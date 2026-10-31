import type { ReactNode } from "react";
import {
  analyticsDirectHost,
  analyticsOtherHost,
  analyticsTimingBuckets,
  randomApiOptionOther,
  randomApiOptionUsed,
  type AnalyticsBrowserSupport,
  type AnalyticsCatalogTarget,
  type AnalyticsCollectDropReason,
  type AnalyticsColorScheme,
  type AnalyticsContentDto,
  type AnalyticsErrorsDto,
  type AnalyticsFallbackReason,
  type AnalyticsListDepth,
  type AnalyticsOverviewDto,
  type AnalyticsPage,
  type AnalyticsPerformanceDto,
  type AnalyticsRandomDto,
  type AnalyticsRangeDto,
  type AnalyticsSection,
  type AnalyticsSessionDepth,
  type AnalyticsShowControl,
  type AnalyticsSourcesDto,
  type AnalyticsTiming,
  type AnalyticsTimingBucket,
  type AnalyticsTotalsDto,
  type AnalyticsViewport,
  type PublicImageOrder,
  type RandomApiStatusClass,
  type ShowMode
} from "@imageshow/shared/browser";
import { ColumnChart, HourHeatmap, ShareList, TrendChart, formatCount, type ShareRow } from "./AnalyticsCharts.js";

const pageLabels: Record<AnalyticsPage, string> = { home: "首页", gallery: "画廊", show: "展映" };
const listDepthLabels: Record<AnalyticsListDepth, string> = {
  "1": "1 页",
  "2": "2 页",
  "3-4": "3–4 页",
  "5-9": "5–9 页",
  "10+": "10 页以上"
};
const showModeLabels: Record<ShowMode, string> = { waterfall: "瀑布", float: "漂浮", cluster: "星群" };
const orderLabels: Record<PublicImageOrder, string> = { latest: "最新", oldest: "最旧", random: "随机" };
const catalogLabels: Record<AnalyticsCatalogTarget, string> = {
  browse: "进入浏览",
  theme: "主题",
  tag: "标签",
  author: "作者",
  device: "设备",
  brightness: "明暗"
};
const supportLabels: Record<AnalyticsBrowserSupport, string> = { full: "完整站点", gallery: "仅画廊（旧浏览器）" };
const fallbackLabels: Record<AnalyticsFallbackReason, string> = {
  legacy_browser: "旧浏览器转入画廊",
  webgl_unavailable: "无 WebGL，展映转入画廊",
  show_init_failed: "展映启动失败，转入画廊"
};
const deviceLabels: Record<string, string> = { desktop: "桌面", mobile: "移动" };
const randomModeLabels: Record<string, string> = { redirect: "跳转", proxy: "代理", json: "JSON" };
const statusLabels: Record<RandomApiStatusClass, string> = {
  success: "成功",
  rate_limited: "限流",
  client_error: "请求错误",
  server_error: "服务端错误"
};
const bridgeLabels = { cursor: "宿主光标", safe_area: "嵌入安全区" } as const;
const sessionDepthLabels: Record<AnalyticsSessionDepth, string> = {
  "1": "1 页（跳出）",
  "2": "2 页",
  "3-4": "3–4 页",
  "5+": "5 页以上"
};
const viewportLabels: Record<AnalyticsViewport, string> = {
  "0-599": "600 以下",
  "600-1023": "600–1023",
  "1024-1439": "1024–1439",
  "1440+": "1440 及以上"
};
const colorSchemeLabels: Record<AnalyticsColorScheme, string> = { light: "浅色", dark: "深色" };
const timingLabels: Record<AnalyticsTiming, string> = {
  ttfb: "首字节（TTFB）",
  fcp: "首次内容绘制（FCP）",
  lcp: "最大内容绘制（LCP）"
};
const timingBucketLabels: Record<AnalyticsTimingBucket, string> = {
  "0-200": "200 毫秒以内",
  "200-500": "200–500 毫秒",
  "500-1000": "0.5–1 秒",
  "1000-2500": "1–2.5 秒",
  "2500-4000": "2.5–4 秒",
  "4000+": "4 秒以上"
};
const dropReasonLabels: Record<AnalyticsCollectDropReason, string> = {
  ip_rate_limited: "按 IP 限流（请求）",
  site_capped: "超出全站上限（事件）",
  buffer_full: "写入缓冲已满（事件）",
  write_failed: "写入失败（事件）"
};
const randomOptionLabels: Record<string, string> = {
  size: "图片档位",
  limit: "数量",
  seed: "随机种子",
  device: "设备",
  brightness: "明暗",
  fallback: "放宽条件",
  theme: "主题",
  tag: "标签",
  author: "作者",
  id: "指定图片",
  group: "分组"
};
// Also the order values are listed in: counts and sizes read in their own order.
const randomOptionValueLabels: Record<string, string> = {
  large: "大图",
  medium: "中图",
  small: "小图",
  "1": "1 张",
  "2-10": "2–10 张",
  "11-50": "11–50 张",
  "51+": "51 张以上",
  pc: "桌面",
  mb: "移动",
  auto: "自动",
  dark: "暗色",
  light: "亮色",
  all: "全部",
  [randomApiOptionOther]: "其他取值"
};
const randomOptionValueOrder = Object.keys(randomOptionValueLabels);
const controlLabels: Record<AnalyticsShowControl, string> = {
  pause: "暂停",
  resume: "继续播放",
  mode: "切换画面",
  size: "调整图片大小",
  grouping: "切换星群分组"
};

