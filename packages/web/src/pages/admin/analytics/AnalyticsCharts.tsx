import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from "react";
import { scaleBand, scaleLinear } from "d3-scale";
import { area, curveMonotoneX, line } from "d3-shape";

const chartHeight = 240;
const margin = { top: 12, right: 12, bottom: 28, left: 44 };

export function formatCount(value: number) {
  return value.toLocaleString("zh-CN");
}

function compactCount(value: number) {
  if (value >= 100_000_000) return `${+(value / 100_000_000).toFixed(1)}亿`;
  if (value >= 10_000) return `${+(value / 10_000).toFixed(1)}万`;
  return formatCount(value);
}

/** Follows the rendered width; the charts draw in CSS pixels. */
function useChartWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.floor(entry?.contentRect.width ?? 0));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

// Counts have no fractional ticks; small maxima keep their whole numbers.
function countTicks(scale: { ticks: (count: number) => number[] }) {
  return scale.ticks(4).filter(Number.isInteger);
}

// Shows at most this many x labels so they never overlap.
function labelStep(count: number, width: number) {
  return Math.max(1, Math.ceil(count / Math.max(2, Math.floor(width / 72))));
}

type ChartSeries = {
  key: string;
  label: string;
  tone: "primary" | "secondary";
  values: readonly number[];
};

function ChartLegend({ series }: { series: readonly Pick<ChartSeries, "key" | "label" | "tone">[] }) {
  return (
    <div className="analytics-legend" aria-hidden="true">
      {series.map((item) => (
        <span key={item.key} className={`analytics-legend-item is-${item.tone}`}>
          <i />
          {item.label}
        </span>
      ))}
    </div>
  );
}

/**
 * The chart's numbers for screen readers, which the hover readout does not
 * reach; the drawing itself is hidden from them.
 */
