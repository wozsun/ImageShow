import { defaultNormalizeProfile } from "@imageshow/shared/browser";
import { storageObjectKey } from "@imageshow/shared/browser";
import "../support/server-environment.ts";
import assert from "node:assert/strict";

import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createTestDirectory } from "../support/test-directory.ts";
import { Hono } from "hono";
import ipaddr from "ipaddr.js";
import sharp from "sharp";
import { neverAbortedSignal } from "../../../packages/server/src/core/abort.ts";
import { limitProtectedAdminRequestBody } from "../../../packages/server/src/core/http/request-body-limit.ts";
import {
  adminApiBasePath,
  ingestionBatchHardLimit,
  normalizeIngestionDraftUrl,
  detectDeviceFromUserAgent
} from "../../../packages/shared/src/browser.ts";
import {
  getIngestionMaxLongEdge
} from "../../../packages/server/src/config/app-settings.ts";
import { initializeRuntimeConfig } from "../../../packages/server/src/config/runtime-config-store.ts";
import { ApiError } from "../../../packages/server/src/core/api-error.ts";
import {
  imageActionInput,
  imagePurgeInput,
  imageSnapshotInput,
  imageStorageMigrationInput,
  imageUpdateInput,
  imageMetadataCreateInput
} from "../../../packages/server/src/routes/validation/images.ts";
import {
  ingestionCommitIntentInput,
  ingestionQueueActionInput,
  ingestionSessionUpdateInput,
  ingestionStatusInput,
  importAcceptInput,
  uploadIntentInput
} from "../../../packages/server/src/routes/validation/ingestion.ts";
import { parse } from "../../../packages/server/src/routes/validation/parse.ts";

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
  privateRevalidationCacheControl,
  publicRedirectCacheControl
} from "../../../packages/server/src/core/http/headers.ts";
import { handleApiError } from "../../../packages/server/src/core/http/responses.ts";
import {
  deviceFromDimensions,
  resolveClassification
} from "../../../packages/server/src/images/classification.ts";
import { detectBrightness } from "../../../packages/server/src/images/brightness.ts";
import {
  createImageBrowseContext,
  decodeImageCursor,
  encodeImageCursor
} from "../../../packages/server/src/images/cursor.ts";
import {
  createImageFilterPlan,
  imageFilterPlanHasAllAxes,
  imageFilterPlanWithout
} from "../../../packages/server/src/images/filter-plan.ts";
import { createPageWindow } from "../../../packages/server/src/images/page-window.ts";
import {
  createImageId,
  parseImageTime
} from "../../../packages/server/src/images/image-time.ts";
import {
  servePublicStoredObject
} from "../../../packages/server/src/images/serving/stored-image.ts";
import { serveAdminExternalOriginal } from "../../../packages/server/src/images/serving/external-original.ts";
import {
  configureSharpRuntime,
  transcodeStoredImage
} from "../../../packages/server/src/images/processing.ts";
import { buildImageFilterSql } from "../../../packages/server/src/images/read-models/image-filter-sql.ts";
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
import { isRedisUnavailableError } from "../../../packages/server/src/core/runtime-availability.ts";
import {
  normalizeRandomQuery,
  parseRandomQuery,
  type ParsedRandomQuery,
  type RandomSelectorMaps
} from "../../../packages/server/src/random/query.ts";
import { resolveCandidateAxes } from "../../../packages/server/src/random/selection-model.ts";
import { registerAdminImageRoutes } from "../../../packages/server/src/routes/admin-images.ts";
import { registerPublicRoutes } from "../../../packages/server/src/routes/public.ts";
import {
  imageId,
  servingReadyCacheItem
} from "../support/server-test-context.ts";

test("[Server/图片] 完成结果统一分类图片与存储配置断连并保留格式化错误", async (t) => {
  const database = await import("../../../packages/server/src/core/database/pools.ts");
  const registry = await import("../../../packages/server/src/storage/backends/registry.ts");
  const { readCommittedIngestionResultsByImageIds } =
    await import("../../../packages/server/src/images/read-models/ingestion-results.ts");
  initializeRuntimeConfig();
  const id = "00000000-0000-7000-8000-000000000001";
  const connectionError = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
  let fault: "metadata" | "storage" | "format" | "missing" | "none" = "metadata";
  const reads: string[] = [];
  t.mock.method(database.pool, "query", async (sql: string) => {
    if (sql.includes("FROM metadata")) {
      reads.push("metadata");
      if (fault === "metadata") throw connectionError;
      return {
        rows: [
          {
            id,
            created_by: "owner",
            storage_slug: "local",
            device: "pc",
            brightness: "dark",
            theme: null,
            author: null,
            tags: [],
            title: "fixture",
            description: "",
            source: "",
            original: "",
            l_width: 1200,
            l_height: 800,
            l_byte_size: "120000",
            l_md5: "a".repeat(32),
            m_width: 900,
            m_height: 600,
            m_byte_size: "80000",
            m_md5: "b".repeat(32),
            s_width: 600,
            s_height: 400,
            s_byte_size: "40000",
            s_md5: "c".repeat(32),
            image_time: fault === "format" ? "invalid" : "2026-09-15T00:00:00.000Z"
          }
        ]
      };
    }
    assert.match(sql, /FROM storage_backend/u);
    reads.push("storage");
    if (fault === "storage") throw connectionError;
    return {
      rows:
        fault === "missing"
          ? []
          : [
              {
                slug: "local",
                type: "local",
                config: {},
                display_name: "Local",
                enabled: true,
                is_default: true,
                namespace_identities: []
              }
            ]
    };
  });
  t.after(() => registry.invalidateStorageBackendRegistry());
  for (const phase of ["metadata", "storage"] as const) {
    fault = phase;
    reads.length = 0;
    registry.invalidateStorageBackendRegistry();
    await assert.rejects(readCommittedIngestionResultsByImageIds([id]), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 503);
      assert.equal(error.code, "database_unavailable");
      assert.equal(error.cause, connectionError);
      return true;
    });
    assert.deepEqual(reads, phase === "metadata" ? ["metadata"] : ["metadata", "storage"]);
  }
  fault = "format";
  registry.invalidateStorageBackendRegistry();
  await assert.rejects(readCommittedIngestionResultsByImageIds([id]), RangeError);
  fault = "missing";
  registry.invalidateStorageBackendRegistry();
  await assert.rejects(
    readCommittedIngestionResultsByImageIds([id]),
    (error: unknown) =>
      error instanceof ApiError &&
      error.code === "storage_backend_not_found" &&
      error.status === 404
  );
  fault = "none";
  registry.invalidateStorageBackendRegistry();
  const results = await readCommittedIngestionResultsByImageIds([id, id.toUpperCase()]);
  assert.equal(results.size, 1);
  assert.equal(results.get(id)?.created_by, "owner");
  assert.equal(results.get(id)?.item.id, id);
  assert.equal(results.get(id)?.item.large_md5, "a".repeat(32));
  assert.deepEqual(results.get(id)?.item.variants, {
    large: { width: 1200, height: 800, byte_size: 120000 },
    medium: { width: 900, height: 600, byte_size: 80000 },
    small: { width: 600, height: 400, byte_size: 40000 }
  });
});

test("[Server/主题] null 保留给未设置主题与作者，写入以 JSON null 表示未设置且不限制标签", async () => {
  const { imageAuthorInput, imageThemeInput } =
    await import("../../../packages/server/src/images/metadata-named-slugs.ts");
  const { themeCreateInput, tagCreateInput, authorSlugInput } =
    await import("../../../packages/server/src/routes/validation/vocabulary.ts");
  for (const input of [imageThemeInput, imageAuthorInput]) {
    assert.equal(input.parse(null), null);
    assert.equal(input.parse(" Portrait "), "portrait");
    for (const value of ["null", " NULL ", ""]) {
      assert.equal(input.safeParse(value).success, false);
    }
  }
  for (const slug of ["null", " NULL "]) {
    assert.equal(themeCreateInput.safeParse({ slug }).success, false);
    assert.equal(authorSlugInput.safeParse(slug).success, false);
  }
  assert.equal(themeCreateInput.parse({ slug: "none" }).slug, "none");
  assert.equal(authorSlugInput.parse("none"), "none");
  assert.equal(tagCreateInput.parse({ slug: "null" }).slug, "null");
});

