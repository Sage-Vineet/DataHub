#!/usr/bin/env python3
"""
Excel extraction for Key Reports financial documents.
Replaces the Node.js xlsx-based extraction with openpyxl.

Supports:
  --type profit_loss    → profit_loss_entries rows
  --type balance_sheet  → balance_sheet_entries rows
  --type general_ledger → general_ledger_entries rows
  --type bank_statement → bank_statement_entries rows

Protocol:
  stdin  : raw Excel/CSV file bytes
  stdout : JSON { rows: [...], detected_years: [...] }
  stderr : debug logs (safe to ignore)
  exit 0 : success
  exit 1 : error (stdout contains { error: "..." })
"""

import sys
import io
import re
import argparse
from datetime import datetime

try:
    from openpyxl import load_workbook
except ImportError:
    print('{"error":"openpyxl not installed — run: pip install openpyxl","rows":[],"detected_years":[]}')
    sys.exit(1)

from common import (
    lc, cell_str, parse_amount, parse_date,
    extract_year_from_text, extract_years_from_title_rows, extract_year_cols_from_header,
    infer_section, is_total_row,
    header_score_pl, header_score_gl, header_score_bs,
    find_best_header_row, find_col,
    ACCOUNT_ALIASES, AMOUNT_ALIASES, DATE_ALIASES, REF_ALIASES,
    NAME_ALIASES, ACCTNUM_ALIASES, DEBIT_ALIASES, CREDIT_ALIASES,
    DESC_ALIASES, CLASS_ALIASES, TYPE_ALIASES, BALANCE_ALIASES,
    emit, emit_error,
)

AS_OF_PATTERN = re.compile(
    r'(?:as\s+of\s+)?'
    r'(\w+\s+\d{1,2},?\s*\d{4}'       # "December 31, 2024"
    r'|\d{1,2}[/\-]\d{1,2}[/\-]\d{4}' # "12/31/2024"
    r'|\d{4}-\d{2}-\d{2})',             # "2024-12-31"
    re.IGNORECASE,
)


# ── Workbook helpers ──────────────────────────────────────────────────────────

def load_wb():
    raw = sys.stdin.buffer.read()
    if not raw:
        emit_error('No file data received on stdin')
    try:
        return load_workbook(io.BytesIO(raw), data_only=True, read_only=True)
    except Exception as e:
        emit_error(f'Cannot open Excel file: {e}')


def get_rows(wb, pattern=None):
    """
    Return array-of-arrays from the best-matching sheet (or first sheet).
    Each row is a list of raw cell values (None for empty cells).
    """
    target = None
    if pattern:
        for name in wb.sheetnames:
            if re.search(pattern, name, re.IGNORECASE):
                target = name
                break
    ws = wb[target] if target else wb.worksheets[0]
    return [[cell.value for cell in row] for row in ws.iter_rows()]


def dbg(msg):
    print(f'[extract_excel] {msg}', file=sys.stderr, flush=True)


# ── PROFIT & LOSS ─────────────────────────────────────────────────────────────

