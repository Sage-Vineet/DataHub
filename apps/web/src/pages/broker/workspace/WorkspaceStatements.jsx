import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import BalanceSheetTable from "../../../components/qoe/BalanceSheetTable";
import { money } from "../../../components/qoe/format";
import { fetchBalanceSheet, fetchTrialBalance } from "../../../services/qoeApi";
import KeyReportVersionSelector from "../../../components/key-reports/KeyReportVersionSelector";
import { useKeyReportContextStore } from "../../../store/useKeyReportContextStore";

/**
 * Balance sheet and trial balance, both derived by `@datahub/financial-engine`
 * from the ledger and the uploaded statements.
 *
 * Both were unusable before: the balance sheet was out by exactly the
 * unclassified retained-earnings account every year, and the trial balance
 * carried no opening balances, so neither could be reconciled (UAT #8).
 */

function TrialBalanceTable({ trialBalance }) {
  const [period, setPeriod] = useState(null);
  if (!trialBalance) return null;

  const entries = trialBalance.entries;
  const active = entries.find((e) => e.period === period) ?? entries.at(-1);
  if (!active) return null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Period</span>
        <div className="inline-flex rounded-md border border-slate-300 p-0.5">
          {entries.map((e) => (
            <button
              key={e.period}
              onClick={() => setPeriod(e.period)}
              className={`rounded px-3 py-1 text-sm transition ${
                active.period === e.period
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {e.label}
            </button>
          ))}
        </div>
        <span
          className={`ml-auto rounded-md px-3 py-1 text-xs font-medium ${
            active.balances
              ? "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200"
              : "bg-rose-50 text-rose-800 ring-1 ring-rose-200"
          }`}
        >
          {active.balances
            ? "Debits equal credits"
            : `Out of balance by ${money(active.outOfBalance, { exact: true })}`}
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full min-w-[760px]">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-100 text-xs font-semibold uppercase tracking-wide text-slate-600">
              <th className="px-4 py-3 text-left">Account</th>
              <th className="px-4 py-3 text-right">Opening</th>
              <th className="px-4 py-3 text-right">Debits</th>
              <th className="px-4 py-3 text-right">Credits</th>
              <th className="px-4 py-3 text-right">Closing</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {active.rows.map((row) => (
              <tr key={row.accountId} className="hover:bg-slate-50">
                <td className="px-4 py-1.5 text-sm text-slate-700">
                  {row.accountName}
                  {row.statementType === "balance_sheet" && (
                    <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-400">
                      BS
                    </span>
                  )}
                </td>
                <td className="px-4 py-1.5 text-right text-sm tabular-nums">{money(row.openingBalance)}</td>
                <td className="px-4 py-1.5 text-right text-sm tabular-nums">{money(row.debits)}</td>
                <td className="px-4 py-1.5 text-right text-sm tabular-nums">{money(row.credits)}</td>
                <td className="px-4 py-1.5 text-right text-sm font-medium tabular-nums">{money(row.closingBalance)}</td>
              </tr>
            ))}
            <tr className="border-t border-slate-300 bg-slate-50 font-semibold">
              <td className="px-4 py-2 text-sm">Total</td>
              <td></td>
              <td className="px-4 py-2 text-right text-sm tabular-nums">{money(active.totalDebits)}</td>
              <td className="px-4 py-2 text-right text-sm tabular-nums">{money(active.totalCredits)}</td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function WorkspaceStatements() {
  const { clientId } = useParams();
  const versionId = useKeyReportContextStore((s) => s.selectedVersionId);

  const [tab, setTab] = useState("balance-sheet");
  const [sheet, setSheet] = useState(null);
  const [trialBalance, setTrialBalance] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!versionId) return;
    try {
      const [bs, tb] = await Promise.all([
        fetchBalanceSheet({ versionId }, { clientId }),
        fetchTrialBalance({ versionId }, { clientId }),
      ]);
      setError("");
      setSheet(bs);
      setTrialBalance(tb);
    } catch (err) {
      setError(err?.message || "Could not load the statements.");
    }
  }, [versionId, clientId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return (
    <div className="space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold text-slate-900">Financial Statements</h1>
        <p className="text-sm text-slate-500">
          Derived from the general ledger and the uploaded balance sheets, not from the extracted
          report tables.
        </p>
        <div className="mt-2">
          <KeyReportVersionSelector clientId={clientId} variant="filter" />
        </div>
      </header>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {!versionId && (
        <div className="rounded-lg border border-dashed border-slate-300 p-10 text-center text-slate-500">
          Select a key-report version to build the statements.
        </div>
      )}

      {versionId && (
        <>
          <div className="inline-flex rounded-md border border-slate-300 p-0.5">
            {[
              ["balance-sheet", "Balance Sheet"],
              ["trial-balance", "Trial Balance"],
            ].map(([value, label]) => (
              <button
                key={value}
                onClick={() => setTab(value)}
                className={`rounded px-3 py-1.5 text-sm transition ${
                  tab === value ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "balance-sheet" ? (
            <BalanceSheetTable sheet={sheet} />
          ) : (
            <TrialBalanceTable trialBalance={trialBalance} />
          )}
        </>
      )}
    </div>
  );
}
