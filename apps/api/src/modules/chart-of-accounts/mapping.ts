/**
 * Turning stored chart-of-accounts rows into the grid and tree the UI renders.
 *
 * Pure, and separate from the repository, because all of it is presentation
 * rules: which name wins, what counts as edited, and how a flat list of
 * fifteen level columns becomes a tree. Legacy interleaved these with Supabase
 * calls, so the only way to ask "what tree does this produce?" was to have a
 * database.
 */

/** The hierarchy is fifteen flattened columns, `level_1`..`level_15`. */
export const MAX_LEVELS = 15;

const BALANCE_SHEET_TYPES = new Set(["asset", "liability", "equity"]);

/**
 * The statement an account type belongs on.
 *
 * Derived, never stored independently — the two cannot then disagree, which is
 * how an account ends up counted on one statement and displayed on the other.
 */
export function statementTypeFor(accountType: string | null): "balance_sheet" | "profit_loss" {
  return BALANCE_SHEET_TYPES.has(String(accountType)) ? "balance_sheet" : "profit_loss";
}

/** A row as stored: the level columns plus the fields the mapping reads. */
export interface CoaRow {
  id: string;
  versionId: string;
  accountNumber: string | null;
  accountName: string;
  parentAccountId: string | null;
  accountType: string | null;
  statementType: string | null;
  isActive: boolean;
  sortOrder: number | null;
  baseAccount: string | null;
  hierarchyPath: string | null;
  accountIdName: string | null;
  classificationMethod: string | null;
  originalName: string | null;
  adjustedName: string | null;
  metadata: { is_group?: boolean; user_modified?: boolean } | null;
  levels: Array<string | null>;
}

/** An account as the grid renders it. */
export interface CoaAccount {
  id: string;
  versionId: string;
  accountNumber: string | null;
  /** What to display: the adjusted name if someone set one. */
  accountName: string;
  /** What the document called it, whatever the display name now is. */
  sourceName: string;
  originalName: string | null;
  adjustedName: string | null;
  accountIdName: string | null;
  accountType: string | null;
  statementType: string | null;
  parentAccountId: string | null;
  isActive: boolean;
  sortOrder: number | null;
  levels: Array<string | null>;
  baseAccount: string | null;
  hierarchyPath: string | null;
  classificationMethod: string | null;
  /** True when a person has touched it — the grid marks these. */
  modified: boolean;
  isGroup: boolean;
  metadata: Record<string, unknown>;
}

export interface CoaTreeNode {
  id: string;
  accountId?: string;
  name: string;
  isGroup: boolean;
  level: number;
  statementType: string | null;
  children: CoaTreeNode[];
  accountNumber?: string | null;
  accountType?: string | null;
  hierarchyPath?: string | null;
  classificationMethod?: string | null;
  isActive?: boolean;
  modified?: boolean;
  levels?: Array<string | null>;
  originalName?: string | null;
  adjustedName?: string | null;
}

/** Read `level_1`..`level_15` off a row into an array. */
export function columnsToLevels(row: Record<string, unknown>): Array<string | null> {
  const levels: Array<string | null> = [];
  for (let i = 1; i <= MAX_LEVELS; i += 1) {
    const value = row[`level${i}`] ?? row[`level_${i}`];
    levels.push(typeof value === "string" && value !== "" ? value : null);
  }
  return levels;
}

/** The inverse: an array back into the fifteen columns, padded with nulls. */
export function levelsToColumns(levels: ReadonlyArray<string | null>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (let i = 0; i < MAX_LEVELS; i += 1) out[`level${i + 1}`] = levels[i] ?? null;
  return out;
}

export interface HierarchySnapshot {
  levels: Array<string | null>;
  account_type: string | null;
  statement_type: string | null;
  base_account: string | null;
}

/** The shape written to the audit tables — snake_case, because it is stored JSON. */
export function hierarchySnapshot(
  levels: ReadonlyArray<string | null>,
  accountType: string | null,
  statementType: string | null,
  baseAccount: string | null,
): HierarchySnapshot {
  return {
    levels: [...levels],
    account_type: accountType,
    statement_type: statementType,
    base_account: baseAccount,
  };
}

/**
 * Whether a person has edited this account.
 *
 * Two signals, because either alone misses a case: the `user_modified` flag is
 * set by every edit path, and a differing adjusted name catches rows edited
 * before that flag existed.
 */
