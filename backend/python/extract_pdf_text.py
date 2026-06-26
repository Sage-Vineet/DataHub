#!/usr/bin/env python3
"""
Extract financial data from text-layer PDFs using pdfplumber.
Called only when detect_pdf_type.py reports pdf_type="text" or "mixed".

Supports:
  --type profit_loss    → profit_loss_entries rows
  --type balance_sheet  → balance_sheet_entries rows
  --type general_ledger → general_ledger_entries rows
  --type bank_statement → bank_statement_entries rows
  --type tax_return     → tax_return_entries rows

Protocol:
  stdin  : raw PDF bytes
  stdout : JSON { rows: [...], detected_years: [...] }
  stderr : debug logs
  exit 0 : success
  exit 1 : error
"""

import sys
import io
import re
import argparse
from datetime import datetime

try:
    import pdfplumber
except ImportError:
    print('{"error":"pdfplumber not installed — run: pip install pdfplumber","rows":[],"detected_years":[]}')
    sys.exit(1)

from common import (
    lc, cell_str, parse_amount, parse_date,
    extract_year_from_text, infer_section, is_total_row,
    find_best_header_row, header_score_bank, find_col,
    AMOUNT_ALIASES, DATE_ALIASES, DESC_ALIASES, REF_ALIASES,
    DEBIT_ALIASES, CREDIT_ALIASES, BALANCE_ALIASES,
    YEAR_PATTERN, emit, emit_error,
)

AS_OF_RE = re.compile(
    r'as\s+of\s+(\w+\s+\d{1,2},?\s*\d{4}|\d{1,2}/\d{1,2}/\d{4}|\d{4}-\d{2}-\d{2})',
    re.IGNORECASE,
)
DATE_RE = re.compile(r'\b(\d{1,2}/\d{1,2}/\d{4}|\d{4}-\d{2}-\d{2})\b')


def dbg(msg):
    print(f'[extract_pdf_text] {msg}', file=sys.stderr, flush=True)


# ── PDF helpers ───────────────────────────────────────────────────────────────

def open_pdf(raw):
    try:
        return pdfplumber.open(io.BytesIO(raw))
    except Exception as e:
        emit_error(f'Cannot open PDF: {e}')


def all_text(pdf):
    parts = []
    for page in pdf.pages:
        t = page.extract_text()
        if t:
            parts.append(t)
    return '\n'.join(parts)


def all_tables(pdf):
    tables = []
    for page in pdf.pages:
        page_tables = page.extract_tables() or []
        tables.extend(page_tables)
    return tables


def year_from_text(text, limit=3000):
    years = [int(y) for y in YEAR_PATTERN.findall(text[:limit]) if 1990 <= int(y) <= 2035]
    return max(years) if years else datetime.now().year


def as_of_date_from_text(text):
    m = AS_OF_RE.search(text[:3000])
    if not m:
        return None
    s = m.group(1).strip().rstrip(',')
    for fmt in ('%B %d %Y', '%b %d %Y', '%B %d, %Y', '%b %d, %Y',
                '%m/%d/%Y', '%Y-%m-%d'):
        try:
            return datetime.strptime(s, fmt).strftime('%Y-%m-%d')
        except ValueError:
            pass
    return None


def normalize_date(s):
    """Turn 'MM/DD/YYYY' or 'YYYY-MM-DD' → 'YYYY-MM-DD'."""
    s = str(s or '').strip()
    m = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{4})$', s)
    if m:
        return f'{m.group(3)}-{m.group(1).zfill(2)}-{m.group(2).zfill(2)}'
    if re.match(r'^\d{4}-\d{2}-\d{2}$', s):
        return s
    return None


# ── Table-to-rows parser (P&L / BS) ──────────────────────────────────────────

