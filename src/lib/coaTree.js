// Client-side Chart of Accounts tree utilities — mirrors the backend's
// buildTree (chartOfAccountsService.js) and buildCoaNodeTree/validateCoaNodeTree
// path-space checks, so the tree editor can recompute the tree and validate a
// draft instantly (no round-trip per edit). The backend re-validates
// authoritatively on Save regardless (saveHierarchy) — this is UX feedback,
// not the enforcement point.

export const MAX_HIERARCHY_LEVELS = 15;

export function normName(s) {
  return String(s || "").trim().toLowerCase();
}

function normPathKey(pathArr) {
  return (pathArr || []).map(normName).join(" > ");
}

// Stable ordering for the standardized top levels; everything else alpha.
const LEVEL_ORDER = new Map([
  ["Total Liabilities and Equity", 1], ["Total Assets", 2],
  ["Assets", 1], ["Liabilities", 2], ["Equity", 3],
  ["Revenue", 4], ["Cost of Goods Sold", 5], ["Operating Expenses", 6],
]);

function leafNode(acct, level) {
  return {
    id: acct.id,
    accountId: acct.id,
    name: acct.accountName || acct.adjustedName || acct.sourceName,
    isGroup: false,
    level: level || ((acct.levels || []).filter(Boolean).length || 1),
    accountNumber: acct.accountNumber,
    accountType: acct.accountType,
    statementType: acct.statementType,
    hierarchyPath: acct.hierarchyPath,
    classificationMethod: acct.classificationMethod,
    isActive: acct.isActive,
    modified: acct.modified,
    pendingEdit: acct.pendingEdit,
    levels: acct.levels,
    originalName: acct.originalName,
    adjustedName: acct.adjustedName,
    metadata: acct.metadata,
    children: [],
  };
}

