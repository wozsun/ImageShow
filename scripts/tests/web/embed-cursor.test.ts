import "../support/web-environment.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { useEmbeddedCursorBridge } from "../../../packages/web/src/hooks/useEmbeddedCursorBridge.ts";
import { createConfigStreamHarness } from "../support/web-test-context.ts";
import { installProperties } from "../support/property-descriptors.ts";

const channel = "imageshow:embed-cursor";
const origin = "https://host.example";

async function createBridgeHarness(t: TestContext) {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const h = await createConfigStreamHarness(t, {
    animationFrame: {
      requestAnimationFrame: (callback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
      },
      cancelAnimationFrame: (id) => {
        frames.delete(id);
      }
    }
  });
  const messages: Array<{ data: Record<string, unknown>; target: string }> = [];
  const parent = {
    postMessage: (data: Record<string, unknown>, target: string) => messages.push({ data, target })
  };
  const pointer = Object.assign(new EventTarget(), { matches: true });
  const restoreWindow = installProperties(h.window, {
    parent,
    matchMedia: (query: string) => {
      assert.equal(query, "(pointer: fine)");
      return pointer;
    }
  });
  const restoreDocument = installProperties(h.document, {
    visibilityState: "visible",
    fullscreenElement: null
  });
  t.after(() => {
    restoreDocument();
    restoreWindow();
  });
  function Bridge({ enabled }: { enabled: boolean }) {
    useEmbeddedCursorBridge(enabled);
    return null;
  }
  const render = (enabled = true) =>
    h.render(
      h.React.createElement(h.React.StrictMode, null, h.React.createElement(Bridge, { enabled }))
    );
  const ready = () => messages.filter((message) => message.data.type === "ready").at(-1)!.data;
  const dispatch = (type: string, values: Record<string, unknown> = {}) => {
    const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), values);
    h.window.dispatchEvent(event);
    return event;
  };
  const command = (
    type: string,
    overrides: Record<string, unknown> = {},
    source: unknown = parent,
    senderOrigin = origin
  ) =>
    dispatch("message", { source, origin: senderOrigin, data: { ...ready(), type, ...overrides } });
  const mouse = (type: string, values: Record<string, unknown> = {}) =>
    dispatch(type, {
      pointerType: "mouse",
      isPrimary: true,
      clientX: 20,
      clientY: 30,
      button: -1,
      buttons: 0,
      relatedTarget: null,
      ...values
    });
  const flushFrame = () => {
    for (const [id, callback] of [...frames]) {
      frames.delete(id);
      callback(16);
    }
  };
  const active = () => h.document.documentElement.getAttribute("data-embed-cursor") === "host";
  const events = () =>
    messages.filter((message) => message.data.type === "pointer").map((message) => message.data);
  return {
    ...h,
    messages,
    parent,
    pointer,
    frames,
    render,
    ready,
    dispatch,
    command,
    mouse,
    flushFrame,
    active,
    events
  };
}

test("[Web/嵌入光标] 随嵌入启用，握手校验父窗口、来源、版本和实例，独立页面保持原生光标", async (t) => {
  const h = await createBridgeHarness(t);
  await h.render(false);
  assert.equal(h.messages.length, 0);
  await h.render();
  assert.equal(h.active(), false);
  assert.deepEqual(Object.keys(h.ready()).sort(), ["bridgeId", "channel", "type", "version"]);
  assert.equal(h.ready().channel, channel);
  h.mouse("pointermove");
  assert.deepEqual(h.events(), []);
  for (const [overrides, source, sender] of [
    [{}, {}, origin],
    [{}, h.parent, "null"],
    [{ version: 2 }, h.parent, origin],
    [{ channel: "unrelated" }, h.parent, origin],
    [{ bridgeId: "stale" }, h.parent, origin]
  ] as const) {
    h.command("connect", overrides, source, sender);
    assert.equal(h.active(), false);
  }
  h.command("hello");
  assert.equal(h.messages.at(-1)!.target, origin);
  h.command("connect");
  assert.equal(h.active(), true);
  assert.deepEqual(h.messages.at(-1)!.data, {
    ...h.ready(),
    type: "state",
    connected: true,
    active: true
  });
  h.command("disconnect", {}, h.parent, "https://other.example");
  assert.equal(h.active(), true, "连接后固定宿主来源");
  h.command("disconnect");
  assert.equal(h.active(), false);
  h.command("connect");
  await h.render(false);
  assert.equal(h.active(), false);
  const count = h.messages.length;
  h.command("connect");
  h.mouse("pointermove");
  assert.equal(h.messages.length, count, "停用后清理监听器");
  const restore = installProperties(h.window, { parent: h.window });
  try {
    await h.render();
    assert.equal(h.messages.length, count, "顶层打开不建立桥接");
  } finally {
    restore();
  }
});

