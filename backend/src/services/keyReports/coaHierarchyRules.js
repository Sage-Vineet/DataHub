// ============================================================================
// Chart of Accounts — deterministic hierarchy rules (Key Reports redesign)
//
// Pure, dependency-light rule engine that places an account into the client's
// STANDARDIZED financial-statement hierarchy. Levels 1–N are fixed anchors that
// are identical across every company; deeper company-specific levels are added
// by the optional Gemini refiner (see geminiCoaClassifier.js / buildLevelsFromPath).
//
// Fixed anchor hierarchy:
//
//   P&L accounts (income / expense / cogs):
//     L1: Income Statement
//     L2: Net Income
//     L3: Pretax Income
//     L4: Operating Income
//     L5: Gross Profit
//     L6: Total Revenue  OR  Total Expenses
//     L7: Income          OR  Expenses
//     L8: (expense group, rule-derived — e.g. "Payroll and Labor")
//     L9+: company-specific (Gemini)
//     Ln: base account
//
//   Balance Sheet accounts (asset / liability / equity):
//     L1: Balance Sheet
//     L2: Total Assets  |  Total Liabilities  |  Total Equity
//     L3: (sub-category — e.g. Current Assets / Long-Term Liabilities)
//     L4: (group — e.g. Bank Accounts / Credit Cards)
//     L5+: company-specific (Gemini)
//     Ln: base account
//
// This engine never calls the network, so it is fast, reproducible, and always
// available as the fallback when Gemini is unavailable.
// ============================================================================

const MAX_LEVELS = 15;

const STATEMENT_BY_TYPE = Object.freeze({
  asset: "balance_sheet",
  liability: "balance_sheet",
  equity: "balance_sheet",
  income: "profit_loss",
  cogs: "profit_loss",
  expense: "profit_loss",
});

// Fixed standardized anchor levels per account type. These are the same for
// EVERY company. Company-specific levels (and asset/liability sub/group) are
// appended after; the base account is appended last by buildLevelsFromPath.
const STANDARD_PREFIX = Object.freeze({
  // P&L: L1=statement, L2–L7=rollup chain, then company-specific, then base.
  income: [
    "Income Statement", "Net Income", "Pretax Income",
    "Operating Income", "Gross Profit", "Total Revenue", "Income",
  ],
  expense: [
    "Income Statement", "Net Income", "Pretax Income",
    "Operating Income", "Gross Profit", "Total Expenses", "Expenses",
  ],
  cogs: [
    "Income Statement", "Net Income", "Pretax Income",
    "Operating Income", "Gross Profit", "Total Expenses", "Expenses",
  ],
  // Balance Sheet: L1=statement, L2=top rollup, then sub+group from rules, then base.
  asset:     ["Balance Sheet", "Total Assets"],
  liability: ["Balance Sheet", "Total Liabilities"],
  equity:    ["Balance Sheet", "Total Equity"],
});

