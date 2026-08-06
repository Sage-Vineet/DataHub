// ============================================================================
// Financial Statement Service — COA-driven P&L, Balance Sheet, Cash Flow
//
// Architecture:
//   chart_of_accounts  (hierarchy + classification, parent_account_id tree)
//       │
//       ├─ Category nodes (metadata.is_group = true)  — structural, no amounts
//       └─ Leaf accounts  (metadata.is_group = false) — map to entry table rows
//               │
//               └─ in-memory name/number map built from the COA leaves
//                       │
//                       └─ entry tables  (balance_sheet_entries / GL)
//
// Report generation flow:
//   1. Load ALL COA accounts (leaves + category nodes) with parent_account_id
//   2. Map entry amounts to LEAF accounts only (skip calculated summary rows)
//   3. Build the parent_account_id tree, recursively roll up leaf amounts
//   4. Derive P&L / BS statement from the rolled-up tree
//   5. Calculated totals (Gross Profit, Net Income, …) come from the tree — never from entries
// ============================================================================

"use strict";

const { supabase } = require("../../db");
const { bsBalancesForYear, aggregateGLForBSByMonth } = require("./keyReportReportService");
const { fetchAllRows } = require("./pagedFetch");
const { norm, normStrict, buildMappings, buildFuzzyLookup, fuzzyMatch } = require("./accountNameMatching");
const { fixedPrefixFor } = require("../chartOfAccountsService");
// Vendor/customer handling is KEY REPORTS-OWNED and deliberately independent of
// the Manual GL Upload flow: this module imports from ./keyReportEntityAggregation
// (a Key Reports file) and never from glEntityNormalization, manualGlMultiYearService
// or any other Manual GL service. The duplication between the two flows' entity
// logic is intentional -- do not merge them back into a shared helper.
const {
  krAccumulateRowEntities,
  krPropagateEntitiesToLeaves,
  krSerializeEntitiesByAccount,
  krValidateEntityReconciliation,
  KR_NO_VENDOR_LABEL,
  KR_NO_CUSTOMER_LABEL,
} = require("./keyReportEntityAggregation");
// ensureAccountExistsInCoa intentionally not imported — COA must be complete
// before report generation begins (ensureCoaComplete runs in Phase 2c).

// Re-exported under the historical names so existing call sites/tests keep
// working; the canonical definitions live in the Key Reports module above.
const NO_VENDOR_LABEL = KR_NO_VENDOR_LABEL;
const NO_CUSTOMER_LABEL = KR_NO_CUSTOMER_LABEL;

/** Thin adapters onto the Key Reports entity module (see its own docs). */
function accumulateGlRowEntities(acc, row, periodKey, amount) {
  krAccumulateRowEntities(acc, row, periodKey, amount);
}

function propagateEntitiesToLeaves(target, leafIds, sourceMap, periodKey) {
  krPropagateEntitiesToLeaves(target, leafIds, sourceMap, periodKey);
}

/**
 * Reconciliation diagnostic. Delegates to the Key Reports entity module, which
 * logs [KR_ENTITY_RECONCILIATION] with company/version/account/period/totals/
 * difference when sum(entity rows) != the account's own period total.
 */
function warnIfVendorReconciliationMismatch(label, leafAmounts, leafEntityMap, periodKey, leaves, ctx = {}) {
  return krValidateEntityReconciliation({
    label, leafAmounts, leafEntityMap, periodKey, leaves,
    displayNameOf: displayName,
    companyId: ctx.companyId || null,
    versionId: ctx.versionId || null,
  });
}

/**
 * Serialize Map<leafId, entityAccumulator> keyed by the leaf's rendered display
 * name -- the SAME displayName() buildDynamicHierarchy uses for leaf.name, which
 * is what the frontend's entityIndex(rec.name) looks up against.
 */
function serializeEntitiesByAccount(leafEntityMap, leaves) {
  return krSerializeEntitiesByAccount(leafEntityMap, leaves, displayName);
}

/**
 * Per-period diagnostic for the Key Reports vendor/customer pipeline, so the
 * layer a breakdown goes missing at is visible from the server log alone rather
 * than needing a bisect through DB -> aggregation -> API -> frontend.
 */
function logKrEntityDiagnostic({ grain, companyId, versionId, period, glRowCount, vendorsByAccount, customersByAccount }) {
  const vAccts = Object.keys(vendorsByAccount || {});
  const cAccts = Object.keys(customersByAccount || {});
  const rowTotal = (obj) => Object.values(obj || {}).reduce((s, rows) => s + (rows?.length || 0), 0);
  const distinct = (obj) => new Set(Object.values(obj || {}).flat().map((r) => r?.name)).size;
  console.log(
    `[KR Vendor Debug] grain=${grain} companyId=${companyId || "?"} versionId=${versionId || "?"} ` +
    `period=${period} glAccounts=${glRowCount} ` +
    `accountsWithVendors=${vAccts.length} vendorRows=${rowTotal(vendorsByAccount)} distinctVendors=${distinct(vendorsByAccount)} ` +
    `accountsWithCustomers=${cAccts.length} customerRows=${rowTotal(customersByAccount)} distinctCustomers=${distinct(customersByAccount)}`,
  );
}

// Post-collapse depth of the shared Profit & Loss fixed anchor (income/cogs/
// expense all resolve to the SAME fixedPrefixFor prefix) — read from
// chartOfAccountsService so this never drifts out of sync with the anchor's
// actual, single-source-of-truth definition.
function collapseConsecutive(arr) {
  const out = [];
  for (const v of arr) if (!out.length || out[out.length - 1] !== v) out.push(v);
  return out;
}
const PL_ANCHOR_DEPTH = collapseConsecutive(fixedPrefixFor("income")).length;

// ─── Utilities ────────────────────────────────────────────────────────────────

const safeNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (v) => Math.round(safeNum(v) * 100) / 100;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const LEVEL_KEYS = Array.from({ length: 15 }, (_, i) => `level_${i + 1}`);

const displayName = (acc) => acc.adjusted_name || acc.base_account || acc.account_name;

// NOTE: the former keyword-based classifier for unmapped Balance-Sheet entries
// (classifyUnmappedBSAccount + _BS_*_KW arrays) has been removed. Hierarchy /
// account-type is never inferred from account-name keywords anywhere in the
// Key Reports pipeline. A balance_sheet_entries row that cannot be matched to
// an existing chart_of_accounts leaf is tracked in unmappedSet and excluded
// from the statement until a human maps it (needs_mapping) — see the
// generateMonthlyBs* miss handling below.



// ─── Calculated / summary row detection ───────────────────────────────────────

/**
 * Entry rows that represent calculated subtotals must be ignored.
 * Only leaf financial accounts should be mapped — totals are derived from the tree.
 */
const SUMMARY_PATTERNS = [
  // ── P&L calculated subtotals ──────────────────────────────────────────────
  /^gross\s*profit/i,
  /^net\s*(income|loss|profit|operating)/i,
  /^total\s+revenue/i,
  /^total\s+expenses?/i,
  /^total\s+income/i,
  /^total\s+cost\s+of/i,
  /^operating\s+(income|expenses?)/i,
  /^pretax\s+income/i,
  /^income\s+before/i,
  /^ebitda/i,
  // ── BS calculated subtotals ───────────────────────────────────────────────
  /^total\s+assets?/i,
  /^total\s+liabilit/i,
  /^total\s+equity/i,
  /^total\s+liabilities\s+and/i,
  // ── Any row starting with "Total" (catch-all for when is_total isn't set) ──
  // Mirrors the same test used in the extraction service to flag total rows.
  // False-positive risk for accounts like "Total Gas Service" is acceptable —
  // the extraction already marks these as is_total=true in the normal path.
  /^total\b/i,
  // ── Top-level section header labels that leak when is_total isn't set ─────
  /^(current\s+)?assets?\s*$/i,
  /^(current|fixed|other|long.?term)\s+(assets?|liabilit(?:y|ies))\s*$/i,
  /^liabilit(?:y|ies)(\s+and\s+equity)?\s*$/i,
  /^equity\s*$/i,
  /^liabilities\s*&\s*equity\s*$/i,
  /^total\s+liabilities\s*&\s*equity/i,
  // ── Cash flow section labels ──────────────────────────────────────────────
  /^net\s+cash\s+(provided|used)/i,
  /^net\s+cash\s+increase/i,
  /^cash\s+at\s+(beginning|end)/i,
];

function isSummaryRow(name) {
  return SUMMARY_PATTERNS.some(p => p.test(String(name || "").trim()));
}

// ─── COA loading ──────────────────────────────────────────────────────────────

async function loadCoa(versionId) {
  const cols = [
    "id", "system_id", "account_name", "account_number",
    "account_type", "statement_type", "adjusted_name", "base_account",
    "parent_account_id", "metadata", "cf_category",
    ...LEVEL_KEYS, "hierarchy_path", "is_active", "sort_order",
  ].join(", ");

  const { data, error } = await supabase
    .from("chart_of_accounts")
    .select(cols)
    .eq("version_id", versionId)
    .eq("is_active", true)
    // CONFIRMED ROOT CAUSE (fixed here) of non-reproducible Balance Sheet
    // figures (Net Income / Retained Earnings differing between identical,
    // repeated report-generation calls): sort_order is NOT guaranteed unique
    // (confirmed live: 52 of 289 chart_of_accounts rows for one real version
    // shared a sort_order value with another row). Ordering by sort_order
    // ALONE leaves ties unresolved, so Postgres/PostgREST does not guarantee
    // a stable relative order between two same-sort_order rows across
    // separate query executions — the array order of COA leaves could differ
    // call to call. generateYearlyBs's GL-carry-forward fallback maps
    // balances onto leaves via first-match-wins fuzzy matching
    // (buildFuzzyLookup/fuzzyMatch), so an unstable leaf order could silently
    // redirect a real balance to a different account on different runs,
    // corrupting Net Income and (since Retained Earnings is the balancing
    // residual) Retained Earnings along with it. `id` is a real, unique,
    // stable tie-breaker — never changes the intended sort_order ordering,
    // only resolves ties within it deterministically.
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`COA load: ${error.message}`);
  const all = data || [];
  // needs_mapping accounts (coaMappingService found no match against any other
  // chart_of_accounts row, not even fuzzy — see
  // chartOfAccountsService.buildLeafHierarchies) have no hierarchy and no
  // parent_account_id. Excluding them here means their GL/BS amounts fall
  // through to the existing "couldn't match any COA leaf" unmappedSet
  // tracking (same path as a name that isn't in the COA at all) instead of
  // silently counting toward a total under an incomplete/missing hierarchy.
  const unmapped = [];
  const accounts = all.filter((a) => {
    if (a.metadata?.needs_mapping) { unmapped.push(a); return false; }
    return true;
  });
  if (unmapped.length) {
    console.log(`[FinStmt][COA] ${unmapped.length} account(s) did not match an existing Chart of Accounts hierarchy. Marked needs_mapping=true. Excluded from reports until manually mapped: ${unmapped.map(a => a.account_name).join(", ")}`);
  }
  const leaves = accounts.filter(a => !a.metadata?.is_group);
  const groups = accounts.filter(a => a.metadata?.is_group);
  console.log(`[FinStmt][COA] ${accounts.length} accounts (${leaves.length} leaves, ${groups.length} groups)`);
  // Carried as extra properties (not a shape change) so existing callers that
  // treat this as a plain array keep working; callers that care about the
  // unmapped count (e.g. validation reporting) can read them.
  accounts.unmappedCount = unmapped.length;
  accounts.unmappedNames = unmapped.map((a) => a.account_name);
  return accounts;
}

// ─── COA tree builder ─────────────────────────────────────────────────────────

/**
 * Build a parent→children tree from the full COA account list using parent_account_id.
 *
 * Returns:
 *   byId  : Map<id, treeNode>     — every account as a tree node
 *   roots : treeNode[]            — accounts whose parent is outside the version
 *   leaves: treeNode[]            — accounts with metadata.is_group = false
 */
function buildTree(coaAccounts) {
  const byId = new Map();
  for (const acc of coaAccounts) {
    byId.set(acc.id, {
      ...acc,
      isGroup: Boolean(acc.metadata?.is_group),
      children: [],
      // Filled by rollupNode:
      signedAmount: 0,
      displayAmount: 0,
      // Filled by assignAmounts:
      leafAmount: 0,
    });
  }

  const roots = [];
  for (const [id, node] of byId) {
    if (node.parent_account_id && byId.has(node.parent_account_id)) {
      byId.get(node.parent_account_id).children.push(node);
    } else {
      roots.push(node);
    }
  }

  const leaves = Array.from(byId.values()).filter(n => !n.isGroup);
  return { byId, roots, leaves };
}

// ─── COA mappings bridge ───────────────────────────────────────────────────────
// The Chart of Accounts rows ARE the mapping: each leaf's source name(s) and
// number map to its account id. (The former coa_account_mappings table was a
// precomputed copy of exactly this — it has been removed; we build it in-memory
// from the COA leaves, which is both authoritative and always in sync.)

// buildMappings / buildFuzzyLookup / fuzzyMatch now live in accountNameMatching.js
// (shared with coaMappingService — see the top-of-file import).

// ─── Tree rollup ──────────────────────────────────────────────────────────────

/**
 * Sign convention for rolling up amounts toward a net income / net assets figure.
 * Income and asset accounts add positively; expenses subtract.
 */
const ROLLUP_SIGN = { income: 1, cogs: -1, expense: -1, asset: 1, liability: 1, equity: 1 };

/**
 * Recursively compute signedAmount and displayAmount for every node.
 * Leaves: take amount from leafAmountById, apply sign.
 * Parents: sum children's signedAmounts.
 */
function rollupNode(node, leafAmountById) {
  if (!node.isGroup) {
    // Leaf: raw amount (always positive from entries) × sign
    const raw = safeNum(leafAmountById.get(node.id) || 0);
    // No fallback sign for an unrecognized/null account_type — every leaf that
    // reaches here should already carry one of the 6 known types; a missing one
    // means classification is incomplete, and it must contribute nothing rather
    // than be silently guessed as asset-like.
    const sign = ROLLUP_SIGN[node.account_type] ?? 0;
    node.leafAmount = raw;
    node.signedAmount = raw * sign;
    node.displayAmount = raw; // always positive for individual account display
    return;
  }
  // Group: recurse then aggregate
  for (const child of node.children) rollupNode(child, leafAmountById);
  node.signedAmount = node.children.reduce((s, c) => s + c.signedAmount, 0);
  node.displayAmount = Math.abs(node.signedAmount);
}

// ─── Statement builders ───────────────────────────────────────────────────────

/**
 * Determine the display label for an expense/COGS group: the direct parent
 * node's name when it's a real category (not a root rollup anchor like
 * "Total Equity"), else the deepest real category in the leaf's OWN copied
 * hierarchy (level_1..level_15) — never a fixed level index, since depth is
 * no longer guaranteed once hierarchy comes from the client's own COA rather
 * than a fixed taxonomy.
 *
 * The P&L fixed anchor is Total Liabilities and Equity > Total Equity >
 * Total Equity (chartOfAccountsService's PL_FIXED_PREFIX) — every one of its
 * labels is already covered by ROOT_ANCHOR_RE (below), so a P&L leaf whose
 * direct parent — or whose nearest ancestor — IS one of those bare anchor
 * labels has literally no document heading of its own (a genuinely flat P&L
 * for that account) and falls through to the "Other"/literal-fallback rather
 * than being mislabelled with the anchor's own name. There is no P&L-only
 * anchor label left to suppress beyond that, so this reuses ROOT_ANCHOR_RE
 * directly instead of a separate, easily-drifting PL-only regex.
 */
function groupLabelFor(node, byId) {
  if (node.parent_account_id) {
    const parent = byId.get(node.parent_account_id);
    if (parent) {
      const parentName = displayName(parent);
      if (parentName && !ROOT_ANCHOR_RE.test(parentName.trim())) {
        return parentName;
      }
    }
  }
  const own = displayName(node);
  // hierarchy_path (unpadded, real path) rather than level_1..15 (padded past
  // real depth with the leaf's own parent category — see buildDynamicHierarchy's
  // doc comment for why level_N alone isn't reliably reversible).
  const ancestry = (node.hierarchy_path ? String(node.hierarchy_path).split(" > ") : []).filter(Boolean);
  if (ancestry.length && ancestry[ancestry.length - 1] === own) ancestry.pop();
  return [...ancestry].reverse().find((l) => !ROOT_ANCHOR_RE.test(l)) || "Other";
}

/**
 * Section header label for one P&L section (Revenue / Cost of Sales /
 * Operating Expenses). Derived with the SAME rule groupLabelFor uses — direct
 * parent node when it's a real category, else a reverse scan of the leaf's own
 * level_1..level_15 skipping recognized rollup anchors — and NEVER a fixed
 * level index.
 *
 * CONFIRMED BUG this fixes: these three labels used to read level_6 || level_7
 * directly, which only ever worked because the old 9-level P&L anchor happened
 * to park "Total Revenue"/"Total Expenses" at those exact positions. The P&L
 * anchor is now 3 levels (Total Liabilities and Equity > Total Equity > Net
 * Income) and everything below it comes from the uploaded document at
 * whatever depth that document has — so level_6/level_7 is either an
 * arbitrary deep document category or, for a shallow account, just the leaf's
 * own name repeated by padLevelsWithLeafPropagation. Same class of problem
 * groupLabelFor's own comment already calls out ("never a fixed level index,
 * since depth is no longer guaranteed"); same solution, reused rather than
 * reinvented.
 *
 * Takes the label the MOST leaves in the section agree on rather than
 * trusting whichever leaf happens to be first in the array — a section with
 * one oddly-nested account should not be renamed by it. Falls back to the
 * caller's literal when no leaf yields a real label (an empty section, or
 * every leaf sitting bare under the anchor) — which reproduces today's
 * default strings exactly.
 */
