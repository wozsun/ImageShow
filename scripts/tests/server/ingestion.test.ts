import "../support/server-environment.ts";
import assert from "node:assert/strict";
import {
  randomUUID
} from "node:crypto";
import {
  rm,
  writeFile
} from "node:fs/promises";
import {
  join,
  resolve,
  toNamespacedPath
} from "node:path";
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
  appConfig
} from "../../../packages/shared/src/app-config.ts";
import {
  adminApiBasePath,
  ingestionUpdatePath
} from "../../../packages/shared/src/browser.ts";
import {
  getRuntimeConfig,
  initializeRuntimeConfig
} from "../../../packages/server/src/config/runtime-config-store.ts";
import {
  ApiError
} from "../../../packages/server/src/core/api-error.ts";
import {
  DynamicConcurrencyLimiter,
  DynamicWeightedLimiter
} from "../../../packages/server/src/core/concurrency.ts";
import {
  uuidV7Timestamp
} from "../../../packages/server/src/core/uuid.ts";
import {
  limitIngestionControlBody,
  limitProtectedAdminRequestBody
} from "../../../packages/server/src/core/http/request-body-limit.ts";
import {
  createImageId,
  parseImageTime
} from "../../../packages/server/src/images/image-time.ts";
import {
  calculateDownloadProgress,
  downloadProgressLength
} from "../../../packages/server/src/images/ingestion/sources/download-progress.ts";
import {
  JsonlManifestError,
  parseJsonlManifest
} from "../../../packages/server/src/images/ingestion/sources/jsonl.ts";
import {
  ingestionIntentRequestHash
} from "../../../packages/server/src/images/ingestion/sessions/request-hash.ts";
import {
  assertImageIdentity,
  createIngestionSessionId,
  inspectImageUuidV7
} from "../../../packages/server/src/images/ingestion/sessions/identity.ts";
import {
  ingestionSessionSemanticHash
} from "../../../packages/server/src/images/ingestion/sessions/projection.ts";
import {
  ingestionTokenPurposes,
  IngestionTokenService,
  type IngestionTokenEnvelope
} from "../../../packages/server/src/images/ingestion/sessions/token-service.ts";
import {
  IngestionIrreversibleCoordinator
} from "../../../packages/server/src/images/ingestion/execution/irreversible-coordinator.ts";
import {
  cancelIngestionSessions,
  cancelRecoveredIngestionSessions
} from "../../../packages/server/src/images/ingestion/cancel/coordinator.ts";
import {
  ingestionSessionIncarnationMismatch
} from "../../../packages/server/src/images/ingestion/repository.ts";
import type {
  IngestionSessionSnapshot
} from "../../../packages/server/src/images/ingestion/sessions/model.ts";
import {
  downloadIngestionSessionSnapshot
} from "../../../packages/server/src/images/ingestion/sources/download-session.ts";
import {
  heartbeatIngestionExecution,
  mutateIngestionExecution,
  refreshIngestionExecutionSession,
  updateIngestionExecutionProgress
} from "../../../packages/server/src/images/ingestion/execution/session.ts";
import {
  ingestionCleanupRetryQueue
} from "../../../packages/server/src/images/ingestion/cleanup/retry-queue.ts";
import {
  IngestionSessionRecovery
} from "../../../packages/server/src/images/ingestion/workers/session-recovery.ts";
import {
  ingestionCommitDispatchWindow,
  ingestionWorkerDispatchWindows,
  isSameFailedIngestionExecution,
  planIngestionWorkerLanes
} from "../../../packages/server/src/images/ingestion/workers/ingestion-worker.ts";
import {
  withImportPrefetchAdmission
} from "../../../packages/server/src/images/ingestion/workers/import-prefetch.ts";
import {
  ingestionPreparationAdmissionSnapshot,
  withIngestionPreparationAdmission
} from "../../../packages/server/src/images/ingestion/workers/preparation-admission.ts";
import {
  preparedAttemptIsReferenced
} from "../../../packages/server/src/images/ingestion/workers/prepare-session.ts";
import {
  ingestionStagingImageKey,
  parseIngestionStagingCleanupKey
} from "../../../packages/server/src/images/ingestion/staging-keys.ts";
import {
  ingestionRawPath
} from "../../../packages/server/src/images/ingestion/raw/paths.ts";
import {
  extractWeiboPost,
  parseWeiboPostUrl
} from "../../../packages/server/src/images/ingestion/sources/weibo-parser.ts";
import {
  weiboPostToJsonl
} from "../../../packages/server/src/images/ingestion/sources/weibo.ts";
import {
  deriveAuthorIdentityFromLink
} from "../../../packages/server/src/authors/identity.ts";
import {
  canonicalImportMetadata
} from "../../../packages/server/src/images/ingestion/sessions/import-metadata.ts";
import {
  createWeiboRequestScheduler
} from "../../../packages/server/src/images/ingestion/sources/weibo-request-scheduler.ts";
import {
  WeiboImportError
} from "../../../packages/server/src/images/ingestion/sources/weibo-types.ts";
import {
  closeAdminSessionConnections
} from "../../../packages/server/src/users/admin-session-connections.ts";
import {
  streamIngestionQueueEvents
} from "../../../packages/server/src/images/ingestion/queue/events.ts";
import {
  deferredPromise
} from "../support/server-test-context.ts";

