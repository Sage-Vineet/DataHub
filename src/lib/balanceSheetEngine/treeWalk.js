// Tree-first structural inference for the Balance Sheet Normalization Engine.
//
// This is where Layers 1 and 8 of the priority order live:
//   Layer 1 — Existing hierarchy: an ancestor (or the node itself) already
//             names a recognized structural wrapper or canonical category,
//             so we trust the source's own placement instead of re-deriving it.
//   Layer 8 — Section totals as structural boundaries: when there is no
//             wrapper header but the sibling list contains an inline
//             "Total Current Assets" / "Total Fixed Assets" style marker,
//             that total is a boundary — everything above it belongs to the
//             subsection it names.
//
// The tree is NEVER flattened first. We walk parent → children, carrying
// forward whatever the ancestry has already told us, and we stop descending
// the moment we reach a node that is either (a) an already-correctly-placed
// account/category — its subtree is taken wholesale, untouched — or (b) a
// dead end with no further structural signal, in which case it is handed to
// the per-account classifier layers (classifiers.js) as an open item.

import {
  SECTION,
  CATEGORIES_BY_SECTION,
  ASSETS_ROOT_SYNONYMS,
  LIABILITIES_ROOT_SYNONYMS,
  EQUITY_ROOT_SYNONYMS,
  CURRENT_ASSETS_WRAPPER_SYNONYMS,
  NONCURRENT_ASSETS_WRAPPER_SYNONYMS,
  CURRENT_LIABILITIES_WRAPPER_SYNONYMS,
  LONGTERM_LIABILITIES_WRAPPER_SYNONYMS,
} from "./canonical.js";

export function normalizeLabel(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function isTotalNode(node, normName) {
  const n = normName !== undefined ? normName : normalizeLabel(node?.name);
  return node?.type === "total" || /^total\b/.test(n);
}

function matchesAny(norm, list) {
  return list.includes(norm);
}

// Several wrapper synonyms ("Fixed Assets", "Other Assets", "Other
// Liabilities") are ALSO valid category labels in their own right. A node is
// only a wrapper to dissolve when it actually has children to recurse into
// — a bare leaf that happens to share a wrapper's name (e.g. a company that
// posts directly to a single "Fixed Assets" account, with no children at
// all) must be treated as an item, never dissolved into nothing.
function hasChildren(node) {
  return Array.isArray(node?.children) && node.children.length > 0;
}

/** Layer 1 (root form): what top-level section does this wrapper name represent? */
export function detectRootSection(norm) {
  if (matchesAny(norm, ASSETS_ROOT_SYNONYMS)) return SECTION.ASSETS;
  if (matchesAny(norm, LIABILITIES_ROOT_SYNONYMS)) return SECTION.LIABILITIES;
  if (matchesAny(norm, EQUITY_ROOT_SYNONYMS)) return SECTION.EQUITY;
  if (/liabilit/.test(norm) && /equity/.test(norm)) return "liabilities-and-equity";
  return null;
}

/** Layer 1 (subsection form): does this wrapper name a Current/Non-Current/Long-Term scope? */
export function detectSubsectionWrapper(norm, section) {
  if (section === SECTION.ASSETS) {
    if (matchesAny(norm, CURRENT_ASSETS_WRAPPER_SYNONYMS)) return "current";
    if (matchesAny(norm, NONCURRENT_ASSETS_WRAPPER_SYNONYMS)) return "noncurrent";
  }
  if (section === SECTION.LIABILITIES) {
    if (matchesAny(norm, CURRENT_LIABILITIES_WRAPPER_SYNONYMS)) return "current";
    if (matchesAny(norm, LONGTERM_LIABILITIES_WRAPPER_SYNONYMS)) return "longterm";
  }
  return null;
}

/**
 * Layer 1 (self form): the node's OWN name already IS one of our canonical
 * category labels (optionally followed by a formatting suffix like
 * "(A/R)"). This is a narrow prefix match against our own vocabulary — not
 * the broad synonym/keyword fuzzy matching used by Layer 11 — so it only
 * ever fires when the source already used our terminology verbatim.
 */
export function detectSelfCategoryLabel(name, section, hintSubsection) {
  const norm = normalizeLabel(name);
  if (!norm) return null;
  const categories = CATEGORIES_BY_SECTION[section] || [];
  for (const cat of categories) {
    if (hintSubsection && cat.subsection !== hintSubsection) continue;
    const labelNorm = normalizeLabel(cat.label);
    if (norm === labelNorm || norm.startsWith(`${labelNorm} `)) {
      return { label: cat.label, subsection: cat.subsection };
    }
  }
  return null;
}

/** Layer 8: what subsection does an inline "Total X" boundary marker represent? */
function detectTotalBoundaryMeaning(norm, section) {
  const stripped = norm.replace(/^total\s+/, "");
  return detectSubsectionWrapper(stripped, section);
}

/**
 * Layer 8: scan a sibling list for inline total markers (no wrapper header
 * present) and assign every node ABOVE a recognized boundary the subsection
 * that boundary names. Nodes after the last recognized boundary (or when no
 * boundary is found at all) get no hint here — they fall through to the
 * per-account classifier layers.
 */
function computeInlineBoundaryHints(nodes, section) {
  const hints = new Array(nodes.length).fill(null);
  let scanStart = 0;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node) continue;
    const norm = normalizeLabel(node.name);
    if (!isTotalNode(node, norm)) continue;
    const meaning = detectTotalBoundaryMeaning(norm, section);
    if (meaning) {
      for (let j = scanStart; j < i; j++) hints[j] = meaning;
      scanStart = i + 1;
    }
  }
  return hints;
}

