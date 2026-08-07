import { useState } from "react";
import { Check, X, Sparkles, Loader2 } from "lucide-react";
import Modal from "../common/Modal";

// Reviews AI hierarchy suggestions in one place instead of one inline badge
// per account. Reads/writes the SAME useHierarchyRecommendations() instance
// the grid's inline RecommendationBadges use — approving here makes the
// inline badge disappear elsewhere for free, since both share `rec.accept`/
// `rec.ignore` (which already trigger a full reload()) and `rec.recommendations`.
//
// Honestly labeled as ONE "Hierarchy Changes" section: the AI engine only
// ever produces a single kind of suggestion (insert a roll-up label above an
// account's current position). There is no separate classification-change or
// level-change category in the data to split this into three.
export default function RecommendedChangesPanel({ isOpen, onClose, rec }) {
  const [bulkRunning, setBulkRunning] = useState(false);
  const pending = rec.recommendations.filter((r) => r.status === "pending");

  const runBulk = async (action, label) => {
    if (!pending.length) return;
    if (!window.confirm(`${label} all ${pending.length} pending recommendation${pending.length === 1 ? "" : "s"}?`)) return;
    setBulkRunning(true);
    try {
      // Sequential, not Promise.all — decidingId is a single scalar and each
      // accept/ignore call triggers its own full reload() internally; firing
      // them concurrently would thrash that indicator and fire N redundant
      // overlapping refetches. Fine at the realistic scale here (a handful
      // of pending recommendations per version).
      for (const r of pending) {
        await action(r.id);
      }
    } finally {
      setBulkRunning(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Recommended Changes" size="lg">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
            <Sparkles size={13} className="text-primary" />
            Hierarchy Changes ({pending.length})
          </p>
          {pending.length > 0 && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => runBulk(rec.accept, "Approve")}
                disabled={bulkRunning || rec.decidingId != null}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {bulkRunning ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                Approve All
              </button>
              <button
                onClick={() => runBulk(rec.ignore, "Reject")}
                disabled={bulkRunning || rec.decidingId != null}
                className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page disabled:opacity-50"
              >
                {bulkRunning ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                Reject All
              </button>
            </div>
          )}
        </div>

        {rec.loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-text-muted">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : pending.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-muted">No pending AI hierarchy suggestions.</p>
        ) : (
          <ul className="space-y-2">
            {pending.map((r) => {
              const deciding = rec.decidingId === r.id;
              return (
                <li key={r.id} className="rounded-xl border border-border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-text-primary">{r.accountName}</p>
                      <p className="mt-0.5 text-xs text-text-muted">
                        Currently under: {Array.isArray(r.currentHierarchy) && r.currentHierarchy.length
                          ? r.currentHierarchy.join(" > ")
                          : "(root)"}
                      </p>
                      <p className="mt-1 text-xs text-text-secondary">
                        Insert <span className="font-semibold text-text-primary">"{r.recommendedRollup}"</span>
                        {r.recommendedParent ? <> above, under <span className="font-medium">"{r.recommendedParent}"</span></> : null}
                      </p>
                      {r.reason && <p className="mt-1 text-[11px] text-text-muted">{r.reason}</p>}
                      {typeof r.confidence === "number" && (
                        <span className="mt-1 inline-block rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          {Math.round(r.confidence * 100)}% confidence
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        onClick={() => rec.accept(r.id)}
                        disabled={bulkRunning || deciding}
                        title="Approve"
                        className="flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50"
                      >
                        {deciding ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                        Approve
                      </button>
                      <button
                        onClick={() => rec.ignore(r.id)}
                        disabled={bulkRunning || deciding}
                        title="Reject"
                        className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-semibold text-text-muted disabled:opacity-50"
                      >
                        <X size={11} />
                        Reject
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
