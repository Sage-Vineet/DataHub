// ============================================================================
// Chart of Accounts — deterministic hierarchy rules (Key Reports redesign)
//
// Pure, dependency-light rule engine that places an account into the
// STANDARDIZED levels of the Chart of Accounts taxonomy (levels 1–4). It never
// calls a network/LLM, so it is fast, free, reproducible, and always available
// as the fallback when Gemini refinement is unavailable.
//
//   Level 1 — statement      (Income Statement | Balance Sheet)
//   Level 2 — major category (Assets | Liabilities | Equity | Revenue |
//                             Cost of Goods Sold | Operating Expenses)
//   Level 3 — sub-category    (Current Assets, Fixed Assets, Operating Revenue, …)
//   Level 4 — account group   (Cash, Accounts Receivable, Payroll, Rent, …)
//
// Deeper levels (5–15) are left null for the Gemini refiner / the user to fill.
// The source account name is the BASE ACCOUNT and is placed at the level
// immediately after the deepest standardized level (see buildLevelsFromPath).
// ============================================================================

const MAX_LEVELS = 15;

// Level-2 label per normalized account type (the 6-type vocab used across the app).
const LEVEL2_BY_TYPE = Object.freeze({
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Revenue",
  cogs: "Cost of Goods Sold",
  expense: "Operating Expenses",
});

const STATEMENT_BY_TYPE = Object.freeze({
  asset: "balance_sheet",
  liability: "balance_sheet",
  equity: "balance_sheet",
  income: "profit_loss",
  cogs: "profit_loss",
  expense: "profit_loss",
});

// Keyword fragments → standardized level-4 account group, per account type.
// First match wins; order matters (more specific first).
const GROUP_RULES = Object.freeze({
  asset: [
    [/cash|checking|savings|bank|petty/, "Cash"],
    [/receivable|\ba\/r\b|\bar\b/, "Accounts Receivable"],
    [/inventory|stock on hand/, "Inventory"],
    [/prepaid/, "Prepaid Expenses"],
    [/equipment|furniture|fixture|vehicle|truck|machinery|building|land|leasehold|depreciation/, "Property & Equipment"],
    [/goodwill|intangible|amortizable/, "Intangible Assets"],
    [/deposit|investment|note receivable/, "Other Assets"],
  ],
  liability: [
    [/payable|\ba\/p\b/, "Accounts Payable"],
    [/credit card/, "Credit Cards"],
    [/loan|note|mortgage|line of credit/, "Loans & Notes Payable"],
    [/accrued/, "Accrued Liabilities"],
    [/tax/, "Taxes Payable"],
    [/payroll|wages payable/, "Payroll Liabilities"],
  ],
  equity: [
    [/retained earnings/, "Retained Earnings"],
    [/capital|owner|member|partner|draw|distribution/, "Owner Equity"],
    [/common stock|paid-in|paid in|additional paid/, "Contributed Capital"],
  ],
  income: [
    [/interest/, "Interest Income"],
    [/dividend/, "Dividend Income"],
    [/gain|disposal/, "Gains"],
    [/service|consulting|fee/, "Service Revenue"],
    [/product|merchandise|goods/, "Product Revenue"],
    [/sales|revenue|income/, "Sales"],
  ],
  cogs: [
    [/labor|wages/, "Direct Labor"],
    [/material|supplies/, "Direct Materials"],
    [/freight|shipping/, "Freight & Shipping"],
    [/.*/, "Cost of Goods Sold"],
  ],
  expense: [
    [/payroll|salaries|salary|wages|compensation|officer/, "Payroll & Compensation"],
    [/rent|lease/, "Rent & Lease"],
    [/utilit|electric|water|gas|internet|phone|telephone/, "Utilities"],
    [/insurance/, "Insurance"],
    [/depreciation|amortization/, "Depreciation & Amortization"],
    [/interest/, "Interest Expense"],
    [/tax/, "Taxes & Licenses"],
    [/advertis|marketing|promotion/, "Marketing & Advertising"],
    [/travel|meals|entertainment/, "Travel & Meals"],
    [/legal|accounting|professional|consulting/, "Professional Fees"],
    [/repair|maintenance/, "Repairs & Maintenance"],
    [/office|supplies|postage/, "Office & Supplies"],
    [/bank|merchant|processing/, "Bank & Processing Fees"],
  ],
});

