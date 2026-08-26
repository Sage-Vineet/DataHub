import { useEffect, useState, useCallback } from "react";
import { ChevronRight, ChevronDown, FolderOpen, FileText, X, Loader2 } from "lucide-react";
import { listFolderTree, listFolderDocuments } from "../../lib/api";

// Lightweight Data Room file picker. Browses the company's folder tree and lets
// the user multi-select existing documents (no re-upload). Built standalone so
// it does not couple to the large FileExplorer component.
export default function DataRoomFilePicker({
  isOpen,
  companyId,
  title = "Select files from Data Room",
  alreadyLinkedIds = [],
  onClose,
  onSelect,
}) {
  const [tree, setTree] = useState([]);
  const [loadingTree, setLoadingTree] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [docsByFolder, setDocsByFolder] = useState({});
  const [loadingDocs, setLoadingDocs] = useState({});
  const [selected, setSelected] = useState({}); // documentId -> doc
  const [error, setError] = useState("");

  const linkedSet = new Set((alreadyLinkedIds || []).map(String));

  useEffect(() => {
    if (!isOpen || !companyId) return;
    setSelected({});
    setError("");
    setLoadingTree(true);
    listFolderTree(companyId)
      .then((nodes) => setTree(Array.isArray(nodes) ? nodes : []))
      .catch((e) => setError(e.message || "Failed to load folders."))
      .finally(() => setLoadingTree(false));
  }, [isOpen, companyId]);

  const loadDocs = useCallback(
    async (folderId) => {
      if (docsByFolder[folderId]) return;
      setLoadingDocs((m) => ({ ...m, [folderId]: true }));
      try {
        const docs = await listFolderDocuments(folderId);
        setDocsByFolder((m) => ({ ...m, [folderId]: Array.isArray(docs) ? docs : [] }));
      } catch (e) {
        setError(e.message || "Failed to load documents.");
      } finally {
        setLoadingDocs((m) => ({ ...m, [folderId]: false }));
      }
    },
    [docsByFolder]
  );

  const toggleFolder = (folderId) => {
    const next = !expanded[folderId];
    setExpanded((m) => ({ ...m, [folderId]: next }));
    if (next) loadDocs(folderId);
  };

  const toggleDoc = (doc) => {
    if (linkedSet.has(String(doc.id))) return;
    setSelected((m) => {
      const next = { ...m };
      if (next[doc.id]) delete next[doc.id];
      else next[doc.id] = doc;
      return next;
    });
  };

  const selectedList = Object.values(selected);

  const handleConfirm = () => {
    onSelect?.(selectedList);
    onClose?.();
  };

  if (!isOpen) return null;

  const renderFolder = (node, depth = 0) => {
    const isOpenFolder = !!expanded[node.id];
    const docs = docsByFolder[node.id] || [];
    const children = node.children || [];
    return (
      <div key={node.id}>
        <button
          type="button"
          onClick={() => toggleFolder(node.id)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-text-primary hover:bg-bg-page"
          style={{ paddingLeft: `${8 + depth * 16}px` }}
        >
          {isOpenFolder ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <FolderOpen size={15} className="text-text-muted" />
          <span className="truncate">{node.name}</span>
        </button>
        {isOpenFolder && (
          <div>
            {children.map((child) => renderFolder(child, depth + 1))}
            {loadingDocs[node.id] && (
              <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-text-muted" style={{ paddingLeft: `${28 + depth * 16}px` }}>
                <Loader2 size={12} className="animate-spin" /> Loading files…
              </div>
            )}
            {!loadingDocs[node.id] &&
              docs.map((doc) => {
                const isLinked = linkedSet.has(String(doc.id));
                const isChecked = !!selected[doc.id];
                return (
                  <label
                    key={doc.id}
                    className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
                      isLinked ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-bg-page"
                    }`}
                    style={{ paddingLeft: `${28 + depth * 16}px` }}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      disabled={isLinked}
                      onChange={() => toggleDoc(doc)}
                    />
                    <FileText size={15} className="text-text-muted" />
                    <span className="truncate text-text-primary">{doc.name}</span>
                    {isLinked && <span className="ml-auto text-[11px] text-text-muted">already linked</span>}
                  </label>
                );
              })}
            {!loadingDocs[node.id] && isOpenFolder && children.length === 0 && docs.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-text-muted" style={{ paddingLeft: `${28 + depth * 16}px` }}>
                No files in this folder.
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl border border-border bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h3 className="text-base font-bold text-text-primary">{title}</h3>
          <button onClick={onClose} className="rounded-md p-1 text-text-muted hover:bg-bg-page">
            <X size={18} />
          </button>
        </div>

        <div className="min-h-[200px] flex-1 overflow-auto px-3 py-3">
          {error && <div className="mb-2 rounded-md bg-red-50 px-3 py-2 text-sm text-negative">{error}</div>}
          {loadingTree ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-text-muted">
              <Loader2 size={16} className="animate-spin" /> Loading Data Room…
            </div>
          ) : tree.length === 0 ? (
            <div className="py-10 text-center text-sm text-text-muted">No folders found in the Data Room.</div>
          ) : (
            tree.map((node) => renderFolder(node, 0))
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border px-5 py-3">
          <span className="text-sm text-secondary">{selectedList.length} selected</span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-xl border border-border px-4 py-2 text-sm font-semibold text-secondary hover:bg-bg-page"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={selectedList.length === 0}
              className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Link {selectedList.length || ""} file{selectedList.length === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
