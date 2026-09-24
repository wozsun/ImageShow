import "../../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { installProperties } from "../../support/property-descriptors.ts";
import {
  ingestionUpdatePath,
  type IngestionQueueSummaryDto
} from "../../../../packages/shared/src/browser.ts";
import type { IngestionJob } from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-job.ts";
import {
  BrowserUploadBatchSequencer,
  BrowserUploadLane
} from "../../../../packages/web/src/pages/admin/ingestion/upload/browser-upload-lane.ts";
import {
  browserDisplayPrefixJobs,
  reduceIngestionQueue
} from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-queue-state.ts";
import { uploadRaw } from "../../../../packages/web/src/pages/admin/ingestion/queue/ingestion-http-client.ts";
import { ingestionJobFromServerItem } from "../../../../packages/web/src/pages/admin/ingestion/queue/model/server-ingestion-job.ts";
import {
  ingestionJob,
  createConfigStreamHarness
} from "../../support/web-test-context.ts";

test("[Web/内容接入] 异常上传回执结束当前请求并释放下一张图片的上传槽", async (t) => {
  const accepted = {
    ok: true,
    session_id: "A".repeat(43),
    image_id: "01980000-0000-7000-8000-000000000001",
    status: "accepted",
    version: 1
  };
  for (const [status, responseText, message] of [
    [200, "null", "上传失败（HTTP 200）"],
    [502, "null", "上传失败（HTTP 502）"],
    [200, "[]", "上传失败（HTTP 200）"],
    [200, '"text"', "上传失败（HTTP 200）"],
    [200, "1", "上传失败（HTTP 200）"],
    [200, "false", "上传失败（HTTP 200）"],
    [200, "{}", "上传失败（HTTP 200）"],
    [502, "<html>bad gateway</html>", "上传失败（HTTP 502）"],
    [502, '{"error":"服务暂不可用"}', "服务暂不可用"],
    [400, '{"error":{"message":"凭据无效"}}', "凭据无效"]
  ] as const) {
    await t.test(`${status} ${responseText}`, async (subtest) => {
      class FakeXhr {
        static instances: FakeXhr[] = [];
        upload = {};
        status = 0;
        responseText = "";
        onload?: () => void;
        onabort?: () => void;
        open() {}
        setRequestHeader() {}
        send() {
          FakeXhr.instances.push(this);
        }
        abort() {
          this.onabort?.();
        }
        respond(status: number, body: string) {
          this.status = status;
          this.responseText = body;
          this.onload?.();
        }
      }
      subtest.after(installProperties(globalThis, { XMLHttpRequest: FakeXhr }));
      const lane = new BrowserUploadLane(1);
      const controller = new AbortController();
      const file = new File(["raw"], "image.webp", { type: "image/webp" });
      const run = () =>
        lane.run(
          controller.signal,
          () => uploadRaw("credential", file, { onProgress: () => undefined }).promise
        );
      const firstRejected = assert.rejects(run(), { message });
      const next = run();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(FakeXhr.instances.length, 1);
      assert.doesNotThrow(() => FakeXhr.instances[0]!.respond(status, responseText));
      await firstRejected;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(FakeXhr.instances.length, 2, "异常回执释放槽位，后续上传无需取消或刷新");
      FakeXhr.instances[1]!.respond(200, JSON.stringify(accepted));
      assert.deepEqual(await next, accepted);
      assert.equal(FakeXhr.instances.length, 2, "不自动重放结果不明的 raw 写入");
    });
  }
});

