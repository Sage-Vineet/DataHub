const path = require("path");
const { Worker } = require("worker_threads");
const XLSX = require("xlsx");
const { supabase } = require("../db");
const { processBalanceSheet } = require("./balanceSheetService");
const {
  REPORT_SOURCE_KEYS,
  updateReportSourceRecord,
} = require("./reportSourceStore");
const { parsePdfWithGemini } = require("./geminiFinancialParser");
const {
  normalizeBankBinary,
  extractBankStatementsFromPdfBase64,
  extractBankStatementsFromExcelBuffer,
  buildBankResponseShape,
} = require("./bankStatementExtractor");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getGeminiModels } = require("../config/geminiModels");

const PDF_WORKER_PATH = path.join(__dirname, "../workers/pdfParser.js");
const PDF_PARSE_TIMEOUT_MS = 30000;

const MANUAL_REPORT_UPLOAD_SOURCE = "manual_report_upload";
const STATEMENT_TYPES = {
  BALANCE_SHEET: "balance_sheet",
  PROFIT_AND_LOSS: "profit_and_loss",
  CASH_FLOW: "cash_flow",
  BANK_RECONCILIATION: "bank_reconciliation",
  TAX_RETURN: "tax_return",
};

// The report_types the Manual Upload sync itself produces, and therefore the ONLY
// ones it may clear before re-syncing.
//
// The "manual_report_upload" source partition is shared: Key Reports result caches
// (kr_financial_statements_v1, kr_pl_financials_v2, kr_activity_review_v2), bank
// reconciliation caches (bank_reconciliation_kr_v3, bs_bank_balances_cache_v2), the
// Tax Reconciliation cache (tax_return_kr_v7) and — critically —
// tax_reconciliation_overrides, which holds values the USER typed by hand, all live
// under the same `source`. Deleting the whole partition destroyed all of it on every
// "Sync All", so the clear-down is restricted to this allow-list. Anything not
// listed here is owned by another subsystem and must survive a re-sync; new cache
// types are therefore safe by default.
const MANUAL_UPLOAD_SYNC_OWNED_REPORT_TYPES = [
  ...Object.values(STATEMENT_TYPES),
  "pl_for_tax",
];

// ─── QMS Sync Progress Store ────────────────────────────────────────────────
// In-memory store for live sync progress. Keyed by companyId.
// Cleared when sync completes or errors.
const _syncProgressStore = new Map();

function _setSyncProgress(companyId, data) {
  _syncProgressStore.set(String(companyId), { ...data, updatedAt: Date.now() });
}

function getSyncProgress(companyId) {
  return _syncProgressStore.get(String(companyId)) || null;
}

function _clearSyncProgress(companyId) {
  _syncProgressStore.delete(String(companyId));
}

// ─── Manual Upload (Excel/PDF) Sync Progress Store ────────────────────────────
const _manualUploadProgressStore = new Map();

function _setManualUploadProgress(companyId, data) {
  _manualUploadProgressStore.set(String(companyId), { ...data, updatedAt: Date.now() });
}

function getManualUploadProgress(companyId) {
  return _manualUploadProgressStore.get(String(companyId)) || null;
}

function _clearManualUploadProgress(companyId) {
  _manualUploadProgressStore.delete(String(companyId));
}

/* =========================================================
   TAX RETURN EXTRACTION — Gemini vision (image-based PDFs)
   Sends raw PDF bytes to Gemini as inline multimodal data.
   Works for both text-based and scanned/image-based PDFs.
========================================================= */

// Dynamically selected via GEMINI_MODELS / GEMINI_MODEL env; this array is the
// default fallback order used when no override is configured.
// "gemini-2.0-flash" removed — decommissioned (API returns 404), so as a fallback
// it only converted transient failures into hard errors.
//
// ── WHY TAX RETURNS GET A STRONGER MODEL THAN EVERY OTHER READER HERE ────────
// flash-lite used to be FIRST. A filed return package is 100–200 pages and the task
// is not "read a table" but "hold a form/schedule/line/column address space": page 1
// line 22 vs line 21, Schedule K 16c vs 16d, Schedule M-1 vs Schedule M-2, federal
// vs five state returns each repeating the same captions with different numbers.
// flash-lite loses that structure and returns confidently mis-addressed figures — a
// wrong number is far more expensive here than a slow one, because a CPA signs it.
//
// Ordering is accuracy-first with graceful degradation: the loop below advances to
// the next model on a 404, so an unavailable tier costs one failed call, not an error.
// Override per environment with GEMINI_MODELS (ordered list) or GEMINI_MODEL.
const TAX_GEMINI_MODELS = getGeminiModels([
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
]);
const _taxExtractCache = new Map();
const _taxExtractSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TAX_EXTRACTION_PROMPT = `
You are extracting data from a US Business Income Tax Return.
This may be a scanned (image-based) PDF — use your vision capability to read every page carefully.
Do NOT guess or interpolate — only report what is visually printed on the form.

STEP 1 — DETECT THE FORM TYPE
Look at the very top of Page 1 for the form number:
  - "Form 1120-S" → S-Corporation return
  - "Form 1065"   → Partnership return
  - "Form 1120"   → C-Corporation return
Set "formType" to "1120-S", "1065", or "1120" accordingly. Default to "1120-S" if unclear.

═══════════════════════════════════════════════════════
FORM 1120-S (S-CORPORATION) — read PAGE 1 and the FULL SCHEDULE K
═══════════════════════════════════════════════════════

PAGE 1 — INCOME & DEDUCTIONS (Form 1120-S):
  Line 1a  — Gross receipts or sales
  Line 1b  — Returns and allowances
  Line 1c  — Balance = Line 1a − 1b (far-right column) → "totalRevenue"
             ⚠️ "totalRevenue" is GROSS RECEIPTS ONLY (Line 1c). It is the top-line sales figure,
                NOT Line 6 "Total income".
  Line 2   — Cost of goods sold         → "totalCostOfGoodsSold"
  Line 3   — Gross profit               → "grossProfit"
  Line 4   — Net gain (loss) Form 4797  → "netGain4797" (0 if blank)
  Line 5   — Other income (loss)        → "otherIncome"  (0 if blank; often shown as "See Statement")
  Line 6   — Total income (loss)        → "totalIncome"
             ⚠️ Line 6 = Line 3 + Line 4 + Line 5, and is LARGER than gross receipts. NEVER copy
                Line 6 into "totalRevenue" — it goes in "totalIncome" only.
  Line 7   — Compensation of officers   → "officerWages"
  Line 13  — Interest                   → "interestExpense"
  Line 14  — Depreciation from Form 4562 → "depreciation"
  Line 20  — Other deductions           → "allOtherExpenses" (and check attached statement for amortization)
  Line 21  — Total deductions           → "totalDeductions"
  Line 22  — Ordinary business income (loss) → "netIncome"

  ⚠️⚠️ MATCH THE PRINTED CAPTION, NOT THE LINE NUMBER. The IRS renumbered the
     deductions block: the 2023 revision inserted line 19 "Energy efficient
     commercial buildings deduction", pushing Other deductions 19→20, Total
     deductions 20→21 and Ordinary business income 21→22. Older returns still use
     the old numbers. So for these three fields find the row by its CAPTION:
       "Other deductions"                  → "allOtherExpenses"
       "Total deductions"                  → "totalDeductions"
       "Ordinary business income (loss)"    → "netIncome"
     NEVER put "Total deductions" into "netIncome" — it is a large POSITIVE number
     (often 7–8 figures) and netIncome is the small bottom-line profit or loss.
     NEVER put "Other deductions" into "totalDeductions".

SCHEDULE K (Form 1120-S) — "Shareholders' Pro Rata Share Items", Lines 2 through 17:
  ⚠️ Schedule K SPANS TWO PAGES (typically page 3 for lines 1–14 and page 4 for
     lines 15–18). Read BOTH pages. Do NOT stop at line 14. The "Items Affecting
     Shareholder Basis" (line 16) and "Other Information" (line 17) lines are on
     the SECOND page and MUST be read.

  ⚠️ SCHEDULE K EXTRACTION RULES — READ CAREFULLY:
  1. Look at the "Total amount" column on the RIGHT SIDE of the Schedule K table.
  2. For each line, examine ONLY the printed dollar amount in that right-hand column.
  3. INCLUDE the line ONLY if you can see a clearly printed, non-zero number there.
  4. If the cell is blank, empty, has a dash (—), or contains 0 → DO NOT include it.
  5. DO NOT guess, estimate, or carry values from other parts of the form.
  6. DO NOT include Line 1 (already captured as netIncome).
  7. DO NOT include Line 18 "Income (loss) reconciliation" — it is only a TOTAL that
     restates Ordinary business income and is NOT a reconciling item.
  8. Use the EXACT label text below for each line — do not paraphrase or re-case it.
  9. ROW ALIGNMENT — MATCH BY PRINTED LINE CODE, NOT BY ROW POSITION. Each amount in the
     "Total amount" column belongs to the line whose printed code (e.g. "16c", "16d",
     "17a") sits on the SAME horizontal row. Lines 15a–15f, 16a–16f and 17a–17b are
     stacked very close together — do NOT shift a value up or down by a row. Read the line
     code printed immediately to the left of each amount and attach the amount to THAT
     code, then use that code's label from the list below. (Example: a single "912" printed
     on the "16c" row is "Nondeductible Expenses" = 912 — it is NOT "16b" and NOT "16d".)
  10. SOURCE RESTRICTION — SCHEDULE K "Total amount" COLUMN ONLY. Every reconcilingItems
      value MUST be read from the Schedule K "Total amount" column. NEVER take a value from
      Schedule M-1 or from Schedule M-2 ("Analysis of the Accumulated Adjustments Account …").
      ⚠️ Schedule M-2's "Balance at beginning of tax year", "Combine lines 1 through 5", and
         "Balance at end of tax year" are running ACCUMULATED ADJUSTMENTS ACCOUNT (AAA)
         BALANCES — they are NOT distributions and must NEVER be reported as "Distributions"
         (or any other Schedule K item). Schedule M-2 has its own line labeled "Distributions";
         do not grab the AAA balance printed next to it and call it a distribution.
      ⚠️ "16d Distributions" is taken ONLY from Schedule K line 16d's "Total amount" cell.
         If that cell is blank/zero, Distributions = 0 and you MUST omit it — even when
         Schedule M-2 shows a non-zero AAA balance.
  11. SELF-CHECK (validation ONLY — never a source of numbers): a correctly-read Schedule K
      value usually agrees with its companion line — "16c Nondeductible Expenses" ≈ Schedule
      M-1 line 3 / M-2 "Other reductions"; "16d Distributions" ≈ Schedule M-2 LINE 7
      "Distributions" (NOT the M-2 balance lines). If a Schedule K "Total amount" cell is blank,
      the item is 0 regardless of any M-2 balance. The Schedule K "Total amount" column is
      always authoritative — if in doubt, trust the blank Schedule K cell over any M-2 figure.

  Line → label mapping (ONLY add lines with a visible non-zero value in "Total amount"):
  2  → "Net Rental Real Estate Income"
  3c → "Other Net Rental Income"
  4  → "Interest Income"
  5a → "Ordinary Dividends"
  5b → "Qualified Dividends"
  6  → "Royalties"
  7  → "Net Short-Term Capital Gain (Loss)"
  8a → "Net Long-Term Capital Gain (Loss)"
  9  → "Net Section 1231 Gain (Loss)"
  10 → "Other Income (Loss)"
  11 → "Section 179 Deduction"
  12a → "Charitable Contributions"
  12b → "Investment Interest Expense"
  12c → "Section 59(e)(2) Expenditures"
  12d → "Other Deductions"
  13a → "Low-Income Housing Credit Sec42(j)(5)"
  13b → "Low-Income Housing Credit Other"
  13c → "Qualified Rehabilitation Expenditures"
  13d → "Other Real Estate Credits"
  13e → "Other Rental Credits"
  13f → "Biofuel Producer Credit"
  13g → "Other Credits"
  15a → "Post-1986 Depreciation Adjustment"
  15b → "Adjusted Gain or Loss"
  15c → "Depletion Other Than Oil and Gas"
  15d → "Oil Gas Geothermal Properties Gross Income"
  15e → "Oil Gas Geothermal Properties Deductions"
  15f → "Other AMT Items"
  16a → "Tax-Exempt Interest Income"
  16b → "Other Tax-Exempt Income"
  16c → "Nondeductible Expenses"
  16d → "Distributions"
  16e → "Repayment of Loans from Shareholders"
  16f → "Foreign Taxes Paid or Accrued"
  17a → "Investment Income"
  17b → "Investment Expenses"
  (SKIP line 17c "Dividend distributions paid from AE&P" and line 18 reconciliation.)

═══════════════════════════════════════════════════════
FORM 1065 (PARTNERSHIP) — read PAGE 1 and ONLY the partnership-level SCHEDULE K page
═══════════════════════════════════════════════════════

⚠️ CRITICAL — SCHEDULE K-1 WARNING:
  The PDF contains MANY pages labelled "Schedule K-1" (one per partner). These are INDIVIDUAL partner pages.
  You MUST COMPLETELY IGNORE every page that has "Schedule K-1" anywhere in its header or title.
  ONLY read the SINGLE page titled exactly "Schedule K  Partners' Distributive Share Items".
  That Schedule K page has a column labelled "Total amount" (or similar) showing the WHOLE PARTNERSHIP totals.
  ANY value from a Schedule K-1 page is WRONG. Do not use it.

PAGE 1 — INCOME & DEDUCTIONS (Form 1065):
  Line 1a  — Gross receipts or sales
  Line 1b  — Returns and allowances
  Line 1c  — Balance (far-right column) → "totalRevenue"
  Line 2   — Cost of goods sold         → "totalCostOfGoodsSold"
  Line 3   — Gross profit               → "grossProfit"
  Line 10  — Guaranteed payments to partners → "officerWages" (use 0 if blank)
  Line 15  — Interest                   → "interestExpense"
  Line 16c — Net depreciation (far-right column) → "depreciation"
             ⚠️ If the far-right column for Line 16c is blank or empty, enter 0.
             Do NOT substitute any value from Schedule K or Schedule K-1 for this field.
  Line 7   — Other income (loss)        → "otherIncome"  (0 if blank)
  Line 8   — Total income (loss)        → "totalIncome"
  Line 21  — Other deductions (NOT Line 22) → "allOtherExpenses"
             ⚠️ Use ONLY Line 21 "Other deductions". Do NOT use Line 22 "Total deductions".
             Line 22 is the sum of all deductions and will be much larger — ignore it.
  Line 22  — Total deductions           → "totalDeductions"
  Line 23  — Ordinary business income (loss) → "netIncome"
             ⚠️ Match these three by CAPTION, not line number — IRS line numbering
                shifts between revisions. "Other deductions" ≠ "Total deductions" ≠
                "Ordinary business income (loss)".

  "amortization":
    Look for a statement attached to Line 21 (may be labelled "Statement 1", "Statement 2", etc.)
    If the statement lists "Amortization" or "Amortization expense" as a line item, use that amount.
    Otherwise use 0.

SCHEDULE K page — Partners' Distributive Share Items (Form 1065):
  ⚠️ READ ONLY the page titled "Schedule K  Partners' Distributive Share Items".
     This page shows totals for the ENTIRE PARTNERSHIP in a single column (often "Total amount").
  ⚠️ DO NOT read any page with "Schedule K-1" in the title — those are partner-specific pages.

  ⚠️ SCHEDULE K EXTRACTION RULES — READ CAREFULLY:
  1. Look at the "Total amount" column on the RIGHT SIDE of the Schedule K table.
  2. INCLUDE a line ONLY if you can see a clearly printed, non-zero dollar amount in that column.
  3. If a cell is blank, empty, has a dash (—), or shows 0 → DO NOT include it.
  4. DO NOT include Line 1 (already captured as netIncome).
  5. DO NOT guess or carry over values from other pages or statements.

  SKIP Line 1 (= netIncome already captured).
  Line → label mapping (ONLY add lines with a visible non-zero value in "Total amount"):
  2  → "Net Rental Real Estate Income"
  3a → "Other Gross Rental Income"
  3c → "Other Net Rental Income"
  4c → "Guaranteed Payments Total"
  5  → "Interest Income"
  6a → "Ordinary Dividends"
  6b → "Qualified Dividends"
  7  → "Royalties"
  8  → "Net Short-Term Capital Gain (Loss)"
  9a → "Net Long-Term Capital Gain (Loss)"
  9c → "Unrecaptured Section 1250 Gain"
  10 → "Net Section 1231 Gain (Loss)"
  11 → "Other Income (Loss)"
  12 → "Section 179 Deduction"
  13a → "Charitable Contributions Cash"
  13b → "Charitable Contributions Noncash"
  13c → "Investment Interest Expense"
  13d2 → "Section 59(e)(2) Expenditures"
  14a → "Net Earnings from Self-Employment"
  14b → "Gross Farming or Fishing Income"
  14c → "Gross Nonfarm Income"
  15a → "Low-Income Housing Credit Sec42(j)(5)"
  15b → "Low-Income Housing Credit Other"
  15c → "Qualified Rehabilitation Expenditures"
  15d → "Other Real Estate Credits"
  15e → "Other Rental Credits"
  15f → "Other Credits"
  17a → "Post-1986 Depreciation Adjustment"
  17b → "Adjusted Gain or Loss"
  17c → "Depletion Other Than Oil and Gas"
  18a → "Tax-Exempt Interest Income"
  18b → "Other Tax-Exempt Income"
  18c → "Nondeductible Expenses"
  19a → "Distributions of Cash and Marketable Securities"
  19b → "Distributions of Other Property"
  20a → "Investment Income"
  20b → "Investment Expenses"
  21  → "Total Foreign Taxes Paid or Accrued"

═══════════════════════════════════════════════════════
FORM 1120 (C-CORPORATION) — read PAGE 1 only
═══════════════════════════════════════════════════════

PAGE 1 — INCOME & DEDUCTIONS (Form 1120):
  Line 1c  — Gross receipts balance     → "totalRevenue"
  Line 2   — Cost of goods sold         → "totalCostOfGoodsSold"
  Line 3   — Gross profit               → "grossProfit"
  Line 9   — Net gain (loss) Form 4797  → "netGain4797" (0 if blank)
  Line 10  — Other income               → "otherIncome"  (0 if blank)
  Line 11  — Total income               → "totalIncome"
  Line 12  — Compensation of officers   → "officerWages"
  Line 17  — Interest                   → "interestExpense"
  Line 20  — Depreciation               → "depreciation"
  Line 26  — Other deductions           → "allOtherExpenses"
  Line 27  — Total deductions           → "totalDeductions"
  Line 28  — Taxable income before NOL  → "netIncome"
             ⚠️ Match "Other deductions", "Total deductions" and the bottom line by
                CAPTION, not line number — IRS numbering shifts between revisions.
  reconcilingItems: [] (no Schedule K for C-Corp)

═══════════════════════════════════════════════════════
SCHEDULE M-1 — BOOK-TO-TAX RECONCILIATION (ALL FORMS)
═══════════════════════════════════════════════════════

Schedule M-1 is titled "Reconciliation of Income (Loss) per Books With Income (Loss)
per Return". It sits beside Schedule M-2 on:
  Form 1120-S — PAGE 5 of the form (footer reads "Form 1120-S (20xx)  … Page 5")
  Form 1065   — PAGE 6 of the form (Schedule M-1 / M-2 / Analysis of Net Income)
  Form 1120   — page 5/6 of the form

⚠️⚠️ "PAGE 5 OF THE FORM" IS NOT "THE LAST PAGE OF THE PDF". A filed return package
   routinely runs 100–200 pages: cover letters and tax summaries FIRST, then the
   federal form, then Schedule K-1 for every owner, supporting statements,
   depreciation schedules, and a full set of STATE returns — each with its own
   Schedule M-1. Do NOT jump to the end of the PDF, and do NOT read a state
   Schedule M-1 (California Form 100S, DC Schedule H-1, etc.) in place of the
   FEDERAL one. Locate the page whose header reads "Form 1120-S (20xx)" (or
   "Form 1065") and whose footer says Page 5, and read Schedule M-1 from THAT page.
   State figures legitimately differ from federal — using one for the other is wrong
   even though both look plausible.

⚠️ Some returns OMIT Schedule M-1 entirely (a small filer meeting the Schedule B
   total-receipts-and-assets test is not required to complete it). If the schedule
   is genuinely absent, return "scheduleM1": null. DO NOT synthesize it, and DO NOT
   copy figures from Schedule M-2 (the Accumulated Adjustments Account) into it —
   M-2 holds running EQUITY BALANCES, not a book-to-tax reconciliation.

Read these into the "scheduleM1" object. Every amount is read from the printed
figure; a blank line is 0 and is omitted from "lines".

  Line 1  — "Net income (loss) per books"        → "netIncomePerBooks"
            ⚠️ THIS IS THE MOST IMPORTANT FIGURE ON THE SCHEDULE. It states what the
               preparer believed the company's BOOKS reported. Read it exactly as
               printed, including a negative (loss) value. If line 1 is blank or the
               schedule is absent, set "netIncomePerBooks" to null — NOT to 0, and
               never to the Ordinary business income figure from page 1.

  The final reconciled total (the line that equals Schedule K's income/loss
  reconciliation):
    Form 1120-S — line 8  "Income (loss) (Schedule K, line 18)"
    Form 1065   — line 9  "Income (loss) (Analysis of Net Income (Loss), line 1)"
    Form 1120   — line 10 "Income (loss) before NOL and special deductions"
                                                  → "reconciledIncome"
            Set to null when not printed. Do NOT compute it yourself.

  DETAIL LINES → "lines": an array of { "label": string, "amount": integer }.
  Use these EXACT labels. Include a line ONLY when a non-zero amount is printed:

    Form 1120-S / Form 1065 (line numbers for 1120-S; 1065 differs by one):
      Income on Schedule K not recorded on books  → "Income on Schedule K Not on Books"
      Expenses on books not on Schedule K:
        Depreciation                             → "Book Depreciation Not on Schedule K"
        Travel and entertainment                 → "Travel and Entertainment"
        Nondeductible expenses                   → "Nondeductible Expenses"
        (any other itemised sub-line)            → use the label exactly as printed
      Tax-exempt interest                        → "Tax-Exempt Interest Income"
      Deductions on Schedule K not charged against book income:
        Depreciation                             → "Tax Depreciation Not on Books"
        Section 179 deduction                    → "Section 179 Deduction"
        Charitable contributions                 → "Charitable Contributions"
        (any other itemised sub-line)            → use the label exactly as printed

    Form 1120:
      Federal income tax per books               → "Federal Income Tax per Books"
      Excess of capital losses over capital gains→ "Excess Capital Losses"
      Income subject to tax not recorded on books→ "Income Not on Books"
      Expenses on books not deducted on return:
        Depreciation                             → "Book Depreciation Not on Return"
        Charitable contributions                 → "Charitable Contributions"
        Travel and entertainment                 → "Travel and Entertainment"
      Tax-exempt interest                        → "Tax-Exempt Interest Income"
      Deductions on the return not charged against book income:
        Depreciation                             → "Tax Depreciation Not on Books"
        Charitable contributions                 → "Charitable Contributions"

  ⚠️ "SEE STATEMENT n" SUB-LINES. An itemised M-1 sub-line is often printed as a
     statement reference with its amount beside it, e.g.
         b Travel and entertainment  $        50.
           SEE STATEMENT 7                   862.        912.
     Do NOT emit "SEE STATEMENT 7" as a label — it names nothing. Find the statement
     with that number in the PDF (a page headed "FEDERAL STATEMENTS", "STATEMENT 7,
     FORM 1120S, SCHEDULE M-1, LINE 3") and use ITS line-item description as the
     label (here: "Penalties" = 862). If the statement cannot be located, omit the
     sub-line rather than emitting a reference as a label — the section subtotal is
     already captured.

  ⚠️ A STATEMENT EXPLAINS ITS PARENT LINE; IT DOES NOT ADD TO IT. In the example
     above the sub-lines 50 + 862 = 912 and 912 is the printed section total. Emit
     the sub-lines only. Never emit both the sub-lines and the total, and never sum
     them into 1,824.

  SIGN RULE: report every "lines" amount as the POSITIVE figure printed on the
  form. Do not apply the schedule's add/subtract direction yourself — the
  application applies it from each line's own label.

═══════════════════════════════════════════════════════
COMMON RULES FOR ALL FORMS
═══════════════════════════════════════════════════════

CRITICAL — totalRevenue (the single most common extraction error — read carefully):
  totalRevenue = "Gross receipts or sales" Balance = Line 1c (Line 1a − Line 1b), far-right column.
  • It is NOT "Total income" (Line 6 on Form 1120-S and 1120; Line 8 on Form 1065). "Total income"
    ADDS net gain from Form 4797 and other income on top of gross profit, so it is LARGER than gross
    receipts. NEVER put "Total income" into totalRevenue — capture that figure in "totalIncome".
  • It is NOT Line 1a when Line 1b (returns and allowances) is non-zero — use Line 1c.
  • If Line 1b is blank, Line 1c = Line 1a.
  QUICK TEST: if your totalRevenue equals your totalIncome while "Other income" (Line 5 / Line 7) is
  non-zero, you copied the WRONG line — totalRevenue must be the SMALLER Line 1c gross-receipts value.

"year": 4-digit tax year printed at top-right of Page 1 (e.g. 2023).

SELF-CHECK (mandatory before returning):
After extracting all values, mentally verify these formulas:
  1) grossProfit  = totalRevenue - totalCostOfGoodsSold   (must match within $5)
  2) totalIncome  = grossProfit + netGain4797 + otherIncome   (must match within $5)
  3) netIncome    = totalIncome - totalDeductions   (must match within $5)
       ⚠️ Formula 3 starts at TOTAL income, NOT gross profit. The form's own bottom
          line is "total income − total deductions", and total income includes net
          gain (line 4) and other income (line 5). Measuring from gross profit makes
          other income look like an expense.
       ⚠️ Do NOT force formula 3 to balance by ADJUSTING allOtherExpenses. Every
          value in it is read from a printed line; if the formula fails, one of those
          READINGS is wrong — re-read the page and fix the misread figure.
If any formula fails, re-examine the relevant lines and correct the values.
The most common mistakes:
  - Putting Line 6 "Total income" into totalRevenue. totalRevenue is ALWAYS Line 1c "Gross receipts
    or sales" — the smaller top-line figure BEFORE net gain and other income are added. Line 6 goes
    in totalIncome. (If formula 1 fails, LOWER totalRevenue to Line 1c — do NOT raise grossProfit.)
  - Using Line 1a (gross receipts) instead of Line 1c (balance after returns) for totalRevenue
  - Reading the wrong line for netIncome: it is the "Ordinary business income (loss)" line — NOT
    "Taxable income", and NOT the "Total deductions" line printed directly above it.
  - Omitting a deduction line or double-counting it in allOtherExpenses
  - Netting other income (line 5) or net gain (line 4) into allOtherExpenses. Those are INCOME.
    allOtherExpenses is the "Other deductions" line only; the application derives any residual
    itself from totalDeductions.

OUTPUT RULES:
- Return ONLY a raw JSON object. No markdown, no backticks, no explanation.
- All dollar amounts: plain integers (no commas, decimals, or $ signs).
- Negative amounts: negative integer (e.g. -5000).
- reconcilingItems: array of { "label": string, "value": integer }. Empty [] if none.
- Only include reconcilingItems entries where value is non-zero.
- scheduleM1: an object, or null when the return does not include Schedule M-1.
  netIncomePerBooks / reconciledIncome are null when not printed — never 0 as a stand-in.

JSON schema:
{
  "formType": "1120-S",
  "year": 0,
  "totalRevenue": 0,
  "totalCostOfGoodsSold": 0,
  "grossProfit": 0,
  "netGain4797": 0,
  "otherIncome": 0,
  "totalIncome": 0,
  "officerWages": 0,
  "depreciation": 0,
  "amortization": 0,
  "interestExpense": 0,
  "allOtherExpenses": 0,
  "totalDeductions": 0,
  "netIncome": 0,
  "reconcilingItems": [],
  "scheduleM1": {
    "netIncomePerBooks": null,
    "reconciledIncome": null,
    "lines": []
  }
}
`.trim();