function plSectionLabelFor(nodes, byId, fallback) {
  const counts = new Map();
  for (const n of nodes) {
    const label = groupLabelFor(n, byId);
    if (!label || label === "Other") continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [label, count] of counts) {
    if (count > bestCount) { best = label; bestCount = count; }
  }
  return best || fallback;
}

/**
 * Build P&L statement from the rolled-up tree.
 *
 * All per-account amounts = displayAmount (positive).
 * Totals = calculated from leaf sums; never read from entry summary rows.
 */
function buildPlStatement(leaves, byId) {
  const income = leaves.filter(n => n.account_type === "income");
  const cogs = leaves.filter(n => n.account_type === "cogs");
  const expense = leaves.filter(n => n.account_type === "expense");

  // Amounts come from the DB (numeric 18,2) — preserve exact precision; do NOT
  // apply Math.round() to individual account amounts.
  const toLeaf = (n) => ({
    systemId: n.system_id || null,
    accountNumber: n.account_number || null,
    name: displayName(n),
    adjustedName: n.adjusted_name || null,
    hierarchyPath: n.hierarchy_path || null,
    amount: safeNum(n.displayAmount),
    // Assigned once at COA classification time (reportTagRules) — QoE/KPI read
    // this instead of scanning account/group names by keyword.
    reportTag: n.metadata?.report_tag || null,
  });

  // Revenue — flat list, total = sum of income leaves.
  // QB GL uses natural-balance convention: revenue credit amounts arrive POSITIVE
  // (increases in the account's natural credit direction are stored as positive).
  // No sign flip needed. Contra-revenue (sales returns, discounts) arrive NEGATIVE
  // in the GL and naturally reduce Total Revenue without any special handling.
  const incomeAccounts = income.map(toLeaf);
  const totalRevenue = safeNum(incomeAccounts.reduce((s, a) => s + a.amount, 0));

  // Cost of Sales — flat list (the frontend reads costOfSales.accounts[])
  const cogsAccounts = cogs.map(toLeaf);
  const totalCogs = safeNum(cogsAccounts.reduce((s, a) => s + a.amount, 0));

  // Gross Profit — calculated
  const grossProfit = safeNum(totalRevenue - totalCogs);

  // Operating Expenses — grouped by direct parent category node name
  const expenseGroupMap = {};
  for (const n of expense) {
    const grp = groupLabelFor(n, byId);
    if (!expenseGroupMap[grp]) expenseGroupMap[grp] = { label: grp, accounts: [], total: 0 };
    const leaf = toLeaf(n);
    expenseGroupMap[grp].accounts.push(leaf);
    expenseGroupMap[grp].total = safeNum(expenseGroupMap[grp].total + leaf.amount);
  }
  const totalExpenses = safeNum(Object.values(expenseGroupMap).reduce((s, g) => s + g.total, 0));
  const operatingIncome = safeNum(grossProfit - totalExpenses);
  const netIncome = operatingIncome;

  const incomeSectionLabel = plSectionLabelFor(income, byId, "Total Revenue");
  const cogsSectionLabel = plSectionLabelFor(cogs, byId, "Cost of Sales");
  const expenseSectionLabel = plSectionLabelFor(expense, byId, "Total Expenses");

  // Genuine N-level trees — same buildDynamicHierarchy convention as the
  // Balance Sheet's assets/liabilities/equity above, walking each leaf's own
  // level_1..level_15 straight from chart_of_accounts. This is what the P&L
  // statement view (keyReportFinancials.js) recurses through so a document's
  // real sub-category depth beneath Revenue/Cost of Sales/Operating Expenses
  // survives instead of collapsing to one grouping level or a flat list.
  // incomeAccounts/cogsAccounts/expenseGroupMap above are kept unchanged —
  // keyReportReportService.js's QoE/EBITDA schedules read those flat/grouped
  // shapes directly and must keep working exactly as they do today.
  const incomeHierarchyResult = buildDynamicHierarchy(income, PL_ANCHOR_DEPTH);
  const cogsHierarchyResult = buildDynamicHierarchy(cogs, PL_ANCHOR_DEPTH);
  const expenseHierarchyResult = buildDynamicHierarchy(expense, PL_ANCHOR_DEPTH);
  logHierarchyRenderVerification("Profit & Loss Revenue", incomeHierarchyResult.verification);
  logHierarchyRenderVerification("Profit & Loss Cost of Sales", cogsHierarchyResult.verification);
  logHierarchyRenderVerification("Profit & Loss Operating Expenses", expenseHierarchyResult.verification);

  return {
    revenue: {
      label: incomeSectionLabel,
      accounts: incomeAccounts,
      hierarchy: incomeHierarchyResult.tree,
      total: totalRevenue,
    },
    costOfSales: {
      label: cogsSectionLabel,
      accounts: cogsAccounts,      // flat list — matches frontend expectation
      hierarchy: cogsHierarchyResult.tree,
      total: totalCogs,
    },
    grossProfit,
    operatingExpenses: {
      label: expenseSectionLabel,
      groups: expenseGroupMap,
      hierarchy: expenseHierarchyResult.tree,
      total: totalExpenses,
    },
    operatingIncome,
    pretaxIncome: operatingIncome,
    netIncome,
  };
}

// The universal current/non-current bifurcation every Balance Sheet ratio
// (Current Ratio, Quick Ratio — see getKpiReport) needs, regardless of what
// the client calls their own categories. This is the one place a bounded
// keyword match is unavoidable: it only ever classifies a label ALREADY
// copied onto this row from chart_of_accounts — it never invents one.
const FIXED_ASSET_RE = /fixed|property|equipment|\bppe\b/i;
const OTHER_ASSET_RE = /^other|long.?term asset|noncurrent asset|non.current asset/i;
const LONG_TERM_LIAB_RE = /long.?term|noncurrent|non.current/i;
// Root rollup anchors are never a useful "group" label for an account that
// sits directly under them with no real category in between.
const ROOT_ANCHOR_RE = /^total\s+(assets?|liabilit(?:y|ies)|liabilities\s+and\s+equity|equity)$/i;

/**
 * "Hierarchy Consistency Verification" (item 7) — for every rendered Balance
 * Sheet account, prints its stored COA levels vs. the path buildDynamicHierarchy
 * actually placed it under (re-derived by walking the FINAL built tree, not
 * just echoing construction — see buildDynamicHierarchy's own comment).
 * PASS for every account is the expected, steady-state result; any FAIL means
 * an account's real chart_of_accounts hierarchy diverged from what got
 * rendered, and is the untouched source of truth to trust over the render.
 */
function logHierarchyRenderVerification(label, verification) {
  const failures = verification.filter((v) => !v.pass);
  console.log(
    `Hierarchy Consistency Verification (${label})\n` +
    `  Accounts Checked: ${verification.length}\n` +
    `  Pass: ${verification.length - failures.length}\n` +
    `  Fail: ${failures.length}`,
  );
  if (failures.length) {
    console.error(
      `[FinStmt][${label}] HIERARCHY RENDER MISMATCH — ${failures.length} account(s) rendered under a different ` +
      `path than their own stored chart_of_accounts levels imply:\n` +
      failures.slice(0, 20).map((f) =>
        `  Account: ${f.account}\n` +
        `  COA Levels: ${f.coaLevels.join(" > ")}\n` +
        `  Rendered Path: ${f.renderedPath.join(" > ")}\n` +
        `  Status: FAIL`,
      ).join("\n\n"),
    );
  }
}

/**
 * Generic, statement-agnostic hierarchy builder — walks any set of posting
 * leaves' own level_1..level_15 columns into a genuine N-level Tree → Node →
 * Children → Leaf structure. No regex, no keyword matching, no fixed bucket
 * names, no depth cap. Shared by every statement section (Balance Sheet
 * assets/liabilities/equity, Profit & Loss revenue/cost of sales/expenses) so
 * none of them ever reconstruct a different hierarchy or discard COA's real
 * Level 3+/4+ document-driven structure — chart_of_accounts is the single
 * source of truth for ALL of them alike.
 */
function buildDynamicHierarchy(accs, skipContainers = 0) {
  const roots = [];
  const rootIndex = new Map();
  const expectedByLeafId = new Map(); // leaf id -> { account, coaLevels, expectedPath }

  for (const n of accs) {
    const own = displayName(n);
    // Read the REAL (unpadded) path from hierarchy_path, not level_1..15.
    // chartOfAccountsService pads every posting leaf's level_1..15 out to 15
    // populated columns by repeating its immediate parent category past its
    // real depth (a DB-schema completeness requirement) — that repeated tail
    // is not always reliably distinguishable from real structure by pattern-
    // matching alone (a single trailing padded level is indistinguishable
    // from a genuinely deep 15-level account). hierarchy_path is written by
    // the same single source of truth (deriveLevelsFromPersistedTree) from
    // the exact same walked parent_account_id chain, but deliberately kept
    // unpadded — so it remains the unambiguous source for real structure.
    const rawLevels = (n.hierarchy_path ? String(n.hierarchy_path).split(" > ") : []).filter(Boolean);

    // Collapse ALL consecutive duplicates (not just a fixed offset) — this
    // correctly handles the double fixed-anchor prefix (e.g. "Total Assets"
    // appearing twice in a row), with no assumption about how many anchor
    // levels precede the real category chain.
    const collapsed = [];
    for (const label of rawLevels) {
      if (!collapsed.length || collapsed[collapsed.length - 1] !== label) collapsed.push(label);
    }
    const hasOwnLeaf = collapsed.length && collapsed[collapsed.length - 1] === own;
    let containers = hasOwnLeaf ? collapsed.slice(0, -1) : collapsed;
    // skipContainers drops the leading N (post-collapse) fixed-anchor levels
    // for callers that already render an explicit wrapper for that anchor
    // (e.g. the P&L "Revenue"/"Cost of Sales"/"Operating Expenses" headers,
    // which stand in for the shared Total Liabilities and Equity > Total
    // Equity accounting-equation bridge) — everything AFTER the anchor is
    // still the untouched, document-driven category chain.
    if (skipContainers > 0) containers = containers.slice(skipContainers);

    let siblings = roots;
    let index = rootIndex;
    let parentId = "bsnode";
    for (const label of containers) {
      let node = index.get(label);
      if (!node) {
        node = { id: `${parentId}/${label}`, name: label, type: "container", children: [], amount: 0, _childIndex: new Map() };
        index.set(label, node);
        siblings.push(node);
      }
      parentId = node.id;
      siblings = node.children;
      index = node._childIndex;
    }

    const leaf = {
      id: n.id, name: own, type: "leaf",
      systemId: n.system_id || null,
      accountNumber: n.account_number || null,
      adjustedName: n.adjusted_name || null,
      hierarchyPath: n.hierarchy_path || null,
      amount: safeNum(n.displayAmount),
      reportTag: n.metadata?.report_tag || null,
      children: [],
    };
    siblings.push(leaf);
    expectedByLeafId.set(n.id, { account: own, coaLevels: rawLevels, expectedPath: [...containers, own] });
  }

  // Roll up container totals bottom-up (post-order) — a container's amount
  // is always the sum of its own children, never independently computed.
  const rollup = (node) => {
    if (node.type === "leaf") return node.amount;
    node.amount = safeNum(node.children.reduce((sum, c) => sum + rollup(c), 0));
    return node.amount;
  };
  for (const r of roots) rollup(r);

  // Verification (item 7): re-walk the ACTUAL, already-built tree from the
  // root to find each leaf by id and record the container names genuinely
  // encountered along the way — an independent cross-check against
  // expectedPath (derived straight from this leaf's own COA levels above),
  // not just an echo of what construction just did. Catches a real defect
  // class construction alone can't (e.g. two accounts' labels colliding
  // into the wrong shared node).
  const verification = [];
  const walk = (nodes, pathSoFar) => {
    for (const node of nodes) {
      if (node.type === "leaf") {
        const expected = expectedByLeafId.get(node.id);
        const actualPath = [...pathSoFar, node.name];
        const pass = expected ? JSON.stringify(expected.expectedPath) === JSON.stringify(actualPath) : false;
        verification.push({ account: node.name, coaLevels: expected?.coaLevels || [], renderedPath: actualPath, pass });
      } else {
        walk(node.children, [...pathSoFar, node.name]);
      }
    }
  };
  walk(roots, []);

  const strip = (node) => {
    const { _childIndex, ...rest } = node;
    rest.children = node.children.map(strip);
    return rest;
  };
  return { tree: roots.map(strip), verification };
}

/**
 * Build Balance Sheet statement from the rolled-up tree.
 * Section (Current/Fixed/Other Assets, Current/Long-Term Liabilities) and
 * group (the account's own client-defined category, e.g. "Vehicles", "Credit
 * Cards", "Benefits - 401k") both come directly from the leaf's own copied
 * hierarchy (level_1..level_15) — never from walking ancestor node display
 * names, which can disagree with the leaf's own stored levels whenever
 * category-node materialization collapses or skips a level (chartOfAccounts
 * Service.buildDesiredCategories/syncCategoryNodes).
 */
function buildBsStatement(leaves, byId) {
  const assets = leaves.filter(n => n.account_type === "asset");
  const liabilities = leaves.filter(n => n.account_type === "liability");
  const equities = leaves.filter(n => n.account_type === "equity");

  // Preserve exact DB precision — do NOT apply Math.round() to individual amounts.
  const toLeaf = (n) => ({
    systemId: n.system_id || null,
    accountNumber: n.account_number || null,
    name: displayName(n),
    adjustedName: n.adjusted_name || null,
    hierarchyPath: n.hierarchy_path || null,
    amount: safeNum(n.displayAmount),
    // Assigned once at COA classification time (reportTagRules) — QoE/KPI read
    // this instead of scanning account/group names by keyword.
    reportTag: n.metadata?.report_tag || null,
  });

  // ══════════════════════════════════════════════════════════════════════
  // KPI-ONLY current/non-current classification — ISOLATED, never used for
  // Balance Sheet rendering (see buildDynamicHierarchy below for that).
  //
  // keyReportReportService.js's KPI report (Current Ratio, Quick Ratio,
  // Working Capital) genuinely needs a bounded current/non-current split for
  // its AGGREGATE TOTALS, regardless of what the client calls their own
  // categories — that is a real accounting concept (current vs. long-term),
  // not a hierarchy. This is the one place a bounded keyword match is
  // legitimate: it only ever classifies a label ALREADY copied onto this row
  // from chart_of_accounts — it never invents, renames, or displays one.
  // Function/variable names are deliberately explicit (KPI-prefixed) so this
  // never gets mistaken for hierarchy construction again.
  function resolveKpiCurrentNonCurrent(n) {
    const own = displayName(n);
    // hierarchy_path (unpadded, real path), not level_1..15 -- see
    // buildDynamicHierarchy's doc comment.
    const ancestry = (n.hierarchy_path ? String(n.hierarchy_path).split(" > ") : []).filter(Boolean);
    if (ancestry.length && ancestry[ancestry.length - 1] === own) ancestry.pop();

    const grpLabel = [...ancestry].reverse().find((l) => !ROOT_ANCHOR_RE.test(l)) || "Other";

    let secLabel;
    if (n.account_type === "liability") {
      secLabel = ancestry.some((l) => LONG_TERM_LIAB_RE.test(l)) ? "Long-Term Liabilities" : "Current Liabilities";
    } else if (ancestry.some((l) => FIXED_ASSET_RE.test(l))) {
      secLabel = "Fixed Assets";
    } else if (ancestry.some((l) => OTHER_ASSET_RE.test(l))) {
      secLabel = "Other Assets";
    } else {
      secLabel = "Current Assets";
    }
    return { secLabel, grpLabel };
  }

  function buildKpiBuckets(accs) {
    const sections = {};
    for (const n of accs) {
      const { secLabel, grpLabel } = resolveKpiCurrentNonCurrent(n);
      if (!sections[secLabel]) sections[secLabel] = { label: secLabel, groups: {}, total: 0 };
      if (!sections[secLabel].groups[grpLabel]) sections[secLabel].groups[grpLabel] = { label: grpLabel, accounts: [], total: 0 };
      const leaf = toLeaf(n);
      sections[secLabel].groups[grpLabel].accounts.push(leaf);
      sections[secLabel].groups[grpLabel].total = safeNum(sections[secLabel].groups[grpLabel].total + leaf.amount);
      sections[secLabel].total = safeNum(sections[secLabel].total + leaf.amount);
    }
    return sections;
  }

  const assetKpiBuckets = buildKpiBuckets(assets);
  const liabKpiBuckets = buildKpiBuckets(liabilities);

  // buildDynamicHierarchy is the single, module-level hierarchy-construction
  // function shared by every section of every statement (see its own doc
  // comment above) — chart_of_accounts level_1..level_15 is the only source
  // of truth for the Balance Sheet AND the Profit & Loss alike.
  const assetHierarchyResult = buildDynamicHierarchy(assets);
  const liabHierarchyResult = buildDynamicHierarchy(liabilities);
  const equityHierarchyResult = buildDynamicHierarchy(equities);
  logHierarchyRenderVerification("Balance Sheet Assets", assetHierarchyResult.verification);
  logHierarchyRenderVerification("Balance Sheet Liabilities", liabHierarchyResult.verification);
  logHierarchyRenderVerification("Balance Sheet Equity", equityHierarchyResult.verification);

  // Flat leaf list retained ONLY for the accounting-equation reconciliation
  // below (balanceRetainedEarnings scans equity.accounts by name) and for the
  // total sum — never used for display, see equity.hierarchy below.
  const equityAccounts = equities.map(toLeaf);

  const totalAssets = safeNum(Object.values(assetKpiBuckets).reduce((s, sec) => s + sec.total, 0));
  const totalLiabilities = safeNum(Object.values(liabKpiBuckets).reduce((s, sec) => s + sec.total, 0));
  const totalEquity = safeNum(equityAccounts.reduce((s, a) => s + a.amount, 0));
  const totalLE = safeNum(totalLiabilities + totalEquity);
  const difference = safeNum(totalAssets - totalLE);

  // KPI-only buckets — never used for display (see buildDynamicHierarchy above).
  const currentAssets = assetKpiBuckets["Current Assets"] || { label: "Current Assets", groups: {}, total: 0 };
  const fixedAssets = assetKpiBuckets["Fixed Assets"] || { label: "Fixed Assets", groups: {}, total: 0 };
  const otherAssets = assetKpiBuckets["Other Assets"] || { label: "Other Assets", groups: {}, total: 0 };

  const currentLiab = liabKpiBuckets["Current Liabilities"] || { label: "Current Liabilities", groups: {}, total: 0 };
  const longTermLiab = liabKpiBuckets["Long-Term Liabilities"] || { label: "Long-Term Liabilities", groups: {}, total: 0 };

  return {
    assets: {
      label: assets[0]?.level_1 || "Total Assets",
      // Kept for keyReportReportService.js's KPI report (Current Ratio,
      // Working Capital) only — never used for display, see buildDynamicHierarchy.
      currentAssets: { label: currentAssets.label, groups: currentAssets.groups, total: currentAssets.total },
      fixedAssets: { label: fixedAssets.label, groups: fixedAssets.groups, total: fixedAssets.total },
      otherAssets: { label: otherAssets.label, groups: otherAssets.groups, total: otherAssets.total },
      // The single source of truth for rendering: a genuine N-level tree
      // built directly from chart_of_accounts level_1..level_15 — no fixed
      // bucket names, no depth cap. This is what the frontend recurses through.
      hierarchy: assetHierarchyResult.tree,
      total: totalAssets,
    },
    liabilities: {
      label: "Liabilities",
      // Kept for the KPI report only — never used for display.
      currentLiabilities: { label: currentLiab.label, groups: currentLiab.groups, total: currentLiab.total },
      longTermLiabilities: { label: longTermLiab.label, groups: longTermLiab.groups, total: longTermLiab.total },
      hierarchy: liabHierarchyResult.tree,
      total: totalLiabilities,
    },
    equity: {
      label: "Equity",
      accounts: equityAccounts,
      // Genuine N-level tree, same convention as assets/liabilities above —
      // the frontend recurses through this for display; equityAccounts
      // (flat) stays only for the retained-earnings reconciliation.
      hierarchy: equityHierarchyResult.tree,
      total: totalEquity,
    },
    totalAssets,
    totalLiabilities,
    totalEquity,
    totalLiabilitiesAndEquity: totalLE,
    balanced: Math.abs(difference) < 1,
    difference,
  };
}