// Level-3 sub-category resolution by account type + keyword.
function level3For(accountType, name) {
  const n = String(name || "").toLowerCase();
  switch (accountType) {
    case "asset":
      if (/equipment|furniture|fixture|vehicle|truck|machinery|building|land|leasehold|depreciation|fixed|property/.test(n)) return "Fixed Assets";
      if (/goodwill|intangible|deposit|investment|long-term|long term|note receivable/.test(n)) return "Other Assets";
      return "Current Assets";
    case "liability":
      if (/loan|note|mortgage|long-term|long term|bond/.test(n)) return "Long-Term Liabilities";
      return "Current Liabilities";
    case "equity":
      return "Equity";
    case "income":
      if (/interest|dividend|gain|other|misc/.test(n)) return "Other Revenue";
      return "Operating Revenue";
    case "cogs":
      return "Cost of Goods Sold";
    case "expense":
      if (/interest|tax|depreciation|amortization|other|misc/.test(n)) return "Other Expenses";
      return "Operating Expenses";
    default:
      return null;
  }
}

function groupFor(accountType, name) {
  const rules = GROUP_RULES[accountType];
  if (!rules) return null;
  const n = String(name || "").toLowerCase();
  for (const [re, label] of rules) {
    if (re.test(n)) return label;
  }
  return null;
}

/**
 * Produce the standardized levels 1–4 for an account.
 *
 * @param {object} account
 *   { accountName, accountNumber, accountType (normalized 6-type), statementType }
 * @returns {{ levels: (string|null)[], standardizedDepth: number }}
 *   levels is a 15-slot array (standardized labels in 1..4, rest null).
 *   standardizedDepth = count of non-null standardized levels produced.
 */
function classifyStandardized(account) {
  const { accountName, accountType, statementType } = account;
  const type = accountType || "";
  const stmt = statementType || STATEMENT_BY_TYPE[type] || null;

  // Build a compact, gap-free list of standardized labels, dropping any label
  // that just repeats the one above it (e.g. expense level-2 == level-3).
  const raw = [
    stmt === "balance_sheet" ? "Balance Sheet" : stmt === "profit_loss" ? "Income Statement" : null,
    LEVEL2_BY_TYPE[type] || null,
    level3For(type, accountName),
    groupFor(type, accountName),
  ];
  const compact = [];
  for (const label of raw) {
    if (!label) continue;
    if (compact.length && compact[compact.length - 1].toLowerCase() === label.toLowerCase()) continue;
    compact.push(label);
  }

  const levels = new Array(MAX_LEVELS).fill(null);
  for (let i = 0; i < compact.length && i < MAX_LEVELS; i += 1) levels[i] = compact[i];
  return { levels, standardizedDepth: compact.length };
}

/**
 * Assemble the final 15-level path: standardized levels, then any deeper
 * category labels (from Gemini), then the base account at the deepest slot.
 *
 * @param {(string|null)[]} standardizedLevels  15-slot array from classifyStandardized
 * @param {number} standardizedDepth            count of standardized levels
 * @param {string[]} deeperLabels               extra category labels (Gemini), ordered
 * @param {string} baseAccount                  the source account display name
 * @returns {{ levels: (string|null)[], hierarchyPath: string }}
 */
function buildLevelsFromPath(standardizedLevels, standardizedDepth, deeperLabels, baseAccount) {
  const levels = standardizedLevels.slice(0, MAX_LEVELS);
  let idx = standardizedDepth;

  // Insert Gemini's intermediate category labels (deduped, non-empty), but keep
  // one slot free for the base account.
  for (const raw of deeperLabels || []) {
    const label = String(raw || "").trim();
    if (!label) continue;
    if (idx >= MAX_LEVELS - 1) break;
    // Skip a label that just repeats the previous level.
    if (idx > 0 && String(levels[idx - 1] || "").toLowerCase() === label.toLowerCase()) continue;
    levels[idx] = label;
    idx += 1;
  }

  // Place the base account at the next free slot (capped at the last level).
  const base = String(baseAccount || "").trim();
  if (base) {
    const slot = Math.min(idx, MAX_LEVELS - 1);
    levels[slot] = base;
  }

  const hierarchyPath = levels.filter(Boolean).join(" > ");
  return { levels, hierarchyPath };
}

module.exports = {
  MAX_LEVELS,
  classifyStandardized,
  buildLevelsFromPath,
  // exported for testing / reuse
  level3For,
  groupFor,
  LEVEL2_BY_TYPE,
  STATEMENT_BY_TYPE,
};
