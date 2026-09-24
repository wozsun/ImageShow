import "../../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { ingestionDuplicatesPath } from "../../../../packages/shared/src/browser.ts";
import type { IngestionJob } from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-job.ts";
import { queryKeys } from "../../../../packages/web/src/lib/api/query-keys.ts";
import {
  createIngestionCommitIntent,
  summarizeIngestionJobs
} from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-queue-state.ts";
import { ingestionJobStatusLabel } from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-status-detail.ts";
import {
  ingestionJob,
  adminImageListItem
} from "../../support/web-test-context.ts";
import { installControlledClock } from "../../support/controlled-clock.ts";

test("[Web/内容接入] 上传与导入窗口真实挂载保持双行摘要、来源切换和关闭回焦", async (t) => {
  assert.equal(
    ingestionJobStatusLabel(ingestionJob({ status: "commit-queued" })),
    "提交排队",
    "稳定配色不得掩盖真实的提交排队状态"
  );
  assert.equal(
    ingestionJobStatusLabel(ingestionJob({ status: "committing" })),
    "提交中",
    "稳定配色不得把真实提交状态伪装成已就绪"
  );
  const { window, document } = parseHTML(
    "<!doctype html><html><body><button id=return-target>打开上传</button><div id=root></div></body></html>"
  );
  const React = await import("react");
  const requestAnimationFrame = (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number;
  const cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  const matchMedia = (query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true
  });
  Object.assign(window, {
    requestAnimationFrame,
    cancelAnimationFrame,
    matchMedia,
    scrollTo() {},
    scrollY: 0,
    innerWidth: 1280,
    innerHeight: 720
  });
  const clock = installControlledClock(t, window as unknown as Window);

  let activeElement: HTMLElement | null = null;
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => activeElement
  });
  const originalFocus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function focus() {
    activeElement = this;
  };

  let fetchCount = 0;
  const windowDuplicateMd5 = "e".repeat(32);
  const windowDuplicateItem = adminImageListItem({
    id: "00000000-0000-7034-8000-00000000008e",
    md5: windowDuplicateMd5
  });
  const fetchStub = async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "https://imageshow.test").pathname;
    if (path === ingestionDuplicatesPath) {
      return new Response(
        JSON.stringify({
          ok: true,
          items: [
            {
              md5: windowDuplicateMd5,
              match_count: 1,
              duplicates: [windowDuplicateItem]
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
    fetchCount += 1;
    throw new Error("内容接入窗口渲染不应发起请求");
  };
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame,
    cancelAnimationFrame,
    fetch: fetchStub,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map(
      (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    )
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  let deregisterCssHooks = () => {};
  try {
    const { registerHooks } = await import("node:module");
    const cssHooks = registerHooks({
      load(url, context, nextLoad) {
        if (url.endsWith(".css")) {
          return { format: "module", source: "", shortCircuit: true };
        }
        return nextLoad(url, context);
      }
    });
    deregisterCssHooks = () => cssHooks.deregister();
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { MemoryRouter } = await import("react-router");
    const { AuthSessionProvider } =
      await import("../../../../packages/web/src/hooks/useAuthSession.tsx");
    const { IngestionWorkflowWindow } =
      await import("../../../../packages/web/src/pages/admin/ingestion/workflow/IngestionWorkflowWindow.tsx");
    const rootElement = document.getElementById("root");
    const returnTarget = document.getElementById("return-target") as HTMLElement;
    assert.ok(rootElement);
    returnTarget.focus();
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          gcTime: Number.POSITIVE_INFINITY,
          retry: false,
          staleTime: Number.POSITIVE_INFINITY,
          refetchOnWindowFocus: false
        }
      }
    });
    client.setQueryData(queryKeys.me, {
      authenticated: true,
      username: "workflow-window-test",
      role: "super",
      permissions: [],
      csrf_token: "workflow-window-token",
      application_version: "current-test",
      preferences: {},
      preferences_etag: 'W/"workflow-window-preferences"',
      version_settings: { enabled: true, link_enabled: true }
    });
    client.setQueryData(queryKeys.galleryFacets, {
      themes: [],
      tags: [],
      authors: []
    });

    const sourceSelections: string[] = [];
    let closeCount = 0;
    let prepareCloseCount = 0;
    let finishPreparedCloseCount = 0;
    let fallbackCloseCount = 0;
    const closeOptions: Array<
      | Readonly<{
          skipCompletedCleanup?: boolean;
        }>
      | undefined
    > = [];
    let clearArmCount = 0;
    let clearConfirmCount = 0;
    let clearShouldSucceed = false;
    let delayClearConfirmation = false;
    let resolveClearConfirmation: ((closed: boolean) => void) | undefined;
    let cleanupConfirmCount = 0;
    let cleanupRunCount = 0;
    let commitReadyCount = 0;
    let applyDefaultsCount = 0;
    let setHarnessOpen: ((open: boolean) => void) | undefined;
    let setHarnessBusy: ((busy: boolean) => void) | undefined;
    let setHarnessMode: ((mode: "upload" | "import") => void) | undefined;
    let setHarnessJobs: ((jobs: IngestionJob[]) => void) | undefined;
    let setHarnessTotalItems: ((total: number | null) => void) | undefined;
    type HarnessServerStatus =
      "idle" | "connecting" | "loading" | "ready" | "disconnected" | "error";
    let setHarnessServerStatus: ((status: HarnessServerStatus) => void) | undefined;
    let setHarnessTransientFlags:
      ((flags: { actionBusy: boolean; pendingAuthorityHandoff: boolean }) => void) | undefined;
    const emptyJobs: IngestionJob[] = [];
    const queueBase = {
      page: 1,
      totalPages: 1,
      serverNotice: "",
      serverNoticeRetryable: false,
      pendingAuthorityHandoff: false,
      actions: {
        busy: false,
        notice: "",
        identity: "test-action-scope"
      },
      server: {
        status: "ready",
        summary: null,
        error: "",
        refresh() {}
      },
      setPage() {},
      applyDefaultsToLocalJobs() {},
      removeLibraryDuplicate() {},
      updateJobs() {},
      updateDuplicateDecision: async () => true
    };

    function Harness() {
      const [open, setOpen] = React.useState(true);
      const [busy, setBusy] = React.useState(false);
      const [workflowMode, setWorkflowMode] = React.useState<"upload" | "import">("import");
      const [jobs, setJobs] = React.useState(emptyJobs);
      const [totalItemsOverride, setTotalItemsOverride] = React.useState<number | null>(null);
      const [serverStatus, setServerStatus] = React.useState<HarnessServerStatus>("loading");
      const [transientFlags, setTransientFlags] = React.useState({
        actionBusy: false,
        pendingAuthorityHandoff: false
      });
      setHarnessOpen = setOpen;
      setHarnessBusy = setBusy;
      setHarnessMode = setWorkflowMode;
      setHarnessJobs = setJobs;
      setHarnessTotalItems = setTotalItemsOverride;
      setHarnessServerStatus = setServerStatus;
      setHarnessTransientFlags = setTransientFlags;
      const [sourceMode, setSourceMode] = React.useState<"urls" | "jsonl" | "weibo">("urls");
      const returnFocusRef = React.useRef<HTMLElement | null>(returnTarget);
      if (!open) return null;
      const queue = {
        ...queueBase,
        pendingAuthorityHandoff: transientFlags.pendingAuthorityHandoff,
        actions: {
          ...queueBase.actions,
          busy: transientFlags.actionBusy
        },
        jobs,
        localJobs: jobs,
        jobsRef: { current: jobs },
        server: {
          ...queueBase.server,
          status: serverStatus
        },
        totalItems: totalItemsOverride ?? jobs.length,
        visibleJobs: jobs,
        summary: summarizeIngestionJobs(jobs),
        uncommittedCount: jobs.length
      };
      return React.createElement(IngestionWorkflowWindow, {
        mode: workflowMode,
        busy,
        queue: queue as never,
        returnFocusRef,
        onPrepareClose: (options) => {
          prepareCloseCount += 1;
          return () => {
            finishPreparedCloseCount += 1;
            closeCount += 1;
            closeOptions.push(options);
            setOpen(false);
          };
        },
        onClose: (options) => {
          fallbackCloseCount += 1;
          closeCount += 1;
          closeOptions.push(options);
          setOpen(false);
        },
        defaults: {
          device: "auto",
          brightness: "auto",
          theme: "",
          author: "",
          tags: []
        },
        onDefaultsChange() {},
        themes: [],
        tags: [],
        authors: [],
        importParseErrors: [],
        onClearImportParseErrors() {},
        storageName: (slug: string) => slug,
        onAddFiles() {},
        onPatchJob() {},
        onCancelJob() {},
        onRetryJob() {},
        onRemoveJob() {},
        onConfirmDuplicateJob() {},
        onApplyDefaults() {
          applyDefaultsCount += 1;
        },
        onPrepareAttributeClear: () => null,
        onCleanupAction() {
          cleanupRunCount += 1;
        },
        onArmCleanupAction: (_action, confirmationCount) => ({
          count: confirmationCount
        }),
        onConfirmCleanupAction: async () => {
          cleanupConfirmCount += 1;
          return true;
        },
        onDiscardUnconfirmedIntents() {},
        confirmationScope: "test-confirmation-scope",
        onArmClearQueue: () => {
          clearArmCount += 1;
          return true;
        },
        onConfirmClearQueue: async () => {
          clearConfirmCount += 1;
          if (delayClearConfirmation) {
            return new Promise<boolean>((resolve) => {
              resolveClearConfirmation = resolve;
            });
          }
          return clearShouldSucceed;
        },
        activeBackend: "local",
        backendOptions: [{ value: "local", label: "本地" }],
        onBackendChange() {},
        async onCommitReady() {
          commitReadyCount += 1;
        },
        canRetryAll: false,
        retryingAll: false,
        retryBusy: false,
        isRetryPending: () => false,
        async onRetryAll() {},
        sourceDialogPending: false,
        sourceDialogOpen: false,
        sourceDialogComponent: null,
        importSourceMode: sourceMode,
        autoImportAfterParse: false,
        importMaxItems: 200,
        weiboMaxItems: 10,
        onOpenImportSource: (mode) => {
          sourceSelections.push(mode);
          setSourceMode(mode);
        },
        onPreloadImportSource() {},
        onCloseImportSource() {},
        onSubmitImportSource() {}
      });
    }

    const root = createRoot(rootElement);
    await React.act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(
            MemoryRouter,
            null,
            React.createElement(
              AuthSessionProvider,
              null,
              React.createElement(Harness)
            )
          )
        )
      );
      await Promise.resolve();
    });

    const dialog = document.querySelector<HTMLElement>("[data-dialog-frame]");
    assert.ok(dialog);
    assert.equal(dialog.getAttribute("aria-label"), "导入图片");
    assert.match(
      dialog.querySelector(".ingestion-empty-state")?.textContent ?? "",
      /点击此处选择图片来源/u,
      "首次快照到达前应随窗口首帧显示默认入口"
    );
    for (const status of [
      "idle",
      "connecting",
      "loading",
      "disconnected"
    ] as const) {
      await React.act(async () => {
        setHarnessServerStatus?.(status);
        await Promise.resolve();
      });
      assert.ok(
        dialog.querySelector(".ingestion-empty-state"),
        `${status} 首帧必须保留默认入口`
      );
    }
    await React.act(async () => {
      setHarnessServerStatus?.("error");
      await Promise.resolve();
    });
    assert.equal(
      dialog.querySelector(".ingestion-empty-state"),
      null,
      "读取失败应以错误提示替代默认入口"
    );
    assert.equal(dialog.querySelector('input[type="file"]'), null);
    await React.act(async () => {
      setHarnessServerStatus?.("ready");
      await Promise.resolve();
    });
    assert.match(dialog.textContent ?? "", /点击此处选择图片来源/);
    assert.match(
      dialog.querySelector(".ingestion-empty-subtitle")?.textContent ?? "",
      /输入来源后立即创建并准备图片任务/u
    );
    const buttonByText = (label: string) =>
      [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === label
      );
    assert.equal(activeElement, dialog.querySelector(".ingestion-close-button"));
    for (const label of ["链接", "清单", "微博"]) {
      const button = buttonByText(label);
      assert.ok(button);
      await React.act(async () => {
        button.dispatchEvent(
          new window.Event("click", {
            bubbles: true,
            cancelable: true
          })
        );
        await Promise.resolve();
      });
    }
    assert.deepEqual(sourceSelections, ["urls", "jsonl", "weibo"]);
    assert.equal(fetchCount, 0);

    await React.act(async () => {
      setHarnessMode?.("upload");
      setHarnessBusy?.(true);
      setHarnessServerStatus?.("loading");
      await Promise.resolve();
    });
    assert.match(
      dialog.querySelector(".ingestion-empty-state")?.textContent ?? "",
      /点击此处选择图片，或将图片拖到这里/u,
      "上传窗口不应在等待首份服务端快照时留下空白主体"
    );
    const localFileInput = dialog.querySelector<HTMLInputElement>('input[type="file"]');
    assert.ok(localFileInput);
    assert.equal(
      localFileInput.disabled,
      false,
      "本地上传忙碌阶段仍须保持选择图片入口稳定可用"
    );
    assert.equal(
      localFileInput.closest(".upload-picker")?.classList.contains("is-disabled"),
      false,
      "本地上传入口不得在提交瞬间切换禁用外观"
    );
    const pendingSnapshotJob = ingestionJob({
      id: "window-pending-snapshot",
      attemptKey: "window-pending-snapshot-attempt",
      sessionId: "S".repeat(43),
      imageId: "00000000-0000-7037-8000-00000000008e",
      serverAccepted: true,
      kind: "upload",
      status: "processing"
    });
    await React.act(async () => {
      setHarnessTotalItems?.(1);
      await Promise.resolve();
    });
    assert.match(
      dialog.querySelector(".ingestion-empty-state")?.textContent ?? "",
      /点击此处选择图片，或将图片拖到这里/u,
      "summary 先到而卡片尚未水合时必须继续保留默认入口"
    );
    assert.match(
      dialog.querySelector(".ingestion-task-summary")?.textContent ?? "",
      /共\s*1\s*张图片/u
    );
    await React.act(async () => {
      setHarnessJobs?.([pendingSnapshotJob]);
      await Promise.resolve();
    });
    assert.equal(
      dialog.querySelector(".ingestion-empty-state"),
      null,
      "服务端未完成任务到达后必须替换首帧默认入口"
    );
    assert.match(
      dialog.querySelector(".ingestion-job")?.textContent ?? "",
      /处理中/u
    );
    await React.act(async () => {
      setHarnessJobs?.([]);
      setHarnessTotalItems?.(null);
      setHarnessBusy?.(false);
      setHarnessMode?.("import");
      setHarnessServerStatus?.("ready");
      await Promise.resolve();
    });

    const applyTransitionJob = ingestionJob({
      id: "window-apply-transition",
      attemptKey: "window-apply-transition-attempt",
      kind: "upload",
      status: "queued"
    });
    await React.act(async () => {
      setHarnessJobs?.([applyTransitionJob]);
      await Promise.resolve();
    });
    const applyDefaults = buttonByText("应用到全部");
    assert.ok(applyDefaults);
    assert.equal(applyDefaults.disabled, false);
    await React.act(async () => {
      setHarnessJobs?.([{ ...applyTransitionJob, status: "processing" }]);
      setHarnessBusy?.(true);
      setHarnessTransientFlags?.({
        actionBusy: true,
        pendingAuthorityHandoff: true
      });
      await Promise.resolve();
    });
    assert.equal(
      applyDefaults.disabled,
      false,
      "交接中的未完成任务仍须保持应用动作可点击"
    );
    await React.act(async () => {
      setHarnessJobs?.([
        {
          ...applyTransitionJob,
          status: "commit-queued",
          commitIntent: createIngestionCommitIntent(
            applyTransitionJob,
            "00000000-0000-702f-8000-00000000008e"
          )
        }
      ]);
      await Promise.resolve();
    });
    assert.equal(
      applyDefaults.disabled,
      false,
      "冻结提交阶段仍应保持按钮状态稳定，动作只影响可应用任务"
    );
    await React.act(async () => {
      setHarnessBusy?.(false);
      setHarnessTransientFlags?.({
        actionBusy: false,
        pendingAuthorityHandoff: false
      });
      await Promise.resolve();
    });

    const waitingSummaryJob = ingestionJob({
      id: "window-waiting-summary",
      attemptKey: "window-waiting-summary-attempt",
      status: "queued"
    });
    await React.act(async () => {
      setHarnessJobs?.([waitingSummaryJob]);
      await Promise.resolve();
    });
    const waitingSummary = dialog.querySelector(
      ".ingestion-summary-primary"
    )?.textContent ?? "";
    assert.match(waitingSummary, /共\s*1\s*张图片/u);
    assert.match(waitingSummary, /1\s*张等待中/u);
    assert.match(waitingSummary, /0\s*张处理中/u);

    await React.act(async () => {
      setHarnessJobs?.([{ ...waitingSummaryJob, status: "received" }]);
      await Promise.resolve();
    });
    const receivedSummary = dialog.querySelector(
      ".ingestion-summary-primary"
    )?.textContent ?? "";
    assert.match(receivedSummary, /共\s*1\s*张图片/u);
    assert.match(receivedSummary, /0\s*张等待中/u);
    assert.match(receivedSummary, /0\s*张处理中/u);

    const firstConfirmationJob = ingestionJob({
      id: "window-confirmation-first",
      attemptKey: "window-confirmation-first-attempt",
      status: "ready"
    });
    const laterConfirmationJob = ingestionJob({
      id: "window-confirmation-later",
      attemptKey: "window-confirmation-later-attempt",
      status: "ready"
    });
    await React.act(async () => {
      setHarnessJobs?.([firstConfirmationJob]);
      await Promise.resolve();
    });
    const readyPrimarySummary =
      dialog.querySelector(
        ".ingestion-summary-primary"
      )?.textContent ?? "";
    const readySecondarySummary =
      dialog.querySelector(
        ".ingestion-summary-secondary"
      )?.textContent ?? "";
    assert.match(readyPrimarySummary, /共\s*1\s*张图片/u);
    assert.match(readyPrimarySummary, /0\s*张等待中/u);
    assert.match(readyPrimarySummary, /0\s*张处理中/u);
    assert.match(readySecondarySummary, /1\s*张待提交/u);
    assert.match(readySecondarySummary, /0\s*张提交中/u);
    assert.match(readySecondarySummary, /0\s*张已完成/u);

    const clearUncommitted = buttonByText("清空未提交");
    assert.ok(clearUncommitted);
    const phaseDuplicateJob = ingestionJob({
      id: "window-phase-duplicate",
      attemptKey: "window-phase-duplicate-attempt",
      sessionId: "Q".repeat(43),
      imageId: "00000000-0000-7036-8000-00000000008e",
      serverAccepted: true,
      status: "ready",
      md5: windowDuplicateMd5,
      duplicateDecision: "undecided",
      duplicateCount: 1,
      duplicates: [windowDuplicateItem]
    });
    await React.act(async () => {
      setHarnessJobs?.([firstConfirmationJob, phaseDuplicateJob]);
      setHarnessBusy?.(true);
      setHarnessServerStatus?.("loading");
      setHarnessTransientFlags?.({
        actionBusy: true,
        pendingAuthorityHandoff: true
      });
      await Promise.resolve();
    });
    const clearDuplicates = buttonByText("清空重复待确认");
    const submitReady = dialog.querySelector<HTMLButtonElement>(".workflow-submit-button");
    const alwaysClickableCancel = dialog.querySelector<HTMLButtonElement>(
      ".ingestion-queue-clear-button"
    );
    assert.ok(clearDuplicates);
    assert.ok(submitReady);
    assert.ok(alwaysClickableCancel);
    const duplicateCancel = dialog.querySelector<HTMLButtonElement>(
      ".duplicate-panel .danger-button"
    );
    assert.ok(duplicateCancel);
    const sourceButtons = ["链接", "清单", "微博"].map((label) => {
      const button = buttonByText(label);
      assert.ok(button);
      return button;
    });
    assert.equal(clearDuplicates.disabled, false);
    assert.equal(clearUncommitted.disabled, false);
    assert.equal(submitReady.disabled, true, "提交受理或队列未确认期间不能再次提交");
    assert.equal(alwaysClickableCancel.disabled, false);
    assert.equal(
      duplicateCancel.disabled,
      false,
      "重复待确认卡片的取消按钮在队列操作期间仍须可点击"
    );
    assert.equal(applyDefaults.disabled, false);
    assert.equal(
      sourceButtons.every((button) => !button.disabled),
      true
    );
    assert.match(submitReady.textContent ?? "", /提交\s*1\s*张/u);
    await React.act(async () => {
      clearDuplicates.dispatchEvent(
        new window.Event("click", {
          bubbles: true,
          cancelable: true
        })
      );
      submitReady.dispatchEvent(
        new window.Event("click", {
          bubbles: true,
          cancelable: true
        })
      );
      for (const button of sourceButtons) {
        button.dispatchEvent(
          new window.Event("click", {
            bubbles: true,
            cancelable: true
          })
        );
      }
      await Promise.resolve();
    });
    assert.equal(cleanupRunCount, 1);
    assert.equal(commitReadyCount, 0);
    assert.equal(applyDefaultsCount, 0);
    assert.deepEqual(
      sourceSelections,
      ["urls", "jsonl", "weibo", "urls", "jsonl", "weibo"],
      "提交与队列动作 busy 不得让三类导入入口闪成 disabled"
    );
    await React.act(async () => {
      setHarnessJobs?.([firstConfirmationJob]);
      setHarnessBusy?.(false);
      setHarnessServerStatus?.("ready");
      setHarnessTransientFlags?.({
        actionBusy: false,
        pendingAuthorityHandoff: false
      });
      await Promise.resolve();
    });
    await React.act(async () => {
      clearUncommitted.dispatchEvent(
        new window.Event("click", {
          bubbles: true,
          cancelable: true
        })
      );
      await Promise.resolve();
    });
    let cleanupDialog = document.querySelector<HTMLElement>(".confirm-dialog");
    assert.ok(cleanupDialog);
    assert.match(cleanupDialog.textContent ?? "", /当前 1 张未提交图片/u);
    await React.act(async () => {
      setHarnessJobs?.([firstConfirmationJob, laterConfirmationJob]);
      await Promise.resolve();
    });
    cleanupDialog = document.querySelector<HTMLElement>(".confirm-dialog");
    assert.ok(cleanupDialog, "新增任务不得关闭已打开的清理确认");
    assert.match(
      cleanupDialog.textContent ?? "",
      /当前 1 张未提交图片/u,
      "确认范围与文案必须保持打开时冻结的任务数量"
    );
    await React.act(async () => {
      setHarnessJobs?.([
        { ...firstConfirmationJob, status: "done" },
        { ...laterConfirmationJob, status: "done" }
      ]);
      await Promise.resolve();
    });
    cleanupDialog = document.querySelector<HTMLElement>(".confirm-dialog");
    assert.ok(cleanupDialog);
    const frozenCleanupConfirm =
      cleanupDialog.querySelector<HTMLButtonElement>('button[type="submit"]');
    assert.ok(frozenCleanupConfirm);
    assert.match(
      frozenCleanupConfirm.querySelector(".async-action-state:not(.is-hidden) .async-action-label")
        ?.textContent ?? "",
      /清空\s*1\s*张/u,
      "确认按钮应保留打开弹窗时冻结的任务数量"
    );
    assert.equal(
      frozenCleanupConfirm.disabled,
      false,
      "普通任务状态变化不得按当前计数禁用已冻结的清理确认"
    );
    const frozenCleanupForm = frozenCleanupConfirm.closest("form");
    assert.ok(frozenCleanupForm);
    await React.act(async () => {
      frozenCleanupForm.dispatchEvent(
        new window.Event("submit", {
          bubbles: true,
          cancelable: true
        })
      );
      await Promise.resolve();
      await clock.advanceBy(499);
      assert.ok(
        document.querySelector(".confirm-dialog"),
        "最短反馈期限前清理确认保持打开"
      );
      await clock.advanceBy(1);
    });
    assert.equal(
      document.querySelector(".confirm-dialog") === null,
      true,
      "成功清理后应关闭确认弹窗"
    );
    assert.equal(cleanupConfirmCount, 1);
    await React.act(async () => {
      setHarnessJobs?.([firstConfirmationJob, laterConfirmationJob]);
      await Promise.resolve();
    });

    const clearQueueButton = dialog.querySelector<HTMLButtonElement>(
      ".ingestion-queue-clear-button"
    );
    assert.ok(clearQueueButton);
    await React.act(async () => {
      clearQueueButton.dispatchEvent(
        new window.Event("click", {
          bubbles: true,
          cancelable: true
        })
      );
      await Promise.resolve();
    });
    assert.equal(clearQueueButton.textContent?.trim(), "清空");
    assert.equal(clearQueueButton.classList.contains("is-armed"), true);
    await React.act(async () => {
      setHarnessJobs?.([
        firstConfirmationJob,
        laterConfirmationJob,
        ingestionJob({
          id: "window-confirmation-newest",
          attemptKey: "window-confirmation-newest-attempt",
          status: "ready"
        })
      ]);
      await Promise.resolve();
    });
    assert.equal(
      clearQueueButton.textContent?.trim(),
      "清空",
      "新增任务不得重置整队列二次确认"
    );
    await React.act(async () => {
      setHarnessServerStatus?.("loading");
      await Promise.resolve();
      clearQueueButton.dispatchEvent(
        new window.Event("blur", {
          bubbles: false
        })
      );
      await Promise.resolve();
    });
    assert.equal(
      clearQueueButton.textContent?.trim(),
      "清空",
      "权威快照交接导致的禁用和失焦不得解除二次确认"
    );
    await React.act(async () => {
      setHarnessServerStatus?.("ready");
      setHarnessJobs?.(
        [
          firstConfirmationJob,
          laterConfirmationJob,
          ingestionJob({
            id: "window-confirmation-newest",
            attemptKey: "window-confirmation-newest-attempt",
            status: "ready"
          })
        ].map((job) => ({ ...job, status: "done" as const }))
      );
      await Promise.resolve();
    });
    assert.equal(
      clearQueueButton.textContent?.trim(),
      "清空",
      "冻结范围内任务转为已完成也不得改写二次确认意图"
    );
    assert.equal(clearQueueButton.classList.contains("danger-button"), true);
    await React.act(async () => {
      clearQueueButton.dispatchEvent(
        new window.Event("click", {
          bubbles: true,
          cancelable: true
        })
      );
      await Promise.resolve();
    });
    assert.equal(clearQueueButton.textContent?.trim(), "取消");
    assert.equal(clearArmCount, 1, "确认时不得按最新队列重新冻结一次范围");
    assert.equal(clearConfirmCount, 1);

    const incarnationSessionId = "Z".repeat(43);
    await React.act(async () => {
      setHarnessJobs?.([
        ingestionJob({
          id: "window-old-incarnation",
          attemptKey: "window-old-incarnation-attempt",
          batchKey: "window-incarnation-batch",
          sessionId: incarnationSessionId,
          imageId: "00000000-0000-7030-8000-00000000008e",
          serverAccepted: true,
          status: "received",
          preview: "blob:window-old-incarnation",
          previewFull: "blob:window-old-incarnation"
        })
      ]);
      await Promise.resolve();
    });
    const oldPreviewOpener = dialog.querySelector<HTMLElement>(
      ".ingestion-job-thumbnail[role='button']"
    );
    assert.ok(oldPreviewOpener);
    await React.act(async () => {
      oldPreviewOpener.dispatchEvent(
        new window.Event("click", {
          bubbles: true,
          cancelable: true
        })
      );
      await Promise.resolve();
    });
    assert.ok(document.querySelector(".image-preview-modal"));

    await React.act(async () => {
      setHarnessJobs?.([
        ingestionJob({
          id: "window-next-incarnation",
          attemptKey: "window-next-incarnation-attempt",
          batchKey: "window-incarnation-batch",
          sessionId: incarnationSessionId,
          imageId: "00000000-0000-7031-8000-00000000008e",
          serverAccepted: true,
          status: "received",
          preview: "https://img.example/images/thumbs/new-incarnation.webp",
          previewFull: "https://img.example/images/full/new-incarnation.webp"
        })
      ]);
      await Promise.resolve();
    });
    const nextPreviewOpener = dialog.querySelector<HTMLElement>(
      ".ingestion-job-thumbnail[role='button']"
    );
    assert.ok(nextPreviewOpener);
    const transferredPreview = document.querySelector<HTMLElement>(".image-preview-modal");
    assert.ok(
      transferredPreview,
      "同 session 新 image 接管后必须把已打开预览切换到新 incarnation"
    );
    const previewClose =
      transferredPreview.querySelector<HTMLButtonElement>(".image-preview-close");
    assert.ok(previewClose);
    await React.act(async () => {
      previewClose.dispatchEvent(
        new window.Event("click", {
          bubbles: true,
          cancelable: true
        })
      );
      await Promise.resolve();
    });
    assert.equal(document.querySelector(".image-preview-modal"), null);
    assert.equal(
      activeElement,
      nextPreviewOpener,
      "旧预览关闭后必须把焦点转交给新 incarnation 卡片"
    );

    const focusSessionId = "F".repeat(43);
    const focusImageId = "00000000-0000-7032-8000-00000000008e";
    const focusPlaceholder = ingestionJob({
      id: "local:continuous-focus",
      attemptKey: "continuous-focus-attempt",
      batchKey: "continuous-focus-batch",
      status: "ready",
      preview: "blob:continuous-focus"
    });
    await React.act(async () => {
      setHarnessJobs?.([focusPlaceholder]);
      await Promise.resolve();
    });
    const oldTitleInput = dialog.querySelector<HTMLInputElement>(
      ".ingestion-job input[placeholder='标题']"
    );
    assert.ok(oldTitleInput);
    await React.act(async () => {
      oldTitleInput.focus();
      oldTitleInput.dispatchEvent(
        new window.Event("focusin", {
          bubbles: true
        })
      );
      await Promise.resolve();
    });
    const firstBoundFocus = ingestionJob({
      ...focusPlaceholder,
      sessionId: focusSessionId,
      imageId: focusImageId,
      serverAccepted: true,
      preview: "https://img.example/images/thumbs/first-bound-focus.webp"
    });
    await React.act(async () => {
      setHarnessJobs?.([firstBoundFocus]);
      await Promise.resolve();
    });
    await React.act(async () => {
      setHarnessJobs?.([
        ingestionJob({
          ...firstBoundFocus,
          id: "server:next-incarnation-focus",
          attemptKey: "next-incarnation-focus-attempt",
          imageId: "00000000-0000-7035-8000-00000000008e"
        })
      ]);
      await Promise.resolve();
    });
    const continuousTitleInput = dialog.querySelector<HTMLInputElement>(
      ".ingestion-job input[placeholder='标题']"
    );
    assert.ok(continuousTitleInput);
    assert.equal(
      activeElement,
      continuousTitleInput,
      "placeholder 同 DOM 接管后再换 image 仍必须转交字段焦点"
    );

    const eventFirstCanonical = ingestionJob({
      id: "server:event-first-focus",
      attemptKey: "event-first-focus-attempt",
      batchKey: "event-first-focus-batch",
      sessionId: focusSessionId,
      imageId: focusImageId,
      serverAccepted: true,
      status: "ready",
      preview: "https://img.example/images/thumbs/event-first-focus.webp"
    });
    await React.act(async () => {
      setHarnessJobs?.([eventFirstCanonical]);
      await Promise.resolve();
    });
    const eventFirstTitleInput = dialog.querySelector<HTMLInputElement>(
      ".ingestion-job input[placeholder='标题']"
    );
    assert.ok(eventFirstTitleInput);
    await React.act(async () => {
      eventFirstTitleInput.focus();
      eventFirstTitleInput.dispatchEvent(
        new window.Event("focusin", {
          bubbles: true
        })
      );
      await Promise.resolve();
    });
    await React.act(async () => {
      setHarnessJobs?.([
        ingestionJob({
          ...eventFirstCanonical,
          id: "local:http-late-focus",
          attemptKey: "http-late-focus-attempt"
        })
      ]);
      await Promise.resolve();
    });
    const transferredTitleInput = dialog.querySelector<HTMLInputElement>(
      ".ingestion-job input[placeholder='标题']"
    );
    assert.ok(transferredTitleInput);
    assert.equal(
      activeElement,
      transferredTitleInput,
      "event-first canonical 合并到 HTTP placeholder 后必须转交字段焦点"
    );

    const detailSessionId = "D".repeat(43);
    const detailImageId = "00000000-0000-7033-8000-00000000008e";
    const detailCanonical = ingestionJob({
      id: "server:event-first-detail",
      attemptKey: "event-first-detail-attempt",
      batchKey: "event-first-detail-batch",
      sessionId: detailSessionId,
      imageId: detailImageId,
      serverAccepted: true,
      serverVersion: 1,
      status: "ready",
      md5: windowDuplicateMd5,
      duplicateDecision: "undecided",
      duplicateCount: 1,
      duplicates: [windowDuplicateItem]
    });
    await React.act(async () => {
      setHarnessJobs?.([detailCanonical]);
      await Promise.resolve();
    });
    const duplicateStatusLabel = dialog.querySelector<HTMLElement>(".ingestion-status-label");
    assert.equal(duplicateStatusLabel?.textContent, "【待确认】");
    assert.equal(
      duplicateStatusLabel?.classList.contains("is-duplicate-pending"),
      true,
      "重复待确认标签必须复用重复提示标题的语义警告色"
    );
    const oldDetailOpener = dialog.querySelector<HTMLButtonElement>(".duplicate-item");
    assert.ok(oldDetailOpener);
    await React.act(async () => {
      oldDetailOpener.dispatchEvent(
        new window.Event("click", {
          bubbles: true,
          cancelable: true
        })
      );
      await Promise.resolve();
    });
    assert.ok(document.querySelector(".image-detail-modal"));
    await React.act(async () => {
      setHarnessJobs?.([
        ingestionJob({
          ...detailCanonical,
          id: "local:http-late-detail",
          attemptKey: "http-late-detail-attempt"
        })
      ]);
      await Promise.resolve();
    });
    const detailClose = document.querySelector<HTMLButtonElement>(
      ".image-detail-modal button[aria-label='关闭图片详情']"
    );
    assert.ok(detailClose);
    await React.act(async () => {
      detailClose.dispatchEvent(
        new window.Event("click", {
          bubbles: true,
          cancelable: true
        })
      );
      await Promise.resolve();
    });
    const transferredDetailOpener = dialog.querySelector<HTMLButtonElement>(".duplicate-item");
    assert.ok(transferredDetailOpener);
    assert.equal(document.querySelector(".image-detail-modal"), null);
    assert.equal(
      activeElement,
      transferredDetailOpener,
      "event-first canonical 合并后详情关闭必须归焦到 placeholder 卡片"
    );

    await React.act(async () => {
      setHarnessBusy?.(true);
      await Promise.resolve();
    });

    const waitForPageScrollRestore = () =>
      new Promise<void>((resolve) => {
        window.addEventListener("imageshow:page-scroll-restored", () => resolve(), {
          once: true
        });
      });
    const escapeScrollRestored = waitForPageScrollRestore();
    const escapeEvent = new window.Event("keydown", {
      bubbles: true,
      cancelable: true
    });
    Object.defineProperty(escapeEvent, "key", { value: "Escape" });
    await React.act(async () => {
      document.dispatchEvent(escapeEvent);
      await Promise.resolve();
    });
    assert.equal(prepareCloseCount, 1);
    assert.equal(finishPreparedCloseCount, 1);
    assert.equal(fallbackCloseCount, 0);
    assert.equal(closeCount, 1);
    assert.equal(closeOptions[0], undefined);
    assert.equal(document.querySelector("[data-dialog-frame]"), null);
    assert.equal(activeElement, returnTarget);
    await escapeScrollRestored;

    await React.act(async () => {
      setHarnessOpen?.(true);
      await Promise.resolve();
    });
    const reopenedDialog = document.querySelector<HTMLElement>("[data-dialog-frame]");
    const closeButton = reopenedDialog?.querySelector<HTMLButtonElement>(".ingestion-close-button");
    assert.ok(closeButton);
    assert.equal(closeButton.disabled, false, "忙碌阶段仍必须允许隐藏窗口");
    const buttonScrollRestored = waitForPageScrollRestore();
    await React.act(async () => {
      closeButton.dispatchEvent(
        new window.Event("click", {
          bubbles: true,
          cancelable: true
        })
      );
      await Promise.resolve();
    });
    assert.equal(prepareCloseCount, 2);
    assert.equal(finishPreparedCloseCount, 2);
    assert.equal(fallbackCloseCount, 0);
    assert.equal(closeCount, 2);
    assert.equal(closeOptions[1], undefined);
    assert.equal(document.querySelector("[data-dialog-frame]"), null);
    await buttonScrollRestored;

    await React.act(async () => {
      setHarnessOpen?.(true);
      await Promise.resolve();
    });
    const staleDialog = document.querySelector<HTMLElement>("[data-dialog-frame]");
    const staleClearQueueButton = staleDialog?.querySelector<HTMLButtonElement>(
      ".ingestion-queue-clear-button"
    );
    const staleCloseButton =
      staleDialog?.querySelector<HTMLButtonElement>(".ingestion-close-button");
    assert.ok(staleClearQueueButton);
    assert.ok(staleCloseButton);
    delayClearConfirmation = true;
    await React.act(async () => {
      staleClearQueueButton.dispatchEvent(
        new window.Event("click", {
          bubbles: true,
          cancelable: true
        })
      );
      await Promise.resolve();
    });
    await React.act(async () => {
      staleClearQueueButton.dispatchEvent(
        new window.Event("click", {
          bubbles: true,
          cancelable: true
        })
      );
      await Promise.resolve();
    });
    assert.ok(resolveClearConfirmation);

    const staleScrollRestored = waitForPageScrollRestore();
    await React.act(async () => {
      staleCloseButton.dispatchEvent(
        new window.Event("click", {
          bubbles: true,
          cancelable: true
        })
      );
      await Promise.resolve();
    });
    assert.equal(prepareCloseCount, 3);
    assert.equal(finishPreparedCloseCount, 3);
    assert.equal(fallbackCloseCount, 0);
    assert.equal(closeCount, 3);
    assert.equal(closeOptions[2], undefined);
    assert.equal(document.querySelector("[data-dialog-frame]"), null);
    await staleScrollRestored;

    await React.act(async () => {
      setHarnessOpen?.(true);
      await Promise.resolve();
    });
    const reopenedAfterStaleConfirmation =
      document.querySelector<HTMLElement>("[data-dialog-frame]");
    assert.ok(reopenedAfterStaleConfirmation);
    delayClearConfirmation = false;
    await React.act(async () => {
      resolveClearConfirmation?.(true);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    resolveClearConfirmation = undefined;
    assert.equal(
      document.querySelector("[data-dialog-frame]"),
      reopenedAfterStaleConfirmation,
      "已卸载窗口的迟到清空结果不得关闭后来重开的窗口"
    );
    assert.equal(prepareCloseCount, 3);
    assert.equal(finishPreparedCloseCount, 3);
    assert.equal(fallbackCloseCount, 0);
    assert.equal(closeCount, 3);

    const finalDialog = reopenedAfterStaleConfirmation;
    const finalClearQueueButton = finalDialog.querySelector<HTMLButtonElement>(
      ".ingestion-queue-clear-button"
    );
    assert.ok(finalClearQueueButton);
    clearShouldSucceed = true;
    const clearScrollRestored = waitForPageScrollRestore();
    await React.act(async () => {
      finalClearQueueButton.dispatchEvent(
        new window.Event("click", {
          bubbles: true,
          cancelable: true
        })
      );
      await Promise.resolve();
    });
    assert.equal(finalClearQueueButton.textContent?.trim(), "清空");
    await React.act(async () => {
      finalClearQueueButton.dispatchEvent(
        new window.Event("click", {
          bubbles: true,
          cancelable: true
        })
      );
      await Promise.resolve();
      await clock.advanceBy(499);
      assert.equal(
        document.querySelector("[data-dialog-frame]"),
        finalDialog,
        "最短反馈期限前整队列窗口保持打开"
      );
      await clock.advanceBy(1);
      await Promise.resolve();
    });
    assert.equal(
      prepareCloseCount,
      3,
      "显式 afterClose 必须跳过默认 completed 清理准备"
    );
    assert.equal(finishPreparedCloseCount, 3);
    assert.equal(fallbackCloseCount, 1);
    assert.equal(closeCount, 4);
    assert.equal(
      closeOptions[3]?.skipCompletedCleanup,
      true,
      "整队列清空成功后的关闭不得再追加 completed 清理"
    );
    assert.equal(document.querySelector("[data-dialog-frame]"), null);
    assert.equal(activeElement, returnTarget);
    await clearScrollRestored;

    await React.act(async () => root.unmount());
    client.clear();
  } finally {
    deregisterCssHooks();
    window.HTMLElement.prototype.focus = originalFocus;
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] 内容接入入口只在模态边界接管前锁定页面且五类激活与失败都正确交接", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><button id=opener>打开导入</button><div id=root></div></body></html>"
  );
  const React = await import("react");
  const requestAnimationFrame = (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number;
  const cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  let reduceMotion = true;
  Object.assign(window, {
    requestAnimationFrame,
    cancelAnimationFrame,
    matchMedia: (query: string) => ({
      matches: reduceMotion && query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true
    }),
    scrollTo() {},
    scrollY: 0,
    innerWidth: 1280,
    innerHeight: 720
  });

  let activeElement: HTMLElement | null = null;
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => activeElement
  });
  const originalFocus = window.HTMLElement.prototype.focus;
  const originalBlur = window.HTMLElement.prototype.blur;
  window.HTMLElement.prototype.focus = function focus() {
    activeElement = this;
  };
  window.HTMLElement.prototype.blur = function blur() {
    if (activeElement === this) activeElement = null;
  };

  let fetchCount = 0;
  let storageResponse: Promise<Response> | undefined;
  const fetchStub = async () => {
    fetchCount += 1;
    if (storageResponse) return storageResponse;
    throw new Error("内容接入激活生命周期测试不应发起请求");
  };
  class SilentEventSource {
    static instances = new Set<SilentEventSource>();
    readonly url: string;

    constructor(url: string) {
      this.url = url;
      SilentEventSource.instances.add(this);
    }

    addEventListener() {}

    close() {
      SilentEventSource.instances.delete(this);
    }
  }
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame,
    cancelAnimationFrame,
    fetch: fetchStub,
    EventSource: SilentEventSource,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map(
      (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    )
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { registerHooks } = await import("node:module");
    const cssHooks = registerHooks({
      load(url, context, nextLoad) {
        if (url.endsWith(".css")) {
          return { format: "module", source: "", shortCircuit: true };
        }
        return nextLoad(url, context);
      }
    });
    const [{ Ingestion }, { IngestionLauncher }] = await Promise.all([
      import("../../../../packages/web/src/pages/admin/ingestion/Ingestion.tsx"),
      import("../../../../packages/web/src/pages/admin/ingestion/IngestionLauncher.tsx")
    ]).finally(() => cssHooks.deregister());
    const container = document.getElementById("root");
    const opener = document.getElementById("opener") as HTMLButtonElement;
    assert.ok(container);
    assert.ok(opener);

    const client = new QueryClient({
      defaultOptions: {
        queries: {
          gcTime: Number.POSITIVE_INFINITY,
          retry: false,
          staleTime: Number.POSITIVE_INFINITY,
          refetchOnWindowFocus: false
        }
      }
    });
    client.setQueryData(queryKeys.settings, {
      settings: {
        ingestion: {
          list_page_size: 20,
          max_file_size_mb: 100,
          max_long_edge: 32000
        },
        upload: {
          max_items: 200,
          browser_concurrency: 2
        },
        import: {
          keep_original_link: [],
          auto_import: false,
          max_items: 200
        },
        weibo: { max_items: 10 }
      }
    });
    client.setQueryData(queryKeys.ingestionVocabulary, {
      themes: [],
      tags: [],
      authors: []
    });
    client.setQueryData(queryKeys.storageOptions, {
      backends: [
        {
          slug: "local",
          display_name: "本地存储",
          enabled: true,
          is_default: true
        }
      ]
    });

    function ImportSourceProbe({
      initialMode,
      onClose,
      onSubmit
    }: {
      initialMode: string;
      onClose: () => void;
      onSubmit: (submission: unknown) => void;
    }) {
      return React.createElement(
        "div",
        { "data-import-source-mode": initialMode },
        initialMode === "jsonl"
          ? React.createElement(
              "button",
              {
                type: "button",
                "data-submit-jsonl-error": true,
                onClick() {
                  onSubmit({
                    mode: "jsonl",
                    manifest: {
                      items: [],
                      errors: [
                        {
                          line: 7,
                          raw: "invalid jsonl row",
                          error: "受控清单错误"
                        }
                      ]
                    }
                  });
                  onClose();
                }
              },
              "提交错误清单"
            )
          : null
      );
    }

    const opened: number[] = [];
    const settled: number[] = [];
    const loadErrors: unknown[] = [];
    let rejectSourceLoad = false;
    const loadImportSourceModule = async () => {
      if (rejectSourceLoad) throw new Error("controlled source load failure");
      return { ImportSourceDialog: ImportSourceProbe } as never;
    };
    const root = createRoot(container);
    const renderActivation = async (
      sequence: number,
      kind: "workflow" | "files" | "urls" | "jsonl" | "weibo"
    ) => {
      await React.act(async () => {
        root.render(
          React.createElement(
            QueryClientProvider,
            { client },
            React.createElement(Ingestion, {
              settings: client.getQueryData<{
                settings: Parameters<typeof Ingestion>[0]["settings"];
              }>(queryKeys.settings)!.settings,
              activation: { sequence, kind, opener },
              activationEnabled: true,
              loadImportSourceModule,
              onActivationOpened: (openedSequence) => {
                opened.push(openedSequence);
              },
              onActivationSettled: (settledSequence) => {
                settled.push(settledSequence);
              },
              onDone() {},
              onLoadError: (error) => loadErrors.push(error)
            })
          )
        );
        await Promise.resolve();
      });
    };
    const waitFor = async (condition: () => boolean, message: string) => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        if (condition()) return;
      }
      assert.fail(message);
    };

    const activationKinds = [
      "workflow",
      "files",
      "urls",
      "jsonl",
      "weibo"
    ] as const;
    for (const [index, kind] of activationKinds.entries()) {
      const sequence = index + 1;
      await renderActivation(sequence, kind);
      await waitFor(
        () => document.querySelector("[data-dialog-frame]") !== null,
        `${kind} 激活后未打开工作流`
      );
      assert.equal(
        SilentEventSource.instances.size,
        1,
        `${kind} 显示时只能订阅当前队列`
      );
      assert.equal(
        opened.filter((item) => item === sequence).length,
        1,
        `${kind} 工作流挂载后必须恰好交接一次模态权威`
      );
      assert.equal(
        settled.includes(sequence),
        false,
        `${kind} 打开后仍应保留活动意图直到工作流关闭`
      );
      if (kind === "urls" || kind === "jsonl" || kind === "weibo") {
        assert.equal(
          document
            .querySelector("[data-import-source-mode]")
            ?.getAttribute("data-import-source-mode"),
          kind
        );
      }
      if (kind === "jsonl") {
        const submitJsonlError = document.querySelector<HTMLButtonElement>(
          "[data-submit-jsonl-error]"
        );
        assert.ok(submitJsonlError);
        await React.act(async () => {
          submitJsonlError.dispatchEvent(
            new window.Event("click", {
              bubbles: true,
              cancelable: true
            })
          );
          await Promise.resolve();
        });
        await waitFor(
          () =>
            (document.querySelector("[data-dialog-frame]")?.textContent ?? "").includes(
              "1 行未创建任务"
            ),
          "JSONL 行级错误未进入 import owner"
        );
      }
      if (kind === "weibo") {
        assert.match(
          document.querySelector("[data-dialog-frame]")?.textContent ?? "",
          /1 行未创建任务/u,
          "关闭并重开 import owner 后必须保留 JSONL 行级错误"
        );
      }

      const defaultTags = document.querySelector<HTMLInputElement>("input[aria-label='默认标签']");
      assert.ok(defaultTags);
      assert.equal(
        document.querySelector(".ingestion-defaults .tag-chip"),
        null,
        `${kind} 重开主窗口时默认标签必须清空`
      );
      await React.act(async () => {
        defaultTags.value = `preset-${kind}`;
        defaultTags.dispatchEvent(new window.Event("focusout", { bubbles: true }));
        await Promise.resolve();
      });
      assert.equal(
        document.querySelector(".ingestion-defaults .tag-chip")?.textContent,
        `preset-${kind}`,
        "离开默认标签输入框应提交当前默认值"
      );

      const closeButton = document.querySelector<HTMLButtonElement>(".ingestion-close-button");
      assert.ok(closeButton);
      await React.act(async () => {
        closeButton.dispatchEvent(
          new window.Event("click", {
            bubbles: true,
            cancelable: true
          })
        );
        await Promise.resolve();
      });
      await waitFor(
        () => settled.includes(sequence),
        `${kind} 关闭后未释放页面锁`
      );
      assert.equal(document.querySelector("[data-dialog-frame]"), null);
      assert.equal(
        SilentEventSource.instances.size,
        0,
        `${kind} 隐藏后必须关闭当前队列订阅`
      );
      assert.equal(
        settled.filter((item) => item === sequence).length,
        1,
        `${kind} 页面锁只能释放一次`
      );
    }

    rejectSourceLoad = true;
    await renderActivation(activationKinds.length + 1, "weibo");
    await waitFor(
      () => settled.includes(activationKinds.length + 1),
      "来源模块加载失败后未退休活动意图"
    );
    assert.equal(
      opened.includes(activationKinds.length + 1),
      false,
      "来源模块加载失败时不得虚构已经取得的模态权威"
    );
    assert.equal(loadErrors.length, 1);
    assert.equal(document.querySelector("[data-dialog-frame]"), null);
    assert.equal(fetchCount, 0);

    reduceMotion = false;
    let backgroundEditClicks = 0;
    let rejectLauncherWorkflowLoad = false;
    const launcherModuleLoaders = {
      ingestion: async () => {
        await Promise.resolve();
        if (rejectLauncherWorkflowLoad) {
          throw new Error("controlled launcher workflow load failure");
        }
        return { Ingestion } as never;
      },
      importSource: loadImportSourceModule
    };
    function LauncherHarness() {
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "button",
          {
            id: "background-single-image-edit",
            type: "button",
            onClick: () => {
              backgroundEditClicks += 1;
            }
          },
          "编辑图片"
        ),
        React.createElement(IngestionLauncher, {
          settings: client.getQueryData<{
            settings: Parameters<typeof IngestionLauncher>[0]["settings"];
          }>(queryKeys.settings)!.settings,
          showTriggers: true,
          disabled: false,
          onDone() {},
          onLoadError: (error) => loadErrors.push(error),
          moduleLoaders: launcherModuleLoaders
        })
      );
    }
    await React.act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(LauncherHarness)
        )
      );
      await Promise.resolve();
    });
    const uploadTrigger = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("上传图片")
    );
    assert.ok(uploadTrigger);
    client.removeQueries({ queryKey: queryKeys.storageOptions });
    let resolveStorage!: (response: Response) => void;
    storageResponse = new Promise((resolve) => {
      resolveStorage = resolve;
    });
    React.act(() => {
      uploadTrigger.dispatchEvent(
        new window.Event("click", {
          bubbles: true,
          cancelable: true
        })
      );
    });
    assert.equal(
      document.querySelector("[data-dialog-frame]"),
      null,
      "同步点击阶段仍应覆盖按需模块尚未挂载弹窗的窗口"
    );
    assert.equal(
      container.inert,
      true,
      "按需模块尚未挂载弹窗时必须先取得页面根交互锁"
    );
    assert.equal(
      (document.getElementById("background-single-image-edit") as HTMLButtonElement).disabled,
      false,
      "启动互斥不得再提交背景按钮的禁用外观"
    );
    assert.equal(
      uploadTrigger.disabled,
      false,
      "被点击的内容接入入口也不得闪现禁用态"
    );
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(fetchCount, 1, "首次打开只请求一次共享存储选项");
    assert.equal(
      document.querySelector("[data-dialog-frame]"),
      null,
      "存储尚未返回时不能提前打开工作流并采用临时 local"
    );
    await React.act(async () =>
      resolveStorage(
        Response.json({
          backends: [
            {
              slug: "cos",
              display_name: "COS",
              enabled: true,
              is_default: true
            }
          ]
        })
      )
    );
    await waitFor(
      () => document.querySelector("[data-dialog-frame]") !== null,
      "工作流挂载后未把启动锁交给模态边界"
    );
    assert.equal(fetchCount, 1, "工作流挂载复用同一查询，不重复加载存储");
    assert.match(document.querySelector('[aria-label="新任务存储位置"]')?.textContent ?? "", /COS/);
    const backgroundEdit = document.getElementById(
      "background-single-image-edit"
    ) as HTMLButtonElement;
    assert.equal(
      backgroundEdit.disabled,
      false,
      "弹窗显示期间背景按钮不应继续呈现为业务禁用"
    );
    assert.equal(
      container.inert,
      true,
      "按钮恢复正常外观后，页面仍必须由模态边界统一设为 inert"
    );
    assert.equal(
      uploadTrigger.disabled,
      false,
      "入口按钮也不得在半透明遮罩后持续显示禁用态"
    );

    const launcherCloseButton =
      document.querySelector<HTMLButtonElement>(".ingestion-close-button");
    assert.ok(launcherCloseButton);
    await React.act(async () => {
      launcherCloseButton.dispatchEvent(
        new window.Event("click", {
          bubbles: true,
          cancelable: true
        })
      );
      await Promise.resolve();
    });
    const closingFrame = document.querySelector<HTMLElement>("[data-dialog-frame]");
    assert.ok(closingFrame);
    assert.equal(closingFrame.classList.contains("is-closing"), true);
    assert.equal(backgroundEdit.disabled, false);
    assert.equal(
      container.inert,
      true,
      "淡出期间仍由现存 DialogFrame 阻止底层操作"
    );
    await React.act(async () => {
      closingFrame.dispatchEvent(
        new window.Event("animationend", {
          bubbles: true
        })
      );
      await Promise.resolve();
    });
    assert.equal(document.querySelector("[data-dialog-frame]"), null);
    assert.notEqual(container.inert, true);
    await React.act(async () => {
      backgroundEdit.dispatchEvent(
        new window.Event("click", {
          bubbles: true,
          cancelable: true
        })
      );
      await Promise.resolve();
    });
    assert.equal(
      backgroundEditClicks,
      1,
      "弹窗卸载后的首次单图编辑操作必须立即生效"
    );
    await waitFor(
      () => !document.documentElement.classList.contains("page-scroll-restoring"),
      "弹窗关闭后的页面滚动位置未完成恢复"
    );

    const loadErrorCountBeforeLauncherFailure = loadErrors.length;
    rejectLauncherWorkflowLoad = true;
    uploadTrigger.focus();
    React.act(() => {
      uploadTrigger.dispatchEvent(
        new window.Event("click", {
          bubbles: true,
          cancelable: true
        })
      );
    });
    assert.equal(container.inert, true);
    assert.equal(
      activeElement,
      null,
      "启动根锁应先把焦点移出即将 inert 的页面"
    );
    await waitFor(
      () => loadErrors.length === loadErrorCountBeforeLauncherFailure + 1
        && !container.inert,
      "Launcher 加载失败后未解除页面根锁"
    );
    assert.equal(document.querySelector("[data-dialog-frame]"), null);
    assert.equal(
      activeElement,
      uploadTrigger,
      "未挂载弹窗的加载失败必须在根锁清理后归焦启动入口"
    );
    await waitFor(
      () => !document.documentElement.classList.contains("page-scroll-restoring"),
      "Launcher 加载失败后的页面滚动位置未完成恢复"
    );

    rejectLauncherWorkflowLoad = false;
    client.removeQueries({ queryKey: queryKeys.storageOptions });
    storageResponse = Promise.resolve(Response.json({ error: "存储查询失败" }, { status: 403 }));
    const errorsBeforeStorageFailure = loadErrors.length;
    await React.act(async () => uploadTrigger.click());
    await waitFor(
      () => loadErrors.length === errorsBeforeStorageFailure + 1 && !container.inert,
      "存储查询失败必须释放入口锁并允许重试"
    );
    assert.equal(document.querySelector("[data-dialog-frame]"), null);
    assert.equal(activeElement, uploadTrigger);
    storageResponse = Promise.resolve(
      Response.json({
        backends: [
          {
            slug: "cos",
            display_name: "COS",
            enabled: true,
            is_default: true
          }
        ]
      })
    );
    await React.act(async () => uploadTrigger.click());
    await waitFor(
      () => document.querySelector("[data-dialog-frame]") !== null,
      "存储查询失败后重试应打开工作流"
    );

    await React.act(async () => root.unmount());
    await waitFor(
      () => !document.documentElement.classList.contains("page-scroll-restoring"),
      "最终卸载应先完成页面滚动恢复，再释放测试 DOM"
    );
    client.clear();
  } finally {
    window.HTMLElement.prototype.focus = originalFocus;
    window.HTMLElement.prototype.blur = originalBlur;
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] 导入组合按钮共同预载且来源选择在菜单退场前取得页面启动锁", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  Object.assign(window, {
    matchMedia: (query: string) => ({
      matches: query.includes("min-width"),
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true
    }),
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0) as unknown as number,
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    innerWidth: 1280,
    innerHeight: 720
  });
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    ResizeObserver: TestResizeObserver,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map(
      (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    )
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    const { createRoot } = await import("react-dom/client");
    const { registerHooks } = await import("node:module");
    const cssHooks = registerHooks({
      load(url, context, nextLoad) {
        if (url.endsWith(".css")) {
          return { format: "module", source: "", shortCircuit: true };
        }
        return nextLoad(url, context);
      }
    });
    const { IngestionTriggers } =
      await import("../../../../packages/web/src/pages/admin/ingestion/IngestionTriggers.tsx").finally(
        () => cssHooks.deregister()
      );
    const container = document.getElementById("root");
    assert.ok(container);
    let workflowPreloads = 0;
    let sourcePreloads = 0;
    let sourceActivations = 0;
    function Harness() {
      return React.createElement(IngestionTriggers, {
        pending: false,
        onPreloadWorkflow: () => {
          workflowPreloads += 1;
        },
        onPreloadImportSource: () => {
          sourcePreloads += 1;
        },
        onOpenWorkflow() {},
        onOpenUrls() {
          sourceActivations += 1;
        },
        onOpenJsonl() {},
        onOpenWeibo() {},
        onOpenFiles() {}
      });
    }
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    const mainButton = container.querySelector<HTMLButtonElement>(".import-source-main");
    const menuButton = container.querySelector<HTMLButtonElement>('[aria-label="更多导入方式"]');
    const uploadButton = [
      ...container.querySelectorAll<HTMLButtonElement>(".ingestion-trigger")
    ].find((button) => button.textContent?.includes("上传图片"));
    assert.ok(mainButton);
    assert.ok(menuButton);
    assert.ok(uploadButton);
    const dispatch = async (
      target: HTMLElement,
      type: string,
      pointerType?: string
    ) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      if (pointerType) {
        Object.defineProperty(event, "pointerType", { value: pointerType });
      }
      await React.act(async () => {
        target.dispatchEvent(event);
        await Promise.resolve();
      });
    };

    await dispatch(mainButton, "pointerover", "mouse");
    assert.deepEqual(
      { workflowPreloads, sourcePreloads },
      { workflowPreloads: 1, sourcePreloads: 1 }
    );
    await dispatch(menuButton, "focusin");
    assert.deepEqual(
      { workflowPreloads, sourcePreloads },
      { workflowPreloads: 2, sourcePreloads: 2 }
    );
    await dispatch(mainButton, "pointerdown", "touch");
    assert.deepEqual(
      { workflowPreloads, sourcePreloads },
      { workflowPreloads: 3, sourcePreloads: 3 }
    );
    await dispatch(uploadButton, "focusin");
    assert.deepEqual(
      { workflowPreloads, sourcePreloads },
      { workflowPreloads: 4, sourcePreloads: 3 }
    );

    await dispatch(menuButton, "click");
    const urlItem = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (button) => button.textContent?.includes("链接导入")
    );
    assert.ok(urlItem);
    await dispatch(urlItem, "click");
    assert.equal(
      sourceActivations,
      1,
      "来源激活不得延迟到菜单退出动画完成后"
    );
    const closingMenu = document.querySelector<HTMLElement>(
      '[role="menu"][aria-label="更多导入方式"].is-closing'
    );
    assert.ok(closingMenu);
    await dispatch(closingMenu, "animationend");
    assert.equal(sourceActivations, 1, "菜单退场不得重复触发来源激活");

    await React.act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
