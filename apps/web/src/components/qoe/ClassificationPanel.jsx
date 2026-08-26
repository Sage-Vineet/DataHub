import { useState } from "react";

/**
 * Chart-of-accounts classification review.
 *
 * The bridge is only as good as this mapping, so it is shown rather than
 * hidden: what was classified, what wants confirming, and — the part that
 * matters — what was deliberately left out and why. An account excluded as an
 * operating tax reads as a decision, not an oversight.
 */

const ROLE_LABELS = {
  interest_income: "Interest Income",
  interest_expense: "Interest Expense",
  income_tax: "Income Tax",
  depreciation: "Depreciation",
  amortization: "Amortization",
  owner_compensation: "Owner Compensation",
};

const ROLE_OPTIONS = [["", "Not classified"], ...Object.entries(ROLE_LABELS)];

/**
 * What the account IS, as distinct from the part it plays on the bridge.
 * UAT #2: "I can't edit the Chart of Accounts classification, only the name."
 */
const TYPE_OPTIONS = [
  ["asset", "Asset"],
  ["liability", "Liability"],
  ["equity", "Equity"],
  ["income", "Income"],
  ["cogs", "COGS"],
  ["expense", "Expense"],
];

function Row({ entry, onSetRole, onSetType, busy }) {
  return (
    <tr className="border-t border-slate-100 align-top">
      <td className="px-3 py-2 text-sm text-slate-800">{entry.accountName}</td>
      <td className="px-3 py-2">
        <select
          className="rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-50"
          value={entry.accountType || ""}
          disabled={busy}
          aria-label={`Classification for ${entry.accountName}`}
          onChange={(e) => onSetType(entry.accountId, e.target.value)}
        >
          {!entry.accountType && <option value="">—</option>}
          {TYPE_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2">
        <select
          className="rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-50"
          value={entry.role || ""}
          disabled={busy}
          aria-label={`EBITDA role for ${entry.accountName}`}
          onChange={(e) => onSetRole(entry.accountId, e.target.value || null)}
        >
          {ROLE_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2 text-xs text-slate-500">{entry.reason}</td>
    </tr>
  );
}

export default function ClassificationPanel({
  open, onClose, report, loading, onClassify, onSetRole, onSetType, busy,
}) {
  // The selected tab persists across opens on purpose: a reviewer working
  // through the "Left out" list should return to it, not to the top.
  const [tab, setTab] = useState("applied");

  if (!open) return null;

  const groups = {
    applied: {
      label: "Classified",
      rows: report?.applied || [],
      blurb: "These accounts feed the EBIT add-back lines on the bridge.",
    },
    suggested: {
      label: "Needs review",
      rows: report?.suggested || [],
      blurb:
        "Matched, but not confidently enough to move the earnings figure on its own. Confirm or clear each.",
    },
    unclassified: {
      label: "Left out",
      rows: report?.unclassified || [],
      blurb:
        "Deliberately excluded — each row says why. Operating taxes belong in earnings, so they stay there.",
    },
  };
  const active = groups[tab];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 sm:p-8">
      <div className="flex max-h-[calc(100%-1rem)] w-full max-w-4xl flex-col rounded-lg bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Account classification</h2>
            <p className="mt-0.5 text-sm text-slate-500">
              Which accounts make up interest, depreciation, amortization, income tax and owner
              compensation on the bridge.
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-slate-200 px-6 py-3">
          {Object.entries(groups).map(([key, group]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                tab === key ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {group.label}
              <span className={`ml-1.5 text-xs ${tab === key ? "text-slate-300" : "text-slate-400"}`}>
                {group.rows.length}
              </span>
            </button>
          ))}
          <button
            onClick={onClassify}
            disabled={loading || busy}
            className="ml-auto rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
          >
            {loading ? "Classifying…" : "Re-run classification"}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <p className="mb-3 text-xs text-slate-500">{active.blurb}</p>
          {active.rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">Nothing in this group.</p>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <th className="px-3 pb-2">Account</th>
                  <th className="px-3 pb-2">Classification</th>
                  <th className="px-3 pb-2">EBITDA role</th>
                  <th className="px-3 pb-2">Why</th>
                </tr>
              </thead>
              <tbody>
                {active.rows.map((entry) => (
                  <Row
                    key={entry.accountId}
                    entry={entry}
                    onSetRole={onSetRole}
                    onSetType={onSetType}
                    busy={busy}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="border-t border-slate-200 px-6 py-3 text-right">
          <button
            onClick={onClose}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
