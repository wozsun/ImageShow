import assert from "node:assert/strict";
import { Hono } from "hono";
import { analyticsCollectLimits } from "@imageshow/shared/browser";
import type { AdminSession } from "../../../../packages/server/src/core/http/admin-session-context.ts";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
  // Day boundaries follow UTC, whatever zone the host shell runs in.
  process.env.TZ = "UTC";
  const { createHttpApp } = await import("../../../../packages/server/src/http-app.ts");
  const { registerAdminAnalyticsRoutes } = await import("../../../../packages/server/src/routes/analytics.ts");
  const { handleApiError } = await import("../../../../packages/server/src/core/http/responses.ts");
  const { requireAdminCsrf } = await import("../../../../packages/server/src/users/admin-session.ts");
  const { limitProtectedAdminRequestBody } =
    await import("../../../../packages/server/src/core/http/request-body-limit.ts");
  const { drainAnalyticsWriter } = await import("../../../../packages/server/src/analytics/runtime.ts");
  const { pruneExpiredAnalytics, rollupFinishedDays } =
    await import("../../../../packages/server/src/analytics/retention.ts");
  const { analyticsReport } = await import("../../../../packages/server/src/analytics/reports.ts");
  const { analyticsTimeZone } = await import("../../../../packages/server/src/analytics/time-zone.ts");
  const { pool } = runtime.databasePools;
  const { updateRuntimeConfig } = runtime.runtimeConfigStore;
  const signal = new AbortController().signal;
  await updateRuntimeConfig({
    site: { domain: "images.example.test", additional_domains: [] },
    security: { random_window_seconds: 60, random_max_requests: 5, random_limit_max_requests: 2 }
  });
  const app = createHttpApp({
    businessGateIsOpen: () => true,
    requireRedis: async () => undefined
  });
  const browserAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  const visitor = "00000000-0000-4000-8000-0000000000a1";
  const session = "00000000-0000-4000-8000-0000000000b1";
  const collect = (
    body: unknown,
    headers: Record<string, string> = {}
  ) => app.request("http://internal.test/api/collect", {
    method: "POST",
    headers: {
      Host: "images.example.test",
      "Content-Type": "application/json",
      "Sec-Fetch-Site": "same-origin",
      Origin: "https://images.example.test",
      "X-Forwarded-Proto": "https",
      "X-Real-IP": "192.0.2.10",
      "User-Agent": browserAgent,
      ...headers
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
  const report = (events: unknown[]) => ({ visitor, session, events });
  const pageView = (overrides: Record<string, unknown> = {}) => ({
    event: "page_view",
    page: "gallery",
    embedded: false,
    referrer: "search.example.test",
    embed_host: null,
    entry: true,
    support: "full",
    new_visitor: false,
    viewport: "1440+",
    color_scheme: "dark",
    reduced_motion: false,
    ...overrides
  });
  const rows = async () => (
    await pool.query<{
      event: string;
      page: string;
      embedded: boolean;
      referrer_host: string | null;
      embed_host: string | null;
      device: string;
      browser: string;
      browser_major: number | null;
      os: string;
      detail: Record<string, unknown>;
    }>(
      `SELECT event, page, embedded, referrer_host, embed_host, device, browser, browser_major, os, detail
         FROM visit_event ORDER BY id`
    )
  ).rows;
  const expectStatus = async (response: Response, status: number) => {
    assert.equal(response.status, status, await response.clone().text());
    await response.arrayBuffer();
  };

  // Accepted reports are buffered and written by the single writer.
  await expectStatus(await collect(report([
    pageView({ new_visitor: true }),
    pageView({ page: "home", referrer: "images.example.test", entry: false }),
    pageView({ embedded: true, referrer: null, embed_host: "portal.example.test", entry: false, viewport: "0-599" }),
    { event: "sort_change", page: "gallery", embedded: false, order: "oldest" },
    { event: "page_leave", page: "gallery", embedded: false, visible_ms: 1_500 }
  ])), 204);
  await drainAnalyticsWriter();
  const written = await rows();
  assert.deepEqual(
    written.map((row) => [row.event, row.page, row.embedded, row.referrer_host, row.embed_host]),
    [
      ["page_view", "gallery", false, "search.example.test", null],
      ["page_view", "home", false, null, null],
      ["page_view", "gallery", true, null, "portal.example.test"],
      ["sort_change", "gallery", false, null, null],
      ["page_leave", "gallery", false, null, null]
    ],
    "the site's own host is internal navigation and embed hosts belong to embedded views"
  );
  assert.deepEqual(
    [written[0]!.device, written[0]!.browser, written[0]!.browser_major, written[0]!.os],
    ["desktop", "Chrome", 141, "Windows"]
  );
  assert.deepEqual(written[0]!.detail, {
    entry: true,
    support: "full",
    new_visitor: true,
    viewport: "1440+",
    color_scheme: "dark",
    reduced_motion: false
  });
  assert.deepEqual(written[4]!.detail, { visible_ms: 1_500 });

  // A phone model named like a crawler is still a visitor.
  await expectStatus(await collect(report([pageView({ referrer: null })]), {
    "User-Agent": "Mozilla/5.0 (Linux; Android 13; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
  }), 204);
  await drainAnalyticsWriter();
  assert.deepEqual(
    (await rows()).slice(written.length).map((row) => [row.device, row.browser, row.os]),
    [["mobile", "Chrome", "Android"]]
  );
  await pool.query("DELETE FROM visit_event WHERE device = 'mobile'");

  // Automated clients are accepted and dropped.
  const droppedReports: Record<string, string>[] = [
    { "User-Agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" },
    { "User-Agent": "" }
  ];
  for (const headers of droppedReports) {
    await expectStatus(await collect(report([pageView()]), headers), 204);
  }
  for (const [body, headers, status] of [
    [report([pageView()]), { "Sec-Fetch-Site": "cross-site" }, 403],
    [report([pageView()]), { Origin: "https://untrusted.example.test" }, 403],
    [report([{ ...pageView(), ip: "192.0.2.1" }]), {}, 400],
    [report([{ event: "purchase", page: "home", embedded: false }]), {}, 400],
    [report([pageView({ viewport: "1920" })]), {}, 400],
    [report([]), {}, 400],
    [{ ...report([pageView()]), visitor: "not-a-uuid" }, {}, 400],
    ["x".repeat(analyticsCollectLimits.maxBodyBytes + 1), {}, 413],
    ["{", {}, 400]
  ] as const) {
    await expectStatus(await collect(body, headers), status);
  }
  await drainAnalyticsWriter();
  assert.equal((await rows()).length, written.length, "dropped and rejected reports leave no rows");

  // The collect window caps one address; rejected bodies still spend it.
  let limited: Response | null = null;
  for (let index = 0; index < 125 && !limited; index += 1) {
    const response = await collect("{", { "X-Real-IP": "192.0.2.99" });
    if (response.status === 429) limited = response;
    else await expectStatus(response, 400);
  }
  assert.ok(limited, "the 121st report from one address is refused");
  assert.match(limited.headers.get("Retry-After") ?? "", /^[1-9]\d*$/);
  assert.equal((await limited.json()).code, "analytics_rate_limited");

  // Site-wide caps count events across addresses, so rotating them does not help.
  // Events accepted earlier in the same minute count too, so a batch before the
  // last may already be refused; at most 60 events get through either way.
  await updateRuntimeConfig({ analytics: { collect_events_per_minute: 60 } });
  const rowsBeforeCap = (await rows()).length;
  const sortBatch = report(Array.from({ length: 20 }, () => (
    { event: "sort_change", page: "gallery", embedded: false, order: "oldest" }
  )));
  let lastStatus = 0;
  for (let index = 0; index < 4; index += 1) {
    const response = await collect(sortBatch, { "X-Real-IP": `192.0.2.${120 + index}` });
    lastStatus = response.status;
    await response.arrayBuffer();
  }
  await drainAnalyticsWriter();
  assert.equal(lastStatus, 429, "80 events from four addresses exceed 60 a minute");
  assert.ok((await rows()).length - rowsBeforeCap <= 60);
  await updateRuntimeConfig({ analytics: { collect_events_per_minute: 1_200 } });

  // Random API calls are counted anonymously per hour, mode, status and source.
  const randomIds = ["00000000-0000-7000-8000-0000000000e1", "00000000-0000-7000-8000-0000000000e2"];
  for (const id of randomIds) {
    await pool.query(
      `INSERT INTO metadata (id,created_by,status,storage_slug,device,brightness,l_width,l_height,l_byte_size,l_md5,m_width,m_height,m_byte_size,m_md5,s_width,s_height,s_byte_size,s_md5)
       VALUES ($1,'integration-admin','ready','local','pc','dark',1,1,1,$2,1,1,1,$2,1,1,1,$2)`,
      [id, "2".repeat(32)]
    );
  }
  const random = (query: string, headers: Record<string, string> = {}, method = "GET") =>
    app.request(`http://internal.test/random?id=${randomIds.join(",")}&${query}`, {
      method,
      headers: { Host: "images.example.test", "X-Forwarded-Proto": "https", "X-Real-IP": "192.0.2.20", ...headers }
    });
  const external = { Referer: "https://blog.example.test/post" };
  const trusted = { Referer: "https://images.example.test/gallery" };
  await expectStatus(await random("mode=json&limit=2", external), 200);
  await expectStatus(await random("mode=redirect", external), 302);
  await expectStatus(await random("mode=redirect", external, "HEAD"), 302);
  await expectStatus(await random("mode=json", trusted), 200);
  await expectStatus(await random("mode=json&limit=0", external), 400);
  await expectStatus(await random("mode=json", { Referer: `https://${"a".repeat(300)}.example.test/` }), 200);
  await expectStatus(await random("mode=json", external), 429);
  await expectStatus(await random("mode=json", external, "OPTIONS"), 204);
  await drainAnalyticsWriter();
  const randomRows = async () => (
    await pool.query<{
      mode: string;
      method: string;
      status_class: string;
      trusted: boolean;
      referrer_host: string;
      requests: string;
      images: string;
    }>(
      `SELECT mode, method, status_class, trusted, referrer_host, requests::text, images::text
         FROM random_api_hourly
        ORDER BY mode, method, status_class, trusted, referrer_host`
    )
  ).rows.map((row) => [
    row.mode,
    row.method,
    row.status_class,
    row.trusted,
    row.referrer_host,
    Number(row.requests),
    Number(row.images)
  ]);
  // Parameters count by bounded value; ids are only marked as used.
  assert.deepEqual(
    (await pool.query<{ option: string; value: string; requests: string }>(
      "SELECT option, value, sum(requests)::text AS requests FROM random_api_option_hourly GROUP BY option, value ORDER BY option, value"
    )).rows.map((row) => [row.option, row.value, Number(row.requests)]),
    [["id", "used", 7], ["limit", "2-10", 1], ["limit", "other", 1]]
  );
  assert.deepEqual(await randomRows(), [
    ["json", "GET", "client_error", false, "blog.example.test", 1, 0],
    ["json", "GET", "rate_limited", false, "blog.example.test", 1, 0],
    ["json", "GET", "success", false, "*", 1, 1],
    ["json", "GET", "success", false, "blog.example.test", 1, 2],
    ["json", "GET", "success", true, "images.example.test", 1, 1],
    ["redirect", "GET", "success", false, "blog.example.test", 1, 1],
    ["redirect", "HEAD", "success", false, "blog.example.test", 1, 1]
  ]);
  const countedBeforeSwitch = await randomRows();
  await updateRuntimeConfig({ analytics: { enabled: false } });
  await expectStatus(await random("mode=json", trusted), 200);
  await expectStatus(await collect(report([pageView()])), 403);
  await drainAnalyticsWriter();
  assert.deepEqual(await randomRows(), countedBeforeSwitch, "the switch also stops random API counting");

  // Today's visitors: a public count shared by CDNs for a minute.
  const visitors = await app.request("http://internal.test/api/visitors/today", {
    headers: { Host: "images.example.test" }
  });
  assert.equal(visitors.status, 404, "closed statistics hide the count");
  await updateRuntimeConfig({ analytics: { enabled: true } });
  const counted = await app.request("http://internal.test/api/visitors/today", {
    headers: { Host: "images.example.test" }
  });
  assert.equal(counted.status, 200);
  assert.equal(counted.headers.get("Cache-Control"), "public, max-age=60, s-maxage=60");
  assert.deepEqual(await counted.json(), { ok: true, visitors: 1 });

  // Hour buckets follow UTC. In a half-hour zone the hourly series takes the
  // same buckets as the day's totals, labelled at half past.
  const configuredZone = process.env.TZ;
  process.env.TZ = "Asia/Kolkata";
  try {
    const bucketDay = (await pool.query<{ day: string }>(
      "SELECT to_char((max(hour) AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day FROM random_api_hourly"
    )).rows[0]!.day;
    const halfHour = await analyticsReport("random", { from: bucketDay, to: bucketDay });
    assert.equal(halfHour.granularity, "hour");
    assert.ok(halfHour.totals.requests > 0);
    assert.equal(
      halfHour.series.reduce((sum, point) => sum + point.requests, 0),
      halfHour.totals.requests
    );
    assert.ok(halfHour.series.every((point) => point.at.endsWith(":30")));
    // PostgreSQL would read an offset as POSIX, with the opposite sign
    // (UTC-8); statistics fall back to UTC days instead.
    const utcDay = (await pool.query<{ day: string }>(
      "SELECT to_char((now() AT TIME ZONE 'UTC')::date - 2, 'YYYY-MM-DD') AS day"
    )).rows[0]!.day;
    await pool.query(
      `INSERT INTO random_api_hourly
       VALUES (($1::date + time '02:00') AT TIME ZONE 'UTC', 'json', 'GET', 'success', false, '', 7, 7, 70, 20)`,
      [utcDay]
    );
    process.env.TZ = "+08:00";
    assert.equal((await analyticsReport("random", { from: utcDay, to: utcDay })).totals.requests, 7);
    await pool.query("DELETE FROM random_api_hourly WHERE requests = 7");
  } finally {
    if (configuredZone === undefined) delete process.env.TZ;
    else process.env.TZ = configuredZone;
  }

  // Rollups replace live computation with identical numbers, idempotently.
  const timeZone = analyticsTimeZone();
  const { today, yesterday, earlier } = (
    await pool.query<{ today: string; yesterday: string; earlier: string }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS today,
              to_char(day - 1, 'YYYY-MM-DD') AS yesterday,
              to_char(day - 2, 'YYYY-MM-DD') AS earlier
         FROM (SELECT (now() AT TIME ZONE $1)::date AS day) local_day`,
      [timeZone]
    )
  ).rows[0]!;
  const otherVisitor = "00000000-0000-4000-8000-0000000000a2";
  // Interactions sit on the day before yesterday: rollups wait 75 minutes past
  // midnight, so yesterday may still be counted live when the test runs.
  for (const [day, visitorId, event, page, detail, referrer] of [
    [yesterday, visitor, "page_view", "home", {
      entry: true, support: "full", new_visitor: false, viewport: "600-1023", color_scheme: "light", reduced_motion: true
    }, "search.example.test"],
    // Views recorded before the display fields existed count for everything else.
    [yesterday, otherVisitor, "page_view", "show", { entry: true, support: "full", new_visitor: true }, null],
    [earlier, otherVisitor, "show_start", "show", { mode: "cluster", switched: false }, null],
    [earlier, otherVisitor, "show_start", "show", { mode: "cluster", switched: true }, null],
    [earlier, otherVisitor, "show_end", "show", { mode: "cluster", duration_ms: 9_000 }, null],
    [earlier, otherVisitor, "error_shown", "show", { status: 503, code: "redis_unavailable" }, null],
    [earlier, otherVisitor, "control_use", "show", { control: "pause" }, null],
    [earlier, otherVisitor, "list_progress", "gallery", { pages: 3, reached_end: true }, null],
    // Depth buckets on both sides of their bounds.
    [earlier, otherVisitor, "list_progress", "gallery", { pages: 2, reached_end: false }, null],
    [earlier, otherVisitor, "list_progress", "gallery", { pages: 4, reached_end: false }, null],
    [earlier, otherVisitor, "list_progress", "gallery", { pages: 5, reached_end: false }, null],
    [earlier, otherVisitor, "list_progress", "gallery", { pages: 9, reached_end: false }, null],
    [earlier, otherVisitor, "list_progress", "gallery", { pages: 10, reached_end: false }, null],
    [earlier, otherVisitor, "page_view", "gallery", { entry: true, support: "gallery" }, null],
    [earlier, otherVisitor, "fallback", "gallery", { reason: "legacy_browser" }, null],
    [earlier, otherVisitor, "page_leave", "gallery", { visible_ms: 3_000 }, null],
    [earlier, otherVisitor, "image_failures", "show", { count: 3 }, null],
    // Timing buckets on both sides of their bounds; a missing timing is left out.
    [earlier, otherVisitor, "perf", "show", { ttfb_ms: 199, fcp_ms: 999, lcp_ms: null }, null],
    [earlier, otherVisitor, "perf", "gallery", { ttfb_ms: 200, fcp_ms: 2_500, lcp_ms: 4_000 }, null]
  ] as const) {
    await pool.query(
      `INSERT INTO visit_event (occurred_at, visitor_id, session_id, event, page, embedded, referrer_host,
                                device, browser, browser_major, os, detail)
       VALUES (($1::date + time '12:00')::timestamp AT TIME ZONE $2, $3, $4, $5, $6, false, $7,
               'mobile', 'Safari', 18, 'iOS', $8)`,
      [day, timeZone, visitorId, session, event, page, referrer, JSON.stringify(detail)]
    );
  }
  // A rolled-up day with random API counts, so rollups and clearing cover them too.
  await pool.query(
    `INSERT INTO random_api_hourly
     VALUES (date_trunc('hour', ($1::date + time '12:00')::timestamp AT TIME ZONE $2), 'json', 'GET', 'success', true, 'images.example.test', 4, 6, 400, 150)`,
    [earlier, timeZone]
  );
  await pool.query(
    `INSERT INTO random_api_option_hourly
     VALUES (date_trunc('hour', ($1::date + time '12:00')::timestamp AT TIME ZONE $2), 'seed', 'used', 4)`,
    [earlier, timeZone]
  );
  // Drops are added up as they happen; the rollup of their day keeps them.
  await pool.query(
    `INSERT INTO analytics_daily VALUES ($1::date, 'collect_dropped', '{"reason": "buffer_full"}', 5, 0)`,
    [earlier]
  );
  // Heatmap cells use the local hour and Monday-first weekdays: seeded noon UTC
  // views fall at 17:30 in Kolkata, on the weekday of their date.
  process.env.TZ = "Asia/Kolkata";
  try {
    const seededDays = await analyticsReport("overview", { from: earlier, to: yesterday });
    const weekday = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
    const cell = (day: string, hour: number) =>
      seededDays.hours.find((entry) => entry.weekday === weekday(day) && entry.hour === hour)!.page_views;
    assert.deepEqual([cell(yesterday, 17), cell(earlier, 17), cell(yesterday, 12)], [2, 1, 0]);
  } finally {
    process.env.TZ = "UTC";
  }
  const range = { from: earlier, to: today };
  const sections = ["overview", "content", "sources", "random", "performance", "errors"] as const;
  // Recent visitors follow the clock, not the range; they are checked on their own below.
  const stableReport = async (section: (typeof sections)[number], request: Parameters<typeof analyticsReport>[1]) => {
    const result = await analyticsReport(section, request);
    return "recent_visitors" in result ? { ...result, recent_visitors: 0 } : result;
  };
  const live = await Promise.all(sections.map((section) => stableReport(section, range)));
  const overview = live[0] as Awaited<ReturnType<typeof analyticsReport<"overview">>>;
  assert.equal(overview.totals.page_views, 6);
  assert.equal(overview.totals.visitors, 2, "range visitors are distinct across days");
  assert.equal(overview.totals.visitors_daily_peak, 2);
  assert.deepEqual(
    overview.daily.map((day) => [day.day, day.page_views, day.visitors]),
    [[earlier, 1, 1], [yesterday, 2, 2], [today, 3, 1]]
  );
  const content = live[1] as Awaited<ReturnType<typeof analyticsReport<"content">>>;
  assert.deepEqual(content.controls, [{ control: "pause", count: 1 }]);
  assert.deepEqual(content.gallery_depth, {
    views: 6,
    pages: 33,
    reached_end: 1,
    distribution: [
      { pages: "1", count: 0 },
      { pages: "2", count: 1 },
      { pages: "3-4", count: 2 },
      { pages: "5-9", count: 2 },
      { pages: "10+", count: 1 }
    ]
  });
  assert.deepEqual(content.show, [{ mode: "cluster", starts: 2, switched: 1, duration_ms: 9_000 }]);
  // One new visitor today (collected) and one yesterday; sessions split by day.
  assert.equal(overview.totals.new_visitors, 2);
  assert.equal(overview.totals.visible_ms, 4_500);
  assert.deepEqual(overview.session_depth, [
    { pages: "1", sessions: 1 },
    { pages: "2", sessions: 1 },
    { pages: "3-4", sessions: 1 },
    { pages: "5+", sessions: 0 }
  ]);
  // Seeded views sit at local noon; the heatmap holds every view of the range.
  assert.equal(overview.hours.length, 7 * 24);
  assert.equal(overview.hours.reduce((sum, cell) => sum + cell.page_views, 0), overview.totals.page_views);
  assert.ok(overview.hours.filter((cell) => cell.hour === 12).reduce((sum, cell) => sum + cell.page_views, 0) >= 3);
  // Embedded views count for their host page and stay out of referrers.
  const sourcesLive = live[2] as Awaited<ReturnType<typeof analyticsReport<"sources">>>;
  assert.equal(overview.totals.embedded_page_views, 1);
  assert.deepEqual(
    [sourcesLive.embed.host, sourcesLive.embed.page_views, sourcesLive.embed.site_page_views, sourcesLive.embed.visitors],
    ["portal.example.test", 1, 6, 1]
  );
  assert.deepEqual(sourcesLive.referrers, [
    { host: "", page_views: 3 },
    { host: "search.example.test", page_views: 2 }
  ]);
  assert.deepEqual(sourcesLive.legacy_browsers, [{ browser: "Safari", major: 18, page_views: 1 }]);
  assert.deepEqual(sourcesLive.viewports, [
    { viewport: "0-599", page_views: 1 },
    { viewport: "600-1023", page_views: 1 },
    { viewport: "1024-1439", page_views: 0 },
    { viewport: "1440+", page_views: 2 }
  ]);
  assert.deepEqual(sourcesLive.color_schemes, [{ scheme: "light", page_views: 1 }, { scheme: "dark", page_views: 3 }]);
  assert.deepEqual(sourcesLive.reduced_motion, [{ reduced: false, page_views: 3 }, { reduced: true, page_views: 1 }]);
  const performanceLive = live[4] as Awaited<ReturnType<typeof analyticsReport<"performance">>>;
  assert.deepEqual(
    performanceLive.timings.filter((row) => row.count).map((row) => [row.timing, row.bucket, row.count]),
    [["ttfb", "0-200", 1], ["ttfb", "200-500", 1], ["fcp", "500-1000", 1], ["fcp", "2500-4000", 1], ["lcp", "4000+", 1]]
  );
  const errorsLive = live[5] as Awaited<ReturnType<typeof analyticsReport<"errors">>>;
  assert.deepEqual(errorsLive.image_failures, [{ page: "show", count: 3 }]);
  // One address over its window, and 20-event batches over the site cap.
  const dropped = new Map(errorsLive.collect_dropped.map((row) => [row.reason, row.count]));
  assert.equal(dropped.get("ip_rate_limited"), 1);
  assert.equal(dropped.get("buffer_full"), 5);
  assert.ok((dropped.get("site_capped") ?? 0) >= 20 && (dropped.get("site_capped") ?? 0) % 20 === 0);
  const earlierRandom = await analyticsReport("random", { from: earlier, to: earlier });
  assert.deepEqual(
    [earlierRandom.totals.duration_ms, earlierRandom.totals.duration_ms_max, earlierRandom.modes[0]!.duration_ms],
    [400, 150, 400]
  );
  assert.deepEqual(earlierRandom.options, [{ option: "seed", value: "used", requests: 4 }]);
  assert.ok(await rollupFinishedDays(signal) >= 2);
  assert.equal(await rollupFinishedDays(signal), 0, "rolled-up days are not rolled up again");
  assert.deepEqual(
    await Promise.all(sections.map((section) => stableReport(section, range))),
    live,
    "stored rollups report the same numbers as live computation"
  );
  assert.deepEqual(await stableReport("overview", { days: 3 }), overview);
  const todayOnly = await analyticsReport("overview", { from: today, to: today });
  assert.deepEqual(
    [todayOnly.previous.page_views, todayOnly.previous.visitors],
    [2, 2],
    "the previous period is the same length right before"
  );
  const hourly = await analyticsReport("random", { from: today, to: today });
  assert.equal(hourly.granularity, "hour");
  assert.ok(hourly.series.length >= 23, "empty hours stay on the time axis");
  assert.equal(
    hourly.series.reduce((sum, point) => sum + point.requests, 0),
    hourly.totals.requests
  );
  const beyondRaw = await analyticsReport("overview", {
    from: (await pool.query<{ day: string }>(
      "SELECT to_char((now() AT TIME ZONE $1)::date - 120, 'YYYY-MM-DD') AS day",
      [timeZone]
    )).rows[0]!.day,
    to: today
  });
  assert.equal(beyondRaw.totals.visitors, null, "distinct visitors need raw rows for the whole range");
  assert.equal(beyondRaw.totals.visitors_daily_peak, 2);

  // Recent visitors are those with a page view in the last five minutes.
  const recentBefore = (await analyticsReport("overview", { days: 1 })).recent_visitors;
  for (const [age, visitorId] of [
    ["1 minute", "00000000-0000-4000-8000-0000000000a3"],
    ["6 minutes", "00000000-0000-4000-8000-0000000000a4"]
  ] as const) {
    await pool.query(
      `INSERT INTO visit_event (occurred_at, visitor_id, session_id, event, page, embedded, device, browser, os, detail)
       VALUES (now() - $1::interval, $2, $3, 'page_view', 'home', false, 'desktop', 'Chrome', 'Windows', '{}')`,
      [age, visitorId, session]
    );
  }
  assert.equal((await analyticsReport("overview", { days: 1 })).recent_visitors, recentBefore + 1);
  await pool.query("DELETE FROM visit_event WHERE visitor_id IN ($1, $2)", [
    "00000000-0000-4000-8000-0000000000a3",
    "00000000-0000-4000-8000-0000000000a4"
  ]);

  // Raw rows leave after their tier's retention; daily rollups stay, also for
  // days already past it.
  const rolledUp = await stableReport("overview", { from: earlier, to: yesterday });
  const pastRetention = (await pool.query<{ day: string }>(
    "SELECT to_char((now() AT TIME ZONE $1)::date - 100, 'YYYY-MM-DD') AS day",
    [timeZone]
  )).rows[0]!.day;
  await pool.query(
    `INSERT INTO analytics_daily VALUES ($1::date, 'site', '{}', 5, 3), ($1::date, 'rollup', '{}', 1, 0)`,
    [pastRetention]
  );
  for (const [age, event] of [
    ["91 days", "page_view"],
    ["31 days", "control_use"],
    ["29 days", "sort_change"]
  ] as const) {
    await pool.query(
      `INSERT INTO visit_event (occurred_at, visitor_id, session_id, event, page, embedded, device, browser, os, detail)
       VALUES (now() - $1::interval, $2, $3, $4, 'gallery', false, 'desktop', 'Chrome', 'Windows', $5)`,
      [age, otherVisitor, session, event,
        JSON.stringify(event === "sort_change" ? { order: "oldest" } : event === "page_view" ? { entry: true, support: "full" } : { control: "pause" })]
    );
  }
  await pool.query(
    `INSERT INTO random_api_hourly VALUES (date_trunc('hour', now() - interval '91 days'), 'json', 'GET', 'success', false, '', 1, 1, 0, 0)`
  );
  await pool.query(
    `INSERT INTO random_api_option_hourly VALUES (date_trunc('hour', now() - interval '91 days'), 'seed', 'used', 1)`
  );
  await pool.query(
    `INSERT INTO visit_event (occurred_at, visitor_id, session_id, event, page, embedded, device, browser, os)
     VALUES (now() - interval '31 days', $1, $2, 'retired_event', 'gallery', false, 'desktop', 'Chrome', 'Windows')`,
    [otherVisitor, session]
  );
  await pruneExpiredAnalytics(signal);
  assert.deepEqual(
    (await pool.query<{ event: string }>(
      "SELECT event FROM visit_event WHERE occurred_at < now() - interval '28 days'"
    )).rows.map((row) => row.event),
    ["sort_change"],
    "events no longer collected expire with the interaction tier"
  );
  for (const table of ["random_api_hourly", "random_api_option_hourly"]) {
    assert.equal(
      Number((await pool.query(`SELECT count(*) FROM ${table} WHERE hour < now() - interval '90 days'`)).rows[0].count),
      0
    );
  }
  assert.deepEqual(await stableReport("overview", { from: earlier, to: yesterday }), rolledUp);
  assert.equal(
    (await analyticsReport("overview", { from: pastRetention, to: pastRetention })).totals.page_views,
    5
  );
  // A longer retention set afterwards cannot bring pruned rows back.
  const afterPruned = (await pool.query<{ day: string }>(
    "SELECT to_char(((now() - interval '90 days') AT TIME ZONE $1)::date + 1, 'YYYY-MM-DD') AS day",
    [timeZone]
  )).rows[0]!.day;
  await updateRuntimeConfig({ analytics: { visit_retention_days: 180 } });
  assert.equal((await analyticsReport("overview", { days: 3 })).range.raw_from, afterPruned);
  await pruneExpiredAnalytics(signal);
  assert.equal((await analyticsReport("overview", { days: 3 })).range.raw_from, afterPruned);

  // Reading needs analytics.view; clearing needs analytics.manage before the body is read.
  const admin = new Hono<{ Variables: { session: AdminSession } }>();
  admin.onError((error, context) => handleApiError(context, error));
  admin.use("/api/admin/*", async (context, next) => {
    const role = context.req.header("x-test-role");
    if (role === "super" || role === "image") {
      context.set("session", { id: "synthetic-analytics-session", username: "analytics-admin", role, csrf: "synthetic-analytics-csrf" });
    }
    await next();
  });
  admin.use("/api/admin/*", (context, next) => context.req.method === "GET"
    ? next() : requireAdminCsrf(context, next));
  admin.use("/api/admin/*", limitProtectedAdminRequestBody);
  registerAdminAnalyticsRoutes(admin as unknown as Hono);
  const adminRequest = (path: string, role: string, body?: string) =>
    admin.request(`http://admin.example.test/api/admin/analytics${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-test-role": role, "x-csrf-token": "synthetic-analytics-csrf" },
      ...(body === undefined ? {} : { body })
    });
  await expectStatus(await adminRequest("/overview?days=7", "image"), 200);
  await expectStatus(await adminRequest("/overview?days=7", ""), 403);
  await expectStatus(await adminRequest("/clear", "image", "{"), 403);
  await expectStatus(await adminRequest("/unknown?days=7", "super"), 400);
  await expectStatus(await adminRequest(`/overview?from=${today}&to=${earlier}`, "super"), 400);

  // Clearing runs under the longer retention, so a lost pruning record would
  // move the raw range back to 180 days.
  const count = async (sql: string) => Number((await pool.query(sql)).rows[0].count);
  const randomBefore = await analyticsReport("random", range);
  assert.ok(randomBefore.totals.requests > 0);
  assert.equal(
    randomBefore.totals.duration_ms_max,
    await count("SELECT max(duration_ms_max) AS count FROM random_api_hourly"),
    "the range's slowest call is the largest of the daily maxima"
  );
  // A report buffered before the clear is discarded with the scope.
  await expectStatus(await collect(report([pageView()]), { "X-Real-IP": "192.0.2.30" }), 204);
  await expectStatus(await adminRequest("/clear", "super", JSON.stringify({ scope: "visits" })), 200);
  await drainAnalyticsWriter();
  assert.equal(await count("SELECT count(*) FROM visit_event"), 0);
  const visitsCleared = await analyticsReport("overview", range);
  assert.equal(visitsCleared.totals.page_views, 0, "rolled-up days are cleared too");
  assert.equal(visitsCleared.range.raw_from, afterPruned, "clearing keeps what pruning removed");
  assert.deepEqual((await analyticsReport("errors", range)).collect_dropped, [], "drop counts belong to visits");
  assert.deepEqual(await analyticsReport("random", range), randomBefore, "clearing visits keeps random API counts");
  await expectStatus(await adminRequest("/clear", "super", JSON.stringify({ scope: "random" })), 200);
  assert.equal(await count("SELECT count(*) FROM random_api_hourly"), 0);
  assert.equal(await count("SELECT count(*) FROM random_api_option_hourly"), 0);
  assert.deepEqual(
    (await analyticsReport("random", range)).totals,
    { requests: 0, images: 0, trusted_requests: 0, rate_limited: 0, duration_ms: 0, duration_ms_max: 0 }
  );
  assert.equal((await analyticsReport("overview", range)).range.raw_from, afterPruned);
  await expectStatus(await adminRequest("/clear", "super", JSON.stringify({ scope: "all" })), 200);
  const retentionStart = (await pool.query<{ day: string }>(
    "SELECT to_char((now() AT TIME ZONE $1)::date - 179, 'YYYY-MM-DD') AS day",
    [timeZone]
  )).rows[0]!.day;
  assert.equal(
    (await analyticsReport("overview", range)).range.raw_from,
    retentionStart,
    "clearing everything also forgets pruning"
  );
  await updateRuntimeConfig({ analytics: { visit_retention_days: 90 } });
});
