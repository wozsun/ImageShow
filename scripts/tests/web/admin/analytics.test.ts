import "../../support/web-environment.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { appConfig } from "../../../../packages/shared/src/app-config.ts";
import { adminPermissions, type AdminPermission } from "../../../../packages/shared/src/browser.ts";
import { queryKeys } from "../../../../packages/web/src/lib/api/query-keys.ts";
import { AuthSessionProvider } from "../../../../packages/web/src/hooks/useAuthSession.tsx";
import { createPublicRouteModuleLoader, createPublicRoutePreloadIntents, PublicRoutePreloadProvider } from "../../../../packages/web/src/lib/public-route-modules.ts";
import { createConfigStreamHarness } from "../../support/web-test-context.ts";
import { installProperties } from "../../support/property-descriptors.ts";
import { settleReactUntil } from "../../support/polling.ts";
import { dispatchDomEvent } from "../../support/dom-events.ts";

async function mountGallery(t: TestContext, analyticsEnabled: boolean) {
  const { GalleryPage } = await import("../../../../packages/web/src/pages/gallery/GalleryPage.tsx");
  const h = await createConfigStreamHarness(t);
  t.after(installProperties(h.window, {
    location: new URL("https://img.example/gallery"),
    scrollX: 0,
    scrollY: 0,
    scrollTo() {},
    getComputedStyle: () => ({ paddingLeft: "0px", paddingRight: "0px", getPropertyValue: () => "16px" })
  }));
  t.after(installProperties(HTMLElement.prototype, { clientWidth: 1024 }));
  const reports: { event: string; page: string }[] = [];
  t.after(installProperties(globalThis.navigator, {
    sendBeacon(path: string, body: Blob) {
      assert.equal(path, "/api/collect");
      void body.text().then((text) => reports.push(...JSON.parse(text).events));
      return true;
    }
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  t.after(() => client.clear());
  client.setQueryData(queryKeys.galleryFacets, { themes: [], tags: [], authors: [] });
  client.setQueryData(queryKeys.siteConfig, {
    site: appConfig.runtimeDefaults.site,
    embed: { enabled: false },
    analytics: { enabled: analyticsEnabled, home_visitors: false }
  });
  client.setQueryData(queryKeys.me, { authenticated: false });
  const loader = createPublicRouteModuleLoader(async () => ({}));
  const intents = createPublicRoutePreloadIntents(loader, loader, loader);
  await h.render(h.React.createElement(QueryClientProvider, { client },
    h.React.createElement(MemoryRouter, { initialEntries: ["/gallery?order=oldest"] },
      h.React.createElement(AuthSessionProvider, null,
        h.React.createElement(PublicRoutePreloadProvider, {
          intents,
          children: h.React.createElement(GalleryPage, { embedded: false, order: "latest" })
        })))));
  return { ...h, reports };
}

test("[Web/统计] 公开页面只在站点开启统计时上报访问", async (t) => {
  // Enabled first: the collector is loaded and leaving a page sends at once,
  // so a gate that failed in the disabled case would show up as a report.
  await t.test("开启", async (t) => {
    const h = await mountGallery(t, true);
    // A hidden page sends what is queued at once instead of after the idle wait.
    t.after(installProperties(globalThis.document, { visibilityState: "hidden" }));
    await settleReactUntil(
      () => {
        globalThis.document.dispatchEvent(new Event("visibilitychange"));
        return h.reports.some((report) => report.event === "page_view");
      },
      "the page view is reported",
      { turns: 200, delayMs: 20 }
    );
    await h.React.act(async () => h.root.unmount());
    await settleReactUntil(
      () => h.reports.some((report) => report.event === "page_leave"),
      "leaving the page reports at once"
    );
    const events = h.reports.map((report) => [report.event, report.page]);
    assert.deepEqual(events[0], ["page_view", "gallery"]);
    assert.deepEqual(events.at(-1), ["page_leave", "gallery"]);
  });
  await t.test("统计关闭", async (t) => {
    const h = await mountGallery(t, false);
    await h.flush();
    await h.React.act(async () => h.root.unmount());
    await h.flush();
    assert.deepEqual(h.reports, [], "no report leaves the page");
  });
});

test("[Web/统计] 图片管理员看得到统计页，清空只在检查页经三次确认后提交所选范围", async (t) => {
  const { adminNavigationForPermissions } =
    await import("../../../../packages/web/src/pages/admin/shell/AdminNavigation.tsx");
  const { adminRoutesFor } = await import("../../../../packages/web/src/pages/admin/shell/admin-route-modules.ts");
  const analyticsLinked = (permissions: readonly AdminPermission[]) =>
    adminNavigationForPermissions("image", permissions).main.some((entry) =>
      entry.kind === "link" && entry.to === "/admin/analytics");
  assert.equal(analyticsLinked([adminPermissions.analyticsView]), true);
  assert.equal(adminRoutesFor([adminPermissions.analyticsView]).some((route) => route.path === "analytics"), true);

  const { CheckAnalyticsClearAction } =
    await import("../../../../packages/web/src/pages/admin/check/CheckMaintenanceCapability.tsx");
  const h = await createConfigStreamHarness(t);
  t.after(installProperties(h.window, { scrollX: 0, scrollY: 0, scrollTo() {} }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  t.after(() => client.clear());
  client.setQueryData([...queryKeys.analytics, "overview", "days=7"], { cached: true });
  await h.render(h.React.createElement(QueryClientProvider, { client },
    h.React.createElement(CheckAnalyticsClearAction, { running: "" })));
  const button = (label: string) => {
    const match = [...h.document.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(label));
    assert.ok(match, label);
    return match as HTMLButtonElement;
  };
  const click = async (target: Element) => {
    await h.React.act(async () => { (target as HTMLElement).click(); });
    await h.flush();
  };
  await click(button("清空统计"));
  const form = () => h.document.querySelector<HTMLFormElement>(".confirm-dialog form");
  assert.ok(form(), "the first step only opens the dialog");
  const scope = [...form()!.querySelectorAll<HTMLInputElement>("input[type=radio]")]
    .find((input) => input.value === "all");
  assert.ok(scope);
  scope.checked = true;
  await click(scope);
  const confirm = () => form()!.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const submit = async () => {
    await h.React.act(async () => { dispatchDomEvent(h.window, form()!, "submit"); });
    await h.flush();
  };
  await submit();
  assert.equal(confirm().getAttribute("aria-pressed"), "true");
  assert.equal(h.pending.length, 0, "the second step only arms the confirmation");
  await submit();
  assert.equal(h.pending.length, 1);
  assert.equal(h.pending[0]!.path, "/api/admin/analytics/clear");
  assert.deepEqual(JSON.parse(String(h.pending[0]!.body)), { scope: "all" });
  await h.respond(0, { ok: true });
  await h.React.act(async () => {
    dispatchDomEvent(h.window, h.document.querySelector(".confirm-dialog")!, "animationend");
  });
  await settleReactUntil(() => !h.document.querySelector(".confirm-dialog"), "dialog closes after clearing");
  assert.equal(
    client.getQueryState([...queryKeys.analytics, "overview", "days=7"])?.isInvalidated,
    true,
    "cleared statistics are read again"
  );
});

test("[Web/统计] 统计页按服务端日界以天数请求时间范围，切换类别保留所选范围", async (t) => {
  const { AnalyticsPage } = await import("../../../../packages/web/src/pages/admin/analytics/AnalyticsPage.tsx");
  const h = await createConfigStreamHarness(t);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  t.after(() => client.clear());
  await h.render(h.React.createElement(QueryClientProvider, { client },
    h.React.createElement(MemoryRouter, null, h.React.createElement(AnalyticsPage))));
  assert.equal(h.pending.at(-1)!.path, "/api/admin/analytics/overview?days=7");
  const click = async (label: string) => {
    const target = [...h.document.querySelectorAll("button")].find((button) => button.textContent === label);
    assert.ok(target, label);
    await h.React.act(async () => { target.click(); });
    await h.flush();
  };
  await click("1 年");
  assert.equal(h.pending.at(-1)!.path, "/api/admin/analytics/overview?days=365");
  await click("随机 API");
  assert.equal(h.pending.at(-1)!.path, "/api/admin/analytics/random?days=365");
});