// One bar per parameter: the calls that used it. Parameters with a short list
// of values break that count down by value; the others only record use.
function randomOptionRows(options: AnalyticsRandomDto["options"]): ShareRow[] {
  const byOption = new Map<string, { requests: number; values: AnalyticsRandomDto["options"] }>();
  for (const row of options) {
    const entry = byOption.get(row.option) ?? { requests: 0, values: [] };
    entry.requests += row.requests;
    if (row.value !== randomApiOptionUsed) entry.values.push(row);
    byOption.set(row.option, entry);
  }
  const listed = (values: AnalyticsRandomDto["options"]) => [...values]
    .sort((left, right) => randomOptionValueOrder.indexOf(left.value) - randomOptionValueOrder.indexOf(right.value))
    .map((row) => `${randomOptionValueLabels[row.value] ?? row.value} ${formatCount(row.requests)}`)
    .join(" · ");
  return [...byOption]
    .sort(([leftOption, left], [rightOption, right]) =>
      right.requests - left.requests || leftOption.localeCompare(rightOption))
    .map(([option, entry]) => ({
      key: option,
      label: randomOptionLabels[option] ?? option,
      value: entry.requests,
      detail: entry.values.length ? listed(entry.values) : undefined
    }));
}

function formatDuration(ms: number | null) {
  if (ms === null) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function formatMilliseconds(ms: number | null) {
  if (ms === null) return "—";
  return ms < 1000 ? `${Math.round(ms)} 毫秒` : `${(ms / 1000).toFixed(2)} 秒`;
}

// Direct page views without an outside referrer: direct visits, links within
// the site and navigation inside the app. Embedded views are counted apart.
function hostLabel(host: string, direct = "无外部来源") {
  if (host === analyticsDirectHost) return direct;
  if (host === analyticsOtherHost) return "其他";
  return host;
}

function percent(part: number, whole: number) {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—";
}

function shortDay(day: string) {
  return day.slice(5);
}

function Card({ title, wide = false, children }: { title: string; wide?: boolean; children: ReactNode }) {
  return (
    <section className={`analytics-card${wide ? " is-wide" : ""}`}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

type Metric = {
  label: string;
  value: string;
  hint?: string;
  change?: { current: number; previous: number } | null;
};

function MetricChange({ current, previous }: { current: number; previous: number }) {
  if (previous === 0) {
    return <span className="analytics-change">上一周期无数据</span>;
  }
  const ratio = (current - previous) / previous;
  const tone = ratio > 0.0005 ? "up" : ratio < -0.0005 ? "down" : "flat";
  const sign = tone === "up" ? "+" : "";
  return (
    <span className={`analytics-change is-${tone}`}>
      {`${sign}${(ratio * 100).toFixed(1)}%`}
      <small>较上一周期</small>
    </span>
  );
}

function MetricCards({ items }: { items: readonly Metric[] }) {
  return (
    <div className="analytics-metrics">
      {items.map((item) => (
        <div className="analytics-metric" key={item.label}>
          <span className="analytics-metric-label">{item.label}</span>
          <span className="analytics-metric-value">{item.value}</span>
          {item.change ? <MetricChange {...item.change} /> : item.hint && (
            <span className="analytics-change">{item.hint}</span>
          )}
        </div>
      ))}
    </div>
  );
}

const rangeNoticeDetails: Partial<Record<AnalyticsSection, string>> = {
  overview: "访客显示日均与单日峰值，会话按日累加。",
  sources: "来源与嵌入宿主只含每日汇总保留的条目。",
  errors: "错误只含每日汇总保留的条目。"
};

/** Explains what a range reaching past the raw retention can still show. */
export function RangeNotice({ range, section }: { range: AnalyticsRangeDto; section: AnalyticsSection }) {
  const detail = rangeNoticeDetails[section];
  if (range.from >= range.raw_from || !detail) return null;
  return (
    <p className="analytics-notice">
      {`${range.raw_from} 之前的日期只保留每日汇总，${detail}`}
    </p>
  );
}

// Long daily series read better as weekly columns.
const weeklyColumnsAfterDays = 62;

// Weeks end on the last day of the range, so only the earliest column can be
// shorter than seven days.
function weeklySeries(series: AnalyticsRandomDto["series"]) {
  const weeks: { at: string; requests: number }[] = [];
  const firstFullWeek = series.length % 7;
  series.forEach((point, index) => {
    if (index === 0 || (index - firstFullWeek) % 7 === 0) weeks.push({ at: point.at, requests: 0 });
    weeks.at(-1)!.requests += point.requests;
  });
  return weeks;
}

function visitorMetric(totals: AnalyticsTotalsDto, previous: AnalyticsTotalsDto): Metric {
  if (totals.visitors !== null) {
    return previous.visitors === null
      ? { label: "访客", value: formatCount(totals.visitors), hint: "上一周期超出明细期，不作对比" }
      : {
        label: "访客",
        value: formatCount(totals.visitors),
        change: { current: totals.visitors, previous: previous.visitors }
      };
  }
  return {
    label: "日均访客",
    value: formatCount(totals.visitors_daily_average),
    hint: `单日峰值 ${formatCount(totals.visitors_daily_peak)}`
  };
}

export function OverviewSection({ data }: { data: AnalyticsOverviewDto }) {
  const { totals, previous } = data;
  const pageRows: ShareRow[] = data.pages.map((row) => ({
    key: `${row.page}:${row.embedded}`,
    label: `${row.embedded ? "嵌入" : ""}${pageLabels[row.page]}`,
    value: row.page_views,
    detail: `入口 ${formatCount(row.entries)} · 平均 ${formatDuration(row.visible_ms_average)}`
  }));
  return (
    <>
      <MetricCards
        items={[
          {
            label: "浏览量",
            value: formatCount(totals.page_views),
            change: { current: totals.page_views, previous: previous.page_views }
          },
          visitorMetric(totals, previous),
          {
            label: "会话",
            value: formatCount(totals.sessions),
            // Sessions are counted per day outside the raw retention; a ratio
            // against an exactly counted period would be skewed.
            ...(totals.visitors !== null && previous.visitors !== null
              ? { change: { current: totals.sessions, previous: previous.sessions } }
              : { hint: totals.visitors === null ? "按日累加" : "上一周期按日累加，不作对比" })
          },
          {
            label: "平均可见时长",
            value: formatDuration(totals.visible_ms_average),
            hint: "页面处于前台的时长"
          },
          {
            label: "嵌入浏览占比",
            value: percent(totals.embedded_page_views, totals.page_views),
            hint: `嵌入浏览 ${formatCount(totals.embedded_page_views)}`
          },
          {
            label: "随机 API 调用",
            value: formatCount(totals.random_requests),
            change: { current: totals.random_requests, previous: previous.random_requests }
          }
        ]}
      />
      <MetricCards
        items={[
          {
            label: "新访客",
            value: formatCount(totals.new_visitors),
            hint: totals.visitors === null
              ? "首次生成访客编号（上限）"
              : `占访客 ${percent(totals.new_visitors, totals.visitors)}（上限）`
          },
          {
            label: "每会话浏览",
            value: totals.sessions ? `${(totals.page_views / totals.sessions).toFixed(1)} 页` : "—",
            hint: "浏览量 ÷ 会话"
          },
          {
            label: "每会话可见时长",
            value: formatDuration(totals.sessions ? totals.visible_ms / totals.sessions : null),
            hint: "可见时长 ÷ 会话"
          },
          {
            label: "近 5 分钟访客",
            value: formatCount(data.recent_visitors),
            hint: "5 分钟内打开过页面，与范围无关"
          }
        ]}
      />
      <div className="analytics-grid">
        <Card title="访问趋势" wide>
          {data.daily.length > 1 ? (
            <TrendChart
              labels={data.daily.map((day) => day.day)}
              formatLabel={shortDay}
              ariaLabel={`每日浏览量与访客，${data.range.from} 至 ${data.range.to}`}
              series={[
                { key: "views", label: "浏览量", tone: "primary", values: data.daily.map((day) => day.page_views) },
                { key: "visitors", label: "访客", tone: "secondary", values: data.daily.map((day) => day.visitors) }
              ]}
            />
          ) : (
            <p className="analytics-empty">选择两天以上的范围查看趋势</p>
          )}
        </Card>
        <Card title="页面" wide>
          <ShareList rows={pageRows} valueLabel="各页面浏览量" />
        </Card>
        <Card title="会话浏览页数" wide>
          <ShareList
            valueLabel="按浏览页数分档的会话数"
            rows={data.session_depth.map((row) => ({
              key: row.pages,
              label: sessionDepthLabels[row.pages],
              value: row.sessions,
              detail: percent(row.sessions, data.session_depth.reduce((sum, depth) => sum + depth.sessions, 0))
            }))}
          />
          <p className="analytics-note">会话在一天内浏览的页数，跨午夜的会话按日分开；画廊滚动加载更多不算新的浏览。</p>
        </Card>
        <Card title="访问时段" wide>
          {totals.page_views ? (
            <HourHeatmap
              cells={data.hours}
              ariaLabel={`按星期与小时的浏览量，${data.range.from} 至 ${data.range.to}`}
            />
          ) : (
            <p className="analytics-empty">暂无数据</p>
          )}
        </Card>
      </div>
    </>
  );
}

export function ContentSection({ data }: { data: AnalyticsContentDto }) {
  const showDuration = data.show.reduce((sum, row) => sum + row.duration_ms, 0);
  return (
    <div className="analytics-grid">
      <Card title="展映">
        <ShareList
          valueLabel="展映启动次数"
          rows={data.show.map((row) => ({
            key: row.mode,
            label: showModeLabels[row.mode],
            value: row.starts,
            detail: [
              `平均 ${formatDuration(row.starts ? row.duration_ms / row.starts : null)}`,
              `时长占比 ${percent(row.duration_ms, showDuration)}`,
              `切换进入 ${formatCount(row.switched)}`
            ].join(" · ")
          }))}
        />
        <p className="analytics-note">启动次数含打开展映时的初始模式与未能启动的展映（WebGL 不可用或初始化失败见「来源」中的回退，数据加载失败见「错误」）；时长只计页面可见的时间，含失败提示的时间。</p>
      </Card>
      <Card title="展映控件">
        <ShareList
          valueLabel="展映控件使用次数"
          rows={data.controls.map((row) => ({ key: row.control, label: controlLabels[row.control], value: row.count }))}
        />
      </Card>
      <Card title="画廊浏览深度">
        {data.gallery_depth.views ? (
          <dl className="analytics-facts">
            <div>
              <dt>平均加载页数</dt>
              <dd>{(data.gallery_depth.pages / data.gallery_depth.views).toFixed(1)}</dd>
            </div>
            <div>
              <dt>浏览到列表末尾</dt>
              <dd>{percent(data.gallery_depth.reached_end, data.gallery_depth.views)}</dd>
            </div>
          </dl>
        ) : (
          <p className="analytics-empty">暂无数据</p>
        )}
      </Card>
      <Card title="画廊加载页数分布">
        <ShareList
          valueLabel="按加载页数分档的浏览次数"
          rows={data.gallery_depth.views
            ? data.gallery_depth.distribution.map((row) => ({
              key: row.pages,
              label: listDepthLabels[row.pages],
              value: row.count,
              detail: percent(row.count, data.gallery_depth.views)
            }))
            : []}
        />
        <p className="analytics-note">每次浏览加载的列表页数，不等于看过的图片数。</p>
      </Card>
      <Card title="首页入口">
        <ShareList
          valueLabel="首页目录点击次数"
          rows={data.catalog.map((row) => ({ key: row.target, label: catalogLabels[row.target], value: row.count }))}
        />
      </Card>
      <Card title="排序切换">
        <ShareList
          valueLabel="排序切换次数"
          rows={data.sorts.map((row) => ({ key: row.order, label: orderLabels[row.order], value: row.count }))}
        />
      </Card>
    </div>
  );
}

const pageOrder: readonly AnalyticsPage[] = ["gallery", "show", "home"];

/** How much the embedding sites use the gallery and show, beside direct visits. */
function EmbedCard({ embed, range }: { embed: AnalyticsSourcesDto["embed"]; range: AnalyticsRangeDto }) {
  if (!embed.page_views) {
    return (
      <Card title="嵌入" wide>
        <p className="analytics-empty">暂无嵌入访问</p>
      </Card>
    );
  }
  const usage = [...embed.pages]
    .filter((row) => embed.pages.some((other) => other.page === row.page && other.embedded))
    .sort((left, right) =>
      pageOrder.indexOf(left.page) - pageOrder.indexOf(right.page) || Number(left.embedded) - Number(right.embedded));
  return (
    <Card title="嵌入" wide>
      <dl className="analytics-facts is-four">
        <div>
          <dt>主要宿主</dt>
          <dd className="is-text" title={embed.host ?? undefined}>{embed.host ?? "未知宿主"}</dd>
        </div>
        <div>
          <dt>嵌入浏览</dt>
          <dd>{formatCount(embed.page_views)}</dd>
        </div>
        <div>
          <dt>占全站浏览</dt>
          <dd>{percent(embed.page_views, embed.site_page_views)}</dd>
        </div>
        <div>
          <dt>嵌入页访客</dt>
          <dd>{embed.visitors === null ? "—" : formatCount(embed.visitors)}</dd>
        </div>
      </dl>
      {embed.daily.length > 1 && (
        <TrendChart
          labels={embed.daily.map((day) => day.day)}
          formatLabel={shortDay}
          ariaLabel={`每日全站浏览与嵌入浏览，${range.from} 至 ${range.to}`}
          series={[
            { key: "all", label: "全站浏览", tone: "primary", values: embed.daily.map((day) => day.page_views) },
            { key: "embedded", label: "嵌入浏览", tone: "secondary", values: embed.daily.map((day) => day.embedded_page_views) }
          ]}
        />
      )}
      <ShareList
        valueLabel="嵌入与直接访问的浏览量"
        rows={usage.map((row) => ({
          key: `${row.page}:${row.embedded}`,
          label: `${pageLabels[row.page]} · ${row.embedded ? "嵌入" : "直接访问"}`,
          value: row.page_views,
          detail: `平均可见 ${formatDuration(row.visible_ms_average)}`
        }))}
      />
      <p className="analytics-note">
        {embed.visitors === null
          ? "嵌入页访客只在明细保留期内可算。"
          : "嵌入页访客是在嵌入页浏览过的不重复访客，不代表导流到本站的人数。"}
      </p>
    </Card>
  );
}

export function SourcesSection({ data }: { data: AnalyticsSourcesDto }) {
  const supportTotal = data.supports.reduce((sum, row) => sum + row.page_views, 0);
  return (
    <div className="analytics-grid">
      <EmbedCard embed={data.embed} range={data.range} />
      <Card title="来源网站">
        <ShareList
          valueLabel="各来源浏览量"
          rows={data.referrers.map((row) => ({
            key: row.host,
            label: hostLabel(row.host),
            value: row.page_views
          }))}
        />
      </Card>
      <Card title="嵌入宿主">
        <ShareList
          valueLabel="各嵌入宿主浏览量"
          empty="暂无嵌入访问"
          rows={data.embed_hosts.map((row) => ({
            key: row.host,
            label: hostLabel(row.host, "未知宿主"),
            value: row.page_views
          }))}
        />
      </Card>
      <Card title="设备">
        <ShareList
          valueLabel="各设备浏览量"
          rows={data.devices.map((row) => ({
            key: row.device,
            label: deviceLabels[row.device] ?? row.device,
            value: row.page_views
          }))}
        />
      </Card>
      <Card title="浏览器">
        <ShareList
          valueLabel="各浏览器浏览量"
          rows={data.browsers.map((row) => ({ key: row.browser, label: row.browser, value: row.page_views }))}
        />
      </Card>
      <Card title="操作系统">
        <ShareList
          valueLabel="各系统浏览量"
          rows={data.systems.map((row) => ({ key: row.os, label: row.os, value: row.page_views }))}
        />
      </Card>
      <Card title="旧浏览器版本">
        <ShareList
          valueLabel="只开放画廊的旧浏览器各版本浏览量"
          empty="没有旧浏览器访问"
          rows={data.legacy_browsers.map((row) => ({
            key: `${row.browser}:${row.major}`,
            label: `${row.browser} ${row.major ?? "未知版本"}`,
            value: row.page_views
          }))}
        />
      </Card>
      <Card title="视口宽度">
        <ShareList
          valueLabel="各视口宽度分档浏览量"
          rows={data.viewports.map((row) => ({
            key: row.viewport,
            label: viewportLabels[row.viewport],
            value: row.page_views,
            detail: percent(row.page_views, data.viewports.reduce((sum, viewport) => sum + viewport.page_views, 0))
          }))}
        />
      </Card>
      <Card title="明暗偏好">
        <ShareList
          valueLabel="系统明暗偏好浏览量"
          rows={data.color_schemes.map((row) => ({
            key: row.scheme,
            label: colorSchemeLabels[row.scheme],
            value: row.page_views
          }))}
        />
      </Card>
      <Card title="减少动态效果">
        <ShareList
          valueLabel="系统减少动态效果设置浏览量"
          rows={data.reduced_motion.map((row) => ({
            key: String(row.reduced),
            label: row.reduced ? "开启" : "未开启",
            value: row.page_views
          }))}
        />
      </Card>
      <Card title="浏览器支持与回退">
        <ShareList
          valueLabel="浏览器支持档浏览量"
          rows={data.supports.map((row) => ({
            key: row.support,
            label: supportLabels[row.support],
            value: row.page_views,
            detail: percent(row.page_views, supportTotal)
          }))}
        />
        <ShareList
          valueLabel="回退次数"
          empty="没有发生回退"
          rows={data.fallbacks.map((row) => ({
            key: row.reason,
            label: fallbackLabels[row.reason],
            value: row.count
          }))}
        />
      </Card>
    </div>
  );
}

export function RandomSection({ data }: { data: AnalyticsRandomDto }) {
  const { totals } = data;
  const hourly = data.granularity === "hour";
  const weekly = !hourly && data.series.length > weeklyColumnsAfterDays;
  const columns = weekly ? weeklySeries(data.series) : data.series;
  return (
    <>
      <MetricCards
        items={[
          { label: "调用", value: formatCount(totals.requests) },
          { label: "返回图片", value: formatCount(totals.images) },
          { label: "可信来源占比", value: percent(totals.trusted_requests, totals.requests), hint: "本站、附加站点与允许列表" },
          { label: "限流比例", value: percent(totals.rate_limited, totals.requests), hint: "返回 429 的调用" },
          {
            label: "平均耗时",
            value: formatMilliseconds(totals.requests ? totals.duration_ms / totals.requests : null),
            hint: "服务端处理，不含传输图片"
          },
          { label: "最大耗时", value: formatMilliseconds(totals.requests ? totals.duration_ms_max : null) }
        ]}
      />
      <div className="analytics-grid">
        <Card title={hourly ? "每小时调用" : weekly ? "每周调用" : "每日调用"} wide>
          {columns.length ? (
            <ColumnChart
              labels={columns.map((point) => point.at)}
              values={columns.map((point) => point.requests)}
              label="调用"
              formatLabel={(at) => (hourly ? at.slice(11, 16) : weekly ? `${shortDay(at)} 起` : shortDay(at))}
              ariaLabel={`随机 API 调用次数，${data.range.from} 至 ${data.range.to}`}
            />
          ) : (
            <p className="analytics-empty">暂无数据</p>
          )}
        </Card>
        <Card title="返回模式与状态">
          <ShareList
            valueLabel="各模式与状态调用次数"
            rows={data.modes.map((row) => ({
              key: `${row.mode}:${row.method}:${row.status}`,
              // HEAD calls (link checks, prefetching) stay apart from the GET they mirror.
              label: [randomModeLabels[row.mode] ?? row.mode, statusLabels[row.status], row.method === "HEAD" ? "HEAD" : ""]
                .filter(Boolean).join(" · "),
              value: row.requests,
              detail: `${formatCount(row.images)} 张 · 平均 ${formatMilliseconds(row.duration_ms / row.requests)}`
            }))}
          />
        </Card>
        <Card title="来源主机">
          <ShareList
            valueLabel="各来源调用次数"
            rows={data.hosts.map((row) => ({
              key: `${row.host}:${row.trusted}`,
              label: hostLabel(row.host, "无来源（直接调用）"),
              value: row.requests,
              detail: row.trusted ? "可信来源" : undefined
            }))}
          />
        </Card>
        <Card title="查询参数" wide>
          <ShareList valueLabel="带各查询参数的调用次数" rows={randomOptionRows(data.options)} />
          <p className="analytics-note">每项是带该参数的调用次数；图片档位、数量、设备与明暗另列各取值，其余参数只记是否使用、不记内容。返回方式见「返回模式与状态」。</p>
        </Card>
      </div>
    </>
  );
}

function TimingCard({ data, timing, wide = false, children }: {
  data: AnalyticsPerformanceDto;
  timing: AnalyticsTiming;
  wide?: boolean;
  children?: ReactNode;
}) {
  const rows = data.timings.filter((row) => row.timing === timing);
  const counted = rows.reduce((sum, row) => sum + row.count, 0);
  return (
    <Card title={timingLabels[timing]} wide={wide}>
      <ShareList
        valueLabel={`${timingLabels[timing]}的分档次数`}
        rows={counted
          ? analyticsTimingBuckets.map((bucket) => {
            const count = rows.find((row) => row.bucket === bucket)?.count ?? 0;
            return { key: bucket, label: timingBucketLabels[bucket], value: count, detail: percent(count, counted) };
          })
          : []}
      />
      {children}
    </Card>
  );
}

export function PerformanceSection({ data }: { data: AnalyticsPerformanceDto }) {
  return (
    <div className="analytics-grid">
      <TimingCard data={data} timing="lcp" wide>
        <p className="analytics-note">每个文档首次打开时记录一次，之后在站内切换页面不再记录；Safari 不提供最大内容绘制。</p>
      </TimingCard>
      <TimingCard data={data} timing="ttfb" />
      <TimingCard data={data} timing="fcp" />
    </div>
  );
}

export function ErrorsSection({ data }: { data: AnalyticsErrorsDto }) {
  return (
    <div className="analytics-grid">
      <Card title="页面错误" wide>
        <ShareList
          valueLabel="各错误出现次数"
          empty="访客没有遇到错误"
          rows={data.errors.map((row) => ({
            key: `${row.page}:${row.status}:${row.code}`,
            label: [pageLabels[row.page], row.status ?? "", row.code ?? "未知错误"].filter(Boolean).join(" · "),
            value: row.count
          }))}
        />
      </Card>
      <Card title="嵌入协议停用" wide>
        <ShareList
          valueLabel="嵌入协议停用次数"
          empty="没有嵌入协议停用"
          rows={data.bridges.map((row) => ({ key: row.bridge, label: bridgeLabels[row.bridge], value: row.count }))}
        />
      </Card>
      <Card title="图片加载失败">
        <ShareList
          valueLabel="各页面图片加载失败次数"
          empty="没有图片加载失败"
          rows={data.image_failures.map((row) => ({ key: row.page, label: pageLabels[row.page], value: row.count }))}
        />
        <p className="analytics-note">画廊缩略图与展映图片加载失败的次数：画廊每次加载失败都计入，展映同一图片在一次浏览中只计一次。</p>
      </Card>
      <Card title="采集丢弃">
        <ShareList
          valueLabel="各原因丢弃的上报"
          empty="没有丢弃上报"
          rows={data.collect_dropped.map((row) => ({ key: row.reason, label: dropReasonLabels[row.reason], value: row.count }))}
        />
        <p className="analytics-note">被丢弃的上报不进入其他统计，其他数字因此是下限。</p>
      </Card>
    </div>
  );
}
