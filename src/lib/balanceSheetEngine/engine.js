// Balance Sheet Normalization Engine — orchestrator.
//
// Runs the full priority chain from the tree walk (Layers 1 & 8) through the
// deterministic per-account layers (2–7, 9, 11), the historical cache
// (Layer 10), and — only via the async entry point — AI (Layer 12). Builds
// the mandated GAAP tree from the results, then validates that every
// original account survived exactly once, repairing automatically if not.
//
// Public API:
//   restructureBalanceSheetTree(rows, options)        — sync, Layers 1–11
//   restructureBalanceSheetTreeAsync(rows, options)    — adds Layer 12 (AI)

import { collectItems, isTotalNode } from "./treeWalk.js";
import {
  METADATA_LAYERS,
  classifyByParentAccount,
  classifyByAccountNumber,
  classifyByNeighbors,
  classifyByLexicon,
  detectContra,
} from "./classifiers.js";
import { createHistoryCache, historyCacheKey } from "./historyCache.js";
import { noopAIClassifier, runAIClassificationLayer } from "./aiClassifier.js";
import { SECTION, CATEGORY_ORDER_BY_SECTION, OTHER_CATEGORY_BY_SECTION_SUBSECTION } from "./canonical.js";

// ─── Small tree-building utilities ─────────────────────────────────────────

function slug(label) {
  return String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
}

function sumNodeAmounts(nodes) {
  let hasAmount = false;
  let amount = 0;
  let hasAmounts = false;
  const amounts = {};
  for (const n of nodes || []) {
    if (typeof n?.amount === "number") {
      hasAmount = true;
      amount += n.amount;
    }
    if (n?.amounts && typeof n.amounts === "object") {
      hasAmounts = true;
      for (const [key, value] of Object.entries(n.amounts)) {
        amounts[key] = (amounts[key] || 0) + (Number(value) || 0);
      }
    }
  }
  const result = {};
  if (hasAmount) result.amount = amount;
  if (hasAmounts) result.amounts = amounts;
  return result;
}

function makeTotalRow(label, totals) {
  return { id: `bse-total-${slug(label)}`, name: `Total ${label}`, type: "total", ...totals };
}

function buildWrapper(label, idSlug, children) {
  if (!children.length) return null;
  const totals = sumNodeAmounts(children);
  return { id: `bse-${idSlug}`, name: label, type: "header", ...totals, children: [...children, makeTotalRow(label, totals)] };
}

// Returns the SAME node reference when nothing actually needed reordering —
// this matters beyond a minor allocation saving: validateAndRepair below
// tracks originally-collected item nodes by reference, and an already
// well-formed preserved subtree (e.g. a source "Bank Accounts" group whose
// total was already last) must keep its identity or every account inside it
// would look "lost" to that check.
function reorderTotalsToEnd(node) {
  if (!node || !Array.isArray(node.children) || !node.children.length) return node;
  const nonTotal = [];
  const totals = [];
  for (const child of node.children) {
    (isTotalNode(child) ? totals : nonTotal).push(child);
  }
  const reordered = [...nonTotal, ...totals].map(reorderTotalsToEnd);
  const unchanged = reordered.length === node.children.length && reordered.every((c, i) => c === node.children[i]);
  return unchanged ? node : { ...node, children: reordered };
}

// ─── Phase 2 — deterministic per-account layers 2–6 (metadata-based) ──────

function resolveMetadataLayers(items, accountNumberRanges) {
  const resolvedByAccountId = new Map();

  // Pass A: order-independent metadata layers (2 CoA metadata, 3 Account
  // Type, 4 Account Subtype). Each may narrow the subsection without yet
  // finding a specific category — keep trying subsequent layers, but never
  // let a later layer override a subsection already narrowed by an earlier
  // (higher-priority) one.
  for (const item of items) {
    if (item.categoryHint) continue; // already resolved by Layer 1 (existing hierarchy)
    for (const layer of METADATA_LAYERS) {
      const result = layer.run(item);
      if (!result) continue;
      if (result.subsection && !item.subsectionHint) item.subsectionHint = result.subsection;
      if (result.label) {
        item.categoryHint = result.label;
        item.subsectionHint = result.subsection;
        item._classifiedBy = layer.name;
        break;
      }
    }
    const accountId = item.meta?.accountId;
    if (item.categoryHint && accountId) {
      resolvedByAccountId.set(String(accountId), { label: item.categoryHint, subsection: item.subsectionHint });
    }
  }

  // Pass B — Layer 5 (Parent Account): depends on Pass A's results.
  for (const item of items) {
    if (item.categoryHint) continue;
    const result = classifyByParentAccount(item, resolvedByAccountId);
    if (result?.label) {
      item.categoryHint = result.label;
      item.subsectionHint = result.subsection;
      item._classifiedBy = "parent-account";
    } else if (result?.subsection && !item.subsectionHint) {
      item.subsectionHint = result.subsection;
    }
  }

  // Pass C — Layer 6 (Account Number).
  for (const item of items) {
    if (item.categoryHint) continue;
    const result = classifyByAccountNumber(item, accountNumberRanges);
    if (result?.subsection && !item.subsectionHint) {
      item.subsectionHint = result.subsection;
      item._classifiedBy = item._classifiedBy || "account-number";
    }
  }
}

