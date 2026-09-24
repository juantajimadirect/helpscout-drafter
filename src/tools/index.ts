import { Tool, CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import sharp from 'sharp';
import { PaginatedResponse, helpScoutClient } from '../utils/helpscout-client.js';
import { airtableClient } from '../utils/airtable-client.js';
import { rasterizePdf } from '../utils/pdf-rasterizer.js';
import { fetchInlineImage } from '../utils/inline-image-fetcher.js';
import { createMcpToolError, isApiError } from '../utils/mcp-errors.js';
import { HelpScoutAPIConstraints, ToolCallContext } from '../utils/api-constraints.js';
import { logger } from '../utils/logger.js';
import { config } from '../utils/config.js';
import { PII_REDACTED_BODY } from '../utils/constants.js';
import { z } from 'zod';
import {
  Inbox,
  Conversation,
  Thread,
  Customer,
  CustomerAddress,
  Organization,
  ServerTime,
  SearchInboxesInputSchema,
  SearchConversationsInputSchema,
  GetThreadsInputSchema,
  GetConversationSummaryInputSchema,
  AdvancedConversationSearchInputSchema,
  MultiStatusConversationSearchInputSchema,
  StructuredConversationFilterInputSchema,
  GetCustomerInputSchema,
  ListCustomersInputSchema,
  SearchCustomersByEmailInputSchema,
  GetCustomerContactsInputSchema,
  ListAllInboxesInputSchema,
  GetOrganizationInputSchema,
  ListOrganizationsInputSchema,
  CreateNoteInputSchema,
  UpdateConversationTagsInputSchema,
  AssignConversationInputSchema,
  GetSavedRepliesInputSchema,
  GetAttachmentFileInputSchema,
  GetPdfAsImagesInputSchema,
  GetInlineImageInputSchema,
  PushAttachmentToAirtableInputSchema,
  GetOrganizationMembersInputSchema,
  GetOrganizationConversationsInputSchema,
} from '../schema/types.js';

/**
 * Constants for tool operations
 */
const TOOL_CONSTANTS = {
  // API pagination defaults
  DEFAULT_PAGE_SIZE: 50,
  MAX_PAGE_SIZE: 100,
  MAX_THREAD_SIZE: 200,
  DEFAULT_THREAD_SIZE: 200,

  // Search limits
  MAX_SEARCH_TERMS: 10,
  DEFAULT_TIMEFRAME_DAYS: 60,
  DEFAULT_LIMIT_PER_STATUS: 25,

  // Sort configuration
  DEFAULT_SORT_FIELD: 'createdAt',
  DEFAULT_SORT_ORDER: 'desc',

  // Cache and performance
  MAX_CONVERSATION_ID_LENGTH: 20,

  // Search locations
  SEARCH_LOCATIONS: {
    BODY: 'body',
    SUBJECT: 'subject',
    BOTH: 'both'
  } as const,

  // Conversation statuses
  STATUSES: {
    ACTIVE: 'active',
    PENDING: 'pending',
    CLOSED: 'closed',
    SPAM: 'spam'
  } as const
} as const;

export class ToolHandler {
  private callHistory: string[] = [];
  private currentUserQuery?: string;

  constructor() {
    // Direct imports, no DI needed
  }

  /**
   * Escape special characters in Help Scout query syntax to prevent injection
   * Help Scout uses double quotes for exact phrases, so we need to escape them
   */
  private parseCursorToPage(cursor?: string): number {
    if (!cursor) return 1;
    const page = parseInt(cursor, 10);
    if (isNaN(page) || page < 1) return 1;
    return page;
  }

  private escapeQueryTerm(term: string): string {
    // Escape backslashes first, then double quotes
    return term.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /**
   * Append a createdAt date range to an existing Help Scout query string.
   * Help Scout has no native createdAfter/createdBefore URL params, so we
   * use query syntax: (createdAt:[start TO end]).
   */
  private appendCreatedAtFilter(
    existingQuery: string | undefined,
    createdAfter?: string,
    createdBefore?: string
  ): string | undefined {
    if (!createdAfter && !createdBefore) return existingQuery;

    // Validate date format to prevent query injection and match Help Scout expectations
    const isoDatePattern = /^\d{4}-\d{2}-\d{2}(T[\d:.]+([+-]\d{2}:\d{2}|Z)?)?$/;
    if (createdAfter && !isoDatePattern.test(createdAfter)) {
      throw new Error(`Invalid createdAfter date format: ${createdAfter}. Expected ISO 8601 (e.g., 2024-01-15T00:00:00Z)`);
    }
    if (createdBefore && !isoDatePattern.test(createdBefore)) {
      throw new Error(`Invalid createdBefore date format: ${createdBefore}. Expected ISO 8601 (e.g., 2024-01-15T00:00:00Z)`);
    }

    // Strip milliseconds (Help Scout rejects .xxx format)
    const normalize = (d: string) => d.replace(/\.\d{3}(Z|[+-]\d{2}:\d{2})$/, '$1');
    const start = createdAfter ? normalize(createdAfter) : '*';
    const end = createdBefore ? normalize(createdBefore) : '*';
    const clause = `(createdAt:[${start} TO ${end}])`;

    if (!existingQuery) return clause;
    return `(${existingQuery}) AND ${clause}`;
  }

  /**
   * Set the current user query for context-aware validation
   */
  setUserContext(userQuery: string): void {
    this.currentUserQuery = userQuery;
  }

  async listTools(): Promise<Tool[]> {
    return [
      {
        name: 'searchInboxes',
        description: 'List or search inboxes by name. Deprecated: inbox IDs now in server instructions. Only needed to refresh list mid-session.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query to match inbox names. Use empty string "" to list ALL inboxes. This is case-insensitive substring matching.',
            },
            limit: {
              type: 'number',
              description: `Maximum number of results (1-${TOOL_CONSTANTS.MAX_PAGE_SIZE})`,
              minimum: 1,
              maximum: TOOL_CONSTANTS.MAX_PAGE_SIZE,
              default: TOOL_CONSTANTS.DEFAULT_PAGE_SIZE,
            },
            cursor: {
              type: 'string',
              description: 'Pagination cursor for next page',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'searchConversations',
        description: 'List conversations by status, date range, inbox, or tags. Searches all statuses by default. For keyword content search, use comprehensiveConversationSearch.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'HelpScout query syntax. Omit to list all. Example: (body:"keyword")',
            },
            inboxId: {
              type: 'string',
              description: 'Inbox ID from server instructions',
            },
            tag: {
              type: 'string',
              description: 'Filter by tag name',
            },
            status: {
              type: 'string',
              enum: [TOOL_CONSTANTS.STATUSES.ACTIVE, TOOL_CONSTANTS.STATUSES.PENDING, TOOL_CONSTANTS.STATUSES.CLOSED, TOOL_CONSTANTS.STATUSES.SPAM],
              description: 'Filter by status. Defaults to all (active, pending, closed)',
            },
            createdAfter: {
              type: 'string',
              format: 'date-time',
              description: 'Filter conversations created after this timestamp (ISO8601)',
            },
            createdBefore: {
              type: 'string',
              format: 'date-time',
              description: 'Filter conversations created before this timestamp (ISO8601)',
            },
            limit: {
              type: 'number',
              description: `Maximum number of results (1-${TOOL_CONSTANTS.MAX_PAGE_SIZE})`,
              minimum: 1,
              maximum: TOOL_CONSTANTS.MAX_PAGE_SIZE,
              default: TOOL_CONSTANTS.DEFAULT_PAGE_SIZE,
            },
            cursor: {
              type: 'string',
              description: 'Pagination cursor for next page',
            },
            sort: {
              type: 'string',
              enum: ['createdAt', 'modifiedAt', 'number'],
              default: TOOL_CONSTANTS.DEFAULT_SORT_FIELD,
              description: 'Sort field',
            },
            order: {
              type: 'string',
              enum: ['asc', 'desc'],
              default: TOOL_CONSTANTS.DEFAULT_SORT_ORDER,
              description: 'Sort order',
            },
            fields: {
              type: 'array',
              items: { type: 'string' },
              description: 'Specific fields to return (for partial responses)',
            },
          },
        },
      },
      {
        name: 'getConversationSummary',
        description: 'Get conversation summary with first customer message and latest staff reply',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: 'The conversation ID to get summary for',
            },
          },
          required: ['conversationId'],
        },
      },
      {
        name: 'getThreads',
        description: 'Retrieve full message history for a conversation. Returns all thread messages.',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: 'The conversation ID to get threads for',
            },
            limit: {
              type: 'number',
              description: `Maximum number of threads (1-${TOOL_CONSTANTS.MAX_THREAD_SIZE})`,
              minimum: 1,
              maximum: TOOL_CONSTANTS.MAX_THREAD_SIZE,
              default: TOOL_CONSTANTS.DEFAULT_THREAD_SIZE,
            },
            cursor: {
              type: 'string',
              description: 'Pagination cursor for next page',
            },
          },
          required: ['conversationId'],
        },
      },
      {
        name: 'getServerTime',
        description: 'Get current server timestamp. Use before date-relative searches to calculate time ranges.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'listAllInboxes',
        description: 'List all inboxes with IDs. Deprecated: inbox IDs now in server instructions. Only needed mid-session.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of results (1-100)',
              minimum: 1,
              maximum: 100,
              default: 100,
            },
          },
        },
      },
      {
        name: 'advancedConversationSearch',
        description: 'Filter conversations by email domain, customer email, or multiple tags. Supports boolean logic for complex queries. For simple keyword search, use comprehensiveConversationSearch.',
        inputSchema: {
          type: 'object',
          properties: {
            contentTerms: {
              type: 'array',
              items: { type: 'string' },
              description: 'Search terms to find in conversation body/content (will be OR combined)',
            },
            subjectTerms: {
              type: 'array',
              items: { type: 'string' },
              description: 'Search terms to find in conversation subject (will be OR combined)',
            },
            customerEmail: {
              type: 'string',
              description: 'Exact customer email to search for',
            },
            emailDomain: {
              type: 'string',
              description: 'Email domain to search for (e.g., "company.com" to find all @company.com emails)',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tag names to search for (will be OR combined)',
            },
            inboxId: {
              type: 'string',
              description: 'Filter by inbox ID',
            },
            status: {
              type: 'string',
              enum: [TOOL_CONSTANTS.STATUSES.ACTIVE, TOOL_CONSTANTS.STATUSES.PENDING, TOOL_CONSTANTS.STATUSES.CLOSED, TOOL_CONSTANTS.STATUSES.SPAM],
              description: 'Filter by conversation status',
            },
            createdAfter: {
              type: 'string',
              format: 'date-time',
              description: 'Filter conversations created after this timestamp (ISO8601)',
            },
            createdBefore: {
              type: 'string',
              format: 'date-time',
              description: 'Filter conversations created before this timestamp (ISO8601)',
            },
            limit: {
              type: 'number',
              description: `Maximum number of results (1-${TOOL_CONSTANTS.MAX_PAGE_SIZE})`,
              minimum: 1,
              maximum: TOOL_CONSTANTS.MAX_PAGE_SIZE,
              default: TOOL_CONSTANTS.DEFAULT_PAGE_SIZE,
            },
            cursor: {
              type: 'string',
              description: 'Pagination cursor for next page',
            },
          },
        },
      },
      {
        name: 'comprehensiveConversationSearch',
        description: 'Search conversation content by keywords. Searches subject and body across all statuses. Requires searchTerms parameter. For listing without keywords, use searchConversations.',
        inputSchema: {
          type: 'object',
          properties: {
            searchTerms: {
              type: 'array',
              items: { type: 'string' },
              description: 'Keywords to search for (OR logic). Example: ["billing", "refund"]',
              minItems: 1,
            },
            inboxId: {
              type: 'string',
              description: 'Inbox ID from server instructions',
            },
            statuses: {
              type: 'array',
              items: { enum: ['active', 'pending', 'closed', 'spam'] },
              description: 'Conversation statuses to search (defaults to active, pending, closed)',
              default: ['active', 'pending', 'closed'],
            },
            searchIn: {
              type: 'array',
              items: { enum: ['body', 'subject', 'both'] },
              description: 'Where to search for terms (defaults to both body and subject)',
              default: ['both'],
            },
            timeframeDays: {
              type: 'number',
              description: `Number of days back to search (defaults to ${TOOL_CONSTANTS.DEFAULT_TIMEFRAME_DAYS})`,
              minimum: 1,
              maximum: 365,
              default: TOOL_CONSTANTS.DEFAULT_TIMEFRAME_DAYS,
            },
            createdAfter: {
              type: 'string',
              format: 'date-time',
              description: 'Override timeframeDays with specific start date (ISO8601)',
            },
            createdBefore: {
              type: 'string',
              format: 'date-time',
              description: 'End date for search range (ISO8601)',
            },
            limitPerStatus: {
              type: 'number',
              description: `Maximum results per status (defaults to ${TOOL_CONSTANTS.DEFAULT_LIMIT_PER_STATUS})`,
              minimum: 1,
              maximum: TOOL_CONSTANTS.MAX_PAGE_SIZE,
              default: TOOL_CONSTANTS.DEFAULT_LIMIT_PER_STATUS,
            },
          },
          required: ['searchTerms'],
        },
      },
      {
        name: 'structuredConversationFilter',
        description: 'Lookup conversation by ticket number or filter by assignee/customer/folder IDs. Use after discovering IDs from other searches. For initial searches, use searchConversations or comprehensiveConversationSearch.',
        inputSchema: {
          type: 'object',
          properties: {
            assignedTo: { type: 'number', description: 'User ID from previous_results[].assignee.id. Use -1 for unassigned.' },
            folderId: { type: 'number', description: 'Folder ID from Help Scout UI (not in API responses)' },
            customerIds: { type: 'array', items: { type: 'number' }, description: 'Customer IDs from previous_results[].customer.id' },
            conversationNumber: { type: 'number', description: 'Ticket number from previous_results[].number or user reference' },
            status: { type: 'string', enum: ['active', 'pending', 'closed', 'spam', 'all'], default: 'all' },
            inboxId: { type: 'string', description: 'Inbox ID to combine with filters' },
            tag: { type: 'string', description: 'Tag name to combine with filters' },
            createdAfter: { type: 'string', format: 'date-time' },
            createdBefore: { type: 'string', format: 'date-time' },
            modifiedSince: { type: 'string', format: 'date-time', description: 'Filter by last modified (different from created)' },
            sortBy: { type: 'string', enum: ['createdAt', 'modifiedAt', 'number', 'waitingSince', 'customerName', 'customerEmail', 'mailboxId', 'status', 'subject'], default: 'createdAt', description: 'waitingSince/customerName/customerEmail are unique to this tool' },
            sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
            limit: { type: 'number', minimum: 1, maximum: 100, default: 50 },
            cursor: { type: 'string' },
          },
        },
      },
      // Customer tools (NAS-680, NAS-727, NAS-728)
      {
        name: 'getCustomer',
        description: 'Get a customer profile by ID. Returns profile with contact details (emails, phones, chat handles, social profiles, websites) plus address from a separate lookup.',
        inputSchema: {
          type: 'object',
          properties: {
            customerId: {
              type: 'string',
              description: 'Customer ID',
            },
          },
          required: ['customerId'],
        },
      },
      {
        name: 'listCustomers',
        description: 'List or search customers by name, query syntax, or modification date. Page-based pagination (v2 API).',
        inputSchema: {
          type: 'object',
          properties: {
            firstName: { type: 'string', description: 'Filter by first name' },
            lastName: { type: 'string', description: 'Filter by last name' },
            query: { type: 'string', description: 'Advanced query syntax, e.g. (email:"john@example.com")' },
            mailbox: { type: 'number', description: 'Filter by inbox ID' },
            modifiedSince: { type: 'string', description: 'ISO 8601 date - only customers modified after this date' },
            sortField: { type: 'string', enum: ['createdAt', 'firstName', 'lastName', 'modifiedAt'], default: 'createdAt' },
            sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number (API returns 50 results per page)' },
          },
        },
      },
      {
        name: 'searchCustomersByEmail',
        description: 'Search customers by email address using the v3 API. Provides email as a dedicated filter parameter (vs query syntax in v2) and cursor-based pagination.',
        inputSchema: {
          type: 'object',
          properties: {
            email: { type: 'string', description: 'Email address to search for' },
            firstName: { type: 'string', description: 'Filter by first name' },
            lastName: { type: 'string', description: 'Filter by last name' },
            query: { type: 'string', description: 'Advanced query syntax' },
            modifiedSince: { type: 'string', description: 'ISO 8601 date' },
            createdSince: { type: 'string', description: 'ISO 8601 date - only in v3' },
            cursor: { type: 'string', description: 'Cursor for pagination (from nextCursor in previous response)' },
          },
          required: ['email'],
        },
      },
      // NAS-727: Customer sub-resource tools
      {
        name: 'getCustomerContacts',
        description: 'Get all contact details for a customer: emails, phones, chat handles, social profiles, websites, and address. Calls dedicated sub-resource endpoints for complete data. Use after getCustomer or listCustomers.',
        inputSchema: {
          type: 'object',
          properties: {
            customerId: {
              type: 'string',
              description: 'Customer ID',
            },
          },
          required: ['customerId'],
        },
      },
      // Organization tools (NAS-684, NAS-712)
      {
        name: 'getOrganization',
        description: 'Get an organization by ID with optional customer/conversation counts.',
        inputSchema: {
          type: 'object',
          properties: {
            organizationId: { type: 'string', description: 'Organization ID' },
            includeCounts: { type: 'boolean', default: true, description: 'Include customerCount and conversationCount' },
            includeProperties: { type: 'boolean', default: false, description: 'Include organization property values' },
          },
          required: ['organizationId'],
        },
      },
      {
        name: 'listOrganizations',
        description: 'List all organizations with sorting options. Use for discovering organizations before drilling into members or conversations. Returns 50 per page.',
        inputSchema: {
          type: 'object',
          properties: {
            sortField: { type: 'string', enum: ['name', 'customerCount', 'conversationCount', 'lastInteractionAt'], default: 'lastInteractionAt' },
            sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number (50 results per page)' },
          },
        },
      },
      {
        name: 'getOrganizationMembers',
        description: 'Get all customers belonging to an organization. Use after getOrganization to see who is in the org. Returns 50 per page.',
        inputSchema: {
          type: 'object',
          properties: {
            organizationId: { type: 'string', description: 'Organization ID' },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number (50 results per page)' },
          },
          required: ['organizationId'],
        },
      },
      {
        name: 'getOrganizationConversations',
        description: 'Get all conversations associated with an organization. Traverses org-to-conversations without needing individual customer lookups. Returns 50 per page.',
        inputSchema: {
          type: 'object',
          properties: {
            organizationId: { type: 'string', description: 'Organization ID' },
            page: { type: 'number', minimum: 1, default: 1, description: 'Page number (50 results per page)' },
          },
          required: ['organizationId'],
        },
      },
      {
        name: 'createNote',
        description: 'Add an internal note to a conversation. Notes are only visible to Help Scout agents, not customers.',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: 'The conversation ID to add the note to',
            },
            text: {
              type: 'string',
              description: 'The note text content (supports HTML)',
            },
          },
          required: ['conversationId', 'text'],
        },
      },
      {
        name: 'updateConversationTags',
        description: 'Replace ALL tags on a conversation. This is a full replacement — any existing tags not included in the array will be removed. To ADD tags without removing existing ones, first retrieve the conversation to get current tags, then include both old and new tags in the array.',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: 'The conversation ID to update tags on',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Complete list of tags for the conversation. WARNING: This replaces all existing tags. To add a tag, include all current tags plus the new one. To remove a tag, include all tags except the one to remove.',
            },
          },
          required: ['conversationId', 'tags'],
        },
      },
      {
        name: 'assignConversation',
        description: 'Assign a Help Scout conversation to a specific user by their user ID.',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: 'The conversation ID to assign',
            },
            userId: {
              type: 'number',
              description: 'The Help Scout user ID to assign the conversation to',
            },
          },
          required: ['conversationId', 'userId'],
        },
      },
      {
        name: 'getSavedReplies',
        description: 'List saved replies (canned messages) for a Help Scout inbox. Useful for finding pre-written response templates to reference or use when drafting replies.',
        inputSchema: {
          type: 'object',
          properties: {
            inboxId: {
              type: 'string',
              description: 'Inbox/mailbox ID. Defaults to 348804.',
            },
            search: {
              type: 'string',
              description: 'Filter by name — case-insensitive substring match.',
            },
          },
          required: [],
        },
      },
      {
        name: 'getAttachmentFile',
        description: 'Fetch the contents of a Help Scout attachment. Use AFTER getThreads — that response provides each attachment\'s id, conversationId, and mimeType. For images, the file renders inline so Claude can view it natively. PDFs are auto-rasterized to images (first 5 pages, 200 DPI) so they\'re visually viewable in chat. For multi-page PDFs needing page-range control, use getPdfAsImages instead. Large images are automatically resized to fit under the MCP protocol size limit (small images and PNG screenshots pass through unchanged). PNG-format inputs are preserved as PNG when possible. Non-image, non-PDF attachments are returned as resource blocks.',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: 'The conversation ID containing the attachment.',
            },
            attachmentId: {
              type: 'string',
              description: 'The attachment ID from getThreads response.',
            },
            mimeType: {
              type: 'string',
              description: 'The mimeType from getThreads attachment.mimeType (e.g. "image/jpeg", "application/pdf"). Required.',
            },
          },
          required: ['conversationId', 'attachmentId', 'mimeType'],
        },
      },
      {
        name: 'pushAttachmentToAirtable',
        description: 'Copy a Help Scout attachment directly into an Airtable attachment field. Use AFTER getThreads to obtain the conversationId, attachmentId, filename, and mimeType. The tool fetches the attachment from Help Scout (auth-walled, not URL-accessible), then uploads it to the specified Airtable record/field. Files under 5MB are uploaded as-is to preserve original quality. Files over 5MB are auto-compressed via sharp (target 4MB, max edge 3000px, JPEG q92) — original quality is preserved when possible. Use field IDs (not field names) for the destination to avoid breakage from field renames. For PDFs: by default, the PDF is uploaded as-is. Set rasterizePdfPages: true to instead rasterize each page to a separate image and upload them as multiple attachments to the same field — useful when you want pages browsable as images in Airtable. Common use cases: archiving customer return photos, Rx images, frame issue photos, fit complaint photos.',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: {
              type: 'string',
              description: 'Help Scout conversation ID containing the attachment.',
            },
            attachmentId: {
              type: 'string',
              description: 'Help Scout attachment ID from getThreads response.',
            },
            filename: {
              type: 'string',
              description: 'The filename to give the file in Airtable (use the original filename from getThreads attachment.filename).',
            },
            contentType: {
              type: 'string',
              description: 'The MIME type of the attachment (use mimeType from getThreads attachment.mimeType, e.g., "image/jpeg" or "application/pdf").',
            },
            baseId: {
              type: 'string',
              description: 'Airtable base ID (starts with "app").',
            },
            recordId: {
              type: 'string',
              description: 'Airtable record ID to attach to (starts with "rec").',
            },
            fieldId: {
              type: 'string',
              description: 'Airtable attachment field ID (starts with "fld"). Use field IDs not names to avoid breakage. The Airtable upload endpoint appends to existing attachments natively — no replace mode.',
            },
            rasterizePdfPages: {
              type: 'boolean',
              description: 'Optional. Only meaningful when contentType is application/pdf. If true, rasterize each page of the PDF to a separate image and upload them as separate Airtable attachments to the same field. Pages browse as images in Airtable rather than requiring a PDF viewer. Ignored for non-PDF attachments.',
            },
          },
          required: ['conversationId', 'attachmentId', 'filename', 'contentType', 'baseId', 'recordId', 'fieldId'],
        },
      },
      {
        name: 'getPdfAsImages',
        description: 'Fetch a Help Scout PDF attachment and rasterize a specific page range to images. Use this instead of getAttachmentFile when you need to see specific pages of a multi-page PDF (e.g., page 3-7 of a long document) or want a higher DPI than the default. For typical 1-2 page PDFs, getAttachmentFile auto-rasterizes the first 5 pages and is simpler. Returns each requested page as a separate image content block plus a header summary text block.',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: { type: 'string', description: 'Help Scout conversation ID containing the PDF.' },
            attachmentId: { type: 'string', description: 'Help Scout attachment ID of the PDF (from getThreads).' },
            startPage: { type: 'number', description: 'First page to render (1-indexed, default 1).' },
            endPage: { type: 'number', description: 'Last page to render (1-indexed, inclusive, default startPage+4).' },
            dpi: { type: 'number', description: 'Render DPI (72-400, default 200). Higher = sharper but bigger files.' },
          },
          required: ['conversationId', 'attachmentId'],
        },
      },
      {
        name: 'getInlineImage',
        description: 'Fetch an image from a public HTTPS URL and return it as an inline image content block. Designed for Help Scout inline CDN images (the d33v4339jhl8k0.cloudfront.net URLs found in email body HTML), but works for any image URL on the configured allowlist. The default allowlist covers Help Scout, Shopify, Airtable, and CloudFront. Additional domains can be added via INLINE_IMAGE_ALLOWLIST env var. Refuses non-HTTPS URLs, refuses URLs that resolve to private IP addresses (SSRF protection), and refuses URLs not on the allowlist.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Full HTTPS URL of the image to fetch.' },
          },
          required: ['url'],
        },
      },
    ];
  }

  async callTool(request: CallToolRequest): Promise<CallToolResult> {
    const requestId = Math.random().toString(36).substring(7);
    const startTime = Date.now();

    logger.info('Tool call started', {
      requestId,
      toolName: request.params.name,
      arguments: request.params.arguments,
    });

    // REVERSE LOGIC VALIDATION: Check API constraints before making the call
    const validationContext: ToolCallContext = {
      toolName: request.params.name,
      arguments: request.params.arguments || {},
      userQuery: this.currentUserQuery,
      previousCalls: [...this.callHistory]
    };

    const validation = HelpScoutAPIConstraints.validateToolCall(validationContext);
    
    if (!validation.isValid) {
      const errorDetails = {
        errors: validation.errors,
        suggestions: validation.suggestions,
        requiredPrerequisites: validation.requiredPrerequisites
      };
      
      logger.warn('Tool call validation failed', {
        requestId,
        toolName: request.params.name,
        validation: errorDetails
      });
      
      // Return helpful error with API constraint guidance (NAS-472: isError per MCP spec)
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'API Constraint Validation Failed',
            details: errorDetails,
            helpScoutAPIRequirements: {
              message: 'This call violates Help Scout API constraints',
              requiredActions: validation.requiredPrerequisites || [],
              suggestions: validation.suggestions
            }
          }, null, 2)
        }],
        isError: true,
      };
    }

    try {
      let result: CallToolResult;

      switch (request.params.name) {
        case 'searchInboxes':
          result = await this.searchInboxes(request.params.arguments || {});
          break;
        case 'searchConversations':
          result = await this.searchConversations(request.params.arguments || {});
          break;
        case 'getConversationSummary':
          result = await this.getConversationSummary(request.params.arguments || {});
          break;
        case 'getThreads':
          result = await this.getThreads(request.params.arguments || {});
          break;
        case 'getServerTime':
          result = await this.getServerTime();
          break;
        case 'listAllInboxes':
          result = await this.listAllInboxes(request.params.arguments || {});
          break;
        case 'advancedConversationSearch':
          result = await this.advancedConversationSearch(request.params.arguments || {});
          break;
        case 'comprehensiveConversationSearch':
          result = await this.comprehensiveConversationSearch(request.params.arguments || {});
          break;
        case 'structuredConversationFilter':
          result = await this.structuredConversationFilter(request.params.arguments || {});
          break;
        case 'getCustomer':
          result = await this.getCustomer(request.params.arguments || {});
          break;
        case 'listCustomers':
          result = await this.listCustomers(request.params.arguments || {});
          break;
        case 'searchCustomersByEmail':
          result = await this.searchCustomersByEmail(request.params.arguments || {});
          break;
        case 'getCustomerContacts':
          result = await this.getCustomerContacts(request.params.arguments || {});
          break;
        case 'getOrganization':
          result = await this.getOrganization(request.params.arguments || {});
          break;
        case 'listOrganizations':
          result = await this.listOrganizations(request.params.arguments || {});
          break;
        case 'getOrganizationMembers':
          result = await this.getOrganizationMembers(request.params.arguments || {});
          break;
        case 'getOrganizationConversations':
          result = await this.getOrganizationConversations(request.params.arguments || {});
          break;
        case 'createNote':
          result = await this.createNote(request.params.arguments || {});
          break;
        case 'updateConversationTags':
          result = await this.updateConversationTags(request.params.arguments || {});
          break;
        case 'assignConversation':
          result = await this.assignConversation(request.params.arguments || {});
          break;
        case 'getSavedReplies':
          result = await this.getSavedReplies(request.params.arguments || {});
          break;
        case 'getAttachmentFile':
          result = await this.getAttachmentFile(request.params.arguments || {});
          break;
        case 'pushAttachmentToAirtable':
          result = await this.pushAttachmentToAirtable(request.params.arguments || {});
          break;
        case 'getPdfAsImages':
          result = await this.getPdfAsImages(request.params.arguments || {});
          break;
        case 'getInlineImage':
          result = await this.getInlineImage(request.params.arguments || {});
          break;
        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
      }

      const duration = Date.now() - startTime;
      // Add to call history for future validation
      this.callHistory.push(request.params.name);
      
      // Enhance result with API constraint guidance (best-effort: never turn a success into a failure)
      let guidanceProvided = false;
      try {
        const originalContent = JSON.parse((result.content[0] as any).text);
        const guidance = HelpScoutAPIConstraints.generateToolGuidance(
          request.params.name,
          originalContent,
          validationContext
        );

        if (guidance.length > 0) {
          originalContent.apiGuidance = guidance;
          result.content[0] = {
            type: 'text',
            text: JSON.stringify(originalContent, null, 2)
          };
          guidanceProvided = true;
        }
      } catch (guidanceError) {
        logger.warn('Failed to inject API guidance into tool response', {
          requestId,
          toolName: request.params.name,
          error: guidanceError instanceof Error ? guidanceError.message : String(guidanceError),
        });
      }

      logger.info('Tool call completed', {
        requestId,
        toolName: request.params.name,
        duration,
        validationPassed: true,
        guidanceProvided
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      return createMcpToolError(error, {
        toolName: request.params.name,
        requestId,
        duration,
      });
    }
  }

  private async searchInboxes(args: unknown): Promise<CallToolResult> {
    const input = SearchInboxesInputSchema.parse(args);
    const response = await helpScoutClient.get<PaginatedResponse<Inbox>>('/mailboxes', {
      page: this.parseCursorToPage(input.cursor),
      size: input.limit,
    });

    const inboxes = response._embedded?.mailboxes || [];
    const filteredInboxes = inboxes.filter(inbox => 
      inbox.name.toLowerCase().includes(input.query.toLowerCase())
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: filteredInboxes.map(inbox => ({
              id: inbox.id,
              name: inbox.name,
              email: inbox.email,
              createdAt: inbox.createdAt,
              updatedAt: inbox.updatedAt,
            })),
            query: input.query,
            totalFound: filteredInboxes.length,
            totalAvailable: inboxes.length,
            usage: filteredInboxes.length > 0 ? 
              'NEXT STEP: Use the "id" field from these results in your conversation search tools (comprehensiveConversationSearch or searchConversations)' : 
              'No inboxes matched your query. Try a different search term or use empty string "" to list all inboxes.',
            example: filteredInboxes.length > 0 ? 
              `comprehensiveConversationSearch({ searchTerms: ["your search"], inboxId: "${filteredInboxes[0].id}" })` : 
              null,
          }, null, 2),
        },
      ],
    };
  }

  private async searchConversations(args: unknown): Promise<CallToolResult> {
    const input = SearchConversationsInputSchema.parse(args);

    const baseParams: Record<string, unknown> = {
      page: this.parseCursorToPage(input.cursor),
      size: input.limit,
      sortField: input.sort,
      sortOrder: input.order,
    };

    // Add HelpScout query parameter for content/body search
    if (input.query) {
      baseParams.query = input.query;
    }

    // Apply inbox scoping: explicit inboxId > default > all inboxes
    const effectiveInboxId = input.inboxId || config.helpscout.defaultInboxId;
    if (effectiveInboxId) {
      baseParams.mailbox = effectiveInboxId;
    }

    if (input.tag) baseParams.tag = input.tag;

    const queryWithDate = this.appendCreatedAtFilter(
      baseParams.query as string | undefined,
      input.createdAfter
    );
    if (queryWithDate) baseParams.query = queryWithDate;

    let conversations: Conversation[] = [];
    let searchedStatuses: string[];
    let pagination: unknown = null;

    if (input.status) {
      // Explicit status: single API call
      const response = await helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', {
        ...baseParams,
        status: input.status,
      });
      // Help Scout ignores `size` on /conversations (25 per page) - honor limit here
      conversations = (response._embedded?.conversations || []).slice(0, input.limit);
      searchedStatuses = [input.status];
      pagination = { ...(response.page || {}), returned: conversations.length, requestedLimit: input.limit };
    } else {
      // No status specified: search all statuses in parallel
      const statuses = ['active', 'pending', 'closed'] as const;
      searchedStatuses = [...statuses];

      const results = await Promise.allSettled(
        statuses.map(status =>
          helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', {
            ...baseParams,
            status,
          })
        )
      );

      // Merge and dedupe by conversation ID, handling partial failures
      // Track both returned conversations AND total available from API
      const seenIds = new Set<number>();
      const failedStatuses: Array<{ status: string; message: string; code: string }> = [];
      let totalAvailable = 0;
      const totalByStatus: Record<string, number> = {};

      for (const [index, result] of results.entries()) {
        if (result.status === 'fulfilled') {
          const statusName = statuses[index];
          const statusTotal = result.value.page?.totalElements || 0;
          totalByStatus[statusName] = statusTotal;
          totalAvailable += statusTotal;

          const responseConversations = result.value._embedded?.conversations || [];
          for (const conv of responseConversations) {
            if (!seenIds.has(conv.id)) {
              seenIds.add(conv.id);
              conversations.push(conv);
            }
          }
        } else {
          const failedStatus = statuses[index];
          const reason = result.reason;
          const errorMessage = isApiError(reason)
            ? reason.message
            : (reason instanceof Error ? reason.message : String(reason));
          const errorCode = isApiError(reason) ? reason.code : 'UNKNOWN';

          // Non-API errors (TypeError, ReferenceError, etc.) should not be
          // silently swallowed - rethrow so programming bugs surface.
          if (!isApiError(reason)) {
            throw reason;
          }

          // Critical API errors should abort, not return partial results.
          if (errorCode === 'UNAUTHORIZED' || errorCode === 'INVALID_INPUT') {
            throw reason;
          }

          failedStatuses.push({
            status: failedStatus,
            message: errorMessage,
            code: errorCode,
          });

          // Log as ERROR since this affects data completeness
          logger.error('Status search failed - partial results will be returned', {
            status: failedStatus,
            errorCode,
            message: errorMessage,
            note: 'This status will be excluded from results'
          });
        }
      }

      // Update searchedStatuses to reflect only successful searches
      if (failedStatuses.length > 0) {
        searchedStatuses = statuses.filter(s => !failedStatuses.some(f => f.status === s));
      }

      // Sort merged results by createdAt descending (most recent first)
      conversations.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      // Limit to requested size after merging
      const effectiveLimit = input.limit || 50;
      if (conversations.length > effectiveLimit) {
        conversations = conversations.slice(0, effectiveLimit);
      }

      // Pagination for merged results - show both returned count and real total
      pagination = {
        totalResults: conversations.length,
        totalAvailable: Object.keys(totalByStatus).length > 0 ? totalAvailable : undefined,
        totalByStatus: Object.keys(totalByStatus).length > 0 ? totalByStatus : undefined,
        errors: failedStatuses.length > 0 ? failedStatuses : undefined,
        note: failedStatuses.length > 0
          ? `[WARNING] ${failedStatuses.length} status(es) failed - results incomplete! Failed: ${failedStatuses.map(f => `${f.status} (${f.code})`).join(', ')}. Totals reflect successful statuses only.`
          : `Merged results from ${Object.keys(totalByStatus).length} statuses. Returned ${conversations.length} of ${totalAvailable} total conversations.`
      };
      logger.info('Multi-status search completed', {
        statusesSearched: searchedStatuses,
        failedStatuses: failedStatuses.length > 0 ? failedStatuses : undefined,
        totalResults: conversations.length,
        totalAvailable: failedStatuses.length > 0 ? 'partial failure' : totalAvailable
      });
    }

    // Apply client-side createdBefore filtering
    // NOTE: Help Scout API doesn't support createdBefore natively, so this filters after fetching
    // Pagination is rebuilt below to distinguish filtered count from API total
    let clientSideFiltered = false;
    const originalPagination = pagination;

    if (input.createdBefore) {
      const filterResult = this.applyCreatedBeforeFilter(conversations, input.createdBefore, 'searchConversations');
      conversations = filterResult.filtered;
      clientSideFiltered = filterResult.wasFiltered;

      if (clientSideFiltered) {
        // Rebuild pagination to show both filtered and pre-filter counts
        if (input.status) {
          // Single-status path: originalPagination is Help Scout's page object with totalElements
          pagination = this.buildFilteredPagination(
            conversations.length,
            originalPagination as { totalElements?: number } | undefined,
            true
          );
        } else {
          // Multi-status path: originalPagination has our custom merged structure
          const merged = originalPagination as {
            totalAvailable?: number;
            totalByStatus?: Record<string, number>;
            errors?: Array<{ status: string; message: string; code: string }>;
            note?: string;
          } | null;
          pagination = {
            totalResults: conversations.length,
            totalAvailable: merged?.totalAvailable,
            totalByStatus: merged?.totalByStatus,
            errors: merged?.errors,
            note: `Client-side createdBefore filter applied to merged results. totalResults shows filtered count (${conversations.length}), totalAvailable shows pre-filter total (${merged?.totalAvailable}). ${merged?.note || ''}`
          };
        }
      }
    }

    // Apply field selection if specified
    if (input.fields && input.fields.length > 0) {
      conversations = conversations.map(conv => {
        const filtered: Partial<Conversation> = {};
        input.fields!.forEach(field => {
          if (field in conv) {
            (filtered as any)[field] = (conv as any)[field];
          }
        });
        return filtered as Conversation;
      });
    }

    const results = {
      results: conversations,
      pagination,
      searchInfo: {
        query: input.query,
        statusesSearched: searchedStatuses,
        inboxScope: this.formatInboxScope(effectiveInboxId, input.inboxId),
        clientSideFiltering: clientSideFiltered ? 'createdBefore filter applied after API fetch - see pagination.totalResults for filtered count and pagination.totalAvailable for API total' : undefined,
        searchGuidance: conversations.length === 0 ? [
          'If no results found, try:',
          '1. Broaden search terms or extend time range',
          '2. Check if inbox ID is correct',
          '3. Try including spam status explicitly',
          !effectiveInboxId ? '4. Set HELPSCOUT_DEFAULT_INBOX_ID to scope searches to your primary inbox' : undefined
        ].filter(Boolean) : (!effectiveInboxId ? [
          'Note: Searching ALL inboxes. For better LLM context, set HELPSCOUT_DEFAULT_INBOX_ID environment variable.'
        ] : undefined),
      },
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  }

  private async getConversationSummary(args: unknown): Promise<CallToolResult> {
    const input = GetConversationSummaryInputSchema.parse(args);
    
    // Get conversation details
    const conversation = await helpScoutClient.get<Conversation>(`/conversations/${input.conversationId}`);
    
    // Get threads to find first customer message and latest staff reply
    const threadsResponse = await helpScoutClient.get<PaginatedResponse<Thread>>(
      `/conversations/${input.conversationId}/threads`,
      { page: 1, size: 50 }
    );
    
    const threads = threadsResponse._embedded?.threads || [];
    const customerThreads = threads.filter(t => t.type === 'customer');
    const staffThreads = threads.filter(t => t.type === 'message' && t.createdBy);
    
    const firstCustomerMessage = customerThreads.sort((a, b) => 
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )[0];
    
    const latestStaffReply = staffThreads.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];

    const summary = {
      conversation: {
        id: conversation.id,
        subject: conversation.subject,
        status: conversation.status,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        customer: config.security.allowPii ? conversation.customer : (conversation.customer ? {
          id: conversation.customer.id,
          email: conversation.customer.email != null ? '[redacted]' : conversation.customer.email,
          firstName: conversation.customer.firstName != null ? '[redacted]' : conversation.customer.firstName,
          lastName: conversation.customer.lastName != null ? '[redacted]' : conversation.customer.lastName,
        } : null),
        assignee: config.security.allowPii ? conversation.assignee : (conversation.assignee ? {
          id: conversation.assignee.id,
          firstName: '[redacted]',
          lastName: '[redacted]',
          email: '[redacted]',
        } : null),
        tags: conversation.tags,
      },
      firstCustomerMessage: firstCustomerMessage ? {
        id: firstCustomerMessage.id,
        body: config.security.allowPii ? firstCustomerMessage.body : PII_REDACTED_BODY,
        createdAt: firstCustomerMessage.createdAt,
        customer: config.security.allowPii ? firstCustomerMessage.customer : (firstCustomerMessage.customer ? {
          id: firstCustomerMessage.customer.id,
          email: firstCustomerMessage.customer.email != null ? '[redacted]' : firstCustomerMessage.customer.email,
          firstName: firstCustomerMessage.customer.firstName != null ? '[redacted]' : firstCustomerMessage.customer.firstName,
          lastName: firstCustomerMessage.customer.lastName != null ? '[redacted]' : firstCustomerMessage.customer.lastName,
        } : null),
      } : null,
      latestStaffReply: latestStaffReply ? {
        id: latestStaffReply.id,
        body: config.security.allowPii ? latestStaffReply.body : PII_REDACTED_BODY,
        createdAt: latestStaffReply.createdAt,
        createdBy: config.security.allowPii ? latestStaffReply.createdBy : (latestStaffReply.createdBy ? {
          id: latestStaffReply.createdBy.id,
          firstName: '[redacted]',
          lastName: '[redacted]',
          email: '[redacted]',
        } : null),
      } : null,
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(summary, null, 2),
        },
      ],
    };
  }

  private async getThreads(args: unknown): Promise<CallToolResult> {
    const input = GetThreadsInputSchema.parse(args);

    // Help Scout returns 25 threads per page regardless of `size`. Without a cursor,
    // fetch every page so long tickets come back whole (the old behaviour silently
    // dropped everything past 25 unless the caller remembered to page).
    const firstPage = this.parseCursorToPage(input.cursor);
    let response = await helpScoutClient.get<PaginatedResponse<Thread>>(
      `/conversations/${input.conversationId}/threads`,
      { page: firstPage, size: input.limit }
    );
    let all: Thread[] = [...(response._embedded?.threads || [])];
    let pagesFetched = 1;
    const totalPages = Number(response.page?.totalPages || 1);
    if (!input.cursor && totalPages > 1) {
      for (let p = 2; p <= Math.min(totalPages, 40); p++) {
        const next = await helpScoutClient.get<PaginatedResponse<Thread>>(
          `/conversations/${input.conversationId}/threads`,
          { page: p, size: input.limit }
        );
        all = all.concat(next._embedded?.threads || []);
        pagesFetched++;
      }
      response = { ...response, page: { ...(response.page || {}), pagesFetched, complete: pagesFetched >= totalPages } as any, _links: undefined } as any;
    }

    // Sort chronologically (oldest first) for readable conversation flow
    const threads = all
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    
    // Redact PII if configured
    const processedThreads = threads.map(thread => ({
      ...thread,
      body: config.security.allowPii ? thread.body : PII_REDACTED_BODY,
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            conversationId: input.conversationId,
            threads: processedThreads,
            pagination: response.page,
            nextCursor: response._links?.next?.href,
          }, null, 2),
        },
      ],
    };
  }

  private async getServerTime(): Promise<CallToolResult> {
    const now = new Date();
    const serverTime: ServerTime = {
      isoTime: now.toISOString(),
      unixTime: Math.floor(now.getTime() / 1000),
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(serverTime, null, 2),
        },
      ],
    };
  }

  private async listAllInboxes(args: unknown): Promise<CallToolResult> {
    const input = ListAllInboxesInputSchema.parse(args);
    const limit = input.limit || 100;

    const response = await helpScoutClient.get<PaginatedResponse<Inbox>>('/mailboxes', {
      page: 1,
      size: limit,
    });

    const inboxes = response._embedded?.mailboxes || [];

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            inboxes: inboxes.map(inbox => ({
              id: inbox.id,
              name: inbox.name,
              email: inbox.email,
              createdAt: inbox.createdAt,
              updatedAt: inbox.updatedAt,
            })),
            totalInboxes: inboxes.length,
            usage: 'Use the "id" field from these results in your conversation searches',
            nextSteps: [
              'To search in a specific inbox, use the inbox ID with comprehensiveConversationSearch or searchConversations',
              'To search across all inboxes, omit the inboxId parameter',
            ],
          }, null, 2),
        },
      ],
    };
  }

  private async advancedConversationSearch(args: unknown): Promise<CallToolResult> {
    const input = AdvancedConversationSearchInputSchema.parse(args);

    // Build HelpScout query syntax
    const queryParts: string[] = [];

    // Content/body search (with injection protection)
    if (input.contentTerms && input.contentTerms.length > 0) {
      const bodyQueries = input.contentTerms.map(term => `body:"${this.escapeQueryTerm(term)}"`);
      queryParts.push(`(${bodyQueries.join(' OR ')})`);
    }

    // Subject search (with injection protection)
    if (input.subjectTerms && input.subjectTerms.length > 0) {
      const subjectQueries = input.subjectTerms.map(term => `subject:"${this.escapeQueryTerm(term)}"`);
      queryParts.push(`(${subjectQueries.join(' OR ')})`);
    }

    // Email searches (with injection protection)
    if (input.customerEmail) {
      queryParts.push(`email:"${this.escapeQueryTerm(input.customerEmail)}"`);
    }

    // Handle email domain search (with injection protection)
    if (input.emailDomain) {
      const domain = input.emailDomain.replace('@', ''); // Remove @ if present
      queryParts.push(`email:"${this.escapeQueryTerm(domain)}"`);
    }

    // Tag search (with injection protection)
    if (input.tags && input.tags.length > 0) {
      const tagQueries = input.tags.map(tag => `tag:"${this.escapeQueryTerm(tag)}"`);
      queryParts.push(`(${tagQueries.join(' OR ')})`);
    }

    // Build final query
    const queryString = queryParts.length > 0 ? queryParts.join(' AND ') : undefined;

    // Set up query parameters
    const queryParams: Record<string, unknown> = {
      page: this.parseCursorToPage(input.cursor),
      size: input.limit || 50,
      sortField: 'createdAt',
      sortOrder: 'desc',
    };

    if (queryString) {
      queryParams.query = queryString;
    }

    // Apply inbox scoping: explicit inboxId > default > all inboxes
    const effectiveInboxId = input.inboxId || config.helpscout.defaultInboxId;
    if (effectiveInboxId) {
      queryParams.mailbox = effectiveInboxId;
    }

    // Default to all statuses for consistency with searchConversations (v1.6.0+)
    queryParams.status = input.status || 'all';

    const queryWithDate = this.appendCreatedAtFilter(
      queryParams.query as string | undefined,
      input.createdAfter
    );
    if (queryWithDate) queryParams.query = queryWithDate;

    const response = await helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', queryParams);

    let conversations = response._embedded?.conversations || [];

    let clientSideFiltered = false;
    const originalCount = conversations.length;
    if (input.createdBefore) {
      const result = this.applyCreatedBeforeFilter(conversations, input.createdBefore, 'advancedConversationSearch');
      conversations = result.filtered;
      clientSideFiltered = result.wasFiltered;
    }

    const paginationInfo = this.buildFilteredPagination(conversations.length, response.page, clientSideFiltered);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: conversations,
            searchQuery: queryString,
            inboxScope: this.formatInboxScope(effectiveInboxId, input.inboxId),
            searchCriteria: {
              contentTerms: input.contentTerms,
              subjectTerms: input.subjectTerms,
              customerEmail: input.customerEmail,
              emailDomain: input.emailDomain,
              tags: input.tags,
            },
            pagination: paginationInfo,
            nextCursor: response._links?.next?.href,
            clientSideFiltering: clientSideFiltered ? `createdBefore filter removed ${originalCount - conversations.length} of ${originalCount} results` : undefined,
            note: !effectiveInboxId ? 'Searching ALL inboxes. Set HELPSCOUT_DEFAULT_INBOX_ID for better LLM context.' : undefined,
          }, null, 2),
        },
      ],
    };
  }

  /**
   * Performs comprehensive conversation search across multiple statuses
   * @param args - Search parameters including search terms, statuses, and timeframe
   * @returns Promise<CallToolResult> with search results organized by status
   * @example
   * comprehensiveConversationSearch({
   *   searchTerms: ["urgent", "billing"],
   *   timeframeDays: 30,
   *   inboxId: "123456"
   * })
   */
  private async comprehensiveConversationSearch(args: unknown): Promise<CallToolResult> {
    const input = MultiStatusConversationSearchInputSchema.parse(args);
    
    const searchContext = this.buildComprehensiveSearchContext(input);
    const searchResults = await this.executeMultiStatusSearch(searchContext);
    const summary = this.formatComprehensiveSearchResults(searchResults, searchContext);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(summary, null, 2),
        },
      ],
    };
  }

  /**
   * Build search context from input parameters
   */
  private buildComprehensiveSearchContext(input: z.infer<typeof MultiStatusConversationSearchInputSchema>) {
    const createdAfter = input.createdAfter || this.calculateTimeRange(input.timeframeDays);
    const searchQuery = this.buildSearchQuery(input.searchTerms, input.searchIn);
    // Apply inbox scoping: explicit inboxId > default > all inboxes
    const effectiveInboxId = input.inboxId || config.helpscout.defaultInboxId;

    return {
      input,
      createdAfter,
      searchQuery,
      effectiveInboxId,
    };
  }

  /**
   * Calculate time range for search
   * Note: Help Scout API requires ISO 8601 format WITHOUT milliseconds
   */
  private calculateTimeRange(timeframeDays: number): string {
    const timeRange = new Date();
    timeRange.setDate(timeRange.getDate() - timeframeDays);
    // Strip milliseconds - Help Scout rejects dates with .xxx format
    return timeRange.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /**
   * Build Help Scout search query from terms and search locations (with injection protection)
   */
  private buildSearchQuery(terms: string[], searchIn: string[]): string {
    const queries: string[] = [];

    for (const term of terms) {
      const termQueries: string[] = [];
      const escapedTerm = this.escapeQueryTerm(term);

      if (searchIn.includes(TOOL_CONSTANTS.SEARCH_LOCATIONS.BODY) || searchIn.includes(TOOL_CONSTANTS.SEARCH_LOCATIONS.BOTH)) {
        termQueries.push(`body:"${escapedTerm}"`);
      }

      if (searchIn.includes(TOOL_CONSTANTS.SEARCH_LOCATIONS.SUBJECT) || searchIn.includes(TOOL_CONSTANTS.SEARCH_LOCATIONS.BOTH)) {
        termQueries.push(`subject:"${escapedTerm}"`);
      }

      if (termQueries.length > 0) {
        queries.push(`(${termQueries.join(' OR ')})`);
      }
    }

    return queries.join(' OR ');
  }

  /**
   * Execute search across multiple statuses with error handling
   */
  private async executeMultiStatusSearch(context: {
    input: z.infer<typeof MultiStatusConversationSearchInputSchema>;
    createdAfter: string;
    searchQuery: string;
    effectiveInboxId?: string;
  }) {
    const { input, createdAfter, searchQuery, effectiveInboxId } = context;
    const allResults: Array<{
      status: string;
      totalCount: number;
      totalCountBeforeFilter?: number;
      conversations: Conversation[];
      searchQuery: string;
      filteredByCreatedBefore?: boolean;
      error?: string;
    }> = [];

    for (const status of input.statuses) {
      try {
        const result = await this.searchSingleStatus({
          status,
          searchQuery,
          createdAfter,
          limitPerStatus: input.limitPerStatus,
          inboxId: effectiveInboxId,
          createdBefore: input.createdBefore,
        });
        allResults.push(result);
      } catch (error) {
        // Use type guard instead of unsafe cast
        if (!isApiError(error)) {
          // Non-API errors (TypeError, network failures) should not be silently swallowed
          logger.error('Unexpected non-API error in multi-status search', {
            status,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }

        // Critical API errors should fail the entire operation.
        if (error.code === 'UNAUTHORIZED' || error.code === 'INVALID_INPUT') {
          logger.error('Critical API error in multi-status search - aborting', {
            status,
            errorCode: error.code,
            message: error.message
          });
          throw error;
        }

        // Non-critical API errors: log and include in response
        logger.error('Status search failed - partial results will be returned', {
          status,
          errorCode: error.code,
          message: error.message,
          note: 'This status will be excluded from results'
        });

        allResults.push({
          status,
          totalCount: 0,
          conversations: [],
          searchQuery,
          error: `Search failed (${error.code}): ${error.message}`,
        });
      }
    }

    return allResults;
  }

  /**
   * Apply client-side createdBefore filter (Help Scout API does not support this natively).
   * Returns filtered conversations and metadata about what was removed.
   */
  private applyCreatedBeforeFilter(
    conversations: Conversation[],
    createdBefore: string,
    context: string
  ): { filtered: Conversation[]; wasFiltered: boolean; removedCount: number } {
    const beforeDate = new Date(createdBefore);
    if (isNaN(beforeDate.getTime())) {
      throw new Error(`Invalid createdBefore date format: ${createdBefore}. Expected ISO 8601 format (e.g., 2023-01-15T00:00:00Z)`);
    }

    const originalCount = conversations.length;
    const filtered = conversations.filter(conv => new Date(conv.createdAt) < beforeDate);
    const removedCount = originalCount - filtered.length;

    if (removedCount > 0) {
      logger.warn(`Client-side createdBefore filter applied - ${context}`, {
        originalCount,
        filteredCount: filtered.length,
        removedCount,
        note: 'Help Scout API does not support createdBefore parameter natively'
      });
    }

    return { filtered, wasFiltered: removedCount > 0, removedCount };
  }

  /**
   * Build inbox scope description string for response metadata.
   */
  private formatInboxScope(effectiveInboxId: string | undefined, explicitInboxId: string | undefined): string {
    if (!effectiveInboxId) return 'ALL inboxes';
    return explicitInboxId ? `Specific inbox: ${effectiveInboxId}` : `Default inbox: ${effectiveInboxId}`;
  }

  /**
   * Build pagination info that distinguishes filtered count from API total.
   * Used when createdBefore client-side filtering modifies a single API response.
   */
  private buildFilteredPagination(
    filteredCount: number,
    apiPage: { totalElements?: number } | undefined,
    wasFiltered: boolean
  ): unknown {
    if (!wasFiltered) return apiPage;
    return {
      totalResults: filteredCount,
      totalAvailable: apiPage?.totalElements,
      note: `Results filtered client-side by createdBefore. totalResults shows filtered count (${filteredCount}), totalAvailable shows pre-filter API total (${apiPage?.totalElements}).`
    };
  }

  /**
   * Search conversations for a single status
   */
  private async searchSingleStatus(params: {
    status: string;
    searchQuery: string;
    createdAfter: string;
    limitPerStatus: number;
    inboxId?: string;
    createdBefore?: string;
  }) {
    const queryWithDate = this.appendCreatedAtFilter(
      params.searchQuery,
      params.createdAfter
    );

    const queryParams: Record<string, unknown> = {
      page: 1,
      size: params.limitPerStatus,
      sortField: TOOL_CONSTANTS.DEFAULT_SORT_FIELD,
      sortOrder: TOOL_CONSTANTS.DEFAULT_SORT_ORDER,
      query: queryWithDate || params.searchQuery,
      status: params.status,
    };

    if (params.inboxId) {
      queryParams.mailbox = params.inboxId;
    }

    const response = await helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', queryParams);
    let conversations = response._embedded?.conversations || [];
    const apiTotalElements = response.page?.totalElements || conversations.length;

    let filteredByDate = false;
    if (params.createdBefore) {
      const result = this.applyCreatedBeforeFilter(conversations, params.createdBefore, `searchSingleStatus(${params.status})`);
      conversations = result.filtered;
      filteredByDate = result.wasFiltered;
    }

    return {
      status: params.status,
      totalCount: filteredByDate ? conversations.length : apiTotalElements,
      totalCountBeforeFilter: filteredByDate ? apiTotalElements : undefined,
      conversations,
      searchQuery: params.searchQuery,
      filteredByCreatedBefore: filteredByDate,
    };
  }

  /**
   * Format comprehensive search results into summary response
   */
  private formatComprehensiveSearchResults(
    allResults: Array<{
      status: string;
      totalCount: number;
      totalCountBeforeFilter?: number;
      conversations: Conversation[];
      searchQuery: string;
      filteredByCreatedBefore?: boolean;
      error?: string;
    }>,
    context: {
      input: z.infer<typeof MultiStatusConversationSearchInputSchema>;
      createdAfter: string;
      searchQuery: string;
      effectiveInboxId?: string;
    }
  ) {
    const { input, createdAfter, searchQuery, effectiveInboxId } = context;
    const totalConversations = allResults.reduce((sum, result) => sum + result.conversations.length, 0);
    const totalAvailable = allResults.reduce((sum, result) => sum + result.totalCount, 0);
    const hasClientSideFiltering = allResults.some(r => r.filteredByCreatedBefore);
    const totalBeforeFilter = hasClientSideFiltering
      ? allResults.reduce((sum, result) => sum + (result.totalCountBeforeFilter || result.totalCount), 0)
      : undefined;

    return {
      searchTerms: input.searchTerms,
      searchQuery,
      searchIn: input.searchIn,
      inboxScope: this.formatInboxScope(effectiveInboxId, input.inboxId),
      timeframe: {
        createdAfter,
        createdBefore: input.createdBefore,
        days: input.timeframeDays,
      },
      totalConversationsFound: totalConversations,
      totalAvailableAcrossStatuses: totalAvailable,
      totalBeforeClientSideFiltering: totalBeforeFilter,
      clientSideFilteringApplied: hasClientSideFiltering ?
        `createdBefore filter applied - totalConversationsFound (${totalConversations}) reflects filtered results, totalBeforeClientSideFiltering (${totalBeforeFilter}) shows pre-filter API totals` : undefined,
      failedStatuses: allResults.filter(r => r.error).map(r => `[WARNING] Status "${r.status}" search failed: ${r.error}`),
      resultsByStatus: allResults,
      searchTips: totalConversations === 0 ? [
        'Try broader search terms or increase the timeframe',
        'Check if the inbox ID is correct',
        'Consider searching without status restrictions first',
        'Verify that conversations exist for the specified criteria',
        !effectiveInboxId ? 'Set HELPSCOUT_DEFAULT_INBOX_ID to scope searches to your primary inbox' : undefined
      ].filter(Boolean) : (!effectiveInboxId ? [
        'Note: Searching ALL inboxes. For better LLM context, set HELPSCOUT_DEFAULT_INBOX_ID environment variable.'
      ] : undefined),
    };
  }

  private async structuredConversationFilter(args: unknown): Promise<CallToolResult> {
    const input = StructuredConversationFilterInputSchema.parse(args);

    const queryParams: Record<string, unknown> = {
      page: this.parseCursorToPage(input.cursor),
      size: input.limit,
      sortField: input.sortBy,
      sortOrder: input.sortOrder,
    };

    // Apply unique structural filters
    if (input.assignedTo !== undefined) queryParams.assigned_to = input.assignedTo;
    if (input.folderId !== undefined) queryParams.folder = input.folderId;
    if (input.conversationNumber !== undefined) queryParams.number = input.conversationNumber;

    // Apply customerIds via query syntax if provided
    if (input.customerIds && input.customerIds.length > 0) {
      queryParams.query = `(${input.customerIds.map(id => `customerIds:${id}`).join(' OR ')})`;
    }

    // Apply combination filters
    const effectiveInboxId = input.inboxId || config.helpscout.defaultInboxId;
    if (effectiveInboxId) queryParams.mailbox = effectiveInboxId;
    // Send status=all explicitly (Help Scout defaults to active-only when omitted)
    queryParams.status = input.status || 'all';
    if (input.tag) queryParams.tag = input.tag;
    if (input.modifiedSince) queryParams.modifiedSince = input.modifiedSince;

    const queryWithDate = this.appendCreatedAtFilter(
      queryParams.query as string | undefined,
      input.createdAfter
    );
    if (queryWithDate) queryParams.query = queryWithDate;

    const response = await helpScoutClient.get<PaginatedResponse<Conversation>>('/conversations', queryParams);
    let conversations = response._embedded?.conversations || [];

    let clientSideFiltered = false;
    const originalCount = conversations.length;
    if (input.createdBefore) {
      const result = this.applyCreatedBeforeFilter(conversations, input.createdBefore, 'structuredConversationFilter');
      conversations = result.filtered;
      clientSideFiltered = result.wasFiltered;
    }

    const paginationInfo = this.buildFilteredPagination(conversations.length, response.page, clientSideFiltered);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: conversations,
          filterApplied: {
            filterType: 'structural',
            assignedTo: input.assignedTo,
            folderId: input.folderId,
            customerIds: input.customerIds,
            conversationNumber: input.conversationNumber,
            uniqueSorting: ['waitingSince', 'customerName', 'customerEmail'].includes(input.sortBy) ? input.sortBy : undefined,
          },
          inboxScope: this.formatInboxScope(effectiveInboxId, input.inboxId),
          pagination: paginationInfo,
          nextCursor: response._links?.next?.href,
          clientSideFiltering: clientSideFiltered ? `createdBefore filter removed ${originalCount - conversations.length} of ${originalCount} results` : undefined,
          note: 'Structural filtering applied. For content-based search or rep activity, use comprehensiveConversationSearch.',
        }, null, 2),
      }],
    };
  }

  // ── Customer Tools (NAS-680, NAS-727) ──

  private redactAddress(address: CustomerAddress): Record<string, unknown> {
    if (config.security.allowPii) return address as unknown as Record<string, unknown>;
    return {
      city: address.city != null ? '[redacted]' : address.city,
      state: address.state != null ? '[redacted]' : address.state,
      postalCode: address.postalCode != null ? '[redacted]' : address.postalCode,
      lines: address.lines ? address.lines.map(() => '[redacted]') : undefined,
      country: address.country, // Country is not PII
    };
  }

  private redactCustomer(customer: Customer): Record<string, unknown> {
    if (config.security.allowPii) return customer as unknown as Record<string, unknown>;

    const { background, firstName, lastName, jobTitle, location, photoUrl, age, _embedded, ...rest } = customer;
    const redacted: Record<string, unknown> = {
      ...rest,
      firstName: firstName != null ? '[redacted]' : firstName,
      lastName: lastName != null ? '[redacted]' : lastName,
      jobTitle: jobTitle != null ? '[redacted]' : jobTitle,
      location: location != null ? '[redacted]' : location,
      photoUrl: photoUrl != null ? '[redacted]' : photoUrl,
      age: age != null ? '[redacted]' : age,
      background: background != null ? '[redacted]' : background,
    };

    if (_embedded) {
      const embeddedCopy = { ..._embedded };
      for (const key of ['emails', 'phones', 'chats', 'social_profiles', 'websites'] as const) {
        const entries = embeddedCopy[key];
        if (entries) {
          (embeddedCopy as Record<string, unknown>)[key] = entries.map(item => ({
            ...item,
            value: '[redacted]',
          }));
        }
      }
      if (embeddedCopy.properties) {
        embeddedCopy.properties = embeddedCopy.properties.map(prop => ({
          ...prop,
          value: prop.value != null ? '[redacted]' : prop.value,
          text: prop.text != null ? '[redacted]' : prop.text,
        }));
      }
      redacted._embedded = embeddedCopy;
    }

    return redacted;
  }

  private async getCustomer(args: unknown): Promise<CallToolResult> {
    const input = GetCustomerInputSchema.parse(args);

    // Fetch customer profile and address in parallel
    const [customerResponse, addressResponse] = await Promise.allSettled([
      helpScoutClient.get<Customer>(`/customers/${input.customerId}`),
      helpScoutClient.get<CustomerAddress>(`/customers/${input.customerId}/address`),
    ]);

    if (customerResponse.status === 'rejected') {
      throw customerResponse.reason;
    }

    const customer = customerResponse.value;

    // Handle address response: 404 means no address on file (expected), all other errors should surface
    let address: CustomerAddress | null = null;
    let addressNote: string | undefined;
    if (addressResponse.status === 'fulfilled') {
      address = addressResponse.value;
    } else {
      const reason = addressResponse.reason;
      const is404 = isApiError(reason) && reason.code === 'NOT_FOUND';
      if (!is404) {
        // Critical errors (auth, rate limit) should abort entirely
        if (isApiError(reason) && (reason.code === 'UNAUTHORIZED' || reason.code === 'RATE_LIMIT')) {
          throw reason;
        }
        // Non-API errors (TypeError, network) should propagate
        if (!isApiError(reason)) {
          throw reason;
        }
        // Other API errors: log and surface in response
        const errorMessage = reason.message || String(reason);
        logger.error('Address fetch failed for customer', { customerId: input.customerId, error: errorMessage });
        addressNote = `Address lookup failed: ${errorMessage}`;
      }
    }

    const result: Record<string, unknown> = this.redactCustomer(customer);
    if (address) {
      result.address = this.redactAddress(address);
    }
    if (addressNote) {
      result.addressNote = addressNote;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          customer: result,
          usage: 'NEXT STEPS: Use organizationId to explore their org with getOrganization. Use customer.id with structuredConversationFilter(customerIds) to find their conversations.',
        }, null, 2),
      }],
    };
  }

  private async listCustomers(args: unknown): Promise<CallToolResult> {
    const input = ListCustomersInputSchema.parse(args);

    // v2 API: page size is fixed at 50, 'size' param is not documented/supported
    const params: Record<string, unknown> = {
      page: input.page,
      sortField: input.sortField,
      sortOrder: input.sortOrder,
      firstName: input.firstName,
      lastName: input.lastName,
      query: input.query,
      mailbox: input.mailbox,
      modifiedSince: input.modifiedSince,
    };

    const response = await helpScoutClient.get<PaginatedResponse<Customer>>('/customers', params);
    const customers = response._embedded?.customers || [];

    // Slim view: strip _links and _embedded to keep response concise for browsing.
    // Use getCustomer for the full profile with all sub-resources.
    const slimResults = customers.map(c => {
      const redacted = this.redactCustomer(c);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _links, _embedded, ...slim } = redacted;
      // Extract primary email from _embedded for slim view (redacted if PII protection is on)
      const emails = (_embedded as Record<string, unknown[]> | undefined)?.emails;
      if (Array.isArray(emails) && emails.length > 0) {
        slim.primaryEmail = (emails[0] as Record<string, unknown>).value;
      }
      return slim;
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: slimResults,
          returnedCount: customers.length,
          pagination: response.page,
          usage: 'Use customer.id with getCustomer for full profile (includes emails, phones, address, etc.), or with structuredConversationFilter(customerIds) for their conversations.',
        }, null, 2),
      }],
    };
  }

  // NAS-728: v3 Customer search with email filter
  private async searchCustomersByEmail(args: unknown): Promise<CallToolResult> {
    const input = SearchCustomersByEmailInputSchema.parse(args);

    const params: Record<string, unknown> = {
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      query: input.query,
      modifiedSince: input.modifiedSince,
      createdSince: input.createdSince,
      cursor: input.cursor,
    };

    // v3 endpoint: construct absolute URL from configured base URL
    const v3Url = config.helpscout.baseUrl.replace(/\/v2\/?$/, '/v3/customers');
    if (v3Url === config.helpscout.baseUrl) {
      logger.warn('v3 URL construction: baseUrl did not match /v2/ pattern, URL may be incorrect', { baseUrl: config.helpscout.baseUrl, v3Url });
    }
    const v3Response = await helpScoutClient.get<{
      _embedded: { customers: Customer[] };
      _links?: { next?: { href: string } };
    }>(v3Url, params);

    const customers = v3Response._embedded?.customers || [];

    // Extract cursor token from v3 next link (full URL -> just the cursor param value)
    let nextCursor: string | undefined;
    const nextHref = v3Response._links?.next?.href;
    if (nextHref) {
      try {
        const url = new URL(nextHref);
        nextCursor = url.searchParams.get('cursor') || nextHref;
      } catch (parseError) {
        logger.debug('Could not parse v3 next link as URL, using raw href as cursor', {
          nextHref,
          error: parseError instanceof Error ? parseError.message : String(parseError),
        });
        nextCursor = nextHref;
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: customers.map(c => this.redactCustomer(c)),
          returnedCount: customers.length,
          searchedEmail: config.security.allowPii ? input.email : '[redacted]',
          nextCursor,
          note: 'v3 API uses cursor-based pagination. Pass nextCursor value back as cursor parameter for more results.',
          usage: 'Use customer.id with getCustomer for full profile with sub-resources.',
        }, null, 2),
      }],
    };
  }

  // NAS-727: Customer sub-resource contacts tool
  private async getCustomerContacts(args: unknown): Promise<CallToolResult> {
    const input = GetCustomerContactsInputSchema.parse(args);
    const cid = input.customerId;

    // Fetch all 6 sub-resources in parallel via dedicated endpoints
    const [emailsRes, phonesRes, chatsRes, socialRes, websitesRes, addressRes] = await Promise.allSettled([
      helpScoutClient.get<{ _embedded?: { emails?: Array<{ id: number; value: string; type: string }> } }>(`/customers/${cid}/emails`),
      helpScoutClient.get<{ _embedded?: { phones?: Array<{ id: number; value: string; type: string }> } }>(`/customers/${cid}/phones`),
      helpScoutClient.get<{ _embedded?: { chats?: Array<{ id: number; value: string; type: string }> } }>(`/customers/${cid}/chats`),
      helpScoutClient.get<{ _embedded?: { social_profiles?: Array<{ id: number; value: string; type: string }> } }>(`/customers/${cid}/social-profiles`),
      helpScoutClient.get<{ _embedded?: { websites?: Array<{ id: number; value: string }> } }>(`/customers/${cid}/websites`),
      helpScoutClient.get<CustomerAddress>(`/customers/${cid}/address`),
    ]);

    // Helper: extract data or note the error
    const extract = <T>(settled: PromiseSettledResult<T>, label: string): { data: T | null; error?: string } => {
      if (settled.status === 'fulfilled') return { data: settled.value };
      const reason = settled.reason;
      // 404 = no data on file (normal)
      if (isApiError(reason) && reason.code === 'NOT_FOUND') return { data: null };
      // Auth/rate limit errors should abort
      if (isApiError(reason) && (reason.code === 'UNAUTHORIZED' || reason.code === 'RATE_LIMIT')) throw reason;
      // Non-API errors (TypeError, ReferenceError, etc.) are programming bugs; propagate them
      if (!isApiError(reason)) throw reason;
      return { data: null, error: `${label} fetch failed (${reason.code}): ${reason.message}` };
    };

    const emails = extract(emailsRes, 'emails');
    const phones = extract(phonesRes, 'phones');
    const chats = extract(chatsRes, 'chats');
    const social = extract(socialRes, 'social profiles');
    const websites = extract(websitesRes, 'websites');
    const address = extract(addressRes, 'address');

    const redactValue = (v: string) => config.security.allowPii ? v : '[redacted]';
    const redactEntry = (e: { id: number; value: string; type?: string }) => ({
      id: e.id, value: redactValue(e.value), ...(e.type ? { type: e.type } : {}),
    });

    const result: Record<string, unknown> = {
      customerId: cid,
      emails: emails.data ? (emails.data._embedded?.emails || []).map(redactEntry) : [],
      phones: phones.data ? (phones.data._embedded?.phones || []).map(redactEntry) : [],
      chats: chats.data ? (chats.data._embedded?.chats || []).map(redactEntry) : [],
      socialProfiles: social.data ? (social.data._embedded?.social_profiles || []).map(redactEntry) : [],
      websites: websites.data ? (websites.data._embedded?.websites || []).map(e => ({ id: e.id, value: redactValue(e.value) })) : [],
      address: address.data ? this.redactAddress(address.data as CustomerAddress) : null,
    };

    // Collect any partial errors
    const errors = [emails, phones, chats, social, websites, address]
      .map(r => r.error).filter(Boolean);
    if (errors.length > 0) {
      logger.error('getCustomerContacts returned partial results', {
        customerId: cid,
        failedResources: errors,
        successCount: 6 - errors.length,
      });
      result.partialErrors = errors;
    }

    // Warn if all sub-resources returned no data (likely invalid customerId)
    const allEmpty = !emails.data && !phones.data && !chats.data && !social.data && !websites.data && !address.data;
    if (allEmpty && errors.length === 0) {
      result.warning = 'No contact data found. Verify the customerId exists using getCustomer.';
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...result,
          usage: 'This returns all contact channels for a customer. Use getCustomer for the full profile with demographics.',
        }, null, 2),
      }],
    };
  }

  // ── Organization Tools (NAS-684, NAS-712) ──

  private redactOrganization(org: Organization): Record<string, unknown> {
    if (config.security.allowPii) return org as unknown as Record<string, unknown>;

    return {
      ...org,
      website: org.website != null ? '[redacted]' : org.website,
      domains: org.domains ? org.domains.map(() => '[redacted]') : org.domains,
      phones: org.phones ? org.phones.map(() => '[redacted]') : org.phones,
      location: org.location != null ? '[redacted]' : org.location,
      note: org.note != null ? '[redacted]' : org.note,
      description: org.description != null ? '[redacted]' : org.description,
    };
  }

  private async getOrganization(args: unknown): Promise<CallToolResult> {
    const input = GetOrganizationInputSchema.parse(args);

    const params: Record<string, unknown> = {};
    if (input.includeCounts) params.includeCounts = true;
    if (input.includeProperties) params.includeProperties = true;

    const org = await helpScoutClient.get<Organization>(
      `/organizations/${input.organizationId}`,
      params
    );

    const orgResult = this.redactOrganization(org);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          organization: orgResult,
          usage: 'NEXT STEPS: Use getOrganizationMembers to see customers in this org. Use getOrganizationConversations to see all conversations.',
        }, null, 2),
      }],
    };
  }

  private async listOrganizations(args: unknown): Promise<CallToolResult> {
    const input = ListOrganizationsInputSchema.parse(args);

    // v2 API: page size is fixed at 50
    const response = await helpScoutClient.get<PaginatedResponse<Organization>>('/organizations', {
      page: input.page,
      sort: `${input.sortField},${input.sortOrder}`,
    });

    const organizations = response._embedded?.organizations || [];

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: organizations.map(org => this.redactOrganization(org)),
          returnedCount: organizations.length,
          pagination: response.page,
          nextCursor: response._links?.next?.href,
          nextPage: response._links?.next?.href ? (response.page?.number ?? 0) + 1 : undefined,
          usage: 'Use organization.id with getOrganization for details, getOrganizationMembers for customers, or getOrganizationConversations for support history.',
        }, null, 2),
      }],
    };
  }

  // NAS-712: Customer-Org relational traversal
  private async getOrganizationMembers(args: unknown): Promise<CallToolResult> {
    const input = GetOrganizationMembersInputSchema.parse(args);

    // v2 API: page size is fixed at 50
    const response = await helpScoutClient.get<PaginatedResponse<Customer>>(
      `/organizations/${input.organizationId}/customers`,
      { page: input.page }
    );

    const customers = response._embedded?.customers || [];

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          organizationId: input.organizationId,
          members: customers.map(c => this.redactCustomer(c)),
          returnedCount: customers.length,
          pagination: response.page,
          nextCursor: response._links?.next?.href,
          nextPage: response._links?.next?.href ? (response.page?.number ?? 0) + 1 : undefined,
          usage: 'Use customer.id with getCustomer for full profile or structuredConversationFilter(customerIds) for their conversations.',
        }, null, 2),
      }],
    };
  }

  private async getOrganizationConversations(args: unknown): Promise<CallToolResult> {
    const input = GetOrganizationConversationsInputSchema.parse(args);

    // v2 API: page size is fixed at 50
    const response = await helpScoutClient.get<PaginatedResponse<Conversation>>(
      `/organizations/${input.organizationId}/conversations`,
      { page: input.page }
    );

    const conversations = response._embedded?.conversations || [];

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          organizationId: input.organizationId,
          conversations: conversations.map(c => ({
            id: c.id,
            number: c.number,
            subject: c.subject,
            status: c.status,
            customer: config.security.allowPii ? c.customer : (c.customer ? {
              id: c.customer.id,
              email: c.customer.email != null ? '[redacted]' : c.customer.email,
              firstName: c.customer.firstName != null ? '[redacted]' : c.customer.firstName,
              lastName: c.customer.lastName != null ? '[redacted]' : c.customer.lastName,
            } : null),
            assignee: config.security.allowPii ? c.assignee : (c.assignee ? {
              id: c.assignee.id,
              firstName: '[redacted]',
              lastName: '[redacted]',
              email: '[redacted]',
            } : null),
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            closedAt: c.closedAt,
            tags: c.tags,
          })),
          returnedCount: conversations.length,
          pagination: response.page,
          nextCursor: response._links?.next?.href,
          nextPage: response._links?.next?.href ? (response.page?.number ?? 0) + 1 : undefined,
          usage: 'Use conversation.id with getThreads to read full message history, or getConversationSummary for a quick overview.',
        }, null, 2),
      }],
    };
  }

  // ── Write Tools ──

  private async createNote(args: unknown): Promise<CallToolResult> {
    const input = CreateNoteInputSchema.parse(args);

    await helpScoutClient.post(
      `/conversations/${input.conversationId}/notes`,
      { text: input.text }
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            conversationId: input.conversationId,
            message: 'Note added successfully',
          }, null, 2),
        },
      ],
    };
  }

  private async updateConversationTags(args: unknown): Promise<CallToolResult> {
    const input = UpdateConversationTagsInputSchema.parse(args);

    await helpScoutClient.put(
      `/conversations/${input.conversationId}/tags`,
      { tags: input.tags }
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            conversationId: input.conversationId,
            tags: input.tags,
            message: 'Tags updated successfully. Note: this replaced all previous tags on the conversation.',
          }, null, 2),
        },
      ],
    };
  }

  private async assignConversation(args: unknown): Promise<CallToolResult> {
    const input = AssignConversationInputSchema.parse(args);

    await helpScoutClient.patch(
      `/conversations/${input.conversationId}`,
      { op: 'replace', path: '/assignTo', value: input.userId }
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            conversationId: input.conversationId,
            assignedTo: input.userId,
            message: 'Conversation assigned successfully.',
          }, null, 2),
        },
      ],
    };
  }

  private async getSavedReplies(args: unknown): Promise<CallToolResult> {
    const input = GetSavedRepliesInputSchema.parse(args);
    const mailboxId = input.inboxId ?? '348804';

    const response = await helpScoutClient.get<Record<string, unknown> | unknown[]>(
      `/mailboxes/${mailboxId}/saved-replies`
    );

    let replies: Array<Record<string, unknown>> = Array.isArray(response)
      ? (response as Array<Record<string, unknown>>)
      : [];
    if (!Array.isArray(response) && response && typeof response === 'object') {
      const embedded = (response as Record<string, unknown>)._embedded as
        | Record<string, unknown>
        | undefined;
      if (embedded) {
        const fromEmbedded =
          (embedded['saved-replies'] as Array<Record<string, unknown>> | undefined) ??
          (embedded['savedReplies'] as Array<Record<string, unknown>> | undefined) ??
          (Object.values(embedded)[0] as Array<Record<string, unknown>> | undefined) ??
          [];
        replies = fromEmbedded;
      }
    }

    if (input.search) {
      const term = input.search.toLowerCase();
      replies = replies.filter((r) => {
        const name = r.name;
        return typeof name === 'string' && name.toLowerCase().includes(term);
      });
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            totalCount: replies.length,
            savedReplies: replies.map((r) => ({
              id: r.id,
              name: r.name,
              text: r.text,
              createdAt: r.createdAt,
              updatedAt: r.updatedAt,
            })),
          }, null, 2),
        },
      ],
    };
  }

  private async resizeImageForResponse(
    buffer: Buffer,
    mimeType: string
  ): Promise<{
    data: Buffer;
    mimeType: string;
    resizedFrom?: { width: number; height: number; bytes: number };
  }> {
    const TARGET_BYTES = 563_000;

    if (buffer.length <= TARGET_BYTES) {
      return { data: buffer, mimeType };
    }

    let originalDims: { width: number; height: number; bytes: number };
    let format: string | undefined;
    try {
      const metadata = await sharp(buffer).metadata();
      originalDims = {
        width: metadata.width ?? 0,
        height: metadata.height ?? 0,
        bytes: buffer.length,
      };
      format = metadata.format;
    } catch (err) {
      logger.debug('sharp metadata failed; returning original buffer', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { data: buffer, mimeType };
    }

    const isPng = mimeType === 'image/png' || format === 'png';

    if (!isPng) {
      try {
        const tier1 = await sharp(buffer).jpeg({ quality: 95 }).toBuffer();
        if (tier1.length <= TARGET_BYTES) {
          logger.debug('image resize tier 1', {
            tier: 1,
            originalBytes: buffer.length,
            finalBytes: tier1.length,
            originalDims,
            mimeType: 'image/jpeg',
          });
          return { data: tier1, mimeType: 'image/jpeg' };
        }
      } catch (err) {
        logger.debug('sharp tier 1 failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    try {
      const tier2Pipeline = sharp(buffer).resize({
        width: 2048,
        height: 2048,
        fit: 'inside',
        withoutEnlargement: true,
      });
      const tier2 = isPng
        ? await tier2Pipeline.png().toBuffer()
        : await tier2Pipeline.jpeg({ quality: 90 }).toBuffer();
      const tier2Mime = isPng ? 'image/png' : 'image/jpeg';
      if (tier2.length <= TARGET_BYTES) {
        logger.debug('image resize tier 2', {
          tier: 2,
          originalBytes: buffer.length,
          finalBytes: tier2.length,
          originalDims,
          mimeType: tier2Mime,
        });
        return { data: tier2, mimeType: tier2Mime, resizedFrom: originalDims };
      }
    } catch (err) {
      logger.debug('sharp tier 2 failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const tier3 = await sharp(buffer)
        .resize({
          width: 1600,
          height: 1600,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 82 })
        .toBuffer();
      logger.debug('image resize tier 3', {
        tier: tier3.length <= TARGET_BYTES ? 3 : 4,
        originalBytes: buffer.length,
        finalBytes: tier3.length,
        originalDims,
        mimeType: 'image/jpeg',
      });
      return { data: tier3, mimeType: 'image/jpeg', resizedFrom: originalDims };
    } catch (err) {
      logger.debug('sharp tier 3 failed; returning original', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { data: buffer, mimeType, resizedFrom: originalDims };
    }
  }

  private async getAttachmentFile(args: unknown): Promise<CallToolResult> {
    const input = GetAttachmentFileInputSchema.parse(args);
    const MAX_BASE64_BYTES = 750_000;
    const NON_IMAGE_MAX_DECODED_BYTES = 5_000_000;

    try {
      const response = await helpScoutClient.get<{ data: string }>(
        `/conversations/${input.conversationId}/attachments/${input.attachmentId}/data`,
        undefined,
        { ttl: 0 }
      );

      const rawBuffer = Buffer.from(response.data, 'base64');

      if (input.mimeType === 'application/pdf') {
        const DEFAULT_PAGE_CAP = 5;
        const rasterizeResult = await rasterizePdf(rawBuffer, {
          startPage: 1,
          endPage: DEFAULT_PAGE_CAP,
        });

        const blocks = await this.buildPdfPageContentBlocks(rasterizeResult.pages);

        const headerText = rasterizeResult.pagesSkipped > 0
          ? `PDF rendered as ${rasterizeResult.pagesReturned} page image(s). PDF has ${rasterizeResult.totalPagesInPdf} total pages — only the first ${DEFAULT_PAGE_CAP} were rasterized. Use getPdfAsImages with explicit page range to see additional pages.`
          : `PDF rendered as ${rasterizeResult.pagesReturned} page image(s).`;

        return {
          content: [
            { type: 'text', text: headerText },
            ...blocks,
          ],
        };
      }

      if (input.mimeType.startsWith('image/')) {
        const {
          data: finalBuffer,
          mimeType: finalMimeType,
          resizedFrom,
        } = await this.resizeImageForResponse(rawBuffer, input.mimeType);

        const finalBase64 = finalBuffer.toString('base64');

        if (finalBase64.length > MAX_BASE64_BYTES) {
          const message = resizedFrom
            ? `Image was resized but still exceeds protocol size limit. Original: ${resizedFrom.width}x${resizedFrom.height}, ${resizedFrom.bytes} bytes. Final: ${finalBase64.length} bytes (over ${MAX_BASE64_BYTES}). View directly in Help Scout.`
            : `Attachment exceeds size limit (${finalBase64.length} bytes, max ${MAX_BASE64_BYTES}). View directly in Help Scout.`;
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'attachment_too_large',
                  size: finalBase64.length,
                  maxSize: MAX_BASE64_BYTES,
                  originalMimeType: input.mimeType,
                  finalMimeType,
                  resizedFrom,
                  message,
                }, null, 2),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'image',
              data: finalBase64,
              mimeType: finalMimeType,
            },
          ],
        };
      }

      if (rawBuffer.length > NON_IMAGE_MAX_DECODED_BYTES) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'attachment_too_large',
                size: rawBuffer.length,
                maxSize: NON_IMAGE_MAX_DECODED_BYTES,
                mimeType: input.mimeType,
                message: `Attachment is ${rawBuffer.length} bytes (decoded), exceeds ${NON_IMAGE_MAX_DECODED_BYTES}-byte cap. View directly in Help Scout instead.`,
              }, null, 2),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'resource',
            resource: {
              uri: `helpscout://conversations/${input.conversationId}/attachments/${input.attachmentId}`,
              mimeType: input.mimeType,
              blob: response.data,
            },
          },
          {
            type: 'text',
            text: `Returned non-image attachment as base64 resource. mimeType=${input.mimeType}, size=~${rawBuffer.length} bytes.`,
          },
        ],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error fetching attachment.';
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'attachment_fetch_failed',
              conversationId: input.conversationId,
              attachmentId: input.attachmentId,
              message,
            }, null, 2),
          },
        ],
      };
    }
  }

  private async buildPdfPageContentBlocks(
    pages: Array<{ pageNumber: number; pngBuffer: Buffer }>
  ): Promise<Array<{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }>> {
    const MAX_BASE64_BYTES = 750_000;
    const blocks: Array<{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }> = [];
    for (const page of pages) {
      const resized = await this.resizeImageForResponse(page.pngBuffer, 'image/png');
      const finalBase64 = resized.data.toString('base64');
      if (finalBase64.length > MAX_BASE64_BYTES) {
        blocks.push({
          type: 'text',
          text: `[Page ${page.pageNumber} too large to render even after resize — skipped.]`,
        });
        continue;
      }
      blocks.push({
        type: 'image',
        data: finalBase64,
        mimeType: resized.mimeType,
      });
    }
    return blocks;
  }

  private async getPdfAsImages(args: unknown): Promise<CallToolResult> {
    const input = GetPdfAsImagesInputSchema.parse(args);

    try {
      const hsResponse = await helpScoutClient.get<{ data: string }>(
        `/conversations/${input.conversationId}/attachments/${input.attachmentId}/data`,
        undefined,
        { ttl: 0 }
      );

      const pdfBuffer = Buffer.from(hsResponse.data, 'base64');

      const rasterizeResult = await rasterizePdf(pdfBuffer, {
        startPage: input.startPage,
        endPage: input.endPage,
        dpi: input.dpi,
      });

      const blocks = await this.buildPdfPageContentBlocks(rasterizeResult.pages);

      return {
        content: [
          {
            type: 'text',
            text: `Rendered ${rasterizeResult.pagesReturned} page(s) at ${input.dpi ?? 200} DPI. PDF total pages: ${rasterizeResult.totalPagesInPdf}.`,
          },
          ...blocks,
        ],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'pdf_rasterize_failed',
              conversationId: input.conversationId,
              attachmentId: input.attachmentId,
              message,
            }, null, 2),
          },
        ],
      };
    }
  }

  private async getInlineImage(args: unknown): Promise<CallToolResult> {
    const input = GetInlineImageInputSchema.parse(args);

    try {
      const { data, contentType } = await fetchInlineImage(input.url);

      const resized = await this.resizeImageForResponse(data, contentType);
      const finalBase64 = resized.data.toString('base64');

      if (finalBase64.length > 750_000) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'image_too_large',
                originalSize: data.length,
                resizedSize: finalBase64.length,
                url: input.url,
                message: 'Image exceeded MCP protocol size limit even after adaptive resize.',
              }, null, 2),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'image',
            data: finalBase64,
            mimeType: resized.mimeType,
          },
        ],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'inline_image_fetch_failed',
              url: input.url,
              message,
            }, null, 2),
          },
        ],
      };
    }
  }

  private async pushAttachmentToAirtable(args: unknown): Promise<CallToolResult> {
    const input = PushAttachmentToAirtableInputSchema.parse(args);

    const AIRTABLE_MAX_BYTES = 5_000_000;
    const COMPRESS_TARGET_BYTES = 4_000_000;
    const COMPRESS_MAX_EDGE = 3000;
    const COMPRESS_QUALITY = 92;

    try {
      const hsResponse = await helpScoutClient.get<{ data: string }>(
        `/conversations/${input.conversationId}/attachments/${input.attachmentId}/data`,
        undefined,
        { ttl: 0 }
      );

      const originalBuffer = Buffer.from(hsResponse.data, 'base64');
      const originalSize = originalBuffer.length;

      if (input.rasterizePdfPages && input.contentType === 'application/pdf') {
        const rasterizeResult = await rasterizePdf(originalBuffer, { startPage: 1, endPage: 100 });
        const baseFilename = input.filename.replace(/\.pdf$/i, '');
        const uploadedAttachments: Array<{ pageNumber: number; airtableRecordId: string; sizeBytes: number }> = [];
        const errors: Array<{ pageNumber: number; error: string }> = [];

        for (const page of rasterizeResult.pages) {
          try {
            let pageBuffer: Buffer = page.pngBuffer;
            let pageContentType = 'image/png';

            if (pageBuffer.length > AIRTABLE_MAX_BYTES) {
              pageBuffer = await sharp(page.pngBuffer)
                .resize({
                  width: COMPRESS_MAX_EDGE,
                  height: COMPRESS_MAX_EDGE,
                  fit: 'inside',
                  withoutEnlargement: true,
                })
                .jpeg({ quality: COMPRESS_QUALITY })
                .toBuffer();
              pageContentType = 'image/jpeg';
            }

            const finalFilename = pageContentType === 'image/jpeg'
              ? `${baseFilename}-page${page.pageNumber}.jpg`
              : `${baseFilename}-page${page.pageNumber}.png`;

            const airtableResponse = await airtableClient.uploadAttachment({
              baseId: input.baseId,
              recordId: input.recordId,
              fieldId: input.fieldId,
              filename: finalFilename,
              contentType: pageContentType,
              base64: pageBuffer.toString('base64'),
            });

            uploadedAttachments.push({
              pageNumber: page.pageNumber,
              airtableRecordId: airtableResponse.id,
              sizeBytes: pageBuffer.length,
            });
          } catch (error: unknown) {
            errors.push({
              pageNumber: page.pageNumber,
              error: error instanceof Error ? error.message : 'unknown',
            });
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: errors.length === 0,
                mode: 'rasterized',
                baseId: input.baseId,
                fieldId: input.fieldId,
                totalPagesInPdf: rasterizeResult.totalPagesInPdf,
                pagesUploaded: uploadedAttachments.length,
                pagesFailed: errors.length,
                uploads: uploadedAttachments,
                errors: errors.length > 0 ? errors : undefined,
                message: `Rasterized PDF and uploaded ${uploadedAttachments.length} page(s) as separate attachments.`,
              }, null, 2),
            },
          ],
        };
      }

      let uploadBuffer = originalBuffer;
      let uploadContentType = input.contentType;
      let compressed = false;
      let compressionMetadata:
        | { originalSize: number; finalSize: number; originalDims?: { width: number; height: number } }
        | undefined;

      if (originalSize > AIRTABLE_MAX_BYTES) {
        if (!input.contentType.startsWith('image/')) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'attachment_too_large_non_image',
                  originalSize,
                  maxSize: AIRTABLE_MAX_BYTES,
                  contentType: input.contentType,
                  message: `Non-image attachment is ${originalSize} bytes, exceeds Airtable's 5MB cap. Cannot auto-compress non-images. Upload manually or split the file.`,
                }, null, 2),
              },
            ],
          };
        }

        try {
          const metadata = await sharp(originalBuffer).metadata();
          const firstPass = await sharp(originalBuffer)
            .resize({
              width: COMPRESS_MAX_EDGE,
              height: COMPRESS_MAX_EDGE,
              fit: 'inside',
              withoutEnlargement: true,
            })
            .jpeg({ quality: COMPRESS_QUALITY })
            .toBuffer();

          if (firstPass.length > COMPRESS_TARGET_BYTES) {
            const aggressive = await sharp(originalBuffer)
              .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 85 })
              .toBuffer();

            if (aggressive.length > AIRTABLE_MAX_BYTES) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      error: 'compression_failed_to_fit',
                      originalSize,
                      compressedSize: aggressive.length,
                      maxSize: AIRTABLE_MAX_BYTES,
                      message: `Image still exceeds 5MB after aggressive compression (${aggressive.length} bytes). Original may be unusually large or already heavily compressed. Manual upload required.`,
                    }, null, 2),
                  },
                ],
              };
            }

            uploadBuffer = aggressive;
          } else {
            uploadBuffer = firstPass;
          }

          uploadContentType = 'image/jpeg';
          compressed = true;
          compressionMetadata = {
            originalSize,
            finalSize: uploadBuffer.length,
            originalDims:
              metadata.width && metadata.height
                ? { width: metadata.width, height: metadata.height }
                : undefined,
          };

          logger.debug('image compressed for airtable upload', {
            originalSize,
            compressedSize: uploadBuffer.length,
            originalDims: compressionMetadata.originalDims,
          });
        } catch (sharpError: unknown) {
          const message = sharpError instanceof Error ? sharpError.message : 'sharp processing failed';
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'compression_failed',
                  originalSize,
                  maxSize: AIRTABLE_MAX_BYTES,
                  message: `Image is ${originalSize} bytes (over Airtable's 5MB cap) and compression failed: ${message}. Manual upload required.`,
                }, null, 2),
              },
            ],
          };
        }
      }

      const finalFilename =
        compressed && !/\.(jpg|jpeg)$/i.test(input.filename)
          ? input.filename.replace(/\.[^.]+$/, '.jpg')
          : input.filename;

      const airtableResponse = await airtableClient.uploadAttachment({
        baseId: input.baseId,
        recordId: input.recordId,
        fieldId: input.fieldId,
        filename: finalFilename,
        contentType: uploadContentType,
        base64: uploadBuffer.toString('base64'),
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              airtableRecordId: airtableResponse.id,
              baseId: input.baseId,
              fieldId: input.fieldId,
              uploadedAs: {
                filename: finalFilename,
                contentType: uploadContentType,
                sizeBytes: uploadBuffer.length,
              },
              compressed,
              compressionMetadata,
              message: compressed
                ? `Attachment compressed (${compressionMetadata!.originalSize} → ${compressionMetadata!.finalSize} bytes) and uploaded to Airtable record ${airtableResponse.id}.`
                : `Attachment uploaded to Airtable record ${airtableResponse.id} at original quality (${uploadBuffer.length} bytes).`,
            }, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'push_failed',
              conversationId: input.conversationId,
              attachmentId: input.attachmentId,
              baseId: input.baseId,
              recordId: input.recordId,
              fieldId: input.fieldId,
              message,
            }, null, 2),
          },
        ],
      };
    }
  }
}

export const toolHandler = new ToolHandler();