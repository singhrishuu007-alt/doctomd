from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import mammoth
import pdfplumber
import razorpay
import hmac
import hashlib
import os
import io
import re

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "https://*.vercel.app", "https://doctomd-orpin.vercel.app"],
    allow_methods=["*"],
    allow_headers=["*"],
)

RZP_KEY_ID     = os.environ.get("RZP_KEY_ID", "")
RZP_KEY_SECRET = os.environ.get("RZP_KEY_SECRET", "")

MAX_FREE_MB = 5
UNLIMITED_PRICE_PAISE = 49900  # ₹499

# Pay-per-file tiers (size in MB → price in paise)
PAID_TIERS = [
    (20,  1000),   # 5–20 MB  → ₹10
    (50,  2000),   # 20–50 MB → ₹20
    (200, 4900),   # 50–200 MB → ₹49
]

# In-memory store for unlimited tokens (payment_id → True)
# In production replace with Redis/DB
unlimited_tokens: set[str] = set()

def get_price(size_mb: float) -> int | None:
    """Returns price in paise for files above free limit, or None if free."""
    if size_mb <= MAX_FREE_MB:
        return None
    for limit_mb, price_paise in PAID_TIERS:
        if size_mb <= limit_mb:
            return price_paise
    return PAID_TIERS[-1][1]


def clean_markdown(md: str) -> str:
    # Collapse 3+ blank lines to 2
    md = re.sub(r'\n{3,}', '\n\n', md)
    # Remove trailing spaces
    md = '\n'.join(line.rstrip() for line in md.split('\n'))
    return md.strip()


def convert_word(data: bytes) -> str:
    result = mammoth.convert_to_markdown(io.BytesIO(data))
    return clean_markdown(result.value)


def find_column_split(page) -> float | None:
    """
    Find the x-coordinate of the gap between two columns.
    Looks for the widest horizontal band with no word coverage
    in the central 20-80% of the page width.
    Returns the split x, or None if no clear column gap found.
    """
    words = page.extract_words()
    if len(words) < 20:
        return None

    W = page.width
    # Build a coverage map: for each x pixel bucket, is there a word?
    buckets = 200
    covered = [False] * buckets
    for w in words:
        lo = int(w['x0'] / W * buckets)
        hi = int(w['x1'] / W * buckets)
        for i in range(max(0, lo), min(buckets, hi + 1)):
            covered[i] = True

    # Find the longest gap in the central 15–85% region
    lo_bound = int(0.15 * buckets)
    hi_bound = int(0.85 * buckets)
    best_gap = 0
    best_center = None
    gap_start = None

    for i in range(lo_bound, hi_bound + 1):
        if not covered[i]:
            if gap_start is None:
                gap_start = i
        else:
            if gap_start is not None:
                gap_len = i - gap_start
                if gap_len > best_gap:
                    best_gap = gap_len
                    best_center = (gap_start + i) / 2
                gap_start = None

    # Require a meaningful gap (at least 3% of page width)
    if best_gap < 6 or best_center is None:
        return None

    return best_center / buckets * W


def extract_page_text(page) -> str:
    """Extract text respecting 2-column layout."""
    split_x = find_column_split(page)
    if split_x is None:
        return page.extract_text() or ""

    left_col = page.crop((0, 0, split_x, page.height))
    right_col = page.crop((split_x, 0, page.width, page.height))

    left_text = left_col.extract_text() or ""
    right_text = right_col.extract_text() or ""

    parts = [p for p in [left_text, right_text] if p.strip()]
    return "\n\n---\n\n".join(parts)  # visual separator between columns


