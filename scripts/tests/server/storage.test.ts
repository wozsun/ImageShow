import "../support/server-environment.ts";
import assert from "node:assert/strict";
import {
  createHash,
  randomUUID
} from "node:crypto";
import {
  rm,
  writeFile
} from "node:fs/promises";
import {
  createServer as createHttpServer,
  request as httpRequest
} from "node:http";
import {
  type AddressInfo
} from "node:net";
import {
  join,
  resolve,
  toNamespacedPath
} from "node:path";
import {
  PassThrough,
  Readable
} from "node:stream";
import {
  setTimeout as delay
} from "node:timers/promises";
import {
  pathToFileURL
} from "node:url";
import test from "node:test";
import {
  createTestDirectory
} from "../support/test-directory.ts";
import {
  runProcess
} from "../support/process-runner.ts";
import {
  Hono
} from "hono";
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import {
  adminApiBasePath
} from "../../../packages/shared/src/browser.ts";
import {
  ApiError
} from "../../../packages/server/src/core/api-error.ts";
import {
  storageBackendUpdateInput
} from "../../../packages/server/src/routes/validation/storage.ts";
import {
  handleApiError
} from "../../../packages/server/src/core/http/responses.ts";
import {
  IngestionCommitStagingCleanup
} from "../../../packages/server/src/images/ingestion/commit/staging-cleanup.ts";
import {
  ingestionStagingImageKey,
  ingestionStagingThumbnailKey,
  stagingSessionId
} from "../../../packages/server/src/images/ingestion/staging-keys.ts";
import {
  missingS3Fields,
  mergeS3Settings,
  s3SettingsSchema,
  storageDriverSignature,
  type S3StorageConfig,
  type StorageConfig
} from "../../../packages/server/src/storage/backends/config.ts";
import {
  contentType,
  s3CopySource,
  s3ListPrefix,
  storageS3ObjectName
} from "../../../packages/server/src/storage/objects/keys.ts";
import {
  assertCanonicalImageObjectKey,
  isCanonicalImageObjectKey,
  isCanonicalThumbnailObjectKey,
  storageObjectKey,
  thumbnailObjectKey
} from "../../../packages/server/src/storage/objects/image-paths.ts";
import {
  storageConfigFromRow
} from "../../../packages/server/src/storage/backends/record.ts";
import {
  groupStorageNamespaces,
  shareStorageNamespace,
  storageNamespaceGroupIdentity,
  storageNamespaceIdentity
} from "../../../packages/server/src/storage/objects/namespace.ts";
import {
  batchStorageKeys,
  STORAGE_ADMIN_LIST_MAX_KEYS
} from "../../../packages/server/src/storage/objects/key-listing.ts";
import {
  captureStagingNamespaceSnapshot
} from "../../../packages/server/src/storage/backends/endpoint-rebind.ts";
import {
  isMissingFileError
} from "../../../packages/server/src/storage/objects/not-found.ts";
import type {
  StorageDriver,
  StorageObjectReference
} from "../../../packages/server/src/storage/drivers/driver.ts";
import {
  removeDriverObjectsAndConfirm
} from "../../../packages/server/src/storage/drivers/removal.ts";
import {
  ensureVerifiedObjectAtDestination
} from "../../../packages/server/src/storage/objects/transfer.ts";
import {
  manageStorageDriver
} from "../../../packages/server/src/storage/drivers/lifecycle.ts";
import {
  S3Backend,
  type S3CommandClient
} from "../../../packages/server/src/storage/drivers/s3.ts";
import {
  S3RequestRuntime
} from "../../../packages/server/src/storage/drivers/s3-request-runtime.ts";
import {
  registerCheckRoutes
} from "../../../packages/server/src/routes/check.ts";
import {
  imageId
} from "../support/server-test-context.ts";

function s3CommandName(command: unknown) {
  return (command as { constructor: { name: string } }).constructor.name;
}

type ManagedTestStorageDriver = Omit<StorageDriver, "close"> & {
  close(): Promise<void>;
};
const manageTestStorageDriver = (driver: StorageDriver) => (
  manageStorageDriver(driver) as ManagedTestStorageDriver
);

