import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import {
  RefreshCw, Loader2, Table2, Check, X, Pencil, RotateCcw, Search, Undo2, Redo2, Download,
  FolderInput, GitMerge, Sparkles, Save, AlertTriangle, GripVertical,
  ChevronRight, ChevronDown, ChevronsDown, ChevronsUp, FolderPlus, Trash2, ListChecks, ArrowRightLeft,
} from "lucide-react";
import {
  getChartOfAccounts, regenerateChartOfAccounts, resetChartOfAccount, resetChartOfAccounts,
} from "../../lib/api";
import { approveCoa } from "../../lib/keyReportGeneration";
import {
  buildIndexes, getLevelsArray, getHierarchyPathLabel, listCategoryNodes,
  applyAccountEdit, mergeCategory, validateTree, summarizeClassification,
  moveAccountToParent, renameNode, moveNode, createCategory, deleteCategory,
  getSubtreeKeys, getRootAnchorKey, getMoveTargetsForCategory, diffCoaTrees,
  CLASSIFICATION_SOURCE_LABELS, MAX_HIERARCHY_LEVELS, displayName,
} from "../../lib/coaTree";
import { clearCachedFinancials } from "../../lib/keyReportFinancials";
import { useHierarchyRecommendations } from "../../hooks/useHierarchyRecommendations";
import RecommendedChangesPanel from "./RecommendedChangesPanel";
import CreateParentModal from "./CreateParentModal";
import Modal from "../common/Modal";

const STATEMENT_LABELS = { balance_sheet: "Balance Sheet", profit_loss: "P&L" };
const METHOD_LABELS = {
  rule: "Rule", gemini: "AI", hybrid: "AI+Rules", manual: "Manual", manual_review: "Manual",
  ai_hierarchy: "AI (full hierarchy)", document_hierarchy: "Document",
  client_workbook: "Uploaded COA",
  // Legacy values a previously-generated row can still carry until its next
  // regenerate — kept so old rows still render a readable label instead of
  // falling back to the raw method string.
  gemini_category: "AI (category match)", existing_working_coa: "Existing COA",
  bs_section: "Balance Sheet section", pl_section: "P&L section",
};
const MAX_LEVELS = MAX_HIERARCHY_LEVELS;
const LEVEL_INDEXES = Array.from({ length: MAX_LEVELS }, (_, i) => i);

// ── Financial section / sub-section structure (mirrors the client's Excel) ───
// Order: P&L → Balance Sheet; within P&L: Income → Expenses; within BS: Assets → Liabilities → Equity
const SECTION_DEFS = [
  {
    key: "pl",
    label: "PROFIT & LOSS ACCOUNTS",
    subGroups: [
      { key: "income",    label: "Income",      types: new Set(["income"]) },
      { key: "expenses",  label: "Expenses",    types: new Set(["expense", "cogs"]) },
    ],
  },
  {
    key: "bs",
    label: "BALANCE SHEET ACCOUNTS",
    subGroups: [
      { key: "assets",      label: "Assets",      types: new Set(["asset"]) },
      { key: "liabilities", label: "Liabilities", types: new Set(["liability"]) },
      { key: "equity",      label: "Equity",      types: new Set(["equity"]) },
    ],
  },
];

// Map accountType → { sectionKey, subGroupKey }
const TYPE_MAP = {};
for (const sec of SECTION_DEFS) {
  for (const sg of sec.subGroups) {
    for (const t of sg.types) TYPE_MAP[t] = { sectionKey: sec.key, subGroupKey: sg.key };
  }
}

// An account with no recognized accountType (needs_mapping — nothing in the
// uploaded documents resolved it and AI didn't confidently either; never
// guessed/defaulted) must still surface here rather than silently vanish from
// TYPE_MAP lookups — this section is exactly the "Chart of Accounts Review" queue.
const NEEDS_MAPPING_KEY = "needs_mapping";
const NEEDS_MAPPING_SECTION = {
  key: NEEDS_MAPPING_KEY,
  label: "NEEDS MAPPING",
  subGroups: [{ key: NEEDS_MAPPING_KEY, label: "Unclassified / Awaiting Review", types: new Set() }],
};

// Total column count (must stay in sync with the <thead> below)
// systemId + acctNum + acctName + acctIdName + stmt + 15 levels + path + method + adjustedName + actions
const TOTAL_COLS = 5 + MAX_LEVELS + 4;

// ── Frozen leading columns ───────────────────────────────────────────────────
// Sticky-LEFT columns inside the existing single overflow-x-auto table — no
// two-table restructure needed (that trick, used by FrozenPaneTable, exists
// solely to fix sticky-TOP header rows inside a scrolling div; sticky-left
// columns have no such conflict, and this exact `sticky left-0 z-10/20
// bg-<color> border-r-2 shadow-...` convention is already proven in
// ManualProfitLossSummary.jsx). Three sticky columns, not four: the drag
// handle is already rendered inline inside the System ID cell (see the
// GripVertical usage below), not a separate column — freezing System ID
// freezes the handle with it.
const STICKY_COL_1_WIDTH = 110; // System ID (+ drag handle)
const STICKY_COL_2_WIDTH = 120; // Account Number
const STICKY_LEFT_1 = 0;
const STICKY_LEFT_2 = STICKY_COL_1_WIDTH;
const STICKY_LEFT_3 = STICKY_COL_1_WIDTH + STICKY_COL_2_WIDTH; // Account Name — last frozen column, natural width
const HEADER_BG = "#1B3A5C";
const EMPTY_COA_DIFF = { moved: [], created: [], deleted: [], renamed: [], movedCategories: [] };
// A sticky cell paints independently of its row's box once repositioned, so it
// needs its OWN background rather than inheriting the <tr>'s — approximating
// the row's two dynamic tint states (edited / drop-target) with the same
// primary color this file already hardcodes for the drop-target outline
// (line ~1128's outline-[#8BC53D]), so the frozen columns stay visually
// consistent with the rest of the row during drag-and-drop. Plain :hover
// tinting is intentionally not replicated on frozen cells — a cosmetic-only
// gap common to frozen-column grids, not a functional one.
function getStickyRowBg(row, { isDropTarget }) {
  if (isDropTarget) return "rgba(139,197,61,0.1)";
  if (row.userEdited) return "rgba(139,197,61,0.05)";
  return "#ffffff";
}

// ── Auto-scroll while dragging: pure helpers (no component state) ───────────
const AUTO_SCROLL_EDGE_PX = 50; // matches the spec's "~50px of the top/bottom"
const AUTO_SCROLL_MAX_SPEED = 16; // px per animation frame at the very edge (~960px/s @60fps)

// The nearest ancestor (starting at `el` itself) that actually scrolls
// vertically — i.e. has overflow-y auto/scroll AND overflowed content.
// Deliberately stops at <body>/<html> without ever returning them: per the
// spec, auto-scroll must never move the whole page/browser window, only
// whichever inner pane the COA table happens to live in.
function findVerticalScrollAncestor(el) {
  let node = el;
  while (node && node !== document.body && node !== document.documentElement) {
    const style = window.getComputedStyle(node);
    const canScrollY = (style.overflowY === "auto" || style.overflowY === "scroll")
      && node.scrollHeight > node.clientHeight + 1;
    if (canScrollY) return node;
    node = node.parentElement;
  }
  return null;
}

// How fast (px/frame, signed) to scroll given the cursor's Y and the
// container's current bounding rect. 0 outside both edge zones. Speed ramps
// linearly from 0 at the zone's outer boundary up to AUTO_SCROLL_MAX_SPEED
// right at the container edge, so it starts smoothly rather than snapping to
// full speed the instant the cursor crosses into the zone.
function computeAutoScrollSpeed(pointerY, rect) {
  const distFromTop = pointerY - rect.top;
  if (distFromTop >= 0 && distFromTop < AUTO_SCROLL_EDGE_PX) {
    return -AUTO_SCROLL_MAX_SPEED * ((AUTO_SCROLL_EDGE_PX - distFromTop) / AUTO_SCROLL_EDGE_PX);
  }
  const distFromBottom = rect.bottom - pointerY;
  if (distFromBottom >= 0 && distFromBottom < AUTO_SCROLL_EDGE_PX) {
    return AUTO_SCROLL_MAX_SPEED * ((AUTO_SCROLL_EDGE_PX - distFromBottom) / AUTO_SCROLL_EDGE_PX);
  }
  return 0;
}

// The rAF loop body, run once per frame for a drag's whole lifetime. A plain
// module-level function (not a component closure) taking its refs as
// parameters — reads only ref.current on each call, so it never goes stale and
// never needs restarting per dragover event, which is what keeps the scroll
// smooth (one continuous rAF chain) and immediately responsive to leaving the
// edge zone (every frame re-evaluates the current cursor position from
// scratch). `frameRef` is both read (for the recursive call) and written here.
function runAutoScrollFrame(pointerYRef, scrollElRef, frameRef) {
  const scrollEl = scrollElRef.current;
  const pointerY = pointerYRef.current;
  if (scrollEl && pointerY != null) {
    const speed = computeAutoScrollSpeed(pointerY, scrollEl.getBoundingClientRect());
    if (speed !== 0) scrollEl.scrollTop += speed;
  }
  frameRef.current = requestAnimationFrame(() => runAutoScrollFrame(pointerYRef, scrollElRef, frameRef));
}

// ── Display-only hierarchy normalization ─────────────────────────────────────
// PRESENTATION ONLY. Nothing below writes to a node, a level field, or the API —
// it reads the ancestry the backend already sent (walkAncestry over parentKey, via
// getLevelsArray) and decides how to DRAW it. No classification, no hardcoded
// section/subsection names — ONE deliberate exception, see
// CALCULATED_STATEMENT_ROW_LABELS immediately below.