// ─── Equity reconciliation — enforce the accounting equation ──────────────────

const RE_NAME_RE = /^retained\s+earnings/i;
const NI_NAME_RE = /^net\s*(income|loss)/i;

/**
 * Recompute every container node's `amount` as the sum of its children
 * (post-order). buildDynamicHierarchy rolls up totals once at construction
 * time; after a leaf's amount is corrected in place (see
 * syncEquityHierarchyAmount below), ancestor containers must be re-summed or
 * they keep showing the stale pre-correction total.
 */
function rollupHierarchyAmounts(nodes) {
  let sum = 0;
  for (const node of nodes || []) {
    if (node.type === "leaf") {
      sum += safeNum(node.amount);
    } else {
      node.amount = rollupHierarchyAmounts(node.children);
      sum += node.amount;
    }
  }
  return sum;
}

/**
 * Find every leaf (recursively — container depth is client-driven, not fixed)
 * whose name matches `nameRe`.
 */
function findHierarchyLeaves(nodes, nameRe, out = []) {
  for (const node of nodes || []) {
    if (node.type === "leaf") {
      if (nameRe.test(node.name || "")) out.push(node);
    } else {
      findHierarchyLeaves(node.children, nameRe, out);
    }
  }
  return out;
}

/**
 * CONFIRMED ROOT CAUSE (fixed here) of "Net Income renders as 0/blank on the
 * Balance Sheet" (both monthly and yearly): buildBsStatement builds TWO
 * independent representations of the same equity accounts — `equity.accounts`
 * (a flat list, used only by balanceRetainedEarnings/reconcileEquityYearly/
 * reconcileEquityMonthly to enforce Assets = Liabilities + Equity) and
 * `equity.hierarchy` (a separate tree of its own leaf objects, built once in
 * buildDynamicHierarchy and never touched again — this is what the frontend
 * actually renders). A real "Net Income" chart_of_accounts leaf almost never
 * has its own GL postings (it's a derived roll-forward, not a transactable
 * account), so its hierarchy-tree leaf starts at 0 and, absent this fix,
 * stayed at 0 forever even after the flat list was corrected to the true
 * cumulative P&L figure — confirmed live: the tree leaf for a real "Net
 * Income" account (systemId BS-043) held 0 in every month of 2023 while the
 * flat account correctly held 92,355.50 (Jan) growing to 360,460.11 (Mar),
 * dragging every ancestor container total (Equity/Total Equity/Total
 * Liabilities and Equity) down to a value that never changed month to month.
 *
 * Mirrors an already-reconciled flat-account amount onto the SAME-NAMED
 * leaf(ves) inside `equity.hierarchy`, then re-rolls every container total so
 * the correction is visible all the way up the tree. When no real leaf exists
 * for this name (a client with no such COA account at all), a synthetic leaf
 * is appended at the tree's top level — mirroring the exact fallback
 * `eq.accounts.push` already uses for the flat list, so the two never diverge
 * on WHETHER the line exists, only never on its value.
 */
function syncEquityHierarchyAmount(equity, nameRe, amount, fallbackName) {
  if (!equity) return;
  equity.hierarchy = equity.hierarchy || [];
  const leaves = findHierarchyLeaves(equity.hierarchy, nameRe);
  if (leaves.length) {
    // Multiple same-named leaves is not the normal case, but split rather than
    // duplicate the total so the tree's own sum stays internally consistent.
    const share = safeNum(amount) / leaves.length;
    for (const leaf of leaves) leaf.amount = share;
  } else {
    equity.hierarchy.push({
      id: `bsnode/${fallbackName}`, name: fallbackName, type: "leaf",
      systemId: null, accountNumber: null, adjustedName: null,
      hierarchyPath: null, amount: safeNum(amount), reportTag: null, children: [],
    });
  }
  rollupHierarchyAmounts(equity.hierarchy);
}

/**
 * Enforce Assets = Liabilities + Equity for a SINGLE balance-sheet statement by
 * setting Retained Earnings to the residual equity:
 *
 *   Retained Earnings = Total Assets − Total Liabilities − Other Equity − Net Income
 *
 * This is the textbook definition of retained earnings as the balancing equity
 * account. It guarantees the statement balances for EVERY period — monthly and
 * yearly alike — while leaving Net Income (from the P&L / cumulative snapshot) and
 * every other equity account (contributions, draws, distributions, paid-in
 * capital) exactly as classified by the COA. In a consistent GL this residual
 * equals the true accumulated retained earnings (verified against the client's
 * 2022–2024 statements); if the GL is inconsistent it still balances and the
 * discrepancy surfaces as a shifted Retained Earnings rather than a broken sheet.
 *
 * Nothing is hardcoded — works for any company.
 */
function balanceRetainedEarnings(statement) {
  const s = statement;
  const eq = s?.equity;
  if (!eq) return;
  eq.accounts = eq.accounts || [];

  const netIncome = eq.accounts
    .filter(a => NI_NAME_RE.test(a.name || ""))
    .reduce((sum, a) => sum + safeNum(a.amount), 0);
  const otherEquity = eq.accounts
    .filter(a => !RE_NAME_RE.test(a.name || "") && !NI_NAME_RE.test(a.name || ""))
    .reduce((sum, a) => sum + safeNum(a.amount), 0);

  const retained = safeNum(s.totalAssets - s.totalLiabilities - otherEquity - netIncome);

  let reAcc = eq.accounts.find(a => RE_NAME_RE.test(a.name || ""));
  if (reAcc) {
    reAcc.amount = retained;
  } else {
    eq.accounts.push({
      systemId: null, accountNumber: null,
      name: "Retained Earnings", adjustedName: "Retained Earnings",
      amount: retained,
    });
  }

  eq.total = safeNum(eq.accounts.reduce((sum, a) => sum + safeNum(a.amount), 0));
  s.totalEquity = eq.total;
  s.totalLiabilitiesAndEquity = safeNum(s.totalLiabilities + s.totalEquity);
  s.difference = safeNum(s.totalAssets - s.totalLiabilitiesAndEquity);
  s.balanced = Math.abs(s.difference) < 1;

  // Mirror the just-computed residual onto the rendered tree — see
  // syncEquityHierarchyAmount's doc comment for why this is required at all.
  syncEquityHierarchyAmount(eq, RE_NAME_RE, retained, "Retained Earnings");
}

/**
 * Reconcile the equity section of every YEARLY statement:
 *   1. Current-year Net Income  = generated P&L Net Income (requirement 5).
 *      Falls back to an existing uploaded Net-Income line only when the GL
 *      produced no P&L for that year.
 *   2. Retained Earnings        = residual that balances the sheet
 *      (via balanceRetainedEarnings).
 */
function reconcileEquityYearly(bsYearly, plYearly) {
  for (let idx = 0; idx < bsYearly.length; idx++) {
    const eq = bsYearly[idx]?.statement?.equity;
    if (!eq) continue;
    eq.accounts = eq.accounts || [];

    const plNI = safeNum(plYearly[idx]?.statement?.netIncome);
    let niAcc = eq.accounts.find(a => NI_NAME_RE.test(a.name || ""));
    const currentNI = Math.abs(plNI) > 0.005 ? plNI : safeNum(niAcc?.amount);
    if (niAcc) {
      niAcc.amount = currentNI;
    } else {
      eq.accounts.push({ systemId: null, accountNumber: null, name: "Net Income", adjustedName: "Net Income", amount: currentNI });
    }
    syncEquityHierarchyAmount(eq, NI_NAME_RE, currentNI, "Net Income");

    balanceRetainedEarnings(bsYearly[idx].statement);
  }
}

/**
 * CONFIRMED ROOT CAUSE (fixed here): reconcileEquityYearly above already
 * guarantees the Balance Sheet's Net Income equals the generated P&L's Net
 * Income at the YEARLY grain — but nothing analogous ever ran for MONTHLY
 * entries. generateMonthlyBs derives each month's "Net Income" account from
 * its own GL roll-forward, independently of generateMonthlyPl's own
 * per-month figure; the two are computed by different code paths and are
 * not guaranteed to agree (confirmed live: every month of a real company's
 * FY2024 showed a different Balance Sheet Net Income than that same month's
 * generated P&L Net Income). The stale comment that used to sit at this
 * call site ("each month-end snapshot already carries its cumulative Net
 * Income from the P&L roll-forward") was aspirational, not actual behavior.
 *
 * Mirrors reconcileEquityYearly at the monthly grain: within one fiscal
 * year, Net Income for month M is the CUMULATIVE (year-to-date) sum of that
 * same year's own generated P&L Net Income through month M — never an
 * independently-rederived monthly figure. Retained Earnings is then reset to
 * the balancing residual (balanceRetainedEarnings) so every month still
 * balances. NOTE: the cumulative-of-monthly total is NOT guaranteed to equal
 * generateYearlyPl's own separately-computed yearly figure — those two are
 * independent P&L code paths that can disagree with each other (a distinct,
 * pre-existing issue this change does not touch); this function only
 * guarantees the Balance Sheet always matches whichever P&L figure it is
 * itself paired with (monthly BS <-> monthly P&L, yearly BS <-> yearly P&L).
 */
function reconcileEquityMonthly(bsMonthsForYear, plMonthsForYear) {
  const plByMonth = new Map();
  for (const p of plMonthsForYear || []) plByMonth.set(Number(p.monthNumber), safeNum(p.statement?.netIncome));

  const sortedMonths = (bsMonthsForYear || []).slice().sort((a, b) => Number(a.monthNumber) - Number(b.monthNumber));
  let cumulative = 0;
  for (const monthEntry of sortedMonths) {
    const eq = monthEntry?.statement?.equity;
    if (!eq) continue;
    eq.accounts = eq.accounts || [];

    cumulative = safeNum(cumulative + (plByMonth.get(Number(monthEntry.monthNumber)) || 0));
    const niAcc = eq.accounts.find(a => NI_NAME_RE.test(a.name || ""));
    if (niAcc) {
      niAcc.amount = cumulative;
    } else {
      eq.accounts.push({ systemId: null, accountNumber: null, name: "Net Income", adjustedName: "Net Income", amount: cumulative });
    }
    syncEquityHierarchyAmount(eq, NI_NAME_RE, cumulative, "Net Income");

    balanceRetainedEarnings(monthEntry.statement);
  }
}

// ─── Statement type filters ────────────────────────────────────────────────────

const PL_TYPES = new Set(["income", "cogs", "expense"]);
const BS_TYPES = new Set(["asset", "liability", "equity"]);

function isPlAccount(acc) {
  return acc.statement_type === "profit_loss" ||
    (acc.statement_type == null && PL_TYPES.has(acc.account_type));
}

function isBsAccount(acc) {
  return acc.statement_type === "balance_sheet" ||
    (acc.statement_type == null && BS_TYPES.has(acc.account_type));
}

// Dynamic COA insertion during report generation has been fully removed — it
// violated the client's required workflow. All GL accounts are placed in the
// COA before Phase 3 (ensureCoaComplete in Phase 2c); anything still unmatched
// at report time is tracked in unmappedSet and excluded, never auto-inserted.

// ─── Distinct years ───────────────────────────────────────────────────────────

async function distinctYears(versionId) {
  // Years are sourced from the General Ledger (the accounting source of truth) and
  // uploaded Balance Sheets. There is no profit_loss_entries table — P&L years are
  // implied by the GL. Exclude is_generated BS rows so accumulated generated rows
  // never push real uploaded-year rows out. Filter GL by TRANSACTION row_type to
  // skip ACCOUNT_HEADER rows.
  //
  // GL years now come straight from transaction_date (migration 069 —
  // fiscal_year/fiscal_month no longer exist on general_ledger_entries; every
  // TRANSACTION/BEGINNING_BALANCE/TOTAL_ROW row always has a real date now, so
  // there is no more "fiscal_year is null" fallback branch to run separately).
  //
  // IMPORTANT: every one of these reads uses fetchAllRows (.range() pagination),
  // never a bare .limit(N) — Supabase/PostgREST caps a single query response at
  // its server-side "Max Rows" setting (commonly 1000) regardless of the client
  // .limit() value, which was silently truncating multi-thousand-row General
  // Ledgers to their first page and losing every year after the first ~1000 rows.
  // CONFIRMED ROOT CAUSE class (see loadCoa's doc comment for the full
  // writeup) — every fetchAllRows call in this file needs an explicit,
  // unique-tie-broken .order() so its .range() pagination can never
  // skip/duplicate a row across a page boundary. `id` is added purely as a
  // stable pagination tie-breaker; it never changes which rows are returned,
  // only guarantees every page boundary lands in the same place every call.
  let bsData;
  try {
    bsData = await fetchAllRows(() =>
      supabase.from("balance_sheet_entries").select("id, fiscal_year")
        .eq("version_id", versionId)
        .or("is_generated.is.null,is_generated.eq.false")
        .order("id", { ascending: true }),
    );
  } catch (err) {
    console.warn(`[FinStmt][Years] BS query error: ${err.message} — falling back to unfiltered`);
    bsData = await fetchAllRows(() =>
      supabase.from("balance_sheet_entries").select("id, fiscal_year").eq("version_id", versionId)
        .order("id", { ascending: true }),
    );
    console.log("[FinStmt][Years] BS unfiltered fallback succeeded");
  }

  const glRows = await fetchAllRows(() =>
    supabase.from("general_ledger_entries")
      .select("id, transaction_date, source_file_id, account_name")
      .eq("version_id", versionId)
      .or("row_type.eq.TRANSACTION,row_type.is.null")
      .not("transaction_date", "is", null)
      .order("id", { ascending: true }),
  );

  const glYearOf = (row) => parseInt(String(row.transaction_date || "").slice(0, 4), 10);

  const set = new Set();
  for (const row of (bsData || [])) {
    const y = Number(row.fiscal_year);
    if (y >= 1990 && y <= 2100) set.add(y);
  }
  for (const row of glRows) {
    const y = glYearOf(row);
    if (y >= 1990 && y <= 2100) set.add(y);
  }
  const years = Array.from(set).sort((a, b) => a - b);

  // Diagnostics: total GL rows retrieved, distinct years, distinct source
  // file IDs, distinct account count — printed every time so a truncated read is
  // immediately visible in the logs instead of silently producing missing years.
  const glDistinctYears = Array.from(new Set(glRows.map(glYearOf))).sort((a, b) => a - b);
  const distinctSourceFiles = new Set(glRows.map((r) => r.source_file_id).filter(Boolean));
  const distinctAccounts = new Set(glRows.map((r) => String(r.account_name || "").trim()).filter(Boolean));
  console.log(
    `[FinStmt][Years] GL totalRows=${glRows.length} distinctYears=[${glDistinctYears.join(",")}] ` +
    `distinctSourceFileIds=${distinctSourceFiles.size} distinctAccounts=${distinctAccounts.size}`,
  );
  console.log(
    `[FinStmt][Years] bs=${bsData?.length || 0} gl=${glRows.length} → [${years.join(", ")}]`,
  );
  return years;
}

/**
 * Lightweight per-version period metadata for the Reports page's Monthly/Yearly
 * filter defaults. Deliberately does NOT reuse distinctYears() (which fetches
 * every GL/BS row just to derive years) — each bound below is a single
 * order-by-and-limit-1 query, so this never loads more than a handful of rows
 * regardless of how large the version's GL is.
 *
 * Monthly bounds come from general_ledger_entries.transaction_date (the GL is
 * mandatory for every generated version — see the Phase 1 validation gate — so
 * it's a safe, always-present source). Yearly bounds widen that with
 * balance_sheet_entries.fiscal_year (uploaded rows only, is_generated
 * excluded) in case an opening/ending Balance Sheet falls outside the GL's own
 * date span.
 */
