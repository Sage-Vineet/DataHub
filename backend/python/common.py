"""
Shared utilities for Key Reports Python extraction scripts.
Column aliases, amount/date parsers, header scoring, and output helpers.
All scripts import from here — keep this free of heavy dependencies.
"""
import re
import sys
import json
from datetime import datetime, date

# ── Column alias tables (mirrors JS extraction services) ──────────────────────

ACCOUNT_ALIASES = [
    'account', 'account name', 'name', 'description', 'account description',
    'label', 'item', 'category', 'line item',
]
AMOUNT_ALIASES = [
    'total', 'amount', 'balance', 'value', 'net', 'ytd', 'annual',
    'fiscal year total',
]
DATE_ALIASES = [
    'date', 'trans date', 'transaction date', 'txn date', 'posting date',
    'effective date', 'value date', 'trans. date',
]
REF_ALIASES = [
    'num', 'ref no', 'ref no.', 'reference', 'ref #', 'check #', 'check no',
    'trans #', 'trans no', 'doc no', 'document no', 'invoice #', 'invoice no',
]
NAME_ALIASES  = ['name', 'vendor', 'vendor name', 'customer', 'payee', 'entity']
ACCTNUM_ALIASES = [
    'account #', 'acct #', 'account number', 'acct number', 'acct no',
    'account no', 'acct. no', 'gl code', 'account code',
]
DEBIT_ALIASES   = ['debit', 'debits', 'dr', 'dr amount', 'amount dr', 'debit amount']
CREDIT_ALIASES  = ['credit', 'credits', 'cr', 'cr amount', 'amount cr', 'credit amount']
DESC_ALIASES    = ['memo', 'description', 'narration', 'notes', 'detail', 'particulars', 'remark']
CLASS_ALIASES   = ['class', 'job', 'department', 'dept', 'location', 'cost center', 'division']
TYPE_ALIASES    = ['type', 'transaction type', 'txn type', 'journal type', 'entry type']
BALANCE_ALIASES = ['balance', 'running balance', 'closing balance', 'ledger balance']

PERIOD_LABEL_RE = re.compile(
    r'\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec'
    r'|q[1-4]|total|ytd|annual|20\d{2}|19\d{2})\b',
    re.IGNORECASE,
)
YEAR_PATTERN = re.compile(r'\b(20\d{2}|19\d{2})\b')

# ── String helpers ────────────────────────────────────────────────────────────

def lc(v):
    """Lowercase-strip a cell value safely."""
    return str(v or '').lower().strip()


def cell_str(v):
    """Coerce cell value to stripped string, empty if None."""
    return str(v or '').strip()


# ── Amount parser ─────────────────────────────────────────────────────────────

def parse_amount(v):
    """
    Parse a cell value to float.
    Handles: $1,234.56  (1,234.56)  -1234  1234.56
    Returns None if not parseable (not zero — callers distinguish None from 0).
    """
    if v is None or v == '':
        return None
    s = str(v).replace('$', '').replace(',', '').replace(' ', '').strip()
    # Parentheses = negative: (1234.56) → -1234.56
    if re.match(r'^\([\d.]+\)$', s):
        inner = s[1:-1]
        try:
            return -float(inner)
        except ValueError:
            return None
    try:
        return float(s)
    except (ValueError, TypeError):
        return None


# ── Date parser ───────────────────────────────────────────────────────────────

def parse_date(v):
    """
    Parse various date formats to ISO string YYYY-MM-DD.
    Handles: datetime/date objects (from openpyxl), ISO strings, MM/DD/YYYY, etc.
    Returns None if unparseable.
    """
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.strftime('%Y-%m-%d')
    if isinstance(v, date):
        return v.isoformat()
    s = str(v).strip()
    if not s:
        return None
    for fmt in ('%Y-%m-%d', '%m/%d/%Y', '%m-%d-%Y', '%m/%d/%y',
                '%d/%m/%Y', '%Y/%m/%d', '%d-%m-%Y'):
        try:
            return datetime.strptime(s, fmt).strftime('%Y-%m-%d')
        except ValueError:
            pass
    return None


# ── Year extraction ───────────────────────────────────────────────────────────

def extract_year_from_text(text):
    """Return first 4-digit year (19xx or 20xx) found in text, or None."""
    m = YEAR_PATTERN.search(str(text or ''))
    return int(m.group(1)) if m else None


def extract_years_from_title_rows(rows, up_to_idx):
    """
    Scan rows[0..up_to_idx] INCLUSIVE for year mentions.
    Fixes the JS bug where headerIdx was used as exclusive upper bound,
    causing QBO files with a year in the header row itself to fall back to
    the current year.
    """
    years = set()
    limit = min(up_to_idx + 1, 15, len(rows))
    for i in range(limit):
        for cell in rows[i]:
            y = extract_year_from_text(str(cell or ''))
            if y and 1990 <= y <= 2035:
                years.add(y)
    return sorted(years)