// ── Schedule K reconciling-item label canonicalization ──────────────────────
// The extraction + Schedule-K verification passes emit the SAME line under
// slightly different wording/casing across years ("Nondeductible expenses" vs
// "Nondeductible Expenses", "Investment income" vs "Investment Income"), which
// produced DUPLICATE rows and inconsistent columns in Tax Reconciliation. Every
// variant is mapped to one canonical label. Lines that are NOT book-to-tax
// reconciling items are dropped — notably Line 18 "Income (loss) reconciliation"
// (1120-S) / the analysis line, which merely restates Ordinary business income
// (already shown as Net Income) and must never appear as a reconciling item.
const _normKey = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

// Dropped entirely (not distributive-share reconciling items).
const SCHEDULE_K_DROP = [
  /income .*reconciliation/,   // Line 18 (1120-S) "Income (loss) reconciliation"
  /^reconciliation$/,
  /ordinary business income/,  // = netIncome, captured on page 1
];

// [regex on normalized key] → canonical label. ORDER MATTERS — more specific
// patterns first (e.g. "investment interest expense" before "interest income").
const SCHEDULE_K_CANON = [
  [/nondeductible expense/, "Nondeductible Expenses"],
  [/tax exempt interest/, "Tax-Exempt Interest Income"],
  [/other tax exempt income/, "Other Tax-Exempt Income"],
  [/repayment of loan/, "Repayment of Loans from Shareholders"],
  [/distribution/, "Distributions"],
  [/investment interest expense/, "Investment Interest Expense"],
  [/investment income/, "Investment Income"],
  [/investment expense/, "Investment Expenses"],
  [/interest income/, "Interest Income"],
  [/qualified dividend/, "Qualified Dividends"],
  [/ordinary dividend/, "Ordinary Dividends"],
  [/dividend/, "Ordinary Dividends"],
  [/royalt/, "Royalties"],
  [/section 179/, "Section 179 Deduction"],
  [/charitable/, "Charitable Contributions"],
  [/net rental real estate/, "Net Rental Real Estate Income"],
  [/net rental/, "Other Net Rental Income"],
  [/short term capital gain/, "Net Short-Term Capital Gain (Loss)"],
  [/long term capital gain/, "Net Long-Term Capital Gain (Loss)"],
  [/section 1231/, "Net Section 1231 Gain (Loss)"],
  [/foreign tax/, "Foreign Taxes Paid or Accrued"],
  [/self employ/, "Net Earnings from Self-Employment"],
  [/guaranteed payment/, "Guaranteed Payments"],
  [/other income/, "Other Income (Loss)"],
];

// Map an arbitrary Schedule K label to its canonical form; returns null to DROP.
function canonicalizeReconLabel(label) {
  const key = _normKey(label);
  if (!key) return null;
  if (SCHEDULE_K_DROP.some((rx) => rx.test(key))) return null;
  for (const [rx, canon] of SCHEDULE_K_CANON) if (rx.test(key)) return canon;
  // Unknown line — kept, never dropped, but Title Cased so a CASING variant of the
  // same unrecognized line ("Other credits" from one pass, "Other Credits" from
  // another) collapses onto one row instead of rendering twice. This is the
  // duplicate-category problem the client reported; a label whose canonical form
  // differs only by case is the same Schedule K line.
  return String(label).trim().replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
}

// Canonicalize + de-duplicate the reconciling items inside a tax "data" array.
// Main line items (isReconcilingItem false) pass through untouched and in order.
// Idempotent — safe to run on freshly-built OR already-cached data.
function canonicalizeReconcilingData(data) {
  if (!Array.isArray(data)) return data;
  const out = [];
  const idxByLabel = new Map();
  // Which RAW source labels have already contributed to each canonical label.
  // This is what separates the two situations that both look like a duplicate:
  //
  //  (a) THE SAME LINE RE-EMITTED — the extraction pass and the Schedule-K
  //      verification pass both report line 16c, one as "Nondeductible expenses"
  //      and the other as "Nondeductible Expenses". Identical normalized raw key
  //      → keep the larger magnitude. Summing would DOUBLE the line.
  //
  //  (b) TWO GENUINELY DIFFERENT LINES that share a category — Form 1065 line 13a
  //      "Charitable Contributions Cash" and 13b "Charitable Contributions
  //      Noncash" both canonicalize to "Charitable Contributions". Different raw
  //      keys → SUM them.
  //
  // CONFIRMED BUG (fixed here): this used to apply (a)'s keep-the-larger rule to
  // BOTH cases, so in case (b) the smaller of the two real amounts was silently
  // discarded. That is a direct contributor to the client's "numbers do not
  // foot" report — a reconciling item short by the whole of its noncash half,
  // with nothing on screen to indicate anything had been dropped.
  const rawKeysByLabel = new Map();
  for (const row of data) {
    if (!row || !row.isReconcilingItem) { out.push(row); continue; }
    const canon = canonicalizeReconLabel(row.label);
    if (!canon) continue; // dropped (e.g. Line 18 reconciliation)
    const rowIsRead = row.taxReturn !== null && row.taxReturn !== undefined
      && row.source?.reported !== false;
    const val = Number(row.taxReturn || 0);
    const rawKey = _normKey(row.label);

    if (idxByLabel.has(canon)) {
      const idx = idxByLabel.get(canon);
      const seenRaw = rawKeysByLabel.get(canon);
      const heldIsRead = out[idx].taxReturn !== null && out[idx].taxReturn !== undefined;
      // An UNREAD row (taxReturn null, source.reported false — see
      // buildTaxReturnResponseData) is not a value: it can neither win a
      // magnitude comparison nor be added to. Merging it as 0 would reinstate the
      // "blank published as a printed zero" defect one layer up.
      if (!rowIsRead) {
        if (!seenRaw.has(rawKey)) {
          seenRaw.add(rawKey);
          out[idx].sourceLabels = [...(out[idx].sourceLabels || []), row.label];
        }
      } else if (!heldIsRead) {
        // The category was only an unread line so far; adopt the real reading.
        out[idx].taxReturn = val;
        out[idx].source = { ...(out[idx].source || {}), reported: true };
        if (!seenRaw.has(rawKey)) {
          seenRaw.add(rawKey);
          out[idx].sourceLabels = [...(out[idx].sourceLabels || []), row.label];
        }
      } else if (seenRaw.has(rawKey)) {
        // (a) same line re-emitted — keep the larger magnitude, never add.
        if (Math.abs(val) > Math.abs(Number(out[idx].taxReturn || 0))) out[idx].taxReturn = val;
      } else {
        // (b) a different source line in the same category — add it.
        seenRaw.add(rawKey);
        out[idx].taxReturn = Number(out[idx].taxReturn || 0) + val;
        out[idx].sourceLabels = [...(out[idx].sourceLabels || []), row.label];
      }
    } else {
      idxByLabel.set(canon, out.length);
      rawKeysByLabel.set(canon, new Set([rawKey]));
      out.push({ ...row, label: canon, sourceLabels: [row.label] });
    }
  }
  return out;
}

/**
 * The page-1 income base that a deduction residual must be measured against.
 *
 * ── WHY THIS EXISTS (a real, traced defect) ─────────────────────────────────
 * The residual used to be measured from GROSS PROFIT alone. On Form 1120-S the
 * bottom line is
 *     Ordinary business income = TOTAL income (line 6) − total deductions (line 21)
 * and line 6 = gross profit (line 3) + net gain (line 4) + OTHER income (line 5).
 * Starting the residual at gross profit therefore silently pushed every dollar of
 * lines 4 and 5 into "All Other Expenses" — booking INCOME as an EXPENSE.
 *
 * Observed on a real 2023 return: page 1 reported other income of 1,613 (a state tax
 * refund, per the line-5 statement). The residual came out 8,907,339 while the
 * return's own deduction lines sum to 8,908,952 (salaries 4,547,088 + taxes 393,034
 * + benefits 410,456 + other deductions 3,558,374). The 1,613 gap was exactly the
 * refund, reported as an expense, and nothing on screen said so.
 */
function taxIncomeBase(tax) {
  const grossProfit = Number(tax.grossProfit || 0);
  const netGain4797 = Number(tax.netGain4797 || 0);
  const otherIncome = Number(tax.otherIncome || 0);
  const totalIncome = Number(tax.totalIncome || 0);
  const built = grossProfit + netGain4797 + otherIncome;

  // Prefer the PRINTED total-income line when it agrees with its components: that is
  // the figure the form itself foots to. Fall back to the component sum when the
  // total was not captured (older payloads; reconstructed cache rows).
  if (totalIncome !== 0 && Math.abs(totalIncome - built) <= TAX_VALIDATE_TOLERANCE) {
    return totalIncome;
  }
  return built || totalIncome;
}

/**
 * The deductions NOT already shown on their own row: total deductions less officer
 * compensation, depreciation, amortization and interest.
 *
 * ── WHY THIS IS ANCHORED ON THE PRINTED "TOTAL DEDUCTIONS" LINE ─────────────
 * Page 1 itemises ~14 deduction lines; the app shows 4 of them. Something has to
 * carry the rest (on the return above: salaries 4,547,088 + taxes 393,034 + benefits
 * 410,456 + other deductions 3,558,374 = 8,908,952).
 *
 * There were two contradictory contracts for that figure. The prompt pointed
 * `allOtherExpenses` at the single "Other deductions" line, while the validator's
 * identity treated it as the whole remainder — so exactly one of them was always
 * being lied to. Deriving from the PRINTED total deductions line settles it: every
 * input is a figure read off the form, the arithmetic is ours, and a mis-scoped
 * `allOtherExpenses` reading can no longer corrupt what the page shows.
 *
 * Falls back to the income-base residual for payloads extracted before
 * `totalDeductions` was requested.
 */
function taxOtherDeductions(tax) {
  const named =
    Number(tax.officerWages || 0) +
    Number(tax.depreciation || 0) +
    Number(tax.amortization || 0) +
    Number(tax.interestExpense || 0);

  const totalDeductions = Number(tax.totalDeductions || 0);
  if (totalDeductions !== 0) return totalDeductions - named;

  // Legacy path: no printed total captured. Back it out of the bottom line instead.
  return taxIncomeBase(tax) - named - Number(tax.netIncome || 0);
}

/**
 * Which printed line of the FEDERAL return each page-1 row publishes.
 *
 * ── WHY AN EXPLICIT TABLE ───────────────────────────────────────────────────
 * The Tax Return column is a claim about a specific line of a specific federal
 * form. Two failures are only avoidable if that claim is written down:
 *
 *  1. Silent re-labelling. "Total Revenue" used to publish `totalRevenue`, which
 *     the extractor defines as Line 1c GROSS RECEIPTS. On a return with other
 *     income those differ: 1c = 9,020,165 but Line 6 total income = 9,021,778.
 *     The row said "Total Revenue" and showed gross receipts, and nothing on
 *     screen distinguished the two. Line 6 was extracted correctly all along
 *     (`totalIncome`) — the row was simply reading the wrong field.
 *  2. Passing arithmetic off as a reading. "All Other Expenses" is not a line on
 *     any 1120-S; it is total deductions minus the four deductions shown on their
 *     own rows. It is legitimate to display, but it must be labelled DERIVED so a
 *     reviewer never goes looking for it on the form.
 *
 * `type: "direct"`   — the value is the figure printed on `form`/`line`.
 * `type: "derived"`  — computed here from printed figures; `from` lists them.
 * `reported: false`  — the extraction carried no value for this row, so the 0 is
 *                      the display convention for "not reported", NOT a figure
 *                      read off the return. Kept numeric because the
 *                      reconciliation engine and the variance column are
 *                      arithmetic; the distinction lives in the metadata.
 *
 * Federal only. Never populate these from a state return (this package carries
 * AZ 120S, CA 100S, DC D-20, IL-1120-ST, MN M8, OH IT 1140/4708 and TX 05-169,
 * several of which restate the same captions with different numbers — CA reports
 * -391,960 and DC -391,100 where the federal bottom line is -391,087).
 */
function taxPage1Rows(tax) {
  const isPartnership = String(tax.formType || "").includes("1065");
  const is1120 = /^1120$/.test(String(tax.formType || "").trim());

  // Line numbers differ per form. Captions do not.
  const L = isPartnership
    ? { form: "Form 1065", cogs: "2", gp: "3", comp: "10", dep: "16a", amort: "21", int: "15", ti: "8", td: "22", obi: "23" }
    : is1120
      ? { form: "Form 1120", cogs: "2", gp: "3", comp: "12", dep: "20", amort: "20", int: "18", ti: "11", td: "27", obi: "28" }
      : { form: "Form 1120-S", cogs: "2", gp: "3", comp: "7", dep: "14", amort: "20", int: "13", ti: "6", td: "21", obi: "22" };

  const officerWagesLabel = isPartnership ? "Guaranteed Payments" : "Officer Wages";

  // Form 1065 without a captured printed total: allOtherExpenses is "Other
  // deductions" verbatim, which already excludes guaranteed payments and interest.
  // Every other case derives the remainder — see taxOtherDeductions.
  const legacyPartnershipOther = isPartnership && !Number(tax.totalDeductions || 0);

  const has = (v) => v !== null && v !== undefined && v !== "";

  return [
    // Line 6 TOTAL income, not Line 1c gross receipts. See the header above.
    { label: "Total Revenue", value: taxIncomeBase(tax),
      form: L.form, line: L.ti, caption: "Total income (loss)",
      type: "direct", reported: has(tax.totalIncome) },
    { label: "Total Cost of Goods Sold", value: tax.totalCostOfGoodsSold,
      form: L.form, line: L.cogs, caption: "Cost of goods sold",
      type: "direct", reported: has(tax.totalCostOfGoodsSold) },
    { label: "Gross Profit", value: tax.grossProfit,
      form: L.form, line: L.gp, caption: "Gross profit",
      type: "direct", reported: has(tax.grossProfit) },
    { label: officerWagesLabel, value: tax.officerWages,
      form: L.form, line: L.comp,
      caption: isPartnership ? "Guaranteed payments to partners" : "Compensation of officers",
      type: "direct", reported: has(tax.officerWages) },
    { label: "Depreciation Expense", value: tax.depreciation,
      form: L.form, line: L.dep, caption: "Depreciation",
      type: "direct", reported: has(tax.depreciation) },
    { label: "Amortization Expense", value: tax.amortization,
      form: L.form, line: L.amort, caption: "Amortization (from the Other deductions statement)",
      type: "direct", reported: has(tax.amortization) },
    { label: "Total Interest Expense", value: tax.interestExpense,
      form: L.form, line: L.int, caption: "Interest",
      type: "direct", reported: has(tax.interestExpense) },
    // NOT a printed line — see the header above.
    { label: "All Other Expenses",
      value: legacyPartnershipOther ? Number(tax.allOtherExpenses || 0) : taxOtherDeductions(tax),
      form: L.form, line: legacyPartnershipOther ? "21" : L.td,
      caption: legacyPartnershipOther
        ? "Other deductions"
        : "Total deductions less the deductions shown on their own rows",
      type: legacyPartnershipOther ? "direct" : "derived",
      from: legacyPartnershipOther ? undefined
        : ["totalDeductions", "officerWages", "depreciation", "amortization", "interestExpense"],
      reported: legacyPartnershipOther ? has(tax.allOtherExpenses) : has(tax.totalDeductions) },
    // Page-1 income that is NOT gross receipts: net gain on asset sales plus other
    // income. Its own row so it can be compared against the P&L's "All Other
    // Income" instead of disappearing into the expense residual.
    { label: "All Other Income",
      value: Number(tax.netGain4797 || 0) + Number(tax.otherIncome || 0),
      form: L.form, line: isPartnership ? "7" : is1120 ? "9 + 10" : "4 + 5",
      caption: "Net gain (Form 4797) plus Other income",
      type: "derived", from: ["netGain4797", "otherIncome"],
      reported: has(tax.netGain4797) || has(tax.otherIncome) },
    // Ordinary business income (loss). NOT Schedule M-1 line 1 net income per
    // books — those are different figures (-391,087 vs -391,999 on the return
    // above) and merging them destroys the whole point of the M-1 reconciliation.
    { label: "Net Income", value: tax.netIncome,
      form: L.form, line: L.obi, caption: "Ordinary business income (loss)",
      type: "direct", reported: has(tax.netIncome) },
  ];
}

function buildTaxReturnResponseData(tax) {
  const data = taxPage1Rows(tax).map((row) => ({
    label: row.label,
    taxReturn: Number(row.value || 0),
    isReconcilingItem: false,
    source: {
      document: "federal",
      form: row.form,
      line: row.line,
      caption: row.caption,
      type: row.type,
      ...(row.from ? { from: row.from } : {}),
      reported: row.reported !== false,
    },
  }));

  // Schedule K items (nondeductible expenses 16c, distributions 16d, …). These are
  // read off the FEDERAL Schedule K / M-2, never off a state K-1 — the Illinois
  // K-1-P and Minnesota KS restate per-shareholder shares of the same captions.
  //
  // ── A LINE THE EXTRACTION DID NOT READ IS NOT A ZERO ────────────────────────
  // This used to publish `Number(item.value || 0)` behind an `item.value !== 0`
  // filter, so a printed 0 was dropped as noise but a NULL (line present in the
  // model's output, no value read) sailed through as a hard 0 — published with
  // `reported: true`, i.e. as a figure claimed to be printed on the form.
  //
  // Traced on a real 2023 1120-S: Schedule K line 16c prints 912 and line 1 prints
  // −391,087; both arrived null and were published as 0. Tax Reconciliation showed
  // "Nondeductible Expenses 0" under Tax Return while the same 912 was visible two
  // sections higher from Schedule M-1 — a self-contradicting report, and one no
  // consumer could detect, because a 0 that means "unread" is indistinguishable
  // from a 0 the preparer asserted.
  //
  // So an unread line is published with `taxReturn: null, reported: false` and
  // renders as "Not Reported". It is kept rather than dropped precisely so the
  // reviewer sees the line the return has and can see it was not read.
  (Array.isArray(tax.reconcilingItems) ? tax.reconcilingItems : []).forEach((item) => {
    if (!item?.label) return;
    const raw = item.value;
    const unread = raw === null || raw === undefined || raw === "";
    const value = unread ? null : Number(raw);
    // A printed 0 carries no adjustment and no information a reviewer can act on,
    // so it stays out of the table — unchanged, long-standing behaviour.
    if (!unread && (!Number.isFinite(value) || value === 0)) return;
    data.push({
      label: item.label,
      taxReturn: value,
      isReconcilingItem: true,
      source: {
        document: "federal",
        form: "Schedule K",
        caption: item.label,
        type: "direct",
        reported: !unread,
      },
    });
  });

  // Canonicalize + de-dup Schedule K reconciling items and drop non-items (Line 18).
  return canonicalizeReconcilingData(data);
}

/**
 * Normalise the AI's `scheduleM1` object into the exact shape the Tax
 * Reconciliation engine consumes (src/lib/taxReconciliation.js —
 * resolveTaxReturnForYear / buildM1Adjustments).
 *
 * `netIncomePerBooks` and `reconciledIncome` are deliberately kept NULLABLE and
 * are NOT coerced to 0. A missing Schedule M-1 line 1 and a genuine book income
 * of zero are completely different facts: the first means the reconciliation has
 * no anchor and must be reported as unavailable, the second is a real figure.
 * Coercing the first to 0 would make the page display a fabricated
 * "Reported M1 Book Net Income" of zero and an unreconciled difference equal to
 * the entire book income — exactly the kind of masked error Part 20 forbids.
 */
function normalizeScheduleM1(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const nullableNum = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const lines = (Array.isArray(raw.lines) ? raw.lines : [])
    .map((l) => ({ label: String(l?.label || '').trim(), amount: Number(l?.amount) || 0 }))
    .filter((l) => l.label && l.amount !== 0);
  const netIncomePerBooks = nullableNum(raw.netIncomePerBooks);
  const reconciledIncome = nullableNum(raw.reconciledIncome);
  // A schedule with nothing readable on it is the same as no schedule at all.
  if (netIncomePerBooks === null && reconciledIncome === null && !lines.length) return null;
  return { netIncomePerBooks, reconciledIncome, lines };
}

function clearTaxExtractCache(cacheKey) {
  if (cacheKey) _taxExtractCache.delete(cacheKey);
  else _taxExtractCache.clear();
}

// ─── Tax returns are a GEMINI-ONLY document type ─────────────────────────────
//
// A tax return must be read by Gemini, directly from the original file bytes, and
// by nothing else. It is not a tabular statement: the figures live at named form
// lines (1120-S line 21, Schedule K line 16c, Schedule M-1 line 1), which is what
// TAX_EXTRACTION_PROMPT is built around. Every other reader in this file is a
// TABLE reader, so pointing one at a return does not produce slightly worse
// data — it produces confidently wrong data:
//
//   • parsePdfWithGemini() is the generic balance-sheet / P&L / cash-flow prompt.
//     It returns a {rows} tree and has no concept of a form line, so a return read
//     through it yields plausible-looking rows attached to the wrong lines. The
//     same mistake is already documented in taxReturnExtractionService.js, which
//     was moved off it for exactly this reason.
//   • extractPdfLines() (pdf-parse) and extractRowsFromWorkbook() (xlsx) are the
//     rule-based fallbacks inside parseStoredReport. They emit whatever text or
//     cells they find, and detectStatementType() cannot even return "tax_return",
//     so the output gets filed under some other statement type entirely.
//   • extract_pdf_text.py / extract_pdf_ocr.py still carry a `--type tax_return`
//     branch. Nothing in the JS calls it (verified), and nothing may start:
//     the Key Reports path is Gemini-direct (taxReturnExtractionService v2).
//
// The guards below are what keep that true. They deliberately FAIL LOUDLY rather
// than degrading to another reader, because a silently mis-read return is far
// worse than a return the user is told could not be read.