test("[Server/图片] 存储输入归一化 slug 并补齐缺省 S3 设置", () => {
  const defaultS3 = {
    endpoint: "",
    region: "auto",
    bucket: "",
    access_key_id: "",
    force_path_style: true,
    root_path: "/",
    public_base_url: "",
    connect_timeout_seconds: 15,
    idle_timeout_seconds: 15,
    task_timeout_seconds: 300
  };
  assert.deepEqual(parse(storageBackendCreateInput, { slug: " Archive " }), {
    slug: "archive",
    display_name: "",
    s3: defaultS3
  });
  assert.deepEqual(
    parse(storageBackendCreateInput, {
      slug: "archive",
      s3: { endpoint: " https://s3.example.com ", bucket: " images ", force_path_style: false }
    }).s3,
    {
      ...defaultS3,
      endpoint: "https://s3.example.com",
      bucket: "images",
      force_path_style: false
    }
  );
  assert.deepEqual(parse(storageBackendTestInput, { slug: " Archive " }), { slug: "archive" });
  assert.deepEqual(parse(storageBackendMigrationInput, { source: " Archive ", target: "LOCAL" }), {
    source: "archive",
    target: "local"
  });
  assert.equal(parse(storageBackendCreateInput, { slug: "a".repeat(32) }).slug, "a".repeat(32));
  assert.throws(() => parse(storageBackendCreateInput, { slug: "a".repeat(33) }), {
    code: "validation_error",
    message: "标识 slug 最长 32 个字符"
  });
  assert.throws(
    () =>
      parse(storageBackendCreateInput, {
        slug: "archive",
        s3: { endpoint: "http://s3.example.com" }
      }),
    { code: "validation_error", message: "endpoint must use HTTPS" }
  );
});