async function getAvailablePeriods(versionId) {
  if (!versionId) throw new Error("versionId is required");

  const firstRow = async (table, column, ascending, filters = (q) => q) => {
    let query = supabase.from(table).select(column).eq("version_id", versionId).not(column, "is", null);
    query = filters(query);
    const { data } = await query.order(column, { ascending }).limit(1).maybeSingle();
    return data ? data[column] : null;
  };

  const [glMinDate, glMaxDate, bsMinYear, bsMaxYear] = await Promise.all([
    firstRow("general_ledger_entries", "transaction_date", true, (q) =>
      q.or("row_type.eq.TRANSACTION,row_type.is.null")),
    firstRow("general_ledger_entries", "transaction_date", false, (q) =>
      q.or("row_type.eq.TRANSACTION,row_type.is.null")),
    firstRow("balance_sheet_entries", "fiscal_year", true, (q) =>
      q.or("is_generated.is.null,is_generated.eq.false")),
    firstRow("balance_sheet_entries", "fiscal_year", false, (q) =>
      q.or("is_generated.is.null,is_generated.eq.false")),
  ]);

  const glMinYear = glMinDate ? Number(String(glMinDate).slice(0, 4)) : null;
  const glMaxYear = glMaxDate ? Number(String(glMaxDate).slice(0, 4)) : null;
  const yearCandidates = [glMinYear, bsMinYear ? Number(bsMinYear) : null].filter((y) => Number.isInteger(y));
  const yearMaxCandidates = [glMaxYear, bsMaxYear ? Number(bsMaxYear) : null].filter((y) => Number.isInteger(y));

  return {
    monthly: { min: glMinDate || null, max: glMaxDate || null },
    yearly: {
      min: yearCandidates.length ? Math.min(...yearCandidates) : null,
      max: yearMaxCandidates.length ? Math.max(...yearMaxCandidates) : null,
    },
  };
}

// ─── Generated-row probe ──────────────────────────────────────────────────────
// True when the Phase-4 monthly engine has stored generated (is_generated=true)
// Balance Sheet rows for the year — used to prefer them over uploaded balance sheets.

async function hasGeneratedRows(table, versionId, year) {
  try {
    const { count, error } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("version_id", versionId)
      .eq("fiscal_year", year)
      .eq("is_generated", true);
    if (error) return false;
    return (count || 0) > 0;
  } catch { return false; }
}

// NOTE: persistGeneratedPl / persistGeneratedBs were removed. Profit & Loss is
// generated live from the GL (never persisted); Balance Sheets are generated +
// STORED by the Phase-4 monthly engine during sync, not lazily on read.

// ─── Yearly P&L ───────────────────────────────────────────────────────────────

async function generateYearlyPl(_companyId, versionId, year, allCoa, unmappedSet) {
  const plAccounts = allCoa.filter(isPlAccount);
  const plLeaves = plAccounts.filter(a => !a.metadata?.is_group);

  // Profit & Loss is generated ENTIRELY from the General Ledger (client
  // requirement — there is no profit_loss_entries table). Map each GL account's
  // yearly movement onto its P&L leaf via the COA name/number map + fuzzy fallback.
  //
  // Uses loadGlAmountsYearly (not loadGlAmountsByMonth) so that GL rows with a
  // valid fiscal_year but a null/missing transaction_date are included in the
  // yearly totals. loadGlAmountsByMonth silently drops those rows because it
  // cannot assign them to a month bucket, causing Total Expenses / Net Income to
  // be understated relative to the Trial Balance.
  const leafAmounts = new Map(plLeaves.map(a => [a.id, 0]));
  // coaLeafId → normalized entity key → bucket, for this single yearly period.
  const leafVendors = new Map();
  const leafCustomers = new Map();
  const gl = await loadGlAmountsYearly(versionId, year);
  if (gl) {
    // gl's key is a coa_id whenever the GL row was linked (authoritative — see
    // loadGlAmountsYearly); glMappings/fuzzyLookup are only the fallback for a
    // key that's still a normalized name (row missing coa_id).
    const glMappings = buildMappings(plLeaves);
    const fuzzyLookup = buildFuzzyLookup(plLeaves);
    for (const [key, { rawName, accountNumber, total, vendors, customers, linked }] of gl) {
      const totalAmt = total;
      if (Math.abs(totalAmt) < 0.005) continue;
      // Entity rows follow the amount onto whichever leaves it lands on, split
      // identically -- recorded per branch below, then propagated once.
      const propagate = (mappedIds) => {
        propagateEntitiesToLeaves(leafVendors, mappedIds, vendors, year);
        propagateEntitiesToLeaves(leafCustomers, mappedIds, customers, year);
      };
      if (leafAmounts.has(key)) {
        leafAmounts.set(key, (leafAmounts.get(key) || 0) + totalAmt);
        propagate([key]);
        continue;
      }
      // CONFIRMED BUG this guard fixes: a row already linked to a real coa_id
      // that simply isn't a P&L leaf (e.g. an asset account like "Furniture &
      // Equipment") must be excluded from P&L, never re-attributed by name/
      // fuzzy matching to a different, merely similarly-named P&L leaf (e.g.
      // "Furniture & Equipment < 2500", a genuinely distinct account with its
      // own coa_id). Confirmed live: this fuzzy match added $71,868 of real
      // Balance Sheet asset activity onto an unrelated Expense leaf for
      // FY2023, understating Net Income by exactly that amount. Name/fuzzy
      // matching is only a legitimate fallback for a row that was NEVER
      // linked at all (linked === false) — coa_id is the single source of
      // truth for classification; a resolved-but-non-P&L account is never
      // reclassified by text similarity.
      if (linked) continue;
      const normKey = norm(rawName);
      let ids = glMappings?.get(normKey);
      if (!ids?.length && accountNumber) ids = glMappings?.get(`__num__${String(accountNumber).trim()}`);
      if (ids?.length) {
        for (const id of ids) {
          if (!leafAmounts.has(id)) leafAmounts.set(id, 0);
          leafAmounts.set(id, (leafAmounts.get(id) || 0) + totalAmt / ids.length);
        }
        propagate(ids);
      } else {
        const match = fuzzyMatch(fuzzyLookup, rawName, accountNumber);
        if (match?.id && leafAmounts.has(match.id)) {
          leafAmounts.set(match.id, (leafAmounts.get(match.id) || 0) + totalAmt);
          propagate([match.id]);
        } else {
          unmappedSet.add(normKey);
        }
      }
    }
  } else {
    console.warn(`[FinStmt][PL][${year}] no GL transactions — P&L renders zero (GL is the only P&L source)`);
  }

  const { byId, roots, leaves } = buildTree(plAccounts);
  for (const leaf of leaves) {
    const node = byId.get(leaf.id);
    if (node) node.leafAmount = leafAmounts.get(leaf.id) || 0;
  }
  for (const root of roots) rollupNode(root, leafAmounts);

  const stmt = buildPlStatement(leaves, byId);
  console.log(`[FinStmt][PL][${year}] rev=${stmt.revenue.total} cogs=${stmt.costOfSales.total} gp=${stmt.grossProfit} exp=${stmt.operatingExpenses.total} ni=${stmt.netIncome}`);

  const reconCtx = { companyId: _companyId, versionId };
  warnIfVendorReconciliationMismatch("P&L yearly vendors", leafAmounts, leafVendors, year, plLeaves, reconCtx);
  warnIfVendorReconciliationMismatch("P&L yearly customers", leafAmounts, leafCustomers, year, plLeaves, reconCtx);

  const vendorsByAccount = serializeEntitiesByAccount(leafVendors, plLeaves);
  const customersByAccount = serializeEntitiesByAccount(leafCustomers, plLeaves);
  logKrEntityDiagnostic({
    grain: "yearly", companyId: _companyId, versionId, period: year,
    glRowCount: gl ? gl.size : 0, vendorsByAccount, customersByAccount,
  });

  return {
    year: String(year),
    periodLabel: `FY ${year}`,
    statement: stmt,
    vendorsByAccount,
    customersByAccount,
  };
}

// ─── Monthly P&L ─────────────────────────────────────────────────────────────

// Fallback when GL has no transaction_date usable for per-account P&L grouping:
// distribute the yearly P&L statement proportionally across months.
//
// Month list priority (mirrors generateMonthlyBs logic so columns stay in sync):
//   1. Multiple distinct as_of_date values in balance_sheet_entries → use those
//   2. Only 1 date (year-end snapshot) → call aggregateGLForBSByMonth for the GL
//      month list (same source that drives BS monthly via generateMonthlyBsFromGL)
//
// Distribution strategy:
//   • If ≥ half the months have a "Net Income" row in BS entries: proportional to
//     incremental monthly NI (YTD-delta).
//   • Otherwise: equal split across all months.
async function generateMonthlyPlFromYearly(versionId, year, yearlyStatement) {
  const yearlyNI = safeNum(yearlyStatement?.netIncome);

  const hasGen = await hasGeneratedRows("balance_sheet_entries", versionId, year);
  const genFilter = (q) => hasGen
    ? q.eq("is_generated", true)
    : q.or("is_generated.is.null,is_generated.eq.false");

  let bsEntries;
  try {
    bsEntries = await fetchAllRows(() => {
      let q = genFilter(
        supabase
          .from("balance_sheet_entries")
          .select("id, account_name, amount, as_of_date, row_type")
          .eq("version_id", versionId)
          .eq("fiscal_year", year)
          .or("is_total.eq.false,is_total.is.null")
      );
      // id tie-breaker — see loadCoa's doc comment for the confirmed root
      // cause this class of fix addresses (unstable pagination across calls).
      return q.order("as_of_date", { ascending: true }).order("id", { ascending: true });
    });
  } catch (_e) { return []; }

  if (!bsEntries?.length) return [];

  // row_type (migration 085): headings/subtotals/metadata now persist too.
  // Net Income is often persisted as row_type='total' (QB marks it a total)
  // but this loop's whole purpose is detecting that exact row — never filter
  // it out. Only heading/subtotal/metadata/footer rows are excluded here.
  const NI_KW = /net.*(income|loss)/i;
  bsEntries = bsEntries.filter((e) => !e.row_type || e.row_type === 'account' || e.row_type === 'total' || NI_KW.test(String(e.account_name || '')));
  // Step 1: Collect every distinct as_of_date AND its YTD Net Income if present.
  const byDate = new Map();
  for (const e of bsEntries) {
    if (!e.as_of_date) continue;
    const monthNum = parseInt(e.as_of_date.slice(5, 7), 10);
    if (!(monthNum >= 1 && monthNum <= 12)) continue;
    if (!byDate.has(e.as_of_date)) byDate.set(e.as_of_date, { date: e.as_of_date, monthNum, niYTD: 0, hasNI: false });
    if (NI_KW.test(e.account_name)) {
      byDate.get(e.as_of_date).niYTD += safeNum(e.amount);
      byDate.get(e.as_of_date).hasNI = true;
    }
  }

  let sortedDates = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));

  // Step 2: When BS only has one date (year-end snapshot), fall back to the GL
  // month list AND actual monthly net income from aggregateGLForBSByMonth.
  // This is the same data source that drives generateMonthlyBsFromGL, so P&L
  // monthly columns match BS monthly exactly AND each month's weight reflects
  // the real GL activity for that month (not equal distribution).
  if (sortedDates.length <= 1) {
    const glByMonth = await aggregateGLForBSByMonth(versionId, year);
    if (glByMonth?.size) {
      const glMonths = Array.from(glByMonth.keys()).sort((a, b) => a - b);
      let cumNI = 0;
      sortedDates = glMonths.map(monthNum => {
        cumNI += safeNum(glByMonth.get(monthNum)?.netIncome);
        return {
          date: `${year}-${String(monthNum).padStart(2, "0")}-28`,
          monthNum,
          niYTD: cumNI,   // cumulative (YTD) NI through this month
          hasNI: true,    // use proportional distribution, not equal split
        };
      });
    }
  }

  if (!sortedDates.length) return [];

  // Use proportional NI only when most months have the Net Income row; otherwise
  // split equally so monthly columns match BS monthly without distortion.
  const niCount = sortedDates.filter(d => d.hasNI).length;
  const useNI = niCount >= Math.ceil(sortedDates.length / 2);
  const n = sortedDates.length;

  console.log(`[FinStmt][PL][${year}] monthly fallback: ${n} months, ${niCount} with NI → ${useNI ? "proportional" : "equal"} split`);

  const scaleAccounts = (accounts, ratio) =>
    (accounts || []).map(a => ({ ...a, amount: round2(safeNum(a.amount) * ratio) }));

  const scaleStmt = (stmt, ratio) => {
    const revenue = {
      label: stmt.revenue?.label,
      accounts: scaleAccounts(stmt.revenue?.accounts, ratio),
      total: round2(safeNum(stmt.revenue?.total) * ratio),
    };
    const costOfSales = {
      label: stmt.costOfSales?.label,
      accounts: scaleAccounts(stmt.costOfSales?.accounts, ratio),
      total: round2(safeNum(stmt.costOfSales?.total) * ratio),
    };
    const grossProfit = round2(safeNum(stmt.grossProfit) * ratio);
    const scaledGroups = {};
    for (const [g, gv] of Object.entries(stmt.operatingExpenses?.groups || {})) {
      scaledGroups[g] = {
        label: gv.label,
        accounts: scaleAccounts(gv.accounts, ratio),
        total: round2(safeNum(gv.total) * ratio),
      };
    }
    const totalExpenses = round2(safeNum(stmt.operatingExpenses?.total) * ratio);
    const operatingIncome = round2(safeNum(stmt.operatingIncome) * ratio);
    return {
      revenue,
      costOfSales,
      grossProfit,
      operatingExpenses: { label: stmt.operatingExpenses?.label, groups: scaledGroups, total: totalExpenses },
      operatingIncome,
      pretaxIncome: operatingIncome,
      netIncome: operatingIncome,
    };
  };

  return sortedDates.map((curr, i) => {
    let ratio;
    if (useNI) {
      const prevYTD = i > 0 ? sortedDates[i - 1].niYTD : 0;
      const monthNI = curr.niYTD - prevYTD;
      ratio = Math.abs(yearlyNI) > 0.01 ? monthNI / yearlyNI : 1 / n;
    } else {
      ratio = 1 / n;
    }

    return {
      month: MONTH_NAMES[curr.monthNum - 1],
      monthNumber: curr.monthNum,
      year: String(year),
      periodLabel: `${MONTH_NAMES[curr.monthNum - 1]} ${year}`,
      statement: scaleStmt(yearlyStatement, ratio),
      // This fallback scales a YEARLY statement by a ratio -- there is no
      // per-month GL detail behind it, so there is no honest way to attribute a
      // counterparty to a month. Emitted empty (never null) so the frontend's
      // lookup is uniform across every period shape.
      vendorsByAccount: {},
      customersByAccount: {},
    };
  });
}

/**
 * Yearly GL accumulation for generateYearlyPl.
 *
 * Reads ALL TRANSACTION (or null row_type) rows for the year via transaction_date
 * range. fiscal_year/fiscal_month no longer exist on general_ledger_entries
 * (migration 069 — date_dimension refactor). Historically some GL rows carried
 * a valid fiscal_year but a null transaction_date (manual journal entries /
 * year-end adjustments); migration 069 backfills a sentinel transaction_date
 * (fiscal_year-06-30) for any such pre-existing row before dropping the column,
 * so a plain date-range filter here is safe and cannot silently drop them the
 * way it could before that backfill existed. New rows always have a real date
 * — validateRows() in generalLedgerExtractionService.js rejects any dateless
 * TRANSACTION row at extraction time.
 *
 * loadGlAmountsByMonth remains unchanged in intent and is still used for MONTHLY P&L.
 */
async function loadGlAmountsYearly(versionId, year) {
  let data;
  try {
    // CONFIRMED ROOT CAUSE (fixed here) of non-reproducible Net Income /
    // Retained Earnings: this query had NO .order() at all — fetchAllRows'
    // .range() pagination over an unordered result set has no guarantee two
    // separate calls partition the same rows onto the same pages, so a real
    // GL row could be silently skipped on one call and included on the next,
    // corrupting the yearly total those calls fed into P&L Net Income (and
    // from there, via reconcileEquityYearly/balanceRetainedEarnings, into
    // Retained Earnings). `id` is a stable, unique tie-breaker — it never
    // changes the SUM (order doesn't affect addition), only guarantees every
    // page boundary lands in the same place every call.
    data = await fetchAllRows(() =>
      supabase
        .from("general_ledger_entries")
        // vendor/customer: see loadGlAmountsByMonth -- same migration-068 entity
        // dimension, same version_id-only scoping.
        .select("id, account_name, split_account, account_number, amount, transaction_date, coa_id, split_coa_id, vendor, customer, entity_type")
        .eq("version_id", versionId)
        .gte("transaction_date", `${year}-01-01`)
        .lte("transaction_date", `${year}-12-31`)
        .or("row_type.eq.TRANSACTION,row_type.is.null")
        .order("id", { ascending: true }),
    );
  } catch (err) { console.warn(`[FinStmt][GL][${year}] yearly read failed: ${err.message}`); return null; }
  if (!data?.length) return null;

  // Keyed by coa_id when the row is linked (authoritative — no name matching);
  // falls back to norm(name) only for a row still missing coa_id. `linked`
  // records WHICH case produced this entry — the consumer (generateYearlyPl)
  // must only attempt name/fuzzy matching when linked is false. A linked
  // entry whose coa_id simply isn't a P&L leaf (e.g. an asset account) is a
  // resolved, correct classification — it belongs on the Balance Sheet, not
  // P&L — and must never be re-attributed to a different, merely
  // similarly-named P&L leaf by the fuzzy fallback.
  const byAccount = new Map();
  const coaIdsWithOwnRow = new Set();
  for (const row of data) {
    const rawName = String(row.account_name || "").trim();
    if (!rawName || isSummaryRow(rawName)) continue;
    const key = row.coa_id || norm(rawName);
    if (row.coa_id) coaIdsWithOwnRow.add(row.coa_id);
    if (!byAccount.has(key)) {
      byAccount.set(key, {
        rawName, accountNumber: row.account_number, total: 0,
        vendors: new Map(), customers: new Map(), linked: Boolean(row.coa_id),
      });
    }
    const acc = byAccount.get(key);
    const amount = safeNum(row.amount);
    acc.total += amount;
    // Single period in yearly mode -- the year itself is the period key.
    accumulateGlRowEntities(acc, row, year, amount);
  }

  // split_coa_id fallback — mirrors keyReportReportService.aggregateGLByAccount's
  // distCoaIdsSeen rule: pick up an account that only ever appears via
  // split_coa_id this year (e.g. a partial GL export), attributed under its own
  // coa_id, but only if it doesn't already have its own account_name row (avoids
  // double-counting). Kept identical in intent to the Balance Sheet/Cash Flow
  // aggregator so P&L and Financial Statements agree on Net Income for the same
  // version+year.
  for (const row of data) {
    if (!row.split_coa_id || coaIdsWithOwnRow.has(row.split_coa_id)) continue;
    const splitName = String(row.split_account || "").trim();
    if (!splitName || isSummaryRow(splitName)) continue;
    if (!byAccount.has(row.split_coa_id)) {
      byAccount.set(row.split_coa_id, {
        rawName: splitName, accountNumber: null, total: 0,
        vendors: new Map(), customers: new Map(), linked: true,
      });
    }
    const acc = byAccount.get(row.split_coa_id);
    const amount = safeNum(row.amount);
    acc.total += amount;
    // The counterparty on the split line is the same row's counterparty.
    accumulateGlRowEntities(acc, row, year, amount);
  }

  console.log(`[FinStmt][GL][${year}] yearly: ${data.length} rows → ${byAccount.size} accounts`);
  return byAccount.size ? byAccount : null;
}