test("[Web/内容接入] 浏览器上传 lane 统一约束页面工作并响应动态容量与取消", async (t) => {
  const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
      resolve = resolvePromise;
    });
    return { promise, resolve };
  };
  const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
  const waitFor = async (predicate: () => boolean, message: string) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      await nextTurn();
    }
    assert.fail(message);
  };

  await t.test("后续选择不能在既有凭据与 raw 交接之间插入预览", async (subtest) => {
    const lane = new BrowserUploadLane(1);
    const sequence = new BrowserUploadBatchSequencer();
    const rawRelease = gate();
    const starts: string[] = [];
    const signal = new AbortController().signal;
    subtest.after(() => rawRelease.resolve());
    const runLane = (
      name: string,
      work: () => Promise<void> = async () => {}
    ) =>
      lane.run(signal, async () => {
        starts.push(name);
        await work();
      });

    const first = sequence.run(async () => {
      await runLane("first-preview");
      await runLane("first-credential");
      await runLane("first-raw", () => rawRelease.promise);
    });
    const second = sequence.run(async () => {
      await Promise.all([
        runLane("second-preview-1"),
        runLane("second-preview-2")
      ]);
    });

    await waitFor(
      () => starts.includes("first-raw"),
      "first credential did not hand off to raw"
    );
    assert.deepEqual(starts, [
      "first-preview",
      "first-credential",
      "first-raw"
    ]);
    rawRelease.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(starts, [
      "first-preview",
      "first-credential",
      "first-raw",
      "second-preview-1",
      "second-preview-2"
    ]);
  });

  await t.test("预览、凭据和 raw 共用容量且提额按 FIFO 补位", async (subtest) => {
    const lane = new BrowserUploadLane(2);
    const releases = [gate(), gate(), gate(), gate()];
    const starts: string[] = [];
    let active = 0;
    let maximumActive = 0;
    subtest.after(() => releases.forEach((release) => release.resolve()));
    const run = (name: string, release: ReturnType<typeof gate>) =>
      lane.run(new AbortController().signal, async () => {
        starts.push(name);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await release.promise;
        } finally {
          active -= 1;
        }
      });
    const runs = [
      run("preview", releases[0]),
      run("raw", releases[1]),
      run("credential", releases[2]),
      run("next", releases[3])
    ];
    await waitFor(() => starts.length === 2, "initial page capacity was not filled");
    assert.deepEqual(starts, ["preview", "raw"]);
    lane.setLimit(3);
    await waitFor(() => starts.length === 3, "raised page capacity did not drain");
    assert.deepEqual(starts, ["preview", "raw", "credential"]);
    assert.equal(maximumActive, 3);
    releases[0].resolve();
    await waitFor(() => starts.length === 4, "FIFO page waiter did not resume");
    releases.slice(1).forEach((release) => release.resolve());
    await Promise.all(runs);
  });

  await t.test("降额让活动工作完成后再发新许可", async (subtest) => {
    const lane = new BrowserUploadLane(2);
    const releases = [gate(), gate(), gate()];
    const starts: number[] = [];
    subtest.after(() => releases.forEach((release) => release.resolve()));
    const runs = releases.map((release, index) =>
      lane.run(new AbortController().signal, async () => {
        starts.push(index);
        await release.promise;
      })
    );
    await waitFor(() => starts.length === 2, "initial page work did not start");
    lane.setLimit(1);
    releases[0].resolve();
    await runs[0];
    await nextTurn();
    assert.deepEqual(starts, [0, 1]);
    releases[1].resolve();
    await waitFor(() => starts.length === 3, "lowered page lane never resumed");
    releases[2].resolve();
    await Promise.all(runs);
  });

  await t.test("等待与许可交接取消均不启动工作并释放容量", async (subtest) => {
    const lane = new BrowserUploadLane(1);
    const firstRelease = gate();
    const waitingController = new AbortController();
    const handoffError = new Error("page cancellation at permit handoff");
    let handoffAbortReads = 0;
    const handoffSignal = {
      get aborted() {
        handoffAbortReads += 1;
        return handoffAbortReads >= 4;
      },
      reason: handoffError,
      addEventListener() {},
      removeEventListener() {}
    } as unknown as AbortSignal;
    const starts: string[] = [];
    subtest.after(() => firstRelease.resolve());
    const first = lane.run(new AbortController().signal, async () => {
      starts.push("first");
      await firstRelease.promise;
    });
    const waiting = lane.run(waitingController.signal, async () => {
      starts.push("cancelled-waiter");
    });
    const handoff = lane.run(handoffSignal, async () => {
      starts.push("cancelled-handoff");
    });
    await waitFor(() => starts.length === 1, "first page work did not start");
    const waitingError = new Error("waiting upload cancelled");
    waitingController.abort(waitingError);
    await assert.rejects(waiting, (error) => error === waitingError);
    firstRelease.resolve();
    await first;
    await assert.rejects(handoff, (error) => error === handoffError);
    assert.deepEqual(starts, ["first"]);
    const workError = new Error("page work failed");
    await assert.rejects(
      lane.run(new AbortController().signal, async () => {
        throw workError;
      }),
      (error) => error === workError
    );
    await lane.run(new AbortController().signal, async () => undefined);
  });

  await t.test("后续凭据批次读取归一化后的当前容量", () => {
    const lane = new BrowserUploadLane(4.9);
    assert.equal(lane.limit, 4);
    lane.setLimit(2);
    assert.equal(lane.limit, 2);
    lane.setLimit(Number.NaN);
    assert.equal(lane.limit, 1);
  });
});
test("[Web/内容接入] 大队列页外进度和缓冲进度不重复请求当前快照", async (t) => {
  const h = await createConfigStreamHarness(t);
  class Events extends EventTarget {
    static current: Events;
    constructor(_url: string) {
      super();
      Events.current = this;
    }
    close() {}
    emit(type: string, data: unknown) {
      this.dispatchEvent(Object.assign(new Event(type), { data: JSON.stringify(data) }));
    }
  }
  t.after(installProperties(globalThis, { EventSource: Events }));
  const { useServerIngestionQueue } =
    await import("../../../../packages/web/src/pages/admin/ingestion/queue/useServerIngestionQueue.ts");
  const items = Array.from({ length: 800 }, (_, index) => ({
    session_id: String(index).padStart(43, "S"),
    image_id: `019f8457-063a-7${index.toString(16).padStart(3, "0")}-a580-00000000008e`,
    queue: "import" as const,
    source_type: "url" as const,
    resolved_image_time: "2026-09-14T00:00:00.000Z",
    status: "preparing" as const,
    phase: "prepare-waiting",
    message: "待处理",
    version: 2,
    progress_seq: 0,
    last_semantic_revision: 800,
    accepted_order: index + 1,
    metadata: ingestionJob().draft,
    storage_slug: "local"
  }));
  const pairs = items.map(({ session_id, image_id }) => ({ session_id, image_id }));
  let view!: ReturnType<typeof useServerIngestionQueue>;
  function Probe() {
    view = useServerIngestionQueue({
      enabled: true,
      displayed: true,
      queue: "import",
      offset: 0,
      limit: 20,
      requiredItems: 20,
      excludeItems: pairs,
      includeItems: pairs.slice(0, 20)
    });
    return null;
  }
  await h.render(h.React.createElement(Probe));
  await h.React.act(async () =>
    Events.current.emit("ready", {
      type: "ready",
      queue: "import",
      revision: 800,
      action_scope: "large-queue"
    })
  );
  assert.equal(h.pending.length, 1);
  let revision = 800;
  let summary: IngestionQueueSummaryDto = {
    total: 800,
    unfinished: 800,
    waiting: 600,
    running: 2,
    ready: 98,
    duplicate_pending: 0,
    committing: 0,
    resolving: 0,
    completed: 0,
    failed: 0
  };
  const snapshot = () => ({
    ...summary,
    queue: "import",
    revision,
    last_accepted_order: 800,
    offset: 0,
    limit: 20,
    items: items.slice(0, 20),
    stale_items: [],
    action_watermark: "watermark"
  });
  const initialSnapshot = snapshot();
  const progress = (index: number) => ({
    type: "mutation",
    queue: "import",
    kind: "progress",
    revision,
    last_accepted_order: 800,
    summary: { ...summary, running: 3 },
    session: { ...items[100 + index], phase: "normalizing", message: "处理中", progress_seq: 1 }
  });
  // The first progress frame arrives while the initial HTTP snapshot is in flight.
  await h.React.act(async () => Events.current.emit("mutation", progress(0)));
  await h.respond(0, initialSnapshot);
  assert.equal(view.summary?.running, 3);
  for (let index = 0; index < 20; index += 1) {
    if (index) await h.React.act(async () => Events.current.emit("mutation", progress(index)));
    assert.equal(view.summary?.running, 3);
    // Completing a worker is semantic; the next admitted task can then start.
    revision += 1;
    summary = { ...summary, ready: summary.ready + 1 };
    await h.React.act(async () =>
      Events.current.emit("mutation", {
        type: "mutation",
        queue: "import",
        kind: "semantic",
        revision,
        last_accepted_order: 800,
        summary,
        session: {
          ...items[100 + index],
          status: "ready",
          version: 3,
          last_semantic_revision: revision
        }
      })
    );
  }
  await h.flush();
  assert.equal(h.pending.length, 1, "20 次页外进入处理不产生整页回读");
  assert.equal(view.summary?.ready, 118);
  assert.deepEqual(view.items, items.slice(0, 20));
  t.diagnostic(
    `800 项 / 20 项展示：初始化 1 次，20 次页外处理额外快照 0 次；每次请求正文 ${Buffer.byteLength(String(h.pending[0].body))} B`
  );
  // An actual revision gap must still recover through the same owner.
  await h.React.act(async () =>
    Events.current.emit("mutation", {
      ...progress(25),
      revision: revision + 2
    })
  );
  await h.flush();
  assert.equal(h.pending.length, 2);
  revision += 2;
  await h.respond(1, snapshot());
  assert.equal(view.status, "ready");
});

