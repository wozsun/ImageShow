import type { PublicImageOrder } from "./images.ts";
import type { ShowMode } from "./settings.ts";

/**
 * 访问统计的事件契约：公开页面采集与服务端校验共用同一份事件、页面与保留档位。
 * 未知事件或字段一律拒收；访问档原始事件保留 analytics.visit_retention_days 天，
 * 交互档保留 analytics.interaction_retention_days 天，天数为 0 的档位不删除，日汇总永久保留。
 */
export const analyticsCollectPath = "/api/collect";
export const analyticsTodayVisitorsPath = "/api/visitors/today";

export const analyticsCollectLimits = {
  maxEvents: 20,
  // Twenty page views with two maximum-length hosts fit with room to spare.
  maxBodyBytes: 16 * 1024,
  maxDurationMs: 24 * 60 * 60 * 1000,
  // A broken image host can fail every tile a long view shows.
  maxImageFailures: 100_000
} as const;

/** Host names as statistics keep them: the hostname of a URL, lowercased. */
export const analyticsHostPattern = /^[a-z0-9.\-:[\]]{1,253}$/u;
/** API error codes reported by error states. */
export const analyticsErrorCodePattern = /^[a-z0-9_]{1,64}$/u;

export const analyticsPages = ["home", "gallery", "show"] as const;
export type AnalyticsPage = (typeof analyticsPages)[number];

const analyticsEventTiers = {
  page_view: "visit",
  page_leave: "visit",
  error_shown: "interaction",
  fallback: "interaction",
  catalog_click: "interaction",
  sort_change: "interaction",
  list_progress: "interaction",
  show_start: "interaction",
  show_end: "interaction",
  control_use: "interaction",
  bridge_failed: "interaction",
  image_failures: "interaction",
  perf: "interaction"
} as const satisfies Record<string, "visit" | "interaction">;

export type AnalyticsEventName = keyof typeof analyticsEventTiers;
export type AnalyticsEventTier = (typeof analyticsEventTiers)[AnalyticsEventName];

const analyticsEventNames = Object.keys(analyticsEventTiers) as AnalyticsEventName[];

export function analyticsEventsOfTier(tier: AnalyticsEventTier) {
  return analyticsEventNames.filter((event) => analyticsEventTiers[event] === tier);
}

/** 浏览器支持档：完整站点，或旧浏览器只开放的画廊。 */
export const analyticsBrowserSupports = ["full", "gallery"] as const;
export type AnalyticsBrowserSupport = (typeof analyticsBrowserSupports)[number];

export const analyticsFallbackReasons = ["legacy_browser", "webgl_unavailable", "show_init_failed"] as const;
export type AnalyticsFallbackReason = (typeof analyticsFallbackReasons)[number];

export const analyticsCatalogTargets = ["browse", "theme", "tag", "author", "device", "brightness"] as const;
export type AnalyticsCatalogTarget = (typeof analyticsCatalogTargets)[number];

// 排序另有 sort_change，不在控件中重复计数。
export const analyticsShowControls = ["pause", "resume", "mode", "size", "grouping"] as const;
export type AnalyticsShowControl = (typeof analyticsShowControls)[number];

/** 一次报表请求最多覆盖的天数（含首尾两天）。 */
export const analyticsMaxRangeDays = 731;
/** 报表可查询的最早日期；更早的日期没有统计，也不是有效的历史范围。 */
export const analyticsEarliestDay = "1970-01-01";

/** 画廊每次浏览加载页数的分档。 */
export const analyticsListDepths = ["1", "2", "3-4", "5-9", "10+"] as const;
export type AnalyticsListDepth = (typeof analyticsListDepths)[number];

export const analyticsBridges = ["cursor", "safe_area"] as const;
export type AnalyticsBridge = (typeof analyticsBridges)[number];

/** 页面浏览时视口宽度（CSS 像素）的分档。 */
export const analyticsViewports = ["0-599", "600-1023", "1024-1439", "1440+"] as const;
export type AnalyticsViewport = (typeof analyticsViewports)[number];

export const analyticsColorSchemes = ["light", "dark"] as const;
export type AnalyticsColorScheme = (typeof analyticsColorSchemes)[number];

/** 会话在一天内浏览页数的分档；只有 1 页的会话即跳出。 */
export const analyticsSessionDepths = ["1", "2", "3-4", "5+"] as const;
export type AnalyticsSessionDepth = (typeof analyticsSessionDepths)[number];

/** 文档加载耗时：首字节、首次内容绘制与最大内容绘制。 */
export const analyticsTimings = ["ttfb", "fcp", "lcp"] as const;
export type AnalyticsTiming = (typeof analyticsTimings)[number];
/** 加载耗时的分档（毫秒，含下限、不含上限）。 */
export const analyticsTimingBuckets = ["0-200", "200-500", "500-1000", "1000-2500", "2500-4000", "4000+"] as const;
export type AnalyticsTimingBucket = (typeof analyticsTimingBuckets)[number];