async function loadGlAmountsByMonth(versionId, year) {
  // Include rows where row_type is null — those are pre-migration-050 transaction
  // rows that were extracted before the TRANSACTION / ACCOUNT_HEADER enum was added.
  // fiscal_year no longer exists (migration 069) — a plain transaction_date range
  // filter is sufficient now that pre-existing dateless rows have been backfilled
  // with a sentinel date (see loadGlAmountsYearly's docstring).
  let data;
  try {
    // See loadGlAmountsYearly's identical fix — an id tie-breaker keeps
    // pagination stable across calls (never changes the per-month sums).
    data = await fetchAllRows(() =>
      supabase
        .from("general_ledger_entries")
        // vendor/customer/entity_type (migration 068) are selected so the entity
        // dimension the extraction service already persists reaches the report
        // instead of being discarded at read time. version_id below is the only
        // scope that matters for isolation -- it is a FK to key_report_versions,
        // so a company's other versions and every other company are excluded by
        // construction, and there is no unscoped entity query anywhere.
        .select("id, account_name, account_number, amount, transaction_date, coa_id, vendor, customer, entity_type")
        .eq("version_id", versionId)
        .gte("transaction_date", `${year}-01-01`)
        .lte("transaction_date", `${year}-12-31`)
        .or("row_type.eq.TRANSACTION,row_type.is.null")
        .order("id", { ascending: true }),
    );
  } catch (err) { console.warn(`[FinStmt][GL] ${err.message}`); return null; }
  if (!data?.length) return null;

  // Keyed by coa_id when linked (authoritative); norm(name) fallback only for
  // a row still missing coa_id.
  // { rawName, accountNumber, months: Map<month, amount>,
  //   vendors/customers: Map<normKey, { display, periods: Map<month, amount>, total }> }
  const byAccount = new Map();
  const monthsFound = new Set();

  for (const row of data) {
    const rawName = String(row.account_name || "").trim();
    if (!rawName || isSummaryRow(rawName)) continue;
    const dateStr = String(row.transaction_date || "");
    const month = parseInt(dateStr.slice(5, 7), 10);
    if (!(month >= 1 && month <= 12)) continue;

    const key = row.coa_id || norm(rawName);
    monthsFound.add(month);
    if (!byAccount.has(key)) {
      byAccount.set(key, {
        rawName, accountNumber: row.account_number, months: new Map(),
        vendors: new Map(), customers: new Map(), linked: Boolean(row.coa_id),
      });
    }
    const acc = byAccount.get(key);
    const amount = safeNum(row.amount);
    acc.months.set(month, (acc.months.get(month) || 0) + amount);
    accumulateGlRowEntities(acc, row, month, amount);
  }

  console.log(`[FinStmt][GL] FY${year}: ${data.length} rows (fully paginated) → ${byAccount.size} accounts, months=[${Array.from(monthsFound).sort().join(",")}]`);
  return monthsFound.size ? { byAccount, monthsFound } : null;
}

async function generateMonthlyPl(_companyId, versionId, year, allCoa, unmappedSet, yearlyStatement = null) {
  const gl = await loadGlAmountsByMonth(versionId, year);
  if (!gl) {
    // GL has no transaction_date — fall back to proportional distribution of the
    // yearly P&L across months, scaled by monthly Net Income from BS equity changes.
    if (yearlyStatement) return generateMonthlyPlFromYearly(versionId, year, yearlyStatement);
    return [];
  }

  const plAccounts = allCoa.filter(isPlAccount);
  const plLeaves = plAccounts.filter(a => !a.metadata?.is_group);
  const glMappings = buildMappings(plLeaves);
  const fuzzyLookup = buildFuzzyLookup(plLeaves);

  // Pre-pass: ensure all GL accounts are mapped in COA. gl.byAccount's key is a
  // coa_id whenever the row was linked (authoritative — see
  // loadGlAmountsByMonth); glMappings/fuzzyLookup only cover a key that's still
  // a normalized name (row missing coa_id).
  const plLeafIds = new Set(plLeaves.map(a => a.id));
  for (const [key, { rawName, accountNumber, months: monthMap, linked }] of gl.byAccount) {
    if (plLeafIds.has(key)) continue;
    // A linked row whose coa_id simply isn't a P&L leaf is correctly
    // classified elsewhere (Balance Sheet) — never name/fuzzy-matched to a
    // different P&L account. See generateYearlyPl's identical guard for the
    // confirmed production bug this prevents.
    if (linked) continue;
    const totalAmt = Array.from(monthMap.values()).reduce((s, v) => s + v, 0);
    if (Math.abs(totalAmt) < 0.005) continue;
    const normKey = norm(rawName);
    let ids = glMappings?.get(normKey);
    if (!ids?.length && accountNumber) ids = glMappings?.get(`__num__${String(accountNumber).trim()}`);
    if (!ids?.length) {
      const match = fuzzyMatch(fuzzyLookup, rawName, accountNumber);
      if (!match?.id) {
        unmappedSet.add(normKey);
      }
    }
  }

  const months = Array.from(gl.monthsFound).sort((a, b) => a - b);

  return months.map((monthNum) => {
    const leafAmounts = new Map(plLeaves.map(a => [a.id, 0]));
    // coaLeafId → normalized entity key → { display, periods, total } for this month
    const leafVendors = new Map();
    const leafCustomers = new Map();

    for (const [key, { rawName, accountNumber, months: monthMap, vendors, customers, linked }] of gl.byAccount) {
      const rawAmt = monthMap.get(monthNum) || 0;
      if (Math.abs(rawAmt) < 0.005) continue;

      let mappedIds = null;
      if (leafAmounts.has(key)) {
        // key is this row's own coa_id — authoritative, no name matching.
        leafAmounts.set(key, (leafAmounts.get(key) || 0) + rawAmt);
        mappedIds = [key];
      } else if (linked) {
        // Linked to a real coa_id that isn't a P&L leaf (e.g. an asset
        // account) — correctly excluded, never fuzzy-matched to a different
        // P&L account by name. See generateYearlyPl's identical guard.
      } else {
        const normKey = norm(rawName);
        let ids = glMappings?.get(normKey);
        if (!ids?.length && accountNumber) ids = glMappings?.get(`__num__${String(accountNumber).trim()}`);
        if (ids?.length) {
          for (const id of ids) {
            if (leafAmounts.has(id)) {
              leafAmounts.set(id, (leafAmounts.get(id) || 0) + rawAmt / ids.length);
            }
          }
          mappedIds = ids.filter(id => leafAmounts.has(id));
        } else {
          const match = fuzzyMatch(fuzzyLookup, rawName, accountNumber);
          if (match?.id && leafAmounts.has(match.id)) {
            leafAmounts.set(match.id, (leafAmounts.get(match.id) || 0) + rawAmt);
            mappedIds = [match.id];
          } else {
            unmappedSet.add(normKey);
          }
        }
      }

      // Propagate the vendor/customer breakdown to whichever COA leaves this
      // account's amount was mapped to, split the same way the amount was.
      propagateEntitiesToLeaves(leafVendors, mappedIds, vendors, monthNum);
      propagateEntitiesToLeaves(leafCustomers, mappedIds, customers, monthNum);
    }

    // If COA mapping produced no amounts, the tree still renders (all-zero,
    // consistent with unmappedSet already tracking why) — never guess a
    // revenue/expense split from the account name as a fallback.
    const { byId, roots, leaves } = buildTree(plAccounts);
    for (const root of roots) rollupNode(root, leafAmounts);

    const reconCtx = { companyId: _companyId, versionId };
    warnIfVendorReconciliationMismatch("P&L monthly vendors", leafAmounts, leafVendors, monthNum, plLeaves, reconCtx);
    warnIfVendorReconciliationMismatch("P&L monthly customers", leafAmounts, leafCustomers, monthNum, plLeaves, reconCtx);

    // Serialise the entity maps keyed by COA leaf display name so the frontend
    // can look them up directly via the account name shown in statement rows.
    const vendorsByAccount = serializeEntitiesByAccount(leafVendors, plLeaves);
    const customersByAccount = serializeEntitiesByAccount(leafCustomers, plLeaves);
    logKrEntityDiagnostic({
      grain: "monthly", companyId: _companyId, versionId, period: `${year}-${String(monthNum).padStart(2, "0")}`,
      glRowCount: gl.byAccount.size, vendorsByAccount, customersByAccount,
    });

    return {
      month: MONTH_NAMES[monthNum - 1],
      monthNumber: monthNum,
      year: String(year),
      periodLabel: `${MONTH_NAMES[monthNum - 1]} ${year}`,
      statement: buildPlStatement(leaves, byId),
      vendorsByAccount,
      customersByAccount,
    };
  });
}

// ─── Yearly BS ────────────────────────────────────────────────────────────────

async function generateYearlyBs(_companyId, versionId, year, allCoa, unmappedSet) {
  const bsAccounts = allCoa.filter(isBsAccount);
  const bsLeaves = bsAccounts.filter(a => !a.metadata?.is_group);

  // Yearly BS = year-end snapshot (latest as_of_date for this year).
  // Phase 4: prefer the generated monthly snapshots (authoritative); the latest
  // (December) generated snapshot is the year-end Balance Sheet. Uploaded balance
  // sheets are the opening seed + reconciliation input only.
  const hasGen = await hasGeneratedRows("balance_sheet_entries", versionId, year);
  const genFilter = (q) => hasGen
    ? q.eq("is_generated", true)
    : q.or("is_generated.is.null,is_generated.eq.false");

  const { data: dateRows } = await genFilter(
    supabase
      .from("balance_sheet_entries")
      .select("as_of_date")
      .eq("version_id", versionId)
      .eq("fiscal_year", year),
  )
    .order("as_of_date", { ascending: false })
    .limit(1);
  const latestDate = dateRows?.[0]?.as_of_date || null;

  // Load entries for the latest snapshot date only.
  const leafAmounts = new Map(bsLeaves.map(a => [a.id, 0]));
  // Load ALL rows (including is_total=true) so Net Income in the equity section of
  // an uploaded BS is not silently dropped. The is_total filter is applied in code below,
  // where we make an exception for the Net Income line.
  // CONFIRMED ROOT CAUSE (fixed here) of non-reproducible Retained Earnings:
  // this query had NO .order() at all — see loadCoa's doc comment for the
  // full writeup of why that makes fetchAllRows' pagination unstable across
  // repeated calls. This is the direct feed for a real uploaded Balance
  // Sheet's own Retained Earnings/Net Income figures.
  const entries = await fetchAllRows(() => {
    let q = genFilter(
      supabase
        .from("balance_sheet_entries")
        .select("id, account_name, account_number, amount, is_total, coa_id, row_type")
        .eq("version_id", versionId),
    );
    q = latestDate ? q.eq("as_of_date", latestDate) : q.eq("fiscal_year", year);
    return q.order("id", { ascending: true });
  });

  let hasUploadedNetIncome = false;
  let glFallbackUsed = false;

  if (!entries?.length) {
    console.warn(`[FinStmt][BS][${year}] NO balance_sheet_entries found for version=${versionId} year=${year} asOf=${latestDate || 'N/A'}. Falling back to GL carry-forward (BS=prior-year close + GL).`);

    // No uploaded balance sheet for this year → derive per-account closing
    // balances from the existing Key Reports GL carry-forward engine
    // (BS(year) = BS(year-1 closing) + GL(year)) and map them onto COA leaves.
    // This reuses bsBalancesForYear() — no new statement logic here.
    try {
      const { balances } = await bsBalancesForYear(versionId, year);
      if (balances && balances.size) {
        const fuzzyLookup = buildFuzzyLookup(bsLeaves);
        let mapped = 0;
        const mappedFromGL = new Set();
        for (const { name, balance } of balances.values()) {
          if (Math.abs(safeNum(balance)) < 0.005) continue;
          const match = fuzzyMatch(fuzzyLookup, name, null);
          if (match?.id && leafAmounts.has(match.id)) {
            leafAmounts.set(match.id, (leafAmounts.get(match.id) || 0) + safeNum(balance));
            mapped++;
            mappedFromGL.add(norm(name));
          } else {
            unmappedSet.add(norm(name));
          }
        }
        console.log(`[FinStmt][BS][${year}] GL carry-forward fallback: ${balances.size} balances, ${mapped} mapped to COA leaves`);
        glFallbackUsed = true;
      }
    } catch (err) {
      console.warn(`[FinStmt][BS][${year}] GL carry-forward fallback failed: ${err.message}`);
    }
  }

  if (entries?.length) {
    // coa_id-linked rows resolve directly (no name matching); only a row still
    // missing coa_id falls through to the name/number/fuzzy fallback below.
    const entryTotals = new Map();
    for (const e of entries) {
      const isNI = NI_NAME_RE.test(String(e.account_name || '').trim());
      // Skip calculated totals (is_total=true) UNLESS it's the Net Income equity line,
      // which QB exports mark as a total but which represents a real closing balance.
      if (e.is_total && !isNI) continue;
      // row_type (migration 085): every source row is now persisted, including
      // headings/subtotals/metadata is_total alone might miss. row_type is
      // NULL for rows persisted before this migration.
      if (e.row_type && e.row_type !== 'account' && !isNI) continue;
      if (isNI) hasUploadedNetIncome = true;
      if (e.coa_id && leafAmounts.has(e.coa_id)) {
        leafAmounts.set(e.coa_id, (leafAmounts.get(e.coa_id) || 0) + safeNum(e.amount));
        continue;
      }
      // Skip P&L subtotals ("Net Operating Income", "Total Revenue", etc.)
      // but allow the "Net Income" equity account through.
      if (!isNI && isSummaryRow(e.account_name)) continue;
      const key = norm(e.account_name);
      if (!key) continue;
      if (!entryTotals.has(key)) entryTotals.set(key, { amount: 0, rawName: e.account_name, accountNumber: e.account_number });
      entryTotals.get(key).amount += safeNum(e.amount);
    }

    const bsMappings = buildMappings(bsLeaves);
    const fuzzyLookup = buildFuzzyLookup(bsLeaves);
    const mappedKeys = new Set();

    for (const [normKey, { amount, rawName, accountNumber }] of entryTotals) {
      let ids = bsMappings?.get(normKey);
      if (!ids?.length && accountNumber) ids = bsMappings?.get(`__num__${String(accountNumber).trim()}`);
      if (ids?.length) {
        for (const id of ids) {
          if (!leafAmounts.has(id)) leafAmounts.set(id, 0);
          leafAmounts.set(id, (leafAmounts.get(id) || 0) + amount / ids.length);
        }
        mappedKeys.add(normKey);
      } else {
        const match = fuzzyMatch(fuzzyLookup, rawName, accountNumber);
        if (match?.id && leafAmounts.has(match.id)) {
          leafAmounts.set(match.id, (leafAmounts.get(match.id) || 0) + amount);
          mappedKeys.add(normKey);
        } else {
          unmappedSet.add(normKey);
        }
      }
    }
  }

  // Re-filter and rebuild the tree to include any newly dynamically added category/leaves
  const refreshedBsAccounts = allCoa.filter(isBsAccount);
  const { byId, roots, leaves } = buildTree(refreshedBsAccounts);
  for (const root of roots) rollupNode(root, leafAmounts);

  const stmt = buildBsStatement(leaves, byId);
  console.log(`[FinStmt][BS][${year}] asOf=${latestDate} assets=${stmt.totalAssets} liab=${stmt.totalLiabilities} equity=${stmt.totalEquity} balanced=${stmt.balanced} glFallback=${glFallbackUsed}`);

  // NOTE: Balance Sheets are generated + STORED by the Phase-4 monthly engine during
  // sync (keyReportAccountingService.generateMonthlyBalanceSheets). This read path no
  // longer persists — it only renders. (glFallbackUsed is retained for diagnostics.)

  return { year: String(year), asOfDate: latestDate || `${year}-12-31`, periodLabel: `FY ${year}`, statement: stmt, hasUploadedNetIncome };
}



