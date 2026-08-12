import { useMemo, useState } from "react";
import { FolderPlus, AlertTriangle, Check, X } from "lucide-react";
import Modal from "../common/Modal";
import CoaHierarchyTree from "./CoaHierarchyTree";
import {
  buildIndexes, displayName, getHierarchyPathLabel, validateNewCategory, createCategory,
} from "../../lib/coaTree";

// "Create New Parent" — a hierarchy-aware replacement for typing Level 1..15
// text fields by hand.
//
// The user gives the new parent a NAME and picks where it goes from the real
// COA tree; its levels/hierarchy path are derived from that parent-child
// relationship by the existing engine (getLevelsArray walks parentKey; the
// backend re-derives level_1..15 on Save). Nothing about levels is ever asked
// of, or shown to, the user as an editable field.
//
// Creation NEVER moves existing accounts: the new parent is added as a sibling
// of whatever already sits under the selected destination. Moving children into
// it is a separate, explicit action (drag-and-drop or the per-account editor).
export default function CreateParentModal({
  isOpen,
  onClose,
  nodes,
  initialParentKey = null,
  onCreate,
}) {
  // Seeded once per mount. The grid only mounts this while the dialog is open,
  // so every launch starts fresh on the row the user clicked — no effect
  // needed to re-seed, and no stale name left over from a previous open.
  const [name, setName] = useState("");
  const [parentKey, setParentKey] = useState(initialParentKey);

  const { nodesByKey, childrenByParentKey } = useMemo(() => buildIndexes(nodes), [nodes]);
  const parentNode = parentKey ? nodesByKey.get(parentKey) : null;
  const trimmed = name.trim();

  const validation = useMemo(
    () => validateNewCategory(nodes, parentKey, name),
    [nodes, parentKey, name],
  );
  // Don't scold the user before they've typed anything.
  const showError = Boolean(trimmed) && !validation.ok;

  const destinationPath = parentKey
    ? getHierarchyPathLabel(nodesByKey, parentKey)
    : "Top level";

  // Existing children of the destination — the "Before" list, and what the
  // "After" list shows the new parent joining WITHOUT absorbing.
  const siblings = useMemo(
    () => (childrenByParentKey.get(parentKey || null) || []).map((n) => ({
      key: n.key,
      name: displayName(n),
      isAccount: n.nodeType === "ACCOUNT",
    })),
    [childrenByParentKey, parentKey],
  );

  // Live preview built by running the REAL createCategory against a copy of
  // the tree — the preview can never disagree with what Create actually does,
  // because it is the same function.
  const preview = useMemo(() => {
    if (!validation.ok) return null;
    const result = createCategory(nodes, { parentKey: parentKey || null, label: trimmed });
    if (result.error) return null;
    return result;
  }, [nodes, parentKey, trimmed, validation.ok]);

  const submit = () => {
    if (!validation.ok) return;
    onCreate({ parentKey: parentKey || null, label: trimmed });
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create New Parent" size="lg">
      <div className="space-y-4">
        {/* ── Name ─────────────────────────────────────────────────────── */}
        <div>
          <label htmlFor="coa-new-parent-name" className="mb-1 block text-xs font-semibold text-text-primary">
            Parent name
          </label>
          <input
            id="coa-new-parent-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && validation.ok) submit();
              if (e.key === "Escape") onClose();
            }}
            placeholder="e.g. Cash Equivalents"
            className={`w-full rounded-lg border px-3 py-2 text-sm ${
              showError ? "border-red-400" : "border-border"
            }`}
          />
          {showError && (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs text-red-700">
              <AlertTriangle size={13} className="mt-px shrink-0" />
              {validation.message}
            </p>
          )}
        </div>

        {/* ── Destination picker ───────────────────────────────────────── */}
        <div>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="text-xs font-semibold text-text-primary">Place under</span>
            <span className="truncate text-[11px] text-text-muted" title={destinationPath}>
              {destinationPath}
            </span>
          </div>
          <CoaHierarchyTree
            nodes={nodes}
            selectedKey={parentKey}
            onSelect={setParentKey}
            allowRoot
            autoExpandKey={initialParentKey}
            maxHeight={240}
            emptyText="This Chart of Accounts has no categories yet — the new parent will be created at the top level."
          />
          <p className="mt-1.5 text-[11px] text-text-muted">
            Pick any category from your generated Chart of Accounts. Levels are worked out
            from this position — you never have to set Level 1, 2, 3 yourself.
          </p>
        </div>

        {/* ── Before / After preview ───────────────────────────────────── */}
        {validation.ok && preview && (
          <div>
            <span className="mb-1 block text-xs font-semibold text-text-primary">Preview</span>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-border bg-bg-page/50 p-2.5">
                <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-text-muted">Before</p>
                <p className="truncate text-[12px] font-semibold text-text-primary" title={destinationPath}>
                  {parentNode ? displayName(parentNode) : "Top level"}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {siblings.length === 0 && <li className="pl-3 text-[11px] italic text-text-muted">(empty)</li>}
                  {siblings.map((s) => (
                    <li key={s.key} className="truncate pl-3 text-[11px] text-text-secondary" title={s.name}>
                      {s.isAccount ? "· " : "▸ "}{s.name}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-2.5">
                <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-emerald-700">After</p>
                <p className="truncate text-[12px] font-semibold text-text-primary" title={destinationPath}>
                  {parentNode ? displayName(parentNode) : "Top level"}
                </p>
                <ul className="mt-1 space-y-0.5">
                  <li className="truncate pl-3 text-[11px] font-semibold text-emerald-800">
                    ▸ {trimmed}
                    <span className="ml-1.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold">new</span>
                  </li>
                  {siblings.map((s) => (
                    <li key={s.key} className="truncate pl-3 text-[11px] text-text-secondary" title={s.name}>
                      {s.isAccount ? "· " : "▸ "}{s.name}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <p className="mt-2 flex items-start gap-1.5 text-[11px] text-text-muted">
              <AlertTriangle size={12} className="mt-px shrink-0 text-amber-500" />
              Existing accounts stay exactly where they are. To put something inside
              <strong className="mx-1">{trimmed}</strong>, drag it there afterwards.
            </p>
          </div>
        )}

        {/* ── Actions ──────────────────────────────────────────────────── */}
        <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page"
          >
            <X size={13} /> Cancel
          </button>
          <button
            onClick={submit}
            disabled={!validation.ok}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            <FolderPlus size={13} /> Create Parent
          </button>
        </div>
      </div>
    </Modal>
  );
}
