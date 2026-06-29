// ============================================================================
// Financial Statement Service — COA-driven P&L, Balance Sheet, Cash Flow
//
// Architecture:
//   chart_of_accounts  (hierarchy + classification, parent_account_id tree)
//       │
//       ├─ Category nodes (metadata.is_group = true)  — structural, no amounts
//       └─ Leaf accounts  (metadata.is_group = false) — map to entry table rows
//               │
//               └─ coa_account_mappings  (bridge: COA id ↔ entry row name)
//                       │
//                       └─ entry tables  (profit_loss_entries / balance_sheet_entries / GL)
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
const { getCashflowReport, bsBalancesForYear, aggregateGLForBSByMonth } = require("./keyReportReportService");

// ─── Utilities ────────────────────────────────────────────────────────────────

const safeNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2  = (v) => Math.round(safeNum(v) * 100) / 100;

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
const LEVEL_KEYS = Array.from({ length: 15 }, (_, i) => `level_${i + 1}`);

/**
 * Primary normalization applied to BOTH sides of every name lookup.
 * Must be identical to the fallback normalization in coa_account_mappings.
 */
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const normStrict = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const displayName = (acc) => acc.adjusted_name || acc.base_account || acc.account_name;

// ─── Unmapped BS entry classification ────────────────────────────────────────
// When a balance_sheet_entries row can't be matched to a COA leaf, classify it
// by keyword so it still appears on the correct side of the Balance Sheet.
// Mirrors classifyGLAccount in keyReportReportService but scoped to BS types.

const _BS_PRIORITY_ASSET_KW = ['loans to', 'loan to'];
const _BS_LIABILITY_KW      = ['payable', 'accrued', 'credit card', 'loan', 'liability', 'mortgage', 'deferred', 'unearned'];
const _BS_ASSET_KW          = ['cash', 'bank', 'checking', 'savings', 'receivable', 'inventory', 'prepaid', 'deposit', 'money market', 'equipment', 'furniture', 'vehicle', 'building', 'land', 'property', 'accumulated depreciation', 'goodwill', 'intangible', 'investment', 'due from', 'asset'];
const _BS_EQUITY_KW         = ['equity', 'capital', 'retained earnings', 'owner', 'member', 'distribution', 'draw', 'net income', 'net loss'];

function classifyUnmappedBSAccount(name) {
  const n = String(name || '').toLowerCase();
  const hit = (kws) => kws.some(k => n.includes(k));
  if (hit(_BS_PRIORITY_ASSET_KW)) return 'asset';
  if (hit(_BS_LIABILITY_KW))      return 'liability';
  if (hit(_BS_ASSET_KW))          return 'asset';
  if (hit(_BS_EQUITY_KW))         return 'equity';
  return null;
}