async function generateMonthlyBsFromGL(_companyId, versionId, year, allCoa, bsLeaves, unmappedSet) {
  // Use classifyGLAccount-based monthly aggregation (no transaction_date required for yearly,
  // but transaction_date IS required per-month — returns null when absent).
  const byMonth = await aggregateGLForBSByMonth(versionId, year);
  if (!byMonth?.size) return [];

  // Year-start = prior year closing BS per leaf
  const yearStartAmounts = new Map(bsLeaves.map(a => [a.id, 0]));
  try {
    const { balances: prior } = await bsBalancesForYear(versionId, year - 1);
    if (prior?.size) {
      const lkp = buildFuzzyLookup(bsLeaves);
      for (const { name, balance } of prior.values()) {
        if (Math.abs(safeNum(balance)) < 0.005) continue;
        const m = fuzzyMatch(lkp, name, null);
        if (m?.id && yearStartAmounts.has(m.id))
          yearStartAmounts.set(m.id, (yearStartAmounts.get(m.id) || 0) + safeNum(balance));
      }
    }
  } catch (e) {
    console.warn(`[FinStmt][BS][${year}] monthly GL fallback: prior year load failed — ${e.message}`);
  }

  const bsAccounts = allCoa.filter(isBsAccount);
  const fuzzyLookup = buildFuzzyLookup(bsLeaves);
  // Find a Net Income leaf in equity section for cumulative P&L injection
  const niLeaf = bsLeaves.find(a => /net.*(income|loss)/i.test(String(a.account_name || a.name || '')))
    || bsLeaves.find(a => /retained/i.test(String(a.account_name || a.name || '')));

  const months = Array.from(byMonth.keys()).sort((a, b) => a - b);

  // cumLeafGL[leafId] = accumulated GL BS movements Jan..currentMonth
  const cumLeafGL = new Map(bsLeaves.map(a => [a.id, 0]));
  let cumNI = 0;
  const result = [];

  for (const monthNum of months) {
    const { bsMap, netIncome: monthNI } = byMonth.get(monthNum);

    // Add this month's BS account movements to cumulative totals. bsMap is
    // keyed by coa_id (see aggregateGLForBSByMonth) — when that key IS a real
    // COA leaf id, use it directly (authoritative, no name matching needed);
    // only the defensive `unlinked:name` fallback key still needs fuzzy match.
    for (const [key, { name, net }] of bsMap) {
      if (Math.abs(net) < 0.005) continue;
      if (cumLeafGL.has(key)) {
        cumLeafGL.set(key, cumLeafGL.get(key) + net);
        continue;
      }
      const match = fuzzyMatch(fuzzyLookup, name, null);
      if (match?.id && cumLeafGL.has(match.id)) {
        cumLeafGL.set(match.id, cumLeafGL.get(match.id) + net);
      } else {
        unmappedSet.add(String(name).toLowerCase().trim());
      }
    }
    cumNI += monthNI;

    // Snapshot: yearStart + cumulative GL movements through this month
    const leafAmounts = new Map(bsLeaves.map(a => [
      a.id,
      (yearStartAmounts.get(a.id) || 0) + (cumLeafGL.get(a.id) || 0),
    ]));

    // Inject cumulative net income into the equity Net Income leaf
    if (niLeaf && Math.abs(cumNI) > 0.005) {
      leafAmounts.set(niLeaf.id, (leafAmounts.get(niLeaf.id) || 0) + cumNI);
    }

    const { byId, roots, leaves } = buildTree(bsAccounts);
    for (const root of roots) rollupNode(root, leafAmounts);

    result.push({
      month: MONTH_NAMES[monthNum - 1],
      monthNumber: monthNum,
      year: String(year),
      asOfDate: `${year}-${String(monthNum).padStart(2, "0")}-28`,
      periodLabel: `${MONTH_NAMES[monthNum - 1]} ${year}`,
      statement: buildBsStatement(leaves, byId),
    });
  }

  console.log(`[FinStmt][BS][${year}] GL monthly fallback: ${result.length} month snapshots`);
  return result;
}

async function generateMonthlyBs(companyId, versionId, year, allCoa, unmappedSet) {
  const bsAccounts = allCoa.filter(isBsAccount);
  const bsLeaves = bsAccounts.filter(a => !a.metadata?.is_group);

  // Phase 4's generated monthly snapshots are a DERIVATION -- the ending Balance
  // Sheet walked backwards through GL activity. They exist so this view has a
  // month dimension when the uploaded document only states one period.
  //
  // CONFIRMED ROOT CAUSE (fixed here): they were preferred unconditionally, so
  // even a document that states every month of its own was overridden by the
  // derivation. Confirmed live once the extractor began reading all 12 period
  // columns: for January the document says Total Assets 293,161.70 while the
  // GL-derived snapshot said 283,931.50, and Accrued Revenue derived to
  // -83,830.90 against the document's 44,279.84.
  //
  // The uploaded document wins whenever it actually carries a month dimension
  // of its own (2+ distinct as_of_date). A single-period upload still falls
  // through to the derivation exactly as before -- that is what it is for.
  const uploadedDates = await fetchAllRows(() => supabase
    .from("balance_sheet_entries")
    .select("as_of_date")
    .eq("version_id", versionId)
    .eq("fiscal_year", year)
    .or("is_generated.is.null,is_generated.eq.false")
    .order("as_of_date", { ascending: true }));
  const uploadedMonthCount = new Set((uploadedDates || []).map((r) => r.as_of_date).filter(Boolean)).size;
  const preferUploaded = uploadedMonthCount >= 2;
  const hasGen = !preferUploaded && await hasGeneratedRows("balance_sheet_entries", versionId, year);
  if (preferUploaded) {
    console.log(`[generateMonthlyBs] version=${versionId} FY${year}: using the uploaded document's own ${uploadedMonthCount} monthly period(s) instead of GL-derived snapshots.`);
  }
  const allEntries = await fetchAllRows(() => {
    let q = supabase
      .from("balance_sheet_entries")
      .select("id, account_name, account_number, amount, as_of_date, coa_id, row_type")
      .eq("version_id", versionId)
      .eq("fiscal_year", year)
      .or("is_total.eq.false,is_total.is.null");
    q = hasGen
      ? q.eq("is_generated", true)
      : q.or("is_generated.is.null,is_generated.eq.false");
    // id tie-breaker — see loadCoa's doc comment for the confirmed root cause.
    return q.order("as_of_date", { ascending: true }).order("id", { ascending: true });
  });

  const byDate = new Map();
  for (const e of (allEntries || [])) {
    if (isSummaryRow(e.account_name)) continue;
    // row_type (migration 085): headings/subtotals/metadata now persist too;
    // isSummaryRow already excludes "Net Income" by name, so no carve-out
    // is needed here.
    if (e.row_type && e.row_type !== 'account') continue;
    const key = e.as_of_date || `${year}-12-31`;
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(e);
  }
  // Only one (or zero) distinct dates → fall back to GL carry-forward monthly snapshots.
  if (byDate.size <= 1) return generateMonthlyBsFromGL(companyId, versionId, year, allCoa, bsLeaves, unmappedSet);

  // Fallback matchers — only used for the rare row still missing coa_id
  // (e.g. a not-yet-relinked upload). Every row Phase E's linkBsToCoa/
  // generateMonthlyBalanceSheets already tagged resolves directly below.
  const bsMappings = buildMappings(bsLeaves);
  const fuzzyLookup = buildFuzzyLookup(bsLeaves);
  const result = [];

  for (const [dateKey, dateEntries] of Array.from(byDate).sort(([a], [b]) => a.localeCompare(b))) {
    const leafAmounts = new Map(bsLeaves.map(a => [a.id, 0]));
    const entryTotals = new Map(); // used only for the coa_id-missing fallback path
    for (const e of dateEntries) {
      if (e.coa_id && leafAmounts.has(e.coa_id)) {
        leafAmounts.set(e.coa_id, (leafAmounts.get(e.coa_id) || 0) + safeNum(e.amount));
        continue;
      }
      const key = norm(e.account_name);
      if (!key) continue;
      if (!entryTotals.has(key)) entryTotals.set(key, { amount: 0, rawName: e.account_name, accountNumber: e.account_number });
      entryTotals.get(key).amount += safeNum(e.amount);
    }
    for (const [normKey, { amount, rawName, accountNumber }] of entryTotals) {
      let ids = bsMappings?.get(normKey);
      if (!ids?.length && accountNumber) ids = bsMappings?.get(`__num__${String(accountNumber).trim()}`);
      if (ids?.length) {
        for (const id of ids) {
          if (!leafAmounts.has(id)) leafAmounts.set(id, 0);
          leafAmounts.set(id, (leafAmounts.get(id) || 0) + amount / ids.length);
        }
      } else {
        const match = fuzzyMatch(fuzzyLookup, rawName, accountNumber);
        if (match?.id && leafAmounts.has(match.id)) {
          leafAmounts.set(match.id, (leafAmounts.get(match.id) || 0) + amount);
        } else {
          // No COA match (coa_id / account number / exact / normalized /
          // fuzzy all missed). Per the client workflow, an unmapped account
          // is NEVER given an invented hierarchy or keyword-guessed type
          // mid-report — it is tracked here and excluded from the statement
          // until a human maps it in the Chart of Accounts (needs_mapping).
          unmappedSet.add(normKey);
        }
      }
    }

    const refreshedBsAccounts = allCoa.filter(isBsAccount);
    const { byId, roots, leaves } = buildTree(refreshedBsAccounts);
    for (const root of roots) rollupNode(root, leafAmounts);

    const monthNum = parseInt(dateKey.slice(5, 7), 10);
    result.push({
      month: MONTH_NAMES[monthNum - 1] || dateKey,
      monthNumber: monthNum,
      year: String(year),
      asOfDate: dateKey,
      periodLabel: `${MONTH_NAMES[monthNum - 1] || dateKey} ${year}`,
      statement: buildBsStatement(leaves, byId),
    });
  }
  return result;
}

// ─── Cash Flow ────────────────────────────────────────────────────────────────

function emptyCfStatement() {
  return {
    operatingActivities: { label: "Operating Activities", items: [], total: 0 },
    investingActivities: { label: "Investing Activities", items: [], total: 0 },
    financingActivities: { label: "Financing Activities", items: [], total: 0 },
    netCashIncrease: 0, openingCash: 0, endingCash: 0,
  };
}

/**
 * Aggregate a year's monthly Cash Flow statements (generateMonthlyCf — the
 * COA-driven cf_category engine, below) into one annual statement. Summing 12
 * monthly deltas is mathematically equivalent to the single year-over-year
 * delta (telescoping sum), so the yearly view reuses the exact same account
 * classification as the monthly view instead of a second, independently
 * classified engine — previously this called the legacy keyReportReportService
 * .getCashflowReport (buildBSFromBalances/buildPLFromGL + the shared
 * manualCashFlowService.buildCashFlow classifier), which could disagree with
 * the monthly total since it classified accounts differently.
 */
function aggregateMonthlyCfToYearly(monthlyEntries) {
  if (!monthlyEntries?.length) return emptyCfStatement();

  const sumItems = (key) => {
    const order = [];
    const byName = new Map();
    for (const m of monthlyEntries) {
      for (const item of m.statement[key].items) {
        if (!byName.has(item.name)) { order.push(item.name); byName.set(item.name, 0); }
        byName.set(item.name, byName.get(item.name) + safeNum(item.amount));
      }
    }
    return order.map((name) => ({ name, amount: round2(byName.get(name)) }));
  };
  const sumTotal = (key) => round2(monthlyEntries.reduce((s, m) => s + safeNum(m.statement[key].total), 0));

  return {
    operatingActivities: { label: "Operating Activities", items: sumItems("operatingActivities"), total: sumTotal("operatingActivities") },
    investingActivities: { label: "Investing Activities", items: sumItems("investingActivities"), total: sumTotal("investingActivities") },
    financingActivities: { label: "Financing Activities", items: sumItems("financingActivities"), total: sumTotal("financingActivities") },
    netCashIncrease: round2(monthlyEntries.reduce((s, m) => s + safeNum(m.statement.netCashIncrease), 0)),
    openingCash: safeNum(monthlyEntries[0].statement.openingCash),
    endingCash: safeNum(monthlyEntries[monthlyEntries.length - 1].statement.endingCash),
  };
}

async function generateYearlyCf(versionId, year, allCoa) {
  try {
    const monthly = await generateMonthlyCf(versionId, year, allCoa);
    return { year: String(year), periodLabel: `FY ${year}`, statement: aggregateMonthlyCfToYearly(monthly) };
  } catch (err) {
    console.warn(`[FinStmt][CF][${year}] ${err.message}`);
    return { year: String(year), periodLabel: `FY ${year}`, statement: emptyCfStatement() };
  }
}

/**
 * Name → {cfCategory, accountType} lookup built from the already-loaded COA
 * leaves, keyed by the same normalization used for every other name/entry
 * match in this file. cf_category is assigned once at COA classification time
 * (chartOfAccountsService + cfCategoryRules) — this never re-derives it.
 * accountType rides along so callers can pick the correct sign convention
 * within the "operating" bucket (current-asset deltas consume cash, current-
 * liability deltas free it up — cf_category alone doesn't distinguish them).
 */
function buildCfCategoryMap(allCoa) {
  const map = new Map();
  for (const a of allCoa || []) {
    if (a.metadata?.is_group) continue;
    const entry = { cfCategory: a.cf_category || null, accountType: a.account_type || null };
    // Keyed by coa_id (authoritative, no name matching) AND by normalized name
    // (fallback for the rare `unlinked:name` synthetic-key case in bsMap/mData).
    if (a.id) map.set(a.id, entry);
    for (const n of [a.account_name, a.adjusted_name, a.base_account]) {
      const k = norm(n);
      if (k && !map.has(k)) map.set(k, entry);
    }
  }
  return map;
}

// Fallback when GL has no transaction_date: derive monthly CF from period-over-period
// balance_sheet_entries deltas (same data source that makes BS monthly work).
async function generateMonthlyCfFromBSDeltas(versionId, year, allCoa) {
  const hasGen = await hasGeneratedRows("balance_sheet_entries", versionId, year);
  const genFilter = (q) => hasGen
    ? q.eq("is_generated", true)
    : q.or("is_generated.is.null,is_generated.eq.false");

  let entries;
  try {
    entries = await fetchAllRows(() => {
      let q = genFilter(
        supabase
          .from("balance_sheet_entries")
          .select("id, account_name, amount, as_of_date, row_type")
          .eq("version_id", versionId)
          .eq("fiscal_year", year)
          .or("is_total.eq.false,is_total.is.null")
      );
      // id tie-breaker — see loadCoa's doc comment for the confirmed root cause.
      return q.order("as_of_date", { ascending: true }).order("id", { ascending: true });
    });
  } catch (_e) { return []; }

  if (!entries?.length) return [];

  const byDate = new Map();
  for (const e of entries) {
    if (isSummaryRow(e.account_name)) continue;
    // row_type (migration 085): headings/subtotals/metadata now persist too;
    // isSummaryRow already excludes "Net Income" by name, so no carve-out
    // is needed here.
    if (e.row_type && e.row_type !== 'account') continue;
    const dateKey = e.as_of_date;
    if (!dateKey) continue;
    const monthNum = parseInt(dateKey.slice(5, 7), 10);
    if (!(monthNum >= 1 && monthNum <= 12)) continue;
    if (!byDate.has(dateKey)) byDate.set(dateKey, new Map());
    const k = norm(e.account_name);
    if (!k) continue;
    if (!byDate.get(dateKey).has(k)) byDate.get(dateKey).set(k, { name: e.account_name, amount: 0 });
    byDate.get(dateKey).get(k).amount += safeNum(e.amount);
  }

  const sortedDates = Array.from(byDate.keys()).sort();
  if (sortedDates.length < 2) return [];

  // "Net Income" is a specific named equity line QB's Balance Sheet always
  // carries (see extractedBalancesMap) — finding it by name identifies a
  // known row, it is not a 3-way accounting classification decision.
  const NI_RE = /net.*(income|loss)/i;
  const cfCategoryMap = buildCfCategoryMap(allCoa);

  let runningCash = 0;
  const result = [];

  for (let i = 1; i < sortedDates.length; i++) {
    const prevMap = byDate.get(sortedDates[i - 1]);
    const currMap = byDate.get(sortedDates[i]);
    const currDate = sortedDates[i];
    const monthNum = parseInt(currDate.slice(5, 7), 10);
    const allKeys = new Set([...prevMap.keys(), ...currMap.keys()]);

    let operatingBase = 0, wcAdj = 0, investingTotal = 0, financingTotal = 0;
    const opAdjItems = [], invItems = [], finItems = [];

    for (const k of allKeys) {
      const name = (currMap.get(k) || prevMap.get(k)).name;
      const delta = safeNum(currMap.get(k)?.amount) - safeNum(prevMap.get(k)?.amount);
      if (!delta) continue;
      const entry = cfCategoryMap.get(k);
      if (!entry?.cfCategory) continue; // cash account, or not yet classified in the COA

      if (NI_RE.test(name)) {
        operatingBase += delta;
      } else if (entry.cfCategory === "operating") {
        // Sign convention: current-asset increases consume cash, current-liability
        // increases free it up. cf_category alone doesn't distinguish the two —
        // accountType (carried alongside it from the COA) does.
        const isAssetSide = entry.accountType !== "liability";
        wcAdj += isAssetSide ? -delta : delta;
        opAdjItems.push({ name, amount: round2(isAssetSide ? -delta : delta) });
      } else if (entry.cfCategory === "investing") {
        investingTotal -= delta;
        invItems.push({ name, amount: round2(-delta) });
      } else if (entry.cfCategory === "financing") {
        financingTotal += delta;
        finItems.push({ name, amount: round2(delta) });
      }
    }

    const operatingTotal = round2(operatingBase + wcAdj);
    const netCash = round2(operatingTotal + investingTotal + financingTotal);
    const openingCash = round2(runningCash);
    runningCash += netCash;
    const endingCash = round2(runningCash);

    result.push({
      month: MONTH_NAMES[monthNum - 1],
      monthNumber: monthNum,
      year: String(year),
      periodLabel: `${MONTH_NAMES[monthNum - 1]} ${year}`,
      statement: {
        operatingActivities: {
          label: "Operating Activities",
          items: [{ name: "Net Income", amount: round2(operatingBase) }, ...opAdjItems],
          total: operatingTotal,
        },
        investingActivities: { label: "Investing Activities", items: invItems, total: round2(investingTotal) },
        financingActivities: { label: "Financing Activities", items: finItems, total: round2(financingTotal) },
        netCashIncrease: netCash,
        openingCash,
        endingCash,
      },
    });
  }

  console.log(`[FinStmt][CF][${year}] BS-delta monthly fallback: ${result.length} months`);
  return result;
}

