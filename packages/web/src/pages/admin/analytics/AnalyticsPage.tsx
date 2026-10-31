import { useEffect, useId, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  adminApiBasePath,
  analyticsEarliestDay,
  analyticsMaxRangeDays,
  type AnalyticsSection,
  type AnalyticsSectionDto
} from "@imageshow/shared/browser";
import { api } from "../../../lib/api/client.js";
import { queryKeys } from "../../../lib/api/query-keys.js";
import { QueryErrorState } from "../../../components/feedback/QueryErrorState.js";
import { WorkspaceHeader } from "../../../components/layout/WorkspaceHeader.js";
import { WorkspaceScrollBody } from "../../../components/layout/WorkspaceScrollBody.js";
import {
  ContentSection,
  ErrorsSection,
  OverviewSection,
  PerformanceSection,
  RandomSection,
  RangeNotice,
  SourcesSection
} from "./AnalyticsSections.js";
import "../../../styles/admin/analytics.css";

function shiftDate(day: string, days: number) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;
// Date inputs accept years past 9999 when typed; they have no ISO form.
const latestDay = "9999-12-31";
const customRangeLimit = `时间范围最长 ${analyticsMaxRangeDays} 天，不早于 ${analyticsEarliestDay}，且不能晚于今天`;

/** Which explicit date breaks the server's limits, checked before asking. */
function invalidCustomDate(from: string, to: string, today: string | undefined): "from" | "to" | null {
  if (!dayPattern.test(to) || to < analyticsEarliestDay || (today && to > today)) return "to";
  if (!dayPattern.test(from) || from < analyticsEarliestDay || from > to) return "from";
  return shiftDate(to, 1 - analyticsMaxRangeDays) <= from ? null : "from";
}

const sectionTabs: readonly { value: AnalyticsSection; label: string }[] = [
  { value: "overview", label: "概览" },
  { value: "content", label: "内容" },
  { value: "sources", label: "来源" },
  { value: "random", label: "随机 API" },
  { value: "performance", label: "性能" },
  { value: "errors", label: "错误" }
];

const rangePresets = [
  { value: "1", label: "今天" },
  { value: "7", label: "7 天" },
  { value: "30", label: "30 天" },
  { value: "90", label: "90 天" },
  { value: "365", label: "1 年" },
  { value: "custom", label: "自定义" }
] as const;

type RangePreset = (typeof rangePresets)[number]["value"];

function rangeSearch(preset: RangePreset, custom: { from: string; to: string }) {
  const params = new URLSearchParams(
    preset === "custom" ? custom : { days: preset }
  );
  return params.toString();
}

function SectionView({ section, data }: { section: AnalyticsSection; data: AnalyticsSectionDto[AnalyticsSection] }) {
  switch (section) {
    case "overview":
      return <OverviewSection data={data as AnalyticsSectionDto["overview"]} />;
    case "content":
      return <ContentSection data={data as AnalyticsSectionDto["content"]} />;
    case "sources":
      return <SourcesSection data={data as AnalyticsSectionDto["sources"]} />;
    case "random":
      return <RandomSection data={data as AnalyticsSectionDto["random"]} />;
    case "performance":
      return <PerformanceSection data={data as AnalyticsSectionDto["performance"]} />;
    case "errors":
      return <ErrorsSection data={data as AnalyticsSectionDto["errors"]} />;
  }
}

