import "../../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseHTML
} from "linkedom";
import {
  ingestionActionScopeHeader,
  ingestionSnapshotPath,
  ingestionStatusPath,
  type IngestionQueueActionResultDto,
  type IngestionQueueSummaryDto
} from "../../../../packages/shared/src/browser.ts";
import {
  queryKeys
} from "../../../../packages/web/src/lib/api/query-keys.ts";
import {
  ingestionJob,
  adminImageListItem
} from "../../support/web-test-context.ts";
import {
  installControlledClock
} from "../../support/controlled-clock.ts";

const selectedQueueScenario = process.env.IMAGESHOW_WEB_QUEUE_SCENARIO;
const queueScenarioIds = new Set([
  "strict-mode",
  "empty-reconnect",
  "reconnect-pagination",
  "handoff-completion"
]);
assert.ok(
  !selectedQueueScenario || queueScenarioIds.has(selectedQueueScenario),
  `未知 Web 队列场景：${selectedQueueScenario}`
);

test("[Web/内容接入] Server 内容接入队列 Hook 在重连与任意分页时只保留一个 SSE 和当前页基线", async (t) => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=strict-root></div>"
      + "<div id=empty-root></div><div id=root></div>"
      + "<div id=owner-root></div></body></html>"
  );
  const clock = installControlledClock(t, window as unknown as Window, {
    minimumControlledDelayMs: 100,
    includeGlobalTimers: true,
    includeDateNow: false
  });
  const React = await import("react");
  const revokedObjectUrls: string[] = [];
  const NativeURL = globalThis.URL;
  class TrackingURL extends NativeURL {
    static override revokeObjectURL(url: string) {
      revokedObjectUrls.push(url);
    }
  }
  class ControlledEventSource {
    static all: ControlledEventSource[] = [];
    static active = new Set<ControlledEventSource>();
    readonly url: string;
    readonly listeners = new Map<
      string,
      Set<EventListenerOrEventListenerObject>
    >();
    closed = false;

    constructor(url: string) {
      this.url = url;
      ControlledEventSource.all.push(this);
      ControlledEventSource.active.add(this);
    }

    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject
    ) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject
    ) {
      this.listeners.get(type)?.delete(listener);
    }

    emit(type: string, payload: unknown) {
      const event = {
        type,
        data: JSON.stringify(payload)
      } as unknown as Event;
      for (const listener of this.listeners.get(type) ?? []) {
        if (typeof listener === "function") {
          listener.call(this, event);
        } else {
          listener.handleEvent(event);
        }
      }
    }

    close() {
      this.closed = true;
      ControlledEventSource.active.delete(this);
    }
  }
  type PendingSnapshot = {
    url: string;
    init: RequestInit;
    aborted: boolean;
    resolved: boolean;
    resolve: (response: Response) => void;
  };
  const requests: PendingSnapshot[] = [];
  const fetchStub = (input: RequestInfo | URL, init: RequestInit = {}) => (
    new Promise<Response>((resolve, reject) => {
      let settled = false;
      const request: PendingSnapshot = {
        url: String(input),
        init,
        aborted: false,
        resolved: false,
        resolve(response) {
          if (settled) return;
          settled = true;
          request.resolved = true;
          resolve(response);
        }
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        request.aborted = true;
        reject(new Error("snapshot aborted"));
      };
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener("abort", abort, { once: true });
      requests.push(request);
    })
  );
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
    fetch: fetchStub,
    EventSource: ControlledEventSource,
    URL: TrackingURL,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
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
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const { useServerIngestionQueue } = await import(
      "../../../../packages/web/src/pages/admin/ingestion/queue/useServerIngestionQueue.ts"
    );
    const { useIngestionQueue } = await import(
      "../../../../packages/web/src/pages/admin/ingestion/queue/useIngestionQueue.ts"
    );
    const sessionId = "S".repeat(43);
    const imageId = "00000000-0000-7009-8000-00000000008e";
    const summary = {
      total: 60,
      unfinished: 59,
      waiting: 1,
      running: 0,
      ready: 0,
      duplicate_pending: 0,
      committing: 2,
      resolving: 3,
      completed: 1,
      failed: 0
    };
    const serverItem = (
      status: "queued" | "preparing" | "ready",
      version: number,
      acceptedOrder: number,
      itemImageId = imageId
    ) => ({
      session_id: sessionId,
      image_id: itemImageId,
      queue: "upload" as const,
      source_type: "upload" as const,
      resolved_image_time: "2026-08-23T01:02:03.456Z",
      status,
      phase: status,
      message: status,
      ...(status === "preparing" ? { progress: 55 } : {}),
      version,
      progress_seq: 0,
      last_semantic_revision: version + 6,
      accepted_order: acceptedOrder,
      metadata: ingestionJob().draft,
      storage_slug: "local"
    });
    let refreshProbe: (() => void) | undefined;
    let recoverAuthorityProbe: (() => Promise<void>) | undefined;
    let recoverAfterSuccessfulActionProbe: (() => Promise<void>) | undefined;
    let ensureRevisionProbe: ((
      revision?: number,
      connectionGeneration?: number
    ) => void) | undefined;
    const probeCompletedObservations: string[] = [];
    const probeServerItemObservations: Array<{
      imageId: string;
      status: string;
      version: number;
    }> = [];
    function Probe(props: Readonly<{
      enabled: boolean;
      displayed?: boolean;
      offset: number;
      limit?: number;
      selectionPair?: { session_id: string; image_id: string };
    }>) {
      const selection = props.selectionPair ? [props.selectionPair] : [];
      const view = useServerIngestionQueue({
        enabled: props.enabled,
        displayed: props.displayed ?? true,
        queue: "upload",
        offset: props.offset,
        limit: props.limit ?? 20,
        requiredItems: props.limit ?? 20,
        excludeItems: selection,
        includeItems: selection,
        onCompletedIngestions: (entries) => {
          probeCompletedObservations.push(...entries.map(
            ({ pair }) => pair.image_id
          ));
        },
        onServerIngestionItem: (item) => {
          probeServerItemObservations.push({
            imageId: item.image_id,
            status: item.status,
            version: item.version
          });
        }
      });
      refreshProbe = view.refresh;
      recoverAuthorityProbe = view.recoverAuthority;
      recoverAfterSuccessfulActionProbe = view.recoverAfterSuccessfulAction;
      ensureRevisionProbe = view.ensureRevision;
      return React.createElement("output", null, JSON.stringify({
        status: view.status,
        generation: view.connectionGeneration,
        actionScope: view.actionScope,
        revision: view.revision,
        total: view.summary?.total ?? null,
        items: view.items.map((item) => ({
          id: item.image_id,
          status: item.status,
          version: item.version
        })),
        watermark: view.actionWatermark,
        error: view.error
      }));
    }
    let setOwnerPage: ((page: number) => void) | undefined;
    let refreshOwner: (() => void) | undefined;
    let recoverOwnerAfterSuccessfulAction: ((
      result: IngestionQueueActionResultDto
    ) => Promise<void>) | undefined;
    let projectOwnerCompletedCleanupBatch: ((
      result: IngestionQueueActionResultDto
    ) => number) | undefined;
    let markOwnerCompletedBrowserOwned: ((imageId: string) => void) | undefined;
    let bindOwnerHandoff: ((revision: number) => void) | undefined;
    let prepareUnknownCompletedHandoff: (() => void) | undefined;
    let bindUnknownCompletedHandoff: (() => void) | undefined;
    let bindCoveredCompletedHandoff: (() => void) | undefined;
    let bindCrossGenerationCompletedCoverage: (() => void) | undefined;
    let bindCrossGenerationPresent: (() => void) | undefined;
    let bindCrossGenerationAccepted: (() => void) | undefined;
    let releaseCrossGenerationHydrated: (() => void) | undefined;
    let bindReleaseRaceHandoff: (() => void) | undefined;
    let releaseRaceHandoff: (() => void) | undefined;
    let releaseMountedFinalized: (() => void) | undefined;
    let bindIncarnationReplacement: (() => void) | undefined;
    let releaseIncarnationReplacement: (() => void) | undefined;
    let bindReconnectAcceptedOwners: (() => void) | undefined;
    let bindLoadingAcceptedOwner: ((requestGeneration: number) => void)
      | undefined;
    let prepareVisibleReadyRelease: (() => void) | undefined;
    let releaseVisibleReady: ((
      imageId?: string,
      release?: Readonly<{
        revision: number;
        summary: IngestionQueueSummaryDto;
      }>
    ) => void) | undefined;
    let visibleReadyReleaseBeforeIds: string[] = [];
    let visibleReadyReleaseAfterIds: string[] = [];
    let observeOwnerCompleted: ((
      pair: { session_id: string; image_id: string },
      item: ReturnType<typeof adminImageListItem>
    ) => void) | undefined;
    let prepareOffPageCompletionBatch: (() => void) | undefined;
    let releaseRaceReleased = false;
    const handoffSessionId = "H".repeat(43);
    const handoffImageId = "00000000-0000-7011-8000-00000000008e";
    const unknownSessionId = "U".repeat(43);
    const unknownImageId = "00000000-0000-7013-8000-00000000008e";
    const unknownPlaceholderId = "owner-unknown-completed-placeholder-0";
    const coveredSessionId = "V".repeat(43);
    const coveredImageId = "00000000-0000-7014-8000-00000000008e";
    const crossGenerationCompletedSessionId = "Q".repeat(43);
    const crossGenerationCompletedImageId =
      "00000000-0000-7019-8000-00000000008e";
    const crossGenerationPresentSessionId = "P".repeat(43);
    const crossGenerationPresentImageId =
      "00000000-0000-7018-8000-00000000008e";
    const crossGenerationSessionId = "W".repeat(43);
    const crossGenerationImageId = "00000000-0000-7015-8000-00000000008e";
    const releaseRaceSessionId = "X".repeat(43);
    const releaseRaceImageId = "00000000-0000-7016-8000-00000000008e";
    const releaseRacePlaceholderId = "owner-release-race-placeholder";
    const releaseRaceAttemptKey = "owner-release-race-attempt";
    const mountedReleaseSessionId = "Y".repeat(43);
    const mountedReleaseImageId = "00000000-0000-7017-8000-00000000008e";
    const incarnationSessionId = "I".repeat(43);
    const oldIncarnationImageId = "00000000-0000-7028-8000-00000000008e";
    const nextIncarnationImageId = "00000000-0000-7029-8000-00000000008e";
    const nextIncarnationPlaceholderId = "owner-next-incarnation-placeholder";
    const nextIncarnationAttemptKey = "owner-next-incarnation-attempt";
    const reconnectVisibleSessionId = "J".repeat(43);
    const reconnectVisibleImageId = "00000000-0000-7038-8000-00000000008e";
    const reconnectOffPageSessionId = "K".repeat(43);
    const reconnectOffPageImageId = "00000000-0000-7039-8000-00000000008e";
    const loadingAcceptedSessionId = "L".repeat(43);
    const visibleReadyReleaseImageIds = [
      "00000000-0000-703f-8000-00000000008e",
      "00000000-0000-7040-8000-00000000008e",
      "00000000-0000-7041-8000-00000000008e",
      "00000000-0000-7042-8000-00000000008e",
      "00000000-0000-7043-8000-00000000008e",
      "00000000-0000-7044-8000-00000000008e",
      "00000000-0000-7045-8000-00000000008e"
    ] as const;
    const loadingAcceptedImageId = visibleReadyReleaseImageIds[0];
    const visibleReadyReleaseTargetImageId = visibleReadyReleaseImageIds[4];
    const visibleReadyReleaseSessionIds = visibleReadyReleaseImageIds.map(
      (_imageId, index) => index === 0
        ? loadingAcceptedSessionId
        : String(index).repeat(43)
    );
    const readyReleaseSummary: IngestionQueueSummaryDto = {
      total: 1,
      unfinished: 1,
      waiting: 0,
      running: 0,
      ready: 1,
      duplicate_pending: 0,
      committing: 0,
      resolving: 0,
      completed: 0,
      failed: 0
    };
    const offPageCompletionSessionIds = Array.from(
      { length: 23 },
      (_, index) => String(index).padStart(43, "C")
    );
    const offPageCompletionImageIds = Array.from(
      { length: 23 },
      (_, index) => (
        `019f8457-063a-7${index.toString(16).padStart(3, "0")}`
          + "-b580-00000000008e"
      )
    );
    const compactChunkFailureSessionIds = Array.from(
      { length: 102 },
      (_, index) => index.toString(36).padStart(43, "Z")
    );
    const compactChunkFailureImageIds = Array.from(
      { length: 102 },
      (_, index) => (
        `019f8457-063a-7${index.toString(16).padStart(3, "0")}`
          + "-c580-00000000008e"
      )
    );
    function OwnerProbe(props: Readonly<{ displayed: boolean }>) {
      const queue = useIngestionQueue(20, "upload", props.displayed);
      refreshOwner = queue.server.refresh;
      recoverOwnerAfterSuccessfulAction = queue.recoverAfterSuccessfulAction;
      projectOwnerCompletedCleanupBatch = queue.projectCompletedCleanupBatch;
      markOwnerCompletedBrowserOwned = (imageId) => {
        const job = queue.jobsRef.current.find((item) => (
          item.imageId === imageId
        ));
        assert.ok(job);
        queue.updateJob(job.id, {
          serverAccepted: false,
          batchKey: "owner-completed-browser-batch",
          batchPosition: 0,
          browserDisplayReleased: false
        });
      };
      observeOwnerCompleted = (pair, item) => {
        queue.observeCompletedIngestions([{ pair, item }]);
      };
      prepareOffPageCompletionBatch = () => {
        queue.appendJobs(offPageCompletionImageIds.map((imageId, index) => (
          ingestionJob({
            id: `owner-off-page-completion-${index}`,
            attemptKey: `owner-off-page-completion-attempt-${index}`,
            batchKey: "owner-off-page-completion-batch",
            batchPosition: index,
            kind: "upload",
            sessionId: offPageCompletionSessionIds[index],
            imageId,
            serverAccepted: true,
            serverAcceptedOrder: 20 + index,
            serverVersion: 5,
            serverProgressSeq: 0,
            serverSemanticRevision: 8,
            serverStatus: "committing",
            serverPhase: "committing",
            status: "committing",
            ...(index === 22 ? {
              preview: "blob:off-page-completion-preview",
              objectUrl: "blob:off-page-completion-preview"
            } : {})
          })
        )));
      };
      setOwnerPage = (page) => queue.setPage(page);
      bindOwnerHandoff = (revision) => {
        const placeholder = ingestionJob({
          id: "owner-handoff-placeholder",
          attemptKey: "owner-handoff-attempt",
          batchKey: "owner-handoff-batch",
          kind: "upload",
          status: "received",
          sessionId: undefined,
          imageId: undefined,
          serverAccepted: false
        });
        queue.appendJobs([placeholder]);
        queue.producerApi.bindServerJob(placeholder.id, {
          sessionId: handoffSessionId,
          imageId: handoffImageId,
          serverAccepted: true,
          serverVersion: 2,
          serverSemanticRevision: revision,
          serverHandoffPending: true,
          serverHandoffRevision: revision,
          status: "received",
          message: "服务器已接管上传任务"
        }, queue.server.connectionGeneration, 61);
      };
      prepareUnknownCompletedHandoff = () => {
        queue.appendJobs(Array.from({ length: 61 }, (_, index) => ingestionJob({
          id: `owner-unknown-completed-placeholder-${index}`,
          attemptKey: `owner-unknown-completed-attempt-${index}`,
          batchKey: "owner-unknown-completed-batch",
          kind: "upload",
          status: "received",
          sessionId: undefined,
          imageId: undefined,
          serverAccepted: false
        })));
      };
      bindUnknownCompletedHandoff = () => {
        const placeholder = queue.jobsRef.current.find(
          (job) => job.id === unknownPlaceholderId
        );
        assert.ok(placeholder);
        queue.producerApi.bindServerJob(placeholder.id, {
          sessionId: unknownSessionId,
          imageId: unknownImageId,
          serverAccepted: true,
          serverHandoffPending: true,
          serverHandoffRevision: undefined,
          status: "finalized",
          resultState: "recovering",
          message: "图片已写入图库，正在读取结果"
        }, queue.server.connectionGeneration, 62);
      };
      bindCoveredCompletedHandoff = () => {
        const placeholder = ingestionJob({
          id: "owner-covered-completed-placeholder",
          attemptKey: "owner-covered-completed-attempt",
          batchKey: "owner-covered-completed-batch",
          kind: "upload",
          status: "received"
        });
        queue.appendJobs([placeholder]);
        queue.setPage(3);
        queue.producerApi.bindServerJob(placeholder.id, {
          sessionId: coveredSessionId,
          imageId: coveredImageId,
          serverAccepted: true,
          serverHandoffPending: true,
          serverHandoffRevision: undefined,
          status: "finalized",
          resultState: "recovering",
          message: "图片已写入图库，正在读取结果"
        }, queue.server.connectionGeneration, 1);
      };
      bindCrossGenerationCompletedCoverage = () => {
        queue.clearJobIds(new Set(queue.localJobs.map((job) => job.id)));
        const placeholders = Array.from({ length: 61 }, (_, index) => ingestionJob({
          id: index === 40
            ? "owner-cross-generation-completed-placeholder"
            : `owner-cross-generation-completed-fill-${index}`,
          attemptKey: index === 40
            ? "owner-cross-generation-completed-attempt"
            : `owner-cross-generation-completed-fill-attempt-${index}`,
          batchKey: "owner-cross-generation-completed-batch",
          kind: "upload",
          status: "received"
        }));
        queue.appendJobs(placeholders);
        queue.setPage(3);
        queue.producerApi.bindServerJob("owner-cross-generation-completed-placeholder", {
          sessionId: crossGenerationCompletedSessionId,
          imageId: crossGenerationCompletedImageId,
          serverAccepted: true,
          serverVersion: 2,
          serverHandoffPending: true,
          serverHandoffRevision: undefined,
          status: "finalized",
          resultState: "recovering",
          message: "图片已写入图库，正在读取结果"
        }, null, 4);
      };
      bindCrossGenerationPresent = () => {
        queue.clearJobIds(new Set(queue.localJobs.map((job) => job.id)));
        const placeholders = Array.from({ length: 61 }, (_, index) => ingestionJob({
          id: index === 40
            ? "owner-cross-generation-present-placeholder"
            : `owner-cross-generation-present-fill-${index}`,
          attemptKey: index === 40
            ? "owner-cross-generation-present-attempt"
            : `owner-cross-generation-present-fill-attempt-${index}`,
          batchKey: "owner-cross-generation-present-batch",
          kind: "upload",
          status: "received"
        }));
        queue.appendJobs(placeholders);
        queue.setPage(3);
        queue.producerApi.bindServerJob("owner-cross-generation-present-placeholder", {
          sessionId: crossGenerationPresentSessionId,
          imageId: crossGenerationPresentImageId,
          serverAccepted: true,
          serverVersion: 1,
          serverSemanticRevision: 1,
          serverHandoffPending: true,
          serverHandoffRevision: 1,
          status: "received",
          message: "服务器已接管上传任务"
        }, null, 5);
      };
      bindCrossGenerationAccepted = () => {
        queue.clearJobIds(new Set(queue.localJobs.map((job) => job.id)));
        const placeholders = Array.from({ length: 61 }, (_, index) => ingestionJob({
          id: index === 40
            ? "owner-cross-generation-placeholder"
            : `owner-cross-generation-fill-${index}`,
          attemptKey: index === 40
            ? "owner-cross-generation-attempt"
            : `owner-cross-generation-fill-attempt-${index}`,
          batchKey: "owner-cross-generation-batch",
          kind: "upload",
          status: "received",
          ...(index === 40 ? {
            preview: "blob:cross-generation-visible",
            objectUrl: "blob:cross-generation-visible"
          } : {})
        }));
        queue.appendJobs(placeholders);
        queue.setPage(3);
        queue.producerApi.bindServerJob("owner-cross-generation-placeholder", {
          sessionId: crossGenerationSessionId,
          imageId: crossGenerationImageId,
          serverAccepted: true,
          serverVersion: 1,
          serverSemanticRevision: 1,
          serverHandoffPending: true,
          serverHandoffRevision: 1,
          status: "received",
          message: "服务器已接管上传任务"
        }, null, 2);
      };
      releaseCrossGenerationHydrated = () => {
        releaseRaceReleased = queue.releaseResolvedServerJobs([{
          id: "owner-cross-generation-placeholder",
          attemptKey: "owner-cross-generation-attempt",
          pair: {
            session_id: crossGenerationSessionId,
            image_id: crossGenerationImageId
          }
        }]).has("owner-cross-generation-placeholder");
      };
      bindReleaseRaceHandoff = () => {
        queue.clearJobIds(new Set(queue.localJobs.map((job) => job.id)));
        const placeholders = Array.from({ length: 21 }, (_, index) => ingestionJob({
          id: index === 20
            ? releaseRacePlaceholderId
            : `owner-release-race-fill-${index}`,
          attemptKey: index === 20
            ? releaseRaceAttemptKey
            : `owner-release-race-fill-attempt-${index}`,
          batchKey: "owner-release-race-batch",
          kind: "upload",
          status: "received"
        }));
        queue.appendJobs(placeholders);
        queue.producerApi.bindServerJob(releaseRacePlaceholderId, {
          sessionId: releaseRaceSessionId,
          imageId: releaseRaceImageId,
          serverAccepted: true,
          serverHandoffPending: true,
          serverHandoffRevision: undefined,
          status: "finalized",
          resultState: "recovering",
          message: "图片已写入图库，正在读取结果"
        }, queue.server.connectionGeneration, 3);
      };
      releaseRaceHandoff = () => {
        releaseRaceReleased = queue.releaseResolvedServerJobs([{
          id: releaseRacePlaceholderId,
          attemptKey: releaseRaceAttemptKey,
          pair: {
            session_id: releaseRaceSessionId,
            image_id: releaseRaceImageId
          }
        }]).has(releaseRacePlaceholderId);
      };
      releaseMountedFinalized = () => {
        queue.clearJobIds(new Set(queue.localJobs.map((job) => job.id)));
        const placeholder = ingestionJob({
          id: "owner-mounted-release-placeholder",
          attemptKey: "owner-mounted-release-attempt",
          batchKey: "owner-mounted-release-batch",
          kind: "upload",
          status: "received"
        });
        queue.appendJobs([placeholder]);
        queue.producerApi.bindServerJob(placeholder.id, {
          sessionId: mountedReleaseSessionId,
          imageId: mountedReleaseImageId,
          serverAccepted: true,
          serverHandoffPending: true,
          serverHandoffRevision: undefined,
          status: "finalized",
          resultState: "recovering",
          message: "图片已写入图库，正在读取结果"
        }, queue.server.connectionGeneration, 4);
        releaseRaceReleased = queue.releaseResolvedServerJobs([{
          id: placeholder.id,
          attemptKey: placeholder.attemptKey,
          pair: {
            session_id: mountedReleaseSessionId,
            image_id: mountedReleaseImageId
          }
        }]).has(placeholder.id);
      };
      bindIncarnationReplacement = () => {
        queue.clearJobIds(new Set(queue.localJobs.map((job) => job.id)));
        const oldPlaceholder = ingestionJob({
          id: "owner-old-incarnation-placeholder",
          attemptKey: "owner-old-incarnation-attempt",
          batchKey: "owner-incarnation-batch",
          kind: "upload",
          status: "received",
          preview: "blob:old-incarnation-owner",
          objectUrl: "blob:old-incarnation-owner",
          serverDraftPending: true
        });
        const nextPlaceholder = ingestionJob({
          id: nextIncarnationPlaceholderId,
          attemptKey: nextIncarnationAttemptKey,
          batchKey: "owner-incarnation-batch",
          kind: "upload",
          status: "received"
        });
        queue.appendJobs([oldPlaceholder, nextPlaceholder]);
        queue.producerApi.bindServerJob(oldPlaceholder.id, {
          sessionId: incarnationSessionId,
          imageId: oldIncarnationImageId,
          serverAccepted: true,
          serverVersion: 1,
          serverSemanticRevision: 111,
          serverHandoffPending: true,
          serverHandoffRevision: 111,
          status: "received",
          message: "服务器已接管旧 incarnation"
        }, queue.server.connectionGeneration, 6);
        queue.producerApi.bindServerJob(nextPlaceholder.id, {
          sessionId: incarnationSessionId,
          imageId: nextIncarnationImageId,
          serverAccepted: true,
          serverVersion: 1,
          serverSemanticRevision: 112,
          serverHandoffPending: true,
          serverHandoffRevision: 112,
          status: "received",
          message: "服务器已接管新 incarnation"
        }, queue.server.connectionGeneration, 7);
      };
      releaseIncarnationReplacement = () => {
        releaseRaceReleased = queue.releaseResolvedServerJobs([{
          id: nextIncarnationPlaceholderId,
          attemptKey: nextIncarnationAttemptKey,
          pair: {
            session_id: incarnationSessionId,
            image_id: nextIncarnationImageId
          }
        }]).has(nextIncarnationPlaceholderId);
      };
      bindReconnectAcceptedOwners = () => {
        queue.clearJobIds(new Set(queue.localJobs.map((job) => job.id)));
        const placeholders = Array.from({ length: 21 }, (_, index) => ingestionJob({
          id: index === 0
            ? "owner-reconnect-visible-placeholder"
            : index === 20
              ? "owner-reconnect-off-page-placeholder"
              : `owner-reconnect-fill-${index}`,
          attemptKey: index === 0
            ? "owner-reconnect-visible-attempt"
            : index === 20
              ? "owner-reconnect-off-page-attempt"
              : `owner-reconnect-fill-attempt-${index}`,
          batchKey: "owner-reconnect-batch",
          kind: "upload",
          status: "received"
        }));
        queue.appendJobs(placeholders);
        queue.setPage(1);
        queue.producerApi.bindServerJob("owner-reconnect-off-page-placeholder", {
          sessionId: reconnectOffPageSessionId,
          imageId: reconnectOffPageImageId,
          serverAccepted: true,
          serverVersion: 1,
          serverSemanticRevision: 113,
          serverHandoffPending: true,
          serverHandoffRevision: 113,
          status: "received",
          message: "服务器已接管离页任务"
        }, queue.server.connectionGeneration, 8);
        queue.producerApi.bindServerJob("owner-reconnect-visible-placeholder", {
          sessionId: reconnectVisibleSessionId,
          imageId: reconnectVisibleImageId,
          serverAccepted: true,
          serverVersion: 1,
          serverSemanticRevision: 114,
          serverHandoffPending: true,
          serverHandoffRevision: 114,
          status: "received",
          message: "服务器已接管可见任务"
        }, queue.server.connectionGeneration, 9);
      };
      bindLoadingAcceptedOwner = (requestGeneration) => {
        queue.clearJobIds(new Set(queue.localJobs.map((job) => job.id)));
        const placeholders = Array.from({ length: 61 }, (_, index) => ingestionJob({
          id: index === 40
            ? "owner-loading-accepted-placeholder"
            : `owner-loading-accepted-fill-${index}`,
          attemptKey: index === 40
            ? "owner-loading-accepted-attempt"
            : `owner-loading-accepted-fill-attempt-${index}`,
          batchKey: "owner-loading-accepted-batch",
          kind: "upload",
          status: "received"
        }));
        queue.appendJobs(placeholders);
        queue.setPage(3);
        queue.producerApi.bindServerJob("owner-loading-accepted-placeholder", {
          sessionId: loadingAcceptedSessionId,
          imageId: loadingAcceptedImageId,
          serverAccepted: true,
          serverVersion: 1,
          serverSemanticRevision: 115,
          serverHandoffPending: true,
          serverHandoffRevision: 115,
          status: "received",
          message: "服务器在新连接加载期间接管任务"
        }, requestGeneration, 10);
      };
      prepareVisibleReadyRelease = () => {
        queue.clearJobIds(new Set(queue.jobsRef.current.map((job) => job.id)));
        const placeholders = visibleReadyReleaseImageIds.map((_imageId, index) => (
          ingestionJob({
            id: `owner-visible-ready-release-placeholder-${index}`,
            attemptKey: `owner-visible-ready-release-attempt-${index}`,
            batchKey: "owner-visible-ready-release-batch",
            kind: "upload",
            status: "received"
          })
        ));
        queue.appendJobs(placeholders);
        visibleReadyReleaseImageIds.forEach((imageId, index) => {
          const placeholder = placeholders[index];
          queue.producerApi.bindServerJob(placeholder.id, {
            sessionId: visibleReadyReleaseSessionIds[index],
            imageId,
            serverAccepted: true,
            serverVersion: 2,
            serverSemanticRevision: 2,
            serverHandoffPending: false,
            status: "ready",
            message: "等待提交"
          }, queue.server.connectionGeneration, 10 + index);
        });
        visibleReadyReleaseBeforeIds = queue.jobsRef.current.flatMap((job) => (
          job.imageId && visibleReadyReleaseImageIds.includes(job.imageId as (
            typeof visibleReadyReleaseImageIds
          )[number])
            ? [job.imageId]
            : []
        ));
      };
      releaseVisibleReady = (
        imageId = visibleReadyReleaseTargetImageId,
        release
      ) => {
        const visibleIndex = visibleReadyReleaseImageIds.indexOf(imageId as (
          typeof visibleReadyReleaseImageIds
        )[number]);
        assert.notEqual(visibleIndex, -1);
        const current = queue.jobsRef.current.find((job) => (
          job.imageId === imageId
        ));
        const targetId = current?.id
          ?? `owner-visible-ready-release-placeholder-${visibleIndex}`;
        const targetAttemptKey = current?.attemptKey
          ?? `owner-visible-ready-release-attempt-${visibleIndex}`;
        const targetSessionId = current?.sessionId
          ?? visibleReadyReleaseSessionIds[visibleIndex]!;
        if (current) {
          queue.updateJob(current.id, {
            status: "cancelled",
            message: "已取消"
          });
        }
        releaseRaceReleased = queue.releaseResolvedServerJobs([{
          id: targetId,
          attemptKey: targetAttemptKey,
          pair: {
            session_id: targetSessionId,
            image_id: imageId
          },
          ...(release ? {
            releasedRevision: release.revision,
            releasedSummary: release.summary
          } : {})
        }]).has(targetId);
        visibleReadyReleaseAfterIds = queue.jobsRef.current.flatMap((job) => (
          job.imageId && visibleReadyReleaseImageIds.includes(job.imageId as (
            typeof visibleReadyReleaseImageIds
          )[number])
            ? [job.imageId]
            : []
        ));
      };
      return React.createElement("output", null, JSON.stringify({
        status: queue.server.status,
        generation: queue.server.connectionGeneration,
        revision: queue.server.revision,
        page: queue.page,
        total: queue.totalItems,
        totalPages: queue.totalPages,
        waiting: queue.summary.waitingJobs
          + queue.summary.commitQueuedJobs
          + queue.summary.finalizedJobs,
        ready: queue.summary.readyCount,
        submitting: queue.summary.committingJobs,
        pendingHandoff: queue.pendingAuthorityHandoff,
        pendingDraft: queue.hasPendingDraftUpdates(),
        reconnectDone: queue.jobsRef.current.filter((job) => (
          job.status === "done"
          && (
            job.sessionId === reconnectVisibleSessionId
            || job.sessionId === reconnectOffPageSessionId
          )
        )).length,
        offPageCompletionOwners: queue.jobsRef.current.filter((job) => (
          job.imageId && offPageCompletionImageIds.includes(job.imageId)
        )).length,
        offPageCompletionDone: queue.jobsRef.current.filter((job) => (
          job.status === "done"
          && job.imageId
          && offPageCompletionImageIds.includes(job.imageId)
        )).length,
        compactChunkHydrated: queue.jobsRef.current.filter((job) => (
          job.resultState === "hydrated"
          && job.imageId
          && compactChunkFailureImageIds.includes(job.imageId)
        )).length,
        jobCount: queue.jobsRef.current.length,
        serverNotice: queue.serverNotice,
        visible: queue.visibleJobs.map((job) => ({
          id: job.imageId,
          status: job.status
        }))
      }));
    }
    const container = document.getElementById("root");
    const ownerContainer = document.getElementById("owner-root");
    const strictContainer = document.getElementById("strict-root");
    const emptyContainer = document.getElementById("empty-root");
    assert.ok(container);
    assert.ok(ownerContainer);
    assert.ok(strictContainer);
    assert.ok(emptyContainer);
    const root = createRoot(container);
    const ownerRoot = createRoot(ownerContainer);
    const strictRoot = createRoot(strictContainer);
    const emptyRoot = createRoot(emptyContainer);
    let strictRootUnmounted = false;
    let emptyRootUnmounted = false;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } }
    });
    queryClient.setQueryData(queryKeys.adminImages, { cached: true });
    let adminImageInvalidations = 0;
    const unsubscribeQueryEvents = queryClient.getQueryCache().subscribe(
      (event) => {
        if (
          event.type === "updated"
          && event.action.type === "invalidate"
          && JSON.stringify(event.query.queryKey)
            === JSON.stringify(queryKeys.adminImages)
        ) adminImageInvalidations += 1;
      }
    );
    const withQueryClient = (child: React.ReactNode) => React.createElement(
      QueryClientProvider,
      { client: queryClient },
      child
    );
    const view = () => JSON.parse(container.textContent || "{}") as {
      status: string;
      generation: number;
      actionScope: string;
      revision: number | null;
      total: number | null;
      items: Array<{ id: string; status: string; version: number }>;
      watermark: string;
      error: string;
    };
    const settleUntil = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      assert.fail(
        `Server Ingestion queue Hook did not settle: ${container.textContent}; `
        + `pending=${requests.filter((request) => (
          !request.aborted && !request.resolved
        )).map((request) => new URL(
          request.url,
          "https://imageshow.test"
        ).pathname).join(",")}; recent=${requests.slice(-8).map((request) => {
          const url = new URL(request.url, "https://imageshow.test");
          return `${url.pathname}?${url.searchParams.toString()}`
            + `:${request.aborted ? "aborted" : request.resolved ? "resolved" : "pending"}`;
        }).join(",")}`
      );
    };
    const respond = (
      request: PendingSnapshot,
      payload: Record<string, unknown>
    ) => {
      request.resolve(new Response(JSON.stringify({ ok: true, ...payload }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    };
    const pendingRequest = (path: string, from = 0) => (
      [...requests.slice(from)].reverse().find((request) => (
        !request.aborted
        && !request.resolved
        && new URL(request.url, "https://imageshow.test").pathname === path
      ))
    );
    const runQueueScenario = (
      id: string,
      name: string,
      work: () => Promise<void>
    ) => t.test(name, {
      skip: Boolean(selectedQueueScenario && selectedQueueScenario !== id)
    }, work);

    try {
      await runQueueScenario(
        "strict-mode",
        "Strict Mode 重挂只保留一个 SSE 并在卸载时释放",
        async () => {
      try {
        await React.act(async () => {
          strictRoot.render(withQueryClient(React.createElement(
            React.StrictMode,
            null,
            React.createElement(Probe, { enabled: true, offset: 0 })
          )));
          await Promise.resolve();
        });
        await settleUntil(() => ControlledEventSource.active.size === 1);
        assert.equal(
          ControlledEventSource.all.filter((candidate) => !candidate.closed).length,
          1,
          "StrictMode 重挂期间只能保留一个当前 SSE owner"
        );
        assert.equal(
          requests.length,
          0,
          "未收到 ready 的 StrictMode 探针不得提前读取 snapshot"
        );
      } finally {
        await React.act(async () => strictRoot.unmount());
        strictRootUnmounted = true;
      }
      assert.equal(ControlledEventSource.active.size, 0);
      ControlledEventSource.all.length = 0;
      requests.length = 0;
        }
      );

      await runQueueScenario(
        "empty-reconnect",
        "空队列重连重置 generation 且忽略旧 revision",
        async () => {
      const emptyView = () => JSON.parse(emptyContainer.textContent || "{}") as {
        status: string;
        generation: number;
        revision: number | null;
        total: number | null;
      };
      const emptySnapshot = (revision: number, watermark: string) => ({
        queue: "upload",
        revision,
        last_accepted_order: 0,
        offset: 0,
        limit: 20,
        total: 0,
        unfinished: 0,
        waiting: 0,
        running: 0,
        ready: 0,
        duplicate_pending: 0,
        committing: 0,
        resolving: 0,
        completed: 0,
        failed: 0,
        items: [],
        action_watermark: watermark
      });
      try {
        await React.act(async () => {
          emptyRoot.render(withQueryClient(
            React.createElement(Probe, { enabled: true, offset: 0 })
          ));
          await Promise.resolve();
        });
        await settleUntil(() => ControlledEventSource.all.length === 1);
        const emptySource = ControlledEventSource.all[0]!;
        await React.act(async () => {
          emptySource.emit("ready", {
            type: "ready",
            queue: "upload",
            revision: 100,
            action_scope: "scope-empty-old-generation"
          });
          await Promise.resolve();
        });
        await settleUntil(() => requests.length === 1);
        await React.act(async () => {
          respond(requests[0]!, emptySnapshot(100, "watermark-empty-old"));
          await Promise.resolve();
        });
        await settleUntil(() => (
          emptyView().status === "ready" && emptyView().total === 0
        ));
        assert.equal(requests.length, 1, "稳定空队列首次打开只能读取一次 snapshot");
        assert.equal(ControlledEventSource.active.size, 1);
        const oldGeneration = emptyView().generation;

        await React.act(async () => {
          emptySource.emit("error", {});
          await Promise.resolve();
        });
        assert.equal(ControlledEventSource.all.length, 1);
        assert.equal(ControlledEventSource.active.size, 1);
        const reopenedSource = emptySource;
        await React.act(async () => {
          reopenedSource.emit("ready", {
            type: "ready",
            queue: "upload",
            revision: 1,
            action_scope: "scope-empty-new-generation"
          });
          await Promise.resolve();
        });
        await settleUntil(() => requests.length === 2);
        await React.act(async () => {
          respond(requests[1]!, emptySnapshot(1, "watermark-empty-new"));
          await Promise.resolve();
        });
        await settleUntil(() => (
          emptyView().status === "ready"
          && emptyView().revision === 1
          && emptyView().generation !== oldGeneration
        ));
        assert.equal(requests.length, 2, "稳定空队列重连后也只能读取一次 snapshot");
        await React.act(async () => {
          ensureRevisionProbe?.(100, oldGeneration);
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        assert.equal(
          requests.length,
          2,
          "旧连接迟到的高 revision 不得污染 revision 已重置的新连接"
        );
      } finally {
        await React.act(async () => emptyRoot.unmount());
        emptyRootUnmounted = true;
      }
      assert.equal(ControlledEventSource.active.size, 0);
      ControlledEventSource.all.length = 0;
      requests.length = 0;
        }
      );

      await runQueueScenario(
        "reconnect-pagination",
        "重连、任意分页与迟到响应保持单一当前页基线",
        async () => {
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, { enabled: true, offset: 40 })
        ));
        await Promise.resolve();
      });
      assert.equal(ControlledEventSource.all.length, 1);
      assert.equal(ControlledEventSource.active.size, 1);
      const source = ControlledEventSource.all[0]!;
      assert.match(source.url, /queue=upload/u);

      await React.act(async () => {
        source.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 7,
          action_scope: "scope-one"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === 1);
      const firstUrl = new URL(requests[0]!.url, "https://imageshow.test");
      assert.equal(firstUrl.searchParams.get("offset"), "40");
      assert.equal(firstUrl.searchParams.get("limit"), "20");
      assert.equal(
        new Headers(requests[0]!.init.headers).get(ingestionActionScopeHeader),
        "scope-one"
      );
      assert.deepEqual(view().items, []);
      assert.equal(view().watermark, "");

      await React.act(async () => {
        source.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: 8,
          last_accepted_order: 60,
          summary,
          session: serverItem("preparing", 2, 20),
          action_watermark: "watermark-eight"
        });
        respond(requests[0]!, {
          queue: "upload",
          revision: 7,
          last_accepted_order: 60,
          offset: 40,
          limit: 20,
          ...summary,
          items: [serverItem("queued", 1, 20)],
          action_watermark: "watermark-seven"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().status === "ready");
      assert.equal(view().revision, 8);
      assert.equal(view().total, 60);
      assert.deepEqual(view().items, [{
        id: imageId,
        status: "preparing",
        version: 2
      }]);
      assert.deepEqual(probeServerItemObservations, [{
        imageId,
        status: "preparing",
        version: 2
      }], "SSE active mutation 必须逐项交给浏览器卡片 owner");
      assert.equal(view().watermark, "watermark-eight");
      const coveredRevisionStart = requests.length;
      await React.act(async () => {
        ensureRevisionProbe?.(8);
        await Promise.resolve();
      });
      assert.equal(
        requests.length,
        coveredRevisionStart,
        "稳定页已覆盖 handoff revision 时不得刷新"
      );

      const authorityRecoveryStart = requests.length;
      let firstAuthorityRecovery!: Promise<void>;
      let coalescedAuthorityRecovery!: Promise<void>;
      await React.act(async () => {
        firstAuthorityRecovery = recoverAuthorityProbe!();
        coalescedAuthorityRecovery = recoverAuthorityProbe!();
        await Promise.resolve();
      });
      assert.equal(
        firstAuthorityRecovery,
        coalescedAuthorityRecovery,
        "同一 owner 的并发凭证恢复必须共用一个权威 snapshot 链"
      );
      await settleUntil(() => requests.length === authorityRecoveryStart + 1);
      await React.act(async () => {
        requests[authorityRecoveryStart]!.resolve(new Response(
          "snapshot response lost",
          { status: 502 }
        ));
        await clock.advanceBy(100);
      });
      await settleUntil(() => requests.length === authorityRecoveryStart + 2);
      await React.act(async () => {
        respond(requests[authorityRecoveryStart + 1]!, {
          queue: "upload",
          revision: 8,
          last_accepted_order: 60,
          offset: 40,
          limit: 20,
          ...summary,
          items: [serverItem("preparing", 2, 20)],
          action_watermark: "watermark-authority-recovered"
        });
        await Promise.all([
          firstAuthorityRecovery,
          coalescedAuthorityRecovery
        ]);
      });
      assert.equal(view().watermark, "watermark-authority-recovered");
      assert.equal(
        requests.length,
        authorityRecoveryStart + 2,
        "响应丢失只允许重读 snapshot，不得并发创建第二条恢复链"
      );
      requests.splice(authorityRecoveryStart, 2);

      const completedBaselineStart = requests.length;
      const completedServerItem = {
        session_id: sessionId,
        image_id: imageId,
        queue: "upload" as const,
        status: "completed" as const,
        version: 3,
        progress_seq: 0,
        last_semantic_revision: 8,
        accepted_order: 20,
        completed_at: 2,
        completed_item: adminImageListItem({ id: imageId })
      };
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === completedBaselineStart + 1);
      await React.act(async () => {
        respond(requests[completedBaselineStart]!, {
          queue: "upload",
          revision: 8,
          last_accepted_order: 60,
          offset: 40,
          limit: 20,
          ...summary,
          items: [completedServerItem],
          action_watermark: "watermark-completed-before-cleanup"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        view().watermark === "watermark-completed-before-cleanup"
      ));
      assert.equal(view().items[0]?.status, "completed");
      requests.splice(completedBaselineStart, 1);

      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, {
            enabled: true,
            displayed: false,
            offset: 40
          })
        ));
        await Promise.resolve();
      });
      const cleanupRecoveryStart = requests.length;
      let cleanupRecovery!: Promise<void>;
      let concurrentCleanupRecovery!: Promise<void>;
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === cleanupRecoveryStart + 1);
      const preActionSnapshot = requests[cleanupRecoveryStart]!;
      await React.act(async () => {
        cleanupRecovery = recoverAfterSuccessfulActionProbe!();
        concurrentCleanupRecovery = recoverAuthorityProbe!();
        void cleanupRecovery.catch(() => undefined);
        await Promise.resolve();
      });
      assert.equal(
        cleanupRecovery,
        concurrentCleanupRecovery,
        "清理成功后的并发 recoverAuthority 必须复用 owner single-flight"
      );
      assert.equal(
        preActionSnapshot.aborted,
        true,
        "清理成功前启动的 snapshot 不得证明清理结果"
      );
      assert.equal(view().status, "loading");
      assert.deepEqual(
        view().items.map((item) => item.id),
        [completedServerItem.image_id],
        "raw owner 应保留有界基线，由组合 owner 精确投影动作成功项"
      );
      assert.equal(
        view().watermark,
        "watermark-completed-before-cleanup"
      );
      await settleUntil(() => requests.length === cleanupRecoveryStart + 2);
      const lateCompletedSessionId = "T".repeat(43);
      const lateCompletedImageId =
        "00000000-0000-7092-8000-00000000008e";
      const latePreparingItem = {
        ...serverItem("preparing", 2, 20, lateCompletedImageId),
        session_id: lateCompletedSessionId
      };
      await React.act(async () => {
        source.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: 9,
          last_accepted_order: 60,
          summary: { ...summary, unfinished: 58, completed: 2 },
          session: {
            session_id: lateCompletedSessionId,
            image_id: lateCompletedImageId,
            queue: "upload",
            status: "completed",
            version: 3,
            progress_seq: 0,
            last_semantic_revision: 9,
            accepted_order: 20,
            completed_at: 2,
            completed_item: adminImageListItem({ id: lateCompletedImageId })
          },
          action_watermark: "watermark-late-completion"
        });
        await Promise.resolve();
      });
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, {
            enabled: true,
            displayed: true,
            offset: 40
          })
        ));
        await Promise.resolve();
      });
      assert.deepEqual(
        view().items.map((item) => item.id),
        [completedServerItem.image_id],
        "raw owner 快速重开仍保留有界基线，组合 owner 负责隐藏已清理卡片"
      );
      await React.act(async () => {
        respond(requests[cleanupRecoveryStart + 1]!, {
          queue: "upload",
          revision: 8,
          last_accepted_order: 60,
          offset: 40,
          limit: 20,
          ...summary,
          items: [latePreparingItem],
          action_watermark: "watermark-after-completed-cleanup"
        });
        await Promise.all([cleanupRecovery, concurrentCleanupRecovery]);
      });
      assert.equal(
        requests.length,
        cleanupRecoveryStart + 2,
        "快速重开、普通 refresh 与并发恢复只能共用一个 post-action snapshot"
      );
      assert.deepEqual(view().items, [{
        id: lateCompletedImageId,
        status: "completed",
        version: 3
      }], "关闭后才完成的任务必须合并进动作后权威快照");
      assert.equal(view().watermark, "watermark-late-completion");
      assert.deepEqual(probeCompletedObservations, [lateCompletedImageId]);
      probeCompletedObservations.length = 0;
      requests.splice(cleanupRecoveryStart, 2);

      const postCleanupRefreshStart = requests.length;
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === postCleanupRefreshStart + 1);
      await React.act(async () => {
        respond(requests[postCleanupRefreshStart]!, {
          queue: "upload",
          revision: 9,
          last_accepted_order: 60,
          offset: 40,
          limit: 20,
          ...summary,
          items: [serverItem("preparing", 2, 20)],
          action_watermark: "watermark-post-cleanup-stable"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        view().watermark === "watermark-post-cleanup-stable"
      ));
      requests.splice(postCleanupRefreshStart, 1);

      const offPageCompletedImageId =
        "00000000-0000-7093-8000-00000000008e";
      await React.act(async () => {
        source.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: 10,
          last_accepted_order: 60,
          summary: { ...summary, completed: 2 },
          session: {
            session_id: "O".repeat(43),
            image_id: offPageCompletedImageId,
            queue: "upload",
            status: "completed",
            version: 2,
            progress_seq: 0,
            last_semantic_revision: 10,
            accepted_order: 1,
            completed_at: 2,
            completed_item: adminImageListItem({
              id: offPageCompletedImageId
            })
          },
          action_watermark: "watermark-ten"
        });
        await Promise.resolve();
      });
      assert.deepEqual(probeCompletedObservations, [offPageCompletedImageId]);
      assert.equal(
        requests.length,
        1,
        "跨页完成失效不应为了当前页额外读取 snapshot"
      );
      assert.equal(view().revision, 10);

      await React.act(async () => {
        source.emit("error", {});
        await Promise.resolve();
      });
      assert.equal(view().status, "disconnected");
      assert.equal(view().total, 60);
      assert.deepEqual(view().items, [{
        id: imageId,
        status: "preparing",
        version: 2
      }]);
      assert.equal(view().watermark, "watermark-ten");

      await React.act(async () => {
        source.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 20,
          action_scope: "scope-two"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === 2);
      assert.equal(view().status, "loading");
      assert.deepEqual(view().items, [{
        id: imageId,
        status: "preparing",
        version: 2
      }]);
      assert.equal(view().actionScope, "scope-two");

      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, { enabled: true, offset: 20 })
        ));
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === 3);
      assert.equal(requests[1]!.aborted, true);
      assert.equal(ControlledEventSource.all.length, 1);
      const thirdUrl = new URL(requests[2]!.url, "https://imageshow.test");
      assert.equal(thirdUrl.searchParams.get("offset"), "20");
      assert.equal(thirdUrl.searchParams.get("limit"), "20");
      await React.act(async () => {
        respond(requests[2]!, {
          queue: "upload",
          revision: 20,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 3, 40)],
          action_watermark: "watermark-page-two"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().status === "ready");
      assert.equal(view().total, 60);
      assert.equal(view().revision, 20);
      assert.equal(view().items[0]?.status, "ready");
      assert.equal(view().watermark, "watermark-page-two");

      const coveredLimitStart = requests.length;
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, {
            enabled: true,
            offset: 20,
            limit: 12
          })
        ));
        await Promise.resolve();
      });
      assert.equal(view().status, "ready");
      assert.equal(view().watermark, "watermark-page-two");
      assert.equal(
        requests.length,
        coveredLimitStart,
        "同筛选同 offset 的 limit 收缩必须复用已有稳定页"
      );
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, {
            enabled: true,
            offset: 20,
            limit: 20
          })
        ));
        await Promise.resolve();
      });
      assert.equal(
        requests.length,
        coveredLimitStart,
        "恢复到仍被原稳定页覆盖的 limit 也不得追加快照"
      );

      const coalescedRefreshStart = requests.length;
      await React.act(async () => {
        refreshProbe?.();
        refreshProbe?.();
        refreshProbe?.();
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === coalescedRefreshStart + 1);
      assert.equal(requests[coalescedRefreshStart]!.aborted, false);
      await React.act(async () => {
        respond(requests[coalescedRefreshStart]!, {
          queue: "upload",
          revision: 20,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 3, 40)],
          action_watermark: "watermark-coalesced-first"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        view().watermark === "watermark-coalesced-first"
      ));
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(requests[coalescedRefreshStart]!.aborted, false);
      assert.equal(
        requests.length,
        coalescedRefreshStart + 1,
        "同页四次普通 refresh 必须由同一成功响应完全覆盖"
      );
      requests.splice(coalescedRefreshStart, 1);

      const failedRefreshStart = requests.length;
      await React.act(async () => {
        refreshProbe?.();
        refreshProbe?.();
        refreshProbe?.();
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === failedRefreshStart + 1);
      await React.act(async () => {
        requests[failedRefreshStart]!.resolve(new Response(
          "coalesced ordinary refresh failed",
          { status: 503 }
        ));
        await clock.advanceBy(99);
      });
      assert.equal(
        requests.length,
        failedRefreshStart + 1,
        "重复普通 refresh 失败后不得绕过首档有界退避"
      );
      await React.act(async () => {
        await clock.advanceBy(1);
      });
      await settleUntil(() => requests.length === failedRefreshStart + 2);
      await React.act(async () => {
        respond(requests[failedRefreshStart + 1]!, {
          queue: "upload",
          revision: 20,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 3, 40)],
          action_watermark: "watermark-coalesced-retry"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().watermark === "watermark-coalesced-retry");
      assert.equal(
        requests.length,
        failedRefreshStart + 2,
        "四次普通 refresh 失败后只能形成原请求与一次退避重试"
      );
      requests.splice(failedRefreshStart, 2);

      const unknownCoverageStart = requests.length;
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === unknownCoverageStart + 1);
      await React.act(async () => {
        ensureRevisionProbe?.();
        respond(requests[unknownCoverageStart]!, {
          queue: "upload",
          revision: 20,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 3, 40)],
          action_watermark: "watermark-before-unknown-coverage"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === unknownCoverageStart + 2);
      assert.equal(
        requests[unknownCoverageStart]!.aborted,
        false,
        "未知 coverage 不得中止触发前已在途的同页请求"
      );
      await React.act(async () => {
        respond(requests[unknownCoverageStart + 1]!, {
          queue: "upload",
          revision: 20,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 3, 40)],
          action_watermark: "watermark-after-unknown-coverage"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        view().watermark === "watermark-after-unknown-coverage"
      ));
      requests.splice(unknownCoverageStart, 2);

      const repeatedRecoveryStart = requests.length;
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === repeatedRecoveryStart + 1);
      let firstRecovery!: Promise<void>;
      await React.act(async () => {
        firstRecovery = recoverAuthorityProbe!();
        respond(requests[repeatedRecoveryStart]!, {
          queue: "upload",
          revision: 20,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 3, 40)],
          action_watermark: "watermark-before-first-recovery"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === repeatedRecoveryStart + 2);
      let laterRecovery!: Promise<void>;
      await React.act(async () => {
        laterRecovery = recoverAuthorityProbe!();
        assert.equal(
          laterRecovery,
          firstRecovery,
          "恢复链在途期间的新未知结果必须共用 owner promise"
        );
        respond(requests[repeatedRecoveryStart + 1]!, {
          queue: "upload",
          revision: 20,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 3, 40)],
          action_watermark: "watermark-before-later-recovery"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === repeatedRecoveryStart + 3);
      await React.act(async () => {
        respond(requests[repeatedRecoveryStart + 2]!, {
          queue: "upload",
          revision: 20,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 3, 40)],
          action_watermark: "watermark-after-later-recovery"
        });
        await Promise.all([firstRecovery, laterRecovery]);
      });
      assert.equal(
        view().watermark,
        "watermark-after-later-recovery",
        "在途恢复开始后的未知结果必须由更晚快照证明"
      );
      requests.splice(repeatedRecoveryStart, 3);

      const capturedMutationStart = requests.length;
      const capturedSessionId = "N".repeat(43);
      const capturedImageId = "00000000-0000-7042-8000-00000000008e";
      const capturedItem = {
        ...serverItem("queued", 1, 61, capturedImageId),
        session_id: capturedSessionId,
        last_semantic_revision: 21
      };
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === capturedMutationStart + 1);
      await React.act(async () => {
        source.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: 21,
          last_accepted_order: 61,
          summary: { ...summary, total: 61, waiting: 2 },
          session: capturedItem,
          action_watermark: "watermark-captured-mutation"
        });
        ensureRevisionProbe?.(21);
        respond(requests[capturedMutationStart]!, {
          queue: "upload",
          revision: 21,
          last_accepted_order: 61,
          offset: 20,
          limit: 20,
          ...summary,
          total: 61,
          waiting: 2,
          items: [serverItem("ready", 3, 40), capturedItem],
          action_watermark: "watermark-captured-mutation"
        });
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(
        requests.length,
        capturedMutationStart + 1,
        "在途 snapshot 已捕获新会话时不得预排重复 reload"
      );
      assert.equal(view().watermark, "watermark-captured-mutation");
      requests.splice(capturedMutationStart, 1);

      const revertedLimitStart = requests.length;
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === revertedLimitStart + 1);
      const limitBaselineRequest = requests[revertedLimitStart]!;
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, {
            enabled: true,
            offset: 20,
            limit: 21
          })
        ));
        await Promise.resolve();
      });
      assert.equal(requests.length, revertedLimitStart + 1);
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, {
            enabled: true,
            offset: 20,
            limit: 20
          })
        ));
        await Promise.resolve();
        respond(limitBaselineRequest, {
          queue: "upload",
          revision: 20,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 3, 40)],
          action_watermark: "watermark-reverted-limit"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().status === "ready");
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(
        requests.length,
        revertedLimitStart + 1,
        "limit 扩容后恢复原值时不得保留已无意义的 parameters 尾随快照"
      );
      assert.equal(limitBaselineRequest.aborted, false);
      requests.splice(revertedLimitStart, 1);

      const revertedFailureStart = requests.length;
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, {
            enabled: true,
            offset: 20,
            limit: 21
          })
        ));
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === revertedFailureStart + 1);
      const obsoleteExpandedRequest = requests[revertedFailureStart]!;
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, {
            enabled: true,
            offset: 20,
            limit: 20
          })
        ));
        await Promise.resolve();
      });
      assert.equal(requests.length, revertedFailureStart + 1);
      await React.act(async () => {
        obsoleteExpandedRequest.resolve(new Response(
          "obsolete expanded snapshot failed",
          { status: 503 }
        ));
        await clock.advanceBy(100);
      });
      await settleUntil(() => requests.length === revertedFailureStart + 2);
      assert.equal(
        obsoleteExpandedRequest.aborted,
        false,
        "参数恢复不得中止同页扩大请求"
      );
      assert.equal(
        new URL(
          requests[revertedFailureStart + 1]!.url,
          "http://localhost"
        ).searchParams.get("limit"),
        "20",
        "已撤销的参数请求失败后仍须按当前选择完成有界权威恢复"
      );
      await React.act(async () => {
        respond(requests[revertedFailureStart + 1]!, {
          queue: "upload",
          revision: 20,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 3, 40)],
          action_watermark: "watermark-reverted-failure-recovered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        view().watermark === "watermark-reverted-failure-recovered"
      ));
      requests.splice(revertedFailureStart, 2);

      const selectionPair = {
        session_id: "F".repeat(43),
        image_id: "00000000-0000-7044-8000-00000000008e"
      };
      const filterChangeStart = requests.length;
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === filterChangeStart + 1);
      const supersededFilterRequest = requests[filterChangeStart]!;
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, {
            enabled: true,
            offset: 20,
            selectionPair
          })
        ));
        await Promise.resolve();
      });
      assert.equal(
        requests.length,
        filterChangeStart + 1,
        "同页排除集合变化必须排队尾随读取，不能中止当前 fetch"
      );
      await React.act(async () => {
        respond(supersededFilterRequest, {
          queue: "upload",
          revision: 20,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 3, 40)],
          action_watermark: "watermark-superseded-filter"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === filterChangeStart + 2);
      assert.equal(supersededFilterRequest.aborted, false);
      assert.equal(
        view().watermark,
        "watermark-reverted-failure-recovered",
        "旧排除集合的响应不得替换当前稳定页面"
      );
      const filteredRequest = requests[filterChangeStart + 1]!;
      assert.deepEqual(JSON.parse(String(filteredRequest.init.body)), {
        exclude_items: [selectionPair],
        include_items: [selectionPair]
      });
      await React.act(async () => {
        respond(filteredRequest, {
          queue: "upload",
          revision: 21,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 4, 40)],
          action_watermark: "watermark-current-filter"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        view().watermark === "watermark-current-filter"
      ));
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, { enabled: true, offset: 20 })
        ));
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === filterChangeStart + 3);
      await React.act(async () => {
        respond(requests[filterChangeStart + 2]!, {
          queue: "upload",
          revision: 21,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 4, 40)],
          action_watermark: "watermark-filter-reset"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().watermark === "watermark-filter-reset");
      requests.splice(filterChangeStart, 3);

      const semanticReloadStart = requests.length;
      await React.act(async () => {
        source.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: 22,
          last_accepted_order: 60,
          summary,
          session: {
            ...serverItem("ready", 4, 40),
            last_semantic_revision: 22
          },
          action_watermark: "watermark-semantic-gap"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === semanticReloadStart + 1);
      assert.equal(
        view().status,
        "ready",
        "同 scope 语义跳变应保留旧水位，避免按钮在后台重读期间失效"
      );
      assert.equal(
        view().watermark,
        "watermark-filter-reset",
        "保留水位必须止于跳变前 accepted-order，不能纳入触发重读的新任务"
      );
      assert.equal(
        view().items[0]?.status,
        "ready",
        "撤销旧快照权威时仍须保留稳定卡片展示"
      );
      await React.act(async () => {
        respond(requests[semanticReloadStart]!, {
          queue: "upload",
          revision: 22,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 4, 40)],
          action_watermark: "watermark-semantic-gap-refreshed"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().status === "ready");
      requests.splice(semanticReloadStart, 1);

      const queuedSemanticReloadStart = requests.length;
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === queuedSemanticReloadStart + 1);
      await React.act(async () => {
        source.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: 24,
          last_accepted_order: 60,
          summary,
          session: {
            ...serverItem("ready", 5, 40),
            last_semantic_revision: 24
          },
          action_watermark: "watermark-queued-semantic-gap"
        });
        await Promise.resolve();
      });
      assert.equal(
        view().status,
        "ready",
        "在途同页刷新发现语义跳变时也应保留有界旧操作权威"
      );
      assert.equal(requests.length, queuedSemanticReloadStart + 1);
      await React.act(async () => {
        respond(requests[queuedSemanticReloadStart]!, {
          queue: "upload",
          revision: 22,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 4, 40)],
          action_watermark: "watermark-before-queued-gap"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === queuedSemanticReloadStart + 2);
      assert.equal(
        view().status,
        "ready",
        "尾随读取前旧签名水位仍可稳定服务点击且不会扩大范围"
      );
      assert.equal(
        view().watermark,
        "watermark-semantic-gap-refreshed"
      );
      assert.equal(requests[queuedSemanticReloadStart]!.aborted, false);
      await React.act(async () => {
        respond(requests[queuedSemanticReloadStart + 1]!, {
          queue: "upload",
          revision: 24,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 5, 40)],
          action_watermark: "watermark-after-queued-gap"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().status === "ready");
      assert.equal(view().watermark, "watermark-after-queued-gap");
      requests.splice(queuedSemanticReloadStart, 2);

      const samePageReconnectStart = requests.length;
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === samePageReconnectStart + 1);
      const staleSamePageRequest = requests[samePageReconnectStart]!;
      await React.act(async () => {
        source.emit("error", {});
        source.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 24,
          action_scope: "scope-three"
        });
        source.emit("error", {});
        source.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 25,
          action_scope: "scope-four"
        });
        source.emit("error", {});
        source.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 26,
          action_scope: "scope-five"
        });
        await Promise.resolve();
      });
      assert.equal(
        requests.length,
        samePageReconnectStart + 2,
        "连续同页重连只能取消旧 scope 请求并启动最后一代快照"
      );
      assert.equal(
        staleSamePageRequest.aborted,
        true,
        "新 scope 必须释放旧请求的单飞队首，不能等待悬挂响应"
      );
      const trailingReconnectRequest = requests[samePageReconnectStart + 1]!;
      assert.equal(
        new Headers(trailingReconnectRequest.init.headers).get(
          ingestionActionScopeHeader
        ),
        "scope-five",
        "尾随快照必须使用最后一次 ready 的作用域"
      );
      assert.equal(view().status, "loading");
      await React.act(async () => {
        respond(trailingReconnectRequest, {
          queue: "upload",
          revision: 26,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 6, 40)],
          action_watermark: "watermark-same-page-reconnect"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().status === "ready");
      assert.equal(view().watermark, "watermark-same-page-reconnect");
      assert.equal(staleSamePageRequest.aborted, true);
      assert.equal(trailingReconnectRequest.aborted, false);
      requests.splice(samePageReconnectStart, 2);

      const automaticRecoveryStart = requests.length;
      await React.act(async () => {
        source.emit("error", {});
        source.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 27,
          action_scope: "scope-six"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === automaticRecoveryStart + 1);
      await React.act(async () => {
        requests[automaticRecoveryStart]!.resolve(new Response(JSON.stringify({
          ok: false,
          error: "controlled retained recovery failure",
          details: {}
        }), {
          status: 500,
          headers: { "content-type": "application/json" }
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(view().status, "disconnected");
      assert.equal(view().watermark, "watermark-same-page-reconnect");
      await React.act(async () => {
        await clock.advanceBy(100);
      });
      await settleUntil(() => requests.length === automaticRecoveryStart + 2);
      await React.act(async () => {
        respond(requests[automaticRecoveryStart + 1]!, {
          queue: "upload",
          revision: 27,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 7, 40)],
          action_watermark: "watermark-automatic-recovery"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().status === "ready");
      assert.equal(view().watermark, "watermark-automatic-recovery");
      requests.splice(automaticRecoveryStart, 2);

      const mutationRecoveryStart = requests.length;
      await React.act(async () => {
        source.emit("error", {});
        source.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 28,
          action_scope: "scope-seven"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === mutationRecoveryStart + 1);
      await React.act(async () => {
        requests[mutationRecoveryStart]!.resolve(new Response(JSON.stringify({
          ok: false,
          error: "controlled mutation recovery failure",
          details: {}
        }), {
          status: 500,
          headers: { "content-type": "application/json" }
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        source.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: 29,
          last_accepted_order: 60,
          summary,
          session: serverItem("ready", 8, 40),
          action_watermark: "watermark-mutation-recovery"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === mutationRecoveryStart + 2);
      await React.act(async () => {
        respond(requests[mutationRecoveryStart + 1]!, {
          queue: "upload",
          revision: 29,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 8, 40)],
          action_watermark: "watermark-mutation-recovered"
        });
        await clock.advanceBy(100);
      });
      assert.equal(
        requests.length,
        mutationRecoveryStart + 2,
        "mutation 主动恢复后必须消费旧 retry timer，不得追加重复快照"
      );
      assert.equal(view().watermark, "watermark-mutation-recovered");
      requests.splice(mutationRecoveryStart, 2);

      const malformedRecoveryStart = requests.length;
      await React.act(async () => {
        source.emit("mutation", {
          type: "mutation",
          queue: "import"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === malformedRecoveryStart + 1);
      assert.equal(ControlledEventSource.all.length, 1);
      assert.equal(view().actionScope, "scope-seven");
      await React.act(async () => {
        respond(requests[malformedRecoveryStart]!, {
          queue: "upload",
          revision: 29,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 8, 40)],
          action_watermark: "watermark-malformed-recovered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().status === "ready");
      requests.splice(malformedRecoveryStart, 1);

      const boundedFailureStart = requests.length;
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === boundedFailureStart + 1);
      await React.act(async () => {
        source.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: 31,
          last_accepted_order: 60,
          summary,
          session: {
            ...serverItem("ready", 9, 40),
            last_semantic_revision: 31
          },
          action_watermark: "watermark-bounded-failure-one"
        });
        requests[boundedFailureStart]!.resolve(new Response(JSON.stringify({
          ok: false,
          error: "controlled queued reload failure one",
          details: {}
        }), {
          status: 500,
          headers: { "content-type": "application/json" }
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(
        requests.length,
        boundedFailureStart + 1,
        "失败请求期间排入的 mutation reload 不得绕过首次退避"
      );
      assert.equal(
        view().status,
        "disconnected",
        "失败后保留卡片但必须撤销旧 action watermark 的执行权威"
      );
      await React.act(async () => {
        await clock.advanceBy(100);
      });
      await settleUntil(() => requests.length === boundedFailureStart + 2);
      await React.act(async () => {
        source.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: 32,
          last_accepted_order: 60,
          summary,
          session: {
            ...serverItem("ready", 10, 40),
            last_semantic_revision: 32
          },
          action_watermark: "watermark-bounded-failure-two"
        });
        requests[boundedFailureStart + 1]!.resolve(new Response(JSON.stringify({
          ok: false,
          error: "controlled queued reload failure two",
          details: {}
        }), {
          status: 500,
          headers: { "content-type": "application/json" }
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(
        requests.length,
        boundedFailureStart + 2,
        "连续 mutation 与 5xx 仍必须进入递增退避而非立即连发"
      );
      await React.act(async () => {
        await clock.advanceBy(499);
        assert.equal(
          requests.length,
          boundedFailureStart + 2,
          "第二档恢复期限前不得提前追加快照"
        );
        await clock.advanceBy(1);
      });
      await settleUntil(() => requests.length === boundedFailureStart + 3);
      await React.act(async () => {
        respond(requests[boundedFailureStart + 2]!, {
          queue: "upload",
          revision: 32,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 10, 40)],
          action_watermark: "watermark-bounded-failure-recovered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().status === "ready");
      requests.splice(boundedFailureStart, 3);

      const retainedRefreshStart = requests.length;
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === retainedRefreshStart + 1);
      assert.equal(view().status, "ready");
      assert.equal(view().items[0]?.status, "ready");
      await React.act(async () => {
        requests[retainedRefreshStart]!.resolve(new Response(JSON.stringify({
          ok: false,
          error: "controlled background refresh failure",
          details: {}
        }), {
          status: 500,
          headers: { "content-type": "application/json" }
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(
        view().status,
        "disconnected",
        "同 scope 快照失败应保留卡片但撤销旧水位执行权威"
      );
      assert.equal(view().items[0]?.status, "ready");
      assert.equal(view().error, "");
      await React.act(async () => {
        await clock.advanceBy(100);
      });
      await settleUntil(() => requests.length === retainedRefreshStart + 2);
      await React.act(async () => {
        respond(requests[retainedRefreshStart + 1]!, {
          queue: "upload",
          revision: 32,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 10, 40)],
          action_watermark: "watermark-background-recovered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().status === "ready");
      requests.splice(retainedRefreshStart, 2);

      const hiddenMutationStart = requests.length;
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, {
            enabled: true,
            displayed: false,
            offset: 20
          })
        ));
        await Promise.resolve();
      });
      await React.act(async () => {
        source.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "removed",
          revision: 33,
          last_accepted_order: 60,
          summary: { ...summary, total: 59, completed: 0 },
          session: {
            session_id: sessionId,
            image_id: imageId,
            status: "discarded",
            version: 11,
            progress_seq: 0,
            last_semantic_revision: 33,
            accepted_order: 40
          },
          action_watermark: "watermark-hidden-removal"
        });
        await Promise.resolve();
      });
      assert.equal(
        requests.length,
        hiddenMutationStart,
        "关闭后保留 action scope 时不得为 removed 事件启动即将取消的快照"
      );
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, {
            enabled: true,
            displayed: true,
            offset: 20
          })
        ));
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === hiddenMutationStart + 1);
      await React.act(async () => {
        respond(requests[hiddenMutationStart]!, {
          queue: "upload",
          revision: 33,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          total: 59,
          completed: 0,
          items: [],
          action_watermark: "watermark-hidden-reopened"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().watermark === "watermark-hidden-reopened");
      requests.splice(hiddenMutationStart, 1);

      await React.act(async () => {
        source.emit("error", {});
        root.render(withQueryClient(
          React.createElement(Probe, { enabled: true, offset: 40 })
        ));
        await Promise.resolve();
      });
      await settleUntil(() => view().items.length === 0);
      assert.equal(view().status, "disconnected");
      assert.equal(view().total, null);

      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, { enabled: false, offset: 40 })
        ));
        await Promise.resolve();
      });
      await settleUntil(() => view().status === "idle");
      assert.equal(source.closed, true);
      assert.equal(ControlledEventSource.active.size, 0);
        }
      );

      await runQueueScenario(
        "handoff-completion",
        "接管、完成失效与动作清理保持 owner 单调权威",
        async () => {
      const ownerSourceStart = ControlledEventSource.all.length;
      const ownerRequestStart = requests.length;
      await React.act(async () => {
        ownerRoot.render(withQueryClient(
          React.createElement(OwnerProbe, { displayed: true })
        ));
        await Promise.resolve();
      });
      await settleUntil(() => (
        ControlledEventSource.all.length === ownerSourceStart + 1
      ));
      const ownerSource = ControlledEventSource.all[ownerSourceStart]!;
      await React.act(async () => {
        ownerSource.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 30,
          action_scope: "scope-owner"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === ownerRequestStart + 1);
      await React.act(async () => {
        respond(requests[ownerRequestStart]!, {
          queue: "upload",
          revision: 30,
          last_accepted_order: 60,
          offset: 0,
          limit: 20,
          ...summary,
          items: [serverItem("queued", 1, 60)],
          action_watermark: "watermark-owner"
        });
        await Promise.resolve();
      });
      const ownerView = () => JSON.parse(ownerContainer.textContent || "{}") as {
        status: string;
        generation: number;
        revision: number | null;
        page: number;
        total: number;
        totalPages: number;
        waiting: number;
        ready: number;
        submitting: number;
        pendingHandoff: boolean;
        pendingDraft: boolean;
        reconnectDone: number;
        offPageCompletionOwners: number;
        offPageCompletionDone: number;
        compactChunkHydrated: number;
        jobCount: number;
        serverNotice: string;
        visible: Array<{ id: string; status: string }>;
      };
      await settleUntil(() => ownerView().status === "ready");
      assert.equal(ownerView().total, 60);
      assert.equal(ownerView().waiting, 4);
      assert.equal(ownerView().submitting, 2);
      assert.ok(setOwnerPage);
      await React.act(async () => {
        setOwnerPage!(3);
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === ownerRequestStart + 2);
      assert.equal(
        new URL(requests[ownerRequestStart + 1]!.url, "https://imageshow.test")
          .searchParams.get("offset"),
        "40"
      );
      await React.act(async () => {
        respond(requests[ownerRequestStart + 1]!, {
          queue: "upload",
          revision: 30,
          last_accepted_order: 60,
          offset: 40,
          limit: 20,
          ...summary,
          items: [serverItem("queued", 1, 20)],
          action_watermark: "watermark-owner-page-three"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready" && ownerView().page === 3
      ));

      const reducedSummary = {
        total: 5,
        unfinished: 5,
        waiting: 0,
        running: 0,
        ready: 0,
        duplicate_pending: 0,
        committing: 0,
        resolving: 0,
        completed: 0,
        failed: 0
      };
      const handoffSummary = {
        ...reducedSummary,
        total: 6,
        unfinished: 6
      };
      await React.act(async () => {
        ownerSource.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "removed",
          revision: 31,
          last_accepted_order: 60,
          summary: reducedSummary,
          session: {
            session_id: sessionId,
            image_id: imageId,
            status: "discarded",
            version: 2,
            progress_seq: 0,
            last_semantic_revision: 31,
            accepted_order: 20
          },
          action_watermark: "watermark-reduced"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === ownerRequestStart + 3);
      await React.act(async () => {
        respond(requests[ownerRequestStart + 2]!, {
          queue: "upload",
          revision: 31,
          last_accepted_order: 60,
          offset: 40,
          limit: 20,
          ...reducedSummary,
          items: [],
          action_watermark: "watermark-reduced"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === ownerRequestStart + 4);
      assert.equal(ownerView().page, 1);
      assert.equal(
        new URL(requests[ownerRequestStart + 3]!.url, "https://imageshow.test")
          .searchParams.get("offset"),
        "0"
      );
      const remainingImageId = "00000000-0000-7010-8000-00000000008e";
      await React.act(async () => {
        respond(requests[ownerRequestStart + 3]!, {
          queue: "upload",
          revision: 31,
          last_accepted_order: 60,
          offset: 0,
          limit: 20,
          ...reducedSummary,
          items: [serverItem("queued", 1, 5, remainingImageId)],
          action_watermark: "watermark-reduced-page-one"
        });
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().status === "ready");
      assert.equal(ownerView().page, 1);
      assert.equal(ownerView().totalPages, 1);
      assert.equal(ownerView().visible[0]?.id, remainingImageId);
      assert.equal(ControlledEventSource.all.length, ownerSourceStart + 1);
      assert.equal(ControlledEventSource.active.size, 1);

      assert.ok(bindOwnerHandoff);
      await React.act(async () => {
        bindOwnerHandoff!(33);
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().pendingHandoff
          && requests.length === ownerRequestStart + 5
      ));
      assert.equal(
        ownerView().total,
        6,
        "有界重取期间必须保留稳定 metadata 与未覆盖交接任务的完整计数"
      );
      assert.equal(
        ownerView().visible.filter((job) => job.id === handoffImageId).length,
        1,
        "HTTP accepted 先到时原占位必须原子转成交接卡且只出现一次"
      );
      await React.act(async () => {
        ownerSource.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: 32,
          last_accepted_order: 60,
          summary: reducedSummary,
          session: {
            ...serverItem(
              "preparing",
              2,
              6,
              "00000000-0000-7012-8000-00000000008e"
            ),
            session_id: "O".repeat(43),
            last_semantic_revision: 32
          },
          action_watermark: "watermark-unrelated-32"
        });
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().pendingHandoff);
      assert.equal(
        ownerView().pendingHandoff,
        true,
        "离开当前页的 pair 仍须由 owner fence 等待其 HTTP revision"
      );
      assert.equal(
        ownerView().total,
        6,
        "loading 中的不相关事件不得丢掉稳定 Server total"
      );
      assert.equal(
        ownerView().visible.filter((job) => job.id === handoffImageId).length,
        1,
        "不相关的较低 revision 不得让可见交接卡消失"
      );
      await React.act(async () => {
        ownerSource.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: 33,
          last_accepted_order: 61,
          summary: handoffSummary,
          session: {
            ...serverItem("preparing", 2, 61, handoffImageId),
            session_id: handoffSessionId,
            last_semantic_revision: 33
          },
          action_watermark: "watermark-handoff-33"
        });
        await Promise.resolve();
      });
      await React.act(async () => {
        respond(requests[ownerRequestStart + 4]!, {
          queue: "upload",
          revision: 33,
          last_accepted_order: 61,
          offset: 0,
          limit: 20,
          ...handoffSummary,
          items: [{
            ...serverItem("preparing", 2, 61, handoffImageId),
            session_id: handoffSessionId,
            last_semantic_revision: 33
          }],
          action_watermark: "watermark-handoff-33"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready" && !ownerView().pendingHandoff
      ));
      assert.equal(ownerView().total, 6);
      assert.equal(
        ownerView().visible.filter((job) => job.id === handoffImageId).length,
        1,
        "权威 snapshot 接管后同一 pair 仍只能挂载一张卡"
      );

      assert.ok(prepareUnknownCompletedHandoff);
      assert.ok(bindUnknownCompletedHandoff);
      const coveredShrinkStart = requests.length;
      await React.act(async () => {
        prepareUnknownCompletedHandoff!();
        await Promise.resolve();
      });
      assert.equal(ownerView().status, "ready");
      assert.equal(
        requests.length,
        coveredShrinkStart,
        "浏览器前缀覆盖整页时必须复用现有 Server 基线"
      );
      await React.act(async () => {
        setOwnerPage!(3);
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().page === 3);
      const unknownRequestStart = requests.length;
      await React.act(async () => {
        bindUnknownCompletedHandoff!();
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
        && Boolean(pendingRequest(ingestionSnapshotPath, unknownRequestStart))
      ));
      assert.equal(
        ownerView().total,
        67,
        "离页 completed 回放必须以稳定 Server total 加 detached 摘要补位"
      );
      assert.equal(
        ownerView().visible.filter((job) => (
          job.id === unknownImageId
        )).length,
        0,
        "离页交接只补摘要，不得把 canonical 强行挂到当前组合页"
      );

      await React.act(async () => {
        respond(pendingRequest(ingestionSnapshotPath, unknownRequestStart)!, {
          queue: "upload",
          revision: 100,
          last_accepted_order: 62,
          offset: 0,
          limit: 20,
          total: 7,
          unfinished: 6,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 1,
          failed: 0,
          items: [],
          action_watermark: "watermark-completed-active"
        });
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionStatusPath, unknownRequestStart)
      ));
      await React.act(async () => {
        respond(pendingRequest(ingestionStatusPath, unknownRequestStart)!, {
          items: [{
            session_id: unknownSessionId,
            image_id: unknownImageId,
            status: "completed",
            completed_item: adminImageListItem({ id: unknownImageId }),
            redis_status: "active",
            redis_version: 2,
            redis_last_semantic_revision: 100
          }]
        });
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().pendingHandoff);
      assert.equal(
        adminImageInvalidations,
        1,
        "PG completed 即使 Redis canonical 尚为 active 也必须失效图片数据"
      );
      queryClient.setQueryData(queryKeys.adminImages, {
        cached: "before completed reconnect"
      });
      const oldGenerationStatusCount = requests.slice(unknownRequestStart)
        .filter((request) => (
          !request.aborted
          &&
          new URL(request.url, "https://imageshow.test").pathname
            === ingestionStatusPath
        )).length;
      assert.equal(oldGenerationStatusCount, 1);

      const coldRequestStart = requests.length;
      const visibleBeforeColdReconnect = ownerView().visible;
      const totalBeforeColdReconnect = ownerView().total;
      await React.act(async () => {
        ownerSource.emit("error", {});
        await Promise.resolve();
      });
      assert.equal(ownerView().status, "disconnected");
      assert.equal(
        ownerView().total,
        totalBeforeColdReconnect,
        "短暂断线不得把已展示的队列总数归零"
      );
      assert.deepEqual(
        ownerView().visible,
        visibleBeforeColdReconnect,
        "短暂断线不得清空或重排已展示的卡片"
      );
      await React.act(async () => {
        ownerSource.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 0,
          action_scope: "scope-owner-cold"
        });
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, coldRequestStart)
      ));
      await React.act(async () => {
        respond(pendingRequest(ingestionSnapshotPath, coldRequestStart)!, {
          queue: "upload",
          revision: 0,
          last_accepted_order: 0,
          offset: 0,
          limit: 20,
          total: 0,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: [],
          action_watermark: "watermark-owner-cold"
        });
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionStatusPath, coldRequestStart)
      ));
      await React.act(async () => {
        respond(pendingRequest(ingestionStatusPath, coldRequestStart)!, {
          items: [{
            session_id: unknownSessionId,
            image_id: unknownImageId,
            status: "completed",
            completed_item: adminImageListItem({ id: unknownImageId }),
            redis_status: "missing"
          }]
        });
        await Promise.resolve();
      });
      await settleUntil(() => !ownerView().pendingHandoff);
      assert.equal(
        adminImageInvalidations,
        1,
        "同一 completed pair 跨重连 status 水合不得重复失效图片数据"
      );
      assert.equal(
        requests.slice(coldRequestStart).filter((request) => (
          !request.aborted
          &&
          new URL(request.url, "https://imageshow.test").pathname
            === ingestionStatusPath
        )).length,
        1,
        "新连接空基线必须重新核对，且收敛后不得继续轮询"
      );

      const coverageBaselineStart = requests.length;
      await React.act(async () => {
        ownerSource.emit("error", {});
        ownerSource.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 101,
          action_scope: "scope-owner-covered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, coverageBaselineStart)
      ));
      await React.act(async () => {
        respond(pendingRequest(ingestionSnapshotPath, coverageBaselineStart)!, {
          queue: "upload",
          revision: 101,
          last_accepted_order: 0,
          offset: 0,
          limit: 20,
          total: 0,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: [],
          action_watermark: "watermark-owner-covered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().status === "ready");

      assert.ok(bindCoveredCompletedHandoff);
      const coveredRequestStart = requests.length;
      await React.act(async () => {
        bindCoveredCompletedHandoff!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, coveredRequestStart)
      ));
      await React.act(async () => {
        respond(pendingRequest(ingestionSnapshotPath, coveredRequestStart)!, {
          queue: "upload",
          revision: 101,
          last_accepted_order: 1,
          offset: 0,
          limit: 20,
          total: 1,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 1,
          failed: 0,
          items: [],
          action_watermark: "watermark-owner-covered-one"
        });
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionStatusPath, coveredRequestStart)
      ));
      await React.act(async () => {
        respond(pendingRequest(ingestionStatusPath, coveredRequestStart)!, {
          items: [{
            session_id: coveredSessionId,
            image_id: coveredImageId,
            status: "completed",
            completed_item: adminImageListItem({ id: coveredImageId }),
            redis_status: "completed",
            redis_version: 2,
            redis_last_semantic_revision: 100
          }]
        });
        await Promise.resolve();
      });
      await settleUntil(() => !ownerView().pendingHandoff);
      assert.equal(
        requests.slice(coveredRequestStart).filter((request) => (
          !request.aborted
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionStatusPath
        )).length,
        1,
        "已被稳定 baseline 覆盖的离页 receipt 必须当场收敛"
      );

      assert.ok(bindCrossGenerationAccepted);
      const crossGenerationRequestStart = requests.length;
      await React.act(async () => {
        bindCrossGenerationAccepted!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionStatusPath, crossGenerationRequestStart)
      ));
      assert.equal(
        requests.slice(crossGenerationRequestStart).some((request) => (
          new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )),
        false,
        "当前代基线已覆盖旧代 HTTP revision 时应直接批量核对 pair"
      );
      await React.act(async () => {
        respond(
          pendingRequest(ingestionStatusPath, crossGenerationRequestStart)!,
          {
            items: [{
              session_id: crossGenerationSessionId,
              image_id: crossGenerationImageId,
              status: "completed",
              completed_item: adminImageListItem({ id: crossGenerationImageId }),
              redis_status: "missing"
            }]
          }
        );
        await Promise.resolve();
      });
      await settleUntil(() => (
        !ownerView().pendingHandoff
        && ownerView().visible.some((job) => (
          job.id === crossGenerationImageId && job.status === "done"
        ))
      ));
      assert.ok(
        revokedObjectUrls.includes("blob:cross-generation-visible"),
        "满 local 页移除跨代 handoff 卡时必须释放浏览器 Blob URL"
      );
      assert.ok(releaseCrossGenerationHydrated);
      const crossGenerationReleaseStart = requests.length;
      await React.act(async () => {
        releaseRaceReleased = false;
        releaseCrossGenerationHydrated!();
        await Promise.resolve();
      });
      assert.equal(releaseRaceReleased, true);
      assert.equal(
        ownerView().visible.some((job) => job.id === crossGenerationImageId),
        false,
        "status 先水合的同 attempt done 卡仍须被后到 clear 结果释放"
      );
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, crossGenerationReleaseStart)
      ));
      const crossGenerationReleaseSnapshot = pendingRequest(
        ingestionSnapshotPath,
        crossGenerationReleaseStart
      )!;
      const crossGenerationReleaseUrl = new URL(
        crossGenerationReleaseSnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(crossGenerationReleaseSnapshot, {
          queue: "upload",
          revision: 101,
          last_accepted_order: 1,
          offset: Number(crossGenerationReleaseUrl.searchParams.get("offset")),
          limit: Number(crossGenerationReleaseUrl.searchParams.get("limit")),
          total: 1,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 1,
          failed: 0,
          items: [],
          action_watermark: "watermark-after-cross-generation-release"
        });
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().status === "ready");

      assert.ok(bindReleaseRaceHandoff);
      assert.ok(releaseRaceHandoff);
      const releaseRaceRequestStart = requests.length;
      await React.act(async () => {
        bindReleaseRaceHandoff!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, releaseRaceRequestStart)
      ));
      await React.act(async () => {
        respond(pendingRequest(ingestionSnapshotPath, releaseRaceRequestStart)!, {
          queue: "upload",
          revision: 102,
          last_accepted_order: 2,
          offset: 0,
          limit: 20,
          total: 2,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 2,
          failed: 0,
          items: [],
          action_watermark: "watermark-before-release-race"
        });
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionStatusPath, releaseRaceRequestStart)
      ));
      const staleReleaseStatus = pendingRequest(
        ingestionStatusPath,
        releaseRaceRequestStart
      )!;
      await React.act(async () => {
        releaseRaceHandoff!();
        await Promise.resolve();
      });
      await settleUntil(() => !ownerView().pendingHandoff);
      assert.equal(releaseRaceReleased, true);
      assert.equal(
        ownerView().visible.some((job) => job.id === releaseRaceImageId),
        false
      );
      await React.act(async () => {
        respond(staleReleaseStatus, {
          items: [{
            session_id: releaseRaceSessionId,
            image_id: releaseRaceImageId,
            status: "completed",
            completed_item: adminImageListItem({ id: releaseRaceImageId }),
            redis_status: "missing"
          }]
        });
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(ownerView().pendingHandoff, false);
      assert.equal(
        ownerView().visible.some((job) => job.id === releaseRaceImageId),
        false,
        "同一 Server clear 已释放的 pair 不得被迟到 status 重新注入"
      );
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, releaseRaceRequestStart)
      ));
      const releaseRaceRecoverySnapshot = pendingRequest(
        ingestionSnapshotPath,
        releaseRaceRequestStart
      )!;
      const releaseRaceRecoveryUrl = new URL(
        releaseRaceRecoverySnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(releaseRaceRecoverySnapshot, {
          queue: "upload",
          revision: 102,
          last_accepted_order: 2,
          offset: Number(releaseRaceRecoveryUrl.searchParams.get("offset")),
          limit: Number(releaseRaceRecoveryUrl.searchParams.get("limit")),
          total: 2,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 2,
          failed: 0,
          items: [],
          action_watermark: "watermark-after-release-race"
        });
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().status === "ready");

      assert.ok(releaseMountedFinalized);
      const mountedReleaseRequestStart = requests.length;
      await React.act(async () => {
        releaseRaceReleased = false;
        releaseMountedFinalized!();
        await Promise.resolve();
      });
      assert.equal(releaseRaceReleased, true);
      assert.equal(ownerView().pendingHandoff, false);
      assert.equal(
        ownerView().visible.some((job) => job.id === mountedReleaseImageId),
        false,
        "commit-owned finalized 卡必须由专用权威释放动作移出"
      );
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, mountedReleaseRequestStart)
      ));
      const mountedReleaseSnapshot = pendingRequest(
        ingestionSnapshotPath,
        mountedReleaseRequestStart
      )!;
      const mountedReleaseSnapshotUrl = new URL(
        mountedReleaseSnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(mountedReleaseSnapshot, {
          queue: "upload",
          revision: 103,
          last_accepted_order: 2,
          offset: Number(mountedReleaseSnapshotUrl.searchParams.get("offset")),
          limit: Number(mountedReleaseSnapshotUrl.searchParams.get("limit")),
          total: 2,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 2,
          failed: 0,
          items: [],
          action_watermark: "watermark-after-mounted-release"
        });
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(
        requests.slice(mountedReleaseRequestStart).filter((request) => (
          new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )).length,
        1,
        "一页 Server 替补必须让 mounted release 以一次快照收敛"
      );
      await settleUntil(() => (
        ownerView().status === "ready"
        && !pendingRequest(ingestionSnapshotPath, mountedReleaseRequestStart)
      ));

      assert.ok(bindCrossGenerationCompletedCoverage);
      const completedCoverageStart = requests.length;
      await React.act(async () => {
        bindCrossGenerationCompletedCoverage!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionStatusPath, completedCoverageStart)
      ));
      assert.equal(
        pendingRequest(ingestionSnapshotPath, completedCoverageStart),
        undefined,
        "跨代 completed 响应必须先由当前连接 status 确认真正 revision"
      );
      await React.act(async () => {
        respond(pendingRequest(ingestionStatusPath, completedCoverageStart)!, {
          items: [{
            session_id: crossGenerationCompletedSessionId,
            image_id: crossGenerationCompletedImageId,
            status: "completed",
            completed_item: adminImageListItem({
              id: crossGenerationCompletedImageId
            }),
            redis_status: "completed",
            redis_version: 2,
            redis_last_semantic_revision: 109
          }]
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().pendingHandoff
        && Boolean(pendingRequest(ingestionSnapshotPath, completedCoverageStart))
      ));
      assert.equal(
        ownerView().pendingHandoff,
        true,
        "高于当前 baseline 的 completed receipt 必须继续持有 owner 围栏"
      );
      await React.act(async () => {
        respond(pendingRequest(ingestionSnapshotPath, completedCoverageStart)!, {
          queue: "upload",
          revision: 109,
          last_accepted_order: 4,
          offset: 0,
          limit: 20,
          total: 2,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 2,
          failed: 0,
          items: [],
          action_watermark: "watermark-completed-covered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => !ownerView().pendingHandoff);
      assert.equal(
        requests.slice(completedCoverageStart).filter((request) => (
          !request.aborted
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionStatusPath
        )).length,
        1,
        "completed coverage 应主动刷新权威快照且不得轮询 status"
      );

      assert.ok(bindCrossGenerationPresent);
      const presentCoverageStart = requests.length;
      await React.act(async () => {
        bindCrossGenerationPresent!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionStatusPath, presentCoverageStart)
      ));
      assert.equal(
        requests.slice(presentCoverageStart).some((request) => (
          new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )),
        false,
        "当前代 revision 已覆盖时应先核对跨代 pair，不预读同一快照"
      );
      assert.equal(
        ownerView().total,
        63,
        "跨代 accepted 在 order 水位覆盖前必须以 byte-free 投影补回组合总数"
      );
      await React.act(async () => {
        respond(pendingRequest(ingestionStatusPath, presentCoverageStart)!, {
          items: [{
            session_id: crossGenerationPresentSessionId,
            image_id: crossGenerationPresentImageId,
            status: "present",
            item: {
              ...serverItem(
                "ready",
                4,
                5,
                crossGenerationPresentImageId
              ),
              session_id: crossGenerationPresentSessionId,
              last_semantic_revision: 110
            }
          }]
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().pendingHandoff
        && Boolean(pendingRequest(ingestionSnapshotPath, presentCoverageStart))
      ));
      assert.equal(
        ownerView().pendingHandoff,
        true,
        "高于当前 baseline 的 present DTO 不得提前释放跨代 owner 围栏"
      );
      assert.equal(
        ownerView().total,
        63,
        "present status 不得在覆盖快照到达前提前减掉 provisional 总数"
      );
      await React.act(async () => {
        respond(pendingRequest(ingestionSnapshotPath, presentCoverageStart)!, {
          queue: "upload",
          revision: 110,
          last_accepted_order: 5,
          offset: 0,
          limit: 20,
          total: 3,
          unfinished: 1,
          waiting: 0,
          running: 0,
          ready: 1,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 2,
          failed: 0,
          items: [],
          action_watermark: "watermark-present-covered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => !ownerView().pendingHandoff);
      assert.equal(
        requests.slice(presentCoverageStart).filter((request) => (
          !request.aborted
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionStatusPath
        )).length,
        1,
        "present coverage 应以一次 status 加一次权威快照收敛，不得轮询"
      );

      assert.ok(bindIncarnationReplacement);
      assert.ok(releaseIncarnationReplacement);
      const incarnationRequestStart = requests.length;
      await React.act(async () => {
        bindIncarnationReplacement!();
        releaseRaceReleased = false;
        releaseIncarnationReplacement!();
        await Promise.resolve();
      });
      assert.equal(releaseRaceReleased, true);
      assert.equal(ownerView().pendingHandoff, false);
      assert.equal(ownerView().pendingDraft, false);
      assert.ok(
        revokedObjectUrls.includes("blob:old-incarnation-owner"),
        "同 session 新 image 接管时必须释放旧 canonical 的 Blob URL"
      );
      assert.equal(
        ownerView().visible.some((job) => (
          job.id === oldIncarnationImageId
          || job.id === nextIncarnationImageId
        )),
        false,
        "释放新 incarnation 后不得残留旧 pair 的围栏或卡片"
      );
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, incarnationRequestStart)
      ));
      const incarnationSnapshot = pendingRequest(
        ingestionSnapshotPath,
        incarnationRequestStart
      )!;
      const incarnationSnapshotUrl = new URL(
        incarnationSnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(incarnationSnapshot, {
          queue: "upload",
          revision: 112,
          last_accepted_order: 7,
          offset: Number(incarnationSnapshotUrl.searchParams.get("offset")),
          limit: Number(incarnationSnapshotUrl.searchParams.get("limit")),
          total: 3,
          unfinished: 1,
          waiting: 0,
          running: 0,
          ready: 1,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 2,
          failed: 0,
          items: [],
          action_watermark: "watermark-incarnation-replaced"
        });
        await Promise.resolve();
      });
      const incarnationTrailingSnapshot = pendingRequest(
        ingestionSnapshotPath,
        incarnationRequestStart
      );
      if (incarnationTrailingSnapshot) {
        const trailingUrl = new URL(
          incarnationTrailingSnapshot.url,
          "https://imageshow.test"
        );
        await React.act(async () => {
          respond(incarnationTrailingSnapshot, {
            queue: "upload",
            revision: 112,
            last_accepted_order: 7,
            offset: Number(trailingUrl.searchParams.get("offset")),
            limit: Number(trailingUrl.searchParams.get("limit")),
            total: 3,
            unfinished: 1,
            waiting: 0,
            running: 0,
            ready: 1,
            duplicate_pending: 0,
            committing: 0,
            resolving: 0,
            completed: 2,
            failed: 0,
            items: [],
            action_watermark: "watermark-incarnation-replaced-trailing"
          });
          await Promise.resolve();
        });
      }
      await settleUntil(() => (
        ownerView().status === "ready"
        && !pendingRequest(ingestionSnapshotPath, incarnationRequestStart)
      ));

      assert.ok(bindReconnectAcceptedOwners);
      const reconnectAcceptedStart = requests.length;
      await React.act(async () => {
        bindReconnectAcceptedOwners!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, reconnectAcceptedStart)
      ));
      const preReconnectSnapshot = pendingRequest(
        ingestionSnapshotPath,
        reconnectAcceptedStart
      )!;
      await React.act(async () => {
        ownerSource.emit("error", {});
        ownerSource.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 114,
          action_scope: "scope-owner-reconnect-accepted"
        });
        await Promise.resolve();
      });
      await settleUntil(() => {
        const pending = pendingRequest(
          ingestionSnapshotPath,
          reconnectAcceptedStart
        );
        return Boolean(pending && pending !== preReconnectSnapshot);
      });
      assert.equal(
        preReconnectSnapshot.aborted,
        true,
        "owner 换代也必须只取消旧 scope 的在途快照"
      );
      const reconnectSnapshot = pendingRequest(
        ingestionSnapshotPath,
        reconnectAcceptedStart
      )!;
      const reconnectSnapshotUrl = new URL(
        reconnectSnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(reconnectSnapshot, {
          queue: "upload",
          revision: 114,
          last_accepted_order: 0,
          offset: Number(reconnectSnapshotUrl.searchParams.get("offset")),
          limit: Number(reconnectSnapshotUrl.searchParams.get("limit")),
          total: 0,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: [],
          action_watermark: "watermark-owner-reconnect-accepted"
        });
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionStatusPath, reconnectAcceptedStart)
      ));
      const reconnectStatus = pendingRequest(
        ingestionStatusPath,
        reconnectAcceptedStart
      )!;
      const requestedReconnectPairs = (
        JSON.parse(String(reconnectStatus.init.body ?? "{}")) as {
          items: Array<{ session_id: string; image_id: string }>;
        }
      ).items;
      assert.deepEqual(
        new Set(requestedReconnectPairs.map((item) => item.session_id)),
        new Set([reconnectVisibleSessionId, reconnectOffPageSessionId]),
        "换代必须把可见与离页的未覆盖 accepted pair 一并升级为 status owner"
      );
      assert.equal(
        ownerView().total,
        21,
        "reconnect status 收敛前必须保留可见与离页 provisional 总数"
      );
      await React.act(async () => {
        respond(reconnectStatus, {
          items: requestedReconnectPairs.map((pair) => ({
            ...pair,
            status: "completed",
            completed_item: adminImageListItem({ id: pair.image_id }),
            redis_status: "missing"
          }))
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        !ownerView().pendingHandoff && ownerView().reconnectDone === 2
      ));
      assert.equal(
        requests.slice(reconnectAcceptedStart).filter((request) => (
          !request.aborted
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionStatusPath
        )).length,
        1,
        "reconnect promotion 必须用一次批量 status 收敛且不得轮询"
      );

      assert.ok(refreshOwner);
      const loadingSnapshotStart = requests.length;
      await React.act(async () => {
        refreshOwner!();
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
        && Boolean(pendingRequest(ingestionSnapshotPath, loadingSnapshotStart))
      ));
      const loadingSnapshot = pendingRequest(
        ingestionSnapshotPath,
        loadingSnapshotStart
      )!;
      assert.ok(bindLoadingAcceptedOwner);
      const loadingAcceptedStart = requests.length;
      const staleRequestGeneration = ownerView().generation - 1;
      await React.act(async () => {
        bindLoadingAcceptedOwner!(staleRequestGeneration);
        await Promise.resolve();
      });
      assert.equal(loadingSnapshot.aborted, false);
      assert.equal(
        requests.slice(loadingAcceptedStart).filter((request) => (
          !request.aborted
          && !request.resolved
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )).length,
        0,
        "已有同页快照在途时不得为新的收敛触发中止旧请求或并发读取"
      );
      assert.equal(ownerView().status, "ready");
      assert.equal(
        ownerView().total,
        61,
        "loading 期间到达的新 accepted order 必须保留 provisional 总数"
      );
      const loadingSnapshotUrl = new URL(
        loadingSnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(loadingSnapshot, {
          queue: "upload",
          revision: 114,
          last_accepted_order: 10,
          offset: Number(loadingSnapshotUrl.searchParams.get("offset")),
          limit: Number(loadingSnapshotUrl.searchParams.get("limit")),
          total: 1,
          unfinished: 1,
          waiting: 0,
          running: 0,
          ready: 1,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: [],
          action_watermark: "watermark-loading-accepted-stale"
        });
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionStatusPath, loadingAcceptedStart)
      ));
      assert.equal(ownerView().total, 61);
      await React.act(async () => {
        respond(pendingRequest(ingestionStatusPath, loadingAcceptedStart)!, {
          items: [{
            session_id: loadingAcceptedSessionId,
            image_id: loadingAcceptedImageId,
            status: "present",
            item: {
              ...serverItem("ready", 2, 10, loadingAcceptedImageId),
              session_id: loadingAcceptedSessionId,
              last_semantic_revision: 115
            }
          }]
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
        && Boolean(pendingRequest(ingestionSnapshotPath, loadingAcceptedStart))
      ));
      assert.equal(
        ownerView().total,
        61,
        "已含 pair 的稳定 total 在 revision coverage loading 时不得重复加 provisional"
      );
      const loadingCoverageSnapshot = pendingRequest(
        ingestionSnapshotPath,
        loadingAcceptedStart
      )!;
      const loadingCoverageUrl = new URL(
        loadingCoverageSnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(loadingCoverageSnapshot, {
          queue: "upload",
          revision: 115,
          last_accepted_order: 10,
          offset: Number(loadingCoverageUrl.searchParams.get("offset")),
          limit: Number(loadingCoverageUrl.searchParams.get("limit")),
          total: 1,
          unfinished: 1,
          waiting: 0,
          running: 0,
          ready: 1,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: [],
          action_watermark: "watermark-loading-accepted-covered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
        && !ownerView().pendingHandoff
        && ownerView().total === 61
      ));
      assert.equal(
        requests.slice(loadingAcceptedStart).filter((request) => (
          !request.aborted
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionStatusPath
        )).length,
        1,
        "loading accepted 必须以一次 status 和一次 coverage 快照收敛"
      );

      const completedSnapshotSessionId = "M".repeat(43);
      const completedSnapshotImageId =
        "00000000-0000-7044-8000-00000000008e";
      const completedSnapshotItem = adminImageListItem({
        id: completedSnapshotImageId,
        author: "snapshot-author",
        tags: ["snapshot-tag"]
      });
      const adjacentCompletedItem = adminImageListItem({
        id: "00000000-0000-7045-8000-00000000008e",
        author: "snapshot-author"
      });
      const completedSnapshotServerItem = {
        session_id: completedSnapshotSessionId,
        image_id: completedSnapshotImageId,
        queue: "upload" as const,
        status: "completed" as const,
        version: 2,
        progress_seq: 0 as const,
        last_semantic_revision: 116,
        accepted_order: 11,
        completed_at: 2,
        completed_item: completedSnapshotItem
      };
      queryClient.setQueryData(queryKeys.adminImages, {
        cached: "before completed snapshot"
      });
      const invalidationsBeforeCompletedSnapshot = adminImageInvalidations;
      assert.ok(observeOwnerCompleted);
      await React.act(async () => {
        const pair = {
          session_id: completedSnapshotSessionId,
          image_id: completedSnapshotImageId
        };
        observeOwnerCompleted!(pair, completedSnapshotItem);
        observeOwnerCompleted!(pair, completedSnapshotItem);
        observeOwnerCompleted!({
          session_id: "N".repeat(43),
          image_id: adjacentCompletedItem.id
        }, adjacentCompletedItem);
        await Promise.resolve();
      });
      assert.equal(
        adminImageInvalidations,
        invalidationsBeforeCompletedSnapshot + 1,
        "同一完成批次的不同 pair 及重复观察只能合并失效一次"
      );
      assert.ok(refreshOwner);
      await React.act(async () => {
        refreshOwner!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath)
      ));
      const completedSnapshotRequest = pendingRequest(ingestionSnapshotPath);
      assert.ok(completedSnapshotRequest);
      const completedSnapshotStart = requests.length;
      await React.act(async () => {
        setOwnerPage!(4);
        await Promise.resolve();
      });
      assert.equal(completedSnapshotRequest.aborted, false);
      assert.equal(
        requests.slice(completedSnapshotStart).filter((request) => (
          !request.aborted
          && !request.resolved
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )).length,
        0,
        "翻页参数落在同一组合 offset 时必须复用在途读取并只排队一个必要尾随快照"
      );
      const completedSnapshotUrl = new URL(
        completedSnapshotRequest.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(completedSnapshotRequest, {
          queue: "upload",
          revision: 116,
          last_accepted_order: 11,
          offset: Number(completedSnapshotUrl.searchParams.get("offset")),
          limit: Number(completedSnapshotUrl.searchParams.get("limit")),
          total: 2,
          unfinished: 1,
          waiting: 0,
          running: 0,
          ready: 1,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 1,
          failed: 0,
          items: [completedSnapshotServerItem],
          action_watermark: "watermark-completed-snapshot"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
      ));
      assert.equal(
        adminImageInvalidations,
        invalidationsBeforeCompletedSnapshot + 1,
        "动作响应之后的 completed snapshot 不得重复失效"
      );
      queryClient.setQueryData(queryKeys.adminImages, {
        cached: "before repeated completed snapshot"
      });

      const preRepeatedReconnectSnapshot = pendingRequest(ingestionSnapshotPath);
      assert.ok(preRepeatedReconnectSnapshot);
      const repeatedCompletedSnapshotStart = requests.length;
      await React.act(async () => {
        ownerSource.emit("error", {});
        ownerSource.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 116,
          action_scope: "scope-owner-completed-snapshot-reconnect"
        });
        await Promise.resolve();
      });
      assert.equal(
        requests.length,
        repeatedCompletedSnapshotStart + 1,
        "completed snapshot 换代必须直接启动新 scope 的唯一读取"
      );
      assert.equal(preRepeatedReconnectSnapshot.aborted, true);
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, repeatedCompletedSnapshotStart)
      ));
      const repeatedCompletedSnapshot = pendingRequest(
        ingestionSnapshotPath,
        repeatedCompletedSnapshotStart
      )!;
      const repeatedCompletedSnapshotUrl = new URL(
        repeatedCompletedSnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(repeatedCompletedSnapshot, {
          queue: "upload",
          revision: 116,
          last_accepted_order: 11,
          offset: Number(
            repeatedCompletedSnapshotUrl.searchParams.get("offset")
          ),
          limit: Number(
            repeatedCompletedSnapshotUrl.searchParams.get("limit")
          ),
          total: 2,
          unfinished: 1,
          waiting: 0,
          running: 0,
          ready: 1,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 1,
          failed: 0,
          items: [completedSnapshotServerItem],
          action_watermark: "watermark-completed-snapshot-reconnect"
        });
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().status === "ready");
      assert.equal(
        adminImageInvalidations,
        invalidationsBeforeCompletedSnapshot + 1,
        "同一 completed snapshot 在 SSE 重连代际不得重复失效"
      );

      assert.ok(bindLoadingAcceptedOwner);
      const renderGapStart = requests.length;
      const renderGapRequestGeneration = ownerView().generation;
      await React.act(async () => {
        ownerSource.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 1,
          action_scope: "scope-owner-render-gap"
        });
        // Intentionally bind before React commits the ready projection. The
        // queue controller has already advanced internally, while handoff
        // callers still observe the previous high-revision generation.
        bindLoadingAcceptedOwner!(renderGapRequestGeneration);
        await Promise.resolve();
      });
      await settleUntil(() => (
        Boolean(pendingRequest(ingestionSnapshotPath, renderGapStart))
      ));
      assert.equal(
        ownerView().pendingHandoff,
        true,
        "React render-gap 内的旧代响应不得被旧高 revision 快捷清除"
      );
      const renderGapReadySnapshot = pendingRequest(
        ingestionSnapshotPath,
        renderGapStart
      )!;
      const renderGapReadyUrl = new URL(
        renderGapReadySnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(renderGapReadySnapshot, {
          queue: "upload",
          revision: 1,
          last_accepted_order: 0,
          offset: Number(renderGapReadyUrl.searchParams.get("offset")),
          limit: Number(renderGapReadyUrl.searchParams.get("limit")),
          total: 0,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: [],
          action_watermark: "watermark-render-gap-ready"
        });
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().status === "ready");
      await settleUntil(() => Boolean(
        pendingRequest(ingestionStatusPath, renderGapStart)
      ));
      await React.act(async () => {
        respond(pendingRequest(ingestionStatusPath, renderGapStart)!, {
          items: [{
            session_id: loadingAcceptedSessionId,
            image_id: loadingAcceptedImageId,
            status: "present",
            item: {
              ...serverItem("ready", 2, 10, loadingAcceptedImageId),
              session_id: loadingAcceptedSessionId,
              last_semantic_revision: 2
            }
          }]
        });
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, renderGapStart)
      ));
      const renderGapCoverageSnapshot = pendingRequest(
        ingestionSnapshotPath,
        renderGapStart
      )!;
      const renderGapCoverageUrl = new URL(
        renderGapCoverageSnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(renderGapCoverageSnapshot, {
          queue: "upload",
          revision: 2,
          last_accepted_order: 10,
          offset: Number(renderGapCoverageUrl.searchParams.get("offset")),
          limit: Number(renderGapCoverageUrl.searchParams.get("limit")),
          total: 1,
          unfinished: 1,
          waiting: 0,
          running: 0,
          ready: 1,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: [{
            ...serverItem("ready", 2, 10, loadingAcceptedImageId),
            session_id: loadingAcceptedSessionId,
            last_semantic_revision: 2
          }],
          action_watermark: "watermark-render-gap-covered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready" && !ownerView().pendingHandoff
      ));
      assert.equal(
        requests.slice(renderGapStart).filter((request) => (
          !request.aborted
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )).length,
        2,
        "render-gap 只允许新代 ready 与当前 status revision 各一次快照"
      );
      assert.equal(
        requests.slice(renderGapStart).filter((request) => (
          !request.aborted
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionStatusPath
        )).length,
        1,
        "render-gap handoff 必须恰好回读一次当前代 status"
      );

      assert.ok(prepareVisibleReadyRelease);
      assert.ok(releaseVisibleReady);
      const staleReleaseSnapshotStart = requests.length;
      await React.act(async () => {
        refreshOwner!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(pendingRequest(
        ingestionSnapshotPath,
        staleReleaseSnapshotStart
      )));
      const staleReleaseSnapshot = pendingRequest(
        ingestionSnapshotPath,
        staleReleaseSnapshotStart
      )!;
      const staleReleaseUrl = new URL(
        staleReleaseSnapshot.url,
        "https://imageshow.test"
      );
      const singleReleaseStart = requests.length;
      await React.act(async () => {
        prepareVisibleReadyRelease!();
        assert.deepEqual(
          visibleReadyReleaseBeforeIds,
          [...visibleReadyReleaseImageIds],
          "回归基线必须固定为七张 ready 卡并保持 1→7 顺序"
        );
        releaseRaceReleased = false;
        releaseVisibleReady!();
        assert.equal(releaseRaceReleased, true);
        respond(staleReleaseSnapshot, {
          queue: "upload",
          revision: 3,
          last_accepted_order: 16,
          offset: Number(staleReleaseUrl.searchParams.get("offset")),
          limit: Number(staleReleaseUrl.searchParams.get("limit")),
          total: 7,
          unfinished: 7,
          waiting: 0,
          running: 0,
          ready: 7,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: visibleReadyReleaseImageIds.map((imageId, index) => ({
            ...serverItem("ready", 2, 10 + index, imageId),
            session_id: visibleReadyReleaseSessionIds[index],
            last_semantic_revision: 3
          })),
          action_watermark: "watermark-single-release-stale"
        });
        await Promise.resolve();
      });
      const remainingReadyReleaseImageIds = visibleReadyReleaseImageIds.filter(
        (imageId) => imageId !== visibleReadyReleaseTargetImageId
      );
      assert.deepEqual(
        visibleReadyReleaseAfterIds,
        remainingReadyReleaseImageIds,
        "第一次移除第 5 张时队列 ref 必须同步变为六张并原位保序"
      );
      await settleUntil(() => ownerView().status === "ready");
      assert.equal(
        ownerView().visible.some((job) => (
          job.id === visibleReadyReleaseTargetImageId
        )),
        false,
        "第一次移除第 5 张后旧 snapshot 不得把同一 ready pair 放到队尾"
      );
      assert.deepEqual(
        ownerView().visible.map((job) => job.id),
        remainingReadyReleaseImageIds,
        "移除前已在途的七项旧快照晚到后仍须保持六项原顺序"
      );
      assert.equal(ownerView().total, 6, "单项移除后总数必须立即减少一次");
      assert.equal(ownerView().ready, 6, "单项移除后 ready 摘要必须立即减少一次");
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, singleReleaseStart)
      ));
      const singleReleaseSnapshot = pendingRequest(
        ingestionSnapshotPath,
        singleReleaseStart
      )!;
      const singleReleaseUrl = new URL(
        singleReleaseSnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(singleReleaseSnapshot, {
          queue: "upload",
          revision: 4,
          last_accepted_order: 16,
          offset: Number(singleReleaseUrl.searchParams.get("offset")),
          limit: Number(singleReleaseUrl.searchParams.get("limit")),
          total: 6,
          unfinished: 6,
          waiting: 0,
          running: 0,
          ready: 6,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: remainingReadyReleaseImageIds.map((imageId) => ({
            ...serverItem(
              "ready",
              2,
              10 + visibleReadyReleaseImageIds.indexOf(imageId),
              imageId
            ),
            session_id: visibleReadyReleaseSessionIds[
              visibleReadyReleaseImageIds.indexOf(imageId)
            ],
            last_semantic_revision: 4
          })),
          action_watermark: "watermark-single-release-covered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().status === "ready");
      assert.equal(
        requests.slice(singleReleaseStart).filter((request) => (
          !request.aborted
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )).length,
        1,
        "单项移除成功后只允许一次 post-trigger 权威快照"
      );
      assert.deepEqual(
        ownerView().visible.map((job) => job.id),
        remainingReadyReleaseImageIds
      );
      assert.equal(ownerView().total, 6);
      assert.equal(ownerView().ready, 6);

      const boundaryExtraImageIds = Array.from({ length: 15 }, (
        _value,
        index
      ) => (
        `019f8457-063a-${(0x7050 + index).toString(16)}-a580-00000000008e`
      ));
      const boundaryImageIds = [
        ...remainingReadyReleaseImageIds,
        ...boundaryExtraImageIds
      ];
      const boundarySessionIds = [
        ...remainingReadyReleaseImageIds.map((imageId) => (
          visibleReadyReleaseSessionIds[
            visibleReadyReleaseImageIds.indexOf(imageId)
          ]!
        )),
        ...boundaryExtraImageIds.map((_imageId, index) => (
          String.fromCharCode("a".charCodeAt(0) + index).repeat(43)
        ))
      ];
      const boundaryItems = boundaryImageIds.map((imageId, index) => ({
        ...serverItem("ready", 3, 20 + index, imageId),
        session_id: boundarySessionIds[index]!,
        last_semantic_revision: 6
      }));
      const boundaryBaselineStart = requests.length;
      await React.act(async () => {
        refreshOwner!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, boundaryBaselineStart)
      ));
      const boundaryBaseline = pendingRequest(
        ingestionSnapshotPath,
        boundaryBaselineStart
      )!;
      const boundaryBaselineUrl = new URL(
        boundaryBaseline.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(boundaryBaseline, {
          queue: "upload",
          revision: 6,
          last_accepted_order: 40,
          offset: Number(boundaryBaselineUrl.searchParams.get("offset")),
          limit: Number(boundaryBaselineUrl.searchParams.get("limit")),
          total: 21,
          unfinished: 21,
          waiting: 0,
          running: 0,
          ready: 21,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: boundaryItems.slice(0, 20),
          action_watermark: "watermark-release-page-boundary"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
        && ownerView().total === 21
        && ownerView().visible.length === 20
      ));
      const boundaryPageTwoStart = requests.length;
      await React.act(async () => {
        setOwnerPage!(2);
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, boundaryPageTwoStart)
      ));
      const boundaryPageTwo = pendingRequest(
        ingestionSnapshotPath,
        boundaryPageTwoStart
      )!;
      const boundaryPageTwoUrl = new URL(
        boundaryPageTwo.url,
        "https://imageshow.test"
      );
      assert.equal(boundaryPageTwoUrl.searchParams.get("offset"), "20");
      await React.act(async () => {
        respond(boundaryPageTwo, {
          queue: "upload",
          revision: 6,
          last_accepted_order: 40,
          offset: Number(boundaryPageTwoUrl.searchParams.get("offset")),
          limit: Number(boundaryPageTwoUrl.searchParams.get("limit")),
          total: 21,
          unfinished: 21,
          waiting: 0,
          running: 0,
          ready: 21,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: boundaryItems.slice(20),
          action_watermark: "watermark-release-target-absent"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready" && ownerView().page === 2
      ));
      assert.equal(ownerView().total, 21);
      assert.equal(ownerView().ready, 21);

      const absentReleaseImageId = remainingReadyReleaseImageIds[0]!;
      const afterAbsentReleaseImageIds = remainingReadyReleaseImageIds.filter(
        (imageId) => imageId !== absentReleaseImageId
      );
      const absentReleaseRecoveryStart = requests.length;
      await React.act(async () => {
        releaseRaceReleased = false;
        releaseVisibleReady!(absentReleaseImageId, {
          revision: 7,
          summary: readyReleaseSummary
        });
        await Promise.resolve();
      });
      assert.equal(releaseRaceReleased, true);
      await settleUntil(() => (
        ownerView().total === 20
        && ownerView().page === 1
        && ownerView().totalPages === 1
      ));
      assert.equal(
        ownerView().ready,
        20,
        "目标不在 bounded items 时仍须按 discard revision 立即扣减 ready"
      );
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, absentReleaseRecoveryStart)
      ));
      const absentReleaseFailedProof = pendingRequest(
        ingestionSnapshotPath,
        absentReleaseRecoveryStart
      )!;
      const firstAbsentReleaseProofUrl = new URL(
        absentReleaseFailedProof.url,
        "https://imageshow.test"
      );
      assert.equal(
        firstAbsentReleaseProofUrl.searchParams.get("offset"),
        "0",
        "21→20 跨页释放必须先原子夹紧到第一页再启动 proof"
      );
      assert.equal(
        requests.slice(absentReleaseRecoveryStart).filter((request) => (
          new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )).length,
        1,
        "跨页释放不得先按已越界 offset 发出随后被中止的 proof"
      );
      assert.equal(absentReleaseFailedProof.aborted, false);
      await React.act(async () => {
        absentReleaseFailedProof.resolve(new Response(JSON.stringify({
          ok: false,
          error: "controlled absent release proof retry",
          details: {}
        }), {
          status: 500,
          headers: { "content-type": "application/json" }
        }));
        await clock.advanceBy(100);
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, absentReleaseRecoveryStart)
      ));
      const absentReleaseProof = pendingRequest(
        ingestionSnapshotPath,
        absentReleaseRecoveryStart
      )!;
      const absentReleaseProofUrl = new URL(
        absentReleaseProof.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(absentReleaseProof, {
          queue: "upload",
          revision: 7,
          last_accepted_order: 40,
          offset: Number(absentReleaseProofUrl.searchParams.get("offset")),
          limit: Number(absentReleaseProofUrl.searchParams.get("limit")),
          total: 20,
          unfinished: 20,
          waiting: 0,
          running: 0,
          ready: 20,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: boundaryItems.filter((item) => (
            item.image_id !== absentReleaseImageId
          )).map((item) => ({
            ...item,
            last_semantic_revision: 7
          })),
          action_watermark: "watermark-release-target-absent-covered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
        && ownerView().total === 20
        && ownerView().ready === 20
      ));
      assert.equal(
        requests.slice(absentReleaseRecoveryStart).filter((request) => (
          !request.aborted
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )).length,
        2,
        "目标缺席时一次失败只允许按既定退避续接同一 proof snapshot"
      );

      const releaseBoundaryTrimStart = requests.length;
      await React.act(async () => {
        refreshOwner!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, releaseBoundaryTrimStart)
      ));
      const releaseBoundaryTrimSnapshot = pendingRequest(
        ingestionSnapshotPath,
        releaseBoundaryTrimStart
      )!;
      const releaseBoundaryTrimUrl = new URL(
        releaseBoundaryTrimSnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(releaseBoundaryTrimSnapshot, {
          queue: "upload",
          revision: 7,
          last_accepted_order: 40,
          offset: Number(releaseBoundaryTrimUrl.searchParams.get("offset")),
          limit: Number(releaseBoundaryTrimUrl.searchParams.get("limit")),
          total: 5,
          unfinished: 5,
          waiting: 0,
          running: 0,
          ready: 5,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: afterAbsentReleaseImageIds.map((imageId) => ({
            ...serverItem(
              "ready",
              3,
              10 + visibleReadyReleaseImageIds.indexOf(imageId),
              imageId
            ),
            session_id: visibleReadyReleaseSessionIds[
              visibleReadyReleaseImageIds.indexOf(imageId)
            ],
            last_semantic_revision: 7
          })),
          action_watermark: "watermark-release-boundary-trimmed"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
        && ownerView().page === 1
        && ownerView().total === 5
      ));
      assert.deepEqual(
        ownerView().visible.map((job) => job.id),
        afterAbsentReleaseImageIds,
        "同窗口 proof 成功后必须释放临时投影并保留其余原顺序"
      );

      const failedReleaseImageId = afterAbsentReleaseImageIds[0]!;
      const failedReleaseRemainingImageIds = afterAbsentReleaseImageIds.filter(
        (imageId) => imageId !== failedReleaseImageId
      );
      const failedReleaseRecoveryStart = requests.length;
      await React.act(async () => {
        releaseRaceReleased = false;
        releaseVisibleReady!(failedReleaseImageId);
        await Promise.resolve();
      });
      assert.equal(releaseRaceReleased, true);
      assert.deepEqual(
        ownerView().visible.map((job) => job.id),
        failedReleaseRemainingImageIds,
        "恢复读取失败前也必须立即移除目标并维持其余四张顺序"
      );
      assert.equal(ownerView().total, 4);
      assert.equal(ownerView().ready, 4);

      const recoveryDelays = [100, 500, 1_500] as const;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await settleUntil(() => Boolean(
          pendingRequest(ingestionSnapshotPath, failedReleaseRecoveryStart)
        ));
        const failedRecoverySnapshot = pendingRequest(
          ingestionSnapshotPath,
          failedReleaseRecoveryStart
        )!;
        await React.act(async () => {
          failedRecoverySnapshot.resolve(new Response(JSON.stringify({
            ok: false,
            error: `controlled resolved-release recovery failure ${attempt + 1}`,
            details: {}
          }), {
            status: 500,
            headers: { "content-type": "application/json" }
          }));
          await Promise.resolve();
        });
        const retryDelay = recoveryDelays[attempt];
        if (retryDelay !== undefined) {
          await React.act(async () => {
            await clock.advanceBy(retryDelay);
          });
        }
      }
      await settleUntil(() => ownerView().status === "error");
      assert.deepEqual(
        ownerView().visible.map((job) => job.id),
        failedReleaseRemainingImageIds,
        "恢复读取最终失败时只允许暂时过滤 retained 旧基线"
      );
      assert.equal(ownerView().total, 4);
      assert.equal(ownerView().ready, 4);

      await React.act(async () => {
        ownerRoot.render(withQueryClient(
          React.createElement(OwnerProbe, { displayed: false })
        ));
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().status === "idle");
      assert.equal(ownerSource.closed, true);
      assert.equal(ControlledEventSource.active.size, 0);

      const reopenedOwnerSourceStart = ControlledEventSource.all.length;
      const reopenedOwnerSnapshotStart = requests.length;
      await React.act(async () => {
        ownerRoot.render(withQueryClient(
          React.createElement(OwnerProbe, { displayed: true })
        ));
        await Promise.resolve();
      });
      await settleUntil(() => (
        ControlledEventSource.all.length === reopenedOwnerSourceStart + 1
      ));
      const reopenedOwnerSource = ControlledEventSource.all.at(-1)!;
      await React.act(async () => {
        reopenedOwnerSource.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 6,
          action_scope: "scope-owner-resolved-release-reopened"
        });
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, reopenedOwnerSnapshotStart)
      ));
      const reopenedOwnerSnapshot = pendingRequest(
        ingestionSnapshotPath,
        reopenedOwnerSnapshotStart
      )!;
      const reopenedOwnerUrl = new URL(
        reopenedOwnerSnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(reopenedOwnerSnapshot, {
          queue: "upload",
          revision: 6,
          last_accepted_order: 16,
          offset: Number(reopenedOwnerUrl.searchParams.get("offset")),
          limit: Number(reopenedOwnerUrl.searchParams.get("limit")),
          total: 5,
          unfinished: 5,
          waiting: 0,
          running: 0,
          ready: 5,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: afterAbsentReleaseImageIds.map((imageId) => ({
            ...serverItem(
              "ready",
              3,
              10 + visibleReadyReleaseImageIds.indexOf(imageId),
              imageId
            ),
            session_id: visibleReadyReleaseSessionIds[
              visibleReadyReleaseImageIds.indexOf(imageId)
            ],
            last_semantic_revision: 6
          })),
          action_watermark: "watermark-resolved-release-reopened"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
        && ownerView().visible.length === 5
      ));
      assert.deepEqual(
        ownerView().visible.map((job) => job.id),
        afterAbsentReleaseImageIds,
        "关闭后重新打开必须清除失败恢复过滤并接受新权威快照"
      );
      assert.equal(ownerView().total, 5);
      assert.equal(ownerView().ready, 5);

      const clearedCompletedSessionId = "N".repeat(43);
      const clearedCompletedImageId =
        "00000000-0000-7046-8000-00000000008e";
      const retainedCompletedSessionId = "O".repeat(43);
      const retainedCompletedImageId =
        "00000000-0000-7047-8000-00000000008e";
      const browserCompletedSessionId = "R".repeat(43);
      const browserCompletedImageId =
        "00000000-0000-7048-8000-00000000008e";
      const ownerCompletedItem = (
        sessionId: string,
        imageId: string,
        revision: number,
        acceptedOrder: number
      ) => ({
        session_id: sessionId,
        image_id: imageId,
        queue: "upload" as const,
        status: "completed" as const,
        version: 3,
        progress_seq: 0,
        last_semantic_revision: revision,
        accepted_order: acceptedOrder,
        completed_at: 2,
        completed_item: adminImageListItem({ id: imageId })
      });
      const completedCleanupBaselineStart = requests.length;
      await React.act(async () => {
        refreshOwner!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, completedCleanupBaselineStart)
      ));
      const completedCleanupBaseline = pendingRequest(
        ingestionSnapshotPath,
        completedCleanupBaselineStart
      )!;
      const completedCleanupBaselineUrl = new URL(
        completedCleanupBaseline.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(completedCleanupBaseline, {
          queue: "upload",
          revision: 7,
          last_accepted_order: 19,
          offset: Number(
            completedCleanupBaselineUrl.searchParams.get("offset")
          ),
          limit: Number(
            completedCleanupBaselineUrl.searchParams.get("limit")
          ),
          total: 3,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 3,
          failed: 0,
          items: [
            ownerCompletedItem(
              clearedCompletedSessionId,
              clearedCompletedImageId,
              7,
              17
            ),
            ownerCompletedItem(
              retainedCompletedSessionId,
              retainedCompletedImageId,
              8,
              18
            ),
            ownerCompletedItem(
              browserCompletedSessionId,
              browserCompletedImageId,
              9,
              19
            )
          ],
          action_watermark: "watermark-before-completed-cleanup"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
        && ownerView().visible.length === 3
      ));
      await React.act(async () => {
        markOwnerCompletedBrowserOwned!(browserCompletedImageId);
        await Promise.resolve();
      });
      assert.ok(ownerView().visible.some((job) => (
        job.id === browserCompletedImageId
      )));

      const completedCleanupRecoveryStart = requests.length;
      let completedCleanupRecovery!: Promise<void>;
      const completedCleanupResult: IngestionQueueActionResultDto = {
        processed: 3,
        changed: 2,
        failed: 0,
        items: [{
          session_id: clearedCompletedSessionId,
          image_id: clearedCompletedImageId,
          status: "changed"
        }, {
          session_id: retainedCompletedSessionId,
          image_id: retainedCompletedImageId,
          status: "skipped",
          code: "ingestion_action_state_changed",
          message: "任务在操作确认后已发生变化"
        }, {
          session_id: browserCompletedSessionId,
          image_id: browserCompletedImageId,
          status: "changed"
        }]
      };
      await React.act(async () => {
        assert.equal(
          projectOwnerCompletedCleanupBatch!(completedCleanupResult),
          2
        );
        await Promise.resolve();
      });
      assert.deepEqual(
        ownerView().visible.map((job) => job.id),
        [retainedCompletedImageId],
        "逐批成功投影必须先移除同 pair 的 Server 与浏览器展示卡片"
      );
      assert.equal(
        requests.length,
        completedCleanupRecoveryStart,
        "逐批展示投影本身不得为每个 continuation 启动权威读取"
      );
      await React.act(async () => {
        completedCleanupRecovery = recoverOwnerAfterSuccessfulAction!(
          completedCleanupResult
        );
        await Promise.resolve();
      });
      assert.equal(ownerView().status, "loading");
      assert.deepEqual(
        ownerView().visible.map((job) => job.id),
        [retainedCompletedImageId],
        "动作后权威恢复期间必须继续保留逐批成功投影和边界外任务"
      );
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, completedCleanupRecoveryStart)
      ));
      const completedCleanupRecoverySnapshot = pendingRequest(
        ingestionSnapshotPath,
        completedCleanupRecoveryStart
      )!;
      assert.equal(
        requests.filter((request, index) => (
          index >= completedCleanupRecoveryStart
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )).length,
        1,
        "组合投影释放与 raw baseline 失效必须复用一个 post-action snapshot"
      );
      const completedCleanupRecoveryUrl = new URL(
        completedCleanupRecoverySnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(completedCleanupRecoverySnapshot, {
          queue: "upload",
          revision: 8,
          last_accepted_order: 18,
          offset: Number(
            completedCleanupRecoveryUrl.searchParams.get("offset")
          ),
          limit: Number(
            completedCleanupRecoveryUrl.searchParams.get("limit")
          ),
          total: 1,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 1,
          failed: 0,
          items: [ownerCompletedItem(
            retainedCompletedSessionId,
            retainedCompletedImageId,
            8,
            18
          )],
          action_watermark: "watermark-after-completed-cleanup"
        });
        await completedCleanupRecovery;
      });
      await settleUntil(() => ownerView().status === "ready");
      assert.deepEqual(
        ownerView().visible.map((job) => job.id),
        [retainedCompletedImageId]
      );
      assert.deepEqual(
        requests.filter((request) => !request.aborted && !request.resolved)
          .map((request) => new URL(
            request.url,
            "https://imageshow.test"
          ).pathname),
        [],
        "23 项离页完成回归开始前不得遗留权威读取"
      );

      assert.ok(prepareOffPageCompletionBatch);
      let projectedRetainedCleanup = 0;
      await React.act(async () => {
        projectedRetainedCleanup = projectOwnerCompletedCleanupBatch!({
          processed: 1,
          changed: 1,
          failed: 0,
          items: [{
            session_id: retainedCompletedSessionId,
            image_id: retainedCompletedImageId,
            status: "changed"
          }]
        });
        await Promise.resolve();
      });
      assert.equal(projectedRetainedCleanup, 1);
      const offPageBaselineRequestStart = requests.length;
      await React.act(async () => {
        prepareOffPageCompletionBatch!();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(ownerView().page, 1);
      assert.equal(ownerView().offPageCompletionOwners, 23);
      await settleUntil(() => Boolean(pendingRequest(
        ingestionSnapshotPath,
        offPageBaselineRequestStart
      )));
      const offPageBaselineRequest = pendingRequest(
        ingestionSnapshotPath,
        offPageBaselineRequestStart
      )!;
      const offPageBaselineUrl = new URL(
        offPageBaselineRequest.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(offPageBaselineRequest, {
          queue: "upload",
          revision: 42,
          last_accepted_order: 42,
          offset: Number(offPageBaselineUrl.searchParams.get("offset")),
          limit: Number(offPageBaselineUrl.searchParams.get("limit")),
          total: 23,
          unfinished: 23,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 23,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: offPageCompletionImageIds.slice(0, 20).map((itemImageId, index) => ({
            session_id: offPageCompletionSessionIds[index],
            image_id: itemImageId,
            queue: "upload",
            source_type: "upload",
            resolved_image_time: "2026-08-23T01:02:03.456Z",
            status: "committing",
            phase: "committing",
            message: "提交中",
            progress: 100,
            version: 5,
            progress_seq: 0,
            last_semantic_revision: 42,
            accepted_order: 20 + index,
            metadata: ingestionJob().draft,
            storage_slug: "local"
          })),
          action_watermark: "watermark-off-page-committing-baseline"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
        && ownerView().revision === 42
        && ownerView().total === 23
      ));
      queryClient.setQueryData(queryKeys.adminImages, {
        cached: "before 23 off-page completions"
      });
      const invalidationsBeforeOffPageCompletion = adminImageInvalidations;
      const offPageCompletionRequestStart = requests.length;
      const offPageCompletionBaseRevision = ownerView().revision ?? 0;
      const currentOwnerSource = [...ControlledEventSource.active].at(-1);
      assert.ok(currentOwnerSource);
      await React.act(async () => {
        offPageCompletionImageIds.forEach((completedImageId, index) => {
          const completedCount = index + 1;
          currentOwnerSource.emit("mutation", {
            type: "mutation",
            queue: "upload",
            kind: "semantic",
            revision: offPageCompletionBaseRevision + index + 1,
            last_accepted_order: 42,
            summary: {
              total: 23,
              unfinished: 23 - completedCount,
              waiting: 0,
              running: 0,
              ready: 0,
              duplicate_pending: 0,
              committing: 23 - completedCount,
              resolving: 0,
              completed: completedCount,
              failed: 0
            },
            session: index === 22
              ? {
                  session_id: offPageCompletionSessionIds[index],
                  image_id: completedImageId,
                  status: "completed",
                  version: 6,
                  progress_seq: 0,
                  last_semantic_revision:
                    offPageCompletionBaseRevision + index + 1,
                  accepted_order: 20 + index
                }
              : {
                  session_id: offPageCompletionSessionIds[index],
                  image_id: completedImageId,
                  queue: "upload",
                  status: "completed",
                  version: 6,
                  progress_seq: 0,
                  last_semantic_revision:
                    offPageCompletionBaseRevision + index + 1,
                  accepted_order: 20 + index,
                  completed_at: 2,
                  display: {
                    source_type: "upload",
                    batch_position: index,
                    original_width: 1600,
                    original_height: 900,
                    original_size: 1,
                    quality: 80,
                    transcoded: false
                  },
                  completed_item: adminImageListItem({
                    id: completedImageId,
                    title: `off-page-completed-${index}`
                  })
                },
            action_watermark: `watermark-off-page-completed-${index}`
          });
        });
        // Replaying the last semantic frame models an SSE reconnect overlap.
        currentOwnerSource.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: offPageCompletionBaseRevision + 23,
          last_accepted_order: 42,
          summary: {
            total: 23,
            unfinished: 0,
            waiting: 0,
            running: 0,
            ready: 0,
            duplicate_pending: 0,
            committing: 0,
            resolving: 0,
            completed: 23,
            failed: 0
          },
          session: {
            session_id: offPageCompletionSessionIds[22],
            image_id: offPageCompletionImageIds[22],
            status: "completed",
            version: 6,
            progress_seq: 0,
            last_semantic_revision: offPageCompletionBaseRevision + 23,
            accepted_order: 42
          },
          action_watermark: "watermark-off-page-completed-22"
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(ownerView().offPageCompletionOwners, 23);
      assert.equal(ownerView().offPageCompletionDone, 23);
      assert.equal(ownerView().total, 23, JSON.stringify(ownerView()));
      assert.equal(ownerView().totalPages, 2, JSON.stringify(ownerView()));
      await settleUntil(() => Boolean(pendingRequest(
        ingestionStatusPath,
        offPageCompletionRequestStart
      )));
      const compactCompletedStatusRequest = pendingRequest(
        ingestionStatusPath,
        offPageCompletionRequestStart
      )!;
      assert.deepEqual(
        JSON.parse(String(compactCompletedStatusRequest.init.body)),
        { items: [{
          session_id: offPageCompletionSessionIds[22],
          image_id: offPageCompletionImageIds[22]
        }] },
        "compact completed 只应按精确 pair 进入既有有界 status owner"
      );
      assert.equal(
        requests.slice(offPageCompletionRequestStart).filter((request) => (
          new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )).length,
        0,
        "compact 离页完成事件不得触发重复分页请求"
      );
      assert.equal(
        adminImageInvalidations,
        invalidationsBeforeOffPageCompletion,
        "compact DTO 未水合时应保留同批唯一图库失效边界"
      );
      await React.act(async () => {
        respond(compactCompletedStatusRequest, {
          items: [{
            session_id: offPageCompletionSessionIds[22],
            image_id: offPageCompletionImageIds[22],
            status: "completed",
            completed_item: adminImageListItem({
              id: offPageCompletionImageIds[22],
              title: "off-page-completed-22"
            }),
            display: {
              source_type: "upload",
              batch_position: 22,
              original_width: 1600,
              original_height: 900,
              original_size: 1,
              quality: 80,
              transcoded: false
            },
            redis_status: "completed",
            redis_version: 6,
            redis_last_semantic_revision:
              offPageCompletionBaseRevision + 23
          }]
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        adminImageInvalidations === invalidationsBeforeOffPageCompletion + 1
      ));
      assert.ok(
        revokedObjectUrls.includes("blob:off-page-completion-preview"),
        "compact 离页完成水合后也必须回收原本地预览 URL"
      );
      assert.equal(
        adminImageInvalidations,
        invalidationsBeforeOffPageCompletion + 1,
        "23 项完成与重连重放只能产生一次图库查询失效"
      );

      const secondPageFirstRenderRequestStart = requests.length;
      await React.act(async () => {
        setOwnerPage!(2);
        await Promise.resolve();
      });
      assert.equal(ownerView().page, 2);
      assert.deepEqual(
        ownerView().visible.slice(0, 3),
        offPageCompletionImageIds.slice(20).map((id) => ({
          id,
          status: "done"
        })),
        "切换第二页后的首次渲染必须在分页响应前直接显示最终状态"
      );
      await settleUntil(() => Boolean(pendingRequest(
        ingestionSnapshotPath,
        secondPageFirstRenderRequestStart
      )));
      const secondPageSnapshot = pendingRequest(
        ingestionSnapshotPath,
        secondPageFirstRenderRequestStart
      )!;
      const secondPageSnapshotUrl = new URL(
        secondPageSnapshot.url,
        "https://imageshow.test"
      );
      assert.equal(secondPageSnapshot.resolved, false);
      await React.act(async () => {
        respond(secondPageSnapshot, {
          queue: "upload",
          revision: offPageCompletionBaseRevision + 23,
          last_accepted_order: 42,
          offset: Number(secondPageSnapshotUrl.searchParams.get("offset")),
          limit: Number(secondPageSnapshotUrl.searchParams.get("limit")),
          total: 23,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 23,
          failed: 0,
          items: offPageCompletionImageIds.slice(20).map((completedImageId, offset) => ({
            session_id: offPageCompletionSessionIds[20 + offset],
            image_id: completedImageId,
            queue: "upload",
            status: "completed",
            version: 6,
            progress_seq: 0,
            last_semantic_revision:
              offPageCompletionBaseRevision + 21 + offset,
            accepted_order: 40 + offset,
            completed_at: 2,
            display: {
              source_type: "upload",
              batch_position: 20 + offset,
              original_width: 1600,
              original_height: 900,
              original_size: 1,
              quality: 80,
              transcoded: false
            },
            completed_item: adminImageListItem({ id: completedImageId })
          })),
          action_watermark: "watermark-off-page-completed-stable"
        });
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().status === "ready");
      assert.equal(ownerView().offPageCompletionOwners, 23);
      assert.equal(ownerView().offPageCompletionDone, 23);
      assert.equal(
        adminImageInvalidations,
        invalidationsBeforeOffPageCompletion + 1,
        "分页水合与完成重放不得重复失效"
      );

      const compactChunkBaselineRequestStart = requests.length;
      await React.act(async () => {
        refreshOwner!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(pendingRequest(
        ingestionSnapshotPath,
        compactChunkBaselineRequestStart
      )));
      const compactChunkBaselineRequest = pendingRequest(
        ingestionSnapshotPath,
        compactChunkBaselineRequestStart
      )!;
      const compactChunkBaselineUrl = new URL(
        compactChunkBaselineRequest.url,
        "https://imageshow.test"
      );
      const compactChunkBaselineRevision = (ownerView().revision ?? 0) + 1;
      const compactChunkLastAcceptedOrder = 144;
      const compactChunkActiveItem = (index: number) => ({
        session_id: compactChunkFailureSessionIds[index],
        image_id: compactChunkFailureImageIds[index],
        queue: "upload" as const,
        source_type: "upload" as const,
        resolved_image_time: "2026-08-23T01:02:03.456Z",
        status: "committing" as const,
        phase: "committing",
        message: "提交中",
        progress: 100,
        version: 5,
        progress_seq: 0,
        last_semantic_revision: compactChunkBaselineRevision,
        accepted_order: 43 + index,
        metadata: ingestionJob().draft,
        storage_slug: "local"
      });
      await React.act(async () => {
        respond(compactChunkBaselineRequest, {
          queue: "upload",
          revision: compactChunkBaselineRevision,
          last_accepted_order: compactChunkLastAcceptedOrder,
          offset: Number(compactChunkBaselineUrl.searchParams.get("offset")),
          limit: Number(compactChunkBaselineUrl.searchParams.get("limit")),
          total: 125,
          unfinished: 102,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 102,
          resolving: 0,
          completed: 23,
          failed: 0,
          items: [
            ...offPageCompletionImageIds.slice(20).map((completedImageId, offset) => ({
              session_id: offPageCompletionSessionIds[20 + offset],
              image_id: completedImageId,
              queue: "upload" as const,
              status: "completed" as const,
              version: 6,
              progress_seq: 0,
              last_semantic_revision:
                offPageCompletionBaseRevision + 21 + offset,
              accepted_order: 40 + offset,
              completed_at: 2,
              completed_item: adminImageListItem({ id: completedImageId })
            })),
            ...compactChunkFailureImageIds.slice(0, 20).map((_imageId, index) => (
              compactChunkActiveItem(index)
            ))
          ],
          action_watermark: "watermark-compact-chunk-failure-baseline"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
        && ownerView().revision === compactChunkBaselineRevision
        && ownerView().total === 125
      ));
      const compactChunkRetainedJobCount = ownerView().jobCount;
      queryClient.setQueryData(queryKeys.adminImages, {
        cached: "before compact chunk failure"
      });
      const invalidationsBeforeCompactChunkFailure = adminImageInvalidations;
      const compactChunkHydrationStart = requests.length;
      const compactCompletedStatus = (index: number) => ({
        session_id: compactChunkFailureSessionIds[index],
        image_id: compactChunkFailureImageIds[index],
        status: "completed" as const,
        completed_item: adminImageListItem({
          id: compactChunkFailureImageIds[index],
          title: `compact-chunk-completed-${index}`
        }),
        redis_status: "completed" as const,
        redis_version: 6,
        redis_last_semantic_revision:
          compactChunkBaselineRevision + index + 1
      });
      const compactCompletedMutation = (index: number) => {
        const completedCount = index + 1;
        return {
          type: "mutation" as const,
          queue: "upload" as const,
          kind: "semantic" as const,
          revision: compactChunkBaselineRevision + completedCount,
          last_accepted_order: compactChunkLastAcceptedOrder,
          summary: {
            total: 125,
            unfinished: 102 - completedCount,
            waiting: 0,
            running: 0,
            ready: 0,
            duplicate_pending: 0,
            committing: 102 - completedCount,
            resolving: 0,
            completed: 23 + completedCount,
            failed: 0
          },
          session: {
            session_id: compactChunkFailureSessionIds[index],
            image_id: compactChunkFailureImageIds[index],
            status: "completed" as const,
            version: 6,
            progress_seq: 0,
            last_semantic_revision:
              compactChunkBaselineRevision + completedCount,
            accepted_order: 43 + index
          },
          action_watermark: `watermark-compact-chunk-completed-${index}`
        };
      };
      await React.act(async () => {
        for (let index = 0; index < 101; index += 1) {
          currentOwnerSource.emit(
            "mutation",
            compactCompletedMutation(index)
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await settleUntil(() => Boolean(pendingRequest(
        ingestionStatusPath,
        compactChunkHydrationStart
      )));
      const compactChunkFirstRequest = pendingRequest(
        ingestionStatusPath,
        compactChunkHydrationStart
      )!;
      const compactChunkFirstPairs = JSON.parse(String(
        compactChunkFirstRequest.init.body
      )).items as Array<{ image_id: string }>;
      assert.deepEqual(
        compactChunkFirstPairs.map((pair) => pair.image_id),
        compactChunkFailureImageIds.slice(0, 100),
        "compact status owner 首批必须保持 100 项硬上限"
      );
      await React.act(async () => {
        respond(compactChunkFirstRequest, {
          items: Array.from(
            { length: 100 },
            (_value, index) => compactCompletedStatus(index)
          )
        });
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(pendingRequest(
        ingestionStatusPath,
        compactChunkHydrationStart
      )));
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const compactChunkRequests = requests.slice(compactChunkHydrationStart)
        .filter((request) => (
          new URL(request.url, "https://imageshow.test").pathname
            === ingestionStatusPath
        ));
      assert.equal(
        compactChunkRequests.length,
        2,
        "成功首批后只能由下一任 effect 对未解决尾部发起一次请求"
      );
      assert.equal(
        compactChunkRequests.some((request) => request.aborted),
        false,
        "正常跨批水合不得先中止再重复请求同一尾部"
      );
      const compactChunkFailedSecondRequest = pendingRequest(
        ingestionStatusPath,
        compactChunkHydrationStart
      )!;
      assert.deepEqual(
        JSON.parse(String(compactChunkFailedSecondRequest.init.body)).items,
        [{
          session_id: compactChunkFailureSessionIds[100],
          image_id: compactChunkFailureImageIds[100]
        }]
      );
      await React.act(async () => {
        compactChunkFailedSecondRequest.resolve(new Response(JSON.stringify({
          ok: false,
          error: "controlled compact second chunk failure",
          details: {}
        }), {
          status: 500,
          headers: { "content-type": "application/json" }
        }));
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().serverNotice.includes(
        "controlled compact second chunk failure"
      ));
      assert.equal(
        adminImageInvalidations,
        invalidationsBeforeCompactChunkFailure,
        "后续 chunk 失败前不得丢失或部分落实先前 compact 水合结果"
      );
      assert.equal(
        ownerView().jobCount,
        compactChunkRetainedJobCount,
        "未知 compact pair 不得挂载额外卡片"
      );
      assert.equal(
        ownerView().compactChunkHydrated,
        17,
        "首个成功 chunk 必须在后续 chunk 失败前完整落实 retained 卡片"
      );

      const compactChunkRetryStart = requests.length;
      await React.act(async () => {
        currentOwnerSource.emit(
          "mutation",
          compactCompletedMutation(101)
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await settleUntil(() => Boolean(pendingRequest(
        ingestionStatusPath,
        compactChunkRetryStart
      )));
      const compactChunkRetryFirstRequest = pendingRequest(
        ingestionStatusPath,
        compactChunkRetryStart
      )!;
      assert.deepEqual(
        (JSON.parse(String(
          compactChunkRetryFirstRequest.init.body
        )).items as Array<{ image_id: string }>)
          .map((pair) => pair.image_id),
        compactChunkFailureImageIds.slice(100),
        "后续事件触发重试时只能读取前一失败 pair 与新 compact pair"
      );
      await React.act(async () => {
        respond(compactChunkRetryFirstRequest, {
          items: [compactCompletedStatus(100), compactCompletedStatus(101)]
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        adminImageInvalidations
          >= invalidationsBeforeCompactChunkFailure + 1
      ));
      assert.equal(
        adminImageInvalidations,
        invalidationsBeforeCompactChunkFailure + 1,
        "失败重试后的全部 compact 完成只能合并为一次图库失效"
      );
      assert.equal(ownerView().jobCount, compactChunkRetainedJobCount);
      const compactReplayStart = requests.length;
      await React.act(async () => {
        currentOwnerSource.emit(
          "mutation",
          compactCompletedMutation(101)
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(
        requests.length,
        compactReplayStart,
        "未知 compact pair 完成水合后，SSE 重放不得再次读取 status"
      );
      assert.equal(
        requests.slice(compactChunkHydrationStart).filter((request) => (
          new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )).length,
        0,
        "未知 compact 水合与失败重试不得追加分页 snapshot"
      );

      await React.act(async () => {
        ownerRoot.render(withQueryClient(
          React.createElement(OwnerProbe, { displayed: false })
        ));
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().status === "idle");
      assert.equal(reopenedOwnerSource.closed, true);
      assert.equal(ControlledEventSource.active.size, 0);
        }
      );
    } finally {
      await React.act(async () => {
        root.unmount();
        ownerRoot.unmount();
        if (!strictRootUnmounted) strictRoot.unmount();
        if (!emptyRootUnmounted) emptyRoot.unmount();
      });
      unsubscribeQueryEvents();
      queryClient.clear();
    }
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
