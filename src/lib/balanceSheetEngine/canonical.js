// Canonical accounting vocabulary for the Balance Sheet Normalization Engine.
//
// This file is pure data: section/category definitions, ERP-agnostic type and
// subtype keyword tables, contra-account signatures, and structural (wrapper)
// synonym lists. No tree logic and no classification logic lives here — see
// treeWalk.js (structural inference) and classifiers.js (per-account layers).
//
// Every category also declares which accounting SUBSECTION it belongs to
// (current | noncurrent | longterm | null-for-equity). That single fact drives
// both grouping AND presentation order, so "where does this category sit" is
// never decided twice.

export const SECTION = Object.freeze({
  ASSETS: "assets",
  LIABILITIES: "liabilities",
  EQUITY: "equity",
});

export const SUBSECTION = Object.freeze({
  CURRENT: "current",
  NONCURRENT: "noncurrent",
  LONGTERM: "longterm",
});

// ─── Structural (wrapper) recognition — used to walk the tree, never to ────
// ─── classify an individual account.                                    ───

export const ASSETS_ROOT_SYNONYMS = ["assets", "asset"];
export const LIABILITIES_ROOT_SYNONYMS = ["liabilities", "liability"];
export const EQUITY_ROOT_SYNONYMS = [
  "equity",
  "stockholders equity",
  "stockholder s equity",
  "shareholders equity",
  "shareholder s equity",
  "owners equity",
  "owner s equity",
  "members equity",
  "partners equity",
  "capital and reserves",
  "shareholders funds",
  "net assets",
];

export const CURRENT_ASSETS_WRAPPER_SYNONYMS = ["current assets"];
export const NONCURRENT_ASSETS_WRAPPER_SYNONYMS = [
  "non current assets",
  "noncurrent assets",
  "fixed assets",
  "long term assets",
  "other assets",
];
export const CURRENT_LIABILITIES_WRAPPER_SYNONYMS = ["current liabilities"];
export const LONGTERM_LIABILITIES_WRAPPER_SYNONYMS = [
  "long term liabilities",
  "noncurrent liabilities",
  "non current liabilities",
  "other liabilities",
];

// ─── Category definitions (mandated presentation order within each ────────
// ─── subsection). `lexicon` is the LAST-RESORT (Layer 11) name matcher —  ───
// ─── `subtypeKeywords` are checked far earlier (Layer 4), against a       ───
// ─── structured account-subtype FIELD, never the free-text display name. ───

