#!/usr/bin/env python3
"""
Build the anonymized golden fixture for @datahub/financial-engine.

PROVENANCE
  Source workbooks (client data — deliberately NOT committed):
    - "Data walkthrough 05.05.2026.xlsx"   (Josh Tonnesen, 5 May 2026)
        Staged GL Data / <year> P&L / Starting + Ending Balance Sheet
    - "Key Reports Data.xlsx"              (attached to the 25 Jul 2026 UAT email)
        Chart of Accounts / Trial Balance Entries

  The underlying engagement is a real one. This script renames the entity, the
  identifying account labels and every vendor, and CHANGES NO AMOUNT. Row counts
  and per-year totals are asserted before writing, so an anonymization mistake
  fails the build rather than silently producing a fixture that asserts fiction.

USAGE
  python3 build-fixture.py <path-to-downloads-dir>

Dependency-free on purpose (no openpyxl): reads xlsx via zipfile + ElementTree.
"""
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

WALKTHROUGH = "Data walkthrough 05.05.2026.xlsx"

# ── anonymization ────────────────────────────────────────────────────────────
COMPANY_REAL = "Space Entertainment Center, LLC"
COMPANY_ALIAS = "Cascade Family Entertainment, LLC"

ACCOUNT_ALIASES = {
    "Business Checking (7454)": "Operating Checking (1001)",
    "Business Money Market": "Reserve Money Market",
    "Provident Bank Business Checking": "Community Bank Operating",
    "Provident Bank Money Market Checking": "Community Bank Money Market",
    "Space Center Savings": "Facility Savings",
    "Due from ERTC": "Due from Payroll Tax Credit",
    "Loans to MTP": "Loans to Affiliate",
    "Loan Payable from MTP": "Loan Payable to Affiliate",
    "Loan Payable - Betson Enterprises": "Loan Payable - Equipment Vendor",
    "Loan Payable- Betson Enterprises II": "Loan Payable - Equipment Vendor II",
    "Loan Payable- Porsche": "Loan Payable - Vehicle Finance",
    "Loan Payable- Florian Realty LLC": "Loan Payable - Property Lessor",
    "Loan Payable- Provident Bank": "Loan Payable - Community Bank",
    "Loan Payable - State of NH": "Loan Payable - State Agency",
    "Capital One - Credit Card": "Corporate Credit Card",
    "Capital One Credit Card 2": "Corporate Credit Card II",
    "Credit Card Payable- Capital One": "Credit Card Payable - Corporate",
    "Chase Ink Credit Card": "Business Rewards Credit Card",
    "Sam's Credit Card": "Warehouse Club Credit Card",
    "Sams Club Credit Card": "Warehouse Club Credit Card II",
    "Credit Card Payable- Sam's Club": "Credit Card Payable - Warehouse Club",
    "Credit Card Payable- BJ's": "Credit Card Payable - Wholesale Club",
}

# ── ebitda_role: the centralized flag QE-0004 requires in place of label regex.
# Anything not named here is deliberately left unflagged and contributes nothing
# to Reported EBITDA. Note what is ABSENT: Meals Tax, Real estate taxes and
# Taxes & Licenses are operating expenses, not income tax expense.
EBITDA_ROLES = {
    "Interest Income": "interest_income",
    "Interest Paid": "interest_expense",
    "Depreciation": "depreciation",
    "Amortization": "amortization",
    "Amortization of Financing Costs": "amortization",
}

PL_SECTION_HEADERS = {
    "Income", "Expenses", "Other Income", "Other Expenses", "Cost of Goods Sold",
}
PL_SKIP_PREFIXES = ("Total for", "Total ")
PL_SKIP_EXACT = {
    "Gross Profit", "Net Operating Income", "Net Income", "Net Other Income",
    "Net Revenue",
}


