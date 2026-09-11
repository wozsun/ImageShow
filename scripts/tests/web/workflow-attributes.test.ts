import "../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { IngestionQueueActionResultDto, IngestionSessionPairDto } from "../../../packages/shared/src/browser.ts";
import { ingestionActionPath } from "../../../packages/shared/src/browser.ts";
import { clearCsrfToken, setCsrfToken } from "../../../packages/web/src/lib/api/client.ts";
import { imageAttributeClearPatch, mergeCommonImageAttributes, type ClearableImageAttribute, type ImageAttributeClearPlan } from "../../../packages/web/src/lib/image-draft.ts";
import { reduceIngestionQueue } from "../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-queue-state.ts";
import { createConfigStreamHarness, ingestionJob } from "../support/web-test-context.ts";
import { dispatchDomEvent } from "../support/dom-events.ts";
import { installProperties, installPropertyDescriptors } from "../support/property-descriptors.ts";

test("[Web/批量属性] 显式清空只更新指定分类，普通应用保留空输入并追加去重标签", () => {
  const draft = ingestionJob().draft;
  const cases = {
    theme: { ...draft, theme: null },
    tags: { ...draft, tags: [] },
    author: { ...draft, author: "" },
    all: { ...draft, theme: null, tags: [], author: "" }
  };
  for (const field of Object.keys(cases) as ClearableImageAttribute[]) {
    const jobs = [
      ingestionJob({ id: "selected", status: "ready" }),
      ingestionJob({ id: "retry", attemptKey: "new-attempt" }),
      ingestionJob({ id: "new" }),
      ingestionJob({ id: "committing", status: "committing" }),
      ingestionJob({ id: "done", status: "done" }),
      ingestionJob({ id: "cancel-failed", status: "failed", failureStage: "cancel" }),
      ingestionJob({ id: "commit-failed", status: "failed", failureStage: "commit" })
    ];
    const result = reduceIngestionQueue({ jobs, page: 1 }, {
      type: "clear-attribute", field,
      attempts: new Map(jobs.filter((job) => job.id !== "new").map((job) => [job.id, "attempt-1"]))
    });
    assert.deepEqual(result.jobs[0]!.draft, cases[field]);
    assert.deepEqual(result.jobs.slice(1), jobs.slice(1), "新任务、新尝试及不可编辑状态均保留");
    assert.deepEqual({ ...draft, ...imageAttributeClearPatch(field) }, cases[field]);
  }
  const empty = { device: "", brightness: "", theme: "  ", author: "", tags: [] } as const;
  assert.deepEqual(mergeCommonImageAttributes(draft, { ...empty, tags: [] }), draft);
  assert.deepEqual(mergeCommonImageAttributes(draft, {
    ...empty, theme: "new-theme", tags: [draft.tags[0]!, "new-tag", "new-tag"]
  }), { ...draft, theme: "new-theme", tags: [...draft.tags, "new-tag"] });
});

test("[Web/批量属性] 确认期间的本地接管按原身份清空，已覆盖任务与重试实例不扩大范围", async (t) => {
  const harness = await createConfigStreamHarness(t);
  const { React } = harness;
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { useIngestionQueue } = await import("../../../packages/web/src/pages/admin/ingestion/queue/useIngestionQueue.ts");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  t.after(() => client.clear());
  let queue!: ReturnType<typeof useIngestionQueue>;
  function Probe() {
    queue = useIngestionQueue(20, "upload", false);
    return null;
  }
  await harness.render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  const jobs = ["local", "handoff", "covered", "retry", "removed", "signed", "signing", "signed-handoff"].map((id, batchPosition) => (
    ingestionJob({ id, kind: "upload", batchPosition })
  ));
  for (const [index, id] of ["signed", "signed-handoff"].entries()) {
    Object.assign(jobs.find((job) => job.id === id)!, {
      status: "uploading", sessionId: "I".repeat(43), serverAccepted: false,
      imageId: `01900000-0000-7000-8000-${String(index + 10).padStart(12, "0")}`
    });
  }
  await React.act(async () => { queue.appendJobs(jobs); });
  const capture = queue.captureLocalAttributeClear("all", 10);
  t.after(capture.dispose);
  await React.act(async () => {
    queue.appendJobs([ingestionJob({ id: "later", batchPosition: 8 })]);
    queue.updateJob("retry", { attemptKey: "retry-2" });
    queue.clearJobIds(new Set(["removed"]));
    queue.updateJob("signing", {
      status: "uploading", sessionId: "J".repeat(43), imageId: "01900000-0000-7000-8000-000000000012"
    });
    queue.bindServerJob("handoff", { sessionId: "H".repeat(43), imageId: "01900000-0000-7000-8000-000000000001", serverAccepted: true }, undefined, 11);
    queue.bindServerJob("covered", { sessionId: "C".repeat(43), imageId: "01900000-0000-7000-8000-000000000002", serverAccepted: true }, undefined, 10);
    queue.bindServerJob("signed-handoff", { sessionId: "I".repeat(43), imageId: "01900000-0000-7000-8000-000000000099", serverAccepted: true }, undefined, 12);
  });
  let pairs!: IngestionSessionPairDto[];
  await React.act(async () => { pairs = capture.apply(); });
  assert.deepEqual(pairs, [
    { session_id: "H".repeat(43), image_id: "01900000-0000-7000-8000-000000000001" },
    { session_id: "I".repeat(43), image_id: "01900000-0000-7000-8000-000000000099" }
  ]);
  for (const id of ["local", "signed", "signing"]) {
    const current = queue.jobsRef.current.find((job) => job.id === id)!;
    assert.deepEqual(current.draft, { ...jobs[0]!.draft, theme: null, tags: [], author: "" });
    assert.equal(current.serverDraftPending, true, "尚未接管的上传在原草稿 owner 中保留待同步修改");
  }
  for (const id of ["retry", "later"]) {
    assert.deepEqual(queue.jobsRef.current.find((job) => job.id === id)!.draft, jobs[0]!.draft);
  }
  assert.equal(harness.pending.length, 0, "本地身份捕获不额外查询或提交队列");
});