def convert_pdf(data: bytes) -> str:
    lines = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for page in pdf.pages:
            text = extract_page_text(page)
            if text:
                lines.append(text)
            # Extract tables (only on single-column pages; skip 1-cell tables which are just boxes)
            if find_column_split(page) is None:
                for table in page.extract_tables():
                    if not table:
                        continue
                    # Skip single-cell tables (decorative boxes, not real data tables)
                    total_cells = sum(len(row) for row in table)
                    if total_cells <= 2:
                        continue
                    header = table[0]
                    rows = table[1:]
                    lines.append('\n| ' + ' | '.join(str(c or '') for c in header) + ' |')
                    lines.append('| ' + ' | '.join('---' for _ in header) + ' |')
                    for row in rows:
                        lines.append('| ' + ' | '.join(str(c or '') for c in row) + ' |')
                    lines.append('')
    return clean_markdown('\n\n'.join(lines))


@app.post("/convert")
async def convert(file: UploadFile = File(...), payment_id: str = "", unlimited_token: str = ""):
    if not file.filename:
        raise HTTPException(400, "No file provided")

    ext = file.filename.rsplit('.', 1)[-1].lower()
    if ext not in ('pdf', 'docx', 'doc'):
        raise HTTPException(400, f"Unsupported format: .{ext}. Supported: .pdf, .docx")

    data = await file.read()
    size_mb = len(data) / (1024 * 1024)

    is_unlimited = unlimited_token and unlimited_token in unlimited_tokens
    price = None if is_unlimited else get_price(size_mb)

    if price is not None and not payment_id:
        raise HTTPException(402, {
            "message": f"File is {size_mb:.1f} MB — payment required",
            "size_mb": round(size_mb, 2),
            "price_paise": price,
            "price_inr": price // 100,
        })

    try:
        if ext == 'pdf':
            markdown = convert_pdf(data)
        else:
            markdown = convert_word(data)
    except Exception as e:
        raise HTTPException(500, f"Conversion failed: {str(e)}")

    return JSONResponse({
        "markdown": markdown,
        "filename": file.filename,
        "size_mb": round(size_mb, 2),
        "word_count": len(markdown.split()),
        "char_count": len(markdown),
    })


class OrderRequest(BaseModel):
    size_mb: float

class UnlimitedOrderRequest(BaseModel):
    pass

@app.post("/create-order")
def create_order(body: OrderRequest):
    if not RZP_KEY_ID:
        raise HTTPException(500, "Payment not configured")
    price = get_price(body.size_mb)
    if price is None:
        raise HTTPException(400, "File is free, no payment needed")
    client = razorpay.Client(auth=(RZP_KEY_ID, RZP_KEY_SECRET))
    order = client.order.create({"amount": price, "currency": "INR", "payment_capture": 1})
    return JSONResponse({"order_id": order["id"], "amount": price, "key_id": RZP_KEY_ID, "type": "per_file"})

@app.post("/create-unlimited-order")
def create_unlimited_order():
    if not RZP_KEY_ID:
        raise HTTPException(500, "Payment not configured")
    client = razorpay.Client(auth=(RZP_KEY_ID, RZP_KEY_SECRET))
    order = client.order.create({"amount": UNLIMITED_PRICE_PAISE, "currency": "INR", "payment_capture": 1})
    return JSONResponse({"order_id": order["id"], "amount": UNLIMITED_PRICE_PAISE, "key_id": RZP_KEY_ID, "type": "unlimited"})


class VerifyRequest(BaseModel):
    razorpay_order_id: str
    razorpay_payment_id: str
    razorpay_signature: str
    type: str = "per_file"  # "per_file" or "unlimited"


@app.post("/verify-payment")
def verify_payment(body: VerifyRequest):
    msg = f"{body.razorpay_order_id}|{body.razorpay_payment_id}"
    expected = hmac.new(RZP_KEY_SECRET.encode(), msg.encode(), hashlib.sha256).hexdigest()
    if expected != body.razorpay_signature:
        raise HTTPException(400, "Payment verification failed")
    if body.type == "unlimited":
        unlimited_tokens.add(body.razorpay_payment_id)
    return JSONResponse({"pro": True, "payment_id": body.razorpay_payment_id, "type": body.type})

@app.get("/check-unlimited/{payment_id}")
def check_unlimited(payment_id: str):
    return JSONResponse({"valid": payment_id in unlimited_tokens})


@app.get("/health")
def health():
    return {"status": "ok"}