function makeSyntheticLeaf(rawName, amount, acType) {
  const section = acType === 'asset'     ? 'Other Current Assets'
    : acType === 'liability' ? 'Other Current Liabilities'
    : 'Equity';
  return {
    id: `__synthetic__${norm(rawName)}`,
    system_id: null, account_number: null,
    account_name: rawName, adjusted_name: null, base_account: null,
    account_type: acType, statement_type: 'balance_sheet',
    parent_account_id: null, metadata: null, hierarchy_path: null,
    level_1: acType === 'asset' ? 'Assets' : acType === 'liability' ? 'Liabilities' : 'Equity',
    level_2: section,
    level_3: null, level_4: null, level_5: null,
    level_6: null, level_7: null, level_8: null, level_9: null, level_10: null,
    level_11: null, level_12: null, level_13: null, level_14: null, level_15: null,
    isGroup: false, children: [],
    signedAmount: amount, displayAmount: amount, leafAmount: amount,
  };
}

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
    "parent_account_id", "metadata",
    ...LEVEL_KEYS, "hierarchy_path", "is_active", "sort_order",
  ].join(", ");

  const { data, error } = await supabase
    .from("chart_of_accounts")
    .select(cols)
    .eq("version_id", versionId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (error) throw new Error(`COA load: ${error.message}`);
  const accounts = data || [];
  const leaves = accounts.filter(a => !a.metadata?.is_group);
  const groups = accounts.filter(a =>  a.metadata?.is_group);
  console.log(`[FinStmt][COA] ${accounts.length} accounts (${leaves.length} leaves, ${groups.length} groups)`);
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

async function loadMappings(versionId, sourceTable) {
  const { data, error } = await supabase
    .from("coa_account_mappings")
    .select("account_id, source_account_name, normalized_name, source_account_number")
    .eq("version_id", versionId)
    .eq("source_table", sourceTable);

  if (error) {
    console.warn(`[FinStmt][Mappings][${sourceTable}] ${error.message} — name-match fallback`);
    return null;
  }

  const map = new Map(); // norm(name) → account_id[]
  for (const row of (data || [])) {
    // Apply norm() so keys always match norm(entry.account_name).
    const key = norm(row.normalized_name || row.source_account_name);
    if (key) {
      if (!map.has(key)) map.set(key, []);
      if (!map.get(key).includes(row.account_id)) map.get(key).push(row.account_id);
    }
    if (row.source_account_number) {
      const numKey = `__num__${String(row.source_account_number).trim()}`;
      if (!map.has(numKey)) map.set(numKey, []);
      if (!map.get(numKey).includes(row.account_id)) map.get(numKey).push(row.account_id);
    }
  }
  console.log(`[FinStmt][Mappings][${sourceTable}] ${data?.length || 0} rows → ${map.size} keys`);
  return map;
}

// ─── Multi-strategy fuzzy fallback matcher ────────────────────────────────────

function buildFuzzyLookup(leaves) {
  const exact  = new Map();
  const strict = new Map();
  const byNum  = new Map();
  for (const acc of leaves) {
    const names = [acc.adjusted_name, acc.account_name, acc.base_account].filter(Boolean);
    for (const name of names) {
      const k1 = norm(name);
      if (k1 && !exact.has(k1))  exact.set(k1, acc.id);
      const k2 = normStrict(name);
      if (k2 && !strict.has(k2)) strict.set(k2, acc.id);
    }
    if (acc.account_number) {
      const nk = String(acc.account_number).trim();
      if (nk && !byNum.has(nk)) byNum.set(nk, acc.id);
    }
  }
  return { exact, strict, byNum };
}

function fuzzyMatch(lookup, name, accountNumber) {
  const k1 = norm(name);
  if (lookup.exact.has(k1)) return { id: lookup.exact.get(k1), confidence: 1.0 };

  if (accountNumber) {
    const nk = String(accountNumber).trim();
    if (lookup.byNum.has(nk)) return { id: lookup.byNum.get(nk), confidence: 1.0 };
  }

  const k2 = normStrict(name);
  if (k2 && lookup.strict.has(k2)) return { id: lookup.strict.get(k2), confidence: 0.95 };

  // Word-set Jaccard similarity with a lowered threshold of 0.50 to catch more valid
  // accounts (e.g. "Cost of Goods Sold" vs "Cost of Sales", "Rent Expense" vs "Rent").
  // Also bonuses for: containment (substring), shared first word, shared last word.
  const words1 = new Set(k1.split(" ").filter(w => w.length > 1));
  const arr1   = [...words1];
  let bestId = null, bestScore = 0;
  for (const [k, id] of lookup.exact) {
    const words2 = new Set(k.split(" ").filter(w => w.length > 1));
    if (!words2.size || !words1.size) continue;
    const inter = arr1.filter(w => words2.has(w)).length;
    const union = new Set([...arr1, ...words2]).size;
    const jaccard = union > 0 ? inter / union : 0;
    const containsBonus  = (k1.includes(k) || k.includes(k1)) ? 0.10 : 0;
    const firstWordBonus = (arr1[0] && arr1[0] === [...words2][0]) ? 0.05 : 0;
    const lastWordBonus  = (arr1[arr1.length - 1] && arr1[arr1.length - 1] === [...words2][words2.size - 1]) ? 0.05 : 0;
    const total = Math.min(jaccard + containsBonus + firstWordBonus + lastWordBonus, 1.0);
    if (total > bestScore && total >= 0.50) { bestScore = total; bestId = id; }
  }
  if (bestId) return { id: bestId, confidence: bestScore };

  return null;
}

// ─── Amount loading for leaf accounts ─────────────────────────────────────────

/**
 * Load Map<coaLeafId, amount> from an entry table.
 * Only LEAF accounts receive amounts; category/group nodes stay at 0 (tree rollup fills them).
 * Summary rows (Gross Profit, Net Income, …) are skipped.
 */
async function buildLeafAmountMap(versionId, sourceTable, year, leaves, unmappedSet) {
  const amountById = new Map(leaves.map(a => [a.id, 0]));

  let query = supabase
    .from(sourceTable)
    .select("account_name, account_number, amount")
    .eq("version_id", versionId)
    .or("is_total.eq.false,is_total.is.null");
  if (year) query = query.eq("fiscal_year", year);

  const { data: entries, error } = await query.limit(200000);
  if (error) throw new Error(`Entry load (${sourceTable}): ${error.message}`);
  if (!entries?.length) {
    console.warn(`[FinStmt][Entries][${sourceTable}] 0 rows for version=${versionId} year=${year}`);
    return amountById;
  }

  // Aggregate by normalized name, skipping summary rows.
  const entryTotals = new Map();
  let skipped = 0;
  for (const e of entries) {
    if (isSummaryRow(e.account_name)) { skipped++; continue; }
    const key = norm(e.account_name);
    if (!key) continue;
    if (!entryTotals.has(key)) entryTotals.set(key, { amount: 0, rawName: e.account_name, accountNumber: e.account_number });
    entryTotals.get(key).amount += safeNum(e.amount);
  }
  console.log(`[FinStmt][Entries][${sourceTable}] ${entries.length} rows, ${skipped} summary rows skipped → ${entryTotals.size} unique accounts`);

  // Build fuzzy lookup once — used in both the mapping-miss path and the no-mapping fallback.
  const fuzzyLookup = buildFuzzyLookup(leaves);

  // Primary: use coa_account_mappings.  Entries that miss the mapping table are
  // tried against fuzzy matching before being declared unmapped.
  const mappings = await loadMappings(versionId, sourceTable);
  let matched = 0, missed = 0;
  if (mappings && mappings.size > 0) {
    for (const [normName, { amount, rawName, accountNumber }] of entryTotals) {
      let ids = mappings.get(normName);
      if (!ids?.length && accountNumber) ids = mappings.get(`__num__${String(accountNumber).trim()}`);
      if (ids?.length) {
        for (const id of ids) {
          if (amountById.has(id))
            amountById.set(id, (amountById.get(id) || 0) + amount / ids.length);
        }
        matched++;
      } else {
        // Mapping missed — try fuzzy before discarding (handles normalisation edge cases).
        const result = fuzzyMatch(fuzzyLookup, rawName || normName, accountNumber);
        if (result && amountById.has(result.id)) {
          amountById.set(result.id, (amountById.get(result.id) || 0) + amount);
          matched++;
        } else {
          unmappedSet.add(normName);
          missed++;
        }
      }
    }
    console.log(`[FinStmt][Map][${sourceTable}] ${matched} matched (incl. fuzzy), ${missed} unmapped via coa_account_mappings`);
    return amountById;
  }

  // Fallback: no mappings at all — pure fuzzy name matching against leaf accounts.
  console.warn(`[FinStmt][Map][${sourceTable}] no mappings — fuzzy name match`);
  for (const [normName, { amount, rawName, accountNumber }] of entryTotals) {
    const result = fuzzyMatch(fuzzyLookup, rawName, accountNumber);
    if (result && amountById.has(result.id)) {
      amountById.set(result.id, (amountById.get(result.id) || 0) + amount);
      if (result.confidence < 1.0)
        console.log(`[FinStmt][Fuzzy] "${rawName}" → ${result.id} (${(result.confidence * 100).toFixed(0)}%)`);
      matched++;
    } else {
      unmappedSet.add(normName);
      missed++;
    }
  }
  console.log(`[FinStmt][Fuzzy][${sourceTable}] ${matched} matched, ${missed} unmapped`);
  return amountById;
}

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
    const sign = ROLLUP_SIGN[node.account_type] ?? 1;
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

/**
 * Determine the display label for an expense/COGS group.
 * Priority: direct parent node name → level_8 → level_7 → fallback.
 */
function groupLabelFor(node, byId) {
  if (node.parent_account_id) {
    const parent = byId.get(node.parent_account_id);
    if (parent) {
      const parentName = displayName(parent);
      // Skip top-level section names — they're not useful as group labels
      if (parentName && !/^(total\s+expenses?|expenses?|total\s+cost|cost\s+of\s+sales)$/i.test(parentName.trim())) {
        return parentName;
      }
    }
  }
  return node.level_8 || node.level_7 || "General and Administrative";
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
  });

  // Revenue — flat list, total = sum of income leaves
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

