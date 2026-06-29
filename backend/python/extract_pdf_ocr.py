#!/usr/bin/env python3
"""
OCR-based extraction for scanned (image-only) PDFs.
Called only when detect_pdf_type.py reports pdf_type="scanned".

Pipeline:
  PDF bytes → PyMuPDF (render pages at 200 DPI) → PIL Images
  → OpenCV preprocessing (grayscale, adaptive threshold, denoise)
  → pytesseract (--psm 6, uniform text block)
  → line/table parser → financial rows

Supports:
  --type profit_loss    → profit_loss_entries rows
  --type balance_sheet  → balance_sheet_entries rows
  --type general_ledger → general_ledger_entries rows (best-effort)
  --type bank_statement → bank_statement_entries rows (best-effort)
  --type tax_return     → tax_return_entries rows (best-effort)

Protocol:
  stdin  : raw PDF bytes
  stdout : JSON { rows: [...], detected_years: [...] }
  stderr : debug logs
  exit 0 : success (may return fewer rows than a text-layer PDF)
  exit 1 : critical failure (cannot render or OCR)
"""

import sys
import io
import re
import argparse
from datetime import datetime

# ── Dependency checks ─────────────────────────────────────────────────────────

try:
    import fitz  # PyMuPDF
except ImportError:
    print('{"error":"PyMuPDF not installed — run: pip install PyMuPDF","rows":[],"detected_years":[]}')
    sys.exit(1)

try:
    import pytesseract
    from PIL import Image
except ImportError:
    print('{"error":"pytesseract/Pillow not installed — run: pip install pytesseract Pillow","rows":[],"detected_years":[]}')
    sys.exit(1)

try:
    import cv2
    import numpy as np
    HAS_OPENCV = True
except ImportError:
    HAS_OPENCV = False

from common import (
    parse_amount, extract_year_from_text, infer_section, is_total_row,
    YEAR_PATTERN, emit, emit_error,
)

DPI         = 200    # render resolution — higher = more accurate, slower
TSS_CONFIG  = '--psm 6 -c preserve_interword_spaces=1'  # uniform block mode


def dbg(msg):
    print(f'[extract_pdf_ocr] {msg}', file=sys.stderr, flush=True)


# ── Rendering & preprocessing ─────────────────────────────────────────────────

def render_pages(pdf_bytes):
    """Render each PDF page to a PIL Image at DPI resolution."""
    doc    = fitz.open(stream=pdf_bytes, filetype='pdf')
    images = []
    mat    = fitz.Matrix(DPI / 72, DPI / 72)
    for page in doc:
        pix = page.get_pixmap(matrix=mat, alpha=False)
        img = Image.open(io.BytesIO(pix.tobytes('png'))).convert('RGB')
        images.append(img)
    doc.close()
    dbg(f'Rendered {len(images)} page(s) at {DPI} DPI')
    return images


def preprocess(pil_img):
    """
    Apply OpenCV preprocessing to improve OCR quality.
    Falls back to original image if OpenCV is unavailable.
    """
    if not HAS_OPENCV:
        return pil_img
    arr  = np.array(pil_img)
    gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
    # Adaptive threshold handles uneven lighting across scanned pages
    thresh = cv2.adaptiveThreshold(
        gray, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY, 15, 8,
    )
    denoised = cv2.fastNlMeansDenoising(thresh, h=10)
    return Image.fromarray(denoised)


def ocr_pages(images):
    """Run pytesseract on each preprocessed image and join page texts."""
    pages = []
    for i, img in enumerate(images):
        processed = preprocess(img)
        text      = pytesseract.image_to_string(processed, config=TSS_CONFIG)
        pages.append(text)
        dbg(f'Page {i + 1}: {len(text)} chars extracted')
    return '\n'.join(pages)


# ── Text utilities ────────────────────────────────────────────────────────────

def year_from_text(text, limit=3000):
    years = [int(y) for y in YEAR_PATTERN.findall(text[:limit]) if 1990 <= int(y) <= 2035]
    return max(years) if years else datetime.now().year