// Formats Gemini accepts as inline data AND that can carry a tax return. Scanned
// returns arrive as images at least as often as PDFs, so they are first-class
// here rather than being skipped.
const TAX_DOCUMENT_MIME_TYPES = Object.freeze({
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
});

/**
 * The Gemini mime type for a tax return file, or `null` when the format is one
 * Gemini cannot read inline (a spreadsheet, a Word document, an archive…).
 *
 * `null` is a hard stop, never a signal to try another reader — see the block
 * comment above. Callers turn it into a user-visible failure naming the file.
 */
function resolveTaxDocumentMime(fileName, contentType = "") {
  const ct = String(contentType || "").toLowerCase();
  for (const mime of Object.values(TAX_DOCUMENT_MIME_TYPES)) {
    if (ct.includes(mime)) return mime;
  }
  // A generic "application/octet-stream" tells us nothing; fall back to the
  // extension, which is what the stored file name carries.
  const ext = String(fileName || "").toLowerCase().split(".").pop();
  return TAX_DOCUMENT_MIME_TYPES[ext] || null;
}

/** Human-readable reason a tax return file cannot be sent to Gemini. */
function unreadableTaxDocumentReason(fileName) {
  const ext = String(fileName || "").toLowerCase().split(".").pop();
  return (
    `"${fileName}" is a .${ext} file. Tax returns are read directly by Gemini, which accepts ` +
    `PDF and image files (${Object.keys(TAX_DOCUMENT_MIME_TYPES).map((e) => `.${e}`).join(", ")}). ` +
    `No other reader is used for tax returns, so this file was NOT read — please upload the return ` +
    `as a PDF or a scanned image.`
  );
}

/**
 * Tax extraction has no non-AI fallback, so a missing key is a hard failure with
 * a clear cause rather than an empty reconciliation nobody can explain.
 */
function assertGeminiConfiguredForTaxReturns() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Tax returns are read only by Gemini — there is no " +
      "fallback reader for them — so no tax data can be extracted until the key is set.",
    );
  }
}

async function extractTaxDataFromBuffer(pdfBuffer, cacheKey, { mimeType = TAX_DOCUMENT_MIME_TYPES.pdf } = {}) {
  assertGeminiConfiguredForTaxReturns();
  if (_taxExtractCache.has(cacheKey)) return _taxExtractCache.get(cacheKey);

  const promise = (async () => {
    const pdfBase64 = pdfBuffer.toString("base64");
    let lastError = null;

    for (const modelName of TAX_GEMINI_MODELS) {
      let retries = 3;
      let delay = 5000;
      while (retries > 0) {
        try {
          console.log(`[TaxExtract] model=${modelName} key=${cacheKey} mime=${mimeType}`);
          const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
          const model = genAI.getGenerativeModel({ model: modelName });
          const result = await model.generateContent([
            { inlineData: { mimeType, data: pdfBase64 } },
            { text: TAX_EXTRACTION_PROMPT },
          ]);
          let text = result.response.text().trim();
          text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
          const parsed = JSON.parse(text);
          ["year", "totalRevenue", "totalCostOfGoodsSold", "grossProfit", "netGain4797",
            "otherIncome", "totalIncome", "officerWages",
            "depreciation", "amortization", "interestExpense", "allOtherExpenses",
            "totalDeductions", "netIncome"]
            .forEach((f) => { parsed[f] = Number(parsed[f]) || 0; });
          if (!parsed.formType) parsed.formType = "1120-S";
          if (!Array.isArray(parsed.reconcilingItems)) parsed.reconcilingItems = [];
          parsed.reconcilingItems = parsed.reconcilingItems
            .map((i) => ({ label: String(i.label || "").trim(), value: Number(i.value) || 0 }))
            .filter((i) => i.label && i.value !== 0);
          parsed.scheduleM1 = normalizeScheduleM1(parsed.scheduleM1);
          console.log(
            `[TaxExtract] formType=${parsed.formType} year=${parsed.year} via ${modelName} ` +
            `scheduleM1=${parsed.scheduleM1 ? `booksNI=${parsed.scheduleM1.netIncomePerBooks} lines=${parsed.scheduleM1.lines.length}` : "absent"}`,
          );
          return parsed;
        } catch (err) {
          lastError = err;
          const msg = String(err.message || err);
          console.warn(`[TaxExtract] model=${modelName} key=${cacheKey} FAILED: ${msg.slice(0, 300)}`);
          if (msg.includes("404") || msg.toLowerCase().includes("not found")) break;
          if ((msg.includes("429") || msg.toLowerCase().includes("quota")) && retries > 1) {
            await _taxExtractSleep(delay);
            delay *= 2;
            retries--;
          } else {
            break;
          }
        }
      }
    }
    const lastMsg = String(lastError?.message || "");
    if (lastMsg.includes("429") || lastMsg.toLowerCase().includes("quota")) {
      throw new Error("Gemini API quota exceeded — enable billing at ai.google.dev or wait for daily reset");
    }
    throw new Error(`Gemini extraction failed: ${lastMsg || "unknown error"}`);
  })();

  promise.catch(() => _taxExtractCache.delete(cacheKey));
  _taxExtractCache.set(cacheKey, promise);
  return promise;
}

// ─── Tax return mathematical validation ──────────────────────────────────────
const TAX_VALIDATE_TOLERANCE = 5; // $5 tolerance for integer rounding

function validateTaxExtraction(extracted) {
  const issues = [];
  const rev      = Number(extracted.totalRevenue         || 0);
  const cogs     = Number(extracted.totalCostOfGoodsSold || 0);
  const gp       = Number(extracted.grossProfit          || 0);
  const wages    = Number(extracted.officerWages         || 0);
  const dep      = Number(extracted.depreciation         || 0);
  const amor     = Number(extracted.amortization         || 0);
  const interest = Number(extracted.interestExpense      || 0);
  const other    = Number(extracted.allOtherExpenses     || 0);
  const netInc   = Number(extracted.netIncome            || 0);
  const otherInc = Number(extracted.otherIncome          || 0);
  const totalInc = Number(extracted.totalIncome          || 0);
  const year     = Number(extracted.year                 || 0);

  if (year < 2010 || year > 2030) {
    issues.push(`Tax year out of expected range: ${year}`);
  }

  // Gross receipts is checkable only when it was actually captured. It is absent on
  // the reconstruction path (the published rows carry TOTAL income, not gross
  // receipts — see taxPage1Rows), and an absent figure must not be treated as a
  // reported zero: doing so produced a "Gross Profit mismatch" against a number the
  // validator had invented, and pushed a correctly-read return to Needs Review.
  const grossReceiptsKnown =
    extracted.totalRevenue !== null && extracted.totalRevenue !== undefined;

  if (grossReceiptsKnown) {
    if (rev <= 0) {
      issues.push(`Total Revenue is zero or negative: ${rev}`);
    }
    // Formula 1: grossProfit = grossReceipts (Line 1c) - totalCostOfGoodsSold
    const expectedGP = rev - cogs;
    if (Math.abs(gp - expectedGP) > TAX_VALIDATE_TOLERANCE) {
      issues.push(
        `Gross Profit mismatch: extracted ${gp}, expected ${expectedGP} (revenue ${rev} - COGS ${cogs})`
      );
    }
  } else if (gp <= 0 && totalInc <= 0) {
    issues.push(`No income figure available: gross profit ${gp}, total income ${totalInc}`);
  }

  // Formula 2: netIncome = TOTAL income - all deductions
  //
  // ⚠️ This identity starts at TOTAL income (line 6 / line 8 / line 11), NOT gross
  // profit. It previously started at gross profit, which made the check WRONG in the
  // most damaging possible way: the only value of allOtherExpenses that could satisfy
  // it was one with net gain (line 4) and other income (line 5) already subtracted —
  // i.e. income misreported as expense. A correctly-read return then FAILED this
  // check and was sent to the corrective second pass, which "fixed" the right answer
  // into the wrong one. Proven on a real 2023 return whose 1,613 state tax refund was
  // the entire discrepancy. Keep the base as total income; see taxIncomeBase.
  const incomeBase = taxIncomeBase(extracted);
  const totalDed = Number(extracted.totalDeductions || 0);

  if (totalDed !== 0) {
    // Preferred: both sides are printed totals, so this checks two readings against
    // the bottom line without depending on how allOtherExpenses was scoped.
    const expectedNet = incomeBase - totalDed;
    if (Math.abs(netInc - expectedNet) > TAX_VALIDATE_TOLERANCE) {
      issues.push(
        `Net Income mismatch: extracted ${netInc}, expected ${expectedNet} ` +
        `(total income ${incomeBase} - total deductions ${totalDed})`
      );
    }
    // The separately-reported lines are a SUBSET of total deductions. If they exceed
    // it, one of them was misread — commonly "Total deductions" landing in a component
    // field, or a component picked up from the wrong column.
    const named = wages + dep + amor + interest;
    if (named - totalDed > TAX_VALIDATE_TOLERANCE) {
      issues.push(
        `Deduction components (${named}) exceed total deductions (${totalDed}): ` +
        `wages ${wages}, dep ${dep}, amor ${amor}, interest ${interest}`
      );
    }
  } else {
    // Legacy: no printed total captured, so allOtherExpenses must carry the remainder.
    const expectedNet = incomeBase - wages - dep - amor - interest - other;
    if (Math.abs(netInc - expectedNet) > TAX_VALIDATE_TOLERANCE) {
      issues.push(
        `Net Income mismatch: extracted ${netInc}, expected ${expectedNet} ` +
        `(total income ${incomeBase} - wages ${wages} - dep ${dep} - amor ${amor} ` +
        `- interest ${interest} - other ${other})`
      );
    }
  }

  // Guard the #1 extraction error: totalRevenue must be gross receipts (Line 1c),
  // never "Total income" (Line 6 on 1120-S/1120, Line 8 on 1065 — which adds net
  // gain + other income). When revenue equals total income while other income is
  // non-zero, Line 6/8 was copied into totalRevenue. Flagging it forces the
  // targeted second pass to re-read Line 1c.
  if (
    otherInc !== 0 &&
    totalInc !== 0 &&
    Math.abs(rev - totalInc) <= TAX_VALIDATE_TOLERANCE &&
    Math.abs(rev - (gp + cogs)) > TAX_VALIDATE_TOLERANCE
  ) {
    issues.push(
      `totalRevenue (${rev}) looks like "Total income" (Line 6/8), not gross receipts (Line 1c). ` +
      `Gross receipts should equal grossProfit + COGS = ${gp + cogs}; other income ${otherInc} must be excluded.`
    );
  }

  return { status: issues.length === 0 ? "Verified" : "Needs Review", issues };
}

// Build a targeted re-extraction prompt that tells the AI exactly what failed
function buildTaxVerificationPrompt(extracted, issues) {
  return `You are DataHub's Tax Return Verification Engine.

A prior extraction of this tax return PDF produced values that FAILED mathematical verification.
Re-read the PDF carefully and return CORRECTED values.

PREVIOUSLY EXTRACTED (INCORRECT) VALUES:
  formType:             ${extracted.formType}
  year:                 ${extracted.year}
  totalRevenue:         ${extracted.totalRevenue}
  totalCostOfGoodsSold: ${extracted.totalCostOfGoodsSold}
  grossProfit:          ${extracted.grossProfit}
  netGain4797:          ${extracted.netGain4797}
  otherIncome:          ${extracted.otherIncome}
  totalIncome:          ${extracted.totalIncome}
  officerWages:         ${extracted.officerWages}
  depreciation:         ${extracted.depreciation}
  amortization:         ${extracted.amortization}
  interestExpense:      ${extracted.interestExpense}
  allOtherExpenses:     ${extracted.allOtherExpenses}
  totalDeductions:      ${extracted.totalDeductions}
  netIncome:            ${extracted.netIncome}

FAILED CHECKS:
${issues.map((i) => `  • ${i}`).join("\n")}

REQUIRED FORMULAS (must hold within $5):
  grossProfit = totalRevenue - totalCostOfGoodsSold   (totalRevenue = Line 1c gross receipts ONLY)
  totalIncome = grossProfit + netGain4797 + otherIncome   (Line 6 / Line 8 / Line 11 — NOT totalRevenue)
  netIncome   = totalIncome - totalDeductions
  ⚠️ The last formula starts at TOTAL income, not gross profit: the form's bottom line is
     "total income − total deductions", and total income includes net gain and other income.
  ⚠️ NEVER satisfy a formula by adjusting allOtherExpenses. Every field is a PRINTED line; a
     failing formula means a MISREAD line. Re-read the page and correct the misread figure.
     In particular do NOT subtract other income (Line 5 / Line 7 / Line 10) from allOtherExpenses
     to make the arithmetic close — that reports income as expense.

INSTRUCTIONS:
1. Go back to the specific form lines mentioned in each failed check.
2. Re-read the printed dollar amount from the original PDF image — do NOT reuse the wrong values above.
3. Common causes of failure (check the FIRST one first — it is the most frequent):
   • totalRevenue was taken from "Total income" (Line 6 on 1120-S/1120, Line 8 on 1065) instead of
     Line 1c "Gross receipts or sales". If grossProfit ≠ totalRevenue − COGS, the fix is almost
     always to LOWER totalRevenue to the Line 1c gross-receipts figure — do NOT raise grossProfit to
     match a Line-6 revenue. grossProfit must equal Line 3 exactly as printed, and totalRevenue must
     exclude net gain (Line 4) and other income (Line 5 / Line 7).
   • Line 1a vs Line 1c confusion for totalRevenue (always use the "Balance" column, Line 1c)
   • netIncome taken from the "Total deductions" row printed directly ABOVE the bottom line. Match
     the CAPTION "Ordinary business income (loss)" — the IRS renumbered this block (2023 shifted
     1120-S Other deductions 19→20, Total deductions 20→21, Ordinary business income 21→22), so a
     remembered line number is unreliable. netIncome is the small profit/loss, never the large
     total-deductions figure. And it is NOT "Taxable income".
   • allOtherExpenses over/under-counted — it is the "Other deductions" CAPTION only, and must
     exclude officer compensation, interest, depreciation and amortization.
   • A deduction line misread (e.g. depreciation split across two sub-lines)
4. After correcting, verify the formulas hold before responding.

Return ONLY a raw JSON object in the exact same schema. No markdown, no explanation.
{
  "formType": "${extracted.formType || "1120-S"}",
  "year": 0,
  "totalRevenue": 0,
  "totalCostOfGoodsSold": 0,
  "grossProfit": 0,
  "netGain4797": 0,
  "otherIncome": 0,
  "totalIncome": 0,
  "officerWages": 0,
  "depreciation": 0,
  "amortization": 0,
  "interestExpense": 0,
  "allOtherExpenses": 0,
  "totalDeductions": 0,
  "netIncome": 0,
  "reconcilingItems": []
}`;
}

// Second-pass: if first extraction fails validation, re-run with targeted correction prompt
async function extractTaxDataWithVerification(pdfBuffer, cacheKey, { mimeType = TAX_DOCUMENT_MIME_TYPES.pdf } = {}) {
  assertGeminiConfiguredForTaxReturns();
  const extracted = await extractTaxDataFromBuffer(pdfBuffer, cacheKey, { mimeType });
  const { status, issues } = validateTaxExtraction(extracted);

  if (status === "Verified") {
    // Still run Schedule K verification to remove hallucinated items
    extracted.reconcilingItems = await verifyScheduleKItems(
      pdfBuffer, extracted.formType || "1120-S", extracted.reconcilingItems || [], { mimeType }
    );
    _taxExtractCache.set(cacheKey, Promise.resolve(extracted));
    return { extracted, status: "Verified" };
  }

  // First pass failed — attempt a targeted second pass with a correction prompt
  console.log(`[TaxVerify] key=${cacheKey} first pass FAILED: ${issues.join("; ")} — retrying with verification prompt`);
  const pdfBase64 = pdfBuffer.toString("base64");
  const verificationPrompt = buildTaxVerificationPrompt(extracted, issues);

  for (const modelName of TAX_GEMINI_MODELS) {
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent([
        { inlineData: { mimeType, data: pdfBase64 } },
        { text: verificationPrompt },
      ]);
      let text = result.response.text().trim()
        .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const corrected = JSON.parse(text);

      ["year","totalRevenue","totalCostOfGoodsSold","grossProfit","netGain4797",
       "otherIncome","totalIncome","officerWages",
       "depreciation","amortization","interestExpense","allOtherExpenses",
       "totalDeductions","netIncome"]
        .forEach((f) => { corrected[f] = Number(corrected[f]) || 0; });
      if (!corrected.formType) corrected.formType = extracted.formType || "1120-S";
      if (!Array.isArray(corrected.reconcilingItems)) corrected.reconcilingItems = extracted.reconcilingItems || [];
      corrected.reconcilingItems = corrected.reconcilingItems
        .map((i) => ({ label: String(i.label || "").trim(), value: Number(i.value) || 0 }))
        .filter((i) => i.label && i.value !== 0);
      // The correction prompt only re-reads the page-1 lines it was told failed,
      // so it may omit Schedule M-1 entirely. Keep the first pass's M-1 in that
      // case rather than losing the reconciliation anchor to a page-1 retry.
      corrected.scheduleM1 = normalizeScheduleM1(corrected.scheduleM1) || extracted.scheduleM1 || null;

      const secondCheck = validateTaxExtraction(corrected);
      console.log(`[TaxVerify] key=${cacheKey} second pass status=${secondCheck.status} via ${modelName}`);

      // Schedule K verification pass — remove any hallucinated reconciling items
      corrected.reconcilingItems = await verifyScheduleKItems(
        pdfBuffer, corrected.formType, corrected.reconcilingItems, { mimeType }
      );

      _taxExtractCache.set(cacheKey, Promise.resolve(corrected));
      return { extracted: corrected, status: secondCheck.status };
    } catch (err) {
      console.warn(`[TaxVerify] second-pass model=${modelName} failed: ${err.message}`);
    }
  }

  // Second pass completely failed — still run Schedule K verification on first-pass result
  extracted.reconcilingItems = await verifyScheduleKItems(
    pdfBuffer, extracted.formType || "1120-S", extracted.reconcilingItems || [], { mimeType }
  );
  return { extracted, status: "Needs Review" };
}

// ─── Schedule K dedicated verification pass ───────────────────────────────────
// After extraction, send a targeted prompt that lists every item the AI claimed
// to see on Schedule K and asks it to confirm each value is actually printed.
// Items the AI cannot confirm get removed from reconcilingItems.
function buildScheduleKVerificationPrompt(formType, reconcilingItems) {
  const lines = reconcilingItems.map((i) => `  • ${i.label}: ${i.value}`).join("\n");
  return `You are verifying Schedule K data extracted from a US ${formType} tax return PDF.

The prior extraction produced these Schedule K reconciling items:
${lines || "  (none)"}

YOUR TASK — for EACH item above:
1. Go to the Schedule K page in the PDF (it spans TWO pages on 1120-S: lines 1–14 then
   lines 15–18). Read BOTH pages.
2. Find the exact line by its printed line CODE (e.g. "16c", "16d", "17a"), not by row
   position. Lines 15a–15f, 16a–16f and 17a–17b are stacked tightly — the amount belongs
   to the line code printed on the SAME horizontal row. Never shift a value up/down a row.
3. Look at the "Total amount" column (right side of the form) for that line code.
4. If you see a non-zero dollar amount printed there → KEEP the item with the correct value.
5. If the cell is blank, empty, dashed, or zero → REMOVE it from the list.
6. Correct the value if the amount you see differs from what was extracted.

Then scan the ENTIRE Schedule K for any additional non-zero "Total amount" lines the prior
extraction MISSED and ADD them. Pay special attention to the "Items Affecting Shareholder
Basis" and "Other Information" lines, which are the most commonly populated and the most
often mis-read: 16a Tax-Exempt Interest Income, 16b Other Tax-Exempt Income,
16c Nondeductible Expenses, 16d Distributions, 16e Repayment of Loans from Shareholders,
16f Foreign Taxes Paid or Accrued, 17a Investment Income, 17b Investment Expenses.

SOURCE RESTRICTION — read every value from the Schedule K "Total amount" column ONLY. NEVER
pull a value from Schedule M-1 or Schedule M-2. In particular, Schedule M-2's Accumulated
Adjustments Account (AAA) balance lines — "Balance at beginning of tax year", "Combine lines
1 through 5", and "Balance at end of tax year" — are NOT distributions; never report an M-2
balance as "Distributions". If Schedule K line 16d "Total amount" is blank/zero, there are NO
distributions and you MUST omit that item.

CROSS-CHECK for VALIDATION ONLY (never a source of numbers) — a correctly-read value usually
agrees with its companion line: "Nondeductible Expenses" (16c) ≈ M-1 line 3 / M-2 "Other
reductions"; "Distributions" (16d) ≈ M-2 LINE 7 "Distributions" (NOT the M-2 balance lines).
A blank Schedule K cell always wins over any M-2 figure.

CRITICAL:
- Use ONLY values visually printed on Schedule K in the "Total amount" column.
- NEVER report a Schedule M-2 AAA balance (e.g. "Balance at end of tax year") as a Schedule K
  item such as "Distributions". Schedule M-2 is a different schedule and is not a value source.
- DO NOT include Line 1 (Ordinary business income — already captured separately).
- DO NOT include the "Income (loss) reconciliation" line (Line 18 on 1120-S) — it is
  only a total that restates ordinary business income, NOT a reconciling item.
- Use standard IRS line names for labels (e.g. "Nondeductible Expenses", "Distributions",
  "Other Tax-Exempt Income", "Investment Income") with consistent Title Case.
- DO NOT guess or carry over values from other pages.

Return ONLY a raw JSON array of confirmed items (empty array [] if none):
[{"label": "Distributions", "value": 26640}, ...]
No markdown, no explanation.`;
}

async function verifyScheduleKItems(pdfBuffer, formType, reconcilingItems, { mimeType = TAX_DOCUMENT_MIME_TYPES.pdf } = {}) {
  const ft = String(formType || "").toUpperCase();
  // C-Corporations (Form 1120, NOT 1120-S) have no Schedule K — nothing to fetch.
  const isCCorp = ft.includes("1120") && !ft.includes("1120-S") && !ft.includes("1120S");
  if (isCCorp) return [];

  // Run the Schedule-K-focused pass even when the broad extraction found nothing.
  // The prompt asks the model to scan the ENTIRE Schedule K "Total amount" column
  // and ADD any non-zero lines the first pass missed — so this doubles as a
  // recovery pass when Schedule K wasn't captured on the first extraction.
  const pdfBase64 = pdfBuffer.toString("base64");
  const prompt = buildScheduleKVerificationPrompt(formType || "1120-S", reconcilingItems);

  for (const modelName of TAX_GEMINI_MODELS) {
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent([
        { inlineData: { mimeType, data: pdfBase64 } },
        { text: prompt },
      ]);
      let text = result.response.text().trim()
        .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const verified = JSON.parse(text);
      if (!Array.isArray(verified)) throw new Error("Expected array");
      const clean = verified
        .map((i) => ({ label: String(i.label || "").trim(), value: Number(i.value) || 0 }))
        .filter((i) => i.label && i.value !== 0);
      console.log(`[ScheduleKVerify] formType=${formType} — ${reconcilingItems.length} in, ${clean.length} confirmed via ${modelName}`);

      // Non-destructive guard: never let a single flaky verify pass WIPE Schedule K
      // items the first extraction confidently found. An empty verify result is
      // only trusted when there was nothing to begin with.
      if (clean.length === 0 && reconcilingItems.length > 0) {
        console.warn(`[ScheduleKVerify] verify returned 0 items but extraction had ${reconcilingItems.length} — keeping original extraction to avoid dropping Schedule K data`);
        return reconcilingItems;
      }
      return clean;
    } catch (err) {
      console.warn(`[ScheduleKVerify] model=${modelName} failed: ${err.message}`);
    }
  }
  // If every verification attempt failed, keep the original items unchanged.
  return reconcilingItems;
}

/* =========================================================
   PROFIT & LOSS EXTRACTION — Gemini vision for Tax Reconciliation
   Reads a P&L PDF and extracts the 10 line items + fiscal year.
========================================================= */