/**
 * Walks the full Balance Sheet tree top-down and returns every classifiable
 * item bucketed by top-level section, each carrying whatever the tree
 * structure has already told us (subsectionHint / categoryHint). Total
 * nodes are dropped everywhere (they are regenerated fresh by the engine).
 * Unrecognized top-level nodes are silently skipped here — engine.js's
 * validation pass is responsible for ensuring nothing this walk missed is
 * ever lost.
 */
export function collectItems(rows) {
  const acc = { [SECTION.ASSETS]: [], [SECTION.LIABILITIES]: [], [SECTION.EQUITY]: [] };
  let scopeCounter = 0;

  function walk(nodes, section, subsectionHint) {
    const list = Array.isArray(nodes) ? nodes : [];
    const scopeId = scopeCounter++; // every sibling list is one "neighboring accounts" scope (Layer 9)
    const boundaryHints =
      subsectionHint == null && (section === SECTION.ASSETS || section === SECTION.LIABILITIES)
        ? computeInlineBoundaryHints(list, section)
        : null;

    list.forEach((node, idx) => {
      if (!node || typeof node !== "object") return;
      const norm = normalizeLabel(node.name);
      if (!norm) return;
      if (isTotalNode(node, norm)) return;

      if (section === null) {
        const root = detectRootSection(norm);
        if (hasChildren(node) && (root === SECTION.ASSETS || root === SECTION.LIABILITIES || root === SECTION.EQUITY)) {
          walk(node.children, root, null);
          return;
        }
        if (hasChildren(node) && root === "liabilities-and-equity") {
          walk(node.children, null, null);
          return;
        }
        return; // Unrecognized (or childless) top-level node — left for the engine's safety net.
      }

      const wrapperHint = hasChildren(node) ? detectSubsectionWrapper(norm, section) : null;
      if (wrapperHint) {
        walk(node.children, section, wrapperHint);
        return;
      }

      const effectiveHint = subsectionHint || (boundaryHints ? boundaryHints[idx] : null);
      const selfCategory = detectSelfCategoryLabel(node.name, section, effectiveHint);

      acc[section].push({
        node,
        section,
        scopeId,
        subsectionHint: effectiveHint || (selfCategory ? selfCategory.subsection : null),
        categoryHint: selfCategory ? selfCategory.label : null,
        meta: node.meta || {},
      });
    });
  }

  walk(rows, null, null);
  return acc;
}