// ─── Phase 3 — Layer 9 (neighboring accounts), scoped to sibling groups ───

function resolveNeighborLayer(bySection) {
  // Explicit section keys only — bySection may also carry an `unrecognized`
  // list of raw (non-item-shaped) nodes that this phase must never touch.
  for (const items of [bySection[SECTION.ASSETS], bySection[SECTION.LIABILITIES], bySection[SECTION.EQUITY]]) {
    const byScope = new Map();
    for (const item of items) {
      if (!byScope.has(item.scopeId)) byScope.set(item.scopeId, []);
      byScope.get(item.scopeId).push(item);
    }
    for (const scopeItems of byScope.values()) {
      const unresolved = scopeItems.filter((i) => !i.categoryHint);
      if (!unresolved.length) continue;
      const resolvedSiblings = scopeItems
        .filter((i) => i.categoryHint)
        .map((i) => ({ label: i.categoryHint, subsection: i.subsectionHint }));
      if (!resolvedSiblings.length) continue;

      for (const item of unresolved) {
        // Defer to the item's own accounting terminology when it has any —
        // neighbor context is a tiebreaker for genuinely unnamed/ambiguous
        // accounts, never an override for one with a clear signal of its own.
        if (classifyByLexicon(item)) continue;

        // Never cross a subsection boundary that a higher-priority layer
        // (existing hierarchy / section totals / metadata) already
        // established for THIS item — a resolved neighbor from a different
        // subsection is not evidence about this one.
        const compatible = resolvedSiblings.filter((s) => !item.subsectionHint || s.subsection === item.subsectionHint);
        const result = classifyByNeighbors(compatible);
        if (result?.label) {
          item.categoryHint = result.label;
          item.subsectionHint = result.subsection;
          item._classifiedBy = "neighboring-accounts";
        }
      }
    }
  }
}

// ─── Phase 4 — Layer 10 (historical classification) ───────────────────────

function resolveHistoryLayer(allItems, cache) {
  for (const item of allItems) {
    if (item.categoryHint) continue;
    const key = historyCacheKey(item.node?.name, item.meta);
    const cached = cache.get(key);
    if (cached?.label) {
      item.categoryHint = cached.label;
      item.subsectionHint = cached.subsection;
      item._classifiedBy = "historical-classification";
    }
  }
}

// ─── Phase 5 — Layer 11 (lexicon), the last deterministic resort ─────────

function resolveLexiconLayer(allItems) {
  for (const item of allItems) {
    if (item.categoryHint) continue;
    const result = classifyByLexicon(item);
    if (result?.label) {
      item.categoryHint = result.label;
      item.subsectionHint = result.subsection;
      item._classifiedBy = "lexicon";
    }
  }
}

// ─── Final catch-all + contra flagging (never leaves an account unplaced) ─

function finalizeItem(item) {
  if (!item.categoryHint) {
    const subsection = item.subsectionHint || (item.section === SECTION.EQUITY ? null : "current");
    const key = `${item.section}.${subsection ?? "null"}`;
    item.categoryHint = OTHER_CATEGORY_BY_SECTION_SUBSECTION[key] || "Other Equity";
    item.subsectionHint = subsection;
    item._classifiedBy = item._classifiedBy || "unclassified-catchall";
  }
  item.isContra = detectContra(item);
}

// ─── Tree assembly from classified items ──────────────────────────────────

function materializeCategoryEntries(label, entries) {
  const ordered = [...entries].sort((a, b) => Number(a.isContra) - Number(b.isContra));
  const nodes = ordered.map((e) => e.node);
  if (nodes.length === 1) return nodes[0];
  const totals = sumNodeAmounts(nodes);
  return {
    id: `bse-cat-${slug(label)}`,
    name: label,
    type: "header",
    ...totals,
    children: [...nodes, makeTotalRow(label, totals)],
  };
}

function materializeCategories(map, order) {
  const out = [];
  const consumed = new Set();
  for (const label of order) {
    const entries = map.get(label);
    if (!entries?.length) continue;
    consumed.add(label);
    out.push(materializeCategoryEntries(label, entries));
  }
  // Defense in depth: a category label that isn't in the canonical order
  // (should never happen, but a bug here must never silently drop accounts)
  // is still emitted, just appended at the end of its subsection.
  for (const [label, entries] of map.entries()) {
    if (consumed.has(label) || !entries?.length) continue;
    out.push(materializeCategoryEntries(label, entries));
  }
  return out;
}

