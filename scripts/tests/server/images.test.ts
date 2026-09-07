import "../support/server-environment.ts";
import assert from "node:assert/strict";
import {
  randomUUID
} from "node:crypto";
import {
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import {
  join
} from "node:path";
import {
  setTimeout as delay
} from "node:timers/promises";
import test from "node:test";
import {
  createTestDirectory
} from "../support/test-directory.ts";
import {
  Hono
} from "hono";
import ipaddr from "ipaddr.js";
import sharp from "sharp";
import {
  adminApiBasePath,
  detectDeviceFromUserAgent
} from "../../../packages/shared/src/browser.ts";
import {
  getIngestionMaxLongEdge,
  parseSettingsInput
} from "../../../packages/server/src/config/app-settings.ts";
import {
  initializeRuntimeConfig
} from "../../../packages/server/src/config/runtime-config-store.ts";
import {
  ApiError
} from "../../../packages/server/src/core/api-error.ts";
import {
  imageActionInput,
  imagePurgeInput,
  imageSnapshotInput,
  imageStorageMigrationInput,
  imageUpdateInput
} from "../../../packages/server/src/routes/validation/images.ts";
import {
  ingestionCommitIntentInput,
  ingestionQueueActionInput,
  ingestionSessionUpdateInput,
  ingestionStatusInput,
  importAcceptInput,
  uploadIntentInput
} from "../../../packages/server/src/routes/validation/ingestion.ts";
import {
  parse
} from "../../../packages/server/src/routes/validation/parse.ts";
import {
  storageBackendCreateInput,
  storageBackendMigrationInput,
  storageBackendTestInput,
  storageBackendUpdateInput
} from "../../../packages/server/src/routes/validation/storage.ts";
import {
  isHttpsUrl,
  isRootRelativeOrHttpsUrl
} from "../../../packages/server/src/core/url-validation.ts";
import {
  createExternalImageLookup,
  externalImageLookupErrorCode
} from "../../../packages/server/src/core/external-image-lookup.ts";
import {
  DynamicConcurrencyLimiter,
  DynamicWeightedLimiter
} from "../../../packages/server/src/core/concurrency.ts";
import {
  immutableCacheControl,
  noStoreCacheControl,
  privateNoStoreCacheControl,
  publicProxyImageCacheControl,
  publicRedirectCacheControl
} from "../../../packages/server/src/core/http/headers.ts";
import {
  handleApiError
} from "../../../packages/server/src/core/http/responses.ts";
import {
  deviceFromDimensions,
  resolveClassification
} from "../../../packages/server/src/images/classification.ts";
import {
  decodeImageCursor,
  encodeImageCursor
} from "../../../packages/server/src/images/cursor.ts";
import {
  createImageFilterPlan,
  imageFilterPlanHasAllAxes,
  imageFilterPlanWithout
} from "../../../packages/server/src/images/filter-plan.ts";
import {
  createPageWindow
} from "../../../packages/server/src/images/page-window.ts";
import {
  createImageId,
  parseImageTime
} from "../../../packages/server/src/images/image-time.ts";
import {
  servePublicStoredObject,
  servePublicStoredThumbnail
} from "../../../packages/server/src/images/stored-image-serving.ts";
import {
  serveAdminExternalOriginal,
  servePublicExternalOriginal
} from "../../../packages/server/src/images/external-original-serving.ts";
import {
  configureSharpRuntime,
  md5Buffer,
  transcodeStoredImage,
  type StoredImageTranscodeSettings
} from "../../../packages/server/src/images/processing.ts";
import {
  buildImageFilterSql
} from "../../../packages/server/src/images/read-models/image-filter-sql.ts";
import {
  fetchAdminImageOffsetRows,
  fetchPublicImageCardPage
} from "../../../packages/server/src/images/read-models/pagination.ts";
import {
  readyImageMember,
  serializeReadyImageCacheItem
} from "../../../packages/server/src/images/ready-cache/model.ts";
import {
  readReadyImageOrderedWindow,
  type ReadyImageWindowDependencies
} from "../../../packages/server/src/images/ready-cache/ordered-window.ts";
import {
  isRedisUnavailableError
} from "../../../packages/server/src/core/runtime-availability.ts";
import {
  normalizeRandomQuery,
  parseRandomQuery,
  type ParsedRandomQuery,
  type RandomSelectorMaps
} from "../../../packages/server/src/random/query.ts";
import {
  resolveCandidateAxes
} from "../../../packages/server/src/random/selection-model.ts";
import {
  registerAdminImageRoutes
} from "../../../packages/server/src/routes/admin-images.ts";
import {
  registerPublicRoutes
} from "../../../packages/server/src/routes/public.ts";
import {
  imageId,
  servingReadyCacheItem
} from "../support/server-test-context.ts";

test("[Server/图片] 输入校验统一图片更新、标签归一化、图片列表唯一性和 issue path", () => {
  const metadataId = randomUUID();
  assert.equal(
    imageUpdateInput.safeParse({
      items: [{ id: metadataId, source: "https://example.com/post/1" }]
    }).success,
    true
  );
  assert.equal(
    imageUpdateInput.safeParse({
      items: [{ id: metadataId, source: "javascript:alert(1)" }]
    }).success,
    false
  );
  assert.equal(imageUpdateInput.safeParse({
    items: [{ id: metadataId }]
  }).success, false);
  assert.equal(imageUpdateInput.safeParse({
    items: [{
      id: metadataId,
      title: "有效字段",
      unknown_title: "未知字段"
    }]
  }).success, false);
  assert.equal(storageBackendUpdateInput.safeParse({}).success, false);
  assert.equal(storageBackendUpdateInput.safeParse({ s3: {} }).success, false);
  assert.equal(storageBackendUpdateInput.safeParse({ unsupported: {} }).success, false);
  assert.equal(storageBackendCreateInput.safeParse({
    slug: "archive",
    s3: {}
  }).success, true);
  assert.equal(storageBackendCreateInput.safeParse({
    slug: "archive",
    type: "s3",
    s3: {}
  }).success, false);
  assert.equal(storageBackendCreateInput.safeParse({
    slug: "archive",
    unsupported: {}
  }).success, false);
  assert.throws(
    () => parse(storageBackendCreateInput, { slug: "" }),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "validation_error");
      assert.equal(
        error.message,
        "Too small: expected string to have >=1 characters；"
          + "Invalid string: must match pattern "
          + "/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/"
      );
      assert.deepEqual(error.details, {
        formErrors: [],
        fieldErrors: {
          slug: [
            "Too small: expected string to have >=1 characters",
            "Invalid string: must match pattern "
              + "/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/"
          ]
        }
      });
      return true;
    }
  );
  assert.equal(storageBackendUpdateInput.safeParse({
    display_name: "对象存储",
    unknown_option: true
  }).success, false);
  assert.equal(storageBackendTestInput.safeParse({}).success, false);
  assert.equal(storageBackendTestInput.safeParse({ slug: "archive" }).success, true);
  assert.equal(storageBackendTestInput.safeParse({ s3: {} }).success, true);
  assert.throws(
    () => parse(storageBackendTestInput, { slug: "bad_slug" }),
    (error) => error instanceof ApiError
      && error.status === 400
      && error.code === "validation_error"
      && error.message === (
        "Invalid string: must match pattern "
          + "/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/"
      )
      && JSON.stringify(error.details) === JSON.stringify({
        formErrors: [],
        fieldErrors: {
          slug: [
            "Invalid string: must match pattern "
              + "/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/"
          ]
        }
      })
  );
  assert.equal(storageBackendTestInput.safeParse({
    type: "s3",
    s3: { unknown_option: true }
  }).success, false);
  assert.throws(() => parseSettingsInput({}));
  assert.throws(() => parseSettingsInput({ site: {} }));
  assert.throws(() => parseSettingsInput({ site: { home: {} } }));
  assert.throws(() => parseSettingsInput({ site: { gallery: {} } }));
  assert.throws(() => parseSettingsInput({ unknown_group: true }));
  assert.equal(parseSettingsInput({ site: { root: "gallery" } }).site?.root, "gallery");
  assert.equal(
    parseSettingsInput({ ingestion: { list_page_size: 100 } })
      .ingestion?.list_page_size,
    100
  );
  assert.throws(() => parseSettingsInput({ ingestion: { list_page_size: 101 } }));
  assert.equal(
    parseSettingsInput({ ingestion: { commit_concurrency: 16 } })
      .ingestion?.commit_concurrency,
    16
  );
  assert.throws(() => parseSettingsInput({ ingestion: { commit_concurrency: 17 } }));
  assert.throws(() => parseSettingsInput({ upload: { list_page_size: 20 } }));
  assert.throws(() => parseSettingsInput({ import: { keep_original_link: [] } }));
  assert.throws(() => parseSettingsInput({ import: { auto_import: false } }));
  assert.throws(() => parseSettingsInput({ weibo: { source_enabled: false } }));
  assert.throws(() => parseSettingsInput({ normalize: { quality_step: 10 } }));
  assert.throws(() => parseSettingsInput({
    site: { unknown_site_key: "gallery" }
  }));
  assert.equal(isHttpsUrl("https://example.com/image.jpg", { requireDomain: true }), true);
  assert.equal(isHttpsUrl("https://127.0.0.1/image.jpg", { requireDomain: true }), false);
  assert.equal(isRootRelativeOrHttpsUrl("/random?mode=redirect"), true);
  assert.equal(isRootRelativeOrHttpsUrl("//evil.example.com"), false);

  const validUpdate = imageUpdateInput.parse({
    items: [{ id: imageId.toUpperCase(), title: "最终标题", tags: [" Stage ", "stage"] }]
  });
  assert.equal(validUpdate.items[0]?.id, imageId);
  assert.deepEqual(validUpdate.items[0]?.tags, ["stage"]);
  assert.equal(imageUpdateInput.safeParse({ items: [{ id: imageId }] }).success, false);
  assert.equal(imageUpdateInput.safeParse({
    items: [{ id: imageId, title: "a", removed_field: true }]
  }).success, false);
  const duplicateUpdate = imageUpdateInput.safeParse({
    items: [
      { id: imageId, title: "a" },
      { id: imageId.toUpperCase(), title: "b" }
    ]
  });
  assert.equal(duplicateUpdate.success, false);
  if (!duplicateUpdate.success) {
    assert.deepEqual(duplicateUpdate.error.issues[0]?.path, ["items", 1, "id"]);
  }
  const invalidUpdateId = imageUpdateInput.safeParse({
    items: [{ id: "not-a-uuid", title: "a" }]
  });
  assert.equal(invalidUpdateId.success, false);
  if (!invalidUpdateId.success) {
    assert.deepEqual(invalidUpdateId.error.issues[0]?.path, ["items", 0, "id"]);
  }
  const secondImageId = "019f8457-063a-7002-a580-7a432dc7fd8e";
  assert.equal(imageSnapshotInput.safeParse({ ids: [imageId] }).success, true);
  assert.equal(imageSnapshotInput.safeParse({
    ids: [imageId, secondImageId]
  }).success, true);
  const duplicateSnapshot = imageSnapshotInput.safeParse({
    ids: [imageId, imageId.toUpperCase()]
  });
  assert.equal(duplicateSnapshot.success, false);
  if (!duplicateSnapshot.success) {
    assert.deepEqual(duplicateSnapshot.error.issues[0]?.path, ["ids", 1]);
  }
  assert.equal(imageActionInput.safeParse({ ids: [imageId] }).success, true);
  assert.equal(imageActionInput.safeParse({
    ids: [imageId, secondImageId]
  }).success, true);
  assert.equal(imageActionInput.safeParse({ ids: [] }).success, false);
  assert.equal(imageActionInput.safeParse({
    ids: [imageId, imageId.toUpperCase()]
  }).success, false);
  assert.equal(imagePurgeInput.safeParse({
    scope: "selected",
    ids: [imageId]
  }).success, true);
  assert.equal(imagePurgeInput.safeParse({ scope: "all" }).success, true);
  for (const invalidPurge of [
    { scope: "selected" },
    { scope: "selected", ids: [] },
    { scope: "selected", ids: [imageId, imageId.toUpperCase()] },
    { scope: "all", ids: [imageId] },
    { scope: "all", ids: null },
    { scope: "all", ids: "*" },
    { ids: [imageId] }
  ]) {
    assert.equal(imagePurgeInput.safeParse(invalidPurge).success, false);
  }
  assert.equal(imageStorageMigrationInput.safeParse({
    ids: [imageId],
    target: "archive"
  }).success, true);
  assert.equal(imageStorageMigrationInput.safeParse({
    ids: [imageId, imageId.toUpperCase()],
    target: "archive"
  }).success, false);
  assert.equal(storageBackendMigrationInput.safeParse({
    source: "local",
    target: "local"
  }).success, false);

  const tags50 = Array.from(
    { length: 50 },
    (_, index) => `tag-${String(index).padStart(2, "0")}`
  );
  const tags51 = [...tags50, "tag-50"];
  const repeatedTags = Array.from(
    { length: 51 },
    (_, index) => index % 2 ? " Stage " : "stage"
  );
  const commonIngestionMetadata = {
    device: "auto" as const,
    brightness: "auto" as const
  };
  const uploadItem = {
    ...commonIngestionMetadata,
    idempotency_key: imageId,
    batch_key: secondImageId,
    batch_position: 0,
    expected_size: 1024,
    max_long_edge: 4096
  };
  assert.equal(uploadIntentInput.safeParse({ items: [uploadItem] }).success, true);
  assert.equal(uploadIntentInput.parse({
    items: [{ ...uploadItem, idempotency_key: imageId.toUpperCase() }]
  }).items[0]?.idempotency_key, imageId);
  assert.equal(uploadIntentInput.safeParse({
    items: [{ ...uploadItem, expected_size: undefined }]
  }).success, false);
  assert.equal(uploadIntentInput.safeParse({
    items: [{ ...uploadItem, created_by: "forged-admin" }]
  }).success, false);
  const rejectedImportDownload = importAcceptInput.safeParse({
    items: [{
      ...commonIngestionMetadata,
      idempotency_key: imageId,
      batch_key: secondImageId,
      batch_position: 0,
      source_type: "url",
      download_url: "http://example.com/image.jpg"
    }]
  });
  assert.equal(rejectedImportDownload.success, false);
  if (!rejectedImportDownload.success) {
    assert.equal(
      rejectedImportDownload.error.issues.some((issue) => (
        issue.message === "外部图片请求未通过安全校验"
      )),
      true,
      "真正的 Import 下载入口必须保留既有安全拒绝提示"
    );
  }
  assert.equal(importAcceptInput.safeParse({
    items: [{
      ...commonIngestionMetadata,
      idempotency_key: imageId,
      batch_key: secondImageId,
      batch_position: 0,
      source_type: "url",
      download_url: "https://example.com/image.jpg"
    }]
  }).success, true);

  const uploadWithRepeatedTags = uploadIntentInput.parse({
    items: [{
      ...uploadItem,
      tags: repeatedTags,
      theme: " Theme-A ",
      author: " Author-A ",
      title: "  标题  "
    }]
  });
  assert.deepEqual(uploadWithRepeatedTags.items[0]?.tags, ["stage"]);
  assert.deepEqual(
    {
      theme: uploadWithRepeatedTags.items[0]?.theme,
      author: uploadWithRepeatedTags.items[0]?.author,
      title: uploadWithRepeatedTags.items[0]?.title
    },
    { theme: "theme-a", author: "author-a", title: "标题" }
  );
  assert.equal(uploadIntentInput.safeParse({
    items: [{ ...uploadItem, tags: tags50 }]
  }).success, true);
  assert.equal(uploadIntentInput.safeParse({
    items: [{ ...uploadItem, tags: tags51 }]
  }).success, false);
  assert.equal(imageUpdateInput.safeParse({
    items: [{ id: imageId, tags: tags50 }]
  }).success, true);
  assert.equal(imageUpdateInput.safeParse({
    items: [{ id: imageId, tags: tags51 }]
  }).success, false);

  const sessionId = "A".repeat(43);
  const unreachableDraft = ingestionSessionUpdateInput.parse({
    items: [{
      session_id: sessionId,
      image_id: imageId,
      expected_version: 1,
      metadata: {
        ...commonIngestionMetadata,
        original: " draft-image.invalid/image.jpg ",
        source: "draft-source.invalid/post"
      }
    }]
  });
  assert.deepEqual(
    {
      original: unreachableDraft.items[0]?.metadata?.original,
      source: unreachableDraft.items[0]?.metadata?.source
    },
    {
      original: "https://draft-image.invalid/image.jpg",
      source: "https://draft-source.invalid/post"
    },
    "草稿 URL 只做同步格式归一，不应要求保留域名可解析或可连接"
  );
  assert.equal(ingestionSessionUpdateInput.safeParse({
    items: [{
      session_id: sessionId,
      image_id: imageId,
      expected_version: 1,
      metadata: {
        ...commonIngestionMetadata,
        source: "https://127.0.0.1/source"
      }
    }]
  }).success, true, "来源 URL 保留既有的 HTTPS IP 格式接受范围");
  for (const [field, value, message] of [
    ["original", "http://example.com/image.jpg", "内容接入草稿原图 URL 格式无效"],
    ["original", "https://127.0.0.1/image.jpg", "内容接入草稿原图 URL 格式无效"],
    ["source", "https://user:password@example.com/post", "内容接入草稿来源 URL 格式无效"],
    ["source", "x".repeat(2_049), "内容接入草稿来源 URL 格式无效"]
  ] as const) {
    const rejectedDraft = ingestionSessionUpdateInput.safeParse({
      items: [{
        session_id: sessionId,
        image_id: imageId,
        expected_version: 1,
        metadata: { ...commonIngestionMetadata, [field]: value }
      }]
    });
    assert.equal(rejectedDraft.success, false);
    if (!rejectedDraft.success) {
      assert.equal(rejectedDraft.error.issues.some((issue) => issue.message === message), true);
      assert.equal(
        rejectedDraft.error.issues.some((issue) => (
          issue.message === "外部图片请求未通过安全校验"
        )),
        false,
        "草稿纯格式失败不得冒充外部图片安全请求失败"
      );
    }
  }
  const commitBinding = {
    session_id: sessionId,
    image_id: imageId,
    expected_version: 1,
    expected_md5: "a".repeat(32),
    commit_request_id: secondImageId,
    duplicate_decision: "upload" as const
  };
  const commitWithRepeatedTags = ingestionCommitIntentInput.parse({
    items: [{
      ...commitBinding,
      image_id: imageId.toUpperCase(),
      metadata: {
        device: "auto",
        brightness: "auto",
        tags: repeatedTags,
        theme: " Theme-A ",
        author: " Author-A ",
        title: "  标题  "
      }
    }]
  });
  assert.equal(commitWithRepeatedTags.items[0]?.image_id, imageId);
  assert.deepEqual(commitWithRepeatedTags.items[0]?.metadata.tags, ["stage"]);
  assert.deepEqual(
    {
      theme: commitWithRepeatedTags.items[0]?.metadata.theme,
      author: commitWithRepeatedTags.items[0]?.metadata.author,
      title: commitWithRepeatedTags.items[0]?.metadata.title
    },
    { theme: "theme-a", author: "author-a", title: "标题" }
  );
  assert.equal(ingestionCommitIntentInput.safeParse({
    items: [{
      ...commitBinding,
      metadata: { device: "auto", brightness: "auto", tags: tags50 }
    }]
  }).success, true);
  assert.equal(ingestionCommitIntentInput.safeParse({
    items: [{
      ...commitBinding,
      metadata: { device: "auto", brightness: "auto", tags: tags51 }
    }]
  }).success, false);
  const boundedCompletedCleanup = {
    queue: "import",
    action_request_id: secondImageId,
    action: "clear_completed",
    action_watermark: "signed-watermark",
    max_semantic_revision: 117
  };
  assert.equal(
    ingestionQueueActionInput.safeParse(boundedCompletedCleanup).success,
    true
  );
  assert.equal(ingestionQueueActionInput.safeParse({
    ...boundedCompletedCleanup,
    action: "clear_queue"
  }).success, false, "semantic revision 上限只允许关闭时清理完成态");
  const invalidCommitId = ingestionCommitIntentInput.safeParse({
    items: [{
      ...commitBinding,
      image_id: "not-a-uuid",
      metadata: { device: "auto", brightness: "auto" }
    }]
  });
  assert.equal(invalidCommitId.success, false);
  if (!invalidCommitId.success) {
    assert.deepEqual(invalidCommitId.error.issues[0]?.path, ["items", 0, "image_id"]);
  }
  const duplicateCommit = ingestionCommitIntentInput.safeParse({
    items: [
      {
        ...commitBinding,
        metadata: { device: "auto", brightness: "auto" }
      },
      {
        ...commitBinding,
        image_id: imageId.toUpperCase(),
        commit_request_id: "019f8457-063a-7003-a580-7a432dc7fd8e",
        metadata: { device: "auto", brightness: "auto" }
      }
    ]
  });
  assert.equal(duplicateCommit.success, false);
  if (!duplicateCommit.success) {
    assert.deepEqual(duplicateCommit.error.issues[0]?.path, ["items", 1, "session_id"]);
  }
  for (const [field, value] of [
    ["commit_request_id", "not-a-uuid"],
    ["expected_md5", "A".repeat(32)],
    ["duplicate_decision", "skip"]
  ] as const) {
    const invalidBinding = ingestionCommitIntentInput.safeParse({
      items: [{
        ...commitBinding,
        [field]: value,
        metadata: { device: "auto", brightness: "auto" }
      }]
    });
    assert.equal(invalidBinding.success, false, field);
    if (!invalidBinding.success) {
      assert.deepEqual(invalidBinding.error.issues[0]?.path, ["items", 0, field]);
    }
  }
  assert.equal(ingestionStatusInput.safeParse({
    items: [{ session_id: sessionId, image_id: imageId }]
  }).success, true);
  assert.equal(ingestionStatusInput.safeParse({
    items: [
      { session_id: sessionId, image_id: imageId },
      { session_id: sessionId, image_id: imageId.toUpperCase() }
    ]
  }).success, false);
});
test("[Server/图片] 图片 1..N 路由拒绝越权、重复 ID 与错误正文层级", async () => {
  const app = new Hono<{
    Variables: { session: { role: "super" | "image" } };
  }>();
  app.onError((error, context) => handleApiError(context, error));
  app.use(`${adminApiBasePath}/*`, async (context, next) => {
    const role = context.req.header("x-test-role");
    if (role === "super" || role === "image") {
      context.set("session", { role });
    }
    await next();
  });
  registerAdminImageRoutes(app as unknown as Hono);
  registerPublicRoutes(app as unknown as Hono);

  const post = (
    path: string,
    body: string,
    role: "super" | "image" = "super"
  ) => app.request(new Request(`http://imageshow.test${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-test-role": role
    },
    body
  }));
  const jsonBody = (value: unknown) => JSON.stringify(value);

  for (const query of [
    "cursor=opaque",
    "offset=60",
    "unknown=true",
    "page=0",
    "page=-1",
    "page=1.5",
    `page=${Number.MAX_SAFE_INTEGER}&limit=2`
  ]) {
    const response = await app.request(new Request(
      `http://imageshow.test${adminApiBasePath}/images?${query}`,
      { headers: { "x-test-role": "super" } }
    ));
    assert.equal(response.status, 400);
    assert.equal(
      (await response.json() as { code?: string }).code,
      "validation_error"
    );
  }

  for (const query of [
    "page=2",
    "offset=60",
    "unknown=true"
  ]) {
    const response = await app.request(new Request(
      `http://imageshow.test/api/images?${query}`
    ));
    assert.equal(response.status, 400);
    assert.equal(
      (await response.json() as { code?: string }).code,
      "validation_error"
    );
  }

  const duplicateIds = [imageId, imageId.toUpperCase()];
  const snapshotDuplicate = await post(
    `${adminApiBasePath}/images/snapshot`,
    jsonBody({ ids: duplicateIds })
  );
  assert.equal(snapshotDuplicate.status, 400);
  assert.equal(
    (await snapshotDuplicate.json() as { code?: string }).code,
    "validation_error"
  );

  const updateDuplicate = await post(
    `${adminApiBasePath}/images/update`,
    jsonBody({
      items: duplicateIds.map((id, index) => ({ id, title: `title-${index}` }))
    })
  );
  assert.equal(updateDuplicate.status, 400);

  for (const action of ["trash", "restore"]) {
    const duplicate = await post(
      `${adminApiBasePath}/images/${action}`,
      jsonBody({ ids: duplicateIds })
    );
    assert.equal(duplicate.status, 400);
    assert.equal(
      (await duplicate.json() as { code?: string }).code,
      "validation_error"
    );
  }

  assert.equal((await post(
    `${adminApiBasePath}/images/delete`,
    jsonBody({ ids: [imageId] })
  )).status, 404);
  for (const suffix of ["raw", "thumb"]) {
    assert.equal((await app.request(
      `http://imageshow.test${adminApiBasePath}/images/${imageId}/${suffix}`,
      { headers: { "x-test-role": "super" } }
    )).status, 404);
  }

  const purgeForbidden = await post(
    `${adminApiBasePath}/images/purge`,
    jsonBody({ scope: "all" }),
    "image"
  );
  assert.equal(purgeForbidden.status, 403);
  assert.equal(
    (await purgeForbidden.json() as { code?: string }).code,
    "forbidden"
  );
  for (const invalidPurge of [
    { scope: "selected" },
    { scope: "selected", ids: [] },
    { scope: "selected", ids: duplicateIds },
    { scope: "all", ids: [imageId] },
    { scope: "all", ids: null },
    { scope: "all", ids: "*" },
    { ids: [imageId] }
  ]) {
    const response = await post(
      `${adminApiBasePath}/images/purge`,
      jsonBody(invalidPurge)
    );
    assert.equal(response.status, 400);
  }

  const migrationForbidden = await post(
    `${adminApiBasePath}/images/migrate-storage`,
    jsonBody({ ids: [imageId], target: "archive" }),
    "image"
  );
  assert.equal(migrationForbidden.status, 403);
  assert.equal(
    (await migrationForbidden.json() as { code?: string }).code,
    "forbidden"
  );

  const migrationDuplicate = await post(
    `${adminApiBasePath}/images/migrate-storage`,
    jsonBody({ ids: duplicateIds, target: "archive" })
  );
  assert.equal(migrationDuplicate.status, 400);

  const aboveStandardTier = await post(
    `${adminApiBasePath}/images/update`,
    jsonBody({
      items: [{ id: imageId, title: "valid", extra: "x".repeat(160 * 1024) }]
    })
  );
  assert.equal(aboveStandardTier.status, 400);
  assert.equal(
    (await aboveStandardTier.json() as { code?: string }).code,
    "validation_error"
  );

  const aboveImageUpdateTier = await post(
    `${adminApiBasePath}/images/update`,
    jsonBody({
      items: [{ id: imageId, title: "valid", extra: "x".repeat(6 * 1024 * 1024) }]
    })
  );
  assert.equal(aboveImageUpdateTier.status, 413);
  assert.equal(
    (await aboveImageUpdateTier.json() as { code?: string }).code,
    "request_body_too_large"
  );
});
test("[Server/图片] 外部图片 DNS 地址策略保持严格解析、最长前缀与回调契约", async () => {
  type RawLookup = (
    hostname: string,
    options: { all?: boolean; family?: number },
    callback: (...args: unknown[]) => void
  ) => void;
  const invokeLookup = (
    lookup: ReturnType<typeof createExternalImageLookup>,
    options: { all?: boolean; family?: number } = {},
    hostname = "images.fixture.example"
  ) => new Promise<unknown[]>((resolve) => {
    (lookup as unknown as RawLookup)(hostname, options, (...args) => resolve(args));
  });
  const addressAllowed = async (address: string, family: number) => {
    const lookup = createExternalImageLookup(async () => [{ address, family }]);
    const [error] = await invokeLookup(lookup);
    return error === null;
  };
  const bytesToValue = (bytes: number[]) => bytes.reduce(
    (value, byte) => (value << 8n) | BigInt(byte),
    0n
  );
  const valueToBytes = (input: bigint, length: number) => {
    let value = input;
    const bytes = Array.from({ length }, () => 0);
    for (let index = length - 1; index >= 0; index -= 1) {
      bytes[index] = Number(value & 255n);
      value >>= 8n;
    }
    return bytes;
  };
  const cidrBoundaryAddresses = (cidr: string) => {
    const [base, prefixLength] = ipaddr.parseCIDR(cidr);
    const baseBytes = base.toByteArray();
    const totalBits = BigInt(baseBytes.length * 8);
    const hostBits = totalBits - BigInt(prefixLength);
    const rangeSize = 1n << hostBits;
    const rangeStart = (bytesToValue(baseBytes) >> hostBits) << hostBits;
    const rangeEnd = rangeStart + rangeSize - 1n;
    const maximum = (1n << totalBits) - 1n;
    return [
      rangeStart > 0n ? rangeStart - 1n : null,
      rangeStart,
      rangeEnd,
      rangeEnd < maximum ? rangeEnd + 1n : null
    ].map((value) => value === null
      ? null
      : ipaddr.fromByteArray(valueToBytes(value, baseBytes.length)).toString());
  };

  const ipv4BoundaryExpectations: Readonly<
    Record<string, readonly (boolean | null)[]>
  > = {
    "224.0.0.0/4": [true, false, false, false],
    "0.0.0.0/8": [null, false, false, true],
    "0.0.0.0/32": [null, false, false, false],
    "10.0.0.0/8": [true, false, false, true],
    "100.64.0.0/10": [true, false, false, true],
    "127.0.0.0/8": [true, false, false, true],
    "169.254.0.0/16": [true, false, false, true],
    "172.16.0.0/12": [true, false, false, true],
    "192.0.0.0/24": [true, false, false, true],
    "192.0.0.0/29": [true, false, false, false],
    "192.0.0.8/32": [false, false, false, true],
    "192.0.0.9/32": [false, true, true, true],
    "192.0.0.10/32": [true, true, true, false],
    "192.0.0.170/32": [false, false, false, false],
    "192.0.0.171/32": [false, false, false, false],
    "192.0.2.0/24": [true, false, false, true],
    "192.31.196.0/24": [true, true, true, true],
    "192.52.193.0/24": [true, true, true, true],
    "192.88.99.0/24": [true, false, false, true],
    "192.88.99.2/32": [false, false, false, false],
    "192.168.0.0/16": [true, false, false, true],
    "192.175.48.0/24": [true, true, true, true],
    "198.18.0.0/15": [true, false, false, true],
    "198.51.100.0/24": [true, false, false, true],
    "203.0.113.0/24": [true, false, false, true],
    "240.0.0.0/4": [false, false, false, null],
    "255.255.255.255/32": [false, false, false, null]
  };
  const ipv6BoundaryExpectations: Readonly<
    Record<string, readonly (boolean | null)[]>
  > = {
    "::/96": [null, false, false, false],
    "::/128": [null, false, false, false],
    "::1/128": [false, false, false, false],
    "::ffff:0:0/96": [false, false, false, false],
    "64:ff9b::/96": [false, false, false, false],
    "64:ff9b:1::/48": [false, false, false, false],
    "100::/64": [false, false, false, false],
    "100:0:0:1::/64": [false, false, false, false],
    "2000::/3": [false, true, true, false],
    "2001::/23": [true, false, false, true],
    "2001::/32": [true, false, false, false],
    "2001:1::1/128": [false, true, true, true],
    "2001:1::2/128": [true, true, true, true],
    "2001:1::3/128": [true, true, true, false],
    "2001:2::/48": [false, false, false, false],
    "2001:3::/32": [false, true, true, false],
    "2001:4:112::/48": [false, true, true, false],
    "2001:10::/28": [false, false, false, true],
    "2001:20::/28": [false, true, true, true],
    "2001:30::/28": [true, true, true, false],
    "2001:db8::/32": [true, false, false, true],
    "2002::/16": [true, false, false, true],
    "2620:4f:8000::/48": [true, true, true, true],
    "3fff::/20": [true, false, false, true],
    "5f00::/16": [false, false, false, false],
    "fc00::/7": [false, false, false, false],
    "fe80::/10": [false, false, false, false],
    "ff00::/8": [false, false, false, null]
  };

  for (const [cidr, expected] of Object.entries(ipv4BoundaryExpectations)) {
    const actual = await Promise.all(cidrBoundaryAddresses(cidr).map((address) => (
      address === null ? null : addressAllowed(address, 4)
    )));
    assert.deepEqual(actual, expected, `IPv4 boundary ${cidr}`);
  }
  for (const [cidr, expected] of Object.entries(ipv6BoundaryExpectations)) {
    const actual = await Promise.all(cidrBoundaryAddresses(cidr).map((address) => (
      address === null ? null : addressAllowed(address, 6)
    )));
    assert.deepEqual(actual, expected, `IPv6 boundary ${cidr}`);
  }

  const addressCases = [
    ["8.8.8.8", 4, true],
    ["192.0.0.9", 4, true],
    ["10.0.0.1", 4, false],
    ["127.1", 4, false],
    ["0x7f.0.0.1", 4, false],
    ["0177.0.0.1", 4, false],
    ["2130706433", 4, false],
    ["192.168.001.001", 4, false],
    ["256.0.0.1", 4, false],
    ["8.8.8.8", 6, false],
    ["2606:4700:4700::1111", 6, true],
    ["2001:1::1", 6, true],
    ["2001:db8::1", 6, false],
    ["4000::1", 6, false],
    ["2606:4700:4700::1111%eth0", 6, false],
    ["2001:db8::1::1", 6, false],
    ["2606:4700:4700::1111", 4, false],
    ["::8.8.8.8", 6, false],
    ["::192.0.0.9", 6, false],
    ["0:0:0:0:0:0:8.8.8.8", 6, false],
    ["::ffff:8.8.8.8", 6, true],
    ["::ffff:10.0.0.1", 6, false],
    ["::ffff:808:808", 6, true],
    ["::ffff:a00:1", 6, false],
    ["64:ff9b::8.8.8.8", 6, true],
    ["64:ff9b::10.0.0.1", 6, false],
    ["64:ff9b::808:808", 6, true],
    ["64:ff9b::a00:1", 6, false],
    ["64:ff9b:1::808:808", 6, false]
  ] as const;
  for (const [address, family, expected] of addressCases) {
    assert.equal(await addressAllowed(address, family), expected, address);
  }

  const safeAddresses = [
    { address: "8.8.8.8", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 }
  ];
  let resolverStarted = false;
  const lookup = createExternalImageLookup(async (hostname) => {
    resolverStarted = true;
    assert.equal(hostname, "images.fixture.example");
    return safeAddresses;
  });
  const allResultPromise = invokeLookup(lookup, { all: true });
  assert.equal(resolverStarted, false);
  assert.deepEqual(await allResultPromise, [null, safeAddresses]);
  assert.deepEqual(await invokeLookup(lookup, { family: 6 }), [
    null,
    "2606:4700:4700::1111",
    6
  ]);

  const blockedMix = createExternalImageLookup(async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "fd00::1", family: 6 }
  ]);
  const blockedArgs = await invokeLookup(blockedMix, { family: 4 });
  assert.ok(blockedArgs[0] instanceof Error);
  assert.equal((blockedArgs[0] as NodeJS.ErrnoException).code, externalImageLookupErrorCode);
  assert.equal((blockedArgs[0] as Error).message, "Blocked external image address");
  assert.deepEqual(blockedArgs.slice(1), ["", 0]);

  const missingFamily = createExternalImageLookup(async () => [safeAddresses[0]]);
  const missingFamilyArgs = await invokeLookup(missingFamily, { family: 6 });
  assert.ok(missingFamilyArgs[0] instanceof Error);
  assert.equal(
    (missingFamilyArgs[0] as NodeJS.ErrnoException).code,
    externalImageLookupErrorCode
  );
  assert.equal(
    (missingFamilyArgs[0] as Error).message,
    "No external image address for requested family"
  );
  assert.deepEqual(missingFamilyArgs.slice(1), ["", 0]);

  const emptyArgs = await invokeLookup(createExternalImageLookup(async () => []));
  assert.ok(emptyArgs[0] instanceof Error);
  assert.equal((emptyArgs[0] as NodeJS.ErrnoException).code, externalImageLookupErrorCode);
  assert.equal((emptyArgs[0] as Error).message, "Blocked external image address");
  assert.deepEqual(emptyArgs.slice(1), ["", 0]);

  const dnsCause = new Error("fixture resolver failure");
  const failedDnsArgs = await invokeLookup(createExternalImageLookup(async () => {
    throw dnsCause;
  }));
  assert.ok(failedDnsArgs[0] instanceof Error);
  assert.equal((failedDnsArgs[0] as NodeJS.ErrnoException).code, externalImageLookupErrorCode);
  assert.equal((failedDnsArgs[0] as Error).message, "External image DNS lookup failed");
  assert.equal((failedDnsArgs[0] as Error).cause, dnsCause);
  assert.deepEqual(failedDnsArgs.slice(1), ["", 0]);
});
test("[Server/图片] stored serving 的缩略图读取严格只读并保留真实错误语义", async () => {
  const item = servingReadyCacheItem();
  const record = {
    id: item.id,
    object_key: item.object_key,
    original: item.original,
    ext: item.ext,
    storage_slug: item.storage_slug,
    device: item.device,
    brightness: item.brightness,
    theme: item.theme,
    status: "ready" as const,
    description: item.description,
    source: item.source,
    updated_at: item.updated_at
  };
  const request = {
    range: "bytes=1-2",
    ifNoneMatch: '"fixture"',
    ifModifiedSince: "Sun, 10 Aug 2026 00:00:00 GMT",
    ifRange: '"fixture"',
    isHead: true,
    signal: new AbortController().signal
  };
  const assertForwardedRequest = (actual: unknown) => {
    const forwarded = actual as typeof request;
    const { signal: forwardedSignal, ...forwardedFields } = forwarded;
    const { signal: _requestSignal, ...expectedFields } = request;
    assert.deepEqual(forwardedFields, expectedFields);
    assert.equal(forwardedSignal.aborted, false);
  };
  const streamCalls: Array<{
    object: Record<string, unknown>;
    contentType: string;
    cacheControl: string;
    request: unknown;
  }> = [];
  const storedBytes = Buffer.from("stable-stored-serving-bytes");
  let thumbnailExistsCalls = 0;
  let servingRecord: Omit<typeof record, "status" | "storage_slug"> & {
    status: "ready" | "deleted";
    storage_slug: string;
  } = record;
  const resolvedObject = (
    prefix: "full" | "thumbs",
    key: string,
    publicUrl = "",
    storageSlug = "local"
  ) => ({
    prefix,
    key,
    storageSlug,
    publicUrl,
    exists: async () => {
      thumbnailExistsCalls += 1;
      return true;
    },
    open: async () => {
      throw new Error("stream mock owns the read");
    }
  });
  const baseDependencies = {
    readImageServingRecordByObjectKey: async () => servingRecord,
    readImageServingRecordByThumbKey: async () => servingRecord,
    resolveReadableObject: async (
      prefix: "full" | "thumbs",
      key: string,
      backend: string
    ) => resolvedObject(prefix, key, "", backend),
    streamResolvedObject: async (
      object: Record<string, unknown>,
      contentTypeValue: string,
      cacheControl: string,
      forwardedRequest: unknown
    ) => {
      streamCalls.push({
        object,
        contentType: contentTypeValue,
        cacheControl,
        request: forwardedRequest
      });
      return new Response(storedBytes, { status: 206 });
    }
  };

  const objectResponse = await servePublicStoredObject(
    item.object_key,
    request,
    baseDependencies as never
  );
  assert.equal(objectResponse.status, 206);
  assert.equal(streamCalls[0]?.object.prefix, "full");
  assert.equal(streamCalls[0]?.contentType, "image/jpeg");
  assert.equal(streamCalls[0]?.cacheControl, immutableCacheControl);
  assertForwardedRequest(streamCalls[0]?.request);

  const getRequest = { ...request, isHead: false };
  for (const state of [
    { status: "ready" as const, storage_slug: "local" },
    { status: "deleted" as const, storage_slug: "local" },
    { status: "deleted" as const, storage_slug: "s3-private" },
    { status: "ready" as const, storage_slug: "s3-private" }
  ]) {
    servingRecord = { ...record, ...state };
    const stableResponse = await servePublicStoredObject(
      item.object_key,
      getRequest,
      baseDependencies as never
    );
    assert.deepEqual(
      Buffer.from(await stableResponse.arrayBuffer()),
      storedBytes
    );
    assert.equal(streamCalls.at(-1)?.object.storageSlug, state.storage_slug);
    assert.equal(streamCalls.at(-1)?.cacheControl, immutableCacheControl);
  }
  servingRecord = { ...record, status: "deleted", storage_slug: "s3-public" };

  const redirectResponse = await servePublicStoredObject(
    item.object_key,
    request,
    {
      ...baseDependencies,
      resolveReadableObject: async (
        prefix: "full" | "thumbs",
        key: string
      ) =>
        resolvedObject(
          prefix,
          key,
          "https://cdn.example.com/full/image.jpg",
          "s3-public"
        )
    } as never
  );
  assert.equal(redirectResponse.status, 302);
  assert.equal(
    redirectResponse.headers.get("Location"),
    "https://cdn.example.com/full/image.jpg"
  );
  assert.equal(
    redirectResponse.headers.get("Cache-Control"),
    publicRedirectCacheControl
  );
  servingRecord = record;

  streamCalls.length = 0;
  const thumbnailResponse = await servePublicStoredThumbnail(
    item.object_key.replace(/\.[^.]+$/, ".webp"),
    request,
    baseDependencies as never
  );
  assert.equal(thumbnailResponse.status, 206);
  assert.equal(streamCalls.length, 1);
  assert.equal(streamCalls[0]?.object.prefix, "thumbs");
  assert.equal(streamCalls[0]?.cacheControl, immutableCacheControl);
  assertForwardedRequest(streamCalls[0]?.request);

  for (const state of [
    { status: "deleted" as const, storage_slug: "local" },
    { status: "deleted" as const, storage_slug: "s3-private" },
    { status: "ready" as const, storage_slug: "s3-private" }
  ]) {
    servingRecord = { ...record, ...state };
    const stableThumbnail = await servePublicStoredThumbnail(
      item.object_key.replace(/\.[^.]+$/, ".webp"),
      getRequest,
      baseDependencies as never
    );
    assert.deepEqual(
      Buffer.from(await stableThumbnail.arrayBuffer()),
      storedBytes
    );
    assert.equal(streamCalls.at(-1)?.object.storageSlug, state.storage_slug);
    assert.equal(streamCalls.at(-1)?.cacheControl, immutableCacheControl);
  }

  streamCalls.length = 0;
  servingRecord = { ...record, status: "deleted", storage_slug: "s3-public" };
  const thumbnailRedirect = await servePublicStoredThumbnail(
    item.object_key.replace(/\.[^.]+$/, ".webp"),
    request,
    {
      ...baseDependencies,
      resolveReadableObject: async (
        prefix: "full" | "thumbs",
        key: string
      ) =>
        resolvedObject(prefix, key, "https://cdn.example.com/thumb.webp")
    } as never
  );
  assert.equal(thumbnailRedirect.status, 302);
  assert.equal(
    thumbnailRedirect.headers.get("Location"),
    "https://cdn.example.com/thumb.webp"
  );
  assert.equal(streamCalls.length, 0);
  assert.equal(
    thumbnailExistsCalls,
    0,
    "公开 S3 缩略图直链不得先执行存在性探测"
  );
  servingRecord = record;

  await assert.rejects(
    servePublicStoredThumbnail(
      item.object_key.replace(/\.[^.]+$/, ".webp"),
      request,
      {
        ...baseDependencies,
        streamResolvedObject: async () => {
          throw new ApiError(404, "storage_object_not_found", "missing");
        }
      } as never
    ),
    (error) => error instanceof ApiError
      && error.status === 404
      && error.code === "not_found"
  );

  await assert.rejects(
    servePublicStoredThumbnail(
      item.object_key.replace(/\.[^.]+$/, ".webp"),
      request,
      {
        ...baseDependencies,
        streamResolvedObject: async () => {
          throw new ApiError(503, "storage_read_unavailable", "unavailable");
        }
      } as never
    ),
    (error) => error instanceof ApiError
      && error.status === 503
      && error.code === "storage_read_unavailable"
  );

  let invalidKeyRead = false;
  await assert.rejects(
    servePublicStoredObject(
      `${item.id}.jpg/../secret`,
      request,
      {
        ...baseDependencies,
        readImageServingRecordByObjectKey: async () => {
          invalidKeyRead = true;
          return record;
        }
      } as never
    ),
    (error) => error instanceof ApiError
      && error.status === 404
      && error.code === "not_found"
  );
  assert.equal(invalidKeyRead, false);

  let invalidThumbnailKeyRead = false;
  await assert.rejects(
    servePublicStoredThumbnail(
      item.object_key,
      request,
      {
        ...baseDependencies,
        readImageServingRecordByThumbKey: async () => {
          invalidThumbnailKeyRead = true;
          return record;
        }
      } as never
    ),
    (error) => error instanceof ApiError
      && error.status === 404
      && error.code === "not_found"
  );
  assert.equal(invalidThumbnailKeyRead, false);
});
test("[Server/图片] external original serving 保持 direct/proxy、validator 与 deleted 边界", async () => {
  const item = servingReadyCacheItem();
  const record = {
    id: item.id,
    object_key: item.object_key,
    original: item.original,
    ext: item.ext,
    storage_slug: item.storage_slug,
    device: item.device,
    brightness: item.brightness,
    theme: item.theme,
    status: "ready" as const,
    description: item.description,
    source: item.source,
    updated_at: item.updated_at
  };
  const proxyCalls: unknown[][] = [];
  let direct = false;
  let readCount = 0;
  let readOptions: unknown;
  const dependencies = {
    readImageServingRecordById: async (_id: string, options: unknown) => {
      readCount += 1;
      readOptions = options;
      return record;
    },
    displayUrlForOriginalComparison: async () =>
      `https://img.example.com/full/${item.object_key}`,
    supportsDirectAccess: async () => direct,
    proxyExternalImage: async (...args: unknown[]) => {
      proxyCalls.push(args);
      return new Response(null, { status: 207 });
    }
  };

  const proxySignal = new AbortController().signal;
  const proxyResponse = await servePublicExternalOriginal(
    item.id,
    {
      userAgent: "fixture-agent",
      signal: proxySignal,
      method: "HEAD",
      ifNoneMatch: '"client"',
      ifModifiedSince: "Sun, 10 Aug 2026 00:00:00 GMT"
    },
    dependencies as never
  );
  assert.equal(proxyResponse.status, 207);
  assert.equal(readCount, 1);
  assert.equal(proxyCalls[0]?.[0], item.original);
  assert.equal(proxyCalls[0]?.[1], "jpg");
  assert.deepEqual(proxyCalls[0]?.[2], {
    method: "HEAD",
    signal: proxySignal,
    validators: {
      ifNoneMatch: '"client"',
      ifModifiedSince: "Sun, 10 Aug 2026 00:00:00 GMT",
      resourceUpdatedAt: item.updated_at
    }
  });
  assert.deepEqual(proxyCalls[0]?.[3], {
    "Cache-Control": noStoreCacheControl,
    "Referrer-Policy": "no-referrer"
  });
  assert.equal(proxyCalls[0]?.[4], publicProxyImageCacheControl);

  direct = true;
  const directRedirect = await servePublicExternalOriginal(
    item.id,
    { userAgent: "fixture-agent" },
    dependencies as never
  );
  assert.equal(readCount, 2);
  assert.equal(proxyCalls.length, 1);
  assert.equal(directRedirect.status, 302);
  assert.equal(directRedirect.headers.get("Location"), item.original);
  assert.equal(
    directRedirect.headers.get("Cache-Control"),
    privateNoStoreCacheControl
  );
  assert.equal(directRedirect.headers.get("Referrer-Policy"), "no-referrer");

  const adminResponse = await serveAdminExternalOriginal(
    item.id,
    "fixture-agent",
    new AbortController().signal,
    {
      ...dependencies,
      readImageServingRecordById: async (_id: string, options: unknown) => {
        readOptions = options;
        return { ...record, status: "deleted" as const };
      }
    } as never
  );
  assert.equal(adminResponse.status, 302);
  assert.equal(adminResponse.headers.get("Location"), item.original);
  assert.deepEqual(readOptions, { includeDeleted: true });

  await assert.rejects(
    servePublicExternalOriginal(
      item.id,
      { userAgent: "fixture-agent" },
      {
        ...dependencies,
        readImageServingRecordById: async () => ({
          ...record,
          status: "deleted" as const
        })
      } as never
    ),
    (error: { status?: number; code?: string }) =>
      error.status === 404 && error.code === "not_found"
  );
});
test("[Server/图片] 图片标准化只信任 Sharp 编解码结果并保留既有格式与质量边界", async () => {
  initializeRuntimeConfig();
  configureSharpRuntime();
  assert.equal(sharp.concurrency(), 1, "每图 Sharp 线程数由 Server 内部基线固定");
  const fixtureRoot = await createTestDirectory("imageshow-processing-");
  const width = 640;
  const height = 480;
  const pixels = Buffer.alloc(width * height * 3);
  let randomState = 0x4163_2026;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
        pixels[(y * width + x) * 3 + channel] = (
          x * 3 + y * 2 + channel * 41 + (randomState >>> 29)
        ) & 255;
      }
    }
  }
  const source = () => sharp(pixels, { raw: { width, height, channels: 3 } });
  const settings: StoredImageTranscodeSettings = {
    quality: 80,
    quality_step: 5,
    min_quality: 20,
    max_long_edge: 4500,
    max_size_kb: 100 * 1024,
    skip_webp_under_kb: 0
  };
  const invalidImage = (code: string) => (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 400);
    assert.equal(error.code, code);
    return true;
  };

  try {
    const fixturePaths = Object.fromEntries(
      ["jpg", "png", "webp", "gif", "avif"].map((ext) => [
        ext,
        join(fixtureRoot, `source.${ext}`)
      ])
    );
    await source().jpeg({ quality: 90 }).toFile(fixturePaths.jpg!);
    await source().png().toFile(fixturePaths.png!);
    await source().webp({ quality: 90 }).toFile(fixturePaths.webp!);
    await source().gif().toFile(fixturePaths.gif!);
    await source().avif({ quality: 90 }).toFile(fixturePaths.avif!);

    for (const [format, path] of Object.entries(fixturePaths)) {
      const result = await transcodeStoredImage(path, settings);
      assert.equal(result.ext, "webp", `${format} 应标准化为 WebP`);
      assert.equal(result.sourceWidth, width);
      assert.equal(result.sourceHeight, height);
      assert.equal(result.width, width);
      assert.equal(result.height, height);
      assert.equal(result.size, result.processed.byteLength);
      assert.equal(result.md5, md5Buffer(result.processed));
      assert.equal(result.transcoded, true);
      const outputMetadata = await sharp(result.processed).metadata();
      assert.equal(outputMetadata.format, "webp");
      assert.equal(outputMetadata.width, result.width);
      assert.equal(outputMetadata.height, result.height);
    }

    const orientedPath = join(fixtureRoot, "oriented.jpg");
    await source()
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 90 })
      .toFile(orientedPath);
    const oriented = await transcodeStoredImage(orientedPath, settings);
    assert.deepEqual(
      [oriented.sourceWidth, oriented.sourceHeight],
      [height, width]
    );
    assert.deepEqual([oriented.width, oriented.height], [height, width]);

    const frameWidth = 96;
    const frameHeight = 64;
    const frameSize = frameWidth * frameHeight * 3;
    const frames = Buffer.alloc(frameSize * 2);
    frames.fill(32, 0, frameSize);
    frames.fill(224, frameSize);
    for (const format of ["gif", "webp"] as const) {
      const path = join(fixtureRoot, `animated.${format}`);
      const animation = sharp(frames, {
        raw: {
          width: frameWidth,
          height: frameHeight * 2,
          channels: 3,
          pageHeight: frameHeight
        }
      });
      if (format === "gif") {
        await animation.gif({ delay: [80, 120], loop: 0 }).toFile(path);
      } else {
        await animation.webp({ delay: [80, 120], loop: 0 }).toFile(path);
      }
      const inputMetadata = await sharp(path).metadata();
      assert.equal(inputMetadata.pages, 2);
      const normalized = await transcodeStoredImage(path, settings);
      const outputMetadata = await sharp(normalized.processed, {
        animated: true
      }).metadata();
      assert.deepEqual(
        [normalized.sourceWidth, normalized.sourceHeight],
        [frameWidth, frameHeight]
      );
      assert.deepEqual(
        [normalized.width, normalized.height],
        [frameWidth, frameHeight]
      );
      assert.equal(outputMetadata.pages, undefined, "默认读取仍只处理首帧");
      if (format === "webp") {
        const inputBytes = await readFile(path);
        const skipped = await transcodeStoredImage(path, {
          ...settings,
          skip_webp_under_kb: (inputBytes.byteLength + 1) / 1024
        });
        assert.equal(skipped.transcoded, false);
        assert.deepEqual(skipped.processed, inputBytes);
        assert.equal(
          (await sharp(skipped.processed, { animated: true }).metadata()).pages,
          2,
          "跳过转码的 animated WebP 应保留完整动画"
        );
      }
    }

    const webpBytes = await readFile(fixturePaths.webp!);
    const equalThreshold = await transcodeStoredImage(fixturePaths.webp!, {
      ...settings,
      skip_webp_under_kb: webpBytes.byteLength / 1024
    });
    assert.equal(equalThreshold.transcoded, true, "等于阈值时仍须转码");
    const aboveThreshold = await transcodeStoredImage(fixturePaths.webp!, {
      ...settings,
      skip_webp_under_kb: (webpBytes.byteLength + 1) / 1024
    });
    assert.equal(aboveThreshold.transcoded, false);
    assert.equal(aboveThreshold.quality, null);
    assert.deepEqual(aboveThreshold.processed, webpBytes);
    assert.equal(aboveThreshold.md5, md5Buffer(webpBytes));

    const qualitySizes = new Map<number, number>();
    const qualityPipeline = sharp(fixturePaths.png!).rotate().resize({
      width: settings.max_long_edge,
      height: settings.max_long_edge,
      fit: "inside",
      withoutEnlargement: true
    });
    for (let quality = 10; quality <= 100; quality += 5) {
      const encoded = await qualityPipeline
        .clone()
        .webp({ quality })
        .toBuffer({ resolveWithObject: true });
      qualitySizes.set(quality, encoded.info.size);
    }
    const qualitySettings = {
      quality: 100,
      quality_step: 15,
      min_quality: 10
    };
    const simulateQuality = (maxBytes: number) => {
      let quality = qualitySettings.quality;
      let lastDropMultiplier = 1;
      while (true) {
        const size = qualitySizes.get(quality)!;
        if (quality <= qualitySettings.min_quality) {
          return { quality, successfulQuality: quality };
        }
        if (size <= maxBytes) {
          const successfulQuality = quality;
          for (let index = 0; index < lastDropMultiplier - 1; index += 1) {
            const nextQuality = Math.min(
              qualitySettings.quality,
              quality + qualitySettings.quality_step
            );
            if (nextQuality <= quality || qualitySizes.get(nextQuality)! > maxBytes) break;
            quality = nextQuality;
          }
          return { quality, successfulQuality };
        }
        lastDropMultiplier = Math.min(
          3,
          Math.max(1, Math.floor(size / maxBytes))
        );
        quality = Math.max(
          qualitySettings.min_quality,
          quality - qualitySettings.quality_step * lastDropMultiplier
        );
      }
    };
    let backfillCase: { maxBytes: number; quality: number } | undefined;
    for (
      let maxBytes = 50 * 1024;
      maxBytes < qualitySizes.get(100)!;
      maxBytes += 1
    ) {
      const simulated = simulateQuality(maxBytes);
      if (simulated.quality > simulated.successfulQuality) {
        backfillCase = { maxBytes, quality: simulated.quality };
        break;
      }
    }
    assert.ok(backfillCase, "测试素材应能触发跨档降质后的质量回填");
    const backfilled = await transcodeStoredImage(fixturePaths.png!, {
      ...settings,
      ...qualitySettings,
      max_size_kb: (backfillCase.maxBytes + 0.5) / 1024
    });
    assert.equal(backfilled.quality, backfillCase.quality);
    assert.ok(backfilled.size <= backfillCase.maxBytes);

    const tiffPath = join(fixtureRoot, "unsupported.tiff");
    const svgPath = join(fixtureRoot, "unsupported.svg");
    await source().tiff().toFile(tiffPath);
    await writeFile(
      svgPath,
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32" />'
    );
    await assert.rejects(
      transcodeStoredImage(tiffPath, settings),
      invalidImage("unsupported_file_type")
    );
    await assert.rejects(
      transcodeStoredImage(svgPath, settings),
      invalidImage("unsupported_file_type")
    );

    const truncatedPath = join(fixtureRoot, "truncated.jpg");
    const completeJpeg = await source().jpeg({ quality: 90 }).toBuffer();
    await writeFile(
      truncatedPath,
      completeJpeg.subarray(0, Math.floor(completeJpeg.byteLength * 0.8))
    );
    assert.equal((await sharp(truncatedPath).metadata()).format, "jpeg");
    await assert.rejects(
      transcodeStoredImage(truncatedPath, settings),
      invalidImage("unsupported_file_type")
    );

    const corruptPath = join(fixtureRoot, "corrupt.jpg");
    await writeFile(corruptPath, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    await assert.rejects(
      transcodeStoredImage(corruptPath, settings),
      invalidImage("unsupported_file_type")
    );

    const inputLimit = getIngestionMaxLongEdge();
    const oversizedPath = join(fixtureRoot, "oversized.png");
    await sharp({
      create: {
        width: inputLimit + 1,
        height: 1,
        channels: 3,
        background: "#000000"
      }
    }).png().toFile(oversizedPath);
    await assert.rejects(
      transcodeStoredImage(oversizedPath, settings),
      invalidImage("image_too_large")
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
test("[Server/图片] 图片时间、UUIDv7、游标、分类和统一筛选保持一致", () => {
  const parsedTime = parseImageTime("2020-05-01 00:00:00", {
    timeZone: "Asia/Makassar"
  });
  assert.equal(parsedTime.iso, "2020-04-30T16:00:00.000Z");
  assert.throws(() => parseImageTime("1969-12-31T23:59:59Z"), /1970/);

  const id = createImageId(new Date(parsedTime.iso));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16), Date.parse(parsedTime.iso));

  const fixedCursorRow = {
    cursor_image_time: "2020-04-30T16:00:00.123456Z",
    id: "018f3e1b-5d80-7abc-8def-0123456789ab"
  };
  const encoded = encodeImageCursor(fixedCursorRow);
  assert.equal(encoded, "AAWkhCgrYkABjz4bXYB6vI3vASNFZ4mr");
  assert.equal(encoded.length, 32);
  assert.doesNotMatch(encoded, /=/);
  assert.deepEqual(decodeImageCursor(encoded), {
    imageTime: "2020-04-30T16:00:00.123456Z",
    id: fixedCursorRow.id,
    sortScore: 1_588_262_400_123_456
  });
  assert.deepEqual(
    decodeImageCursor("_-AAAAAAAAEAAAAAAABwAIAAAAAAAAAA"),
    {
      imageTime: "1684-07-28T00:12:25.259009Z",
      id: "00000000-0000-7000-8000-000000000000",
      sortScore: Number.MIN_SAFE_INTEGER
    }
  );
  assert.deepEqual(
    decodeImageCursor("AB________8AAAAAAABwAIAAAAAAAAAA"),
    {
      imageTime: "2255-06-05T23:47:34.740991Z",
      id: "00000000-0000-7000-8000-000000000000",
      sortScore: Number.MAX_SAFE_INTEGER
    }
  );
  const maximumUuidCursor = encodeImageCursor({
    cursor_image_time: "1970-01-01T00:00:00.000000Z",
    id: "ffffffff-ffff-7fff-bfff-ffffffffffff"
  });
  assert.equal(maximumUuidCursor, "AAAAAAAAAAD_______9__7__________");
  assert.deepEqual(decodeImageCursor(maximumUuidCursor), {
    imageTime: "1970-01-01T00:00:00.000000Z",
    id: "ffffffff-ffff-7fff-bfff-ffffffffffff",
    sortScore: 0
  });
  for (const invalidCursor of [
    "invalid",
    `1.${encoded}`,
    `${encoded}=`,
    JSON.stringify(fixedCursorRow),
    "AAAAAAAAAAAAAAAAAABwAAAAAAAAAAAA"
  ]) {
    assert.throws(
      () => decodeImageCursor(invalidCursor),
      /Invalid image list cursor/
    );
  }
  assert.throws(() => encodeImageCursor({
    ...fixedCursorRow,
    cursor_image_time: "2255-06-05T23:47:34.740992Z"
  }), /Invalid image list cursor row/);
  assert.throws(() => encodeImageCursor({
    ...fixedCursorRow,
    id: "not-a-uuid"
  }), /Invalid image list cursor row/);

  assert.equal(deviceFromDimensions(1920, 1080), "pc");
  assert.equal(deviceFromDimensions(800, 1200), "mb");
  assert.deepEqual(resolveClassification(
    { device: "auto", brightness: "light" },
    { device: "mb", brightness: "dark" }
  ), { device: "mb", brightness: "light" });

  const plan = createImageFilterPlan({
    devices: ["pc"],
    tag: { include: ["live", "stage", "live"] },
    author: { exclude: ["blocked"] }
  });
  assert.deepEqual(plan.tag.include, ["live", "stage"]);
  assert.equal(imageFilterPlanHasAllAxes(plan), false);
  assert.equal(imageFilterPlanHasAllAxes(imageFilterPlanWithout(plan, "device")), true);
  const sql = buildImageFilterSql({ status: "ready", plan }, { alias: "m" });
  assert.deepEqual(sql.params, [
    "ready",
    "pc",
    "dark",
    "pc",
    "light",
    ["blocked"],
    ["live", "stage"]
  ]);
  assert.match(sql.where.join(" AND "), /EXISTS/);
  assert.throws(() => createImageFilterPlan({
    tag: { include: ["live"], exclude: ["blocked"] }
  }), /Cannot mix include and exclude/);
});
test("[Server/图片] 公开 cursor、后台 offset 与 Redis 有序窗口只读取精确目标页", async () => {
  let sql = "";
  let sqlParams: unknown[] = [];
  const reader = {
    query: async (text: string, params: unknown[]) => {
      sql = text;
      sqlParams = params;
      return { rows: [] };
    }
  } as never;
  await fetchAdminImageOffsetRows(
    ["status=$1"],
    ["deleted"],
    createPageWindow(100, 60),
    reader
  );
  assert.match(sql, /ORDER BY image_time DESC, id DESC/);
  assert.match(sql, /LIMIT \$2 OFFSET \$3/);
  assert.match(sql, /AS tags/);
  assert.match(
    sql,
    /FROM \(\s*SELECT[\s\S]*FROM metadata[\s\S]*LIMIT \$2 OFFSET \$3\s*\) metadata/
  );
  assert.deepEqual(sqlParams, ["deleted", 60, 5_940]);

  const publicCursorId = "019f8457-063a-7002-a580-7a432dc7fd8d";
  const publicCursorTime = "2026-08-03T12:00:00.000000Z";
  await fetchPublicImageCardPage(
    ["status=$1"],
    ["ready"],
    60,
    "oldest",
    encodeImageCursor({
      cursor_image_time: publicCursorTime,
      id: publicCursorId
    }),
    reader
  );
  assert.match(sql, /\(image_time, id\) > \(\$2::timestamptz, \$3::uuid\)/);
  assert.match(sql, /ORDER BY image_time ASC, id ASC/);
  assert.match(sql, /LIMIT \$4/);
  assert.deepEqual(sqlParams, [
    "ready",
    publicCursorTime,
    publicCursorId,
    61
  ]);

  const first = servingReadyCacheItem({ id: randomUUID() });
  const second = servingReadyCacheItem({ id: randomUUID() });
  const members = [readyImageMember(first.id), readyImageMember(second.id)];
  let memberWindow: [number, number] | null = null;
  let hydrationCalls = 0;
  const dependencies: ReadyImageWindowDependencies = {
    validate: async () => true,
    count: async () => 5,
    members: async (_index, start, stop) => {
      memberWindow = [start, stop];
      return members;
    },
    items: async () => {
      hydrationCalls += 1;
      return [
        serializeReadyImageCacheItem(first),
        serializeReadyImageCacheItem(second)
      ];
    },
    assertDerivedItems: async () => undefined
  };
  const index = {
    kind: "core" as const,
    key: "ready:test",
    revision: "1",
    count: 5,
    metaKey: null,
    instanceToken: null
  };
  const window = await readReadyImageOrderedWindow(
    index,
    2,
    2,
    "fallback",
    dependencies
  );
  assert.deepEqual(memberWindow, [2, 3]);
  assert.equal(hydrationCalls, 1);
  assert.deepEqual(window?.items.map((item) => item.id), [first.id, second.id]);
  assert.equal(window?.total, 5);

  memberWindow = null;
  hydrationCalls = 0;
  assert.deepEqual(
    await readReadyImageOrderedWindow(
      index,
      5,
      2,
      "fallback",
      dependencies
    ),
    { items: [], total: 5 }
  );
  assert.equal(memberWindow, null);
  assert.equal(hydrationCalls, 0);

  await assert.rejects(
    readReadyImageOrderedWindow(index, 2, 2, "fallback", {
      ...dependencies,
      members: async () => [members[0]!]
    }),
    /invalid ordered window/
  );

  const oneItemIndex = { ...index, count: 1 };
  const operationalDependencies: ReadyImageWindowDependencies = {
    validate: async () => true,
    count: async () => 1,
    members: async () => [members[0]!],
    items: async () => [serializeReadyImageCacheItem(first)],
    assertDerivedItems: async () => undefined
  };
  for (const stage of ["count", "members", "items"] as const) {
    const failure = new Error(`controlled Redis ${stage} failure`);
    await assert.rejects(
      readReadyImageOrderedWindow(
        oneItemIndex,
        0,
        1,
        "required",
        {
          ...operationalDependencies,
          [stage]: async () => {
            throw failure;
          }
        }
      ),
      (error) => isRedisUnavailableError(error)
        && error.cause === failure
    );
  }
  await assert.rejects(
    readReadyImageOrderedWindow(
      oneItemIndex,
      0,
      1,
      "fallback",
      { ...operationalDependencies, items: async () => [] }
    ),
    /incomplete core items/
  );

  const logicalMismatch = new Error("controlled derived projection mismatch");
  await assert.rejects(
    readReadyImageOrderedWindow(
      {
        kind: "attribute",
        key: "ready:test:attribute",
        revision: "1",
        count: 1,
        metaKey: "ready:test:attribute:meta",
        instanceToken: "0".repeat(32)
      },
      0,
      1,
      "required",
      {
        ...operationalDependencies,
        assertDerivedItems: async () => {
          throw logicalMismatch;
        }
      }
    ),
    (error) => error === logicalMismatch
      && !isRedisUnavailableError(error)
  );
});
test("[Server/图片] 随机图查询以 auto 归一缺省设备并接受完整参数契约", async () => {
  const parseQuery = (search: string) => {
    const result = parseRandomQuery(
      new URL("https://img.example.com/random?" + search),
      "redirect"
    );
    assert.equal(result instanceof Response, false);
    return result as ParsedRandomQuery;
  };
  const maps: RandomSelectorMaps = {
    theme: new Map([["舞台", "stage"], ["stage", "stage"]]),
    tag: new Map([["现场", "live"], ["live", "live"]]),
    author: new Map([["摄影师", "photographer"], ["photographer", "photographer"]])
  };

  const omittedDevice = parseQuery("");
  const explicitAuto = parseQuery("device=auto");
  assert.equal(omittedDevice.device, "auto");
  assert.equal(explicitAuto.device, "auto");
  const normalizedOmitted = normalizeRandomQuery(omittedDevice, maps);
  const normalizedAuto = normalizeRandomQuery(explicitAuto, maps);
  assert.equal(normalizedOmitted instanceof Response, false);
  assert.equal(normalizedAuto instanceof Response, false);
  if (
    normalizedOmitted instanceof Response
    || normalizedAuto instanceof Response
  ) {
    assert.fail("auto 随机查询未完成归一化");
  }
  assert.equal(normalizedOmitted.signature, normalizedAuto.signature);
  assert.equal(
    normalizedOmitted.signature,
    '{"d":"","b":"","t":{"include":[],"exclude":[]},'
      + '"tag":{"include":[],"exclude":[]},'
      + '"a":{"include":[],"exclude":[]}}'
  );
  assert.equal(
    detectDeviceFromUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    ),
    "pc"
  );
  assert.equal(
    detectDeviceFromUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"
    ),
    "mb"
  );
  assert.equal(detectDeviceFromUserAgent("unrecognized-client"), null);
  assert.deepEqual(
    resolveCandidateAxes("auto", null, "Mozilla/5.0 (Windows NT 10.0)")
      .deviceCandidates,
    ["pc"]
  );
  assert.deepEqual(
    resolveCandidateAxes("auto", null, "Mozilla/5.0 (iPhone)")
      .deviceCandidates,
    ["mb"]
  );
  assert.deepEqual(
    resolveCandidateAxes("auto", null, "unrecognized-client")
      .deviceCandidates,
    ["pc", "mb"]
  );
  assert.deepEqual(
    resolveCandidateAxes("all", null, "Mozilla/5.0 (iPhone)")
      .deviceCandidates,
    ["pc", "mb"]
  );

  const normalized = normalizeRandomQuery(
    parseQuery("device=PC&brightness=DARK&theme=%E8%88%9E%E5%8F%B0&tag=%E7%8E%B0%E5%9C%BA&author=%E6%91%84%E5%BD%B1%E5%B8%88&mode=PROXY"),
    maps
  );
  assert.equal(normalized instanceof Response, false);
  if (normalized instanceof Response) assert.fail("随机图选择器未完成归一化");
  assert.deepEqual(normalized.theme, { include: ["stage"], exclude: [] });
  assert.deepEqual(normalized.tag, { include: ["live"], exclude: [] });
  assert.deepEqual(normalized.author, { include: ["photographer"], exclude: [] });
  assert.equal(normalized.device, "pc");
  assert.equal(normalized.brightness, "dark");
  assert.equal(normalized.mode, "proxy");

  const targeted = parseQuery(
    "id=" + imageId
    + "&id=7a432dc7fd8d&device=auto&mode=json&limit=2"
  );
  assert.deepEqual(targeted.ids, [imageId, "7a432dc7fd8d"].sort());
  assert.equal(targeted.mode, "json");
  assert.equal(targeted.limit, 2);
  assert.equal(targeted.device, "auto");

  for (const search of [
    "tag=live&tag=!blocked",
    "device=pc&device=mb",
    "id=7a432dc7fd8d&brightness=dark",
    "limit=2",
    "unknown=value",
    "device=invalid"
  ]) {
    const result = parseRandomQuery(
      new URL("https://img.example.com/random?" + search),
      "redirect"
    );
    assert.equal(result instanceof Response, true, search);
    assert.equal((result as Response).status, 400, search);
  }
});
test("[Server/图片] 图片处理共享许可并同时限制 commit 数量和字节", async () => {
  const cancellationError = (signal: AbortSignal) => (
    signal.reason ?? new Error("cancelled")
  );
  const normalizeAdmission = new DynamicConcurrencyLimiter(
    () => 1,
    cancellationError
  );
  const commitAdmission = new DynamicConcurrencyLimiter(
    () => 2,
    cancellationError
  );
  const commitByteAdmission = new DynamicWeightedLimiter(
    () => 10,
    cancellationError
  );
  const signal = new AbortController().signal;
  const pools = {
    prepare: <Result>(admissionSignal: AbortSignal, work: () => Promise<Result>) => (
      normalizeAdmission.run(admissionSignal, work)
    ),
    commit: <Result>(
      bytes: number,
      admissionSignal: AbortSignal,
      work: () => Promise<Result>
    ) => commitAdmission.run(admissionSignal, () => (
      commitByteAdmission.run(bytes, admissionSignal, work)
    ))
  };

  const stageStarts: string[] = [];
  let releasePrepare: () => void = () => {};
  const prepareGate = new Promise<void>((resolve) => {
    releasePrepare = resolve;
  });
  const uploadPrepare = pools.prepare(signal, async () => {
    stageStarts.push("upload-prepare");
    await prepareGate;
  });
  const ingestionPrepare = pools.prepare(signal, async () => {
    stageStarts.push("import-prepare");
  });
  while (stageStarts.length < 1) await delay(0);
  assert.deepEqual(stageStarts, ["upload-prepare"]);
  releasePrepare();
  await Promise.all([
    uploadPrepare,
    ingestionPrepare
  ]);
  assert.ok(stageStarts.indexOf("import-prepare") > stageStarts.indexOf(
    "upload-prepare"
  ));

  let releaseLargeCommit: () => void = () => {};
  const largeCommitGate = new Promise<void>((resolve) => {
    releaseLargeCommit = resolve;
  });
  const commitStarts: string[] = [];
  const largeCommit = pools.commit(7, signal, async () => {
    commitStarts.push("large");
    await largeCommitGate;
  });
  const byteBlockedCommit = pools.commit(4, signal, async () => {
    commitStarts.push("blocked-by-bytes");
  });
  const itemBlockedCommit = pools.commit(3, signal, async () => {
    commitStarts.push("blocked-by-items");
  });
  while (!commitStarts.length) await delay(0);
  assert.deepEqual(commitStarts, ["large"]);
  releaseLargeCommit();
  await Promise.all([largeCommit, byteBlockedCommit, itemBlockedCommit]);
  assert.deepEqual(commitStarts, [
    "large",
    "blocked-by-bytes",
    "blocked-by-items"
  ]);

  await assert.rejects(pools.commit(10, signal, async () => {
    throw new Error("commit failed");
  }));
  assert.equal(await pools.commit(10, signal, async () => "released"), "released");
});
test("[Server/图片] 标准化取消等待当前编码与缩略图收口，停止降质及质量回补", async (t) => {
  initializeRuntimeConfig();
  const root = await createTestDirectory("encode-cancel-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "source.png");
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).png().toFile(path);
  const settings = { quality: 90, min_quality: 10, quality_step: 10, max_size_kb: 1, skip_webp_under_kb: 0, max_long_edge: 100 };
  const preCancelled = new AbortController(); preCancelled.abort(new Error("already cancelled"));
  await assert.rejects(transcodeStoredImage("missing-file", settings, preCancelled.signal), (e) => e === preCancelled.signal.reason);
  const original = sharp.prototype.toBuffer;
  t.after(() => { sharp.prototype.toBuffer = original; });
  for (const cancelAt of [1, 2, 3]) {
    const abort = new AbortController();
    const reason = new Error("cancel encode " + cancelAt);
    let releaseEncode!: () => void;
    let releaseThumbnail!: () => void;
    let markStarted!: () => void;
    const encodeGate = new Promise<void>((resolve) => { releaseEncode = resolve; });
    const thumbnailGate = new Promise<void>((resolve) => { releaseThumbnail = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const qualities: number[] = [];
    sharp.prototype.toBuffer = (async function (
      this: { options: { webpQuality: number } },
      options: { resolveWithObject?: boolean }
    ) {
      if (!options?.resolveWithObject) { await thumbnailGate; return Buffer.from("thumbnail"); }
      qualities.push(this.options.webpQuality);
      if (qualities.length === cancelAt) { markStarted(); await encodeGate; }
      return { data: Buffer.from("image"), info: { width: 8, height: 8, size: qualities.length === 1 ? 4096 : 512 } };
    }) as typeof sharp.prototype.toBuffer;
    let settled = false;
    const pending = transcodeStoredImage(path, settings, abort.signal).finally(() => { settled = true; });
    const rejected = assert.rejects(pending, (error) => error === reason);
    await started; abort.abort(reason);
    await delay(0); assert.equal(settled, false);
    releaseEncode(); await delay(0);
    assert.equal(settled, false, "仍在编码的缩略图必须一起收口");
    assert.equal(qualities.length, cancelAt, "取消后不能进入下一轮或继续回补");
    releaseThumbnail(); await rejected;
  }
});
test("[Server/图片] 安全抓取在预取消时不联网，原图代理头部及正文取消传到上游且不 fallback", async (t) => {
  const { safeFetchExternalImage } = await import("../../../packages/server/src/core/external-image-fetch.ts");
  const { proxyExternalImage } = await import("../../../packages/server/src/images/external-image-proxy.ts");
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let fetches = 0; let fallbacks = 0;
  globalThis.fetch = async () => { fetches++; throw Error("must not fetch"); };
  const pre = new AbortController(); pre.abort();
  await assert.rejects(safeFetchExternalImage("https://example.com/image", { signal: pre.signal, timeoutMs: 1000 }), (e: any) => e.code === "external_image_cancelled");
  await assert.rejects(proxyExternalImage("https://example.com/image", "png", { method: "GET", signal: pre.signal }, {}, undefined, () => { fallbacks++; return new Response(); }));
  assert.equal(fetches, 0); assert.equal(fallbacks, 0);
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).png().toBuffer();
  for (const phase of ["headers", "body"] as const) {
    const abort = new AbortController(); const reason = new Error("cancel " + phase);
    let signal!: AbortSignal; let markFetched!: () => void;
    const fetched = new Promise<void>((resolve) => { markFetched = resolve; });
    globalThis.fetch = async (_url, init) => {
      fetches++; signal = init!.signal!;
      markFetched();
      if (phase === "headers") return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(image); signal.addEventListener("abort", () => controller.error(signal.reason), { once: true }); } }), { headers: { "content-type": "image/png" } });
    };
    const pending = proxyExternalImage("https://example.com/image", "png", { method: "GET", signal: abort.signal }, {}, undefined, () => { fallbacks++; return new Response(); });
    if (phase === "headers") {
      const rejection = assert.rejects(pending, (error) => error === reason);
      await fetched; abort.abort(reason); await rejection;
    } else {
      const response = await pending;
      const reader = response.body!.getReader();
      assert.deepEqual((await reader.read()).value, image);
      const rejection = assert.rejects(reader.read()); abort.abort(reason); await rejection;
    }
    assert.equal(signal.aborted, true); assert.equal(fallbacks, 0);
  }
  const redirected = new AbortController();
  globalThis.fetch = async () => { fetches++; return new Response(new ReadableStream({ cancel() { redirected.abort(); } }), { status: 302, headers: { location: "https://example.com/next" } }); };
  const beforeRedirect = fetches;
  await assert.rejects(safeFetchExternalImage("https://example.com/start", { timeoutMs: 1000, signal: redirected.signal }), (e: any) => e.code === "external_image_cancelled");
  assert.equal(fetches - beforeRedirect, 1);
});
test("[Server/图片] 专属原图等待共享探测时单个 HTTP 取消不影响另一消费者", async () => {
  const item = servingReadyCacheItem();
  let resolveProbe!: (value: boolean) => void;
  let started!: () => void;
  let probeCalls = 0;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const probe = new Promise<boolean>((resolve) => { resolveProbe = resolve; });
  const dependencies = {
    readImageServingRecordById: async () => ({ ...item, status: "ready" }),
    displayUrlForOriginalComparison: async () => "https://display.example.com/image.webp",
    supportsDirectAccess: (...args: unknown[]) => { assert.equal(args.length, 2, "共享探测不接收单个消费者的 signal"); if (++probeCalls === 2) started(); return probe; },
    proxyExternalImage: async () => { throw Error("direct probe should succeed"); }
  };
  const cancelled = new AbortController(); const other = new AbortController();
  const first = servePublicExternalOriginal(item.id, { signal: cancelled.signal }, dependencies as never);
  const second = serveAdminExternalOriginal(item.id, "", other.signal, dependencies as never);
  await ready;
  const reason = new Error("caller left");
  const rejected = assert.rejects(first, (error) => error === reason);
  cancelled.abort(reason); await rejected;
  assert.equal(other.signal.aborted, false);
  resolveProbe(true);
  assert.equal((await second).status, 302);
  assert.equal((await servePublicExternalOriginal(item.id, {}, dependencies as never)).status, 302);
});
