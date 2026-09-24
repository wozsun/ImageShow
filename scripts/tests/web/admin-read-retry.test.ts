import "../support/web-environment.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { QueryClient, QueryObserver, isCancelledError } from "@tanstack/react-query";
import { ApiClientError } from "../../../packages/web/src/lib/api/client.ts";
import { readEditableImageSnapshots } from "../../../packages/web/src/lib/api/image-edit.ts";
import { ingestionVocabularyQueryOptions } from "../../../packages/web/src/lib/api/ingestion-vocabulary.ts";
import { storageOptionsQueryOptions } from "../../../packages/web/src/lib/api/storage-options.ts";
import { queryKeys } from "../../../packages/web/src/lib/api/query-keys.ts";
import { invalidateImageDataAfterMetadataSave } from "../../../packages/web/src/lib/api/query-invalidation.ts";
import { installControlledClock } from "../support/controlled-clock.ts";
import { installProperties } from "../support/property-descriptors.ts";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { useImageMetadataOperations } from "../../../packages/web/src/components/image/editor/useImageMetadataOperations.ts";
import { editableImage } from "../support/web-test-context.ts";
import {
  createImageMetadataSession,
  reconcileImageMetadataSession
} from "../../../packages/web/src/components/image/editor/image-metadata-session.ts";

const imageId = "00000000-0000-7000-8000-000000000631";
const sharedReads = [
  {
    name: "词表",
    options: ingestionVocabularyQueryOptions,
    data: { themes: [], tags: [], authors: [] }
  },
  { name: "存储选项", options: storageOptionsQueryOptions, data: { backends: [] } }
] as const;

function createReadHarness(t: TestContext, fetchMock: typeof fetch, includeDateNow = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } }
  });
  const clock = installControlledClock(t, window, {
    includeGlobalTimers: true,
    includeDateNow
  });
  t.after(installProperties(globalThis, { fetch: fetchMock }));
  t.after(() => client.clear());
  return { client, clock };
}

async function settleRequests() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function stalledResponse(init: RequestInit | undefined, phase: "headers" | "body") {
  const signal = init?.signal;
  assert.ok(signal, "读取必须把取消和超时传给实际 fetch");
  signal.throwIfAborted();
  if (phase === "headers")
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  return Promise.resolve(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"items":'));
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        }
      })
    )
  );
}

