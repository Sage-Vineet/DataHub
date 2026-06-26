// ============================================================================
// Chart of Accounts engine (Key Reports Rearchitecture — M2 / Phase 10)
//
// Builds a per-version Chart of Accounts (COA) from a synced Key Report version's
// staged GL transactions and Balance Sheet lines, classifies each account, and
// persists a parent/child hierarchy into the chart_of_accounts table.
//
// Hierarchy shape (matches the client's requested example):
//   Assets                (group)
//     └─ Cash             (leaf)
//   Revenue               (group)
//     └─ Sales Revenue    (leaf)
//   Expenses              (group)
//     └─ Payroll          (leaf)
//
// The COA is regenerated on every sync (delete-then-insert per version), so it is
// always consistent with the version's currently-linked data.
// ============================================================================

const { supabase } = require("../db");
const {
  normalizeAccountType,
  inferAccountType,
} = require("./manualGlMultiYearService");

const TABLE_COA = "chart_of_accounts";
const TABLE_TXN = "general_ledger_entries";
const TABLE_BS = "balance_sheet_entries";
const PAGE_SIZE = 1000;

// Group (parent) node definitions, keyed by normalized account type. The label is
// the human-facing parent name; statementType drives report slicing; sortOrder
// gives a stable Assets→Liabilities→Equity→Revenue→COGS→Expenses ordering.
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

// Section ("assets" | "liabilities" | "equity") on Balance Sheet lines maps
// directly onto a normalized account type.
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

// ── Invalid-row guards ───────────────────────────────────────────────────────
// Spec: a header, total, or section label must NEVER become a chart of account.
// These guards are name-based so one rule protects EVERY source path (BS, P&L, GL)
// and both the entry-table and legacy-batch readers.

// Report banners / metadata lines (e.g. "Accrual Basis ...", "Report generated ...").
const NON_ACCOUNT_RE =
  /^(accrual basis|cash basis|report generated|date generated|generated on|as of\b|unrealized gains?)/i;

// Pure section / category labels — structure, not accounts.
const SECTION_LABEL_SET = new Set([
  "assets", "liabilities", "equity", "income", "revenue", "expense", "expenses",
  "current assets", "fixed assets", "other assets", "other current assets",
  "current liabilities", "long-term liabilities", "long term liabilities",
  "other current liabilities", "other liabilities", "cost of goods sold",
  "liabilities and equity", "liabilities & equity", "total liabilities and equity",
]);

// Total / subtotal / summary rows (mirrors backend/python/common.py IS_TOTAL_RE).
const TOTAL_NAME_RE = /(^total\b|\btotal$|\bnet income\b|\bnet loss\b|\bgross profit\b)/i;

function isTotalName(name) {
  return TOTAL_NAME_RE.test(String(name || "").trim());
}

function isSectionLabel(name) {
  const n = String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
  return SECTION_LABEL_SET.has(n);
}

/**
 * True when a row must NOT become a chart-of-accounts entry: blank names, report
 * banners ("Accrual Basis …"), section labels ("Assets", "Current Liabilities"),
 * and any total/subtotal ("Total Assets", "Total for …", "Net Income").
 */
function isNonAccountRow(name) {
  const n = String(name || "").trim();
  if (!n) return true;
  if (NON_ACCOUNT_RE.test(n)) return true;
  if (isTotalName(n)) return true;
  if (isSectionLabel(n)) return true;
  return false;
}