test("[Web/批量属性] 清空冻结水位，部分失败只重试失败身份，未知响应复用请求号", async (t) => {
  const harness = await createConfigStreamHarness(t);
  const { React } = harness;
  const { useIngestionQueueActions } = await import("../../../packages/web/src/pages/admin/ingestion/queue/useIngestionQueueActions.ts");
  const { useIngestionQueueSubmitActions } = await import("../../../packages/web/src/pages/admin/ingestion/workflow/useIngestionQueueSubmitActions.ts");
  const server = {
    status: "ready", actionScope: "A".repeat(32), actionWatermark: "original-watermark",
    connectionGeneration: 1, lastAcceptedOrder: 10,
    summary: { unfinished: 2, committing: 0, resolving: 0 },
    refresh() {}, recoverAuthority: async () => {}
  };
  const hold = { current: false };
  let localApplies = 0;
  let disposals = 0;
  let flushes = 0;
  const handoff = { session_id: "H".repeat(43), image_id: "01900000-0000-7000-8000-000000000001" };
  const failed = { session_id: "F".repeat(43), image_id: "01900000-0000-7000-8000-000000000002" };
  const succeeded = { session_id: "S".repeat(43), image_id: "01900000-0000-7000-8000-000000000003" };
  let workflow!: ReturnType<typeof useIngestionQueueSubmitActions>;
  function Probe() {
    const actions = useIngestionQueueActions("upload", server as never, hold, () => {});
    workflow = useIngestionQueueSubmitActions({
      queue: {
        actions, server, uncommittedCount: 3,
        flushPendingUpdates: async () => { flushes += 1; },
        captureLocalAttributeClear: (field: ClearableImageAttribute, order: number) => {
          assert.equal(field, "all");
          assert.equal(order, 10);
          return { dispose: () => { disposals += 1; }, apply: () => { localApplies += 1; return [handoff]; } };
        }
      } as never,
      defaults: { device: "auto", brightness: "auto", theme: "", author: "", tags: [] },
      commitJobs: async () => false, onDone() {}, captureServerAction: () => ({ required: false, frozen: null })
    });
    return null;
  }
  setCsrfToken("clear-attributes-test");
  t.after(clearCsrfToken);
  await harness.render(React.createElement(Probe));
  const plan = workflow.prepareAttributeClear("all");
  assert.ok(plan);
  assert.equal(plan.count, 3);
  server.actionWatermark = "newer-watermark";
  await harness.render(React.createElement(Probe));
  const begin = async () => {
    let outcome!: Promise<unknown>;
    await React.act(async () => { outcome = plan.apply().then(() => null, (error: unknown) => error); });
    await harness.flush();
    return { outcome };
  };
  const body = (index: number) => {
    assert.equal(harness.pending[index]!.path, ingestionActionPath);
    return JSON.parse(String(harness.pending[index]!.body));
  };
  const response = (items: IngestionQueueActionResultDto["items"]) => ({
    ok: true, items, processed: items.length,
    changed: items.filter((item) => item.status === "changed").length,
    failed: items.filter((item) => item.status === "failed").length
  });
  const first = await begin();
  assert.equal(body(0).action_watermark, "original-watermark");
  assert.equal(body(0).items, undefined);
  assert.deepEqual(body(0).metadata, { theme: null, tags: [], author: "" });
  await harness.respond(0, response([
    { ...succeeded, status: "changed" }, { ...failed, status: "failed", message: "暂时失败" }
  ]));
  assert.match(String(await first.outcome), /1 个任务清空失败/);
  const retry = await begin();
  assert.deepEqual(body(1).items, [failed]);
  assert.notEqual(body(1).action_request_id, body(0).action_request_id);
  assert.equal(body(1).action_watermark, "newer-watermark");
  await harness.respond(1, response([{ ...failed, status: "changed" }]));
  assert.deepEqual(body(2).items, [handoff]);
  await harness.respond(2, response([{ ...handoff, status: "changed" }]));
  assert.equal(await retry.outcome, null);
  assert.equal(localApplies, 1);
  assert.equal(flushes, 3);
  assert.equal(hold.current, false);
  plan.dispose?.();
  assert.ok(disposals > 0);
  await assert.rejects(plan.apply(), /清空范围已失效/);

  const uncertain = workflow.prepareAttributeClear("all")!;
  let uncertainResult!: Promise<unknown>;
  await React.act(async () => { uncertainResult = uncertain.apply().catch((error: unknown) => error); });
  await harness.flush();
  const failure = { ok: false, error: { code: "temporary_failure", message: "response lost" } };
  await harness.respond(3, failure, 503);
  await harness.respond(4, failure, 503);
  assert.match(String(await uncertainResult), /结果尚未确认/);
  let resumed!: Promise<void>;
  await React.act(async () => { resumed = uncertain.apply(); });
  await harness.flush();
  assert.deepEqual(body(4), body(3));
  assert.deepEqual(body(5), body(3), "人工重试仍重放原请求而非重新选择整个队列");
  await harness.respond(5, response([]));
  await harness.respond(6, response([]));
  await resumed;
  uncertain.dispose?.();

  const stale = workflow.prepareAttributeClear("all")!;
  server.connectionGeneration += 1;
  await harness.render(React.createElement(Probe));
  await React.act(async () => { await assert.rejects(stale.apply(), /队列连接已变化/); });
  assert.equal(harness.pending.length, 7);
  stale.dispose?.();
});

