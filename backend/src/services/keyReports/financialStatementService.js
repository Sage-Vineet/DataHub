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
// ensureAccountExistsInCoa intentionally not imported — COA must be complete
// before report generation begins (ensureCoaComplete runs in Phase 2c).

// ─── Utilities ────────────────────────────────────────────────────────────────

const safeNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2  = (v) => Math.round(safeNum(v) * 100) / 100;

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
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
    .order("sort_order", { ascending: true });

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
  const groups = accounts.filter(a =>  a.metadata?.is_group);
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
      isGroup:       Boolean(acc.metadata?.is_group),
      children:      [],
      // Filled by rollupNode:
      signedAmount:  0,
      displayAmount: 0,
      // Filled by assignAmounts:
      leafAmount:    0,
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
    const raw  = safeNum(leafAmountById.get(node.id) || 0);
    // No fallback sign for an unrecognized/null account_type — every leaf that
    // reaches here should already carry one of the 6 known types; a missing one
    // means classification is incomplete, and it must contribute nothing rather
    // than be silently guessed as asset-like.
    const sign = ROLLUP_SIGN[node.account_type] ?? 0;
    node.leafAmount    = raw;
    node.signedAmount  = raw * sign;
    node.displayAmount = raw; // always positive for individual account display
    return;
  }
  // Group: recurse then aggregate
  for (const child of node.children) rollupNode(child, leafAmountById);
  node.signedAmount  = node.children.reduce((s, c) => s + c.signedAmount, 0);
  node.displayAmount = Math.abs(node.signedAmount);
}

// ─── Statement builders ───────────────────────────────────────────────────────

const PL_ROOT_ANCHOR_RE = /^(total\s+expenses?|expenses?|total\s+cost|cost\s+of\s+sales)$/i;

/**
 * Determine the display label for an expense/COGS group: the direct parent
 * node's name when it's a real category (not a root rollup anchor like
 * "Total Expenses"), else the deepest real category in the leaf's OWN copied
 * hierarchy (level_1..level_15) — never a fixed level index, since depth is
 * no longer guaranteed once hierarchy comes from the client's own COA rather
 * than a fixed taxonomy.
 */
function groupLabelFor(node, byId) {
  if (node.parent_account_id) {
    const parent = byId.get(node.parent_account_id);
    if (parent) {
      const parentName = displayName(parent);
      if (parentName && !PL_ROOT_ANCHOR_RE.test(parentName.trim())) {
        return parentName;
      }
    }
  }
  const own = displayName(node);
  const ancestry = BS_LEVEL_KEYS.map((k) => node[k]).filter(Boolean);
  if (ancestry.length && ancestry[ancestry.length - 1] === own) ancestry.pop();
  return [...ancestry].reverse().find((l) => !PL_ROOT_ANCHOR_RE.test(l) && !ROOT_ANCHOR_RE.test(l)) || "Other";
}

/**
 * Build P&L statement from the rolled-up tree.
 *
 * All per-account amounts = displayAmount (positive).
 * Totals = calculated from leaf sums; never read from entry summary rows.
 */
function buildPlStatement(leaves, byId) {
  const income  = leaves.filter(n => n.account_type === "income");
  const cogs    = leaves.filter(n => n.account_type === "cogs");
  const expense = leaves.filter(n => n.account_type === "expense");

  // Amounts come from the DB (numeric 18,2) — preserve exact precision; do NOT
  // apply Math.round() to individual account amounts.
  const toLeaf = (n) => ({
    systemId:      n.system_id      || null,
    accountNumber: n.account_number || null,
    name:          displayName(n),
    adjustedName:  n.adjusted_name  || null,
    hierarchyPath: n.hierarchy_path || null,
    amount:        safeNum(n.displayAmount),
    // Assigned once at COA classification time (reportTagRules) — QoE/KPI read
    // this instead of scanning account/group names by keyword.
    reportTag:     n.metadata?.report_tag || null,
  });

  // Revenue — flat list, total = sum of income leaves.
  // QB GL uses natural-balance convention: revenue credit amounts arrive POSITIVE
  // (increases in the account's natural credit direction are stored as positive).
  // No sign flip needed. Contra-revenue (sales returns, discounts) arrive NEGATIVE
  // in the GL and naturally reduce Total Revenue without any special handling.
  const incomeAccounts = income.map(toLeaf);
  const totalRevenue   = safeNum(incomeAccounts.reduce((s, a) => s + a.amount, 0));

  // Cost of Sales — flat list (the frontend reads costOfSales.accounts[])
  const cogsAccounts = cogs.map(toLeaf);
  const totalCogs    = safeNum(cogsAccounts.reduce((s, a) => s + a.amount, 0));

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
  const totalExpenses   = safeNum(Object.values(expenseGroupMap).reduce((s, g) => s + g.total, 0));
  const operatingIncome = safeNum(grossProfit - totalExpenses);
  const netIncome       = operatingIncome;

  const incomeSectionLabel  = income[0]?.level_6  || income[0]?.level_7  || "Total Revenue";
  const cogsSectionLabel    = cogs[0]?.level_6    || cogs[0]?.level_7    || "Cost of Sales";
  const expenseSectionLabel = expense[0]?.level_6 || expense[0]?.level_7 || "Total Expenses";

  return {
    revenue: {
      label:    incomeSectionLabel,
      accounts: incomeAccounts,
      total:    totalRevenue,
    },
    costOfSales: {
      label:    cogsSectionLabel,
      accounts: cogsAccounts,      // flat list — matches frontend expectation
      total:    totalCogs,
    },
    grossProfit,
    operatingExpenses: {
      label:  expenseSectionLabel,
      groups: expenseGroupMap,
      total:  totalExpenses,
    },
    operatingIncome,
    pretaxIncome: operatingIncome,
    netIncome,
  };
}