def as_of_date_from_text(text):
    m = re.search(
        r'as\s+of\s+(\w+\s+\d{1,2},?\s*\d{4}|\d{1,2}/\d{1,2}/\d{4})',
        text[:3000], re.IGNORECASE,
    )
    if not m:
        return None
    s = m.group(1).strip().rstrip(',')
    for fmt in ('%B %d %Y', '%b %d %Y', '%B %d, %Y', '%b %d, %Y', '%m/%d/%Y'):
        try:
            return datetime.strptime(s, fmt).strftime('%Y-%m-%d')
        except ValueError:
            pass
    return None


def trailing_amount(line):
    """Find the last dollar amount on a line."""
    for token in reversed(re.findall(r'[\-\(]?[\d,]+\.?\d*\)?', line)):
        v = parse_amount(token)
        if v is not None:
            return v
    return None


def strip_amount(line):
    """Remove the trailing amount from a line, returning the label."""
    return re.sub(r'[\-\(]?[\d,]+\.?\d*\)?\s*$', '', line).strip()


# ── P&L and Balance Sheet line parser ────────────────────────────────────────

def parse_statement_lines(text, doc_type, fiscal_year, as_of_date=None):
    result = []
    for line in text.split('\n'):
        line = line.strip()
        if not line or len(line) < 4:
            continue
        # Skip lines that are only numbers/symbols
        if re.match(r'^[\d\s.,\-()\$%]+$', line):
            continue

        amount = trailing_amount(line)
        if amount is None:
            continue

        account_name = strip_amount(line)
        if not account_name or len(account_name) < 2:
            continue

        if doc_type == 'profit_loss':
            result.append({
                'account_name': account_name,
                'account_type': None,
                'amount':       amount,
                'fiscal_year':  fiscal_year,
                'is_total':     is_total_row(account_name),
                'is_header':    False,
            })
        elif doc_type == 'balance_sheet':
            result.append({
                'account_name':     account_name,
                'account_number':   None,
                'section':          infer_section(account_name),
                'amount':           amount,
                'as_of_date':       as_of_date or f'{fiscal_year}-12-31',
                'fiscal_year':      fiscal_year,
                'is_total':         is_total_row(account_name),
                'is_section_header': False,
            })
    return result


# ── GL / Bank best-effort line parsers ───────────────────────────────────────

DATE_RE_INLINE = re.compile(r'\b(\d{1,2}[/\-]\d{1,2}[/\-]\d{4}|\d{4}-\d{2}-\d{2})\b')


def normalize_date(s):
    m = re.match(r'^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$', s.strip())
    if m:
        return f'{m.group(3)}-{m.group(1).zfill(2)}-{m.group(2).zfill(2)}'
    if re.match(r'^\d{4}-\d{2}-\d{2}$', s.strip()):
        return s.strip()
    return None


def parse_gl_lines(text, fiscal_year):
    result = []
    for line in text.split('\n'):
        m = DATE_RE_INLINE.search(line)
        if not m:
            continue
        date_str = normalize_date(m.group(1))
        if not date_str:
            continue
        fy     = int(date_str[:4])
        amount = trailing_amount(line)
        if amount is None:
            continue
        # Account name: text before the date
        label  = line[:m.start()].strip()
        if not label:
            label = line[m.end():].strip()
        label = re.sub(r'[\-\(]?[\d,]+\.?\d*\)?\s*$', '', label).strip()
        if not label:
            continue
        debit, credit = (amount, 0) if amount >= 0 else (0, abs(amount))
        result.append({
            'transaction_date': date_str,
            'fiscal_year':      fy,
            'account_number':   None,
            'account_name':     label,
            'description':      None,
            'reference':        None,
            'debit':            debit,
            'credit':           credit,
            'journal_type':     None,
            'class':            None,
            'vendor_name':      None,
        })
    return result