for (const failure of [
  { label: "服务端错误", status: 503, body: '{"ok":false,"code":"response_lost","error":"response lost"}' },
  { label: "成功正文损坏", status: 200, body: '{"items":' }
]) {
  test(`[Web/批量属性] 后续页${failure.label}时续传原游标，保留此前逐项结果且不重复通知`, async (t) => {
    const harness = await createConfigStreamHarness(t);
    const { React } = harness;
    const { useIngestionQueueActions } = await import("../../../packages/web/src/pages/admin/ingestion/queue/useIngestionQueueActions.ts");
    const server = {
      status: "ready", actionScope: "P".repeat(32), actionWatermark: "frozen-pages", connectionGeneration: 1,
      recoverAuthority: async () => {}
    };
    const hold = { current: false };
    let actions!: ReturnType<typeof useIngestionQueueActions>;
    function Probe() { actions = useIngestionQueueActions("upload", server as never, hold, () => {}); return null; }
    setCsrfToken("paged-clear-test");
    t.after(clearCsrfToken);
    await harness.render(React.createElement(Probe));
    const frozen = actions.freeze("apply_metadata", { theme: null, tags: [], author: "" })!;
    const notifications: string[] = [];
    const options = { onBatchResult: (result: IngestionQueueActionResultDto) => notifications.push(...result.items.map((item) => item.session_id)) };
    let initial!: ReturnType<typeof actions.run>;
    await React.act(async () => { initial = actions.run(frozen, undefined, options); });
    await harness.flush();
    const knownFailure = { session_id: "F".repeat(43), image_id: "01900000-0000-7000-8000-000000000001", status: "failed" as const, message: "retry this identity" };
    await harness.respond(0, { ok: true, processed: 1, changed: 0, failed: 1, items: [knownFailure], continuation: "page-2" });
    const respondUnknown = async (index: number) => {
      await React.act(async () => {
        harness.pending[index]!.resolve(new Response(failure.body, { status: failure.status }));
      });
      await harness.flush();
    };
    await respondUnknown(1);
    assert.equal(harness.pending.length, 3, "结果未知时先自动重试原页一次");
    await respondUnknown(2);
    assert.equal(await initial, null);
    const body = (index: number) => JSON.parse(String(harness.pending[index]!.body));
    assert.equal(body(1).continuation, "page-2");
    assert.deepEqual(body(2), body(1));
    let resumed!: ReturnType<typeof actions.run>;
    await React.act(async () => { resumed = actions.run(frozen, undefined, options); });
    await harness.flush();
    assert.deepEqual(body(3), body(1), "人工重试必须从服务端最后可重放的页继续");
    const second = { session_id: "S".repeat(43), image_id: "01900000-0000-7000-8000-000000000002", status: "changed" as const };
    const third = { session_id: "T".repeat(43), image_id: "01900000-0000-7000-8000-000000000003", status: "changed" as const };
    await harness.respond(3, { ok: true, processed: 1, changed: 1, failed: 0, items: [second], continuation: "page-3" });
    assert.equal(body(4).continuation, "page-3");
    assert.equal(body(4).action_request_id, body(0).action_request_id);
    await harness.respond(4, { ok: true, processed: 1, changed: 1, failed: 0, items: [third] });
    assert.deepEqual(await resumed, { processed: 3, changed: 2, failed: 1, items: [knownFailure, second, third] });
    assert.deepEqual(notifications, [knownFailure.session_id, second.session_id, third.session_id]);
    assert.equal(hold.current, false);
  });
}