export function isModified(row: CoaRow): boolean {
  if (row.metadata?.user_modified) return true;
  return Boolean(row.adjustedName && row.originalName && row.adjustedName !== row.originalName);
}

export function toAccount(row: CoaRow): CoaAccount {
  return {
    id: row.id,
    versionId: row.versionId,
    accountNumber: row.accountNumber,
    accountName: row.adjustedName || row.accountName,
    sourceName: row.accountName,
    originalName: row.originalName,
    adjustedName: row.adjustedName,
    accountIdName: row.accountIdName,
    accountType: row.accountType,
    statementType: row.statementType,
    parentAccountId: row.parentAccountId,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    levels: row.levels,
    baseAccount: row.baseAccount,
    hierarchyPath: row.hierarchyPath,
    classificationMethod: row.classificationMethod,
    modified: isModified(row),
    isGroup: Boolean(row.metadata?.is_group),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
  };
}

/**
 * Presentation order for the standard captions.
 *
 * Alphabetical would put "Assets" after "Equity" and "Revenue" after
 * "Operating Expenses", which is not how anyone reads a set of accounts.
 * Anything unrecognised sorts alphabetically after these.
 */
const LEVEL_ORDER = new Map<string, number>([
  ["Income Statement", 1],
  ["Balance Sheet", 2],
  ["Assets", 1],
  ["Liabilities", 2],
  ["Equity", 3],
  ["Revenue", 4],
  ["Cost of Goods Sold", 5],
  ["Operating Expenses", 6],
]);

function leafNode(account: CoaAccount, level?: number): CoaTreeNode {
  return {
    id: account.id,
    accountId: account.id,
    name: account.accountName,
    isGroup: false,
    level: level ?? (account.levels.filter(Boolean).length || 1),
    accountNumber: account.accountNumber,
    accountType: account.accountType,
    statementType: account.statementType,
    hierarchyPath: account.hierarchyPath,
    classificationMethod: account.classificationMethod,
    isActive: account.isActive,
    modified: account.modified,
    levels: account.levels,
    originalName: account.originalName,
    adjustedName: account.adjustedName,
    children: [],
  };
}

/**
 * Build the tree from each account's level path.
 *
 * The LAST non-null level is the account itself, not a category — so the walk
 * stops one short. Treating it as a category would give every account a folder
 * of its own containing only itself.
 */
export function buildTree(accounts: ReadonlyArray<CoaAccount>): CoaTreeNode[] {
  interface Building extends Omit<CoaTreeNode, "children"> {
    children: Building[];
    childIndex: Map<string, Building>;
  }
  const root = { id: "root", children: [] as Building[], childIndex: new Map<string, Building>() };

  for (const account of accounts) {
    const path = account.levels.filter((l): l is string => Boolean(l));
    if (path.length === 0) {
      root.children.push(leafNode(account) as Building);
      continue;
    }

    let node: { id?: string; children: Building[]; childIndex: Map<string, Building> } = root;
    for (let i = 0; i < path.length - 1; i += 1) {
      const label = path[i]!;
      let child = node.childIndex.get(label);
      if (!child) {
        child = {
          id: `cat:${node.id ?? "root"}/${label}`,
          name: label,
          isGroup: true,
          level: i + 1,
          statementType: account.statementType,
          children: [],
          childIndex: new Map(),
        };
        node.childIndex.set(label, child);
        node.children.push(child);
      }
      node = child;
    }
    node.children.push(leafNode(account, path.length) as Building);
  }

  /** Categories before accounts, then the standard order, then alphabetical. */
  const compare = (a: Building, b: Building): number => {
    if (a.isGroup !== b.isGroup) return a.isGroup ? -1 : 1;
    const ao = LEVEL_ORDER.get(a.name) ?? 999;
    const bo = LEVEL_ORDER.get(b.name) ?? 999;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name);
  };

  const finalize = (n: Building): CoaTreeNode => {
    n.children.sort(compare);
    n.children.forEach(finalize);
    delete (n as Partial<Building>).childIndex;
    return n as CoaTreeNode;
  };

  // The top level is sorted too. Legacy sorted every node's children but not
  // the root's, so "Assets, Liabilities, Equity" held three levels deep and the
  // outermost list came out in whatever order the rows arrived — sorted
  // everywhere except where a reader looks first.
  root.children.sort(compare);
  return root.children.map(finalize);
}