def parse_bank_lines(text, statement_date=None):
    result = []
    for line in text.split('\n'):
        m = DATE_RE_INLINE.search(line)
        if not m:
            continue
        date_str = normalize_date(m.group(1))
        if not date_str:
            continue
        stmt_year  = int(date_str[:4])
        stmt_month = f'{date_str[:7]}-01'
        amount     = trailing_amount(line)
        if amount is None:
            continue
        desc = re.sub(r'[\-\(]?[\d,]+\.?\d*\)?\s*$', '', line[m.end():]).strip() or None
        result.append({
            'statement_date':  statement_date or date_str,
            'statement_month': stmt_month,
            'bank_account':    'Bank Account',
            'bank_name':       None,
            'account_type':    None,
            'transaction_date': date_str,
            'description':     desc,
            'reference':       None,
            'amount':          amount,
            'transaction_type': 'Deposit' if amount >= 0 else 'Withdrawal',
            'running_balance': None,
            'statement_year':  stmt_year,
        })
    return result


def parse_tax_lines(text, fiscal_year, form_type):
    result = []
    for line in text.split('\n'):
        line = line.strip()
        # Match patterns like "1a  Gross receipts or sales  1,234,567"
        m = re.match(r'^(\d+[a-z]?)\s+(.+?)\s+([\-\(]?[\d,]+\.?\d*\)?)$', line, re.IGNORECASE)
        if not m:
            continue
        line_num, label, amt_str = m.groups()
        amount = parse_amount(amt_str)
        if amount is None:
            continue
        field_name = f'line_{line_num}'
        result.append({
            'field_name':   field_name,
            'field_label':  label.strip(),
            'field_value':  str(amount),
            'field_amount': amount,
            'line_number':  line_num,
            'schedule':     None,
            'section':      None,
            'tax_year':     fiscal_year,
            'form_type':    form_type,
        })
    return result


# ── Main extraction dispatcher ────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='OCR extraction for scanned PDFs')
    parser.add_argument('--type', required=True,
        choices=['profit_loss', 'balance_sheet', 'general_ledger', 'bank_statement', 'tax_return'])
    parser.add_argument('--filename', default='')
    args = parser.parse_args()

    raw = sys.stdin.buffer.read()
    if not raw:
        emit_error('No PDF data on stdin')

    dbg(f'type={args.type} filename="{args.filename}" size={len(raw)} bytes')

    try:
        images = render_pages(raw)
    except Exception as e:
        emit_error(f'Failed to render PDF: {e}')
        return

    try:
        full_text = ocr_pages(images)
    except Exception as e:
        emit_error(f'OCR failed: {e}')
        return

    dbg(f'Total OCR text: {len(full_text)} chars')
    if len(full_text.strip()) < 50:
        emit_error('OCR produced insufficient text — verify pytesseract is installed and working')

    fiscal_year    = year_from_text(full_text)
    as_of_date     = as_of_date_from_text(full_text)
    if as_of_date:
        fiscal_year = int(as_of_date[:4])

    # Tax form detection
    form_type = None
    form_m = re.search(r'(Form\s+(?:1120-?[A-Z]*|1065|1040-?[A-Z]*))', full_text[:2000], re.IGNORECASE)
    if form_m:
        form_type = re.sub(r'\s+', ' ', form_m.group(1)).strip()

    try:
        if args.type == 'profit_loss':
            rows = parse_statement_lines(full_text, 'profit_loss', fiscal_year)
            detected_years = [fiscal_year] if rows else []
        elif args.type == 'balance_sheet':
            rows = parse_statement_lines(full_text, 'balance_sheet', fiscal_year, as_of_date)
            detected_years = [fiscal_year] if rows else []
        elif args.type == 'general_ledger':
            rows = parse_gl_lines(full_text, fiscal_year)
            detected_years = sorted({r['fiscal_year'] for r in rows})
        elif args.type == 'bank_statement':
            rows = parse_bank_lines(full_text, as_of_date)
            detected_years = sorted({r['statement_year'] for r in rows})
        else:  # tax_return
            rows = parse_tax_lines(full_text, fiscal_year, form_type)
            detected_years = [fiscal_year] if rows else []
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        emit_error(str(e))
        return

    dbg(f'Extracted {len(rows)} rows, years={detected_years}')

    if not rows:
        emit_error(f'OCR produced text but could not parse any {args.type} rows')

    emit({'rows': rows, 'detected_years': detected_years})


if __name__ == '__main__':
    main()
