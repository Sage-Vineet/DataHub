// ============================================================================
// COA ACCOUNT CLASSIFIER  (Key Reports — deterministic, accounting-aware)
//
// Replaces the old asset-first single-keyword `inferAccountType` for the Chart
// of Accounts engine. It evaluates MULTIPLE signals in accounting-correct
// priority order instead of matching one keyword, and it is:
//   • deterministic  — same input → same output, no network
//   • explainable    — every decision returns a `reason`
//   • extensible     — ordered rule tiers; add a tier without touching others
//   • generic        — no company-specific names
//
// Output type is the system's 6-type model (asset|liability|equity|income|
// cogs|expense) so the rest of the pipeline (statementTypeFor, GROUP_DEFS,
// coaHierarchyRules) is unchanged.
//
// PRIORITY (first match wins) — the core of the refactor:
//   0. Balance-Sheet section (from an uploaded BS)      — authoritative
//   1. Explicit account_type (from a typed source)       — authoritative
//   2. Equity phrases (retained earnings, net income, …) — before income/expense
//   3. Cost of Goods Sold phrases
//   4. Prepaid* → asset ; Accrued* → liability ; Accumulated depreciation → asset
//   5. Direction: "…to / due from / receivable" → asset ; "…from / payable / due to" → liability
//   6. Generic "loan/mortgage/note" (no direction)      → liability
//   7. Ambiguous nouns resolved BY CONTEXT:
//        credit card  → payable? liability : charge/fee/bill/interest/expense? expense : liability(card)
//        bank         → charge/fee/service/expense? expense : asset
//        vehicle/car/truck → ownership-only? asset : expense
//   8. Fixed-asset nouns (equipment, building, land, …) without rental/lease/expense → asset
//   9. Liquid-asset nouns (cash, checking, inventory, prepaid, receivable, …)        → asset
//  10. Revenue phrases                                   → income
//  11. Expense phrases / "…charges|fees|expense|cost"    → expense
//  12. Liability nouns (debt, note, obligation)          → liability
//  13. Normal balance (if known): debit → expense ; credit → income
//  14. Account-number range (1..8)
//  15. Default → expense
// ============================================================================

"use strict";

const BS_TYPES = new Set(["asset", "liability", "equity"]);

function statementTypeFor(accountType) {
  return BS_TYPES.has(accountType) ? "balance_sheet" : "profit_loss";
}

