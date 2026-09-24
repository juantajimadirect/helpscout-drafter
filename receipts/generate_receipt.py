#!/usr/bin/env python3
"""
generate_receipt.py — render a Tajima itemized insurance receipt PDF from a JSON spec.

Format is the canonical one documented in KB Docs/Receipt_Generator_V325_01.md.
Claude assembles the spec from the live Shopify order (via tajima_api.get_order) + Airtable,
then calls this to render. Keeps rendering pure/testable and separate from data-fetching.

Requires reportlab. RUN WITH /usr/bin/python3 (3.9) — the default python3 (3.7) has a broken Pillow.
  /usr/bin/python3 -m pip install --user reportlab pillow      # one-time

Usage:
  /usr/bin/python3 generate_receipt.py --spec receipt.json [--out /abs/path.pdf]
If --out is omitted, saves to the system temp dir as Tajima_Itemized_Receipt_Order#<num>_<LastName>.pdf (path is printed)

Spec JSON (omit optional keys to skip those lines):
{
  "order_number": "3012986",
  "order_date": "April 10, 2026",                 // optional
  "fulfillment_date": "April 28, 2026",           // optional
  "customer_name": "John Abd-El-Malek",
  "shipping_address": ["1531 University Ave", "Palo Alto, CA 94301-3140", "US"],
  "contact_info": "+1 650-861-2182",
  "email": "john.abdelmalek@gmail.com",
  "line_items": [
    {"description": "Prescription Sunglass Lens Replacement (Gray 15, Polarized, 1.67 High-Index)",
     "amount": "545.00",
     "subbullets": ["Prescription Type: Single Vision", "Frame: Masunaga Empire II 52mm"]}
  ],
  "shipping": "Free via USPS First Class 2–5 Days",
  "subtotal": "545.00",
  "discount": {"code": "SIGNUP10", "amount": "10.00"},   // optional
  "tax": "12.34",                                          // optional
  "total_paid": "545.00",
  "payment_status": "Paid",
  "last_name": "Abd-El-Malek"
}
"""
import argparse, json, os
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor, black
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Image
from reportlab.lib.styles import ParagraphStyle

HERE = os.path.dirname(os.path.abspath(__file__))
LOGO = os.path.join(HERE, "assets", "tajima_logo.jpg")
import tempfile
RECEIPTS_DIR = tempfile.gettempdir()  # no shared Receipts folder any more (2026-09-23); attach the PDF to the Help Scout note
NAVY = HexColor("#0a1f5c")


def build(spec, out_path):
    body = ParagraphStyle("body", fontName="Helvetica", fontSize=10, textColor=black, leading=12, alignment=TA_LEFT, spaceAfter=5)
    addr = ParagraphStyle("addr", parent=body, spaceAfter=2)
    bullet = ParagraphStyle("bullet", parent=body, leftIndent=16, spaceAfter=4)
    section = ParagraphStyle("section", parent=body, fontName="Helvetica-Bold", spaceAfter=5)
    title = ParagraphStyle("title", fontName="Helvetica-Bold", fontSize=20, textColor=NAVY, leading=22, alignment=TA_LEFT, spaceBefore=2, spaceAfter=8)
    subtitle = ParagraphStyle("subtitle", fontName="Helvetica", fontSize=10, textColor=black, leading=13, spaceAfter=12)

    def P(t, s=body):
        return Paragraph(t, s)

    story = []
    # Logo top-right, standalone, above the title
    from reportlab.lib.utils import ImageReader
    iw, ih = ImageReader(LOGO).getSize()
    w = 1.5 * inch
    logo = Image(LOGO, width=w, height=w * ih / iw)
    logo.hAlign = "RIGHT"
    story.append(logo)

    story.append(P("Tajima Lens Technology", title))
    story.append(P("Itemized Receipt for Prescription Lens Replacement", subtitle))
    story.append(Spacer(1, 6))

    # Order details
    story.append(P(f"<b>Order Number:</b> #{spec['order_number']}"))
    if spec.get("order_date"):
        story.append(P(f"<b>Order Date:</b> {spec['order_date']}"))
    if spec.get("fulfillment_date"):
        story.append(P(f"<b>Fulfillment Date:</b> {spec['fulfillment_date']}"))
    story.append(P(f"<b>Customer Name:</b> {spec['customer_name']}"))
    addr_lines = spec.get("shipping_address", [])
    if addr_lines:
        story.append(P("<b>Shipping Address:</b>", addr))
        for ln in addr_lines[:-1]:
            story.append(P(ln, addr))
        story.append(P(addr_lines[-1], body))
    if spec.get("contact_info"):
        story.append(P(f"<b>Contact Info:</b> {spec['contact_info']}"))
    if spec.get("email"):
        story.append(P(f"<b>Email:</b> {spec['email']}"))
    story.append(Spacer(1, 6))

    # Itemized charges
    story.append(P("Itemized Charges:", section))
    for it in spec["line_items"]:
        story.append(P(f"{it['description']} — ${it['amount']}"))
        for sb in it.get("subbullets", []):
            story.append(P(f"• {sb}", bullet))
    story.append(Spacer(1, 6))

    # Pricing block
    if spec.get("shipping"):
        story.append(P(f"<b>Shipping:</b> {spec['shipping']}"))
    if spec.get("tax"):
        story.append(P(f"<b>Tax:</b> ${spec['tax']}"))
    if spec.get("subtotal"):
        story.append(P(f"<b>Subtotal:</b> ${spec['subtotal']}"))
    if spec.get("discount"):
        d = spec["discount"]
        code = f" ({d['code']})" if d.get("code") else ""
        story.append(P(f"<b>Discount Applied{code}:</b> –${d['amount']}"))
    story.append(P(f"<b>Total Paid: ${spec['total_paid']}</b>"))
    story.append(P(f"<b>Payment Status:</b> {spec.get('payment_status', 'Paid')}"))
    story.append(Spacer(1, 6))

    # Footer
    story.append(P("<b>Provider:</b> Tajima Lens Technology"))
    story.append(P("<b>Service:</b> Custom Prescription Lens Replacement"))

    SimpleDocTemplate(out_path, pagesize=letter, leftMargin=inch, rightMargin=inch,
                      topMargin=inch, bottomMargin=inch,
                      title=f"Tajima Itemized Receipt - Order #{spec['order_number']}").build(story)
    return out_path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True)
    ap.add_argument("--out")
    a = ap.parse_args()
    spec = json.load(open(a.spec, encoding="utf-8"))
    out = a.out
    if not out:
        last = spec.get("last_name") or spec["customer_name"].split()[-1]
        os.makedirs(RECEIPTS_DIR, exist_ok=True)
        out = os.path.join(RECEIPTS_DIR, f"Tajima_Itemized_Receipt_Order#{spec['order_number']}_{last}.pdf")
    build(spec, out)
    print("WROTE:", out)


if __name__ == "__main__":
    main()
