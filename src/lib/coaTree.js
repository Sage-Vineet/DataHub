// Client-side Chart of Accounts TREE utilities — operates directly on the
// backend's flat node-list wire shape ({ key, parentKey, nodeType, ... }),
// the SAME shape for both an unpersisted Proposed COA and a persisted
// Approved COA (chartOfAccountsService.serializeProposedTree /
// serializePersistedTree). There is no flat level_1..15 reconstruction here
// any more — parentKey is the single source of truth for hierarchy, exactly
// as it is on the backend.
//
// Every check in validateTree below is a CLIENT-SIDE UX convenience mirroring
// chartOfAccountsService.validateFinalCoaTree — it gives the tree editor
// instant feedback while a draft is being edited. The backend's Save endpoint
// (chartOfAccountsService.validateFinalCoaTree, called from
// keyReportSyncService's APPROVE MODE) remains the sole authoritative gate;
// this file must never be treated as a substitute for it.

export const MAX_HIERARCHY_LEVELS = 15;

export const CLASSIFICATION_SOURCE_LABELS = {
  DOCUMENT: "Document match",
  AI_FALLBACK: "AI classified",
  USER_EDITED: "User edited",
};

export function normName(s) {
  return String(s || "").trim().toLowerCase();
}

/** The label a node should render with — adjusted/edited name wins over the
 * original source name; a CATEGORY node's own `label` is used as-is. */
export function displayName(node) {
  if (!node) return "";
  if (node.nodeType === "ACCOUNT") return node.adjustedName || node.accountName || "";
  return node.label || "";
}

/**
 * Build the two lookup structures every other helper in this file needs:
 *   nodesByKey            Map<key, node>
 *   childrenByParentKey   Map<parentKey|null, node[]>  (children sorted by
 *                         sortOrder, falling back to display name)
 */
export function buildIndexes(nodes) {
  const nodesByKey = new Map();
  for (const n of nodes || []) nodesByKey.set(n.key, n);

  const childrenByParentKey = new Map();
  for (const n of nodes || []) {
    const parentKey = n.parentKey ?? null;
    if (!childrenByParentKey.has(parentKey)) childrenByParentKey.set(parentKey, []);
    childrenByParentKey.get(parentKey).push(n);
  }
  const sortFn = (a, b) => {
    const sa = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const sb = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    return displayName(a).localeCompare(displayName(b));
  };
  for (const list of childrenByParentKey.values()) list.sort(sortFn);

  return { nodesByKey, childrenByParentKey };
}

/**
 * Walk key -> parentKey up to a root (parentKey == null). Mirrors the
 * backend's walkNodeAncestry exactly: detects a dangling parentKey (ORPHAN)
 * or a chain that revisits itself (CIRCULAR_REFERENCE) or exceeds the
 * maximum supported depth, instead of looping forever.
 */
export function walkAncestry(nodesByKey, startKey) {
  const chain = [];
  const seen = new Set();
  let cur = startKey;
  while (cur) {
    if (seen.has(cur)) return { chain, error: "CIRCULAR_REFERENCE" };
    seen.add(cur);
    const node = nodesByKey.get(cur);
    if (!node) return { chain, error: "ORPHAN" };
    chain.unshift(node);
    if (chain.length > MAX_HIERARCHY_LEVELS + 1) return { chain, error: "DEPTH_EXCEEDED" };
    cur = node.parentKey || null;
  }
  return { chain, error: null };
}

/** Breadcrumb string for a node ("Total Assets > Current Assets > Chase Bank"). */
export function getHierarchyPathLabel(nodesByKey, key) {
  const { chain, error } = walkAncestry(nodesByKey, key);
  if (error) return chain.map(displayName).join(" > ");
  return chain.map(displayName).join(" > ");
}

/** The topmost (parentKey === null) ancestor's key for a node — used to keep
 * a "Move to…" target list within the same fixed GAAP anchor the node is
 * already under (an asset account must stay under the Total Assets anchor,
 * etc.) — the same invariant validateFinalCoaTree enforces server-side. */
export function getRootAnchorKey(nodesByKey, key) {
  const { chain, error } = walkAncestry(nodesByKey, key);
  if (error || !chain.length) return null;
  return chain[0].key;
}