// Paginate a scoped select so large batches don't get truncated by PostgREST's
// default row cap (the report path caps rows; COA must see every account).
async function fetchAllRows(buildQuery) {
  const out = [];
  let from = 0;
  // Hard upper bound on pages as a runaway guard (1000 pages * 1000 rows = 1M).
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

// Read distinct accounts from staged GL transactions for a batch. Scoped by
// upload_batch_id (the column the snapshot/report path uses); falls back to the
// base batch_id column on installs predating migration 026.
async function collectGlAccounts(companyId, batchId) {
  const select = "account_number, account_name, account_type, fiscal_year";
  let rows;
  try {
    rows = await fetchAllRows(() =>
      supabase
        .from(TABLE_TXN)
        .select(select)
        .eq("company_id", companyId)
        .eq("upload_batch_id", batchId)
        .order("id", { ascending: true }),
    );
  } catch (err) {
    const msg = String(err?.message || "").toLowerCase();
    if (!msg.includes("upload_batch_id")) throw err;
    rows = await fetchAllRows(() =>
      supabase
        .from(TABLE_TXN)
        .select(select)
        .eq("company_id", companyId)
        .eq("batch_id", batchId)
        .order("id", { ascending: true }),
    );
  }
  return rows;
}

// Read distinct accounts from Balance Sheet lines for a batch. Ensures
// balance-sheet-only accounts (no GL activity) still appear in the COA.
async function collectBsAccounts(companyId, batchId) {
  return fetchAllRows(() =>
    supabase
      .from(TABLE_BS)
      .select("account_name, section")
      .eq("company_id", companyId)
      .eq("batch_id", batchId)
      .order("id", { ascending: true }),
  );
}

// Read distinct accounts from general_ledger_entries for a version (new architecture).
async function collectGlAccountsFromEntries(companyId, versionId) {
  return fetchAllRows(() =>
    supabase
      .from('general_ledger_entries')
      .select('distribution_account, account_section, fiscal_year')
      .eq('company_id', companyId)
      .eq('version_id', versionId)
      .eq('row_type', 'TRANSACTION')
      .order('id', { ascending: true }),
  );
}

// Read accounts from balance_sheet_entries for a version (new architecture).
// Excludes total rows at the query layer; section-header/label rows are dropped by
// isNonAccountRow in buildCoaModel. Balance Sheet is the AUTHORITATIVE source — its
// `section` decides asset/liability/equity (never keyword inference).
async function collectBsAccountsFromEntries(companyId, versionId) {
  return fetchAllRows(() =>
    supabase
      .from('balance_sheet_entries')
      .select('account_name, account_number, section, is_total, hierarchy_level, fiscal_year')
      .eq('company_id', companyId)
      .eq('version_id', versionId)
      .eq('is_total', false)
      .order('id', { ascending: true }),
  );
}

// Read accounts from profit_loss_entries for a version (new architecture).
// Spec priority #2 (after Balance Sheet, before General Ledger). Excludes total
// rows at the query layer; headers/labels dropped by isNonAccountRow.
async function collectPlAccountsFromEntries(companyId, versionId) {
  return fetchAllRows(() =>
    supabase
      .from('profit_loss_entries')
      .select('account_name, account_number, account_type, is_total, hierarchy_level, fiscal_year')
      .eq('company_id', companyId)
      .eq('version_id', versionId)
      .eq('is_total', false)
      .order('id', { ascending: true }),
  );
}

/**
 * Build the in-memory COA model (groups + leaves) from raw account rows.
 * Pure function — no DB access — so it is easy to test and reason about.
 *
 * Source precedence (spec): Balance Sheet (authoritative) → Profit & Loss →
 * General Ledger (fallback only). Sources are processed in that order; whichever
 * source FIRST creates a leaf fixes its classification, and later sources only
 * merge provenance (sources/fiscal years/number). General Ledger therefore never
 * overrides a Balance-Sheet or P&L classification of the same account.
 *
 * Every name is screened by isNonAccountRow, so headers, totals, and section
 * labels can never become accounts regardless of which source emitted them.
 */
function buildCoaModel(glRows, bsRows, plRows) {
  // Index leaves by normalized name so the same account linked from BS (often
  // un-numbered) and GL (numbered) collapses into one row. Two genuinely distinct
  // accounts that share a name but have *different* numbers are kept separate.
  const leavesByName = new Map(); // normName -> leaf[]
  const usedGroups = new Set();

  const mergeInto = (leaf, source, fiscalYear, number) => {
    leaf.sources.add(source);
    if (fiscalYear) leaf.fiscalYears.add(Number(fiscalYear));
    if (!leaf.accountNumber && number) leaf.accountNumber = number; // adopt a real number
  };

  // explicitType: a known type from the source (BS section / P&L|GL account_type).
  // When absent we keyword-infer. classificationSource records how we decided.
  const addLeaf = (accountName, accountNumber, explicitType, source, fiscalYear, classificationSource) => {
    const name = String(accountName || "").trim();
    if (!name) return;
    if (isNonAccountRow(name)) return; // guard: no headers / totals / section labels
    const number = accountNumber ? String(accountNumber).trim() : null;
    const normalized = normalizeAccountType(explicitType);
    const type = normalized || inferAccountType(name, number || "");
    const resolvedSource = normalized ? classificationSource : "keyword";
    const key = normName(name);
    const bucket = leavesByName.get(key) || [];

    // Find a merge target: same number, or a same-name entry missing a number
    // (or this row missing a number). Different explicit numbers => separate.
    const target = bucket.find((l) => {
      if (number && l.accountNumber) return l.accountNumber === number;
      return true; // one side has no number → treat as the same account
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

  // 1) Balance Sheet — authoritative. Section drives the type (never keyword).
  for (const r of bsRows || []) {
    const type = accountTypeFromBsSection(r.section);
    addLeaf(r.account_name, r.account_number || null, type, "balance_sheet", r.fiscal_year, "balance_sheet_section");
  }
  // 2) Profit & Loss — income / expense / cogs.
  for (const r of plRows || []) {
    addLeaf(r.account_name, r.account_number || null, r.account_type || null, "profit_loss", r.fiscal_year, "profit_loss_type");
  }
  // 3) General Ledger — fallback only. Use the posting account; do NOT fall back to
  //    the section header (it can be a report banner). Type is keyword-inferred
  //    unless the entry carries an explicit account_type (legacy staged rows).
  for (const r of glRows || []) {
    const name = r.distribution_account || r.account_name || "";
    addLeaf(name, r.account_number || null, r.account_type || null, "general_ledger", r.fiscal_year, "gl_type");
  }

  // Only emit group nodes that actually have children.
  const groups = Object.entries(GROUP_DEFS)
    .filter(([type]) => usedGroups.has(type))
    .map(([type, def]) => ({ type, ...def }));

  const leaves = Array.from(leavesByName.values()).flat();
  return { groups, leaves };
}

/**
 * Regenerate and persist the Chart of Accounts for a Key Report version.
 *
 * @param {string} companyId
 * @param {string} versionId  key_report_versions.id
 * @param {string} batchId    manual_gl_batches.id (legacy path); pass null to read from entry tables
 * @returns {Promise<{ accountCount: number, groupCount: number, leafCount: number }>}
 */
async function generateChartOfAccounts(companyId, versionId, batchId) {
  if (!companyId || !versionId) {
    return { accountCount: 0, groupCount: 0, leafCount: 0, skipped: true };
  }

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

  const { groups, leaves } = buildCoaModel(glRows, bsRows, plRows);

  // Replace the version's COA atomically-ish: delete then insert. The COA is a
  // pure derivative of the version's data, so a brief empty window on regenerate
  // is acceptable and is bounded to this version only.
  const del = await supabase.from(TABLE_COA).delete().eq("version_id", versionId);
  if (del.error) throw del.error;

  if (!leaves.length) {
    return { accountCount: 0, groupCount: 0, leafCount: 0 };
  }

  // 1) Insert group (parent) nodes and capture their ids by type.
  const groupRows = groups.map((g) => ({
    version_id: versionId,
    company_id: companyId,
    account_number: null,
    account_name: g.label,
    parent_account_id: null,
    account_type: g.type,
    statement_type: g.statementType,
    is_active: true,
    sort_order: g.sortOrder,
    metadata: { is_group: true },
  }));

  const groupIdByType = new Map();
  if (groupRows.length) {
    const ins = await supabase.from(TABLE_COA).insert(groupRows).select("id, account_type");
    if (ins.error) throw ins.error;
    for (const row of ins.data || []) {
      groupIdByType.set(row.account_type, row.id);
    }
  }

  // 2) Insert leaf accounts, parented to their group node.
  const leafRows = leaves
    .slice()
    .sort((a, b) => a.accountName.localeCompare(b.accountName))
    .map((leaf, idx) => ({
      version_id: versionId,
      company_id: companyId,
      account_number: leaf.accountNumber,
      account_name: leaf.accountName,
      parent_account_id: groupIdByType.get(leaf.accountType) || null,
      account_type: leaf.accountType,
      statement_type: leaf.statementType,
      is_active: true,
      sort_order: 1000 + idx,
      metadata: {
        is_group: false,
        sources: Array.from(leaf.sources),
        fiscal_years: Array.from(leaf.fiscalYears).sort((a, b) => a - b),
        classification_source: leaf.classificationSource || null,
      },
    }));

  const insLeaves = await supabase.from(TABLE_COA).insert(leafRows);
  if (insLeaves.error) throw insLeaves.error;

  return {
    accountCount: groupRows.length + leafRows.length,
    groupCount: groupRows.length,
    leafCount: leafRows.length,
  };
}

function mapRow(row) {
  return {
    id: row.id,
    versionId: row.version_id,
    accountNumber: row.account_number,
    accountName: row.account_name,
    parentAccountId: row.parent_account_id,
    accountType: row.account_type,
    statementType: row.statement_type,
    isActive: row.is_active,
    sortOrder: row.sort_order,
    isGroup: Boolean(row.metadata?.is_group),
    metadata: row.metadata || {},
  };
}

/**
 * Fetch a version's COA as a nested tree (groups with their child accounts),
 * plus the flat list for clients that prefer it.
 */
async function getChartOfAccounts(versionId) {
  const { data, error } = await supabase
    .from(TABLE_COA)
    .select("*")
    .eq("version_id", versionId)
    .order("sort_order", { ascending: true });
  if (error) throw error;

  const rows = (data || []).map(mapRow);
  const groups = rows.filter((r) => r.isGroup);
  const childrenByParent = new Map();
  for (const r of rows) {
    if (r.isGroup) continue;
    const list = childrenByParent.get(r.parentAccountId) || [];
    list.push(r);
    childrenByParent.set(r.parentAccountId, list);
  }

  const tree = groups.map((g) => ({
    ...g,
    children: childrenByParent.get(g.id) || [],
  }));
  // Surface any leaves whose parent group was removed (defensive).
  const orphans = (childrenByParent.get(null) || []).concat(
    rows.filter((r) => !r.isGroup && r.parentAccountId && !groups.some((g) => g.id === r.parentAccountId)),
  );
  if (orphans.length) {
    tree.push({
      id: null,
      accountName: "Unclassified",
      accountType: null,
      statementType: null,
      isGroup: true,
      sortOrder: 9999,
      children: orphans,
    });
  }

  return { versionId, flat: rows, tree, accountCount: rows.length };
}

const EDITABLE_FIELDS = {
  accountName: "account_name",
  accountType: "account_type",
  statementType: "statement_type",
  parentAccountId: "parent_account_id",
  isActive: "is_active",
  sortOrder: "sort_order",
};

/**
 * Update a single COA account (supports the "allow future editing" requirement).
 */
async function updateAccount(accountId, patch = {}) {
  const update = { updated_at: new Date().toISOString() };
  for (const [apiKey, column] of Object.entries(EDITABLE_FIELDS)) {
    if (patch[apiKey] !== undefined) update[column] = patch[apiKey];
  }
  const { data, error } = await supabase
    .from(TABLE_COA)
    .update(update)
    .eq("id", accountId)
    .select("*")
    .single();
  if (error) throw error;
  return mapRow(data);
}

// ── Validation engine (Key Reports Rearchitecture — M1 / spec validation rules) ──
//
// Runs the spec's Chart-of-Accounts checks against a synced version and returns
// (a) a structured `reports` object (the lists the spec asks to surface:
//     unmapped / duplicate / invalid / header-total / multi-category), and
// (b) `rows` shaped for key_report_validation_results so the Sync dashboard's
//     existing year-by-year grid + "Validation messages" pane render them with NO
//     frontend change (data_type='chart_of_accounts', year=null).
//
// Pure derivative — reads the COA + GL it just built; never mutates anything.
async function validateChartOfAccounts(companyId, versionId) {
  const empty = { nullType: [], invalidRows: [], duplicates: [], unmapped: [], multiCategory: [] };
  if (!companyId || !versionId) {
    return { summary: { accountCount: 0, leafCount: 0, status: "warning", ...empty }, reports: empty, rows: [] };
  }

  const { data: coaData, error } = await supabase
    .from(TABLE_COA)
    .select("id, account_name, account_number, account_type, metadata")
    .eq("version_id", versionId);
  if (error) throw error;

  const all = coaData || [];
  const leaves = all.filter((r) => !r.metadata?.is_group);

  // GL accounts that ought to be represented in the COA (TRANSACTION rows only).
  let glAccounts = [];
  try {
    const glRows = await collectGlAccountsFromEntries(companyId, versionId);
    glAccounts = glRows.map((r) => String(r.distribution_account || "").trim()).filter(Boolean);
  } catch (_e) {
    glAccounts = [];
  }

  const leafKeys = new Set(leaves.map((r) => normName(r.account_name)));

  // 1) No account may have a NULL/blank category.
  const nullType = leaves.filter((r) => !r.account_type).map((r) => r.account_name);
  // 2) No header/total/section-label row may exist in the COA (defensive — the
  //    generator already screens these; this proves it for the dashboard).
  const invalidRows = leaves.filter((r) => isNonAccountRow(r.account_name)).map((r) => r.account_name);
  // 3) No duplicate account mappings (same normalized name more than once).
  const counts = new Map();
  for (const r of leaves) {
    const k = normName(r.account_name);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const duplicates = leaves
    .filter((r) => counts.get(normName(r.account_name)) > 1)
    .map((r) => r.account_name)
    .filter((v, i, a) => a.indexOf(v) === i);
  // 4) Every GL account must map to a COA account.
  const unmapped = Array.from(
    new Set(glAccounts.filter((n) => !isNonAccountRow(n) && !leafKeys.has(normName(n)))),
  );
  // 5) Each account belongs to exactly one category.
  const typesByName = new Map();
  for (const r of leaves) {
    const k = normName(r.account_name);
    if (!typesByName.has(k)) typesByName.set(k, new Set());
    typesByName.get(k).add(r.account_type || "unknown");
  }
  const multiCategory = Array.from(typesByName.entries())
    .filter(([, set]) => set.size > 1)
    .map(([k]) => k);

  const reports = { nullType, invalidRows, duplicates, unmapped, multiCategory };

  const sample = (arr, n = 8) =>
    arr.slice(0, n).join(", ") + (arr.length > n ? ` … (+${arr.length - n} more)` : "");

  const rows = [];
  let worst = "success";

  // Hard failures.
  const errorChecks = [
    [nullType, (a) => `${a.length} account(s) missing a category: ${sample(a)}`],
    [invalidRows, (a) => `${a.length} invalid row(s) (header/total/section) present in the Chart of Accounts: ${sample(a)}`],
    [multiCategory, (a) => `${a.length} account(s) classified into more than one category: ${sample(a)}`],
  ];
  for (const [arr, msg] of errorChecks) {
    if (arr.length) {
      worst = "error";
      rows.push({
        dataType: "chart_of_accounts", year: null, status: "error", severity: "error",
        message: msg(arr), metadata: { sample: arr.slice(0, 25), count: arr.length },
      });
    }
  }

  // Soft warnings.
  const warnChecks = [
    [duplicates, (a) => `${a.length} duplicate account name(s): ${sample(a)}`],
    [unmapped, (a) => `${a.length} General Ledger account(s) not represented in the Chart of Accounts: ${sample(a)}`],
  ];
  for (const [arr, msg] of warnChecks) {
    if (arr.length) {
      if (worst !== "error") worst = "warning";
      rows.push({
        dataType: "chart_of_accounts", year: null, status: "warning", severity: "warning",
        message: msg(arr), metadata: { sample: arr.slice(0, 25), count: arr.length },
      });
    }
  }

  const status = leaves.length ? worst : "warning";
  // Summary row first so the grid cell reflects overall COA health.
  rows.unshift({
    dataType: "chart_of_accounts",
    year: null,
    status,
    severity: status,
    message: leaves.length
      ? status === "success"
        ? `Chart of Accounts generated successfully (${leaves.length} accounts, all classified).`
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
  validateChartOfAccounts,
  // exported for unit testing
  buildCoaModel,
  isNonAccountRow,
};