// A QuickBooks-style Chart of Accounts encodes these four P&L calculated rows
// as real category LEVELS (e.g. "... > Net Income > Net Other Income >
// Net Operating Income > Gross Profit > Income > Company Services > Billing &
// Collections"), so they are genuine nodes in the parentKey tree this file
// walks — not a display bug in buildSubGroupItems itself. They are NOT a
// leading anchor common to every account in a sub-group (an account below the
// "Other Income" line, e.g. "Other income", skips both "Net Operating Income"
// and "Gross Profit" entirely), so commonPrefixLength below does not catch
// them, and they render as their own category header rows — confirmed live:
// "Net Operating Income" and "Gross Profit" each showing up as a header above
// "Income" > the real accounts.
//
// These are calculated STATEMENT rows, never real hierarchy categories — the
// same treatment financialStatementService.js's PL_CALCULATED_ROW_NAMES
// already gives them for the Profit & Loss report view. There is no
// structural flag distinguishing them from a genuine category (confirmed live
// against chart_of_accounts: both persist as ordinary `metadata.is_group`
// rows, byte-for-byte the same shape as "Charges" or "Insurance") — so name
// matching is the only way to identify them, same reasoning as the backend's
// comment on that constant. This never removes an account: only a CONTAINER
// category header is skipped; its children still render, one level shallower.
const CALCULATED_STATEMENT_ROW_LABELS = new Set([
  "gross profit", "net operating income", "operating income",
  "net other income", "net income", "net loss", "pretax income",
]);
const isCalculatedStatementRowLabel = (label) =>
  CALCULATED_STATEMENT_ROW_LABELS.has(String(label || "").trim().toLowerCase());

/** Length of the longest leading run of labels every chain shares. */
function commonPrefixLength(chains) {
  if (!chains.length) return 0;
  let n = 0;
  for (;;) {
    const label = chains[0][n];
    if (label === undefined) return n;
    for (const c of chains) if (c[n] !== label) return n;
    n += 1;
  }
}

/**
 * Order a sub-group's accounts into nested category headers + account rows.
 *
 * The shared leading prefix of a sub-group is the statement anchor the backend
 * puts in front of every account of that type (Total Assets… / Total Liabilities
 * and Equity > Total Liabilities… ). It carries no information the sub-group
 * header above it doesn't already convey, so it is not drawn — derived from the
 * DATA (what all these accounts happen to share), never from a list of names, so
 * it adapts to any company's anchor depth.
 *
 * An account never loses its last remaining category: the drop is capped at
 * chain.length - 1, so a lone account in a sub-group still shows the group it
 * sits in rather than being flattened to nothing.
 *
 * Walks the ACTUAL node tree (childrenByParentKey, which buildIndexes has already
 * ordered by the backend's sortOrder and then display name — the app's existing
 * canonical ordering), descending only into the categories that lead to accounts
 * in this sub-group. Because each category is a real node, it is drawn exactly
 * ONCE.
 *
 * The first version of this compared each row's path only against the row
 * immediately before it, which silently split any category whose accounts were
 * not adjacent in the array: the node list arrives ordered by system id (BS-006,
 * BS-018, BS-019, … BS-007, BS-020), so "Current Assets > Bank Accounts" and
 * "Other Current Assets" each rendered twice, once per run.
 *
 * Within a category, direct accounts are listed before sub-categories — how a
 * financial statement reads.
 */
function buildSubGroupItems(rows, section, sg, nodesByKey, childrenByParentKey, collapsedKeys = null) {
  if (!rows.length) return [];
  const rowByKey = new Map(rows.map((r) => [r.key, r]));

  // Ancestor CATEGORY keys for an account, root-first.
  const ancestorKeys = (key) => {
    const out = [];
    let cur = nodesByKey.get(key)?.parentKey ?? null;
    while (cur) { out.unshift(cur); cur = nodesByKey.get(cur)?.parentKey ?? null; }
    return out;
  };
  const chains = rows.map((r) => ancestorKeys(r.key));
  // Categories that lead to an account in THIS sub-group. A shared anchor (e.g.
  // Total Liabilities and Equity) also carries other sub-groups' accounts, so the
  // walk must be restricted rather than rendering the whole tree.
  const included = new Set();
  for (const chain of chains) for (const k of chain) included.add(k);

  // Hide the leading anchor levels every account here shares (see above), never
  // taking an account's last remaining category.
  const minLen = Math.min(...chains.map((c) => c.length));
  const hideDepth = Math.max(0, Math.min(commonPrefixLength(chains), minLen - 1));

  const items = [];
  const walk = (parentKey, depth, remainingHidden) => {
    // Collapse guard: suppresses only the recursive DESCENT into a collapsed
    // category's children — never the category's own header row, which the
    // parent call already pushed before recursing here. Real (persisted)
    // keys only, so collapse state (keyed by the real node key, not the
    // synthetic display id below) survives a rename/move of the category.
    if (parentKey && collapsedKeys?.has(parentKey)) return;
    const children = childrenByParentKey.get(parentKey) || [];
    for (const n of children) {
      if (n.nodeType !== "ACCOUNT") continue;
      const row = rowByKey.get(n.key);
      if (row) items.push({ kind: "account", section, sg, row, depth });
    }
    const parentLabel = parentKey ? displayName(nodesByKey.get(parentKey) || {}) : null;
    for (const n of children) {
      if (n.nodeType === "ACCOUNT" || !included.has(n.key)) continue;
      const label = displayName(n);
      // Hidden because it is part of the shared anchor, because it just repeats
      // its parent's label (the backend's anchors legitimately do, e.g. Total
      // Assets twice — a storage convention, not real hierarchy), or because
      // it's a calculated P&L statement row (Gross Profit, Net Operating
      // Income, …) that only ever appears as a real category LEVEL in the
      // data — see CALCULATED_STATEMENT_ROW_LABELS above for why.
      const hidden = remainingHidden > 0 || label === parentLabel || isCalculatedStatementRowLabel(label);
      if (!hidden) {
        // `node`/`hasChildren` expose the REAL tree node (never duplicated
        // fields) so the chevron/DnD/create-rename-delete-move actions can
        // act on n.key/n.accountType/n.statementType directly, and so a
        // collapsed empty category correctly renders no chevron at all.
        items.push({
          kind: "category", section, sg, label, depth,
          key: `cat-${sg.key}-${n.key}`, node: n,
          hasChildren: (childrenByParentKey.get(n.key) || []).length > 0,
        });
      }
      walk(n.key, hidden ? depth : depth + 1, Math.max(0, remainingHidden - 1));
    }
  };
  walk(null, 0, hideDepth);
  return items;
}

function parsePathInput(value) {
  return String(value || "").split(">").map((s) => s.trim()).filter(Boolean);
}

/**
 * ChartOfAccountsGrid — the grouped-table Chart of Accounts editor (the
 * original visual layout: PROFIT & LOSS / BALANCE SHEET section headers,
 * Income/Expenses/Assets/Liabilities/Equity sub-groups, a Level 1..15 column
 * per row), now driven entirely by the tree-native node-list wire shape
 * ({ key, parentKey, nodeType, ... } — see chartOfAccountsService.
 * serializeProposedTree / serializePersistedTree) instead of the old flat
 * `levels` array + patches-diff model. Level/Hierarchy-Path columns are
 * DERIVED fresh from each account's parentKey chain on every render (lib/
 * coaTree.js's getLevelsArray/getHierarchyPathLabel) rather than being a
 * static field that could go stale after a move/rename — parentKey remains
 * the single source of truth, exactly as it is on the backend.
 *
 * Two data sources, one component:
 *   - `mode === "proposal"` — reviewing a just-generated (or just-regenerated)
 *     proposal that has never been persisted. `proposalNodes` (from the
 *     /sync or /generate response, or /chart-of-accounts/regenerate) seeds
 *     the working tree. Nothing exists in chart_of_accounts yet.
 *   - `mode === "approved"` — `version.coaApprovedAt` is set, so the tree is
 *     fetched from GET /chart-of-accounts (the real persisted hierarchy).
 *
 * Save always calls the SAME endpoint (chart-of-accounts/save) regardless of
 * mode — the backend re-validates, persists, and (only on success) runs
 * Trial Balance/Reconciliation/Monthly Balance Sheets/report snapshots. This
 * component routes Save through keyReportGeneration.approveCoa so the
 * module-level generation-state manager (survives navigation, gates the
 * page's "Open Reports" action) reflects the outcome.
 */
