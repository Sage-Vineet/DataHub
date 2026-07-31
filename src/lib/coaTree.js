// Client-side Chart of Accounts tree utilities â€” mirrors the backend's
// buildCoaNodeTree/validateCoaNodeTree
// path-space checks, so the tree editor can recompute the tree and validate a
// draft instantly (no round-trip per edit). The backend re-validates
// authoritatively on Save regardless (saveHierarchy) â€” this is UX feedback,
// not the enforcement point.

export const MAX_HIERARCHY_LEVELS = 15;

export function normName(s) {
  return String(s || "").trim().toLowerCase();
}

function normPathKey(pathArr) {
  return (pathArr || []).map(normName).join(" > ");
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
 * Every distinct existing category path in the current draft â€” the pickable
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

  // Mirrors the backend's validateCoaNodeTree fix exactly: `nodes` holds ONLY
  // synthesized GROUP keys (built from path.slice(0, -1)) and
  // `leavesByFullPath` holds ONLY ACCOUNT keys. Keying both on the same bare
  // normPathKey let a group and a posting account "collide" as plain strings
  // even though they are different node types â€” e.g. the P&L anchor's
  // "Net Income" group at
  // "Total Liabilities and Equity > Total Equity > Net Income" and the
  // synthetic equity "Net Income" leaf at that same path. That is legitimate,
  // and the server accepts it; without this fix the grid would show a
  // client-side validation error for a draft the server would happily commit.
  // Namespacing the two key-spaces makes the cross-type case impossible while
  // still catching a genuine same-type conflict (already covered above by the
  // duplicate-structural-node and duplicate-leaf-path checks).
  const GROUP_NS = "group::";
  const ACCOUNT_NS = "account::";
  const structuralPathKeys = new Set(Array.from(nodes.keys(), (k) => `${GROUP_NS}${k}`));
  const leafPathKeys = new Set(Array.from(leavesByFullPath.keys(), (k) => `${ACCOUNT_NS}${k}`));
  let leafUsedAsParentCount = 0;
  for (const tagged of structuralPathKeys) {
    if (!leafPathKeys.has(tagged)) continue;
    leafUsedAsParentCount += 1;
    const key = tagged.slice(GROUP_NS.length);
    const node = nodes.get(key);
    const offending = leavesByFullPath.get(key) || [];
    violations.push(
      `"${node.pathArr.join(" > ")}" is a posting account (${offending.map(displayName).join(", ")}) but would also become a parent category.`,
    );
  }

  // Diagnostic only, never a violation â€” a group and an account may share a label.
  let groupAccountLabelCollisions = 0;
  for (const key of nodes.keys()) if (leavesByFullPath.has(key)) groupAccountLabelCollisions += 1;

  let depthExceededCount = 0;
  for (const leaf of flat) {
    const depth = (leaf.levels || []).filter(Boolean).length;
    if (depth > MAX_HIERARCHY_LEVELS) {
      depthExceededCount += 1;
      violations.push(`${displayName(leaf)}'s hierarchy is ${depth} levels deep â€” exceeds the maximum of ${MAX_HIERARCHY_LEVELS}.`);
    }
  }

  return {
    hierarchyValid: duplicateStructuralNodes === 0 && duplicateLeafPaths === 0
      && leafUsedAsParentCount === 0 && depthExceededCount === 0,
    duplicateStructuralNodes, duplicateLeafPaths, leafUsedAsParentCount, depthExceededCount,
    groupAccountLabelCollisions, violations,
  };
}