export const ASSET_CATEGORIES = [
  {
    label: "Cash & Cash Equivalents",
    subsection: SUBSECTION.CURRENT,
    subtypeKeywords: ["cashonhand", "pettycash", "cashequivalent", "cashinhand", "cash"],
    lexicon: [/^cash$/i, /^cash and cash equivalents$/i, /petty cash/i, /cash equivalent/i, /cash on hand/i, /cash in hand/i],
  },
  {
    label: "Bank Accounts",
    subsection: SUBSECTION.CURRENT,
    subtypeKeywords: ["checking", "savings", "moneymarket", "bank", "trustaccount", "undepositedfunds"],
    lexicon: [/bank account/i, /\bchecking\b/i, /\bsavings\b/i, /money market/i, /^bank$/i, /current account/i, /trust account/i],
  },
  {
    label: "Accounts Receivable",
    subsection: SUBSECTION.CURRENT,
    subtypeKeywords: ["accountsreceivable", "tradereceivable", "debtors", "billsreceivable"],
    lexicon: [/accounts?\s*receivable/i, /\ba\/?r\b/i, /trade receivables?/i, /\bdebtors?\b/i, /bills receivable/i, /sundry debtors/i, /customer receivable/i],
  },
  {
    label: "Inventory",
    subsection: SUBSECTION.CURRENT,
    subtypeKeywords: ["inventory", "stock"],
    lexicon: [/inventory/i, /stock[- ]?in[- ]?hand/i, /merchandise/i, /stock on hand/i],
  },
  {
    label: "Prepaid Expenses",
    subsection: SUBSECTION.CURRENT,
    subtypeKeywords: ["prepaidexpenses", "prepayments"],
    lexicon: [/prepaid/i, /prepayment/i],
  },
  {
    label: "Accrued Revenue",
    subsection: SUBSECTION.CURRENT,
    subtypeKeywords: ["accruedrevenue", "unbilledrevenue", "contractasset"],
    lexicon: [/accrued revenue/i, /unbilled revenue/i, /contract asset/i],
  },
  {
    label: "Other Current Assets",
    subsection: SUBSECTION.CURRENT,
    subtypeKeywords: ["othercurrentasset"],
    lexicon: [/other current asset/i],
  },
  {
    label: "Property Plant Equipment",
    subsection: SUBSECTION.NONCURRENT,
    subtypeKeywords: ["land", "buildings", "leaseholdimprovements", "propertyplantequipment"],
    lexicon: [/property.*plant.*equipment/i, /\bpp&e\b/i, /^property$/i, /real estate/i, /^land$/i, /^building/i, /leasehold improvement/i],
  },
  {
    label: "Fixed Assets",
    subsection: SUBSECTION.NONCURRENT,
    subtypeKeywords: ["furniturefixtures", "machineryequipment", "vehicles", "otherfixedasset", "accumulateddepreciation"],
    lexicon: [/fixed asset/i, /furniture/i, /^equipment$/i, /vehicle/i, /machinery/i, /accumulated depreciation/i, /plant and machinery/i],
  },
  {
    label: "Investments",
    subsection: SUBSECTION.NONCURRENT,
    subtypeKeywords: ["investment", "longterminvestment"],
    lexicon: [/investment/i],
  },
  {
    label: "Security Deposits",
    subsection: SUBSECTION.NONCURRENT,
    subtypeKeywords: ["securitydeposit"],
    lexicon: [/security deposit/i, /rental deposit/i],
  },
  {
    label: "Intangible Assets",
    subsection: SUBSECTION.NONCURRENT,
    subtypeKeywords: ["intangibleasset", "goodwill"],
    lexicon: [/intangible/i, /goodwill/i, /patent/i, /trademark/i, /software licen[sc]e/i],
  },
  {
    label: "Deferred Tax Assets",
    subsection: SUBSECTION.NONCURRENT,
    subtypeKeywords: ["deferredtaxasset"],
    lexicon: [/deferred tax asset/i],
  },
  {
    label: "Other Non-Current Assets",
    subsection: SUBSECTION.NONCURRENT,
    subtypeKeywords: ["otherasset", "otherlongtermasset", "notesreceivablelongterm"],
    lexicon: [/other (non.?current|long.?term) asset/i, /^other asset/i, /notes? receivable/i],
  },
];