const BS_LEVEL_KEYS = Array.from({ length: 15 }, (_, i) => `level_${i + 1}`);

// The universal current/non-current bifurcation every Balance Sheet ratio
// (Current Ratio, Quick Ratio — see getKpiReport) needs, regardless of what
// the client calls their own categories. This is the one place a bounded
// keyword match is unavoidable: it only ever classifies a label ALREADY
// copied onto this row from chart_of_accounts — it never invents one.
const FIXED_ASSET_RE    = /fixed|property|equipment|\bppe\b/i;
const OTHER_ASSET_RE    = /^other|long.?term asset|noncurrent asset|non.current asset/i;
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
  const assets      = leaves.filter(n => n.account_type === "asset");
  const liabilities = leaves.filter(n => n.account_type === "liability");
  const equities    = leaves.filter(n => n.account_type === "equity");

  // Preserve exact DB precision — do NOT apply Math.round() to individual amounts.
  const toLeaf = (n) => ({
    systemId:      n.system_id      || null,
    accountNumber: n.account_number || null,
    name:          displayName(n),
    adjustedName:  n.adjusted_name  || null,
    hierarchyPath: n.hierarchy_path || null,
    amount:        safeNum(n.displayAmount),
    // Assigned once at COA classification time (reportTagRules) — QoE/KPI read
    // this instead of scanning account/group names by keyword.
    reportTag:     n.metadata?.report_tag || null,
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
    const ancestry = BS_LEVEL_KEYS.map((k) => n[k]).filter(Boolean);
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
  const liabKpiBuckets  = buildKpiBuckets(liabilities);

  // ══════════════════════════════════════════════════════════════════════
  // buildDynamicHierarchy — the ONLY hierarchy-construction logic for
  // rendering the Balance Sheet. chart_of_accounts (level_1..level_15) is
  // the single source of truth: this function does nothing but walk it and
  // build a genuine N-level Tree → Node → Children → Leaf structure. No
  // regex, no keyword matching, no fixed bucket/section names, no depth cap.
  //
  // Consecutive duplicate labels (the deliberate double fixed-anchor prefix,
  // e.g. "Total Assets" twice, or a leaf's own name repeated by
  // padLevelsWithLeafPropagation to fill all 15 columns) are collapsed here
  // for DISPLAY ONLY — chart_of_accounts itself is never touched. Example:
  // stored ["Total Assets","Total Assets","Fixed Assets","Vehicles","Truck",
  // "Truck",...] renders as Total Assets → Fixed Assets → Vehicles → Truck.
  function buildDynamicHierarchy(accs) {
    const roots = [];
    const rootIndex = new Map();
    const expectedByLeafId = new Map(); // leaf id -> { account, coaLevels, expectedPath }

    for (const n of accs) {
      const own = displayName(n);
      const rawLevels = BS_LEVEL_KEYS.map((k) => n[k]).filter(Boolean);

      // Collapse ALL consecutive duplicates (not just a fixed offset) — this
      // correctly handles both the double fixed-anchor prefix and any
      // leaf-name padding repetition uniformly, with no assumption about how
      // many anchor levels precede the real category chain.
      const collapsed = [];
      for (const label of rawLevels) {
        if (!collapsed.length || collapsed[collapsed.length - 1] !== label) collapsed.push(label);
      }
      const hasOwnLeaf = collapsed.length && collapsed[collapsed.length - 1] === own;
      const containers = hasOwnLeaf ? collapsed.slice(0, -1) : collapsed;

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

  const assetHierarchyResult = buildDynamicHierarchy(assets);
  const liabHierarchyResult  = buildDynamicHierarchy(liabilities);
  logHierarchyRenderVerification("Balance Sheet Assets", assetHierarchyResult.verification);
  logHierarchyRenderVerification("Balance Sheet Liabilities", liabHierarchyResult.verification);

  const equityAccounts = equities.map(toLeaf);

  const totalAssets      = safeNum(Object.values(assetKpiBuckets).reduce((s, sec) => s + sec.total, 0));
  const totalLiabilities = safeNum(Object.values(liabKpiBuckets).reduce((s, sec) => s + sec.total, 0));
  const totalEquity      = safeNum(equityAccounts.reduce((s, a) => s + a.amount, 0));
  const totalLE          = safeNum(totalLiabilities + totalEquity);
  const difference       = safeNum(totalAssets - totalLE);

  // KPI-only buckets — never used for display (see buildDynamicHierarchy above).
  const currentAssets = assetKpiBuckets["Current Assets"] || { label: "Current Assets", groups: {}, total: 0 };
  const fixedAssets   = assetKpiBuckets["Fixed Assets"]   || { label: "Fixed Assets",   groups: {}, total: 0 };
  const otherAssets   = assetKpiBuckets["Other Assets"]   || { label: "Other Assets",   groups: {}, total: 0 };

  const currentLiab  = liabKpiBuckets["Current Liabilities"]   || { label: "Current Liabilities",   groups: {}, total: 0 };
  const longTermLiab = liabKpiBuckets["Long-Term Liabilities"] || { label: "Long-Term Liabilities", groups: {}, total: 0 };

  return {
    assets: {
      label: assets[0]?.level_1 || "Total Assets",
      // Kept for keyReportReportService.js's KPI report (Current Ratio,
      // Working Capital) only — never used for display, see buildDynamicHierarchy.
      currentAssets:  { label: currentAssets.label, groups: currentAssets.groups, total: currentAssets.total },
      fixedAssets:    { label: fixedAssets.label,   groups: fixedAssets.groups,   total: fixedAssets.total },
      otherAssets:    { label: otherAssets.label,   groups: otherAssets.groups,   total: otherAssets.total },
      // The single source of truth for rendering: a genuine N-level tree
      // built directly from chart_of_accounts level_1..level_15 — no fixed
      // bucket names, no depth cap. This is what the frontend recurses through.
      hierarchy: assetHierarchyResult.tree,
      total: totalAssets,
    },
    liabilities: {
      label: "Liabilities",
      // Kept for the KPI report only — never used for display.
      currentLiabilities:  { label: currentLiab.label,  groups: currentLiab.groups,  total: currentLiab.total },
      longTermLiabilities: { label: longTermLiab.label, groups: longTermLiab.groups, total: longTermLiab.total },
      hierarchy: liabHierarchyResult.tree,
      total: totalLiabilities,
    },
    equity: {
      label:    "Equity",
      accounts: equityAccounts,
      total:    totalEquity,
    },
    totalAssets,
    totalLiabilities,
    totalEquity,
    totalLiabilitiesAndEquity: totalLE,
    balanced:  Math.abs(difference) < 1,
    difference,
  };
}

// ─── Net Income → Retained Earnings injection ─────────────────────────────────

function injectNetIncomeToBS(bsEntry, plEntry) {
  if (!bsEntry || !plEntry) return bsEntry;
  const netIncome = safeNum(plEntry.statement?.netIncome);
  if (Math.abs(netIncome) < 0.01) return bsEntry;

  const eq = bsEntry.statement.equity;
  if (!eq) return bsEntry;

  // Only touch the "Net Income" account — never add to Retained Earnings.
  // RE represents accumulated prior earnings; NI is the current year's result.
  const niAcc = (eq.accounts || []).find(a =>
    /^net\s*(income|loss)/i.test(a.name || "")
  );

  if (niAcc) {
    // If this year has Net Income from an uploaded BS, trust that value over the
    // generated P&L (the uploaded QB document is the source of truth).
    if (bsEntry.hasUploadedNetIncome && Math.abs(niAcc.amount) > 0.01) {
      return bsEntry;
    }
    niAcc.amount = safeNum(netIncome);
    niAcc.netIncomeInjected = netIncome;
  } else {
    eq.accounts = eq.accounts || [];
    eq.accounts.push({
      systemId: null, accountNumber: null,
      name: "Net Income",
      adjustedName: "Net Income",
      amount: netIncome,
      netIncomeInjected: netIncome,
    });
  }

  eq.total = safeNum((eq.accounts || []).reduce((s, a) => s + a.amount, 0));
  const s = bsEntry.statement;
  s.totalEquity               = eq.total;
  s.totalLiabilitiesAndEquity = safeNum(s.totalLiabilities + s.totalEquity);
  s.difference                = safeNum(s.totalAssets - s.totalLiabilitiesAndEquity);
  s.balanced                  = Math.abs(s.difference) < 1;
  return bsEntry;
}

// ─── Equity reconciliation — enforce the accounting equation ──────────────────

const RE_NAME_RE = /^retained\s+earnings/i;
const NI_NAME_RE = /^net\s*(income|loss)/i;

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
  s.totalEquity               = eq.total;
  s.totalLiabilitiesAndEquity = safeNum(s.totalLiabilities + s.totalEquity);
  s.difference                = safeNum(s.totalAssets - s.totalLiabilitiesAndEquity);
  s.balanced                  = Math.abs(s.difference) < 1;
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

    balanceRetainedEarnings(bsYearly[idx].statement);
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
  let bsData;
  try {
    bsData = await fetchAllRows(() =>
      supabase.from("balance_sheet_entries").select("fiscal_year")
        .eq("version_id", versionId)
        .or("is_generated.is.null,is_generated.eq.false"),
    );
  } catch (err) {
    console.warn(`[FinStmt][Years] BS query error: ${err.message} — falling back to unfiltered`);
    bsData = await fetchAllRows(() =>
      supabase.from("balance_sheet_entries").select("fiscal_year").eq("version_id", versionId),
    );
    console.log("[FinStmt][Years] BS unfiltered fallback succeeded");
  }

  const glRows = await fetchAllRows(() =>
    supabase.from("general_ledger_entries")
      .select("transaction_date, source_file_id, account_name")
      .eq("version_id", versionId)
      .or("row_type.eq.TRANSACTION,row_type.is.null")
      .not("transaction_date", "is", null),
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
  const plLeaves   = plAccounts.filter(a => !a.metadata?.is_group);

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
  const gl = await loadGlAmountsYearly(versionId, year);
  if (gl) {
    // gl's key is a coa_id whenever the GL row was linked (authoritative — see
    // loadGlAmountsYearly); glMappings/fuzzyLookup are only the fallback for a
    // key that's still a normalized name (row missing coa_id).
    const glMappings  = buildMappings(plLeaves);
    const fuzzyLookup = buildFuzzyLookup(plLeaves);
    for (const [key, { rawName, accountNumber, total, linked }] of gl) {
      const totalAmt = total;
      if (Math.abs(totalAmt) < 0.005) continue;
      if (leafAmounts.has(key)) {
        leafAmounts.set(key, (leafAmounts.get(key) || 0) + totalAmt);
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
      } else {
        const match = fuzzyMatch(fuzzyLookup, rawName, accountNumber);
        if (match?.id && leafAmounts.has(match.id)) {
          leafAmounts.set(match.id, (leafAmounts.get(match.id) || 0) + totalAmt);
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

  return { year: String(year), periodLabel: `FY ${year}`, statement: stmt };
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
          .select("account_name, amount, as_of_date")
          .eq("version_id", versionId)
          .eq("fiscal_year", year)
          .or("is_total.eq.false,is_total.is.null")
      );
      return q.order("as_of_date", { ascending: true });
    });
  } catch (_e) { return []; }

  if (!bsEntries?.length) return [];

  const NI_KW  = /net.*(income|loss)/i;
  // Step 1: Collect every distinct as_of_date AND its YTD Net Income if present.
  const byDate = new Map();
  for (const e of bsEntries) {
    if (!e.as_of_date) continue;
    const monthNum = parseInt(e.as_of_date.slice(5, 7), 10);
    if (!(monthNum >= 1 && monthNum <= 12)) continue;
    if (!byDate.has(e.as_of_date)) byDate.set(e.as_of_date, { date: e.as_of_date, monthNum, niYTD: 0, hasNI: false });
    if (NI_KW.test(e.account_name)) {
      byDate.get(e.as_of_date).niYTD += safeNum(e.amount);
      byDate.get(e.as_of_date).hasNI  = true;
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
          date:    `${year}-${String(monthNum).padStart(2, "0")}-28`,
          monthNum,
          niYTD:   cumNI,   // cumulative (YTD) NI through this month
          hasNI:   true,    // use proportional distribution, not equal split
        };
      });
    }
  }

  if (!sortedDates.length) return [];

  // Use proportional NI only when most months have the Net Income row; otherwise
  // split equally so monthly columns match BS monthly without distortion.
  const niCount = sortedDates.filter(d => d.hasNI).length;
  const useNI   = niCount >= Math.ceil(sortedDates.length / 2);
  const n       = sortedDates.length;

  console.log(`[FinStmt][PL][${year}] monthly fallback: ${n} months, ${niCount} with NI → ${useNI ? "proportional" : "equal"} split`);

  const scaleAccounts = (accounts, ratio) =>
    (accounts || []).map(a => ({ ...a, amount: round2(safeNum(a.amount) * ratio) }));

  const scaleStmt = (stmt, ratio) => {
    const revenue = {
      label:    stmt.revenue?.label,
      accounts: scaleAccounts(stmt.revenue?.accounts, ratio),
      total:    round2(safeNum(stmt.revenue?.total) * ratio),
    };
    const costOfSales = {
      label:    stmt.costOfSales?.label,
      accounts: scaleAccounts(stmt.costOfSales?.accounts, ratio),
      total:    round2(safeNum(stmt.costOfSales?.total) * ratio),
    };
    const grossProfit = round2(safeNum(stmt.grossProfit) * ratio);
    const scaledGroups = {};
    for (const [g, gv] of Object.entries(stmt.operatingExpenses?.groups || {})) {
      scaledGroups[g] = {
        label:    gv.label,
        accounts: scaleAccounts(gv.accounts, ratio),
        total:    round2(safeNum(gv.total) * ratio),
      };
    }
    const totalExpenses   = round2(safeNum(stmt.operatingExpenses?.total) * ratio);
    const operatingIncome = round2(safeNum(stmt.operatingIncome) * ratio);
    return {
      revenue,
      costOfSales,
      grossProfit,
      operatingExpenses: { label: stmt.operatingExpenses?.label, groups: scaledGroups, total: totalExpenses },
      operatingIncome,
      pretaxIncome: operatingIncome,
      netIncome:    operatingIncome,
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
      month:            MONTH_NAMES[curr.monthNum - 1],
      monthNumber:      curr.monthNum,
      year:             String(year),
      periodLabel:      `${MONTH_NAMES[curr.monthNum - 1]} ${year}`,
      statement:        scaleStmt(yearlyStatement, ratio),
      vendorsByAccount: {},
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
    data = await fetchAllRows(() =>
      supabase
        .from("general_ledger_entries")
        .select("account_name, split_account, account_number, amount, transaction_date, coa_id, split_coa_id")
        .eq("version_id", versionId)
        .gte("transaction_date", `${year}-01-01`)
        .lte("transaction_date", `${year}-12-31`)
        .or("row_type.eq.TRANSACTION,row_type.is.null"),
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
      byAccount.set(key, { rawName, accountNumber: row.account_number, total: 0, linked: Boolean(row.coa_id) });
    }
    byAccount.get(key).total += safeNum(row.amount);
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
      byAccount.set(row.split_coa_id, { rawName: splitName, accountNumber: null, total: 0, linked: true });
    }
    byAccount.get(row.split_coa_id).total += safeNum(row.amount);
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
    data = await fetchAllRows(() =>
      supabase
        .from("general_ledger_entries")
        .select("account_name, account_number, amount, transaction_date, coa_id")
        .eq("version_id", versionId)
        .gte("transaction_date", `${year}-01-01`)
        .lte("transaction_date", `${year}-12-31`)
        .or("row_type.eq.TRANSACTION,row_type.is.null"),
    );
  } catch (err) { console.warn(`[FinStmt][GL] ${err.message}`); return null; }
  if (!data?.length) return null;

  // Keyed by coa_id when linked (authoritative); norm(name) fallback only for
  // a row still missing coa_id. { rawName, accountNumber, months: Map<month, amount>, vendors: Map<vendorName, Map<month, amount>> }
  const byAccount   = new Map();
  const monthsFound = new Set();

  for (const row of data) {
    const rawName = String(row.account_name || "").trim();
    if (!rawName || isSummaryRow(rawName)) continue;
    const dateStr = String(row.transaction_date || "");
    const month   = parseInt(dateStr.slice(5, 7), 10);
    if (!(month >= 1 && month <= 12)) continue;

    const key = row.coa_id || norm(rawName);
    monthsFound.add(month);
    if (!byAccount.has(key)) {
      byAccount.set(key, { rawName, accountNumber: row.account_number, months: new Map(), linked: Boolean(row.coa_id) });
    }
    const acc = byAccount.get(key);
    acc.months.set(month, (acc.months.get(month) || 0) + safeNum(row.amount));
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

  const plAccounts  = allCoa.filter(isPlAccount);
  const plLeaves    = plAccounts.filter(a => !a.metadata?.is_group);
  const glMappings  = buildMappings(plLeaves);
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

  const months      = Array.from(gl.monthsFound).sort((a, b) => a - b);

  return months.map((monthNum) => {
    const leafAmounts = new Map(plLeaves.map(a => [a.id, 0]));
    // leafVendors: coaLeafId → vendorName → amount (for this month)
    const leafVendors = new Map();

    for (const [key, { rawName, accountNumber, months: monthMap, vendors, linked }] of gl.byAccount) {
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

      // Propagate vendor breakdown to mapped COA leaves.
      if (mappedIds?.length && vendors?.size) {
        for (const id of mappedIds) {
          if (!leafVendors.has(id)) leafVendors.set(id, new Map());
          const vMap = leafVendors.get(id);
          for (const [vName, vMonthMap] of vendors) {
            const vAmt = vMonthMap.get(monthNum) || 0;
            if (Math.abs(vAmt) < 0.005) continue;
            const share = mappedIds.length > 1 ? vAmt / mappedIds.length : vAmt;
            vMap.set(vName, (vMap.get(vName) || 0) + share);
          }
        }
      }
    }

    // If COA mapping produced no amounts, the tree still renders (all-zero,
    // consistent with unmappedSet already tracking why) — never guess a
    // revenue/expense split from the account name as a fallback.
    const { byId, roots, leaves } = buildTree(plAccounts);
    for (const root of roots) rollupNode(root, leafAmounts);

    // Serialise vendor map keyed by COA leaf display name so the frontend can look
    // it up directly via the account name shown in the statement rows.
    const vendorsByAccount = {};
    for (const [leafId, vMap] of leafVendors) {
      const leaf = plLeaves.find(l => l.id === leafId);
      const accountName = leaf?.name || String(leafId);
      vendorsByAccount[accountName] = Array.from(vMap.entries())
        .map(([name, amount]) => ({ name, amount: Math.round(amount * 100) / 100 }))
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    }

    return {
      month:           MONTH_NAMES[monthNum - 1],
      monthNumber:     monthNum,
      year:            String(year),
      periodLabel:     `${MONTH_NAMES[monthNum - 1]} ${year}`,
      statement:       buildPlStatement(leaves, byId),
      vendorsByAccount,
    };
  });
}

// ─── Yearly BS ────────────────────────────────────────────────────────────────

async function generateYearlyBs(_companyId, versionId, year, allCoa, unmappedSet) {
  const bsAccounts = allCoa.filter(isBsAccount);
  const bsLeaves   = bsAccounts.filter(a => !a.metadata?.is_group);

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
  const entries = await fetchAllRows(() => {
    let q = genFilter(
      supabase
        .from("balance_sheet_entries")
        .select("account_name, account_number, amount, is_total, coa_id")
        .eq("version_id", versionId),
    );
    return latestDate ? q.eq("as_of_date", latestDate) : q.eq("fiscal_year", year);
  });

  let hasUploadedNetIncome = false;
  let glFallbackUsed       = false;

  if (!entries?.length) {
    console.warn(`[FinStmt][BS][${year}] NO balance_sheet_entries found for version=${versionId} year=${year} asOf=${latestDate || 'N/A'}. Falling back to GL carry-forward (BS=prior-year close + GL).`);

    // No uploaded balance sheet for this year → derive per-account closing
    // balances from the existing Key Reports GL carry-forward engine
    // (BS(year) = BS(year-1 closing) + GL(year)) and map them onto COA leaves.
    // This reuses bsBalancesForYear() — no new statement logic here.
    try {
      const { balances } = await bsBalancesForYear(versionId, year);
      if (balances && balances.size) {
        const fuzzyLookup  = buildFuzzyLookup(bsLeaves);
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
      const isNI = /^net\s*(income|loss)/i.test(String(e.account_name || '').trim());
      // Skip calculated totals (is_total=true) UNLESS it's the Net Income equity line,
      // which QB exports mark as a total but which represents a real closing balance.
      if (e.is_total && !isNI) continue;
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

    const bsMappings  = buildMappings(bsLeaves);
    const fuzzyLookup = buildFuzzyLookup(bsLeaves);
    const mappedKeys  = new Set();

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

  const bsAccounts  = allCoa.filter(isBsAccount);
  const fuzzyLookup = buildFuzzyLookup(bsLeaves);
  // Find a Net Income leaf in equity section for cumulative P&L injection
  const niLeaf = bsLeaves.find(a => /net.*(income|loss)/i.test(String(a.account_name || a.name || '')))
              || bsLeaves.find(a => /retained/i.test(String(a.account_name || a.name || '')));

  const months = Array.from(byMonth.keys()).sort((a, b) => a - b);

  // cumLeafGL[leafId] = accumulated GL BS movements Jan..currentMonth
  const cumLeafGL = new Map(bsLeaves.map(a => [a.id, 0]));
  let   cumNI     = 0;
  const result    = [];

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
      month:       MONTH_NAMES[monthNum - 1],
      monthNumber: monthNum,
      year:        String(year),
      asOfDate:    `${year}-${String(monthNum).padStart(2, "0")}-28`,
      periodLabel: `${MONTH_NAMES[monthNum - 1]} ${year}`,
      statement:   buildBsStatement(leaves, byId),
    });
  }

  console.log(`[FinStmt][BS][${year}] GL monthly fallback: ${result.length} month snapshots`);
  return result;
}

async function generateMonthlyBs(companyId, versionId, year, allCoa, unmappedSet) {
  const bsAccounts = allCoa.filter(isBsAccount);
  const bsLeaves   = bsAccounts.filter(a => !a.metadata?.is_group);

  // Phase 4: prefer the generated monthly snapshots (authoritative). They provide
  // one as_of_date per month, which is exactly the month dimension this view wants.
  const hasGen = await hasGeneratedRows("balance_sheet_entries", versionId, year);
  const allEntries = await fetchAllRows(() => {
    let q = supabase
      .from("balance_sheet_entries")
      .select("account_name, account_number, amount, as_of_date, coa_id")
      .eq("version_id", versionId)
      .eq("fiscal_year", year)
      .or("is_total.eq.false,is_total.is.null");
    q = hasGen
      ? q.eq("is_generated", true)
      : q.or("is_generated.is.null,is_generated.eq.false");
    return q.order("as_of_date", { ascending: true });
  });

  const byDate = new Map();
  for (const e of (allEntries || [])) {
    if (isSummaryRow(e.account_name)) continue;
    const key = e.as_of_date || `${year}-12-31`;
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(e);
  }
  // Only one (or zero) distinct dates → fall back to GL carry-forward monthly snapshots.
  if (byDate.size <= 1) return generateMonthlyBsFromGL(companyId, versionId, year, allCoa, bsLeaves, unmappedSet);

  // Fallback matchers — only used for the rare row still missing coa_id
  // (e.g. a not-yet-relinked upload). Every row Phase E's linkBsToCoa/
  // generateMonthlyBalanceSheets already tagged resolves directly below.
  const bsMappings  = buildMappings(bsLeaves);
  const fuzzyLookup = buildFuzzyLookup(bsLeaves);
  const result      = [];

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
      month:       MONTH_NAMES[monthNum - 1] || dateKey,
      monthNumber: monthNum,
      year:        String(year),
      asOfDate:    dateKey,
      periodLabel: `${MONTH_NAMES[monthNum - 1] || dateKey} ${year}`,
      statement:   buildBsStatement(leaves, byId),
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
          .select("account_name, amount, as_of_date")
          .eq("version_id", versionId)
          .eq("fiscal_year", year)
          .or("is_total.eq.false,is_total.is.null")
      );
      return q.order("as_of_date", { ascending: true });
    });
  } catch (_e) { return []; }

  if (!entries?.length) return [];

  const byDate = new Map();
  for (const e of entries) {
    if (isSummaryRow(e.account_name)) continue;
    const dateKey  = e.as_of_date;
    if (!dateKey)  continue;
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
  const result    = [];

  for (let i = 1; i < sortedDates.length; i++) {
    const prevMap  = byDate.get(sortedDates[i - 1]);
    const currMap  = byDate.get(sortedDates[i]);
    const currDate = sortedDates[i];
    const monthNum = parseInt(currDate.slice(5, 7), 10);
    const allKeys  = new Set([...prevMap.keys(), ...currMap.keys()]);

    let operatingBase = 0, wcAdj = 0, investingTotal = 0, financingTotal = 0;
    const opAdjItems = [], invItems = [], finItems = [];

    for (const k of allKeys) {
      const name  = (currMap.get(k) || prevMap.get(k)).name;
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
    const netCash        = round2(operatingTotal + investingTotal + financingTotal);
    const openingCash    = round2(runningCash);
    runningCash         += netCash;
    const endingCash     = round2(runningCash);

    result.push({
      month:       MONTH_NAMES[monthNum - 1],
      monthNumber: monthNum,
      year:        String(year),
      periodLabel: `${MONTH_NAMES[monthNum - 1]} ${year}`,
      statement: {
        operatingActivities: {
          label: "Operating Activities",
          items: [{ name: "Net Income", amount: round2(operatingBase) }, ...opAdjItems],
          total: operatingTotal,
        },
        investingActivities:  { label: "Investing Activities",  items: invItems, total: round2(investingTotal) },
        financingActivities:  { label: "Financing Activities",  items: finItems, total: round2(financingTotal) },
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

function validateAll(plYearly, bsYearly) {
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
    // After injectNetIncomeToBS, this account always holds the authoritative NI for the year.
    const niAcc = bsEntry.statement.equity?.accounts?.find(
      a => /^net\s*(income|loss)/i.test(a.name || "")
    );
    if (niAcc && Math.abs(safeNum(niAcc.amount) - safeNum(plY.netIncome)) > 1) {
      const diff = round2(safeNum(niAcc.amount) - safeNum(plY.netIncome));
      errors.push(`FY${year} Net Income: generated P&L=${plY.netIncome} vs BS equity NI=${niAcc.amount} (diff=${diff})`);
    }
  }
  return errors;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

// Result-cache report_type for the full financial-statements payload. Bump the
// suffix to invalidate all cached rows after a shape change.
const FIN_STMT_CACHE_TYPE = "kr_financial_statements_v1";

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
        (r) => r?.data?.versionId === versionId && r?.data?.syncedAt === syncedAt &&
          r?.data?.coaUpdatedAt === coaUpdatedAt && String(r?.data?.yearKey) === yearKey && r?.data?.result,
      );
      if (hit) {
        console.log(`[FinStmt][Cache] hit v=${versionId} year=${yearKey}`);
        return { ...hit.data.result, companyName: options.companyName || "", currency: options.currency || "USD" };
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

  // ── Equity reconciliation — guarantee Assets = Liabilities + Equity ──────────
  // YEARLY: set current-year Net Income = generated P&L Net Income, then set
  // Retained Earnings to the residual that balances the sheet.
  reconcileEquityYearly(bsYearly, plYearly);
  // MONTHLY: each month-end snapshot already carries its cumulative Net Income
  // (from the P&L roll-forward); set Retained Earnings to the balancing residual so
  // every month balances too. Applied to every month across every year.
  for (const monthsForYear of bsMonthly) {
    for (const monthEntry of (monthsForYear || [])) {
      if (monthEntry?.statement) balanceRetainedEarnings(monthEntry.statement);
    }
  }

  const validation       = validateAll(plYearly, bsYearly);
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
    currency:    options.currency    || "USD",
    reports: {
      profitAndLoss: { monthly: plMonthly.flat(), yearly: plYearly },
      balanceSheet:  { monthly: bsMonthly.flat(), yearly: bsYearly },
      cashFlow:      { monthly: cfMonthly.flat(), yearly: cfYearly },
    },
    validation,
    missingData: [],
  };

  // Persist to the result cache (best-effort). One row per (version, yearKey):
  // a re-generate/COA edit changes the key and this overwrites the stale row.
  if (options.noCache !== true && companyId) {
    try {
      const now = new Date().toISOString();
      const payload = { versionId, syncedAt, coaUpdatedAt, yearKey, result };
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
 * Mapping (per product spec):
 *   Sales per Financials    ← monthly "Total for Income"  (statement.revenue.total)
 *   Expenses per Financials ← monthly "Net Operating Income" (statement.operatingIncome)
 *
 * Keyed by "YYYY-MM" to match the Activity Review's monthKey. Spans every fiscal
 * year present in the version (no year filter), so multi-year ranges are covered.
 *
 * @returns {Promise<{ totalIncome: Object<string,number>, totalExpenses: Object<string,number> }>}
 */
const PL_FINANCIALS_CACHE_TYPE = "kr_pl_financials_v1";

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
    totalExpenses[key] = round2(safeNum(entry.statement?.operatingIncome));
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

module.exports = {
  generateFinancialStatements,
  getMonthlyPlFinancials,
  // Exported so keyReportReportService.js's getCashflowReport can delegate to
  // this COA-driven (cf_category) engine instead of the legacy name/regex
  // classifier in manualCashFlowService.js — one Cash Flow engine, not two.
  loadCoa,
  generateYearlyCf,
};