/** All CATEGORY nodes, each annotated with its own hierarchy path label. */
export function listCategoryNodes(nodes) {
  const { nodesByKey } = buildIndexes(nodes);
  return (nodes || [])
    .filter((n) => n.nodeType === "CATEGORY")
    .map((n) => ({ node: n, path: getHierarchyPathLabel(nodesByKey, n.key) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Category nodes a given ACCOUNT node could legally move under — restricted
 * to the same top-level anchor as its CURRENT position, and never itself
 * (an account can never be its own parent). Purely a UX narrowing; the
 * server is still the authority on whether a given move is valid. */
export function getMoveTargetsForAccount(nodes, accountNode) {
  const { nodesByKey } = buildIndexes(nodes);
  const currentAnchor = getRootAnchorKey(nodesByKey, accountNode.parentKey || accountNode.key);
  return listCategoryNodes(nodes).filter(({ node }) => {
    if (node.key === accountNode.key) return false;
    const anchor = getRootAnchorKey(nodesByKey, node.key);
    return !currentAnchor || anchor === currentAnchor;
  });
}

/** Rename a node (ACCOUNT: adjustedName; CATEGORY: label) — pure, returns a
 * NEW array. Marks the edited node userEdited:true so a Save forces the
 * backend to treat it as a manual/human classification. */
export function renameNode(nodes, key, newName) {
  const trimmed = String(newName || "").trim();
  return (nodes || []).map((n) => {
    if (n.key !== key) return n;
    if (n.nodeType === "ACCOUNT") {
      const adjustedName = trimmed && trimmed !== n.accountName ? trimmed : null;
      return { ...n, adjustedName, userEdited: true };
    }
    return { ...n, label: trimmed || n.label, userEdited: true };
  });
}

/** Move a node to a new parent — pure, returns a NEW array. Marks the moved
 * node userEdited:true (a reclassification signal for an ACCOUNT node). */
export function moveNode(nodes, key, newParentKey) {
  return (nodes || []).map((n) => (n.key === key ? { ...n, parentKey: newParentKey, userEdited: true } : n));
}

/** Full display path for an ACCOUNT node — ancestor CATEGORY labels followed
 * by the account's own (adjusted) name, padded to MAX_HIERARCHY_LEVELS with
 * "" — the same shape the old flat-`levels`-array grid rendered per-row
 * Level 1..15 cells from, now derived fresh from the parentKey graph on every
 * render instead of being a static field that could go stale after an edit. */
export function getLevelsArray(nodesByKey, key) {
  const { chain, error } = walkAncestry(nodesByKey, key);
  const labels = error ? chain.map(displayName) : chain.map(displayName);
  const out = labels.slice(0, MAX_HIERARCHY_LEVELS);
  while (out.length < MAX_HIERARCHY_LEVELS) out.push("");
  return out;
}

function normPathKey(pathArr) {
  return (pathArr || []).map(normName).filter(Boolean).join(" > ");
}

/**
 * Find-or-create the CATEGORY node chain for a typed/selected path (e.g. from
 * the "Hierarchy Path" free-text field or a merge/mapping target) — the
 * client-side equivalent of the backend's resolveOrCreateCategoryChain,
 * operating on the in-memory draft array instead of the database. Reuses an
 * EXISTING category anywhere in the tree whose own normalized path matches a
 * prefix exactly (so retyping the same path twice, or picking one from the
 * "Move to…" datalist, never creates a duplicate); creates a new CATEGORY
 * node (a locally-generated key, never confused with a real persisted id)
 * for any prefix depth that doesn't already exist. Pure — returns
 * { nodes: NEW array, categoryKey: string|null } (null only for an empty
 * path, meaning "no category — this would be a bare root-level account",
 * which validateTree/the backend will reject since every account must sit
 * under its fixed GAAP anchor).
 */
export function resolveOrCreateCategoryChain(nodes, pathArr, { accountType, statementType } = {}) {
  const path = (pathArr || []).map((s) => String(s || "").trim()).filter(Boolean);
  if (!path.length) return { nodes: nodes || [], categoryKey: null };

  const next = [...(nodes || [])];
  const byPath = new Map();
  for (const n of next) {
    if (n.nodeType !== "CATEGORY") continue;
    byPath.set(normPathKey(getLevelsArray(new Map(next.map((m) => [m.key, m])), n.key).filter(Boolean)), n.key);
  }

  let parentKey = null;
  for (let i = 0; i < path.length; i += 1) {
    const prefixArr = path.slice(0, i + 1);
    const pKey = normPathKey(prefixArr);
    let key = byPath.get(pKey);
    if (!key) {
      key = `client-cat::${pKey}`;
      // A prior loop iteration (or an earlier call in this same edit) may
      // already have created this exact node — never push a second copy.
      if (!next.some((n) => n.key === key)) {
        next.push({
          key, parentKey, nodeType: "CATEGORY", label: prefixArr[prefixArr.length - 1],
          accountType, statementType,
        });
      }
      byPath.set(pKey, key);
    }
    parentKey = key;
  }
  return { nodes: next, categoryKey: parentKey };
}

/**
 * Apply a full inline-edit commit for ONE account: rename + move under a
 * (possibly brand-new) category path, in one step — the tree-native
 * replacement for the old flat-array editor's computeDescendantRelabel.
 * Unlike that old helper, no other row ever needs touching: descendants
 * inherit a moved CATEGORY's new position automatically via the SAME
 * parentKey they already had, so only the single edited/moved node itself
 * is ever mutated here.
 */
export function applyAccountEdit(nodes, accountKey, { newName, categoryPathArr, accountType, statementType, clearNeedsMapping } = {}) {
  const { nodes: withCategory, categoryKey } = resolveOrCreateCategoryChain(nodes, categoryPathArr, { accountType, statementType });
  return withCategory.map((n) => {
    if (n.key !== accountKey) return n;
    const trimmed = String(newName || "").trim();
    const adjustedName = trimmed && trimmed !== n.accountName ? trimmed : null;
    return {
      ...n,
      adjustedName,
      parentKey: categoryKey !== null ? categoryKey : n.parentKey,
      userEdited: true,
      ...(clearNeedsMapping ? { needsMapping: false } : {}),
    };
  });
}

/**
 * Merge one CATEGORY's entire membership into another (possibly brand-new)
 * category path — every node currently pointing at `sourceCategoryKey`
 * (accounts AND any sub-categories) is repointed to the target, then the
 * now-unreferenced source category node is dropped from the array. Real
 * accounts get `userEdited: true` (a reclassification); the removed
 * source-category itself needs no flag — the backend never persists a
 * category that isn't a live ancestor of some submitted account.
 */
export function mergeCategory(nodes, sourceCategoryKey, targetPathArr, { accountType, statementType } = {}) {
  const { nodes: withTarget, categoryKey: targetKey } = resolveOrCreateCategoryChain(nodes, targetPathArr, { accountType, statementType });
  if (!targetKey || targetKey === sourceCategoryKey) return withTarget;
  const reassigned = withTarget
    .filter((n) => n.key !== sourceCategoryKey)
    .map((n) => (n.parentKey === sourceCategoryKey
      ? { ...n, parentKey: targetKey, ...(n.nodeType === "ACCOUNT" ? { userEdited: true } : {}) }
      : n));
  return reassigned;
}

/**
 * Client-side mirror of chartOfAccountsService.validateFinalCoaTree's
 * structural checks (duplicate keys, orphan/circular parentKey, an ACCOUNT
 * acting as a parent, invalid enum values). Deliberately does NOT reimplement
 * the deeper GAAP-anchor consistency check (validateHierarchyConsistency) —
 * that requires the same fixedPrefixFor rules the backend owns, and
 * duplicating it here would risk silently drifting out of sync with the
 * real rule. This is UX feedback only; the backend Save call remains the
 * enforcement point regardless of what this returns.
 */
export function validateTree(nodes) {
  const violations = [];
  const list = nodes || [];

  const seenKeys = new Set();
  for (const n of list) {
    if (seenKeys.has(n.key)) violations.push(`Duplicate node key "${n.key}" in the tree.`);
    seenKeys.add(n.key);
    if (!["CATEGORY", "ACCOUNT"].includes(n.nodeType)) {
      violations.push(`Node "${n.key}" has an invalid nodeType "${n.nodeType}".`);
    }
    if (n.nodeType === "ACCOUNT" && !["balance_sheet", "profit_loss"].includes(n.statementType)) {
      violations.push(`Account "${displayName(n)}" has an invalid statementType "${n.statementType}".`);
    }
  }

  const childCountByParent = new Map();
  for (const n of list) {
    if (!n.parentKey) continue;
    childCountByParent.set(n.parentKey, (childCountByParent.get(n.parentKey) || 0) + 1);
  }
  for (const n of list) {
    if (n.nodeType === "ACCOUNT" && childCountByParent.has(n.key)) {
      violations.push(`"${displayName(n)}" is a posting account but has children — a posting account can never have children.`);
    }
  }

  const { nodesByKey } = buildIndexes(list);
  for (const n of list) {
    if (n.nodeType !== "ACCOUNT") continue;
    const { error } = walkAncestry(nodesByKey, n.key);
    if (error === "CIRCULAR_REFERENCE") {
      violations.push(`"${displayName(n)}" has a circular parent reference.`);
    } else if (error === "ORPHAN") {
      violations.push(`"${displayName(n)}" references a parent category that does not exist in the tree.`);
    } else if (error === "DEPTH_EXCEEDED") {
      violations.push(`"${displayName(n)}"'s hierarchy exceeds the maximum of ${MAX_HIERARCHY_LEVELS} levels.`);
    }
  }

  return { valid: violations.length === 0, violations };
}

/** Summary counts for the toolbar badges / toasts — prefers the backend's own
 * matchSummary (proposal / regenerate response) when supplied, otherwise
 * derives the same two numbers from each ACCOUNT node's classificationSource
 * (used for an already-Approved tree, which has no matchSummary attached). */
export function summarizeClassification(nodes, matchSummary) {
  if (matchSummary) {
    return {
      documentMatchedCount: matchSummary.documentMatchedCount || 0,
      aiFallbackCount: matchSummary.aiFallbackCount || 0,
      needsMappingCount: matchSummary.needsMappingCount || 0,
      totalCount: matchSummary.totalCount ?? (nodes || []).filter((n) => n.nodeType === "ACCOUNT").length,
    };
  }
  const accounts = (nodes || []).filter((n) => n.nodeType === "ACCOUNT");
  return {
    documentMatchedCount: accounts.filter((n) => n.classificationSource === "DOCUMENT").length,
    aiFallbackCount: accounts.filter((n) => n.classificationSource === "AI_FALLBACK").length,
    needsMappingCount: accounts.filter((n) => n.needsMapping).length,
    totalCount: accounts.length,
  };
}