export const LIABILITY_CATEGORIES = [
  {
    label: "Accounts Payable",
    subsection: SUBSECTION.CURRENT,
    subtypeKeywords: ["accountspayable", "tradepayable", "creditors", "billspayable"],
    lexicon: [/accounts?\s*payable/i, /\ba\/?p\b/i, /trade payables?/i, /\bcreditors?\b/i, /bills payable/i, /sundry creditors/i, /vendor payable/i],
  },
  {
    label: "Credit Cards",
    subsection: SUBSECTION.CURRENT,
    subtypeKeywords: ["creditcard"],
    lexicon: [/credit card/i],
  },
  {
    label: "Accrued Expenses",
    subsection: SUBSECTION.CURRENT,
    subtypeKeywords: ["accruedliability", "accruedexpense"],
    lexicon: [/accrued expense/i, /accrued liabilit/i, /outstanding expense/i, /provision for expense/i],
  },
  {
    label: "Payroll Liabilities",
    subsection: SUBSECTION.CURRENT,
    subtypeKeywords: ["payroll"],
    lexicon: [/payroll/i, /salaries payable/i, /wages payable/i],
  },
  {
    label: "Taxes Payable",
    subsection: SUBSECTION.CURRENT,
    subtypeKeywords: ["salestaxpayable", "incometaxpayable", "taxpayable"],
    lexicon: [/tax(es)?\s*payable/i, /sales tax payable/i, /gst payable/i, /vat payable/i, /statutory liabilit/i],
  },
  {
    label: "Unearned Revenue",
    subsection: SUBSECTION.CURRENT,
    subtypeKeywords: ["unearnedrevenue", "deferredrevenue", "contractliability"],
    lexicon: [/unearned revenue/i, /deferred revenue/i, /advance from customer/i, /contract liabilit/i],
  },
  {
    label: "Short-Term Loans",
    subsection: SUBSECTION.CURRENT,
    subtypeKeywords: ["lineofcredit", "notespayablecurrent", "shorttermloan"],
    lexicon: [/short.?term loan/i, /line of credit/i, /current portion/i, /notes?\s*payable.*current/i, /bank overdraft/i, /cash credit/i],
  },
  {
    label: "Other Current Liabilities",
    subsection: SUBSECTION.CURRENT,
    subtypeKeywords: ["othercurrentliability"],
    lexicon: [/other current liabilit/i],
  },
  {
    label: "Bank Loans",
    subsection: SUBSECTION.LONGTERM,
    subtypeKeywords: ["bankloanpayable", "termloan"],
    lexicon: [/bank loan/i, /term loan/i],
  },
  {
    label: "Director Loans",
    subsection: SUBSECTION.LONGTERM,
    subtypeKeywords: ["directorloan"],
    lexicon: [/director loan/i],
  },
  {
    label: "Shareholder Loans",
    subsection: SUBSECTION.LONGTERM,
    subtypeKeywords: ["shareholdernotespayable", "stockholderloan"],
    lexicon: [/shareholder loan/i, /stockholder loan/i, /member loan/i, /partner loan/i],
  },
  {
    label: "Lease Liability",
    subsection: SUBSECTION.LONGTERM,
    subtypeKeywords: ["leaseliability", "capitallease"],
    lexicon: [/lease liabilit/i, /capital lease/i, /finance lease/i],
  },
  {
    label: "Mortgage",
    subsection: SUBSECTION.LONGTERM,
    subtypeKeywords: ["mortgagepayable"],
    lexicon: [/mortgage/i],
  },
  {
    label: "Deferred Tax Liability",
    subsection: SUBSECTION.LONGTERM,
    subtypeKeywords: ["deferredtaxliability"],
    lexicon: [/deferred tax liabilit/i],
  },
  {
    label: "Other Long-Term Liabilities",
    subsection: SUBSECTION.LONGTERM,
    subtypeKeywords: ["otherlongtermliability"],
    lexicon: [/other long.?term liabilit/i, /^long.?term liabilit/i, /\bloan\b/i, /\bborrowings?\b/i, /debenture/i],
  },
];

export const EQUITY_CATEGORIES = [
  {
    label: "Share Capital",
    subsection: null,
    subtypeKeywords: ["commonstock", "preferredstock", "capitalstock"],
    lexicon: [/share capital/i, /common stock/i, /preferred stock/i, /capital stock/i, /equity share/i],
  },
  {
    label: "Additional Paid-In Capital",
    subsection: null,
    subtypeKeywords: ["paidincapital", "apic"],
    lexicon: [/additional paid.?in capital/i, /paid.?in capital/i, /\bapic\b/i, /share premium/i, /securities premium/i],
  },
  {
    label: "Partner Capital",
    subsection: null,
    subtypeKeywords: ["partnercontribution", "partnercapital"],
    lexicon: [/partner.?s?\s*capital/i, /partner.?s?\s*contribution/i],
  },
  {
    label: "Owner's Equity",
    subsection: null,
    subtypeKeywords: ["ownersequity", "ownerdraw"],
    lexicon: [/owner.?s?\s*equity/i, /owner.?s?\s*draw/i, /owner.?s?\s*investment/i, /owner.?s?\s*contribution/i, /proprietor.?s? capital/i, /drawings/i],
  },
  {
    label: "Retained Earnings",
    subsection: null,
    subtypeKeywords: ["retainedearnings", "accumulateddeficit"],
    lexicon: [/retained earnings/i, /accumulated deficit/i, /accumulated (profit|surplus)/i, /reserves? and surplus/i, /general reserve/i],
  },
  {
    label: "Current Year Net Income",
    subsection: null,
    subtypeKeywords: ["netincome"],
    lexicon: [/net income/i, /current year earnings/i, /profit for the (year|period)/i],
  },
  {
    label: "Other Equity",
    subsection: null,
    subtypeKeywords: ["otherequity"],
    lexicon: [/other equity/i],
  },
];

