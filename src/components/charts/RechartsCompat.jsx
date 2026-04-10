import { Children, cloneElement, isValidElement, useState } from "react";
import { cn } from "../../lib/utils";

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
      getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim() || "#8bc53d"
    );
  }
  return value;
}

function getRoundedMax(value) {
  const safeValue = Number.isFinite(value) ? value : 0;

  if (safeValue <= 2000) return 2000;
  if (safeValue <= 5000) return Math.ceil(safeValue / 1000) * 1000;
  if (safeValue <= 10000) return Math.ceil(safeValue / 2500) * 2500;
  if (safeValue <= 50000) return Math.ceil(safeValue / 5000) * 5000;

  return Math.ceil(safeValue / 10000) * 10000;
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
  const [hoveredIndex, setHoveredIndex] = useState(null);
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
  const dataMax = Math.max(1, ...numericValues);
  const maxValue = getRoundedMax(dataMax);
  const tickFormatter = yAxis?.props?.tickFormatter;
  const tooltipFormatter = tooltip?.props?.formatter;
  const activeIndex = hoveredIndex;
  const activeItem =
    activeIndex !== null && activeIndex !== undefined
      ? data[activeIndex]
      : null;
  const activeValues = activeItem
    ? bars.map((bar) => {
        const rawValue = Number(activeItem?.[bar.props.dataKey] ?? 0);
        const numericValue = Number.isFinite(rawValue) ? rawValue : 0;
        const formatted = tooltipFormatter
          ? tooltipFormatter(numericValue)?.[0] || numericValue
          : numericValue;

        return {
          key: bar.props.dataKey,
          label: bar.props.name || bar.props.dataKey,
          color: getColor(bar.props.fill),
          value: numericValue,
          formatted,
        };
      })
    : [];
  const legendItems = [...bars].reverse();
  const tooltipValues = [...activeValues].reverse();
  const xAxisHeight = Number(
    xAxis?.props?.height ??
      (xAxis?.props?.angle && Number(xAxis.props.angle) !== 0 ? 68 : 34),
  );
  const xAxisDy = Number(xAxis?.props?.dy ?? 8);
  const xTickFontSize = Number(xAxis?.props?.tick?.fontSize ?? 12);
  const yTickRatios = [1, 0.75, 0.5, 0.25, 0];

  return (
    <div
      className="flex h-full w-full flex-col"
      style={{
        paddingTop: margin?.top || 0,
        paddingRight: margin?.right || 0,
        paddingBottom: margin?.bottom || 0,
      }}
    >
      <div className="grid h-full min-h-0 grid-cols-[48px_1fr] gap-0">
        <div className="flex min-h-0 flex-col pr-2 text-right text-[12px] font-medium text-text-muted">
          <div className="relative flex-1">
            {yTickRatios.map((ratio, index, array) => {
              const value = maxValue * ratio;
              const top = `${(index / (array.length - 1)) * 100}%`;
              const transform =
                index === 0
                  ? "translateY(0)"
                  : index === array.length - 1
                    ? "translateY(-100%)"
                    : "translateY(-50%)";

              return (
                <span
                  key={ratio}
                  className="absolute right-0"
                  style={{
                    top,
                    transform,
                  }}
                >
                  {tickFormatter ? tickFormatter(value) : Math.round(value)}
                </span>
              );
            })}
          </div>
          <div style={{ height: Math.min(xAxisHeight, 60) }} />
        </div>
        <div className="flex min-h-0 flex-col">
          <div className="relative flex-1 bg-white">
            <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
              {yTickRatios.map((ratio) => (
                <div
                  key={ratio}
                  className="border-t border-dashed border-border-light"
                />
              ))}
            </div>

            <div className="absolute inset-0 z-10 flex justify-between gap-2 px-2 overflow-visible">
              {data.map((item, index) => {
                const isRightHalf = index >= Math.floor(data.length / 2);
                return (
                  <div
                    key={`${item?.name || "item"}-${index}`}
                    className="group relative flex min-w-0 flex-1 overflow-visible"
                    onMouseEnter={() => setHoveredIndex(index)}
                    onMouseLeave={() => setHoveredIndex(null)}
                  >
                    {activeIndex === index &&
                    tooltipValues.some((entry) => entry.value > 0) ? (
                      <div
                        className="pointer-events-none absolute top-3 z-50 w-[140px] rounded-xl border border-border bg-white px-3 py-2.5 text-left shadow-[0_8px_22px_rgba(5,5,5,0.12)]"
                        style={isRightHalf
                          ? { right: 0 }
                          : { left: 0 }
                        }
                      >
                        <p className="text-[11px] font-semibold text-text-secondary truncate">
                          {item?.[xAxis?.props?.dataKey || "name"] || item?.name}
                        </p>
                        <div className="mt-2 space-y-1">
                          {tooltipValues.map((entry) => (
                            <p
                              key={entry.key}
                              className="text-[11px] font-semibold"
                              style={{ color: entry.color }}
                            >
                              {entry.formatted}
                            </p>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div className="absolute inset-x-0 bottom-0 flex h-full items-end justify-center gap-1">
                      {bars.map((bar) => {
                        const rawValue = Number(item?.[bar.props.dataKey] ?? 0);
                        const numericValue = Number.isFinite(rawValue) ? rawValue : 0;
                        const heightRatio = maxValue > 0 ? (numericValue / maxValue) * 100 : 0;
                        const height = numericValue > 0 ? `${heightRatio}%` : "0%";
                        const propSize = Number(bar.props.barSize || 24);
                        // Only scale down slightly if there are many items to prevent overflow
                        const safeSize = data.length > 9
                          ? Math.max(Math.round(propSize * 0.65), 12)
                          : propSize;

                        return (
                          <div
                            key={bar.props.dataKey}
                            className="relative flex h-full items-end justify-center"
                            style={{ width: safeSize }}
                          >
                            <div
                              className="self-end rounded-t-[4px] transition-opacity duration-200 group-hover:opacity-90"
                              style={{
                                width: safeSize,
                                height,
                                backgroundColor: getColor(bar.props.fill),
                                opacity: bar.props.fillOpacity ?? 1,
                              }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {legend && legendItems.length > 0 ? (
              <div
                className="absolute right-5 top-4 z-20 flex flex-wrap items-center gap-4 text-[12px] font-medium"
                style={legend.props.wrapperStyle}
              >
                {legendItems.map((bar) => (
                  <div
                    key={bar.props.dataKey}
                    className="flex items-center gap-1.5"
                  >
                    <span
                      className="inline-block h-3 w-3 rounded-full"
                      style={{ backgroundColor: getColor(bar.props.fill) }}
                    />
                    <span style={{ color: getColor(bar.props.fill) }}>
                      {bar.props.name || bar.props.dataKey}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div
            className="flex justify-between gap-3 overflow-hidden px-2"
            style={{ height: xAxisHeight }}
          >
            {data.map((item, index) => (
              <div
                key={`${item?.name || "item"}-${index}`}
                className="flex min-w-0 flex-1 items-start justify-center overflow-hidden"
              >
                <div
                  className={cn(
                    "whitespace-nowrap text-center text-[12px] font-medium text-text-muted transition-colors",
                    activeIndex === index && "text-text-primary",
                  )}
                  style={{
                    paddingTop: xAxisDy + 4,
                    lineHeight: 1,
                    fontSize: xTickFontSize,
                    transform:
                      xAxis?.props?.angle && Number(xAxis.props.angle) !== 0
                        ? `rotate(${xAxis.props.angle}deg)`
                        : undefined,
                    transformOrigin:
                      xAxis?.props?.angle && Number(xAxis.props.angle) !== 0
                        ? "top center"
                        : "center",
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