function buildSectionTree(items, section) {
  items.forEach(finalizeItem);

  if (section === SECTION.EQUITY) {
    const byCategory = new Map();
    for (const item of items) {
      if (!byCategory.has(item.categoryHint)) byCategory.set(item.categoryHint, []);
      byCategory.get(item.categoryHint).push(item);
    }
    const children = materializeCategories(byCategory, CATEGORY_ORDER_BY_SECTION[SECTION.EQUITY]);
    return buildWrapper("Equity", "equity", children);
  }

  const bySubsection = { current: new Map(), noncurrent: new Map(), longterm: new Map() };
  for (const item of items) {
    const sub = item.subsectionHint || "current";
    const map = bySubsection[sub] || bySubsection.current;
    if (!map.has(item.categoryHint)) map.set(item.categoryHint, []);
    map.get(item.categoryHint).push(item);
  }

  const order = CATEGORY_ORDER_BY_SECTION[section];
  if (section === SECTION.ASSETS) {
    const currentWrapper = buildWrapper("Current Assets", "current-assets", materializeCategories(bySubsection.current, order));
    const nonCurrentWrapper = buildWrapper("Non-Current Assets", "noncurrent-assets", materializeCategories(bySubsection.noncurrent, order));
    return buildWrapper("Assets", "assets", [currentWrapper, nonCurrentWrapper].filter(Boolean));
  }

  const currentWrapper = buildWrapper("Current Liabilities", "current-liabilities", materializeCategories(bySubsection.current, order));
  const longTermWrapper = buildWrapper("Long-Term Liabilities", "longterm-liabilities", materializeCategories(bySubsection.longterm, order));
  return buildWrapper("Liabilities", "liabilities", [currentWrapper, longTermWrapper].filter(Boolean));
}

function assembleTree(bySection) {
  const assetsSection = buildSectionTree(bySection[SECTION.ASSETS], SECTION.ASSETS);
  const liabilitiesSection = buildSectionTree(bySection[SECTION.LIABILITIES], SECTION.LIABILITIES);
  const equitySection = buildSectionTree(bySection[SECTION.EQUITY], SECTION.EQUITY);

  const output = [];
  if (assetsSection) output.push(assetsSection);
  if (liabilitiesSection) output.push(liabilitiesSection);
  if (equitySection) output.push(equitySection);

  const leParts = [liabilitiesSection, equitySection].filter(Boolean);
  if (leParts.length) output.push(makeTotalRow("Liabilities & Equity", sumNodeAmounts(leParts)));

  return output.map(reorderTotalsToEnd);
}

// ─── Validation & automatic repair ─────────────────────────────────────────

function collectNodeSet(tree) {
  const set = new Set();
  (function visit(nodes) {
    for (const n of nodes || []) {
      set.add(n);
      if (Array.isArray(n.children)) visit(n.children);
    }
  })(tree);
  return set;
}

/**
 * Guarantees "every original account exists exactly once". By construction
 * every collected item is placed into exactly one category bucket, so this
 * should always pass — it exists as defense in depth against future bugs,
 * never as the primary placement mechanism.
 */
function validateAndRepair(allItems, tree) {
  const nodeSet = collectNodeSet(tree);
  const missing = allItems.filter((item) => !nodeSet.has(item.node));
  if (!missing.length) return { ok: true, repaired: [], tree };

  console.warn(
    `[BalanceSheetEngine] ${missing.length} account(s) were not placed by the normal build — repairing into an Unclassified bucket:`,
    missing.map((m) => m.node?.name),
  );
  const missingNodes = missing.map((m) => m.node);
  const totals = sumNodeAmounts(missingNodes);
  const bucket = {
    id: "bse-unclassified",
    name: "Unclassified",
    type: "header",
    ...totals,
    children: [...missingNodes, makeTotalRow("Unclassified", totals)],
  };

  const hasTrailingTotal = tree.length > 0 && isTotalNode(tree[tree.length - 1]);
  const repairedTree = hasTrailingTotal ? [...tree.slice(0, -1), bucket, tree[tree.length - 1]] : [...tree, bucket];

  return { ok: false, repaired: missing.map((m) => m.node?.name || "(unnamed)"), tree: repairedTree };
}

// ─── Shared deterministic pipeline (Layers 1–11) ───────────────────────────