export default function ChartOfAccountsGrid({
  clientId, versionId, version, hasSyncedData, notify,
  proposalNodes, proposalMatchSummary, proposalToken,
  onApproved,
}) {
  const [nodes, setNodes] = useState([]);
  const [mode, setMode] = useState("proposal"); // "proposal" | "approved"
  const [matchSummary, setMatchSummary] = useState(null); // only set from a proposal/regenerate response
  const [history, setHistory] = useState([]); // array of node-array snapshots
  const [future, setFuture] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [resettingAll, setResettingAll] = useState(false);
  const [search, setSearch] = useState("");
  const [saveErrors, setSaveErrors] = useState(null);

  const [editingKey, setEditingKey] = useState(null);
  const [editName, setEditName] = useState("");
  const [editLevels, setEditLevels] = useState([]); // MAX_LEVELS strings; source of truth while editing
  const [mappingKey, setMappingKey] = useState(null);
  const [mappingCategoryPath, setMappingCategoryPath] = useState("");
  const [mappingBaseName, setMappingBaseName] = useState("");
  const [mergeEditor, setMergeEditor] = useState(null); // { categoryKey, categoryPathArr, value }

  // ── Collapse/expand tree state ──────────────────────────────────────────
  // Keyed by the REAL CATEGORY node key (n.key), never the synthetic
  // per-render `cat-${sg.key}-${n.key}` display id — the real key is stable
  // across a rename/move of the category; the synthetic one is not (it
  // encodes which sub-group the category currently renders under).
  const [collapsedKeys, setCollapsedKeys] = useState(() => new Set());
  const toggleCollapsed = (key) => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const collapseAll = () => {
    setCollapsedKeys(new Set(nodes.filter((n) => n.nodeType === "CATEGORY").map((n) => n.key)));
  };
  const expandAll = () => setCollapsedKeys(new Set());

  // ── Category create/rename/move — one shared inline-editor state,
  // analogous to the existing mergeEditor/mappingKey pattern above. ────────
  // mode: "create" (new child under parentKey) | "rename" (targetKey) | "move" (targetKey)
  const [categoryEditor, setCategoryEditor] = useState(null);
  const closeCategoryEditor = () => setCategoryEditor(null);

  // ── Save preview (diff before Save) ─────────────────────────────────────
  const [showSavePreview, setShowSavePreview] = useState(false);
  const [showRecPanel, setShowRecPanel] = useState(false);

  // ── Create Parent dialog ────────────────────────────────────────────────
  // createParentUnder is the destination the dialog OPENS on (the row whose
  // "+ Add Parent" was clicked, or null for the toolbar entry point); the user
  // can still pick any other destination from the tree inside the dialog.
  const [showCreateParent, setShowCreateParent] = useState(false);
  const [createParentUnder, setCreateParentUnder] = useState(null);

  // Drag-and-drop reclassification. Native HTML5 DnD (the pattern already used
  // by FileExplorer) — no new dependency. `dragKey` is the account being
  // dragged; `dropKey` is the row currently hovered, used only for the drop
  // affordance.
  const [dragKey, setDragKey] = useState(null);
  const [dropKey, setDropKey] = useState(null);

  // ── Auto-scroll while dragging ──────────────────────────────────────────
  // Pure UX addition: the table can be far taller than the viewport, so
  // dragging a row toward the top/bottom edge of whatever container actually
  // scrolls it (the app's scrollable content pane, not the row list itself —
  // this table has no scroll region of its own) must scroll that container,
  // the same way a file manager auto-scrolls while dragging a file toward the
  // edge of a long list. Everything below is additive to the existing native
  // HTML5 DnD handlers (onRowDragStart/onRowDragOver/onRowDrop/clearDrag) —
  // none of their drop-target logic is touched, so preventDefault/dropEffect
  // continue to be governed solely by isValidDropTarget as before.
  const tableWrapRef = useRef(null);
  const dragPointerYRef = useRef(null); // latest cursor Y while a drag is over the table; null when not
  const autoScrollElRef = useRef(null); // the scrollable ancestor found for the CURRENT drag
  const autoScrollFrameRef = useRef(null); // requestAnimationFrame id, or null when not running

  const loadedNodesRef = useRef([]);
  // Read via a ref so the load effect can depend on a stable `proposalToken`
  // (e.g. the generation run's startedAt) instead of the proposal object
  // identity, which would otherwise re-trigger on every parent re-render and
  // wipe the user's in-progress edits.
  const proposalRef = useRef({ nodes: proposalNodes, matchSummary: proposalMatchSummary });
  useEffect(() => {
    proposalRef.current = { nodes: proposalNodes, matchSummary: proposalMatchSummary };
  });

  const rec = useHierarchyRecommendations(clientId, versionId, notify);
  const coaApprovedAt = version?.coaApprovedAt || null;

  // ── Data loading ─────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!versionId) { setNodes([]); loadedNodesRef.current = []; return; }

    if (!coaApprovedAt) {
      // Nothing persisted yet — a pending proposal (from the /generate
      // response, or a /regenerate call) is the only thing to review.
      const proposal = proposalRef.current;
      const list = proposal?.nodes?.length ? proposal.nodes : [];
      setNodes(list);
      setMatchSummary(list.length ? proposal.matchSummary || null : null);
      setMode("proposal");
      loadedNodesRef.current = list;
      setHistory([]); setFuture([]); setSaveErrors(null);
      return;
    }

    setLoading(true);
    try {
      const res = await getChartOfAccounts(versionId);
      const list = res?.tree?.nodes || [];
      setNodes(list);
      setMatchSummary(null);
      setMode("approved");
      loadedNodesRef.current = list;
      setHistory([]); setFuture([]); setSaveErrors(null);
    } catch (e) {
      notify?.(e.message || "Failed to load Chart of Accounts.", "error");
      setNodes([]);
      loadedNodesRef.current = [];
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionId, coaApprovedAt, proposalToken, notify]);

  useEffect(() => { void Promise.resolve().then(() => load()); }, [load]);

  // ── Derived data ─────────────────────────────────────────────────────────
  const { nodesByKey, childrenByParentKey } = useMemo(() => buildIndexes(nodes), [nodes]);
  const accountRows = useMemo(
    () => nodes
      .filter((n) => n.nodeType === "ACCOUNT")
      .map((n) => ({
        ...n,
        name: displayName(n),
        levels: getLevelsArray(nodesByKey, n.key),
        hierarchyPath: getHierarchyPathLabel(nodesByKey, n.key),
      })),
    [nodes, nodesByKey],
  );
  const categoryOptions = useMemo(() => listCategoryNodes(nodes), [nodes]);
  const counts = useMemo(() => summarizeClassification(nodes, matchSummary), [nodes, matchSummary]);
  const pendingCount = useMemo(() => nodes.filter((n) => n.userEdited).length, [nodes]);
  const draftValidation = useMemo(() => validateTree(nodes), [nodes]);
  const accountCount = accountRows.length;

  // ── History-aware edits (undo/redo over WHOLE-TREE snapshots) ───────────
  const commit = useCallback((newNodes) => {
    setHistory((h) => [...h, nodes]);
    setFuture([]);
    setNodes(newNodes);
    setSaveErrors(null);
  }, [nodes]);

  const undo = () => {
    if (!history.length) return;
    const prev = history[history.length - 1];
    setFuture((f) => [nodes, ...f]);
    setHistory((h) => h.slice(0, -1));
    setNodes(prev);
    setSaveErrors(null);
  };
  const redo = () => {
    if (!future.length) return;
    const next = future[0];
    setHistory((h) => [...h, nodes]);
    setFuture((f) => f.slice(1));
    setNodes(next);
    setSaveErrors(null);
  };
  const discardDraft = () => {
    setNodes(loadedNodesRef.current);
    setHistory([]); setFuture([]); setSaveErrors(null);
  };

  // ── Save / Approve — always submits the COMPLETE tree ───────────────────
  const handleSave = async () => {
    if (!nodes.length) return;
    setSaving(true);
    try {
      const outcome = await approveCoa(clientId, versionId, nodes);
      if (!outcome.ok) {
        if (Array.isArray(outcome.violations) && outcome.violations.length) {
          setSaveErrors(outcome.violations);
          notify?.("Some changes couldn't be saved — see the details below.", "error");
        } else {
          notify?.(outcome.error || "Failed to save Chart of Accounts.", "error");
        }
        return;
      }
      const tree = outcome.res?.tree?.nodes || [];
      setNodes(tree);
      loadedNodesRef.current = tree;
      setMode("approved");
      setMatchSummary(null);
      setHistory([]); setFuture([]); setSaveErrors(null);
      clearCachedFinancials(clientId, versionId);
      const savedCounts = summarizeClassification(tree, null);
      notify?.(
        `Chart of Accounts approved — ${savedCounts.totalCount} account${savedCounts.totalCount === 1 ? "" : "s"} saved. ` +
        "Trial Balance, Reconciliation, Monthly Balance Sheets and report snapshots have been regenerated.",
        "success",
      );
      onApproved?.(outcome.res);
    } finally {
      setSaving(false);
    }
  };

  // ── Save preview (diff before Save) ─────────────────────────────────────
  // loadedNodesRef.current is already exactly "the originally-loaded tree" —
  // set once when the version loads (or on Regenerate/a prior Save/Reset),
  // never touched by an edit. No new capture mechanism needed. Computed in an
  // effect rather than a render-time useMemo: reading a ref's `.current`
  // during render is unsound (react-hooks/refs) even when memoized, since a
  // ref mutation itself never triggers the re-render that would recompute it.
  const [saveDiff, setSaveDiff] = useState(EMPTY_COA_DIFF);
  useEffect(() => {
    setSaveDiff(diffCoaTrees(loadedNodesRef.current, nodes));
  }, [nodes]);
  const saveDiffIsEmpty = !saveDiff.moved.length && !saveDiff.created.length
    && !saveDiff.deleted.length && !saveDiff.renamed.length && !saveDiff.movedCategories.length;

  const requestSave = () => {
    if (saveDiffIsEmpty) { handleSave(); return; }
    setShowSavePreview(true);
  };
  const confirmSaveFromPreview = () => {
    setShowSavePreview(false);
    handleSave();
  };
  const discardFromPreview = () => {
    setShowSavePreview(false);
    discardDraft();
  };

  // ── Regenerate the PROPOSAL only (no persistence) ───────────────────────
  const handleRegenerate = async () => {
    if (!versionId) return;
    setRegenerating(true);
    try {
      const res = await regenerateChartOfAccounts(versionId);
      const list = res?.proposedTree?.nodes || [];
      setNodes(list);
      loadedNodesRef.current = list;
      setMatchSummary(res?.matchSummary || null);
      setMode("proposal");
      setHistory([]); setFuture([]); setSaveErrors(null);
      clearCachedFinancials(clientId, versionId);
      // Accurate, two-number messaging — never a single blended "N accounts
      // required AI classification" figure that overclaims for document-
      // matched accounts.
      const c = summarizeClassification(list, res?.matchSummary);
      const parts = [`${c.totalCount} account${c.totalCount === 1 ? "" : "s"} proposed.`];
      if (c.documentMatchedCount) parts.push(`${c.documentMatchedCount} resolved from uploaded documents.`);
      if (c.aiFallbackCount) parts.push(`${c.aiFallbackCount} required AI classification.`);
      if (c.needsMappingCount) parts.push(`${c.needsMappingCount} need${c.needsMappingCount === 1 ? "s" : ""} manual mapping.`);
      notify?.(`Chart of Accounts proposal regenerated. ${parts.join(" ")} Review and Approve to persist.`, "success");
    } catch (e) {
      notify?.(e.message || "Failed to regenerate Chart of Accounts.", "error");
    } finally { setRegenerating(false); }
  };

  // ── Reset (approved accounts only — meaningless against an unpersisted
  //    proposal, since there is no "original" persisted row to restore) ────
  const handleResetAll = async () => {
    if (!versionId) return;
    setResettingAll(true);
    try {
      const res = await resetChartOfAccounts(versionId);
      const list = res?.tree?.nodes || [];
      setNodes(list);
      loadedNodesRef.current = list;
      setHistory([]); setFuture([]); setSaveErrors(null);
      clearCachedFinancials(clientId, versionId);
      notify?.("Restored all accounts to their original classification.", "success");
    } catch (e) {
      notify?.(e.message || "Failed to reset hierarchy.", "error");
    } finally { setResettingAll(false); }
  };

  const resetRow = async (row) => {
    if (!row?.accountId) return;
    try {
      await resetChartOfAccount(row.accountId);
      await load();
      clearCachedFinancials(clientId, versionId);
      notify?.("Account restored to its original classification.", "success");
    } catch (e) { notify?.(e.message || "Failed to reset account.", "error"); }
  };

  // ── Inline edit — the whole row: Adjusted Name AND every Level 1..15 cell
  // (synced two-way with the Hierarchy Path field), committed as one step.
  // In the new tree model this only ever touches the ONE edited account —
  // its descendants (there are none; a posting account can't have children)
  // and the rest of the tree are untouched, unlike the old flat-array
  // editor's computeDescendantRelabel. ────────────────────────────────────
  const startEdit = (row) => {
    setEditingKey(row.key);
    setEditName(row.adjustedName || row.accountName || "");
    const levels = new Array(MAX_LEVELS).fill("");
    (row.levels || []).forEach((v, i) => { if (i < MAX_LEVELS) levels[i] = v || ""; });
    setEditLevels(levels);
  };
  const cancelEdit = () => { setEditingKey(null); setEditName(""); setEditLevels([]); };
  const setEditLevelAt = (i, value) => {
    setEditLevels((prev) => {
      const next = [...prev];
      next[i] = value;
      return next;
    });
  };
  // The Hierarchy Path field edits the same editLevels array as one string.
  const editPathValue = editLevels.filter(Boolean).join(" > ");
  const setEditPathValue = (value) => {
    const parsed = parsePathInput(value);
    const next = new Array(MAX_LEVELS).fill("");
    parsed.slice(0, MAX_LEVELS).forEach((v, i) => { next[i] = v; });
    setEditLevels(next);
  };
  const saveEdit = (row) => {
    const trimmedName = editName.trim();
    const trimmedPathArr = editLevels.map((v) => (v || "").trim()).filter(Boolean);
    const oldPath = (row.levels || []).filter(Boolean);
    const nameChanged = trimmedName && trimmedName !== (row.adjustedName || row.accountName);
    const pathChanged = trimmedPathArr.length && trimmedPathArr.join(" > ") !== oldPath.join(" > ");
    if (!nameChanged && !pathChanged) { cancelEdit(); return; }

    // The path field's own last segment doubles as the account's name
    // (mirrors the old editor) unless the dedicated Adjusted Name field was
    // ALSO changed, in which case that explicit rename wins.
    const categoryPathArr = trimmedPathArr.length ? trimmedPathArr.slice(0, -1) : [];
    const finalName = nameChanged ? trimmedName : (trimmedPathArr[trimmedPathArr.length - 1] || row.name);
    commit(applyAccountEdit(nodes, row.key, {
      newName: finalName,
      categoryPathArr: categoryPathArr.length ? categoryPathArr : oldPath.slice(0, -1),
      accountType: row.accountType,
      statementType: row.statementType,
    }));
    cancelEdit();
  };

  // ── Drag-and-drop reclassification ───────────────────────────────────────
  //
  // Model: drag an ACCOUNT row and drop it ON ANOTHER ACCOUNT ROW. The dragged
  // account moves into the drop target's own parent category and adopts the
  // target's classification -- i.e. "put this account where that one is".
  //
  // Why drop-onto-a-row rather than drop-between-rows: the grid renders no
  // CATEGORY rows (only accountType-derived sub-group headers, which are not
  // tree nodes), so an account row is the only thing on screen that actually
  // identifies a real destination in the tree. It also makes every move the
  // user asked for expressible -- Asset <-> Liability <-> Equity, P&L <-> BS,
  // and between nested categories within one section -- because the target row
  // supplies both the parent and the classification.
  //
  // Both must travel together: the server's validateHierarchyConsistency
  // requires a leaf's level chain to start with the fixed anchor for its OWN
  // accountType, so re-parenting alone across sections would be rejected on
  // Save (422). See moveAccountToParent's comment in coaTree.js.
  //
  // Nothing is recomputed here: levels and hierarchyPath are derived from the
  // parentKey graph on every render, and the backend re-derives them from the
  // same graph on Save. Routing through `commit` gives undo/redo, the dirty
  // badge, live validation and the Save button state for free.
  const canReorder = mode === "proposal";

  const stopAutoScroll = useCallback(() => {
    if (autoScrollFrameRef.current != null) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
    dragPointerYRef.current = null;
    autoScrollElRef.current = null;
  }, []);

  // Resolved once per drag (not per frame/event) — the scrollable ancestor
  // doesn't move mid-drag, and re-walking the DOM on every dragover would be
  // wasted work on a table with hundreds/thousands of rows.
  const startAutoScroll = useCallback(() => {
    autoScrollElRef.current = tableWrapRef.current
      ? findVerticalScrollAncestor(tableWrapRef.current)
      : null;
    if (autoScrollElRef.current && autoScrollFrameRef.current == null) {
      autoScrollFrameRef.current = requestAnimationFrame(
        () => runAutoScrollFrame(dragPointerYRef, autoScrollElRef, autoScrollFrameRef),
      );
    }
  }, []);

  // `row` is either an ACCOUNT row object (real key at `row.key`) or a
  // CATEGORY item from buildSubGroupItems (real key at `row.node.key` —
  // `row.key` on a category item is the synthetic per-render display id,
  // `cat-${sg.key}-${n.key}`, never the real node).
  const onRowDragStart = (row) => (e) => {
    if (!canReorder) return;
    const realKey = row.nodeType === "ACCOUNT" ? row.key : row.node?.key;
    if (!realKey) return;
    cancelEdit();
    setDragKey(realKey);
    e.dataTransfer.effectAllowed = "move";
    // Some browsers require data to be set for a drag to start at all.
    try { e.dataTransfer.setData("text/plain", realKey); } catch { /* non-fatal */ }
    startAutoScroll();
  };

  // Passive position tracking for auto-scroll only — never calls
  // preventDefault/stopPropagation, so the existing per-row onRowDragOver
  // (which alone controls dropEffect/isValidDropTarget) is completely
  // unaffected. Attached to the table's wrapper div, so it fires for every
  // dragover anywhere over the table (native dragover bubbles).
  const onTableDragOver = (e) => { dragPointerYRef.current = e.clientY; };
  // Cursor left the table entirely (not just moved to a sibling row inside
  // it — dragleave fires on every such transition too, hence the `contains`
  // check) — stop using a now-meaningless stale position.
  const onTableDragLeave = (e) => {
    if (!tableWrapRef.current?.contains(e.relatedTarget)) dragPointerYRef.current = null;
  };

  const clearDrag = useCallback(() => {
    setDragKey(null);
    setDropKey(null);
    stopAutoScroll();
  }, [stopAutoScroll]);

  // Safety net: native `dragend` always fires on the source row when the drag
  // ends normally, but if anything ever prevents that (row unmounted mid-drag,
  // Esc pressed, etc.) this guarantees the rAF loop still stops rather than
  // scrolling forever. Registered once for the component's lifetime.
  useEffect(() => {
    window.addEventListener("dragend", clearDrag);
    window.addEventListener("drop", clearDrag);
    return () => {
      window.removeEventListener("dragend", clearDrag);
      window.removeEventListener("drop", clearDrag);
      stopAutoScroll();
    };
  }, [clearDrag, stopAutoScroll]);

  // Generalized target shape: either an ACCOUNT row (unchanged existing
  // target — `row.nodeType === "ACCOUNT"`) or a CATEGORY item from
  // buildSubGroupItems (`row.kind === "category"`, real node at `row.node`).
  // `dragKey` may now hold either kind's real key; its nodeType is resolved
  // live from `nodesByKey` at drop time rather than tracked as separate
  // state, since the tree itself is always the source of truth for it.
  const isValidDropTarget = (target) => {
    if (!canReorder || !dragKey) return false;
    const draggedNode = nodesByKey.get(dragKey);
    if (!draggedNode) return false;

    if (target?.nodeType === "ACCOUNT") {
      // Existing behavior, unchanged: an account can be dropped onto another
      // account (never a category dragging onto an account — that pairing is
      // handled by the category-onto-category branch below, or is simply
      // not a valid pairing).
      return draggedNode.nodeType === "ACCOUNT" && target.key !== dragKey;
    }
    if (target?.kind === "category" && target.node) {
      const targetKey = target.node.key;
      if (targetKey === dragKey) return false;
      if (draggedNode.nodeType === "ACCOUNT") return true; // account -> category: always valid, matches account-onto-account semantics
      // category -> category: same root GAAP anchor only (never invent a
      // recursive reclassification of every descendant leaf), and never
      // into its own subtree (would create a cycle).
      const subtree = getSubtreeKeys(childrenByParentKey, dragKey);
      if (subtree.has(targetKey)) return false;
      const draggedAnchor = getRootAnchorKey(nodesByKey, dragKey);
      const targetAnchor = getRootAnchorKey(nodesByKey, targetKey);
      return !draggedAnchor || draggedAnchor === targetAnchor;
    }
    return false;
  };

  const onRowDragOver = (row) => (e) => {
    if (!isValidDropTarget(row)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const targetKey = row.nodeType === "ACCOUNT" ? row.key : row.node?.key;
    if (dropKey !== targetKey) setDropKey(targetKey);
  };

  const onRowDrop = (row) => (e) => {
    if (!isValidDropTarget(row)) return;
    e.preventDefault();
    const movedKey = dragKey;
    const draggedNode = nodesByKey.get(movedKey);
    clearDrag();
    if (!draggedNode) return;

    if (draggedNode.nodeType === "ACCOUNT") {
      const moved = accountRows.find((r) => r.key === movedKey);
      if (!moved) return;
      const targetParentKey = row.nodeType === "ACCOUNT" ? (row.parentKey || null) : row.node.key;
      const targetType = row.nodeType === "ACCOUNT" ? row.accountType : row.node.accountType;
      const targetStatement = row.nodeType === "ACCOUNT" ? row.statementType : row.node.statementType;
      // A drop onto a sibling already under the same parent is a no-op -- don't
      // dirty the tree or burn an undo step for it.
      const sameParent = (moved.parentKey || null) === targetParentKey;
      const sameType = moved.accountType === targetType;
      if (sameParent && sameType) return;
      commit(moveAccountToParent(nodes, movedKey, targetParentKey, {
        accountType: targetType,
        statementType: targetStatement,
      }));
      const dest = row.nodeType === "ACCOUNT" ? (row.hierarchyPath || row.name) : row.label;
      notify?.(`Moved "${moved.name}" to ${dest}. Review and Save to apply.`, "success");
      return;
    }

    // CATEGORY -> CATEGORY: a reparent, not a merge — the dragged category
    // and its whole subtree survive under the new parent (moveNode only ever
    // touches the dragged node's own parentKey; every descendant keeps
    // pointing at IT, so they move for free). Distinct from mergeCategory,
    // which instead deletes the source and repoints only its DIRECT members.
    if (row.kind === "category" && row.node) {
      const targetKey = row.node.key;
      if ((draggedNode.parentKey || null) === targetKey) return; // no-op
      commit(moveNode(nodes, movedKey, targetKey));
      notify?.(`Moved "${displayName(draggedNode)}" under "${row.label}". Review and Save to apply.`, "success");
    }
  };

  // ── Merge this account's category into another existing (or new) category ──
  const openMergeEditor = (row) => {
    cancelEdit();
    setMergeEditor({ categoryKey: row.parentKey || null, categoryPathArr: row.levels.filter(Boolean).slice(0, -1), value: "", __forKey: row.key });
  };
  const closeMergeEditor = () => setMergeEditor(null);
  const submitMergeEditor = () => {
    if (!mergeEditor) return;
    const targetArr = parsePathInput(mergeEditor.value);
    if (!targetArr.length) { notify?.("Pick a category to merge into.", "error"); return; }
    if (!mergeEditor.categoryKey) { notify?.("This account has no category to merge.", "error"); return; }
    commit(mergeCategory(nodes, mergeEditor.categoryKey, targetArr));
    closeMergeEditor();
  };

  // ── Category create / rename / delete / move (structured, no free-text
  // path typing) ───────────────────────────────────────────────────────────
  // Renders in BOTH mode==="proposal" and mode==="approved" — matching the
  // existing precedent that the per-account Pencil/GitMerge/FolderInput
  // actions already render in both modes today (only native drag-and-drop is
  // proposal-only, via canReorder). This is not a new restriction.
  // Create Parent now runs through CreateParentModal — a hierarchy-aware
  // dialog (tree destination picker + live before/after preview + validation)
  // rather than a bare name field on one row. It stages through the SAME
  // commit() as every other edit, so undo/redo, the unsaved-changes badge,
  // live validation and the Save preview all apply unchanged.
  const openCreateParent = (parentKey) => {
    cancelEdit();
    closeCategoryEditor();
    setCreateParentUnder(parentKey || null);
    setShowCreateParent(true);
  };
  const handleCreateParent = ({ parentKey, label }) => {
    const parentNode = parentKey ? nodesByKey.get(parentKey) : null;
    const result = createCategory(nodes, {
      parentKey: parentKey || null,
      label,
      accountType: parentNode?.accountType,
      statementType: parentNode?.statementType,
    });
    if (result.error) {
      notify?.(
        `Couldn't create "${label}" — ${result.error === "PARENT_IS_LEAF" ? "that location is a posting account, not a category" : "invalid location"}.`,
        "error",
      );
      return;
    }
    commit(result.nodes);
    // Keep the new parent visible: make sure its whole ancestor path is
    // expanded, so it doesn't land inside a collapsed branch.
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      let cur = parentKey;
      let guard = 0;
      while (cur && guard < MAX_LEVELS + 2) {
        next.delete(cur);
        cur = nodesByKey.get(cur)?.parentKey || null;
        guard += 1;
      }
      return next;
    });
    notify?.(
      parentNode
        ? `Created "${label}" under "${displayName(parentNode)}". Existing accounts were not moved — drag them in, then Save.`
        : `Created "${label}". Existing accounts were not moved — drag them in, then Save.`,
      "success",
    );
  };
  const openRenameCategory = (node) => {
    cancelEdit();
    setCategoryEditor({ mode: "rename", targetKey: node.key, value: displayName(node) });
  };
  const openMoveCategory = (node) => {
    cancelEdit();
    setCategoryEditor({ mode: "move", targetKey: node.key, value: "" });
  };
  const submitCategoryEditor = () => {
    if (!categoryEditor) return;
    const trimmed = categoryEditor.value.trim();

    if (categoryEditor.mode === "rename") {
      if (!trimmed) { notify?.("Enter a name.", "error"); return; }
      commit(renameNode(nodes, categoryEditor.targetKey, trimmed));
      closeCategoryEditor();
      return;
    }

    if (categoryEditor.mode === "move") {
      const targetNode = nodesByKey.get(categoryEditor.targetKey);
      const targets = targetNode ? getMoveTargetsForCategory(nodes, targetNode) : [];
      const target = targets.find((c) => c.path === trimmed || c.node.key === trimmed);
      if (!target) { notify?.("Pick a destination category from the list.", "error"); return; }
      commit(moveNode(nodes, categoryEditor.targetKey, target.node.key));
      notify?.(`Moved under "${target.path}". Review and Save to apply.`, "success");
      closeCategoryEditor();
    }
  };
  const handleDeleteCategory = (node) => {
    const result = deleteCategory(nodes, node.key);
    if (result.error === "HAS_CHILDREN") {
      // Shouldn't be reachable — the Trash2 icon only renders when
      // !hasChildren — but defensive, and points at the right tool instead
      // of failing silently.
      notify?.(`"${displayName(node)}" still has content — use Merge instead of Delete.`, "error");
      return;
    }
    if (result.error) { notify?.("Couldn't delete that category.", "error"); return; }
    commit(result.nodes);
    notify?.(`Deleted empty category "${displayName(node)}".`, "success");
  };

  // ── Manual mapping for a needs_mapping account ────────────────────────────
  const startMapping = (row) => {
    setMappingKey(row.key);
    setMappingCategoryPath(categoryOptions[0]?.path || "");
    setMappingBaseName(row.adjustedName || row.name || "");
  };
  const cancelMapping = () => { setMappingKey(null); setMappingCategoryPath(""); setMappingBaseName(""); };
  const saveMapping = (row) => {
    const baseName = mappingBaseName.trim();
    if (!mappingCategoryPath || !baseName) { notify?.("Pick a category and a name first.", "error"); return; }
    commit(applyAccountEdit(nodes, row.key, {
      newName: baseName,
      categoryPathArr: parsePathInput(mappingCategoryPath),
      accountType: row.accountType,
      statementType: row.statementType,
      clearNeedsMapping: true,
    }));
    cancelMapping();
  };

  // ── Excel export — always exports ALL accounts regardless of current search ─
  const handleExport = () => {
    if (!accountRows.length) return;

    const allGrouped = {};
    for (const sec of SECTION_DEFS)
      for (const sg of sec.subGroups)
        allGrouped[sg.key] = [];
    allGrouped[NEEDS_MAPPING_KEY] = [];
    for (const row of accountRows) {
      const sgKey = TYPE_MAP[row.accountType]?.subGroupKey || NEEDS_MAPPING_KEY;
      allGrouped[sgKey].push(row);
    }

    const sheetRows = [];
    sheetRows.push([
      "System ID", "Account Number", "Account Name", "Statement Type",
      ...LEVEL_INDEXES.map((i) => `Level ${i + 1}`),
      "Hierarchy Path", "Method", "Adjusted Name", "Classification",
    ]);

    for (const section of [...SECTION_DEFS, NEEDS_MAPPING_SECTION]) {
      sheetRows.push([section.label]);
      for (const sg of section.subGroups) {
        sheetRows.push([sg.label]);
        for (const row of allGrouped[sg.key] || []) {
          const lvls = row.levels || [];
          sheetRows.push([
            row.systemId || "",
            row.accountNumber || "",
            row.accountName || "",
            STATEMENT_LABELS[row.statementType] || row.statementType || "",
            ...LEVEL_INDEXES.map((i) => lvls[i] || ""),
            row.hierarchyPath || "",
            METHOD_LABELS[row.classificationMethod] || row.classificationMethod || "",
            row.adjustedName || "",
            CLASSIFICATION_SOURCE_LABELS[row.classificationSource] || row.classificationSource || "",
          ]);
        }
      }
    }

    const ws = XLSX.utils.aoa_to_sheet(sheetRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Chart of Accounts");
    XLSX.writeFile(wb, "chart_of_accounts.xlsx");
  };

  // ── Search filter ─────────────────────────────────────────────────────────
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return accountRows;
    return accountRows.filter((r) => {
      const hay = [r.systemId, r.accountNumber, r.accountName, r.adjustedName, r.hierarchyPath]
        .filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [accountRows, search]);

  // ── Group filtered accounts into the section/sub-group structure ──────────
  const groupedData = useMemo(() => {
    const out = {};
    for (const sec of SECTION_DEFS)
      for (const sg of sec.subGroups)
        out[sg.key] = [];
    out[NEEDS_MAPPING_KEY] = [];

    for (const row of filteredRows) {
      const mapping = TYPE_MAP[row.accountType];
      const sgKey = row.needsMapping ? NEEDS_MAPPING_KEY : (mapping?.subGroupKey || NEEDS_MAPPING_KEY);
      out[sgKey].push(row);
    }
    return out;
  }, [filteredRows]);

  // ── Build a flat list of row descriptors for the table body ───────────────
  const tableRows = useMemo(() => {
    const items = [];
    for (const section of [...SECTION_DEFS, NEEDS_MAPPING_SECTION]) {
      const sectionCount = section.subGroups.reduce(
        (n, sg) => n + (groupedData[sg.key] || []).length, 0,
      );
      if (search && sectionCount === 0) continue;
      if (section.key === NEEDS_MAPPING_KEY && sectionCount === 0) continue;

      items.push({ kind: "section", section, count: sectionCount });

      for (const sg of section.subGroups) {
        const rows = groupedData[sg.key] || [];
        if (search && rows.length === 0) continue;

        items.push({ kind: "subGroup", section, sg, count: rows.length });

        // Nest the accounts under the category headers the backend's own
        // ancestry already describes, instead of listing them flat. Presentation
        // only — see buildSubGroupItems.
        for (const item of buildSubGroupItems(rows, section, sg, nodesByKey, childrenByParentKey, collapsedKeys)) items.push(item);
        if (rows.length === 0) {
          items.push({ kind: "empty", section, sg });
        }
      }
    }
    return items;
  }, [groupedData, search, nodesByKey, childrenByParentKey, collapsedKeys]);

  const pendingRecCount = useMemo(
    () => rec.recommendations.filter((r) => r.status === "pending").length,
    [rec.recommendations],
  );

  // Root anchor key per sub-group, used only to enable/disable that
  // sub-group's "create category here" button — a company with zero
  // accounts of a given type has no anchor node yet to attach a new
  // category to. Derived from the unfiltered account rows (not
  // filteredRows) so an active search never hides this control.
  const subGroupAnchorKey = useMemo(() => {
    const out = {};
    for (const sec of [...SECTION_DEFS, NEEDS_MAPPING_SECTION]) {
      for (const sg of sec.subGroups) {
        const row = accountRows.find((r) => sg.types.has(r.accountType));
        out[sg.key] = row ? getRootAnchorKey(nodesByKey, row.key) : null;
      }
    }
    return out;
  }, [accountRows, nodesByKey]);

  const saveLabel = mode === "proposal" ? "Approve & Generate Reports" : "Save Changes";
  const isEmpty = !loading && accountRows.length === 0;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="rounded-2xl border border-border bg-white">
      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Table2 size={18} className="text-primary" />
          <h3 className="text-base font-bold text-text-primary">Chart of Accounts</h3>
          <span className="rounded-full bg-bg-page px-2 py-0.5 text-xs text-text-muted">
            {accountCount} account{accountCount === 1 ? "" : "s"}
          </span>
          {mode === "proposal" && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
              pending review — not yet saved
            </span>
          )}
          {counts.documentMatchedCount > 0 && (
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
              {counts.documentMatchedCount} from documents
            </span>
          )}
          {counts.aiFallbackCount > 0 && (
            <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800">
              {counts.aiFallbackCount} AI classified
            </span>
          )}
          {counts.needsMappingCount > 0 && (
            <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
              {counts.needsMappingCount} need{counts.needsMappingCount === 1 ? "s" : ""} mapping
            </span>
          )}
          {pendingRecCount > 0 && (
            <button
              onClick={() => setShowRecPanel(true)}
              title="Review AI hierarchy suggestions"
              className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary hover:bg-primary/20"
            >
              <Sparkles size={11} />
              Review Recommendations ({pendingRecCount})
            </button>
          )}
          {pendingCount > 0 && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
              {pendingCount} unsaved edit{pendingCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search accounts…"
              className="w-56 rounded-lg border border-border py-1.5 pl-8 pr-2 text-sm"
            />
          </div>
          <button
            onClick={() => openCreateParent(null)}
            disabled={!accountCount}
            title="Create a new parent group anywhere in this Chart of Accounts"
            className="flex items-center gap-1 rounded-lg border border-primary px-2 py-1.5 text-xs font-semibold text-primary hover:bg-primary/5 disabled:opacity-40"
          >
            <FolderPlus size={13} /> Add Parent
          </button>
          <button
            onClick={collapseAll}
            title="Collapse all categories"
            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page"
          >
            <ChevronsUp size={13} /> Collapse All
          </button>
          <button
            onClick={expandAll}
            title="Expand all categories"
            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page"
          >
            <ChevronsDown size={13} /> Expand All
          </button>
          <button
            onClick={undo}
            disabled={!history.length}
            title="Undo"
            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page disabled:opacity-40"
          >
            <Undo2 size={13} /> Undo
          </button>
          <button
            onClick={redo}
            disabled={!future.length}
            title="Redo"
            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page disabled:opacity-40"
          >
            <Redo2 size={13} /> Redo
          </button>
          {(history.length > 0 || pendingCount > 0) && (
            <button
              onClick={discardDraft}
              title="Discard unsaved changes"
              className="flex items-center gap-1 rounded-lg border border-border px-2 py-1.5 text-xs font-semibold text-text-muted hover:bg-bg-page"
            >
              <X size={13} /> Discard
            </button>
          )}
          {mode === "approved" && (
            <button
              onClick={handleResetAll}
              disabled={resettingAll}
              className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page disabled:opacity-50"
              title="Restore all accounts to their original classification"
            >
              {resettingAll ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
              Reset all
            </button>
          )}
          <button
            onClick={handleExport}
            disabled={!accountCount}
            title="Download the full Chart of Accounts as an Excel file"
            className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page disabled:opacity-50"
          >
            <Download size={13} />
            Export
          </button>
          <button
            onClick={handleRegenerate}
            disabled={regenerating || !hasSyncedData}
            title={hasSyncedData ? "Rebuild the proposal from this version's extracted data" : "Run Generate first"}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page disabled:opacity-50"
          >
            {regenerating ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Regenerate
          </button>
          <button
            onClick={requestSave}
            disabled={saving || !accountCount || !draftValidation.valid}
            title={!draftValidation.valid ? "Fix the issues below before saving" : saveLabel}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {saveLabel}
          </button>
        </div>
      </div>

      {/* ── Proposal-review banner ───────────────────────────────────────── */}
      {mode === "proposal" && !isEmpty && (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600" />
          <p className="text-xs text-amber-800">
            This is a proposed Chart of Accounts — nothing has been saved yet, and no reports have been
            generated. Review the hierarchy below, make any adjustments, then click
            <strong> {saveLabel}</strong> to persist it and generate Trial Balance / Reconciliation /
            Balance Sheet / P&amp;L / Cash Flow.
            <br />
            <span className="text-amber-700">
              To reclassify an account, <strong>drag its row onto any other account row</strong> — it moves
              into that account&apos;s category and takes its classification, so you can move accounts between
              Assets / Liabilities / Equity / Income / Expenses or between nested categories. Undo is available.
            </span>
          </p>
        </div>
      )}

      {/* ── Live validation banner ────────────────────────────────────────── */}
      {!draftValidation.valid && accountCount > 0 && (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600" />
          <div className="text-xs text-amber-800">
            <p className="font-semibold">This tree can't be saved yet:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {draftValidation.violations.slice(0, 5).map((v, i) => <li key={i}>{v}</li>)}
            </ul>
          </div>
        </div>
      )}
      {saveErrors && (
        <div className="flex items-start gap-2 border-b border-red-200 bg-red-50 px-4 py-2.5">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-red-600" />
          <div className="text-xs text-red-800">
            <p className="font-semibold">Save rejected — the server found these problems:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {saveErrors.map((v, i) => <li key={i}>{v}</li>)}
            </ul>
          </div>
        </div>
      )}

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center gap-2 px-4 py-10 text-sm text-text-muted">
          <Loader2 size={15} className="animate-spin" /> Loading…
        </div>
      ) : isEmpty ? (
        <p className="px-4 py-10 text-center text-sm text-text-muted">
          {hasSyncedData
            ? "No pending Chart of Accounts proposal to review. Click Regenerate to build one."
            : "Upload financial statements and run Generate to build the Chart of Accounts."}
        </p>
      ) : (
        <div
          ref={tableWrapRef}
          className="overflow-x-auto"
          onDragOver={onTableDragOver}
          onDragLeave={onTableDragLeave}
        >
          <table className="min-w-max w-full border-collapse text-sm">
            {/* ── Column headers — dark teal matching the Excel ─────────────── */}
            <thead>
              <tr className="text-left text-[11px] font-bold uppercase tracking-wider text-white"
                  style={{ backgroundColor: "#1B3A5C" }}>
                <th
                  className="sticky whitespace-nowrap px-3 py-2.5 border-r border-white/10 z-20"
                  style={{ left: STICKY_LEFT_1, width: STICKY_COL_1_WIDTH, backgroundColor: HEADER_BG }}
                >
                  System ID
                </th>
                <th
                  className="sticky whitespace-nowrap px-3 py-2.5 border-r border-white/10 z-20"
                  style={{ left: STICKY_LEFT_2, width: STICKY_COL_2_WIDTH, backgroundColor: HEADER_BG }}
                >
                  Account Number
                </th>
                <th
                  className="sticky whitespace-nowrap px-3 py-2.5 border-r-2 border-border/50 z-20 min-w-[180px] shadow-[2px_0_4px_-2px_rgba(0,0,0,0.15)]"
                  style={{ left: STICKY_LEFT_3, backgroundColor: HEADER_BG }}
                >
                  Account Name
                </th>
                <th className="whitespace-nowrap px-3 py-2.5 border-r border-white/10">Statement Type</th>
                {LEVEL_INDEXES.map((i) => (
                  <th key={i} className="whitespace-nowrap px-2 py-2.5 border-r border-white/10 min-w-[90px]">
                    Level {i + 1}
                  </th>
                ))}
                <th className="whitespace-nowrap px-3 py-2.5 border-r border-white/10 min-w-[200px]">Hierarchy Path</th>
                <th className="whitespace-nowrap px-3 py-2.5 border-r border-white/10">Method</th>
                <th className="whitespace-nowrap px-3 py-2.5 border-r border-white/10 min-w-[160px]">Adjusted Name</th>
                <th className="whitespace-nowrap px-3 py-2.5 text-right">Actions</th>
              </tr>
            </thead>

            <tbody>
              {tableRows.map((item) => {
                if (item.kind === "section") {
                  return (
                    <tr key={`sec-${item.section.key}`} style={{ backgroundColor: "#1B3A5C" }}>
                      <td colSpan={TOTAL_COLS} className="px-4 py-2.5 text-xs font-extrabold uppercase tracking-widest text-white">
                        {item.section.label}
                        {search && (
                          <span className="ml-3 text-white/50 font-normal normal-case tracking-normal">
                            {item.count} result{item.count !== 1 ? "s" : ""}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                }

                if (item.kind === "subGroup") {
                  const anchorKey = subGroupAnchorKey[item.sg.key];
                  return (
                    <tr key={`sg-${item.sg.key}`} style={{ backgroundColor: "#2C4D7A" }}>
                      <td colSpan={TOTAL_COLS} className="px-6 py-2 text-xs font-bold text-white">
                        <div className="flex items-center justify-between">
                          <span>
                            {item.sg.label}
                            <span className="ml-2 text-white/40 font-normal">({item.count})</span>
                          </span>
                          {anchorKey && (
                            <button
                              onClick={() => openCreateParent(anchorKey)}
                              title={`Add a parent under ${item.sg.label}`}
                              className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-semibold text-white/70 hover:bg-white/10 hover:text-white"
                            >
                              <FolderPlus size={13} /> Add Parent
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                }

                if (item.kind === "empty") {
                  return (
                    <tr key={`empty-${item.sg.key}`} className="bg-white">
                      <td colSpan={TOTAL_COLS} className="px-8 py-2 text-xs text-text-muted italic">
                        No {item.sg.label.toLowerCase()} accounts found.
                      </td>
                    </tr>
                  );
                }

                // A subsection header straight from the backend's ancestry. Not an
                // account: it deliberately carries no system id, account number,
                // statement badge, level cells or row actions.
                if (item.kind === "category") {
                  const catNode = item.node;
                  const isCollapsed = collapsedKeys.has(catNode.key);
                  const isDropTargetCat = dropKey === catNode.key && dragKey !== catNode.key;
                  const catBg = isDropTargetCat ? "rgba(139,197,61,0.1)" : "#f9fafb";
                  const isRenamingThis = categoryEditor?.mode === "rename" && categoryEditor.targetKey === catNode.key;
                  const isMovingThis = categoryEditor?.mode === "move" && categoryEditor.targetKey === catNode.key;
                  const moveTargets = isMovingThis ? getMoveTargetsForCategory(nodes, catNode) : [];

                  return (
                    <Fragment key={item.key}>
                    <tr
                      draggable={canReorder}
                      onDragStart={onRowDragStart(item)}
                      onDragEnd={clearDrag}
                      onDragOver={onRowDragOver(item)}
                      onDragLeave={() => { if (dropKey === catNode.key) setDropKey(null); }}
                      onDrop={onRowDrop(item)}
                      className={`border-b border-border/40 transition-colors ${canReorder ? "cursor-grab" : ""} ${
                        dragKey === catNode.key ? "opacity-40" : ""
                      } ${isDropTargetCat ? "outline outline-2 -outline-offset-2 outline-[#8BC53D]" : ""}`}
                    >
                      <td
                        className="sticky z-10 py-1.5 border-r-2 border-border/50 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]"
                        style={{ left: STICKY_LEFT_1, width: STICKY_LEFT_3, backgroundColor: catBg }}
                      >
                        <div className="flex items-center gap-1 min-w-0" style={{ paddingLeft: `${32 + item.depth * 16}px`, paddingRight: "8px" }}>
                          {item.hasChildren ? (
                            <button
                              onClick={() => toggleCollapsed(catNode.key)}
                              title={isCollapsed ? "Expand" : "Collapse"}
                              className="shrink-0 rounded p-0.5 text-text-muted hover:bg-white/60"
                            >
                              {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                            </button>
                          ) : (
                            <span className="inline-block w-[18px] shrink-0" />
                          )}
                          <span className="truncate text-[12px] font-semibold text-text-secondary" title={item.label}>
                            {item.label}
                          </span>
                        </div>
                      </td>
                      <td colSpan={TOTAL_COLS - 1} className="py-1.5 px-3" style={{ backgroundColor: catBg }}>
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => openCreateParent(catNode.key)}
                            title={`Add a parent under "${item.label}"`}
                            className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-semibold text-text-muted hover:bg-white/80 hover:text-primary"
                          >
                            <FolderPlus size={12} /> Add Parent
                          </button>
                          <button
                            onClick={() => (isRenamingThis ? closeCategoryEditor() : openRenameCategory(catNode))}
                            title="Rename this category"
                            className="rounded p-1 text-text-muted hover:bg-white/80 hover:text-text-primary"
                          >
                            <Pencil size={12} />
                          </button>
                          <button
                            onClick={() => (isMovingThis ? closeCategoryEditor() : openMoveCategory(catNode))}
                            title="Move this category elsewhere"
                            className="rounded p-1 text-text-muted hover:bg-white/80 hover:text-primary"
                          >
                            <ArrowRightLeft size={12} />
                          </button>
                          {!item.hasChildren && (
                            <button
                              onClick={() => handleDeleteCategory(catNode)}
                              title="Delete this empty category"
                              className="rounded p-1 text-text-muted hover:bg-white/80 hover:text-red-600"
                            >
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>

                    {isRenamingThis && (
                      <tr className="bg-primary/5 border-b border-border/40">
                        <td colSpan={TOTAL_COLS} className="px-4 py-3">
                          <div className="flex flex-wrap items-end gap-3">
                            <div className="flex flex-col gap-1">
                              <label className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                                Rename "{item.label}" to
                              </label>
                              <input
                                autoFocus
                                value={categoryEditor.value}
                                onChange={(e) => setCategoryEditor((c) => ({ ...c, value: e.target.value }))}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") submitCategoryEditor();
                                  if (e.key === "Escape") closeCategoryEditor();
                                }}
                                placeholder="Category name"
                                className="w-[320px] rounded border border-primary px-2 py-1.5 text-xs"
                              />
                            </div>
                            <button onClick={submitCategoryEditor} className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
                              <Check size={13} /> Rename
                            </button>
                            <button onClick={closeCategoryEditor} className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-white">
                              <X size={13} /> Cancel
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}

                    {isMovingThis && (
                      <tr className="bg-primary/5 border-b border-border/40">
                        <td colSpan={TOTAL_COLS} className="px-4 py-3">
                          <div className="flex flex-wrap items-end gap-3">
                            <div className="flex flex-col gap-1">
                              <label className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                                Move "{item.label}" under
                              </label>
                              <input
                                autoFocus
                                list={`coa-cat-move-options-${catNode.key}`}
                                value={categoryEditor.value}
                                onChange={(e) => setCategoryEditor((c) => ({ ...c, value: e.target.value }))}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") submitCategoryEditor();
                                  if (e.key === "Escape") closeCategoryEditor();
                                }}
                                placeholder="Pick a destination category"
                                className="w-[420px] rounded border border-primary px-2 py-1.5 text-xs"
                              />
                              <datalist id={`coa-cat-move-options-${catNode.key}`}>
                                {moveTargets.map((c) => <option key={c.node.key} value={c.path} />)}
                              </datalist>
                            </div>
                            <button onClick={submitCategoryEditor} className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
                              <Check size={13} /> Move
                            </button>
                            <button onClick={closeCategoryEditor} className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-white">
                              <X size={13} /> Cancel
                            </button>
                          </div>
                          <p className="mt-2 text-[11px] text-text-muted">
                            Only same-statement destinations are listed — moving across Balance Sheet/P&L isn't supported here.
                          </p>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                }

                const { row } = item;
                const isEditing = editingKey === row.key;
                const levels = row.levels || [];
                // Level cells repeat the LEAF past the account's real depth, the
                // same storage/display convention the persisted level_1..15
                // columns use (levelsToColumns -> padLevelsWithLeafPropagation).
                // getLevelsArray pads with "" because its output also keys path
                // identity, so the propagation is applied here, for display only.
                // `levels` itself is left untouched -- the edit handlers derive
                // the real category path from it.
                const displayLevels = (() => {
                  const real = levels.filter(Boolean);
                  if (!real.length) return levels;
                  const leaf = real[real.length - 1];
                  return LEVEL_INDEXES.map((i) => (i < real.length ? real[i] : leaf));
                })();
                const rowRec = row.accountId ? rec.byAccountId.get(row.accountId) : null;

                return (
                  <Fragment key={row.key}>
                  <tr
                    draggable={canReorder && editingKey !== row.key}
                    onDragStart={onRowDragStart(row)}
                    onDragEnd={clearDrag}
                    onDragOver={onRowDragOver(row)}
                    onDragLeave={() => { if (dropKey === row.key) setDropKey(null); }}
                    onDrop={onRowDrop(row)}
                    className={`border-b border-border/40 bg-white transition-colors hover:bg-gray-50 ${
                      row.userEdited ? "bg-primary/5" : ""
                    } ${canReorder ? "cursor-grab" : ""} ${
                      dragKey === row.key ? "opacity-40" : ""
                    } ${
                      dropKey === row.key && dragKey !== row.key
                        ? "outline outline-2 -outline-offset-2 outline-[#8BC53D] bg-[#8BC53D]/10"
                        : ""
                    }`}
                  >
                    <td
                      className="sticky whitespace-nowrap px-3 py-1.5 font-mono text-xs font-semibold text-text-muted border-r border-border/30 z-10"
                      style={{
                        left: STICKY_LEFT_1,
                        width: STICKY_COL_1_WIDTH,
                        backgroundColor: getStickyRowBg(row, { isDropTarget: dropKey === row.key && dragKey !== row.key }),
                      }}
                    >
                      {canReorder && (
                        <GripVertical
                          className="mr-1 inline h-3 w-3 align-[-2px] text-text-muted/50"
                          aria-hidden="true"
                        />
                      )}
                      {row.systemId || "—"}
                    </td>

                    <td
                      className="sticky whitespace-nowrap px-3 py-1.5 font-mono text-xs text-text-muted border-r border-border/30 z-10"
                      style={{
                        left: STICKY_LEFT_2,
                        width: STICKY_COL_2_WIDTH,
                        backgroundColor: getStickyRowBg(row, { isDropTarget: dropKey === row.key && dragKey !== row.key }),
                      }}
                    >
                      {row.accountNumber || ""}
                    </td>

                    {/* Indented to sit under its category header. Indentation only —
                        every existing cell, badge and action below is untouched. */}
                    <td
                      className="sticky whitespace-nowrap px-3 py-1.5 border-r-2 border-border/50 z-10 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]"
                      style={{
                        left: STICKY_LEFT_3,
                        backgroundColor: getStickyRowBg(row, { isDropTarget: dropKey === row.key && dragKey !== row.key }),
                        ...(item.depth ? { paddingLeft: `${12 + item.depth * 16}px` } : {}),
                      }}
                    >
                      <span className="text-text-primary text-[13px]" title={row.accountName}>
                        {row.accountName}
                      </span>
                      {row.userEdited && (
                        <span className="ml-1.5 rounded-full bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                          modified
                        </span>
                      )}
                      {row.classificationSource && (
                        <span
                          className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                            row.classificationSource === "AI_FALLBACK"
                              ? "bg-purple-100 text-purple-800"
                              : row.classificationSource === "USER_EDITED"
                                ? "bg-emerald-100 text-emerald-800"
                                : "bg-blue-100 text-blue-800"
                          }`}
                        >
                          {CLASSIFICATION_SOURCE_LABELS[row.classificationSource] || row.classificationSource}
                        </span>
                      )}
                      {rowRec && <RecommendationBadge rec={rowRec} accept={rec.accept} ignore={rec.ignore} deciding={rec.decidingId === rowRec.id} />}
                    </td>

                    <td className="whitespace-nowrap px-3 py-1.5 border-r border-border/30">
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          row.statementType === "profit_loss"
                            ? "bg-amber-200 text-amber-900"
                            : "bg-blue-200 text-blue-900"
                        }`}
                      >
                        {STATEMENT_LABELS[row.statementType] || row.statementType || "—"}
                      </span>
                    </td>

                    {LEVEL_INDEXES.map((i) => (
                      <td
                        key={i}
                        className="px-2 py-1.5 text-xs text-text-secondary border-r border-border/30 max-w-[110px]"
                        title={isEditing ? "" : (displayLevels[i] || "")}
                      >
                        {isEditing ? (
                          <input
                            value={editLevels[i] || ""}
                            onChange={(e) => setEditLevelAt(i, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter")  saveEdit(row);
                              if (e.key === "Escape") cancelEdit();
                            }}
                            className="w-full min-w-[80px] rounded border border-primary px-1 py-0.5 text-xs"
                          />
                        ) : (
                          <span className="block truncate">{displayLevels[i] || ""}</span>
                        )}
                      </td>
                    ))}

                    <td className="px-3 py-1.5 text-xs text-text-muted border-r border-border/30">
                      {isEditing ? (
                        <>
                          <input
                            list={`coa-path-options-${row.key}`}
                            value={editPathValue}
                            onChange={(e) => setEditPathValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter")  saveEdit(row);
                              if (e.key === "Escape") cancelEdit();
                            }}
                            placeholder='Separate levels with ">" (e.g. Total Assets > Current Assets > Bank Accounts > Chase Bank)'
                            className="w-[260px] rounded border border-primary px-2 py-0.5 text-xs"
                          />
                          <datalist id={`coa-path-options-${row.key}`}>
                            {categoryOptions.map((c) => (
                              <option key={c.node.key} value={`${c.path} > ${editName || row.name}`} />
                            ))}
                          </datalist>
                        </>
                      ) : (
                        <span className="block max-w-[220px] truncate" title={row.hierarchyPath}>{row.hierarchyPath || "—"}</span>
                      )}
                    </td>

                    <td className="whitespace-nowrap px-3 py-1.5 border-r border-border/30">
                      <span className="rounded bg-white/70 border border-border/40 px-1.5 py-0.5 text-[10px] text-text-muted">
                        {METHOD_LABELS[row.classificationMethod] || row.classificationMethod || "—"}
                      </span>
                    </td>

                    <td className="whitespace-nowrap px-3 py-1.5 border-r border-border/30">
                      {isEditing ? (
                        <div className="flex items-center gap-1">
                          <input
                            autoFocus
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter")  saveEdit(row);
                              if (e.key === "Escape") cancelEdit();
                            }}
                            className="w-40 rounded border border-primary px-2 py-0.5 text-xs"
                          />
                          <button onClick={() => saveEdit(row)} title="Save" className="rounded p-1 text-primary hover:bg-white/60">
                            <Check size={12} />
                          </button>
                          <button onClick={cancelEdit} title="Cancel" className="rounded p-1 text-text-muted hover:bg-white/60">
                            <X size={12} />
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-text-primary" title={row.adjustedName}>
                          {row.adjustedName || "—"}
                        </span>
                      )}
                    </td>

                    <td className="whitespace-nowrap px-3 py-1.5">
                      {!isEditing && (
                        <div className="flex items-center justify-end gap-1">
                          {row.needsMapping && (
                            <button
                              onClick={() => (mappingKey === row.key ? cancelMapping() : startMapping(row))}
                              title="Map to an existing category"
                              className="rounded p-1 text-red-600 hover:bg-white/60"
                            >
                              <FolderInput size={12} />
                            </button>
                          )}
                          <button onClick={() => startEdit(row)} title="Edit this account (name, hierarchy path, parent)" className="rounded p-1 text-text-muted hover:bg-white/60 hover:text-text-primary">
                            <Pencil size={12} />
                          </button>
                          <button
                            onClick={() => (mergeEditor?.__forKey === row.key ? closeMergeEditor() : openMergeEditor(row))}
                            title="Merge this account's category into another"
                            className="rounded p-1 text-text-muted hover:bg-white/60 hover:text-primary"
                          >
                            <GitMerge size={12} />
                          </button>
                          {mode === "approved" && row.userEdited && (
                            <button onClick={() => resetRow(row)} title="Restore original classification" className="rounded p-1 text-text-muted hover:bg-white/60 hover:text-amber-600">
                              <RotateCcw size={12} />
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>

                  {mappingKey === row.key && (
                    <tr key={`map-${row.key}`} className="bg-red-50/60 border-b border-border/40">
                      <td colSpan={TOTAL_COLS} className="px-4 py-3">
                        <div className="flex flex-wrap items-end gap-3">
                          <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                              Place under existing (or new) category
                            </label>
                            <input
                              list={`coa-map-category-options-${row.key}`}
                              value={mappingCategoryPath}
                              onChange={(e) => setMappingCategoryPath(e.target.value)}
                              placeholder="Existing category, or type a new one"
                              className="w-[420px] rounded border border-border px-2 py-1.5 text-xs"
                            />
                            <datalist id={`coa-map-category-options-${row.key}`}>
                              {categoryOptions.map((c) => <option key={c.node.key} value={c.path} />)}
                            </datalist>
                          </div>
                          <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                              Account name (final level)
                            </label>
                            <input
                              value={mappingBaseName}
                              onChange={(e) => setMappingBaseName(e.target.value)}
                              className="w-56 rounded border border-border px-2 py-1.5 text-xs"
                            />
                          </div>
                          <button
                            onClick={() => saveMapping(row)}
                            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                          >
                            <Check size={13} /> Stage mapping
                          </button>
                          <button onClick={cancelMapping} className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-white">
                            <X size={13} /> Cancel
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}

                  {mergeEditor?.__forKey === row.key && (
                    <tr key={`merge-${row.key}`} className="bg-primary/5 border-b border-border/40">
                      <td colSpan={TOTAL_COLS} className="px-4 py-3">
                        <div className="flex flex-wrap items-end gap-3">
                          <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                              Merge "{mergeEditor.categoryPathArr.join(" > ") || "(root)"}" into
                            </label>
                            <input
                              autoFocus
                              list={`coa-merge-options-${row.key}`}
                              value={mergeEditor.value}
                              onChange={(e) => setMergeEditor((m) => ({ ...m, value: e.target.value }))}
                              placeholder="Existing category (or a new one) this should merge into"
                              className="w-[420px] rounded border border-primary px-2 py-1.5 text-xs"
                            />
                            <datalist id={`coa-merge-options-${row.key}`}>
                              {categoryOptions.map((c) => <option key={c.node.key} value={c.path} />)}
                            </datalist>
                          </div>
                          <button onClick={submitMergeEditor} className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
                            <Check size={13} /> Stage merge
                          </button>
                          <button onClick={closeMergeEditor} className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-white">
                            <X size={13} /> Cancel
                          </button>
                        </div>
                        <p className="mt-2 text-[11px] text-text-muted">
                          Moves every account under this same category (not just this one) to the target category.
                        </p>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <RecommendedChangesPanel isOpen={showRecPanel} onClose={() => setShowRecPanel(false)} rec={rec} />

      {/* Mounted only while open, so each launch seeds fresh from the row the
          user clicked rather than carrying over the previous name/destination. */}
      {showCreateParent && (
        <CreateParentModal
          isOpen
          onClose={() => setShowCreateParent(false)}
          nodes={nodes}
          initialParentKey={createParentUnder}
          onCreate={handleCreateParent}
        />
      )}

      <Modal isOpen={showSavePreview} onClose={() => setShowSavePreview(false)} title="Review changes before saving" size="lg">
        <div className="space-y-4">
          {saveDiff.created.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-text-primary">New categories ({saveDiff.created.length})</p>
              <ul className="mt-1 space-y-1">
                {saveDiff.created.map((c) => (
                  <li key={c.key} className="text-xs text-text-muted">
                    {c.path}
                    {!c.hasDescendantAccount && (
                      <span className="ml-1.5 rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-800">
                        empty — no accounts moved in yet
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {saveDiff.deleted.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-text-primary">Deleted categories ({saveDiff.deleted.length})</p>
              <ul className="mt-1 space-y-1">
                {saveDiff.deleted.map((c) => <li key={c.key} className="text-xs text-text-muted">{c.path}</li>)}
              </ul>
            </div>
          )}
          {saveDiff.renamed.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-text-primary">Renamed categories ({saveDiff.renamed.length})</p>
              <ul className="mt-1 space-y-1">
                {saveDiff.renamed.map((c) => (
                  <li key={c.key} className="text-xs text-text-muted">
                    "{c.from}" → "{c.to}" <span className="text-text-muted/70">({c.path})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {saveDiff.movedCategories.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-text-primary">Moved categories ({saveDiff.movedCategories.length})</p>
              <ul className="mt-1 space-y-1">
                {saveDiff.movedCategories.map((c) => (
                  <li key={c.key} className="text-xs text-text-muted">
                    "{c.label}": {c.fromParentPath} → {c.toParentPath}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {saveDiff.moved.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-text-primary">Moved accounts ({saveDiff.moved.length})</p>
              <ul className="mt-1 space-y-1">
                {saveDiff.moved.map((a) => (
                  <li key={a.key} className="text-xs text-text-muted">
                    <span className="font-medium text-text-primary">{a.name}</span>: {a.fromPath} → {a.toPath}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {saveDiffIsEmpty && <p className="text-sm text-text-muted">No hierarchy changes to review.</p>}

          <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
            <button
              onClick={discardFromPreview}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page"
            >
              Discard all changes
            </button>
            <button
              onClick={confirmSaveFromPreview}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              Confirm & Save
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function RecommendationBadge({ rec, accept, ignore, deciding }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative ml-1.5 inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        title="AI hierarchy suggestion available"
        className="flex items-center gap-1 rounded-full border border-dashed border-primary bg-primary/5 px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10"
      >
        <Sparkles size={10} /> Suggestion
      </button>
      {open && (
        <div className="absolute left-0 top-6 z-10 w-80 rounded-xl border border-border bg-white p-3 text-left shadow-lg">
          <p className="text-xs text-text-muted">
            Suggested roll-up: <span className="font-semibold text-text-primary">{rec.recommendedRollup}</span>
            {rec.recommendedParent ? <> under <span className="font-semibold">{rec.recommendedParent}</span></> : null}
          </p>
          {rec.reason && <p className="mt-1 text-[11px] text-text-muted">{rec.reason}</p>}
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={async () => { const ok = await accept(rec.id); if (ok) setOpen(false); }}
              disabled={deciding}
              className="flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50"
            >
              <Check size={11} /> Accept
            </button>
            <button
              onClick={async () => { await ignore(rec.id); setOpen(false); }}
              disabled={deciding}
              className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-semibold text-text-muted disabled:opacity-50"
            >
              <X size={11} /> Ignore
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