def extract_year_cols_from_header(header_row):
    """
    Return list of {col_idx, year} for columns whose header is a year number.
    E.g. [..., '2022', '2023', '2024'] → [{col_idx:1, year:2022}, ...]
    """
    result = []
    for i, cell in enumerate(header_row):
        y = extract_year_from_text(str(cell or ''))
        if y and 1990 <= y <= 2035:
            result.append({'col_idx': i, 'year': y})
    return result


# ── Section inference ─────────────────────────────────────────────────────────

def infer_section(account_name):
    """Classify a BS account name into assets/liabilities/equity or None."""
    n = lc(account_name)
    if 'asset' in n:
        return 'assets'
    if 'liabilit' in n:
        return 'liabilities'
    if any(k in n for k in ('equity', 'capital', "owner's", 'retained')):
        return 'equity'
    return None


# ── Header row scoring ────────────────────────────────────────────────────────

def header_score_pl(row):
    """Score row as likely P&L header (period labels, account/amount aliases)."""
    score = 0
    for cell in row:
        s = str(cell or '')
        if PERIOD_LABEL_RE.search(s):
            score += 2
        h = lc(s)
        if any(a in h for a in ACCOUNT_ALIASES):
            score += 3
        if any(a == h or a in h for a in AMOUNT_ALIASES):
            score += 2
    return score


def header_score_gl(row):
    """Score row as likely GL header (date, debit, credit, account)."""
    score = 0
    for cell in row:
        h = lc(cell)
        if any(h == a for a in DATE_ALIASES):
            score += 4
        if any(h == a for a in DEBIT_ALIASES):
            score += 3
        if any(h == a for a in CREDIT_ALIASES):
            score += 3
        if any(h == a for a in ACCOUNT_ALIASES):
            score += 3
        if any(h == a for a in NAME_ALIASES):
            score += 2
        if any(h == a for a in DESC_ALIASES):
            score += 2
    return score


def header_score_bs(row):
    """
    Score row as likely Balance Sheet header.
    Uses score-based approach — fixes the JS 'last matching row' bug.
    """
    score = 0
    row_text = ' '.join(str(c or '') for c in row).lower()
    if any(w in row_text for w in ('as of', 'as-of', 'total assets', 'total liabilities')):
        score += 4
    if any(a in row_text for a in ACCOUNT_ALIASES):
        score += 3
    if extract_year_from_text(row_text):
        score += 3
    if 'balance' in row_text:
        score += 2
    return score


def header_score_bank(row):
    """Score row as bank statement header."""
    score = 0
    for cell in row:
        h = lc(cell)
        if any(h == a or a in h for a in DATE_ALIASES[:4]):
            score += 4
        if any(h == a or a in h for a in DESC_ALIASES[:3]):
            score += 3
        if h in ('amount', 'debit', 'credit', 'withdrawal', 'deposit'):
            score += 3
    return score


def find_best_header_row(rows, scorer, max_scan=25):
    """
    Return (index, score) of the highest-scoring row in rows[0..max_scan-1].
    This is the correct approach — single pass, best score wins, no drift.
    """
    best_idx, best_score = 0, 0
    for i in range(min(max_scan, len(rows))):
        s = scorer(rows[i])
        if s > best_score:
            best_score = s
            best_idx = i
    return best_idx, best_score


# ── Column finder ─────────────────────────────────────────────────────────────

def find_col(header_row, aliases):
    """Return index of first column matching any alias (exact or contains). -1 if none."""
    for i, cell in enumerate(header_row):
        h = lc(cell)
        if any(h == a or a in h for a in aliases):
            return i
    return -1


# ── is_total detection ────────────────────────────────────────────────────────

IS_TOTAL_RE = re.compile(
    r'(^total\b|\btotal$|\bnet income\b|\bnet loss\b|\bgross profit\b'
    r'|\btotal assets\b|\btotal liabilities\b)',
    re.IGNORECASE,
)

def is_total_row(account_name):
    return bool(IS_TOTAL_RE.search(account_name))


# ── Output helpers ────────────────────────────────────────────────────────────

def emit(data):
    """Write result JSON to stdout and flush."""
    print(json.dumps(data, default=str), flush=True)


def emit_error(msg):
    """Write error JSON to stdout and exit 1."""
    print(json.dumps({'error': msg, 'rows': [], 'detected_years': []}), flush=True)
    sys.exit(1)
