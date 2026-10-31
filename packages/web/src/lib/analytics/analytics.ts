import {
  analyticsCollectLimits,
  analyticsErrorCodePattern,
  analyticsHostPattern,
  publicPageTarget,
  type AnalyticsEventInput,
  type AnalyticsPage,
  type AnalyticsViewport
} from "@imageshow/shared/browser";
import { isApiClientError } from "../api/client.js";
import { serverInlinedSiteConfig } from "../api/site-queries.js";
import { supportsFullSite } from "../browser-support.js";
import { readSystemPrefersDark } from "../ui/color-scheme.js";
import { reducedMotionPreferred } from "../ui/reduced-motion.js";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event as pages report it; the tracker adds the page being viewed. */
export type AnalyticsReport = DistributiveOmit<AnalyticsEventInput, "page" | "embedded">;

/** Builds a page's end-of-view summary. */
type PageEndReport = () => AnalyticsReport | null;

type Collector = typeof import("./collector.js");

// Events reported before the collector arrives wait here, bounded.
const pendingLimit = 50;
// A report made while the page is still mounting (layout code runs before the
// page view starts) joins the page that begins right after it.
const unattachedReportMs = 2_000;

let collector: Collector | null = null;
let loading = false;
let pending: AnalyticsEventInput[] = [];
let unattached: { report: AnalyticsReport; atMs: number }[] = [];
let currentPage: { page: AnalyticsPage; embedded: boolean } | null = null;
let activeView: { serial: number } | null = null;
let viewSerial = 0;
let excludedAreas = 0;
let imageFailures = 0;
const pageEndReports = new Set<{ report: PageEndReport; sentInView: number }>();

function loadCollector() {
  if (collector || loading) return;
  loading = true;
  void import("./collector.js")
    .then((module) => {
      collector = module;
      const queued = pending;
      pending = [];
      for (const event of queued) module.queueAnalyticsEvent(event);
    })
    .catch(() => {
      // Statistics never affect the page; a failed load drops what waited.
      pending = [];
    });
}

function deliver(event: AnalyticsEventInput) {
  if (collector) {
    collector.queueAnalyticsEvent(event);
    return;
  }
  if (pending.length < pendingLimit) pending.push(event);
  loadCollector();
}

/**
 * Counts views of a mounted page and returns the function that stops. Collection
 * runs only on public pages when the site enables it; otherwise the collector
 * module is never loaded and reports are dropped. Closing the document ends
 * the view; a restore from the back-forward cache starts the next one.
 */
export function beginAnalyticsPage(page: AnalyticsPage, embedded: boolean, siteEnabled: boolean) {
  if (!siteEnabled) {
    unattached = [];
    return () => undefined;
  }
  let visibility: ReturnType<typeof startVisibleClock> | null = null;
  const start = () => {
    viewSerial += 1;
    activeView = { serial: viewSerial };
    imageFailures = 0;
    visibility = startVisibleClock();
    if (!loadTimingsReported) observeLargestPaint();
    currentPage = { page, embedded };
    deliver({ page, embedded, ...pageViewFields(embedded) } as AnalyticsEventInput);
    if (!supportsFullSite && page === "gallery") reportLegacyFallback(embedded);
    const recent = unattached.filter((entry) => performance.now() - entry.atMs <= unattachedReportMs);
    unattached = [];
    for (const { report } of recent) deliver({ page, embedded, ...report } as AnalyticsEventInput);
  };
  const end = () => {
    const view = activeView;
    if (!view || !visibility) return;
    activeView = null;
    for (const entry of pageEndReports) {
      if (entry.sentInView === view.serial) continue;
      entry.sentInView = view.serial;
      const summary = entry.report();
      if (summary) deliver({ page, embedded, ...summary } as AnalyticsEventInput);
    }
    if (imageFailures) {
      const count = Math.min(imageFailures, analyticsCollectLimits.maxImageFailures);
      deliver({ page, embedded, event: "image_failures", count });
    }
    if (!loadTimingsReported) {
      loadTimingsReported = true;
      deliver({ page, embedded, ...loadTimingsReport() });
    }
    deliver({ page, embedded, event: "page_leave", visible_ms: visibility.stop() });
    visibility = null;
    currentPage = null;
    collector?.flushAnalyticsEvents();
  };
  const resume = (event: PageTransitionEvent) => {
    if (event.persisted) start();
  };
  start();
  window.addEventListener("pagehide", end);
  window.addEventListener("pageshow", resume);
  return () => {
    window.removeEventListener("pagehide", end);
    window.removeEventListener("pageshow", resume);
    end();
  };
}

/**
 * Marks a mounted area that is never counted, such as the admin, and returns
 * the function that ends it. Its reports are dropped instead of waiting for
 * a public page that opens soon after.
 */
export function excludeFromAnalytics() {
  excludedAreas += 1;
  unattached = [];
  return () => {
    excludedAreas -= 1;
  };
}

/** Reports an interaction on the page being viewed; dropped outside public pages. */
export function trackAnalytics(report: AnalyticsReport) {
  if (excludedAreas > 0) return;
  if (currentPage) {
    deliver({ ...currentPage, ...report } as AnalyticsEventInput);
  } else if (unattached.length < pendingLimit) {
    unattached.push({ report, atMs: performance.now() });
  }
}