test("[Server/图片] 亮度分类识别深色浅色与透明背景", async () => {
  for (const [background, expected] of [
    [{ r: 0, g: 0, b: 0, alpha: 1 }, "dark"],
    [{ r: 255, g: 255, b: 255, alpha: 1 }, "light"],
    [{ r: 0, g: 0, b: 0, alpha: 0 }, "light"]
  ] as const) {
    const input = await sharp({
      create: { width: 16, height: 16, channels: 4, background }
    })
      .png()
      .toBuffer();
    assert.equal(await detectBrightness(input), expected);
  }
});

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
  assert.equal(
    imageUpdateInput.safeParse({
      items: [{ id: metadataId }]
    }).success,
    false
  );
  assert.equal(
    imageUpdateInput.safeParse({
      items: [
        {
          id: metadataId,
          title: "有效字段",
          unknown_title: "未知字段"
        }
      ]
    }).success,
    false
  );
  assert.equal(storageBackendUpdateInput.safeParse({}).success, false);
  assert.equal(storageBackendUpdateInput.safeParse({ s3: {} }).success, false);
  assert.equal(storageBackendUpdateInput.safeParse({ unsupported: {} }).success, false);
  assert.equal(
    storageBackendCreateInput.safeParse({
      slug: "archive",
      s3: {}
    }).success,
    true
  );
  assert.equal(
    storageBackendCreateInput.safeParse({
      slug: "archive",
      type: "s3",
      s3: {}
    }).success,
    false
  );
  assert.equal(
    storageBackendCreateInput.safeParse({
      slug: "archive",
      unsupported: {}
    }).success,
    false
  );
  assert.throws(
    () => parse(storageBackendCreateInput, { slug: "" }),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "validation_error");
      assert.equal(
        error.message,
        "标识 slug 不能为空；" +
          "标识 slug 只能包含小写字母、数字、连字符，且不能以连字符开头或结尾"
      );
      assert.deepEqual(error.details, {
        formErrors: [],
        fieldErrors: {
          slug: [
            "标识 slug 不能为空",
            "标识 slug 只能包含小写字母、数字、连字符，且不能以连字符开头或结尾"
          ]
        }
      });
      return true;
    }
  );
  assert.equal(
    storageBackendUpdateInput.safeParse({
      display_name: "对象存储",
      unknown_option: true
    }).success,
    false
  );
  assert.equal(storageBackendTestInput.safeParse({}).success, false);
  assert.equal(storageBackendTestInput.safeParse({ slug: "archive" }).success, true);
  assert.equal(storageBackendTestInput.safeParse({ s3: {} }).success, true);
  assert.throws(
    () => parse(storageBackendTestInput, { slug: "bad_slug" }),
    (error) =>
      error instanceof ApiError &&
      error.status === 400 &&
      error.code === "validation_error" &&
      error.message === "标识 slug 只能包含小写字母、数字、连字符，且不能以连字符开头或结尾" &&
      JSON.stringify(error.details) ===
        JSON.stringify({
          formErrors: [],
          fieldErrors: {
            slug: ["标识 slug 只能包含小写字母、数字、连字符，且不能以连字符开头或结尾"]
          }
        })
  );
  assert.equal(
    storageBackendTestInput.safeParse({
      type: "s3",
      s3: { unknown_option: true }
    }).success,
    false
  );
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
  assert.equal(
    imageUpdateInput.safeParse({
      items: [{ id: imageId, title: "a", removed_field: true }]
    }).success,
    false
  );
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
  const secondImageId = "00000000-0000-7002-8000-00000000008e";
  assert.equal(imageSnapshotInput.safeParse({ ids: [imageId] }).success, true);
  assert.equal(
    imageSnapshotInput.safeParse({
      ids: [imageId, secondImageId]
    }).success,
    true
  );
  const duplicateSnapshot = imageSnapshotInput.safeParse({
    ids: [imageId, imageId.toUpperCase()]
  });
  assert.equal(duplicateSnapshot.success, false);
  if (!duplicateSnapshot.success) {
    assert.deepEqual(duplicateSnapshot.error.issues[0]?.path, ["ids", 1]);
  }
  assert.equal(imageActionInput.safeParse({ ids: [imageId] }).success, true);
  assert.equal(
    imageActionInput.safeParse({
      ids: [imageId, secondImageId]
    }).success,
    true
  );
  assert.equal(imageActionInput.safeParse({ ids: [] }).success, false);
  assert.equal(
    imageActionInput.safeParse({
      ids: [imageId, imageId.toUpperCase()]
    }).success,
    false
  );
  assert.equal(
    imagePurgeInput.safeParse({
      scope: "selected",
      ids: [imageId]
    }).success,
    true
  );
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
  assert.equal(
    imageStorageMigrationInput.safeParse({
      ids: [imageId],
      target: "archive"
    }).success,
    true
  );
  assert.equal(
    imageStorageMigrationInput.safeParse({
      ids: [imageId, imageId.toUpperCase()],
      target: "archive"
    }).success,
    false
  );
  assert.equal(
    storageBackendMigrationInput.safeParse({
      source: "local",
      target: "local"
    }).success,
    false
  );

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
  assert.equal(
    uploadIntentInput.parse({
      items: [{ ...uploadItem, idempotency_key: imageId.toUpperCase() }]
    }).items[0]?.idempotency_key,
    imageId
  );
  assert.equal(
    uploadIntentInput.safeParse({
      items: [{ ...uploadItem, expected_size: undefined }]
    }).success,
    false
  );
  assert.equal(
    uploadIntentInput.safeParse({
      items: [{ ...uploadItem, created_by: "forged-admin" }]
    }).success,
    false
  );
  const rejectedImportDownload = importAcceptInput.safeParse({
    items: [
      {
        ...commonIngestionMetadata,
        idempotency_key: imageId,
        batch_key: secondImageId,
        batch_position: 0,
        source_type: "url",
        download_url: "http://example.com/image.jpg"
      }
    ]
  });
  assert.equal(rejectedImportDownload.success, false);
  if (!rejectedImportDownload.success) {
    assert.equal(
      rejectedImportDownload.error.issues.some(
        (issue) => issue.message === "外部图片请求未通过安全校验"
      ),
      true,
      "真正的 Import 下载入口必须保留既有安全拒绝提示"
    );
  }
  assert.equal(
    importAcceptInput.safeParse({
      items: [
        {
          ...commonIngestionMetadata,
          idempotency_key: imageId,
          batch_key: secondImageId,
          batch_position: 0,
          source_type: "url",
          download_url: "https://example.com/image.jpg"
        }
      ]
    }).success,
    true
  );
  for (const [tags, expected] of [
    [tags50, true],
    [tags51, false]
  ] as const) {
    assert.equal(
      importAcceptInput.safeParse({
        items: [
          {
            ...commonIngestionMetadata,
            idempotency_key: imageId,
            batch_key: secondImageId,
            batch_position: 0,
            source_type: "jsonl",
            download_url: "https://example.com/image.jpg",
            tags
          }
        ]
      }).success,
      expected,
      "Import 合并后的标签仍受 50 个唯一标签边界约束"
    );
  }

  const uploadWithRepeatedTags = uploadIntentInput.parse({
    items: [
      {
        ...uploadItem,
        tags: repeatedTags,
        theme: " Theme-A ",
        author: " Author-A ",
        title: "  标题  "
      }
    ]
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
  assert.equal(
    uploadIntentInput.safeParse({
      items: [{ ...uploadItem, tags: tags50 }]
    }).success,
    true
  );
  assert.equal(
    uploadIntentInput.safeParse({
      items: [{ ...uploadItem, tags: tags51 }]
    }).success,
    false
  );
  assert.equal(
    imageUpdateInput.safeParse({
      items: [{ id: imageId, tags: tags50 }]
    }).success,
    true
  );
  assert.equal(
    imageUpdateInput.safeParse({
      items: [{ id: imageId, tags: tags51 }]
    }).success,
    false
  );

  const sessionId = "A".repeat(43);
  const unreachableDraft = ingestionSessionUpdateInput.parse({
    items: [
      {
        session_id: sessionId,
        image_id: imageId,
        expected_version: 1,
        metadata: {
          ...commonIngestionMetadata,
          original: " draft-image.invalid/image.jpg ",
          source: "draft-source.invalid/post"
        }
      }
    ]
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
  assert.equal(
    ingestionSessionUpdateInput.safeParse({
      items: [
        {
          session_id: sessionId,
          image_id: imageId,
          expected_version: 1,
          metadata: {
            ...commonIngestionMetadata,
            source: "https://127.0.0.1/source"
          }
        }
      ]
    }).success,
    true,
    "来源 URL 保留既有的 HTTPS IP 格式接受范围"
  );
  for (const [field, value, message] of [
    ["original", "http://example.com/image.jpg", "内容接入草稿原图 URL 格式无效"],
    ["original", "https://127.0.0.1/image.jpg", "内容接入草稿原图 URL 格式无效"],
    ["source", "https://user:password@example.com/post", "内容接入草稿来源 URL 格式无效"],
    ["source", "x".repeat(2_049), "内容接入草稿来源 URL 格式无效"]
  ] as const) {
    const rejectedDraft = ingestionSessionUpdateInput.safeParse({
      items: [
        {
          session_id: sessionId,
          image_id: imageId,
          expected_version: 1,
          metadata: { ...commonIngestionMetadata, [field]: value }
        }
      ]
    });
    assert.equal(rejectedDraft.success, false);
    if (!rejectedDraft.success) {
      assert.equal(
        rejectedDraft.error.issues.some((issue) => issue.message === message),
        true
      );
      assert.equal(
        rejectedDraft.error.issues.some((issue) => issue.message === "外部图片请求未通过安全校验"),
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
    items: [
      {
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
      }
    ]
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
  assert.equal(
    ingestionCommitIntentInput.safeParse({
      items: [
        {
          ...commitBinding,
          metadata: { device: "auto", brightness: "auto", tags: tags50 }
        }
      ]
    }).success,
    true
  );
  assert.equal(
    ingestionCommitIntentInput.safeParse({
      items: [
        {
          ...commitBinding,
          metadata: { device: "auto", brightness: "auto", tags: tags51 }
        }
      ]
    }).success,
    false
  );
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
  assert.equal(
    ingestionQueueActionInput.safeParse({
      ...boundedCompletedCleanup,
      action: "clear_queue"
    }).success,
    false,
    "semantic revision 上限只允许关闭时清理完成态"
  );
  const exactAttributeAction = {
    queue: "import",
    action: "apply_metadata",
    action_request_id: secondImageId,
    action_watermark: "signed-watermark",
    metadata: { theme: null, tags: [], author: null },
    items: [{ session_id: sessionId, image_id: imageId }]
  };
  assert.deepEqual(ingestionQueueActionInput.parse(exactAttributeAction), exactAttributeAction);
  for (const invalid of [
    { ...exactAttributeAction, items: [] },
    {
      ...exactAttributeAction,
      items: [...exactAttributeAction.items, ...exactAttributeAction.items]
    },
    { ...exactAttributeAction, items: [{ session_id: sessionId, image_id: "invalid" }] },
    { ...exactAttributeAction, continuation: "signed-continuation" },
    { ...exactAttributeAction, action: "clear_queue", metadata: undefined }
  ])
    assert.equal(ingestionQueueActionInput.safeParse(invalid).success, false);
  const boundedPairs = Array.from({ length: ingestionBatchHardLimit + 1 }, (_, index) => ({
    session_id: sessionId,
    image_id: `01900000-0000-7000-8000-${String(index).padStart(12, "0")}`
  }));
  assert.equal(
    ingestionQueueActionInput.safeParse({
      ...exactAttributeAction,
      items: boundedPairs.slice(0, ingestionBatchHardLimit)
    }).success,
    true
  );
  assert.equal(
    ingestionQueueActionInput.safeParse({
      ...exactAttributeAction,
      items: boundedPairs
    }).success,
    false
  );
  const invalidCommitId = ingestionCommitIntentInput.safeParse({
    items: [
      {
        ...commitBinding,
        image_id: "not-a-uuid",
        metadata: { device: "auto", brightness: "auto" }
      }
    ]
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
        commit_request_id: "00000000-0000-7003-8000-00000000008e",
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
      items: [
        {
          ...commitBinding,
          [field]: value,
          metadata: { device: "auto", brightness: "auto" }
        }
      ]
    });
    assert.equal(invalidBinding.success, false, field);
    if (!invalidBinding.success) {
      assert.deepEqual(invalidBinding.error.issues[0]?.path, ["items", 0, field]);
    }
  }
  assert.equal(
    ingestionStatusInput.safeParse({
      items: [{ session_id: sessionId, image_id: imageId }]
    }).success,
    true
  );
  assert.equal(
    ingestionStatusInput.safeParse({
      items: [
        { session_id: sessionId, image_id: imageId },
        { session_id: sessionId, image_id: imageId.toUpperCase() }
      ]
    }).success,
    false
  );
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
  app.use(`${adminApiBasePath}/*`, limitProtectedAdminRequestBody);
  registerAdminImageRoutes(app as unknown as Hono);
  registerPublicRoutes(app as unknown as Hono);

  const post = (
    path: string,
    body: string,
    role: "super" | "image" = "super"
  ) =>
    app.request(
      new Request(`http://imageshow.test${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-test-role": role
        },
        body
      })
    );
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
    const response = await app.request(
      new Request(`http://imageshow.test${adminApiBasePath}/images?${query}`, {
        headers: { "x-test-role": "super" }
      })
    );
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
    const response = await app.request(
      new Request(`http://imageshow.test/api/images?view=gallery&limit=60&${query}`)
    );
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
    ((await aboveImageUpdateTier.json()) as { code?: string }).code,
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
  ) =>
    new Promise<unknown[]>((resolve) => {
      (lookup as unknown as RawLookup)(hostname, options, (...args) => resolve(args));
    });
  const addressAllowed = async (address: string, family: number) => {
    const lookup = createExternalImageLookup(async () => [{ address, family }]);
    const [error] = await invokeLookup(lookup);
    return error === null;
  };
  const bytesToValue = (bytes: number[]) =>
    bytes.reduce(
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
    ].map((value) =>
      value === null
        ? null
        : ipaddr.fromByteArray(valueToBytes(value, baseBytes.length)).toString()
    );
  };

  const ipv4BoundaryExpectations: Readonly<Record<string, readonly (boolean | null)[]>> = {
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
  const ipv6BoundaryExpectations: Readonly<Record<string, readonly (boolean | null)[]>> = {
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
    const actual = await Promise.all(
      cidrBoundaryAddresses(cidr).map((address) =>
        address === null ? null : addressAllowed(address, 4)
      )
    );
    assert.deepEqual(actual, expected, `IPv4 boundary ${cidr}`);
  }
  for (const [cidr, expected] of Object.entries(ipv6BoundaryExpectations)) {
    const actual = await Promise.all(
      cidrBoundaryAddresses(cidr).map((address) =>
        address === null ? null : addressAllowed(address, 6)
      )
    );
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
  const failedDnsArgs = await invokeLookup(
    createExternalImageLookup(async () => {
      throw dnsCause;
    })
  );
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
    storage_slug: item.storage_slug
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
  let servingRecord = record;
  const resolvedObject = (
    prefix: "large" | "medium" | "small",
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
    readImageServingRecordById: async () => servingRecord,
    resolveReadableObject: async (
      prefix: "large" | "medium" | "small",
      key: string,
      backend: string
    ) =>
      resolvedObject(prefix, key, "", backend),
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

  const objectResponse = await servePublicStoredObject("large", storageObjectKey(item.id),
    request,
    baseDependencies as never
  );
  assert.equal(objectResponse.status, 206);
  assert.equal(streamCalls[0]?.object.prefix, "large");
  assert.equal(streamCalls[0]?.contentType, "image/webp");
  assert.equal(streamCalls[0]?.cacheControl, immutableCacheControl);
  assertForwardedRequest(streamCalls[0]?.request);

  const getRequest = { ...request, isHead: false };
  for (const storageSlug of ["local", "s3-private"]) {
    servingRecord = { ...record, storage_slug: storageSlug };
    const stableResponse = await servePublicStoredObject("large", storageObjectKey(item.id),
      getRequest,
      baseDependencies as never
    );
    assert.deepEqual(
      Buffer.from(await stableResponse.arrayBuffer()),
      storedBytes
    );
    assert.equal(streamCalls.at(-1)?.object.storageSlug, storageSlug);
    assert.equal(streamCalls.at(-1)?.cacheControl, immutableCacheControl);
  }
  servingRecord = { ...record, storage_slug: "s3-public" };

  const redirectResponse = await servePublicStoredObject("large", storageObjectKey(item.id),
    request,
    {
      ...baseDependencies,
      resolveReadableObject: async (
        prefix: "large" | "medium" | "small",
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
  const thumbnailResponse = await servePublicStoredObject("small", storageObjectKey(item.id),
    request,
    baseDependencies as never
  );
  assert.equal(thumbnailResponse.status, 206);
  assert.equal(streamCalls.length, 1);
  assert.equal(streamCalls[0]?.object.prefix, "small");
  assert.equal(streamCalls[0]?.cacheControl, immutableCacheControl);
  assertForwardedRequest(streamCalls[0]?.request);

  for (const storageSlug of ["local", "s3-private"]) {
    servingRecord = { ...record, storage_slug: storageSlug };
    const stableThumbnail = await servePublicStoredObject("small", storageObjectKey(item.id),
      getRequest,
      baseDependencies as never
    );
    assert.deepEqual(
      Buffer.from(await stableThumbnail.arrayBuffer()),
      storedBytes
    );
    assert.equal(streamCalls.at(-1)?.object.storageSlug, storageSlug);
    assert.equal(streamCalls.at(-1)?.cacheControl, immutableCacheControl);
  }

  streamCalls.length = 0;
  servingRecord = { ...record, storage_slug: "s3-public" };
  const thumbnailRedirect = await servePublicStoredObject("small", storageObjectKey(item.id),
    request,
    {
      ...baseDependencies,
      resolveReadableObject: async (
        prefix: "large" | "medium" | "small",
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
    servePublicStoredObject("small", storageObjectKey(item.id),
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
    servePublicStoredObject("small", storageObjectKey(item.id),
      request,
      {
        ...baseDependencies,
        streamResolvedObject: async () => {
          throw new ApiError(503, "storage_read_unavailable", "unavailable");
        }
      } as never
    ),
    (error) =>
      error instanceof ApiError
        && error.status === 503
        && error.code === "storage_read_unavailable"
  );

  let invalidKeyRead = false;
  await assert.rejects(
    servePublicStoredObject("large", `${item.id}.jpg/../secret`, request, {
      ...baseDependencies,
      readImageServingRecordById: async () => {
        invalidKeyRead = true;
        return record;
      }
    } as never),
    (error) => error instanceof ApiError
      && error.status === 404
      && error.code === "not_found"
  );
  assert.equal(invalidKeyRead, false);

  let invalidThumbnailKeyRead = false;
  await assert.rejects(
    servePublicStoredObject("small", `${item.id.slice(-2)}/${item.id}.jpg`, request, {
      ...baseDependencies,
      readImageServingRecordById: async () => {
        invalidThumbnailKeyRead = true;
        return record;
      }
    } as never),
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
    original: item.original,
    storage_slug: item.storage_slug,
    updated_at: item.updated_at
  };
  const proxyCalls: unknown[][] = [];
  let direct = false;
  let readCount = 0;
  const dependencies = {
    readImageServingRecordById: async () => {
      readCount += 1;
      return record;
    },
    displayUrlForOriginalComparison: async () =>
      `https://img.example.com/images/large/${storageObjectKey(item.id)}`,
    supportsDirectAccess: async () => direct,
    proxyExternalImage: async (...args: unknown[]) => {
      proxyCalls.push(args);
      return new Response(null, { status: 207 });
    }
  };

  const proxySignal = new AbortController().signal;
  const proxyResponse = await serveAdminExternalOriginal(
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
    "Cache-Control": privateRevalidationCacheControl,
    Vary: "Cookie, User-Agent",
    "Referrer-Policy": "no-referrer"
  });

  direct = true;
  const directRedirect = await serveAdminExternalOriginal(
    item.id,
    { signal: neverAbortedSignal, userAgent: "fixture-agent" },
    dependencies as never
  );
  assert.equal(readCount, 2);
  assert.equal(proxyCalls.length, 1);
  assert.equal(directRedirect.status, 302);
  assert.equal(directRedirect.headers.get("Location"), item.original);
  assert.equal(
    directRedirect.headers.get("Cache-Control"),
    privateRevalidationCacheControl
  );
  assert.equal(directRedirect.headers.get("Referrer-Policy"), "no-referrer");

  assert.equal(directRedirect.headers.get("Vary"), "Cookie, User-Agent");
  const redirectUrls = [
    ["https://img.example.com/照片.webp", "https://img.example.com/%E7%85%A7%E7%89%87.webp"],
    [
      "https://例子.中国/p.png?标题=照片",
      "https://xn--fsqu00a.xn--fiqs8s/p.png?%E6%A0%87%E9%A2%98=%E7%85%A7%E7%89%87"
    ],
    [
      "https://img.example.com/café.png?sig=a%2Bb%2Fc+d&x=1&x=2",
      "https://img.example.com/caf%C3%A9.png?sig=a%2Bb%2Fc+d&x=1&x=2"
    ]
  ];
  for (const [original, expected] of redirectUrls) {
    for (const method of ["GET", "HEAD"] as const) {
      const response = await serveAdminExternalOriginal(
        item.id,
        { signal: neverAbortedSignal, method },
        {
          ...dependencies,
          readImageServingRecordById: async () => ({ ...record, original })
        }
      );
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("Location"), expected);
      assert.equal(response.headers.get("Cache-Control"), privateRevalidationCacheControl);
      assert.equal(response.headers.get("Vary"), "Cookie, User-Agent");
      assert.equal(await response.text(), "");
    }
  }
  for (const control of ["\r", "\n", "\t", "\u200b"]) {
    await assert.rejects(
      serveAdminExternalOriginal(
        item.id,
        { signal: neverAbortedSignal },
        {
          ...dependencies,
          readImageServingRecordById: async () => ({
            ...record,
            original: `https://img.example.com/${control}photo.png`
          })
        }
      ),
      /Unsafe Location/
    );
  }
  for (const unavailable of [
    null,
    { ...record, original: "" },
    {
      ...record,
      original: `https://img.example.com/images/large/${storageObjectKey(item.id)}`
    }
  ]) {
    await assert.rejects(
      serveAdminExternalOriginal(
        item.id,
        { signal: neverAbortedSignal },
        {
          ...dependencies,
          readImageServingRecordById: async () => unavailable
        }
      ),
      (error: { status?: number; code?: string }) =>
        error.status === 404 && error.code === "not_found"
    );
  }
});
test("[Server/图片] 原图代理使用私有重验证缓存，条件请求及 HEAD 释放上游正文", async (t) => {
  const { proxyExternalImage } =
    await import("../../../packages/server/src/images/external-image-proxy.ts");
  const { proxyEtagForUpstream } =
    await import("../../../packages/server/src/core/http/proxy-validators.ts");
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const url = "https://original.example.test/image.png";
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  const updatedAt = "2026-09-01T00:00:00.000Z";
  const baseHeaders = {
    "Cache-Control": privateRevalidationCacheControl,
    Vary: "Cookie, User-Agent"
  };
  const expires = "Wed, 09 Sep 2037 00:00:00 GMT";
  const policies: Array<Record<string, string>> = [
    {},
    { "Cache-Control": "public, max-age=120" },
    { "Cache-Control": "no-store" },
    { Expires: expires }
  ];
  for (const method of ["GET", "HEAD"] as const) {
    for (const policy of policies) {
      let cancelled = 0;
      globalThis.fetch = async (input, init) => {
        assert.equal(String(input), url);
        assert.equal(init?.method, method);
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("Referer"), "https://original.example.test/");
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(image);
              if (method === "GET") controller.close();
            },
            cancel() {
              cancelled++;
            }
          }),
          { headers: { "content-type": "image/png", etag: '"origin"', ...policy } }
        );
      };
      const response = await proxyExternalImage(
        url,
        "png",
        {
          method,
          signal: neverAbortedSignal,
          validators: { resourceUpdatedAt: updatedAt }
        },
        baseHeaders
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), privateRevalidationCacheControl);
      assert.equal(response.headers.get("Expires"), null);
      assert.equal(response.headers.get("Vary"), "Cookie, User-Agent");
      assert.equal(response.headers.get("ETag"), proxyEtagForUpstream(url, '"origin"'));
      if (method === "HEAD") {
        assert.equal(await response.text(), "");
        assert.equal(cancelled, 1);
      } else {
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
      }
    }
  }
  globalThis.fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get("If-None-Match"), '"origin"');
    return new Response(null, { status: 304, headers: { etag: '"origin"' } });
  };
  const revalidated = await proxyExternalImage(
    url,
    "png",
    {
      method: "GET",
      signal: neverAbortedSignal,
      validators: {
        resourceUpdatedAt: updatedAt,
        ifNoneMatch: proxyEtagForUpstream(url, '"origin"')!
      }
    },
    baseHeaders
  );
  assert.equal(revalidated.status, 304);
  assert.equal(await revalidated.text(), "");
  assert.equal(revalidated.headers.get("Cache-Control"), privateRevalidationCacheControl);
  assert.equal(revalidated.headers.get("Vary"), "Cookie, User-Agent");
  let failedBodyCancelled = 0;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        cancel() {
          failedBodyCancelled++;
        }
      }),
      { status: 503 }
    );
  const fallback = await proxyExternalImage(
    url,
    "png",
    { method: "GET", signal: neverAbortedSignal },
    baseHeaders
  );
  assert.equal(fallback.status, 302);
  assert.equal(fallback.headers.get("Location"), url);
  assert.equal(fallback.headers.get("Cache-Control"), "no-store");
  assert.equal(failedBodyCancelled, 1);
  await assert.rejects(
    proxyExternalImage(
      "https://127.0.0.1/private.png",
      "png",
      { method: "GET", signal: neverAbortedSignal },
      baseHeaders
    ),
    (error: { code?: string }) => error.code === "external_image_rejected"
  );
});

