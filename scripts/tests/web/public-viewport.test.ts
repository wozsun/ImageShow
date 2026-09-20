import "../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SiteHead } from "../../../packages/web/src/components/layout/SiteHead.tsx";
import { useEmbeddedSafeArea } from "../../../packages/web/src/hooks/useEmbeddedSafeArea.ts";
import { useAnchoredMenu } from "../../../packages/web/src/hooks/useAnchoredMenu.ts";
import { usePublicImageViewportControls } from "../../../packages/web/src/hooks/usePublicImageViewportControls.ts";
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
  function ImageControls() { usePublicImageViewportControls(); return null; }
  function Navigation() {
    navigate = useNavigate();
    const { pathname } = useLocation();
    return h.React.createElement(h.React.Fragment, null,
      h.React.createElement(SiteHead),
      /^\/(?:embed\/)?(?:gallery|show)\/?$/i.test(pathname)
        ? h.React.createElement(ImageControls) : null);
  }
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

test("[Web/公开视口] 原生安全区按订阅上报、合并变化，断开和重挂释放旧实例", async t => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const h = await createConfigStreamHarness(t, { animationFrame: {
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => { frames.delete(id); }
  } });
  const flushFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(0));
  };
  const messages: Array<{ data: Record<string, unknown>; origin: string }> = [];
  const parent = { postMessage: (data: Record<string, unknown>, origin: string) => messages.push({ data, origin }) };
  const native = { top: 23, right: 17, bottom: 31, left: 11 };
  const observers = new Set<{ notify: () => void; targets: Set<HTMLElement> }>();
  const restoreObserver = installProperties(globalThis, { ResizeObserver: class {
    targets = new Set<HTMLElement>();
    constructor(public notify: () => void) { observers.add(this); }
    observe(target: HTMLElement) {
      this.targets.add(target);
      // Model the environment's CSS dimensions; host custom properties do not affect env().
      const measure = (css: string) => native[css.match(/safe-area-inset-(top|right|bottom|left)/)?.[1] as keyof typeof native] ?? 0;
      target.getBoundingClientRect = () => ({
        width: measure(target.style.width), height: measure(target.style.height)
      }) as DOMRect;
    }
    disconnect() { observers.delete(this); }
  } });
  const visualViewport = new EventTarget();
  const restoreWindow = installProperties(h.window, { parent, innerWidth: 800, innerHeight: 600, visualViewport });
  const restoreDocument = installProperties(h.document, { fullscreenElement: null });
  t.after(() => { restoreObserver(); restoreWindow(); restoreDocument(); });
  function Bridge({ enabled }: { enabled: boolean }) { useEmbeddedSafeArea(enabled); return null; }
  const render = (enabled: boolean) => h.render(h.React.createElement(h.React.StrictMode, null,
    h.React.createElement(Bridge, { enabled })));
  await render(true);
  let ready = messages.at(-1)!.data;
  const send = (type: string, extra: Record<string, unknown> = {}, source: unknown = parent, origin = "https://host.example") => {
    h.window.dispatchEvent(Object.assign(new Event("message"), { source, origin,
      data: { ...ready, type, ...extra } }));
  };
  const reports = () => messages.filter(message => message.data.type === "native-insets");
  const bottom = () => h.document.documentElement.style.getPropertyValue("--embed-safe-area-bottom");
  assert.equal(observers.size, 0, "未订阅时没有测量资源");
  for (const extra of [{ version: 2 }, { channel: "other" }, { bridgeId: "stale" }]) send("connect", extra);
  send("connect", {}, {});
  send("connect", {}, parent, "null");
  assert.equal(observers.size, 0);
  send("connect");
  send("connect");
  assert.equal(observers.size, 1);
  assert.equal(frames.size, 1);
  assert.ok(!bottom(), "订阅本身不覆盖布局");
  flushFrames();
  assert.deepEqual(reports(), [{ origin: "https://host.example", data: {
    ...ready, type: "native-insets", insets: { ...native }, viewportWidth: 800, viewportHeight: 600, fullscreen: false
  } }]);

  send("insets", { insets: { top: 0, right: 48, bottom: 80, left: 48 } });
  assert.equal(bottom(), "80px");
  send("connect", {}, parent, "https://other.example");
  h.window.dispatchEvent(new Event("resize"));
  visualViewport.dispatchEvent(new Event("resize"));
  observers.forEach(observer => observer.notify());
  assert.equal(frames.size, 1);
  flushFrames();
  assert.equal(reports().length, 1, "宿主覆盖及重复几何事件不产生原生回传循环");
  native.bottom = 35;
  observers.forEach(observer => observer.notify());
  flushFrames();
  assert.deepEqual(reports().at(-1)!.data.insets, native);
  assert.equal(bottom(), "80px");

  const restoreSize = installProperties(h.window, { innerWidth: 600, innerHeight: 800 });
  h.window.dispatchEvent(new Event("resize"));
  flushFrames();
  assert.equal(reports().at(-1)!.data.viewportWidth, 600);
  assert.equal(reports().at(-1)!.data.viewportHeight, 800);
  const restoreFullscreen = installProperties(h.document, { fullscreenElement: h.document.body });
  h.document.dispatchEvent(new Event("fullscreenchange"));
  flushFrames();
  assert.equal(reports().at(-1)!.data.fullscreen, true);
  assert.ok(!bottom());
  restoreFullscreen();
  h.document.dispatchEvent(new Event("fullscreenchange"));
  flushFrames();
  assert.equal(reports().at(-1)!.data.fullscreen, false);
  assert.equal(bottom(), "80px");
  restoreSize();
  const count = reports().length;
  h.window.dispatchEvent(new Event("pageshow"));
  flushFrames();
  assert.equal(reports().length, count + 1);
  assert.equal(messages.at(-2)!.data.type, "ready");

  const probes = [...observers].flatMap(observer => [...observer.targets]);
  send("connect");
  send("disconnect");
  assert.equal(observers.size, 0);
  assert.equal(frames.size, 0);
  assert.ok(probes.every(probe => !probe.isConnected));
  assert.ok(!bottom());
  send("connect");
  flushFrames();
  assert.equal(reports().length, count + 2, "断开后可以重新订阅");
  const oldBridgeId = ready.bridgeId;
  h.window.dispatchEvent(new Event("resize"));
  await render(false);
  assert.equal(messages.at(-1)!.data.type, "disconnect");
  assert.equal(messages.at(-1)!.origin, "https://host.example");
  assert.equal(observers.size, 0);
  assert.equal(frames.size, 0);
  const detachedCount = messages.length;
  send("connect");
  h.window.dispatchEvent(new Event("pageshow"));
  visualViewport.dispatchEvent(new Event("resize"));
  assert.equal(messages.length, detachedCount);
  assert.equal(frames.size, 0);
  await render(true);
  ready = messages.at(-1)!.data;
  assert.notEqual(ready.bridgeId, oldBridgeId);
  send("connect", { bridgeId: oldBridgeId });
  assert.equal(observers.size, 0);
  send("connect");
  await render(false);
  assert.equal(observers.size, 0);
  assert.equal(frames.size, 0);
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