test("[Web/嵌入光标] 转发 CSS 坐标与按键，合并移动且保留点击顺序，不拦截原生交互", async (t) => {
  const h = await createBridgeHarness(t);
  await h.render();
  h.command("connect");
  h.mouse("pointermove", { pointerType: "touch" });
  h.mouse("pointermove", { pointerType: "pen" });
  h.mouse("pointermove", { isPrimary: false });
  assert.deepEqual(h.events(), []);
  h.mouse("pointerover");
  h.mouse("pointermove", { clientX: 40 });
  h.mouse("pointermove", { clientX: 50 });
  assert.equal(h.frames.size, 1);
  assert.deepEqual(
    h.events().map((event) => event.phase),
    ["enter"]
  );
  const click = h.mouse("pointerdown", { clientX: 50, button: 0, buttons: 1 });
  assert.equal(click.defaultPrevented, false);
  assert.equal(h.frames.size, 0);
  assert.deepEqual(
    h.events().map((event) => event.phase),
    ["enter", "move", "down"]
  );
  assert.deepEqual(h.events()[1], {
    ...h.ready(),
    type: "pointer",
    phase: "move",
    x: 50,
    y: 30,
    button: -1,
    buttons: 0,
    viewportWidth: 1024,
    viewportHeight: 768
  });
  h.mouse("pointerup", { button: 0 });
  h.mouse("pointermove", { clientY: 80 });
  h.flushFrame();
  assert.equal(h.events().at(-1)!.y, 80);
  h.mouse("pointerout", { relatedTarget: h.document.body });
  assert.equal(h.events().at(-1)!.phase, "move", "元素之间移动不离开 iframe");
  h.mouse("pointermove", { clientX: -1 });
  assert.equal(h.events().at(-1)!.phase, "leave", "拖动捕获超出 iframe 时隐藏宿主光标");
  h.mouse("pointermove");
  assert.equal(h.events().at(-1)!.phase, "enter");
  h.mouse("pointercancel");
  assert.equal(h.events().at(-1)!.phase, "cancel");
  assert.ok(
    h.messages
      .filter((message) => message.data.type !== "ready")
      .every((message) => message.target === origin)
  );
});

test("[Web/嵌入光标] 全屏、隐藏、粗指针及卸载恢复原生光标，重新挂载拒绝旧实例", async (t) => {
  const h = await createBridgeHarness(t);
  await h.render();
  const firstId = h.ready().bridgeId;
  h.command("connect");
  h.mouse("pointermove");
  h.mouse("pointermove");
  h.dispatch("blur");
  assert.equal(h.frames.size, 0);
  assert.equal(h.events().at(-1)!.phase, "leave");
  for (const [target, property, inactive, restored, event] of [
    [h.document, "visibilityState", "hidden", "visible", "visibilitychange"],
    [h.document, "fullscreenElement", h.document.body, null, "fullscreenchange"],
    [h.pointer, "matches", false, true, "change"]
  ] as const) {
    h.mouse("pointermove");
    Reflect.set(target, property, inactive);
    target.dispatchEvent(new Event(event));
    assert.equal(h.active(), false);
    assert.equal(h.events().at(-1)!.phase, "leave");
    Reflect.set(target, property, restored);
    target.dispatchEvent(new Event(event));
    assert.equal(h.active(), true);
  }
  h.dispatch("pagehide");
  assert.equal(h.active(), false);
  h.dispatch("pageshow");
  assert.equal(h.active(), true);
  h.mouse("pointermove");
  h.mouse("pointermove");
  await h.render(false);
  assert.equal(h.frames.size, 0);
  assert.equal(h.active(), false);
  assert.equal(h.events().at(-1)!.phase, "leave");
  await h.render();
  assert.notEqual(h.ready().bridgeId, firstId);
  h.command("connect", { bridgeId: firstId });
  assert.equal(h.active(), false);
  h.command("connect");
  assert.equal(h.active(), true);
});