test("[Server/图片] 标准化生成三档 WebP、保留来源尺寸并响应取消", async () => {
  initializeRuntimeConfig(); configureSharpRuntime();
  assert.equal(sharp.concurrency(), 1);
  const root = await createTestDirectory("imageshow-processing-");
  const settings = defaultNormalizeProfile();
  try {
    for (const format of ["jpeg", "png", "webp", "gif", "avif"] as const) {
      const path = join(root, "source." + format);
      await sharp({create:{width:800,height:400,channels:3,background:"#4578ab"}}).toFormat(format).toFile(path);
      const result = await transcodeStoredImage(path, settings, neverAbortedSignal);
      assert.deepEqual([result.sourceWidth,result.sourceHeight],[800,400]);
      for (const variant of ["large","medium","small"] as const) {
        const output = result.variants[variant];
        const metadata = await sharp(output.data).metadata();
        assert.equal(metadata.format,"webp");
        assert.equal(output.data.length,output.facts.bytes);
        assert.equal(createHash("md5").update(output.data).digest("hex"),output.facts.md5);
        assert.deepEqual([metadata.width,metadata.height],variant==="small"?[600,300]:[800,400]);
      }
    }
    const corrupt = join(root,"corrupt.jpg");await writeFile(corrupt,Buffer.from([0xff,0xd8,0,0]));
    await assert.rejects(transcodeStoredImage(corrupt, settings, neverAbortedSignal));
    await assert.rejects(transcodeStoredImage(corrupt,settings,AbortSignal.abort()),{name:"AbortError"});
    const unsupported = join(root,"source.tiff");await sharp({create:{width:32,height:16,channels:3,background:"red"}}).tiff().toFile(unsupported);
    await assert.rejects(transcodeStoredImage(unsupported, settings, neverAbortedSignal));
    const oversized=join(root,"oversized.png");await sharp({create:{width:getIngestionMaxLongEdge()+1,height:1,channels:3,background:"black"}}).png().toFile(oversized);
    await assert.rejects(transcodeStoredImage(oversized, settings, neverAbortedSignal));
  } finally {await rm(root,{recursive:true,force:true});}
});
test("[Server/图片] 图片时间、UUIDv7、游标、分类和统一筛选保持一致", () => {
  const parsedTime = parseImageTime("2020-05-01 00:00:00", {
    timeZone: "Asia/Makassar"
  });
  assert.equal(parsedTime.iso, "2020-04-30T16:00:00.000Z");
  assert.throws(() => parseImageTime("1969-12-31T23:59:59Z"), /1970/);

  const id = createImageId(new Date(parsedTime.iso));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(
    Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16),
    Date.parse(parsedTime.iso)
  );

  const context = createImageBrowseContext("latest");
  const cursorId = "00000000-0000-7000-8000-0000000000ab";
  const positions = [
    { time: "2020-04-30T16:00:00.123456Z", score: 1_588_262_400_123_456 },
    { time: "1684-07-28T00:12:25.259009Z", score: Number.MIN_SAFE_INTEGER },
    { time: "1969-12-31T23:59:59.999999Z", score: -1 },
    { time: "1970-01-01T00:00:00.000000Z", score: 0 },
    { time: "2255-06-05T23:47:34.740991Z", score: Number.MAX_SAFE_INTEGER }
  ];
  for (const { time, score } of positions) {
    const row = { cursor_image_time: time, id: cursorId };
    const encoded = encodeImageCursor(row, context);
    assert.equal(encoded.length, 31);
    assert.equal(encodeImageCursor({ id: cursorId, sort_score: score }, context), encoded);
    for (const order of ["latest", "oldest"] as const) {
      assert.deepEqual(decodeImageCursor(encoded, createImageBrowseContext(order)), {
        imageTime: time,
        id: cursorId,
        sortScore: score,
        phase: 0
      });
    }
  }
  const adjacent = [1_588_262_400_123_456, 1_588_262_400_123_457].map((sort_score) =>
    encodeImageCursor({ id: cursorId, sort_score }, context)
  );
  assert.notEqual(adjacent[0], adjacent[1]);
  assert.equal(decodeImageCursor(adjacent[1]!, context).imageTime, "2020-04-30T16:00:00.123457Z");
  for (const sort_score of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => encodeImageCursor({ id: cursorId, sort_score }, context),
      /Invalid image list cursor row/
    );
  }
  const fixedCursorRow = { cursor_image_time: positions[0]!.time, id: cursorId };
  const encoded = encodeImageCursor(fixedCursorRow, context);
  for (const invalid of [
    "invalid",
    encoded.slice(1),
    `${encoded}=`,
    `${encoded.slice(0, -1)}!`,
    `${encoded.slice(0, -1)}B`
  ]) {
    assert.throws(() => decodeImageCursor(invalid, context), /Invalid image list cursor/);
  }
  const invalidUuid = Buffer.from(encoded, "base64url");
  invalidUuid[15] = 0;
  assert.throws(
    () => decodeImageCursor(invalidUuid.toString("base64url"), context),
    /Invalid image list cursor/
  );
  assert.throws(
    () =>
      encodeImageCursor(
        { ...fixedCursorRow, cursor_image_time: "2255-06-05T23:47:34.740992Z" },
        context
      ),
    /Invalid image list cursor row/
  );
  assert.throws(
    () => encodeImageCursor({ ...fixedCursorRow, id: "not-a-uuid" }, context),
    /Invalid image list cursor row/
  );

  // The day number remains exact across the epoch and beyond a 16-bit counter.
  for (const day of [-1, 0, 65_536]) {
    const now = day * 86_400_000;
    const randomContext = createImageBrowseContext("random", now);
    for (const suffix of ["000000000000", "ffffffffffff"]) {
      const id = `ffffffff-ffff-7fff-bfff-${suffix}`;
      const randomCursor = encodeImageCursor({ ...fixedCursorRow, id }, randomContext);
      assert.equal(randomCursor.length, 26);
      assert.deepEqual(decodeImageCursor(randomCursor, randomContext), {
        id,
        imageTime: "",
        sortScore: Number.parseInt(suffix, 16),
        phase: suffix[0] === "0" ? 1 : 0
      });
      assert.throws(
        () => decodeImageCursor(randomCursor,
          createImageBrowseContext("random", now + 86_400_000)),
        { code: "cursor_expired" }
      );
      assert.throws(() => decodeImageCursor(`${randomCursor.slice(0, -1)}B`, randomContext), {
        code: "invalid_cursor"
      });
    }
  }

  assert.equal(deviceFromDimensions(1920, 1080), "pc");
  assert.equal(deviceFromDimensions(800, 1200), "mb");
  assert.deepEqual(
    resolveClassification(
      { device: "auto", brightness: "light" },
      { device: "mb", brightness: "dark" }
    ),
    { device: "mb", brightness: "light" }
  );

  const plan = createImageFilterPlan({
    devices: ["pc"],
    tag: { anyOf: [["live"], ["stage"], ["live"]] },
    author: { exclude: ["blocked"] }
  });
  assert.deepEqual(plan.tag, { anyOf: [["live"], ["stage"]] });
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
  assert.throws(
    () =>
      createImageFilterPlan({
        author: { include: ["owner"], exclude: ["blocked"] }
      }),
    /Cannot mix include and exclude/
  );
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

  const publicCursorId = "00000000-0000-7002-8000-00000000008d";
  const publicCursorTime = "2026-08-03T12:00:00.000000Z";
  await fetchPublicImageCardPage(
    ["status=$1"],
    ["ready"],
    60,
    createImageBrowseContext("oldest"),
    "gallery",
    { imageTime: publicCursorTime, id: publicCursorId, sortScore: 0, phase: 0 },
    reader
  );
  assert.match(sql, /\(image_time, id\) > \(\$3::timestamptz, \$4::uuid\)/);
  assert.match(sql, /ORDER BY image_time ASC, id ASC/);
  assert.match(sql, /LIMIT \$2/);
  assert.deepEqual(sqlParams, [
    "ready",
    61,
    publicCursorTime,
    publicCursorId
  ]);

  const first = servingReadyCacheItem({ id: randomUUID() });
  const second = servingReadyCacheItem({ id: randomUUID() });
  const members = [readyImageMember(first.id), readyImageMember(second.id)];
  let memberWindow: [number, number] | null = null;
  let hydrationCalls = 0;
  const dependencies: ReadyImageWindowDependencies = {
    validate: async () => ({ status: "valid", count: 5 }),
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
  assert.deepEqual(
    window?.items.map((item) => item.id),
    [first.id, second.id]
  );
  assert.equal(window?.total, 5);

  memberWindow = null;
  hydrationCalls = 0;
  assert.deepEqual(await readReadyImageOrderedWindow(
    index,
    5,
    2,
    "fallback",
    dependencies
  ), {
    items: [],
    total: 5
  });
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
    validate: async () => ({ status: "valid", count: 1 }),
    members: async () => [members[0]!],
    items: async () => [serializeReadyImageCacheItem(first)],
    assertDerivedItems: async () => undefined
  };
  for (const stage of ["validate", "members", "items"] as const) {
    const failure = new Error(`controlled Redis ${stage} failure`);
    await assert.rejects(
      readReadyImageOrderedWindow(oneItemIndex, 0, 1, "required", {
        ...operationalDependencies,
        [stage]: async () => {
          throw failure;
        }
      }),
      (error) => isRedisUnavailableError(error)
        && error.cause === failure
    );
  }
  await assert.rejects(
    readReadyImageOrderedWindow(oneItemIndex, 0, 1, "fallback", {
      ...operationalDependencies,
      items: async () => []
    }),
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
    theme: new Map([
      ["舞台", "stage"],
      ["stage", "stage"]
    ]),
    tag: new Map([
      ["现场", "live"],
      ["live", "live"]
    ]),
    author: new Map([
      ["摄影师", "photographer"],
      ["photographer", "photographer"]
    ])
  };

  const omittedDevice = parseQuery("");
  const explicitAuto = parseQuery("device=auto");
  assert.equal(omittedDevice.device, "auto");
  assert.equal(omittedDevice.size, "medium");
  for (const defaultSize of ["large", "medium", "small"] as const) {
    for (const mode of ["proxy", "redirect", "json"]) {
      for (const explicitSize of ["", "large", "medium", "small"]) {
        const query = parseRandomQuery(
          new URL(
            `https://img.example.com/random?mode=${mode}${explicitSize ? `&size=${explicitSize}` : ""}`
          ),
          "redirect",
          defaultSize
        );
        assert.ok(!(query instanceof Response));
        assert.equal(query.size, explicitSize || defaultSize);
      }
    }
  }
  assert.equal(explicitAuto.device, "auto");
  const normalizedOmitted = normalizeRandomQuery(omittedDevice, maps);
  const normalizedAuto = normalizeRandomQuery(explicitAuto, maps);
  assert.equal(normalizedOmitted instanceof Response, false);
  assert.equal(normalizedAuto instanceof Response, false);
  if (normalizedOmitted instanceof Response
    || normalizedAuto instanceof Response) {
    assert.fail("auto 随机查询未完成归一化");
  }
  assert.equal(normalizedOmitted.signature, normalizedAuto.signature);
  for (const size of ["small", "large"] as const) {
    const sized = normalizeRandomQuery(parseQuery(`size=${size.toUpperCase()}`), maps);
    assert.ok(!(sized instanceof Response));
    assert.equal(sized.size, size);
    assert.equal(
      sized.signature,
      normalizedOmitted.signature,
      "size does not partition selection or dedupe"
    );
    assert.equal(parseQuery(`id=${imageId}&size=${size}`).size, size);
    assert.equal(parseQuery(`seed=synthetic-seed&size=${size}`).size, size);
  }
  assert.equal(
    normalizedOmitted.signature,
    '{"d":"","b":"","t":{"include":[],"exclude":[]},' +
      '"tag":null,' +
      '"a":{"include":[],"exclude":[]}}'
  );
  assert.equal(
    detectDeviceFromUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    ),
    "pc"
  );
  assert.equal(
    detectDeviceFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"),
    "mb"
  );
  assert.equal(detectDeviceFromUserAgent("unrecognized-client"), null);
  assert.deepEqual(
    resolveCandidateAxes("auto", null, "Mozilla/5.0 (Windows NT 10.0)").deviceCandidates,
    ["pc"]
  );
  assert.deepEqual(resolveCandidateAxes("auto", null, "Mozilla/5.0 (iPhone)").deviceCandidates, [
    "mb"
  ]);
  assert.deepEqual(resolveCandidateAxes("auto", null, "unrecognized-client").deviceCandidates, [
    "pc",
    "mb"
  ]);
  assert.deepEqual(resolveCandidateAxes("all", null, "Mozilla/5.0 (iPhone)").deviceCandidates, [
    "pc",
    "mb"
  ]);

  const normalized = normalizeRandomQuery(
    parseQuery(
      "device=PC&brightness=DARK&theme=%E8%88%9E%E5%8F%B0&tag=%E7%8E%B0%E5%9C%BA&author=%E6%91%84%E5%BD%B1%E5%B8%88&mode=PROXY"
    ),
    maps
  );
  assert.equal(normalized instanceof Response, false);
  if (normalized instanceof Response) assert.fail("随机图选择器未完成归一化");
  assert.deepEqual(normalized.theme, { include: ["stage"], exclude: [] });
  assert.deepEqual(normalized.tag, { anyOf: [["live"]] });
  assert.deepEqual(normalized.author, { include: ["photographer"], exclude: [] });
  assert.equal(normalized.device, "pc");
  assert.equal(normalized.brightness, "dark");
  assert.equal(normalized.mode, "proxy");

  const targeted = parseQuery("id=" + imageId + "&id=00000000008d&device=auto&mode=json&limit=2");
  assert.deepEqual(targeted.ids, [imageId, "00000000008d"].sort());
  assert.equal(targeted.mode, "json");
  assert.equal(targeted.limit, 2);
  assert.equal(targeted.device, "auto");
  assert.deepEqual(parseQuery("id=" + imageId + "&device=all").ids, [imageId]);

  // Scope, filters and selection combine freely; repeats of one value count once.
  const combined = parseQuery(
    `id=${imageId}&seed=s&device=pc&brightness=dark&theme=stage&tag=live&author=photographer&mode=json&limit=2`
  );
  assert.deepEqual(combined.ids, [imageId]);
  assert.equal(combined.seed, "s");
  assert.equal(combined.device, "pc");
  assert.equal(combined.limit, 2);
  assert.equal(parseQuery("brightness=ALL").brightness, null);
  for (const mode of ["proxy", "redirect", "json"]) {
    assert.equal(parseQuery(`limit=1&mode=${mode}`).limit, 1, mode);
  }
  assert.equal(parseQuery("size=small&size=SMALL").size, "small");
  assert.equal(parseQuery("device=&device=pc").device, "pc");
  assert.equal(parseQuery("seed=x&seed=&seed=x").seed, "x");
  assert.equal(parseQuery("mode=json&limit=&limit=02&limit=2").limit, 2);
  assert.deepEqual(parseQuery("theme=stage,!&author=!,").theme, { include: ["stage"], exclude: [] });
  const signatureOf = (search: string) => {
    const result = normalizeRandomQuery(parseQuery(search), maps);
    assert.ok(!(result instanceof Response), search);
    return result;
  };
  const mixed = signatureOf("theme=舞台,!unknown-theme&author=!nobody,photographer");
  assert.deepEqual(mixed.theme, { include: ["stage"], exclude: [] });
  assert.deepEqual(mixed.author, { include: ["photographer"], exclude: [] });
  assert.equal(mixed.signature, signatureOf("theme=stage&author=photographer").signature);
  assert.equal(signatureOf("brightness=all").signature, signatureOf("").signature);
  const emptiedByExclusion = normalizeRandomQuery(parseQuery("theme=舞台,!stage"), maps);
  assert.ok(emptiedByExclusion instanceof Response);
  assert.equal(emptiedByExclusion.status, 404);
  const targetedSignature = signatureOf(`id=${imageId}`).signature;
  assert.notEqual(targetedSignature, signatureOf("").signature);
  assert.equal(signatureOf(`id=${imageId}&device=auto`).signature, targetedSignature);
  assert.notEqual(signatureOf(`id=${imageId}&device=all`).signature, targetedSignature);

  // Blank optional values mean "not provided", so they do not filter.
  const blank = parseQuery("device=&brightness=%20&theme=,&author=&tag=,&tag=all:&mode=&size=&limit=");
  assert.equal(blank.device, "auto");
  assert.equal(blank.brightness, null);
  assert.deepEqual(blank.theme, { include: [], exclude: [] });
  assert.deepEqual(blank.author, { include: [], exclude: [] });
  assert.equal(blank.tag, null);
  assert.equal(blank.mode, "redirect");
  assert.equal(blank.size, "medium");
  assert.equal(blank.limit, 1);
  assert.deepEqual(parseQuery("tag=all:a,,b&tag=c,").tag, { anyOf: [["a", "b"], ["c"]] });
  assert.deepEqual(parseQuery(`id=${imageId}&device=&theme=&tag=`).ids, [imageId]);

  for (const search of [
    "tag=live&tag=!blocked",
    "device=pc&device=mb",
    "id=",
    "id=,",
    "limit=2",
    "limit=0",
    "mode=json&limit=2&limit=3",
    "unknown=value",
    "device=invalid",
    "brightness=invalid",
    "size=invalid-size",
    "size=%20full",
    "size=large&size=small",
    "size=small&limit=2"
  ]) {
    const result = parseRandomQuery(
      new URL("https://img.example.com/random?" + search),
      "redirect"
    );
    assert.equal(result instanceof Response, true, search);
    assert.equal((result as Response).status, 400, search);
  }
});
test("[Server/图片] 固定 seed 保留 Unicode 原值并支持 JSON 数量与组合参数", () => {
  const parse = (search: string) =>
    parseRandomQuery(new URL(`https://img.example.com/random?${search}`), "redirect");
  for (const seed of ["wallpaper", "Wallpaper", "  wallpaper  ", "2026-09-15", "图😀".repeat(64)]) {
    for (const mode of ["proxy", "redirect", "json"]) {
      const result = parse(new URLSearchParams({ seed, mode }).toString());
      assert.ok(!(result instanceof Response));
      assert.equal(result.seed, seed);
      assert.equal(result.limit, 1);
      assert.equal(result.mode, mode);
    }
  }
  const ordinary = parse("");
  assert.ok(!(ordinary instanceof Response));
  assert.equal(ordinary.seed, null);
  for (const limit of [1, 2, 200, 201]) {
    const explicit = parse(`seed=fixed&mode=json&limit=${limit}`);
    assert.ok(!(explicit instanceof Response));
    assert.equal(explicit.limit, Math.min(limit, 200));
  }
  for (const search of ["seed=a&seed=a", "seed=a&mode=redirect&limit=1", `seed=a&id=${imageId}`]) {
    const result = parse(search);
    assert.ok(!(result instanceof Response), search);
    assert.equal(result.seed, "a", search);
  }
  for (const search of [
    "seed=",
    "seed=+%20",
    "seed=%00",
    "seed=%0A",
    "seed=%7F",
    `seed=${encodeURIComponent("😀".repeat(129))}`,
    "seed=a&seed=b",
    "seed=a&seed=a%20",
    "seed=&seed=",
    "seed=fixed&mode=json&limit=0"
  ]) {
    const result = parse(search);
    assert.ok(result instanceof Response, search);
    assert.equal(result.status, 400, search);
  }
});