test("[Web/内容接入] 各来源及恢复任务原位重试保留身份时间与当前页", async (t) => {
  const h = await createConfigStreamHarness(t);
  const { useIngestionRetry } =
    await import("../../../../packages/web/src/pages/admin/ingestion/queue/useIngestionRetry.ts");
  let state = { page: 2, jobs: [] as IngestionJob[] };
  let recoveries = 0;
  const jobsRef = {
    get current() {
      return state.jobs;
    }
  };
  const queue = {
    jobsRef,
    observeCompletedIngestions() {},
    appendJobs(jobs: IngestionJob[]) {
      state = reduceIngestionQueue(state, { type: "append", jobs });
      return true;
    },
    updateJob(id: string, patch: Partial<IngestionJob>) {
      state = reduceIngestionQueue(state, { type: "patch", id, patch });
    },
    bindServerJob(
      id: string,
      binding: Partial<IngestionJob> & { sessionId: string; imageId: string }
    ) {
      state = reduceIngestionQueue(state, { type: "bind-server", id, binding });
    },
    captureServerConnectionGeneration: () => 1,
    server: {
      recoverAfterSuccessfulAction: async () => {
        recoveries += 1;
      }
    }
  };
  let owner!: ReturnType<typeof useIngestionRetry>;
  function Probe() {
    owner = useIngestionRetry({
      queue: queue as never,
      retryBrowserJobs: async () => {},
      commitJobs: async () => false
    });
    return null;
  }
  await h.render(h.React.createElement(Probe));
  for (const [count, source] of [
    [31, "weibo"],
    [21, "jsonl"],
    [21, undefined],
    [21, "upload"]
  ] as const) {
    const imageTime = "2020-06-17T02:30:45.000Z";
    state = {
      page: 2,
      jobs: Array.from({ length: count }, (_, index) =>
        ingestionJobFromServerItem({
          session_id: String(index).padStart(43, "S"),
          image_id: `019f8457-063a-7${index.toString(16).padStart(3, "0")}-a580-00000000008e`,
          queue: source === "upload" ? "upload" : "import",
          source_type: source ?? "url",
          batch_position: index,
          download_url: "https://images.example.com/photo.png",
          resolved_image_time: imageTime,
          status: "failed",
          phase: "failed",
          message: "内容接入执行权已转移",
          version: 1,
          progress_seq: 0,
          last_semantic_revision: 1,
          accepted_order: index + 1,
          storage_slug: "local",
          metadata: ingestionJob().draft
        })
      )
    };
    const before = state.jobs[20];
    const ids = state.jobs.map(({ id }) => id);
    const start = h.pending.length;
    let retry!: Promise<void>;
    await h.React.act(async () => {
      retry = owner.retry(before);
    });
    await h.flush();
    await owner.retry(before);
    assert.equal(h.pending.length, start + 1, "同一重试正在等待时不重复写入");
    assert.equal(h.pending[start].path, ingestionUpdatePath);
    const input = JSON.parse(String(h.pending[start].body)).items[0];
    assert.deepEqual(input, {
      session_id: before.sessionId,
      image_id: before.imageId,
      expected_version: 1,
      metadata: before.draft,
      retry_prepare: true
    });
    const recoveryBefore = recoveries;
    await h.respond(start, {
      items: [
        {
          session_id: before.sessionId,
          image_id: before.imageId,
          status: "changed",
          version: 2,
          last_semantic_revision: 2,
          duplicate_count: 0,
          duplicate_decision: "upload"
        }
      ]
    });
    await h.React.act(async () => {
      await retry;
    });
    assert.equal(recoveries, recoveryBefore + 1);
    assert.equal(state.page, 2);
    assert.deepEqual(
      state.jobs.map(({ id }) => id),
      ids
    );
    assert.equal(state.jobs[20].attemptKey, before.attemptKey);
    assert.equal(state.jobs[20].imageTime, imageTime);
    assert.equal(state.jobs[20].browserDisplayReleased, true);
    assert.deepEqual(browserDisplayPrefixJobs(state.jobs), [], "恢复卡片不能提升到浏览器前缀");
    assert.equal(state.jobs[20].serverAccepted, true);
    assert.equal(state.jobs[20].imageTime, imageTime);
  }
  const current = state.jobs[20];
  const failedRequest = h.pending.length;
  let uncertainRetry!: Promise<void>;
  await h.React.act(async () => {
    uncertainRetry = owner.retry(current);
  });
  await h.respond(failedRequest, { ok: false, error: "response lost" }, 502);
  await h.React.act(async () => {
    await uncertainRetry;
  });
  assert.equal(h.pending.length, failedRequest + 1, "不自动重发未知写入结果");
  assert.equal(recoveries, 5, "写回执丢失后仍由原 owner 回读一次");
  assert.equal(state.page, 2);
  assert.equal(state.jobs[20].imageTime, current.imageTime);
  queue.appendJobs([ingestionJob({ id: "new-batch" })]);
  assert.equal(state.page, 1);
});
