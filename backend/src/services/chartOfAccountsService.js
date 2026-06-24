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
const TABLE_TXN = "manual_gl_staged_transactions";
const TABLE_BS = "manual_gl_balance_sheet_lines";
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
      .select('account_number, account_name, account_type, fiscal_year')
      .eq('company_id', companyId)
      .eq('version_id', versionId)
      .order('id', { ascending: true }),
  );
}

// Read distinct accounts from balance_sheet_entries for a version (new architecture).
async function collectBsAccountsFromEntries(companyId, versionId) {
  return fetchAllRows(() =>
    supabase
      .from('balance_sheet_entries')
      .select('account_name, section')
      .eq('company_id', companyId)
      .eq('version_id', versionId)
      .order('id', { ascending: true }),
  );
}

/**
 * Build the in-memory COA model (groups + leaves) from raw account rows.
 * Pure function — no DB access — so it is easy to test and reason about.
 */
function buildCoaModel(glRows, bsRows) {
  // Index leaves by normalized name so the same account linked from both GL
  // (numbered) and the Balance Sheet (often un-numbered) collapses into one row.
  // Two genuinely distinct accounts that share a name but have *different*
  // numbers are kept separate.
  const leavesByName = new Map(); // normName -> leaf[]
  const usedGroups = new Set();

  const mergeInto = (leaf, source, fiscalYear, number) => {
    leaf.sources.add(source);
    if (fiscalYear) leaf.fiscalYears.add(Number(fiscalYear));
    if (!leaf.accountNumber && number) leaf.accountNumber = number; // adopt a real number
  };

  const addLeaf = (accountName, accountNumber, accountType, source, fiscalYear) => {
    const name = String(accountName || "").trim();
    if (!name) return;
    const number = accountNumber ? String(accountNumber).trim() : null;
    const type =
      normalizeAccountType(accountType) || inferAccountType(name, number || "");
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
      sources: new Set([source]),
      fiscalYears: new Set(fiscalYear ? [Number(fiscalYear)] : []),
    };
    bucket.push(leaf);
    leavesByName.set(key, bucket);
  };

  for (const r of glRows || []) {
    addLeaf(r.account_name, r.account_number, r.account_type, "general_ledger", r.fiscal_year);
  }
  for (const r of bsRows || []) {
    const type = accountTypeFromBsSection(r.section);
    addLeaf(r.account_name, null, type, "balance_sheet", null);
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

  let glRows, bsRows;
  if (batchId) {
    [glRows, bsRows] = await Promise.all([
      collectGlAccounts(companyId, batchId),
      collectBsAccounts(companyId, batchId).catch(() => []),
    ]);
  } else {
    [glRows, bsRows] = await Promise.all([
      collectGlAccountsFromEntries(companyId, versionId),
      collectBsAccountsFromEntries(companyId, versionId).catch(() => []),
    ]);
  }

  const { groups, leaves } = buildCoaModel(glRows, bsRows);

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

module.exports = {
  generateChartOfAccounts,
  getChartOfAccounts,
  updateAccount,
  // exported for unit testing
  buildCoaModel,
};