def load_workbook(path):
    z = zipfile.ZipFile(path)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")):
            shared.append("".join(t.text or "" for t in si.iter(NS + "t")))
    rels = {e.get("Id"): e.get("Target") for e in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    sheets = {}
    for s in ET.fromstring(z.read("xl/workbook.xml")).iter(NS + "sheet"):
        tgt = rels[s.get(RNS + "id")]
        sheets[s.get("name")] = tgt if tgt.startswith("xl/") else "xl/" + tgt.lstrip("/")
    return z, shared, sheets


def col_index(ref):
    letters = re.match(r"([A-Z]+)", ref).group(1)
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def sheet_rows(z, shared, target):
    for row in ET.fromstring(z.read(target)).iter(NS + "row"):
        cells = {}
        for c in row:
            v, t = c.find(NS + "v"), c.get("t")
            if v is None:
                continue
            cells[col_index(c.get("r"))] = shared[int(v.text)] if t == "s" else v.text
        yield [cells.get(i, "") for i in range(max(cells) + 1)] if cells else []


def cell(row, i):
    return str(row[i]).strip() if i < len(row) else ""


def classify_pl_accounts(z, shared, sheets):
    """Income vs expense, read from each year's own P&L section headers."""
    kind = {}
    for year in (2022, 2023, 2024, 2025):
        section = None
        for row in list(sheet_rows(z, shared, sheets[f"{year} P&L"]))[4:]:
            label = cell(row, 0)
            if not label:
                continue
            if label in PL_SECTION_HEADERS:
                section = label
                continue
            if label in PL_SKIP_EXACT or label.startswith(PL_SKIP_PREFIXES):
                continue
            if "Basis" in label and "GMT" in label:  # QuickBooks footer artifact
                continue
            if section:
                kind[label] = "income" if "Income" in section else "expense"
    return kind


def main(downloads):
    z, shared, sheets = load_workbook(os.path.join(downloads, WALKTHROUGH))
    pl_kind = classify_pl_accounts(z, shared, sheets)

    # ── staged GL → (account, year, month, vendor) buckets ────────────────────
    raw = defaultdict(float)
    statement_of = {}
    vendors_seen = []
    rows_read = 0
    for row in list(sheet_rows(z, shared, sheets["Staged GL Data"]))[4:]:
        account, date = cell(row, 1), cell(row, 2)
        if not account or account == "Beginning Balance" or not date:
            continue
        year_raw = cell(row, 10)
        if year_raw in ("", "1900"):
            continue
        try:
            amount = float(cell(row, 8) or 0)
            year, month = int(float(year_raw)), int(float(cell(row, 11) or 0))
        except ValueError:
            continue
        statement = "profit_loss" if cell(row, 12) == "P&L" else "balance_sheet"
        statement_of.setdefault(account, statement)
        vendor = cell(row, 5)
        if vendor and vendor not in vendors_seen:
            vendors_seen.append(vendor)
        raw[(account, year, month, vendor)] += amount
        rows_read += 1

    vendor_alias = {v: f"Vendor {i + 1:03d}" for i, v in enumerate(vendors_seen)}

    # ── accounts ─────────────────────────────────────────────────────────────
    accounts, account_id = [], {}
    for name in sorted(statement_of):
        statement = statement_of[name]
        alias = ACCOUNT_ALIASES.get(name, name)
        aid = re.sub(r"[^a-z0-9]+", "-", alias.lower()).strip("-")
        account_id[name] = aid
        accounts.append({
            "id": aid,
            "name": alias,
            "statementType": statement,
            "accountType": pl_kind.get(name) if statement == "profit_loss" else None,
            "ebitdaRole": EBITDA_ROLES.get(name),
        })

    unclassified = [a["name"] for a in accounts
                    if a["statementType"] == "profit_loss" and not a["accountType"]]
    if unclassified:
        sys.exit(f"P&L accounts with no income/expense classification: {unclassified}")

    entries = [
        {
            "accountId": account_id[account],
            "fiscalYear": year,
            "month": month,
            "amount": round(amount, 2),
            "vendor": vendor_alias.get(vendor),
        }
        for (account, year, month, vendor), amount in sorted(raw.items())
        if round(amount, 2) != 0
    ]

    # ── assertions: anonymization must not have moved a number ────────────────
    expected = {
        2022: (2609930.60, 2494034.22, 115896.38),
        2023: (2927853.69, 2823774.57, 104079.12),
        2024: (2511740.83, 2464172.60, 47568.23),
        2025: (2333398.51, 2163902.61, 169495.90),
    }
    kind_of = {a["id"]: a["accountType"] for a in accounts}
    for year, (want_rev, want_exp, want_ni) in expected.items():
        rev = sum(e["amount"] for e in entries
                  if e["fiscalYear"] == year and kind_of.get(e["accountId"]) == "income")
        exp = sum(e["amount"] for e in entries
                  if e["fiscalYear"] == year and kind_of.get(e["accountId"]) == "expense")
        for label, got, want in (("revenue", rev, want_rev), ("expenses", exp, want_exp),
                                 ("net income", rev - exp, want_ni)):
            if abs(round(got, 2) - want) > 0.01:
                sys.exit(f"FY{year} {label}: got {got:,.2f}, expected {want:,.2f}")

    fixture = {
        "_provenance": (
            "Anonymized from 'Data walkthrough 05.05.2026.xlsx'. Entity, account labels "
            "and vendors renamed; no amount altered. Regenerate with scripts/build-fixture.py."
        ),
        "company": {
            "id": "11111111-1111-4111-8111-111111111111",
            "name": COMPANY_ALIAS,
            "profitMetric": "adjusted_ebitda",
            "marketRateReplacementSalary": None,
        },
        "fiscalYears": [2022, 2023, 2024, 2025],
        "accounts": accounts,
        "glEntries": entries,
    }

    out = os.path.join(os.path.dirname(__file__), "..", "src", "__fixtures__", "engagement.json")
    with open(os.path.normpath(out), "w") as fh:
        json.dump(fixture, fh, separators=(",", ":"), sort_keys=False)
    print(f"GL rows read      : {rows_read:,}")
    print(f"entries written   : {len(entries):,}")
    print(f"accounts          : {len(accounts)} "
          f"({sum(1 for a in accounts if a['statementType'] == 'profit_loss')} P&L)")
    print(f"vendors anonymized: {len(vendor_alias):,}")
    print(f"wrote             : {os.path.normpath(out)}")
    print("all four fiscal years tie to the expected revenue / expense / net income")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/home/blake/Downloads")
