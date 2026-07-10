// ============================================================================
// Chart of Accounts — hierarchy assembly (Key Reports redesign)
//
// Provides:
//   aiSectionToStandardLevels(section, accountType)
//     Maps the AI-returned section label to the fixed structural labels that
//     form levels 1–N of the standard hierarchy.  This is a pure lookup table —
//     it does NOT match keywords on account names.  Account name analysis is
//     entirely the responsibility of the AI classification layer.
//
//   buildLevelsFromPath(standardizedLevels, standardizedDepth, deeperLabels, baseAccount)
//     Assembles the final MAX_LEVELS-slot array from:
//       1. Standard structural levels (from aiSectionToStandardLevels)
//       2. AI-provided deeper company-specific labels
//       3. The base account name
//     Deduplicates consecutive equal labels and fits within MAX_LEVELS.
//
// No network calls.  No keyword/regex matching on account names.
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

// ── Section → standard structural labels ─────────────────────────────────────
//
// Each value is the ordered array of fixed rollup labels that precede the
// company-specific levels (from AI) and the base account.
//
// These labels are the same for EVERY company regardless of ERP or industry.
//
// UNIFIED hierarchy (client spec): there is ONE root, "Total Liabilities and
// Equity", alongside its parallel "Total Assets" root — not two disconnected
// "Income Statement" / "Balance Sheet" trees. Net Income (and therefore the
// entire P&L rollup chain) nests under Total Equity, since period net income
// rolls into equity:
//   Total Liabilities and Equity
//     └─ Total Equity
//          ├─ Equity                              (pure equity accounts)
//          └─ Net Income
//               └─ Pretax Income
//                    └─ Operating Income
//                         └─ Gross Profit
//                              ├─ Total Revenue  → Income
//                              └─ Total Expenses → Expenses → (9 groups)
//   Total Assets
//     ├─ Current Assets / Fixed Assets / Other Assets
//   Total Liabilities and Equity
//     └─ Total Liabilities
//          └─ Current Liabilities / Long-Term Liabilities
//
// buildLevelsFromPath collapses consecutive duplicate labels, so a
// self-referential stub (e.g. repeating "Total Assets" before its
// subcategory) is intentionally omitted below — it would be stripped anyway.
//
// The mapping is keyed by the exact section string the AI is instructed to
// return (see geminiCoaClassifier.buildClassifyPrompt).  Case-sensitive to
// prevent accidental mismatches; the AI is instructed to use these exact strings.

const SECTION_STANDARD_LEVELS = Object.freeze({
  // ── Balance Sheet ──────────────────────────────────────────────────────────
  "Current Assets":        ["Total Assets", "Current Assets"],
  "Fixed Assets":          ["Total Assets", "Fixed Assets"],
  "Other Assets":          ["Total Assets", "Other Assets"],
  "Current Liabilities":   ["Total Liabilities and Equity", "Total Liabilities", "Current Liabilities"],
  "Long-Term Liabilities": ["Total Liabilities and Equity", "Total Liabilities", "Long-Term Liabilities"],
  "Equity":                ["Total Liabilities and Equity", "Total Equity", "Equity"],

  // ── Profit & Loss (nests under Total Equity → Net Income) ──────────────────
  // Revenue and COGS/OpEx share the same rollup chain to "Gross Profit", then
  // split into "Total Revenue / Income" vs "Total Expenses / Expenses".
  "Revenue":            ["Total Liabilities and Equity", "Total Equity", "Net Income", "Pretax Income", "Operating Income", "Gross Profit", "Total Revenue",  "Income"],
  "Cost of Goods Sold": ["Total Liabilities and Equity", "Total Equity", "Net Income", "Pretax Income", "Operating Income", "Gross Profit", "Total Expenses", "Expenses"],
  "Operating Expenses": ["Total Liabilities and Equity", "Total Equity", "Net Income", "Pretax Income", "Operating Income", "Gross Profit", "Total Expenses", "Expenses"],
  // Other Income / Other Expense appear below Operating Income — short chain.
  "Other Income":       ["Total Liabilities and Equity", "Total Equity", "Net Income", "Pretax Income"],
  "Other Expense":      ["Total Liabilities and Equity", "Total Equity", "Net Income", "Pretax Income"],
});