const PL_FOR_TAX_PROMPT = `
You are extracting data from a Profit & Loss (Income Statement) report.
This may be a scanned or text-based PDF — use your vision capability to read it carefully.
Do NOT guess or interpolate — only report what is visually printed.

DETECT THE FISCAL YEAR:
  Look for a date range or period header such as:
    "January 1 – December 31, 2023" → year = 2023
    "For the year ended December 31, 2022" → year = 2022
    "FY 2024" → year = 2024
  Use the ENDING year of the period (the year the fiscal year closes).
  If there is only one year mentioned anywhere in the header, use that.

EXTRACT THESE 10 VALUES (all integers, use 0 if blank/absent):
  "year"                — 4-digit fiscal year (as described above)
  "totalRevenue"        — Total Revenue / Total Income / Net Sales (top-line)
  "totalCostOfGoodsSold"— Cost of Goods Sold / COGS / Cost of Sales
  "grossProfit"         — Gross Profit (Revenue minus COGS)
  "officerWages"        — Officer Compensation / Officer Wages / S-Corp Officer Pay
                          (0 if not separately listed)
  "depreciation"        — Depreciation Expense (0 if not listed)
  "amortization"        — Amortization Expense (0 if not listed; ignore if combined with depreciation)
  "interestExpense"     — Interest Expense / Loan Interest / Bank Interest (0 if not listed)
  "allOtherExpenses"    — All Other Expenses / Other Operating Expenses / Other Deductions
                          If not explicitly labeled, compute:
                          allOtherExpenses = Total Expenses − officerWages − depreciation
                                            − amortization − interestExpense
  "allOtherIncome"      — Other Income / Non-operating Income (0 if not listed)
  "netIncome"           — Net Income / Net Profit / Net Loss (bottom line; negative = loss)

OUTPUT RULES:
- Return ONLY a raw JSON object. No markdown, no backticks, no explanation.
- All dollar amounts: plain integers (no commas, decimals, or $ signs).
- Negative amounts: negative integer (e.g. -5000).

JSON schema:
{
  "year": 0,
  "totalRevenue": 0,
  "totalCostOfGoodsSold": 0,
  "grossProfit": 0,
  "officerWages": 0,
  "depreciation": 0,
  "amortization": 0,
  "interestExpense": 0,
  "allOtherExpenses": 0,
  "allOtherIncome": 0,
  "netIncome": 0
}
`.trim();

const _plForTaxCache = new Map();

async function extractPLForTax(pdfBuffer, cacheKey) {
  if (_plForTaxCache.has(cacheKey)) return _plForTaxCache.get(cacheKey);

  const promise = (async () => {
    const pdfBase64 = pdfBuffer.toString("base64");
    let lastError = null;

    for (const modelName of TAX_GEMINI_MODELS) {
      let retries = 3;
      let delay = 5000;
      while (retries > 0) {
        try {
          console.log(`[PLForTax] model=${modelName} key=${cacheKey}`);
          const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
          const model = genAI.getGenerativeModel({ model: modelName });
          const result = await model.generateContent([
            { inlineData: { mimeType: "application/pdf", data: pdfBase64 } },
            { text: PL_FOR_TAX_PROMPT },
          ]);
          let text = result.response.text().trim();
          text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
          const parsed = JSON.parse(text);
          ["year", "totalRevenue", "totalCostOfGoodsSold", "grossProfit", "officerWages",
            "depreciation", "amortization", "interestExpense", "allOtherExpenses", "allOtherIncome", "netIncome"]
            .forEach((f) => { parsed[f] = Number(parsed[f]) || 0; });
          console.log(`[PLForTax] year=${parsed.year} via ${modelName}`);
          return parsed;
        } catch (err) {
          lastError = err;
          const msg = String(err.message || err);
          if (msg.includes("404") || msg.toLowerCase().includes("not found")) break;
          if ((msg.includes("429") || msg.toLowerCase().includes("quota")) && retries > 1) {
            await _taxExtractSleep(delay);
            delay *= 2;
            retries--;
          } else {
            break;
          }
        }
      }
    }
    const lastMsg = String(lastError?.message || "");
    if (lastMsg.includes("429") || lastMsg.toLowerCase().includes("quota")) {
      throw new Error("Gemini API quota exceeded — enable billing at ai.google.dev or wait for daily reset");
    }
    throw new Error(`Gemini extraction failed: ${lastMsg || "unknown error"}`);
  })();

  promise.catch(() => _plForTaxCache.delete(cacheKey));
  _plForTaxCache.set(cacheKey, promise);
  return promise;
}

function extractPLLineItemsFromRows(rows, year) {
  function flatten(items, result = []) {
    for (const item of (items || [])) {
      const label = String(item.name || "").trim();
      if (!label) continue;
      result.push({ label, value: typeof item.amount === "number" ? item.amount : 0, type: String(item.type || "data") });
      if (Array.isArray(item.children)) flatten(item.children, result);
    }
    return result;
  }
  const flat = flatten(rows);
  const lc = (s) => s.toLowerCase().trim();
  const find = (patterns, preferTotal = true) => {
    const matches = flat.filter((row) => patterns.some((p) => lc(row.label).includes(lc(p)) || lc(p).includes(lc(row.label))));
    if (!matches.length) return 0;
    if (preferTotal) {
      const totals = matches.filter((r) => r.type === "total");
      if (totals.length) return totals[totals.length - 1].value;
    }
    return matches[matches.length - 1].value;
  };
  const officerWages = find(["officer compensation", "officer wages", "officer salary", "officer pay"], false);
  const depreciation = find(["depreciation expense", "depreciation"], false);
  const amortization = find(["amortization expense", "amortization"], false);
  const interestExpense = find(["total interest expense", "interest expense", "loan interest"], false);
  const totalExpenses = find(["total expenses", "total operating expenses", "total expense"]);
  const allOtherExpenses = totalExpenses > 0 ? Math.max(0, totalExpenses - (officerWages + depreciation + amortization + interestExpense)) : 0;
  return {
    year,
    totalRevenue: find(["total income", "total revenue", "net revenue", "total sales"]),
    totalCostOfGoodsSold: find(["total cost of goods sold", "cost of goods sold", "cost of sales"]),
    grossProfit: find(["gross profit", "gross margin"]),
    officerWages,
    depreciation,
    amortization,
    interestExpense,
    allOtherExpenses,
    allOtherIncome: find(["total other income", "other income", "other revenue"]),
    netIncome: find(["net income", "net loss", "net earnings", "net profit"]),
  };
}

function buildPLForTaxData(pl) {
  return [
    { label: "Total Revenue", pl: Number(pl.totalRevenue || 0) },
    { label: "Total Cost of Goods Sold", pl: Number(pl.totalCostOfGoodsSold || 0) },
    { label: "Gross Profit", pl: Number(pl.grossProfit || 0) },
    { label: "Officer Wages", pl: Number(pl.officerWages || 0) },
    { label: "Depreciation Expense", pl: Number(pl.depreciation || 0) },
    { label: "Amortization Expense", pl: Number(pl.amortization || 0) },
    { label: "Total Interest Expense", pl: Number(pl.interestExpense || 0) },
    { label: "All Other Expenses", pl: Number(pl.allOtherExpenses || 0) },
    { label: "All Other Income", pl: Number(pl.allOtherIncome || 0) },
    { label: "Net Income", pl: Number(pl.netIncome || 0) },
  ];
}

async function syncTaxReturnFolder(companyId, folder, now) {
  const { data: documents } = await supabase
    .from("documents")
    .select("id, name, upload_id, file_url")
    .eq("folder_id", folder.id)
    .order("name", { ascending: true });

  if (!documents?.length) {
    return { success: false, reason: "No files in Tax Reconciliation folder", processed: [], failed: [] };
  }

  const taxYears = {};
  const processedDocs = [];
  const failedDocs = [];

  for (const doc of documents) {
    const fileName = String(doc.name || "");
    const lowerName = fileName.toLowerCase();

    let buffer = null;

    if (doc.upload_id) {
      const { data: up } = await supabase
        .from("uploads").select("data").eq("id", doc.upload_id).maybeSingle();
      if (up?.data) buffer = normalizeUploadBinary(up.data);
    }

    if (!buffer?.length && doc.file_url) {
      const m = String(doc.file_url).match(/\/uploads\/([0-9a-f-]{36})\/content/i);
      if (m) {
        const { data: up } = await supabase
          .from("uploads").select("data").eq("id", m[1]).maybeSingle();
        if (up?.data) buffer = normalizeUploadBinary(up.data);
      }
    }

    // A file that cannot be read must be REPORTED, not skipped. Both of these
    // used to `continue` with only a console line, so a linked return that never
    // reached Gemini looked identical to one that had no tax data in it — the user
    // saw a missing year with no explanation anywhere in the UI.
    if (!buffer?.length) {
      console.warn(`[TaxReturnSync] No binary for "${fileName}"`);
      failedDocs.push({
        documentId: doc.id, fileName, folderName: folder.name,
        reason: `"${fileName}" has no readable file contents — nothing was sent to Gemini.`,
      });
      continue;
    }

    const mimeType = resolveTaxDocumentMime(fileName, null);
    if (!mimeType) {
      console.log(`[TaxReturnSync] "${fileName}" is not a Gemini-readable format`);
      failedDocs.push({
        documentId: doc.id, fileName, folderName: folder.name,
        reason: unreadableTaxDocumentReason(fileName),
      });
      continue;
    }

    try {
      const cacheKey = `tax_sync_${companyId}_${doc.upload_id || lowerName}`;
      const extracted = await extractTaxDataFromBuffer(buffer, cacheKey, { mimeType });
      if (extracted?.year) {
        const year = Number(extracted.year);
        // scheduleM1 is carried alongside `data` (not inside it): it is a
        // reconciliation ANCHOR, not a label/amount row, and the Tax
        // Reconciliation engine reads it as `taxYear.scheduleM1`.
        taxYears[year] = {
          year, fileName,
          scheduleM1: extracted.scheduleM1 || null,
          data: buildTaxReturnResponseData(extracted),
        };
        processedDocs.push({ documentId: doc.id, fileName, folderName: folder.name, statementType: STATEMENT_TYPES.TAX_RETURN, taxYear: year });
        console.log(`[TaxReturnSync] Stored year=${year} from "${fileName}"`);
      } else {
        failedDocs.push({ documentId: doc.id, fileName, folderName: folder.name, reason: "Year not detected in PDF" });
      }
    } catch (err) {
      console.error(`[TaxReturnSync] Gemini failed for "${fileName}": ${err.message}`);
      failedDocs.push({ documentId: doc.id, fileName, folderName: folder.name, reason: err.message });
    }
  }

  if (!Object.keys(taxYears).length) {
    return { success: false, reason: "No tax data could be extracted from PDFs", processed: [], failed: failedDocs };
  }

  // Upsert one aggregate record per company for all tax years
  const { data: existing } = await supabase
    .from("qb_synced_reports")
    .select("id")
    .eq("company_id", companyId)
    .eq("source", MANUAL_REPORT_UPLOAD_SOURCE)
    .eq("report_type", STATEMENT_TYPES.TAX_RETURN)
    .maybeSingle();

  const payload = {
    company_id: companyId,
    report_type: STATEMENT_TYPES.TAX_RETURN,
    report_params: { sourceFolderName: SOURCE_FOLDER_NAME, folderId: folder.id, folderName: folder.name },
    data: { tax_return: { taxYears, syncedAt: now, documentCount: processedDocs.length } },
    source: MANUAL_REPORT_UPLOAD_SOURCE,
    status: "synced",
    last_synced_at: now,
    updated_at: now,
  };

  let upsertError;
  if (existing?.id) {
    ({ error: upsertError } = await supabase
      .from("qb_synced_reports").update(payload).eq("id", existing.id));
  } else {
    ({ error: upsertError } = await supabase
      .from("qb_synced_reports").insert(payload));
  }

  if (upsertError) throw new Error(`Failed to store tax return data: ${upsertError.message}`);

  console.log(`[TaxReturnSync] Saved ${Object.keys(taxYears).length} year(s) for company ${companyId}`);
  return { success: true, processed: processedDocs, failed: failedDocs };
}

async function syncPLForTaxFolder(companyId, folder, now) {
  const PL_FOR_TAX_REPORT_TYPE = "pl_for_tax";

  const { data: documents } = await supabase
    .from("documents")
    .select("id, name, upload_id, file_url")
    .eq("folder_id", folder.id)
    .order("name", { ascending: true });

  if (!documents?.length) {
    return { success: false, reason: "No files in Profit & Loss folder", processed: [], failed: [] };
  }

  const plYears = {};
  const processedDocs = [];
  const failedDocs = [];

  for (const doc of documents) {
    const fileName = String(doc.name || "");
    const lowerName = fileName.toLowerCase();

    if (!lowerName.endsWith(".pdf")) {
      console.log(`[PLForTaxSync] Skipping non-PDF "${fileName}"`);
      continue;
    }

    let buffer = null;
    if (doc.upload_id) {
      const { data: up } = await supabase.from("uploads").select("data").eq("id", doc.upload_id).maybeSingle();
      if (up?.data) buffer = normalizeUploadBinary(up.data);
    }
    if (!buffer?.length && doc.file_url) {
      const m = String(doc.file_url).match(/\/uploads\/([0-9a-f-]{36})\/content/i);
      if (m) {
        const { data: up } = await supabase.from("uploads").select("data").eq("id", m[1]).maybeSingle();
        if (up?.data) buffer = normalizeUploadBinary(up.data);
      }
    }

    if (!buffer?.length) {
      console.warn(`[PLForTaxSync] No binary for "${fileName}"`);
      continue;
    }

    try {
      const cacheKey = `pl_sync_${companyId}_${doc.upload_id || lowerName}`;
      _plForTaxCache.delete(cacheKey); // invalidate so re-sync gets fresh data
      const extracted = await extractPLForTax(buffer, cacheKey);
      if (extracted?.year) {
        const year = Number(extracted.year);
        plYears[year] = { year, fileName, data: buildPLForTaxData(extracted) };
        processedDocs.push({ documentId: doc.id, fileName, folderName: folder.name, statementType: PL_FOR_TAX_REPORT_TYPE, plYear: year });
        console.log(`[PLForTaxSync] Stored year=${year} from "${fileName}"`);
      } else {
        failedDocs.push({ documentId: doc.id, fileName, folderName: folder.name, reason: "Year not detected in PDF" });
      }
    } catch (geminiErr) {
      console.warn(`[PLForTaxSync] Gemini failed for "${fileName}", trying text fallback: ${geminiErr.message}`);
      // Text-extraction fallback for text-based PDFs (when Gemini is unavailable)
      try {
        const fakeUpload = { data: buffer, file_name: fileName, content_type: "application/pdf" };
        const parsed = await parseStoredReport(fakeUpload, STATEMENT_TYPES.PROFIT_AND_LOSS);
        if (parsed?.report?.rows?.length) {
          let year = parsed.report.asOfDate ? parseInt(String(parsed.report.asOfDate).split("-")[0], 10) : 0;
          if (!year) { const m = fileName.match(/\b(20\d{2})\b/); if (m) year = parseInt(m[1], 10); }
          if (year) {
            const pl = extractPLLineItemsFromRows(parsed.report.rows, year);
            plYears[year] = { year, fileName, data: buildPLForTaxData(pl) };
            processedDocs.push({ documentId: doc.id, fileName, folderName: folder.name, statementType: PL_FOR_TAX_REPORT_TYPE, plYear: year });
            console.log(`[PLForTaxSync] Text fallback: year=${year} from "${fileName}"`);
            continue;
          }
        }
        failedDocs.push({ documentId: doc.id, fileName, folderName: folder.name, reason: "Could not extract P&L data from PDF" });
      } catch (fbErr) {
        console.error(`[PLForTaxSync] Both Gemini and text fallback failed for "${fileName}": ${fbErr.message}`);
        failedDocs.push({ documentId: doc.id, fileName, folderName: folder.name, reason: geminiErr.message });
      }
    }
  }

  if (!Object.keys(plYears).length) {
    return { success: false, reason: "No P&L data could be extracted from PDFs", processed: [], failed: failedDocs };
  }

  const { data: existing } = await supabase.from("qb_synced_reports").select("id")
    .eq("company_id", companyId).eq("source", MANUAL_REPORT_UPLOAD_SOURCE)
    .eq("report_type", PL_FOR_TAX_REPORT_TYPE).maybeSingle();

  const payload = {
    company_id: companyId,
    report_type: PL_FOR_TAX_REPORT_TYPE,
    report_params: { sourceFolderName: SOURCE_FOLDER_NAME, folderId: folder.id, folderName: folder.name },
    data: { pl_for_tax: { plYears, syncedAt: now, documentCount: processedDocs.length } },
    source: MANUAL_REPORT_UPLOAD_SOURCE,
    status: "synced",
    last_synced_at: now,
    updated_at: now,
  };

  let upsertError;
  if (existing?.id) {
    ({ error: upsertError } = await supabase.from("qb_synced_reports").update(payload).eq("id", existing.id));
  } else {
    ({ error: upsertError } = await supabase.from("qb_synced_reports").insert(payload));
  }

  if (upsertError) throw new Error(`Failed to store P&L for tax data: ${upsertError.message}`);
  console.log(`[PLForTaxSync] Saved ${Object.keys(plYears).length} year(s) for company ${companyId}`);
  return { success: true, processed: processedDocs, failed: failedDocs };
}

function normalizeUploadBinary(data) {
  if (!data) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.from(data);
  if (typeof data === "object" && data.type === "Buffer" && Array.isArray(data.data)) {
    return Buffer.from(data.data);
  }
  if (typeof data === "string") {
    const value = data.trim();
    if (/^\\x[0-9a-f]+$/i.test(value)) return Buffer.from(value.slice(2), "hex");
    if (/^0x[0-9a-f]+$/i.test(value)) return Buffer.from(value.slice(2), "hex");
    return Buffer.from(value, "base64");
  }
  return Buffer.from(String(data));
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hasCellValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function parseAmount(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const raw = String(value).trim();
  if (!raw) return null;

  const cleaned = raw
    .replace(/[$,\s]/g, "")
    .replace(/\((.*)\)/, "-$1")
    .replace(/^[=]/, "")
    .replace(/\.{2,}/g, "");

  if (!/^[-+]?[\d.]+$/.test(cleaned)) return null;
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundMoney(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

const MONTH_INDEX = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function toIsoDate(dateStr = "") {
  if (!dateStr) return null;
  const s = String(dateStr).trim().replace(/,/g, "");

  // "March 31 2025" / "Jan 1 2025"
  const longMatch = s.match(/^([a-z]+)\s+(\d{1,2})\s+(\d{4})$/i);
  if (longMatch) {
    const month = MONTH_INDEX[longMatch[1].toLowerCase()];
    if (month !== undefined) {
      return `${longMatch[3]}-${String(month + 1).padStart(2, "0")}-${String(parseInt(longMatch[2], 10)).padStart(2, "0")}`;
    }
  }

  // "January 2023" — month + year only
  const monthYearMatch = s.match(/^([a-z]+)\s+(\d{4})$/i);
  if (monthYearMatch) {
    const month = MONTH_INDEX[monthYearMatch[1].toLowerCase()];
    if (month !== undefined) {
      return `${monthYearMatch[2]}-${String(month + 1).padStart(2, "0")}-01`;
    }
  }

  // MM/DD/YYYY or MM-DD-YYYY
  const numericMatch = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (numericMatch) {
    let year = parseInt(numericMatch[3], 10);
    if (year < 100) year += 2000;
    return `${year}-${String(parseInt(numericMatch[1], 10)).padStart(2, "0")}-${String(parseInt(numericMatch[2], 10)).padStart(2, "0")}`;
  }

  // YYYY-MM-DD
  const isoMatch = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    return `${isoMatch[1]}-${String(parseInt(isoMatch[2], 10)).padStart(2, "0")}-${String(parseInt(isoMatch[3], 10)).padStart(2, "0")}`;
  }

  return null;
}

function firstTextCell(cells = []) {
  for (const cell of cells) {
    const text = String(cell || "").trim();
    if (/[a-z]/i.test(text)) return text;
  }
  return "";
}

function findAmountInCells(cells = []) {
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    const amount = parseAmount(cells[index]);
    if (amount !== null) return roundMoney(amount);
  }
  return null;
}

const MONTH_PERIOD_RE = /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s.\-_]*(\d{2,4})?\s*$/i;
const MONTH_ABBR_MAP = { january:"Jan",february:"Feb",march:"Mar",april:"Apr",may:"May",june:"Jun",july:"Jul",august:"Aug",september:"Sep",october:"Oct",november:"Nov",december:"Dec" };
const MONTH_ABBRS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function normalizePeriodLabel(cell) {
  const s = String(cell || "").trim();
  const m = s.match(/^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s.\-_]*(\d{2,4})?\s*$/i);
  if (!m) return s;
  const full = m[1].toLowerCase();
  const abbr = MONTH_ABBR_MAP[full] || (full[0].toUpperCase() + full.slice(1, 3));
  const yr = m[2] ? (m[2].length <= 2 ? `20${m[2]}` : m[2]) : "";
  return yr ? `${abbr} ${yr}` : abbr;
}

// Convert an Excel date serial number (e.g. 45292 = Jan 1 2025) to "Jan 2025".
function excelSerialToMonthYear(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n < 40000 || n > 80000) return null;
  const ms = (n - 25569) * 86400000;
  const d = new Date(ms);
  const abbr = MONTH_ABBRS[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  if (!abbr || year < 2000 || year > 2099) return null;
  return `${abbr} ${year}`;
}

function detectPeriodColumns(rawRows) {
  for (let i = 0; i < Math.min(10, rawRows.length); i++) {
    const row = Array.isArray(rawRows[i]) ? rawRows[i] : [];
    const periods = [];
    for (let j = 0; j < row.length; j++) {
      const cell = row[j];
      const cellStr = String(cell || "").trim();
      if (MONTH_PERIOD_RE.test(cellStr)) {
        periods.push({ label: normalizePeriodLabel(cellStr), colIdx: j });
        continue;
      }
      // Excel sometimes stores month headers as numeric date serials (e.g. 45292 for Jan 2025).
      const serialLabel = excelSerialToMonthYear(cell);
      if (serialLabel) {
        periods.push({ label: serialLabel, colIdx: j });
      }
    }
    if (periods.length >= 3) {
      for (let j = 0; j < row.length; j++) {
        const cell = String(row[j] || "").trim();
        if (/^total$/i.test(cell)) {
          periods.push({ label: "Total", colIdx: j });
          break;
        }
      }
      return { headerRowIdx: i, periods };
    }
  }
  return null;
}

function extractRowsFromWorkbook(buffer, fileName = "", contentType = "") {
  let workbook;
  try {
    if (String(fileName).toLowerCase().endsWith(".csv") || String(contentType).toLowerCase().includes("csv")) {
      workbook = XLSX.read(buffer.toString("utf8"), { type: "string" });
    } else {
      workbook = XLSX.read(buffer, { type: "buffer" });
    }
  } catch (error) {
    throw new Error(`Unable to parse workbook: ${error.message}`);
  }

  if (!workbook.SheetNames.length) throw new Error("No worksheet found.");

  // For multi-sheet workbooks (e.g. "Balance Sheet + Last 13 Months" tabs), prefer
  // the sheet that has the most detected period columns so we always show the richest
  // monthly data rather than falling back to a yearly-comparison sheet.
  let bestRows = null;
  let bestPeriodCount = -1;

  for (const sName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sName];
    if (!sheet) continue;
    const sheetRows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: null,
      blankrows: false,
    }).filter((row) => Array.isArray(row) && row.some(hasCellValue));

    const info = detectPeriodColumns(sheetRows);
    const count = info ? info.periods.length : 0;
    if (count > bestPeriodCount) {
      bestPeriodCount = count;
      bestRows = sheetRows;
    }
  }

  // If no sheet had period columns, fall back to the first sheet.
  if (!bestRows) {
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw new Error("No worksheet found.");
    bestRows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: null,
      blankrows: false,
    }).filter((row) => Array.isArray(row) && row.some(hasCellValue));
  }

  return bestRows;
}

function extractPdfLines(buffer) {
  return new Promise((resolve, reject) => {
    // Copy the buffer into a fresh ArrayBuffer so it can be safely transferred
    // to the worker thread without sharing memory with the main thread pool.
    const owned = Buffer.from(buffer);
    const arrayBuffer = owned.buffer.slice(
      owned.byteOffset,
      owned.byteOffset + owned.byteLength,
    );

    const worker = new Worker(PDF_WORKER_PATH, {
      workerData: { arrayBuffer },
      transferList: [arrayBuffer],
    });

    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("PDF parsing timed out"));
    }, PDF_PARSE_TIMEOUT_MS);

    const cleanup = () => clearTimeout(timer);

    worker.once("message", (msg) => {
      cleanup();
      if (msg.success) {
        resolve(
          String(msg.text)
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean),
        );
      } else {
        reject(new Error(msg.error || "PDF parsing failed"));
      }
    });

    worker.once("error", (err) => {
      cleanup();
      reject(err);
    });

    worker.once("exit", (code) => {
      cleanup();
      if (code !== 0) reject(new Error(`PDF worker exited with code ${code}`));
    });
  });
}

