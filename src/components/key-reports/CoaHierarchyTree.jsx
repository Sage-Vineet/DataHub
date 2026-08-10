import { useMemo, useState, Fragment } from "react";
import { ChevronRight, ChevronDown, Folder, FolderOpen, FileText } from "lucide-react";
import { buildIndexes, displayName } from "../../lib/coaTree";

// A generic, expandable Chart of Accounts hierarchy tree.
//
// Deliberately statement-agnostic: it renders whatever `nodes` (the flat
// { key, parentKey, nodeType } wire shape the whole COA editor already uses)
// describes, so Balance Sheet and Profit & Loss both flow through this ONE
// component. There is no per-section logic and nothing about Assets /
// Liabilities / Equity / Revenue / Expenses is named here — the hierarchy is
// entirely whatever the generated COA says it is.
//
// Used as the "Place under" selector in CreateParentModal, and reusable
// anywhere a read-only or selectable COA tree is needed.
//
// Props
//   nodes           flat node list (the tree)
//   selectedKey     currently selected node key, or null for "top level"
//   onSelect        (key|null) => void; omit to render a non-interactive tree
//   rootKeys        optional: restrict to these subtrees (defaults to real roots)
//   showAccounts    include ACCOUNT leaves (default false — a parent can only
//                   ever be created under a CATEGORY, so the picker hides them)
//   disabledKeys    Set of keys that cannot be selected (e.g. a node's own
//                   subtree when re-parenting it)
//   highlightKeys   Set of keys to badge as newly added (preview mode)
//   allowRoot       show a selectable "Top level" row (default false)
//   emptyText       message when there is nothing to show
//   maxHeight       CSS max-height for the scroll area (default 320px)
export default function CoaHierarchyTree({
  nodes,
  selectedKey = null,
  onSelect = null,
  rootKeys = null,
  showAccounts = false,
  disabledKeys = null,
  highlightKeys = null,
  allowRoot = false,
  emptyText = "No categories in this Chart of Accounts yet.",
  maxHeight = 320,
  autoExpandKey = null,
}) {
  const { nodesByKey, childrenByParentKey } = useMemo(() => buildIndexes(nodes), [nodes]);

  const roots = useMemo(() => {
    if (rootKeys?.length) return rootKeys.map((k) => nodesByKey.get(k)).filter(Boolean);
    return childrenByParentKey.get(null) || [];
  }, [rootKeys, nodesByKey, childrenByParentKey]);

  // Start with the path to the selected (or explicitly requested) node open, so
  // the current choice is visible without hunting for it.
  const [expanded, setExpanded] = useState(() => {
    const open = new Set();
    let cur = autoExpandKey || selectedKey;
    let guard = 0;
    while (cur && guard < 64) {
      open.add(cur);
      cur = nodes?.find((n) => n.key === cur)?.parentKey || null;
      guard += 1;
    }
    return open;
  });

  const toggle = (key) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const renderNode = (node, depth) => {
    const children = (childrenByParentKey.get(node.key) || [])
      .filter((c) => showAccounts || c.nodeType === "CATEGORY");
    const hasChildren = children.length > 0;
    const isOpen = expanded.has(node.key);
    const isAccount = node.nodeType === "ACCOUNT";
    const isSelected = selectedKey === node.key;
    const isDisabled = Boolean(disabledKeys?.has(node.key)) || isAccount;
    const isNew = Boolean(highlightKeys?.has(node.key));

    return (
      <Fragment key={node.key}>
        <div
          className={`flex items-center gap-1 rounded-lg pr-2 ${
            isSelected ? "bg-primary/10" : isNew ? "bg-emerald-50" : "hover:bg-bg-page"
          }`}
          style={{ paddingLeft: `${depth * 16}px` }}
        >
          <button
            type="button"
            onClick={() => hasChildren && toggle(node.key)}
            className="flex h-6 w-5 shrink-0 items-center justify-center text-text-muted disabled:opacity-0"
            disabled={!hasChildren}
            aria-label={hasChildren ? (isOpen ? "Collapse" : "Expand") : undefined}
          >
            {hasChildren ? (isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}
          </button>

          <button
            type="button"
            onClick={() => !isDisabled && onSelect?.(node.key)}
            disabled={isDisabled || !onSelect}
            title={isDisabled && !isAccount ? "Can't place a parent inside its own subtree" : displayName(node)}
            className={`flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-[13px] ${
              isDisabled
                ? "cursor-not-allowed text-text-muted/60"
                : onSelect
                  ? "cursor-pointer text-text-primary"
                  : "text-text-primary"
            } ${isSelected ? "font-semibold text-primary" : ""}`}
          >
            {isAccount ? (
              <FileText size={12} className="shrink-0 text-text-muted" />
            ) : isOpen && hasChildren ? (
              <FolderOpen size={12} className="shrink-0 text-primary/70" />
            ) : (
              <Folder size={12} className="shrink-0 text-primary/70" />
            )}
            <span className="truncate">{displayName(node)}</span>
            {isNew && (
              <span className="ml-1 shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                new
              </span>
            )}
          </button>
        </div>

        {hasChildren && isOpen && children.map((c) => renderNode(c, depth + 1))}
      </Fragment>
    );
  };

  return (
    <div
      className="overflow-y-auto rounded-xl border border-border bg-white p-1.5"
      style={{ maxHeight }}
    >
      {allowRoot && (
        <div
          className={`flex items-center gap-1 rounded-lg pr-2 ${selectedKey === null ? "bg-primary/10" : "hover:bg-bg-page"}`}
        >
          <span className="h-6 w-5 shrink-0" />
          <button
            type="button"
            onClick={() => onSelect?.(null)}
            disabled={!onSelect}
            className={`flex flex-1 items-center gap-1.5 py-1 text-left text-[13px] ${
              selectedKey === null ? "font-semibold text-primary" : "text-text-primary"
            }`}
          >
            <Folder size={12} className="shrink-0 text-primary/70" />
            Top level
          </button>
        </div>
      )}
      {roots.length === 0 && !allowRoot ? (
        <p className="px-2 py-6 text-center text-xs text-text-muted">{emptyText}</p>
      ) : (
        roots.map((r) => renderNode(r, 0))
      )}
    </div>
  );
}