// Fallback by 6-type accountType when the AI does not return a recognised
// section or the section field is absent.
const TYPE_STANDARD_LEVELS = Object.freeze({
  asset:     ["Total Assets"],
  liability: ["Total Liabilities and Equity", "Total Liabilities"],
  equity:    ["Total Liabilities and Equity", "Total Equity"],
  income:    ["Total Liabilities and Equity", "Total Equity", "Net Income", "Pretax Income", "Operating Income", "Gross Profit", "Total Revenue",  "Income"],
  cogs:      ["Total Liabilities and Equity", "Total Equity", "Net Income", "Pretax Income", "Operating Income", "Gross Profit", "Total Expenses", "Expenses"],
  expense:   ["Total Liabilities and Equity", "Total Equity", "Net Income", "Pretax Income", "Operating Income", "Gross Profit", "Total Expenses", "Expenses"],
});

/**
 * Return the ordered array of standard structural rollup labels for an account.
 * Pure lookup — never examines the account name.
 *
 * @param {string} section     AI-returned section (e.g. "Current Assets")
 * @param {string} accountType 6-type model value (e.g. "asset")
 * @returns {string[]}         ordered labels, deepest-first ending before base account
 */
function aiSectionToStandardLevels(section, accountType) {
  return (
    SECTION_STANDARD_LEVELS[String(section || "")] ||
    TYPE_STANDARD_LEVELS[String(accountType || "")] ||
    ["Total Liabilities and Equity"]
  ).slice(); // return a mutable copy
}

/**
 * Assemble the final 15-level path:
 *   standard rollup levels → AI deeper company-specific labels → base account.
 *
 * Steps:
 *   1. Collect every segment in order.
 *   2. Strip consecutive duplicates (case-insensitive).
 *      Removes echoed labels when AI returns a standardized label in deeperLevels
 *      or includes the account name as its last deeperLevel entry.
 *   3. Fit within MAX_LEVELS, keeping the base account in the deepest slot.
 *   4. Fill the fixed-size MAX_LEVELS-slot array.
 *
 * @param {(string|null)[]} standardizedLevels  MAX_LEVELS-slot array from labelsToLevelArray
 * @param {number} standardizedDepth            count of non-null standard labels
 * @param {string[]} deeperLabels               AI-provided deeper category labels
 * @param {string} baseAccount                  display name for the base account
 * @returns {{ levels: (string|null)[], hierarchyPath: string }}
 */
function buildLevelsFromPath(standardizedLevels, standardizedDepth, deeperLabels, baseAccount) {
  // 1. Collect all segments.
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

  // 2. Remove consecutive duplicates.
  const deduped = [];
  for (const label of raw) {
    if (!deduped.length || deduped[deduped.length - 1].toLowerCase() !== label.toLowerCase()) {
      deduped.push(label);
    }
  }

  // 3. Fit within MAX_LEVELS; base account always occupies the final slot.
  let path = deduped;
  if (path.length > MAX_LEVELS) {
    path = base
      ? [...deduped.slice(0, MAX_LEVELS - 1), base]
      : deduped.slice(0, MAX_LEVELS);
  }

  // 4. Fill the fixed-size array.
  const levels = new Array(MAX_LEVELS).fill(null);
  for (let i = 0; i < path.length; i++) levels[i] = path[i];

  return { levels, hierarchyPath: path.join(" > ") };
}

/**
 * Convert a plain ordered labels array into a MAX_LEVELS-slot null-padded array.
 * Used to feed standard label arrays into buildLevelsFromPath.
 *
 * @param {string[]} labels
 * @returns {(string|null)[]}
 */
function labelsToLevelArray(labels) {
  const arr = new Array(MAX_LEVELS).fill(null);
  for (let i = 0; i < labels.length && i < MAX_LEVELS; i++) arr[i] = labels[i];
  return arr;
}

module.exports = {
  MAX_LEVELS,
  STATEMENT_BY_TYPE,
  SECTION_STANDARD_LEVELS,
  TYPE_STANDARD_LEVELS,
  aiSectionToStandardLevels,
  labelsToLevelArray,
  buildLevelsFromPath,
};