def parse_statement_table(table, doc_type, fiscal_year, as_of_date=None):
    """
    Parse a pdfplumber table (list of lists) into financial row dicts.
    Works for both P&L and Balance Sheet by checking doc_type.
    For Balance Sheet, tracks the current section (Assets/Liabilities/Equity)
    so that leaf entries inherit the correct section even when their own name
    contains no section keyword.
    """
    result = []
    current_section = None  # tracks Assets / Liabilities / Equity across rows
    for row in table:
        if not row:
            continue

        # Account name: first non-empty cell
        account_name = str(row[0] or '').strip()
        if not account_name:
            for c in row[1:]:
                if str(c or '').strip():
                    account_name = str(c).strip()
                    break
        if not account_name:
            continue

        # Amount: last parseable numeric cell
        amount = None
        for c in reversed(row):
            v = parse_amount(c)
            if v is not None:
                amount = v
                break

        # Balance-sheet section header detection: a row whose account name
        # contains a section keyword AND has no numeric amount is a pure
        # section divider (e.g. "ASSETS", "LIABILITIES AND EQUITY").
        if doc_type == 'balance_sheet':
            section_from_name = infer_section(account_name)
            if section_from_name and amount is None:
                current_section = section_from_name
                continue  # section header — don't emit as a data row
            # Even if the row has an amount, update current_section so that
            # "Total Assets $1,147,368.19" anchors the section for later rows.
            if section_from_name:
                current_section = section_from_name

        non_empty = [str(c or '').strip() for c in row if str(c or '').strip()]
        if len(non_empty) < 2:
            continue
        if amount is None:
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
                'section':          current_section or infer_section(account_name),
                'amount':           amount,
                'as_of_date':       as_of_date or f'{fiscal_year}-12-31',
                'fiscal_year':      fiscal_year,
                'is_total':         is_total_row(account_name),
                'is_section_header': False,
            })
    return result


# ── PROFIT & LOSS ─────────────────────────────────────────────────────────────

def extract_profit_loss(pdf):
    text        = all_text(pdf)
    fiscal_year = year_from_text(text)
    tables      = all_tables(pdf)

    dbg(f'P&L: {len(tables)} tables found, fiscal_year={fiscal_year}')

    rows = []
    for table in tables:
        rows.extend(parse_statement_table(table, 'profit_loss', fiscal_year))

    # Fallback: parse line-by-line if no tables
    if not rows:
        dbg('No tables — falling back to line-by-line parsing')
        rows = parse_lines_profit_loss(text, fiscal_year)

    return {'rows': rows, 'detected_years': [fiscal_year] if rows else []}


def parse_lines_profit_loss(text, fiscal_year):
    result = []
    for line in text.split('\n'):
        line = line.strip()
        if not line or len(line) < 4:
            continue
        if re.match(r'^[\d\s.,\-()\$]+$', line):
            continue   # pure number line — skip
        amount = None
        # Look for trailing dollar amount
        m = re.search(r'([\-\(]?[\d,]+\.?\d*\)?)$', line)
        if m:
            amount = parse_amount(m.group(1))
        if amount is None:
            continue
        account_name = re.sub(r'[\-\(]?[\d,]+\.?\d*\)?\s*$', '', line).strip()
        if not account_name or len(account_name) < 2:
            continue
        result.append({
            'account_name': account_name,
            'account_type': None,
            'amount':       amount,
            'fiscal_year':  fiscal_year,
            'is_total':     is_total_row(account_name),
            'is_header':    False,
        })
    return result


# ── BALANCE SHEET ─────────────────────────────────────────────────────────────

def extract_balance_sheet(pdf):
    text       = all_text(pdf)
    as_of_date = as_of_date_from_text(text)
    fiscal_year = int(as_of_date[:4]) if as_of_date else year_from_text(text)
    tables      = all_tables(pdf)

    dbg(f'BS: {len(tables)} tables, as_of={as_of_date}, fiscal_year={fiscal_year}')

    rows = []
    for table in tables:
        rows.extend(parse_statement_table(table, 'balance_sheet', fiscal_year, as_of_date))

    if not rows:
        rows = parse_lines_balance_sheet(text, fiscal_year, as_of_date)

    return {'rows': rows, 'detected_years': [fiscal_year] if rows else []}