test("[Web/批量属性] 移动浮层拥有菜单与确认框，按层关闭且确认不触发父表单保存", async (t) => {
  const { registerHooks } = await import("node:module");
  const cssHooks = registerHooks({
    load(url, context, nextLoad) {
      return url.endsWith(".css")
        ? { format: "module", source: "export {};", shortCircuit: true }
        : nextLoad(url, context);
    }
  });
  t.after(() => cssHooks.deregister());
  let harness!: Awaited<ReturnType<typeof createConfigStreamHarness>>;
  const restorers: Array<() => void> = [];
  t.after(async () => {
    try {
      await harness.render(null);
      await harness.flush();
      await harness.flush();
    } finally {
      for (const restore of restorers.reverse()) restore();
    }
  });
  harness = await createConfigStreamHarness(t);
  const { React, window, document } = harness;
  const { WorkflowAttributeActions } = await import("../../../packages/web/src/components/form/WorkflowAttributeActions.tsx");
  const { WorkflowCollapsePanel } = await import("../../../packages/web/src/components/layout/WorkflowCollapsePanel.tsx");
  const { DialogFrame } = await import("../../../packages/web/src/components/feedback/DialogFrame.tsx");
  let activeElement = document.body as HTMLElement;
  // linkedom dispatches every listener in registration order. Restore the
  // document keydown capture phase so layered Escape sees browser ordering.
  const keyCaptures = new Set<EventListenerOrEventListenerObject>();
  const addListener = document.addEventListener.bind(document);
  const removeListener = document.removeEventListener.bind(document);
  const captureKeys = (event: Event) => {
    for (const listener of [...keyCaptures]) {
      if (typeof listener === "function") listener.call(document, event);
      else listener.handleEvent(event);
      if (event.cancelBubble) break;
    }
  };
  addListener("keydown", captureKeys);
  restorers.push(
    () => removeListener("keydown", captureKeys),
    installProperties(document, {
      addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
        if (type === "keydown" && (options === true || typeof options === "object" && options.capture)) keyCaptures.add(listener);
        else addListener(type, listener, options);
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) {
        if (type === "keydown" && (options === true || typeof options === "object" && options.capture)) keyCaptures.delete(listener);
        else removeListener(type, listener, options);
      }
    }),
    installPropertyDescriptors(document, { activeElement: { configurable: true, get: () => activeElement } }),
    installProperties((window as Window & typeof globalThis).HTMLElement.prototype, {
      focus(this: HTMLElement) {
        if (activeElement === this) return;
        activeElement = this;
        dispatchDomEvent(window, this, "focusin");
      },
      blur(this: HTMLElement) { if (activeElement === this) activeElement = document.body; },
      clientLeft: 0, clientTop: 0, scrollLeft: 0, scrollTop: 0
    }),
    installProperties(globalThis, {
      innerWidth: 320, innerHeight: 568, scrollY: 0, scrollTo() {},
      getComputedStyle: () => ({ getPropertyValue: () => "", display: "block", visibility: "visible", position: "static", overflowY: "visible" }),
      matchMedia: (media: string) => ({ media, matches: media.includes("max-width") || media.includes("prefers-reduced-motion"), addEventListener() {}, removeEventListener() {} })
    })
  );
  let parentCloses = 0;
  let parentSubmits = 0;
  let applied = 0;
  let disposed = 0;
  const clears: ClearableImageAttribute[] = [];
  const prepared: ClearableImageAttribute[] = [];
  function Probe() {
    const [expanded, setExpanded] = React.useState(false);
    return React.createElement(DialogFrame, {
      className: "parent-dialog", ariaLabel: "批量编辑", onClose: () => { parentCloses += 1; },
      children: () => React.createElement("form", { onSubmit: (event) => { event.preventDefault(); parentSubmits += 1; } },
        React.createElement("button", { type: "button", id: "outside" }, "外部控件"),
        React.createElement(WorkflowCollapsePanel, {
          className: "test-panel", contentClassName: "test-content", title: "批量属性", summary: "2 张图片",
          expanded, onExpandedChange: setExpanded,
          children: React.createElement(WorkflowAttributeActions, {
            disabled: false, ready: true, scopeLabel: "本次批量编辑",
            onApply: () => { applied += 1; },
            onPrepareClear: (field): ImageAttributeClearPlan => {
              prepared.push(field);
              return { count: 2, apply: async () => { clears.push(field); }, dispose: () => { disposed += 1; } };
            }
          })
        }))
    });
  }
  const find = (selector: string) => {
    const element = document.querySelector<HTMLElement>(selector);
    assert.ok(element, selector);
    return element;
  };
  const send = async (target: EventTarget, type: string, properties = {}) => {
    const touches = [{ identifier: 1, clientX: 10, clientY: 10 }];
    await React.act(async () => {
      dispatchDomEvent(window, target, type, {
        ...(type === "touchstart" ? { touches: Object.assign(touches, { item: (index: number) => touches[index] ?? null }) } : {}),
        ...properties
      });
    });
    await harness.flush();
  };
  const escape = () => send(document, "keydown", { key: "Escape", keyCode: 27 });
  await harness.render(React.createElement(Probe));
  const toggle = find(".workflow-collapse-toggle");
  const trigger = find('[aria-label="更多批量属性操作"]');
  const expanded = () => toggle.getAttribute("aria-expanded");
  await send(toggle, "click");
  await send(find(".apply-to-all-button"), "click");
  assert.equal(applied, 1);
  await send(trigger, "click");
  assert.deepEqual([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent), [
    "清空全部主题", "清空全部标签", "清空全部作者", "清空以上全部"
  ]);
  const allItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].at(-1)!;
  await send(allItem, "touchstart");
  assert.equal(expanded(), "true");
  await send(allItem, "click");
  const confirm = find('[role="dialog"][aria-label="清空全部分类属性"]');
  assert.match(confirm.textContent ?? "", /2 张图片的主题、标签和作者/);
  assert.equal(expanded(), "true");
  assert.deepEqual(prepared, ["all"]);
  assert.deepEqual(clears, []);
  await send(confirm.querySelector("button")!, "touchstart");
  assert.equal(expanded(), "true");
  await escape();
  assert.equal(document.querySelector(".confirm-dialog") === null, true, "Escape 关闭确认层");
  assert.equal(expanded(), "true");
  assert.equal(activeElement === trigger, true, "确认层关闭后焦点归还箭头");
  assert.equal(disposed, 1);
  assert.equal(parentCloses, 0);
  await send(trigger, "click");
  await escape();
  assert.equal(document.querySelector('[role="menu"]') === null, true, "Escape 关闭菜单");
  assert.equal(expanded(), "true");
  await escape();
  assert.equal(expanded(), "false");
  assert.equal(activeElement === toggle, true, "面板关闭后焦点归还展开按钮");
  assert.equal(parentCloses, 0);
  await send(toggle, "click");
  await send(trigger, "click");
  await send([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].at(-1)!, "click");
  await send(find(".confirm-dialog form"), "submit");
  assert.deepEqual(clears, ["all"]);
  assert.equal(parentSubmits, 0);
  for (let attempt = 0; attempt < 100 && document.querySelector(".confirm-dialog"); attempt += 1) {
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  assert.equal(document.querySelector(".confirm-dialog") === null, true, "确认成功关闭确认层");
  assert.equal(expanded(), "true");
  await send(find("#outside"), "touchstart");
  assert.equal(expanded(), "false", "浮层外触摸仍按原机制自动收起");
  await escape();
  assert.equal(parentCloses, 1);
});