for (const phase of ["headers", "body"] as const) {
  test(`[Web/后台保存] 写响应挂起后限时进入快照确认，保留冻结意图和新草稿 / ${phase}`, async (t) => {
    t.after(
      installProperties(window, {
        location: { pathname: "/admin/images", href: "http://imageshow.test/admin/images" }
      })
    );
    const ids = [imageId, "00000000-0000-7000-8000-000000000633"];
    const baseline = ids.map((id) => editableImage(id));
    const updates = ids.map((id) => ({ id, title: "submitted", tags: ["submitted-tag"] }));
    const authority = ids.map((id) =>
      editableImage(id, { title: "submitted", tags: ["submitted-tag"] })
    );
    const snapshotGate = Promise.withResolvers<void>();
    let writes = 0,
      snapshots = 0,
      invalidations = 0;
    let writeSignal: AbortSignal | null | undefined;
    const { clock } = createReadHarness(
      t,
      async (input, init) => {
        if (String(input).endsWith("/logs/client-errors")) return Response.json({ ok: true });
        if (String(input).endsWith("/images/update")) {
          writes++;
          assert.deepEqual(JSON.parse(String(init?.body)), { items: updates });
          writeSignal = init?.signal;
          return stalledResponse(
            { ...init, signal: init?.signal ?? new AbortController().signal },
            phase
          );
        }
        assert.ok(String(input).endsWith("/images/snapshot"));
        snapshots++;
        await snapshotGate.promise;
        return Response.json({ items: authority });
      },
      true
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let operations!: ReturnType<typeof useImageMetadataOperations>;
    function Harness() {
      operations = useImageMetadataOperations({
        initialIds: ids,
        onSaved: async () => {
          invalidations++;
        }
      });
      return null;
    }
    try {
      await React.act(async () => root.render(React.createElement(Harness)));
      let pending!: ReturnType<typeof operations.save>;
      await React.act(async () => {
        pending = operations.save(updates, ids);
      });
      await React.act(async () => {
        await clock.advanceBy(29_999);
        await settleRequests();
      });
      assert.equal(snapshots, 0);
      await React.act(async () => {
        await clock.advanceBy(1);
        await settleRequests();
      });
      assert.equal(snapshots, 1, "写响应未返回也应开始只读确认");
      assert.equal(writeSignal?.reason.name, "TimeoutError");
      assert.equal(operations.saveStatus.pending, true, "批量保存等待同一整批锁后的快照");
      // A caller's later edit must not rewrite the submitted attempt.
      updates[0]!.title = "new-draft";
      updates[0]!.tags.push("new-tag");
      const session = createImageMetadataSession(baseline);
      session.drafts[ids[0]!]!.title = "new-draft";
      session.drafts[ids[0]!]!.tags = ["submitted-tag", "new-tag"];
      snapshotGate.resolve();
      let outcome: Awaited<typeof pending>;
      await React.act(async () => {
        outcome = await pending;
      });
      assert.ok(outcome!);
      assert.equal(outcome!.report.responseReceived, false);
      assert.equal(outcome!.report.updated, 2);
      assert.deepEqual(outcome!.attempt.items[0], {
        id: ids[0],
        title: "submitted",
        tags: ["submitted-tag"]
      });
      const reconciled = reconcileImageMetadataSession(
        session,
        outcome!.attempt,
        outcome!.authoritativeItems!
      );
      assert.equal(reconciled.drafts[ids[0]!]!.title, "new-draft");
      assert.deepEqual(reconciled.drafts[ids[0]!]!.tags, ["submitted-tag", "new-tag"]);
      assert.equal(writes, 1);
      assert.equal(invalidations, 1);
      assert.equal(operations.saveStatus.pending, false);
      assert.equal(operations.pendingReconciliation, false);
      assert.equal(clock.pendingCount(), 0);
    } finally {
      snapshotGate.resolve();
      await React.act(async () => root.unmount());
      container.remove();
    }
  });
}

for (const { confirmation, automatic } of [
  { confirmation: "save", automatic: false },
  { confirmation: "restore", automatic: false },
  { confirmation: "save", automatic: true }
] as const) {
  test(`[Web/后台保存] 未知写入迟于首次确认完成，人工确认交接最新列表和词表 / ${confirmation}${automatic ? " auto" : ""}`, async (t) => {
    t.after(
      installProperties(window, {
        location: { pathname: "/admin/images", href: "http://imageshow.test/admin/images" }
      })
    );
    const before = editableImage(imageId);
    const after = editableImage(imageId, {
      title: "committed",
      tags: ["new-tag"],
      brightness: "light"
    });
    let committed = false;
    let writes = 0,
      snapshots = 0,
      listReads = 0,
      vocabularyReads = 0;
    const { client, clock } = createReadHarness(
      t,
      async (input, init) => {
        if (String(input).endsWith("/logs/client-errors")) return Response.json({ ok: true });
        if (String(input).endsWith("/images/update")) {
          writes++;
          return stalledResponse(init, "headers");
        }
        if (String(input).endsWith("/images/snapshot")) {
          snapshots++;
          return committed ? Response.json({ items: [after] }) : stalledResponse(init, "headers");
        }
        assert.ok(String(input).endsWith("/ingestion/vocabulary"));
        vocabularyReads++;
        return Response.json({
          themes: [],
          authors: [],
          tags: committed ? [{ slug: "new-tag", display_name: "new-tag" }] : []
        });
      },
      true
    );
    const list = new QueryObserver(client, {
      queryKey: [...queryKeys.adminImages, "current-page"],
      staleTime: Infinity,
      queryFn: async () => {
        listReads++;
        return { items: [committed ? after : before] };
      }
    });
    const vocabulary = new QueryObserver(client, ingestionVocabularyQueryOptions);
    const unsubscribeList = list.subscribe(() => {});
    const unsubscribeVocabulary = vocabulary.subscribe(() => {});
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let operations!: ReturnType<typeof useImageMetadataOperations>;
    function Harness() {
      operations = useImageMetadataOperations({
        initialIds: [imageId],
        onSaved: async (commit) => {
          assert.ok(commit);
          await invalidateImageDataAfterMetadataSave(
            client,
            commit.updates,
            commit.authoritativeItems
          );
        }
      });
      return null;
    }
    try {
      await React.act(async () => root.render(React.createElement(Harness)));
      let pending!: ReturnType<typeof operations.save>;
      await React.act(async () => {
        pending = operations.save(
          [
            {
              id: imageId,
              title: "committed",
              tags: ["new-tag"],
              brightness: automatic ? "auto" : "light"
            }
          ],
          [imageId]
        );
      });
      await React.act(async () => {
        await clock.advanceBy(30_000);
        await settleRequests();
      });
      for (let attempt = 0; attempt < 4; attempt++) {
        await React.act(async () => {
          await clock.advanceBy(30_000);
          await settleRequests();
        });
        if (attempt < 3)
          await React.act(async () => {
            await clock.advanceBy(500 * 2 ** attempt);
            await settleRequests();
          });
      }
      await React.act(async () => {
        await pending;
      });
      assert.equal(operations.pendingReconciliation, true);
      assert.equal(list.getCurrentResult().data?.items[0]?.title, before.title);
      assert.deepEqual(vocabulary.getCurrentResult().data?.tags, []);
      assert.equal(listReads, 2, "结果未知时先做一次保守刷新，服务端此时尚未提交");
      assert.equal(vocabularyReads, 2);

      committed = true;
      let confirmed!: ReturnType<typeof operations.reconcilePendingSave>;
      await React.act(async () => {
        confirmed =
          confirmation === "save"
            ? operations.save([], [imageId])
            : operations.reconcilePendingSave();
      });
      await React.act(async () => {
        await clock.advanceBy(500);
        await settleRequests();
      });
      const outcome = await confirmed;
      const report = outcome?.report;
      assert.equal(report?.updated, automatic ? 0 : 1, "权威当前值不能证明自动识别指令执行成功");
      assert.equal(report?.failed, automatic ? 1 : 0);
      if (automatic) {
        assert.ok(outcome?.authoritativeItems);
        const session = createImageMetadataSession([before]);
        Object.assign(session.drafts[imageId]!, {
          title: "committed",
          tags: ["new-tag"],
          brightness: "auto"
        });
        const reconciled = reconcileImageMetadataSession(
          session,
          outcome.attempt,
          outcome.authoritativeItems
        );
        assert.equal(
          reconciled.drafts[imageId]!.brightness,
          "auto",
          "刷新父页面不能清除未确认指令草稿"
        );
      }
      assert.equal(list.getCurrentResult().data?.items[0]?.title, "committed");
      assert.equal(list.getCurrentResult().data?.items[0]?.brightness, "light");
      assert.deepEqual(
        vocabulary.getCurrentResult().data?.tags.map((tag) => tag.slug),
        ["new-tag"]
      );
      assert.equal(listReads, 3, "首次确认完成后刷新到已提交状态");
      assert.equal(vocabularyReads, 3);
      assert.equal(writes, 1, "人工确认不能重放写入");
      assert.equal(snapshots, 5);
      assert.equal(operations.pendingReconciliation, false);
      assert.equal(await operations.reconcilePendingSave(), null);
      assert.equal(listReads, 3, "已完成确认不重复刷新");
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
      unsubscribeList();
      unsubscribeVocabulary();
    }
  });
}

for (const failure of ["503", "headers", "body"] as const) {
  test(`[Web/后台只读重试] 已响应的保存快照失败只重试三次，人工确认不重复写入或失效 / ${failure}`, async (t) => {
    t.after(
      installProperties(window, {
        location: { pathname: "/admin/images", href: "http://imageshow.test/admin/images" }
      })
    );
    let writes = 0;
    let snapshots = 0;
    let invalidations = 0;
    let recovered = false;
    const { clock } = createReadHarness(
      t,
      async (input, init) => {
        if (String(input).endsWith("/logs/client-errors")) return Response.json({ ok: true });
        if (String(input).endsWith("/images/update")) {
          writes += 1;
          return Response.json({
            updated: 1,
            failed: 0,
            results: [{ id: imageId, status: "updated" }]
          });
        }
        assert.ok(String(input).endsWith("/images/snapshot"));
        snapshots += 1;
        if (recovered) return Response.json({ items: [] });
        return failure === "503"
          ? Response.json({ error: "busy" }, { status: 503 })
          : stalledResponse(init, failure);
      },
      true
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let operations!: ReturnType<typeof useImageMetadataOperations>;
    function Harness() {
      operations = useImageMetadataOperations({
        initialIds: [imageId],
        onSaved: async () => {
          invalidations += 1;
        }
      });
      return null;
    }
    try {
      await React.act(async () => root.render(React.createElement(Harness)));
      let pending!: ReturnType<typeof operations.save>;
      let finished = false;
      await React.act(async () => {
        pending = operations.save([{ id: imageId, title: "changed" }], [imageId]).finally(() => {
          finished = true;
        });
      });
      await React.act(async () => {
        await settleRequests();
      });
      assert.equal(snapshots, 1);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (failure !== "503") {
          await React.act(async () => {
            await clock.advanceBy(30_000);
            await settleRequests();
          });
        }
        if (attempt < 3) {
          await React.act(async () => {
            await clock.advanceBy(500 * 2 ** attempt);
            await settleRequests();
          });
        }
      }
      assert.equal(operations.pendingReconciliation, true);
      await React.act(async () => {
        await clock.advanceBy(500);
        await settleRequests();
      });
      assert.equal(snapshots, 4);
      assert.equal(finished, true, "快照耗尽后立即进入人工确认，不能叠加另一轮自动重试");
      assert.equal((await pending)?.report.snapshotFailed, true);
      assert.equal(operations.pendingReconciliation, true);
      assert.equal(writes, 1);
      assert.equal(invalidations, 1);
      recovered = true;
      await React.act(async () => {
        await operations.reconcilePendingSave();
      });
      assert.equal(snapshots, 5);
      assert.equal(writes, 1);
      assert.equal(invalidations, 1);
      assert.equal(operations.pendingReconciliation, false);
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
    }
  });
}

for (const { name, options, data } of sharedReads) {
  // Each descriptor has its own result type; the tests observe JSON and query
  // identity, so avoid requiring both DTOs to have the same shape.
  const read = (client: QueryClient): Promise<unknown> =>
    name === "词表"
      ? client.fetchQuery(ingestionVocabularyQueryOptions)
      : client.fetchQuery(storageOptionsQueryOptions);

  test(`[Web/后台只读重试] ${name}首次成功及缓存命中不增加请求`, async (t) => {
    let requests = 0;
    const { client, clock } = createReadHarness(t, async () => {
      requests += 1;
      return Response.json(data);
    });
    assert.deepEqual(await read(client), data);
    assert.deepEqual(await read(client), data);
    await clock.advanceBy(4_000);
    assert.equal(requests, 1);
  });

  test(`[Web/后台只读重试] ${name}并发准备共享恢复请求及成功缓存`, async (t) => {
    let requests = 0;
    const { client, clock } = createReadHarness(t, async () => {
      requests += 1;
      return requests === 1
        ? Response.json({ error: "temporarily unavailable" }, { status: 503 })
        : Response.json(data);
    });
    const first = read(client);
    await settleRequests();
    const second = read(client);
    await clock.advanceBy(499);
    assert.equal(requests, 1);
    await clock.advanceBy(1);
    assert.deepEqual(await Promise.all([first, second]), [data, data]);
    assert.deepEqual(await read(client), data);
    assert.equal(requests, 2);
  });

  test(`[Web/后台只读重试] ${name}持续失败最多四次且退避结束前不报错`, async (t) => {
    const requestTimes: number[] = [];
    const { client, clock } = createReadHarness(t, async () => {
      requestTimes.push(clock.now());
      return Response.json({ error: "temporarily unavailable" }, { status: 503 });
    });
    let settled = false;
    const result = read(client)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    const startedAt = clock.now();
    await settleRequests();
    for (const delay of [500, 1_000, 2_000]) {
      await clock.advanceBy(delay - 1);
      assert.equal(settled, false);
      await clock.advanceBy(1);
      await settleRequests();
    }
    const error = await result;
    assert.ok(error instanceof ApiClientError);
    assert.equal(error.status, 503);
    assert.deepEqual(
      requestTimes.map((time) => time - startedAt),
      [0, 500, 1_500, 3_500]
    );
    await clock.advanceBy(4_000);
    assert.equal(requestTimes.length, 4);
  });

  test(`[Web/后台只读重试] ${name}取消共享查询后不再发起重试`, async (t) => {
    let requests = 0;
    let requestSignal: AbortSignal | undefined;
    const { client, clock } = createReadHarness(t, async (_input, init) => {
      requests += 1;
      requestSignal = init?.signal ?? undefined;
      throw new TypeError("Failed to fetch");
    });
    const result = read(client).catch((error: unknown) => error);
    await settleRequests();
    await client.cancelQueries({ queryKey: options.queryKey });
    assert.ok(isCancelledError(await result));
    assert.equal(requestSignal?.aborted, true);
    await clock.advanceBy(4_000);
    assert.equal(requests, 1);
  });

  for (const phase of ["headers", "body"] as const) {
    test(`[Web/后台只读重试] ${name}挂起 ${phase} 超时后共享重试且释放计时器`, async (t) => {
      let requests = 0;
      const { client, clock } = createReadHarness(t, async (_input, init) => {
        requests += 1;
        return requests === 1 ? stalledResponse(init, phase) : Response.json(data);
      });
      const first = read(client);
      const second = read(client);
      await settleRequests();
      await clock.advanceBy(29_999);
      assert.equal(requests, 1);
      await clock.advanceBy(1);
      await settleRequests();
      await clock.advanceBy(500);
      assert.deepEqual(await Promise.all([first, second]), [data, data]);
      assert.equal(requests, 2);
      assert.equal(clock.pendingCount(), 0);
    });

    test(`[Web/后台只读重试] ${name}挂起 ${phase} 时取消立即退出且不重试`, async (t) => {
      let requests = 0;
      let requestSignal: AbortSignal | null | undefined;
      const { client, clock } = createReadHarness(t, async (_input, init) => {
        requests += 1;
        requestSignal = init?.signal;
        return stalledResponse(init, phase);
      });
      const result = read(client).catch((error: unknown) => error);
      await settleRequests();
      await client.cancelQueries({ queryKey: options.queryKey });
      assert.ok(isCancelledError(await result));
      await settleRequests();
      assert.equal(requestSignal?.aborted, true);
      assert.equal(clock.pendingCount(), 0);
      await clock.advanceBy(125_000);
      assert.equal(requests, 1);
    });
  }
}

for (const phase of ["headers", "body"] as const) {
  test(`[Web/后台只读重试] 快照挂起 ${phase} 时外部取消立即结束本轮读取`, async (t) => {
    let requests = 0;
    const { clock } = createReadHarness(t, async (_input, init) => {
      requests += 1;
      return stalledResponse(init, phase);
    });
    const controller = new AbortController();
    const result = readEditableImageSnapshots([imageId], controller.signal).catch(
      (error: unknown) => error
    );
    await settleRequests();
    controller.abort();
    assert.equal(await result, controller.signal.reason);
    assert.equal(clock.pendingCount(), 0);
    await clock.advanceBy(125_000);
    assert.equal(requests, 1);
  });
}

test("[Web/后台只读重试] 编辑快照冻结请求体并在第三次重试恢复", async (t) => {
  const bodies: unknown[] = [];
  const requestTimes: number[] = [];
  const ids = [imageId];
  const data = { items: [{ id: imageId }] };
  const { clock } = createReadHarness(t, async (input, init) => {
    assert.equal(input, "/api/admin/images/snapshot");
    assert.equal(init?.method, "POST");
    bodies.push(JSON.parse(String(init?.body)));
    requestTimes.push(clock.now());
    if (bodies.length === 1) throw new TypeError("Failed to fetch");
    if (bodies.length < 4) return Response.json({ error: "busy" }, { status: 502 });
    return Response.json(data);
  });
  const startedAt = clock.now();
  const result = readEditableImageSnapshots(ids);
  ids.push("00000000-0000-7000-8000-000000000632");
  for (const delay of [500, 1_000, 2_000]) {
    await clock.advanceBy(delay);
    await settleRequests();
  }
  assert.deepEqual(await result, data);
  assert.deepEqual(
    bodies,
    Array.from({ length: 4 }, () => ({ ids: [imageId] }))
  );
  assert.deepEqual(
    requestTimes.map((time) => time - startedAt),
    [0, 500, 1_500, 3_500]
  );
});

test("[Web/后台只读重试] 编辑快照持续失败在四次请求后结束", async (t) => {
  let requests = 0;
  const { clock } = createReadHarness(t, async () => {
    requests += 1;
    return Response.json({ error: "busy" }, { status: 500 });
  });
  const result = readEditableImageSnapshots([imageId]).catch((error: unknown) => error);
  for (const delay of [500, 1_000, 2_000]) {
    await clock.advanceBy(delay);
    await settleRequests();
  }
  const error = await result;
  assert.ok(error instanceof ApiClientError);
  assert.equal(error.status, 500);
  await clock.advanceBy(4_000);
  assert.equal(requests, 4);
  assert.equal(clock.pendingCount(), 0);
});

test("[Web/后台只读重试] 编辑快照取消退避或预先取消都不再发请求", async (t) => {
  let requests = 0;
  const { clock } = createReadHarness(t, async () => {
    requests += 1;
    throw new TypeError("Failed to fetch");
  });
  const controller = new AbortController();
  const result = readEditableImageSnapshots([imageId], controller.signal).catch(
    (error: unknown) => error
  );
  await settleRequests();
  assert.equal(clock.pendingCount(), 1);
  controller.abort();
  assert.equal(await result, controller.signal.reason);
  assert.equal(clock.pendingCount(), 0);
  await assert.rejects(readEditableImageSnapshots([imageId], controller.signal), {
    name: "AbortError"
  });
  await clock.advanceBy(4_000);
  assert.equal(requests, 1);
});

test("[Web/后台只读重试] 编辑快照仅恢复网络与临时服务错误", async (t) => {
  for (const status of [
    200, 400, 401, 403, 404, 408, 409, 422, 429, 500, 501, 502, 503, 504, 505
  ]) {
    await t.test(`HTTP ${status}`, async (t) => {
      let requests = 0;
      const { clock } = createReadHarness(t, async () => {
        requests += 1;
        if (requests > 1) return Response.json({ items: [] });
        return status === 200
          ? new Response("invalid json", { status })
          : Response.json({ error: "read failed" }, { status });
      });
      const result = readEditableImageSnapshots([imageId]).catch((error: unknown) => error);
      await clock.advanceBy(500);
      const value = await result;
      if ([408, 500, 502, 503, 504].includes(status)) {
        assert.deepEqual(value, { items: [] });
        assert.equal(requests, 2);
      } else {
        assert.ok(value instanceof ApiClientError);
        assert.equal(value.status, status);
        assert.equal(requests, 1);
      }
    });
  }
});