/** Counts an image of the viewed page that failed to load; sent once when the view ends. */
export function countImageLoadFailure() {
  if (activeView && excludedAreas === 0) imageFailures += 1;
}

/** The report for an error state shown on a page; values the server would refuse stay empty. */
export function errorShownReport(error: unknown): AnalyticsReport {
  const apiError = isApiClientError(error) ? error : null;
  return {
    event: "error_shown",
    status: apiError && apiError.status >= 100 && apiError.status <= 599 ? apiError.status : null,
    code: apiError && analyticsErrorCodePattern.test(apiError.code) ? apiError.code : null
  };
}

/**
 * Registers a summary the page sends once per view when the view ends
 * (leaving the page or closing the document), such as how far a list was
 * read. The returned function withdraws it and returns the summary when the
 * current view has not sent it yet, for the caller to report itself.
 */
export function reportAtPageEnd(report: PageEndReport) {
  const entry = { report, sentInView: 0 };
  pageEndReports.add(entry);
  return () => {
    pageEndReports.delete(entry);
    return activeView && entry.sentInView !== activeView.serial ? report() : null;
  };
}

let firstViewOfDocument = true;

// A host the server would reject (such as an app package with underscores)
// is left out instead of failing the whole batch.
function hostnameOf(url: string | undefined) {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return analyticsHostPattern.test(host) ? host : null;
  } catch {
    return null;
  }
}

function viewportOf(width: number): AnalyticsViewport {
  if (width < 600) return "0-599";
  if (width < 1024) return "600-1023";
  return width < 1440 ? "1024-1439" : "1440+";
}

function pageViewFields(embedded: boolean) {
  // Only the document's first view came from document.referrer; later views
  // are navigation inside the app. In an embed the referrer is the host page.
  const first = firstViewOfDocument;
  firstViewOfDocument = false;
  const ownHost = location.hostname.toLowerCase();
  const referrer = hostnameOf(document.referrer);
  const ancestors = (location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  return {
    event: "page_view" as const,
    referrer: first && !embedded && referrer !== ownHost ? referrer : null,
    embed_host: embedded ? hostnameOf(ancestors?.[0] ?? document.referrer) : null,
    entry: false,
    support: supportsFullSite ? "full" as const : "gallery" as const,
    new_visitor: false,
    viewport: viewportOf(window.innerWidth),
    color_scheme: readSystemPrefersDark() ? "dark" as const : "light" as const,
    reduced_motion: reducedMotionPreferred()
  };
}

// Load timings describe the document, so only its first view reports them.
let loadTimingsReported = false;
let largestPaintMs: number | null = null;
let largestPaintObserver: PerformanceObserver | null = null;

function observeLargestPaint() {
  if (largestPaintObserver || !PerformanceObserver.supportedEntryTypes.includes("largest-contentful-paint")) return;
  largestPaintObserver = new PerformanceObserver((list) => {
    const entries = list.getEntries();
    largestPaintMs = entries[entries.length - 1]?.startTime ?? largestPaintMs;
  });
  largestPaintObserver.observe({ type: "largest-contentful-paint", buffered: true });
}

// Zero means the browser did not record the moment (such as a prerendered page).
function timingMs(value: number | null | undefined) {
  return value && value > 0 ? Math.min(Math.round(value), analyticsCollectLimits.maxDurationMs) : null;
}

function loadTimingsReport(): AnalyticsReport {
  largestPaintObserver?.disconnect();
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return {
    event: "perf",
    ttfb_ms: timingMs(navigation?.responseStart),
    fcp_ms: timingMs(performance.getEntriesByName("first-contentful-paint")[0]?.startTime),
    lcp_ms: timingMs(largestPaintMs)
  };
}

let legacyFallbackReported = false;

function reportLegacyFallback(embedded: boolean) {
  if (legacyFallbackReported) return;
  legacyFallbackReported = true;
  // The address the document opened at, before routes redirected a page this
  // browser cannot show, under the configuration before the gallery-only rules.
  const config = serverInlinedSiteConfig();
  const opened = new URL(performance.getEntriesByType("navigation")[0]?.name || location.href).pathname;
  const target = config && publicPageTarget(config.site, config.embed.enabled, opened);
  if (target && !target.endsWith("/gallery")) {
    deliver({ page: "gallery", embedded, event: "fallback", reason: "legacy_browser" });
  }
}

/**
 * Counts the time the page is visible. `take` returns what accumulated since
 * the previous take, so a view restored from the back-forward cache counts
 * only its own time.
 */
export function startVisibleClock() {
  let visibleMs = 0;
  let since = document.visibilityState === "visible" ? performance.now() : null;
  const onVisibility = () => {
    if (document.visibilityState === "visible") {
      since ??= performance.now();
    } else if (since !== null) {
      visibleMs += performance.now() - since;
      since = null;
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  const take = () => {
    if (since !== null) {
      const now = performance.now();
      visibleMs += now - since;
      since = now;
    }
    const taken = Math.min(Math.round(visibleMs), analyticsCollectLimits.maxDurationMs);
    visibleMs = 0;
    return taken;
  };
  return {
    take,
    stop() {
      document.removeEventListener("visibilitychange", onVisibility);
      return take();
    }
  };
}
