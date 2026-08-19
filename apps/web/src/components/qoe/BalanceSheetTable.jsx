import { useMemo, useState } from "react";
import { money } from "./format";

/**
 * The rolled balance sheet, presented the way a balance sheet is presented:
 * by section, then by sub-heading, then by account.
 *
 * Josh's UAT #7 was that this arrived as one flat list with no bank-accounts /
 * fixed-assets / credit-cards grouping. The grouping comes from the uploaded
 * statement where it survived ingestion, and is derived otherwise — a derived
 * one the statement could legitimately contradict is marked, rather than
 * presented as fact.
 */

const SECTION_LABELS = { asset: "Assets", liability: "Liabilities", equity: "Equity" };

/** Year-end columns — a monthly sheet is 48 columns and unreadable. */
function yearEndPeriods(periods) {
  const byYear = new Map();
  for (const p of periods) byYear.set(p.fiscalYear, p);
  return [...byYear.values()];
}

const keyOf = (p) => (p.month === null ? String(p.fiscalYear) : `${p.fiscalYear}-${String(p.month).padStart(2, "0")}`);

export default function BalanceSheetTable({ sheet }) {
  const [collapsed, setCollapsed] = useState(() => new Set());

  const columns = useMemo(() => (sheet ? yearEndPeriods(sheet.periods) : []), [sheet]);

  const sections = useMemo(() => {
    if (!sheet) return [];
    const bySection = new Map();
    for (const line of sheet.lines) {
      const groups = bySection.get(line.section) ?? new Map();
      const rows = groups.get(line.group ?? "—") ?? [];
      rows.push(line);
      groups.set(line.group ?? "—", rows);
      bySection.set(line.section, groups);
    }
    return ["asset", "liability", "equity"]
      .filter((s) => bySection.has(s))
      .map((section) => ({ section, groups: [...bySection.get(section).entries()] }));
  }, [sheet]);

  if (!sheet) return null;
  const keys = columns.map(keyOf);

  const toggle = (id) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const sum = (rows, key) => rows.reduce((a, r) => a + (r.balances?.[key] ?? 0), 0);

  const checkFor = (key) => sheet.checks.find((c) => c.period === key);
  const allBalance = sheet.balances;

  return (
    <div className="space-y-3">
      <div
        className={`flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm ${
          allBalance
            ? "border-emerald-200 bg-emerald-50 text-emerald-900"
            : "border-rose-200 bg-rose-50 text-rose-900"
        }`}
      >
        <strong>{allBalance ? "Balances" : "Out of balance"}</strong>
        <span>
          {allBalance
            ? `Assets equal liabilities plus equity in all ${sheet.checks.length} periods.`
            : `${sheet.checks.filter((c) => !c.balances).length} of ${sheet.checks.length} periods do not balance.`}
        </span>
        {sheet.tieOut && (
          <span className="ml-auto text-xs">
            {sheet.tieOut.ties
              ? "Ties to the closing statement it was not rolled from."
              : `${Object.keys(sheet.tieOut.differences).length} accounts differ from the closing statement.`}
          </span>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full min-w-[720px]">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-100">
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
                Balance Sheet
              </th>
              {columns.map((p) => (
                <th
                  key={keyOf(p)}
                  className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-600"
                >
                  {p.fiscalYear}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sections.map(({ section, groups }) => (
              <>
                <tr key={section} className="bg-slate-50">
                  <td className="px-4 py-2 text-sm font-semibold text-slate-900" colSpan={keys.length + 1}>
                    {SECTION_LABELS[section] ?? section}
                  </td>
                </tr>

                {groups.map(([group, rows]) => {
                  const id = `${section}:${group}`;
                  const isCollapsed = collapsed.has(id);
                  const uncertain = rows.some((r) => !r.groupCertain);
                  return (
                    <>
                      <tr
                        key={id}
                        className="cursor-pointer hover:bg-slate-50"
                        onClick={() => toggle(id)}
                      >
                        <td className="px-4 py-2 pl-8 text-sm font-medium text-slate-700">
                          <span className="inline-block w-4 text-slate-400">
                            {isCollapsed ? "▸" : "▾"}
                          </span>
                          {group}
                          {uncertain && (
                            <span
                              className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
                              title="Grouped by convention — the uploaded statement did not say. Current versus long-term in particular cannot be read from an account name."
                            >
                              inferred
                            </span>
                          )}
                        </td>
                        {keys.map((k) => (
                          <td key={k} className="px-4 py-2 text-right text-sm font-medium tabular-nums">
                            {money(sum(rows, k))}
                          </td>
                        ))}
                      </tr>

                      {!isCollapsed &&
                        rows.map((line) => (
                          <tr key={line.accountId} className="hover:bg-slate-50">
                            <td className="px-4 py-1.5 pl-16 text-sm text-slate-600">
                              {line.accountName}
                            </td>
                            {keys.map((k) => (
                              <td key={k} className="px-4 py-1.5 text-right text-sm tabular-nums">
                                {money(line.balances?.[k])}
                              </td>
                            ))}
                          </tr>
                        ))}
                    </>
                  );
                })}
              </>
            ))}

            <tr className="bg-slate-50 font-medium">
              <td className="px-4 py-2 pl-8 text-sm text-slate-700">Retained Earnings</td>
              {keys.map((k) => (
                <td key={k} className="px-4 py-2 text-right text-sm tabular-nums">
                  {money(sheet.retainedEarnings?.[k])}
                </td>
              ))}
            </tr>
            <tr className="bg-slate-50 font-medium">
              <td className="px-4 py-2 pl-8 text-sm text-slate-700">Net Income</td>
              {keys.map((k) => (
                <td key={k} className="px-4 py-2 text-right text-sm tabular-nums">
                  {money(sheet.netIncome?.[k])}
                </td>
              ))}
            </tr>

            <tr className="border-t-2 border-slate-900 bg-slate-900 font-semibold text-white">
              <td className="px-4 py-2.5 text-sm">Assets − (Liabilities + Equity)</td>
              {keys.map((k) => {
                const check = checkFor(k);
                const out = check?.outOfBalance ?? 0;
                return (
                  <td key={k} className="px-4 py-2.5 text-right text-sm tabular-nums">
                    {Math.abs(out) < 0.005 ? "—" : money(out, { exact: true })}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