/** 随机 API 查询参数的两个特殊取值：只记是否出现的参数记为 used，不在可列取值中的记为 other。 */
export const randomApiOptionUsed = "used";
export const randomApiOptionOther = "other";

/** 统计上报被丢弃的原因：按 IP 限流按请求计，其余按事件计。 */
export const analyticsCollectDropReasons = ["ip_rate_limited", "site_capped", "buffer_full", "write_failed"] as const;
export type AnalyticsCollectDropReason = (typeof analyticsCollectDropReasons)[number];

type AnalyticsEventBase = {
  page: AnalyticsPage;
  embedded: boolean;
};

export type AnalyticsEventInput = AnalyticsEventBase & (
  | {
      event: "page_view";
      /** 外部来源的主机名；站内跳转、直接访问或取不到时为 null。 */
      referrer: string | null;
      /** 嵌入页的宿主主机名；非嵌入页为 null。 */
      embed_host: string | null;
      entry: boolean;
      support: AnalyticsBrowserSupport;
      /** 访客编号在本文档中刚生成后的第一次浏览；不保存本地存储时每个文档都是。 */
      new_visitor: boolean;
      viewport: AnalyticsViewport;
      color_scheme: AnalyticsColorScheme;
      reduced_motion: boolean;
    }
  | { event: "page_leave"; visible_ms: number }
  | { event: "error_shown"; status: number | null; code: string | null }
  | { event: "fallback"; reason: AnalyticsFallbackReason }
  | { event: "catalog_click"; target: AnalyticsCatalogTarget }
  | { event: "sort_change"; order: PublicImageOrder }
  | { event: "list_progress"; pages: number; reached_end: boolean }
  /** switched：由页面内切换进入，而不是打开展映时的初始模式。 */
  | { event: "show_start"; mode: ShowMode; switched: boolean }
  | { event: "show_end"; mode: ShowMode; duration_ms: number }
  | { event: "control_use"; control: AnalyticsShowControl }
  | { event: "bridge_failed"; bridge: AnalyticsBridge }
  /** 一次浏览中画廊或展映图片加载失败的次数，浏览结束时发送。 */
  | { event: "image_failures"; count: number }
  /** 文档首次浏览结束时发送一次；浏览器不提供的耗时为 null。 */
  | { event: "perf"; ttfb_ms: number | null; fcp_ms: number | null; lcp_ms: number | null }
);

export type AnalyticsCollectRequestDto = {
  visitor: string;
  session: string;
  events: AnalyticsEventInput[];
};

export type AnalyticsTodayVisitorsDto = {
  visitors: number;
};

export const analyticsSections = ["overview", "content", "sources", "random", "performance", "errors"] as const;
export type AnalyticsSection = (typeof analyticsSections)[number];

export const analyticsClearScopes = ["visits", "random", "all"] as const;
export type AnalyticsClearScope = (typeof analyticsClearScopes)[number];

/** 随机 API 的状态类别：成功（2xx 与跳转）、限流、其他客户端错误、服务端错误。 */
export type RandomApiStatusClass = "success" | "rate_limited" | "client_error" | "server_error";

/** 来源主机的两个保留值：无外部来源（直接访问、站内跳转，随机 API 为不带 Referer 的调用）与合并的其他主机（超出汇总的每日名额；随机 API 另含超出每小时名额、无法解析或不符合主机名格式的 Referer）。 */
export const analyticsDirectHost = "";
export const analyticsOtherHost = "*";

/** 日期以 `YYYY-MM-DD` 表示，日界按服务端 TZ。 */
export type AnalyticsRangeDto = {
  from: string;
  to: string;
  today: string;
  /** 原始明细覆盖的最早日期；早于它的范围只能读取日汇总。 */
  raw_from: string;
};

export type AnalyticsTotalsDto = {
  page_views: number;
  /** 范围完全在原始明细保留期内时为跨日去重的访客数，否则为 null，改看日均与峰值。 */
  visitors: number | null;
  visitors_daily_average: number;
  visitors_daily_peak: number;
  sessions: number;
  /** 浏览器本地首次生成访客编号的访客；清除站点数据或不保存本地存储时偏高。 */
  new_visitors: number;
  visible_ms: number;
  visible_ms_average: number | null;
  /** 嵌入页的浏览量，已包含在 page_views 中。 */
  embedded_page_views: number;
  random_requests: number;
};

export type AnalyticsOverviewDto = {
  range: AnalyticsRangeDto;
  totals: AnalyticsTotalsDto;
  previous: AnalyticsTotalsDto;
  daily: { day: string; page_views: number; visitors: number }[];
  /** 本地时间的星期（0 为周一）× 小时的浏览量，共 7 × 24 格。 */
  hours: { weekday: number; hour: number; page_views: number }[];
  pages: AnalyticsPageUsageDto[];
  /** 按会话在一天内的浏览页数分档的会话数；跨午夜的会话按日拆分。 */
  session_depth: { pages: AnalyticsSessionDepth; sessions: number }[];
  /** 最近 5 分钟打开过公开页面的不重复访客，与所选范围无关。 */
  recent_visitors: number;
};