// Normalize a name for matching: lowercase, "&"→"and", keep "/" (a/r, w/), collapse space.
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/['’`]/g, "")        // drop apostrophes so "owner's" → "owners"
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9/\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeType(type) {
  if (!type) return "";
  const t = String(type).toLowerCase().trim();
  if (t.includes("cogs") || t.includes("cost of goods") || t.includes("cost of sales")) return "cogs";
  if (t.includes("asset")) return "asset";
  if (t.includes("liabilit")) return "liability";
  if (t.includes("equity")) return "equity";
  if (t.includes("revenue") || t.includes("income")) return "income";
  if (t.includes("expense")) return "expense";
  return "";
}

function sectionType(section) {
  const s = String(section || "").toLowerCase();
  if (!s) return "";
  // A combined "Liabilities & Equity" header can't disambiguate on its own — skip it.
  if (s.includes("liabilit") && s.includes("equity")) return "";
  if (s.includes("asset")) return "asset";
  if (s.includes("liabilit")) return "liability";
  if (s.includes("equity")) return "equity";
  return "";
}

// ── Signal vocabularies ──────────────────────────────────────────────────────

// Equity — checked FIRST so "Net Income" is equity, never income/expense.
const EQUITY_RE =
  /\b(retained earnings|net income|net loss|current year (?:net )?(?:income|earnings)|prior year earnings|owner'?s? equity|owners equity|member'?s? (?:equity|capital)|partner'?s? (?:equity|capital)|shareholders? equity|stockholders? equity|capital stock|common stock|preferred stock|treasury stock|paid.?in capital|contributed capital|capital contribution|capital account|owner'?s? (?:draw|drawings?|capital)|drawings?|distributions?|dividends? (?:paid|declared)|opening balance equity)\b/;

const COGS_RE =
  /\b(cost of goods sold|cost of goods|cost of sales|cogs|direct costs?|direct labor|direct materials?|freight in|purchases)\b/;

// Direction: receivable (asset) vs payable (liability).
const RECEIVABLE_DIR_RE =
  /\b(loans? to|advances? to|due from|receivable from|notes? receivable|loans? receivable|accounts? receivable|a\/r|(?:employee|director|officer|shareholder|member|intercompany|related party) (?:loan|advance|receivable))\b|\breceivable\b/;
const PAYABLE_DIR_RE =
  /\b(payable|loans? from|due to|notes? payable|line of credit|lines? of credit|customer deposits?|deposits? held|unearned|deferred revenue|deferred income|sales tax payable|payroll liabilit(?:y|ies)|accrued)\b|\baccounts? payable\b|\ba\/p\b/;

// Generic borrowing (no explicit direction) → liability.
const LOAN_GENERIC_RE = /\b(loans?|mortgages?|notes?\b|debt|borrowings?|bonds? payable)\b/;

// Ambiguous nouns.
const CREDIT_CARD_RE = /\b(credit cards?|cc|visa|mastercard|master card|amex|american express|discover card)\b/;
const BANK_RE = /\bbank\b/;
const VEHICLE_RE = /\b(vehicles?|cars?|trucks?|auto|autos|automobiles?|motor)\b/;
const VEHICLE_OWNERSHIP_RE =
  /\b(vehicles|fleet|motor vehicles?|company vehicles?|transportation equipment|delivery (?:vehicles?|trucks?))\b/;

// Expense context that flips an ambiguous BS-ish noun into an expense.
const EXPENSE_CTX_RE =
  /\b(charges?|fees?|expenses?|costs?|interest|service charge|finance charge|bill|billing|fuel|gas|gasoline|repairs?|maintenance|insurance|registration|lease|rental|mileage|dues|subscriptions?)\b/;

// Fixed-asset nouns (ownership) — asset unless rental/lease/expense context.
const FIXED_ASSET_RE =
  /\b(equipment|machinery|furniture|fixtures?|buildings?|land|leasehold improvements?|goodwill|intangibles?|investments?|marketable securities|property|leasehold)\b/;
const RENTAL_LEASE_RE = /\b(rent|rental|lease|expense|charges?|fees?)\b/;

// Liquid / current asset nouns.
const LIQUID_ASSET_RE =
  /\b(cash|checking|savings|money market|petty cash|undeposited funds?|inventory|stock on hand|prepaid|prepayments?|certificate of deposit|deposits? in transit|escrow)\b/;

// Revenue.
const REVENUE_RE =
  /\b(sales|revenue|service income|services income|interest income|dividend income|rental income|royalty income|gain on|other income|fees earned|fee income|earned income)\b|\bincome$/;

// Contra-revenue (reduces revenue) → belongs in the INCOME section, not expenses:
// refunds/discounts given, refunds to customers, sales returns, returns & allowances,
// chargebacks, comps. Excluded when clearly a purchase/vendor/expense/COGS context
// (e.g. "Purchase Discounts" is contra-COGS, "Discount Expense" is an expense).
const CONTRA_REVENUE_RE =
  /\b(refunds?|discounts?|sales returns?|returns and allowances|chargebacks?|comps)\b/;
const CONTRA_REVENUE_EXCLUDE_RE = /\b(purchase|vendor|supplier|expense|cost of|payroll|merchant)\b/;

// Expense (generic) — suffix/word form. Checked late so BS nouns win first.
const EXPENSE_RE =
  /\b(expenses?|charges?|fees?|rent|rental|lease|utilit(?:y|ies)|payroll|salar(?:y|ies)|wages?|benefits?|advertising|marketing|promotion|travel|meals?|entertainment|depreciation|amortization|licenses?|legal|accounting|professional fees?|telephone|phone|internet|postage|freight|shipping|supplies|repairs?|maintenance|insurance|fuel|gas|gasoline|mileage|registration|dues|subscriptions?|training|education|seminars?|penalt(?:y|ies)|fine|bad debt|interest expense|service charge|finance charge|bank charge|tax expense|payroll tax)\b/;

// Contra / special.
const PREPAID_RE = /\bprepaid|prepayments?\b/;
const ACCRUED_RE = /\baccrued\b/;
const ACCUM_DEP_RE = /\baccumulated (?:depreciation|amortization)\b|\ballowance for (?:doubtful|bad)\b/;

// Liability nouns (last-resort).
const LIABILITY_NOUN_RE = /\b(liabilit(?:y|ies)|obligations?|debt|note|payable)\b/;

function byNumber(num) {
  const n = String(num || "").trim();
  if (!n) return "";
  if (n.startsWith("1")) return "asset";
  if (n.startsWith("2")) return "liability";
  if (n.startsWith("3")) return "equity";
  if (n.startsWith("4")) return "income";
  if (n.startsWith("5")) return "cogs";
  if (/^[678]/.test(n)) return "expense";
  return "";
}

/**
 * Classify one account. Pure + deterministic.
 * @param {object} a
 *   accountName   {string}
 *   accountNumber {string}   optional GL number
 *   bsSection     {string}   uploaded Balance Sheet section (authoritative when present)
 *   explicitType  {string}   account_type from a typed source (authoritative when present)
 *   normalBalance {'debit'|'credit'|''}  optional GL normal-balance signal
 * @returns {{accountType:string, statementType:string, reason:string}}
 */
function classifyAccount(a = {}) {
  const name = norm(a.accountName);
  const num = String(a.accountNumber || "");

  const done = (type, reason) => ({ accountType: type, statementType: statementTypeFor(type), reason });

  // 0 — Balance Sheet section is authoritative.
  const sec = sectionType(a.bsSection);
  if (sec) return done(sec, "balance_sheet_section");

  // 1 — Explicit account_type from a typed source.
  const explicit = normalizeType(a.explicitType);
  if (explicit) return done(explicit, "explicit_type");

  if (!name) return done("expense", "empty_name_default");

  // 2 — Equity phrases (before income/expense so "Net Income" is equity).
  if (EQUITY_RE.test(name)) return done("equity", "equity_phrase");

  // 3 — COGS.
  if (COGS_RE.test(name)) return done("cogs", "cogs_phrase");

  // 4 — Prepaid / accrued / contra prefixes (unambiguous).
  if (ACCUM_DEP_RE.test(name)) return done("asset", "contra_asset");
  if (PREPAID_RE.test(name)) return done("asset", "prepaid_asset");
  if (ACCRUED_RE.test(name) && !RECEIVABLE_DIR_RE.test(name)) return done("liability", "accrued_liability");

  // 5 — Direction: receivable (asset) vs payable (liability).
  const recv = RECEIVABLE_DIR_RE.test(name);
  const pay = PAYABLE_DIR_RE.test(name);
  if (recv && !pay) return done("asset", "receivable_direction");
  if (pay && !recv) return done("liability", "payable_direction");

  // 6/7 — Ambiguous nouns resolved by context.
  //   Credit card: payable → liability; charge/fee/bill/interest/expense → expense; else the card = liability.
  if (CREDIT_CARD_RE.test(name)) {
    if (/\bpayable\b/.test(name)) return done("liability", "credit_card_payable");
    if (EXPENSE_CTX_RE.test(name)) return done("expense", "credit_card_expense");
    return done("liability", "credit_card_account");
  }
  //   Generic borrowing with no direction (e.g. "Bank Loan", "Mortgage", "Note Payable") → liability.
  //   Checked before the bank/asset nouns so "Bank Loan" is a liability, not an asset.
  if (LOAN_GENERIC_RE.test(name) && !EXPENSE_CTX_RE.test(name)) return done("liability", "borrowing");
  //   Bank: with a charge/fee/service/expense context → expense; otherwise the bank account = asset.
  if (BANK_RE.test(name)) {
    if (EXPENSE_CTX_RE.test(name)) return done("expense", "bank_expense");
    return done("asset", "bank_account");
  }
  //   Vehicle: ownership nouns only → asset; anything else (fuel, repairs, "Car & Truck", …) → expense.
  if (VEHICLE_RE.test(name) || VEHICLE_OWNERSHIP_RE.test(name)) {
    if (VEHICLE_OWNERSHIP_RE.test(name) && !EXPENSE_CTX_RE.test(name)) return done("asset", "vehicle_ownership");
    return done("expense", "vehicle_expense");
  }

  // 8 — Fixed-asset nouns (ownership) unless rental/lease/expense context.
  if (FIXED_ASSET_RE.test(name) && !RENTAL_LEASE_RE.test(name)) return done("asset", "fixed_asset_noun");

  // 9 — Liquid / current asset nouns.
  if (LIQUID_ASSET_RE.test(name)) return done("asset", "liquid_asset_noun");

  // 9.5 — Contra-revenue (discounts/refunds/returns) → Income section.
  if (CONTRA_REVENUE_RE.test(name) && !CONTRA_REVENUE_EXCLUDE_RE.test(name)) {
    return done("income", "contra_revenue");
  }

  // 10 — Revenue.
  if (REVENUE_RE.test(name)) return done("income", "revenue_phrase");

  // 11 — Expense (generic).
  if (EXPENSE_RE.test(name)) return done("expense", "expense_phrase");

  // 12 — Liability nouns (last-resort noun match).
  if (LIABILITY_NOUN_RE.test(name)) return done("liability", "liability_noun");

  // 13 — Normal balance signal.
  const nb = String(a.normalBalance || "").toLowerCase();
  if (nb === "debit") return done("expense", "normal_balance_debit");
  if (nb === "credit") return done("income", "normal_balance_credit");

  // 14 — Account-number range.
  const byNum = byNumber(num);
  if (byNum) return done(byNum, "account_number_range");

  // 15 — Default.
  return done("expense", "default_expense");
}

module.exports = {
  classifyAccount,
  statementTypeFor,
  sectionType,
  normalizeType,
  // exported for unit tests
  norm,
};