function runDeterministicPhases(rows, options) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;

  const bySection = collectItems(list);
  const classifiedItems = [...bySection[SECTION.ASSETS], ...bySection[SECTION.LIABILITIES], ...bySection[SECTION.EQUITY]];
  // Nodes the walk couldn't place under any section at all (e.g. an upstream
  // bug left one as a stray sibling instead of nested where it belongs).
  // They skip classification entirely — there's no section to classify them
  // INTO — but they still ride along into `allItems` purely so validation
  // catches them as "missing" from the final tree and repairs them into the
  // Unclassified bucket, instead of the alternative: silently vanishing.
  const unrecognizedItems = (bySection.unrecognized || []).map((node) => ({ node }));
  const allItems = [...classifiedItems, ...unrecognizedItems];
  if (!allItems.length) return null;

  classifiedItems.forEach((item) => {
    if (item.categoryHint) item._classifiedBy = "existing-hierarchy";
  });

  const cache = options.historyCache || createHistoryCache({ scope: options.cacheScope });

  resolveMetadataLayers(classifiedItems, options.accountNumberRanges); // Layers 2–6
  resolveNeighborLayer(bySection); // Layer 9
  resolveHistoryLayer(classifiedItems, cache); // Layer 10
  resolveLexiconLayer(classifiedItems); // Layer 11

  return { list, bySection, allItems, cache };
}

function finalizeFromState(state) {
  const { list, bySection, allItems } = state;
  const tree = assembleTree(bySection);
  const { tree: finalTree, ok, repaired } = validateAndRepair(allItems, tree);
  return { tree: finalTree, list, ok, repaired };
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Reorganizes a Balance Sheet row tree into the mandated GAAP presentation
 * order using Layers 1–11 (every deterministic signal — existing hierarchy,
 * Chart of Accounts metadata, account type/subtype, parent account, account
 * number, normal balance, section totals, neighboring accounts, historical
 * cache, and the multi-region lexicon fallback). Never changes an account
 * name or dollar amount — only where each node sits in the tree. Falls back
 * to the original rows on any unexpected input shape or internal error, so
 * a classification miss can never hide data.
 *
 * Pass `options.historyCache` / `options.cacheScope` to control Layer 10's
 * persistence, and `options.accountNumberRanges` to override Layer 6's
 * default Chart-of-Accounts numbering scheme for a specific company.
 */
export function restructureBalanceSheetTree(rows, options = {}) {
  try {
    const state = runDeterministicPhases(rows, options);
    if (!state) return Array.isArray(rows) ? rows : [];
    return finalizeFromState(state).tree;
  } catch (err) {
    console.warn("[BalanceSheetEngine] Normalization skipped due to an error:", err);
    return Array.isArray(rows) ? rows : [];
  }
}

/**
 * Same as `restructureBalanceSheetTree`, but adds Layer 12 (AI) for any
 * account still unresolved after Layers 1–11 — genuinely the last resort.
 * Pass `options.classifyWithAI` to wire a real model call; without it, AI
 * is a no-op and unresolved accounts land in the "Other <Section>"
 * catch-all exactly as the sync engine does. Every confident AI result is
 * written to the history cache (Layer 10) so it is never requested twice.
 */
export async function restructureBalanceSheetTreeAsync(rows, options = {}) {
  try {
    const state = runDeterministicPhases(rows, options);
    if (!state) return Array.isArray(rows) ? rows : [];

    // `item.section` excludes the orphaned, section-less items described
    // above (see runDeterministicPhases) — AI has no section to classify
    // them into, and any result couldn't be placed in the tree anyway, so
    // sending them would just waste a call. They still get surfaced via the
    // Unclassified repair bucket in finalizeFromState below.
    const stillUnresolved = state.allItems.filter((item) => !item.categoryHint && item.section);
    if (stillUnresolved.length) {
      const classifyWithAI = options.classifyWithAI || noopAIClassifier;
      const aiResults = await runAIClassificationLayer(stillUnresolved, classifyWithAI, state.cache, historyCacheKey);
      for (const item of stillUnresolved) {
        const key = historyCacheKey(item.node?.name, item.meta);
        const result = aiResults.get(key);
        if (result?.label) {
          item.categoryHint = result.label;
          item.subsectionHint = result.subsection;
          item._classifiedBy = "ai-classification";
        }
      }
    }

    return finalizeFromState(state).tree;
  } catch (err) {
    console.warn("[BalanceSheetEngine] Async normalization skipped due to an error:", err);
    return Array.isArray(rows) ? rows : [];
  }
}

/** Exposed for testing/debugging: run the deterministic pipeline and inspect per-item classification sources without building the final tree. */
export function classifyForInspection(rows, options = {}) {
  const state = runDeterministicPhases(rows, options);
  if (!state) return [];
  state.allItems.forEach(finalizeItem);
  return state.allItems.map((item) => ({
    name: item.node?.name,
    section: item.section,
    subsection: item.subsectionHint,
    category: item.categoryHint,
    isContra: item.isContra,
    classifiedBy: item._classifiedBy || "unclassified-catchall",
  }));
}