function ChartDataTable({
  caption,
  labels,
  formatLabel,
  columns,
  rowHeader = "时间"
}: {
  caption: string;
  labels: readonly string[];
  formatLabel: (label: string) => string;
  columns: readonly Pick<ChartSeries, "key" | "label" | "values">[];
  rowHeader?: string;
}) {
  // A table ignores width and overflow, so the hidden box is a wrapper.
  return (
    <div className="analytics-chart-data">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{rowHeader}</th>
            {columns.map((column) => <th key={column.key} scope="col">{column.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {labels.map((label, index) => (
            <tr key={index}>
              <th scope="row">{formatLabel(label)}</th>
              {columns.map((column) => <td key={column.key}>{formatCount(column.values[index] ?? 0)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChartTooltip({
  left,
  title,
  rows
}: {
  left: number;
  title: string;
  rows: readonly { key: string; label: string; tone: string; value: string }[];
}) {
  return (
    <div className="analytics-tooltip" style={{ left }}>
      <strong>{title}</strong>
      {rows.map((row) => (
        <span key={row.key} className={`is-${row.tone}`}>
          <i />
          {row.label}
          <b>{row.value}</b>
        </span>
      ))}
    </div>
  );
}

/** Area chart of one or two series over ordered labels, with a hover readout. */
export function TrendChart({
  labels,
  series,
  formatLabel = (label) => label,
  ariaLabel
}: {
  labels: readonly string[];
  series: readonly ChartSeries[];
  formatLabel?: (label: string) => string;
  ariaLabel: string;
}) {
  const gradientId = useId();
  const { ref, width } = useChartWidth();
  const [hover, setHover] = useState<number | null>(null);
  const innerWidth = Math.max(0, width - margin.left - margin.right);
  const innerHeight = chartHeight - margin.top - margin.bottom;
  const maximum = Math.max(1, ...series.flatMap((item) => item.values));
  const x = useMemo(
    () => scaleLinear().domain([0, Math.max(1, labels.length - 1)]).range([0, innerWidth]),
    [innerWidth, labels.length]
  );
  const y = useMemo(
    () => scaleLinear().domain([0, maximum]).nice(4).range([innerHeight, 0]),
    [innerHeight, maximum]
  );
  const step = labelStep(labels.length, innerWidth);
  const onPointerMove = (event: PointerEvent<SVGRectElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const index = Math.round(x.invert(event.clientX - bounds.left));
    setHover(Math.min(labels.length - 1, Math.max(0, index)));
  };
  return (
    <div className="analytics-chart" ref={ref}>
      <ChartLegend series={series} />
      <ChartDataTable caption={ariaLabel} labels={labels} formatLabel={formatLabel} columns={series} />
      {width > 0 && (
        <svg width={width} height={chartHeight} aria-hidden="true">
          <defs>
            {series.map((item) => (
              <linearGradient key={item.key} id={`${gradientId}-${item.key}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" className={`analytics-gradient-start is-${item.tone}`} />
                <stop offset="100%" className={`analytics-gradient-end is-${item.tone}`} />
              </linearGradient>
            ))}
          </defs>
          <g transform={`translate(${margin.left},${margin.top})`}>
            {countTicks(y).map((tick) => (
              <g key={tick} transform={`translate(0,${y(tick)})`}>
                <line className="analytics-gridline" x2={innerWidth} />
                <text className="analytics-axis" x={-8} dy="0.32em" textAnchor="end">
                  {compactCount(tick)}
                </text>
              </g>
            ))}
            {labels.map((label, index) => index % step === 0 && (
              <text
                key={label}
                className="analytics-axis"
                x={x(index)}
                y={innerHeight + 18}
                textAnchor={labels.length === 1 ? "start" : index === 0 ? "start" : "middle"}
              >
                {formatLabel(label)}
              </text>
            ))}
            {series.map((item) => {
              const points = item.values.map((value, index) => [x(index), y(value)] as [number, number]);
              const areaPath = area<[number, number]>()
                .x((point) => point[0])
                .y0(innerHeight)
                .y1((point) => point[1])
                .curve(curveMonotoneX)(points);
              const linePath = line<[number, number]>().curve(curveMonotoneX)(points);
              return (
                <g key={item.key}>
                  <path className="analytics-area" d={areaPath ?? ""} fill={`url(#${gradientId}-${item.key})`} />
                  <path className={`analytics-line is-${item.tone}`} d={linePath ?? ""} />
                </g>
              );
            })}
            {hover !== null && (
              <g transform={`translate(${x(hover)},0)`}>
                <line className="analytics-crosshair" y2={innerHeight} />
                {series.map((item) => (
                  <circle
                    key={item.key}
                    className={`analytics-dot is-${item.tone}`}
                    cy={y(item.values[hover] ?? 0)}
                    r={4}
                  />
                ))}
              </g>
            )}
            <rect
              className="analytics-hit"
              width={innerWidth}
              height={innerHeight}
              onPointerMove={onPointerMove}
              onPointerLeave={() => setHover(null)}
            />
          </g>
        </svg>
      )}
      {hover !== null && labels[hover] !== undefined && (
        <ChartTooltip
          left={Math.min(Math.max(margin.left + x(hover), 80), Math.max(80, width - 80))}
          title={formatLabel(labels[hover])}
          rows={series.map((item) => ({
            key: item.key,
            label: item.label,
            tone: item.tone,
            value: formatCount(item.values[hover] ?? 0)
          }))}
        />
      )}
    </div>
  );
}

/** Columns for counts per hour or day. */
export function ColumnChart({
  labels,
  values,
  label,
  formatLabel = (value) => value,
  ariaLabel
}: {
  labels: readonly string[];
  values: readonly number[];
  label: string;
  formatLabel?: (value: string) => string;
  ariaLabel: string;
}) {
  const { ref, width } = useChartWidth();
  const [hover, setHover] = useState<number | null>(null);
  const innerWidth = Math.max(0, width - margin.left - margin.right);
  const innerHeight = chartHeight - margin.top - margin.bottom;
  const x = useMemo(
    () => scaleBand<number>()
      .domain(labels.map((_, index) => index))
      .range([0, innerWidth])
      .paddingInner(labels.length > 60 ? 0.1 : 0.25),
    [innerWidth, labels]
  );
  const y = useMemo(
    () => scaleLinear().domain([0, Math.max(1, ...values)]).nice(4).range([innerHeight, 0]),
    [innerHeight, values]
  );
  const step = labelStep(labels.length, innerWidth);
  return (
    <div className="analytics-chart" ref={ref}>
      <ChartLegend series={[{ key: "value", label, tone: "primary" }]} />
      <ChartDataTable
        caption={ariaLabel}
        labels={labels}
        formatLabel={formatLabel}
        columns={[{ key: "value", label, values }]}
      />
      {width > 0 && (
        <svg width={width} height={chartHeight} aria-hidden="true">
          <g transform={`translate(${margin.left},${margin.top})`}>
            {countTicks(y).map((tick) => (
              <g key={tick} transform={`translate(0,${y(tick)})`}>
                <line className="analytics-gridline" x2={innerWidth} />
                <text className="analytics-axis" x={-8} dy="0.32em" textAnchor="end">
                  {compactCount(tick)}
                </text>
              </g>
            ))}
            {values.map((value, index) => {
              const left = x(index) ?? 0;
              // Index keys: a day that leaves daylight saving repeats an hour label.
              return (
                <g key={index}>
                  <rect
                    className={`analytics-column${hover === index ? " is-active" : ""}`}
                    x={left}
                    y={y(value)}
                    width={x.bandwidth()}
                    height={innerHeight - y(value)}
                    rx={Math.min(4, x.bandwidth() / 2)}
                  />
                  <rect
                    className="analytics-hit"
                    x={left}
                    width={x.bandwidth()}
                    height={innerHeight}
                    onPointerEnter={() => setHover(index)}
                    onPointerLeave={() => setHover(null)}
                  />
                  {index % step === 0 && (
                    <text
                      className="analytics-axis"
                      x={left + x.bandwidth() / 2}
                      y={innerHeight + 18}
                      textAnchor="middle"
                    >
                      {formatLabel(labels[index]!)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      )}
      {hover !== null && labels[hover] !== undefined && (
        <ChartTooltip
          left={Math.min(
            Math.max(margin.left + (x(hover) ?? 0) + x.bandwidth() / 2, 80),
            Math.max(80, width - 80)
          )}
          title={formatLabel(labels[hover])}
          rows={[{ key: "value", label, tone: "primary", value: formatCount(values[hover] ?? 0) }]}
        />
      )}
    </div>
  );
}

const weekdayLabels = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const heatLevels = 4;

/**
 * Page views by weekday and local hour. Shades are relative to the busiest
 * cell of the range, so they compare hours, not ranges.
 */
export function HourHeatmap({
  cells,
  ariaLabel
}: {
  cells: readonly { weekday: number; hour: number; page_views: number }[];
  ariaLabel: string;
}) {
  const maximum = Math.max(0, ...cells.map((cell) => cell.page_views));
  const level = (value: number) => (maximum ? Math.ceil((value / maximum) * heatLevels) : 0);
  const hours = Array.from({ length: 24 }, (_, hour) => hour);
  const value = (weekday: number, hour: number) => cells[weekday * 24 + hour]?.page_views ?? 0;
  return (
    <div className="analytics-heatmap">
      <ChartDataTable
        caption={ariaLabel}
        labels={weekdayLabels}
        formatLabel={(label) => label}
        rowHeader="星期"
        columns={hours.map((hour) => ({
          key: String(hour),
          label: `${hour} 时`,
          values: weekdayLabels.map((_, weekday) => value(weekday, hour))
        }))}
      />
      <div className="analytics-heatmap-grid" aria-hidden="true">
        <span />
        {hours.map((hour) => (
          <span key={hour} className="analytics-heatmap-hour">{hour % 6 === 0 ? hour : ""}</span>
        ))}
        {weekdayLabels.map((label, weekday) => [
          <span key={label} className="analytics-heatmap-day">{label.slice(1)}</span>,
          ...hours.map((hour) => (
            <span
              key={`${label}-${hour}`}
              className="analytics-heatmap-cell"
              data-level={level(value(weekday, hour))}
              title={`${label} ${hour}:00 · ${formatCount(value(weekday, hour))} 次`}
            />
          ))
        ])}
      </div>
      <div className="analytics-heatmap-legend" aria-hidden="true">
        少
        {Array.from({ length: heatLevels + 1 }, (_, index) => (
          <span key={index} className="analytics-heatmap-cell" data-level={index} />
        ))}
        多
      </div>
    </div>
  );
}

export type ShareRow = {
  key: string;
  label: string;
  value: number;
  detail?: string;
};

// A detail wraps only between its " · " parts, never inside one ("平均 20 毫秒").
function unbrokenParts(detail: string) {
  return detail.split(" · ").map((part) => part.replaceAll(" ", "\u00a0")).join(" · ");
}

/** Ranked rows with a bar for each value's share of the largest. */
export function ShareList({
  rows,
  valueLabel,
  empty = "暂无数据"
}: {
  rows: readonly ShareRow[];
  valueLabel: string;
  empty?: string;
}) {
  if (!rows.length) return <p className="analytics-empty">{empty}</p>;
  const maximum = Math.max(1, ...rows.map((row) => row.value));
  return (
    <ol className="analytics-share-list" aria-label={valueLabel}>
      {rows.map((row) => (
        <li key={row.key}>
          <span
            className="analytics-share-bar"
            style={{ width: `${(row.value / maximum) * 100}%` }}
            aria-hidden="true"
          />
          <span className="analytics-share-label" title={row.label}>{row.label}</span>
          {row.detail && <span className="analytics-share-detail">{unbrokenParts(row.detail)}</span>}
          <span className="analytics-share-value">{formatCount(row.value)}</span>
        </li>
      ))}
    </ol>
  );
}
