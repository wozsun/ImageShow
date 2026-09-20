import "../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SiteHead } from "../../../packages/web/src/components/layout/SiteHead.tsx";
import { useEmbeddedSafeArea } from "../../../packages/web/src/hooks/useEmbeddedSafeArea.ts";
import { useAnchoredMenu } from "../../../packages/web/src/hooks/useAnchoredMenu.ts";
import { computeAnchoredPosition } from "../../../packages/web/src/lib/ui/menu-position.ts";
import { createConfigStreamHarness } from "../support/web-test-context.ts";
import { installProperties } from "../support/property-descriptors.ts";

test("[Web/公开视口] 直达、站内往返和后退保持唯一 viewport，后台与登录恢复默认", async t => {
  const h = await createConfigStreamHarness(t);
  const restore = installProperties(globalThis, { getComputedStyle: () => ({
    getPropertyValue: () => "", backgroundColor: "#000"
  }) });
  t.after(restore);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  t.after(() => client.clear());
  let navigate: NavigateFunction = () => {};
  function Navigation() { navigate = useNavigate(); return h.React.createElement(SiteHead); }
  const mount = (path: string) => h.render(h.React.createElement(QueryClientProvider, { client },
    h.React.createElement(MemoryRouter, { key: path, initialEntries: [path] },
      h.React.createElement(Navigation))));
  const check = (immersive: boolean) => {
    const metas = h.document.querySelectorAll('meta[name="viewport"]');
    assert.equal(metas.length, 1);
    assert.equal(metas[0].getAttribute("content"), "width=device-width, initial-scale=1.0"
      + (immersive ? ", viewport-fit=cover" : ""));
    assert.equal(h.document.documentElement.hasAttribute("data-public-viewport"), immersive);
  };
  for (const path of ["/", "/home", "/gallery/", "/SHOW", "/embed/home", "/embed/gallery", "/embed/show"]) {
    await mount(path);
    check(true);
  }
  await h.React.act(async () => { await navigate("/admin/login"); });
  check(false);
  await h.React.act(async () => { await navigate(-1); });
  check(true);
  for (const path of ["/admin", "/admin/login", "/admin/images"]) {
    await mount(path);
    check(false);
  }
});

test("[Web/公开视口] 嵌入安全区校验父窗口、实例、来源和尺寸，全屏及卸载恢复原生值", async t => {
  const h = await createConfigStreamHarness(t);
  const messages: Array<Record<string, unknown>> = [];
  const parent = { postMessage: (data: Record<string, unknown>) => messages.push(data) };
  const restoreWindow = installProperties(h.window, { parent, innerWidth: 800, innerHeight: 600 });
  const restoreDocument = installProperties(h.document, { fullscreenElement: null });
  // HTTP 内网没有 SecureContext-only randomUUID，嵌入仍须正常工作。
  const restoreCrypto = installProperties(globalThis, { crypto: {
    getRandomValues: crypto.getRandomValues.bind(crypto)
  } });
  t.after(() => { restoreWindow(); restoreDocument(); restoreCrypto(); });
  function Bridge({ enabled }: { enabled: boolean }) { useEmbeddedSafeArea(enabled); return null; }
  const render = (enabled: boolean) => h.render(h.React.createElement(h.React.StrictMode, null,
    h.React.createElement(Bridge, { enabled })));
  await render(false);
  assert.equal(messages.length, 0);
  await render(true);
  const ready = messages.at(-1)!;
  const insets = { top: 0, right: 48, bottom: 34, left: 48 };
  const send = (data: Record<string, unknown>, source: unknown = parent, origin = "https://host.example") => {
    h.window.dispatchEvent(Object.assign(new Event("message"), {
      source, origin, data: { ...ready, type: "insets", insets, ...data }
    }));
  };
  const bottom = () => h.document.documentElement.style.getPropertyValue("--embed-safe-area-bottom");
  for (const invalid of [{ version: 2 }, { bridgeId: "stale" }, { insets: { ...insets, bottom: -1 } },
    { insets: { ...insets, bottom: Infinity } }, { insets: { ...insets, top: 301 } }, { insets: {} }]) {
    send(invalid);
    assert.ok(!bottom());
  }
  send({}, {});
  send({}, parent, "null");
  assert.ok(!bottom());
  send({});
  assert.equal(bottom(), "34px");
  assert.equal(h.document.documentElement.style.getPropertyValue("--embed-safe-area-top"), "0px");
  send({ insets: { ...insets, bottom: 20 } }, parent, "https://other.example");
  assert.equal(bottom(), "34px");
  const restoreFullscreen = installProperties(h.document, { fullscreenElement: h.document.body });
  h.document.dispatchEvent(new Event("fullscreenchange"));
  assert.ok(!bottom());
  restoreFullscreen();
  h.document.dispatchEvent(new Event("fullscreenchange"));
  assert.equal(bottom(), "34px");
  send({ type: "disconnect" });
  assert.ok(!bottom());
  send({});
  await render(false);
  assert.ok(!bottom());
  send({});
  assert.ok(!bottom(), "卸载后不再接受旧消息");
  restoreWindow();
  const restoreStandalone = installProperties(h.window, { parent: h.window });
  const count = messages.length;
  await render(true);
  assert.equal(messages.length, count);
  restoreStandalone();
});