def extract_profit_loss(wb):
    rows = get_rows(wb, r'income|profit|p&l|pl|earnings|revenue')
    if len(rows) < 2:
        emit_error('No data rows found in P&L sheet')

    header_idx, score = find_best_header_row(rows, header_score_pl)
    dbg(f'Header row: {header_idx} (score={score}): {[cell_str(c) for c in rows[header_idx]][:8]}')

    header_row = rows[header_idx]

    # Extract years from title area — INCLUSIVE of header_idx (fixes JS year-scan bug)
    title_years = extract_years_from_title_rows(rows, header_idx)
    year_cols   = extract_year_cols_from_header(header_row)

    # Determine which year columns to emit
    if year_cols:
        fiscal_years = year_cols                            # multi-year columns
    else:
        guess = title_years[-1] if title_years else datetime.now().year
        fiscal_years = [{'col_idx': -1, 'year': guess}]   # single-year

    acct_idx = max(0, find_col(header_row, ACCOUNT_ALIASES))
    dbg(f'Account col={acct_idx}, year cols={fiscal_years}')

    result = []
    for row in rows[header_idx + 1:]:
        if not row or all(v is None or str(v).strip() == '' for v in row):
            continue

        raw_name = cell_str(row[acct_idx] if acct_idx < len(row) else None)
        if not raw_name:
            continue

        account_name = raw_name.lstrip()   # strip leading indent spaces
        is_total     = is_total_row(account_name)

        if year_cols:
            for yc in year_cols:
                c = yc['col_idx']
                amt = parse_amount(row[c] if c < len(row) else None)
                if amt is None and not is_total:
                    continue
                result.append({
                    'account_name': account_name,
                    'account_type': None,
                    'amount':       amt if amt is not None else 0,
                    'fiscal_year':  yc['year'],
                    'is_total':     is_total,
                    'is_header':    False,
                })
        else:
            year = fiscal_years[0]['year']
            # Walk right-to-left to find the last numeric value
            amount = None
            for c in range(len(row) - 1, acct_idx, -1):
                v = parse_amount(row[c])
                if v is not None:
                    amount = v
                    break
            if amount is None:
                continue
            result.append({
                'account_name': account_name,
                'account_type': None,
                'amount':       amount,
                'fiscal_year':  year,
                'is_total':     is_total,
                'is_header':    False,
            })

    detected_years = sorted({r['fiscal_year'] for r in result})
    dbg(f'Extracted {len(result)} rows, years={detected_years}')
    return {'rows': result, 'detected_years': detected_years}


# ── BALANCE SHEET ─────────────────────────────────────────────────────────────

def parse_as_of_date(text):
    m = AS_OF_PATTERN.search(str(text or ''))
    if not m:
        return None
    s = m.group(1).strip().rstrip(',')
    for fmt in ('%B %d %Y', '%b %d %Y', '%B %d, %Y', '%b %d, %Y',
                '%m/%d/%Y', '%Y-%m-%d', '%d/%m/%Y', '%m-%d-%Y'):
        try:
            return datetime.strptime(s, fmt).strftime('%Y-%m-%d')
        except ValueError:
            pass
    return None


def extract_balance_sheet(wb):
    rows = get_rows(wb, r'balance\s*sheet|bs\b')
    if len(rows) < 2:
        emit_error('No data rows found in Balance Sheet')

    # Scan first 20 rows for as_of_date and fiscal year
    as_of_date       = None
    title_fiscal_year = None
    for i in range(min(20, len(rows))):
        row_text = ' '.join(cell_str(c) for c in rows[i])
        if not as_of_date:
            d = parse_as_of_date(row_text)
            if d:
                as_of_date        = d
                title_fiscal_year = int(d[:4])
        if not title_fiscal_year:
            y = extract_year_from_text(row_text)
            if y:
                title_fiscal_year = y

    # Score-based header detection — FIXED vs JS 'last matching row' bug
    header_idx, score = find_best_header_row(rows, header_score_bs, max_scan=20)
    dbg(f'BS header row: {header_idx} (score={score}), as_of={as_of_date}')

    if not as_of_date:
        year       = title_fiscal_year or datetime.now().year
        as_of_date = f'{year}-12-31'
    fiscal_year = title_fiscal_year or int(as_of_date[:4])

    header_row = rows[header_idx]
    acct_idx   = max(0, find_col(header_row, ACCOUNT_ALIASES))

    current_section = None
    result = []

    for row in rows[header_idx + 1:]:
        if not row or all(v is None or str(v).strip() == '' for v in row):
            continue

        raw_name = cell_str(row[acct_idx] if acct_idx < len(row) else None)
        if not raw_name:
            continue

        section_match = infer_section(raw_name)

        # Walk right-to-left for amount
        amount = None
        for c in range(len(row) - 1, acct_idx, -1):
            v = parse_amount(row[c])
            if v is not None:
                amount = v
                break

        # Pure section header row (no amount)
        if section_match and amount is None:
            current_section = raw_name
            result.append({
                'account_name':    raw_name,
                'account_number':  None,
                'section':         section_match,
                'amount':          0,
                'as_of_date':      as_of_date,
                'fiscal_year':     fiscal_year,
                'is_total':        False,
                'is_section_header': True,
            })
            continue

        if amount is None:
            continue

        account_name = raw_name.lstrip()
        result.append({
            'account_name':     account_name,
            'account_number':   None,
            'section':          infer_section(current_section) if current_section else infer_section(account_name),
            'amount':           amount,
            'as_of_date':       as_of_date,
            'fiscal_year':      fiscal_year,
            'is_total':         is_total_row(account_name),
            'is_section_header': False,
        })

    detected_years = [fiscal_year] if result else []
    dbg(f'Extracted {len(result)} BS rows')
    return {'rows': result, 'detected_years': detected_years}