export function AnalyticsPage() {
  const panelId = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [section, setSection] = useState<AnalyticsSection>("overview");
  const [preset, setPreset] = useState<RangePreset>("7");
  const [custom, setCustom] = useState({ from: "", to: "" });
  // The server's today from the latest report; dates after it are refused.
  const [serverToday, setServerToday] = useState<string>();
  const customChosen = Boolean(custom.from && custom.to);
  const invalidDate = customChosen ? invalidCustomDate(custom.from, custom.to, serverToday) : null;
  const customReady = customChosen && !invalidDate;
  const customInvalid = preset === "custom" && invalidDate !== null;
  const search = rangeSearch(preset, custom);
  const query = useQuery<AnalyticsSectionDto[AnalyticsSection]>({
    queryKey: [...queryKeys.analytics, section, search],
    queryFn: ({ signal }) => api(`${adminApiBasePath}/analytics/${section}?${search}`, { signal }),
    enabled: preset !== "custom" || customReady,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === section ? keepPreviousData(previous) : undefined
  });
  const range = query.data?.range;
  // Until the custom dates are usable the body shows a notice, not data, so the
  // subtitle leaves out the range the previous data covered.
  const shownRange = preset === "custom" && !customReady ? undefined : range;
  useEffect(() => {
    if (range) setServerToday(range.today);
  }, [range]);

  const choosePreset = (next: RangePreset) => {
    if (next === "custom" && range && !customReady) setCustom({ from: range.from, to: range.to });
    setPreset(next);
  };

  return (
    <section className="workspace workspace-contained analytics-page">
      <WorkspaceHeader
        title="统计"
        // Like the sort inputs, the dates only turn red; the allowed range takes
        // the subtitle because the toolbar row has no room for a field error.
        description={customInvalid
          ? customRangeLimit
          : shownRange
            ? `公开页面访问与随机 API 调用 · ${shownRange.from === shownRange.to ? shownRange.from : `${shownRange.from} 至 ${shownRange.to}`}`
            : "公开页面访问与随机 API 调用"}
        toolbarRow={
          <div className="analytics-toolbar">
            <div className="analytics-tabs" role="tablist" aria-label="统计类别">
              {sectionTabs.map((tab, index) => (
                <button
                  key={tab.value}
                  ref={(element) => {
                    tabRefs.current[index] = element;
                  }}
                  id={`${panelId}-${tab.value}`}
                  type="button"
                  role="tab"
                  aria-selected={section === tab.value}
                  aria-controls={panelId}
                  tabIndex={section === tab.value ? 0 : -1}
                  className={section === tab.value ? "is-selected" : undefined}
                  onClick={() => setSection(tab.value)}
                  onKeyDown={(event) => {
                    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                    event.preventDefault();
                    const last = sectionTabs.length - 1;
                    const next = event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? last
                        : (index + (event.key === "ArrowRight" ? 1 : last)) % sectionTabs.length;
                    setSection(sectionTabs[next]!.value);
                    tabRefs.current[next]?.focus();
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="analytics-range">
              <div className="analytics-segmented" role="group" aria-label="时间范围">
                {rangePresets.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={preset === option.value}
                    className={preset === option.value ? "is-selected" : undefined}
                    onClick={() => choosePreset(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {preset === "custom" && (
                <div className="analytics-dates">
                  <input
                    type="date"
                    aria-label="开始日期"
                    value={custom.from}
                    min={dayPattern.test(custom.to)
                      ? [shiftDate(custom.to, 1 - analyticsMaxRangeDays), analyticsEarliestDay].sort()[1]
                      : analyticsEarliestDay}
                    max={custom.to || serverToday || latestDay}
                    aria-invalid={invalidDate === "from" || undefined}
                    aria-describedby={invalidDate === "from" ? `${panelId}-dates` : undefined}
                    onChange={(event) => setCustom((current) => ({ ...current, from: event.target.value }))}
                  />
                  <span aria-hidden="true">–</span>
                  <input
                    type="date"
                    aria-label="结束日期"
                    value={custom.to}
                    min={custom.from || analyticsEarliestDay}
                    max={serverToday ?? latestDay}
                    aria-invalid={invalidDate === "to" || undefined}
                    aria-describedby={invalidDate === "to" ? `${panelId}-dates` : undefined}
                    onChange={(event) => setCustom((current) => ({ ...current, to: event.target.value }))}
                  />
                </div>
              )}
            </div>
          </div>
        }
      />
      <WorkspaceScrollBody>
        <div
          id={panelId}
          className="analytics-body"
          role="tabpanel"
          aria-labelledby={`${panelId}-${section}`}
          aria-busy={query.isFetching || undefined}
          // Only data from the previous range is dimmed, never the date notice.
          data-stale={(query.isPlaceholderData && (preset !== "custom" || customReady)) || undefined}
        >
          {preset === "custom" && !customReady ? (
            <p id={`${panelId}-dates`} className="analytics-empty" role="status">
              {customChosen ? customRangeLimit : "选择开始与结束日期"}
            </p>
          ) : query.isError ? (
            <QueryErrorState
              error={query.error}
              onRetry={() => void query.refetch()}
              reportContext="analytics.load"
            />
          ) : query.data ? (
            <>
              <RangeNotice range={query.data.range} section={section} />
              <SectionView section={section} data={query.data} />
            </>
          ) : (
            <p className="analytics-empty">加载中</p>
          )}
        </div>
      </WorkspaceScrollBody>
    </section>
  );
}
