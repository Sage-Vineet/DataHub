// ============================================================================
// Chart of Accounts engine (Key Reports redesign — COA is the source of truth)
//
// Builds a per-version Chart of Accounts (COA) from a synced Key Report
// version's extracted P&L / Balance Sheet / General Ledger accounts, classifies
// each account into a deep hierarchy (up to 15 levels), and persists it with a
// never-overwritten ORIGINAL (AI) classification beside a user-editable ADJUSTED
// one, plus mapping + audit-history tables.
//
// Classification is HYBRID:
//   1. coaHierarchyRules        — deterministic standardized levels 1–4.
//   2. geminiCoaClassifier      — optional AI refinement for deeper, company-
//                                 specific levels (5–15) + normalized names.
//   The Gemini step is non-fatal; on any failure the rule-only path stands.
//
// Persistence uses an UPSERT-by-stable-key merge (NOT delete-then-insert) so
// that account ids — and therefore the adjustment/classification audit history
// that FKs to them — survive regeneration, and user adjustments are preserved.
// ============================================================================

const { supabase } = require("../db");
const {
  normalizeAccountType,
  inferAccountType,
} = require("./manualGlMultiYearService");
const { classifyStandardized, buildLevelsFromPath, MAX_LEVELS } = require("./keyReports/coaHierarchyRules");
const { refineAccounts } = require("./keyReports/geminiCoaClassifier");

const TABLE_COA = "chart_of_accounts";
const TABLE_TXN = "general_ledger_entries";
const TABLE_BS = "balance_sheet_entries";
const TABLE_MAPPINGS = "coa_account_mappings";
const TABLE_ADJUSTMENTS = "coa_account_adjustments";
const TABLE_HISTORY = "coa_classification_history";
const TABLE_LEVELS = "coa_hierarchy_levels";
const PAGE_SIZE = 1000;

// Group (parent) node definitions, keyed by normalized account type. Retained
// for the legacy 2-level summary + statement-type slicing.
const GROUP_DEFS = Object.freeze({
  asset: { label: "Assets", statementType: "balance_sheet", sortOrder: 1 },
  liability: { label: "Liabilities", statementType: "balance_sheet", sortOrder: 2 },
  equity: { label: "Equity", statementType: "balance_sheet", sortOrder: 3 },
  income: { label: "Revenue", statementType: "profit_loss", sortOrder: 4 },
  cogs: { label: "Cost of Goods Sold", statementType: "profit_loss", sortOrder: 5 },
  expense: { label: "Expenses", statementType: "profit_loss", sortOrder: 6 },
});

const BALANCE_SHEET_TYPES = new Set(["asset", "liability", "equity"]);

function statementTypeFor(accountType) {
  return BALANCE_SHEET_TYPES.has(accountType) ? "balance_sheet" : "profit_loss";
}

function accountTypeFromBsSection(section) {
  const s = String(section || "").toLowerCase();
  if (s.includes("asset")) return "asset";
  if (s.includes("liabilit")) return "liability";
  if (s.includes("equity")) return "equity";
  return "";
}

function normName(accountName) {
  return String(accountName || "").trim().toLowerCase();
}

// Stable per-account key: number (if any) + normalized name. Used to merge the
// same account across regenerations and across BS/P&L/GL sources.
function accountKey(number, name) {
  return `${String(number || "").trim().toLowerCase()}::${normName(name)}`;
}

// ── Invalid-row guards (unchanged) ──────────────────────────────────────────
const NON_ACCOUNT_RE =
  /^(accrual basis|cash basis|report generated|date generated|generated on|as of\b|unrealized gains?)/i;

const SECTION_LABEL_SET = new Set([
  "assets", "liabilities", "equity", "income", "revenue", "expense", "expenses",
  "current assets", "fixed assets", "other assets", "other current assets",
  "current liabilities", "long-term liabilities", "long term liabilities",
  "other current liabilities", "other liabilities", "cost of goods sold",
  "liabilities and equity", "liabilities & equity", "total liabilities and equity",
]);

const TOTAL_NAME_RE = /(^total\b|\btotal$|\bnet income\b|\bnet loss\b|\bgross profit\b)/i;

function isTotalName(name) {
  return TOTAL_NAME_RE.test(String(name || "").trim());
}

function isSectionLabel(name) {
  const n = String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
  return SECTION_LABEL_SET.has(n);
}

function isNonAccountRow(name) {
  const n = String(name || "").trim();
  if (!n) return true;
  if (NON_ACCOUNT_RE.test(n)) return true;
  if (isTotalName(n)) return true;
  if (isSectionLabel(n)) return true;
  return false;
}