test("[Server/存储] 存储维护只保留中性写入口并在业务执行前拒绝越权", async () => {
  const app = new Hono<{
    Variables: { session: { role: "super" | "image" } };
  }>();
  app.onError((error, context) => handleApiError(context, error));
  app.use(`${adminApiBasePath}/*`, async (context, next) => {
    const role = context.req.header("x-test-role");
    if (role === "super" || role === "image") context.set("session", { role });
    await next();
  });
  registerCheckRoutes(app as unknown as Hono);

  const post = (path: string, role: "super" | "image" = "image") => (
    app.request(new Request(`http://imageshow.test${path}`, {
      method: "POST",
      headers: { "x-test-role": role }
    }))
  );
  const forbidden = await post(
    `${adminApiBasePath}/check/storage-maintenance`
  );
  assert.equal(forbidden.status, 403);
  assert.equal(
    (await forbidden.json() as { code?: string }).code,
    "forbidden"
  );
});
test("[Server/存储] 存储键列举保持固定批大小、显式完整性和取消边界", async () => {
  async function consumeListing(
    listing: ReturnType<typeof batchStorageKeys>,
    consume: (keys: readonly string[]) => void | Promise<void>
  ) {
    while (true) {
      const step = await listing.next();
      if (step.done) return step.value;
      await consume(step.value);
    }
  }

  async function* keys(count: number) {
    for (let index = 0; index < count; index += 1) {
      yield `group/${index}.webp`;
    }
  }

  for (const count of [50_000, 100_000]) {
    let observed = 0;
    let largestBatch = 0;
    const result = await consumeListing(
      batchStorageKeys(keys(count), {
        maxKeys: STORAGE_ADMIN_LIST_MAX_KEYS
      }),
      (batch) => {
        observed += batch.length;
        largestBatch = Math.max(largestBatch, batch.length);
      }
    );
    assert.deepEqual(result, { complete: true, count });
    assert.equal(observed, count);
    assert.ok(largestBatch <= 256);
  }

  let truncatedObserved = 0;
  const truncated = await consumeListing(
    batchStorageKeys(keys(STORAGE_ADMIN_LIST_MAX_KEYS + 1), {
      maxKeys: STORAGE_ADMIN_LIST_MAX_KEYS
    }),
    (batch) => {
      truncatedObserved += batch.length;
    }
  );
  assert.deepEqual(truncated, {
    complete: false,
    count: STORAGE_ADMIN_LIST_MAX_KEYS,
    reason: "max_keys"
  });
  assert.equal(truncatedObserved, STORAGE_ADMIN_LIST_MAX_KEYS);

  const cancel = new AbortController();
  const cancelReason = new Error("cancel slow storage listing");
  async function* slowKeys() {
    for (let index = 0; index < 1_000; index += 1) {
      if (index % 64 === 0) await delay(1);
      yield `slow/${index}`;
    }
  }
  await assert.rejects(
    () => consumeListing(
      batchStorageKeys(slowKeys(), { signal: cancel.signal }),
      () => cancel.abort(cancelReason)
    ),
    (error) => error === cancelReason
  );

  const ioFailure = Object.assign(new Error("injected storage I/O failure"), {
    code: "EIO"
  });
  async function* failingKeys() {
    yield "before-error";
    throw ioFailure;
  }
  await assert.rejects(
    () => consumeListing(
      batchStorageKeys(failingKeys()),
      () => undefined
    ),
    (error) => error === ioFailure
  );
  assert.equal(isMissingFileError({ code: "ENOENT" }), true);
  assert.equal(isMissingFileError({ code: "EACCES" }), false);
  assert.equal(isMissingFileError({ code: "EIO" }), false);

  const snapshotAbort = new AbortController();
  const capturedOptions: Array<Parameters<StorageDriver["listKeys"]>[1]> = [];
  const snapshotDriver = {
    listKeys(_prefix, options) {
      capturedOptions.push(options);
      return batchStorageKeys([
        "opaque-key-without-ingestion-shape",
        "session/attempt/image.webp"
      ], options);
    }
  } as StorageDriver;
  const snapshot = await captureStagingNamespaceSnapshot(
    snapshotDriver,
    snapshotAbort.signal
  );
  assert.equal(capturedOptions[0]?.signal, snapshotAbort.signal);
  assert.equal(capturedOptions[0]?.maxKeys, STORAGE_ADMIN_LIST_MAX_KEYS);
  assert.deepEqual([...snapshot.keys], [
    "opaque-key-without-ingestion-shape",
    "session/attempt/image.webp"
  ]);

  const cancelledSnapshot = new AbortController();
  const cancelledReason = new Error("cancel staging snapshot");
  cancelledSnapshot.abort(cancelledReason);
  await assert.rejects(
    () => captureStagingNamespaceSnapshot(
      snapshotDriver,
      cancelledSnapshot.signal
    ),
    (error) => error === cancelledReason
  );
});
test("[Server/存储] local / S3 配置只按实际连接参数复用 driver", () => {
  const current = s3SettingsSchema.parse({
    endpoint: "objects.example.com",
    region: "ap-southeast-1",
    bucket: "gallery",
    access_key_id: "key",
    secret_access_key: "secret",
    root_path: "/images",
    public_base_url: "https://cdn.example.com"
  });
  const patch = storageBackendUpdateInput.parse({
    s3: { public_base_url: "https://assets.example.com" }
  });
  assert.deepEqual(patch.s3, {
    public_base_url: "https://assets.example.com"
  });
  assert.deepEqual(mergeS3Settings(patch.s3, current), {
    ...current,
    public_base_url: "https://assets.example.com"
  });
  assert.equal(
    mergeS3Settings({}, current).secret_access_key,
    "secret",
    "省略凭据应由普通 patch 合并保留"
  );

  const first: StorageConfig = {
    slug: "archive",
    type: "s3",
    namespace_identities: ["registered-endpoint"],
    s3: current
  };
  const presentationOnly: StorageConfig = {
    ...first,
    slug: "mirror",
    namespace_identities: ["another-registered-endpoint"],
    s3: { ...current, public_base_url: "https://assets.example.com" }
  };
  assert.equal(
    storageDriverSignature(first),
    storageDriverSignature(presentationOnly),
    "slug、已登记 identity 与公开 URL 不应重建物理 driver"
  );
  assert.notEqual(
    storageDriverSignature(first),
    storageDriverSignature({
      ...first,
      s3: { ...current, idle_timeout_seconds: 30 }
    })
  );
  assert.notEqual(
    storageDriverSignature(first),
    storageDriverSignature({
      ...first,
      s3: { ...current, root_path: "/other" }
    })
  );
  assert.equal(
    storageDriverSignature({ slug: "local", type: "local" }),
    storageDriverSignature({ slug: "local-copy", type: "local" })
  );
});
test("[Server/存储] S3 键列举按需分页并保持有界、可取消和错误透明", async () => {
  async function consumeListing(
    listing: ReturnType<S3Backend["listKeys"]>,
    consume: (keys: readonly string[]) => void | Promise<void>
  ) {
    while (true) {
      const step = await listing.next();
      if (step.done) return step.value;
      await consume(step.value);
    }
  }

  const config: StorageConfig = {
    slug: "s3-list-test",
    type: "s3",
    s3: s3SettingsSchema.parse({
      endpoint: "s3.example.test",
      bucket: "images",
      access_key_id: "access-key",
      secret_access_key: "secret-key",
      root_path: "/bounded"
    })
  };
  const commandInput = (command: unknown) => (
    command as {
      input: {
        Prefix?: string;
        ContinuationToken?: string;
        MaxKeys?: number;
      };
    }
  ).input;

  for (const total of [50_000, 100_000]) {
    let pageCalls = 0;
    let largestPage = 0;
    let destroyed = false;
    const client: S3CommandClient = {
      async send(command) {
        const input = commandInput(command);
        const start = Number(input.ContinuationToken ?? 0);
        const end = Math.min(total, start + (input.MaxKeys ?? 1_000));
        const prefix = input.Prefix ?? "";
        pageCalls += 1;
        largestPage = Math.max(largestPage, end - start);
        return {
          Contents: Array.from({ length: end - start }, (_, offset) => ({
            Key: `${prefix}${String(start + offset).padStart(8, "0")}.webp`
          })),
          IsTruncated: end < total,
          NextContinuationToken: end < total ? String(end) : undefined
        };
      },
      destroy() { destroyed = true; }
    };
    const backend = new S3Backend(config, { client });
    const listing = backend.listKeys("full", {
      maxKeys: STORAGE_ADMIN_LIST_MAX_KEYS
    });
    const first = await listing.next();
    assert.equal(first.done, false);
    assert.equal(first.value.length, 256);
    assert.equal(pageCalls, 1, "首批结果不得预取或累积后续 S3 页面");

    let observed = first.value.length;
    let largestBatch = first.value.length;
    const result = await consumeListing(listing, (batch) => {
      observed += batch.length;
      largestBatch = Math.max(largestBatch, batch.length);
    });
    assert.deepEqual(result, { complete: true, count: total });
    assert.equal(observed, total);
    assert.equal(pageCalls, Math.ceil(total / 1_000));
    assert.ok(largestPage <= 1_000);
    assert.ok(largestBatch <= 256);
    backend.close();
    assert.equal(destroyed, true);
  }

  let truncatedPageCalls = 0;
  const truncatedClient: S3CommandClient = {
    async send(command) {
      const input = commandInput(command);
      const start = Number(input.ContinuationToken ?? 0);
      const total = STORAGE_ADMIN_LIST_MAX_KEYS + 1;
      const end = Math.min(total, start + 1_000);
      const prefix = input.Prefix ?? "";
      truncatedPageCalls += 1;
      return {
        Contents: Array.from({ length: end - start }, (_, offset) => ({
          Key: `${prefix}${start + offset}.webp`
        })),
        IsTruncated: end < total,
        NextContinuationToken: end < total ? String(end) : undefined
      };
    },
    destroy() {}
  };
  const truncatedBackend = new S3Backend(config, { client: truncatedClient });
  let truncatedObserved = 0;
  const truncated = await consumeListing(
    truncatedBackend.listKeys("full", {
      maxKeys: STORAGE_ADMIN_LIST_MAX_KEYS
    }),
    (batch) => { truncatedObserved += batch.length; }
  );
  assert.deepEqual(truncated, {
    complete: false,
    count: STORAGE_ADMIN_LIST_MAX_KEYS,
    reason: "max_keys"
  });
  assert.equal(truncatedObserved, STORAGE_ADMIN_LIST_MAX_KEYS);
  assert.equal(truncatedPageCalls, 101);
  truncatedBackend.close();

  const cancel = new AbortController();
  const cancelReason = new Error("cancel pending S3 page");
  let cancellationObserved = false;
  const slowClient: S3CommandClient = {
    send(_command, options) {
      return new Promise((_resolve, reject) => {
        const signal = options?.abortSignal;
        const rejectWithReason = () => {
          cancellationObserved = true;
          reject(signal?.reason);
        };
        if (signal?.aborted) rejectWithReason();
        else signal?.addEventListener("abort", rejectWithReason, { once: true });
      });
    },
    destroy() {}
  };
  const slowBackend = new S3Backend(config, { client: slowClient });
  const pendingPage = slowBackend.listKeys("full", {
    signal: cancel.signal
  }).next();
  cancel.abort(cancelReason);
  await assert.rejects(pendingPage, (error) => error === cancelReason);
  assert.equal(cancellationObserved, true);
  slowBackend.close();

  const responseBody = new PassThrough();
  const permissionError = Object.assign(new Error("Access denied"), {
    name: "AccessDenied",
    $metadata: { httpStatusCode: 403 },
    $response: { body: responseBody }
  });
  const deniedClient: S3CommandClient = {
    async send() { throw permissionError; },
    destroy() {}
  };
  const deniedBackend = new S3Backend(config, { client: deniedClient });
  await assert.rejects(
    deniedBackend.listKeys("full").next(),
    (error) => error === permissionError
  );
  assert.equal(responseBody.destroyed, true);
  deniedBackend.close();

  for (const status of [429, 503]) {
    const failureBody = new PassThrough();
    const serviceError = Object.assign(new Error(`S3 ${status}`), {
      $metadata: { httpStatusCode: status },
      $response: { body: failureBody }
    });
    const failureBackend = new S3Backend(config, {
      client: {
        async send() { throw serviceError; },
        destroy() {}
      }
    });
    await assert.rejects(
      failureBackend.listKeys("full").next(),
      (error) => error === serviceError
    );
    assert.equal(failureBody.destroyed, true);
    failureBackend.close();
  }

  const invalidPageClient: S3CommandClient = {
    async send(command) {
      const { Prefix = "" } = commandInput(command);
      return {
        Contents: [{ Key: `${Prefix}inside.webp` }],
        IsTruncated: true
      };
    },
    destroy() {}
  };
  const invalidPageBackend = new S3Backend(config, {
    client: invalidPageClient
  });
  await assert.rejects(
    () => consumeListing(invalidPageBackend.listKeys("full"), () => undefined),
    (error) => (
      error instanceof Error
      && "code" in error
      && error.code === "storage_list_invalid"
    )
  );
  invalidPageBackend.close();

  let cyclicTokenCalls = 0;
  const repeatedTokenBackend = new S3Backend(config, {
    client: {
      async send() {
        cyclicTokenCalls += 1;
        return {
          Contents: [],
          IsTruncated: true,
          NextContinuationToken: cyclicTokenCalls % 2 === 1
            ? "token-a"
            : "token-b"
        };
      },
      destroy() {}
    }
  });
  await assert.rejects(
    () => consumeListing(
      repeatedTokenBackend.listKeys("full"),
      () => undefined
    ),
    (error) => (
      error instanceof Error
      && "code" in error
      && error.code === "storage_list_invalid"
    )
  );
  assert.equal(cyclicTokenCalls, 3);
  repeatedTokenBackend.close();

  let emptyPageCalls = 0;
  const noProgressBackend = new S3Backend(config, {
    client: {
      async send() {
        emptyPageCalls += 1;
        return {
          Contents: [],
          IsTruncated: true,
          NextContinuationToken: `fresh-token-${emptyPageCalls}`
        };
      },
      destroy() {}
    }
  });
  await assert.rejects(
    () => consumeListing(
      noProgressBackend.listKeys("full"),
      () => undefined
    ),
    (error) => (
      error instanceof Error
      && "code" in error
      && error.code === "storage_list_invalid"
    )
  );
  assert.equal(emptyPageCalls, 9);
  noProgressBackend.close();

  const outsidePrefixClient: S3CommandClient = {
    async send() {
      return {
        Contents: [{ Key: "outside/requested/prefix.webp" }],
        IsTruncated: false
      };
    },
    destroy() {}
  };
  const outsidePrefixBackend = new S3Backend(config, {
    client: outsidePrefixClient
  });
  await assert.rejects(
    () => consumeListing(
      outsidePrefixBackend.listKeys("full"),
      () => undefined
    ),
    (error) => (
      error instanceof Error
      && "code" in error
      && error.code === "storage_list_invalid"
    )
  );
  outsidePrefixBackend.close();
});
test("[Server/存储] S3 删除响应丢失后允许 move.cleanup 的幂等确认重试", async () => {
  const config: S3StorageConfig = {
    slug: "s3-delete-retry-test",
    type: "s3",
    s3: s3SettingsSchema.parse({
      endpoint: "s3.example.test",
      bucket: "images",
      access_key_id: "access-key",
      secret_access_key: "secret-key",
      root_path: "/cleanup"
    })
  };
  let exists = true;
  const commands: string[] = [];
  const client: S3CommandClient = {
    async send(command) {
      const name = s3CommandName(command);
      commands.push(name);
      if (name === "HeadObjectCommand") {
        if (exists) return {};
        throw Object.assign(new Error("not found"), {
          $metadata: { httpStatusCode: 404 }
        });
      }
      if (name === "DeleteObjectsCommand") {
        exists = false;
        throw new Error("injected S3 DELETE response loss");
      }
      throw new Error(`Unexpected command: ${name}`);
    },
    destroy() {}
  };
  const backend = new S3Backend(config, { client });
  const first = await backend.removeObjects([{
    prefix: "full",
    key: "candidate.webp"
  }]);
  const retry = await backend.removeObjects([{
    prefix: "full",
    key: "candidate.webp"
  }]);
  assert.equal(first[0]?.status, "removed");
  assert.equal(retry[0]?.status, "missing");
  assert.deepEqual(commands, [
    "HeadObjectCommand",
    "DeleteObjectsCommand",
    "HeadObjectCommand",
    "HeadObjectCommand"
  ]);
});
test("[Server/存储] S3 自检在调用方取消后仍独立清理已落地探针", async () => {
  const config: S3StorageConfig = {
    slug: "s3-self-test-cleanup",
    type: "s3",
    s3: s3SettingsSchema.parse({
      endpoint: "s3.example.test",
      bucket: "images",
      access_key_id: "access-key",
      secret_access_key: "secret-key",
      root_path: "/self-test"
    })
  };
  const caller = new AbortController();
  const callerReason = new Error("cancel after S3 self-test PUT materialized");
  const commands: string[] = [];
  const cleanupSignals: AbortSignal[] = [];
  let exists = false;
  const client: S3CommandClient = {
    async send(command, options) {
      const name = s3CommandName(command);
      commands.push(name);
      options?.abortSignal?.throwIfAborted();
      if (name === "PutObjectCommand") {
        exists = true;
        caller.abort(callerReason);
        return {};
      }
      if (name === "HeadObjectCommand") {
        if (exists) return { ContentLength: 2 };
        throw Object.assign(new Error("not found"), {
          $metadata: { httpStatusCode: 404 }
        });
      }
      if (name === "DeleteObjectsCommand") {
        assert.ok(options?.abortSignal);
        assert.notEqual(options.abortSignal, caller.signal);
        assert.equal(options.abortSignal.aborted, false);
        cleanupSignals.push(options.abortSignal);
        exists = false;
        return { Errors: [] };
      }
      throw new Error(`Unexpected command: ${name}`);
    },
    destroy() {}
  };
  const backend = new S3Backend(config, { client });
  try {
    await assert.rejects(
      backend.selfTest({ signal: caller.signal }),
      (error) => error === callerReason
    );
    assert.equal(exists, false);
    assert.equal(cleanupSignals.length, 1);
    assert.equal(
      commands.filter((name) => name === "HeadObjectCommand").length,
      2,
      "独立清理必须预检并确认探针已经消失"
    );
    assert.equal(commands.includes("DeleteObjectsCommand"), true);
  } finally {
    backend.close();
  }
});
test("[Server/存储] S3 provider 中性 1…N 删除保持逐项结果、顺序分块和有限恢复", async (t) => {
  type DeleteHandler = (
    keys: string[],
    quiet: boolean,
    call: number,
    signal: AbortSignal | undefined
  ) => Promise<{
    Deleted?: Array<{ Key?: string }>;
    Errors?: Array<{ Key?: string; Code?: string; Message?: string }>;
  }>;
  const missingObject = () => Object.assign(new Error("not found"), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 }
  });
  const fullObject = (key: string): StorageObjectReference => ({
    prefix: "full",
    key
  });
  const physical = (key: string) => `full/${key}`;
  const memoryS3 = (initial: readonly string[], handler?: DeleteHandler) => {
    const objects = new Set(initial);
    const deleteBatches: string[][] = [];
    let deleteCalls = 0;
    let activeDeletes = 0;
    let maximumActiveDeletes = 0;
    const client: S3CommandClient = {
      async send(command, options) {
        if (command instanceof HeadObjectCommand) {
          const key = command.input.Key!;
          if (!objects.has(key)) throw missingObject();
          return { ContentLength: 1 };
        }
        if (command instanceof DeleteObjectsCommand) {
          const keys = command.input.Delete!.Objects!.map((item) => item.Key!);
          const quiet = command.input.Delete?.Quiet === true;
          deleteCalls += 1;
          deleteBatches.push(keys);
          activeDeletes += 1;
          maximumActiveDeletes = Math.max(maximumActiveDeletes, activeDeletes);
          try {
            if (handler) {
              return await handler(
                keys,
                quiet,
                deleteCalls,
                options?.abortSignal
              );
            }
            for (const key of keys) objects.delete(key);
            return quiet
              ? { Errors: [] }
              : { Deleted: keys.map((Key) => ({ Key })), Errors: [] };
          } finally {
            activeDeletes -= 1;
          }
        }
        throw new Error(`Unexpected command: ${command?.constructor?.name}`);
      },
      destroy() {}
    };
    const backend = new S3Backend({
      slug: `memory-s3-${randomUUID()}`,
      type: "s3",
      s3: mergeS3Settings({
        endpoint: "https://s3.example.test",
        region: "auto",
        bucket: "test-bucket",
        access_key_id: "test-access-key",
        secret_access_key: "test-secret-key",
        root_path: "/"
      })
    }, { client });
    return {
      backend,
      objects,
      deleteBatches,
      get deleteCalls() { return deleteCalls; },
      get maximumActiveDeletes() { return maximumActiveDeletes; }
    };
  };

  await t.test("N=1、N>1、Quiet 与 Verbose 使用同一结果模型", async () => {
    for (const quiet of [false, true]) {
      const storage = memoryS3([physical("a"), physical("b")]);
      const results = await storage.backend.removeObjects([
        fullObject("a"),
        fullObject("missing"),
        fullObject("b")
      ], { quiet });
      assert.deepEqual(results.map((result) => result.status), [
        "removed",
        "missing",
        "removed"
      ]);
      assert.deepEqual(storage.deleteBatches, [[physical("a"), physical("b")]]);
      storage.backend.close();
    }
  });

  await t.test("1001 项在 driver 内按 1000 顺序分块", async () => {
    const keys = Array.from({ length: 1_001 }, (_, index) => `item-${index}`);
    const storage = memoryS3(keys.map(physical), async (batch, quiet) => {
      assert.equal(quiet, true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      for (const key of batch) storage.objects.delete(key);
      return { Errors: [] };
    });
    const results = await storage.backend.removeObjects(keys.map(fullObject));
    assert.equal(results.every((result) => result.status === "removed"), true);
    assert.deepEqual(storage.deleteBatches.map((batch) => batch.length), [1_000, 1]);
    assert.equal(storage.maximumActiveDeletes, 1);
    storage.backend.close();
  });

  await t.test("部分失败只重试未完成项，重复输入只执行一次", async () => {
    const storage = memoryS3(
      [physical("a"), physical("b"), physical("c")],
      async (keys, _quiet, call) => {
        if (call === 1) {
          storage.objects.delete(physical("a"));
          storage.objects.delete(physical("c"));
          return {
            Deleted: [{ Key: physical("a") }, { Key: physical("c") }],
            Errors: [{
              Key: physical("b"),
              Code: "SlowDown",
              Message: "retry this key"
            }]
          };
        }
        assert.deepEqual(keys, [physical("b")]);
        storage.objects.delete(physical("b"));
        return { Deleted: [{ Key: physical("b") }], Errors: [] };
      }
    );
    const results = await storage.backend.removeObjects([
      fullObject("a"), fullObject("b"), fullObject("c"), fullObject("a")
    ], { quiet: false });
    assert.equal(results.every((result) => result.status === "removed"), true);
    assert.deepEqual(storage.deleteBatches, [
      [physical("a"), physical("b"), physical("c")],
      [physical("b")]
    ]);
    storage.backend.close();
  });

  await t.test("取消保留已发分块 unknown 且未发分块 failed", async () => {
    const keys = Array.from({ length: 1_001 }, (_, index) => `cancel-${index}`);
    const controller = new AbortController();
    const cancellation = new Error("cancel after dispatch");
    const storage = memoryS3(keys.map(physical), async () => {
      controller.abort(cancellation);
      throw cancellation;
    });
    const results = await storage.backend.removeObjects(keys.map(fullObject), {
      signal: controller.signal
    });
    assert.equal(results.slice(0, 1_000).every((result) => (
      result.status === "unknown"
    )), true);
    assert.equal(results[1_000]?.status, "failed");
    assert.equal(storage.deleteBatches.length, 1);
    storage.backend.close();
  });

  await t.test("畸形响应、未开始项和确认失败不会被当作成功", async () => {
    await assert.rejects(
      removeDriverObjectsAndConfirm({
        objects: [],
        async exists() { return false; },
        async remove() { return []; }
      }),
      /at least one object/
    );

    const malformed = memoryS3(
      [physical("a"), physical("b")],
      async () => ({
        Deleted: [{ Key: physical("a") }, { Key: physical("a") }],
        Errors: []
      })
    );
    const malformedResults = await malformed.backend.removeObjects([
      fullObject("a"), fullObject("b")
    ], { quiet: false });
    assert.equal(malformedResults.every((result) => result.status === "failed"), true);
    assert.equal(malformed.deleteCalls, 2);
    malformed.backend.close();

    let existsCalls = 0;
    const notStarted = await removeDriverObjectsAndConfirm({
      objects: [fullObject("external-delete")],
      async exists() {
        existsCalls += 1;
        return existsCalls === 1;
      },
      async remove() {
        return [{
          status: "not_started",
          error: { code: "cancelled", message: "not dispatched" }
        }];
      }
    });
    assert.equal(notStarted[0]?.status, "failed");

    let confirmationReads = 0;
    let removeCalls = 0;
    const confirmationUnknown = await removeDriverObjectsAndConfirm({
      objects: [fullObject("confirmation-error")],
      async exists() {
        confirmationReads += 1;
        if (confirmationReads === 1) return true;
        throw new Error("head failed");
      },
      async remove() {
        removeCalls += 1;
        return [{ status: "acknowledged" }];
      }
    });
    assert.equal(confirmationUnknown[0]?.status, "unknown");
    assert.equal(removeCalls, 1);

    let failedRemoveCalls = 0;
    const failed = await removeDriverObjectsAndConfirm({
      objects: [fullObject("persistent-failure")],
      async exists() { return true; },
      async remove() {
        failedRemoveCalls += 1;
        return [{
          status: "failed",
          error: { code: "denied", message: "still present" }
        }];
      }
    });
    assert.equal(failed[0]?.status, "failed");
    assert.equal(failedRemoveCalls, 2);
  });

  await t.test("DeleteObjects 请求体 Content-MD5 在签名前写入", async () => {
    let present = true;
    let deleteBody: Buffer | undefined;
    let deleteHeaders: Record<string, string | string[] | undefined> | undefined;
    const server = createHttpServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "HEAD") {
        response.statusCode = present ? 200 : 404;
        if (present) response.setHeader("content-length", "1");
        response.end();
        return;
      }
      if (request.method !== "POST" || !url.searchParams.has("delete")) {
        response.statusCode = 500;
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        deleteBody = Buffer.concat(chunks);
        deleteHeaders = request.headers;
        present = false;
        const body = Buffer.from(
          "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
            + "<DeleteResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">"
            + "<Deleted><Key>full/checksum.bin</Key></Deleted>"
            + "</DeleteResult>"
        );
        response.writeHead(200, {
          "content-type": "application/xml",
          "content-length": String(body.byteLength)
        });
        response.end(body);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    const client = new S3Client({
      endpoint: `http://127.0.0.1:${address.port}`,
      region: "test-region",
      forcePathStyle: true,
      credentials: {
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key"
      }
    });
    const backend = new S3Backend({
      slug: "checksum-test",
      type: "s3",
      s3: mergeS3Settings({
        endpoint: "https://s3.example.test",
        region: "test-region",
        bucket: "test-bucket",
        access_key_id: "test-access-key",
        secret_access_key: "test-secret-key",
        force_path_style: true,
        root_path: "/"
      })
    }, { client });
    try {
      const results = await backend.removeObjects([fullObject("checksum.bin")], {
        quiet: false
      });
      assert.equal(results[0]?.status, "removed");
      assert.ok(deleteBody);
      const contentMd5 = Array.isArray(deleteHeaders?.["content-md5"])
        ? deleteHeaders["content-md5"][0]
        : deleteHeaders?.["content-md5"];
      assert.equal(
        contentMd5,
        createHash("md5").update(deleteBody).digest("base64")
      );
      const authorization = Array.isArray(deleteHeaders?.authorization)
        ? deleteHeaders.authorization[0]
        : deleteHeaders?.authorization;
      assert.match(authorization ?? "", /SignedHeaders=[^,]*content-md5/);
    } finally {
      backend.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
test("[Server/存储] S3 迁移优先使用条件 CopyObject，跨凭据时单次流式传输", async () => {
  const body = Buffer.from("server-copy-and-stream-source");
  const expectedMd5 = createHash("md5").update(body).digest("hex");
  const missingObject = () => Object.assign(new Error("not found"), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 }
  });
  const config = (
    slug: string,
    bucket: string,
    accessKeyId = "shared-access-key",
    secretAccessKey = "shared-secret-key"
  ): S3StorageConfig => ({
    slug,
    type: "s3",
    s3: mergeS3Settings({
      endpoint: "https://cos.ap-jakarta.example.test",
      region: "ap-jakarta",
      bucket,
      access_key_id: accessKeyId,
      secret_access_key: secretAccessKey,
      root_path: "/migration"
    })
  });

  let sourceReads = 0;
  const source = new S3Backend(config("source", "source-bucket"), {
    client: {
      async send(command) {
        assert.equal(s3CommandName(command), "GetObjectCommand");
        sourceReads += 1;
        return {
          Body: Readable.from([body]),
          ContentLength: body.byteLength,
          ETag: '"source-etag"'
        };
      },
      destroy() {}
    }
  });

  let copyCalls = 0;
  const compatibleTarget = new S3Backend(
    config("copy-target", "copy-target-bucket"),
    {
      client: {
        async send(command) {
          if (command instanceof HeadObjectCommand) throw missingObject();
          assert.ok(command instanceof CopyObjectCommand);
          copyCalls += 1;
          assert.deepEqual(command.input, {
            Bucket: "copy-target-bucket",
            CopySource: "source-bucket/migration/_uploads/object.webp",
            CopySourceIfMatch: '"source-etag"',
            Key: "migration/_uploads/object.webp"
          });
          return {};
        },
        destroy() {}
      }
    }
  );

  let streamedBody = Buffer.alloc(0);
  let streamCalls = 0;
  const streamTarget = new S3Backend(
    config(
      "stream-target",
      "stream-target-bucket",
      "other-access-key",
      "other-secret-key"
    ),
    {
      client: {
        async send(command) {
          if (command instanceof HeadObjectCommand) throw missingObject();
          assert.ok(command instanceof PutObjectCommand);
          streamCalls += 1;
          const chunks: Buffer[] = [];
          for await (const chunk of command.input.Body as Readable) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          streamedBody = Buffer.concat(chunks);
          assert.equal(command.input.ContentLength, body.byteLength);
          assert.equal(
            command.input.ContentMD5,
            Buffer.from(expectedMd5, "hex").toString("base64")
          );
          return {};
        },
        destroy() {}
      }
    }
  );

  let existingTargetReads = 0;
  const existingTarget = new S3Backend(
    config("existing-target", "existing-target-bucket"),
    {
      client: {
        async send(command) {
          if (command instanceof HeadObjectCommand) {
            return { ContentLength: body.byteLength, ETag: '"target-etag"' };
          }
          existingTargetReads += 1;
          return {
            Body: Readable.from([body]),
            ContentLength: body.byteLength,
            ETag: '"target-etag"'
          };
        },
        destroy() {}
      }
    }
  );
  const missingSource = new S3Backend(
    config("missing-source", "missing-source-bucket"),
    {
      client: {
        async send(command) {
          assert.equal(s3CommandName(command), "GetObjectCommand");
          throw missingObject();
        },
        destroy() {}
      }
    }
  );

  const sourceEndpoint = { config: config("source", "source-bucket"), driver: source };
  try {
    assert.deepEqual(
      await ensureVerifiedObjectAtDestination({
        source: sourceEndpoint,
        target: {
          config: config("copy-target", "copy-target-bucket"),
          driver: compatibleTarget
        },
        prefix: "_uploads",
        key: "object.webp",
        expected: { size: body.byteLength, md5: expectedMd5 },
        contentType: "image/webp"
      }),
      { created: true }
    );
    assert.equal(sourceReads, 1);
    assert.equal(copyCalls, 1);

    assert.deepEqual(
      await ensureVerifiedObjectAtDestination({
        source: sourceEndpoint,
        target: {
          config: config(
            "stream-target",
            "stream-target-bucket",
            "other-access-key",
            "other-secret-key"
          ),
          driver: streamTarget
        },
        prefix: "_uploads",
        key: "object.webp",
        expected: { size: body.byteLength, md5: expectedMd5 },
        contentType: "image/webp"
      }),
      { created: true }
    );
    assert.equal(sourceReads, 2, "跨存储流式路径只能读取源对象一次");
    assert.equal(streamCalls, 1);
    assert.deepEqual(streamedBody, body);

    await assert.rejects(
      ensureVerifiedObjectAtDestination({
        source: sourceEndpoint,
        target: {
          config: config("copy-target", "copy-target-bucket"),
          driver: compatibleTarget
        },
        prefix: "_uploads",
        key: "object.webp",
        expected: { size: body.byteLength, md5: "0".repeat(32) },
        contentType: "image/webp"
      }),
      (error) => (
        error instanceof ApiError
        && error.code === "storage_source_integrity_failed"
      )
    );
    assert.equal(copyCalls, 1, "数据库 MD5 不匹配时不得发布 CopyObject");

    await assert.rejects(
      ensureVerifiedObjectAtDestination({
        source: {
          config: config("missing-source", "missing-source-bucket"),
          driver: missingSource
        },
        target: {
          config: config("existing-target", "existing-target-bucket"),
          driver: existingTarget
        },
        prefix: "_uploads",
        key: "source-missing.webp",
        expected: { size: body.byteLength, md5: expectedMd5 },
        contentType: "image/webp"
      }),
      (error) => (
        error instanceof ApiError
        && error.code === "storage_source_object_not_found"
      )
    );
    assert.equal(
      existingTargetReads,
      0,
      "源缺失时不得读取或改写已经存在的目标对象"
    );
  } finally {
    source.close();
    compatibleTarget.close();
    streamTarget.close();
    existingTarget.close();
    missingSource.close();
  }
});
test("[Server/存储] 跨 driver 迁移在目标提前拒绝、退休与取消时释放源流", async () => {
  const baseDriver = (overrides: Partial<StorageDriver>): StorageDriver => ({
    async exists() { return false; },
    async openRead() { throw new Error("unexpected openRead"); },
    async readBuffer() { return Buffer.alloc(0); },
    async writeBuffer() {},
    async writeStream() {},
    async removeObjects(objects) {
      return objects.map((object) => ({
        ...object,
        status: "missing" as const
      }));
    },
    async copy() {},
    serverCopySource() { return undefined; },
    supportsServerCopySource() { return false; },
    async copyFromServerSource() {
      throw new Error("unexpected server copy");
    },
    listKeys(_prefix, options) { return batchStorageKeys([], options); },
    async selfTest() { return { backend: "s3", writable: true }; },
    async pruneEmptyDirs() { return 0; },
    ...overrides
  });
  const config = (
    slug: string,
    accessKeyId: string
  ): StorageConfig => ({
    slug,
    type: "s3",
    s3: mergeS3Settings({
      endpoint: "https://cos.ap-jakarta.example.test",
      region: "ap-jakarta",
      bucket: `${slug}-bucket`,
      access_key_id: accessKeyId,
      secret_access_key: `${accessKeyId}-secret`,
      task_timeout_seconds: 15
    })
  });

  for (const mode of ["reject", "retire", "cancel"] as const) {
    const sourceBody = new PassThrough();
    let sourceClosed = 0;
    let targetClosed = 0;
    let writeEntered!: () => void;
    const entered = new Promise<void>((resolve) => { writeEntered = resolve; });
    const controller = new AbortController();
    let cleanupAfter: Date | undefined;
    let target!: StorageDriver;
    const source = manageStorageDriver(baseDriver({
      async openRead() {
        if (mode === "retire") await target.close?.();
        return {
          body: sourceBody,
          size: 16,
          totalSize: 16,
          backend: "s3"
        };
      },
      async close() { sourceClosed += 1; }
    }));
    target = manageStorageDriver(baseDriver({
      async writeStream(_prefix, _key, _body, _size, _type, options) {
        if (mode === "reject") throw new Error("target rejected before read");
        if (mode === "retire") throw new Error("retired target was invoked");
        writeEntered();
        await new Promise<never>((_resolve, reject) => {
          const rejectWithSignal = () => reject(options?.signal?.reason);
          if (options?.signal?.aborted) rejectWithSignal();
          else options?.signal?.addEventListener("abort", rejectWithSignal, {
            once: true
          });
        });
      },
      async close() { targetClosed += 1; }
    }));

    const startedAt = Date.now();
    const transfer = ensureVerifiedObjectAtDestination({
      source: { config: config(`${mode}-source`, `${mode}-source-key`), driver: source },
      target: { config: config(`${mode}-target`, `${mode}-target-key`), driver: target },
      prefix: "_uploads",
      key: `${mode}.webp`,
      expected: { size: 16 },
      contentType: "image/webp",
      cleanupCandidate: async (_object, options) => {
        cleanupAfter = options?.confirmAbsentAfter;
      },
      signal: controller.signal
    });
    if (mode === "cancel") {
      await entered;
      controller.abort(new Error("cancel transfer"));
    }
    await assert.rejects(transfer);
    assert.equal(sourceBody.destroyed, true, `${mode} 必须销毁未消费源流`);
    assert.ok(cleanupAfter instanceof Date);
    assert.ok(cleanupAfter.getTime() >= startedAt + 14_000);
    assert.ok(cleanupAfter.getTime() <= Date.now() + 16_000);
    await Promise.all([source.close?.(), target.close?.()]);
    assert.equal(sourceClosed, 1, `${mode} 必须释放 source driver lease`);
    assert.equal(targetClosed, 1, `${mode} 必须释放 target driver lease`);
  }
});
test("[Server/存储] 预存在迁移目标只在源完整性通过后读取目标", async () => {
  const wrongBody = Buffer.from("wrong-source");
  const expectedBody = Buffer.from("expected-source");
  let targetReads = 0;
  const driver = (overrides: Partial<StorageDriver>): StorageDriver => ({
    async exists() { return false; },
    async openRead() { throw new Error("unexpected openRead"); },
    async readBuffer() { return Buffer.alloc(0); },
    async writeBuffer() {},
    async writeStream() {},
    async removeObjects(objects) {
      return objects.map((object) => ({
        ...object,
        status: "missing" as const
      }));
    },
    async copy() {},
    serverCopySource() { return undefined; },
    supportsServerCopySource() { return false; },
    async copyFromServerSource() {},
    listKeys(_prefix, options) { return batchStorageKeys([], options); },
    async selfTest() { return { backend: "s3", writable: true }; },
    async pruneEmptyDirs() { return 0; },
    ...overrides
  });
  const config = (slug: string, credential: string): StorageConfig => ({
    slug,
    type: "s3",
    s3: mergeS3Settings({
      endpoint: "https://cos.ap-jakarta.example.test",
      bucket: `${slug}-bucket`,
      access_key_id: credential,
      secret_access_key: `${credential}-secret`
    })
  });
  await assert.rejects(
    ensureVerifiedObjectAtDestination({
      source: {
        config: config("existing-source", "source-key"),
        driver: driver({
          async openRead() {
            return {
              body: Readable.from([wrongBody]),
              size: wrongBody.byteLength,
              totalSize: wrongBody.byteLength,
              backend: "s3"
            };
          }
        })
      },
      target: {
        config: config("existing-target", "target-key"),
        driver: driver({
          async exists() { return true; },
          async openRead() {
            targetReads += 1;
            return {
              body: Readable.from([expectedBody]),
              size: expectedBody.byteLength,
              totalSize: expectedBody.byteLength,
              backend: "s3"
            };
          }
        })
      },
      prefix: "_uploads",
      key: "existing.webp",
      expected: {
        size: wrongBody.byteLength,
        md5: createHash("md5").update(expectedBody).digest("hex")
      },
      contentType: "image/webp"
    }),
    (error) => error instanceof ApiError
      && error.code === "storage_source_integrity_failed"
  );
  assert.equal(targetReads, 0);
});
test("[Server/存储] S3 Range 错误释放响应体并保留权威对象总长度", async () => {
  const config: StorageConfig = {
    slug: "s3-range-test",
    type: "s3",
    s3: s3SettingsSchema.parse({
      endpoint: "s3.example.test",
      bucket: "images",
      access_key_id: "access-key",
      secret_access_key: "secret-key"
    })
  };
  const rangeBody = new PassThrough();
  let commands = 0;
  const rangeError = Object.assign(new Error("Invalid Range"), {
    $metadata: { httpStatusCode: 416 },
    $response: {
      headers: { "content-range": "bytes */1234" },
      body: rangeBody
    }
  });
  const client: S3CommandClient = {
    async send(command) {
      commands += 1;
      const input = (command as { input: { Range?: string } }).input;
      assert.equal(input.Range, "bytes=1234-1235");
      throw rangeError;
    },
    destroy() {}
  };
  const backend = new S3Backend(config, { client });
  await assert.rejects(
    backend.openRead("full", "range.webp", "bytes=1234-1235"),
    (error) => {
      const value = error as {
        status?: number;
        code?: string;
        details?: { total_size?: number };
      };
      return value.status === 416
        && value.code === "range_not_satisfiable"
        && value.details?.total_size === 1234;
    }
  );
  assert.equal(commands, 1, "Content-Range 已给出总长度时不应再发 HEAD");
  assert.equal(rangeBody.destroyed, true);
  backend.close();

  const fallbackBody = new PassThrough();
  let fallbackCommands = 0;
  const fallbackBackend = new S3Backend(config, {
    client: {
      async send(command) {
        fallbackCommands += 1;
        const commandName = (command as { constructor: { name: string } })
          .constructor.name;
        if (commandName === "GetObjectCommand") {
          throw Object.assign(new Error("Invalid Range"), {
            $metadata: { httpStatusCode: 416 },
            $response: { headers: {}, body: fallbackBody }
          });
        }
        assert.equal(commandName, "HeadObjectCommand");
        return { ContentLength: 2048 };
      },
      destroy() {}
    }
  });
  await assert.rejects(
    fallbackBackend.openRead("full", "fallback.webp", "bytes=2048-"),
    (error) => (
      (error as { details?: { total_size?: number } })
        .details?.total_size === 2048
    )
  );
  assert.equal(fallbackCommands, 2);
  assert.equal(fallbackBody.destroyed, true);
  fallbackBackend.close();
});
test("[Server/存储] S3 响应期限和 driver 引用退休覆盖完整流生命周期", {
  timeout: 5_000
}, async () => {
  const consume = async (stream: Readable) => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  };
  const bodyFrom = <T extends { Body: Readable }>(result: T) => result.Body;
  const timeoutError = (error: unknown) => (
    error instanceof Error
    && "code" in error
    && error.code === "storage_timeout"
  );

  const normalRuntime = new S3RequestRuntime({
    idleTimeoutMs: 200,
    taskTimeoutMs: 500
  });
  const normalBody = new PassThrough();
  const normalResult = await normalRuntime.run(
    async () => ({ Body: normalBody }),
    {},
    bodyFrom
  );
  const normalRead = consume(normalResult.Body);
  normalBody.end("ok");
  assert.equal((await normalRead).toString(), "ok");

  const idleRuntime = new S3RequestRuntime({
    idleTimeoutMs: 20,
    taskTimeoutMs: 500
  });
  const idleBody = new PassThrough();
  const idleResult = await idleRuntime.run(
    async () => ({ Body: idleBody }),
    {},
    bodyFrom
  );
  await assert.rejects(() => consume(idleResult.Body), timeoutError);
  assert.equal(idleBody.destroyed, true);

  const taskRuntime = new S3RequestRuntime({
    idleTimeoutMs: 500,
    taskTimeoutMs: 20
  });
  const taskBody = new PassThrough();
  const taskResult = await taskRuntime.run(
    async () => ({ Body: taskBody }),
    {},
    bodyFrom
  );
  await assert.rejects(() => consume(taskResult.Body), timeoutError);
  assert.equal(taskBody.destroyed, true);

  const caller = new AbortController();
  const callerReason = new Error("caller cancelled S3 body");
  const callerBody = new PassThrough();
  const callerResult = await normalRuntime.run(
    async () => ({ Body: callerBody }),
    { signal: caller.signal },
    bodyFrom
  );
  const callerRead = consume(callerResult.Body);
  caller.abort(callerReason);
  await assert.rejects(callerRead, (error) => error === callerReason);
  assert.equal(callerBody.destroyed, true);

  await assert.rejects(
    normalRuntime.run(async () => {
      throw Object.assign(new Error("socket timed out"), { code: "ETIMEDOUT" });
    }),
    timeoutError
  );

  const pendingRequestRuntime = new S3RequestRuntime({
    idleTimeoutMs: 500,
    taskTimeoutMs: 20
  });
  await assert.rejects(
    pendingRequestRuntime.run((signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true
      });
    })),
    timeoutError
  );

  const incomingServer = createHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    if (request.url === "/complete") {
      response.end("complete");
      return;
    }
    response.write("partial");
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    incomingServer.once("error", rejectListen);
    incomingServer.listen(0, "127.0.0.1", () => resolveListen());
  });
  try {
    const address = incomingServer.address();
    assert.ok(address && typeof address === "object");
    const incomingRuntime = new S3RequestRuntime({
      idleTimeoutMs: 40,
      taskTimeoutMs: 1_000
    });
    const completeResult = await incomingRuntime.run(
      (signal) => new Promise<{ Body: Readable }>((resolveRequest, rejectRequest) => {
        const request = httpRequest({
          host: "127.0.0.1",
          port: address.port,
          path: "/complete",
          signal
        }, (response) => resolveRequest({ Body: response }));
        request.once("error", rejectRequest);
        request.end();
      }),
      {},
      bodyFrom
    );
    assert.equal((await consume(completeResult.Body)).toString(), "complete");
    assert.equal(completeResult.Body.listenerCount("timeout"), 0);

    const incomingResult = await incomingRuntime.run(
      (signal) => new Promise<{ Body: Readable }>((resolveRequest, rejectRequest) => {
        const request = httpRequest({
          host: "127.0.0.1",
          port: address.port,
          path: "/idle",
          signal
        }, (response) => resolveRequest({ Body: response }));
        request.once("error", rejectRequest);
        request.end();
      }),
      {},
      bodyFrom
    );
    await assert.rejects(() => consume(incomingResult.Body), timeoutError);
    assert.equal(incomingResult.Body.destroyed, true);
  } finally {
    incomingServer.closeAllConnections();
    await new Promise<void>((resolveClose) => incomingServer.close(() => resolveClose()));
  }

  function streamDriver(body: PassThrough, onClose: () => void): StorageDriver {
    return {
      async exists() { return false; },
      async openRead() {
        return {
          body,
          size: undefined,
          totalSize: undefined,
          backend: "s3"
        };
      },
      async readBuffer() { return Buffer.alloc(0); },
      async writeBuffer() {},
      async writeStream() {},
      async removeObjects(objects) {
        return objects.map((object) => ({
          ...object,
          status: "missing" as const
        }));
      },
      async copy() {},
      serverCopySource() { return undefined; },
      supportsServerCopySource() { return false; },
      async copyFromServerSource() {},
      listKeys(_prefix, options) {
        return batchStorageKeys(["one.webp"], options);
      },
      async selfTest() { return { backend: "s3", writable: true }; },
      async pruneEmptyDirs() { return 0; },
      async close() { onClose(); }
    };
  }

  const leasedBody = new PassThrough();
  let leasedDriverClosed = 0;
  const managed = manageTestStorageDriver(
    streamDriver(leasedBody, () => { leasedDriverClosed += 1; })
  );
  const opened = await managed.openRead("full", "leased.webp");
  let closeSettled = false;
  const closing = managed.close().then(() => { closeSettled = true; });
  await delay(10);
  assert.equal(closeSettled, false);
  assert.equal(leasedDriverClosed, 0);
  await assert.rejects(
    managed.exists("full", "new-operation.webp"),
    (error) => (
      error instanceof Error
      && "code" in error
      && error.code === "storage_driver_retired"
    )
  );
  const leasedRead = consume(opened.body);
  leasedBody.end("leased");
  assert.equal((await leasedRead).toString(), "leased");
  await closing;
  assert.equal(leasedDriverClosed, 1);

  const listingBody = new PassThrough();
  let listingDriverClosed = 0;
  const listingManaged = manageTestStorageDriver(
    streamDriver(listingBody, () => { listingDriverClosed += 1; })
  );
  const leasedListing = listingManaged.listKeys("full");
  const firstBatch = await leasedListing.next();
  assert.equal(firstBatch.done, false);
  const listingClose = listingManaged.close();
  await delay(10);
  assert.equal(listingDriverClosed, 0);
  await leasedListing.return(undefined as never);
  await listingClose;
  assert.equal(listingDriverClosed, 1);
  listingBody.destroy();

  const pendingBody = new PassThrough();
  let pendingDriverClosed = 0;
  let finishPendingExists: (value: boolean) => void = () => {};
  const pendingDriver = streamDriver(
    pendingBody,
    () => { pendingDriverClosed += 1; }
  );
  pendingDriver.exists = () => new Promise((resolve) => {
    finishPendingExists = resolve;
  });
  const pendingManaged = manageTestStorageDriver(pendingDriver);
  const pendingExists = pendingManaged.exists("full", "pending.webp");
  const pendingClose = pendingManaged.close();
  await delay(10);
  assert.equal(pendingDriverClosed, 0);
  finishPendingExists(true);
  assert.equal(await pendingExists, true);
  await pendingClose;
  assert.equal(pendingDriverClosed, 1);
  pendingBody.destroy();

  for (const ending of ["eof", "error"] as const) {
    const body = new PassThrough();
    let closed = 0;
    const driver = streamDriver(body, () => { closed += 1; });
    if (ending === "error") {
      driver.listKeys = () => (async function* () {
        yield ["one.webp"];
        throw new Error("listing failed");
      })();
    }
    const lifecycleManaged = manageTestStorageDriver(driver);
    const listing = lifecycleManaged.listKeys("full");
    assert.equal((await listing.next()).done, false);
    const lifecycleClose = lifecycleManaged.close();
    await delay(10);
    assert.equal(closed, 0);
    if (ending === "eof") {
      assert.equal((await listing.next()).done, true);
    } else {
      await assert.rejects(() => listing.next(), /listing failed/);
    }
    await lifecycleClose;
    assert.equal(closed, 1, `${ending} must release the listing reference`);
    body.destroy();
  }

  for (const ending of ["destroy", "error"] as const) {
    const body = new PassThrough();
    let closed = 0;
    const lifecycleManaged = manageTestStorageDriver(
      streamDriver(body, () => { closed += 1; })
    );
    await lifecycleManaged.openRead("full", `${ending}.webp`);
    const lifecycleClose = lifecycleManaged.close();
    await delay(10);
    body.destroy(ending === "error" ? new Error("stream failed") : undefined);
    await lifecycleClose;
    assert.equal(closed, 1, `${ending} must release the object-body lease`);
  }

  let failedCloseCalls = 0;
  const closeFailure = new Error("driver close failed");
  const failingDriver = streamDriver(new PassThrough(), () => undefined);
  failingDriver.close = async () => {
    failedCloseCalls += 1;
    throw closeFailure;
  };
  const failingManaged = manageTestStorageDriver(failingDriver);
  const firstClose = failingManaged.close();
  const repeatedClose = failingManaged.close();
  assert.equal(firstClose, repeatedClose);
  await assert.rejects(firstClose, (error) => error === closeFailure);
  await assert.rejects(repeatedClose, (error) => error === closeFailure);
  assert.equal(failedCloseCalls, 1, "driver 只关闭一次");
});
test("[Server/存储] 提交后两个暂存对象只调用一次批量清理并仅重试未完成项", async () => {
  const immediateCalls: string[][] = [];
  const retainedCalls: string[][] = [];
  const plan = new IngestionCommitStagingCleanup(
    "local",
    ["prepared-image", "prepared-thumbnail"],
    {
      removeImmediately: async (keys) => {
        immediateCalls.push([...keys]);
        return [keys[1]!];
      },
      removeRetained: async (keys) => {
        retainedCalls.push([...keys]);
      },
      schedule: async (work) => work()
    }
  );

  plan.markDatabaseCommitted();
  assert.equal(await plan.removeNow(), 1);
  assert.deepEqual(immediateCalls, [[
    "prepared-image",
    "prepared-thumbnail"
  ]]);
  await plan.scheduleRemainingRemoval();
  assert.deepEqual(retainedCalls, [["prepared-thumbnail"]]);

  const requestFailureRetained: string[][] = [];
  const failedPlan = new IngestionCommitStagingCleanup(
    "local",
    ["prepared-image", "prepared-thumbnail"],
    {
      removeImmediately: async () => {
        throw new Error("injected request-level deletion failure");
      },
      removeRetained: async (keys) => {
        requestFailureRetained.push([...keys]);
      },
      schedule: async (work) => work()
    }
  );
  failedPlan.markDatabaseCommitted();
  assert.equal(await failedPlan.removeNow(), 2);
  await failedPlan.scheduleRemainingRemoval();
  assert.deepEqual(requestFailureRetained, [[
    "prepared-image",
    "prepared-thumbnail"
  ]]);
});
test("[Server/存储] local 与 S3 对象命名、当前类型和物理命名空间保持统一", () => {
  const s3 = s3SettingsSchema.parse({
    endpoint: "objects.example.com",
    bucket: "gallery",
    access_key_id: "key",
    secret_access_key: "secret",
    root_path: "/images/"
  });
  assert.deepEqual(missingS3Fields(s3), []);
  assert.deepEqual(missingS3Fields(s3SettingsSchema.parse({})), [
    "endpoint",
    "bucket",
    "access_key_id",
    "secret_access_key"
  ]);
  assert.deepEqual(
    {
      connect: s3.connect_timeout_seconds,
      idle: s3.idle_timeout_seconds,
      task: s3.task_timeout_seconds
    },
    { connect: 15, idle: 15, task: 300 }
  );
  assert.equal(s3SettingsSchema.safeParse({
    ...s3,
    connect_timeout_seconds: 0
  }).success, false);
  assert.equal(s3SettingsSchema.safeParse({
    ...s3,
    idle_timeout_seconds: 301
  }).success, false);
  assert.equal(s3SettingsSchema.safeParse({
    ...s3,
    task_timeout_seconds: 14
  }).success, false);

  const first: StorageConfig = {
    slug: "archive-a",
    type: "s3",
    s3
  };
  const second: StorageConfig = {
    slug: "archive-b",
    type: "s3",
    s3: {
      ...s3,
      endpoint: "https://OBJECTS.example.com/",
      access_key_id: "rotated",
      secret_access_key: "rotated-secret",
      root_path: "images",
      connect_timeout_seconds: 30,
      idle_timeout_seconds: 45,
      task_timeout_seconds: 600
    }
  };
  const local: StorageConfig = { slug: "local", type: "local" };
  assert.equal("s3" in local, false);
  assert.deepEqual(storageConfigFromRow({
    slug: "local",
    type: "local",
    config: { ignored_extra_config: true }
  }), {
    slug: "local",
    type: "local",
    namespace_identities: []
  });
  assert.deepEqual(storageConfigFromRow({
    slug: "s3-only",
    type: "s3",
    config: s3
  }), {
    slug: "s3-only",
    type: "s3",
    namespace_identities: [],
    s3
  });
  assert.throws(() => storageConfigFromRow({
    slug: "unsupported",
    type: "unsupported",
    config: {}
  }), /Unsupported storage backend type: unsupported/);
  assert.equal(storageNamespaceIdentity(first), storageNamespaceIdentity(second));
  assert.equal(shareStorageNamespace(first, second), true);
  const historicalAliasA: StorageConfig = {
    ...first,
    slug: "historical-a",
    namespace_identities: ["historical-shared"]
  };
  const historicalAliasB: StorageConfig = {
    ...first,
    slug: "historical-b",
    namespace_identities: ["historical-shared", "historical-bridge"],
    s3: { ...first.s3, endpoint: "https://new-endpoint.example.com" }
  };
  const transitiveAlias: StorageConfig = {
    ...first,
    slug: "historical-c",
    namespace_identities: ["historical-bridge"],
    s3: { ...first.s3, endpoint: "https://third-endpoint.example.com" }
  };
  const unrelatedAlias: StorageConfig = {
    ...first,
    slug: "unrelated",
    s3: { ...first.s3, endpoint: "https://unrelated.example.com" }
  };
  const historicalGroups = groupStorageNamespaces([
    historicalAliasA,
    unrelatedAlias,
    transitiveAlias,
    historicalAliasB
  ]);
  assert.deepEqual(
    historicalGroups
      .map((group) => group.map((config) => config.slug).toSorted())
      .toSorted((left, right) => left[0].localeCompare(right[0])),
    [["historical-a", "historical-b", "historical-c"], ["unrelated"]]
  );
  const historicalGroup = historicalGroups.find((group) => (
    group.some((config) => config.slug === historicalAliasA.slug)
  ));
  assert.ok(historicalGroup);
  assert.equal(
    storageNamespaceGroupIdentity(historicalGroup),
    storageNamespaceGroupIdentity([
      historicalAliasB,
      transitiveAlias,
      historicalAliasA
    ])
  );

  const canonicalKey = storageObjectKey(imageId, "avif");
  assert.equal(canonicalKey, "8d/" + imageId + ".avif");
  assert.equal(thumbnailObjectKey(canonicalKey), "8d/" + imageId + ".webp");
  assert.equal(isCanonicalImageObjectKey(canonicalKey), true);
  assert.equal(isCanonicalImageObjectKey("00/" + imageId + ".avif"), false);
  assert.equal(isCanonicalImageObjectKey(imageId + ".avif"), false);
  assert.equal(
    isCanonicalImageObjectKey("nested/" + imageId + ".avif"),
    false
  );
  assert.throws(
    () => assertCanonicalImageObjectKey("nested/" + imageId + ".avif"),
    /Invalid image object key/
  );
  assert.throws(
    () => thumbnailObjectKey("nested/" + imageId + ".avif"),
    /Invalid image object key/
  );
  assert.equal(isCanonicalThumbnailObjectKey(thumbnailObjectKey(canonicalKey)), true);
  assert.equal(isCanonicalThumbnailObjectKey(canonicalKey), false);
  assert.equal(
    storageS3ObjectName(first, "full", canonicalKey),
    "images/full/" + canonicalKey
  );
  assert.equal(s3ListPrefix(first, "thumbs"), "images/thumbs/");
  assert.equal(
    s3CopySource(first, "full", canonicalKey),
    "gallery/images/full/" + canonicalKey
  );
  assert.equal(contentType("webp"), "image/webp");
  assert.throws(
    () => storageS3ObjectName(first, "full", "../escape.webp"),
    /Unsafe storage path/
  );

  const attemptId = "019f75ca-1219-7e89-a625-268a49963cec";
  const sessionId = `A${"b".repeat(42)}`;
  assert.equal(stagingSessionId(ingestionStagingImageKey({
    session_id: sessionId,
    image_id: imageId,
    generation: attemptId,
    execution_token: attemptId
  })), sessionId);
  assert.equal(stagingSessionId(ingestionStagingThumbnailKey({
    session_id: sessionId,
    image_id: imageId,
    generation: attemptId,
    execution_token: attemptId
  })), sessionId);
  assert.equal(stagingSessionId("unexpected-object.bin"), "");
});
test("[Server/存储] Local 驱动取消阻止发布，候选清理及并行自检互相隔离", async () => {
  const root = await createTestDirectory("local-contract-");
  const helper = join(root, "verify.mjs");
  const moduleUrl = pathToFileURL(resolve("packages/server/src/storage/drivers/local.ts")).href;
  const source = `
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { Readable } from "node:stream";
import { LocalBackend } from ${JSON.stringify(moduleUrl)};
const fsp = fs.promises;
const directory = join(process.env.IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY, "storage");
const driver = new LocalBackend();
const stopped = new AbortController(); const reason = new Error("cancelled"); stopped.abort(reason);
for (const work of [
  () => driver.writeBuffer("full","pre.bin",Buffer.from("x"),"text/plain",{signal:stopped.signal}),
  () => driver.copy("full","missing.bin","full","pre.bin",{signal:stopped.signal}),
  () => driver.selfTest({signal:stopped.signal})
]) await assert.rejects(work,(error)=>error===reason);
await assert.rejects(fsp.access(directory));
await fsp.mkdir(join(directory,"full"),{recursive:true});
await fsp.writeFile(join(directory,"full/source.bin"),"source");
const originalWrite = fsp.writeFile; const originalCopy = fsp.copyFile; const originalMkdir = fsp.mkdir;
try {
  const abort = new AbortController();
  fsp.writeFile = async (path,body,options) => {
    assert.equal(options.signal,abort.signal);
    await originalWrite(path,body,options); abort.abort(reason);
  }; syncBuiltinESMExports();
  await assert.rejects(driver.writeBuffer("full","buffer.bin",Buffer.from("x"),"text/plain",{signal:abort.signal}),(error)=>error===reason);
  assert.deepEqual(await fsp.readdir(join(directory,"full")),["source.bin"]);
} finally {fsp.writeFile=originalWrite;syncBuiltinESMExports();}
try {
  const abort = new AbortController();
  fsp.copyFile = async (...args) => {await originalCopy(...args);abort.abort(reason);};syncBuiltinESMExports();
  await assert.rejects(driver.copy("full","source.bin","full","copy.bin",{signal:abort.signal}),(error)=>error===reason);
  assert.deepEqual(await fsp.readdir(join(directory,"full")),["source.bin"]);
} finally {fsp.copyFile=originalCopy;syncBuiltinESMExports();}
for (const method of ["buffer","copy","stream"]) {
  const abort = new AbortController();
  try {
    fsp.mkdir = async (...args) => {const value=await originalMkdir(...args);abort.abort(reason);return value;};syncBuiltinESMExports();
    const body=Readable.from(["source"]);
    const work = method==="buffer" ? driver.writeBuffer("full","mkdir.bin",Buffer.from("x"),"text/plain",{signal:abort.signal})
      : method==="copy" ? driver.copy("full","source.bin","full","mkdir.bin",{signal:abort.signal})
      : driver.writeStream("full","mkdir.bin",body,6,"text/plain",{signal:abort.signal});
    await assert.rejects(work,(error)=>error===reason);body.destroy();
    assert.deepEqual(await fsp.readdir(join(directory,"full")),["source.bin"]);
  } finally {fsp.mkdir=originalMkdir;syncBuiltinESMExports();}
}
// Aborting as opendir resolves must still close the acquired iterator.
const originalOpendir=fsp.opendir;
for (const populated of [false,true]) {
  const abort=new AbortController();let closes=0;let iterations=0;
  try {
    fsp.opendir=async()=>{abort.abort(reason);return {
      async *[Symbol.asyncIterator]() {
        try {iterations++;if(populated) yield {name:"leaf",isDirectory:()=>false};}
        finally {closes++;}
      }
    };};syncBuiltinESMExports();
    await assert.rejects(driver.pruneEmptyDirs({signal:abort.signal}),(error)=>error===reason);
    assert.equal(iterations,1);assert.equal(closes,1);
  } finally {fsp.opendir=originalOpendir;syncBuiltinESMExports();}
}
// Real concurrent probes must not touch an existing file or one another.
await fsp.mkdir(join(directory,"_uploads"),{recursive:true});
await fsp.writeFile(join(directory,"_uploads/.storage-test"),"existing");
const outcomes = await Promise.all(Array.from({length:12},()=>driver.selfTest()));
assert.ok(outcomes.every((result)=>result.writable));
assert.deepEqual(await fsp.readdir(join(directory,"_uploads")),[".storage-test"]);
assert.equal(await fsp.readFile(join(directory,"_uploads/.storage-test"),"utf8"),"existing");
const cancelledProbe = new LocalBackend();const cancel = new AbortController();
const write = cancelledProbe.writeBuffer.bind(cancelledProbe);
cancelledProbe.writeBuffer = async (...args) => {await write(...args);cancel.abort(reason);};
const remove = cancelledProbe.removeObjects.bind(cancelledProbe);
cancelledProbe.removeObjects = async (objects,options) => {
  assert.ok(options.signal);assert.notEqual(options.signal,cancel.signal);assert.equal(options.signal.aborted,false);
  return remove(objects,options);
};
const [failed,succeeded]=await Promise.allSettled([cancelledProbe.selfTest({signal:cancel.signal}),driver.selfTest()]);
assert.equal(failed.status,"rejected");assert.equal(failed.reason,reason);
assert.equal(succeeded.status,"fulfilled");
assert.deepEqual(await fsp.readdir(join(directory,"_uploads")),[".storage-test"]);
console.log("local-contract-ok");
`;
  try {
    await writeFile(helper, source);
    const result = await runProcess(process.execPath, ["--experimental-strip-types", helper], {
      cwd: resolve("."), env: { ...process.env, NODE_ENV: "development", IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY: toNamespacedPath(root) }, timeoutMs: 30_000
    });
    assert.match(result.stdout, /local-contract-ok/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