def parse_lines_balance_sheet(text, fiscal_year, as_of_date):
    """
    Line-by-line fallback parser for Balance Sheet PDFs.
    Tracks the current section (assets/liabilities/equity) across lines so that
    leaf entries like "Business Checking (7454)" inherit the correct section even
    though their own name contains no section keyword.
    """
    result = []
    current_section = None
    for line in text.split('\n'):
        line = line.strip()
        if not line or len(line) < 4:
            continue
        if re.match(r'^[\d\s.,\-()\$]+$', line):
            continue

        section_from_name = infer_section(line)
        m = re.search(r'([\-\(]?[\d,]+\.?\d*\)?)$', line)
        has_amount = m is not None and parse_amount(m.group(1)) is not None

        # Pure section-header lines (contain a section keyword, no amount):
        # "ASSETS", "LIABILITIES AND EQUITY", "Equity" — update context, skip row.
        if section_from_name and not has_amount:
            current_section = section_from_name
            continue

        if not m:
            continue
        amount = parse_amount(m.group(1))
        if amount is None:
            continue
        account_name = re.sub(r'[\-\(]?[\d,]+\.?\d*\)?\s*$', '', line).strip()
        if not account_name or len(account_name) < 2:
            continue

        # Rows that carry a section keyword AND an amount (e.g. "Total Assets $X")
        # also advance the current section so subsequent rows stay in scope.
        if section_from_name:
            current_section = section_from_name

        result.append({
            'account_name':     account_name,
            'account_number':   None,
            'section':          current_section or section_from_name,
            'amount':           amount,
            'as_of_date':       as_of_date or f'{fiscal_year}-12-31',
            'fiscal_year':      fiscal_year,
            'is_total':         is_total_row(account_name),
            'is_section_header': False,
        })
    return result


# ── GENERAL LEDGER ────────────────────────────────────────────────────────────

def extract_general_ledger(pdf):
    tables = all_tables(pdf)
    dbg(f'GL: {len(tables)} tables')

    result = []
    for table in tables:
        if len(table) < 2:
            continue
        header = [lc(c or '') for c in table[0]]
        date_col = next((i for i, h in enumerate(header) if 'date' in h), -1)
        if date_col < 0:
            continue
        acct_col = next((i for i, h in enumerate(header)
                         if 'account' in h or 'acct' in h), -1)
        desc_col = next((i for i, h in enumerate(header)
                         if any(k in h for k in ('memo', 'desc', 'narration'))), -1)

        for row in table[1:]:
            if not row or len(row) <= date_col:
                continue
            raw_date = str(row[date_col] or '').strip()
            date_str = normalize_date(raw_date)
            if not date_str:
                continue

            fiscal_year  = int(date_str[:4])
            account_name = str(row[acct_col] if acct_col >= 0 and acct_col < len(row) else '').strip()
            if not account_name:
                continue

            # Last numeric cell = amount
            debit = credit = 0
            for c in reversed(row):
                v = parse_amount(c)
                if v is not None:
                    if v >= 0:
                        debit = v
                    else:
                        credit = abs(v)
                    break

            desc = str(row[desc_col] if desc_col >= 0 and desc_col < len(row) else '').strip() or None

            result.append({
                'transaction_date': date_str,
                'fiscal_year':      fiscal_year,
                'account_number':   None,
                'account_name':     account_name,
                'description':      desc,
                'reference':        None,
                'debit':            debit,
                'credit':           credit,
                'journal_type':     None,
                'class':            None,
                'vendor_name':      None,
            })

    detected_years = sorted({r['fiscal_year'] for r in result})
    dbg(f'GL: {len(result)} rows, years={detected_years}')
    return {'rows': result, 'detected_years': detected_years}


# ── BANK STATEMENT ────────────────────────────────────────────────────────────


# ?? BANK STATEMENT ???????????????????????????????????????????????????????????

BANK_DATE_ALIASES = DATE_ALIASES + ['transaction date', 'posting date', 'value date']
BANK_DESC_ALIASES = DESC_ALIASES + ['description', 'transaction', 'payee', 'particulars', 'details']
BANK_REF_ALIASES = REF_ALIASES + ['reference']
BANK_DEBIT_ALIASES = DEBIT_ALIASES + ['withdrawal', 'withdrawn', 'debit', 'payment', 'fee', 'charge']
BANK_CREDIT_ALIASES = CREDIT_ALIASES + ['deposit', 'credit', 'refund', 'interest']
BANK_AMOUNT_ALIASES = AMOUNT_ALIASES + ['amount', 'transaction amount']
BANK_BALANCE_ALIASES = BALANCE_ALIASES + ['available balance', 'ledger balance']