test("[Server/图片] 图片处理共享许可并同时限制 commit 数量和字节", async () => {
  const cancellationError = (signal: AbortSignal) => signal.reason ?? new Error("cancelled");
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
    prepare: <Result>(admissionSignal: AbortSignal, work: () => Promise<Result>) =>
      normalizeAdmission.run(admissionSignal, work),
    commit: <Result>(
      bytes: number,
      admissionSignal: AbortSignal,
      work: () => Promise<Result>
    ) =>
      commitAdmission.run(admissionSignal, () =>
        commitByteAdmission.run(bytes, admissionSignal, work)
      )
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
  assert.ok(stageStarts.indexOf("import-prepare") > stageStarts.indexOf("upload-prepare"));

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

  await assert.rejects(
    pools.commit(10, signal, async () => {
      throw new Error("commit failed");
    })
  );
  assert.equal(await pools.commit(10, signal, async () => "released"), "released");
});
test("[Server/图片] 标准化取消等待当前编码收口且不进入后续质量或档位", async (t) => {
  initializeRuntimeConfig(); const root=await createTestDirectory("encode-cancel-");
  t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,"source.png");
  await sharp({create:{width:8,height:8,channels:3,background:"red"}}).png().toFile(path);
  const settings=defaultNormalizeProfile();
  await assert.rejects(transcodeStoredImage("missing-file",settings,AbortSignal.abort()),{name:"AbortError"});
  const original=sharp.prototype.toBuffer;t.after(()=>{sharp.prototype.toBuffer=original;});
  for(const cancelAt of [1,2,3]) {
    const abort=new AbortController(),reason=new Error("cancel encode");
    let release!:()=>void,start!:()=>void;const gate=new Promise<void>(r=>{release=r;});const started=new Promise<void>(r=>{start=r;});let encodes=0;
    sharp.prototype.toBuffer=async function(){if(++encodes===cancelAt){start();await gate;}return {data:Buffer.alloc(900*1024),info:{width:8,height:8}};} as typeof sharp.prototype.toBuffer;
    let settled=false;const pending=transcodeStoredImage(path,settings,abort.signal).finally(()=>{settled=true;});
    const rejected=assert.rejects(pending,e=>e===reason);await started;abort.abort(reason);await delay(0);assert.equal(settled,false);release();await rejected;assert.equal(encodes,cancelAt);
  }
});
test("[Server/图片] 安全抓取在预取消时不联网，原图代理取消不 fallback，超时错误码与导入正文中断清理保持正确", async (t) => {
  const { safeFetchExternalImage } =
    await import("../../../packages/server/src/core/external-image-fetch.ts");
  const { proxyExternalImage } =
    await import("../../../packages/server/src/images/external-image-proxy.ts");
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    throw Error("must not fetch");
  };
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(
    safeFetchExternalImage("https://example.com/image", { signal: pre.signal, timeoutMs: 1000 }),
    (e: any) => e.code === "external_image_cancelled"
  );
  await assert.rejects(
    proxyExternalImage(
      "https://example.com/image",
      "png",
      { method: "GET", signal: pre.signal },
      {}
    )
  );
  assert.equal(fetches, 0);
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  for (const phase of ["headers", "body"] as const) {
    const abort = new AbortController();
    const reason = new Error("cancel " + phase);
    let signal!: AbortSignal;
    let markFetched!: () => void;
    const fetched = new Promise<void>((resolve) => {
      markFetched = resolve;
    });
    globalThis.fetch = async (_url, init) => {
      fetches++;
      signal = init!.signal!;
      markFetched();
      if (phase === "headers")
        return new Promise<Response>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        );
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(image);
            signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          }
        }),
        { headers: { "content-type": "image/png" } }
      );
    };
    const pending = proxyExternalImage(
      "https://example.com/image",
      "png",
      { method: "GET", signal: abort.signal },
      {}
    );
    if (phase === "headers") {
      const rejection = assert.rejects(pending, (error) => error === reason);
      await fetched;
      abort.abort(reason);
      await rejection;
    } else {
      const response = await pending;
      const reader = response.body!.getReader();
      assert.deepEqual((await reader.read()).value, image);
      const rejection = assert.rejects(reader.read());
      abort.abort(reason);
      await rejection;
    }
    assert.equal(signal.aborted, true);
  }
  const redirected = new AbortController();
  globalThis.fetch = async () => {
    fetches++;
    return new Response(
      new ReadableStream({
        cancel() {
          redirected.abort();
        }
      }),
      { status: 302, headers: { location: "https://example.com/next" } }
    );
  };
  const beforeRedirect = fetches;
  await assert.rejects(
    safeFetchExternalImage("https://example.com/start", {
      timeoutMs: 1000,
      signal: redirected.signal
    }),
    (e: any) => e.code === "external_image_cancelled"
  );
  assert.equal(fetches - beforeRedirect, 1);
  for (const phase of ["headers", "body"] as const) {
    globalThis.fetch = async (_url, init) => {
      const signal = init!.signal!;
      if (phase === "headers")
        return new Promise<Response>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        );
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          }
        }),
        { headers: { "content-type": "image/png" } }
      );
    };
    await assert.rejects(
      safeFetchExternalImage("https://example.com/image", {
        timeoutMs: 20,
        signal: new AbortController().signal
      }),
      (e: any) => e.code === "external_url_timeout",
      `${phase} 阶段超时`
    );
  }
  const { fetchImportImageToFile } =
    await import("../../../packages/server/src/images/ingestion/sources/fetch.ts");
  initializeRuntimeConfig();
  const directory = await createTestDirectory("import-body-interruption-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const failure of ["timeout", "cancel"] as const) {
    const abort = new AbortController();
    const bodyStarted = Promise.withResolvers<void>();
    const target = join(directory, `${failure}.raw`);
    const part = join(directory, `${failure}.part`);
    await writeFile(target, "complete successor content");
    let failBody!: (error: Error) => void;
    globalThis.fetch = async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(image);
          failBody = (error) => controller.error(error);
        }
      }),
      {
        headers: {
          "content-type": "image/png",
          "content-length": String(image.length * 2)
        }
      }
    );
    const pending = fetchImportImageToFile(
      "https://example.com/image.png",
      target,
      part,
      image.length * 4,
      abort.signal,
      () => bodyStarted.resolve()
    );
    const rejection = assert.rejects(pending, {
      status: failure === "timeout" ? 400 : 409,
      code: failure === "timeout" ? "import_timeout" : "ingestion_cancelled"
    });
    await bodyStarted.promise;
    if (failure === "timeout") failBody(new DOMException("synthetic body timeout", "TimeoutError"));
    else abort.abort(new Error("synthetic caller cancellation"));
    await rejection;
    assert.equal(await readFile(target, "utf8"), "complete successor content");
    await assert.rejects(readFile(part), { code: "ENOENT" });
  }
});
test("[Server/图片] 管理员原图等待共享探测时单个 HTTP 取消不影响另一消费者", async () => {
  const item = servingReadyCacheItem();
  let resolveProbe!: (value: boolean) => void;
  let started!: () => void;
  let probeCalls = 0;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const probe = new Promise<boolean>((resolve) => {
    resolveProbe = resolve;
  });
  const dependencies = {
    readImageServingRecordById: async () => ({ ...item, status: "ready" }),
    displayUrlForOriginalComparison: async () => "https://display.example.com/image.webp",
    supportsDirectAccess: (...args: unknown[]) => {
      assert.equal(args.length, 2, "共享探测不接收单个消费者的 signal");
      if (++probeCalls === 2) started();
      return probe;
    },
    proxyExternalImage: async () => {
      throw Error("direct probe should succeed");
    }
  };
  const cancelled = new AbortController();
  const other = new AbortController();
  const first = serveAdminExternalOriginal(
    item.id,
    { signal: cancelled.signal },
    dependencies as never
  );
  const second = serveAdminExternalOriginal(
    item.id,
    { signal: other.signal },
    dependencies as never
  );
  await ready;
  const reason = new Error("caller left");
  const rejected = assert.rejects(first, (error) => error === reason);
  cancelled.abort(reason);
  await rejected;
  assert.equal(other.signal.aborted, false);
  resolveProbe(true);
  assert.equal((await second).status, 302);
  assert.equal(
    (
      await serveAdminExternalOriginal(
        item.id,
        { signal: neverAbortedSignal },
        dependencies as never
      )
    ).status,
    302
  );
});