/** Build a nested tree from the flat leaf list — same shape/logic as the backend's buildTree. */
export function buildTree(flatRows) {
  const root = { children: [], childIndex: new Map() };

  for (const acct of flatRows) {
    const path = (acct.levels || []).filter(Boolean);
    if (!path.length) {
      root.children.push(leafNode(acct));
      continue;
    }
    let node = root;
    for (let i = 0; i < path.length - 1; i += 1) {
      const label = path[i];
      const idxKey = normName(label);
      let child = node.childIndex.get(idxKey);
      if (!child) {
        child = {
          id: `cat:${node.id || "root"}/${label}`,
          name: label,
          isGroup: true,
          level: i + 1,
          pathArr: path.slice(0, i + 1),
          statementType: acct.statementType,
          children: [],
          childIndex: new Map(),
        };
        node.childIndex.set(idxKey, child);
        node.children.push(child);
      }
      node = child;
    }
    node.children.push(leafNode(acct, path.length));
  }

  const finalize = (n) => {
    if (n.children) {
      n.children.sort((a, b) => {
        if (a.isGroup !== b.isGroup) return a.isGroup ? -1 : 1;
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

/** Collapse consecutive duplicate labels (the leaf-padding display convention). */
export function collapsePath(levelsArr) {
  const raw = (levelsArr || []).filter(Boolean);
  const out = [];
  for (const v of raw) {
    if (!out.length || out[out.length - 1] !== v) out.push(v);
  }
  return out;
}

/**
 * The single primitive behind rename / move / merge: relabel every leaf
 * whose path starts with oldPrefixArr, substituting newPrefixArr for that
 * prefix and keeping the remainder (including the leaf's own name) intact.
 * Pass a leaf's OWN FULL path as oldPrefixArr to move just that one leaf.
 */
export function computeDescendantRelabel(flat, oldPrefixArr, newPrefixArr) {
  const oldKey = (oldPrefixArr || []).map(normName);
  const patches = [];
  for (const leaf of flat) {
    const path = (leaf.levels || []).filter(Boolean);
    if (path.length < oldKey.length) continue;
    let matches = true;
    for (let i = 0; i < oldKey.length; i += 1) {
      if (normName(path[i]) !== oldKey[i]) { matches = false; break; }
    }
    if (!matches) continue;
    const remainder = path.slice(oldKey.length);
    const newPath = [...newPrefixArr, ...remainder].slice(0, MAX_HIERARCHY_LEVELS);
    if (newPath.join(" > ") === path.join(" > ")) continue;
    patches.push({ accountId: leaf.id, levels: newPath });
  }
  return patches;
}

/**
 * Every distinct existing category path in the current draft — the pickable
 * "Move to..." target list, extended with whatever new path the user types.
 */
export function collectCategoryOptions(flat) {
  const byPath = new Map();
  for (const row of flat) {
    if (row.metadata?.needs_mapping) continue;
    const deduped = collapsePath(row.levels);
    if (deduped.length < 2) continue;
    const categoryLevels = deduped.slice(0, -1);
    const key = categoryLevels.join(" > ");
    if (!byPath.has(key)) byPath.set(key, categoryLevels);
  }
  return Array.from(byPath.entries())
    .map(([path, levels]) => ({ path, levels }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Client-side mirror of the backend's buildCoaNodeTree + validateCoaNodeTree
 * path-space checks. Instant feedback while editing a draft; the backend
 * (saveHierarchy) re-validates authoritatively and is the real gate.
 */
export function validateDraftTree(flat) {
  const violations = [];
  const displayName = (l) => l.accountName || l.adjustedName || l.sourceName || l.id;

  const nodes = new Map();
  for (const leaf of flat) {
    const path = (leaf.levels || []).filter(Boolean);
    if (path.length <= 1) continue;
    const catLabels = path.slice(0, -1);
    for (let i = 0; i < catLabels.length; i += 1) {
      const prefixArr = catLabels.slice(0, i + 1);
      const key = normPathKey(prefixArr);
      if (!nodes.has(key)) {
        nodes.set(key, {
          pathArr: prefixArr,
          label: prefixArr[prefixArr.length - 1],
          parentKey: i === 0 ? null : normPathKey(prefixArr.slice(0, -1)),
        });
      }
    }
  }

  const seenByParentLabel = new Map();
  let duplicateStructuralNodes = 0;
  for (const [key, node] of nodes) {
    const dupKey = `${node.parentKey || "<root>"}::${normName(node.label)}`;
    if (seenByParentLabel.has(dupKey)) duplicateStructuralNodes += 1;
    else seenByParentLabel.set(dupKey, key);
  }

  const leavesByFullPath = new Map();
  for (const leaf of flat) {
    const path = (leaf.levels || []).filter(Boolean);
    if (!path.length) continue;
    const key = normPathKey(path);
    if (!leavesByFullPath.has(key)) leavesByFullPath.set(key, []);
    leavesByFullPath.get(key).push(leaf);
  }
  let duplicateLeafPaths = 0;
  for (const [, group] of leavesByFullPath) {
    if (group.length > 1) {
      duplicateLeafPaths += 1;
      violations.push(
        `${group.map(displayName).join(" and ")} would resolve to the identical hierarchy path "${(group[0].levels || []).filter(Boolean).join(" > ")}".`,
      );
    }
  }

  let leafUsedAsParentCount = 0;
  for (const key of nodes.keys()) {
    if (leavesByFullPath.has(key)) {
      leafUsedAsParentCount += 1;
      const node = nodes.get(key);
      const offending = leavesByFullPath.get(key) || [];
      violations.push(
        `"${node.pathArr.join(" > ")}" is a posting account (${offending.map(displayName).join(", ")}) but would also become a parent category.`,
      );
    }
  }

  let depthExceededCount = 0;
  for (const leaf of flat) {
    const depth = (leaf.levels || []).filter(Boolean).length;
    if (depth > MAX_HIERARCHY_LEVELS) {
      depthExceededCount += 1;
      violations.push(`${displayName(leaf)}'s hierarchy is ${depth} levels deep — exceeds the maximum of ${MAX_HIERARCHY_LEVELS}.`);
    }
  }

  return {
    hierarchyValid: duplicateStructuralNodes === 0 && duplicateLeafPaths === 0
      && leafUsedAsParentCount === 0 && depthExceededCount === 0,
    duplicateStructuralNodes, duplicateLeafPaths, leafUsedAsParentCount, depthExceededCount,
    violations,
  };
}
