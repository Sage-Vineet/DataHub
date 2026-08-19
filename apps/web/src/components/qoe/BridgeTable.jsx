import { useState } from "react";
import { money, percent, periodKey } from "./format";

const TONE_CLASSES = {
  normal: "hover:bg-slate-50",
  subtotal: "bg-slate-50 font-semibold border-t border-slate-200",
  total: "bg-slate-900 text-white font-semibold",
  metric: "bg-emerald-50 font-bold border-t-2 border-emerald-600",
};

/**
 * One bridge row. Defined at module scope rather than inside the table: a
 * component created during render is a new type on every render, so React
 * unmounts and remounts every row instead of updating it.
 */
function BridgeRow({ line, keys, indent = 0, tone = "normal", onClick, selectedKey }) {
  const isSelected = selectedKey !== undefined && selectedKey === line.key;
  return (
    <tr
      className={`${TONE_CLASSES[tone] ?? TONE_CLASSES.normal} ${onClick ? "cursor-pointer" : ""} ${
        isSelected ? "ring-2 ring-inset ring-sky-500" : ""
      }`}
      onClick={onClick}
    >
      <td className="px-4 py-2 text-sm" style={{ paddingLeft: `${16 + indent * 20}px` }}>
        {line.label}
      </td>
      {keys.map((key) => (
        <td key={key} className="px-4 py-2 text-sm text-right tabular-nums">
          {money(line.amounts?.[key])}
        </td>
      ))}
    </tr>
  );
}

/**
 * The SDE/EBITDA bridge (`QE - 0004`).
 *
 * Every EBIT add-back is its own row and is never pre-aggregated. Add-backs
 * appear under user-defined subtotal headers that collapse without losing the
 * underlying account-level detail.
 */
export default function BridgeTable({ bridge, onSelectLine, selectedLineKey }) {
  const [collapsed, setCollapsed] = useState(() => new Set());

  if (!bridge) return null;
  const keys = bridge.periods.map(periodKey);

  const toggle = (id) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full min-w-[720px]">
        <thead>
          <tr className="bg-slate-100 border-b border-slate-200">
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
              {bridge.metricLabel} Bridge
            </th>
            {bridge.periods.map((p) => (
              <th
                key={periodKey(p)}
                className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-600"
              >
                {p.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          <BridgeRow keys={keys} selectedKey={selectedLineKey}
            line={bridge.netIncome}
            onClick={() => onSelectLine?.(bridge.netIncome)}
          />

          {bridge.ebitLines.map((line) => (
            <BridgeRow keys={keys} selectedKey={selectedLineKey}
              key={line.key}
              line={line}
              indent={1}
              onClick={() => onSelectLine?.(line)}
            />
          ))}

          <BridgeRow keys={keys} selectedKey={selectedLineKey}
            line={{ key: "reported_ebitda", label: "Reported EBITDA", amounts: bridge.reportedEbitda }}
            tone="subtotal"
          />

          {bridge.addbackGroups.map((group) => {
            const isCollapsed = group.id !== null && collapsed.has(group.id);
            return (
              <>
                {group.id !== null && (
                  <tr
                    key={`${group.id}-header`}
                    className="bg-slate-50 cursor-pointer hover:bg-slate-100"
                    onClick={() => toggle(group.id)}
                  >
                    <td className="px-4 py-2 text-sm font-medium" colSpan={keys.length + 1}>
                      <span className="inline-block w-4 text-slate-500">
                        {isCollapsed ? "▸" : "▾"}
                      </span>
                      {group.label || "Group"}
                      {isCollapsed && (
                        <span className="ml-2 text-xs text-slate-500">
                          ({group.items.length} item{group.items.length === 1 ? "" : "s"} hidden)
                        </span>
                      )}
                    </td>
                  </tr>
                )}
                {!isCollapsed &&
                  group.items.map((item) => (
                    <BridgeRow keys={keys} selectedKey={selectedLineKey}
                      key={item.key}
                      line={item}
                      indent={group.id === null ? 1 : 2}
                      onClick={() => onSelectLine?.(item)}
                    />
                  ))}
                {group.id !== null && (
                  <BridgeRow keys={keys} selectedKey={selectedLineKey}
                    key={`${group.id}-subtotal`}
                    line={{
                      key: `${group.id}-subtotal`,
                      label: `Total ${group.label || "Group"}`,
                      amounts: group.subtotals,
                    }}
                    indent={1}
                    tone="subtotal"
                  />
                )}
              </>
            );
          })}

          {bridge.ownerCompensation && (
            <BridgeRow keys={keys} selectedKey={selectedLineKey}
              line={bridge.ownerCompensation}
              indent={1}
              onClick={() => onSelectLine?.(bridge.ownerCompensation)}
            />
          )}

          <BridgeRow keys={keys} selectedKey={selectedLineKey}
            line={{ key: "adjusted", label: bridge.metricLabel, amounts: bridge.adjusted }}
            tone="metric"
          />
          <tr className="bg-emerald-50/60 text-sm">
            <td className="px-4 py-2 pl-8 text-slate-600">{bridge.metricLabel} Margin</td>
            {keys.map((key) => (
              <td key={key} className="px-4 py-2 text-right tabular-nums text-slate-600">
                {percent(bridge.margin?.[key])}
              </td>
            ))}
          </tr>
          <tr className="text-sm text-slate-500">
            <td className="px-4 py-2 pl-8">Revenue</td>
            {keys.map((key) => (
              <td key={key} className="px-4 py-2 text-right tabular-nums">
                {money(bridge.revenue?.[key])}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