/**
 * Build Balance Sheet statement from the rolled-up tree.
 * Sections (Current/Fixed/Other Assets, Current/Long-Term Liabilities) come from
 * direct parent category node names or level_2/level_3 as fallback.
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
  });

  // Patterns that mark a label as a top-level aggregate rather than a useful
  // section (e.g. "Total Assets", "Balance Sheet").  When a grandNode has such
  // a label we fall through to the level columns to find a real section name.
  const AGGREGATE_LABEL_RE = /^(total\s+(assets?|liabilit|equity|liabilities\s+and|balance\s+sheet)|balance\s+sheet)\s*$/i;

  function resolveSecGrp(n) {
    const parentNode = n.parent_account_id ? byId.get(n.parent_account_id) : null;
    const grandNode  = parentNode?.parent_account_id ? byId.get(parentNode.parent_account_id) : null;

    let grpLabel = parentNode ? displayName(parentNode) : null;
    let secLabel = grandNode  ? displayName(grandNode)  : null;

    // When the grandNode is an unhelpful aggregate (e.g. "Total Assets") or
    // doesn't exist, fall back to the leaf's level columns which always carry
    // the standardised section names ("Current Assets", "Current Liabilities", …).
    if (!secLabel || AGGREGATE_LABEL_RE.test(secLabel)) {
      // Scan level_3 … level_2 for a meaningful section name
      for (let i = 4; i >= 2; i--) {
        const lvl = n[`level_${i}`];
        if (lvl && !AGGREGATE_LABEL_RE.test(lvl) && lvl !== displayName(n)) {
          secLabel = lvl;
          break;
        }
      }
    }
    // Same guard for grpLabel (parent may also be a top-level aggregate)
    if (!grpLabel || AGGREGATE_LABEL_RE.test(grpLabel)) {
      for (let i = 5; i >= 3; i--) {
        const lvl = n[`level_${i}`];
        if (lvl && !AGGREGATE_LABEL_RE.test(lvl) && lvl !== displayName(n) && lvl !== secLabel) {
          grpLabel = lvl;
          break;
        }
      }
    }

    // Ultimate fallbacks
    grpLabel = grpLabel || n.level_4 || n.level_3 || "Other";
    secLabel = secLabel || grpLabel;
    return { secLabel, grpLabel };
  }

  function buildGroupMap(accs) {
    const sections = {};
    for (const n of accs) {
      const { secLabel, grpLabel } = resolveSecGrp(n);
      if (!sections[secLabel]) sections[secLabel] = { label: secLabel, groups: {}, total: 0 };
      if (!sections[secLabel].groups[grpLabel]) sections[secLabel].groups[grpLabel] = { label: grpLabel, accounts: [], total: 0 };
      const leaf = toLeaf(n);
      sections[secLabel].groups[grpLabel].accounts.push(leaf);
      sections[secLabel].groups[grpLabel].total = safeNum(sections[secLabel].groups[grpLabel].total + leaf.amount);
      sections[secLabel].total = safeNum(sections[secLabel].total + leaf.amount);
    }
    return sections;
  }

  const assetSections  = buildGroupMap(assets);
  const liabSections   = buildGroupMap(liabilities);
  const equityAccounts = equities.map(toLeaf);

  const totalAssets      = safeNum(Object.values(assetSections).reduce((s, sec) => s + sec.total, 0));
  const totalLiabilities = safeNum(Object.values(liabSections).reduce((s, sec) => s + sec.total, 0));
  const totalEquity      = safeNum(equityAccounts.reduce((s, a) => s + a.amount, 0));
  const totalLE          = safeNum(totalLiabilities + totalEquity);
  const difference       = safeNum(totalAssets - totalLE);

  const findSection = (sections, patterns) =>
    Object.entries(sections).find(([label]) =>
      patterns.some(p => new RegExp(p, "i").test(label))
    )?.[1];

  // Merge any sections not explicitly claimed into a default bucket.
  // This prevents amounts from "falling through" when section labels don't
  // exactly match the expected patterns (e.g. a flat "Assets" section).
  function mergeSurplus(sections, claimed, defaultBucket) {
    const claimedLabels = new Set(claimed.filter(Boolean).map(s => s.label));
    for (const [label, sec] of Object.entries(sections)) {
      if (claimedLabels.has(label)) continue;
      for (const [grpLabel, grp] of Object.entries(sec.groups)) {
        if (!defaultBucket.groups[grpLabel])
          defaultBucket.groups[grpLabel] = { label: grpLabel, accounts: [], total: 0 };
        defaultBucket.groups[grpLabel].accounts.push(...grp.accounts);
        defaultBucket.groups[grpLabel].total = safeNum(defaultBucket.groups[grpLabel].total + grp.total);
      }
      defaultBucket.total = safeNum(defaultBucket.total + sec.total);
    }
  }

  // Map tree sections to canonical frontend keys (pattern-match on section label).
  const currentAssets = findSection(assetSections, ["current"])            || { label: "Current Assets",        groups: {}, total: 0 };
  const fixedAssets   = findSection(assetSections, ["fixed", "property"])  || { label: "Fixed Assets",           groups: {}, total: 0 };
  const otherAssets   = findSection(assetSections, ["other", "long.?term asset", "noncurrent asset"]) || { label: "Other Assets", groups: {}, total: 0 };
  mergeSurplus(assetSections, [currentAssets, fixedAssets, otherAssets], currentAssets);

  const currentLiab  = findSection(liabSections, ["current"])              || { label: "Current Liabilities",   groups: {}, total: 0 };
  const longTermLiab = findSection(liabSections, ["long", "noncurrent liabilit", "non.current liabilit"]) || { label: "Long-Term Liabilities", groups: {}, total: 0 };
  mergeSurplus(liabSections, [currentLiab, longTermLiab], currentLiab);

  return {
    assets: {
      label: assets[0]?.level_1 || "Total Assets",
      currentAssets:  { label: currentAssets.label, groups: currentAssets.groups, total: currentAssets.total },
      fixedAssets:    { label: fixedAssets.label,   groups: fixedAssets.groups,   total: fixedAssets.total },
      otherAssets:    { label: otherAssets.label,   groups: otherAssets.groups,   total: otherAssets.total },
      total: totalAssets,
    },
    liabilities: {
      label: "Liabilities",
      currentLiabilities:  { label: currentLiab.label,  groups: currentLiab.groups,  total: currentLiab.total },
      longTermLiabilities: { label: longTermLiab.label, groups: longTermLiab.groups, total: longTermLiab.total },
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

// ─── Distinct years ───────────────────────────────────────────────────────────

async function distinctYears(versionId) {
  // Exclude is_generated rows from PL/BS so accumulated persisted rows never fill
  // the query limit and push real uploaded-year rows out of the result set.
  // Filter GL by TRANSACTION row_type to skip ACCOUNT_HEADER / BEGINNING_BALANCE /
  // TOTAL_ROW rows (post-migration 050 rows that have null fiscal_year).
  const [pl, bs, gl, glDateFallback] = await Promise.all([
    supabase.from("profit_loss_entries").select("fiscal_year")
      .eq("version_id", versionId)
      .or("is_generated.is.null,is_generated.eq.false")
      .limit(200000),
    supabase.from("balance_sheet_entries").select("fiscal_year")
      .eq("version_id", versionId)
      .or("is_generated.is.null,is_generated.eq.false")
      .limit(200000),
    supabase.from("general_ledger_entries").select("fiscal_year")
      .eq("version_id", versionId)
      .or("row_type.eq.TRANSACTION,row_type.is.null")
      .not("fiscal_year", "is", null)
      .limit(200000),
    // Fallback: GL rows where fiscal_year is null but transaction_date carries the
    // year. Handles GL files extracted before migration 050 or where the extraction
    // failed to assign a fiscal_year (e.g. 2025 GL with year-detection gap).
    supabase.from("general_ledger_entries").select("transaction_date")
      .eq("version_id", versionId)
      .is("fiscal_year", null)
      .not("transaction_date", "is", null)
      .or("row_type.eq.TRANSACTION,row_type.is.null")
      .limit(200000),
  ]);
  const set = new Set();
  for (const row of [...(pl.data || []), ...(bs.data || []), ...(gl.data || [])]) {
    const y = Number(row.fiscal_year);
    if (y >= 1990 && y <= 2100) set.add(y);
  }
  // Infer fiscal years from transaction_date for GL rows that have no fiscal_year set.
  for (const row of (glDateFallback.data || [])) {
    const y = parseInt(String(row.transaction_date || "").slice(0, 4), 10);
    if (y >= 1990 && y <= 2100) set.add(y);
  }
  const years = Array.from(set).sort((a, b) => a - b);
  console.log(
    `[FinStmt][Years] pl=${pl.data?.length || 0} bs=${bs.data?.length || 0} ` +
    `gl=${gl.data?.length || 0} glDateFallback=${glDateFallback.data?.length || 0} → [${years.join(", ")}]`,
  );
  return years;
}

// ─── Version → company helper ─────────────────────────────────────────────────

async function getVersionCompanyId(versionId) {
  const { data } = await supabase
    .from("key_report_versions")
    .select("company_id")
    .eq("id", versionId)
    .maybeSingle();
  return data?.company_id || null;
}

// ─── Generated report persistence ────────────────────────────────────────────
// Persist GL-derived (generated) reports back to the entry tables so the
// carry-forward chain can reuse them on the next call without re-generating.
// Only called when no extracted (uploaded) rows exist for the year.

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

async function persistGeneratedPl(versionId, companyId, year, plStatement) {
  try {
    const rows = [];
    let sort = 0;
    const push = (name, amount, isTotal, hierarchyLevel) =>
      rows.push({ version_id: versionId, company_id: companyId, source_file_id: null,
        fiscal_year: year, account_name: name, amount: safeNum(amount),
        is_total: isTotal, hierarchy_level: hierarchyLevel, sort_order: sort++,
        is_generated: true });

    push(plStatement.revenue?.label || "Income", 0, false, 0);
    for (const a of plStatement.revenue?.accounts || []) push(a.name, a.amount, false, 1);
    push("Total Revenue", plStatement.revenue?.total, true, 1);
    for (const a of plStatement.costOfSales?.accounts || []) push(a.name, a.amount, false, 1);
    if (plStatement.costOfSales?.accounts?.length)
      push("Total Cost of Sales", plStatement.costOfSales?.total, true, 1);
    push("Gross Profit", plStatement.grossProfit, true, 0);
    push(plStatement.operatingExpenses?.label || "Expenses", 0, false, 0);
    for (const [, g] of Object.entries(plStatement.operatingExpenses?.groups || {})) {
      push(g.label, 0, false, 1);
      for (const a of g.accounts || []) push(a.name, a.amount, false, 2);
      push(`Total ${g.label}`, g.total, true, 1);
    }
    push("Total Expenses", plStatement.operatingExpenses?.total, true, 0);
    push("Net Income", plStatement.netIncome, true, 0);

    if (!rows.length) return;
    const { error } = await supabase.from("profit_loss_entries").insert(rows);
    if (error) console.warn(`[FinStmt][Persist][PL][${year}] ${error.message}`);
    else console.log(`[FinStmt][Persist][PL][${year}] ${rows.length} rows stored (is_generated=true)`);
  } catch (err) {
    console.warn(`[FinStmt][Persist][PL][${year}] ${err.message}`);
  }
}

async function persistGeneratedBs(versionId, companyId, year, bsStatement) {
  try {
    const rows = [];
    let sort = 0;
    const push = (name, amount, section, isTotal) =>
      rows.push({ version_id: versionId, company_id: companyId, source_file_id: null,
        fiscal_year: year, as_of_date: `${year}-12-31`, account_name: name,
        amount: safeNum(amount), section, is_total: isTotal,
        hierarchy_level: isTotal ? 1 : 2, sort_order: sort++, is_generated: true });

    // Assets
    for (const [, sec] of Object.entries({
      ...(bsStatement.assets?.currentAssets ? { currentAssets: bsStatement.assets.currentAssets } : {}),
      ...(bsStatement.assets?.fixedAssets   ? { fixedAssets:   bsStatement.assets.fixedAssets   } : {}),
      ...(bsStatement.assets?.otherAssets   ? { otherAssets:   bsStatement.assets.otherAssets   } : {}),
    })) {
      for (const [, g] of Object.entries(sec?.groups || {})) {
        for (const a of g.accounts || []) push(a.name, a.amount, "assets", false);
        push(`Total ${g.label}`, g.total, "assets", true);
      }
    }
    push("Total Assets", bsStatement.totalAssets, "assets", true);

    // Liabilities
    for (const [, sec] of Object.entries({
      ...(bsStatement.liabilities?.currentLiabilities  ? { current:  bsStatement.liabilities.currentLiabilities  } : {}),
      ...(bsStatement.liabilities?.longTermLiabilities ? { longterm: bsStatement.liabilities.longTermLiabilities } : {}),
    })) {
      for (const [, g] of Object.entries(sec?.groups || {})) {
        for (const a of g.accounts || []) push(a.name, a.amount, "liabilities", false);
        push(`Total ${g.label}`, g.total, "liabilities", true);
      }
    }
    push("Total Liabilities", bsStatement.totalLiabilities, "liabilities", true);

    // Equity
    for (const a of bsStatement.equity?.accounts || []) push(a.name, a.amount, "equity", false);
    push("Total Equity", bsStatement.totalEquity, "equity", true);

    if (!rows.length) return;
    const { error } = await supabase.from("balance_sheet_entries").insert(rows);
    if (error) console.warn(`[FinStmt][Persist][BS][${year}] ${error.message}`);
    else console.log(`[FinStmt][Persist][BS][${year}] ${rows.length} rows stored (is_generated=true)`);
  } catch (err) {
    console.warn(`[FinStmt][Persist][BS][${year}] ${err.message}`);
  }
}

// ─── Yearly P&L ───────────────────────────────────────────────────────────────

async function generateYearlyPl(versionId, year, allCoa, unmappedSet) {
  const plAccounts = allCoa.filter(isPlAccount);
  const plLeaves   = plAccounts.filter(a => !a.metadata?.is_group);

  const leafAmounts = await buildLeafAmountMap(versionId, "profit_loss_entries", year, plLeaves, unmappedSet);

  // If profit_loss_entries has no data for this year, fall back to GL transactions.
  // This handles years where the P&L file was not uploaded or extraction failed.
  let glFallbackUsed = false;
  const hasPlData = Array.from(leafAmounts.values()).some(v => Math.abs(v) > 0.005);
  if (!hasPlData) {
    const gl = await loadGlAmountsByMonth(versionId, year);
    if (gl) {
      const glMappings  = await loadMappings(versionId, "general_ledger_entries");
      const fuzzyLookup = buildFuzzyLookup(plLeaves);
      for (const [normKey, { rawName, accountNumber, months: monthMap }] of gl.byAccount) {
        const totalAmt = Array.from(monthMap.values()).reduce((s, v) => s + v, 0);
        if (Math.abs(totalAmt) < 0.005) continue;
        let ids = glMappings?.get(normKey);
        if (!ids?.length && accountNumber) ids = glMappings?.get(`__num__${String(accountNumber).trim()}`);
        if (ids?.length) {
          for (const id of ids) {
            if (leafAmounts.has(id)) leafAmounts.set(id, (leafAmounts.get(id) || 0) + totalAmt / ids.length);
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
      glFallbackUsed = true;
      console.log(`[FinStmt][PL][${year}] GL fallback: no profit_loss_entries found, derived from GL transactions`);
    }
  }

  const { byId, roots, leaves } = buildTree(plAccounts);
  for (const leaf of leaves) {
    const node = byId.get(leaf.id);
    if (node) node.leafAmount = leafAmounts.get(leaf.id) || 0;
  }
  for (const root of roots) rollupNode(root, leafAmounts);

  const stmt = buildPlStatement(leaves, byId);
  console.log(`[FinStmt][PL][${year}] rev=${stmt.revenue.total} cogs=${stmt.costOfSales.total} gp=${stmt.grossProfit} exp=${stmt.operatingExpenses.total} ni=${stmt.netIncome}`);

  // Persist GL-generated P&L so subsequent calls skip GL re-processing.
  // Only store if not already persisted (is_generated rows exist = skip).
  if (glFallbackUsed) {
    const alreadyGenerated = await hasGeneratedRows("profit_loss_entries", versionId, year);
    if (!alreadyGenerated) {
      const companyId = await getVersionCompanyId(versionId);
      if (companyId) await persistGeneratedPl(versionId, companyId, year, stmt);
    }
  }

  return { year: String(year), periodLabel: `FY ${year}`, statement: stmt };
}

// ─── Monthly P&L (via GL entries) ─────────────────────────────────────────────

// GL-direct P&L for one month — used when COA mapping produces all-zero results.
function buildGlDirectPlStatement(byAccount, monthNum) {
  const REVENUE_RE = /revenue|income|sales|fees earned|interest income|gross receipts|gain on sale|refund/i;
  const revenue = [], expenses = [];
  for (const { rawName, months } of byAccount.values()) {
    const amt = months.get(monthNum) || 0;
    if (Math.abs(amt) < 0.005) continue;
    if (REVENUE_RE.test(rawName)) {
      revenue.push({ name: rawName, amount: round2(Math.abs(amt)) });
    } else {
      expenses.push({ name: rawName, amount: round2(Math.abs(amt)) });
    }
  }
  const totalRevenue  = round2(revenue.reduce((s, a) => s + a.amount, 0));
  const totalExpenses = round2(expenses.reduce((s, a) => s + a.amount, 0));
  const grossProfit   = totalRevenue;
  const netIncome     = round2(totalRevenue - totalExpenses);
  return {
    revenue:          { label: "Total Revenue",  accounts: revenue,   total: totalRevenue },
    costOfSales:      { label: "Cost of Sales",  accounts: [],        total: 0 },
    grossProfit,
    operatingExpenses: { label: "Total Expenses", groups: { "Operating Expenses": { label: "Operating Expenses", accounts: expenses, total: totalExpenses } }, total: totalExpenses },
    operatingIncome:  netIncome,
    netIncome,
  };
}

async function loadGlAmountsByMonth(versionId, year) {
  // Include rows where row_type is null — those are pre-migration-050 transaction
  // rows that were extracted before the TRANSACTION / ACCOUNT_HEADER enum was added.
  // Also include rows where fiscal_year is null but transaction_date falls in `year`
  // (handles GL files where year-detection failed during extraction).
  const { data, error } = await supabase
    .from("general_ledger_entries")
    .select("distribution_account, account_name, account_number, amount, transaction_date, fiscal_year, transaction_name")
    .eq("version_id", versionId)
    .or(
      `fiscal_year.eq.${year},` +
      `and(fiscal_year.is.null,transaction_date.gte.${year}-01-01,transaction_date.lte.${year}-12-31)`,
    )
    .or("row_type.eq.TRANSACTION,row_type.is.null")
    .limit(200000);

  if (error) { console.warn(`[FinStmt][GL] ${error.message}`); return null; }
  if (!data?.length) return null;

  // norm(name) → { rawName, accountNumber, months: Map<month, amount>, vendors: Map<vendorName, Map<month, amount>> }
  const byAccount   = new Map();
  const monthsFound = new Set();

  for (const row of data) {
    const rawName = String(row.distribution_account || row.account_name || "").trim();
    if (!rawName || isSummaryRow(rawName)) continue;
    const dateStr = String(row.transaction_date || "");
    const month   = parseInt(dateStr.slice(5, 7), 10);
    if (!(month >= 1 && month <= 12)) continue;

    const key    = norm(rawName);
    const vendor = String(row.transaction_name || "").trim() || null;
    monthsFound.add(month);
    if (!byAccount.has(key)) {
      byAccount.set(key, { rawName, accountNumber: row.account_number, months: new Map(), vendors: new Map() });
    }
    const acc = byAccount.get(key);
    acc.months.set(month, (acc.months.get(month) || 0) + safeNum(row.amount));
    if (vendor) {
      if (!acc.vendors.has(vendor)) acc.vendors.set(vendor, new Map());
      const vMap = acc.vendors.get(vendor);
      vMap.set(month, (vMap.get(month) || 0) + safeNum(row.amount));
    }
  }

  console.log(`[FinStmt][GL] ${data.length} rows → ${byAccount.size} accounts, months=[${Array.from(monthsFound).sort().join(",")}]`);
  return monthsFound.size ? { byAccount, monthsFound } : null;
}

async function generateMonthlyPl(versionId, year, allCoa, unmappedSet) {
  const gl = await loadGlAmountsByMonth(versionId, year);
  if (!gl) return [];

  const plAccounts  = allCoa.filter(isPlAccount);
  const plLeaves    = plAccounts.filter(a => !a.metadata?.is_group);
  const glMappings  = await loadMappings(versionId, "general_ledger_entries");
  const fuzzyLookup = buildFuzzyLookup(plLeaves);
  const months      = Array.from(gl.monthsFound).sort((a, b) => a - b);

  return months.map((monthNum) => {
    const leafAmounts = new Map(plLeaves.map(a => [a.id, 0]));
    // leafVendors: coaLeafId → vendorName → amount (for this month)
    const leafVendors = new Map();

    for (const [normKey, { rawName, accountNumber, months: monthMap, vendors }] of gl.byAccount) {
      const rawAmt = monthMap.get(monthNum) || 0;
      if (Math.abs(rawAmt) < 0.005) continue;

      let ids = glMappings?.get(normKey);
      if (!ids?.length && accountNumber) ids = glMappings?.get(`__num__${String(accountNumber).trim()}`);

      let mappedIds = null;
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

    // If COA mapping produced no amounts, fall back to direct GL classification.
    const totalMapped = Array.from(leafAmounts.values()).reduce((s, v) => s + Math.abs(v), 0);
    if (totalMapped < 0.01 && gl.byAccount.size > 0) {
      return {
        month: MONTH_NAMES[monthNum - 1], monthNumber: monthNum,
        year: String(year), periodLabel: `${MONTH_NAMES[monthNum - 1]} ${year}`,
        statement: buildGlDirectPlStatement(gl.byAccount, monthNum),
        vendorsByAccount: {},
      };
    }

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

async function generateYearlyBs(versionId, year, allCoa, unmappedSet) {
  const bsAccounts = allCoa.filter(isBsAccount);
  const bsLeaves   = bsAccounts.filter(a => !a.metadata?.is_group);

  // Yearly BS = year-end snapshot (latest as_of_date for this year).
  const { data: dateRows } = await supabase
    .from("balance_sheet_entries")
    .select("as_of_date")
    .eq("version_id", versionId)
    .eq("fiscal_year", year)
    .order("as_of_date", { ascending: false })
    .limit(1);
  const latestDate = dateRows?.[0]?.as_of_date || null;

  // Load entries for the latest snapshot date only.
  const leafAmounts = new Map(bsLeaves.map(a => [a.id, 0]));
  // Load ALL rows (including is_total=true) so Net Income in the equity section of
  // an uploaded BS is not silently dropped. The is_total filter is applied in code below,
  // where we make an exception for the Net Income line.
  let query = supabase
    .from("balance_sheet_entries")
    .select("account_name, account_number, amount, is_total")
    .eq("version_id", versionId);
  query = latestDate ? query.eq("as_of_date", latestDate) : query.eq("fiscal_year", year);

  const { data: entries, error } = await query.limit(200000);
  if (error) throw new Error(`BS entries: ${error.message}`);

  const syntheticLeaves    = [];
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
        // Synthetic leaves for GL carry-forward balances that couldn't match any COA leaf.
        for (const { name, balance } of balances.values()) {
          if (Math.abs(safeNum(balance)) < 0.005 || mappedFromGL.has(norm(name))) continue;
          const acType = classifyUnmappedBSAccount(name);
          if (!acType) continue;
          unmappedSet.delete(norm(name));
          syntheticLeaves.push(makeSyntheticLeaf(name, safeNum(balance), acType));
          if (/^net\s*(income|loss)/i.test(name)) hasUploadedNetIncome = true;
        }
        console.log(`[FinStmt][BS][${year}] GL carry-forward fallback: ${balances.size} balances, ${mapped} mapped to COA leaves`);
        glFallbackUsed = true;
      }
    } catch (err) {
      console.warn(`[FinStmt][BS][${year}] GL carry-forward fallback failed: ${err.message}`);
    }
  }

  if (entries?.length) {
    const entryTotals = new Map();
    for (const e of entries) {
      const isNI = /^net\s*(income|loss)/i.test(String(e.account_name || '').trim());
      // Skip calculated totals (is_total=true) UNLESS it's the Net Income equity line,
      // which QB exports mark as a total but which represents a real closing balance.
      if (e.is_total && !isNI) continue;
      // Skip P&L subtotals ("Net Operating Income", "Total Revenue", etc.)
      // but allow the "Net Income" equity account through.
      if (!isNI && isSummaryRow(e.account_name)) continue;
      const key = norm(e.account_name);
      if (!key) continue;
      if (!entryTotals.has(key)) entryTotals.set(key, { amount: 0, rawName: e.account_name, accountNumber: e.account_number });
      entryTotals.get(key).amount += safeNum(e.amount);
      if (isNI) hasUploadedNetIncome = true;
    }

    const bsMappings  = await loadMappings(versionId, "balance_sheet_entries");
    const fuzzyLookup = buildFuzzyLookup(bsLeaves);
    const mappedKeys  = new Set();

    for (const [normKey, { amount, rawName, accountNumber }] of entryTotals) {
      let ids = bsMappings?.get(normKey);
      if (!ids?.length && accountNumber) ids = bsMappings?.get(`__num__${String(accountNumber).trim()}`);
      if (ids?.length) {
        for (const id of ids) {
          if (leafAmounts.has(id)) leafAmounts.set(id, (leafAmounts.get(id) || 0) + amount / ids.length);
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

    // Accounts that couldn't match any COA leaf are classified by keyword and added
    // as synthetic leaves. This keeps "Loans to MTP", "Net Income", etc. on the correct
    // side of the Balance Sheet even before they are added to the COA.
    for (const [normKey, { amount, rawName }] of entryTotals) {
      if (mappedKeys.has(normKey)) continue;
      if (Math.abs(safeNum(amount)) < 0.005) continue;
      const acType = classifyUnmappedBSAccount(rawName);
      if (!acType) continue;
      unmappedSet.delete(normKey);
      syntheticLeaves.push(makeSyntheticLeaf(rawName, safeNum(amount), acType));
    }
  }

  const { byId, roots, leaves } = buildTree(bsAccounts);
  for (const root of roots) rollupNode(root, leafAmounts);

  const stmt = buildBsStatement([...leaves, ...syntheticLeaves], byId);
  if (syntheticLeaves.length) {
    console.log(`[FinStmt][BS][${year}] ${syntheticLeaves.length} synthetic leaf(ves) added for unmapped entries: ${syntheticLeaves.map(l => l.account_name).join(', ')}`);
  }
  console.log(`[FinStmt][BS][${year}] asOf=${latestDate} assets=${stmt.totalAssets} liab=${stmt.totalLiabilities} equity=${stmt.totalEquity} balanced=${stmt.balanced}`);

  // Persist GL-generated BS so subsequent calls skip GL re-processing.
  // Only store if not already persisted (is_generated rows exist = skip).
  if (glFallbackUsed) {
    const alreadyGenerated = await hasGeneratedRows("balance_sheet_entries", versionId, year);
    if (!alreadyGenerated) {
      const companyId = await getVersionCompanyId(versionId);
      if (companyId) await persistGeneratedBs(versionId, companyId, year, stmt);
    }
  }

  return { year: String(year), asOfDate: latestDate || `${year}-12-31`, periodLabel: `FY ${year}`, statement: stmt, hasUploadedNetIncome };
}

// ─── Monthly BS ───────────────────────────────────────────────────────────────

// Derive month-by-month BS snapshots from GL carry-forward when uploaded BS files
// do not have multiple distinct as_of_date values (the common yearly-upload case).
// BS(month M) = BS(prior year-end) + cumulative GL transactions(Jan..M) for BS-type accounts.
async function generateMonthlyBsFromGL(versionId, year, allCoa, bsLeaves, unmappedSet) {
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

    // Add this month's BS account movements to cumulative totals
    for (const [name, { net }] of bsMap) {
      if (Math.abs(net) < 0.005) continue;
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

async function generateMonthlyBs(versionId, year, allCoa, unmappedSet) {
  const bsAccounts = allCoa.filter(isBsAccount);
  const bsLeaves   = bsAccounts.filter(a => !a.metadata?.is_group);

  const { data: allEntries, error } = await supabase
    .from("balance_sheet_entries")
    .select("account_name, account_number, amount, as_of_date")
    .eq("version_id", versionId)
    .eq("fiscal_year", year)
    .or("is_total.eq.false,is_total.is.null")
    .order("as_of_date", { ascending: true })
    .limit(200000);
  if (error) throw error;

  const byDate = new Map();
  for (const e of (allEntries || [])) {
    if (isSummaryRow(e.account_name)) continue;
    const key = e.as_of_date || `${year}-12-31`;
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(e);
  }
  // Only one (or zero) distinct dates → fall back to GL carry-forward monthly snapshots.
  if (byDate.size <= 1) return generateMonthlyBsFromGL(versionId, year, allCoa, bsLeaves, unmappedSet);

  const bsMappings  = await loadMappings(versionId, "balance_sheet_entries");
  const fuzzyLookup = buildFuzzyLookup(bsLeaves);
  const result      = [];

  for (const [dateKey, dateEntries] of Array.from(byDate).sort(([a], [b]) => a.localeCompare(b))) {
    const leafAmounts = new Map(bsLeaves.map(a => [a.id, 0]));
    const entryTotals = new Map();
    for (const e of dateEntries) {
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
          if (leafAmounts.has(id)) leafAmounts.set(id, (leafAmounts.get(id) || 0) + amount / ids.length);
        }
      } else {
        const match = fuzzyMatch(fuzzyLookup, rawName, accountNumber);
        if (match?.id && leafAmounts.has(match.id)) {
          leafAmounts.set(match.id, (leafAmounts.get(match.id) || 0) + amount);
        } else {
          unmappedSet.add(normKey);
        }
      }
    }

    const { byId, roots, leaves } = buildTree(bsAccounts);
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

function convertCfRow(row) {
  return { name: row.name, amount: safeNum(row.amount || 0), isTotal: row.type === "total", children: (row.children || []).map(convertCfRow) };
}

function convertCfTree(rows) {
  const find  = (id) => rows.find(r => r.id === id || r.id?.includes(id));
  const op    = find("operating");
  const inv   = find("investing");
  const fin   = find("financing");
  const net   = rows.find(r => /net.*(cash|change)/i.test(r.name) && r.type === "total");
  const open  = rows.find(r => /opening|beginning/i.test(r.name));
  const close = rows.find(r => /ending/i.test(r.name));
  return {
    operatingActivities:  { label: "Operating Activities",  items: (op?.children  || []).map(convertCfRow), total: safeNum(op?.amount  || 0) },
    investingActivities:  { label: "Investing Activities",  items: (inv?.children || []).map(convertCfRow), total: safeNum(inv?.amount || 0) },
    financingActivities:  { label: "Financing Activities",  items: (fin?.children || []).map(convertCfRow), total: safeNum(fin?.amount || 0) },
    netCashIncrease: safeNum(net?.amount  || 0),
    openingCash:     safeNum(open?.amount || 0),
    endingCash:      safeNum(close?.amount || 0),
  };
}

async function generateYearlyCf(versionId, year) {
  try {
    const cf = await getCashflowReport(versionId, { year });
    return { year: String(year), periodLabel: `FY ${year}`, statement: convertCfTree(cf.rows || cf.hierarchicalRows || []) };
  } catch (err) {
    console.warn(`[FinStmt][CF][${year}] ${err.message}`);
    return { year: String(year), periodLabel: `FY ${year}`, statement: { operatingActivities: { label: "Operating Activities", items: [], total: 0 }, investingActivities: { label: "Investing Activities", items: [], total: 0 }, financingActivities: { label: "Financing Activities", items: [], total: 0 }, netCashIncrease: 0, openingCash: 0, endingCash: 0 } };
  }
}

async function generateMonthlyCf(versionId, year) {
  try {
    const glByMonth = await aggregateGLForBSByMonth(versionId, year);
    if (!glByMonth) return [];

    const CASH_KW          = /cash|checking|savings|petty/i;
    const WC_ASSET_KW      = /receivable|inventory|prepaid|deposit|due from/i;
    const WC_LIAB_KW       = /payable|accrued|credit card|unearned|deferred revenue/i;
    const INVEST_KW        = /equipment|property|building|land|vehicle|furniture|ppe|intangible|invest/i;
    const FINANCE_LIAB_KW  = /loan|mortgage|bond|note payable|line of credit|long.term/i;

    const months = Array.from(glByMonth.keys()).sort((a, b) => a - b);
    let runningCash = 0;

    return months.map((monthNum) => {
      const mData = glByMonth.get(monthNum);
      const operatingBase = safeNum(mData.netIncome);
      let wcAdj = 0, investingTotal = 0, financingTotal = 0;
      const opAdjItems = [], invItems = [], finItems = [];

      for (const [name, { net, type }] of mData.bsMap) {
        const amt = safeNum(net);
        if (!amt || CASH_KW.test(name)) continue;

        if (type === "asset" && WC_ASSET_KW.test(name)) {
          wcAdj -= amt;
          opAdjItems.push({ name, amount: round2(-amt) });
        } else if (type === "liability" && WC_LIAB_KW.test(name)) {
          wcAdj += amt;
          opAdjItems.push({ name, amount: round2(amt) });
        } else if (type === "asset" && INVEST_KW.test(name)) {
          investingTotal -= amt;
          invItems.push({ name, amount: round2(-amt) });
        } else if (type === "liability" && FINANCE_LIAB_KW.test(name)) {
          financingTotal += amt;
          finItems.push({ name, amount: round2(amt) });
        } else if (type === "equity") {
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

async function generateFinancialStatements(versionId, options = {}) {
  if (!versionId) throw new Error("versionId is required");

  const [allCoa, years] = await Promise.all([
    loadCoa(versionId),
    distinctYears(versionId),
  ]);

  const filteredYears = options.year
    ? years.filter(y => y === Number(options.year))
    : years;

  const missingData = [];
  if (!allCoa.filter(a => !a.metadata?.is_group).length) {
    missingData.push("Chart of Accounts has no leaf accounts. Generate the COA first (Step 6 in Key Reports).");
  }
  if (!filteredYears.length) {
    missingData.push("No financial data found. Sync your financial documents first.");
  }
  if (missingData.length) {
    return {
      companyName: options.companyName || "", currency: options.currency || "USD",
      reports: { profitAndLoss: { monthly: [], yearly: [] }, balanceSheet: { monthly: [], yearly: [] }, cashFlow: { monthly: [], yearly: [] } },
      validation: missingData, unmappedAccounts: [], missingData,
    };
  }

  const unmappedSet = new Set();

  // P&L and Cash Flow are year-independent — run concurrently for speed.
  const [plYearly, plMonthly, cfYearly, cfMonthly] = await Promise.all([
    Promise.all(filteredYears.map(y => generateYearlyPl(versionId, y, allCoa, unmappedSet))),
    Promise.all(filteredYears.map(y => generateMonthlyPl(versionId, y, allCoa, unmappedSet))),
    Promise.all(filteredYears.map(y => generateYearlyCf(versionId, y))),
    Promise.all(filteredYears.map(y => generateMonthlyCf(versionId, y))),
  ]);

  // Balance Sheet has a carry-forward chain: BS(year) = BS(year-1 close) + GL(year).
  // Each year must be fully persisted before the next year reads it as its prior-year
  // base. Running concurrently causes hasGeneratedRows race conditions and computes
  // the carry-forward independently per year instead of reusing prior-year results.
  const bsYearly = [];
  for (const y of filteredYears) {
    bsYearly.push(await generateYearlyBs(versionId, y, allCoa, unmappedSet));
  }
  const bsMonthly = [];
  for (const y of filteredYears) {
    bsMonthly.push(await generateMonthlyBs(versionId, y, allCoa, unmappedSet));
  }

  // Inject current-year Net Income into Balance Sheet Retained Earnings.
  for (let i = 0; i < filteredYears.length; i++) {
    injectNetIncomeToBS(bsYearly[i], plYearly[i]);
  }

  const validation       = validateAll(plYearly, bsYearly);
  const unmappedAccounts = Array.from(unmappedSet).sort();

  console.log(
    `[FinStmt] v=${versionId} years=[${filteredYears.join(",")}]`,
    `| pl=${plYearly.length} bs=${bsYearly.length} cf=${cfYearly.length}`,
    `| monthly pl=${plMonthly.flat().length} cf=${cfMonthly.flat().length}`,
    `| unmapped=${unmappedAccounts.length} warnings=${validation.length}`,
  );
  if (unmappedAccounts.length)
    console.warn("[FinStmt] Unmapped:", unmappedAccounts.slice(0, 10));

  return {
    companyName: options.companyName || "",
    currency:    options.currency    || "USD",
    reports: {
      profitAndLoss: { monthly: plMonthly.flat(), yearly: plYearly },
      balanceSheet:  { monthly: bsMonthly.flat(), yearly: bsYearly },
      cashFlow:      { monthly: cfMonthly.flat(), yearly: cfYearly },
    },
    validation,
    unmappedAccounts,
    missingData: [],
  };
}

module.exports = { generateFinancialStatements };