function isStandaloneYear(str = "") {
  return /^\d{4}$/.test(String(str).replace(/[$,()]/g, "").trim());
}

function isPageIndicatorLine(line = "") {
  const s = String(line).trim().toLowerCase();
  return /^page\s+\d+(\s+of\s+\d+)?$/.test(s) || /^\d+$/.test(s);
}

function extractAsOfDateFromLines(lines = []) {
  // "As of [date]" — used by Balance Sheet headers
  const asOfPattern = /as\s+of\s+([a-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}[-/]\d{1,2}[-/]\d{1,2})/i;
  for (const line of lines.slice(0, 40)) {
    const match = line.match(asOfPattern);
    if (match?.[1]) {
      const date = toIsoDate(match[1].trim());
      if (date) return date;
    }
  }
  // Period range — used by P&L / Cash Flow headers (e.g. "January-December, 2022", "Oct 2021 - Sep 2022").
  // Match before the generic month pattern so the footer export date is not captured.
  const M = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const periodRange = new RegExp(`(?:${M})(?:\\s+\\d{4})?[\\s,\\-–]+(?:${M}),?\\s+(\\d{4})`, "i");
  for (const line of lines.slice(0, 20)) {
    const m = line.match(periodRange);
    if (m?.[1]) return `${m[1]}-12-31`;
  }
  // Generic "Month Day, Year" — last resort; may match footer timestamps
  const monthPattern = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}/i;
  for (const line of lines.slice(0, 40)) {
    const match = line.match(monthPattern);
    if (match) {
      const date = toIsoDate(match[0]);
      if (date) return date;
    }
  }
  return null;
}

// Extracts start and end dates from a P&L/CF period header line.
// e.g. "January-December, 2022" → { start: "2022-01-01", end: "2022-12-31" }
//      "October 2021 - September 2022" → { start: "2021-10-01", end: "2022-09-30" }
function extractPeriodDatesFromLines(lines = []) {
  const MONTH_MAP = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const M = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  // Two-month range: "(Month[ year]) - (Month[ year])"
  const rangeRe = new RegExp(
    `(${M})(?:\\s+(\\d{4}))?[\\s,\\-–]+` +
    `(${M}),?\\s+(\\d{4})`,
    "i",
  );
  for (const line of lines.slice(0, 20)) {
    const m = line.match(rangeRe);
    if (!m) continue;
    const startMonthKey = m[1].slice(0, 3).toLowerCase();
    const startMonthNum = MONTH_MAP[startMonthKey];
    const endMonthKey = m[3].slice(0, 3).toLowerCase();
    const endMonthNum = MONTH_MAP[endMonthKey];
    const endYear = parseInt(m[4], 10);
    const startYear = m[2] ? parseInt(m[2], 10) : endYear;
    if (!startMonthNum || !endMonthNum || !endYear) continue;
    const endDay = new Date(endYear, endMonthNum, 0).getDate(); // last day of end month
    return {
      start: `${startYear}-${String(startMonthNum).padStart(2, "0")}-01`,
      end: `${endYear}-${String(endMonthNum).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`,
    };
  }
  return null;
}

/**
 * Does this file's own text identify it as an IRS return?
 *
 * Deliberately narrow: it matches the FORM DESIGNATION printed on a return
 * ("Form 1120-S", "U.S. Return of Partnership Income", a Schedule K-1 header),
 * not soft signals like "depreciation" or a four-digit year that a normal
 * management statement also carries. A false positive here would reject a
 * legitimate statement, so only markers that appear on a return and essentially
 * nowhere else are listed.
 */
const TAX_RETURN_MARKERS = [
  /\bform\s*1120[\s-]?s?\b/,
  /\bform\s*1065\b/,
  /\bform\s*1040\b/,
  /\bu\.?s\.?\s+income\s+tax\s+return\b/,
  /\bu\.?s\.?\s+return\s+of\s+partnership\s+income\b/,
  /\bincome\s+tax\s+return\s+for\s+an\s+s\s+corporation\b/,
  /\bschedule\s+k-1\b/,
  /\bshareholders?'?\s+pro\s+rata\s+share\s+items\b/,
  /\bpartners'?\s+distributive\s+share\s+items\b/,
  /\bdepartment\s+of\s+the\s+treasury\b.*\binternal\s+revenue\s+service\b/,
];

function looksLikeTaxReturn({ fileName = "", rows = [], lines = [] }) {
  const haystack = [
    fileName,
    ...rows.slice(0, 60).map((row) => (Array.isArray(row) ? row.join(" ") : "")),
    ...lines.slice(0, 120),
  ]
    .join(" ")
    .toLowerCase()
    .replace(/\s+/g, " ");
  return TAX_RETURN_MARKERS.some((rx) => rx.test(haystack));
}

function detectStatementType({ fileName = "", rows = [], lines = [] }) {
  const haystack = [
    fileName,
    ...rows.slice(0, 80).map((row) => (Array.isArray(row) ? row.join(" ") : "")),
    ...lines.slice(0, 120),
  ]
    .join(" ")
    .toLowerCase();

  const isBalanceSheet =
    haystack.includes("balance sheet") ||
    (haystack.includes("assets") &&
      haystack.includes("liabilities") &&
      haystack.includes("equity"));

  if (
    haystack.includes("cash flow") ||
    haystack.includes("operating activities") ||
    haystack.includes("investing activities") ||
    haystack.includes("financing activities")
  ) {
    return STATEMENT_TYPES.CASH_FLOW;
  }

  if (isBalanceSheet) {
    return STATEMENT_TYPES.BALANCE_SHEET;
  }

  if (
    haystack.includes("profit and loss") ||
    haystack.includes("profit & loss") ||
    haystack.includes("income statement") ||
    haystack.includes("ordinary income") ||
    haystack.includes("net income")
  ) {
    return STATEMENT_TYPES.PROFIT_AND_LOSS;
  }

  return null;
}

function buildNode(name, amount, type = "data", id = "", firstPeriodAmount = null, colAmounts = null) {
  const node = {
    id: id || `${type}-${normalizeSlug(name) || "row"}`,
    name: String(name || "").trim(),
    amount: roundMoney(Number(amount || 0)),
    type,
  };
  if (firstPeriodAmount !== null && firstPeriodAmount !== undefined) {
    node.firstPeriodAmount = roundMoney(Number(firstPeriodAmount));
  }
  if (Array.isArray(colAmounts) && colAmounts.length > 0) {
    node.colAmounts = colAmounts;
  }
  return node;
}

function buildSectionNode(name, children = [], id = "") {
  const normalizedChildren = Array.isArray(children) ? children.filter(Boolean) : [];
  const totalRow = normalizedChildren
    .slice()
    .reverse()
    .find((child) => child.type === "total");
  const computedAmount = totalRow
    ? totalRow.amount
    : roundMoney(
      normalizedChildren
        .filter((child) => child.type !== "total")
        .reduce((sum, child) => sum + Number(child.amount || 0), 0),
    );

  const node = {
    id: id || `section-${normalizeSlug(name) || "group"}`,
    name,
    amount: computedAmount,
    type: "header",
    children: normalizedChildren.length ? normalizedChildren : undefined,
  };

  const numPeriods = (normalizedChildren.find((c) => c.colAmounts)?.colAmounts || []).length;
  if (numPeriods > 0) {
    if (totalRow?.colAmounts?.length === numPeriods) {
      node.colAmounts = totalRow.colAmounts;
    } else {
      node.colAmounts = Array.from({ length: numPeriods }, (_, i) =>
        roundMoney(
          normalizedChildren
            .filter((c) => c.type !== "total")
            .reduce((sum, c) => sum + (c.colAmounts?.[i] || 0), 0),
        ),
      );
    }
  }

  return node;
}

