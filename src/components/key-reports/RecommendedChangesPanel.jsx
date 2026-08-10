import { useState } from "react";
import { Check, X, Sparkles, Loader2, ArrowRight, FileWarning, ShieldCheck } from "lucide-react";
import Modal from "../common/Modal";

// AI Reasonableness Check review panel.
//
// Reads/writes the SAME useHierarchyRecommendations() instance the grid's
// inline badges use, so approving here makes the inline badge disappear
// elsewhere for free — both share rec.accept / rec.ignore, which reload()
// internally.
//
// Nothing here changes the Chart of Accounts directly: Accept calls the
// backend apply endpoint (which re-validates and refuses a stale
// recommendation), and Reject only records the decision.

const BAND_STYLE = {
  HIGH: "bg-emerald-100 text-emerald-800",
  MEDIUM: "bg-amber-100 text-amber-800",
  LOW: "bg-gray-100 text-gray-700",
};

const IMPACT_LABEL = {
  CLASSIFICATION: "Changes which statement this account appears on",
  OPERATING_RESULT: "Affects Operating Income / EBITDA / Other Income",
  BALANCE_SHEET_SECTION: "Affects Balance Sheet section totals",
  PRESENTATION: "Presentation only",
};

function HierarchyPath({ path, className = "" }) {
  if (!Array.isArray(path) || !path.length) return <span className="text-text-muted">—</span>;
  return (
    <span className={className} title={path.join(" > ")}>
      {path.join(" › ")}
    </span>
  );
}

function RecommendationCard({ rec, r, bulkRunning }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const deciding = rec.decidingId === r.id;
  const busy = bulkRunning || deciding;

  return (
    <li className="rounded-xl border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold text-text-primary">{r.accountName}</span>
            {r.systemId && (
              <span className="rounded bg-bg-page px-1.5 py-0.5 font-mono text-[10px] text-text-muted">{r.systemId}</span>
            )}
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${BAND_STYLE[r.confidenceBand] || BAND_STYLE.LOW}`}>
              {r.confidenceBand}
            </span>
            {r.kind === "RECLASSIFY" && (
              <span className="flex items-center gap-1 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
                <FileWarning size={10} /> Reclassification
              </span>
            )}
            {r.source === "AI_REASONABLENESS" && (
              <span
                className="rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-800"
                title="No matching section exists in the uploaded documents — this placement was derived by the AI."
              >
                AI-derived
              </span>
            )}
            {r.source === "DOCUMENT_MATCH" && (
              <span
                className="flex items-center gap-1 rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-800"
                title="The target section exists in this company's own uploaded statement structure."
              >
                <ShieldCheck size={10} /> From document
              </span>
            )}
          </div>

          <div className="mt-1.5 space-y-0.5 text-xs">
            <p className="text-text-muted">
              <span className="font-medium text-text-secondary">Current: </span>
              <HierarchyPath path={r.currentHierarchy} />
            </p>
            <p className="text-text-muted">
              <span className="font-medium text-text-secondary">Recommended: </span>
              <HierarchyPath path={r.recommendedHierarchy} className="text-emerald-800 font-medium" />
            </p>
            {r.kind === "RECLASSIFY" && r.recommendedAccountType && (
              <p className="text-text-muted">
                <span className="font-medium text-text-secondary">Type: </span>
                {r.currentAccountType} <ArrowRight size={10} className="inline" /> {r.recommendedAccountType}
              </p>
            )}
          </div>

          {r.reason && <p className="mt-1.5 text-[11px] text-text-muted">{r.reason}</p>}
          {r.impact && IMPACT_LABEL[r.impact] && (
            <p className="mt-1 text-[10px] font-medium uppercase tracking-wide text-text-muted/80">
              {IMPACT_LABEL[r.impact]}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <button
            onClick={() => rec.accept(r.id)}
            disabled={busy}
            title="Apply this recommendation to the Chart of Accounts"
            className="flex w-24 items-center justify-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50"
          >
            {deciding ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
            Accept
          </button>
          <button
            onClick={() => setRejecting((v) => !v)}
            disabled={busy}
            title="Leave the Chart of Accounts unchanged"
            className="flex w-24 items-center justify-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-semibold text-text-muted disabled:opacity-50"
          >
            <X size={11} /> Reject
          </button>
        </div>
      </div>

      {rejecting && (
        <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-border pt-2">
          <div className="flex min-w-[240px] flex-1 flex-col gap-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
              Reason (optional)
            </label>
            <input
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. intentionally treated as operating income for this client"
              className="rounded border border-border px-2 py-1.5 text-xs"
            />
          </div>
          <button
            onClick={async () => { await rec.ignore(r.id, reason.trim() || null); setRejecting(false); }}
            disabled={busy}
            className="rounded-lg bg-text-primary px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            Confirm reject
          </button>
          <button
            onClick={() => setRejecting(false)}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text-primary"
          >
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}

export default function RecommendedChangesPanel({ isOpen, onClose, rec }) {
  const [bulkRunning, setBulkRunning] = useState(false);
  const pending = rec.pending || rec.recommendations.filter((r) => r.status === "PENDING");
  const bands = rec.byConfidence || {
    HIGH: pending.filter((r) => r.confidenceBand === "HIGH"),
    MEDIUM: pending.filter((r) => r.confidenceBand === "MEDIUM"),
    LOW: pending.filter((r) => r.confidenceBand === "LOW"),
  };

  const runBulk = async (items, action, label) => {
    if (!items.length) return;
    if (!window.confirm(`${label} ${items.length} recommendation${items.length === 1 ? "" : "s"}?`)) return;
    setBulkRunning(true);
    try {
      // Sequential, not Promise.all — decidingId is a single scalar and each
      // call reloads the list internally; firing them concurrently would
      // thrash that indicator and cause N overlapping refetches.
      for (const r of items) {
        await action(r.id);
      }
    } finally {
      setBulkRunning(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="AI Reasonableness Check" size="xl">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
              <Sparkles size={14} className="text-primary" />
              {pending.length === 0
                ? "No classifications need review"
                : `AI found ${pending.length} classification${pending.length === 1 ? "" : "s"} that may need review`}
            </p>
            {pending.length > 0 && (
              <p className="mt-0.5 text-[11px] text-text-muted">
                {bands.HIGH.length} high · {bands.MEDIUM.length} medium · {bands.LOW.length} low confidence.
                Nothing changes until you accept.
              </p>
            )}
          </div>
          {pending.length > 0 && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => runBulk(bands.HIGH, rec.accept, "Accept all high-confidence")}
                disabled={bulkRunning || !bands.HIGH.length || rec.decidingId != null}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {bulkRunning ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                Accept All High Confidence ({bands.HIGH.length})
              </button>
              <button
                onClick={() => runBulk(pending, rec.ignore, "Reject all")}
                disabled={bulkRunning || rec.decidingId != null}
                className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page disabled:opacity-50"
              >
                <X size={12} /> Reject All
              </button>
            </div>
          )}
        </div>

        {rec.loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-text-muted">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : pending.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-muted">
            The generated Chart of Accounts looks reasonable — no presentation issues were found.
          </p>
        ) : (
          ["HIGH", "MEDIUM", "LOW"].map((band) => (
            bands[band].length > 0 && (
              <div key={band}>
                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-text-muted">
                  {band} confidence ({bands[band].length})
                </p>
                <ul className="space-y-2">
                  {bands[band].map((r) => (
                    <RecommendationCard key={r.id} rec={rec} r={r} bulkRunning={bulkRunning} />
                  ))}
                </ul>
              </div>
            )
          ))
        )}
      </div>
    </Modal>
  );
}