# ── GENERAL LEDGER ────────────────────────────────────────────────────────────

def extract_general_ledger(wb):
    rows = get_rows(wb, r'general\s*ledger|gl\b|transaction')
    if len(rows) < 2:
        emit_error('No data rows found in GL file')

    header_idx, score = find_best_header_row(rows, header_score_gl, max_scan=25)
    if score < 2:
        dbg('No strong GL header found — using row 0')
        header_idx = 0

    header_row = rows[header_idx]
    dbg(f'GL header row: {header_idx} (score={score}): {[cell_str(c) for c in header_row][:10]}')

    col = {
        'date':        find_col(header_row, DATE_ALIASES),
        'ref':         find_col(header_row, REF_ALIASES),
        'name':        find_col(header_row, NAME_ALIASES),
        'account':     find_col(header_row, ACCOUNT_ALIASES),
        'account_num': find_col(header_row, ACCTNUM_ALIASES),
        'debit':       find_col(header_row, DEBIT_ALIASES),
        'credit':      find_col(header_row, CREDIT_ALIASES),
        'amount':      find_col(header_row, AMOUNT_ALIASES),
        'desc':        find_col(header_row, DESC_ALIASES),
        'class_':      find_col(header_row, CLASS_ALIASES),
        'type':        find_col(header_row, TYPE_ALIASES),
    }
    dbg(f'GL col map: {col}')

    # Detect QBO "by Account" format: no Account column in header; account name
    # appears as a section header row above its transactions.
    is_by_account = col['account'] < 0 and col['account_num'] < 0
    current_account_section = None

    # If date column not found, probe first data rows
    if col['date'] < 0:
        for c in range(min(5, len(header_row))):
            for r_idx in range(header_idx + 1, min(header_idx + 6, len(rows))):
                if r_idx < len(rows) and c < len(rows[r_idx]):
                    if parse_date(rows[r_idx][c]):
                        col['date'] = c
                        break
            if col['date'] >= 0:
                break
    if col['date'] < 0:
        emit_error('Could not detect date column in GL file')

    def get(row, key):
        c = col[key]
        return row[c] if c >= 0 and c < len(row) else None

    result = []
    for row in rows[header_idx + 1:]:
        if not row or all(v is None or str(v).strip() == '' for v in row):
            continue

        date_str = parse_date(get(row, 'date'))

        # by-Account: rows without a date are section headers carrying the account name
        if is_by_account and not date_str:
            potential = cell_str(row[0])
            if potential:
                current_account_section = potential
            continue

        if not date_str:
            continue

        fiscal_year = int(date_str[:4])

        if is_by_account:
            account_name = current_account_section or ''
            account_num  = ''
        else:
            account_name = cell_str(get(row, 'account'))
            account_num  = cell_str(get(row, 'account_num'))

        if not account_name and not account_num:
            continue

        debit  = parse_amount(get(row, 'debit'))  or 0
        credit = parse_amount(get(row, 'credit')) or 0

        # Single-amount column: positive = debit, negative = credit
        if col['debit'] < 0 and col['credit'] < 0 and col['amount'] >= 0:
            amt = parse_amount(get(row, 'amount')) or 0
            debit, credit = (amt, 0) if amt >= 0 else (0, abs(amt))

        result.append({
            'transaction_date': date_str,
            'fiscal_year':      fiscal_year,
            'account_number':   account_num or None,
            'account_name':     account_name,
            'description':      cell_str(get(row, 'desc'))  or None,
            'reference':        cell_str(get(row, 'ref'))   or None,
            'debit':            debit,
            'credit':           credit,
            'journal_type':     cell_str(get(row, 'type'))  or None,
            'class':            cell_str(get(row, 'class_')) or None,
            'vendor_name':      cell_str(get(row, 'name'))  or None,
        })

    detected_years = sorted({r['fiscal_year'] for r in result})
    dbg(f'Extracted {len(result)} GL rows, years={detected_years}')
    return {'rows': result, 'detected_years': detected_years}