test("[Server/内容接入] 内容接入草稿批量更新在保护层后仍使用内容接入正文预算", async () => {
  const app = new Hono();
  app.use(`${adminApiBasePath}/*`, limitProtectedAdminRequestBody);
  app.post(ingestionUpdatePath, limitIngestionControlBody, async (context) => {
    const body = await context.req.json<{ marker: string }>();
    return context.json({ ok: true, markerLength: body.marker.length });
  });
  app.post(`${adminApiBasePath}/standard-body`, (context) => (
    context.json({ ok: true })
  ));
  const marker = "x".repeat(160 * 1024);
  const request = (path: string) => app.request(new Request(
    `http://imageshow.test${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ marker })
    }
  ));
  const accepted = await request(ingestionUpdatePath);
  assert.equal(accepted.status, 200);
  assert.equal(
    (await accepted.json() as { markerLength: number }).markerLength,
    marker.length
  );
  const standard = await request(`${adminApiBasePath}/standard-body`);
  assert.equal(standard.status, 413);
  assert.equal(
    (await standard.json() as { code?: string }).code,
    "request_body_too_large"
  );
});
test("[Server/内容接入] 导入清单、下载进度与微博入口使用同一当前语义", () => {
  const manifest = parseJsonlManifest([
    JSON.stringify({
      original: "https://img.example.com/a.jpg",
      source: "https://weibo.com/detail/1",
      image_time: "2020-05-01 00:00:00",
      author: "alice",
      tags: [" Concert ", "concert"]
    }),
    "not-json",
    JSON.stringify({ original: "http://img.example.com/b.jpg" })
  ].join("\n"), { maxItems: 100, timeZone: "Asia/Makassar" });
  assert.equal(manifest.items.length, 1);
  assert.equal(manifest.items[0]?.image_time, "2020-04-30T16:00:00.000Z");
  assert.deepEqual(manifest.items[0]?.tags, ["concert"]);
  assert.deepEqual(manifest.errors.map(({ line }) => line), [2, 3]);
  const themes = [null, "none", "night"];
  const themedManifest = parseJsonlManifest(themes.map((theme, index) => (
    JSON.stringify({ original: `https://img.example.com/${index}.jpg`, theme })
  )).join("\n"), { maxItems: 3 });
  assert.deepEqual(themedManifest.errors, []);
  assert.deepEqual(themedManifest.items.map((item) => item.theme), themes);
  const weiboPost = {
    source_url: "https://weibo.com/1234567890/Example",
    weibo_id: "123",
    bid: "Example",
    user_id: "1234567890",
    published_at: "2026-08-29T01:02:03.000Z",
    images: [{
      original_url: "https://wx1.sinaimg.cn/large/example.jpg",
      user_id: "1234567890"
    }],
    image_count: 1
  };
  const authorSlugs = new Map([["1234567890", "alice"]]);
  const withWeiboSource = parseJsonlManifest(
    weiboPostToJsonl(weiboPost, true, authorSlugs),
    { maxItems: 10, timeZone: "UTC" }
  );
  const withoutWeiboSource = parseJsonlManifest(
    weiboPostToJsonl(weiboPost, false, authorSlugs),
    { maxItems: 10, timeZone: "UTC" }
  );
  assert.equal(withWeiboSource.items[0]?.source, weiboPost.source_url);
  assert.equal(withWeiboSource.items[0]?.author, "alice");
  assert.equal(withoutWeiboSource.items[0]?.source, undefined);
  assert.equal(
    withoutWeiboSource.items[0]?.original,
    weiboPost.images[0]!.original_url
  );
  const policyMetadata = {
    title: "",
    description: "",
    source: weiboPost.source_url,
    original: "https://submitted.example.com/ignored.jpg",
    device: "auto" as const,
    brightness: "auto" as const,
    theme: null,
    author: "",
    tags: []
  };
  assert.deepEqual(canonicalImportMetadata({
    import: { keep_original_link: ["weibo"] },
    weibo: { source_enabled: true }
  }, "weibo", weiboPost.images[0]!.original_url, policyMetadata), {
    ...policyMetadata,
    original: weiboPost.images[0]!.original_url
  });
  assert.deepEqual(canonicalImportMetadata({
    import: { keep_original_link: [] },
    weibo: { source_enabled: false }
  }, "weibo", weiboPost.images[0]!.original_url, policyMetadata), {
    ...policyMetadata,
    source: "",
    original: ""
  });
  const tooManyTags = parseJsonlManifest(JSON.stringify({
    original: "https://img.example.com/c.jpg",
    tags: Array.from(
      { length: 51 },
      (_, index) => `tag-${String(index).padStart(2, "0")}`
    )
  }), { maxItems: 1 });
  assert.equal(tooManyTags.items.length, 0);
  assert.deepEqual(tooManyTags.errors.map(({ line }) => line), [1]);
  assert.throws(() => parseJsonlManifest([
    '{"original":"https://img.example.com/a.jpg"}',
    '{"original":"https://img.example.com/b.jpg"}'
  ].join("\n"), { maxItems: 1 }), JsonlManifestError);

  assert.equal(downloadProgressLength(new Headers({ "content-length": "200" })), 200);
  assert.equal(downloadProgressLength(new Headers({
    "content-encoding": "gzip",
    "content-length": "200"
  })), undefined);
  assert.equal(calculateDownloadProgress(99, 200), 49);
  assert.equal(calculateDownloadProgress(300, 200), 100);

  assert.deepEqual(parseWeiboPostUrl("https://weibo.com/1234567890/ExamplePost"), {
    identifier: "ExamplePost",
    sourceUrl: "https://weibo.com/1234567890/ExamplePost"
  });
  assert.equal(
    parseWeiboPostUrl("https://m.weibo.cn/detail/1234567890123456").identifier,
    "1234567890123456"
  );
  assert.throws(() => parseWeiboPostUrl("https://example.com/not-weibo"));
  assert.deepEqual(
    deriveAuthorIdentityFromLink("https://weibo.com/u/1234567890"),
    { provider: "weibo", id: "1234567890" }
  );
  assert.deepEqual(
    deriveAuthorIdentityFromLink("https://weibo.com/u/1234567890/?from=profile#top"),
    { provider: "weibo", id: "1234567890" }
  );
  for (const link of [
    "http://weibo.com/u/1234567890",
    "https://m.weibo.com/u/1234567890",
    "https://weibo.com.example/u/1234567890",
    "https://user@weibo.com/u/1234567890",
    "https://weibo.com:8443/u/1234567890",
    "https://weibo.com/1234567890/post",
    "https://weibo.com/u/0",
    "https://weibo.com/u/123456789012345678901"
  ]) {
    assert.equal(deriveAuthorIdentityFromLink(link), null, link);
  }

  const extracted = extractWeiboPost({
    idstr: "987654321",
    mblogid: "OuterBid",
    created_at: "Sat Aug 29 09:02:03 +0800 2026",
    user: { idstr: "1111111111" },
    pic_ids: ["outer"],
    pic_infos: {
      outer: {
        largest: { url: "https://wx1.sinaimg.cn/mw2000/outer.jpg" }
      }
    },
    retweeted_status: {
      user: { idstr: "2222222222" },
      pics: [{
        largest: { url: "https://wx2.sinaimg.cn/bmiddle/forwarded.jpg" }
      }],
      retweeted_status: {
        user: {},
        pics: [{
          largest: { url: "https://wx3.sinaimg.cn/thumb180/unknown-owner.jpg" }
        }]
      }
    }
  }, parseWeiboPostUrl("https://weibo.com/1111111111/OuterBid"));
  assert.deepEqual(extracted.images, [
    {
      original_url: "https://wx1.sinaimg.cn/large/outer.jpg",
      user_id: "1111111111"
    },
    {
      original_url: "https://wx2.sinaimg.cn/large/forwarded.jpg",
      user_id: "2222222222"
    },
    {
      original_url: "https://wx3.sinaimg.cn/large/unknown-owner.jpg"
    }
  ]);
  const extractedManifest = weiboPostToJsonl(extracted, true, new Map([
    ["1111111111", "outer-author"],
    ["2222222222", "forwarded-author"]
  ])).split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    extractedManifest.map((item) => item.author),
    ["outer-author", "forwarded-author", undefined]
  );
  const duplicateAcrossStatuses = extractWeiboPost({
    idstr: "987654322",
    created_at: "Sat Aug 29 09:02:03 +0800 2026",
    user: { idstr: "1111111111" },
    pics: [{ largest: { url: "https://wx1.sinaimg.cn/large/shared.jpg" } }],
    retweeted_status: {
      user: { idstr: "2222222222" },
      pics: [{ largest: { url: "https://wx1.sinaimg.cn/large/shared.jpg" } }]
    }
  }, parseWeiboPostUrl("https://weibo.com/1111111111/DuplicateBid"));
  assert.deepEqual(duplicateAcrossStatuses.images, [{
    original_url: "https://wx1.sinaimg.cn/large/shared.jpg"
  }], "同一 URL 被不同 status 声明时不得猜测媒体作者");
});
test("[Server/内容接入] 内容接入身份、稳定哈希、状态投影、TTL 与签名 purpose 契约", () => {
  const imageTime = parseImageTime("2026-08-23T01:02:03.456Z");
  const imageId = createImageId(imageTime.date, 37);
  assert.deepEqual(inspectImageUuidV7(imageId), {
    timestamp: imageTime.date.getTime(),
    version: 7,
    variant: 2,
    randA: 37
  });
  assert.equal(assertImageIdentity(imageId, imageTime.iso, 37).randA, 37);
  assert.throws(() => assertImageIdentity(imageId, imageTime.iso, 38));
  assert.equal(
    createIngestionSessionId("alice", "upload", "same"),
    createIngestionSessionId("alice", "upload", "same")
  );
  assert.notEqual(
    createIngestionSessionId("alice", "upload", "same"),
    createIngestionSessionId("alice", "import", "same")
  );

  const draft = {
    device: "auto" as const,
    brightness: "auto" as const,
    theme: null,
    author: "",
    title: "title",
    description: "",
    source: "",
    original: "",
    tags: ["one", "two"]
  };
  const hashInput = {
    queue: "upload" as const,
    source_type: "upload" as const,
    batch_key: "0198d321-1111-7111-8111-111111111111",
    provided_image_time: null,
    batch_position: 1,
    import_download: null,
    metadata: draft,
    storage_slug: "local",
    expected_size: 123,
    max_long_edge: 456
  };
  assert.equal(
    ingestionIntentRequestHash(hashInput),
    ingestionIntentRequestHash({
      ...hashInput,
      metadata: { ...draft, tags: ["two", "one"] }
    })
  );
  assert.notEqual(
    ingestionIntentRequestHash(hashInput),
    ingestionIntentRequestHash({ ...hashInput, expected_size: 124 })
  );
  const baseIntentHash = ingestionIntentRequestHash(hashInput);
  const excludedHashFields = {
    ...hashInput,
    session_id: "server-session",
    candidate_image_id: "server-candidate",
    image_id: "server-image",
    resolved_image_time: "2027-01-01T00:00:00.000Z",
    accepted_at: 123,
    accepted_order: 456,
    execution_token: "server-token",
    raw_generation: "server-raw",
    prepared_generation: "server-prepared",
    commit_request_id: "server-commit",
    credential: "server-credential",
    metadata: { ...draft, created_by: "server-actor" }
  };
  assert.equal(
    ingestionIntentRequestHash(excludedHashFields),
    baseIntentHash,
    "服务端身份、时钟、token、generation 与 actor 不得进入 request hash"
  );
  const includedHashChanges = [
    { ...hashInput, queue: "import" as const },
    { ...hashInput, source_type: "url" as const },
    { ...hashInput, batch_key: "0198d321-1112-7111-8111-111111111111" },
    { ...hashInput, provided_image_time: "2026-08-23T00:00:00.000Z" },
    { ...hashInput, batch_position: 2 },
    { ...hashInput, import_download: { url: "https://example.com/image.jpg" } },
    { ...hashInput, metadata: { ...draft, device: "pc" as const } },
    { ...hashInput, metadata: { ...draft, brightness: "dark" as const } },
    { ...hashInput, metadata: { ...draft, theme: "night" } },
    { ...hashInput, metadata: { ...draft, theme: "none" } },
    { ...hashInput, metadata: { ...draft, author: "author" } },
    { ...hashInput, metadata: { ...draft, title: "changed" } },
    { ...hashInput, metadata: { ...draft, description: "changed" } },
    {
      ...hashInput,
      metadata: { ...draft, source: "https://example.com/source" }
    },
    {
      ...hashInput,
      metadata: { ...draft, original: "https://example.com/original.jpg" }
    },
    { ...hashInput, metadata: { ...draft, tags: [...draft.tags, "three"] } },
    { ...hashInput, storage_slug: "archive" },
    { ...hashInput, expected_size: 124 },
    { ...hashInput, max_long_edge: 457 }
  ];
  for (const changed of includedHashChanges) {
    assert.notEqual(ingestionIntentRequestHash(changed), baseIntentHash);
  }

  const semantic = {
    owner: "alice",
    queue: "upload",
    session_id: "session",
    image_id: imageId,
    accepted_at: 0,
    accepted_order: 0,
    version: 0,
    progress_seq: 0,
    last_semantic_revision: 0,
    discard_at: 0,
    status: "received",
    metadata: draft
  };
  assert.equal(
    ingestionSessionSemanticHash(semantic as never),
    ingestionSessionSemanticHash({
      ...semantic,
      accepted_at: 100,
      accepted_order: 9,
      version: 3,
      progress_seq: 7,
      last_semantic_revision: 8,
      discard_at: 999
    } as never)
  );

  assert.notEqual(
    ingestionSessionSemanticHash(semantic as never),
    ingestionSessionSemanticHash({
      ...semantic, metadata: { ...draft, theme: "none" }
    } as never)
  );
  assert.notEqual(
    ingestionSessionSemanticHash({ ...semantic, commit: { metadata: draft } } as never),
    ingestionSessionSemanticHash({
      ...semantic, commit: { metadata: { ...draft, theme: "none" } }
    } as never)
  );
  let now = 1_000;
  const tokens = new IngestionTokenService({
    rootKey: new Uint8Array(32).fill(7),
    now: () => now
  });
  const isMarker = (
    value: IngestionTokenEnvelope
  ): value is IngestionTokenEnvelope & { marker: string } => (
    value.marker === "bound"
  );
  const credentials = new Map(ingestionTokenPurposes.map((purpose) => [
    purpose,
    tokens.sign(purpose, { marker: "bound" }, 2_000, 1_000)
  ]));
  for (const purpose of ingestionTokenPurposes) {
    const credential = credentials.get(purpose)!;
    assert.equal(tokens.verify(purpose, credential, isMarker).marker, "bound");
    for (const otherPurpose of ingestionTokenPurposes) {
      if (purpose === otherPurpose) continue;
      assert.throws(() => tokens.verify(otherPurpose, credential, isMarker));
    }
  }
  const credential = credentials.get(
    "imageshow/ingestion/upload/credential"
  )!;
  assert.equal(
    tokens.sign(
      "imageshow/ingestion/action/watermark",
      { z: 1, a: 2 },
      2_000,
      1_000
    ),
    tokens.sign(
      "imageshow/ingestion/action/watermark",
      { a: 2, z: 1 },
      2_000,
      1_000
    ),
    "签名 payload 必须使用确定性字段顺序"
  );
  const isStrictMarker = (
    value: IngestionTokenEnvelope
  ): value is IngestionTokenEnvelope & { marker: string } => (
    isMarker(value)
    && Object.keys(value).sort().join(",") === [
      "expires_at",
      "issued_at",
      "marker",
      "purpose"
    ].sort().join(",")
  );
  const extraClaims = tokens.sign(
    "imageshow/ingestion/upload/credential",
    { marker: "bound", unexpected: true },
    2_000,
    1_000
  );
  assert.throws(() => tokens.verify(
    "imageshow/ingestion/upload/credential",
    extraClaims,
    isStrictMarker
  ));
  const futureIssued = tokens.sign(
    "imageshow/ingestion/upload/credential",
    { marker: "bound" },
    3_000,
    2_001
  );
  assert.throws(() => tokens.verify(
    "imageshow/ingestion/upload/credential",
    futureIssued,
    isMarker
  ));
  assert.throws(() => new IngestionTokenService({
    rootKey: new Uint8Array(32).fill(7),
    now: () => now,
    maximumPayloadBytes: 16
  }).sign(
    "imageshow/ingestion/upload/credential",
    { marker: "bound" },
    2_000,
    1_000
  ));
  const credentialBytes = Buffer.byteLength(credential, "utf8");
  assert.throws(() => new IngestionTokenService({
    rootKey: new Uint8Array(32).fill(7),
    now: () => now,
    maximumTokenBytes: credentialBytes - 1
  }).verify(
    "imageshow/ingestion/upload/credential",
    credential,
    isMarker
  ));
  assert.throws(() => tokens.verify(
    "imageshow/ingestion/upload/credential",
    `!${credential}`,
    isMarker
  ));
  assert.throws(() => tokens.verify(
    "imageshow/ingestion/upload/credential",
    credential.slice(0, -1),
    isMarker
  ));
  assert.throws(() => tokens.verify(
    "imageshow/ingestion/upload/credential",
    `${credential.slice(0, -1)}x`,
    isMarker
  ));
  now = 2_000;
  assert.throws(() => tokens.verify(
    "imageshow/ingestion/upload/credential",
    credential,
    isMarker
  ));
  assert.equal(appConfig.ingestionRuntime.uploadIntentTtlSeconds, 30 * 60);
  assert.equal(appConfig.ingestionRuntime.uploadSessionIdleTtlSeconds, 2 * 60 * 60);
  assert.equal(appConfig.ingestionRuntime.importSessionIdleTtlSeconds, 24 * 60 * 60);
  assert.equal(appConfig.ingestionRuntime.orphanCleanupIntervalSeconds, 60);
  assert.equal(appConfig.ingestionRuntime.orphanCleanupSafetySeconds, 60);
});
test("[Server/内容接入] 不可逆协调器在同一 pair 边界区分可取消与已启动事务", async () => {
  const pathPair = {
    session_id: `A${"b".repeat(42)}`,
    image_id: createImageId(new Date("2026-08-23T01:02:03.456Z"), 1)
  };
  const generation = createImageId(new Date("2026-08-23T01:02:04.456Z"), 2);
  assert.equal(ingestionRawPath("upload", pathPair, generation).includes(
    pathPair.session_id
  ), true);
  const stagingExecutionToken = createImageId(
    new Date("2026-08-23T01:02:05.456Z"),
    3
  );
  const stagingKey = ingestionStagingImageKey({
    ...pathPair,
    generation,
    execution_token: stagingExecutionToken
  });
  assert.equal(stagingKey.startsWith(`${pathPair.session_id}/`), true);
  assert.equal(uuidV7Timestamp(generation), Date.parse("2026-08-23T01:02:04.456Z"));
  const stagingIdentity = {
    session_id: pathPair.session_id,
    image_id: pathPair.image_id,
    generation,
    execution_token: stagingExecutionToken,
    kind: "image",
    created_at: Date.parse("2026-08-23T01:02:04.456Z")
  };
  assert.deepEqual(parseIngestionStagingCleanupKey(stagingKey), {
    ...stagingIdentity,
    base_key: stagingKey,
    local_atomic_candidate: false
  });
  const localCandidateKey = `${stagingKey}.candidate-${randomUUID()}`;
  assert.deepEqual(parseIngestionStagingCleanupKey(localCandidateKey), {
    ...stagingIdentity,
    base_key: stagingKey,
    local_atomic_candidate: true
  });
  assert.equal(
    parseIngestionStagingCleanupKey(`${stagingKey}.candidate-not-a-uuid`),
    null
  );
  assert.equal(parseIngestionStagingCleanupKey("malformed.image.webp"), null);

  const pair = { session_id: "session", image_id: "image" };
  const coordinator = new IngestionIrreversibleCoordinator();
  assert.equal(coordinator.registerCancellable(pair), true);
  assert.equal(coordinator.registerCancellable(pair), false);
  let releaseTransaction: () => void = () => {};
  const transactionGate = new Promise<void>((resolve) => {
    releaseTransaction = resolve;
  });
  let transactionStarted = false;
  const transaction = coordinator.beginDatabaseTransaction(
    pair,
    async () => undefined,
    async () => {
      transactionStarted = true;
      await transactionGate;
      return "committed";
    }
  );
  while (!transactionStarted) await delay(0);
  const resolving = await coordinator.cancelBoundary(
    pair,
    async () => "must-not-discard"
  );
  assert.equal(resolving.status, "resolving");
  releaseTransaction();
  assert.equal(await transaction, "committed");
  await coordinator.waitForDatabaseTransactions();

  const cancellable = new IngestionIrreversibleCoordinator();
  assert.deepEqual(await cancellable.cancelBoundary(
    pair,
    async () => "discarded"
  ), {
    status: "discarded",
    value: "discarded"
  });

  const cancelWins = new IngestionIrreversibleCoordinator();
  assert.equal(cancelWins.registerCancellable(pair), true);
  let releaseDiscard: () => void = () => {};
  const discardGate = new Promise<void>((resolve) => {
    releaseDiscard = resolve;
  });
  let discardStarted = false;
  const cancelling = cancelWins.cancelBoundary(pair, async () => {
    discardStarted = true;
    await discardGate;
    return "discarded-first";
  });
  while (!discardStarted) await delay(0);
  let lateTransactionStarted = false;
  const lateTransaction = cancelWins.beginDatabaseTransaction(
    pair,
    async () => undefined,
    async () => {
      lateTransactionStarted = true;
      return "must-not-start";
    }
  );
  releaseDiscard();
  assert.deepEqual(await cancelling, {
    status: "discarded",
    value: "discarded-first"
  });
  await assert.rejects(lateTransaction);
  assert.equal(lateTransactionStarted, false);
  assert.equal(cancelWins.state(pair), null);

  const synchronousStartFailure = new IngestionIrreversibleCoordinator();
  assert.equal(synchronousStartFailure.registerCancellable(pair), true);
  await assert.rejects(synchronousStartFailure.beginDatabaseTransaction(
    pair,
    async () => undefined,
    () => {
      throw new Error("transaction did not start");
    }
  ));
  assert.equal(synchronousStartFailure.state(pair), "cancellable");
  assert.deepEqual(await synchronousStartFailure.cancelBoundary(
    pair,
    async () => "discarded-after-start-failure"
  ), {
    status: "discarded",
    value: "discarded-after-start-failure"
  });
  assert.equal(synchronousStartFailure.state(pair), null);

  const stoppedBeforeStart = new IngestionIrreversibleCoordinator();
  const stopController = new AbortController();
  const stopReason = new Error("worker stopped at final verification");
  let stoppedTransactionStarted = false;
  assert.equal(stoppedBeforeStart.registerCancellable(pair), true);
  await assert.rejects(stoppedBeforeStart.beginDatabaseTransaction(
    pair,
    async () => {
      queueMicrotask(() => stopController.abort(stopReason));
    },
    async () => {
      stoppedTransactionStarted = true;
    },
    stopController.signal
  ), (error) => error === stopReason);
  assert.equal(stoppedTransactionStarted, false);
  assert.equal(stoppedBeforeStart.state(pair), "cancellable");
  stoppedBeforeStart.unregisterCancellable(pair);

  const draining = new IngestionIrreversibleCoordinator();
  const firstPair = { session_id: "drain-a", image_id: "image-a" };
  const secondPair = { session_id: "drain-b", image_id: "image-b" };
  assert.equal(draining.registerCancellable(firstPair), true);
  assert.equal(draining.registerCancellable(secondPair), true);
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted = false;
  const firstTransaction = draining.beginDatabaseTransaction(
    firstPair,
    async () => undefined,
    async () => {
      firstStarted = true;
      await firstGate;
    }
  );
  while (!firstStarted) await delay(0);
  let drainSettled = false;
  const drain = draining.waitForDatabaseTransactions().then(() => {
    drainSettled = true;
  });
  let releaseSecond: () => void = () => {};
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  let secondStarted = false;
  const secondTransaction = draining.beginDatabaseTransaction(
    secondPair,
    async () => undefined,
    async () => {
      secondStarted = true;
      await secondGate;
    }
  );
  while (!secondStarted) await delay(0);
  releaseFirst();
  await firstTransaction;
  await delay(0);
  assert.equal(
    drainSettled,
    false,
    "drain 必须继续等待首次快照之后进入 database_started 的事务"
  );
  releaseSecond();
  await Promise.all([secondTransaction, drain]);
  assert.equal(drainSettled, true);
});
test("[Server/内容接入] Ingestion Worker 跨页保持 Import queued 与 received 的 FIFO 调度", () => {
  const importSession = (
    position: number,
    status: "queued" | "received"
  ): IngestionSessionSnapshot => ({
    session_id: `import-session-${position}`,
    image_id: `import-image-${position}`,
    owner: "fifo-owner",
    queue: "import",
    status
  }) as unknown as IngestionSessionSnapshot;
  const queued = Array.from(
    { length: 3 },
    (_, index) => importSession(index, "queued")
  );
  const recovered = importSession(3, "received");
  const recoveredUpload = {
    ...importSession(4, "received"),
    session_id: "upload-session-4",
    image_id: "upload-image-4",
    queue: "upload"
  } as unknown as IngestionSessionSnapshot;

  const firstPage = planIngestionWorkerLanes(queued, []);
  assert.deepEqual(
    firstPage.candidates.map(({ session }) => session.session_id),
    queued.slice(0, 2).map((session) => session.session_id)
  );
  assert.equal(firstPage.blockedLanes.has("import"), true);

  const activeAfterOneSettled = firstPage.candidates.slice(1).map((item) => ({
    pair: item.session,
    lane: item.lane
  }));
  const laterPage = planIngestionWorkerLanes(
    [recovered, recoveredUpload],
    activeAfterOneSettled,
    firstPage.blockedLanes
  );
  assert.deepEqual(
    laterPage.candidates.map(({ session }) => session.session_id),
    [recoveredUpload.session_id],
    "同一 frozen-tail pass 的后页 received 不得越过先前被窗口挡住的 queued"
  );

  const nextPass = planIngestionWorkerLanes(
    [queued[2], recovered],
    activeAfterOneSettled
  );
  assert.deepEqual(
    nextPass.candidates.map(({ session }) => session.session_id),
    [queued[2].session_id]
  );
});
test("[Server/内容接入] Ingestion Commit dispatch window 由公开并发派生且不会忽略等待许可的项", () => {
  assert.equal(ingestionCommitDispatchWindow(1), 2);
  assert.equal(ingestionCommitDispatchWindow(8), 12);
  assert.equal(ingestionCommitDispatchWindow(16), 24);

  const committing = Array.from({ length: 40 }, (_, index) => ({
    session_id: `commit-session-${index}`,
    image_id: `commit-image-${index}`,
    owner: "commit-lane-owner",
    queue: index % 2 ? "upload" : "import",
    status: "committing"
  })) as never[];
  const windows = ingestionWorkerDispatchWindows(2, 16);
  const first = planIngestionWorkerLanes(
    committing,
    [],
    new Set(),
    windows
  );
  assert.equal(first.candidates.length, 24);
  assert.equal(first.blockedLanes.has("commit"), true);

  const active = first.candidates.slice(0, 20).map((item) => ({
    pair: item.session,
    lane: item.lane
  }));
  const refill = planIngestionWorkerLanes(
    committing.slice(20),
    active,
    new Set(),
    windows
  );
  assert.equal(
    refill.candidates.length,
    4,
    "等待数量或字节许可的 coordinator 仍占用候补窗口"
  );
});
test("[Server/内容接入] Ingestion pre-commit dispatch slot 由 Normalize 派生且交接后不重复领取活动 pair", () => {
  assert.deepEqual(ingestionWorkerDispatchWindows(1, 8), {
    import: 1,
    upload: 1,
    commit: 12
  });
  assert.deepEqual(ingestionWorkerDispatchWindows(8, 8), {
    import: 8,
    upload: 8,
    commit: 12
  });

  const normalizing = {
    session_id: "normalizing-import",
    image_id: "normalizing-image",
    owner: "prepare-window-owner",
    queue: "import",
    status: "received"
  } as unknown as IngestionSessionSnapshot;
  const successor = {
    ...normalizing,
    session_id: "successor-import",
    image_id: "successor-image",
    status: "queued"
  } as IngestionSessionSnapshot;
  const plan = planIngestionWorkerLanes(
    [normalizing, successor],
    [{
      pair: normalizing,
      lane: "import",
      dispatchSlotHeld: false
    }],
    new Set(),
    ingestionWorkerDispatchWindows(1, 8)
  );
  assert.deepEqual(
    plan.candidates.map(({ session }) => session.session_id),
    [successor.session_id]
  );
});
test("[Server/内容接入] Upload 与 Import 共用唯一 Prepare/Publish owner 并保留一批 Import 后继", async (t) => {
  initializeRuntimeConfig();
  const limit = getRuntimeConfig().normalize.concurrency;
  const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
  const waitFor = async (predicate: () => boolean, message: string) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      await nextTurn();
    }
    assert.fail(message);
  };

  await t.test("两种来源合计最多持有 N 个 prepare / staging publication", async (subtest) => {
    const itemCount = limit + 2;
    const gates = Array.from({ length: itemCount }, () => deferredPromise<void>());
    const sources = Array.from(
      { length: itemCount },
      (_, index) => index % 2 ? "import" : "upload"
    );
    const starts: number[] = [];
    let active = 0;
    let maxActive = 0;
    subtest.after(() => gates.forEach((gate) => gate.resolve()));
    const runs = gates.map((gate, index) => withIngestionPreparationAdmission(
      new AbortController().signal,
      async () => {
        starts.push(index);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await gate.promise;
          return sources[index];
        } finally {
          active -= 1;
        }
      }
    ));

    await waitFor(
      () => starts.length === limit,
      "shared Ingestion preparation capacity did not fill"
    );
    assert.equal(active, limit);
    assert.equal(maxActive, limit);
    assert.deepEqual(starts, Array.from({ length: limit }, (_, index) => index));

    gates[0].resolve();
    await waitFor(
      () => starts.length === limit + 1,
      "Upload / Import did not share the released preparation permit"
    );
    assert.equal(active, limit);
    assert.equal(maxActive, limit);

    gates.forEach((gate) => gate.resolve());
    const outcomes = await Promise.all(runs);
    assert.deepEqual(outcomes, sources);
    assert.equal(new Set(outcomes).size, 2);
    assert.equal(active, 0);
    assert.deepEqual(ingestionPreparationAdmissionSnapshot(), {
      limit,
      active: 0,
      waiting: 0
    });
  });

  await t.test("当前 prepare 与磁盘 raw 后继各自最多一批", async (subtest) => {
    const itemCount = limit * 2 + 1;
    const gates = Array.from({ length: itemCount }, () => deferredPromise<void>());
    const materializationStarts: number[] = [];
    const preparationStarts: number[] = [];
    let activePreparations = 0;
    let maxActivePreparations = 0;
    subtest.after(() => gates.forEach((gate) => gate.resolve()));

    const runs = gates.map((gate, index) => withImportPrefetchAdmission(
      new AbortController().signal,
      async (onNormalizationAdmitted) => {
        materializationStarts.push(index);
        return withIngestionPreparationAdmission(
          new AbortController().signal,
          async () => {
            preparationStarts.push(index);
            activePreparations += 1;
            maxActivePreparations = Math.max(
              maxActivePreparations,
              activePreparations
            );
            onNormalizationAdmitted();
            try {
              await gate.promise;
            } finally {
              activePreparations -= 1;
            }
          }
        );
      }
    ));

    await waitFor(
      () => materializationStarts.length === limit * 2,
      "Import did not fill the current and successor batches"
    );
    assert.equal(preparationStarts.length, limit);
    assert.equal(activePreparations, limit);
    assert.equal(maxActivePreparations, limit);
    assert.equal(
      materializationStarts.includes(itemCount - 1),
      false,
      "a third Import batch started before preparation capacity was released"
    );

    gates[0].resolve();
    await waitFor(
      () => preparationStarts.length === limit + 1,
      "prepared publication completion did not admit the first successor"
    );
    await waitFor(
      () => materializationStarts.length === itemCount,
      "successor normalization admission did not refill Import materialization"
    );
    assert.equal(activePreparations, limit);
    assert.equal(maxActivePreparations, limit);

    gates.forEach((gate) => gate.resolve());
    await Promise.all(runs);
    assert.equal(activePreparations, 0);
    assert.equal(maxActivePreparations, limit);
    assert.equal(ingestionPreparationAdmissionSnapshot().active, 0);
    assert.equal(ingestionPreparationAdmissionSnapshot().waiting, 0);
  });

  await t.test("取消等待项不会进入图片处理或 staging publication", async (subtest) => {
    const gates = Array.from({ length: limit }, () => deferredPromise<void>());
    subtest.after(() => gates.forEach((gate) => gate.resolve()));
    const active = gates.map((gate) => withIngestionPreparationAdmission(
      new AbortController().signal,
      () => gate.promise
    ));
    await nextTurn();

    const controller = new AbortController();
    const cancellation = new Error("cancel waiting Ingestion preparation");
    let started = false;
    const waiting = withIngestionPreparationAdmission(
      controller.signal,
      async () => {
        started = true;
      }
    );
    await nextTurn();
    assert.equal(started, false);
    controller.abort(cancellation);
    await assert.rejects(waiting, (error) => error === cancellation);

    gates.forEach((gate) => gate.resolve());
    await Promise.all(active);
    assert.equal(started, false);
    assert.equal(ingestionPreparationAdmissionSnapshot().active, 0);
    assert.equal(ingestionPreparationAdmissionSnapshot().waiting, 0);
  });

  await t.test("热加载提额立即补位且降额自然排空", async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    const helperRoot = await createTestDirectory("imageshow-preparation-admission-");
    const helperPath = join(helperRoot, "verify-preparation-admission.mjs");
    const runtimeConfigStoreUrl = pathToFileURL(resolve(
      repositoryRoot,
      "packages/server/src/config/runtime-config-store.ts"
    )).href;
    const preparationAdmissionUrl = pathToFileURL(resolve(
      repositoryRoot,
      "packages/server/src/images/ingestion/workers/preparation-admission.ts"
    )).href;
    const helperSource = `
import assert from "node:assert/strict";
import {
  initializeRuntimeConfig,
  updateRuntimeConfig
} from ${JSON.stringify(runtimeConfigStoreUrl)};
import {
  withIngestionPreparationAdmission
} from ${JSON.stringify(preparationAdmissionUrl)};

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  throw new Error(message);
};

assert.equal(initializeRuntimeConfig().normalize.concurrency, 1);
const gates = [deferred(), deferred(), deferred()];
const starts = [];
const runs = gates.map((gate, index) => withIngestionPreparationAdmission(
  new AbortController().signal,
  async () => {
    starts.push(index);
    await gate.promise;
  }
));
await waitFor(() => starts.length === 1, "initial preparation permit did not start");
await updateRuntimeConfig({ normalize: { concurrency: 2 } });
await waitFor(() => starts.length === 2, "raised preparation capacity did not fill");
await updateRuntimeConfig({ normalize: { concurrency: 1 } });
gates[0].resolve();
await runs[0];
await nextTurn();
assert.deepEqual(starts, [0, 1]);
gates[1].resolve();
await waitFor(() => starts.length === 3, "lowered preparation capacity never resumed");
gates[2].resolve();
await Promise.all(runs);
console.log("preparation-admission-reload-ok");
`;
    try {
      await writeFile(helperPath, helperSource);
      const result = await runProcess(process.execPath, [
        resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs"),
        helperPath
      ], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          NODE_ENV: "development",
          IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY: toNamespacedPath(join(helperRoot, "data")),
          NORMALIZE_CONCURRENCY: "1"
        },
        timeoutMs: 30_000
      });
      assert.match(result.stdout, /preparation-admission-reload-ok/);
    } finally {
      await rm(helperRoot, { recursive: true, force: true });
    }
  });
});
test("[Server/内容接入] Import 后继窗口在 Normalize 准入时交接并完整释放许可", async (t) => {
  initializeRuntimeConfig();
  const limit = getRuntimeConfig().normalize.concurrency;
  const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
  const waitFor = async (predicate: () => boolean, message: string) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      await nextTurn();
    }
    assert.fail(message);
  };

  await t.test("仅预取一批并在图片处理许可交接后立即补位", async (subtest) => {
    const gates = Array.from({ length: limit + 1 }, () => deferredPromise<void>());
    const starts: number[] = [];
    const markNormalizationAdmitted: Array<(() => void) | undefined> = [];
    subtest.after(() => gates.forEach((gate) => gate.resolve()));
    const runs = gates.map((gate, index) => withImportPrefetchAdmission(
      new AbortController().signal,
      async (onNormalizationAdmitted) => {
        starts.push(index);
        markNormalizationAdmitted[index] = onNormalizationAdmitted;
        await gate.promise;
        return index;
      }
    ));
    await waitFor(
      () => starts.length === limit,
      "Import successor window did not fill"
    );
    assert.deepEqual(starts, Array.from({ length: limit }, (_, index) => index));

    let firstSettled = false;
    void runs[0].finally(() => {
      firstSettled = true;
    });
    markNormalizationAdmitted[0]?.();
    await waitFor(
      () => starts.length === limit + 1,
      "Normalize admission did not release the next Import successor"
    );
    await nextTurn();
    assert.equal(firstSettled, false);

    gates.forEach((gate) => gate.resolve());
    assert.deepEqual(
      await Promise.all(runs),
      Array.from({ length: limit + 1 }, (_, index) => index)
    );
  });

  await t.test("处理许可交接前后的失败都向调用方传播并释放窗口", async () => {
    const beforeAdmission = new Error("download failed before Normalize");
    await assert.rejects(
      withImportPrefetchAdmission(
        new AbortController().signal,
        async () => { throw beforeAdmission; }
      ),
      (error) => error === beforeAdmission
    );

    const afterAdmission = new Error("prepare failed after Normalize admission");
    await assert.rejects(
      withImportPrefetchAdmission(
        new AbortController().signal,
        async (onNormalizationAdmitted) => {
          onNormalizationAdmitted();
          await nextTurn();
          throw afterAdmission;
        }
      ),
      (error) => error === afterAdmission
    );
    assert.equal(
      await withImportPrefetchAdmission(
        new AbortController().signal,
        async () => "released"
      ),
      "released"
    );
  });

  await t.test("取消等待项不会启动远程素材化", async (subtest) => {
    const gates = Array.from({ length: limit }, () => deferredPromise<void>());
    const starts: number[] = [];
    subtest.after(() => gates.forEach((gate) => gate.resolve()));
    const active = gates.map((gate, index) => withImportPrefetchAdmission(
      new AbortController().signal,
      async () => {
        starts.push(index);
        await gate.promise;
      }
    ));
    await waitFor(() => starts.length === limit, "Import window did not fill");

    const waitingController = new AbortController();
    const cancellation = new Error("cancel waiting Import successor");
    let waitingStarted = false;
    const waiting = withImportPrefetchAdmission(
      waitingController.signal,
      async () => {
        waitingStarted = true;
      }
    );
    await nextTurn();
    assert.equal(waitingStarted, false);
    waitingController.abort(cancellation);
    await assert.rejects(waiting, (error) => error === cancellation);

    gates.forEach((gate) => gate.resolve());
    await Promise.all(active);
    assert.equal(waitingStarted, false);
  });

  await t.test("RuntimeConfig 提额立即补位且降额等待活动项排空", async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    const helperRoot = await createTestDirectory("imageshow-import-prefetch-");
    const helperPath = join(helperRoot, "verify-import-prefetch.mjs");
    const runtimeConfigStoreUrl = pathToFileURL(resolve(
      repositoryRoot,
      "packages/server/src/config/runtime-config-store.ts"
    )).href;
    const importPrefetchUrl = pathToFileURL(resolve(
      repositoryRoot,
      "packages/server/src/images/ingestion/workers/import-prefetch.ts"
    )).href;
    const helperSource = `
import assert from "node:assert/strict";
import {
  initializeRuntimeConfig,
  onRuntimeConfigChange,
  updateRuntimeConfig
} from ${JSON.stringify(runtimeConfigStoreUrl)};
import { withImportPrefetchAdmission } from ${JSON.stringify(importPrefetchUrl)};

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  throw new Error(message);
};

assert.equal(initializeRuntimeConfig().normalize.concurrency, 1);
let configNotifications = 0;
const removeConfigListener = onRuntimeConfigChange(() => {
  configNotifications += 1;
});
const gates = [deferred(), deferred(), deferred()];
const starts = [];
const runs = gates.map((gate, index) => withImportPrefetchAdmission(
  new AbortController().signal,
  async () => {
    starts.push(index);
    await gate.promise;
  }
));
await waitFor(() => starts.length === 1, "initial Import permit did not start");
await updateRuntimeConfig({ normalize: { concurrency: 2 } });
assert.equal(configNotifications, 1);
await waitFor(() => starts.length === 2, "raised Import window did not fill");
removeConfigListener();
await updateRuntimeConfig({ normalize: { concurrency: 1 } });
assert.equal(configNotifications, 1, "removed RuntimeConfig listener was notified");
gates[0].resolve();
await runs[0];
await nextTurn();
assert.deepEqual(starts, [0, 1]);
gates[1].resolve();
await waitFor(() => starts.length === 3, "lowered Import window never resumed");
gates[2].resolve();
await Promise.all(runs);
console.log("import-prefetch-reload-ok");
`;
    try {
      await writeFile(helperPath, helperSource);
      const result = await runProcess(process.execPath, [
        resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs"),
        helperPath
      ], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          NODE_ENV: "development",
          IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY: toNamespacedPath(join(helperRoot, "data")),
          NORMALIZE_CONCURRENCY: "1"
        },
        timeoutMs: 30_000
      });
      assert.match(result.stdout, /import-prefetch-reload-ok/);
    } finally {
      await rm(helperRoot, { recursive: true, force: true });
    }
  });
});
test("[Server/内容接入] 动态数量与加权许可器保持 FIFO、热重载和取消释放语义", async (t) => {
  type Gate = ReturnType<typeof deferredPromise<void>>;
  const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
  const waitFor = async (predicate: () => boolean, message: string) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      await nextTurn();
    }
    assert.fail(message);
  };
  const cancellationError = (signal: AbortSignal) => (
    signal.reason ?? new Error("cancelled")
  );

  await t.test("数量许可不让新请求越过队列并在提额通知后补位", async (subtest) => {
    let limit = 1;
    const limiter = new DynamicConcurrencyLimiter(() => limit, cancellationError);
    const releases = [
      deferredPromise<void>(),
      deferredPromise<void>(),
      deferredPromise<void>()
    ];
    const starts: string[] = [];
    subtest.after(() => releases.forEach((release) => release.resolve()));
    const run = (name: string, release: Gate) => limiter.run(
      new AbortController().signal,
      async () => {
        starts.push(name);
        await release.promise;
      }
    );
    const first = run("first", releases[0]);
    await waitFor(() => starts.length === 1, "first permit did not start");
    const second = run("second", releases[1]);
    await nextTurn();
    limit = 2;
    const third = run("third", releases[2]);
    await nextTurn();
    assert.deepEqual(starts, ["first"]);
    assert.deepEqual(limiter.snapshot(), {
      limit: 2,
      active: 1,
      waiting: 2
    });
    limiter.refresh();
    await waitFor(() => starts.length === 2, "raised limit did not drain FIFO head");
    assert.deepEqual(starts, ["first", "second"]);
    assert.deepEqual(limiter.snapshot(), {
      limit: 2,
      active: 2,
      waiting: 1
    });
    releases[0].resolve();
    await waitFor(() => starts.length === 3, "third permit did not start");
    assert.deepEqual(starts, ["first", "second", "third"]);
    releases[1].resolve();
    releases[2].resolve();
    await Promise.all([first, second, third]);
    assert.deepEqual(limiter.snapshot(), {
      limit: 2,
      active: 0,
      waiting: 0
    });
  });

  await t.test("数量许可降额保留活动项并按 FIFO 恢复", async (subtest) => {
    let limit = 2;
    const limiter = new DynamicConcurrencyLimiter(() => limit, cancellationError);
    const releases = [
      deferredPromise<void>(),
      deferredPromise<void>(),
      deferredPromise<void>()
    ];
    const starts: number[] = [];
    subtest.after(() => releases.forEach((release) => release.resolve()));
    const runs = releases.map((release, index) => limiter.run(
      new AbortController().signal,
      async () => {
        starts.push(index);
        await release.promise;
      }
    ));
    await waitFor(() => starts.length === 2, "initial permits were not filled");
    limit = 1;
    limiter.refresh();
    releases[0].resolve();
    await runs[0];
    await nextTurn();
    assert.deepEqual(starts, [0, 1]);
    releases[1].resolve();
    await waitFor(() => starts.length === 3, "lowered limiter never resumed");
    releases[2].resolve();
    await Promise.all(runs);
  });

  await t.test("等待与交接取消、活动异常和启动 hook 异常均释放数量许可", async (subtest) => {
    const limiter = new DynamicConcurrencyLimiter(() => 1, cancellationError);
    const firstRelease = deferredPromise<void>();
    const waitingController = new AbortController();
    const handoffError = new Error("cancelled at permit handoff");
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
    const first = limiter.run(new AbortController().signal, async () => {
      starts.push("first");
      await firstRelease.promise;
    });
    const waiting = limiter.run(waitingController.signal, async () => {
      starts.push("cancelled-waiter");
    });
    const handoff = limiter.run(handoffSignal, async () => {
      starts.push("cancelled-handoff");
    });
    await waitFor(() => starts.length === 1, "first permit did not start");
    const waitingError = new Error("waiting cancelled");
    waitingController.abort(waitingError);
    await assert.rejects(waiting, (error) => error === waitingError);
    firstRelease.resolve();
    await first;
    await assert.rejects(handoff, (error) => error === handoffError);
    assert.deepEqual(starts, ["first"]);

    const workError = new Error("work failed");
    await assert.rejects(
      limiter.run(new AbortController().signal, async () => {
        throw workError;
      }),
      (error) => error === workError
    );
    const hookError = new Error("start hook failed");
    let hookWorkStarted = false;
    await assert.rejects(
      limiter.run(
        new AbortController().signal,
        async () => {
          hookWorkStarted = true;
        },
        { onStarted: () => { throw hookError; } }
      ),
      (error) => error === hookError
    );
    assert.equal(hookWorkStarted, false);
    assert.equal(
      await limiter.run(new AbortController().signal, async () => "released"),
      "released"
    );
  });

  await t.test("活动取消释放数量许可", async () => {
    const limiter = new DynamicConcurrencyLimiter(() => 1, cancellationError);
    const controller = new AbortController();
    const started = deferredPromise<void>();
    const cancellation = new Error("active cancelled");
    const active = limiter.run(controller.signal, async () => {
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason),
          { once: true }
        );
      });
    });
    await started.promise;
    controller.abort(cancellation);
    await assert.rejects(active, (error) => error === cancellation);
    await limiter.run(new AbortController().signal, async () => undefined);
  });

  await t.test("加权许可让超预算队首独占并在提额后保持 FIFO", async (subtest) => {
    let limit = 3;
    const limiter = new DynamicWeightedLimiter(() => limit, cancellationError);
    const releases = [
      deferredPromise<void>(),
      deferredPromise<void>(),
      deferredPromise<void>()
    ];
    const starts: string[] = [];
    subtest.after(() => releases.forEach((release) => release.resolve()));
    const oversized = limiter.run(5, new AbortController().signal, async () => {
      starts.push("oversized");
      await releases[0].promise;
    });
    const second = limiter.run(2, new AbortController().signal, async () => {
      starts.push("second");
      await releases[1].promise;
    });
    const third = limiter.run(1, new AbortController().signal, async () => {
      starts.push("third");
      await releases[2].promise;
    });
    await waitFor(() => starts.length === 1, "oversized head did not start alone");
    assert.deepEqual(starts, ["oversized"]);
    assert.deepEqual(limiter.snapshot(), {
      limit: 3,
      activeWeight: 5,
      waiting: 2,
      waitingWeight: 3
    });
    limit = 7;
    limiter.refresh();
    await waitFor(() => starts.length === 2, "weighted raise did not start FIFO head");
    assert.deepEqual(starts, ["oversized", "second"]);
    assert.deepEqual(limiter.snapshot(), {
      limit: 7,
      activeWeight: 7,
      waiting: 1,
      waitingWeight: 1
    });
    await nextTurn();
    assert.deepEqual(starts, ["oversized", "second"]);
    releases[0].resolve();
    await waitFor(() => starts.length === 3, "weighted queue did not continue");
    releases[1].resolve();
    releases[2].resolve();
    await Promise.all([oversized, second, third]);
    assert.deepEqual(limiter.snapshot(), {
      limit: 7,
      activeWeight: 0,
      waiting: 0,
      waitingWeight: 0
    });
  });

  await t.test("加权许可处理等待取消、交接取消和异常释放", async (subtest) => {
    const limiter = new DynamicWeightedLimiter(() => 2, cancellationError);
    const firstRelease = deferredPromise<void>();
    const waitingController = new AbortController();
    const handoffError = new Error("weighted handoff cancelled");
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
    subtest.after(() => firstRelease.resolve());
    const first = limiter.run(2, new AbortController().signal, async () => {
      await firstRelease.promise;
    });
    const waiting = limiter.run(1, waitingController.signal, async () => undefined);
    const handoff = limiter.run(2, handoffSignal, async () => {
      assert.fail("cancelled weighted handoff must not start");
    });
    await nextTurn();
    const waitingError = new Error("weighted waiting cancelled");
    waitingController.abort(waitingError);
    await assert.rejects(waiting, (error) => error === waitingError);
    firstRelease.resolve();
    await first;
    await assert.rejects(handoff, (error) => error === handoffError);
    const workError = new Error("weighted work failed");
    await assert.rejects(
      limiter.run(2, new AbortController().signal, async () => {
        throw workError;
      }),
      (error) => error === workError
    );
    await limiter.run(2, new AbortController().signal, async () => undefined);
  });
});
test("[Server/内容接入] 微博上游调度保持串行、公平、随机节奏与单一访客身份", async (t) => {
  const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
  const waitFor = async (predicate: () => boolean, message: string) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      await nextTurn();
    }
    assert.fail(message);
  };
  const schedulerWithoutDelay = (
    createVisitorIdentity:
      (signal: AbortSignal) => Promise<string> = async () => "visitor"
  ) => createWeiboRequestScheduler({
    createVisitorIdentity,
    delayRange: () => ({ minDelaySeconds: 0, maxDelaySeconds: 0 })
  });

  await t.test("多个批次固定串行并逐项轮转", async (subtest) => {
    const scheduler = schedulerWithoutDelay();
    const firstRelease = deferredPromise<void>();
    const order: string[] = [];
    let active = 0;
    let maximumActive = 0;
    subtest.after(() => firstRelease.resolve());
    const request = (name: string, hold = false) => async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(name);
      if (hold) await firstRelease.promise;
      active -= 1;
      return name;
    };
    const first = scheduler.scheduleBatch([
      request("a1", true),
      request("a2"),
      request("a3")
    ]);
    await waitFor(() => order.length === 1, "first Weibo request did not start");
    const second = scheduler.scheduleBatch([request("b1"), request("b2")]);
    firstRelease.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["a1", "b1", "a2", "b2", "a3"]);
    assert.equal(maximumActive, 1);
  });

  await t.test("访客握手完整串行并由后续批次复用", async () => {
    const order: string[] = [];
    let creations = 0;
    const scheduler = schedulerWithoutDelay(async () => {
      creations += 1;
      order.push("handshake-1");
      await nextTurn();
      order.push("handshake-2");
      return "visitor";
    });
    const first = scheduler.scheduleBatch([
      async () => { order.push("post-a"); }
    ]);
    const second = scheduler.scheduleBatch([
      async () => { order.push("post-b"); }
    ]);
    await Promise.all([first, second]);
    assert.equal(creations, 1);
    assert.deepEqual(order, [
      "handshake-1",
      "handshake-2",
      "post-a",
      "post-b"
    ]);
  });

  await t.test("每个相邻请求按开始等待时的当前区间采样", async () => {
    let now = 0;
    let range = { minDelaySeconds: 2, maxDelaySeconds: 4 };
    const waits: number[] = [];
    const scheduler = createWeiboRequestScheduler({
      createVisitorIdentity: async () => "visitor",
      delayRange: () => range,
      random: () => 0.25,
      now: () => now,
      wait: async (delayMs) => {
        waits.push(delayMs);
        if (waits.length === 1) {
          range = { minDelaySeconds: 5, maxDelaySeconds: 5 };
        }
        now += delayMs;
      }
    });
    const request = async () => { now += 100; };
    await scheduler.scheduleBatch([request, request, request]);
    assert.deepEqual(waits, [2_500, 5_000]);
  });

  await t.test("排队、延迟等待和活动请求取消均不启动后续项", async (subtest) => {
    const waitStarted = deferredPromise<void>();
    const releaseWait = deferredPromise<void>();
    const controller = new AbortController();
    const cancellation = new Error("cancelled during delayed wait");
    let starts = 0;
    const scheduler = createWeiboRequestScheduler({
      createVisitorIdentity: async () => "visitor",
      delayRange: () => ({ minDelaySeconds: 2, maxDelaySeconds: 2 }),
      now: () => 0,
      wait: async () => {
        waitStarted.resolve();
        await releaseWait.promise;
      }
    });
    subtest.after(() => releaseWait.resolve());
    const batch = scheduler.scheduleBatch([
      async () => { starts += 1; },
      async () => { starts += 1; }
    ], controller.signal);
    await waitStarted.promise;
    const rejected = assert.rejects(batch, (error) => error === cancellation);
    controller.abort(cancellation);
    await rejected;
    releaseWait.resolve();
    await nextTurn();
    await nextTurn();
    assert.equal(starts, 1);

    const activeScheduler = schedulerWithoutDelay();
    const activeController = new AbortController();
    const activeCancellation = new Error("cancelled while active");
    let activeStarted = false;
    let activeObservedAbort = false;
    const active = activeScheduler.scheduleBatch([
      async (_identity, signal) => {
        activeStarted = true;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            activeObservedAbort = true;
            reject(signal.reason);
          }, { once: true });
        });
      },
      async () => assert.fail("cancelled batch must not start another request")
    ], activeController.signal);
    await waitFor(() => activeStarted, "active Weibo request did not start");
    const activeRejected = assert.rejects(
      active,
      (error) => error === activeCancellation
    );
    const next = activeScheduler.scheduleBatch([async () => "next"]);
    activeController.abort(activeCancellation);
    await activeRejected;
    assert.deepEqual(await next, [{ status: "fulfilled", value: "next" }]);
    assert.equal(activeObservedAbort, true);
  });

  await t.test("取消访客创建先收口旧握手再让下一批创建", async (subtest) => {
    const firstIdentitySettled = deferredPromise<void>();
    const firstController = new AbortController();
    const cancellation = new Error("cancelled during visitor creation");
    let creations = 0;
    let activeCreations = 0;
    let maximumActiveCreations = 0;
    const scheduler = schedulerWithoutDelay(async (signal) => {
      creations += 1;
      const identityNumber = creations;
      activeCreations += 1;
      maximumActiveCreations = Math.max(maximumActiveCreations, activeCreations);
      try {
        if (identityNumber === 1) {
          await firstIdentitySettled.promise;
          signal.throwIfAborted();
        }
        return `visitor-${identityNumber}`;
      } finally {
        activeCreations -= 1;
      }
    });
    subtest.after(() => firstIdentitySettled.resolve());
    const first = scheduler.scheduleBatch([
      async () => assert.fail("cancelled batch must not start a post request")
    ], firstController.signal);
    await waitFor(() => creations === 1, "visitor creation did not start");
    const next = scheduler.scheduleBatch([async (identity) => identity]);
    const firstRejected = assert.rejects(first, (error) => error === cancellation);
    firstController.abort(cancellation);
    await firstRejected;
    firstIdentitySettled.resolve();
    assert.deepEqual(await next, [{ status: "fulfilled", value: "visitor-2" }]);
    assert.equal(creations, 2);
    assert.equal(maximumActiveCreations, 1);
  });

  await t.test("身份拒绝只影响当前帖子并在下一项重建", async () => {
    let creations = 0;
    let attempts = 0;
    const scheduler = schedulerWithoutDelay(async () => (
      `visitor-${creations += 1}`
    ));
    const results = await scheduler.scheduleBatch([
      async (identity) => {
        attempts += 1;
        assert.equal(identity, "visitor-1");
        throw new WeiboImportError("weibo_visitor_rejected", "rejected");
      },
      async (identity) => {
        attempts += 1;
        return identity;
      }
    ]);
    assert.equal(results[0]?.status, "rejected");
    assert.deepEqual(results[1], { status: "fulfilled", value: "visitor-2" });
    assert.equal(attempts, 2);
    assert.equal(creations, 2);

    const limitError = new WeiboImportError(
      "weibo_image_limit_exceeded",
      "too many images"
    );
    let afterLimitStarted = false;
    await assert.rejects(
      scheduler.scheduleBatch([
        async () => { throw limitError; },
        async () => { afterLimitStarted = true; }
      ]),
      (error) => error === limitError
    );
    assert.equal(afterLimitStarted, false);

    const fatalError = new Error("unexpected scheduler failure");
    let afterFatalStarted = false;
    await assert.rejects(
      scheduler.scheduleBatch([
        async () => { throw fatalError; },
        async () => { afterFatalStarted = true; }
      ]),
      (error) => error === fatalError
    );
    assert.equal(afterFatalStarted, false);
  });
});
test("[Server/内容接入] 下载进度写入失败会立即被观察并中止正文传输", async () => {
  const owner = "download-progress-owner";
  const progressFailure = new Error("progress Redis write failed");
  const downloadFailure = new Error("download stopped after progress failure");
  const session = {
    owner,
    queue: "import",
    source_type: "url",
    session_id: createIngestionSessionId(owner, "import", "progress-failure"),
    image_id: createImageId(new Date("2026-08-23T01:00:00.000Z"), 1),
    status: "downloading",
    execution_token: "0198c080-0000-7000-8000-000000000001",
    version: 2,
    import_download: { url: "https://example.com/slow-image.jpg" }
  } as const;
  let fetchObservedAbort = false;

  await assert.rejects(
    downloadIngestionSessionSnapshot(
      {
        updateProgress: async () => {
          throw progressFailure;
        },
        heartbeat: async () => undefined
      } as never,
      session as never,
      new AbortController().signal,
      {
        now: () => 1_000,
        fetchImageToFile: async (
          _url,
          _target,
          _part,
          limit,
          signal,
          onProgress
        ) => {
          assert.equal(limit, 100 * 1024 * 1024);
          onProgress?.(10);
          await delay(0);
          fetchObservedAbort = signal?.aborted === true;
          throw downloadFailure;
        }
      }
    ),
    (error) => error === progressFailure
  );
  assert.equal(fetchObservedAbort, true);
});
test("[Server/内容接入] 同一 execution 可接力草稿版本且身份变化仍会围栏", async () => {
  const owner = "execution-relay-owner";
  const staleExecution = {
    owner,
    queue: "import",
    source_type: "url",
    session_id: createIngestionSessionId(owner, "import", "metadata-relay"),
    image_id: createImageId(new Date("2026-08-23T01:00:01.000Z"), 2),
    image_time: "2026-08-23T01:00:01.000Z",
    request_hash: "a".repeat(64),
    import_download: { url: "https://example.com/metadata-relay.jpg" },
    metadata: {
      device: "auto",
      brightness: "auto",
      theme: null,
      author: "",
      title: "before edit",
      description: "",
      source: "",
      original: "",
      tags: []
    },
    storage_slug: "local",
    status: "downloading",
    phase: "downloading",
    message: "downloading",
    progress: 0,
    version: 2,
    progress_seq: 0,
    last_semantic_revision: 2,
    accepted_at: 1,
    accepted_order: 1,
    execution_token: "0198c080-0000-7000-8000-000000000002",
    raw_generation: "",
    raw_size: 0,
    discard_at: Date.now() + 60_000,
    semantic_hash: "b".repeat(64)
  } as const;
  let canonical: any = { ...staleExecution };
  const assertCurrentExecution = (
    current: { execution_token: string },
    expectedVersion: number
  ) => {
    if (expectedVersion !== canonical.version) {
      throw new ApiError(409, "ingestion_version_conflict", "version changed");
    }
    if (current.execution_token !== canonical.execution_token) {
      throw new ApiError(409, "ingestion_execution_fenced", "token changed");
    }
  };
  const repository = {
    readSession: async () => canonical,
    updateProgress: async (
      current: { execution_token: string },
      expectedVersion: number,
      progress: Record<string, unknown>
    ) => {
      assertCurrentExecution(current, expectedVersion);
      canonical = {
        ...canonical,
        ...progress,
        progress_seq: Number(canonical.progress_seq) + 1
      };
      return { session: canonical };
    },
    heartbeat: async (
      current: { execution_token: string },
      expectedVersion: number
    ) => {
      assertCurrentExecution(current, expectedVersion);
      canonical = { ...canonical, discard_at: Date.now() + 120_000 };
      return { session: canonical };
    },
    mutateSemantic: async (
      current: { execution_token: string },
      expectedVersion: number,
      next: Record<string, unknown>
    ) => {
      assertCurrentExecution(current, expectedVersion);
      canonical = { ...next, version: expectedVersion + 1 };
      return { changed: true, session: canonical };
    }
  };

  const downloaded = await downloadIngestionSessionSnapshot(
    repository as never,
    staleExecution as never,
    new AbortController().signal,
    {
      maxFileBytes: () => 1024,
      now: () => 1_000,
      fetchImageToFile: async (
        _url,
        _target,
        _part,
        limit,
        _signal,
        onProgress
      ) => {
        assert.equal(limit, 1024);
        canonical = {
          ...canonical,
          version: 3,
          last_semantic_revision: 3,
          metadata: {
            ...canonical.metadata,
            title: "edited while downloading"
          }
        };
        onProgress?.(50);
        await delay(0);
        return 42;
      }
    }
  );
  assert.equal(downloaded.status, "received");
  assert.equal(downloaded.version, 4);
  assert.equal(downloaded.metadata.title, "edited while downloading");
  assert.equal(downloaded.raw_size, 42);

  const preparingStale = {
    ...downloaded,
    status: "preparing",
    phase: "preparing",
    execution_token: "0198c080-0000-7000-8000-000000000003",
    raw_generation: "0198c080-0000-7000-8000-000000000004",
    version: 5
  };
  canonical = {
    ...preparingStale,
    version: 6,
    last_semantic_revision: 6,
    metadata: {
      ...preparingStale.metadata,
      description: "edited while preparing"
    }
  };
  const progressed = await updateIngestionExecutionProgress(
    repository as never,
    preparingStale as never,
    { phase: "detecting", message: "detecting", progress: null }
  );
  assert.equal(progressed.version, 6);
  assert.equal(progressed.metadata.description, "edited while preparing");
  const heartbeaten = await heartbeatIngestionExecution(
    repository as never,
    preparingStale as never
  );
  assert.equal(heartbeaten.version, 6);
  const failed = await mutateIngestionExecution(
    repository as never,
    preparingStale as never,
    (latest) => ({
      ...latest,
      status: "failed",
      phase: "failed",
      execution_token: ""
    })
  );
  assert.equal(failed.version, 7);
  assert.equal(failed.metadata.description, "edited while preparing");

  await assert.rejects(
    refreshIngestionExecutionSession(repository as never, preparingStale as never),
    (error) => error instanceof ApiError
      && error.code === "ingestion_execution_fenced"
  );
});
type CleanupRetryQueueOptions = Readonly<{
  capacity?: () => number;
  lossy?: boolean;
  maxAttempts?: () => number;
  retryDelayMs?: () => number;
}>;
const CleanupRetryQueue = ingestionCleanupRetryQueue.constructor as unknown as {
  new(options?: CleanupRetryQueueOptions): typeof ingestionCleanupRetryQueue;
};
test("[Server/内容接入] Ingestion 清理重试队列满载时背压且不丢失精确任务", async () => {
  const queue = new CleanupRetryQueue({
    capacity: () => 2,
    retryDelayMs: () => 0
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  let completed = 0;
  let thirdStarted = false;
  const work = async () => {
    started += 1;
    await gate;
    completed += 1;
  };

  await queue.enqueue(work);
  await queue.enqueue(work);
  let thirdAdmitted = false;
  const thirdAdmission = queue.enqueue(async () => {
    thirdStarted = true;
    completed += 1;
  }).then(() => {
    thirdAdmitted = true;
  });
  await delay(0);
  assert.equal(started, 1);
  assert.equal(thirdAdmitted, false);
  assert.equal(thirdStarted, false);

  release();
  await thirdAdmission;
  while (completed < 3) await delay(0);
  assert.equal(started, 2);
  assert.equal(thirdStarted, true);

  const retrying = new CleanupRetryQueue({
    capacity: () => 1,
    retryDelayMs: () => 0
  });
  let attempts = 0;
  await retrying.enqueue(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient cleanup failure");
  });
  while (attempts < 2) await delay(0);

  const fairRetry = new CleanupRetryQueue({
    capacity: () => 2,
    retryDelayMs: () => 25
  });
  const attemptOrder: string[] = [];
  let fairAttempts = 0;
  await fairRetry.enqueue(async () => {
    fairAttempts += 1;
    attemptOrder.push(`retry-${fairAttempts}`);
    if (fairAttempts === 1) throw new Error("retry after another cleanup");
  });
  while (fairAttempts < 1) await delay(0);
  await fairRetry.enqueue(async () => {
    attemptOrder.push("later-cleanup");
  });
  while (!attemptOrder.includes("later-cleanup")) await delay(0);
  assert.deepEqual(attemptOrder.slice(0, 2), ["retry-1", "later-cleanup"]);
  while (fairAttempts < 2) await delay(1);
});
test("[Server/内容接入] 可再发现的清理材料在满载与永久失败时保持有界", async () => {
  const queue = new CleanupRetryQueue({
    capacity: () => 1,
    lossy: true,
    maxAttempts: () => 2,
    retryDelayMs: () => 0
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  let overflowRan = false;
  await queue.enqueue(async () => {
    attempts += 1;
    await gate;
    throw new Error("permanent disposable cleanup failure");
  });
  await queue.enqueue(async () => {
    overflowRan = true;
  });
  assert.equal(overflowRan, false, "满载时不得让请求等待无界后台工作");
  release();
  while (attempts < 2) await delay(0);
  await delay(0);
  let recovered = false;
  await queue.enqueue(async () => {
    recovered = true;
  });
  while (!recovered) await delay(0);
  assert.equal(attempts, 2);
  assert.equal(overflowRan, false);
});
test("[Server/内容接入] 取消批次只查询一次 PG 并在查询期间封住全部提交边界", async () => {
  const owner = "cancel-batch-owner";
  const coordinator = new IngestionIrreversibleCoordinator();
  const sessions = Array.from({ length: 100 }, (_, index): IngestionSessionSnapshot => {
    const resolved = parseImageTime(
      `2026-08-23T01:02:${String(index % 60).padStart(2, "0")}.456Z`
    );
    return {
      owner,
      queue: "import",
      source_type: "url",
      session_id: createIngestionSessionId(owner, "import", `item-${index}`),
      image_id: createImageId(resolved.date, index),
      image_time: resolved.iso,
      request_hash: String(index).padStart(64, "0"),
      import_download: { url: `https://example.com/${index}.jpg` },
      metadata: {
        device: "auto",
        brightness: "auto",
        theme: null,
        author: "",
        title: "",
        description: "",
        source: "",
        original: "",
        tags: []
      },
      storage_slug: "local",
      status: "failed",
      phase: "failed",
      message: "commit response lost",
      progress: null,
      version: 1,
      progress_seq: 0,
      last_semantic_revision: 1,
      accepted_at: 1,
      accepted_order: index + 1,
      execution_token: "",
      raw_generation: "",
      raw_size: 0,
      commit: {
        commit_request_id: `commit-request-${index}`,
        commit_intent_hash: String(index + 2).padStart(64, "0"),
        created_by: owner,
        expected_md5: String(index).padStart(32, "0"),
        duplicate_decision: "upload",
        metadata: {
          device: "auto",
          brightness: "auto",
          theme: null,
          author: "",
          title: "",
          description: "",
          source: "",
          original: "",
          tags: []
        },
        final_object_key: `2026/08/cancel-${index}.webp`
      },
      error: {
        code: "ingestion_stage_failed",
        message: "commit response lost"
      },
      discard_at: 10_000,
      semantic_hash: String(index + 1).padStart(64, "0")
    };
  });
  const bySession = new Map(sessions.map((session) => [
    session.session_id,
    session
  ]));
  for (const session of sessions) {
    assert.equal(coordinator.registerCancellable(session), true);
  }

  let discarded = 0;
  let aborted = 0;
  const repository = {
    readSessions: async (_owner: string, items: readonly { session_id: string }[]) => (
      items.map((item) => bySession.get(item.session_id) ?? null)
    ),
    mutateSemantic: async (
      current: { version: number },
      expectedVersion: number,
      next: { status: string }
    ) => {
      assert.equal(current.version, expectedVersion);
      assert.equal(next.status, "discarded");
      discarded += 1;
      return { session: next, metadata: { revision: discarded } };
    }
  };
  let resultReads = 0;
  let physicalCleanupSchedules = 0;
  let databaseStarts = 0;
  let competingTransactions: Promise<"rejected" | "started">[] = [];
  const results = await cancelIngestionSessions(
    repository as never,
    coordinator,
    owner,
    sessions.map((session) => ({
      session_id: session.session_id,
      image_id: session.image_id,
      expected_version: session.version
    })),
    () => {
      aborted += 1;
    },
    {},
    {
      readCommitted: async (imageIds) => {
        resultReads += 1;
        assert.equal(imageIds.length, sessions.length);
        competingTransactions = sessions.map((session) => (
          coordinator.beginDatabaseTransaction(
            session,
            async () => undefined,
            async () => {
              databaseStarts += 1;
            }
          ).then(() => "started" as const, () => "rejected" as const)
        ));
        await delay(0);
        assert.equal(
          databaseStarts,
          0,
          "PG 批量判定期间任何 pair 都不得越过取消临界区"
        );
        return new Map();
      },
      scheduleCleanup: async (work) => {
        assert.equal(discarded, sessions.length);
        physicalCleanupSchedules += 1;
        await work();
      }
    }
  );
  assert.equal(resultReads, 1);
  assert.equal(discarded, sessions.length);
  assert.equal(aborted, sessions.length);
  assert.equal(physicalCleanupSchedules, 1);
  assert.ok(results.every((result) => result.status === "discarded"));
  assert.deepEqual(
    results.map((result) => result.queue_revision),
    Array.from({ length: sessions.length }, (_, index) => index + 1)
  );
  assert.ok((await Promise.all(competingTransactions)).every(
    (result) => result === "rejected"
  ));
  assert.equal(databaseStarts, 0);

  const crossOwner = sessions.map((session, index) => {
    const crossOwnerName = `cancel-owner-${index}`;
    return {
      ...session,
      owner: crossOwnerName,
      session_id: createIngestionSessionId(
        crossOwnerName,
        "import",
        `item-${index}`
      )
    };
  });
  const crossOwnerCoordinator = new IngestionIrreversibleCoordinator();
  for (const session of crossOwner) {
    assert.equal(crossOwnerCoordinator.registerCancellable(session), true);
  }
  let crossOwnerReads = 0;
  let crossOwnerDiscards = 0;
  let crossOwnerCleanupSchedules = 0;
  const crossOwnerResults = await cancelRecoveredIngestionSessions(
    {
      mutateSemantic: async (
        _current: unknown,
        _expectedVersion: number,
        next: { status: string }
      ) => {
        assert.equal(next.status, "discarded");
        crossOwnerDiscards += 1;
        return {
          session: next,
          metadata: { revision: crossOwnerDiscards }
        };
      }
    } as never,
    crossOwnerCoordinator,
    crossOwner,
    () => undefined,
    {},
    {
      readCommitted: async (imageIds) => {
        crossOwnerReads += 1;
        assert.equal(imageIds.length, crossOwner.length);
        return new Map();
      },
      scheduleCleanup: async (work) => {
        crossOwnerCleanupSchedules += 1;
        await work();
      }
    }
  );
  assert.equal(crossOwnerReads, 1);
  assert.equal(crossOwnerDiscards, crossOwner.length);
  assert.equal(crossOwnerCleanupSchedules, 1);
  assert.ok(crossOwnerResults.every((result) => (
    result.status === "discarded"
  )));
  assert.deepEqual(
    crossOwnerResults.map((result) => result.queue_revision),
    Array.from({ length: crossOwner.length }, (_, index) => index + 1)
  );
});
test("[Server/内容接入] 取消批次把旧 incarnation 保留为逐项冲突", async () => {
  const owner = "cancel-incarnation-owner";
  const stale = {
    session_id: createIngestionSessionId(owner, "import", "stale"),
    image_id: createImageId(
      parseImageTime("2026-08-23T01:02:03.456Z").date,
      1
    ),
    expected_version: 1
  };
  const completed = {
    session_id: createIngestionSessionId(owner, "import", "completed"),
    image_id: createImageId(
      parseImageTime("2026-08-23T01:02:04.456Z").date,
      2
    ),
    expected_version: 1
  };
  const results = await cancelIngestionSessions(
    {
      readSessions: async () => [ingestionSessionIncarnationMismatch, null]
    } as never,
    new IngestionIrreversibleCoordinator(),
    owner,
    [stale, completed],
    () => undefined,
    {},
    {
      readCommitted: async () => new Map([[
        completed.image_id,
        {
          created_by: owner,
          item: { id: completed.image_id }
        } as never
      ]])
    }
  );
  assert.deepEqual(results.map((result) => ({
    status: result.status,
    code: result.status === "failed" ? result.code : undefined
  })), [
    { status: "failed", code: "ingestion_incarnation_conflict" },
    { status: "completed", code: undefined }
  ]);
  const completedResult = results[1];
  assert.equal(completedResult?.status, "completed");
  if (completedResult?.status !== "completed") {
    assert.fail("第二项应返回已完成图片");
  }
  assert.equal(completedResult.completed_item.id, completed.image_id);
});
test("[Server/内容接入] 已启动事务的 expiry 只通过原子 cutoff 收敛", async () => {
  const runCase = async (input: Readonly<{
    committed: boolean;
    discardAt: number;
  }>) => {
    const pair = {
      session_id: createIngestionSessionId(
        "expiry-owner",
        "import",
        `expiry-${input.committed}-${input.discardAt}`
      ),
      image_id: createImageId(
        new Date(`2026-08-23T01:03:0${input.committed ? 1 : 2}.456Z`),
        input.discardAt
      )
    };
    const current = {
      owner: "expiry-owner",
      queue: "import",
      source_type: "url",
      ...pair,
      image_time: "2026-08-23T01:03:00.456Z",
      request_hash: "a".repeat(64),
      import_download: { url: "https://example.com/expiry.jpg" },
      metadata: {
        device: "auto",
        brightness: "auto",
        theme: null,
        author: "",
        title: "",
        description: "",
        source: "",
        original: "",
        tags: []
      },
      storage_slug: "local",
      status: "committing",
      phase: "committing",
      message: "committing",
      progress: null,
      version: 1,
      progress_seq: 0,
      last_semantic_revision: 1,
      accepted_at: 1,
      accepted_order: 1,
      execution_token: "execution",
      raw_generation: "raw",
      raw_size: 1,
      commit: {
        commit_request_id: "commit-request",
        commit_intent_hash: "b".repeat(64)
      },
      discard_at: input.discardAt,
      semantic_hash: "c".repeat(64)
    } as const;
    const coordinator = new IngestionIrreversibleCoordinator();
    assert.equal(coordinator.registerCancellable(pair), true);
    let releaseTransaction: () => void = () => {};
    const transactionGate = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    const transaction = coordinator.beginDatabaseTransaction(
      pair,
      async () => undefined,
      async () => transactionGate
    );
    while (coordinator.state(pair) !== "database_started") await delay(0);
    const transitions: string[] = [];
    const repository = {
      readSessions: async () => [current],
      readSession: async () => current,
      expireSession: async (
        active: { discard_at: number },
        _version: number,
        cutoff: number,
        next: { status: string }
      ) => {
        if (active.discard_at > cutoff) {
          throw new ApiError(
            409,
            "ingestion_session_not_expired",
            "内容接入任务的有效期已经刷新"
          );
        }
        transitions.push(next.status);
        return { session: next, metadata: { revision: transitions.length } };
      },
      mutateSemantic: async () => {
        throw new Error("expiry must not use a non-atomic semantic mutation");
      }
    };
    const results = await cancelIngestionSessions(
      repository as never,
      coordinator,
      current.owner,
      [{ ...pair, expected_version: current.version }],
      () => undefined,
      { expiryCutoff: 10 },
      {
        readCommitted: async () => new Map(input.committed
          ? [[pair.image_id, {
              created_by: current.owner,
              item: { id: pair.image_id }
            } as never]]
          : []),
        scheduleCleanup: () => undefined
      }
    );
    releaseTransaction();
    await transaction;
    return { results, transitions };
  };

  const resolving = await runCase({ committed: false, discardAt: 10 });
  assert.equal(resolving.results[0].status, "resolving");
  assert.deepEqual(resolving.transitions, ["resolving"]);
  const completed = await runCase({ committed: true, discardAt: 10 });
  assert.equal(completed.results[0].status, "completed");
  assert.deepEqual(completed.transitions, ["completed"]);
  for (const committed of [false, true]) {
    const refreshed = await runCase({ committed, discardAt: 11 });
    assert.equal(refreshed.results[0].status, "failed");
    assert.equal(refreshed.results[0].code, "ingestion_session_not_expired");
    assert.deepEqual(refreshed.transitions, []);
  }
});
test("[Server/内容接入] PG 完成清理不会越过新的 session incarnation", async () => {
  const owner = "incarnation-owner";
  const sessionId = createIngestionSessionId(owner, "import", "same-intent");
  const oldImageId = createImageId(
    new Date("2026-08-23T01:04:01.456Z"),
    1
  );
  const newImageId = createImageId(
    new Date("2026-08-23T01:04:02.456Z"),
    2
  );
  const active = (imageId: string) => ({
    owner,
    queue: "import",
    source_type: "url",
    session_id: sessionId,
    image_id: imageId,
    image_time: "2026-08-23T01:04:00.456Z",
    request_hash: "d".repeat(64),
    import_download: { url: "https://example.com/incarnation.jpg" },
    metadata: {
      device: "auto",
      brightness: "auto",
      theme: null,
      author: "",
      title: "",
      description: "",
      source: "",
      original: "",
      tags: []
    },
    storage_slug: "local",
    status: "queued",
    phase: "queued",
    message: "queued",
    progress: null,
    version: 1,
    progress_seq: 0,
    last_semantic_revision: 1,
    accepted_at: 1,
    accepted_order: 1,
    execution_token: "",
    raw_generation: "",
    raw_size: 0,
    discard_at: 10_000,
    semantic_hash: "e".repeat(64)
  } as const);
  const oldSession = active(oldImageId);
  const replacement = active(newImageId);
  let writes = 0;
  const results = await cancelIngestionSessions(
    {
      readSessions: async () => [oldSession],
      readSession: async () => replacement,
      mutateSemantic: async () => {
        writes += 1;
        throw new Error("replacement must not be mutated");
      },
      deleteSession: async () => {
        writes += 1;
        throw new Error("replacement must not be deleted");
      }
    } as never,
    new IngestionIrreversibleCoordinator(),
    owner,
    [{
      session_id: sessionId,
      image_id: oldImageId,
      expected_version: oldSession.version
    }],
    () => undefined,
    {},
    {
      readCommitted: async () => new Map([[
        oldImageId,
        { created_by: owner } as never
      ]]),
      scheduleCleanup: () => undefined
    }
  );
  assert.equal(results[0].status, "completed");
  assert.equal(writes, 0);
});
test("[Server/内容接入] PG 完成会清退保留 commit 的 failed canonical", async () => {
  const owner = "failed-commit-owner";
  const pair = {
    session_id: createIngestionSessionId(owner, "import", "failed-commit"),
    image_id: createImageId(new Date("2026-08-23T01:05:01.456Z"), 1)
  };
  const failed = {
    owner,
    queue: "import",
    source_type: "url",
    ...pair,
    image_time: "2026-08-23T01:05:01.456Z",
    request_hash: "f".repeat(64),
    import_download: { url: "https://example.com/failed-commit.jpg" },
    metadata: {
      device: "auto",
      brightness: "auto",
      theme: null,
      author: "",
      title: "",
      description: "",
      source: "",
      original: "",
      tags: []
    },
    storage_slug: "local",
    status: "failed",
    phase: "failed",
    message: "response lost",
    progress: null,
    version: 2,
    progress_seq: 0,
    last_semantic_revision: 2,
    accepted_at: 1,
    accepted_order: 1,
    execution_token: "",
    raw_generation: createImageId(
      new Date("2026-08-23T01:05:02.456Z"),
      2
    ),
    raw_size: 1,
    commit: {
      commit_request_id: "commit-request",
      commit_intent_hash: "a".repeat(64),
      created_by: owner,
      expected_md5: "c".repeat(32),
      duplicate_decision: "upload",
      metadata: {
        device: "auto",
        brightness: "auto",
        theme: null,
        author: "",
        title: "",
        description: "",
        source: "",
        original: "",
        tags: []
      },
      final_object_key: "2026/08/failed-commit.webp"
    },
    error: {
      code: "ingestion_stage_failed",
      message: "response lost"
    },
    discard_at: 10_000,
    semantic_hash: "b".repeat(64)
  } as const;
  const discarded = {
    owner,
    queue: "import",
    ...pair,
    image_time: failed.image_time,
    request_hash: failed.request_hash,
    status: "discarded",
    version: 3,
    last_semantic_revision: 3,
    accepted_at: 1,
    accepted_order: 1,
    discarded_at: 2,
    discard_at: failed.discard_at
  } as const;
  for (const committedObjectKey of [
    failed.commit.final_object_key,
    "2026/08/another-published-object.webp"
  ] as const) {
    const writes: string[] = [];
    const results = await cancelIngestionSessions(
      {
        readSessions: async () => [failed],
        readSession: async () => failed,
        mutateSemantic: async (
          _current: unknown,
          _version: number,
          next: { status: string }
        ) => {
          writes.push(next.status);
          assert.equal(next.status, "discarded");
          return { session: discarded, metadata: { revision: 3 } };
        },
        deleteSession: async (current: { status: string }) => {
          writes.push(`delete:${current.status}`);
        }
      } as never,
      new IngestionIrreversibleCoordinator(),
      owner,
      [{ ...pair, expected_version: failed.version }],
      () => undefined,
      {},
      {
        readCommitted: async () => new Map([[pair.image_id, {
          image_id: pair.image_id,
          image_time: failed.image_time,
          created_by: owner,
          item: {
            storage_slug: failed.storage_slug,
            object_key: committedObjectKey
          } as never
        }]]),
        scheduleCleanup: async (work) => work()
      }
    );
    assert.equal(results[0].status, "completed");
    assert.deepEqual(writes, ["discarded", "delete:discarded"]);
  }
});
test("[Server/内容接入] 迟到失败接力同 execution 草稿版本且 prepared 丢响应保留引用", () => {
  const execution = {
    image_id: "image",
    status: "preparing",
    version: 2,
    execution_token: "execution-a"
  };
  assert.equal(isSameFailedIngestionExecution(
    { ...execution } as never,
    execution as never
  ), true);
  assert.equal(isSameFailedIngestionExecution(
    { ...execution, execution_token: "execution-b" } as never,
    execution as never
  ), false);
  assert.equal(isSameFailedIngestionExecution(
    { ...execution, version: 3 } as never,
    execution as never
  ), true);
  assert.equal(isSameFailedIngestionExecution(
    { ...execution, status: "ready", version: 3 } as never,
    execution as never
  ), false);
  const committing = {
    ...execution,
    status: "committing",
    execution_token: "commit-a"
  };
  assert.equal(isSameFailedIngestionExecution(
    { ...committing, status: "resolving", version: 3 } as never,
    committing as never
  ), true);

  const current = {
    image_id: "image",
    prepared: {
      prepared_image_key: "attempt/image",
      prepared_thumbnail_key: "attempt/thumb"
    }
  };
  assert.equal(preparedAttemptIsReferenced(
    current as never,
    { image_id: "image" },
    "attempt/image",
    "attempt/thumb"
  ), true);
  assert.equal(preparedAttemptIsReferenced(
    current as never,
    { image_id: "image" },
    "older/image",
    "older/thumb"
  ), false);
  assert.equal(preparedAttemptIsReferenced(
    null,
    { image_id: "image" },
    "attempt/image",
    "attempt/thumb"
  ), false);
});
type RecoveryTestSession = Omit<
  IngestionSessionSnapshot,
  "status" | "commit"
> & {
  status: string;
  commit?: Readonly<{ commit_request_id: string }>;
  commit_request_id?: string;
  commit_intent_hash?: string;
  completed_at?: number;
};
test("[Server/内容接入] recovery 严格先收敛 expiry 并只重排一次未过期执行阶段", async () => {
  const now = 10_000;
  const session = (
    imageId: string,
    status: string,
    discardAt: number
  ): RecoveryTestSession => ({
    owner: "recovery-owner",
    queue: "import",
    source_type: "url",
    session_id: `session-${imageId}`,
    image_id: imageId,
    image_time: "2026-08-23T01:02:03.456Z",
    request_hash: `request-${imageId}`,
    import_download: { url: "https://example.com/image.jpg" },
    metadata: {
      device: "auto",
      brightness: "auto",
      theme: null,
      author: "",
      title: imageId,
      description: "",
      source: "",
      original: "",
      tags: []
    },
    storage_slug: "local",
    status,
    phase: status,
    message: status,
    progress: null,
    version: 1,
    progress_seq: 0,
    last_semantic_revision: 1,
    accepted_at: 1,
    accepted_order: 1,
    execution_token: `old-${imageId}`,
    raw_generation: status === "preparing" ? `raw-${imageId}` : "",
    raw_size: status === "preparing" ? 100 : 0,
    discard_at: discardAt,
    semantic_hash: `semantic-${imageId}`
  });
  const sessions = new Map<string, RecoveryTestSession>([
    ["expired", session("expired", "queued", now)],
    ["expired-completed", {
      ...session("expired-completed", "completed", now),
      commit_request_id: "commit-expired",
      commit_intent_hash: "intent-expired",
      completed_at: 1
    }],
    ["downloading", session("downloading", "downloading", now + 1_000)],
    ["raw-present", session("raw-present", "preparing", now + 2_000)],
    ["raw-missing", session("raw-missing", "preparing", now + 3_000)],
    ["ready", session("ready", "ready", now + 4_000)],
    ["commit-retry", {
      ...session("commit-retry", "committing", now + 5_000),
      commit: { commit_request_id: "retry" }
    }],
    ["committed", {
      ...session("committed", "committing", now + 6_000),
      commit: { commit_request_id: "committed" }
    }],
    ["resolving", {
      ...session("resolving", "resolving", now + 7_000),
      commit: { commit_request_id: "resolving" }
    }]
  ]);
  const operations: string[] = [];
  const recoveredCompletedItem = { id: "committed" };
  let publishedCompletedItem: unknown;
  const repository = {
    discoverExpired: async (at: number) => {
      operations.push("discover-expired");
      return [...sessions.values()]
        .filter((value) => value.discard_at <= at)
        .map((value) => ({ canonicalKey: value.session_id, session: value }));
    },
    discoverExpiryPage: async (offset: number) => {
      operations.push(`page-${offset}`);
      const items = [...sessions.values()]
        .filter((value) => value.discard_at > now)
        .slice(offset, offset + appConfig.ingestionRuntime.ingestionSessionScanBatchSize)
        .map((value) => ({ canonicalKey: value.session_id, session: value }));
      return {
        items,
        total: items.length,
        scanned: items.length,
        missing: 0,
        frozenTailScore: 0,
        lastScannedScore: 0
      };
    },
    deleteSession: async (current: { image_id: string }) => {
      operations.push(`delete-${current.image_id}`);
      sessions.delete(current.image_id);
    },
    expireSession: async (current: { image_id: string }) => {
      operations.push(`delete-${current.image_id}`);
      sessions.delete(current.image_id);
      return { session: undefined };
    },
    mutateSemantic: async (
      current: RecoveryTestSession,
      _version: number,
      next: RecoveryTestSession
    ) => {
      operations.push(`mutate-${current.image_id}`);
      const stored = { ...next, version: current.version + 1 };
      sessions.set(current.image_id, stored);
      return { session: stored };
    }
  };
  let tokenSequence = 0;
  const recovery = new IngestionSessionRecovery(
    repository as never,
    new IngestionIrreversibleCoordinator(),
    () => undefined,
    {
      now: () => now,
      readCommitted: async (ids) => new Map(ids.includes("committed")
        ? [["committed", {
          created_by: "recovery-owner",
          item: recoveredCompletedItem
        } as never]]
        : []),
      cancel: async (_repository, _coordinator, active) => {
        return active.map((item, index) => {
          operations.push(`cancel-${item.image_id}`);
          sessions.delete(item.image_id);
          return {
            session_id: item.session_id,
            image_id: item.image_id,
            status: "discarded" as const,
            queue_revision: index + 1
          };
        });
      },
      publishCompleted: async (_repository, current, _completedAt, item) => {
        operations.push(`complete-${current.image_id}`);
        publishedCompletedItem = item;
        sessions.set(current.image_id, {
          ...current,
          status: "completed"
        });
      },
      rawExists: async (current) => current.image_id === "raw-present",
      newExecutionToken: () => `new-token-${++tokenSequence}`
    }
  );
  for (let step = 0; step < 10 && !recovery.complete; step += 1) {
    await recovery.step();
  }
  assert.equal(recovery.complete, true, "恢复不得因 committing 重复换 token 而自旋");
  const firstPage = operations.findIndex((value) => value.startsWith("page-"));
  assert.ok(firstPage > operations.indexOf("cancel-expired"));
  assert.ok(firstPage > operations.indexOf("delete-expired-completed"));
  assert.equal(sessions.get("downloading")?.status, "queued");
  assert.equal(sessions.get("raw-present")?.status, "received");
  assert.equal(sessions.get("raw-missing")?.status, "failed");
  assert.equal(sessions.get("ready")?.status, "ready");
  assert.equal(sessions.get("commit-retry")?.execution_token, "new-token-1");
  assert.equal(
    operations.filter((value) => value === "mutate-commit-retry").length,
    1
  );
  assert.equal(sessions.get("committed")?.status, "completed");
  assert.equal(
    publishedCompletedItem,
    recoveredCompletedItem,
    "恢复已知 PostgreSQL 完成项时必须直接随 completed 事件携带 DTO"
  );
  assert.equal(sessions.has("resolving"), false);
  sessions.set("late-expired", session("late-expired", "queued", now));
  assert.equal(await recovery.drainExpired(), true);
  assert.equal(sessions.has("late-expired"), false,
    "startup recovery 完成后仍必须有界收敛新到期 session");
});
test("[Server/内容接入] 恢复按实际扫描边界越过缺失 canonical 的满页", async () => {
  const now = Date.parse("2026-08-23T01:02:03.456Z");
  const makeSession = (label: string, status: "ready" | "downloading") => {
    const owner = "recovery-missing-owner";
    const sessionId = createIngestionSessionId(owner, "import", label);
    return {
      owner,
      queue: "import" as const,
      source_type: "url" as const,
      session_id: sessionId,
      image_id: createImageId(new Date(now), label === "ready" ? 1 : 2),
      image_time: new Date(now).toISOString(),
      request_hash: (label === "ready" ? "1" : "2").repeat(64),
      import_download: { url: `https://example.com/${label}.jpg` },
      metadata: {
        device: "auto",
        brightness: "auto",
        theme: null,
        author: "",
        title: label,
        description: "",
        source: "",
        original: "",
        tags: []
      },
      storage_slug: "local",
      status,
      phase: status,
      message: status,
      progress: null,
      version: 1,
      progress_seq: 0,
      last_semantic_revision: 1,
      accepted_at: now,
      accepted_order: label === "ready" ? 1 : 2,
      execution_token: status === "downloading" ? "old-token" : "",
      raw_generation: "",
      raw_size: 0,
      discard_at: now + 60_000,
      semantic_hash: `semantic-${label}`
    };
  };
  const ready = makeSession("ready", "ready");
  const downloading = makeSession("downloading", "downloading");
  const batchSize = appConfig.ingestionRuntime.ingestionSessionScanBatchSize;
  const offsets: number[] = [];
  let normalized = false;
  let pageCall = 0;
  const repository = {
    discoverExpired: async () => [],
    discoverExpiryPage: async (offset: number) => {
      offsets.push(offset);
      pageCall += 1;
      if (pageCall === 1) {
        return {
          items: [{ canonicalKey: ready.session_id, session: ready }],
          total: batchSize + 1,
          scanned: batchSize,
          missing: batchSize - 1,
          frozenTailScore: 0,
          lastScannedScore: 0
        };
      }
      if (pageCall === 2) {
        return {
          items: [{ canonicalKey: downloading.session_id, session: downloading }],
          total: 2,
          scanned: 1,
          missing: 0,
          frozenTailScore: 0,
          lastScannedScore: 0
        };
      }
      return {
        items: [],
        total: 1,
        scanned: 0,
        missing: 0,
        frozenTailScore: 0,
        lastScannedScore: 0
      };
    },
    mutateSemantic: async (
      _current: IngestionSessionSnapshot,
      _version: number,
      next: IngestionSessionSnapshot
    ) => {
      normalized = next.status === "queued";
      return { session: { ...next, version: next.version + 1 } };
    }
  };
  const recovery = new IngestionSessionRecovery(
    repository as never,
    new IngestionIrreversibleCoordinator(),
    () => undefined,
    {
      now: () => now,
      readCommitted: async () => new Map(),
      cancel: async () => [],
      publishCompleted: async () => undefined,
      rawExists: async () => false,
      newExecutionToken: () => "new-token"
    }
  );
  assert.equal(await recovery.step(), false);
  assert.equal(await recovery.step(), false);
  assert.equal(normalized, true);
  assert.deepEqual(offsets.slice(0, 2), [0, 1]);
  assert.equal(await recovery.step(), true);

  const expired = {
    ...makeSession("expired", "downloading"),
    discard_at: now
  };
  const shiftedOffsets: number[] = [];
  let expiryScan = 0;
  let shiftedPage = 0;
  const recoveryWithExpiryShift = new IngestionSessionRecovery(
    {
      discoverExpired: async () => {
        expiryScan += 1;
        return expiryScan === 2
          ? [{ canonicalKey: expired.session_id, session: expired }]
          : [];
      },
      discoverExpiryPage: async (offset: number) => {
        shiftedOffsets.push(offset);
        shiftedPage += 1;
        return shiftedPage === 1
          ? {
            items: [{ canonicalKey: ready.session_id, session: ready }],
            total: batchSize,
            scanned: batchSize,
            missing: batchSize - 1,
            frozenTailScore: 0,
            lastScannedScore: 0
          }
          : {
            items: [],
            total: 1,
            scanned: 0,
            missing: 0,
            frozenTailScore: 0,
            lastScannedScore: 0
          };
      }
    } as never,
    new IngestionIrreversibleCoordinator(),
    () => undefined,
    {
      now: () => now,
      readCommitted: async () => new Map(),
      cancel: async (_repository, _coordinator, active) => active.map((item, index) => ({
        session_id: item.session_id,
        image_id: item.image_id,
        status: "discarded" as const,
        queue_revision: index + 1
      })),
      publishCompleted: async () => undefined,
      rawExists: async () => false,
      newExecutionToken: () => "new-token"
    }
  );
  assert.equal(await recoveryWithExpiryShift.step(), false);
  assert.equal(await recoveryWithExpiryShift.step(), false);
  assert.equal(await recoveryWithExpiryShift.step(), true);
  assert.deepEqual(shiftedOffsets, [0, 0],
    "expiry 收敛改变 ZSET rank 后必须从头开始新的恢复轮次");
});
test("[Server/内容接入] 内容接入 SSE 先监听再快照、串行验权并响应登录立即失效", async () => {
  const session = {
    id: "current-sse-session",
    username: "current-sse-owner",
    csrf: "current-sse-csrf",
    role: "image" as const
  };
  const initialMetadata = {
    owner: session.username,
    queue: "upload" as const,
    revision: 4,
    last_accepted_order: 1,
    total: 1,
    unfinished: 0,
    waiting: 0,
    running: 0,
    ready: 0,
    duplicate_pending: 0,
    committing_resolving: 0,
    resolving: 0,
    completed: 1,
    failed: 0
  };
  const removedMetadata = {
    ...initialMetadata,
    revision: 6,
    total: 0,
    completed: 0
  };
  const terminal = {
    owner: session.username,
    queue: "upload" as const,
    session_id: "sse-terminal-session",
    image_id: "019f8457-063a-7005-a580-7a432dc7fd8e",
    request_hash: "1".repeat(64),
    commit_request_id: "019f8457-063a-7006-a580-7a432dc7fd8e",
    commit_intent_hash: "2".repeat(64),
    status: "completed" as const,
    version: 3,
    last_semantic_revision: 5,
    accepted_at: 1,
    accepted_order: 1,
    completed_at: 2,
    discard_at: 3
  };
  const order: string[] = [];
  let unsubscribeCount = 0;
  const repository = {
    subscribe(
      owner: string,
      queue: "upload" | "import",
      listener: (event: unknown) => void
    ) {
      assert.equal(owner, session.username);
      assert.equal(queue, "upload");
      order.push("subscribe");
      this.listener = listener;
      return () => {
        unsubscribeCount += 1;
      };
    },
    listener: undefined as ((event: unknown) => void) | undefined,
    async snapshot() {
      order.push("snapshot");
      this.listener?.({
        owner: session.username,
        queue: "upload",
        kind: "semantic",
        metadata: { ...initialMetadata, revision: 5 },
        session: terminal,
        completedItem: {
          id: terminal.image_id,
          storage_slug: "local"
        }
      });
      this.listener?.({
        owner: session.username,
        queue: "upload",
        kind: "removed",
        metadata: removedMetadata,
        session: terminal
      });
      return {
        metadata: initialMetadata,
        offset: 0,
        limit: 1,
        items: []
      };
    }
  };
  let validationCalls = 0;
  let activeValidations = 0;
  let maximumActiveValidations = 0;
  const validateSession = async () => {
    activeValidations += 1;
    maximumActiveValidations = Math.max(
      maximumActiveValidations,
      activeValidations
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    validationCalls += 1;
    activeValidations -= 1;
    return validationCalls < 3 ? session : null;
  };
  const tokens = new IngestionTokenService({
    rootKey: new Uint8Array(32).fill(41)
  });
  let scopeCloseCount = 0;
  const actionScopes = {
    open: () => ({
      id: "current-sse-action-scope",
      connectionEpoch: 1,
      close: () => {
        scopeCloseCount += 1;
      }
    }),
    require: () => ({
      id: "current-sse-action-scope",
      sessionId: session.id,
      owner: session.username,
      queue: "upload" as const,
      connectionEpoch: 1,
      invalidate: () => undefined
    }),
    sign: () => "current-sse-watermark"
  };
  const app = new Hono();
  app.get("/events", (context) => streamIngestionQueueEvents(context, {
    repository: repository as never,
    tokens,
    session,
    queue: "upload",
    validateSession,
    authenticationHeartbeatMs: 1,
    actionScopes: actionScopes as never
  }));
  const response = await app.request("/events");
  assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  const body = await response.text();
  assert.deepEqual(order, ["subscribe", "snapshot"]);
  assert.ok(body.indexOf("event: ready") >= 0);
  assert.ok(body.indexOf("event: mutation") > body.indexOf("event: ready"));
  const semanticMutationMatch = body.match(
    /event: mutation\r?\ndata: ([^\r\n]+)/u
  );
  assert.ok(semanticMutationMatch);
  const semanticMutation = JSON.parse(semanticMutationMatch[1]);
  assert.deepEqual(semanticMutation.summary, {
    total: 1,
    unfinished: 0,
    waiting: 0,
    running: 0,
    ready: 0,
    duplicate_pending: 0,
    committing: 0,
    resolving: 0,
    completed: 1,
    failed: 0
  });
  assert.equal(semanticMutation.action_watermark, "current-sse-watermark");
  assert.match(
    body,
    new RegExp(`"completed_item":\\{"id":"${terminal.image_id}"`, "u"),
    "完成投影必须随语义事件直接交给前端，不得强制补查 snapshot"
  );
  assert.ok(body.indexOf("event: ping") > body.indexOf("event: mutation"));
  assert.equal(validationCalls, 3);
  assert.equal(maximumActiveValidations, 1);
  assert.equal(unsubscribeCount, 1);
  assert.equal(scopeCloseCount, 1);

  let immediateUnsubscribeCount = 0;
  const immediateRepository = {
    subscribe() {
      return () => {
        immediateUnsubscribeCount += 1;
      };
    },
    async snapshot() {
      return {
        metadata: initialMetadata,
        offset: 0,
        limit: 1,
        items: []
      };
    }
  };
  const immediateApp = new Hono();
  immediateApp.get("/events", (context) => streamIngestionQueueEvents(context, {
    repository: immediateRepository as never,
    tokens,
    session,
    queue: "upload",
    validateSession: async () => session,
    authenticationHeartbeatMs: 60_000,
    actionScopes: actionScopes as never
  }));
  const immediateResponse = await immediateApp.request("/events");
  const reader = immediateResponse.body!.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /event: ready/u);
  assert.equal(closeAdminSessionConnections([session.id]), 1);
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
  }
  assert.equal(immediateUnsubscribeCount, 1);
  assert.equal(scopeCloseCount, 2);
  assert.equal(closeAdminSessionConnections([session.id]), 0);

  let validationStarted!: () => void;
  let resolveValidation!: (value: typeof session) => void;
  const validationStart = new Promise<void>((resolve) => {
    validationStarted = resolve;
  });
  const validationResult = new Promise<typeof session>((resolve) => {
    resolveValidation = resolve;
  });
  let raceSubscribeCount = 0;
  const raceApp = new Hono();
  raceApp.get("/events", (context) => streamIngestionQueueEvents(context, {
    repository: {
      subscribe() {
        raceSubscribeCount += 1;
        return () => undefined;
      },
      async snapshot() {
        return {
          metadata: initialMetadata,
          offset: 0,
          limit: 0,
          items: []
        };
      }
    } as never,
    tokens,
    session,
    queue: "upload",
    validateSession: async () => {
      validationStarted();
      return validationResult;
    },
    authenticationHeartbeatMs: 60_000,
    actionScopes: actionScopes as never
  }));
  const raceResponse = await raceApp.request("/events");
  const raceBody = raceResponse.text();
  await validationStart;
  assert.equal(
    closeAdminSessionConnections([session.id]),
    1,
    "验权在途期间的登出也必须命中已登记连接"
  );
  assert.equal(await Promise.race([
    raceBody.then(() => true),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 100);
      timer.unref();
    })
  ]), true, "在途验权不结束也必须立即关闭 SSE 响应");
  assert.equal(raceSubscribeCount, 0);
  assert.equal(scopeCloseCount, 2);
  assert.equal(closeAdminSessionConnections([session.id]), 0);
  resolveValidation(session);
});
