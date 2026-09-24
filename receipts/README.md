# Receipts (moved here from the scripts repo, 2026-09-23)

`generate_receipt.py` renders an itemized Tajima Direct receipt PDF from a JSON spec (layout, fields and
the spec shape are documented in the RECEIPT_GENERATOR row of the Claude table). The logo is in `assets/`.

Cloud routine recipe (this repo is cloned into every run):

    pip3 install --quiet -r receipts/requirements.txt          # once per session; pypi is allowed
    python3 receipts/generate_receipt.py --spec /tmp/receipt.json --out /tmp/receipt-<order>.pdf
    # then post the CL note with the file attached:
    #   createNote { conversationId, text, attachmentPaths: ["/tmp/receipt-<order>.pdf"] }

The spec comes from the Shopify order (Shopify connector `get-order`) cross-checked against Airtable.
