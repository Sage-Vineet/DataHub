#!/usr/bin/env python3
"""
Regression harness for the Balance Sheet section-classification root-cause
fix in extract_excel.py (infer_bs_header_section / bs_section_from_ancestry).
No file/DB access -- pure function tests against real module functions.

Mirrors backend/scripts/validateBsSectionAncestry.js exactly (same cases,
same rationale) since this is the Python PRIMARY extraction path for Excel
Balance Sheets (the JS service is the fallback).

Root cause fixed here: `section` used to be read off a single flat
`current_section` variable that was only reassigned when a recognized
section-header LINE was itself visited, and was never rescoped when the
document's own indentation ancestor-stack popped back past that header.
bs_section_from_ancestry instead derives `section` fresh, per row, from that
row's OWN real ancestor chain (parent_path, walked nearest-ancestor-first) --
immune to whatever a shared mutable variable happens to be pointing at.

Run: python backend/python/test_bs_section_ancestry.py
"""
import sys

from extract_excel import infer_bs_header_section, bs_section_from_ancestry

pass_count = 0
fail_count = 0
failures = []


def check(name, actual, expected):
    global pass_count, fail_count
    if actual == expected:
        pass_count += 1
        print(f"  PASS  {name}")
    else:
        fail_count += 1
        failures.append(name)
        print(f"  FAIL  {name}\n        expected: {expected!r}\n        actual  : {actual!r}")


print("\n=== 1. infer_bs_header_section: bare header vocabulary (single concept) ===")
check("Asset test: 'Assets' -> assets", infer_bs_header_section("Assets"), "assets")
check("Asset test: 'Current Assets' -> assets", infer_bs_header_section("Current Assets"), "assets")
check("Asset test: 'Fixed Assets' -> assets", infer_bs_header_section("Fixed Assets"), "assets")
check("Liability test: 'Liabilities' -> liabilities", infer_bs_header_section("Liabilities"), "liabilities")
check("Liability test: 'Current Liabilities' -> liabilities", infer_bs_header_section("Current Liabilities"), "liabilities")
check("Liability test: 'Long Term Liabilities' -> liabilities", infer_bs_header_section("Long Term Liabilities"), "liabilities")
check("Equity test: 'Equity' -> equity", infer_bs_header_section("Equity"), "equity")
check("Equity test: 'Owners Equity' -> equity", infer_bs_header_section("Owners Equity"), "equity")
check("Equity test: 'Stockholders Equity' -> equity", infer_bs_header_section("Stockholders Equity"), "equity")
check(
    "Not a header: 'Capital One Credit Card' -> None (regression guard against a substring-match false positive)",
    infer_bs_header_section("Capital One Credit Card"), None,
)
check("Not a header: 'Chase Bank' -> None", infer_bs_header_section("Chase Bank"), None)
check(
    "Not a header: '30010 TH Equity' (a real account name, not a header line) -> None",
    infer_bs_header_section("30010 TH Equity"), None,
)

print("\n=== 2. bs_section_from_ancestry: Asset branch (nearest-ancestor-first walk) ===")
check(
    "1. Asset account: Assets > Current Assets > Bank Accounts > Chase Bank",
    bs_section_from_ancestry(["Assets", "Current Assets", "Bank Accounts"]), "assets",
)
check(
    "2. Multiple asset branches: Assets > Fixed Assets",
    bs_section_from_ancestry(["Assets", "Fixed Assets"]), "assets",
)
check(
    "3. Multiple asset branches: Assets > Other Current Assets > Prepaid Expenses",
    bs_section_from_ancestry(["Assets", "Other Current Assets", "Prepaid Expenses"]), "assets",
)
check(
    "4. Repeated document labels: Total Assets > Total Assets > Current Assets",
    bs_section_from_ancestry(["Total Assets", "Total Assets", "Current Assets"]), "assets",
)
check("5. Shallow hierarchy: Assets only", bs_section_from_ancestry(["Assets"]), "assets")

print("\n=== 3. bs_section_from_ancestry: Liability branch under the combined umbrella ===")
check(
    "6. Liability account: Liabilities and Equity > Liabilities > Current Liabilities > Accounts Payable",
    bs_section_from_ancestry(["Liabilities and Equity", "Liabilities", "Current Liabilities"]), "liabilities",
)
check(
    "7. Multiple liability branches: ... > Liabilities > Long Term Liabilities",
    bs_section_from_ancestry(["Liabilities and Equity", "Liabilities", "Long Term Liabilities"]), "liabilities",
)
check(
    "8. Multiple liability branches: ... > Liabilities > Other Current Liabilities",
    bs_section_from_ancestry(["Liabilities and Equity", "Liabilities", "Other Current Liabilities"]), "liabilities",
)
check(
    "9. Deep hierarchy with unrecognized intermediate groups still resolves via nearest recognized ancestor",
    bs_section_from_ancestry(
        ["Liabilities and Equity", "Liabilities", "Credit Cards", "Business Card Program", "Store Card"]
    ),
    "liabilities",
)

print("\n=== 4. bs_section_from_ancestry: Equity branch under the combined umbrella (the reported bug) ===")
check(
    "10. CRITICAL - reported bug: Liabilities and Equity > Equity > Shareholder Equity > 30010 TH Equity => equity, NOT liability",
    bs_section_from_ancestry(["Liabilities and Equity", "Equity", "Shareholder Equity"]), "equity",
)
check(
    "11. Multiple equity branches: ... > Equity > Owners Capital",
    bs_section_from_ancestry(["Liabilities and Equity", "Equity", "Owners Capital"]), "equity",
)
check(
    "12. Multiple equity branches: ... > Equity > Partners Capital",
    bs_section_from_ancestry(["Liabilities and Equity", "Equity", "Partners Capital"]), "equity",
)
check(
    "13. Shallow hierarchy: Liabilities and Equity > Equity",
    bs_section_from_ancestry(["Liabilities and Equity", "Equity"]), "equity",
)

print("\n=== 5. THE ROOT-CAUSE PROOF: ancestry-based derivation is immune to a poisoned/stale current_section ===")
poisoned_current_section = "Current Liabilities"
true_parent_path = ["Liabilities and Equity", "Equity"]

old_result = infer_bs_header_section(poisoned_current_section)
new_result = bs_section_from_ancestry(true_parent_path)

check(
    "14. OLD formula (infer_bs_header_section(current_section)) reproduces the confirmed bug: gives 'liabilities' for a real Equity account",
    old_result, "liabilities",
)
check(
    "15. NEW formula (bs_section_from_ancestry(parent_path)) is immune to the poisoned variable: gives 'equity' regardless of current_section",
    new_result, "equity",
)
check("16. OLD and NEW disagree on this exact case - this is the bug the fix closes", old_result != new_result, True)

print("\n=== 6. Known residual limitation (documented, NOT silently claimed fixed) ===")
check(
    "17. Documented limitation: umbrella-only ancestor (no distinguishing branch) still defaults to 'liabilities'",
    bs_section_from_ancestry(["Liabilities and Equity"]), "liabilities",
)

print(f"\n{'=' * 60}\n{pass_count} passed, {fail_count} failed\n{'=' * 60}")
if fail_count > 0:
    print("Failures:")
    for f in failures:
        print(f"  - {f}")
sys.exit(0 if fail_count == 0 else 1)