async function generateMonthlyCf(versionId, year, allCoa) {
  try {
    const glByMonth = await aggregateGLForBSByMonth(versionId, year);
    if (!glByMonth) {
      // GL has no transaction_date — derive CF from period-over-period BS entry deltas
      return generateMonthlyCfFromBSDeltas(versionId, year, allCoa);
    }

    const cfCategoryMap = buildCfCategoryMap(allCoa);
    const months = Array.from(glByMonth.keys()).sort((a, b) => a - b);
    let runningCash = 0;

    return months.map((monthNum) => {
      const mData = glByMonth.get(monthNum);
      const operatingBase = safeNum(mData.netIncome);
      let wcAdj = 0, investingTotal = 0, financingTotal = 0;
      const opAdjItems = [], invItems = [], finItems = [];

      // mData.bsMap is keyed by coa_id (see aggregateGLForBSByMonth) — look up
      // cf_category directly by that id first (authoritative); norm(name) only
      // covers the defensive `unlinked:name` synthetic-key case.
      for (const [key, { name, net, type }] of mData.bsMap) {
        const amt = safeNum(net);
        if (!amt) continue;
        const cfCategory = (cfCategoryMap.get(key) || cfCategoryMap.get(norm(name)))?.cfCategory;
        if (!cfCategory) continue; // cash account, or not yet classified in the COA

        if (cfCategory === "operating") {
          // Current-asset increases consume cash, current-liability increases free it up.
          const isAssetSide = type !== "liability";
          wcAdj += isAssetSide ? -amt : amt;
          opAdjItems.push({ name, amount: round2(isAssetSide ? -amt : amt) });
        } else if (cfCategory === "investing") {
          investingTotal -= amt;
          invItems.push({ name, amount: round2(-amt) });
        } else if (cfCategory === "financing") {
          financingTotal += amt;
          finItems.push({ name, amount: round2(amt) });
        }
      }

      const operatingTotal = round2(operatingBase + wcAdj);
      const netCash = round2(operatingTotal + investingTotal + financingTotal);
      const openingCash = round2(runningCash);
      runningCash += netCash;
      const endingCash = round2(runningCash);

      return {
        month: MONTH_NAMES[monthNum - 1], monthNumber: monthNum,
        year: String(year), periodLabel: `${MONTH_NAMES[monthNum - 1]} ${year}`,
        statement: {
          operatingActivities: { label: "Operating Activities", items: [{ name: "Net Income", amount: round2(operatingBase) }, ...opAdjItems], total: operatingTotal },
          investingActivities: { label: "Investing Activities", items: invItems, total: round2(investingTotal) },
          financingActivities: { label: "Financing Activities", items: finItems, total: round2(financingTotal) },
          netCashIncrease: netCash, openingCash, endingCash,
        },
      };
    });
  } catch (err) {
    console.warn(`[FinStmt][CF][${year}] monthly: ${err.message}`);
    return [];
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateAll(plYearly, bsYearly, plMonthly = [], bsMonthly = []) {
  const errors = [];
  for (const { year, statement: s } of bsYearly) {
    if (!s.balanced) {
      errors.push(`Balance Sheet FY${year} out of balance by ${s.difference}. Assets=${s.totalAssets} vs L+E=${s.totalLiabilitiesAndEquity}`);
    }
  }
  for (const { year, statement: plY } of plYearly) {
    if (Math.abs(safeNum(plY?.netIncome)) < 0.01) continue;
    const bsEntry = bsYearly.find(b => b.year === year);
    if (!bsEntry) continue;
    // Look specifically for the "Net Income" account in equity — not Retained Earnings.
    // After reconcileEquityYearly, this account always holds the authoritative NI for the year.
    const niAcc = bsEntry.statement.equity?.accounts?.find(
      a => NI_NAME_RE.test(a.name || "")
    );
    if (niAcc && Math.abs(safeNum(niAcc.amount) - safeNum(plY.netIncome)) > 1) {
      const diff = round2(safeNum(niAcc.amount) - safeNum(plY.netIncome));
      errors.push(`FY${year} Net Income: generated P&L=${plY.netIncome} vs BS equity NI=${niAcc.amount} (diff=${diff})`);
    }
  }
  // Monthly regression tripwire for reconcileEquityMonthly: month M's BS Net
  // Income must equal that year's own P&L, summed year-to-date through M.
  for (let yi = 0; yi < plMonthly.length; yi += 1) {
    const plMonthsForYear = plMonthly[yi] || [];
    const bsMonthsForYear = (bsMonthly[yi] || []).slice().sort((a, b) => Number(a.monthNumber) - Number(b.monthNumber));
    const plByMonth = new Map(plMonthsForYear.map((p) => [Number(p.monthNumber), safeNum(p.statement?.netIncome)]));
    let cumulative = 0;
    for (const monthEntry of bsMonthsForYear) {
      cumulative = safeNum(cumulative + (plByMonth.get(Number(monthEntry.monthNumber)) || 0));
      const niAcc = monthEntry.statement?.equity?.accounts?.find(a => NI_NAME_RE.test(a.name || ""));
      if (niAcc && Math.abs(safeNum(niAcc.amount) - cumulative) > 1) {
        const diff = round2(safeNum(niAcc.amount) - cumulative);
        errors.push(`${monthEntry.periodLabel} Net Income: year-to-date P&L=${cumulative} vs BS equity NI=${niAcc.amount} (diff=${diff})`);
      }
    }
  }
  return errors;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

// Result-cache report_type for the full financial-statements payload.
const FIN_STMT_CACHE_TYPE = "kr_financial_statements_v1";

// CONFIRMED ROOT CAUSE (fixed by this constant) of "vendor/customer breakdown
// never appears in Key Reports even though the backend computes it": the result
// cache below is keyed ONLY on data-freshness signals -- versionId, the version's
// last_synced_at, the COA's latest updated_at, and the year. NONE of those change
// when the CODE changes. So every payload cached before the vendor/customer
// fields were added kept being served verbatim, forever, and the frontend had
// nothing to render. Confirmed live: of 13 cached payloads, 11 had NO
// `vendorsByAccount` key at all on their yearly periods and an empty `{}` on
// their monthly ones -- the exact pre-fix shape -- and would only ever have been
// refreshed by an unrelated re-sync or COA edit.
//
// The payload SHAPE is now part of the cache identity. Bump this whenever the
// emitted payload gains/renames/removes a field, and every stale row is rejected
// automatically (a row written before this existed has no payloadVersion, so it
// can never satisfy the check). This is enforced by the predicate rather than by
// remembering to rename FIN_STMT_CACHE_TYPE -- the previous mechanism relied on a
// comment, and that is precisely what was missed.
const FIN_STMT_PAYLOAD_VERSION = 3;

/**
 * Is a cached financial-statements row safe to serve?
 *
 * Extracted from the lookup below so the rule is unit-testable -- the defect it
 * guards against was invisible precisely because it lived inline in a `.find()`
 * predicate that nothing could exercise.
 *
 * Freshness (version/syncedAt/coaUpdatedAt/year) AND payload shape must all
 * match. A row written before payloadVersion existed has `undefined` there, so
 * it can never be served.
 */
function isFinStmtCacheRowUsable(rowData, { versionId, syncedAt, coaUpdatedAt, yearKey }) {
  if (!rowData || !rowData.result) return false;
  if (Number(rowData.payloadVersion) !== FIN_STMT_PAYLOAD_VERSION) return false;
  return rowData.versionId === versionId
    && rowData.syncedAt === syncedAt
    && rowData.coaUpdatedAt === coaUpdatedAt
    && String(rowData.yearKey) === String(yearKey);
}

// In-flight de-duplication. The generate-time background warm and a user's
// Reports / Reconciliation load can ask for the same version's statements at the
// same moment; without this, BOTH would run the full (heavy) compute in parallel,
// doubling DB load. Here the second caller awaits the first's in-flight compute.
const _fsInflight = new Map();

async function generateFinancialStatements(versionId, options = {}) {
  if (options.noCache === true) return _generateFinancialStatementsImpl(versionId, options);
  const yearKey = options.year ? String(Number(options.year)) : "all";
  const key = `${versionId}:${yearKey}:${options.currency || "USD"}:${options.companyName || ""}`;
  const existing = _fsInflight.get(key);
  if (existing) return existing;
  const p = _generateFinancialStatementsImpl(versionId, options);
  _fsInflight.set(key, p);
  p.then(() => _fsInflight.delete(key), () => _fsInflight.delete(key));
  return p;
}

async function _generateFinancialStatementsImpl(versionId, options = {}) {
  if (!versionId) throw new Error("versionId is required");

  // Version + latest COA edit drive the result-cache key below: the cache
  // invalidates whenever the version is re-generated (last_synced_at changes) or
  // the Chart of Accounts is edited (chart_of_accounts.updated_at changes) —
  // exactly the two signals that change the numbers.
  const [{ data: version }, { data: coaRow }] = await Promise.all([
    supabase.from("key_report_versions").select("company_id, last_synced_at").eq("id", versionId).single(),
    supabase.from("chart_of_accounts").select("updated_at").eq("version_id", versionId)
      .order("updated_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const companyId = version?.company_id;
  const syncedAt = version?.last_synced_at || null;
  const coaUpdatedAt = coaRow?.updated_at || null;
  const yearKey = options.year ? String(Number(options.year)) : "all";

  // ── Result cache ────────────────────────────────────────────────────────────
  // generateFinancialStatements is expensive (it scans the GL many times per
  // year). Cache the full result in qb_synced_reports so repeat loads of the
  // Reports / Reconciliation pages return instantly. companyName/currency are
  // presentation-only and re-applied on a hit, so they never fragment the cache.
  // Pass options.noCache = true to force a fresh compute.
  if (options.noCache !== true && companyId) {
    try {
      const { data: rows } = await supabase
        .from("qb_synced_reports").select("data")
        .eq("company_id", companyId).eq("report_type", FIN_STMT_CACHE_TYPE)
        .order("updated_at", { ascending: false });
      const hit = (rows || []).find(
        (r) => isFinStmtCacheRowUsable(r?.data, { versionId, syncedAt, coaUpdatedAt, yearKey }),
      );
      if (hit) {
        // The cache key only tracks DATA freshness (syncedAt/coaUpdatedAt) — it
        // has no way to know the balance sheet's own shape changed underneath it
        // (buildBsStatement started returning a per-section `hierarchy` tree,
        // consumed by getBalanceSheetReport's rows/hierarchicalRows). A row
        // cached before that shape existed stays a "fresh" hit forever (nothing
        // about the underlying GL/COA changed), silently serving balance sheets
        // with no hierarchy to every reader — reproducing exactly the CIM Prep
        // slide 26 / Balance Sheet tab "blank on live, fine on local" symptom,
        // since a locally-tested company/version has no such stale cache row.
        // Guard against it the same way the generated_report_snapshots
        // self-heal check does: verify the shape this call actually needs is
        // present before trusting the cache, otherwise fall through and
        // recompute (which re-persists a correctly-shaped row below).
        const cachedBsYearly = hit.data.result?.reports?.balanceSheet?.yearly || [];
        const cachedBsShapeIsCurrent = cachedBsYearly.every((e) => Array.isArray(e?.statement?.assets?.hierarchy));
        if (cachedBsShapeIsCurrent) {
          console.log(`[FinStmt][Cache] hit v=${versionId} year=${yearKey}`);
          return { ...hit.data.result, companyName: options.companyName || "", currency: options.currency || "USD" };
        }
        console.log(`[FinStmt][Cache] stale-shape hit v=${versionId} year=${yearKey} — cached Balance Sheet predates the hierarchy tree, recomputing`);
      }
    } catch {
      /* cache read failed — fall through to compute */
    }
  }

  const [allCoa, years] = await Promise.all([
    loadCoa(versionId),
    distinctYears(versionId),
  ]);

  const filteredYears = options.year
    ? years.filter(y => y === Number(options.year))
    : years;

  console.log(
    `[FinStmt][Init] v=${versionId} allYears=[${years.join(",")}] ` +
    `filteredYears=[${filteredYears.join(",")}] coa=${allCoa.length}`,
  );

  const missingData = [];
  if (!allCoa.filter(a => !a.metadata?.is_group).length) {
    missingData.push("Chart of Accounts has no leaf accounts. Generate the COA first (Step 6 in Key Reports).");
  }
  if (!filteredYears.length) {
    missingData.push(`No financial data found for ${options.year ? `FY${options.year}` : "any year"}. Sync your financial documents first.`);
  }
  if (missingData.length) {
    return {
      companyName: options.companyName || "", currency: options.currency || "USD",
      reports: { profitAndLoss: { monthly: [], yearly: [] }, balanceSheet: { monthly: [], yearly: [] }, cashFlow: { monthly: [], yearly: [] } },
      validation: missingData, missingData,
    };
  }

  const unmappedSet = new Set();

  // Yearly P&L must complete first so its statement can serve as a proportional
  // fallback for monthly P&L when GL has no transaction_date.
  const plYearly = await Promise.all(filteredYears.map(y => generateYearlyPl(companyId, versionId, y, allCoa, unmappedSet)));

  // Monthly P&L, yearly CF, and monthly CF are year-independent — run concurrently.
  const [plMonthly, cfYearly, cfMonthly] = await Promise.all([
    Promise.all(filteredYears.map((y, i) => generateMonthlyPl(companyId, versionId, y, allCoa, unmappedSet, plYearly[i]?.statement))),
    Promise.all(filteredYears.map(y => generateYearlyCf(versionId, y, allCoa))),
    Promise.all(filteredYears.map(y => generateMonthlyCf(versionId, y, allCoa))),
  ]);

  // Balance Sheet has a carry-forward chain: BS(year) = BS(year-1 close) + GL(year).
  // Each year must be fully persisted before the next year reads it as its prior-year
  // base. Running concurrently causes hasGeneratedRows race conditions and computes
  // the carry-forward independently per year instead of reusing prior-year results.
  const bsYearly = [];
  for (const y of filteredYears) {
    bsYearly.push(await generateYearlyBs(companyId, versionId, y, allCoa, unmappedSet));
  }
  const bsMonthly = [];
  for (const y of filteredYears) {
    bsMonthly.push(await generateMonthlyBs(companyId, versionId, y, allCoa, unmappedSet));
  }

  // ── Equity reconciliation — guarantee Assets = Liabilities + Equity, and
  // that the Balance Sheet's Net Income always comes from the P&L ──────────
  // YEARLY: set current-year Net Income = generated P&L Net Income, then set
  // Retained Earnings to the residual that balances the sheet.
  reconcileEquityYearly(bsYearly, plYearly);
  // MONTHLY: set each month's Net Income to that year's own P&L, accumulated
  // year-to-date through that month (see reconcileEquityMonthly's doc
  // comment — this used to be skipped entirely, letting the monthly Balance
  // Sheet's own independently-derived Net Income silently diverge from the
  // generated P&L every month), then rebalance Retained Earnings.
  for (let i = 0; i < filteredYears.length; i++) {
    reconcileEquityMonthly(bsMonthly[i], plMonthly[i]);
  }

  const validation = validateAll(plYearly, bsYearly, plMonthly, bsMonthly);
  // Accounts with no Chart of Accounts hierarchy match (needs_mapping, excluded
  // from loadCoa) and any GL/BS name that couldn't be matched to a COA leaf at all
  // (unmappedSet, accumulated across every generate*/aggregate* call above) —
  // both are excluded from every total above, not silently guessed. Surface
  // them so that exclusion is visible rather than a silent Balance Sheet
  // imbalance with no explanation.
  if (allCoa.unmappedCount) {
    validation.push(`${allCoa.unmappedCount} account(s) need manual mapping (no Chart of Accounts match): ${allCoa.unmappedNames.join(", ")}. Excluded from all totals until reviewed.`);
  }
  if (unmappedSet.size) {
    validation.push(`${unmappedSet.size} GL/BS line(s) could not be matched to any Chart of Accounts account: ${[...unmappedSet].join(", ")}. Excluded from all totals.`);
  }
  console.log(
    `[FinStmt] v=${versionId} years=[${filteredYears.join(",")}]`,
    `| pl=${plYearly.length} bs=${bsYearly.length} cf=${cfYearly.length}`,
    `| monthly pl=${plMonthly.flat().length} cf=${cfMonthly.flat().length}`,
    `| warnings=${validation.length}`,
  );

  const result = {
    companyName: options.companyName || "",
    currency: options.currency || "USD",
    reports: {
      profitAndLoss: { monthly: plMonthly.flat(), yearly: plYearly },
      balanceSheet: { monthly: bsMonthly.flat(), yearly: bsYearly },
      cashFlow: { monthly: cfMonthly.flat(), yearly: cfYearly },
    },
    validation,
    missingData: [],
  };

  // Persist to the result cache (best-effort). One row per (version, yearKey):
  // a re-generate/COA edit changes the key and this overwrites the stale row.
  if (options.noCache !== true && companyId) {
    try {
      const now = new Date().toISOString();
      // payloadVersion stamps the SHAPE, so a later code change that alters the
      // payload cannot be served from a row written by an older build.
      const payload = { versionId, syncedAt, coaUpdatedAt, yearKey, payloadVersion: FIN_STMT_PAYLOAD_VERSION, result };
      const { data: existingRows } = await supabase
        .from("qb_synced_reports").select("id, data")
        .eq("company_id", companyId).eq("report_type", FIN_STMT_CACHE_TYPE);
      const existing = (existingRows || []).find(
        (r) => r?.data?.versionId === versionId && String(r?.data?.yearKey) === yearKey,
      );
      if (existing?.id) {
        await supabase.from("qb_synced_reports")
          .update({ data: payload, status: "synced", updated_at: now }).eq("id", existing.id);
      } else {
        await supabase.from("qb_synced_reports").insert({
          company_id: companyId, report_type: FIN_STMT_CACHE_TYPE, source: "manual_report_upload",
          data: payload, status: "synced", updated_at: now,
        });
      }
    } catch {
      /* cache write is best-effort — never block the response */
    }
  }

  return result;
}

/**
 * Monthly "per Financials" figures for the Bank Reconciliation Activity Review,
 * sourced from THIS Key Report version's generated P&L (the same statements the
 * /reports/financial-statements endpoint returns).
 *
 * Mapping (per product spec / CPA reconciliation workpaper):
 *   Sales per Financials    ← monthly accrual revenue      (statement.revenue.total)
 *   Expenses per Financials ← monthly Total Operating Expenses (statement.operatingExpenses.total)
 *
 * Expenses per Financials is the accrual OPERATING EXPENSES base the Activity
 * Review bridges to External Withdrawals. It deliberately INCLUDES the non-cash
 * accounts (depreciation, amortization, bad debt): those are added back as
 * separate positive reconciling rows, which only nets to the true cash figure
 * when they remain in this base (excluding them here AND adding them back would
 * double-count). This replaced an earlier mapping to operatingIncome (Net
 * Operating Income), which is a profit figure — the wrong base for a
 * withdrawals-vs-expenses reconciliation and it never reconciled to zero.
 *
 * Keyed by "YYYY-MM" to match the Activity Review's monthKey. Spans every fiscal
 * year present in the version (no year filter), so multi-year ranges are covered.
 *
 * @returns {Promise<{ totalIncome: Object<string,number>, totalExpenses: Object<string,number> }>}
 */
// v2: Expenses per Financials remapped operatingIncome → operatingExpenses.total.
// Bumped so the corrected figures invalidate any v1 rows cached under the same
// version/sync/COA key (a code change alone does not move that key).
const PL_FINANCIALS_CACHE_TYPE = "kr_pl_financials_v2";

function computeMonthlyPlFinancials(fs) {
  const monthly = fs?.reports?.profitAndLoss?.monthly || [];
  const totalIncome = {};
  const totalExpenses = {};
  for (const entry of monthly) {
    const year = Number(entry?.year);
    const monthNum = Number(entry?.monthNumber);
    if (!Number.isInteger(year) || !(monthNum >= 1 && monthNum <= 12)) continue;
    const key = `${year}-${String(monthNum).padStart(2, "0")}`;
    totalIncome[key] = round2(safeNum(entry.statement?.revenue?.total));
    totalExpenses[key] = round2(safeNum(entry.statement?.operatingExpenses?.total));
  }
  return { totalIncome, totalExpenses };
}

async function getMonthlyPlFinancials(versionId) {
  if (!versionId) return { totalIncome: {}, totalExpenses: {} };

  // Cache keyed by version + its last sync time AND the Chart of Accounts'
  // latest update. generateFinancialStatements is expensive (regenerates all
  // P&L/BS/CF), so the Bank Reconciliation page must not pay that cost on every
  // load. last_synced_at alone is not enough: COA reclassification (regenerate /
  // manual edit / reset via routes/keyReports.js) writes chart_of_accounts
  // directly and does NOT bump last_synced_at, so a cache keyed on syncedAt alone
  // would keep serving pre-reclassification totals indefinitely. Folding in COA's
  // own updated_at makes the cache invalidate on either signal.
  const [{ data: ver }, { data: coaRow }] = await Promise.all([
    supabase.from("key_report_versions").select("company_id, last_synced_at").eq("id", versionId).maybeSingle(),
    supabase.from("chart_of_accounts").select("updated_at").eq("version_id", versionId)
      .order("updated_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const companyId = ver?.company_id || null;
  const syncedAt = ver?.last_synced_at || null;
  const coaUpdatedAt = coaRow?.updated_at || null;

  if (companyId) {
    try {
      const { data: rows } = await supabase
        .from("qb_synced_reports")
        .select("data")
        .eq("company_id", companyId)
        .eq("report_type", PL_FINANCIALS_CACHE_TYPE)
        .order("updated_at", { ascending: false });
      const hit = (rows || []).find(
        (r) => r?.data?.versionId === versionId && r?.data?.syncedAt === syncedAt &&
          r?.data?.coaUpdatedAt === coaUpdatedAt && r?.data?.plFinancials,
      );
      if (hit) return hit.data.plFinancials;
    } catch {
      // Cache read failed → fall through to compute.
    }
  }

  const fs = await generateFinancialStatements(versionId, {});
  const result = computeMonthlyPlFinancials(fs);

  if (companyId) {
    try {
      const { data: existingRows } = await supabase
        .from("qb_synced_reports")
        .select("id, data")
        .eq("company_id", companyId)
        .eq("report_type", PL_FINANCIALS_CACHE_TYPE);
      const existing = (existingRows || []).find((r) => r?.data?.versionId === versionId);
      const payload = { versionId, syncedAt, coaUpdatedAt, plFinancials: result };
      const now = new Date().toISOString();
      if (existing?.id) {
        await supabase
          .from("qb_synced_reports")
          .update({ data: payload, status: "synced", updated_at: now })
          .eq("id", existing.id);
      } else {
        await supabase.from("qb_synced_reports").insert({
          company_id: companyId,
          report_type: PL_FINANCIALS_CACHE_TYPE,
          source: "manual_report_upload",
          data: payload,
          status: "synced",
          updated_at: now,
        });
      }
    } catch {
      // Cache write is best-effort — never block the response.
    }
  }

  return result;
}

function normNameForValidation(s) { return String(s || "").trim().toLowerCase(); }

/**
 * validateBalanceSheetTotals -- financial-TOTALS validation, replacing
 * "N accounts matched" with the numbers a finance user actually needs. For
 * every fiscal year with an uploaded Balance Sheet, compares the UPLOADED
 * document's own ending-snapshot totals (the same latest-as_of_date
 * convention generateYearlyBs itself uses for "year-end", so "uploaded" and
 * "generated" always describe the identical point in time) against the
 * GENERATED, COA-classified statement for that year. Works for a starting-
 * only, ending-only, multi-year, or partial-year upload alike, since it
 * simply iterates whatever distinct fiscal years/as_of_dates are actually
 * present -- no assumption about which years exist.
 *
 * When a section's totals disagree, the gap is explained rather than left as
 * a bare FAIL: any chart_of_accounts leaf still flagged needs_mapping whose
 * name matches an uploaded row for that year's snapshot is surfaced by name,
 * section, and amount. An unmapped account is EXCLUDED from the generated
 * statement by design (never invented a hierarchy for it) -- so a mismatch
 * this function reports is virtually always attributable to one of these,
 * not a hierarchy defect.
 */
async function validateBalanceSheetTotals(companyId, versionId) {
  // loadCoa deliberately EXCLUDES needs_mapping rows (that's the mechanism
  // that keeps an unmapped account out of every generated report) -- so the
  // needs_mapping accounts themselves must be queried directly from
  // chart_of_accounts, not from loadCoa's already-filtered result.
  const [{ data: bsRowsRaw }, allCoa, { data: unmappedRows }] = await Promise.all([
    supabase.from("balance_sheet_entries").select("account_name, amount, fiscal_year, section, as_of_date, row_type").eq("version_id", versionId),
    loadCoa(versionId),
    supabase.from("chart_of_accounts").select("account_name, metadata").eq("version_id", versionId).eq("node_type", "account"),
  ]);
  // row_type (migration 085): headings/subtotals/metadata/footer rows now
  // persist too but were NEVER in this table before that migration — exclude
  // them here so this raw section sum doesn't newly double-count against
  // generateYearlyBs's COA-driven total. 'total'/'account'/NULL (legacy rows)
  // pass through unchanged, preserving this function's pre-existing behavior.
  const rows = (bsRowsRaw || []).filter((r) => !r.row_type || r.row_type === "account" || r.row_type === "total");
  const years = [...new Set(rows.map((r) => r.fiscal_year))].sort();

  const needsMappingByName = new Map(
    (unmappedRows || []).filter((a) => a.metadata?.needs_mapping)
      .map((a) => [normNameForValidation(a.account_name), a]),
  );

  const results = [];
  for (const year of years) {
    const yearRows = rows.filter((r) => r.fiscal_year === year);
    const latestAsOf = yearRows.reduce((max, r) => (r.as_of_date > max ? r.as_of_date : max), "");
    const snapshot = yearRows.filter((r) => r.as_of_date === latestAsOf);

    const uploaded = { assets: 0, liabilities: 0, equity: 0 };
    for (const r of snapshot) {
      if (r.section === "assets") uploaded.assets += Number(r.amount || 0);
      else if (r.section === "liabilities") uploaded.liabilities += Number(r.amount || 0);
      else if (r.section === "equity") uploaded.equity += Number(r.amount || 0);
    }
    uploaded.totalLiabilitiesAndEquity = uploaded.liabilities + uploaded.equity;

    let generated = null;
    let genError = null;
    try {
      const yearly = await generateYearlyBs(companyId, versionId, year, allCoa, new Set());
      generated = yearly?.statement || null;
    } catch (err) { genError = err.message; }

    const diff = (a, b) => Number(a || 0) - Number(b || 0);
    const within = (d) => d != null && Math.abs(d) < 0.01;
    const dAssets = generated ? diff(uploaded.assets, generated.assets?.total) : null;
    const dLiab = generated ? diff(uploaded.liabilities, generated.liabilities?.total) : null;
    const dEquity = generated ? diff(uploaded.equity, generated.equity?.total) : null;
    const dTLE = generated ? diff(uploaded.totalLiabilitiesAndEquity, generated.totalLiabilitiesAndEquity) : null;
    const pass = Boolean(generated) && within(dAssets) && within(dLiab) && within(dEquity) && within(dTLE);

    const explanations = [];
    if (!pass) {
      for (const r of snapshot) {
        const match = needsMappingByName.get(normNameForValidation(r.account_name));
        if (match) {
          explanations.push({ account: r.account_name, section: r.section, amount: Number(r.amount || 0), status: "Needs Manual Mapping" });
        }
      }
    }

    results.push({
      fiscalYear: year, asOfDate: latestAsOf, uploaded, generated,
      diffs: { assets: dAssets, liabilities: dLiab, equity: dEquity, totalLiabilitiesAndEquity: dTLE },
      genError, pass, explanations,
    });
  }
  return results;
}

function printBalanceSheetValidation(results) {
  const fmt = (n) => Number(n || 0).toFixed(2);
  console.log("\n==========================================\nBalance Sheet Validation\n==========================================");
  for (const r of results) {
    console.log(`\nFiscal Year ${r.fiscalYear} (uploaded as of ${r.asOfDate})`);
    if (r.genError || !r.generated) {
      console.log(`  Generated Balance Sheet unavailable: ${r.genError || "no generated data for this year"}`);
      continue;
    }
    const g = r.generated;
    console.log(`  Total Assets                  uploaded=${fmt(r.uploaded.assets)}  generated=${fmt(g.assets?.total)}  diff=${fmt(r.diffs.assets)}`);
    console.log(`  Total Liabilities              uploaded=${fmt(r.uploaded.liabilities)}  generated=${fmt(g.liabilities?.total)}  diff=${fmt(r.diffs.liabilities)}`);
    console.log(`  Total Equity                   uploaded=${fmt(r.uploaded.equity)}  generated=${fmt(g.equity?.total)}  diff=${fmt(r.diffs.equity)}`);
    console.log(`  Total Liabilities & Equity     uploaded=${fmt(r.uploaded.totalLiabilitiesAndEquity)}  generated=${fmt(g.totalLiabilitiesAndEquity)}  diff=${fmt(r.diffs.totalLiabilitiesAndEquity)}`);
    console.log(`  Result: ${r.pass ? "PASS" : "FAIL"}`);
    if (!r.pass) {
      if (r.explanations.length) {
        console.log("  Generated Balance Sheet differs from uploaded document.");
        for (const e of r.explanations) {
          console.log(`    Reason  : Unmapped account excluded`);
          console.log(`    Account : ${e.account}`);
          console.log(`    Section : ${e.section}`);
          console.log(`    Amount  : ${fmt(e.amount)}`);
          console.log(`    Status  : ${e.status}`);
        }
      } else {
        console.log("  Generated Balance Sheet differs from uploaded document, and no needs_mapping account fully explains the gap -- investigate further.");
      }
    }
  }
  console.log("==========================================");
}

/**
 * validateCashFlowIntegrity -- for every fiscal year, verifies (1) the Cash
 * Flow statement's own internal identity (Opening Cash + Net Cash Flow =
 * Ending Cash) and (2) that the Cash Flow's Ending Cash actually ties to the
 * Balance Sheet's own reported cash balance for that year -- reusing the
 * already-classified `report_tag === "cash"` tag (assigned once at COA
 * classification time, chartOfAccountsService/reportTagRules.js) rather than
 * re-scanning account names here. Never silently ignores a mismatch.
 */
const CF_CASH_NAME_RE = /cash|checking|savings|petty|money market/i;

async function validateCashFlowIntegrity(companyId, versionId) {
  const allCoa = await loadCoa(versionId);
  const years = await distinctYears(versionId);

  const { data: bsRowsRaw } = await supabase
    .from("balance_sheet_entries").select("account_name, amount, fiscal_year, as_of_date, row_type")
    .eq("version_id", versionId);
  // row_type (migration 085): headings/subtotals/metadata/footer rows now
  // persist too but were NEVER in this table before that migration — exclude
  // them here so a heading like "Cash and Cash Equivalents" can't newly match
  // CF_CASH_NAME_RE below. 'total'/'account'/NULL (legacy rows) pass through
  // unchanged, preserving this function's pre-existing behavior.
  const bsRows = (bsRowsRaw || []).filter((r) => !r.row_type || r.row_type === "account" || r.row_type === "total");

  const results = [];
  for (const year of years) {
    const cf = await generateYearlyCf(versionId, year, allCoa);
    const stmt = cf.statement || emptyCfStatement();
    const identityDiff = Number(stmt.openingCash || 0) + Number(stmt.netCashIncrease || 0) - Number(stmt.endingCash || 0);
    const identityPass = Math.abs(identityDiff) < 0.01;

    // "Balance Sheet Cash" -- the uploaded document's own ending-snapshot cash
    // balance, using the SAME classification regex already used in production
    // (reportTagRules.js's CASH_RE, assigned to chart_of_accounts.metadata.
    // report_tag at COA-generation time) applied here to the raw uploaded rows
    // rather than the persisted COA, since the generated Balance Sheet's own
    // nested group/hierarchy structure doesn't expose a flat per-leaf id to
    // filter by report_tag directly from this function.
    const yearRows = bsRows.filter((r) => r.fiscal_year === year);
    const latestAsOf = yearRows.reduce((max, r) => (r.as_of_date > max ? r.as_of_date : max), "");
    const bsCash = yearRows
      .filter((r) => r.as_of_date === latestAsOf && CF_CASH_NAME_RE.test(r.account_name || ""))
      .reduce((sum, r) => sum + Number(r.amount || 0), 0);
    const tieDiff = Number(stmt.endingCash || 0) - bsCash;
    const tiePass = yearRows.length > 0 && Math.abs(tieDiff) < 0.01;

    results.push({
      fiscalYear: year, openingCash: stmt.openingCash, netCashIncrease: stmt.netCashIncrease,
      endingCash: stmt.endingCash, identityDiff, identityPass,
      bsCash, bsAvailable: yearRows.length > 0, tieDiff, tiePass,
    });
  }
  return results;
}

function printCashFlowValidation(results) {
  const fmt = (n) => Number(n || 0).toFixed(2);
  console.log("\n==========================================\nCash Flow Validation\n==========================================");
  for (const r of results) {
    console.log(`\nFiscal Year ${r.fiscalYear}`);
    console.log(`  Opening Cash      : ${fmt(r.openingCash)}`);
    console.log(`  Net Cash Flow     : ${fmt(r.netCashIncrease)}`);
    console.log(`  Ending Cash       : ${fmt(r.endingCash)}`);
    console.log(`  Opening + Net = Ending : ${r.identityPass ? "PASS" : `FAIL (diff=${fmt(r.identityDiff)})`}`);
    if (r.bsAvailable) {
      console.log(`  Balance Sheet Cash (uploaded) : ${fmt(r.bsCash)}`);
      console.log(`  Cash Flow Ending == BS Cash   : ${r.tiePass ? "PASS" : `FAIL (diff=${fmt(r.tieDiff)})`}`);
    } else {
      console.log(`  Balance Sheet Cash (uploaded) : not available (no uploaded Balance Sheet this year)`);
    }
  }
  console.log("==========================================");
}

module.exports = {
  generateFinancialStatements,
  getAvailablePeriods,
  getMonthlyPlFinancials,
  validateBalanceSheetTotals,
  printBalanceSheetValidation,
  validateCashFlowIntegrity,
  printCashFlowValidation,
  // Exported so keyReportReportService.js's getCashflowReport can delegate to
  // this COA-driven (cf_category) engine instead of the legacy name/regex
  // classifier in manualCashFlowService.js — one Cash Flow engine, not two.
  loadCoa,
  generateYearlyCf,
  // exported for unit testing
  buildTree,
  buildPlStatement,
  buildBsStatement,
  buildDynamicHierarchy,
  groupLabelFor,
  plSectionLabelFor,
  balanceRetainedEarnings,
  reconcileEquityYearly,
  reconcileEquityMonthly,
  syncEquityHierarchyAmount,
  NO_VENDOR_LABEL,
  FIN_STMT_PAYLOAD_VERSION,
  isFinStmtCacheRowUsable,
  accumulateGlRowEntities,
  propagateEntitiesToLeaves,
  serializeEntitiesByAccount,
  warnIfVendorReconciliationMismatch,
};