// ── Expense company groups (the standardized level that sits under "Expenses") ──
// First match wins; order matters (more specific before the generic catch-all).
const EXPENSE_GROUP_RULES = [
  [/payroll|salar|wages|401\s*k|employee benefit|\bbenefits?\b|worker'?s? ?comp|\bofficer\b|\blabor\b/, "Payroll and Labor"],
  [/food|beverage|job suppl|meals tax|cost of (goods|sales)|merchandise|raw material/, "Cost of Sales"],
  [/\brent\b|lease|real estate tax|propert(?:y|ies) tax|utilit|water|sewer|alarm|electric|natural gas/, "Occupancy"],
  [/car (?:and|&) truck|\btruck\b|\btravel\b|mileage|\bauto\b|\bvehicle\b|\bfuel\b|gasoline/, "Vehicle and Travel"],
  [/repair|maintenance|rubbish|\btrash\b|removal|janitor|cleaning/, "Repairs and Maintenance"],
  [/advertis|marketing|promotion|charitable|contribution|entertainment/, "Sales and Marketing"],
  [/insurance/, "Insurance"],
  [/depreciation|amortization|interest (?:paid|expense)|\binterest\b|education|bad debt|below.line|non.?cash/, "Non-Cash and Below-Line"],
  [/.*/, "General and Administrative"],
];

function expenseGroupFor(name) {
  const n = String(name || "").toLowerCase();
  for (const [re, label] of EXPENSE_GROUP_RULES) {
    if (re.test(n)) return label;
  }
  return "General and Administrative";
}

// ── Asset sub-category + group ────────────────────────────────────────────────
function assetSubAndGroup(name) {
  const n = String(name || "").toLowerCase();
  // Sub-category (level 3).
  let sub;
  if (/equipment|furniture|fixture|machinery|building|\bland\b|leasehold|accumulated depreciation|construction in progress|\bvehicle\b/.test(n)) {
    sub = "Fixed Assets";
  } else if (/amortization|goodwill|intangible|other long.?term|\bdeposit\b|financing cost|note receivable/.test(n)) {
    sub = "Other Assets";
  } else {
    sub = "Current Assets";
  }

  // Group (level 4).
  let group = null;
  if (/money market|checking|savings|\bbank\b|petty cash|\bcash\b/.test(n)) group = "Bank Accounts";
  else if (/receivable|\ba\/r\b/.test(n)) group = "Accounts Receivable";
  else if (/inventory|stock on hand/.test(n)) group = "Inventory";
  else if (/prepaid/.test(n)) group = "Prepaid Expenses";
  else if (/loans? to|due from|loan receivable/.test(n)) group = "Other Current Assets";
  else if (/accumulated depreciation/.test(n)) group = "Accumulated Depreciation";
  else if (/machinery|equipment/.test(n)) group = "Machinery & Equipment";
  else if (/furniture|fixture/.test(n)) group = "Furniture & Fixtures";
  else if (/leasehold/.test(n)) group = "Leasehold Improvements";
  else if (/\bvehicle\b|\btruck\b/.test(n)) group = "Vehicles";
  else if (/\bland\b/.test(n)) group = "Land Improvements";
  else if (/construction in progress/.test(n)) group = "Construction in Progress";
  else if (/amortization|financing cost|goodwill|intangible/.test(n)) group = "Other Long-Term Assets";
  else if (sub === "Current Assets") group = "Other Current Assets";
  else if (sub === "Fixed Assets") group = "Other Fixed Assets";
  else group = "Other Long-Term Assets";

  return [sub, group];
}

// ── Liability sub-category + group ────────────────────────────────────────────
function liabilitySubAndGroup(name, bsSection) {
  const n = String(name || "").toLowerCase();
  if (/credit card/.test(n)) return ["Current Liabilities", "Credit Cards"];

  // Use the actual BS section from the uploaded statement when available —
  // keyword inference can't reliably tell current from long-term for loans.
  if (bsSection) {
    const s = String(bsSection).toLowerCase();
    if (/long.?term/.test(s)) return ["Long-Term Liabilities", "Long-Term Loans"];
    if (/current/.test(s)) return ["Current Liabilities", "Other Current Liabilities"];
  }

  // Fallback: only route to Long-Term when there is an explicit signal.
  // Default loans to Current — avoids mis-placing short-term or PPP/EIDL/officer loans.
  if (/\blong.?term\b/.test(n)) return ["Long-Term Liabilities", "Long-Term Loans"];
  if (/\bsba\b/.test(n)) return ["Long-Term Liabilities", "Long-Term Loans"];
  if (/loan|note payable|mortgage|line of credit|\beidl\b|\bppp\b/.test(n)) {
    return ["Current Liabilities", "Other Current Liabilities"];
  }
  return ["Current Liabilities", "Other Current Liabilities"];
}

/**
 * Produce the standardized rollup labels for an account (levels 1..N), with the
 * base account intentionally NOT yet appended (buildLevelsFromPath adds it plus
 * any Gemini deeper levels).
 *
 * @param {object} account
 *   { accountName, accountNumber, accountType (normalized 6-type), statementType }
 * @returns {{ levels: (string|null)[], standardizedDepth: number }}
 *   levels is a 15-slot array (rollup labels in 1..standardizedDepth, rest null).
 */
function classifyStandardized(account) {
  const { accountName, accountType } = account;
  const type = accountType || "";

  const prefix = (STANDARD_PREFIX[type] || []).slice();
  const labels = prefix.slice();

  if (type === "expense" || type === "cogs") {
    labels.push(expenseGroupFor(accountName));
  } else if (type === "asset") {
    const [sub, group] = assetSubAndGroup(accountName);
    labels.push(sub, group);
  } else if (type === "liability") {
    const [sub, group] = liabilitySubAndGroup(accountName, account.bsSection);
    labels.push(sub, group);
  }
  // income / equity: prefix only — base account is appended directly afterwards.

  // Drop any label that just repeats the one immediately above it.
  // The STANDARD_PREFIX no longer has intentional duplicates (the old
  // "Total Assets > Total Assets" pair has been replaced with the clean
  // "Balance Sheet > Total Assets" pair).
  const compact = [];
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    if (!label) continue;
    if (compact.length && compact[compact.length - 1].toLowerCase() === label.toLowerCase()) continue;
    compact.push(label);
  }

  const levels = new Array(MAX_LEVELS).fill(null);
  for (let i = 0; i < compact.length && i < MAX_LEVELS; i += 1) levels[i] = compact[i];
  return { levels, standardizedDepth: Math.min(compact.length, MAX_LEVELS) };
}