function normalizeSectionName(value = "") {
  return normalizeText(value)
    .replace(/^total for\s+/, "")
    .replace(/^total\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isMetadataLikeLabel(label = "") {
  const normalized = normalizeText(label);
  return (
    normalized.startsWith("as of ") ||
    normalized.includes("accrual basis") ||
    normalized.includes("cash basis") ||
    normalized.includes("gmt") ||
    normalized.includes("am ") ||
    normalized.includes("pm ") ||
    /\bthrough\b/.test(normalized) ||
    /^(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(normalized) ||
    /^page\s+\d+/.test(normalized)
  );
}

function getBalanceSheetSectionLevel(label = "") {
  const normalized = normalizeSectionName(label);
  if (!normalized) return null;

  if (
    normalized === "assets" ||
    normalized === "liabilities and equity" ||
    normalized === "liabilities & equity"
  ) {
    return 0;
  }

  if (
    normalized === "liabilities" ||
    normalized === "equity" ||
    normalized === "current assets" ||
    normalized === "fixed assets" ||
    normalized === "other assets" ||
    normalized === "current liabilities" ||
    normalized === "long-term liabilities" ||
    normalized === "long term liabilities"
  ) {
    return 1;
  }

  if (
    normalized === "bank accounts" ||
    normalized === "other current assets" ||
    normalized === "credit cards" ||
    normalized === "other current liabilities"
  ) {
    return 2;
  }

  return null;
}

function matchBalanceSheetSectionStack(stack = [], totalLabel = "") {
  const normalizedTotal = normalizeSectionName(totalLabel);
  if (!normalizedTotal) return -1;

  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const sectionName = normalizeSectionName(stack[index]?.name || "");
    // Only match exact equality OR the section name is a substring of the total label
    // (e.g. "bank accounts" inside "total bank accounts" → normalizedTotal.includes(sectionName)).
    // Do NOT match the reverse (sectionName.includes(normalizedTotal)) because that causes
    // "liabilities & equity" to match "total liabilities", wiping the root from the stack.
    if (sectionName === normalizedTotal || normalizedTotal.includes(sectionName)) {
      return index;
    }
  }

  return -1;
}

function finalizeBalanceSheetSections(nodes = []) {
  return (Array.isArray(nodes) ? nodes : []).map((node) => {
    if (!node?.children) return node;
    return buildSectionNode(
      node.name,
      finalizeBalanceSheetSections(node.children),
      node.id,
    );
  });
}

function parseBalanceSheetHierarchy(entries = []) {
  const roots = [];
  const stack = [];

  const appendToCurrent = (node) => {
    if (stack.length) {
      stack[stack.length - 1].children.push(node);
      return;
    }
    roots.push(node);
  };

  entries.forEach((entry) => {
    const label = String(entry?.label || "").trim();
    if (!label || isMetadataLikeLabel(label)) return;

    const amount = entry?.amount;
    const isTotal = normalizeText(label).startsWith("total ");

    if (amount === null) {
      const level = getBalanceSheetSectionLevel(label);
      if (level === null) return;

      while (stack.length > level) {
        stack.pop();
      }

      const sectionNode = {
        id: `section-${normalizeSlug(label) || entry.index || "group"}`,
        name: label,
        children: [],
      };
      appendToCurrent(sectionNode);
      stack.push(sectionNode);
      return;
    }

    if (isTotal) {
      const matchedIndex = matchBalanceSheetSectionStack(stack, label);

      // Only pop deeper sections when we have an actual match.
      // If matchedIndex is -1 (unrecognised total such as "TOTAL LIABILITIES" when
      // only "LIABILITIES & EQUITY" is on the stack), we leave the stack as-is so
      // subsequent siblings (e.g. Equity) still nest under the right parent.
      if (matchedIndex >= 0) {
        while (stack.length - 1 > matchedIndex) {
          stack.pop();
        }
      }

      const totalNode = buildNode(
        label,
        amount,
        "total",
        `total-${normalizeSlug(label) || entry.index || "row"}`,
        null,
        entry.colAmounts ?? null,
      );
      appendToCurrent(totalNode);

      if (matchedIndex >= 0) {
        stack.splice(matchedIndex);
      }
      return;
    }

    appendToCurrent(
      buildNode(
        label,
        amount,
        "data",
        `${normalizeSlug(label) || "row"}-${entry.index + 1}`,
        null,
        entry.colAmounts ?? null,
      ),
    );
  });

  return finalizeBalanceSheetSections(roots);
}

function extractEntriesFromRows(rows = [], periodInfo = null) {
  const skipIdx = periodInfo?.headerRowIdx ?? -1;
  return rows
    .map((row, index) => {
      if (index === skipIdx) return null;
      const cells = Array.isArray(row) ? row : [];
      const entry = {
        label: firstTextCell(cells),
        amount: findAmountInCells(cells),
        index,
      };
      if (periodInfo?.periods?.length) {
        entry.colAmounts = periodInfo.periods.map(({ colIdx }) => {
          const val = parseAmount(cells[colIdx]);
          return val !== null ? roundMoney(val) : 0;
        });
      }
      return entry;
    })
    .filter((entry) => entry && entry.label);
}

function extractEntriesFromLines(lines = []) {
  const entries = [];
  let i = 0;

  while (i < lines.length) {
    const line = String(lines[i]).trim();

    if (!line || isPageIndicatorLine(line)) {
      i++;
      continue;
    }

    // Pattern 0: Multi-column line — 2+ dollar-prefixed amounts on the same line.
    // e.g. "Revenue  $1,000  $1,200  ...  $15,000"
    //      "Discounts  $383.88  $479.11  ...  $-22,266.07"
    // Label = text before the first $, firstPeriodAmount = first $ value, amount = last $ value.
    const dollarMatches = [...line.matchAll(/\$-?\d[\d,]*(?:\.\d+)?/g)];
    if (dollarMatches.length >= 2) {
      const firstDollarIdx = dollarMatches[0].index;
      const potentialLabel = line.slice(0, firstDollarIdx).replace(/[\s.\-_]+$/, "").trim();
      if (potentialLabel) {
        const firstPeriodAmount = roundMoney(parseAmount(dollarMatches[0][0]) || 0);
        const totalAmount = roundMoney(parseAmount(dollarMatches[dollarMatches.length - 1][0]) || 0);
        entries.push({ label: potentialLabel, amount: totalAmount, firstPeriodAmount, index: i });
        i++;
        continue;
      }
    }

    // Pattern 1: label and amount on the same line.
    // Handles: "Checking  12,345.00"  "Revenue  (5,000.00)"  "Retained Earnings  $-116,747.37"  "Account  -"
    const inlineMatch = line.match(/^(.*)\s+(\$-?\d[\d,]*(?:\.\d+)?|\(?-?\$?\d[\d,]*(?:\.\d+)?\)?|-)\s*$/);
    if (inlineMatch) {
      const potentialLabel = inlineMatch[1].replace(/[\s.\-_]+$/, "").trim();
      const amountStr = inlineMatch[2];

      if (potentialLabel && !isStandaloneYear(amountStr)) {
        const parsedAmt = amountStr === "-" ? 0 : (parseAmount(amountStr) || 0);
        entries.push({ label: potentialLabel, amount: roundMoney(parsedAmt), index: i });
        i++;
        continue;
      }
    }

    // Pattern 1.5: Amount directly concatenated to label with no whitespace separator.
    // QuickBooks PDF exports often lose the column gap when parsed by pdf-parse.
    // e.g. "Total for Income$111,604.89", "In8 Revenue Share30,591.39", "Net Income-$166,405.04"
    // Strategy: find the rightmost financial amount at the end of the line.
    const concatAmtSuffix = line.match(/(-?\$\d{1,3}(?:,\d{3})*(?:\.\d+)?|\$-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d{1,3}(?:,\d{3})+\.\d{2,}|-?\d+\.\d{2})$/);
    if (concatAmtSuffix) {
      const matchedAmt = concatAmtSuffix[1];
      const splitAt = line.lastIndexOf(matchedAmt);
      const potentialLabel = line.slice(0, splitAt).replace(/[\s.\-_]+$/, "").trim();
      // Only accept if label is non-empty, not purely numeric, and not a year.
      if (potentialLabel && potentialLabel.length >= 2 && !/^\d+$/.test(potentialLabel) && !isStandaloneYear(matchedAmt)) {
        entries.push({ label: potentialLabel, amount: roundMoney(parseAmount(matchedAmt) || 0), index: i });
        i++;
        continue;
      }
    }

    // Pattern 2: label on this line, standalone amount on the very next line.
    // Handles PDFs where label and value appear on alternating lines.
    if (i + 1 < lines.length) {
      const nextLine = String(lines[i + 1]).trim();
      const isNextAmount =
        (/^\$?-?\d[\d,]*(?:\.\d+)?$/.test(nextLine) || /^\(-?\d[\d,]*(?:\.\d+)?\)$/.test(nextLine) || nextLine === "-") &&
        !isPageIndicatorLine(nextLine) &&
        !isStandaloneYear(nextLine);

      if (isNextAmount) {
        const parsedAmt = nextLine === "-" ? 0 : (parseAmount(nextLine) || 0);
        entries.push({ label: line, amount: roundMoney(parsedAmt), index: i });
        i += 2;
        continue;
      }
    }

    // No amount found — section header or metadata line.
    entries.push({ label: line, amount: null, index: i });
    i++;
  }

  return entries.filter((entry) => entry.label);
}

function normalizeSectionLabel(value = "") {
  return normalizeText(value)
    .replace(/^total for\s+/, "")
    .replace(/^total\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isCrossSectionSummary(label = "") {
  const norm = normalizeText(label);
  return (
    /^gross profit/.test(norm) ||
    /^gross loss/.test(norm) ||
    /^net operating income/.test(norm) ||
    /^net operating loss/.test(norm) ||
    /^net other income/.test(norm) ||
    /^net other expense/.test(norm) ||
    /^net income/.test(norm) ||
    /^net loss/.test(norm) ||
    /^net earnings/.test(norm)
  );
}

function parseSectionedStatement(entries = [], sectionDefinitions = [], options = {}) {
  const rows = [];
  let currentSection = null;
  const exactMatchOnly = options.exactMatchOnly !== false;

  const findSection = (label = "") => {
    const normalized = normalizeSectionLabel(label);
    return sectionDefinitions.find((section) =>
      section.matches.some((keyword) => {
        const normalizedKeyword = normalizeSectionLabel(keyword);
        return exactMatchOnly
          ? normalized === normalizedKeyword
          : normalized.includes(normalizedKeyword);
      }),
    );
  };

  entries.forEach((entry) => {
    const section = findSection(entry.label);
    if (section && entry.amount === null) {
      if (currentSection?.id === section.id) {
        // Already in this section — update name to the simpler form if the current
        // has a "/" (wrapper like "Ordinary Income/Expense") and the new label doesn't.
        if (currentSection.name.includes("/") && !entry.label.includes("/")) {
          currentSection.name = entry.label;
        }
        return;
      }
      currentSection = {
        name: entry.label,
        id: section.id,
        children: [],
      };
      rows.push(currentSection);
      return;
    }

    if (entry.amount === null) return;

    // Summary rows that sit between sections (Gross Profit, Net Operating Income, etc.)
    // must appear at top level, not inside whatever section happened to be open.
    if (isCrossSectionSummary(entry.label)) {
      currentSection = null;
      rows.push(
        buildNode(
          entry.label,
          entry.amount,
          "total",
          `${normalizeSlug(entry.label) || "row"}-${entry.index + 1}`,
          entry.firstPeriodAmount ?? null,
          entry.colAmounts ?? null,
        ),
      );
      return;
    }

    const target = currentSection?.children ? currentSection.children : rows;
    const normalizedLabel = normalizeText(entry.label);
    const type =
      normalizedLabel.includes("total ") ||
        normalizedLabel.includes("net income") ||
        normalizedLabel.includes("gross profit") ||
        normalizedLabel.includes("net cash") ||
        normalizedLabel.includes("ending cash") ||
        normalizedLabel.includes("ending balance")
        ? "total"
        : "data";

    target.push(
      buildNode(
        entry.label,
        entry.amount,
        type,
        `${normalizeSlug(entry.label) || "row"}-${entry.index + 1}`,
        entry.firstPeriodAmount ?? null,
        entry.colAmounts ?? null,
      ),
    );
  });

  return rows.map((row) =>
    row?.children ? buildSectionNode(row.name, row.children, row.id) : row,
  );
}

// Statement types that require AI (Gemini) parsing in QMS mode.
// Balance Sheet, P&L, and Cash Flow use the rule-based parser only.
const QMS_AI_STATEMENT_TYPES = new Set(["tax_return", "bank_statement", "bank_reconciliation"]);

const PERIOD_MONTH_RE = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

function normalizeYearToken(value) {
  const year = Number(value);
  if (!Number.isFinite(year) || year < 0) return null;
  if (year >= 1000 && year <= 9999) return year;
  if (year > 0 && year <= 99) return year >= 70 ? 1900 + year : 2000 + year;
  return null;
}

function collectYearsFromText(value) {
  const text = String(value || "").trim();
  if (!text) return [];

  const years = new Set();
  const fullYearMatches = text.match(/\b(?:19|20)\d{2}\b/g) || [];
  fullYearMatches.forEach((match) => years.add(Number(match)));

  const monthYearRegex = new RegExp(PERIOD_MONTH_RE + "[\s.\-_]*(\d{2,4})\b", "ig");
  let monthMatch;
  while ((monthMatch = monthYearRegex.exec(text))) {
    const normalized = normalizeYearToken(monthMatch[1]);
    if (normalized) years.add(normalized);
  }

  return Array.from(years).sort((a, b) => a - b);
}

function collectDetectedYearsFromReport(report = {}, fileName = "") {
  const years = new Set();
  const add = (value) => {
    collectYearsFromText(value).forEach((year) => years.add(year));
  };

  add(report?.asOfDate);
  add(report?.periodStart);
  add(report?.periodEnd);
  (report?.periods || []).forEach(add);
  if (!years.size) add(fileName);

  return Array.from(years).sort((a, b) => a - b);
}

function collectDetectedYearsFromStatements(statements = [], fileName = "") {
  const years = new Set();
  const add = (value) => {
    collectYearsFromText(value).forEach((year) => years.add(year));
  };

  (statements || []).forEach((statement) => {
    add(statement?.period_start);
    add(statement?.period_end);
  });
  if (!years.size) add(fileName);

  return Array.from(years).sort((a, b) => a - b);
}

async function parseStoredReport(upload, forcedStatementType = null, { skipAI = false } = {}) {
  const buffer = normalizeUploadBinary(upload?.data);
  const fileName = String(upload?.file_name || "");
  const contentType = String(upload?.content_type || "");
  const lowerFileName = fileName.toLowerCase();
  const isPdf = lowerFileName.endsWith(".pdf") || contentType.toLowerCase().includes("pdf");

  // ── Tax returns: the dedicated Gemini tax reader, and NOTHING else ──────
  //
  // CONFIRMED BUG (fixed here). This function is called with
  // forcedStatementType="tax_return" from the QMS upload sync
  // (QMS_AI_STATEMENT_TYPES includes "tax_return", so skipAI is false), and it
  // then did two wrong things in sequence:
  //
  //   1. sent the return to parsePdfWithGemini() below — the GENERIC
  //      balance-sheet / P&L / cash-flow prompt. It returns a {rows} tree and has
  //      no notion of an IRS form line, so page-1, Schedule K and Schedule M-1
  //      figures came back attached to invented table rows. This is the exact
  //      mistake taxReturnExtractionService.js was already moved off.
  //   2. on ANY Gemini failure — or simply when GEMINI_API_KEY was unset — fell
  //      through to the rule-based readers further down: extractPdfLines()
  //      (pdf-parse text) for PDFs, extractRowsFromWorkbook() (xlsx) for
  //      spreadsheets. detectStatementType() cannot even return "tax_return", so
  //      the result was filed under whatever else it matched — a return that
  //      mentions "net income" lands as a Profit & Loss.
  //
  // Both are silent: the caller only checks `parsed.report.rows.length`, so wrong
  // data looked exactly like right data. A tax return now takes this branch and
  // returns or throws — it can never reach the readers below.
  const resolvedTaxType = forcedStatementType === STATEMENT_TYPES.TAX_RETURN;
  if (resolvedTaxType) {
    const mimeType = resolveTaxDocumentMime(fileName, contentType);
    if (!mimeType) throw new Error(unreadableTaxDocumentReason(fileName));
    if (!buffer?.length) throw new Error(`"${fileName}" has no readable file contents.`);

    const cacheKey = `tax_parse_${upload?.id || lowerFileName}`;
    const { extracted, status } = await extractTaxDataWithVerification(buffer, cacheKey, { mimeType });
    if (!extracted?.year) {
      throw new Error(
        `Gemini could not determine the tax year for "${fileName}". The return was not stored ` +
        `rather than being filed under a guessed year.`,
      );
    }
    return {
      statementType: STATEMENT_TYPES.TAX_RETURN,
      parserType: "gemini-tax-direct",
      taxReturn: {
        year: Number(extracted.year),
        fileName,
        status: status || "Needs Review",
        scheduleM1: extracted.scheduleM1 || null,
        data: buildTaxReturnResponseData(extracted),
      },
      report: {
        // Kept so existing `parsed.report.rows.length` guards still behave, but the
        // authoritative payload is `taxReturn` above.
        rows: buildTaxReturnResponseData(extracted).map((row) => ({
          id: `tax-${normalizeSlug(row.label) || "row"}`,
          name: row.label,
          amount: Number(row.taxReturn || 0),
          type: row.isReconcilingItem ? "data" : "total",
        })),
        asOfDate: `${Number(extracted.year)}-12-31`,
        periodStart: null,
        periodEnd: `${Number(extracted.year)}-12-31`,
        detectedYears: [Number(extracted.year)],
      },
    };
  }

  // ── Gemini path for PDFs ────────────────────────────────────────────────
  // Skipped when skipAI=true (QMS mode for non-AI statement types).
  if (isPdf && process.env.GEMINI_API_KEY && !skipAI) {
    try {
      const geminiResult = await parsePdfWithGemini(buffer, fileName);
      if (Array.isArray(geminiResult.rows) && geminiResult.rows.length > 0) {
        const statementType = forcedStatementType || geminiResult.statementType;
        console.log(`[ManualReportUpload] Gemini parsed "${fileName}" as ${statementType} (${geminiResult.rows.length} top-level rows)`);
        return {
          statementType,
          parserType: "gemini",
          report: {
            rows: geminiResult.rows,
            asOfDate: geminiResult.asOfDate || geminiResult.periodEnd || null,
            periodStart: geminiResult.periodStart || null,
            periodEnd: geminiResult.periodEnd || geminiResult.asOfDate || null,
            detectedYears: collectDetectedYearsFromReport(
              {
                asOfDate: geminiResult.asOfDate || geminiResult.periodEnd || null,
                periodStart: geminiResult.periodStart || null,
                periodEnd: geminiResult.periodEnd || geminiResult.asOfDate || null,
                periods: Array.isArray(geminiResult.periods) ? geminiResult.periods : [],
              },
              fileName,
            ),
          },
        };
      }
    } catch (geminiError) {
      console.warn(`[ManualReportUpload] Gemini failed for "${fileName}", falling back to text extraction: ${geminiError.message}`);
    }
  }

  // ── Text-extraction fallback (Excel / non-Gemini PDF) ──────────────────
  let rows = [];
  let lines = [];
  let parserType = "excel";

  if (isPdf) {
    parserType = "pdf";
    lines = await extractPdfLines(buffer);
    console.log(`[ManualReportUpload] PDF text fallback "${fileName}" → ${lines.length} lines`);
    if (lines.length > 0) console.log(`[ManualReportUpload] First 10 lines:`, lines.slice(0, 10));
  } else {
    rows = extractRowsFromWorkbook(buffer, fileName, contentType);
  }

  // Detect monthly period columns in Excel files (e.g. "P&L by Month" with Jan 22 … Dec 25 headers)
  const periodInfo = (!isPdf && rows.length) ? detectPeriodColumns(rows) : null;

  // A tax return that reached the rule-based readers without being declared as one
  // must NOT be filed as whatever else it happens to match. detectStatementType
  // cannot return "tax_return", and a return mentioning "net income" matches the
  // Profit & Loss test — so without this it would be ingested as a P&L, by a text
  // or spreadsheet reader, and look entirely normal downstream. Refuse it and say
  // where it belongs; tax returns are Gemini-only (see the branch at the top).
  if (looksLikeTaxReturn({ fileName, rows, lines })) {
    throw new Error(
      `"${fileName}" looks like an IRS tax return, not a financial statement. Tax returns are read ` +
      `only by Gemini through the Tax Return document type — this file was NOT parsed as a ` +
      `statement. Upload it to the Tax Return folder (or link it as a Tax Return in Key Reports).`,
    );
  }

  const statementType = forcedStatementType || detectStatementType({ fileName, rows, lines });
  console.log(`[ManualReportUpload] "${fileName}" detected as: ${statementType || "unknown"}${forcedStatementType ? " (forced)" : ""}${periodInfo ? ` [${periodInfo.periods.length} period columns]` : ""}`);
  if (!statementType) return null;

  if (statementType === STATEMENT_TYPES.BALANCE_SHEET) {
    let asOfDate = null;

    if (parserType === "pdf") {
      asOfDate = extractAsOfDateFromLines(lines);
    } else {
      try {
        const structured = processBalanceSheet({ rawRows: rows });
        asOfDate = structured.asOfDate || null;
      } catch (error) {
        console.warn(
          `[ManualReportUpload] Balance Sheet normalization fallback for ${fileName}: ${error.message}`,
        );
      }
    }

    // For multi-column Balance Sheets (e.g. "Last 13 Months"), use the last
    // period's year as asOfDate so year-range filtering works correctly.
    if (periodInfo && periodInfo.periods.length > 0) {
      const dataLabels = periodInfo.periods
        .map((p) => p.label)
        .filter((l) => !/^total$/i.test(l.trim()));
      const lastLabel = dataLabels[dataLabels.length - 1];
      if (lastLabel) {
        const ym = lastLabel.match(/\b(20\d{2})\b/);
        if (ym) asOfDate = `${ym[1]}-12-31`;
      }
    }

    const entries = rows.length ? extractEntriesFromRows(rows, periodInfo) : extractEntriesFromLines(lines);
    const hierarchyRows = parseBalanceSheetHierarchy(entries);

    return {
      statementType,
      parserType,
      report: {
        rows: hierarchyRows.length ? hierarchyRows : [],
        asOfDate,
        detectedYears: collectDetectedYearsFromReport(
          {
            asOfDate,
            periodStart: null,
            periodEnd: null,
            periods: periodInfo ? periodInfo.periods.map((p) => p.label) : [],
          },
          fileName,
        ),
        ...(periodInfo ? { periods: periodInfo.periods.map((p) => p.label) } : {}),
      },
    };
  }

  const entries = rows.length ? extractEntriesFromRows(rows, periodInfo) : extractEntriesFromLines(lines);
  const sectionDefinitions =
    statementType === STATEMENT_TYPES.PROFIT_AND_LOSS
      ? [
        {
          id: "income",
          name: "Income",
          matches: ["income", "revenue", "ordinary income", "ordinary income/expense"],
        },
        {
          id: "cost-of-sales",
          name: "Cost of Sales",
          matches: ["cost of goods sold", "cost of sales", "cost of goods sold/cost of sales"],
        },
        {
          id: "expenses",
          name: "Expenses",
          matches: ["expenses", "expense", "operating expenses"],
        },
        {
          id: "other-income",
          name: "Other Income / Expense",
          matches: ["other income", "other expense", "other income / expense", "other income expense", "net other income"],
        },
      ]
      : [
        { id: "operating", name: "Operating Activities", matches: ["operating activities"] },
        { id: "investing", name: "Investing Activities", matches: ["investing activities"] },
        { id: "financing", name: "Financing Activities", matches: ["financing activities"] },
      ];

  const exactMatchOnly = parserType !== "pdf" && statementType === STATEMENT_TYPES.PROFIT_AND_LOSS;

  // Extract date period for P&L / Cash Flow
  let reportAsOfDate = null;
  let reportPeriodStart = null;
  let reportPeriodEnd = null;

  if (parserType === "pdf" && lines.length > 0) {
    // Try to extract a precise period range first (e.g. "January-December, 2022")
    const periodDates = extractPeriodDatesFromLines(lines);
    if (periodDates) {
      reportPeriodStart = periodDates.start;
      reportPeriodEnd = periodDates.end;
      reportAsOfDate = periodDates.end;
    } else {
      reportAsOfDate = extractAsOfDateFromLines(lines);
    }
  }
  if (!reportAsOfDate && parserType === "excel" && rows.length > 0) {
    // Scan first 10 rows for a 4-digit year (e.g. "January through December 2024")
    for (const row of rows.slice(0, 10)) {
      const rowText = (Array.isArray(row) ? row : []).map((c) => String(c || "")).join(" ");
      const yearMatch = rowText.match(/\b(20\d{2})\b/);
      if (yearMatch) {
        reportAsOfDate = `${yearMatch[1]}-12-31`;
        break;
      }
    }
  }
  // Fallback: try to infer year from fileName (e.g. "ProfitLoss_2023.pdf")
  if (!reportAsOfDate) {
    const yearInName = String(fileName).match(/\b(20\d{2})\b/);
    if (yearInName) reportAsOfDate = `${yearInName[1]}-12-31`;
  }

  return {
    statementType,
    parserType,
    report: {
      rows: parseSectionedStatement(entries, sectionDefinitions, { exactMatchOnly }),
      asOfDate: reportAsOfDate,
      detectedYears: collectDetectedYearsFromReport(
        {
          asOfDate: reportAsOfDate,
          periodStart: reportPeriodStart,
          periodEnd: reportPeriodEnd,
          periods: periodInfo ? periodInfo.periods.map((p) => p.label) : [],
        },
        fileName,
      ),
      ...(reportPeriodStart ? { periodStart: reportPeriodStart } : {}),
      ...(reportPeriodEnd ? { periodEnd: reportPeriodEnd } : {}),
      ...(periodInfo ? { periods: periodInfo.periods.map((p) => p.label) } : {}),
    },
  };
}

async function loadUpload(uploadId) {
  const { data: upload, error } = await supabase
    .from("uploads")
    .select("id, file_name, content_type, data")
    .eq("id", uploadId)
    .maybeSingle();

  if (error) throw new Error(`Upload read failed: ${error.message}`);
  if (!upload) throw new Error("Upload not found.");
  return upload;
}

async function loadUploadForDoc(doc) {
  if (doc.upload_id) {
    const { data: up } = await supabase
      .from("uploads").select("id, file_name, content_type, data").eq("id", doc.upload_id).maybeSingle();
    if (up?.data) return up;
  }
  if (doc.file_url) {
    const m = String(doc.file_url).match(/\/uploads\/([0-9a-f-]{36})\/content/i);
    if (m) {
      const { data: up } = await supabase
        .from("uploads").select("id, file_name, content_type, data").eq("id", m[1]).maybeSingle();
      if (up?.data) return up;
    }
  }
  throw new Error("No upload binary found for this document");
}


/**
 * Processes a single DataRoom document into structured report data,
 * persisting the result to qb_synced_reports.
 * Used by Key Reports Sync to extract data from linked documents.
 */
async function processDocumentMapping(companyId, documentId, category, opts = {}) {
  const { folderId = null, folderName = "Linked Document" } = opts;
  const now = new Date().toISOString();

  // 1. Resolve category to statement type
  const typeMap = {
    profit_loss: STATEMENT_TYPES.PROFIT_AND_LOSS,
    balance_sheet: STATEMENT_TYPES.BALANCE_SHEET,
    cash_flow: STATEMENT_TYPES.CASH_FLOW,
    bank_statement: STATEMENT_TYPES.BANK_RECONCILIATION,
    tax_return: STATEMENT_TYPES.TAX_RETURN,
  };
  const statementType = typeMap[category];
  if (!statementType) {
    throw new Error(`Unsupported category for document extraction: ${category}`);
  }

  // 2. Load document and binary
  const { data: document, error: docErr } = await supabase
    .from("documents")
    .select("id, name, upload_id, file_url")
    .eq("id", documentId)
    .maybeSingle();

  if (docErr) throw new Error(`Failed to load document: ${docErr.message}`);
  if (!document) throw new Error(`Document not found: ${documentId}`);

  const upload = await loadUploadForDoc(document);
  const buffer = normalizeUploadBinary(upload.data);
  const fileName = document.name;

  let extractionResult = null;

  // 3. Extraction based on statement type
  if (statementType === STATEMENT_TYPES.TAX_RETURN) {
    const cacheKey = `kr_sync_tax_${companyId}_${documentId}`;
    const extracted = await extractTaxDataFromBuffer(buffer, cacheKey);
    if (extracted?.year) {
      const detectedYears = collectDetectedYearsFromReport({ asOfDate: String(extracted.year) + "-12-31" }, fileName);
      extractionResult = {
        tax_return: {
          taxYears: {
            [extracted.year]: {
              year: extracted.year,
              fileName,
              scheduleM1: extracted.scheduleM1 || null,
              data: buildTaxReturnResponseData(extracted),
            },
          },
          syncedAt: now,
          documentCount: 1,
          detectedYears: detectedYears.length ? detectedYears : [Number(extracted.year)],
        },
      };
    }
  } else if (statementType === STATEMENT_TYPES.BANK_RECONCILIATION) {
    const ext = fileName.toLowerCase().split(".").pop();
    let statements = [];
    if (["xlsx", "xls", "csv"].includes(ext)) {
      statements = await extractBankStatementsFromExcelBuffer(buffer, fileName);
    } else {
      statements = await extractBankStatementsFromPdfBase64(buffer.toString("base64"), fileName);
    }
    if (statements.length) {
      const { banks, months, totals } = buildBankResponseShape(statements);
      const detectedYears = collectDetectedYearsFromStatements(statements, fileName);
      extractionResult = {
        bank_reconciliation: {
          banks,
          months,
          totals,
          syncedAt: now,
          documentCount: 1,
          detectedYears,
        },
      };
    }
  } else {
    // P&L, Balance Sheet, Cash Flow
    const parsed = await parseStoredReport(upload, statementType);
    if (parsed?.report?.rows?.length) {
      extractionResult = {
        manual_report_upload: {
          statementType: parsed.statementType,
          parserType: parsed.parserType,
          documentId,
          uploadId: upload.id,
          fileName,
          report: parsed.report,
          syncedAt: now,
          detectedYears: Array.isArray(parsed?.report?.detectedYears) ? parsed.report.detectedYears : [],
        },
      };
    }
  }

  if (!extractionResult) {
    throw new Error(`Could not extract structured data from "${fileName}" as ${statementType}`);
  }

  // 4. Persist to qb_synced_reports
  // Use source=manual_report_upload to remain compatible with standard report views.
  await supabase
    .from("qb_synced_reports")
    .delete()
    .eq("company_id", companyId)
    .eq("source", MANUAL_REPORT_UPLOAD_SOURCE)
    .eq("report_type", statementType)
    .filter("report_params->>documentId", "eq", documentId);

  const { error: upsertError } = await supabase
    .from("qb_synced_reports")
    .insert({
      company_id: companyId,
      report_type: statementType,
      report_params: {
        folderId,
        folderName,
        documentId,
        uploadId: upload.id,
        fileName,
      },
      data: extractionResult,
      source: MANUAL_REPORT_UPLOAD_SOURCE,
      status: "synced",
      last_synced_at: now,
      updated_at: now,
    });

  if (upsertError) throw new Error(`Persistence failed: ${upsertError.message}`);

  const detectedYears =
    extractionResult?.manual_report_upload?.detectedYears ||
    extractionResult?.bank_reconciliation?.detectedYears ||
    extractionResult?.tax_return?.detectedYears ||
    [];

  return {
    success: true,
    documentId,
    statementType,
    fileName,
    detectedYears,
  };
}

async function syncManualReportFolder({ companyId, folderId, folderName = "" }) {
  if (!companyId) throw new Error("companyId is required");
  if (!folderId) throw new Error("folderId is required");

  const { data: documents, error } = await supabase
    .from("documents")
    .select("id, name, upload_id, file_url")
    .eq("folder_id", folderId)
    .not("upload_id", "is", null)
    .order("uploaded_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load folder documents: ${error.message}`);
  }

  const processed = [];
  const skipped = [];
  const now = new Date().toISOString();

  // Process all documents in parallel — each PDF spins up its own worker thread
  // so the main event loop stays free and multiple files don't queue behind each other.
  const settlements = await Promise.allSettled(
    (documents || []).map(async (document) => {
      const upload = await loadUpload(document.upload_id);
      const parsed = await parseStoredReport(upload);

      if (!parsed?.statementType || !parsed?.report?.rows?.length) {
        return { skipped: true, documentId: document.id, fileName: document.name, reason: "Unsupported or unreadable report" };
      }

      // Remove any previous record for this exact document before inserting the fresh one.
      // (report_params is JSONB — no unique constraint exists on it, so upsert onConflict
      // is not usable; delete-then-insert achieves the same idempotent result.)
      await supabase
        .from("qb_synced_reports")
        .delete()
        .eq("company_id", companyId)
        .eq("source", MANUAL_REPORT_UPLOAD_SOURCE)
        .eq("report_type", parsed.statementType)
        .filter("report_params->>documentId", "eq", document.id);

      const { error: upsertError } = await supabase
        .from("qb_synced_reports")
        .insert({
          company_id: companyId,
          report_type: parsed.statementType,
          report_params: {
            folderId,
            folderName,
            documentId: document.id,
            uploadId: document.upload_id,
            fileName: document.name,
          },
          data: {
            manual_report_upload: {
              statementType: parsed.statementType,
              parserType: parsed.parserType,
              folderId,
              folderName,
              documentId: document.id,
              uploadId: document.upload_id,
              fileName: document.name,
              fileUrl: document.file_url || null,
              report: parsed.report,
              syncedAt: now,
            },
          },
          source: MANUAL_REPORT_UPLOAD_SOURCE,
          status: "synced",
          last_synced_at: now,
          updated_at: now,
        });

      if (upsertError) throw new Error(upsertError.message);

      return { skipped: false, documentId: document.id, fileName: document.name, statementType: parsed.statementType };
    }),
  );

  for (let idx = 0; idx < settlements.length; idx++) {
    const doc = (documents || [])[idx];
    const settlement = settlements[idx];
    if (settlement.status === "fulfilled") {
      const val = settlement.value;
      if (val.skipped) {
        skipped.push({ documentId: val.documentId, fileName: val.fileName, reason: val.reason });
      } else {
        processed.push({ documentId: val.documentId, fileName: val.fileName, statementType: val.statementType });
      }
    } else {
      skipped.push({ documentId: doc?.id, fileName: doc?.name, reason: settlement.reason?.message || "Processing failed" });
    }
  }

  try {
    await updateReportSourceRecord(companyId, REPORT_SOURCE_KEYS.MANUAL_UPLOAD, {
      isAvailable: processed.length > 0,
      isConnected: false,
      lastSyncedAt: processed.length > 0 ? now : null,
      metadata: {
        selectedFolderId: folderId,
        selectedFolderName: folderName || null,
        syncedReportTypes: Array.from(new Set(processed.map((item) => item.statementType))),
        processedCount: processed.length,
        skippedCount: skipped.length,
      },
    });
  } catch (updateError) {
    console.warn("[ManualReportUpload] Failed to update source record:", updateError.message);
  }

  return {
    folderId,
    folderName,
    processed,
    skipped,
    processedCount: processed.length,
  };
}

async function getLatestManualUploadedReport({ companyId, statementType }) {
  if (!companyId) throw new Error("companyId is required");
  if (!statementType) throw new Error("statementType is required");

  const { data, error } = await supabase
    .from("qb_synced_reports")
    .select("id, report_type, report_params, data, updated_at, last_synced_at")
    .eq("company_id", companyId)
    .eq("source", MANUAL_REPORT_UPLOAD_SOURCE)
    .eq("report_type", statementType)
    .order("updated_at", { ascending: false })
    .order("last_synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Manual uploaded report fetch failed: ${error.message}`);
  }

  return data || null;
}

async function getAllManualUploadedReports({ companyId, statementType }) {
  if (!companyId) throw new Error("companyId is required");
  if (!statementType) throw new Error("statementType is required");

  const { data, error } = await supabase
    .from("qb_synced_reports")
    .select("id, report_type, report_params, data, updated_at, last_synced_at")
    .eq("company_id", companyId)
    .eq("source", MANUAL_REPORT_UPLOAD_SOURCE)
    .eq("report_type", statementType)
    .order("updated_at", { ascending: true });

  if (error) {
    throw new Error(`Manual uploaded reports fetch failed: ${error.message}`);
  }

  return data || [];
}

// ── Manual Upload Source sync ─────────────────────────────────────────────────

const SOURCE_FOLDER_NAME = "Manual Upload Source";
const QMS_FOLDER_NAME = "Quickbooks Manual Source";
const QMS_REPORT_UPLOAD_SOURCE = "quickbooks_manual_upload";

async function getAllQMSUploadedReports({ companyId, statementType }) {
  if (!companyId) throw new Error("companyId is required");
  if (!statementType) throw new Error("statementType is required");

  const { data, error } = await supabase
    .from("qb_synced_reports")
    .select("id, report_type, report_params, data, updated_at, last_synced_at")
    .eq("company_id", companyId)
    .eq("source", QMS_REPORT_UPLOAD_SOURCE)
    .eq("report_type", statementType)
    .order("updated_at", { ascending: true });

  if (error) throw new Error(`QMS uploaded reports fetch failed: ${error.message}`);
  return data || [];
}

async function getLatestQMSUploadedReport({ companyId, statementType }) {
  if (!companyId) throw new Error("companyId is required");
  if (!statementType) throw new Error("statementType is required");

  const { data, error } = await supabase
    .from("qb_synced_reports")
    .select("id, report_type, report_params, data, updated_at, last_synced_at")
    .eq("company_id", companyId)
    .eq("source", QMS_REPORT_UPLOAD_SOURCE)
    .eq("report_type", statementType)
    .order("updated_at", { ascending: false })
    .order("last_synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`QMS latest report fetch failed: ${error.message}`);
  return data || null;
}

// Extract any UUID from a URL string — broader fallback for non-standard file_url formats.
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function loadBankBuffer(doc, fileName) {
  // 1. Direct upload_id lookup
  if (doc.upload_id) {
    const { data: upload } = await supabase
      .from("uploads").select("data").eq("id", doc.upload_id).maybeSingle();
    if (upload?.data) {
      const buf = normalizeBankBinary(upload.data);
      if (buf?.length) return { buffer: buf, method: "upload_id" };
    }
  }

  if (doc.file_url) {
    const url = String(doc.file_url);

    // 2. Specific /uploads/UUID/content pattern
    const specificMatch = url.match(/\/uploads\/([0-9a-f-]{36})\/content/i);
    if (specificMatch) {
      const { data: upload } = await supabase
        .from("uploads").select("data").eq("id", specificMatch[1]).maybeSingle();
      if (upload?.data) {
        const buf = normalizeBankBinary(upload.data);
        if (buf?.length) return { buffer: buf, method: "file_url_specific" };
      }
    }

    // 3. Any UUID found anywhere in the URL (handles non-standard storage paths)
    const uuidMatch = url.match(UUID_PATTERN);
    if (uuidMatch && uuidMatch[0] !== specificMatch?.[1]) {
      const { data: upload } = await supabase
        .from("uploads").select("data").eq("id", uuidMatch[0]).maybeSingle();
      if (upload?.data) {
        const buf = normalizeBankBinary(upload.data);
        if (buf?.length) {
          console.log(`[BankSync] Loaded "${fileName}" via URL UUID fallback`);
          return { buffer: buf, method: "file_url_uuid_fallback" };
        }
      }
    }
  }

  return { buffer: null, method: "not_found" };
}

async function syncBankReconciliationFolder(companyId, folder, now, overrideSource) {
  const bankSource = overrideSource || MANUAL_REPORT_UPLOAD_SOURCE;
  const { data: documents } = await supabase
    .from("documents")
    .select("id, name, upload_id, file_url")
    .eq("folder_id", folder.id)
    .order("uploaded_at", { ascending: false });

  if (!documents?.length) {
    return { success: false, reason: "No files in folder", processed: [], failed: [] };
  }

  const allStatements = [];
  const processedDocs = [];
  const perFileFailed = [];

  for (const doc of documents) {
    const fileName = String(doc.name || "bank_statement");
    const ext = fileName.toLowerCase().split(".").pop();
    const isPdf = ext === "pdf";
    const isExcel = ["xlsx", "xls", "csv"].includes(ext);

    if (!isPdf && !isExcel) {
      console.log(`[BankSync] Skipping unsupported file type: "${fileName}"`);
      perFileFailed.push({ fileName, folderName: folder.name, reason: `Unsupported file type (.${ext}). Upload PDF, XLSX, XLS, or CSV.` });
      continue;
    }

    const { buffer } = await loadBankBuffer(doc, fileName);

    if (!buffer?.length) {
      console.warn(`[BankSync] No binary data for "${fileName}", skipping`);
      perFileFailed.push({ fileName, folderName: folder.name, reason: "File binary could not be read. Try re-uploading the file." });
      continue;
    }

    try {
      let statements;
      if (isExcel) {
        statements = await extractBankStatementsFromExcelBuffer(buffer, fileName);
        console.log(`[BankSync] Excel extracted ${statements.length} statement(s) from "${fileName}"`);
      } else {
        statements = await extractBankStatementsFromPdfBase64(buffer.toString("base64"), fileName);
      }
      if (statements.length) {
        allStatements.push(...statements);
        processedDocs.push({ documentId: doc.id, fileName, statementType: STATEMENT_TYPES.BANK_RECONCILIATION });
      } else {
        perFileFailed.push({ fileName, folderName: folder.name, reason: "No bank statement data found in file. Ensure it contains Beginning Balance, Deposits, Withdrawals, and Ending Balance." });
      }
    } catch (err) {
      console.error(`[BankSync] Extraction failed for "${fileName}": ${err.message}`);
      perFileFailed.push({ fileName, folderName: folder.name, reason: `Extraction error: ${err.message}` });
    }
  }

  if (!allStatements.length) {
    const reason = perFileFailed.length
      ? perFileFailed.map((f) => `${f.fileName}: ${f.reason}`).join("; ")
      : "No bank statement data could be extracted";
    return { success: false, reason, processed: [], failed: perFileFailed };
  }

  const { banks, months, totals } = buildBankResponseShape(allStatements);

  // Don't persist empty extraction results — the endpoint will re-run live extraction next time.
  if (!banks.length) {
    console.warn(`[BankSync] buildBankResponseShape produced 0 banks for company ${companyId} — skipping storage`);
    return { success: false, reason: "No bank data could be structured from extracted statements", processed: [] };
  }

  // Upsert one aggregate record per company for bank reconciliation
  const { data: existing } = await supabase
    .from("qb_synced_reports")
    .select("id")
    .eq("company_id", companyId)
    .eq("source", bankSource)
    .eq("report_type", STATEMENT_TYPES.BANK_RECONCILIATION)
    .maybeSingle();

  const payload = {
    company_id: companyId,
    report_type: STATEMENT_TYPES.BANK_RECONCILIATION,
    report_params: { sourceFolderName: SOURCE_FOLDER_NAME, folderName: folder.name },
    data: {
      bank_reconciliation: {
        banks,
        months,
        totals,
        syncedAt: now,
        documentCount: processedDocs.length,
      },
    },
    source: bankSource,
    status: "synced",
    last_synced_at: now,
    updated_at: now,
  };

  let upsertError;
  if (existing?.id) {
    ({ error: upsertError } = await supabase
      .from("qb_synced_reports").update(payload).eq("id", existing.id));
  } else {
    ({ error: upsertError } = await supabase
      .from("qb_synced_reports").insert(payload));
  }

  if (upsertError) throw new Error(upsertError.message);

  console.log(`[BankSync] Stored bank reconciliation data for company ${companyId}: ${banks.length} bank(s), ${months.length} month(s)`);
  return { success: true, processed: processedDocs, failed: perFileFailed };
}

// Maps lowercase subfolder name → forced statement type
const SUBFOLDER_STATEMENT_MAP = {
  "balance sheet": STATEMENT_TYPES.BALANCE_SHEET,
  "profit & loss": STATEMENT_TYPES.PROFIT_AND_LOSS,
  "profit and loss": STATEMENT_TYPES.PROFIT_AND_LOSS,
  "cashflow": STATEMENT_TYPES.CASH_FLOW,
  "cash flow": STATEMENT_TYPES.CASH_FLOW,
  "bank reconciliation": STATEMENT_TYPES.BANK_RECONCILIATION,
  "bank statement": STATEMENT_TYPES.BANK_RECONCILIATION,
  "tax reconciliation": STATEMENT_TYPES.TAX_RETURN,
  "tax return": STATEMENT_TYPES.TAX_RETURN,
};

async function getManualUploadSourceTree(companyId) {
  if (!companyId) throw new Error("companyId is required");

  const { data: sourceFolder } = await supabase
    .from("folders")
    .select("id, name")
    .eq("company_id", companyId)
    .is("parent_id", null)
    .ilike("name", SOURCE_FOLDER_NAME)
    .maybeSingle();

  if (!sourceFolder) return null;

  const { data: children } = await supabase
    .from("folders")
    .select("id, name")
    .eq("parent_id", sourceFolder.id)
    .order("created_at", { ascending: true });

  const result = [];

  for (const child of (children || [])) {
    const nameLower = child.name.toLowerCase().trim();

    if (nameLower === "reports") {
      const { data: reportChildren } = await supabase
        .from("folders")
        .select("id, name")
        .eq("parent_id", child.id)
        .order("created_at", { ascending: true });

      const subItems = await Promise.all((reportChildren || []).map(async (rc) => {
        const { count } = await supabase
          .from("documents")
          .select("id", { count: "exact", head: true })
          .eq("folder_id", rc.id);
        return {
          id: rc.id,
          name: rc.name,
          statementType: SUBFOLDER_STATEMENT_MAP[rc.name.toLowerCase().trim()] || null,
          fileCount: count || 0,
        };
      }));

      result.push({ id: child.id, name: child.name, isGroup: true, children: subItems });
    } else {
      const { count } = await supabase
        .from("documents")
        .select("id", { count: "exact", head: true })
        .eq("folder_id", child.id);

      result.push({
        id: child.id,
        name: child.name,
        statementType: SUBFOLDER_STATEMENT_MAP[nameLower] || null,
        fileCount: count || 0,
        isGroup: false,
      });
    }
  }

  // Augment tree: show generated Cash Flow count even when no CF folder exists in DataRoom
  try {
    const { count: cfCount } = await supabase
      .from("qb_synced_reports")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .eq("source", "manual_upload_generated")
      .eq("report_type", STATEMENT_TYPES.CASH_FLOW);

    // Find an existing CF folder entry anywhere in the tree
    let existingCfEntry = null;
    for (const item of result) {
      if (item.statementType === STATEMENT_TYPES.CASH_FLOW) { existingCfEntry = item; break; }
      if (item.isGroup) {
        const sub = (item.children || []).find((c) => c.statementType === STATEMENT_TYPES.CASH_FLOW);
        if (sub) { existingCfEntry = sub; break; }
      }
    }

    if (existingCfEntry) {
      existingCfEntry.fileCount = cfCount || 0;
      existingCfEntry.isGenerated = true;
    } else {
      result.push({
        id: "generated-cashflow",
        name: "Cash Flow",
        statementType: STATEMENT_TYPES.CASH_FLOW,
        fileCount: cfCount || 0,
        isGroup: false,
        isGenerated: true,
      });
    }
  } catch (e) {
    console.warn("[ManualUploadTree] Could not add CF count:", e.message);
  }

  return { id: sourceFolder.id, name: sourceFolder.name, children: result };
}

async function syncManualUploadSource(companyId) {
  if (!companyId) throw new Error("companyId is required");

  const sourceTree = await getManualUploadSourceTree(companyId);
  if (!sourceTree) {
    throw new Error(`"${SOURCE_FOLDER_NAME}" folder not found in DataRoom.`);
  }

  // Collect all leaf folders that map to a statement type
  const foldersToSync = [];
  for (const item of sourceTree.children) {
    if (item.isGroup) {
      for (const sub of (item.children || [])) {
        if (sub.statementType) foldersToSync.push({ folder: sub, statementType: sub.statementType });
      }
    } else if (item.statementType) {
      foldersToSync.push({ folder: item, statementType: item.statementType });
    }
  }

  // ── Progress tracking ─────────────────────────────────────────────────────
  const processableTotal = foldersToSync
    .filter(({ folder }) => !folder.isGenerated)
    .reduce((sum, { folder }) => sum + (folder.fileCount || 0), 0);
  let totalFilesCount = Math.max(processableTotal, 1);
  let processedFilesCount = 0;

  _setManualUploadProgress(companyId, {
    totalFiles: totalFilesCount,
    processedFiles: 0,
    currentFile: "",
    currentStep: "Preparing sync...",
    percentage: 0,
  });

  // Clear this company's previously-synced Manual Upload STATEMENTS so
  // removed/renamed files don't leave stale rows behind after re-sync. Scoped to the
  // report_types this sync owns — see MANUAL_UPLOAD_SYNC_OWNED_REPORT_TYPES for why
  // deleting the whole `source` partition is destructive.
  const { error: deleteError } = await supabase
    .from("qb_synced_reports")
    .delete()
    .eq("company_id", companyId)
    .eq("source", MANUAL_REPORT_UPLOAD_SOURCE)
    .in("report_type", MANUAL_UPLOAD_SYNC_OWNED_REPORT_TYPES);

  if (deleteError) {
    throw new Error(`Failed to clear existing records before sync: ${deleteError.message}`);
  }

  const now = new Date().toISOString();
  const processed = [];
  const failed = [];

  for (const { folder, statementType } of foldersToSync) {
    // Bank reconciliation uses Gemini bank extraction — handled separately
    if (statementType === STATEMENT_TYPES.BANK_RECONCILIATION) {
      try {
        const bankResult = await syncBankReconciliationFolder(companyId, folder, now);
        processed.push(...(bankResult.processed || []));
        // Per-file failures from syncBankReconciliationFolder are the primary signal.
        // Only add a folder-level fallback error when no per-file detail is available.
        if (bankResult.failed?.length) {
          failed.push(...bankResult.failed);
        } else if (!bankResult.success && bankResult.reason !== "No files in folder") {
          failed.push({ fileName: folder.name, folderName: folder.name, reason: bankResult.reason || "Bank extraction failed" });
        }
      } catch (err) {
        failed.push({ fileName: folder.name, folderName: folder.name, reason: err.message });
      }
      processedFilesCount += folder.fileCount || 1;
      _setManualUploadProgress(companyId, {
        totalFiles: totalFilesCount,
        processedFiles: Math.min(processedFilesCount, totalFilesCount),
        currentFile: folder.name,
        currentStep: "Bank statements processed",
        percentage: Math.min(99, Math.round((processedFilesCount / totalFilesCount) * 100)),
      });
      continue;
    }

    // Tax reconciliation uses Gemini vision (image-based PDF support) — handled separately
    if (statementType === STATEMENT_TYPES.TAX_RETURN) {
      try {
        console.log(`[Sync] Processing Tax Reconciliation folder "${folder.name}"...`);
        const taxResult = await syncTaxReturnFolder(companyId, folder, now);
        processed.push(...(taxResult.processed || []));
        failed.push(...(taxResult.failed || []));
      } catch (err) {
        failed.push({ fileName: folder.name, folderName: folder.name, reason: err.message });
      }
      processedFilesCount += folder.fileCount || 1;
      _setManualUploadProgress(companyId, {
        totalFiles: totalFilesCount,
        processedFiles: Math.min(processedFilesCount, totalFilesCount),
        currentFile: folder.name,
        currentStep: "Tax data extracted",
        percentage: Math.min(99, Math.round((processedFilesCount / totalFilesCount) * 100)),
      });
      continue;
    }

    // Profit & Loss: also run Gemini/text extraction for Tax Reconciliation page (pl_for_tax)
    // This is a secondary operation — failures here don't affect the main P&L sync result
    if (statementType === STATEMENT_TYPES.PROFIT_AND_LOSS) {
      try {
        console.log(`[Sync] Running P&L extraction for Tax Recon page from "${folder.name}"...`);
        await syncPLForTaxFolder(companyId, folder, now);
      } catch (err) {
        console.warn(`[Sync] P&L extraction for tax recon skipped: ${err.message}`);
      }
      // Fall through to run the normal Excel/pattern-matching P&L sync as well
    }

    const { data: documents } = await supabase
      .from("documents")
      .select("id, name, upload_id, file_url")
      .eq("folder_id", folder.id)
      .order("uploaded_at", { ascending: false });

    if (!documents?.length) {
      // Empty folder — silently skip, don't count as failed
      continue;
    }

    const settlements = await Promise.allSettled(
      documents.map(async (doc) => {
        _setManualUploadProgress(companyId, {
          totalFiles: totalFilesCount,
          processedFiles: processedFilesCount,
          currentFile: doc.name,
          currentStep: "Extracting financial data",
          percentage: Math.min(99, Math.round((processedFilesCount / totalFilesCount) * 100)),
        });
        let upload;
        try {
          upload = await loadUploadForDoc(doc);
        } catch (err) {
          return { failed: true, documentId: doc.id, fileName: doc.name, folderName: folder.name, reason: err.message };
        }
        const parsed = await parseStoredReport(upload, statementType);

        if (!parsed?.report?.rows?.length) {
          return { failed: true, documentId: doc.id, fileName: doc.name, folderName: folder.name, reason: "No parseable data in file" };
        }

        const resolvedUploadId = upload.id || doc.upload_id || null;
        // All existing records for this company were deleted above; plain insert is safe.
        const { error: upsertError } = await supabase
          .from("qb_synced_reports")
          .insert({
            company_id: companyId,
            report_type: statementType,
            report_params: {
              sourceFolderName: SOURCE_FOLDER_NAME,
              folderId: folder.id,
              folderName: folder.name,
              documentId: doc.id,
              uploadId: resolvedUploadId,
              fileName: doc.name,
            },
            data: {
              manual_report_upload: {
                statementType,
                parserType: parsed.parserType,
                folderId: folder.id,
                folderName: folder.name,
                documentId: doc.id,
                uploadId: resolvedUploadId,
                fileName: doc.name,
                fileUrl: doc.file_url || null,
                report: parsed.report,
                syncedAt: now,
              },
            },
            source: MANUAL_REPORT_UPLOAD_SOURCE,
            status: "synced",
            last_synced_at: now,
            updated_at: now,
          });

        if (upsertError) throw new Error(upsertError.message);
        return { failed: false, documentId: doc.id, fileName: doc.name, statementType, folderName: folder.name };
      }),
    );

    for (let i = 0; i < settlements.length; i++) {
      const s = settlements[i];
      processedFilesCount++;
      if (s.status === "fulfilled") {
        s.value.failed ? failed.push(s.value) : processed.push(s.value);
      } else {
        failed.push({ folderName: folder.name, fileName: documents[i]?.name, reason: s.reason?.message });
      }
      _setManualUploadProgress(companyId, {
        totalFiles: totalFilesCount,
        processedFiles: Math.min(processedFilesCount, totalFilesCount),
        currentFile: documents[i]?.name || "",
        currentStep: s.status === "fulfilled" && !s.value?.failed ? "Saved" : "Failed",
        percentage: Math.min(99, Math.round((processedFilesCount / totalFilesCount) * 100)),
      });
    }
  }

  // Generate Cash Flow reports via Gemini for all complete year pairs
  _setManualUploadProgress(companyId, {
    totalFiles: totalFilesCount,
    processedFiles: processedFilesCount,
    currentFile: "",
    currentStep: "Generating cash flow reports...",
    percentage: 99,
  });
  try {
    const { generateAndSaveCashFlowsForAllYears } = require("./manualCashFlowService");
    const cfGenResult = await generateAndSaveCashFlowsForAllYears(companyId, now);
    console.log(`[Sync] CF generation: ${cfGenResult.generated.length} generated, ${cfGenResult.failed.length} failed`);
    for (const g of (cfGenResult.generated || [])) {
      processed.push({ statementType: "cash_flow", fileName: `CashFlow_${g.year}`, folderName: "Cash Flow" });
    }
    for (const f of (cfGenResult.failed || [])) {
      failed.push({ statementType: "cash_flow", fileName: `CashFlow_${f.year}`, folderName: "Cash Flow", reason: f.reason });
    }
  } catch (cfErr) {
    console.error("[Sync] Cash flow generation error:", cfErr.message);
  }

  try {
    await updateReportSourceRecord(companyId, REPORT_SOURCE_KEYS.MANUAL_UPLOAD, {
      isAvailable: processed.length > 0,
      isConnected: false,
      lastSyncedAt: processed.length > 0 ? now : null,
      metadata: {
        sourceFolderName: SOURCE_FOLDER_NAME,
        syncedReportTypes: Array.from(new Set(processed.map((p) => p.statementType))),
        processedCount: processed.length,
        failedCount: failed.length,
      },
    });
  } catch (e) {
    console.warn("[ManualReportUpload] Failed to update source record:", e.message);
  }

  clearManualDashboardCache(companyId);

  _setManualUploadProgress(companyId, {
    totalFiles: totalFilesCount,
    processedFiles: totalFilesCount,
    currentFile: "",
    currentStep: "Sync completed successfully",
    percentage: 100,
  });
  setTimeout(() => _clearManualUploadProgress(companyId), 5000);

  return {
    sourceFolderName: SOURCE_FOLDER_NAME,
    processedCount: processed.length,
    processed,
    failed,
  };
}

/**
 * Lazily extracts asOfDate from the source binary when it was not saved during sync.
 * Tries: PDF text extraction → Excel row scan → filename regex.
 * If found, patches the qb_synced_reports row so the next call is instant.
 */
async function extractAndCacheReportAsOfDate(reportRow) {
  if (!reportRow?.id) return null;

  const uploadId =
    reportRow?.data?.manual_report_upload?.uploadId ||
    reportRow?.report_params?.uploadId ||
    null;

  if (!uploadId) {
    // Last-resort: year in fileName from report_params
    const fn = String(reportRow?.report_params?.fileName || reportRow?.data?.manual_report_upload?.fileName || "");
    const m = fn.match(/\b(20\d{2})\b/);
    return m ? `${m[1]}-12-31` : null;
  }

  let upload = null;
  try {
    upload = await loadUpload(uploadId);
  } catch {
    return null;
  }

  const buffer = normalizeUploadBinary(upload?.data);
  const fileName = String(upload?.file_name || reportRow?.report_params?.fileName || "");
  const contentType = String(upload?.content_type || "");
  const isPdf =
    fileName.toLowerCase().endsWith(".pdf") ||
    contentType.toLowerCase().includes("pdf");

  let asOfDate = null;

  // PDF: run text extractor then scan header lines
  if (isPdf && buffer?.length) {
    try {
      const lines = await extractPdfLines(buffer);
      asOfDate = extractAsOfDateFromLines(lines);
      // Also try a year-range pattern: "January through December 2023"
      if (!asOfDate) {
        for (const line of lines.slice(0, 40)) {
          const m = line.match(/\b(20\d{2})\b/);
          if (m) { asOfDate = `${m[1]}-12-31`; break; }
        }
      }
    } catch { /* ignore PDF parse failure */ }
  }

  // Excel: scan first rows for year
  if (!asOfDate && !isPdf && buffer?.length) {
    try {
      const rows = extractRowsFromWorkbook(buffer, fileName, contentType);
      for (const row of rows.slice(0, 10)) {
        const text = (Array.isArray(row) ? row : []).map((c) => String(c || "")).join(" ");
        const m = text.match(/\b(20\d{2})\b/);
        if (m) { asOfDate = `${m[1]}-12-31`; break; }
      }
    } catch { /* ignore */ }
  }

  // Filename fallback
  if (!asOfDate) {
    const m = fileName.match(/\b(20\d{2})\b/);
    if (m) asOfDate = `${m[1]}-12-31`;
  }

  // Gemini vision fallback — for image-based PDFs where text extraction fails.
  // Send only the first page bytes with a minimal year-detection prompt.
  if (!asOfDate && isPdf && buffer?.length && process.env.GEMINI_API_KEY) {
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: TAX_GEMINI_MODELS[0] });
      const result = await model.generateContent([
        {
          inlineData: {
            mimeType: "application/pdf",
            data: buffer.toString("base64"),
          },
        },
        "Look at this financial document. What is the fiscal year or reporting period it covers? " +
        "Reply ONLY with a raw JSON object: {\"year\": 2023} — use the END year if it spans multiple years.",
      ]);
      const raw = result.response.text().trim()
        .replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
      const parsed = JSON.parse(raw);
      if (parsed?.year && /^20\d{2}$/.test(String(parsed.year))) {
        asOfDate = `${parsed.year}-12-31`;
        console.log(`[ManualReport] Gemini vision detected year=${parsed.year} for record ${reportRow.id}`);
      }
    } catch (e) {
      console.warn(`[ManualReport] Gemini year fallback failed: ${e.message}`);
    }
  }

  // Patch the stored record so subsequent calls are instant
  if (asOfDate) {
    try {
      const mu = reportRow.data?.manual_report_upload || {};
      const updatedData = {
        ...reportRow.data,
        manual_report_upload: {
          ...mu,
          report: { ...(mu.report || {}), asOfDate },
        },
      };
      await supabase.from("qb_synced_reports").update({ data: updatedData }).eq("id", reportRow.id);
      console.log(`[ManualReport] Lazily patched asOfDate=${asOfDate} for record ${reportRow.id}`);
    } catch (e) {
      console.warn(`[ManualReport] Failed to patch asOfDate: ${e.message}`);
    }
  }

  return asOfDate;
}

async function getQMSUploadSourceTree(companyId) {
  if (!companyId) throw new Error("companyId is required");

  const { data: sourceFolder } = await supabase
    .from("folders")
    .select("id, name")
    .eq("company_id", companyId)
    .is("parent_id", null)
    .ilike("name", QMS_FOLDER_NAME)
    .maybeSingle();

  if (!sourceFolder) return null;

  const { data: children } = await supabase
    .from("folders")
    .select("id, name")
    .eq("parent_id", sourceFolder.id)
    .order("created_at", { ascending: true });

  const result = [];

  for (const child of (children || [])) {
    const nameLower = child.name.toLowerCase().trim();

    if (nameLower === "reports") {
      const { data: reportChildren } = await supabase
        .from("folders")
        .select("id, name")
        .eq("parent_id", child.id)
        .order("created_at", { ascending: true });

      const subItems = await Promise.all((reportChildren || []).map(async (rc) => {
        const { count } = await supabase
          .from("documents")
          .select("id", { count: "exact", head: true })
          .eq("folder_id", rc.id);
        return {
          id: rc.id,
          name: rc.name,
          statementType: SUBFOLDER_STATEMENT_MAP[rc.name.toLowerCase().trim()] || null,
          fileCount: count || 0,
        };
      }));

      result.push({ id: child.id, name: child.name, isGroup: true, children: subItems });
    } else {
      const { count } = await supabase
        .from("documents")
        .select("id", { count: "exact", head: true })
        .eq("folder_id", child.id);

      result.push({
        id: child.id,
        name: child.name,
        statementType: SUBFOLDER_STATEMENT_MAP[nameLower] || null,
        fileCount: count || 0,
        isGroup: false,
      });
    }
  }

  return { id: sourceFolder.id, name: sourceFolder.name, children: result };
}

async function syncQMSUploadSource(companyId) {
  if (!companyId) throw new Error("companyId is required");

  const sourceTree = await getQMSUploadSourceTree(companyId);
  if (!sourceTree) {
    throw new Error(`"${QMS_FOLDER_NAME}" folder not found in DataRoom.`);
  }

  const foldersToSync = [];
  for (const item of sourceTree.children) {
    if (item.isGroup) {
      for (const sub of (item.children || [])) {
        if (sub.statementType) foldersToSync.push({ folder: sub, statementType: sub.statementType });
      }
    } else if (item.statementType) {
      foldersToSync.push({ folder: item, statementType: item.statementType });
    }
  }

  // Pre-count total files across all folders for accurate progress tracking.
  let totalFiles = 0;
  const folderDocCounts = new Map(); // folderId → count
  for (const { folder } of foldersToSync) {
    const { count } = await supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("folder_id", folder.id);
    const n = count || 0;
    folderDocCounts.set(folder.id, n);
    totalFiles += n;
  }

  // Initialize progress store so the polling endpoint can read it immediately.
  _setSyncProgress(companyId, {
    totalFiles,
    processedFiles: 0,
    currentFile: "",
    currentStep: "Starting",
    percentage: 0,
  });

  // Clear all existing QMS records for this company before re-syncing.
  const { error: deleteError } = await supabase
    .from("qb_synced_reports")
    .delete()
    .eq("company_id", companyId)
    .eq("source", QMS_REPORT_UPLOAD_SOURCE);

  if (deleteError) {
    _clearSyncProgress(companyId);
    throw new Error(`Failed to clear QMS records: ${deleteError.message}`);
  }

  const now = new Date().toISOString();
  const processed = [];
  const failed = [];

  // Helper: bump processedFiles counter and recompute percentage.
  const bumpProgress = (fileName, step, count = 1) => {
    const cur = getSyncProgress(companyId);
    if (!cur) return;
    const next = Math.min(cur.processedFiles + count, cur.totalFiles);
    _setSyncProgress(companyId, {
      ...cur,
      processedFiles: next,
      currentFile: fileName || cur.currentFile,
      currentStep: step || cur.currentStep,
      percentage: cur.totalFiles > 0 ? Math.round((next / cur.totalFiles) * 100) : 100,
    });
  };

  for (const { folder, statementType } of foldersToSync) {
    const folderCount = folderDocCounts.get(folder.id) || 0;

    if (statementType === STATEMENT_TYPES.BANK_RECONCILIATION) {
      _setSyncProgress(companyId, {
        ...(getSyncProgress(companyId) || {}),
        currentFile: folder.name,
        currentStep: "Reading bank statements",
      });
      try {
        const bankResult = await syncBankReconciliationFolder(companyId, folder, now, QMS_REPORT_UPLOAD_SOURCE);
        processed.push(...(bankResult.processed || []));
        if (bankResult.failed?.length) {
          failed.push(...bankResult.failed);
        } else if (!bankResult.success && bankResult.reason !== "No files in folder") {
          failed.push({ fileName: folder.name, folderName: folder.name, reason: bankResult.reason || "Bank extraction failed" });
        }
      } catch (err) {
        failed.push({ fileName: folder.name, folderName: folder.name, reason: err.message });
      }
      bumpProgress(folder.name, "Bank statements read", folderCount);
      continue;
    }

    if (statementType === STATEMENT_TYPES.TAX_RETURN) {
      _setSyncProgress(companyId, {
        ...(getSyncProgress(companyId) || {}),
        currentFile: folder.name,
        currentStep: "Reading tax returns",
      });
      try {
        const taxResult = await syncTaxReturnFolder(companyId, folder, now);
        processed.push(...(taxResult.processed || []));
        failed.push(...(taxResult.failed || []));
      } catch (err) {
        failed.push({ fileName: folder.name, folderName: folder.name, reason: err.message });
      }
      bumpProgress(folder.name, "Tax returns read", folderCount);
      continue;
    }

    const { data: documents } = await supabase
      .from("documents")
      .select("id, name, upload_id, file_url")
      .eq("folder_id", folder.id)
      .order("uploaded_at", { ascending: false });

    if (!documents?.length) continue;

    const settlements = await Promise.allSettled(
      documents.map(async (doc) => {
        _setSyncProgress(companyId, {
          ...(getSyncProgress(companyId) || {}),
          currentFile: doc.name,
          currentStep: "Analyzing financial data",
        });

        let upload;
        try {
          upload = await loadUploadForDoc(doc);
        } catch (err) {
          bumpProgress(doc.name, "Failed");
          return { failed: true, documentId: doc.id, fileName: doc.name, folderName: folder.name, reason: err.message };
        }
        // TAX_RETURN and BANK_RECONCILIATION are handled by their own AI-powered
        // sync functions above. The main loop only sees BS/PL/CF — always rule-based.
        const parsed = await parseStoredReport(upload, statementType, { skipAI: true });

        if (!parsed?.report?.rows?.length) {
          bumpProgress(doc.name, "Failed");
          return { failed: true, documentId: doc.id, fileName: doc.name, folderName: folder.name, reason: "No parseable data in file" };
        }

        const resolvedUploadId = upload.id || doc.upload_id || null;

        const { error: insertError } = await supabase
          .from("qb_synced_reports")
          .insert({
            company_id: companyId,
            report_type: statementType,
            report_params: {
              sourceFolderName: QMS_FOLDER_NAME,
              folderId: folder.id,
              folderName: folder.name,
              documentId: doc.id,
              uploadId: resolvedUploadId,
              fileName: doc.name,
            },
            data: {
              manual_report_upload: {
                statementType,
                parserType: parsed.parserType,
                folderId: folder.id,
                folderName: folder.name,
                documentId: doc.id,
                uploadId: resolvedUploadId,
                fileName: doc.name,
                fileUrl: doc.file_url || null,
                report: parsed.report,
                syncedAt: now,
              },
            },
            source: QMS_REPORT_UPLOAD_SOURCE,
            status: "synced",
            last_synced_at: now,
            updated_at: now,
          });

        if (insertError) throw new Error(insertError.message);
        bumpProgress(doc.name, "Done");
        return { failed: false, documentId: doc.id, fileName: doc.name, statementType, folderName: folder.name };
      }),
    );

    for (let i = 0; i < settlements.length; i++) {
      const s = settlements[i];
      if (s.status === "fulfilled") {
        s.value.failed ? failed.push(s.value) : processed.push(s.value);
      } else {
        failed.push({ folderName: folder.name, fileName: documents[i]?.name, reason: s.reason?.message });
        bumpProgress(documents[i]?.name, "Failed");
      }
    }
  }

  try {
    await updateReportSourceRecord(companyId, REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL, {
      isAvailable: processed.length > 0,
      isConnected: false,
      lastSyncedAt: processed.length > 0 ? now : null,
      metadata: {
        sourceFolderName: QMS_FOLDER_NAME,
        syncedReportTypes: Array.from(new Set(processed.map((p) => p.statementType))),
        processedCount: processed.length,
        failedCount: failed.length,
      },
    });
  } catch (e) {
    console.warn("[QMSUpload] Failed to update source record:", e.message);
  }

  clearQMSDashboardCache(companyId);

  // Mark sync as fully complete then clear the progress record after a short
  // window so any in-flight polls can still read the 100% state.
  _setSyncProgress(companyId, {
    totalFiles,
    processedFiles: totalFiles,
    currentFile: "",
    currentStep: "Complete",
    percentage: 100,
  });
  setTimeout(() => _clearSyncProgress(companyId), 3000);

  return {
    sourceFolderName: QMS_FOLDER_NAME,
    processedCount: processed.length,
    processed,
    failed,
  };
}

// Targeted parse: only processes the specific documents that were just uploaded.
// Used by the "Choose Folder" upload flow so we never re-scan the entire QMS folder tree.
// clearFirst=true: wipes all existing QMS synced reports before parsing (used by the Sync button
// so old files from previous sessions are replaced by the current session's uploads).
async function parseAndSaveQMSDocuments(companyId, documents, { clearFirst = false } = {}) {
  if (!companyId) throw new Error("companyId is required");
  if (!Array.isArray(documents) || documents.length === 0) return { processed: [], failed: [] };

  if (clearFirst) {
    const { error: delErr } = await supabase
      .from("qb_synced_reports")
      .delete()
      .eq("company_id", companyId)
      .eq("source", QMS_REPORT_UPLOAD_SOURCE);
    if (delErr) throw new Error(`Failed to clear QMS records: ${delErr.message}`);
  }

  const now = new Date().toISOString();
  const processed = [];
  const failed = [];

  for (const { uploadId, statementType, fileName } of documents) {
    if (!uploadId || !statementType) {
      failed.push({ fileName, reason: "Missing uploadId or statementType" });
      continue;
    }

    // Fetch upload binary
    let upload = null;
    try {
      upload = await loadUploadForDoc({ upload_id: uploadId });
    } catch (err) {
      failed.push({ fileName, reason: `Binary not found: ${err.message}` });
      continue;
    }

    // In QMS mode: only tax_return and bank_statement use AI (Gemini).
    // Balance Sheet, P&L, and Cash Flow always use the rule-based parser.
    const skipAI = !QMS_AI_STATEMENT_TYPES.has(statementType);
    let parsed;
    try {
      parsed = await parseStoredReport(upload, statementType, { skipAI });
    } catch (err) {
      failed.push({ fileName, reason: `Parse error: ${err.message}` });
      continue;
    }

    if (!parsed?.report?.rows?.length) {
      failed.push({ fileName, reason: "No parseable data found in file" });
      continue;
    }

    // When not clearing the whole table first, remove any prior record for this upload
    if (!clearFirst) {
      await supabase
        .from("qb_synced_reports")
        .delete()
        .eq("company_id", companyId)
        .eq("source", QMS_REPORT_UPLOAD_SOURCE)
        .eq("report_type", statementType)
        .filter("report_params->>uploadId", "eq", String(uploadId));
    }

    const resolvedFileName = fileName || upload.file_name;
    const { error: insertError } = await supabase.from("qb_synced_reports").insert({
      company_id: companyId,
      report_type: statementType,
      report_params: { uploadId, fileName: resolvedFileName },
      data: {
        manual_report_upload: {
          statementType,
          parserType: parsed.parserType,
          uploadId,
          fileName: resolvedFileName,
          report: parsed.report,
          syncedAt: now,
        },
      },
      source: QMS_REPORT_UPLOAD_SOURCE,
      status: "synced",
      last_synced_at: now,
      updated_at: now,
    });

    if (insertError) {
      failed.push({ fileName, reason: insertError.message });
      continue;
    }

    processed.push({ fileName, statementType });
  }

  // Update source record availability
  try {
    if (processed.length > 0) {
      await updateReportSourceRecord(companyId, REPORT_SOURCE_KEYS.QUICKBOOKS_MANUAL, {
        isAvailable: true,
        isConnected: false,
        lastSyncedAt: now,
        metadata: {
          sourceFolderName: QMS_FOLDER_NAME,
          syncedReportTypes: Array.from(new Set(processed.map((p) => p.statementType))),
          processedCount: processed.length,
          failedCount: failed.length,
        },
      });
    }
  } catch (e) {
    console.warn("[QMSUpload] Failed to update source record:", e.message);
  }

  clearQMSDashboardCache(companyId);

  return { processed, failed, processedCount: processed.length };
}

// ── QMS + Manual Upload Dashboard: parse + aggregate ─────────────────────────

const _qmsDashboardCache = new Map();
const _manualDashboardCache = new Map();
const DASHBOARD_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function clearQMSDashboardCache(companyId) {
  if (companyId) { _qmsDashboardCache.delete(companyId); } else { _qmsDashboardCache.clear(); }
}
function clearManualDashboardCache(companyId) {
  if (companyId) { _manualDashboardCache.delete(companyId); } else { _manualDashboardCache.clear(); }
}

function _lcStr(s) { return String(s || "").toLowerCase().trim(); }

// Strips "total for " and "total " prefixes so "Total for Income" → "income" matches "total income" → "income".
function _normalizeName(s) {
  return _lcStr(s)
    .replace(/^total\s+for\s+/, "")
    .replace(/^total\s+/, "")
    .replace(/['']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function _flattenQMSRows(rows) {
  const out = [];
  function walk(items) {
    for (const item of (Array.isArray(items) ? items : [])) {
      if (item && typeof item === "object") {
        out.push(item);
        if (Array.isArray(item.children)) walk(item.children);
      }
    }
  }
  walk(rows);
  return out;
}

/**
 * Five-tier search (stops at first hit):
 *  T1 — exact name on type:total
 *  T2 — normalized name on type:total   (handles "Total for Income" → "income")
 *  T3 — normalized name on type:header  (section nodes hold computed totals)
 *  T4 — substring includes on type:total
 *  T5 — substring includes on any type  (last resort)
 */
function _findQMSAmount(flat, namePhrases) {
  const phrases = namePhrases.map(_lcStr);
  const normPhrases = namePhrases.map(_normalizeName);

  for (const phrase of phrases) {
    const r = flat.find((f) => f.type === "total" && _lcStr(f.name) === phrase);
    if (r !== undefined) return parseFloat(r.amount) || 0;
  }
  for (const normPhrase of normPhrases) {
    if (!normPhrase) continue;
    const r = flat.find((f) => f.type === "total" && _normalizeName(f.name) === normPhrase);
    if (r !== undefined) return parseFloat(r.amount) || 0;
  }
  for (const normPhrase of normPhrases) {
    if (!normPhrase) continue;
    const r = flat.find((f) => f.type === "header" && _normalizeName(f.name) === normPhrase);
    if (r !== undefined) return parseFloat(r.amount) || 0;
  }
  for (const phrase of phrases) {
    if (!phrase) continue;
    const r = flat.find((f) => {
      if (f.type !== "total") return false;
      const name = _lcStr(f.name);
      if (!name.includes(phrase)) return false;
      const extra = name.replace(phrase, "").trim();
      return !extra || !/\w/.test(extra);
    });
    if (r !== undefined) return parseFloat(r.amount) || 0;
  }
  for (const phrase of phrases) {
    if (!phrase) continue;
    const r = flat.find((f) => {
      const name = _lcStr(f.name);
      if (!name.includes(phrase)) return false;
      const extra = name.replace(phrase, "").trim();
      return !extra || !/\w/.test(extra);
    });
    if (r !== undefined) return parseFloat(r.amount) || 0;
  }
  return 0;
}

function _extractKPIsFromQMSRows(bsRows, plRows, debugLabel = "") {
  const bsFlat = _flattenQMSRows(bsRows);
  const plFlat = _flattenQMSRows(plRows);

  const totalRevenue = _findQMSAmount(plFlat, ["total income", "total revenue", "total sales", "total ordinary income", "income", "revenue"]);
  const rawExpenses = _findQMSAmount(plFlat, ["total expenses", "total expense", "total operating expenses", "expenses", "operating expenses"]);
  const totalExpenses = Math.abs(rawExpenses);
  const netProfitRaw = _findQMSAmount(plFlat, ["net income", "net profit", "net loss", "net earnings", "net income loss"]);
  const netProfit = netProfitRaw !== 0 ? netProfitRaw : totalRevenue - totalExpenses;

  const totalAssets = _findQMSAmount(bsFlat, ["total assets", "assets"]);
  const totalLiabilities = _findQMSAmount(bsFlat, ["total liabilities", "liabilities"]);
  const totalEquity = _findQMSAmount(bsFlat, ["total equity", "total stockholders equity", "total shareholders equity", "total owners equity", "equity", "stockholders equity", "shareholders equity", "owners equity"]);
  const currentAssets = _findQMSAmount(bsFlat, ["total current assets", "current assets"]);
  const currentLiabilities = _findQMSAmount(bsFlat, ["total current liabilities", "current liabilities"]);
  const cashAndBankBalance = _findQMSAmount(bsFlat, ["total bank accounts", "total cash and cash equivalents", "total cash and bank", "total cash", "bank accounts", "cash and cash equivalents"]);
  const accountsReceivable = _findQMSAmount(bsFlat, ["total accounts receivable", "total accounts receivable a r", "accounts receivable a r", "accounts receivable"]);
  const inventoryValue = _findQMSAmount(bsFlat, ["total inventory", "inventory asset", "inventory"]);
  const accountsPayable = _findQMSAmount(bsFlat, ["total accounts payable", "total accounts payable a p", "accounts payable a p", "accounts payable"]);
  const longTermDebt = _findQMSAmount(bsFlat, ["total long-term liabilities", "total long term liabilities", "long-term liabilities", "long term liabilities", "notes payable", "long-term debt"]);
  const workingCapital = currentAssets && currentLiabilities
    ? currentAssets - currentLiabilities
    : cashAndBankBalance + accountsReceivable + inventoryValue - accountsPayable;

  if (debugLabel) {
    console.log(
      `[QB-MANUAL] ${debugLabel}\n` +
      `  Revenue=$${totalRevenue} Expenses=$${totalExpenses} NetProfit=$${netProfit}\n` +
      `  Assets=$${totalAssets} Liabilities=$${totalLiabilities} Equity=$${totalEquity}\n` +
      `  WorkingCapital=$${workingCapital} Cash=$${cashAndBankBalance}\n` +
      `  AR=$${accountsReceivable} AP=$${accountsPayable} LTDebt=$${longTermDebt}`
    );
  }

  return { totalRevenue, totalExpenses, netProfit, totalAssets, totalLiabilities, totalEquity, workingCapital, cashAndBankBalance, accountsReceivable, inventoryValue, accountsPayable, longTermDebt };
}

function _extractYearFromQMSRecord(row) {
  const report = row.data?.manual_report_upload?.report;
  const tryYear = (value) => {
    if (!value) return null;
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d.getFullYear();
    const bareYear = String(value).match(/^(\d{4})$/);
    if (bareYear) return parseInt(bareYear[1], 10);
    return null;
  };
  const fromPeriodEnd = tryYear(report?.periodEnd); if (fromPeriodEnd) return fromPeriodEnd;
  const fromPeriodStart = tryYear(report?.periodStart); if (fromPeriodStart) return fromPeriodStart;
  const fromAsOfDate = tryYear(report?.asOfDate); if (fromAsOfDate) return fromAsOfDate;
  const fileName = row.report_params?.fileName || "";
  const match = fileName.match(/\b(20\d{2}|19\d{2})\b/);
  if (match) return parseInt(match[1], 10);
  return null;
}

function _pickLatestRecord(records) {
  if (!records || records.length === 0) return null;
  return records.reduce((best, cur) => {
    const bestTs = new Date(best.updated_at || best.last_synced_at || 0).getTime();
    const curTs = new Date(cur.updated_at || cur.last_synced_at || 0).getTime();
    return curTs > bestTs ? cur : best;
  });
}

function _buildDashboardPayload(annotatedBS, annotatedPL, logPrefix) {
  const groupByYear = (records) => {
    const map = new Map();
    for (const r of records) {
      if (r._year == null) continue;
      const existing = map.get(r._year);
      if (!existing) { map.set(r._year, [r]); } else { existing.push(r); }
    }
    const resolved = new Map();
    for (const [year, list] of map) resolved.set(year, _pickLatestRecord(list));
    return resolved;
  };

  const bsByYear = groupByYear(annotatedBS);
  const plByYear = groupByYear(annotatedPL);
  const allYears = Array.from(new Set([...bsByYear.keys(), ...plByYear.keys()])).sort((a, b) => b - a);

  const reports = {};
  for (const year of allYears) {
    const bsRecord = bsByYear.get(year) || null;
    const plRecord = plByYear.get(year) || null;
    const bsReport = bsRecord?.data?.manual_report_upload?.report || null;
    const plReport = plRecord?.data?.manual_report_upload?.report || null;
    const warnings = [];
    if (!bsReport) warnings.push(`Balance Sheet missing for ${year}`);
    if (!plReport) warnings.push(`Profit & Loss missing for ${year}`);
    const kpis = _extractKPIsFromQMSRows(bsReport?.rows || [], plReport?.rows || []);

    const bsFileName = bsRecord?.report_params?.fileName || "(none)";
    const plFileName = plRecord?.report_params?.fileName || "(none)";
    const _srcDisplay = logPrefix === "MANUAL DASHBOARD" ? "Manual Upload" : logPrefix === "QB-MANUAL" ? "QuickBooks Manual" : logPrefix;
    console.log(
      `[${logPrefix}] Active Source=${_srcDisplay} Year=${year} Files Read: ${bsFileName} ${plFileName} ` +
      `Revenue=${kpis.totalRevenue} Expenses=${kpis.totalExpenses} NetProfit=${kpis.netProfit} ` +
      `Assets=${kpis.totalAssets} Liabilities=${kpis.totalLiabilities} Equity=${kpis.totalEquity} ` +
      `Cash=${kpis.cashAndBankBalance} AR=${kpis.accountsReceivable} AP=${kpis.accountsPayable} LTDebt=${kpis.longTermDebt}`
    );

    reports[String(year)] = {
      year: String(year),
      balanceSheet: bsReport ? { rowId: bsRecord.id, fileName: bsRecord.report_params?.fileName || null, folderName: bsRecord.report_params?.folderName || null, asOfDate: bsReport.asOfDate || null, periodStart: bsReport.periodStart || null, periodEnd: bsReport.periodEnd || null, updatedAt: bsRecord.updated_at || null } : null,
      profitLoss: plReport ? { rowId: plRecord.id, fileName: plRecord.report_params?.fileName || null, folderName: plRecord.report_params?.folderName || null, asOfDate: plReport.asOfDate || null, periodStart: plReport.periodStart || null, periodEnd: plReport.periodEnd || null, updatedAt: plRecord.updated_at || null } : null,
      kpis,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  const latestBS = _pickLatestRecord(annotatedBS);
  const latestPL = _pickLatestRecord(annotatedPL);
  const allFilesKpis = _extractKPIsFromQMSRows(
    latestBS?.data?.manual_report_upload?.report?.rows || [],
    latestPL?.data?.manual_report_upload?.report?.rows || [],
  );
  const allFilesWarnings = [];
  if (!latestBS) allFilesWarnings.push("No Balance Sheet files found");
  if (!latestPL) allFilesWarnings.push("No Profit & Loss files found");

  const trends = [...allYears].reverse().map((year) => {
    const plReport = plByYear.get(year)?.data?.manual_report_upload?.report || null;
    const plFlat = _flattenQMSRows(plReport?.rows || []);
    const revenue = _findQMSAmount(plFlat, ["total income", "total revenue", "total sales", "total ordinary income", "income", "revenue"]);
    const rawExpenses = _findQMSAmount(plFlat, ["total expenses", "total expense", "total operating expenses", "expenses", "operating expenses"]);
    const expenses = Math.abs(rawExpenses);
    const netProfitRaw = _findQMSAmount(plFlat, ["net income", "net profit", "net loss", "net earnings", "net income loss"]);
    const netProfit = netProfitRaw !== 0 ? netProfitRaw : revenue - expenses;
    return { year: String(year), revenue, expenses, netProfit };
  });

  return {
    years: ["All Files", ...allYears.map(String)],
    reports,
    allFiles: { year: "All Files", kpis: allFilesKpis, ...(allFilesWarnings.length > 0 ? { warnings: allFilesWarnings } : {}) },
    trends,
  };
}

async function buildQMSDashboardData(companyId) {
  if (!companyId) throw new Error("companyId is required");
  const cached = _qmsDashboardCache.get(companyId);
  if (cached && Date.now() < cached.expiresAt) { console.log(`[QMSDashboard] Cache hit for ${companyId}`); return cached.data; }
  console.log(`[QMSDashboard] Building for ${companyId}`);
  const [bsRecords, plRecords] = await Promise.all([
    getAllQMSUploadedReports({ companyId, statementType: STATEMENT_TYPES.BALANCE_SHEET }),
    getAllQMSUploadedReports({ companyId, statementType: STATEMENT_TYPES.PROFIT_AND_LOSS }),
  ]);
  const annotate = (records) => records.map((r) => ({ ...r, _year: _extractYearFromQMSRecord(r) }));
  const result = _buildDashboardPayload(annotate(bsRecords), annotate(plRecords), "QB-MANUAL");
  _qmsDashboardCache.set(companyId, { data: result, expiresAt: Date.now() + DASHBOARD_CACHE_TTL_MS });
  console.log(`[QMSDashboard] Built for ${companyId} — years: ${result.years.slice(1).join(", ") || "(none)"}`);
  return result;
}

async function buildManualUploadDashboardData(companyId) {
  if (!companyId) throw new Error("companyId is required");
  const cached = _manualDashboardCache.get(companyId);
  if (cached && Date.now() < cached.expiresAt) { console.log(`[MANUAL DASHBOARD] Cache hit for ${companyId}`); return cached.data; }
  console.log(`[MANUAL DASHBOARD] Building for ${companyId}`);
  const [bsRecords, plRecords] = await Promise.all([
    getAllManualUploadedReports({ companyId, statementType: STATEMENT_TYPES.BALANCE_SHEET }),
    getAllManualUploadedReports({ companyId, statementType: STATEMENT_TYPES.PROFIT_AND_LOSS }),
  ]);
  const annotate = (records) => records.map((r) => ({ ...r, _year: _extractYearFromQMSRecord(r) }));
  const result = _buildDashboardPayload(annotate(bsRecords), annotate(plRecords), "MANUAL DASHBOARD");
  _manualDashboardCache.set(companyId, { data: result, expiresAt: Date.now() + DASHBOARD_CACHE_TTL_MS });
  console.log(`[MANUAL DASHBOARD] Built for ${companyId} — years: ${result.years.slice(1).join(", ") || "(none)"}`);
  return result;
}

module.exports = {
  MANUAL_REPORT_UPLOAD_SOURCE,
  STATEMENT_TYPES,
  syncManualReportFolder,
  syncManualUploadSource,
  getManualUploadSourceTree,
  getQMSUploadSourceTree,
  syncQMSUploadSource,
  parseAndSaveQMSDocuments,
  getSyncProgress,
  getManualUploadProgress,
  getLatestManualUploadedReport,
  getAllManualUploadedReports,
  getLatestQMSUploadedReport,
  getAllQMSUploadedReports,
  extractAndCacheReportAsOfDate,
  extractTaxDataFromBuffer,
  extractTaxDataWithVerification,
  // Tax returns are a GEMINI-ONLY document type — see the block comment above
  // extractTaxDataFromBuffer. These decide whether a file can be sent to Gemini
  // at all, and explain to the user when it cannot, instead of any caller quietly
  // handing the file to a table reader.
  TAX_DOCUMENT_MIME_TYPES,
  resolveTaxDocumentMime,
  unreadableTaxDocumentReason,
  looksLikeTaxReturn,
  validateTaxExtraction,
  clearTaxExtractCache,
  buildTaxReturnResponseData,
  canonicalizeReconLabel,
  canonicalizeReconcilingData,
  syncTaxReturnFolder,
  extractPLForTax,
  buildPLForTaxData,
  syncPLForTaxFolder,
  extractPLLineItemsFromRows,
  buildQMSDashboardData,
  clearQMSDashboardCache,
  buildManualUploadDashboardData,
  clearManualDashboardCache,
  processDocumentMapping,
};