export const CATEGORIES_BY_SECTION = Object.freeze({
  [SECTION.ASSETS]: ASSET_CATEGORIES,
  [SECTION.LIABILITIES]: LIABILITY_CATEGORIES,
  [SECTION.EQUITY]: EQUITY_CATEGORIES,
});

export const CATEGORY_ORDER_BY_SECTION = Object.freeze({
  [SECTION.ASSETS]: ASSET_CATEGORIES.map((c) => c.label),
  [SECTION.LIABILITIES]: LIABILITY_CATEGORIES.map((c) => c.label),
  [SECTION.EQUITY]: EQUITY_CATEGORIES.map((c) => c.label),
});

export const OTHER_CATEGORY_BY_SECTION_SUBSECTION = Object.freeze({
  "assets.current": "Other Current Assets",
  "assets.noncurrent": "Other Non-Current Assets",
  "liabilities.current": "Other Current Liabilities",
  "liabilities.longterm": "Other Long-Term Liabilities",
  "equity.null": "Other Equity",
});

// ─── Coarse ERP "Account Type" → (section, subsection). Layer 3. Checked ──
// ─── against a normalized STRUCTURED type field, never the account name. ──

export const ACCOUNT_TYPE_TO_SECTION = [
  { keywords: ["bank", "accountsreceivable", "othercurrentasset", "currentasset"], section: SECTION.ASSETS, subsection: SUBSECTION.CURRENT },
  { keywords: ["fixedasset", "otherasset", "noncurrentasset", "longtermasset"], section: SECTION.ASSETS, subsection: SUBSECTION.NONCURRENT },
  { keywords: ["accountspayable", "creditcard", "othercurrentliability", "currentliability"], section: SECTION.LIABILITIES, subsection: SUBSECTION.CURRENT },
  { keywords: ["longtermliability", "noncurrentliability"], section: SECTION.LIABILITIES, subsection: SUBSECTION.LONGTERM },
  { keywords: ["equity"], section: SECTION.EQUITY, subsection: null },
];

// ─── Contra-account signatures — recognized regardless of which category ──
// ─── they land in; they stay WITH that category, just ordered after the  ──
// ─── gross accounts they offset.                                         ──

export const CONTRA_PATTERNS = [
  /accumulated depreciation/i,
  /accumulated depletion/i,
  /accumulated amortization/i,
  /allowance for doubtful accounts/i,
  /allowance for bad debts?/i,
  /allowance for obsolete inventory/i,
  /inventory reserve/i,
  /discount on (bonds|notes)/i,
  /treasury (stock|shares)/i,
  /^less:/i,
];

// ─── Default Chart-of-Accounts numbering ranges (Layer 6). Overridable —  ──
// ─── real numbering schemes vary company to company.                     ──

export const DEFAULT_ACCOUNT_NUMBER_RANGES = [
  { min: 1000, max: 1499, section: SECTION.ASSETS, subsection: SUBSECTION.CURRENT },
  { min: 1500, max: 1999, section: SECTION.ASSETS, subsection: SUBSECTION.NONCURRENT },
  { min: 2000, max: 2499, section: SECTION.LIABILITIES, subsection: SUBSECTION.CURRENT },
  { min: 2500, max: 2999, section: SECTION.LIABILITIES, subsection: SUBSECTION.LONGTERM },
  { min: 3000, max: 3999, section: SECTION.EQUITY, subsection: null },
];