/**
 * Assemble the final 15-level path: standardized rollup levels, then any deeper
 * company-specific labels (from Gemini), then the base account at the deepest slot.
 *
 * The build is done in three stages:
 *   1. Collect every segment in order (standardized → Gemini deeper → base account).
 *   2. Strip consecutive duplicates (case-insensitive, whitespace-normalised).
 *      This removes spurious repeats injected when Gemini echoes a standardized label
 *      or includes the account name in its deeperLevels list.
 *   3. Fit within MAX_LEVELS, keeping the base account in the deepest slot.
 *
 * @param {(string|null)[]} standardizedLevels  15-slot array from classifyStandardized
 * @param {number} standardizedDepth            count of standardized levels
 * @param {string[]} deeperLabels               extra category labels (Gemini), ordered
 * @param {string} baseAccount                  the source account display name
 * @returns {{ levels: (string|null)[], hierarchyPath: string }}
 */
function buildLevelsFromPath(standardizedLevels, standardizedDepth, deeperLabels, baseAccount) {
  // ── 1. Collect all segments ────────────────────────────────────────────────
  const raw = [];

  for (let i = 0; i < standardizedDepth; i++) {
    const l = String(standardizedLevels[i] || "").trim();
    if (l) raw.push(l);
  }

  for (const label of deeperLabels || []) {
    const l = String(label || "").trim();
    if (l) raw.push(l);
  }

  const base = String(baseAccount || "").trim();
  if (base) raw.push(base);

  // ── 2. Remove consecutive duplicates (Rules 1, 2, 5, 6, 9) ───────────────
  // Case-insensitive, whitespace-normalised. This handles:
  //   • Gemini echoing a standardized label that sits right above its output.
  //   • Gemini including the account name as its last deeperLevel item, which
  //     would otherwise duplicate the base account appended in step 1.
  //   • Any back-to-back identical strings anywhere in the collected path.
  const deduped = [];
  for (const label of raw) {
    if (
      !deduped.length ||
      deduped[deduped.length - 1].toLowerCase() !== label.toLowerCase()
    ) {
      deduped.push(label);
    }
  }

  // ── 3. Fit within MAX_LEVELS (Rule 8: base account is always last) ─────────
  // If the de-duped path is longer than MAX_LEVELS, truncate intermediate levels
  // but ensure the base account still occupies the final slot.
  let path = deduped;
  if (path.length > MAX_LEVELS) {
    path = base
      ? [...deduped.slice(0, MAX_LEVELS - 1), base]
      : deduped.slice(0, MAX_LEVELS);
  }

  // ── 4. Fill the fixed-size 15-slot array ──────────────────────────────────
  const levels = new Array(MAX_LEVELS).fill(null);
  for (let i = 0; i < path.length; i++) levels[i] = path[i];

  const hierarchyPath = path.join(" > ");
  return { levels, hierarchyPath };
}

module.exports = {
  MAX_LEVELS,
  classifyStandardized,
  buildLevelsFromPath,
  // exported for testing / reuse
  STANDARD_PREFIX,
  STATEMENT_BY_TYPE,
  expenseGroupFor,
  assetSubAndGroup,
  liabilitySubAndGroup,
};
