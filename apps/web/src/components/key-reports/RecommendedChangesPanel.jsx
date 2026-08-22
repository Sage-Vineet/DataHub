import { useState } from 'react';
import { ArrowRight, Check, FileWarning, Loader2, ShieldCheck, Sparkles, X } from 'lucide-react';
import Modal from '../common/Modal';

/**
 * The chart-of-accounts reasonableness review panel.
 *
 * Ported from `data_room`. Takes the `useHierarchyRecommendations()` instance
 * rather than calling the API itself, so a decision made here and a decision
 * made anywhere else that shares the hook stay in step for free — both go
 * through `rec.accept` / `rec.ignore`, which reload internally.
 *
 * Nothing here edits the chart of accounts. Accept calls the server's apply
 * endpoint, which re-validates and refuses a stale recommendation; reject only
 * records the decision.
 */

const BAND_STYLE = {
  HIGH: 'bg-emerald-100 text-emerald-800',
  MEDIUM: 'bg-amber-100 text-amber-800',
  LOW: 'bg-gray-100 text-gray-700',
};

/**
 * What a change would actually move.
 *
 * Spelled out rather than shown as a code, because "OPERATING_RESULT" tells a
 * reviewer nothing about whether it is worth their attention.
 */
const IMPACT_LABEL = {
  CLASSIFICATION: 'Changes which statement this account appears on',
  OPERATING_RESULT: 'Affects Operating Income / EBITDA / Other Income',
  BALANCE_SHEET_SECTION: 'Affects Balance Sheet section totals',
  PRESENTATION: 'Presentation only',
};

const BANDS = ['HIGH', 'MEDIUM', 'LOW'];

function HierarchyPath({ path, className = '' }) {
  if (!Array.isArray(path) || !path.length) return <span className="text-text-muted">—</span>;
  return (
    <span className={className} title={path.join(' > ')}>
      {path.join(' › ')}
    </span>
  );
}

export function RecommendationCard({ rec, r, bulkRunning }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const deciding = rec.decidingId === r.id;
  const busy = bulkRunning || deciding;

  return (
    <li className="rounded-xl border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold text-text-primary">{r.accountName}</span>
            {r.accountNumber && (
              <span className="rounded bg-bg-page px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
                {r.accountNumber}
              </span>
            )}
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${BAND_STYLE[r.confidenceBand] || BAND_STYLE.LOW}`}
            >
              {r.confidenceBand}
            </span>
            {r.kind === 'RECLASSIFY' && (
              <span className="flex items-center gap-1 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
                <FileWarning size={10} /> Reclassification
              </span>
            )}
            {r.source === 'AI_REASONABLENESS' && (
              <span
                className="rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-800"
                title="No matching section exists in the uploaded documents — this placement was derived rather than matched."
              >
                AI-derived
              </span>
            )}
            {r.source === 'DOCUMENT_MATCH' && (
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
              <HierarchyPath
                path={r.recommendedHierarchy}
                className="font-medium text-emerald-800"
              />
            </p>
            {r.kind === 'RECLASSIFY' && r.recommendedAccountType && (
              <p className="text-text-muted">
                <span className="font-medium text-text-secondary">Type: </span>
                {r.currentAccountType} <ArrowRight size={10} className="inline" />{' '}
                {r.recommendedAccountType}
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
            type="button"
            onClick={() => rec.accept(r.id)}
            disabled={busy}
            title="Apply this recommendation to the Chart of Accounts"
            className="flex w-24 items-center justify-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50"
          >
            {deciding ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
            Accept
          </button>
          <button
            type="button"
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
            <label
              htmlFor={`reject-reason-${r.id}`}
              className="text-[10px] font-semibold uppercase tracking-wide text-text-muted"
            >
              Reason (optional)
            </label>
            <input
              id={`reject-reason-${r.id}`}
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. intentionally treated as operating income for this client"
              className="rounded border border-border px-2 py-1.5 text-xs"
            />
          </div>
          <button
            type="button"
            onClick={async () => {
              await rec.ignore(r.id, reason.trim() || null);
              setRejecting(false);
            }}
            disabled={busy}
            className="rounded-lg bg-text-primary px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            Confirm reject
          </button>
          <button
            type="button"
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

export default function RecommendedChangesPanel({ isOpen, onClose, rec, confirm }) {
  const [bulkRunning, setBulkRunning] = useState(false);

  const pending = rec.pending || rec.recommendations.filter((r) => r.status === 'PENDING');
  const bands = rec.byConfidence || {
    HIGH: pending.filter((r) => r.confidenceBand === 'HIGH'),
    MEDIUM: pending.filter((r) => r.confidenceBand === 'MEDIUM'),
    LOW: pending.filter((r) => r.confidenceBand === 'LOW'),
  };

  // Injected so a test can answer it. Defaults to the browser's own, which is
  // what the original used.
  const ask = confirm ?? ((message) => window.confirm(message));

  const runBulk = async (items, action, label) => {
    if (!items.length) return;
    if (!ask(`${label} ${items.length} recommendation${items.length === 1 ? '' : 's'}?`)) return;
    setBulkRunning(true);
    try {
      // Sequential, not Promise.all — `decidingId` is a single scalar and each
      // call reloads the list internally, so firing them concurrently would
      // thrash that indicator and cause N overlapping refetches.
      for (const r of items) {
        await action(r.id);
      }
    } finally {
      setBulkRunning(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Chart of Accounts review" size="xl">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
              <Sparkles size={14} className="text-primary" />
              {pending.length === 0
                ? 'No classifications need review'
                : `${pending.length} classification${pending.length === 1 ? '' : 's'} may need review`}
            </p>
            {pending.length > 0 && (
              <p className="mt-0.5 text-[11px] text-text-muted">
                {bands.HIGH.length} high · {bands.MEDIUM.length} medium · {bands.LOW.length} low
                confidence. Nothing changes until you accept.
              </p>
            )}
          </div>
          {pending.length > 0 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => runBulk(bands.HIGH, rec.accept, 'Accept all high-confidence')}
                disabled={bulkRunning || !bands.HIGH.length || rec.decidingId != null}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {bulkRunning ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                Accept all high confidence ({bands.HIGH.length})
              </button>
              <button
                type="button"
                onClick={() => runBulk(pending, rec.ignore, 'Reject all')}
                disabled={bulkRunning || rec.decidingId != null}
                className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-page disabled:opacity-50"
              >
                <X size={12} /> Reject all
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
          BANDS.map(
            (band) =>
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
              ),
          )
        )}
      </div>
    </Modal>
  );
}