/** 某页面直接访问或嵌入时的浏览量、会话入口次数与平均可见时长。 */
export type AnalyticsPageUsageDto = {
  page: AnalyticsPage;
  embedded: boolean;
  page_views: number;
  entries: number;
  visible_ms_average: number | null;
};

export type AnalyticsContentDto = {
  range: AnalyticsRangeDto;
  sorts: { order: PublicImageOrder; count: number }[];
  /** starts 含打开展映时的初始模式；switched 为其中由页面内切换进入的次数；duration_ms 只计可见时间。 */
  show: { mode: ShowMode; starts: number; switched: number; duration_ms: number }[];
  controls: { control: AnalyticsShowControl; count: number }[];
  /** 画廊列表：结束浏览时的记录数、累计加载页数、到达末尾的次数与按加载页数分档的记录数。 */
  gallery_depth: {
    views: number;
    pages: number;
    reached_end: number;
    distribution: { pages: AnalyticsListDepth; count: number }[];
  };
  catalog: { target: AnalyticsCatalogTarget; count: number }[];
};

type AnalyticsHostRowDto = { host: string; page_views: number };

export type AnalyticsSourcesDto = {
  range: AnalyticsRangeDto;
  /** 嵌入页的使用量；访客只表示在嵌入页浏览过的不重复访客，不代表导流到本站的人数。 */
  embed: {
    /** 嵌入浏览最多的宿主。 */
    host: string | null;
    page_views: number;
    site_page_views: number;
    /** 范围完全在明细保留期内时为跨日去重的嵌入页访客，否则为 null。 */
    visitors: number | null;
    daily: { day: string; page_views: number; embedded_page_views: number }[];
    pages: AnalyticsPageUsageDto[];
  };
  /** 非嵌入浏览的来源网站；空主机为直接访问、站内跳转或不带来源的访问。 */
  referrers: AnalyticsHostRowDto[];
  embed_hosts: AnalyticsHostRowDto[];
  devices: { device: string; page_views: number }[];
  browsers: { browser: string; page_views: number }[];
  systems: { os: string; page_views: number }[];
  supports: { support: AnalyticsBrowserSupport; page_views: number }[];
  fallbacks: { reason: AnalyticsFallbackReason; count: number }[];
  /** 只开放画廊的旧浏览器按浏览器与主版本的浏览量。 */
  legacy_browsers: { browser: string; major: number | null; page_views: number }[];
  viewports: { viewport: AnalyticsViewport; page_views: number }[];
  color_schemes: { scheme: AnalyticsColorScheme; page_views: number }[];
  reduced_motion: { reduced: boolean; page_views: number }[];
};

export type AnalyticsRandomDto = {
  range: AnalyticsRangeDto;
  granularity: "hour" | "day";
  series: { at: string; requests: number; images: number }[];
  /** duration_ms 为服务端处理到响应头的耗时之和，不含传输图片。 */
  modes: {
    mode: string;
    method: "GET" | "HEAD";
    status: RandomApiStatusClass;
    requests: number;
    images: number;
    duration_ms: number;
  }[];
  hosts: { host: string; trusted: boolean; requests: number; images: number }[];
  /** 各查询参数出现的调用次数；筛选、分组、指定图片、放宽条件与 seed 只记是否出现，不记取值。 */
  options: { option: string; value: string; requests: number }[];
  totals: {
    requests: number;
    images: number;
    trusted_requests: number;
    rate_limited: number;
    duration_ms: number;
    duration_ms_max: number;
  };
};

export type AnalyticsPerformanceDto = {
  range: AnalyticsRangeDto;
  timings: { timing: AnalyticsTiming; bucket: AnalyticsTimingBucket; count: number }[];
};

export type AnalyticsErrorsDto = {
  range: AnalyticsRangeDto;
  errors: { page: AnalyticsPage; status: number | null; code: string | null; count: number }[];
  bridges: { bridge: AnalyticsBridge; count: number }[];
  /** 图片加载失败的次数，按发生的页面。 */
  image_failures: { page: AnalyticsPage; count: number }[];
  collect_dropped: { reason: AnalyticsCollectDropReason; count: number }[];
};

export type AnalyticsSectionDto = {
  overview: AnalyticsOverviewDto;
  content: AnalyticsContentDto;
  sources: AnalyticsSourcesDto;
  random: AnalyticsRandomDto;
  performance: AnalyticsPerformanceDto;
  errors: AnalyticsErrorsDto;
};

export type AnalyticsClearRequestDto = {
  scope: AnalyticsClearScope;
};