# ── BANK STATEMENT ────────────────────────────────────────────────────────────

def extract_bank_statement(wb):
    rows = get_rows(wb, r'bank|statement|transaction|checking|savings')
    if len(rows) < 2:
        emit_error('No data rows found in bank statement file')

    BANK_DATE_ALIASES = DATE_ALIASES + ['transaction date', 'posting date', 'value date']
    BANK_DESC_ALIASES = DESC_ALIASES + ['description', 'transaction', 'payee', 'particulars']
    BANK_AMT_ALIASES  = AMOUNT_ALIASES + ['amount', 'transaction amount', 'withdrawal', 'deposit']
    BANK_BAL_ALIASES  = BALANCE_ALIASES + ['available balance', 'ledger balance']
    BANK_TYPE_ALIASES = TYPE_ALIASES + ['transaction type', 'code']

    def bank_scorer(row):
        score = 0
        for cell in row:
            h = lc(cell)
            if any(h == a or a in h for a in BANK_DATE_ALIASES[:4]):
                score += 4
            if any(h == a or a in h for a in BANK_DESC_ALIASES[:3]):
                score += 3
            if h in ('amount', 'debit', 'credit', 'withdrawal', 'deposit'):
                score += 3
        return score

    header_idx, _ = find_best_header_row(rows, bank_scorer, max_scan=20)
    header_row = rows[header_idx]

    col = {
        'date':    find_col(header_row, BANK_DATE_ALIASES),
        'desc':    find_col(header_row, BANK_DESC_ALIASES),
        'amount':  find_col(header_row, BANK_AMT_ALIASES),
        'debit':   find_col(header_row, DEBIT_ALIASES),
        'credit':  find_col(header_row, CREDIT_ALIASES),
        'balance': find_col(header_row, BANK_BAL_ALIASES),
        'type':    find_col(header_row, BANK_TYPE_ALIASES),
        'ref':     find_col(header_row, REF_ALIASES),
    }

    # Try to pull statement date and bank name from title rows above header
    statement_date = None
    bank_name      = None
    for i in range(min(header_idx, 10)):
        row_text = ' '.join(cell_str(c) for c in rows[i])
        if not statement_date:
            m = re.search(
                r'(january|february|march|april|may|june|july|august'
                r'|september|october|november|december)\s+\d{1,2},?\s+\d{4}',
                row_text, re.IGNORECASE,
            )
            if m:
                try:
                    statement_date = datetime.strptime(
                        m.group(0).replace(',', '').strip(), '%B %d %Y'
                    ).strftime('%Y-%m-%d')
                except ValueError:
                    pass

    # Date column probing fallback — same approach as GL extractor
    if col['date'] < 0:
        for c_idx in range(min(8, len(header_row))):
            for r_idx in range(header_idx + 1, min(header_idx + 6, len(rows))):
                if r_idx < len(rows) and c_idx < len(rows[r_idx]):
                    if parse_date(rows[r_idx][c_idx]):
                        col['date'] = c_idx
                        dbg(f'Date column probed at index {c_idx}')
                        break
            if col['date'] >= 0:
                break
    if col['date'] < 0:
        emit_error('Could not detect date column in bank statement file')

    # If no explicit amount/debit/credit column found, fall back to last numeric value per row
    use_last_numeric = col['amount'] < 0 and col['debit'] < 0 and col['credit'] < 0
    if use_last_numeric:
        dbg('No amount/debit/credit column detected — will use last numeric value per row')

    def get(row, key):
        c = col[key]
        return row[c] if c >= 0 and c < len(row) else None

    result     = []
    all_dates  = []

    for row in rows[header_idx + 1:]:
        if not row or all(v is None or str(v).strip() == '' for v in row):
            continue

        date_str = parse_date(get(row, 'date'))
        if not date_str:
            continue

        all_dates.append(date_str)

        # Determine amount and transaction type
        amount   = None
        txn_type = None

        raw_amount = get(row, 'amount')
        if raw_amount is not None:
            amount = parse_amount(raw_amount)

        if amount is None and col['debit'] >= 0:
            debit  = parse_amount(get(row, 'debit')  or 0)
            credit = parse_amount(get(row, 'credit') or 0)
            if debit and debit != 0:
                amount   = -abs(debit)
                txn_type = 'Withdrawal'
            elif credit and credit != 0:
                amount   = abs(credit)
                txn_type = 'Deposit'

        # Last-resort: use rightmost numeric cell after the date column
        if amount is None and use_last_numeric:
            date_col = col['date']
            for c in range(len(row) - 1, date_col, -1):
                v = parse_amount(row[c] if c < len(row) else None)
                if v is not None:
                    amount = v
                    break

        if amount is None:
            continue

        if not txn_type:
            txn_type = cell_str(get(row, 'type')) or None

        stmt_year  = int(date_str[:4])
        stmt_month = f'{date_str[:7]}-01'

        balance = parse_amount(get(row, 'balance'))

        result.append({
            'statement_date':  date_str,           # updated after loop if needed
            'statement_month': stmt_month,
            'bank_account':    bank_name or 'Bank Account',
            'bank_name':       bank_name,
            'account_type':    None,
            'transaction_date': date_str,
            'description':     cell_str(get(row, 'desc'))  or None,
            'reference':       cell_str(get(row, 'ref'))   or None,
            'amount':          amount,
            'transaction_type': txn_type,
            'running_balance': balance,
            'statement_year':  stmt_year,
        })

    # Finalize statement_date from max date if not found in title rows
    if all_dates and not statement_date:
        statement_date = max(all_dates)
        stmt_month     = f'{statement_date[:7]}-01'
        for r in result:
            r['statement_date']  = statement_date
            r['statement_month'] = stmt_month

    detected_years = sorted({r['statement_year'] for r in result})
    dbg(f'Extracted {len(result)} bank rows, years={detected_years}')
    return {'rows': result, 'detected_years': detected_years}


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Extract financial data from Excel files')
    parser.add_argument('--type', required=True,
        choices=['profit_loss', 'balance_sheet', 'general_ledger', 'bank_statement'])
    parser.add_argument('--filename', default='', help='Original filename (for logging)')
    args = parser.parse_args()

    dbg(f'type={args.type} filename="{args.filename}"')
    wb = load_wb()

    try:
        if args.type == 'profit_loss':
            result = extract_profit_loss(wb)
        elif args.type == 'balance_sheet':
            result = extract_balance_sheet(wb)
        elif args.type == 'general_ledger':
            result = extract_general_ledger(wb)
        else:
            result = extract_bank_statement(wb)
    except SystemExit:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        emit_error(str(e))
        return

    wb.close()

    if not result['rows']:
        emit_error(f'No {args.type} rows extracted from file')

    emit(result)


if __name__ == '__main__':
    main()