DATE_TOKEN_RE = re.compile(r'\b(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}-\d{2}-\d{2})\b')
TRAILING_MONEY_RE = re.compile(r'(?P<amount>[\(\-]?\$?[\d,]+(?:\.\d{2})?\)?)(?:\s+(?P<balance>[\(\-]?\$?[\d,]+(?:\.\d{2})?\)?))?\s*$')
REF_LABEL_RE = re.compile(r'(?:ref(?:erence)?|check|chk|trace|txn|trans|id)\s*[:#]?\s*([A-Za-z0-9\-]+)', re.IGNORECASE)
WITHDRAWAL_HINT_RE = re.compile(r'\b(withdrawal|withdrawn|debit|payment|fee|charge|pos)\b', re.IGNORECASE)
DEPOSIT_HINT_RE = re.compile(r'\b(deposit|credit|refund|interest)\b', re.IGNORECASE)


def statement_month_from_date(date_str):
    if not date_str:
        return None
    return f'{date_str[:7]}-01'


def dedupe_bank_rows(rows):
    seen = set()
    deduped = []
    for row in rows:
        amount = row.get('amount')
        balance = row.get('running_balance')
        key = (
            row.get('transaction_date') or '',
            (row.get('description') or '').strip().lower(),
            (row.get('reference') or '').strip().lower(),
            round(float(amount), 2) if amount is not None else None,
            round(float(balance), 2) if balance is not None else None,
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(row)
    return deduped


def build_bank_row(date_str, statement_date, description, reference, amount, balance):
    if amount is None:
        return None

    raw_text = ' '.join(part for part in [date_str, description or '', reference or '', str(amount), str(balance or '')] if part)
    text_lower = raw_text.lower()

    if amount >= 0 and WITHDRAWAL_HINT_RE.search(text_lower) and not DEPOSIT_HINT_RE.search(text_lower):
        amount = -abs(amount)
    elif amount < 0 and DEPOSIT_HINT_RE.search(text_lower) and not WITHDRAWAL_HINT_RE.search(text_lower):
        amount = abs(amount)

    statement_anchor = statement_date or date_str
    statement_month = statement_month_from_date(statement_anchor)
    stmt_year = int(date_str[:4])
    txn_type = 'Deposit' if amount >= 0 else 'Withdrawal'

    return {
        'statement_date': statement_anchor,
        'statement_month': statement_month,
        'bank_account': 'Bank Account',
        'bank_name': None,
        'account_type': None,
        'transaction_date': date_str,
        'description': description or None,
        'reference': reference or None,
        'amount': amount,
        'transaction_type': txn_type,
        'running_balance': balance,
        'statement_year': stmt_year,
        'debit': abs(amount) if amount < 0 else 0,
        'credit': amount if amount > 0 else 0,
        'balance': balance,
    }


def parse_bank_table_rows(table, statement_date):
    if not table:
        return []

    header_idx, best_score = find_best_header_row(table, header_score_bank, max_scan=min(20, len(table)))
    header_row = table[header_idx] if header_idx < len(table) else []

    col = {
        'date': find_col(header_row, BANK_DATE_ALIASES),
        'desc': find_col(header_row, BANK_DESC_ALIASES),
        'ref': find_col(header_row, BANK_REF_ALIASES),
        'debit': find_col(header_row, BANK_DEBIT_ALIASES),
        'credit': find_col(header_row, BANK_CREDIT_ALIASES),
        'amount': find_col(header_row, BANK_AMOUNT_ALIASES),
        'balance': find_col(header_row, BANK_BALANCE_ALIASES),
    }

    if col['date'] < 0:
        for probe_col in range(min(6, len(header_row))):
            for probe_row in range(header_idx + 1, min(header_idx + 6, len(table))):
                candidate = table[probe_row][probe_col] if probe_col < len(table[probe_row]) else None
                if parse_date(candidate) or normalize_date(candidate):
                    col['date'] = probe_col
                    break
            if col['date'] >= 0:
                break

    rows = []
    for row in table[header_idx + 1:]:
        if not row or all(v is None or str(v).strip() == '' for v in row):
            continue

        date_cell = row[col['date']] if col['date'] >= 0 and col['date'] < len(row) else None
        date_str = parse_date(date_cell) or normalize_date(date_cell)
        if not date_str:
            continue

        description = None
        if col['desc'] >= 0 and col['desc'] < len(row):
            description = cell_str(row[col['desc']]) or None

        reference = None
        if col['ref'] >= 0 and col['ref'] < len(row):
            reference = cell_str(row[col['ref']]) or None

        balance = None
        if col['balance'] >= 0 and col['balance'] < len(row):
            balance = parse_amount(row[col['balance']])

        debit = parse_amount(row[col['debit']]) if col['debit'] >= 0 and col['debit'] < len(row) else None
        credit = parse_amount(row[col['credit']]) if col['credit'] >= 0 and col['credit'] < len(row) else None
        amount = None

        if debit is not None and credit is not None:
            if debit and not credit:
                amount = -abs(debit)
            elif credit and not debit:
                amount = abs(credit)
        elif col['amount'] >= 0 and col['amount'] < len(row):
            amount = parse_amount(row[col['amount']])

        if amount is None:
            numeric_values = []
            for idx, cell in enumerate(row):
                if idx <= col['date']:
                    continue
                v = parse_amount(cell)
                if v is not None:
                    numeric_values.append(v)
            if numeric_values:
                amount = numeric_values[-1] if len(numeric_values) == 1 or balance is None else numeric_values[-2]
                if balance is None and len(numeric_values) > 1:
                    balance = numeric_values[-1]

        if amount is None:
            continue

        built = build_bank_row(date_str, statement_date, description, reference, amount, balance)
        if built:
            rows.append(built)

    return rows


def parse_bank_line(line, statement_date, permissive=False):
    normalized = ' '.join(str(line or '').split())
    if not normalized:
        return None

    date_match = DATE_TOKEN_RE.search(normalized)
    if not date_match:
        return None

    date_str = parse_date(date_match.group(1)) or normalize_date(date_match.group(1))
    if not date_str:
        return None

    tail = normalized[date_match.end():].strip()
    if not tail:
        return None

    amount = None
    balance = None
    description = tail
    reference = None

    if permissive:
        tokens = re.findall(r'[\(\-]?\$?[\d,]+(?:\.\d{2})?\)?', tail)
        if not tokens:
            return None
        amount_token = tokens[-2] if len(tokens) >= 2 else tokens[-1]
        balance_token = tokens[-1] if len(tokens) >= 2 else None
        amount = parse_amount(amount_token)
        balance = parse_amount(balance_token) if balance_token else None
        if amount is None:
            return None
        body = tail
        for token in tokens[::-1]:
            body = body.replace(token, '', 1).strip()
        description = body
    else:
        money_match = TRAILING_MONEY_RE.search(tail)
        if not money_match:
            return None
        amount = parse_amount(money_match.group('amount'))
        balance = parse_amount(money_match.group('balance')) if money_match.group('balance') else None
        if amount is None:
            return None
        description = tail[:money_match.start()].strip()

    ref_match = REF_LABEL_RE.search(description)
    if ref_match:
        reference = ref_match.group(1)
        description = REF_LABEL_RE.sub('', description).strip()

    if not reference and permissive:
        tokens = description.split()
        if len(tokens) >= 2:
            candidate = tokens[-1].strip(',:;#')
            if re.fullmatch(r'[A-Za-z0-9\-]{2,12}', candidate) and not re.search(r'[A-Za-z]', candidate):
                reference = candidate
                description = ' '.join(tokens[:-1]).strip()

    return build_bank_row(date_str, statement_date, description or None, reference, amount, balance)


def parse_bank_lines(text, statement_date, permissive=False):
    rows = []
    for line in text.split('\n'):
        row = parse_bank_line(line, statement_date, permissive=permissive)
        if row:
            rows.append(row)
    return rows


def extract_bank_statement(pdf):
    text = all_text(pdf)
    tables = all_tables(pdf)

    statement_date = as_of_date_from_text(text)
    fiscal_year = int(statement_date[:4]) if statement_date else year_from_text(text)
    dbg(f'Bank: {len(tables)} tables, statement_date={statement_date}, fiscal_year={fiscal_year}')

    table_rows = []
    for table in tables:
        table_rows.extend(parse_bank_table_rows(table, statement_date))
    dbg(f'Bank tables: {len(table_rows)} row(s)')

    strict_line_rows = parse_bank_lines(text, statement_date, permissive=False)
    dbg(f'Bank line parsing: {len(strict_line_rows)} row(s)')

    regex_rows = parse_bank_lines(text, statement_date, permissive=True)
    dbg(f'Bank regex parsing: {len(regex_rows)} row(s)')

    result = dedupe_bank_rows(table_rows + strict_line_rows + regex_rows)

    if not result:
        dbg('Bank: no transaction rows found after table, line, and regex parsing')
        return {'rows': [], 'detected_years': []}

    if not statement_date:
        statement_date = max((r['transaction_date'] for r in result if r.get('transaction_date')), default=None)
        if statement_date:
            statement_month = statement_month_from_date(statement_date)
            for row in result:
                row['statement_date'] = statement_date
                row['statement_month'] = statement_month

    detected_years = sorted({r['statement_year'] for r in result if r.get('statement_year')})
    dbg(f'Bank: {len(result)} rows, years={detected_years}')
    return {'rows': result, 'detected_years': detected_years}


# ── TAX RETURN ────────────────────────────────────────────────────────────────

def extract_tax_return(pdf):
    text   = all_text(pdf)
    tables = all_tables(pdf)

    # Detect tax year
    fiscal_year = year_from_text(text)
    year_m = re.search(
        r'(?:tax year|for (?:calendar|fiscal) year|year ending|taxable year)\s+(\d{4})',
        text[:3000], re.IGNORECASE,
    )
    if year_m:
        fiscal_year = int(year_m.group(1))

    # Detect form type
    form_type = None
    form_m = re.search(r'(Form\s+(?:1120-?[A-Z]*|1065|1040-?[A-Z]*))', text[:2000], re.IGNORECASE)
    if form_m:
        form_type = re.sub(r'\s+', ' ', form_m.group(1)).strip()

    dbg(f'Tax: fiscal_year={fiscal_year}, form_type={form_type}, tables={len(tables)}')

    result = []
    for table in tables:
        for row in table:
            if not row:
                continue
            line_num = None
            label    = None
            amount   = None

            for cell in row:
                s = str(cell or '').strip()
                if re.match(r'^\d+[a-z]?$', s, re.IGNORECASE) and line_num is None:
                    line_num = s
                elif s and label is None and not re.match(r'^[\d,.\-\(\)\$\s]+$', s):
                    label = s
                else:
                    v = parse_amount(s)
                    if v is not None:
                        amount = v

            if label and (amount is not None or line_num):
                field_name = f'line_{line_num}' if line_num else re.sub(r'\W+', '_', label.lower())[:50]
                result.append({
                    'field_name':   field_name,
                    'field_label':  label,
                    'field_value':  str(amount) if amount is not None else None,
                    'field_amount': amount,
                    'line_number':  line_num,
                    'schedule':     None,
                    'section':      None,
                    'tax_year':     fiscal_year,
                    'form_type':    form_type,
                })

    # Line-by-line fallback for simple form layouts
    if not result:
        dbg('No table rows — falling back to line parsing')
        for line in text.split('\n'):
            line = line.strip()
            if not line or len(line) < 5:
                continue
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

    dbg(f'Tax: {len(result)} fields extracted')
    return {'rows': result, 'detected_years': [fiscal_year] if result else []}


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Extract financial data from text-layer PDFs')
    parser.add_argument('--type', required=True,
        choices=['profit_loss', 'balance_sheet', 'general_ledger', 'bank_statement', 'tax_return'])
    parser.add_argument('--filename', default='')
    args = parser.parse_args()

    raw = sys.stdin.buffer.read()
    if not raw:
        emit_error('No PDF data on stdin')

    dbg(f'type={args.type} filename="{args.filename}" size={len(raw)} bytes')
    pdf = open_pdf(raw)

    try:
        if args.type == 'profit_loss':
            result = extract_profit_loss(pdf)
        elif args.type == 'balance_sheet':
            result = extract_balance_sheet(pdf)
        elif args.type == 'general_ledger':
            result = extract_general_ledger(pdf)
        elif args.type == 'bank_statement':
            result = extract_bank_statement(pdf)
        else:
            result = extract_tax_return(pdf)
    except SystemExit:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        emit_error(str(e))
        return
    finally:
        try:
            pdf.close()
        except Exception:
            pass

    if not result['rows']:
        emit_error(f'No {args.type} rows extracted from PDF text layer')

    emit(result)


if __name__ == '__main__':
    main()
