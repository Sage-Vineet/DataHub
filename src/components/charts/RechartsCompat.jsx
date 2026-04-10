import { Children, cloneElement, isValidElement } from "react";

function createStubComponent(name) {
  const Component = () => null;
  Component.displayName = name;
  return Component;
}

function getChildType(child) {
  if (!isValidElement(child) || !child.type) return "";
  return child.type.displayName || child.type.name || "";
}

function getColor(value) {
  if (!value) return "#8bc53d";
  if (typeof document !== "undefined" && String(value).startsWith("var(")) {
    const name = value.slice(4, -1).trim();
    return (
      getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
      "#8bc53d"
    );
  }
  return value;
}

export function ResponsiveContainer({
  width = "100%",
  height = "100%",
  children,
}) {
  if (!isValidElement(children)) return null;
  return (
    <div style={{ width, height }}>
      {cloneElement(children, {
        responsiveWidth: width,
        responsiveHeight: height,
      })}
    </div>
  );
}

export function BarChart({ data = [], children, margin }) {
  const nodes = Children.toArray(children);
  const xAxis = nodes.find((child) => getChildType(child) === "XAxis");
  const yAxis = nodes.find((child) => getChildType(child) === "YAxis");
  const legend = nodes.find((child) => getChildType(child) === "Legend");
  const tooltip = nodes.find((child) => getChildType(child) === "Tooltip");
  const bars = nodes.filter((child) => getChildType(child) === "Bar");
  const numericValues = data.flatMap((item) =>
    bars.map((bar) => {
      const rawValue = Number(item?.[bar.props.dataKey] ?? 0);
      return Number.isFinite(rawValue) ? rawValue : 0;
    }),
  );
  const maxValue = Math.max(
    1,
    ...numericValues,
  );
  const tickFormatter = yAxis?.props?.tickFormatter;
  const tooltipFormatter = tooltip?.props?.formatter;

  return (
    <div className="flex h-full w-full flex-col" style={{ paddingTop: margin?.top || 0 }}>
      {legend && bars.length > 0 ? (
        <div
          className="mb-4 flex flex-wrap justify-end gap-4 text-[12px] font-medium"
          style={legend.props.wrapperStyle}
        >
          {bars.map((bar) => (
            <div key={bar.props.dataKey} className="flex items-center gap-2">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: getColor(bar.props.fill) }}
              />
              <span>{bar.props.name || bar.props.dataKey}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="grid h-full min-h-0 grid-cols-[56px_1fr] gap-3">
        <div className="flex h-full flex-col justify-between py-2 text-right text-[12px] font-medium text-text-muted">
          {[1, 0.75, 0.5, 0.25, 0].map((ratio) => {
            const value = maxValue * ratio;
            return (
              <span key={ratio}>
                {tickFormatter ? tickFormatter(value) : Math.round(value)}
              </span>
            );
          })}
        </div>
        <div className="relative h-full min-h-0 rounded-lg border border-border-light bg-white/50 px-4 pb-10 pt-2">
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between px-4 py-2">
            {[0, 1, 2, 3, 4].map((line) => (
              <div key={line} className="border-t border-dashed border-border-light" />
            ))}
          </div>
          <div className="relative z-10 flex h-full items-end justify-between gap-3">
            {data.map((item, index) => (
              <div
                key={`${item?.name || "item"}-${index}`}
                className="flex h-full min-w-0 flex-1 flex-col justify-end"
              >
                <div className="group flex h-full items-end justify-center gap-1.5">
                  {bars.map((bar) => {
                    const rawValue = Number(item?.[bar.props.dataKey] ?? 0);
                    const numericValue = Number.isFinite(rawValue) ? rawValue : 0;
                    const heightRatio =
                      maxValue > 0 ? (numericValue / maxValue) * 100 : 0;
                    const height = numericValue > 0 ? `${heightRatio}%` : "0%";
                    const formatted = tooltipFormatter
                      ? tooltipFormatter(numericValue)?.[0] || numericValue
                      : numericValue;

                    return (
                      <div
                        key={bar.props.dataKey}
                        className="relative flex h-full flex-1 items-end justify-center"
                        title={`${bar.props.name || bar.props.dataKey}: ${formatted}`}
                      >
                        <div
                          className="w-full min-w-[10px] self-end rounded-t-[4px] transition-opacity group-hover:opacity-85"
                          style={{
                            height,
                            backgroundColor: getColor(bar.props.fill),
                            opacity: bar.props.fillOpacity ?? 1,
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
                <div
                  className="mt-3 truncate text-center text-[12px] font-medium text-text-muted"
                  style={{
                    transform:
                      xAxis?.props?.angle && Number(xAxis.props.angle) !== 0
                        ? `rotate(${xAxis.props.angle}deg)`
                        : undefined,
                    transformOrigin: "top center",
                    height: xAxis?.props?.height,
                  }}
                >
                  {item?.[xAxis?.props?.dataKey || "name"] || item?.name}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export const CartesianGrid = createStubComponent("CartesianGrid");
export const XAxis = createStubComponent("XAxis");
export const YAxis = createStubComponent("YAxis");
export const Tooltip = createStubComponent("Tooltip");
export const Legend = createStubComponent("Legend");
export const Bar = createStubComponent("Bar");