// ── Source collectors (unchanged) ───────────────────────────────────────────
async function fetchAllRows(buildQuery) {
  const out = [];
  let from = 0;
  for (let page = 0; page < 1000; page += 1) {
    const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

async function collectGlAccounts(companyId, batchId) {
  const select = "account_number, account_name, account_type, fiscal_year";
  let rows;
  try {
    rows = await fetchAllRows(() =>
      supabase.from(TABLE_TXN).select(select)
        .eq("company_id", companyId).eq("upload_batch_id", batchId).order("id", { ascending: true }),
    );
  } catch (err) {
    const msg = String(err?.message || "").toLowerCase();
    if (!msg.includes("upload_batch_id")) throw err;
    rows = await fetchAllRows(() =>
      supabase.from(TABLE_TXN).select(select)
        .eq("company_id", companyId).eq("batch_id", batchId).order("id", { ascending: true }),
    );
  }
  return rows;
}

async function collectBsAccounts(companyId, batchId) {
  return fetchAllRows(() =>
    supabase.from(TABLE_BS).select("account_name, section")
      .eq("company_id", companyId).eq("batch_id", batchId).order("id", { ascending: true }),
  );
}

async function collectGlAccountsFromEntries(companyId, versionId) {
  return fetchAllRows(() =>
    supabase.from("general_ledger_entries")
      .select("distribution_account, account_section, account_number, fiscal_year")
      .eq("company_id", companyId).eq("version_id", versionId)
      .eq("row_type", "TRANSACTION").order("id", { ascending: true }),
  );
}

async function collectBsAccountsFromEntries(companyId, versionId) {
  return fetchAllRows(() =>
    supabase.from("balance_sheet_entries")
      .select("account_name, account_number, section, is_total, hierarchy_level, fiscal_year")
      .eq("company_id", companyId).eq("version_id", versionId)
      .eq("is_total", false).order("id", { ascending: true }),
  );
}

async function collectPlAccountsFromEntries(companyId, versionId) {
  return fetchAllRows(() =>
    supabase.from("profit_loss_entries")
      .select("account_name, account_number, account_type, is_total, hierarchy_level, fiscal_year")
      .eq("company_id", companyId).eq("version_id", versionId)
      .eq("is_total", false).order("id", { ascending: true }),
  );
}

/**
 * Build the in-memory COA leaf model from raw account rows.
 * Source precedence (spec): Balance Sheet → Profit & Loss → General Ledger.
 * Pure function. (Unchanged from the prior 2-level engine — still the dedup +
 * classification core; the hierarchy layer is built on top of its leaves.)
 */
function buildCoaModel(glRows, bsRows, plRows) {
  const leavesByName = new Map();
  const usedGroups = new Set();

  const mergeInto = (leaf, source, fiscalYear, number) => {
    leaf.sources.add(source);
    if (fiscalYear) leaf.fiscalYears.add(Number(fiscalYear));
    if (!leaf.accountNumber && number) leaf.accountNumber = number;
  };

  const addLeaf = (accountName, accountNumber, explicitType, source, fiscalYear, classificationSource) => {
    const name = String(accountName || "").trim();
    if (!name) return;
    if (isNonAccountRow(name)) return;
    const number = accountNumber ? String(accountNumber).trim() : null;
    const normalized = normalizeAccountType(explicitType);
    const type = normalized || inferAccountType(name, number || "");
    const resolvedSource = normalized ? classificationSource : "keyword";
    const key = normName(name);
    const bucket = leavesByName.get(key) || [];

    const target = bucket.find((l) => {
      if (number && l.accountNumber) return l.accountNumber === number;
      return true;
    });
    if (target) {
      mergeInto(target, source, fiscalYear, number);
      return;
    }

    usedGroups.add(type);
    const leaf = {
      accountName: name,
      accountNumber: number,
      accountType: type,
      statementType: statementTypeFor(type),
      classificationSource: resolvedSource,
      sources: new Set([source]),
      fiscalYears: new Set(fiscalYear ? [Number(fiscalYear)] : []),
    };
    bucket.push(leaf);
    leavesByName.set(key, bucket);
  };

  for (const r of bsRows || []) {
    const type = accountTypeFromBsSection(r.section);
    addLeaf(r.account_name, r.account_number || null, type, "balance_sheet", r.fiscal_year, "balance_sheet_section");
  }
  for (const r of plRows || []) {
    addLeaf(r.account_name, r.account_number || null, r.account_type || null, "profit_loss", r.fiscal_year, "profit_loss_type");
  }
  for (const r of glRows || []) {
    const name = r.distribution_account || r.account_name || "";
    addLeaf(name, r.account_number || null, r.account_type || null, "general_ledger", r.fiscal_year, "gl_type");
  }

  const groups = Object.entries(GROUP_DEFS)
    .filter(([type]) => usedGroups.has(type))
    .map(([type, def]) => ({ type, ...def }));

  const leaves = Array.from(leavesByName.values()).flat();
  return { groups, leaves };
}

// ── Hierarchy assembly (rules + optional Gemini) ─────────────────────────────

/**
 * Enrich each leaf with its full 15-level hierarchy. Runs the deterministic
 * rule classifier first, then a single (batched) Gemini refinement pass over
 * the deduped account set. Always resolves — Gemini failure ⇒ rule-only paths.
 *
 * @returns {Promise<Array>} leaves augmented with:
 *   { levels:string[15], hierarchyPath, baseAccount, displayName, classificationMethod }
 */
async function buildLeafHierarchies(leaves) {
  // 1) Deterministic standardized levels 1–4.
  const enriched = leaves.map((leaf) => {
    const { levels, standardizedDepth } = classifyStandardized({
      accountName: leaf.accountName,
      accountNumber: leaf.accountNumber,
      accountType: leaf.accountType,
      statementType: leaf.statementType,
    });
    return { leaf, stdLevels: levels, standardizedDepth };
  });

  // 2) Optional AI refinement (deeper levels + normalized names).
  const refineInput = enriched.map(({ leaf, stdLevels }) => ({
    key: accountKey(leaf.accountNumber, leaf.accountName),
    accountName: leaf.accountName,
    accountNumber: leaf.accountNumber,
    level1: stdLevels[0], level2: stdLevels[1], level3: stdLevels[2], level4: stdLevels[3],
  }));

  let refinements = new Map();
  try {
    refinements = await refineAccounts(refineInput);
  } catch (err) {
    console.warn(`[ChartOfAccounts] Gemini refinement skipped: ${err.message}`);
    refinements = new Map();
  }

  // 3) Assemble final paths.
  return enriched.map(({ leaf, stdLevels, standardizedDepth }) => {
    const key = accountKey(leaf.accountNumber, leaf.accountName);
    const refinement = refinements.get(key);
    const deeperLevels = refinement?.deeperLevels || [];
    const displayName = refinement?.normalizedName || leaf.accountName;
    const classificationMethod = refinement ? "hybrid" : "rule";

    const { levels, hierarchyPath } = buildLevelsFromPath(
      stdLevels, standardizedDepth, deeperLevels, displayName,
    );

    return {
      ...leaf,
      levels,
      hierarchyPath,
      baseAccount: leaf.accountName,
      displayName,
      classificationMethod,
    };
  });
}

// ── Persistence helpers ──────────────────────────────────────────────────────

function levelsToColumns(levels) {
  const out = {};
  for (let i = 0; i < MAX_LEVELS; i += 1) out[`level_${i + 1}`] = levels[i] || null;
  return out;
}

function columnsToLevels(row) {
  const levels = [];
  for (let i = 0; i < MAX_LEVELS; i += 1) levels.push(row[`level_${i + 1}`] || null);
  return levels;
}

function hierarchySnapshot(levels, accountType, statementType, baseAccount) {
  return { levels, account_type: accountType, statement_type: statementType, base_account: baseAccount };
}

/**
 * Regenerate and persist the Chart of Accounts for a Key Report version.
 * Preserves account ids (and their audit history) + user adjustments via an
 * upsert-by-stable-key merge.
 *
 * @param {string} companyId
 * @param {string} versionId
 * @param {string} batchId   legacy path; pass null to read entry tables
 */
async function generateChartOfAccounts(companyId, versionId, batchId) {
  if (!companyId || !versionId) {
    return { accountCount: 0, leafCount: 0, skipped: true };
  }

  // 1) Collect source accounts.
  let glRows, bsRows, plRows;
  if (batchId) {
    [glRows, bsRows] = await Promise.all([
      collectGlAccounts(companyId, batchId),
      collectBsAccounts(companyId, batchId).catch(() => []),
    ]);
    plRows = [];
  } else {
    [glRows, bsRows, plRows] = await Promise.all([
      collectGlAccountsFromEntries(companyId, versionId),
      collectBsAccountsFromEntries(companyId, versionId).catch(() => []),
      collectPlAccountsFromEntries(companyId, versionId).catch(() => []),
    ]);
  }

  const { leaves } = buildCoaModel(glRows, bsRows, plRows);
  if (!leaves.length) {
    // Nothing to build — clear derived rows so stale accounts don't linger.
    await supabase.from(TABLE_COA).delete().eq("version_id", versionId);
    return { accountCount: 0, leafCount: 0 };
  }

  const hierarchical = await buildLeafHierarchies(leaves);

  // 2) Load existing rows so we can preserve ids, originals, and adjustments.
  const { data: existingData, error: exErr } = await supabase
    .from(TABLE_COA)
    .select("id, account_number, account_name, original_name, original_hierarchy, adjusted_name, adjusted_hierarchy, metadata, classification_method, account_type, statement_type, level_1, level_2, level_3, level_4, level_5, level_6, level_7, level_8, level_9, level_10, level_11, level_12, level_13, level_14, level_15, base_account")
    .eq("version_id", versionId);
  if (exErr) throw exErr;
  const existingByKey = new Map();
  for (const row of existingData || []) {
    existingByKey.set(accountKey(row.account_number, row.account_name), row);
  }

  const seenKeys = new Set();
  const toInsert = [];
  const updates = []; // { id, patch }
  let sortCounter = 0;

  for (const leaf of hierarchical
    .slice()
    .sort((a, b) => a.accountName.localeCompare(b.accountName))) {
    const key = accountKey(leaf.accountNumber, leaf.accountName);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const aiLevels = leaf.levels;
    const aiSnapshot = hierarchySnapshot(aiLevels, leaf.accountType, leaf.statementType, leaf.baseAccount);
    const accountIdName = leaf.accountNumber ? `${leaf.accountNumber} — ${leaf.accountName}` : leaf.accountName;
    const baseMeta = {
      is_group: false,
      sources: Array.from(leaf.sources),
      fiscal_years: Array.from(leaf.fiscalYears).sort((a, b) => a - b),
      classification_source: leaf.classificationSource || null,
    };
    sortCounter += 1;
    const existing = existingByKey.get(key);

    if (!existing) {
      // Brand-new account: original = adjusted = AI result.
      toInsert.push({
        version_id: versionId,
        company_id: companyId,
        account_number: leaf.accountNumber,
        account_name: leaf.accountName,
        account_id_name: accountIdName,
        parent_account_id: null,
        account_type: leaf.accountType,
        statement_type: leaf.statementType,
        is_active: true,
        sort_order: sortCounter,
        ...levelsToColumns(aiLevels),
        base_account: leaf.baseAccount,
        hierarchy_path: leaf.hierarchyPath,
        classification_method: leaf.classificationMethod,
        original_name: leaf.displayName,
        original_hierarchy: aiSnapshot,
        adjusted_name: leaf.displayName,
        adjusted_hierarchy: aiSnapshot,
        metadata: { ...baseMeta, user_modified: false },
      });
      continue;
    }

    // Existing account. NEVER overwrite original_*. Preserve adjustments.
    const userModified = Boolean(existing.metadata?.user_modified);
    const patch = {
      account_id_name: accountIdName,
      account_type: userModified ? existing.account_type : leaf.accountType,
      statement_type: userModified ? existing.statement_type : leaf.statementType,
      sort_order: sortCounter,
      // original stays as first-seen; only backfill if it was never set.
      original_name: existing.original_name || leaf.displayName,
      original_hierarchy: existing.original_hierarchy || aiSnapshot,
      metadata: { ...(existing.metadata || {}), ...baseMeta, user_modified: userModified },
      updated_at: new Date().toISOString(),
    };
    if (userModified) {
      // Keep the user's adjusted hierarchy + display name + level columns.
      // (No level/adjusted changes here.)
    } else {
      // Refresh the adjusted view + level columns with the latest AI result.
      Object.assign(patch, levelsToColumns(aiLevels), {
        base_account: leaf.baseAccount,
        hierarchy_path: leaf.hierarchyPath,
        classification_method: leaf.classificationMethod,
        adjusted_name: leaf.displayName,
        adjusted_hierarchy: aiSnapshot,
      });
    }
    updates.push({ id: existing.id, patch });
  }

  // 3) Apply updates.
  for (const { id, patch } of updates) {
    const { error } = await supabase.from(TABLE_COA).update(patch).eq("id", id);
    if (error) throw error;
  }

  // 4) Insert new rows (batched) and capture their ids.
  const insertedByKey = new Map();
  if (toInsert.length) {
    const ins = await supabase.from(TABLE_COA).insert(toInsert).select("id, account_number, account_name");
    if (ins.error) throw ins.error;
    for (const row of ins.data || []) {
      insertedByKey.set(accountKey(row.account_number, row.account_name), row.id);
    }
  }

  // 5) Delete rows whose source account disappeared (CASCADE clears their audit).
  const staleIds = (existingData || [])
    .filter((row) => !seenKeys.has(accountKey(row.account_number, row.account_name)))
    .map((row) => row.id);
  if (staleIds.length) {
    const del = await supabase.from(TABLE_COA).delete().in("id", staleIds);
    if (del.error) throw del.error;
  }

  // 6) Resolve account ids for every leaf (existing + inserted).
  const accountIdByKey = new Map();
  for (const row of existingData || []) accountIdByKey.set(accountKey(row.account_number, row.account_name), row.id);
  for (const [k, id] of insertedByKey.entries()) accountIdByKey.set(k, id);

  // 7) Rebuild source→account mappings (pure derivative; safe to replace).
  await supabase.from(TABLE_MAPPINGS).delete().eq("version_id", versionId);
  const SOURCE_TABLE = {
    general_ledger: "general_ledger_entries",
    balance_sheet: "balance_sheet_entries",
    profit_loss: "profit_loss_entries",
  };
  const mappingRows = [];
  for (const leaf of hierarchical) {
    const key = accountKey(leaf.accountNumber, leaf.accountName);
    const accountId = accountIdByKey.get(key);
    if (!accountId) continue;
    for (const src of leaf.sources) {
      mappingRows.push({
        version_id: versionId,
        company_id: companyId,
        account_id: accountId,
        source_table: SOURCE_TABLE[src] || src,
        source_account_name: leaf.accountName,
        source_account_number: leaf.accountNumber,
        normalized_name: normName(leaf.accountName),
      });
    }
  }
  if (mappingRows.length) {
    const insMap = await supabase.from(TABLE_MAPPINGS).insert(mappingRows);
    if (insMap.error) throw insMap.error;
  }

  // 8) Record an initial classification-history snapshot for new accounts.
  const historyRows = [];
  for (const leaf of hierarchical) {
    const key = accountKey(leaf.accountNumber, leaf.accountName);
    const id = insertedByKey.get(key);
    if (!id) continue; // only newly classified accounts
    historyRows.push({
      account_id: id,
      version_id: versionId,
      company_id: companyId,
      classification_method: leaf.classificationMethod,
      hierarchy_snapshot: hierarchySnapshot(leaf.levels, leaf.accountType, leaf.statementType, leaf.baseAccount),
      source: "generate",
    });
  }
  if (historyRows.length) {
    await supabase.from(TABLE_HISTORY).insert(historyRows).then(({ error }) => {
      if (error) console.warn(`[ChartOfAccounts] history insert skipped: ${error.message}`);
    });
  }

  return {
    accountCount: (updates.length + toInsert.length),
    leafCount: hierarchical.length,
    inserted: toInsert.length,
    updated: updates.length,
    deleted: staleIds.length,
  };
}

// ── Read model (deep tree + flat) ────────────────────────────────────────────

function mapRow(row) {
  const levels = columnsToLevels(row);
  const modified = Boolean(row.metadata?.user_modified)
    || (row.adjusted_name && row.original_name && row.adjusted_name !== row.original_name);
  return {
    id: row.id,
    versionId: row.version_id,
    accountNumber: row.account_number,
    accountName: row.adjusted_name || row.account_name, // display = adjusted
    sourceName: row.account_name,
    originalName: row.original_name,
    adjustedName: row.adjusted_name,
    accountIdName: row.account_id_name,
    accountType: row.account_type,
    statementType: row.statement_type,
    parentAccountId: row.parent_account_id,
    isActive: row.is_active,
    sortOrder: row.sort_order,
    levels,
    baseAccount: row.base_account,
    hierarchyPath: row.hierarchy_path,
    classificationMethod: row.classification_method,
    modified: Boolean(modified),
    isGroup: Boolean(row.metadata?.is_group),
    metadata: row.metadata || {},
  };
}

// Stable ordering for the standardized top levels; everything else alpha.
const LEVEL_ORDER = new Map([
  ["Income Statement", 1], ["Balance Sheet", 2],
  ["Assets", 1], ["Liabilities", 2], ["Equity", 3],
  ["Revenue", 4], ["Cost of Goods Sold", 5], ["Operating Expenses", 6],
]);

function buildTree(flatRows) {
  const root = { children: [], childIndex: new Map() };

  for (const acct of flatRows) {
    const path = acct.levels.filter(Boolean); // last element = base account (leaf)
    if (!path.length) {
      root.children.push({ ...leafNode(acct) });
      continue;
    }
    let node = root;
    // Walk category levels (all but the last path element).
    for (let i = 0; i < path.length - 1; i += 1) {
      const label = path[i];
      let child = node.childIndex.get(label);
      if (!child) {
        child = {
          id: `cat:${(node.id || "root")}/${label}`,
          name: label,
          isGroup: true,
          level: i + 1,
          statementType: acct.statementType,
          children: [],
          childIndex: new Map(),
        };
        node.childIndex.set(label, child);
        node.children.push(child);
      }
      node = child;
    }
    node.children.push(leafNode(acct, path.length));
  }

  // Sort recursively and strip the helper index.
  const finalize = (n) => {
    if (n.children) {
      n.children.sort((a, b) => {
        if (a.isGroup !== b.isGroup) return a.isGroup ? -1 : 1; // categories first
        const ao = LEVEL_ORDER.get(a.name) || 999;
        const bo = LEVEL_ORDER.get(b.name) || 999;
        if (ao !== bo) return ao - bo;
        return String(a.name).localeCompare(String(b.name));
      });
      n.children.forEach(finalize);
    }
    delete n.childIndex;
    return n;
  };
  root.children.forEach(finalize);
  return root.children;
}

function leafNode(acct, level) {
  return {
    id: acct.id,
    accountId: acct.id,
    name: acct.accountName,
    isGroup: false,
    level: level || (acct.levels.filter(Boolean).length || 1),
    accountNumber: acct.accountNumber,
    accountType: acct.accountType,
    statementType: acct.statementType,
    hierarchyPath: acct.hierarchyPath,
    classificationMethod: acct.classificationMethod,
    isActive: acct.isActive,
    modified: acct.modified,
    levels: acct.levels,
    originalName: acct.originalName,
    adjustedName: acct.adjustedName,
    children: [],
  };
}

async function getChartOfAccounts(versionId) {
  const { data, error } = await supabase
    .from(TABLE_COA).select("*").eq("version_id", versionId)
    .order("sort_order", { ascending: true });
  if (error) throw error;

  const rows = (data || []).map(mapRow);
  const tree = buildTree(rows);
  return { versionId, flat: rows, tree, accountCount: rows.length };
}

// ── Editing (rename / move / reclassify / save / reset) ──────────────────────

async function loadAccount(accountId) {
  const { data, error } = await supabase.from(TABLE_COA).select("*").eq("id", accountId).single();
  if (error) throw error;
  return data;
}

async function recordAdjustment(row, fieldChanged, oldValue, newValue, userId) {
  await supabase.from(TABLE_ADJUSTMENTS).insert({
    account_id: row.id,
    version_id: row.version_id,
    company_id: row.company_id,
    field_changed: fieldChanged,
    old_value: oldValue ?? null,
    new_value: newValue ?? null,
    changed_by: userId || null,
  }).then(({ error }) => { if (error) console.warn(`[ChartOfAccounts] adjustment log skipped: ${error.message}`); });
}

async function recordHistory(row, method, levels, accountType, statementType, baseAccount, source, userId) {
  await supabase.from(TABLE_HISTORY).insert({
    account_id: row.id,
    version_id: row.version_id,
    company_id: row.company_id,
    classification_method: method,
    hierarchy_snapshot: hierarchySnapshot(levels, accountType, statementType, baseAccount),
    source,
    created_by: userId || null,
  }).then(({ error }) => { if (error) console.warn(`[ChartOfAccounts] history log skipped: ${error.message}`); });
}

/**
 * Apply a user edit to a single account. Supports rename (adjustedName),
 * move/change-parent/reclassify (levels + accountType/statementType), and
 * active toggle. NEVER touches original_*. Writes adjustment + history audit.
 */
async function updateAccountHierarchy(accountId, patch = {}, userId = null) {
  const row = await loadAccount(accountId);
  const update = { updated_at: new Date().toISOString(), classification_method: "manual" };
  const meta = { ...(row.metadata || {}), user_modified: true };
  update.metadata = meta;
  let changed = false;

  if (patch.adjustedName !== undefined && patch.adjustedName !== row.adjusted_name) {
    await recordAdjustment(row, "name", row.adjusted_name, patch.adjustedName, userId);
    update.adjusted_name = String(patch.adjustedName || "").trim() || row.account_name;
    changed = true;
  }

  if (patch.accountType !== undefined && patch.accountType !== row.account_type) {
    await recordAdjustment(row, "reclassify", row.account_type, patch.accountType, userId);
    update.account_type = patch.accountType;
    if (patch.statementType === undefined) {
      update.statement_type = statementTypeFor(patch.accountType);
    }
    changed = true;
  }
  if (patch.statementType !== undefined) update.statement_type = patch.statementType;

  if (Array.isArray(patch.levels)) {
    const levels = patch.levels.slice(0, MAX_LEVELS);
    while (levels.length < MAX_LEVELS) levels.push(null);
    const nonNull = levels.filter(Boolean);
    const baseAccount = nonNull.length ? nonNull[nonNull.length - 1] : row.base_account;
    const hierarchyPath = nonNull.join(" > ");
    await recordAdjustment(row, patch.movedParent ? "parent" : "level", columnsToLevels(row), levels, userId);
    Object.assign(update, levelsToColumns(levels), {
      base_account: baseAccount,
      hierarchy_path: hierarchyPath,
      adjusted_hierarchy: hierarchySnapshot(levels, update.account_type || row.account_type, update.statement_type || row.statement_type, baseAccount),
    });
    changed = true;
  }

  if (patch.isActive !== undefined && patch.isActive !== row.is_active) {
    await recordAdjustment(row, "active", row.is_active, patch.isActive, userId);
    update.is_active = patch.isActive;
    changed = true;
  }

  if (!changed) return mapRow(row);

  const { data, error } = await supabase.from(TABLE_COA).update(update).eq("id", accountId).select("*").single();
  if (error) throw error;

  const newLevels = columnsToLevels(data);
  await recordHistory(data, "manual", newLevels, data.account_type, data.statement_type, data.base_account, "adjust", userId);
  return mapRow(data);
}

/** Bulk-persist an edited hierarchy (array of per-account patches). */
async function saveHierarchy(versionId, nodes = [], userId = null) {
  let updated = 0;
  for (const node of nodes) {
    if (!node?.accountId && !node?.id) continue;
    await updateAccountHierarchy(node.accountId || node.id, {
      adjustedName: node.adjustedName,
      levels: node.levels,
      accountType: node.accountType,
      statementType: node.statementType,
      isActive: node.isActive,
      movedParent: node.movedParent,
    }, userId);
    updated += 1;
  }
  return { updated };
}

/** Restore a single account's adjusted classification back to its original AI one. */
async function resetAccount(accountId, userId = null) {
  const row = await loadAccount(accountId);
  const original = row.original_hierarchy || hierarchySnapshot(columnsToLevels(row), row.account_type, row.statement_type, row.base_account);
  const levels = Array.isArray(original.levels) ? original.levels.slice(0, MAX_LEVELS) : columnsToLevels(row);
  while (levels.length < MAX_LEVELS) levels.push(null);
  const nonNull = levels.filter(Boolean);
  const baseAccount = original.base_account || (nonNull.length ? nonNull[nonNull.length - 1] : row.base_account);

  const update = {
    updated_at: new Date().toISOString(),
    adjusted_name: row.original_name || row.account_name,
    adjusted_hierarchy: original,
    account_type: original.account_type || row.account_type,
    statement_type: original.statement_type || row.statement_type,
    base_account: baseAccount,
    hierarchy_path: nonNull.join(" > "),
    classification_method: "rule",
    metadata: { ...(row.metadata || {}), user_modified: false },
    ...levelsToColumns(levels),
  };
  await recordAdjustment(row, "reset", columnsToLevels(row), levels, userId);
  const { data, error } = await supabase.from(TABLE_COA).update(update).eq("id", accountId).select("*").single();
  if (error) throw error;
  await recordHistory(data, "rule", levels, data.account_type, data.statement_type, data.base_account, "reset", userId);
  return mapRow(data);
}

/** Restore every modified account in a version to its original AI classification. */
async function resetVersion(versionId, userId = null) {
  const { data, error } = await supabase
    .from(TABLE_COA).select("id, metadata, adjusted_name, original_name")
    .eq("version_id", versionId);
  if (error) throw error;
  const modified = (data || []).filter(
    (r) => r.metadata?.user_modified || (r.adjusted_name && r.original_name && r.adjusted_name !== r.original_name),
  );
  for (const r of modified) await resetAccount(r.id, userId);
  return { reset: modified.length };
}

/** Audit history (classification + adjustments) for a version. */
async function getHistory(versionId) {
  const [hist, adj] = await Promise.all([
    supabase.from(TABLE_HISTORY).select("*").eq("version_id", versionId).order("created_at", { ascending: false }).limit(500),
    supabase.from(TABLE_ADJUSTMENTS).select("*").eq("version_id", versionId).order("changed_at", { ascending: false }).limit(500),
  ]);
  if (hist.error) throw hist.error;
  if (adj.error) throw adj.error;
  return { classificationHistory: hist.data || [], adjustments: adj.data || [] };
}

/** The standardized taxonomy reference (for UI level filters). */
async function getHierarchyLevels() {
  const { data, error } = await supabase
    .from(TABLE_LEVELS).select("*")
    .order("level_number", { ascending: true })
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return data || [];
}

// Legacy single-field update — retained for backward compatibility.
const EDITABLE_FIELDS = {
  accountName: "adjusted_name",
  accountType: "account_type",
  statementType: "statement_type",
  parentAccountId: "parent_account_id",
  isActive: "is_active",
  sortOrder: "sort_order",
};

async function updateAccount(accountId, patch = {}) {
  const update = { updated_at: new Date().toISOString() };
  for (const [apiKey, column] of Object.entries(EDITABLE_FIELDS)) {
    if (patch[apiKey] !== undefined) update[column] = patch[apiKey];
  }
  const { data, error } = await supabase.from(TABLE_COA).update(update).eq("id", accountId).select("*").single();
  if (error) throw error;
  return mapRow(data);
}

// ── Validation engine (extended with level-integrity checks) ─────────────────
async function validateChartOfAccounts(companyId, versionId) {
  const empty = { nullType: [], invalidRows: [], duplicates: [], unmapped: [], multiCategory: [], noLevel: [], noBase: [] };
  if (!companyId || !versionId) {
    return { summary: { accountCount: 0, leafCount: 0, status: "warning", ...empty }, reports: empty, rows: [] };
  }

  const { data: coaData, error } = await supabase
    .from(TABLE_COA)
    .select("id, account_name, adjusted_name, account_number, account_type, base_account, level_1, level_2, metadata")
    .eq("version_id", versionId);
  if (error) throw error;

  const all = coaData || [];
  const leaves = all.filter((r) => !r.metadata?.is_group);

  let glAccounts = [];
  try {
    const glRows = await collectGlAccountsFromEntries(companyId, versionId);
    glAccounts = glRows.map((r) => String(r.distribution_account || "").trim()).filter(Boolean);
  } catch (_e) {
    glAccounts = [];
  }

  const leafKeys = new Set(leaves.map((r) => normName(r.account_name)));

  const nullType = leaves.filter((r) => !r.account_type).map((r) => r.account_name);
  const invalidRows = leaves.filter((r) => isNonAccountRow(r.account_name)).map((r) => r.account_name);
  const noLevel = leaves.filter((r) => !r.level_1).map((r) => r.account_name);
  const noBase = leaves.filter((r) => !r.base_account).map((r) => r.account_name);

  const counts = new Map();
  for (const r of leaves) {
    const k = normName(r.account_name);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const duplicates = leaves
    .filter((r) => counts.get(normName(r.account_name)) > 1)
    .map((r) => r.account_name)
    .filter((v, i, a) => a.indexOf(v) === i);

  const unmapped = Array.from(
    new Set(glAccounts.filter((n) => !isNonAccountRow(n) && !leafKeys.has(normName(n)))),
  );

  const typesByName = new Map();
  for (const r of leaves) {
    const k = normName(r.account_name);
    if (!typesByName.has(k)) typesByName.set(k, new Set());
    typesByName.get(k).add(r.account_type || "unknown");
  }
  const multiCategory = Array.from(typesByName.entries())
    .filter(([, set]) => set.size > 1)
    .map(([k]) => k);

  const reports = { nullType, invalidRows, duplicates, unmapped, multiCategory, noLevel, noBase };

  const sample = (arr, n = 8) =>
    arr.slice(0, n).join(", ") + (arr.length > n ? ` … (+${arr.length - n} more)` : "");

  const rows = [];
  let worst = "success";

  const errorChecks = [
    [nullType, (a) => `${a.length} account(s) missing a category: ${sample(a)}`],
    [invalidRows, (a) => `${a.length} invalid row(s) (header/total/section) present in the Chart of Accounts: ${sample(a)}`],
    [multiCategory, (a) => `${a.length} account(s) classified into more than one category: ${sample(a)}`],
    [noLevel, (a) => `${a.length} account(s) missing a hierarchy (no Level 1): ${sample(a)}`],
  ];
  for (const [arr, msg] of errorChecks) {
    if (arr.length) {
      worst = "error";
      rows.push({ dataType: "chart_of_accounts", year: null, status: "error", severity: "error", message: msg(arr), metadata: { sample: arr.slice(0, 25), count: arr.length } });
    }
  }

  const warnChecks = [
    [duplicates, (a) => `${a.length} duplicate account name(s): ${sample(a)}`],
    [unmapped, (a) => `${a.length} General Ledger account(s) not represented in the Chart of Accounts: ${sample(a)}`],
    [noBase, (a) => `${a.length} account(s) missing a base account: ${sample(a)}`],
  ];
  for (const [arr, msg] of warnChecks) {
    if (arr.length) {
      if (worst !== "error") worst = "warning";
      rows.push({ dataType: "chart_of_accounts", year: null, status: "warning", severity: "warning", message: msg(arr), metadata: { sample: arr.slice(0, 25), count: arr.length } });
    }
  }

  const status = leaves.length ? worst : "warning";
  rows.unshift({
    dataType: "chart_of_accounts",
    year: null,
    status,
    severity: status,
    message: leaves.length
      ? status === "success"
        ? `Chart of Accounts generated successfully (${leaves.length} accounts, all classified into a hierarchy).`
        : `Chart of Accounts generated with issues (${leaves.length} accounts).`
      : "Chart of Accounts not generated.",
    metadata: { accountCount: all.length, leafCount: leaves.length, reports },
  });

  return { summary: { accountCount: all.length, leafCount: leaves.length, status, ...reports }, reports, rows };
}

module.exports = {
  generateChartOfAccounts,
  getChartOfAccounts,
  updateAccount,
  updateAccountHierarchy,
  saveHierarchy,
  resetAccount,
  resetVersion,
  getHistory,
  getHierarchyLevels,
  validateChartOfAccounts,
  // exported for unit testing
  buildCoaModel,
  buildLeafHierarchies,
  buildTree,
  isNonAccountRow,
};