test("[Web/公开视口] 菜单在公开页安全边界内定位，后台保留现有可视视口边界", async t => {
  const h = await createConfigStreamHarness(t);
  const restoreWindow = installProperties(h.window, { innerWidth: 800, innerHeight: 600, visualViewport: null });
  const restoreStyle = installProperties(globalThis, { getComputedStyle: () => ({ getPropertyValue: (name: string) =>
    name.endsWith("left") || name.endsWith("right") ? "48px" : "34px" }) });
  t.after(() => { restoreWindow(); restoreStyle(); });
  const rect = { left: 0, right: 40, top: 60, bottom: 90, width: 40 } as DOMRect;
  const size = { minWidth: 900, maxHeight: 600, flipThreshold: 100, minAvailable: 100 };
  const plain = computeAnchoredPosition(rect, size);
  assert.equal(plain.style.left, 8);
  assert.equal(plain.style.width, 784);
  h.document.documentElement.setAttribute("data-public-viewport", "");
  const safe = computeAnchoredPosition(rect, size);
  assert.equal(safe.style.left, 56);
  assert.equal(safe.style.width, 688);
  assert.equal(safe.style.maxHeight, 462);
});

test("[Web/公开视口] 已打开菜单随安全区单独变化重排，关闭后释放观察资源", async t => {
  const h = await createConfigStreamHarness(t);
  let bottom = 0;
  const observers = new Set<{ notify: () => void; targets: Set<Element> }>();
  const restore = installProperties(globalThis, {
    getComputedStyle: () => ({ getPropertyValue: (name: string) => name.endsWith("bottom") ? `${bottom}px` : "0px" }),
    ResizeObserver: class {
      targets = new Set<Element>();
      constructor(public notify: () => void) { observers.add(this); }
      observe(target: Element) { this.targets.add(target); }
      unobserve(target: Element) { this.targets.delete(target); }
      disconnect() { observers.delete(this); }
    }
  });
  const restoreWindow = installProperties(h.window, { innerWidth: 844, innerHeight: 400, visualViewport: null });
  t.after(() => { restore(); restoreWindow(); });
  h.document.documentElement.setAttribute("data-public-viewport", "");
  let menu: ReturnType<typeof useAnchoredMenu> | undefined;
  const anchor = h.document.createElement("button");
  anchor.getBoundingClientRect = () => ({ left: 40, right: 140, width: 100, top: 70, bottom: 114 }) as DOMRect;
  const triggerRef = { current: anchor };
  function Menu() {
    menu = useAnchoredMenu({ triggerRef, initialMaxHeight: 420, animateClose: false,
      getSize: () => ({ minWidth: 300, maxHeight: 420, flipThreshold: 80, minAvailable: 80 }) });
    return null;
  }
  await h.render(h.React.createElement(Menu));
  await h.React.act(async () => menu!.openMenu());
  assert.equal(menu!.position.maxHeight, 272);
  const observed = [...observers].flatMap(observer => [...observer.targets]);
  const probes = observed.filter(element => element !== anchor);
  assert.ok(probes.length > 0);
  bottom = 150;
  await h.React.act(async () => {
    observers.forEach(observer => observer.notify());
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  assert.equal(menu!.position.maxHeight, 122);
  await h.React.act(async () => menu!.requestClose());
  assert.equal(observers.size, 0);
  assert.ok(probes.every(probe => !probe.isConnected));
});