test("[Server/图片] URL 补全后的长度边界在草稿与正式输入间保持闭合", () => {
  const imageId = "01980000-0000-7000-8000-000000000001";
  for (const field of ["original", "source"] as const) {
    for (const protocol of ["", "https://"]) {
      for (const length of [2040, 2041, 2048, 2049]) {
        const prefix = protocol + "example.com/?sig=%2F+";
        const input = prefix + "x".repeat(length - prefix.length);
        const expected = protocol ? input : "https://" + input;
        const accepted = expected.length <= 2048;
        const metadata = { device: "auto", brightness: "auto", [field]: ` ${input} ` };
        const formal = imageMetadataCreateInput.safeParse(metadata);
        const draft = ingestionSessionUpdateInput.safeParse({
          items: [
            {
              session_id: "A".repeat(43),
              image_id: imageId,
              expected_version: 1,
              metadata
            }
          ]
        });
        assert.equal(formal.success, accepted, `${field}: ${protocol} ${length}`);
        assert.equal(draft.success, accepted);
        assert.equal(normalizeIngestionDraftUrl(field, input), accepted ? expected : null);
        if (formal.success && draft.success) {
          assert.equal(formal.data[field], expected, "不重写路径、签名或截断 URL");
          assert.equal(draft.data.items[0]!.metadata![field], expected);
          assert.deepEqual(imageMetadataCreateInput.parse(formal.data), formal.data);
          assert.deepEqual(ingestionSessionUpdateInput.parse(draft.data), draft.data);
          assert.equal(normalizeIngestionDraftUrl(field, expected), expected);
        }
      }
    }
  }
});
