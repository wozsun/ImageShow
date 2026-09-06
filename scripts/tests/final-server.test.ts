import "./support/server-environment.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { join, resolve, toNamespacedPath } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createTestDirectory } from "./support/test-directory.ts";
import { Hono } from "hono";
import ipaddr from "ipaddr.js";
import { Client } from "pg";
import sharp from "sharp";
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { appConfig } from "../../packages/shared/src/app-config.ts";
import {
  adminApiBasePath,
  adminImageListReadStartedAtHeader,
  adminPermissions,
  detectDeviceFromUserAgent,
  ingestionUpdatePath,
  type RuntimeConfig
} from "../../packages/shared/src/browser.ts";
import {
  normalizeRuntimeConfig,
  parseRuntimeConfig,
  runtimeConfigDefaults
} from "../../packages/server/src/config/runtime-config.ts";
import {
  runtimeConfigFromEnvironment
} from "../../packages/server/src/config/bootstrap-env.ts";
import {
  runtimeConfigEnvironmentBindings
} from "../../packages/server/src/config/runtime-config-environment.ts";
import {
  getIngestionMaxLongEdge,
  parseSettingsInput
} from "../../packages/server/src/config/app-settings.ts";
import {
  getRuntimeConfig,
  initializeRuntimeConfig,
  withRuntimeConfigWriteLease
} from "../../packages/server/src/config/runtime-config-store.ts";
import {
  buildConfigPackage,
  materializeImportedRuntimeConfig,
  parseConfigPackage,
  projectConfigPackagePreview,
  resolveImportedStorageBackends
} from "../../packages/server/src/config/config-package-format.ts";
import { effectiveEmbedAncestorSources } from "../../packages/server/src/config/embed-ancestors.ts";
import { ApiError } from "../../packages/server/src/core/api-error.ts";
import {
  imageActionInput,
  imagePurgeInput,
  imageSnapshotInput,
  imageStorageMigrationInput,
  imageUpdateInput,
  adminImageListQuery,
  galleryStatsQuery,
  listQuery
} from "../../packages/server/src/routes/validation/images.ts";
import {
  ingestionCommitIntentInput,
  ingestionQueueActionInput,
  ingestionSessionUpdateInput,
  ingestionStatusInput,
  importAcceptInput,
  uploadIntentInput
} from "../../packages/server/src/routes/validation/ingestion.ts";
import { parse } from "../../packages/server/src/routes/validation/parse.ts";
import {
  storageBackendCreateInput,
  storageBackendMigrationInput,
  storageBackendTestInput,
  storageBackendUpdateInput
} from "../../packages/server/src/routes/validation/storage.ts";
import { isHttpsUrl, isRootRelativeOrHttpsUrl } from "../../packages/server/src/core/url-validation.ts";
import {
  createExternalImageLookup,
  externalImageLookupErrorCode
} from "../../packages/server/src/core/external-image-lookup.ts";
import { raceWithAbortSignal } from "../../packages/server/src/core/abort.ts";
import {
  DynamicConcurrencyLimiter,
  DynamicWeightedLimiter
} from "../../packages/server/src/core/concurrency.ts";
import { uuidV7Timestamp } from "../../packages/server/src/core/uuid.ts";
import {
  acquireAdvisoryLockClient
} from "../../packages/server/src/core/database/advisory-locks.ts";
import {
  readRequiredRedisCommandCapabilities
} from "../../packages/server/src/core/redis/client.ts";
import {
  deleteRedisStringIfEqual,
  deleteRedisStringsIfEqual,
  parseRedisDeleteIfEqualReply,
  parseRedisSetIfEqualReply,
  refreshRedisStringTtlIfEqual,
  replaceRedisStringIfEqualKeepingTtl
} from "../../packages/server/src/core/redis/conditional-string.ts";
import {
  redisWindowScripts,
  registerRedisWindowCommand,
  reserveRedisWindowsCommand,
  type RedisWindowCommandClient
} from "../../packages/server/src/core/redis/window-limit.ts";
import {
  readyImageRedisScripts,
  registerReadyImageRedisCommands
} from "../../packages/server/src/images/ready-cache/redis/client.ts";
import {
  publishReadyImageAttributeIndexCommand,
  sampleReadyImageCoreIndexCommand,
  sampleReadyImageDerivedIndexCommand,
  storeReadyImageFilterSetCommand,
  touchReadyImageIndexedResultCommand,
  touchReadyImageStatsResultCommand,
  type RedisAttributePublishCommandClient,
  type RedisDerivedRegistryCommandConfig,
  type RedisFilterSetCommandClient,
  type RedisIndexedTouchCommandClient,
  type RedisReadyImageCoreSampleCommandClient,
  type RedisReadyImageDerivedSampleCommandClient,
  type RedisStatsTouchCommandClient
} from "../../packages/server/src/images/ready-cache/redis/commands.ts";
import {
  createPublicDatabaseAdmission
} from "../../packages/server/src/core/database/public-admission.ts";
import {
  createPublicDatabaseReadScope
} from "../../packages/server/src/core/database/public-fallback.ts";
import {
  withTransactionOnClient
} from "../../packages/server/src/core/database/transactions.ts";
import {
  WorkerExecutionCoordinator,
  type WorkerExecutionCompletion
} from "../../packages/server/src/jobs/worker-execution.ts";
import {
  backgroundJobTypes,
  parseBackgroundJobType
} from "../../packages/server/src/jobs/types.ts";
import {
  normalizePartialContentRange,
  parseSingleByteRange,
  totalSizeFromContentRange
} from "../../packages/server/src/core/http/byte-range.ts";
import {
  finalizeSecurityHeaders,
  immutableCacheControl,
  noStoreCacheControl,
  privateNoStoreCacheControl,
  publicProxyImageCacheControl,
  publicRedirectCacheControl
} from "../../packages/server/src/core/http/headers.ts";
import { readJsonBody } from "../../packages/server/src/core/http/json-body.ts";
import {
  limitAdminLoginBody,
  limitIngestionControlBody,
  limitProtectedAdminRequestBody
} from "../../packages/server/src/core/http/request-body-limit.ts";
import {
  assertSameOrigin,
  requestClientIp,
  requestIsSecure
} from "../../packages/server/src/core/http/request-security.ts";
import {
  apiSuccessEtag,
  handleApiError,
  privateCacheableApiSuccess
} from "../../packages/server/src/core/http/responses.ts";
import {
  auditAdminMutation,
  markAdminReadRequest
} from "../../packages/server/src/core/audit-log.ts";
import { logger } from "../../packages/server/src/core/logger.ts";
import {
  proxyEtagForUpstream,
  proxyLastModified,
  upstreamIfModifiedSinceForProxy,
  upstreamIfNoneMatchForProxy
} from "../../packages/server/src/core/http/proxy-validators.ts";
import { hashPassword, isCurrentPasswordHash, verifyPassword } from "../../packages/server/src/core/password.ts";
import {
  deviceFromDimensions,
  resolveClassification
} from "../../packages/server/src/images/classification.ts";
import { decodeImageCursor, encodeImageCursor } from "../../packages/server/src/images/cursor.ts";
import { createImageFilterPlan, imageFilterPlanHasAllAxes, imageFilterPlanWithout } from "../../packages/server/src/images/filter-plan.ts";
import { createPageWindow } from "../../packages/server/src/images/page-window.ts";
import { createImageId, parseImageTime } from "../../packages/server/src/images/image-time.ts";
import {
  readImageServingRecordById,
  readImageServingRecordByObjectKey,
  readImageServingRecordByThumbKey
} from "../../packages/server/src/images/image-serving-record.ts";
import {
  servePublicStoredObject,
  servePublicStoredThumbnail
} from "../../packages/server/src/images/stored-image-serving.ts";
import {
  serveAdminExternalOriginal,
  servePublicExternalOriginal
} from "../../packages/server/src/images/external-original-serving.ts";
import {
  presentRandomJsonItems
} from "../../packages/server/src/random/json-presentation.ts";
import {
  invalidateStorageBackendRegistry
} from "../../packages/server/src/storage/backends/registry.ts";
import {
  configureSharpRuntime,
  md5Buffer,
  transcodeStoredImage,
  type StoredImageTranscodeSettings
} from "../../packages/server/src/images/processing.ts";
import { buildImageFilterSql } from "../../packages/server/src/images/read-models/image-filter-sql.ts";
import {
  fetchAdminImageOffsetRows,
  fetchPublicImageCardPage
} from "../../packages/server/src/images/read-models/pagination.ts";
import { calculateDownloadProgress, downloadProgressLength } from "../../packages/server/src/images/ingestion/sources/download-progress.ts";
import { JsonlManifestError, parseJsonlManifest } from "../../packages/server/src/images/ingestion/sources/jsonl.ts";
import {
  ingestionIntentRequestHash
} from "../../packages/server/src/images/ingestion/sessions/request-hash.ts";
import {
  assertImageIdentity,
  createIngestionSessionId,
  inspectImageUuidV7
} from "../../packages/server/src/images/ingestion/sessions/identity.ts";
import {
  ingestionSessionSemanticHash
} from "../../packages/server/src/images/ingestion/sessions/projection.ts";
import {
  ingestionTokenPurposes,
  IngestionTokenService,
  type IngestionTokenEnvelope
} from "../../packages/server/src/images/ingestion/sessions/token-service.ts";
import {
  IngestionIrreversibleCoordinator
} from "../../packages/server/src/images/ingestion/execution/irreversible-coordinator.ts";
import {
  cancelIngestionSessions,
  cancelRecoveredIngestionSessions
} from "../../packages/server/src/images/ingestion/cancel/coordinator.ts";
import {
  ingestionSessionIncarnationMismatch
} from "../../packages/server/src/images/ingestion/repository.ts";
import {
  downloadIngestionSessionSnapshot
} from "../../packages/server/src/images/ingestion/sources/download-session.ts";
import {
  heartbeatIngestionExecution,
  mutateIngestionExecution,
  refreshIngestionExecutionSession,
  updateIngestionExecutionProgress
} from "../../packages/server/src/images/ingestion/execution/session.ts";
import {
  ingestionCleanupRetryQueue
} from "../../packages/server/src/images/ingestion/cleanup/retry-queue.ts";
import {
  IngestionCommitStagingCleanup
} from "../../packages/server/src/images/ingestion/commit/staging-cleanup.ts";
import {
  IngestionSessionRecovery
} from "../../packages/server/src/images/ingestion/workers/session-recovery.ts";
import {
  ingestionCommitDispatchWindow,
  ingestionWorkerDispatchWindows,
  isSameFailedIngestionExecution,
  planIngestionWorkerLanes
} from "../../packages/server/src/images/ingestion/workers/ingestion-worker.ts";
import {
  withImportPrefetchAdmission
} from "../../packages/server/src/images/ingestion/workers/import-prefetch.ts";
import {
  ingestionPreparationAdmissionSnapshot,
  withIngestionPreparationAdmission
} from "../../packages/server/src/images/ingestion/workers/preparation-admission.ts";
import {
  preparedAttemptIsReferenced
} from "../../packages/server/src/images/ingestion/workers/prepare-session.ts";
import {
  ingestionStagingImageKey,
  ingestionStagingThumbnailKey,
  parseIngestionStagingCleanupKey,
  stagingSessionId
} from "../../packages/server/src/images/ingestion/staging-keys.ts";
import {
  ingestionRawPath
} from "../../packages/server/src/images/ingestion/raw/paths.ts";
import {
  extractWeiboPost,
  parseWeiboPostUrl
} from "../../packages/server/src/images/ingestion/sources/weibo-parser.ts";
import { weiboPostToJsonl } from "../../packages/server/src/images/ingestion/sources/weibo.ts";
import {
  deriveAuthorIdentityFromLink
} from "../../packages/server/src/authors/identity.ts";
import { canonicalImportMetadata } from "../../packages/server/src/images/ingestion/sessions/import-metadata.ts";
import {
  parseReadyImageCacheItem,
  readyImageCacheItemFromRow,
  readyImageIdFromMember,
  readyImageMember,
  readyImageStatFields,
  readyImageThumbKey,
  serializeReadyImageCacheItem
} from "../../packages/server/src/images/ready-cache/model.ts";
import {
  ReadyImageCacheCoordinator
} from "../../packages/server/src/images/ready-cache/coordinator-machine.ts";
import {
  readReadyImageCacheMeta,
  rebuildingReadyImageCacheMeta
} from "../../packages/server/src/images/ready-cache/meta.ts";
import {
  getReadyImageCacheOverviewStatus,
  readReadyImageCacheAdminStatus
} from "../../packages/server/src/images/ready-cache/admin-status.ts";
import {
  measureReadyImageCoreMemory
} from "../../packages/server/src/images/ready-cache/sync/redis-writer.ts";
import {
  READY_IMAGE_CORE_KEYS
} from "../../packages/server/src/images/ready-cache/keys.ts";
import {
  readReadyImageOrderedWindow,
  type ReadyImageWindowDependencies
} from "../../packages/server/src/images/ready-cache/ordered-window.ts";
import {
  sampleResolvedReadyImageIndex
} from "../../packages/server/src/images/ready-cache/random-sampler.ts";
import {
  inspectRedisKeyspaceDeep
} from "../../packages/server/src/checks/redis-deep-inspection.ts";
import {
  inspectRedisState
} from "../../packages/server/src/checks/redis-inspect.ts";
import type {
  RedisOperationalState
} from "../../packages/server/src/core/runtime-availability.ts";
import {
  isRedisUnavailableError
} from "../../packages/server/src/core/runtime-availability.ts";
import {
  normalizeRandomQuery,
  parseRandomQuery,
  type ParsedRandomQuery,
  type RandomSelectorMaps
} from "../../packages/server/src/random/query.ts";
import {
  resolveCandidateAxes
} from "../../packages/server/src/random/selection-model.ts";
import {
  missingS3Fields,
  mergeS3Settings,
  s3SettingsSchema,
  storageDriverSignature,
  type StorageBackendRecord,
  type StorageConfig
} from "../../packages/server/src/storage/backends/config.ts";
import {
  contentType,
  s3CopySource,
  s3ListPrefix,
  storageS3ObjectName
} from "../../packages/server/src/storage/objects/keys.ts";
import {
  assertCanonicalImageObjectKey,
  isCanonicalImageObjectKey,
  isCanonicalThumbnailObjectKey,
  storageObjectKey,
  thumbnailObjectKey
} from "../../packages/server/src/storage/objects/image-paths.ts";
import { storageConfigFromRow } from "../../packages/server/src/storage/backends/record.ts";
import { storageBackendLabel } from "../../packages/server/src/storage/backends/label.ts";
import {
  groupStorageNamespaces,
  shareStorageNamespace,
  storageNamespaceGroupIdentity,
  storageNamespaceIdentity
} from "../../packages/server/src/storage/objects/namespace.ts";
import {
  batchStorageKeys,
  STORAGE_ADMIN_LIST_MAX_KEYS
} from "../../packages/server/src/storage/objects/key-listing.ts";
import { captureStagingNamespaceSnapshot } from "../../packages/server/src/storage/backends/endpoint-rebind.ts";
import { isMissingFileError } from "../../packages/server/src/storage/objects/not-found.ts";
import type {
  StorageDriver,
  StorageObjectReference
} from "../../packages/server/src/storage/drivers/driver.ts";
import {
  removeDriverObjectsAndConfirm
} from "../../packages/server/src/storage/drivers/removal.ts";
import {
  ensureVerifiedObjectAtDestination
} from "../../packages/server/src/storage/objects/transfer.ts";
import {
  manageStorageDriver
} from "../../packages/server/src/storage/drivers/lifecycle.ts";
import {
  S3Backend,
  type S3CommandClient
} from "../../packages/server/src/storage/drivers/s3.ts";
import {
  S3RequestRuntime
} from "../../packages/server/src/storage/drivers/s3-request-runtime.ts";
import {
  createWeiboRequestScheduler
} from "../../packages/server/src/images/ingestion/sources/weibo-request-scheduler.ts";
import {
  WeiboImportError
} from "../../packages/server/src/images/ingestion/sources/weibo-types.ts";
import { adminPermissionsForRole } from "../../packages/server/src/users/admin-authorization.ts";
import { registerAdminImageRoutes } from "../../packages/server/src/routes/admin-images.ts";
import { registerPublicRoutes } from "../../packages/server/src/routes/public.ts";
import { registerCheckRoutes } from "../../packages/server/src/routes/check.ts";
import {
  authorizeAdminSessionCredentialTransition
} from "../../packages/server/src/users/admin-session.ts";
import {
  closeAdminSessionConnections,
  closeAllAdminSessionConnections,
  registerAdminSessionConnection
} from "../../packages/server/src/users/admin-session-connections.ts";
import {
  streamIngestionQueueEvents
} from "../../packages/server/src/images/ingestion/queue/events.ts";
import {
  adminSessionKey,
  adminSessionKeyPattern
} from "../../packages/server/src/users/admin-session-key.ts";
import {
  adminCredentialTransitionVersions,
  adminCredentialVersion,
  parseAdminCredentialVersions
} from "../../packages/server/src/users/session-credential.ts";
import {
  adminSessionRedisClient,
  invalidateAllAdminSessions,
  invalidateCommittedAdminSessionsByUsername
} from "../../packages/server/src/users/session-invalidation.ts";
import {
  forceTerminateProcessTree,
  releaseFailedProcessTree,
  spawnManaged
} from "../build/process-tree.mjs";

const imageId = "019f8457-063a-7002-a580-7a432dc7fd8d";
type ReadyImageSampleDependencies = NonNullable<
  Parameters<typeof sampleResolvedReadyImageIndex>[3]
>;

function servingReadyCacheItem(overrides: Record<string, unknown> = {}) {
  return readyImageCacheItemFromRow({
    id: imageId,
    object_key: storageObjectKey(imageId, "jpg"),
    ext: "jpg",
    device: "pc",
    brightness: "dark",
    theme: "none",
    storage_slug: "local",
    author: "",
    tags: [],
    width: 1920,
    height: 1080,
    image_size: 123456,
    cursor_image_time: "2026-08-10T00:00:00.000000Z",
    sort_score: "1",
    title: "Serving fixture",
    description: "Serving behavior fixture",
    source: "https://example.com/post",
    original: "https://origin.example.com/image.jpeg",
    md5: "0123456789abcdef0123456789abcdef",
    cursor_created_at: "2026-08-10T00:00:00.000000Z",
    cursor_updated_at: "2026-08-10T00:00:01.000000Z",
    ...overrides
  });
}

function readyCacheMeta(revision = "1") {
  return {
    state: "ready" as const,
    appliedRevision: revision,
    itemCount: 1,
    lastUpdatedAt: "2026-08-10T00:00:03.000Z",
    fullRebuildStartedAt: "2026-08-10T00:00:01.000Z",
    fullRebuildCompletedAt: "2026-08-10T00:00:02.000Z",
    processed: 0,
    total: 0,
    lastFullRebuildCoreMemoryBytes: 1024,
    lastFullRebuildMeasuredAt: "2026-08-10T00:00:01.900Z",
    lastError: ""
  };
}

test("ready cache 拒绝完整重建时间逆序的持久 meta", async () => {
  await assert.rejects(
    readReadyImageCacheMeta({
      hgetall: async () => ({
        state: "ready",
        applied_revision: "8",
        item_count: "1",
        last_updated_at: "2026-08-10T03:00:00.000Z",
        full_rebuild_started_at: "2026-08-10T03:00:00.000Z",
        full_rebuild_completed_at: "2026-08-10T02:00:00.000Z",
        processed: "0",
        total: "0",
        last_full_rebuild_core_memory_bytes: "1024",
        last_full_rebuild_measured_at: "2026-08-10T01:59:59.000Z",
        last_error: ""
      })
    } as never),
    /full rebuild timestamps are out of order/
  );
});

function deferredPromise<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

test("运行时配置同时支持严格保存与启动归一化", () => {
  const defaults = runtimeConfigDefaults();
  assert.deepEqual(parseRuntimeConfig(defaults), defaults);
  assert.deepEqual(defaults.import.keep_original_link, ["url", "jsonl", "weibo"]);
  assert.equal(defaults.weibo.source_enabled, true);
  assert.equal(defaults.site.root, "home");
  assert.equal(defaults.site.home.browse_target, "show");
  assert.deepEqual(defaults.site.show, {
    enabled: true,
    autoplay: true,
    mode: "waterfall",
    density: "balanced",
    drift_speed: 28,
    order: "random"
  });
  assert.equal(defaults.site.gallery.enabled, true);
  assert.equal(defaults.site.gallery.order, "latest");
  assert.equal(defaults.site.gallery.public_original_button, false);
  assert.deepEqual(defaults.ingestion, {
    max_file_size_mb: 100,
    max_long_edge: 32_000,
    list_page_size: 20,
    commit_concurrency: 8
  });
  assert.equal(defaults.normalize.concurrency, 2);
  assert.equal(defaults.normalize.max_long_edge, 4_200);
  assert.equal(defaults.admin.recent_uploads, 16);
  const drift = structuredClone(defaults) as Record<string, unknown>;
  delete drift.embed;
  drift.unknown_group = { enabled: true };
  drift.unknown_runtime_group = { max_attempts: 8 };
  const currentImport = structuredClone(drift.import) as Record<string, unknown>;
  const currentIngestion = structuredClone(drift.ingestion) as Record<string, unknown>;
  const currentUpload = structuredClone(drift.upload) as Record<string, unknown>;
  const currentWeibo = structuredClone(drift.weibo) as Record<string, unknown>;
  delete currentImport.auto_import;
  delete currentImport.keep_original_link;
  currentImport.unknown_option = true;
  currentIngestion.commit_concurrency = 6;
  delete currentIngestion.max_file_size_mb;
  delete currentIngestion.max_long_edge;
  delete currentIngestion.list_page_size;
  currentIngestion.unknown_option = 99;
  currentUpload.unknown_option = 99;
  delete currentWeibo.request_delay_seconds;
  delete currentWeibo.source_enabled;
  currentWeibo.unknown_option = 99;
  drift.import = currentImport;
  drift.ingestion = currentIngestion;
  drift.upload = currentUpload;
  drift.weibo = currentWeibo;
  const driftSite = drift.site as Record<string, unknown>;
  delete driftSite.description;
  delete driftSite.root;
  const driftGallery = driftSite.gallery as Record<string, unknown>;
  delete driftGallery.public_original_button;
  driftSite.unknown_site_key = "gallery";
  driftSite.unknown_option = true;
  (driftSite.home as Record<string, unknown>).unknown_option = true;

  const normalized = normalizeRuntimeConfig(drift);
  assert.deepEqual(normalized.embed, { enabled: false, allowed_origins: [] });
  assert.equal(normalized.import.auto_import, true);
  assert.deepEqual(normalized.import.keep_original_link, ["url", "jsonl", "weibo"]);
  assert.equal(normalized.ingestion.commit_concurrency, 6);
  assert.equal(normalized.ingestion.max_file_size_mb, 100);
  assert.equal(normalized.ingestion.max_long_edge, 32000);
  assert.equal(normalized.ingestion.list_page_size, 20);
  assert.deepEqual(normalized.weibo.request_delay_seconds, [2, 5]);
  assert.equal(normalized.weibo.source_enabled, true);
  assert.equal(normalized.site.description, "画廊与随机图片API");
  assert.equal(normalized.site.root, "home");
assert.equal(normalized.site.show.autoplay, true, "已有配置缺失字段使用唯一默认值，不重新播种环境值");
  assert.equal(normalized.site.gallery.public_original_button, false);
  assert.equal("unknown_site_key" in normalized.site, false);
  assert.equal("unknown_option" in normalized.site, false);
  assert.equal("unknown_option" in normalized.site.home, false);
  assert.equal("unknown_option" in normalized.import, false);
  assert.equal("unknown_option" in normalized.ingestion, false);
  assert.equal("unknown_option" in normalized.upload, false);
  assert.equal("unknown_option" in normalized.weibo, false);
  assert.equal("unknown_group" in normalized, false);
  assert.equal("unknown_runtime_group" in normalized, false);
  assert.throws(() => parseRuntimeConfig(drift));

  const reversedWeiboDelay = structuredClone(defaults);
  reversedWeiboDelay.weibo.request_delay_seconds = [6, 5];
  assert.throws(() => parseRuntimeConfig(reversedWeiboDelay));

  const configWithImportTypesKeepingOriginalLink = structuredClone(defaults);
  configWithImportTypesKeepingOriginalLink.import.keep_original_link = [
    "weibo",
    "url",
    "weibo",
    "url"
  ];
  assert.deepEqual(
    normalizeRuntimeConfig(configWithImportTypesKeepingOriginalLink).import.keep_original_link,
    ["weibo", "url"]
  );
  configWithImportTypesKeepingOriginalLink.import.keep_original_link = [];
  assert.deepEqual(
    normalizeRuntimeConfig(configWithImportTypesKeepingOriginalLink).import.keep_original_link,
    []
  );
  configWithImportTypesKeepingOriginalLink.import.keep_original_link = ["upload"] as never;
  assert.throws(() => normalizeRuntimeConfig(configWithImportTypesKeepingOriginalLink));

  const siteWithUnknownKey = structuredClone(defaults) as RuntimeConfig & {
    site: RuntimeConfig["site"] & Record<string, unknown>;
  };
  siteWithUnknownKey.site.root = "gallery";
  siteWithUnknownKey.site.unknown_site_key = "home";
  const siteWithUnknownKeyNormalized = normalizeRuntimeConfig(siteWithUnknownKey);
  assert.equal(siteWithUnknownKeyNormalized.site.root, "gallery");
  assert.equal("unknown_site_key" in siteWithUnknownKeyNormalized.site, false);

  const missingSiteRoot = structuredClone(defaults) as RuntimeConfig & {
    site: RuntimeConfig["site"] & Record<string, unknown>;
  };
  delete (missingSiteRoot.site as Partial<RuntimeConfig["site"]>).root;
  missingSiteRoot.site.unknown_site_key = "invalid";
  assert.equal(normalizeRuntimeConfig(missingSiteRoot).site.root, "home");

  const invalidCurrentSiteRoot = structuredClone(defaults) as RuntimeConfig & {
    site: RuntimeConfig["site"] & Record<string, unknown>;
  };
  invalidCurrentSiteRoot.site.root = "invalid" as RuntimeConfig["site"]["root"];
  invalidCurrentSiteRoot.site.unknown_site_key = "gallery";
  assert.throws(() => normalizeRuntimeConfig(invalidCurrentSiteRoot));

  const invalidOriginalButton = structuredClone(defaults) as RuntimeConfig;
  invalidOriginalButton.site.gallery.public_original_button = "false" as never;
  assert.throws(() => parseRuntimeConfig(invalidOriginalButton));
  assert.throws(() => normalizeRuntimeConfig(invalidOriginalButton));

  for (const root of ["home", "gallery"] as const) {
    const current = structuredClone(defaults);
    current.site.root = root;
    assert.equal(parseRuntimeConfig(current).site.root, root);
  }

  const embedded = structuredClone(defaults);
  embedded.site.domain = "img.example.com:5518";
  embedded.embed.enabled = true;
  embedded.embed.allowed_origins = [
    " HTTPS://Portal.Example.com:443/ ",
    "https://portal.example.com",
    "https://*.trusted.example.net"
  ];
  const parsed = parseRuntimeConfig(embedded);
  assert.deepEqual(parsed.embed.allowed_origins, [
    "https://portal.example.com",
    "https://*.trusted.example.net"
  ]);
  assert.deepEqual(effectiveEmbedAncestorSources(parsed), [
    "https://img.example.com:5518",
    "https://*.img.example.com:5518",
    "https://portal.example.com",
    "https://*.trusted.example.net"
  ]);
  for (const domain of ["", "example.com"]) {
    const automatic = parseRuntimeConfig({
      ...embedded,
      site: { ...embedded.site, domain }
    });
    assert.equal(automatic.site.domain, domain);
    assert.deepEqual(effectiveEmbedAncestorSources(automatic), [
      "'self'", "https://portal.example.com", "https://*.trusted.example.net"
    ]);
  }

  const invalid = structuredClone(defaults);
  invalid.normalize.concurrency = 0;
  assert.throws(() => normalizeRuntimeConfig(invalid));

  const described = structuredClone(defaults);
  described.site.description = "  自定义站点描述  ";
  assert.equal(parseRuntimeConfig(described).site.description, "自定义站点描述");
  described.site.description = "";
  assert.equal(parseRuntimeConfig(described).site.description, "");
  described.site.description = "站".repeat(201);
  assert.throws(() => parseRuntimeConfig(described));

  const siteLimits = structuredClone(defaults);
  siteLimits.site.home.banner_title = "题".repeat(80);
  assert.equal(parseRuntimeConfig(siteLimits).site.home.banner_title.length, 80);
  siteLimits.site.home.banner_title = "题".repeat(81);
  assert.throws(() => parseRuntimeConfig(siteLimits));

  for (const maxLongEdge of [300, 32_000]) {
    const current = structuredClone(defaults);
    current.ingestion.max_long_edge = maxLongEdge;
    assert.equal(parseRuntimeConfig(current).ingestion.max_long_edge, maxLongEdge);
  }
  for (const maxLongEdge of [299, 32_001]) {
    const current = structuredClone(defaults);
    current.ingestion.max_long_edge = maxLongEdge;
    assert.throws(() => parseRuntimeConfig(current));
  }

  for (const maxFileSizeMb of [0.001, 200]) {
    const current = structuredClone(defaults);
    current.ingestion.max_file_size_mb = maxFileSizeMb;
    assert.equal(
      parseRuntimeConfig(current).ingestion.max_file_size_mb,
      maxFileSizeMb
    );
  }
  for (const maxFileSizeMb of [0, 200.001]) {
    const current = structuredClone(defaults);
    current.ingestion.max_file_size_mb = maxFileSizeMb;
    assert.throws(() => parseRuntimeConfig(current));
  }
  for (const listPageSize of [1, 100]) {
    const current = structuredClone(defaults);
    current.ingestion.list_page_size = listPageSize;
    assert.equal(
      parseRuntimeConfig(current).ingestion.list_page_size,
      listPageSize
    );
  }
  for (const listPageSize of [0, 101]) {
    const current = structuredClone(defaults);
    current.ingestion.list_page_size = listPageSize;
    assert.throws(() => parseRuntimeConfig(current));
  }
  for (const commitConcurrency of [1, 16]) {
    const current = structuredClone(defaults);
    current.ingestion.commit_concurrency = commitConcurrency;
    assert.equal(
      parseRuntimeConfig(current).ingestion.commit_concurrency,
      commitConcurrency
    );
  }
  for (const commitConcurrency of [0, 17]) {
    const current = structuredClone(defaults);
    current.ingestion.commit_concurrency = commitConcurrency;
    assert.throws(() => parseRuntimeConfig(current));
  }
  for (const normalizeConcurrency of [1, 8]) {
    const current = structuredClone(defaults);
    current.normalize.concurrency = normalizeConcurrency;
    assert.equal(
      parseRuntimeConfig(current).normalize.concurrency,
      normalizeConcurrency
    );
  }
  for (const normalizeConcurrency of [0, 9]) {
    const current = structuredClone(defaults);
    current.normalize.concurrency = normalizeConcurrency;
    assert.throws(() => parseRuntimeConfig(current));
  }
  for (const normalizedLongEdge of [300, 32_000]) {
    const current = structuredClone(defaults);
    current.normalize.max_long_edge = normalizedLongEdge;
    assert.equal(
      parseRuntimeConfig(current).normalize.max_long_edge,
      normalizedLongEdge
    );
  }
  for (const normalizedLongEdge of [299, 32_001]) {
    const current = structuredClone(defaults);
    current.normalize.max_long_edge = normalizedLongEdge;
    assert.throws(() => parseRuntimeConfig(current));
  }
  for (const recentUploads of [1, 60]) {
    const current = structuredClone(defaults);
    current.admin.recent_uploads = recentUploads;
    assert.equal(parseRuntimeConfig(current).admin.recent_uploads, recentUploads);
  }
  for (const recentUploads of [0, 61]) {
    const current = structuredClone(defaults);
    current.admin.recent_uploads = recentUploads;
    assert.throws(() => parseRuntimeConfig(current));
  }

  const validCurrentValues = structuredClone(defaults);
  validCurrentValues.ingestion.max_file_size_mb = 128;
  validCurrentValues.ingestion.max_long_edge = 24_000;
  validCurrentValues.ingestion.list_page_size = 40;
  validCurrentValues.normalize.concurrency = 6;
  validCurrentValues.normalize.max_long_edge = 4_500;
  validCurrentValues.admin.recent_uploads = 12;
  validCurrentValues.site.gallery.public_original_button = true;
  const preservedCurrentValues = normalizeRuntimeConfig(validCurrentValues);
  assert.deepEqual(preservedCurrentValues.ingestion, validCurrentValues.ingestion);
  assert.equal(preservedCurrentValues.normalize.concurrency, 6);
  assert.equal(preservedCurrentValues.normalize.max_long_edge, 4_500);
  assert.equal(preservedCurrentValues.admin.recent_uploads, 12);
  assert.equal(preservedCurrentValues.site.gallery.public_original_button, true);

  for (const method of ["proxy", "redirect"] as const) {
    const current = structuredClone(defaults);
    current.site.random_method = method;
    assert.equal(parseRuntimeConfig(current).site.random_method, method);
  }
  const invalidRandomDefault = structuredClone(defaults) as RuntimeConfig;
  invalidRandomDefault.site.random_method = "json" as never;
  assert.throws(() => parseRuntimeConfig(invalidRandomDefault));
});

test("完整环境播种严格覆盖全部已映射 RuntimeConfig 叶子与合法空值", async () => {
  function valueAtPath(value: unknown, path: string) {
    return path.split(".").reduce<unknown>((current, segment) => (
      current && typeof current === "object"
        ? (current as Record<string, unknown>)[segment]
        : undefined
    ), value);
  }
  function environmentLiteral(kind: string, value: unknown) {
    if (kind === "string") return value as string;
    if (kind === "boolean" || kind === "number") return String(value);
    return JSON.stringify(value);
  }

  const defaults = runtimeConfigDefaults();
  const completeSeed = Object.fromEntries(
    runtimeConfigEnvironmentBindings.map((binding) => [
      binding.environmentVariable,
      environmentLiteral(binding.valueKind, valueAtPath(defaults, binding.path))
    ])
  );
  assert.deepEqual(runtimeConfigFromEnvironment(completeSeed), defaults);
  assert.equal(runtimeConfigFromEnvironment({}).site.domain, "example.com");
  assert.equal(runtimeConfigFromEnvironment({ SITE_DOMAIN: "" }).site.domain, "");
  assert.equal(runtimeConfigFromEnvironment({ SITE_DOMAIN: "  EXAMPLE.COM  " }).site.domain, "example.com");
  assert.equal(runtimeConfigFromEnvironment({ SITE_DOMAIN: "img.example.com" }).site.domain, "img.example.com");
  assert.equal(
    runtimeConfigFromEnvironment({
      SITE_GALLERY_PUBLIC_ORIGINAL_BUTTON: "true"
    }).site.gallery.public_original_button,
    true
  );

  const environmentConfig = runtimeConfigFromEnvironment({
    SITE_DESCRIPTION: "",
    SITE_ROOT: "show",
    SITE_HOME_BROWSE_TARGET: "show",
    SITE_HOME_BACKGROUND: "",
    SITE_SHOW_ENABLED: "false",
    SITE_SHOW_AUTOPLAY: "false",
    SITE_SHOW_MODE: "float",
    SITE_SHOW_DENSITY: "dense",
    SITE_SHOW_DRIFT_SPEED: "42",
    SITE_SHOW_ORDER: "oldest",
    SITE_GALLERY_ENABLED: "false",
    SITE_ROBOTS_ENABLED: "false",
    NORMALIZE_SKIP_WEBP_UNDER_KB: "0",
    IMPORT_KEEP_ORIGINAL_LINK: '["weibo","url"]',
    WEIBO_SOURCE_ENABLED: "false",
    EMBED_ALLOWED_ORIGINS:
      '["https://portal.example.com","https://*.trusted.example.net"]'
  });
  assert.equal(environmentConfig.site.description, "");
  assert.equal(environmentConfig.site.root, "show");
  assert.equal(environmentConfig.site.home.browse_target, "show");
  assert.equal(environmentConfig.site.home.background, "");
  assert.deepEqual(environmentConfig.site.show, {
    enabled: false,
    autoplay: false,
    mode: "float",
    density: "dense",
    drift_speed: 42,
    order: "oldest"
  });
  assert.equal(environmentConfig.site.gallery.enabled, false);
  assert.equal(environmentConfig.site.robots_enabled, false);
  assert.equal(environmentConfig.normalize.skip_webp_under_kb, 0);
  assert.deepEqual(environmentConfig.import.keep_original_link, ["weibo", "url"]);
  assert.equal(environmentConfig.weibo.source_enabled, false);
  assert.deepEqual(
    runtimeConfigFromEnvironment({ IMPORT_KEEP_ORIGINAL_LINK: "[]" })
      .import.keep_original_link,
    []
  );
  assert.deepEqual(
    runtimeConfigFromEnvironment({
      IMPORT_KEEP_ORIGINAL_LINK: '["url","url","url","url"]'
    }).import.keep_original_link,
    ["url"]
  );
  assert.deepEqual(environmentConfig.embed.allowed_origins, [
    "https://portal.example.com",
    "https://*.trusted.example.net"
  ]);
  assert.equal(
    runtimeConfigFromEnvironment({ SITE_DESCRIPTION: "  环境站点描述  " })
      .site.description,
    "环境站点描述"
  );
  assert.equal(runtimeConfigFromEnvironment({}).site.description, "画廊与随机图片API");
  assert.equal(runtimeConfigFromEnvironment({
    UNKNOWN_RUNTIME_SETTING: "gallery"
  }).site.root, "home");

  for (const [environment, expected] of [
    [{ UPLOAD_MAX_ITEMS: " 1" }, /UPLOAD_MAX_ITEMS.*upload\.max_items/],
    [{ UPLOAD_MAX_ITEMS: "01" }, /UPLOAD_MAX_ITEMS.*upload\.max_items/],
    [{ UPLOAD_MAX_ITEMS: "NaN" }, /UPLOAD_MAX_ITEMS.*upload\.max_items/],
    [{ INGESTION_MAX_LONG_EDGE: "32001" }, /INGESTION_MAX_LONG_EDGE.*ingestion\.max_long_edge/],
    [{ SITE_ROBOTS_ENABLED: "yes" }, /SITE_ROBOTS_ENABLED.*site\.robots_enabled/],
    [{ SITE_ROBOTS_ENABLED: "1" }, /SITE_ROBOTS_ENABLED.*site\.robots_enabled/],
    [{ SITE_ROBOTS_ENABLED: "0" }, /SITE_ROBOTS_ENABLED.*site\.robots_enabled/],
    [{ SITE_GALLERY_PUBLIC_ORIGINAL_BUTTON: "1" }, /SITE_GALLERY_PUBLIC_ORIGINAL_BUTTON.*site\.gallery\.public_original_button/],
    [{ SITE_GALLERY_ENABLED: "1" }, /SITE_GALLERY_ENABLED.*site\.gallery\.enabled/],
    [{ SITE_ROOT: "landing" }, /SITE_ROOT.*site\.root/],
    [{ SITE_HOME_BROWSE_TARGET: "home" }, /SITE_HOME_BROWSE_TARGET.*site\.home\.browse_target/],
    [{ SITE_SHOW_ENABLED: "1" }, /SITE_SHOW_ENABLED.*site\.show\.enabled/],
    [{ SITE_SHOW_AUTOPLAY: "1" }, /SITE_SHOW_AUTOPLAY.*site\.show\.autoplay/],
    [{ SITE_SHOW_MODE: "grid" }, /SITE_SHOW_MODE.*site\.show\.mode/],
    [{ SITE_SHOW_DENSITY: "maximum" }, /SITE_SHOW_DENSITY.*site\.show\.density/],
    [{ SITE_SHOW_DRIFT_SPEED: "9" }, /SITE_SHOW_DRIFT_SPEED.*site\.show\.drift_speed/],
    [{ SITE_SHOW_ORDER: "shuffle" }, /SITE_SHOW_ORDER.*site\.show\.order/],
    [{ SITE_RANDOM_METHOD: "json" }, /SITE_RANDOM_METHOD.*site\.random_method/],
    [{ IMPORT_KEEP_ORIGINAL_LINK: "url,weibo" }, /IMPORT_KEEP_ORIGINAL_LINK.*JSON/],
    [{ IMPORT_KEEP_ORIGINAL_LINK: '["url","upload"]' }, /IMPORT_KEEP_ORIGINAL_LINK.*import\.keep_original_link/],
    [{ EMBED_ALLOWED_ORIGINS: "https:\/\/portal.example.com" }, /EMBED_ALLOWED_ORIGINS.*embed\.allowed_origins/],
    [{ EMBED_ALLOWED_ORIGINS: "{}" }, /EMBED_ALLOWED_ORIGINS.*embed\.allowed_origins/],
    [{ EMBED_ALLOWED_ORIGINS: '["http:\/\/portal.example.com"]' }, /EMBED_ALLOWED_ORIGINS.*embed\.allowed_origins/],
    [{ SITE_NAME: "" }, /SITE_NAME.*site\.name/],
    [{ NORMALIZE_QUALITY: "10", NORMALIZE_MIN_QUALITY: "20" }, /NORMALIZE_QUALITY.*normalize\.min_quality/],
    [{ WEIBO_REQUEST_DELAY_SECONDS: "[6,5]" }, /WEIBO_REQUEST_DELAY_SECONDS.*weibo\.request_delay_seconds/],
    [{ WEIBO_REQUEST_DELAY_SECONDS: "[2]" }, /WEIBO_REQUEST_DELAY_SECONDS.*weibo\.request_delay_seconds/],
    [{ WEIBO_REQUEST_DELAY_SECONDS: '["2",5]' }, /WEIBO_REQUEST_DELAY_SECONDS.*weibo\.request_delay_seconds/],
    [{ ALTCHA_COUNTER_RANGE: '[2000,"5000"]' }, /ALTCHA_COUNTER_RANGE.*altcha\.counter_range/],
    [{ ALTCHA_COST: "100000", ALTCHA_COUNTER_RANGE: "[2000,100000]" }, /ALTCHA_COST.*altcha\.counter_range/]
  ] as const) {
    assert.throws(() => runtimeConfigFromEnvironment(environment), expected);
  }

  const repositoryRoot = resolve(import.meta.dirname, "../..");
  const helperRoot = await createTestDirectory("imageshow-config-lifecycle-");
  const helperPath = join(helperRoot, "verify-config-lifecycle.mjs");
  const runtimeConfigUrl = pathToFileURL(resolve(
    repositoryRoot,
    "packages/server/src/config/runtime-config.ts"
  )).href;
  const runtimeConfigStoreUrl = pathToFileURL(resolve(
    repositoryRoot,
    "packages/server/src/config/runtime-config-store.ts"
  )).href;
  const appSettingsUrl = pathToFileURL(resolve(
    repositoryRoot,
    "packages/server/src/config/app-settings.ts"
  )).href;
  const helperSource = `
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeConfigDefaults } from ${JSON.stringify(runtimeConfigUrl)};
import {
  getRuntimeConfig,
  initializeRuntimeConfig,
  reloadRuntimeConfigFromDisk,
  updateRuntimeConfig
} from ${JSON.stringify(runtimeConfigStoreUrl)};
import {
  getSettingsForAdmin,
  parseSettingsInput,
  resolveIngestionSnapshotLimit,
  saveAppSettings,
  siteConfigPayload
} from ${JSON.stringify(appSettingsUrl)};

const root = process.env.IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY;
assert.ok(root);
await mkdir(root, { recursive: true });
const scenario = process.env.CONFIG_SCENARIO;
const unknownSiteKey = "unknown_site_key";

if (scenario === "seed") {
  const generated = initializeRuntimeConfig();
  assert.equal(generated.site.root, "show");
  assert.equal(generated.site.description, "");
  assert.equal(siteConfigPayload().site.description, generated.site.name, "空描述只在服务端投影为站点名");
  assert.equal(generated.site.home.browse_target, "show");
  assert.deepEqual(generated.site.show, {
    enabled: false,
    autoplay: false,
    mode: "float",
    density: "dense",
    drift_speed: 42,
    order: "oldest"
  });
  assert.equal(generated.site.gallery.enabled, false);
  assert.equal(generated.site.gallery.public_original_button, true);
  assert.equal(generated.normalize.skip_webp_under_kb, 0);
  const persisted = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  assert.deepEqual(persisted, generated);
  console.log("config-seed-ok");
} else if (scenario === "invalid-current") {
  const invalid = structuredClone(runtimeConfigDefaults());
  invalid.site.root = "invalid";
  invalid.site[unknownSiteKey] = "gallery";
  await writeFile(join(root, "config.json"), JSON.stringify(invalid));
  assert.throws(() => initializeRuntimeConfig(), /Invalid runtime config/);
  const persisted = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  assert.equal(persisted.site.root, "invalid");
  assert.equal(persisted.site[unknownSiteKey], "gallery");
  console.log("config-invalid-current-ok");
} else {
const drifted = structuredClone(runtimeConfigDefaults());
delete drifted.site.description;
delete drifted.site.root;
delete drifted.site.show.autoplay;
delete drifted.site.gallery.enabled;
delete drifted.site.gallery.public_original_button;
drifted.site[unknownSiteKey] = "gallery";
drifted.site.unknown = "remove-me";
drifted.site.home.unknown = "remove-me";
drifted.unknown_section = { enabled: false };
await writeFile(join(root, "config.json"), JSON.stringify(drifted));
const normalized = initializeRuntimeConfig();
assert.equal(normalized.site.description, "画廊与随机图片API");
assert.equal(normalized.site.root, "home");
assert.equal(normalized.site.gallery.enabled, true);
assert.equal(normalized.site.gallery.public_original_button, false);
assert.equal(unknownSiteKey in normalized.site, false);
assert.equal("unknown" in normalized.site, false);
assert.equal("unknown" in normalized.site.home, false);
assert.equal("unknown_section" in normalized, false);
assert.equal(siteConfigPayload().site.description, "画廊与随机图片API");
assert.equal(siteConfigPayload().site.root, "home");
assert.equal(
  siteConfigPayload().site.home.background,
  "/random?mode=redirect"
);
assert.deepEqual(siteConfigPayload().site.show, {
  enabled: true,
    autoplay: true,
  mode: "waterfall",
  density: "balanced",
  drift_speed: 28,
  order: "random"
});
assert.equal(siteConfigPayload().site.gallery.enabled, true);
assert.equal(siteConfigPayload().site.gallery.public_original_button, false);
assert.equal(
  siteConfigPayload().site.static_url,
  "/static"
);
assert.equal("description" in getSettingsForAdmin().site, false);
assert.equal(getSettingsForAdmin().site.root, "home");
assert.equal("browse_target" in getSettingsForAdmin().site.home, false);
assert.equal("show" in getSettingsForAdmin().site, false);
assert.equal("enabled" in getSettingsForAdmin().site.gallery, false);
assert.equal("public_original_button" in getSettingsForAdmin().site.gallery, false);
assert.deepEqual(getSettingsForAdmin().ingestion, {
  max_file_size_mb: 100,
  max_long_edge: 32000,
  list_page_size: 20,
  commit_concurrency: 8
});
assert.deepEqual(getSettingsForAdmin().upload, {
  max_items: 200,
  browser_concurrency: 2
});
assert.deepEqual(getSettingsForAdmin().import, {
  keep_original_link: ["url", "jsonl", "weibo"],
  auto_import: true,
  max_items: 200
});
assert.deepEqual(getSettingsForAdmin().weibo, {
  max_items: 10
});
assert.deepEqual(getSettingsForAdmin().normalize, {
  concurrency: 2,
  quality: 80,
  min_quality: 20,
  max_long_edge: 4200,
  max_size_kb: 500,
  skip_webp_under_kb: 700
});
assert.equal("quality_step" in getSettingsForAdmin().normalize, false);
assert.deepEqual(new Set(Object.keys(getSettingsForAdmin())), new Set([
  "site",
  "ingestion",
  "upload",
  "import",
  "weibo",
  "normalize",
  "thumbnail",
  "admin"
]));
assert.equal("unknown_section" in getSettingsForAdmin(), false);
assert.equal("unknown_section" in siteConfigPayload(), false);
assert.equal(parseSettingsInput({ site: { root: "gallery" } }).site?.root, "gallery");
assert.equal(parseSettingsInput({ site: { root: "show" } }).site.root, "show");
for (const site of [
  { home: { browse_target: "show" } },
  { gallery: { enabled: false } },
  { show: { autoplay: false } },
  { show: { mode: "float" } }
]) assert.throws(() => parseSettingsInput({ site }), "普通设置拒绝尚未开放的新字段");
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
assert.throws(() => parseSettingsInput({ site: { [unknownSiteKey]: "gallery" } }));
assert.throws(() => parseSettingsInput({ site: { description: "越权普通设置" } }));
assert.throws(() => parseSettingsInput({
  site: { gallery: { public_original_button: true } }
}));
assert.throws(() => parseSettingsInput({ unknown_section: { enabled: false } }));
const persisted = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
assert.deepEqual(persisted, normalized);
assert.equal(unknownSiteKey in persisted.site, false);
assert.equal("unknown" in persisted.site, false);
assert.equal("unknown" in persisted.site.home, false);
assert.equal(persisted.site.gallery.public_original_button, false);
assert.equal("unknown_section" in persisted, false);

await saveAppSettings(parseSettingsInput({
  ingestion: { list_page_size: 37, commit_concurrency: 12 }
}));
assert.equal(getRuntimeConfig().ingestion.list_page_size, 37);
assert.equal(getRuntimeConfig().ingestion.commit_concurrency, 12);
assert.equal(getSettingsForAdmin().ingestion.list_page_size, 37);
assert.equal(getSettingsForAdmin().ingestion.commit_concurrency, 12);
assert.equal(resolveIngestionSnapshotLimit(undefined), 37);
assert.equal(resolveIngestionSnapshotLimit(0), 0);
assert.equal(resolveIngestionSnapshotLimit(12), 12);
const saved = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
assert.equal(saved.ingestion.list_page_size, 37);
assert.equal(saved.ingestion.commit_concurrency, 12);

await updateRuntimeConfig({
  site: { gallery: { public_original_button: true } },
  import: { keep_original_link: ["jsonl"], auto_import: false },
  weibo: { source_enabled: false },
  normalize: { quality_step: 11 }
});
await saveAppSettings(parseSettingsInput({
  normalize: { quality: 79 },
  admin: { recent_uploads: 15 }
}));
assert.deepEqual(getRuntimeConfig().import.keep_original_link, ["jsonl"]);
assert.equal(getRuntimeConfig().import.auto_import, false);
assert.equal(getRuntimeConfig().weibo.source_enabled, false);
assert.equal(getRuntimeConfig().normalize.quality_step, 11);
assert.equal(getRuntimeConfig().normalize.quality, 79);
assert.equal(getRuntimeConfig().site.gallery.public_original_button, true);
assert.equal(siteConfigPayload().site.gallery.public_original_button, true);
assert.equal("public_original_button" in getSettingsForAdmin().site.gallery, false);
assert.deepEqual(getSettingsForAdmin().import.keep_original_link, ["jsonl"]);
assert.equal(getSettingsForAdmin().import.auto_import, false);
assert.equal("source_enabled" in getSettingsForAdmin().weibo, false);
assert.equal("quality_step" in getSettingsForAdmin().normalize, false);

const mixed = structuredClone(getRuntimeConfig());
mixed.site.root = "gallery";
mixed.site.gallery.public_original_button = false;
mixed.site[unknownSiteKey] = "home";
await writeFile(join(root, "config.json"), JSON.stringify(mixed));
const reloaded = await reloadRuntimeConfigFromDisk();
assert.equal(reloaded.site.root, "gallery");
assert.equal(reloaded.site.gallery.public_original_button, false);
assert.equal(siteConfigPayload().site.gallery.public_original_button, false);
assert.equal(unknownSiteKey in reloaded.site, false);
const reloadedPersisted = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
assert.deepEqual(reloadedPersisted, reloaded);
console.log("config-existing-ok");
}
`;
  try {
    await writeFile(helperPath, helperSource);
    const scenarios = [
      {
        name: "seed",
        environment: {
          SITE_ROOT: "show",
          SITE_DESCRIPTION: "",
          SITE_HOME_BROWSE_TARGET: "show",
          SITE_SHOW_ENABLED: "false",
    SITE_SHOW_AUTOPLAY: "false",
          SITE_SHOW_MODE: "float",
          SITE_SHOW_DENSITY: "dense",
          SITE_SHOW_DRIFT_SPEED: "42",
          SITE_SHOW_ORDER: "oldest",
          SITE_GALLERY_ENABLED: "false",
          SITE_GALLERY_PUBLIC_ORIGINAL_BUTTON: "true",
          NORMALIZE_SKIP_WEBP_UNDER_KB: "0"
        },
        output: /config-seed-ok/
      },
      {
        name: "existing",
        environment: {
          SITE_ROOT: "invalid",
          SITE_GALLERY_ENABLED: "invalid",
          SITE_GALLERY_PUBLIC_ORIGINAL_BUTTON: "invalid",
          UPLOAD_MAX_ITEMS: "invalid"
        },
        output: /config-existing-ok/
      },
      {
        name: "invalid-current",
        environment: {},
        output: /config-invalid-current-ok/
      }
    ] as const;
    for (const scenario of scenarios) {
      const result = await runProcess(process.execPath, [
        resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs"),
        helperPath
      ], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          NODE_ENV: "development",
          CONFIG_SCENARIO: scenario.name,
          IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY: toNamespacedPath(join(helperRoot, scenario.name)),
          SITE_ROOT: undefined,
          SITE_DESCRIPTION: undefined,
          SITE_GALLERY_ENABLED: undefined,
          SITE_GALLERY_PUBLIC_ORIGINAL_BUTTON: undefined,
          NORMALIZE_SKIP_WEBP_UNDER_KB: undefined,
          UPLOAD_MAX_ITEMS: undefined,
          ...scenario.environment
        },
        timeoutMs: 30_000
      });
      assert.match(result.stdout, scenario.output);
    }
  } finally {
    await rm(helperRoot, { recursive: true, force: true });
  }
});

test("Host 出口严格区分主站、static 资源域与未知 Host", async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  const helperRoot = await createTestDirectory("imageshow-host-boundary-");
  const helperPath = join(helperRoot, "verify-host-boundary.mjs");
  const runtimeConfigStoreUrl = pathToFileURL(resolve(
    repositoryRoot,
    "packages/server/src/config/runtime-config-store.ts"
  )).href;
  const siteHostUrl = pathToFileURL(resolve(
    repositoryRoot,
    "packages/server/src/config/site-host.ts"
  )).href;
  const httpAppUrl = pathToFileURL(resolve(
    repositoryRoot,
    "packages/server/src/http-app.ts"
  )).href;
  const helperSource = `
import assert from "node:assert/strict";
import {
  getRuntimeConfig,
  initializeRuntimeConfig,
  updateRuntimeConfig
} from ${JSON.stringify(runtimeConfigStoreUrl)};
import { staticLocalBaseUrl } from ${JSON.stringify(siteHostUrl)};
import { createHttpApp } from ${JSON.stringify(httpAppUrl)};

initializeRuntimeConfig();
const config = getRuntimeConfig();
assert.equal(config.site.domain, "img.example.com");
assert.equal(config.site.static_subdomain, "assets");
assert.equal(staticLocalBaseUrl(), "https://assets.img.example.com");

const app = createHttpApp({
  businessGateIsOpen: () => true,
  requireRedis: async () => undefined
});
async function status(host, path, method = "GET") {
  const response = await app.request(new Request(
    "http://internal.test" + path,
    { method, headers: { Host: host } }
  ));
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  return response.status;
}

assert.equal(await status("img.example.com", "/random", "POST"), 405);
assert.equal(await status("img.example.com", "/api/ping", "OPTIONS"), 204);
assert.equal(
  await status("assets.img.example.com", "/api/ping", "OPTIONS"),
  404
);
assert.equal(
  await status("assets.img.example.com", "/full/8d/example.webp", "OPTIONS"),
  204
);
assert.equal(
  await status("assets.img.example.com", "/link/not-a-uuid"),
  400
);
assert.equal(
  await status("img.example.com", "/link/not-a-uuid"),
  404
);
assert.equal(await status("assets.img.example.com", "/random", "POST"), 404);
for (const method of ["GET", "HEAD", "OPTIONS"]) {
  assert.equal(await status("assets.img.example.com", "/link/not-a-uuid", method), method === "OPTIONS" ? 204 : 400);
  if (method === "OPTIONS") continue;
  for (const host of ["img.example.com", "assets.img.example.com", "unknown.img.example.com"]) {
    for (const path of ["/link/not-a-uuid/extra", "/link/"]) {
      assert.equal(await status(host, path, method), 404, host + path + method);
    }
  }
}

for (const host of [
  "unknown.img.example.com",
  "another.img.example.com",
  "foo.assets.img.example.com"
]) {
  assert.equal(await status(host, "/"), 404, host);
}
await updateRuntimeConfig({site:{static_subdomain:""}});
assert.equal(staticLocalBaseUrl(), "https://img.example.com/static");
assert.equal(await status("assets.img.example.com", "/full/test.webp"),404);
assert.equal(await status("img.example.com", "/link/not-a-uuid"),404);
assert.equal(await status("img.example.com", "/static/link/not-a-uuid"),400);
assert.equal(await status("img.example.com", "/static/full/test.webp","OPTIONS"),204);
for (const method of ["GET", "HEAD", "OPTIONS"]) {
  assert.equal(await status("img.example.com", "/static/link/not-a-uuid", method), method === "OPTIONS" ? 204 : 400);
  if (method === "OPTIONS") continue;
  for (const host of ["img.example.com", "assets.img.example.com", "unknown.img.example.com"]) {
    for (const path of ["/static/link/not-a-uuid/extra", "/static/link/"]) {
      assert.equal(await status(host, path, method), 404, host + path + method);
    }
  }
}
for (const path of ["/full/test.webp","/thumbs/test.webp","/static","/static/","/static/api/site-config","/static/admin","/static/random","/static/assets/test.js","/static/static/full/test.webp"]) {
  for (const method of ["GET","HEAD","POST","OPTIONS"]) assert.equal(await status("img.example.com",path,method),404,path+method);
}
const publicConfig = await app.request("http://internal.test/api/site-config", {headers:{Host:"img.example.com"}});
assert.equal((await publicConfig.json()).site.static_url,"https://img.example.com/static");
for (const domain of ["img.example.com:5518","local.example:5518"]) {
  await updateRuntimeConfig({site:{domain}});
  assert.equal(staticLocalBaseUrl(),"https://"+domain+"/static");
  assert.equal(await status(domain,"/static/link/not-a-uuid"),400);
  assert.equal(await status(domain.split(":")[0],"/static/link/not-a-uuid"),404);
}
await updateRuntimeConfig({site:{domain:"img.example.com",static_subdomain:"media"}});
assert.equal(staticLocalBaseUrl(),"https://media.img.example.com");
assert.equal(await status("img.example.com","/static/link/not-a-uuid"),404);
assert.equal(await status("media.img.example.com","/link/not-a-uuid"),400);
assert.equal(await status("assets.img.example.com","/link/not-a-uuid"),404);
for (const domain of ["", "example.com"]) {
  for (const static_subdomain of ["", "assets"]) {
    await updateRuntimeConfig({site:{domain,static_subdomain}});
    assert.equal(staticLocalBaseUrl(), "/static");
    for (const host of ["localhost:5518", "127.0.0.1:5518", "first.example.com", "second.example.com:8443"]) {
      assert.equal(await status(host, "/api/ping", "OPTIONS"), 204, host);
      assert.equal(await status(host, "/static/link/not-a-uuid"), 400, host);
      assert.equal(await status(host, "/full/test.webp", "OPTIONS"), 404, host);
      const response = await app.request("http://internal.test/api/site-config", {headers:{Host:host}});
      assert.equal(response.status, 200);
      const resourceRoot = (await response.json()).site.static_url;
      assert.equal(resourceRoot, "/static");
      for (const scheme of ["http", "https"]) {
        assert.equal(new URL(resourceRoot + "/thumbs/test.webp", scheme + "://" + host).href,
          scheme + "://" + host + "/static/thumbs/test.webp");
      }
    }
    for (const host of ["", "bad host", "evil.test/path", "user@evil.test", "one.test,two.test", "local.test:0", "local.test:65536"]) {
      assert.equal(await status(host, "/api/ping", "OPTIONS"), 404, host);
    }
    const crossSite = await app.request("http://internal.test/api/ping", {
      method: "OPTIONS", headers: {Host:"localhost:5518", "Sec-Fetch-Site":"cross-site"}
    });
    assert.equal(crossSite.status, 403);
  }
}
await updateRuntimeConfig({site:{domain:"restored.example.com",static_subdomain:"assets"}});
assert.equal(await status("localhost:5518", "/api/ping", "OPTIONS"), 404);
assert.equal(await status("restored.example.com", "/api/ping", "OPTIONS"), 204);
assert.equal(staticLocalBaseUrl(), "https://assets.restored.example.com");
console.log("host-boundary-ok");
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
        IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY: toNamespacedPath(helperRoot),
        SITE_DOMAIN: "img.example.com",
        SITE_STATIC_SUBDOMAIN: "assets"
      },
      timeoutMs: 30_000
    });
    assert.match(result.stdout, /host-boundary-ok/);
  } finally {
    await rm(helperRoot, { recursive: true, force: true });
  }
});

test("配置包按目标版本能力宽松识别并保留导入安全边界", () => {
  const s3 = s3SettingsSchema.parse({
    endpoint: "objects.example.com",
    bucket: "gallery",
    access_key_id: "key",
    secret_access_key: "secret"
  });
  const backends = [
    {
      slug: "local",
      display_name: "本地",
      type: "local",
      enabled: true,
      is_default: true
    },
    {
      slug: "archive",
      display_name: "归档",
      type: "s3",
      enabled: true,
      is_default: false,
      s3
    }
  ] satisfies StorageBackendRecord[];
  const packageRuntime = runtimeConfigDefaults();
  packageRuntime.site.name = "来源站点";
  packageRuntime.site.description = "来源说明";
  packageRuntime.site.gallery.public_original_button = true;
  const pkg = buildConfigPackage(
    packageRuntime,
    backends,
    "current-build",
    new Date("2026-08-11T00:00:00.000Z")
  );
  assert.equal(pkg.format, "imageshow-config");
  assert.equal(pkg.application_version, "current-build");
  assert.equal(pkg.config.site.root, "home");
  assert.equal(pkg.config.site.gallery.public_original_button, true);
  assert.deepEqual(pkg.storage_backends, [{
    slug: "archive",
    display_name: "归档",
    enabled: true,
    is_default: false,
    s3
  }]);
  const complete = parseConfigPackage(pkg);
  assert.deepEqual(complete.config, pkg.config);
  assert.ok(complete.config_values.recognized > 0);
  assert.equal(complete.config_values.defaulted, 0);
  assert.equal(complete.config_values.ignored, 0);
  assert.equal(complete.skipped_storage_backends, 0);

  const source = structuredClone(pkg) as unknown as Record<string, unknown>;
  source.format = "future-config";
  delete source.application_version;
  source.unused_package_field = true;
  const sourceConfig = source.config as Record<string, Record<string, unknown>>;
  const sourceSite = sourceConfig.site!;
  sourceSite.name = "  已采用站点  ";
  delete sourceSite.description;
  sourceSite.root = "future-root";
  sourceSite.domain = "must-not-cross.example.com";
  sourceSite.unknown_site_field = true;
  const sourceGallery = sourceSite.gallery as Record<string, unknown>;
  delete sourceGallery.public_original_button;
  sourceConfig.future_group = { enabled: true };
  sourceConfig.normalize!.quality = 50;
  sourceConfig.normalize!.min_quality = 40;
  sourceConfig.thumbnail!.quality = 101;
  sourceConfig.thumbnail!.long_edge = "640";

  const sourceBackends = source.storage_backends as Array<Record<string, unknown>>;
  const sourceArchive = sourceBackends[0]!;
  sourceArchive.future_backend_field = true;
  (sourceArchive.s3 as Record<string, unknown>).future_s3_field = true;
  sourceBackends.push(
    { ...structuredClone(sourceArchive), display_name: "重复 slug" },
    {
      slug: "missing-settings",
      display_name: "缺少设置",
      enabled: true,
      is_default: false
    },
    {
      ...structuredClone(sourceArchive),
      slug: "disabled-default",
      display_name: "停用默认",
      enabled: false,
      is_default: true
    },
    {
      ...structuredClone(sourceArchive),
      slug: "wrong-setting-type",
      display_name: "错误设置类型",
      s3: {
        ...(sourceArchive.s3 as Record<string, unknown>),
        task_timeout_seconds: "300"
      }
    }
  );

  const parsed = parseConfigPackage(source);
  const defaults = runtimeConfigDefaults();
  assert.equal(parsed.format, "future-config");
  assert.equal(parsed.application_version, null);
  assert.equal(parsed.config.site.name, "已采用站点");
  assert.equal(parsed.config.site.description, defaults.site.description);
  assert.equal(parsed.config.site.root, defaults.site.root);
  assert.equal(parsed.config.site.gallery.public_original_button, false);
  assert.equal("domain" in parsed.config.site, false);
  assert.equal(parsed.config.normalize.quality, 50);
  assert.equal(parsed.config.normalize.min_quality, 40);
  assert.equal(parsed.config.thumbnail.quality, defaults.thumbnail.quality);
  assert.equal(parsed.config.thumbnail.long_edge, defaults.thumbnail.long_edge);
  assert.ok(parsed.config_values.recognized > 0);
  assert.ok(parsed.config_values.defaulted > 0);
  assert.ok(parsed.config_values.ignored > 0);
  assert.equal(parsed.storage_backends.length, 1);
  assert.equal(parsed.storage_backends[0]!.slug, "archive");
  assert.equal(parsed.storage_backends[0]!.s3.secret_access_key, "secret");
  assert.equal("future_s3_field" in parsed.storage_backends[0]!.s3, false);
  assert.equal(parsed.skipped_storage_backends, 4);
  const materialized = materializeImportedRuntimeConfig(
    parsed.config,
    "target.example.com"
  );
  assert.equal(materialized.site.domain, "target.example.com");

  const preview = projectConfigPackagePreview(parsed, new Set(["local", "archive"]));
  assert.deepEqual(preview.config_values, parsed.config_values);
  assert.equal(preview.skipped_storage_backends, 4);
  assert.deepEqual(preview.conflicts, ["archive"]);
  assert.deepEqual(
    resolveImportedStorageBackends(
      parsed,
      new Set(["local", "archive"]),
      { archive: "archive-imported" }
    ).map((backend) => backend.slug),
    ["archive-imported"]
  );
  assert.throws(
    () => resolveImportedStorageBackends(
      parsed,
      new Set(["local", "archive"]),
      {}
    ),
    (error) => error instanceof ApiError
      && error.code === "config_storage_slug_conflict"
  );
  assert.throws(
    () => resolveImportedStorageBackends(
      parsed,
      new Set(["local", "archive"]),
      { archive: "bad_slug" }
    ),
    (error) => error instanceof ApiError
      && error.status === 400
      && error.code === "config_slug_mapping_invalid"
  );

  const empty = parseConfigPackage({});
  const { domain: _domain, ...portableSiteDefaults } = defaults.site;
  assert.equal(empty.format, null);
  assert.equal(empty.application_version, null);
  assert.equal(empty.exported_at, null);
  assert.deepEqual(empty.config, { ...defaults, site: portableSiteDefaults });
  assert.equal(empty.config_values.recognized, 0);
  assert.ok(empty.config_values.defaulted > 0);
  assert.equal(empty.storage_backends.length, 0);

  const loneCombinationValue = parseConfigPackage({
    config: { normalize: { quality: 10 } }
  });
  assert.equal(loneCombinationValue.config.normalize.quality, defaults.normalize.quality);
  assert.equal(loneCombinationValue.config_values.ignored, 1);

  const competingNormalizeValues = parseConfigPackage({
    config: { normalize: { quality: 10, min_quality: 30 } }
  });
  assert.equal(
    competingNormalizeValues.config.normalize.quality,
    defaults.normalize.quality,
    "只回退造成组合无效的 quality"
  );
  assert.equal(competingNormalizeValues.config.normalize.min_quality, 30);
  assert.equal(competingNormalizeValues.config_values.ignored, 1);

  const competingAltchaValues = parseConfigPackage({
    config: { altcha: { cost: 100_000, counter_range: [100, 2_000] } }
  });
  assert.equal(competingAltchaValues.config.altcha.cost, defaults.altcha.cost);
  assert.deepEqual(
    competingAltchaValues.config.altcha.counter_range,
    [100, 2_000],
    "有效 counter_range 必须在 cost 回退后保留"
  );
  assert.equal(competingAltchaValues.config_values.ignored, 1);

  for (const scalarRoot of [null, false, 0, "", []]) {
    assert.throws(
      () => parseConfigPackage(scalarRoot),
      (error) => error instanceof ApiError
        && error.status === 400
        && error.code === "config_package_invalid"
    );
  }

  assert.throws(
    () => parseConfigPackage({
      storage_backends: Array.from({ length: 101 }, () => null)
    }),
    (error) => error instanceof ApiError
      && error.status === 400
      && error.code === "config_package_invalid"
  );
  assert.throws(
    () => parseConfigPackage({ content: "x".repeat(appConfig.configPackage.maxBytes) }),
    (error) => error instanceof ApiError
      && error.status === 413
      && error.code === "config_package_too_large"
  );
});

test("构建后的服务端 SPA 路由注入当前站点描述并遵循空值回退", async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  const helperRoot = await createTestDirectory("imageshow-spa-description-");
  const helperPath = join(helperRoot, "verify-spa-description.mjs");
  const runtimeConfigUrl = pathToFileURL(resolve(
    repositoryRoot,
    "packages/server/dist/config/runtime-config.js"
  )).href;
  const runtimeConfigStoreUrl = pathToFileURL(resolve(
    repositoryRoot,
    "packages/server/dist/config/runtime-config-store.js"
  )).href;
  const spaRoutesUrl = pathToFileURL(resolve(
    repositoryRoot,
    "packages/server/dist/routes/spa.js"
  )).href;
  const honoUrl = pathToFileURL(resolve(
    repositoryRoot,
    "node_modules/hono/dist/index.js"
  )).href;
  const helperSource = `
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from ${JSON.stringify(honoUrl)};
import { runtimeConfigDefaults } from ${JSON.stringify(runtimeConfigUrl)};
import {
  getRuntimeConfig,
  initializeRuntimeConfig,
  updateRuntimeConfig
} from ${JSON.stringify(runtimeConfigStoreUrl)};
import { registerSpaRoutes } from ${JSON.stringify(spaRoutesUrl)};

const root = process.env.IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY;
assert.ok(root);
const config = runtimeConfigDefaults();
config.site.name = "示例 <画廊>";
config.site.description = '图片 "说明" <安全>';
config.site.static_subdomain = "assets";
await writeFile(join(root, "config.json"), JSON.stringify(config));
initializeRuntimeConfig();
const app = new Hono();
app.get("/random", (c) => c.text("random-ok"));
registerSpaRoutes(app);

async function html(path = "/") {
  const response = await app.request("http://imageshow.test" + path);
  assert.equal(response.status, 200);
  return response.text();
}

const described = await html();
assert.match(await html("/show"), /<title>示例 &lt;画廊&gt;<\\/title>/);
assert.match(described, /<title>示例 &lt;画廊&gt;<\\/title>/);
assert.match(
  described,
  /<meta name="description" content="图片 &quot;说明&quot; &lt;安全&gt;" \\/>/
);
const inlineMarker = '<script type="application/json" id="__site_config__">';
const inlineStart = described.indexOf(inlineMarker);
assert.ok(inlineStart >= 0);
const inlineText = described.slice(
  inlineStart + inlineMarker.length,
  described.indexOf("</script>", inlineStart)
);
assert.equal(inlineText.includes("<"), false);
const inlineConfig = JSON.parse(inlineText);
assert.equal(inlineConfig.site.description, '图片 "说明" <安全>');
assert.equal(inlineConfig.site.static_url, "/static");
assert.equal(described.includes('<link rel="preconnect"'), false);

// All embedded public pages share the same enable switch and ancestor policy.
for (const path of ["/embed/home", "/embed/show", "/embed/gallery"]) {
  assert.equal((await app.request("http://imageshow.test" + path)).status, 404);
}
await updateRuntimeConfig({
  site: { root: "show", show: { mode: "float" } },
  embed: { enabled: true, allowed_origins: ["https://portal.example.com"] }
});
const rootShow = await app.request("http://imageshow.test/");
assert.equal(rootShow.status, 200);
assert.equal(rootShow.headers.get("location"), null);
assert.ok(rootShow.headers.get("content-security-policy-report-only")?.includes("connect-src 'self' https:"));
assert.ok(rootShow.headers.get("content-security-policy")?.includes("script-src 'self'"));
for (const path of [
  "/embed/home", "/embed/gallery", "/embed/show",
  "/embed/show?mode=float", "/embed/show?mode=waterfall&theme=stage"
]) {
  const response = await app.request("http://imageshow.test" + path);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
  assert.ok(response.headers.get("cache-control")?.includes("no-store"));
  assert.ok(response.headers.get("content-security-policy")?.includes("frame-ancestors"));
  assert.ok(response.headers.get("content-security-policy")?.includes("frame-ancestors 'self'"));
  assert.ok(response.headers.get("content-security-policy")?.includes("https://portal.example.com"));
  assert.ok(response.headers.get("content-security-policy-report-only")?.includes("connect-src 'self' https:"));
  assert.equal(response.headers.get("x-frame-options"), null);
  const body = await response.text();
  const start = body.indexOf(inlineMarker) + inlineMarker.length;
  const embeddedConfig = JSON.parse(body.slice(start, body.indexOf("</script>", start)));
  assert.equal(embeddedConfig.site.show.mode, "float");
}
await updateRuntimeConfig({ embed: { enabled: false } });
assert.equal((await app.request("http://imageshow.test/embed/show?mode=float")).status, 404);

await updateRuntimeConfig({ site: { description: "" } });
assert.match(
  await html(),
  /<meta name="description" content="示例 &lt;画廊&gt;" \\/>/
);
await updateRuntimeConfig({
  site: {
    home: { enabled: false },
    show: { enabled: false },
    gallery: { enabled: false }
  }
});
const unavailableRoot = await app.request("http://imageshow.test/");
assert.equal(unavailableRoot.status, 404);
assert.deepEqual(await unavailableRoot.json(), {
  ok: false,
  code: "not_found",
  error: "Not Found"
});
assert.equal((await app.request("http://imageshow.test/random")).status, 200);
assert.equal((await app.request("http://imageshow.test/admin")).status, 200);
console.log("spa-description-ok");
`;
  try {
    await writeFile(helperPath, helperSource);
    const result = await runProcess(process.execPath, [helperPath], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_ENV: "development",
        IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY: toNamespacedPath(helperRoot)
      },
      timeoutMs: 30_000
    });
    assert.match(result.stdout, /spa-description-ok/);
  } finally {
    await rm(helperRoot, { recursive: true, force: true });
  }
});

test("存储显示名统一使用配置值并为缺省名称提供稳定标签", () => {
  assert.equal(storageBackendLabel({
    storage_slug: "archive",
    storage_display_name: "  归档存储  "
  }), "归档存储");
  assert.equal(storageBackendLabel({
    storage_slug: "local",
    storage_display_name: ""
  }), "本地存储");
  assert.equal(storageBackendLabel({
    storage_slug: "archive",
    storage_display_name: null
  }), "archive");
});


test("输入校验统一图片更新、标签归一化、图片列表唯一性和 issue path", () => {
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

test("内容接入草稿批量更新在保护层后仍使用内容接入正文预算", async () => {
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

test("公开 cursor 与后台数字页使用严格且互斥的查询契约", () => {
  const defaultPublicQuery = listQuery.parse({ cursor: "opaque", limit: "60" });
  assert.equal(defaultPublicQuery.order, "latest");
  assert.equal(listQuery.safeParse({ order: "oldest" }).success, true);
  assert.equal(listQuery.safeParse({ order: "random" }).success, false);
  assert.equal(adminImageListQuery.safeParse({ page: "100", limit: "60" }).success, true);
  const completeFilters = {
    device: "pc",
    brightness: "dark",
    theme: "stage",
    tag: "live",
    author: "alice"
  };
  assert.equal(listQuery.safeParse(completeFilters).success, true);
  assert.equal(galleryStatsQuery.safeParse(completeFilters).success, true);
  assert.equal(adminImageListQuery.safeParse(completeFilters).success, true);

  for (const field of ["d", "b", "t", "a"]) {
    assert.equal(listQuery.safeParse({ [field]: "value" }).success, false);
    assert.equal(galleryStatsQuery.safeParse({ [field]: "value" }).success, false);
    assert.equal(adminImageListQuery.safeParse({ [field]: "value" }).success, false);
  }

  for (const query of [
    { page: "2" },
    { offset: "60" },
    { removed: "true" }
  ]) {
    const result = listQuery.safeParse(query);
    assert.equal(result.success, false);
  }
  for (const query of [
    { cursor: "opaque" },
    { offset: "60" },
    { removed: "true" },
    { page: "0" },
    { page: "-1" },
    { page: "1.5" },
    { page: String(Number.MAX_SAFE_INTEGER + 1) }
  ]) {
    const result = adminImageListQuery.safeParse(query);
    assert.equal(result.success, false);
  }

  assert.deepEqual(createPageWindow(1, 60), {
    page: 1,
    limit: 60,
    start: 0,
    endExclusive: 60
  });
  assert.deepEqual(createPageWindow(100, 60), {
    page: 100,
    limit: 60,
    start: 5_940,
    endExclusive: 6_000
  });
  assert.throws(
    () => createPageWindow(Number.MAX_SAFE_INTEGER, 2),
    (error: { status?: number; code?: string }) => (
      error.status === 400 && error.code === "validation_error"
    )
  );
});

test("图片 1..N 路由拒绝越权、重复 ID 与错误正文层级", async () => {
  const app = new Hono();
  app.onError((error, context) => handleApiError(context, error));
  app.use(`${adminApiBasePath}/*`, async (context, next) => {
    const role = context.req.header("x-test-role");
    if (role === "super" || role === "image") {
      context.set("session", { role });
    }
    await next();
  });
  registerAdminImageRoutes(app);
  registerPublicRoutes(app);

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

test("存储维护只保留中性写入口并在业务执行前拒绝越权", async () => {
  const app = new Hono();
  app.onError((error, context) => handleApiError(context, error));
  app.use(`${adminApiBasePath}/*`, async (context, next) => {
    const role = context.req.header("x-test-role");
    if (role === "super" || role === "image") context.set("session", { role });
    await next();
  });
  registerCheckRoutes(app);

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

test("可信单跳入口忽略转发 Host 并只接受单值客户端 IP", async () => {
  const app = new Hono();
  app.onError((error, context) => handleApiError(context, error));
  app.get("/inspect", (context) => context.json({
    ip: requestClientIp(context),
    secure: requestIsSecure(context)
  }));
  app.post("/same-origin", (context) => {
    assertSameOrigin(context);
    return context.json({ ok: true });
  });

  const inspect = async (headers: Record<string, string>) => (
    await (await app.request(new Request("http://internal.test/inspect", {
      headers: {
        host: "img.example.com",
        ...headers
      }
    }))).json() as { ip: string; secure: boolean }
  );
  assert.deepEqual(await inspect({
    "x-forwarded-host": "attacker.example",
    "x-forwarded-proto": "https",
    "x-real-ip": "203.0.113.8",
    "x-forwarded-for": "198.51.100.4, 10.0.0.2"
  }), { ip: "203.0.113.8", secure: true });
  assert.deepEqual(await inspect({
    "x-forwarded-for": "198.51.100.4, 10.0.0.2"
  }), { ip: "unknown", secure: false });
  assert.deepEqual(await inspect({
    "x-forwarded-for": "198.51.100.4"
  }), { ip: "198.51.100.4", secure: false });
  assert.deepEqual(await inspect({
    "x-forwarded-proto": "https, http",
    "x-real-ip": "not-an-ip",
    "x-forwarded-for": "2001:db8::7"
  }), { ip: "2001:db8::7", secure: false });

  const sameOriginHeaders = {
    host: "img.example.com",
    origin: "https://img.example.com",
    "x-forwarded-host": "attacker.example",
    "x-forwarded-proto": "https"
  };
  assert.equal((await app.request(new Request(
    "http://internal.test/same-origin",
    { method: "POST", headers: sameOriginHeaders }
  ))).status, 200);
  assert.equal((await app.request(new Request(
    "http://internal.test/same-origin",
    {
      method: "POST",
      headers: {
        ...sameOriginHeaders,
        origin: "https://attacker.example"
      }
    }
  ))).status, 403);
});

test("外部图片 DNS 地址策略保持严格解析、最长前缀与回调契约", async () => {
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

test("单进程配置写租约覆盖嵌套调用和长 I/O", async () => {
  const order: string[] = [];
  let releaseLongIo: () => void = () => undefined;
  let markLongIoStarted: () => void = () => undefined;
  const longIoGate = new Promise<void>((resolve) => {
    releaseLongIo = resolve;
  });
  const longIoStarted = new Promise<void>((resolve) => {
    markLongIoStarted = resolve;
  });
  const first = withRuntimeConfigWriteLease(async () => {
    order.push("first:start");
    markLongIoStarted();
    await longIoGate;
    await withRuntimeConfigWriteLease(() => {
      order.push("first:nested");
    });
    order.push("first:end");
  });
  await longIoStarted;
  const second = withRuntimeConfigWriteLease(() => {
    order.push("second");
  });
  await delay(10);
  assert.deepEqual(order, ["first:start"]);
  releaseLongIo();
  await Promise.all([first, second]);
  assert.deepEqual(order, [
    "first:start",
    "first:nested",
    "first:end",
    "second"
  ]);
});

test("共享 abort race 保留调用方 reason 并收口迟到 operation", async () => {
  const completed = await raceWithAbortSignal(
    new AbortController().signal,
    Promise.resolve("completed")
  );
  assert.equal(completed, "completed");

  const controller = new AbortController();
  const reason = new Error("caller cancelled");
  let rejectOperation: (error: Error) => void = () => undefined;
  const operation = new Promise<never>((_resolve, reject) => {
    rejectOperation = reject;
  });
  const raced = raceWithAbortSignal(controller.signal, operation);
  controller.abort(reason);
  await assert.rejects(raced, (error) => error === reason);
  rejectOperation(new Error("late operation failure"));
  await delay(0);
});

test("后台任务类型只接受当前固定集合", () => {
  assert.deepEqual(backgroundJobTypes, [
    "move.cleanup",
    "trash.purge",
    "cache.rebuild"
  ]);
  for (const type of backgroundJobTypes) {
    assert.equal(parseBackgroundJobType(type), type);
  }
  for (const unsupported of ["unsupported.job", "", null, 1]) {
    assert.throws(
      () => parseBackgroundJobType(unsupported),
      /Unsupported background job type/
    );
  }
});

test("Worker 重复停止会中止并排空同一个活动执行", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let completion: WorkerExecutionCompletion<string> | undefined;
  const coordinator = new WorkerExecutionCoordinator<{ id: string }, string>({
    taskTimeoutMs: 10_000,
    leaseRenewalIntervalMs: 10_000,
    renewLease: async () => true,
    execute: async (_job, signal) => {
      markStarted();
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true
        });
      });
    },
    settle: async (_job, result) => {
      completion = result;
    }
  });

  const running = coordinator.claimAndRun(async () => ({ id: "job" }));
  await started;
  const stopReason = new Error("test shutdown");
  coordinator.stop(stopReason);
  coordinator.stop(new Error("duplicate shutdown"));
  assert.equal(await coordinator.drain(1_000), true);
  assert.equal(await running, true);
  assert.equal(coordinator.isAccepting(), false);
  assert.deepEqual(completion, { status: "stopped", reason: stopReason });
  assert.equal(await coordinator.drain(0), true);

  coordinator.start();
  assert.equal(coordinator.isAccepting(), true);
  coordinator.stop();
});

test("Worker 不丢弃已经发出的迟到续租失败", async () => {
  for (const scenario of ["lost", "error"] as const) {
    const renewalStarted = deferredPromise<void>();
    const renewalResult = deferredPromise<boolean>();
    const handlerResult = deferredPromise<string>();
    const renewalError = new Error("injected renewal failure");
    let leaseLostCalls = 0;
    const renewalErrors: unknown[] = [];
    let completion: WorkerExecutionCompletion<string> | undefined;
    const coordinator = new WorkerExecutionCoordinator<
      { id: string },
      string
    >({
      taskTimeoutMs: 10_000,
      leaseRenewalIntervalMs: 1,
      renewLease: async () => {
        renewalStarted.resolve();
        return renewalResult.promise;
      },
      execute: async () => handlerResult.promise,
      settle: async (_job, result) => {
        completion = result;
      },
      onLeaseLost: () => {
        leaseLostCalls += 1;
      },
      onLeaseRenewalError: (_job, error) => {
        renewalErrors.push(error);
      }
    });

    const running = coordinator.claimAndRun(async () => ({ id: scenario }));
    await renewalStarted.promise;
    handlerResult.resolve("handled");
    // The handler continuation was registered first, so this microtask runs
    // after run() has stopped new renewals and is awaiting the in-flight one.
    await Promise.resolve();
    if (scenario === "lost") renewalResult.resolve(false);
    else renewalResult.reject(renewalError);

    assert.equal(await running, true);
    assert.equal(completion?.status, "rejected");
    if (completion?.status !== "rejected") assert.fail("expected rejection");
    if (scenario === "lost") {
      assert.equal(
        (completion.error as { code?: string }).code,
        "worker_lease_lost"
      );
      assert.equal(leaseLostCalls, 1);
      assert.deepEqual(renewalErrors, []);
    } else {
      assert.equal(
        (completion.error as { code?: string }).code,
        "worker_lease_renewal_failed"
      );
      assert.equal((completion.error as Error).cause, renewalError);
      assert.equal(leaseLostCalls, 0);
      assert.deepEqual(renewalErrors, [renewalError]);
    }
  }
});

test("Worker 停止原因优先于在途续租的迟到结果", async () => {
  const renewalStarted = deferredPromise<void>();
  const renewalResult = deferredPromise<boolean>();
  let leaseLostCalls = 0;
  let completion: WorkerExecutionCompletion<string> | undefined;
  const coordinator = new WorkerExecutionCoordinator<{ id: string }, string>({
    taskTimeoutMs: 10_000,
    leaseRenewalIntervalMs: 1,
    renewLease: async () => {
      renewalStarted.resolve();
      return renewalResult.promise;
    },
    execute: async (_job, signal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true
      });
    }),
    settle: async (_job, result) => {
      completion = result;
    },
    onLeaseLost: () => {
      leaseLostCalls += 1;
    }
  });

  const running = coordinator.claimAndRun(async () => ({ id: "stopping" }));
  await renewalStarted.promise;
  const stopReason = new Error("injected worker stop");
  coordinator.stop(stopReason);
  renewalResult.resolve(false);

  assert.equal(await running, true);
  assert.deepEqual(completion, { status: "stopped", reason: stopReason });
  assert.equal(leaseLostCalls, 0);
});

test("公开数据库准入保持 FIFO、总并发、队列上限与等待取消", async () => {
  const config = {
    ...appConfig.publicPgFallback,
    totalConcurrency: 1,
    queueLimit: 4,
    queueTimeoutMs: 30
  };
  const admission = createPublicDatabaseAdmission(config);
  const holder = await admission.acquire(new AbortController().signal);
  const activationOrder: string[] = [];
  const firstLeasePromise = admission.acquire(
    new AbortController().signal
  ).then((lease) => {
    activationOrder.push("first");
    return lease;
  });
  const secondLeasePromise = admission.acquire(
    new AbortController().signal
  ).then((lease) => {
    activationOrder.push("second");
    return lease;
  });
  assert.deepEqual(admission.snapshot(), { active: 1, queued: 2 });
  holder.release();
  const firstLease = await firstLeasePromise;
  await delay(0);
  assert.deepEqual(activationOrder, ["first"]);
  firstLease.release();
  const secondLease = await secondLeasePromise;
  assert.deepEqual(activationOrder, ["first", "second"]);
  secondLease.release();
  assert.equal(admission.snapshot().active, 0);
  assert.equal(admission.snapshot().queued, 0);

  const cancellationAdmission = createPublicDatabaseAdmission(config);
  const cancellationHolder = await cancellationAdmission.acquire(
    new AbortController().signal
  );
  const queuedAbort = new AbortController();
  const abortReason = new Error("queued request disconnected");
  const queued = cancellationAdmission.acquire(queuedAbort.signal);
  const queuedRejected = assert.rejects(
    queued,
    (error) => error === abortReason
  );
  queuedAbort.abort(abortReason);
  await queuedRejected;
  assert.equal(cancellationAdmission.snapshot().queued, 0);
  cancellationHolder.release();

  const boundedAdmission = createPublicDatabaseAdmission({
    ...config,
    queueLimit: 1,
    queueTimeoutMs: 10
  });
  const boundedHolder = await boundedAdmission.acquire(
    new AbortController().signal
  );
  const timedOut = boundedAdmission.acquire(new AbortController().signal);
  const timedOutRejected = assert.rejects(
    timedOut,
    (error: { code?: string; retryAfterSeconds?: number }) =>
      error.code === "public_pg_fallback_queue_timeout"
      && error.retryAfterSeconds === config.retryAfterSeconds
  );
  await assert.rejects(
    boundedAdmission.acquire(new AbortController().signal),
    (error: { code?: string }) =>
      error.code === "public_pg_fallback_queue_full"
  );
  await timedOutRejected;
  boundedHolder.release();
  assert.equal(boundedAdmission.snapshot().queued, 0);
});

test("公开 PostgreSQL 回源在缓存命中时零准入且多查询复用一个 client", async () => {
  class FakePublicClient {
    readonly releases: boolean[] = [];
    readonly queries: string[] = [];
    active = 0;
    maximumActive = 0;
    readonly execute: (text: string) => Promise<unknown>;

    constructor(execute: (text: string) => Promise<unknown> = async () => ({
      rows: []
    })) {
      this.execute = execute;
    }

    async query(text: string) {
      this.queries.push(text);
      this.active += 1;
      this.maximumActive = Math.max(this.maximumActive, this.active);
      try {
        return await this.execute(text);
      } finally {
        this.active -= 1;
      }
    }

    release(destroy = false) {
      this.releases.push(destroy);
    }
  }

  const client = new FakePublicClient();
  let admissionAcquires = 0;
  let admissionReleases = 0;
  let connects = 0;
  const scope = createPublicDatabaseReadScope({
    pool: {
      connect: async () => {
        connects += 1;
        return client;
      }
    } as never,
    admission: {
      acquire: async (_signal: AbortSignal) => {
        admissionAcquires += 1;
        return {
          release: () => {
            admissionReleases += 1;
          }
        };
      },
      snapshot: () => ({}) as never
    },
    executionTimeoutMs: 1_000,
    retryAfterSeconds: 1
  } as never);

  assert.equal(
    await scope(
      new AbortController().signal,
      async () => "redis cache hit"
    ),
    "redis cache hit"
  );
  assert.equal(admissionAcquires, 0);
  assert.equal(connects, 0);
  assert.deepEqual(client.releases, []);
  const workError = new Error("storage failed before PostgreSQL fallback");
  await assert.rejects(
    scope(new AbortController().signal, async () => {
      throw workError;
    }),
    (error) => error === workError
  );
  assert.equal(admissionAcquires, 0);
  assert.equal(connects, 0);

  assert.equal(await scope(
    new AbortController().signal,
    async ({ reader }) => {
      await Promise.all([
        reader.query("theme vocabulary"),
        reader.query("tag vocabulary"),
        reader.query("author vocabulary")
      ]);
      await reader.query("public response body");
      return "PostgreSQL fallback";
    }
  ), "PostgreSQL fallback");
  assert.equal(admissionAcquires, 1);
  assert.equal(connects, 1);
  assert.deepEqual(client.queries, [
    "theme vocabulary",
    "tag vocabulary",
    "author vocabulary",
    "public response body"
  ]);
  assert.deepEqual(client.releases, [false]);
  assert.equal(admissionReleases, 1);
  assert.equal(client.maximumActive, 1, "公开 reader 必须逐条执行单连接 SQL");

  const blockedAdmission = createPublicDatabaseAdmission({
    ...appConfig.publicPgFallback,
    totalConcurrency: 1
  });
  const blockedHolder = await blockedAdmission.acquire(
    new AbortController().signal
  );
  let blockedConnects = 0;
  const blockedScope = createPublicDatabaseReadScope({
    pool: {
      connect: async () => {
        blockedConnects += 1;
        return new FakePublicClient();
      }
    } as never,
    admission: blockedAdmission,
    executionTimeoutMs: 1_000,
    retryAfterSeconds: 1
  });
  const detachedErrors: unknown[] = [];
  assert.equal(await blockedScope(
    new AbortController().signal,
    async ({ reader }) => {
      void reader.query("detached").catch((error) => {
        detachedErrors.push(error);
      });
      return "returned early";
    }
  ), "returned early");
  assert.deepEqual(blockedAdmission.snapshot(), { active: 1, queued: 0 });
  assert.equal(blockedConnects, 0);
  blockedHolder.release();
  await delay(0);
  assert.equal(detachedErrors.length, 1);
});

test("公开 reader 排队 SQL 在失败、取消和 scope 结束后不再执行", async () => {
  for (const outcome of ["failure", "abort", "close"] as const) {
    const started = Promise.withResolvers<void>();
    const firstQuery = Promise.withResolvers<{ rows: unknown[] }>();
    const calls: string[] = [];
    const releases: boolean[] = [];
    let leaseReleases = 0;
    const controller = new AbortController();
    const failure = new Error(`reader ${outcome}`);
    const scope = createPublicDatabaseReadScope({
      pool: { connect: async () => ({
        query(text: string) {
          calls.push(text);
          started.resolve();
          return firstQuery.promise;
        },
        release(destroy: boolean) { releases.push(destroy); }
      }) } as never,
      admission: {
        acquire: async () => ({ release() { leaseReleases += 1; } }),
        snapshot: () => ({ active: 0, queued: 0 })
      },
      executionTimeoutMs: 1_000,
      retryAfterSeconds: 1
    });
    let results!: Promise<PromiseSettledResult<unknown>[]>;
    const operation = scope(controller.signal, async ({ reader }) => {
      const queries = [reader.query("first"), reader.query("second"), reader.query("third")];
      results = Promise.allSettled(queries);
      await started.promise;
      if (outcome === "close") throw failure;
      return Promise.all(queries);
    });
    const rejected = assert.rejects(operation, (error: { code?: string }) => (
      outcome === "failure"
        ? error.code === "public_pg_fallback_query_failed"
        : error === failure
    ));
    await started.promise;
    if (outcome === "failure") firstQuery.reject(failure);
    if (outcome === "abort") controller.abort(failure);
    await rejected;
    firstQuery.resolve({ rows: [] });
    const settled = await results;
    assert.deepEqual(calls, ["first"], `${outcome} 后排队 SQL 不得启动`);
    assert.equal(settled[1]?.status, "rejected");
    assert.equal(settled[2]?.status, "rejected");
    assert.deepEqual(releases, [true]);
    assert.equal(leaseReleases, 1);
  }
});

test("公开 PostgreSQL 回源在故障、取消和超时后释放资源", async () => {
  class FakePublicClient {
    readonly releases: boolean[] = [];
    readonly execute: () => Promise<unknown>;

    constructor(execute: () => Promise<unknown> = async () => ({
      rows: []
    })) {
      this.execute = execute;
    }

    query() {
      return this.execute();
    }

    release(destroy = false) {
      this.releases.push(destroy);
    }
  }

  const queryErrorClient = new FakePublicClient(async () => {
    throw new Error("connection lost during query");
  });
  let queryErrorLeaseReleases = 0;
  const queryErrorScope = createPublicDatabaseReadScope({
    pool: { connect: async () => queryErrorClient } as never,
    admission: {
      acquire: async () => ({
        release: () => {
          queryErrorLeaseReleases += 1;
        }
      }),
      snapshot: () => ({}) as never
    },
    executionTimeoutMs: 1_000,
    retryAfterSeconds: 1
  } as never);
  await assert.rejects(
    queryErrorScope(
      new AbortController().signal,
      async ({ reader }) => reader.query("broken")
    ),
    (error: { code?: string }) =>
      error.code === "public_pg_fallback_query_failed"
  );
  assert.deepEqual(queryErrorClient.releases, [true]);
  assert.equal(queryErrorLeaseReleases, 1);

  const apiErrorClient = new FakePublicClient();
  let apiErrorLeaseReleases = 0;
  const apiErrorScope = createPublicDatabaseReadScope({
    pool: { connect: async () => apiErrorClient } as never,
    admission: {
      acquire: async () => ({
        release: () => {
          apiErrorLeaseReleases += 1;
        }
      }),
      snapshot: () => ({}) as never
    },
    executionTimeoutMs: 1_000,
    retryAfterSeconds: 1
  } as never);
  const businessError = new ApiError(404, "not_found", "Not found");
  await assert.rejects(
    apiErrorScope(new AbortController().signal, async ({ reader }) => {
      await reader.query("business lookup");
      throw businessError;
    }),
    (error) => error === businessError
  );
  assert.deepEqual(apiErrorClient.releases, [false]);
  assert.equal(apiErrorLeaseReleases, 1);

  const recoveredClient = new FakePublicClient();
  let connectAttempts = 0;
  let recoveryAdmissionReleases = 0;
  const recoveringScope = createPublicDatabaseReadScope({
    pool: {
      connect: async () => {
        connectAttempts += 1;
        if (connectAttempts === 1) throw new Error("database unavailable");
        return recoveredClient;
      }
    } as never,
    admission: {
      acquire: async () => ({
        release: () => {
          recoveryAdmissionReleases += 1;
        }
      }),
      snapshot: () => ({}) as never
    },
    executionTimeoutMs: 1_000,
    retryAfterSeconds: 1
  } as never);
  await assert.rejects(
    recoveringScope(
      new AbortController().signal,
      async ({ reader }) => reader.query("unreachable")
    ),
    (error: { code?: string }) =>
      error.code === "public_pg_fallback_unavailable"
  );
  assert.deepEqual(await recoveringScope(
    new AbortController().signal,
    async ({ reader }) => reader.query("recovered")
  ), { rows: [] });
  assert.deepEqual(recoveredClient.releases, [false]);
  assert.equal(recoveryAdmissionReleases, 2);

  const activeStarted = deferredPromise<void>();
  const activeGate = deferredPromise<never>();
  const activeClient = new FakePublicClient(async () => {
    activeStarted.resolve();
    return activeGate.promise;
  });
  let activeAdmissionReleases = 0;
  const activeScope = createPublicDatabaseReadScope({
    pool: { connect: async () => activeClient } as never,
    admission: {
      acquire: async () => ({
        release: () => {
          activeAdmissionReleases += 1;
        }
      }),
      snapshot: () => ({}) as never
    },
    executionTimeoutMs: 1_000,
    retryAfterSeconds: 1
  } as never);
  const requestAbort = new AbortController();
  const operation = activeScope(
    requestAbort.signal,
    async ({ reader }) => reader.query("active")
  );
  await activeStarted.promise;
  const abortReason = new Error("public request disconnected");
  const operationRejected = assert.rejects(
    operation,
    (error) => error === abortReason
  );
  requestAbort.abort(abortReason);
  await operationRejected;
  assert.deepEqual(activeClient.releases, [true]);
  assert.equal(activeAdmissionReleases, 1);

  const checkoutGate = deferredPromise<FakePublicClient>();
  const checkoutStarted = deferredPromise<void>();
  const checkoutClient = new FakePublicClient();
  let checkoutAdmissionReleases = 0;
  const checkoutScope = createPublicDatabaseReadScope({
    pool: {
      connect: async () => {
        checkoutStarted.resolve();
        return checkoutGate.promise;
      }
    } as never,
    admission: {
      acquire: async () => ({
        release: () => {
          checkoutAdmissionReleases += 1;
        }
      }),
      snapshot: () => ({}) as never
    },
    executionTimeoutMs: 1_000,
    retryAfterSeconds: 1,
  } as never);
  const checkoutAbort = new AbortController();
  const checkoutOperation = checkoutScope(
    checkoutAbort.signal,
    async ({ reader }) => reader.query("unreachable")
  );
  await checkoutStarted.promise;
  const checkoutReason = new Error("disconnect during pool checkout");
  const checkoutRejected = assert.rejects(
    checkoutOperation,
    (error) => error === checkoutReason
  );
  checkoutAbort.abort(checkoutReason);
  await checkoutRejected;
  assert.equal(checkoutAdmissionReleases, 0);
  checkoutGate.resolve(checkoutClient);
  await delay(0);
  await delay(0);
  assert.deepEqual(checkoutClient.releases, [true]);
  assert.equal(checkoutAdmissionReleases, 1);

  const timeoutClient = new FakePublicClient(
    async () => new Promise<never>(() => undefined)
  );
  let timeoutAdmissionReleases = 0;
  const timeoutScope = createPublicDatabaseReadScope({
    pool: { connect: async () => timeoutClient } as never,
    admission: {
      acquire: async () => ({
        release: () => {
          timeoutAdmissionReleases += 1;
        }
      }),
      snapshot: () => ({}) as never
    },
    executionTimeoutMs: 10,
    retryAfterSeconds: 1
  } as never);
  await assert.rejects(
    timeoutScope(
      new AbortController().signal,
      async ({ reader }) => reader.query("slow")
    ),
    (error: { code?: string }) =>
      error.code === "public_pg_fallback_execution_timeout"
  );
  assert.deepEqual(timeoutClient.releases, [true]);
  assert.equal(timeoutAdmissionReleases, 1);

  const storageTimeoutClient = new FakePublicClient();
  let storageAbortObserved = false;
  let storageTimeoutAdmissionReleases = 0;
  const storageTimeoutScope = createPublicDatabaseReadScope({
    pool: { connect: async () => storageTimeoutClient } as never,
    admission: {
      acquire: async () => ({
        release: () => {
          storageTimeoutAdmissionReleases += 1;
        }
      }),
      snapshot: () => ({}) as never
    },
    executionTimeoutMs: 10,
    retryAfterSeconds: 1
  } as never);
  await assert.rejects(
    storageTimeoutScope(
      new AbortController().signal,
      async ({ reader }, signal) => {
        await reader.query("resolve storage record");
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            storageAbortObserved = true;
            reject(signal.reason);
          }, { once: true });
        });
      }
    ),
    (error: { code?: string }) =>
      error.code === "public_pg_fallback_execution_timeout"
  );
  assert.equal(storageAbortObserved, true);
  assert.deepEqual(storageTimeoutClient.releases, [true]);
  assert.equal(storageTimeoutAdmissionReleases, 1);
});

test("数据库事务边界只在成功提交并在失败时回滚", async () => {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      return text.startsWith("SELECT pg_current_xact_id")
        ? { rows: [{ transaction_id: "81" }] }
        : { rows: [] };
    }
  } as never;
  let transactionId = "";
  const value = await withTransactionOnClient(
    client,
    async () => "committed",
    { onTransactionId: (current) => {
      transactionId = current;
    } }
  );
  assert.equal(value, "committed");
  assert.equal(transactionId, "81");
  assert.deepEqual(queries, [
    "BEGIN",
    "SELECT pg_current_xact_id()::text AS transaction_id",
    "COMMIT"
  ]);

  queries.length = 0;
  const failure = new Error("transaction body failed");
  await assert.rejects(
    withTransactionOnClient(client, async () => {
      throw failure;
    }),
    (error) => error === failure
  );
  assert.deepEqual(queries, ["BEGIN", "ROLLBACK"]);

  queries.length = 0;
  assert.equal(
    await withTransactionOnClient(
      client,
      async () => "snapshot",
      { mode: "read_only_repeatable_read" }
    ),
    "snapshot"
  );
  assert.deepEqual(queries, [
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "COMMIT"
  ]);

  queries.length = 0;
  await assert.rejects(
    withTransactionOnClient(
      client,
      async () => {
        throw failure;
      },
      { mode: "read_only_repeatable_read" }
    ),
    (error) => error === failure
  );
  assert.deepEqual(queries, [
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "ROLLBACK"
  ]);
});

test("serving record 统一 Redis 命中、空命中与 PostgreSQL fallback", async () => {
  const item = servingReadyCacheItem();
  const readyRow = {
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
  const deletedRow = { ...readyRow, status: "deleted" as const };
  let idCache: unknown = { cached: true, value: item };
  let objectCache: unknown = { cached: true, value: item };
  let thumbCache: unknown = { cached: true, value: item };
  let queryRows: unknown[] = [];
  const queryParameters: unknown[][] = [];
  const reader = {
    query: async (_sql: string, parameters: unknown[]) => {
      queryParameters.push(parameters);
      return { rows: queryRows };
    }
  } as never;
  const dependencies = {
    readReadyImageById: async () => idCache,
    readReadyImageByObjectKey: async () => objectCache,
    readReadyImageByThumbKey: async () => thumbCache
  } as never;

  const cached = await readImageServingRecordById(
    item.id,
    {},
    dependencies
  );
  assert.equal(cached?.object_key, item.object_key);
  assert.equal(cached?.status, "ready");
  assert.equal(queryParameters.length, 0);

  idCache = { cached: true, value: null };
  assert.equal(
    await readImageServingRecordById(item.id, {}, dependencies),
    null
  );
  assert.equal(queryParameters.length, 0);

  queryRows = [deletedRow];
  const deleted = await readImageServingRecordById(
    item.id,
    { includeDeleted: true, database: { reader } },
    dependencies
  );
  assert.equal(deleted?.status, "deleted");
  assert.deepEqual(queryParameters.at(-1), [item.id, true]);

  idCache = { cached: false };
  queryRows = [readyRow];
  assert.equal(
    (await readImageServingRecordById(
      item.id,
      { database: { reader } },
      dependencies
    ))?.status,
    "ready"
  );
  assert.deepEqual(queryParameters.at(-1), [item.id, false]);

  assert.equal(
    (await readImageServingRecordByObjectKey(
      item.object_key,
      { reader },
      dependencies
    ))?.id,
    item.id
  );
  objectCache = { cached: true, value: null };
  queryRows = [deletedRow];
  assert.equal(
    (await readImageServingRecordByObjectKey(
      item.object_key,
      { reader },
      dependencies
    ))?.status,
    "deleted"
  );

  thumbCache = { cached: true, value: null };
  queryRows = [deletedRow];
  assert.equal(
    (await readImageServingRecordByThumbKey(
      item.object_key.replace(/\.[^.]+$/, ".webp"),
      { reader },
      dependencies
    ))?.status,
    "deleted"
  );
});

test("stored serving 的缩略图读取严格只读并保留真实错误语义", async () => {
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
  const presentedUrls = {
    object_url: `https://static.example.com/full/${item.object_key}`,
    thumb_url: `https://static.example.com/thumbs/${item.object_key.replace(/\.[^.]+$/, ".webp")}`
  };
  const readyAdminView = {
    ...item,
    ...presentedUrls,
    status: "ready",
    deleted_at: null,
    created_at: item.created_at,
    image_time: item.image_time,
    tags: item.tags,
    diff_original: true
  };
  const deletedAdminView = {
    ...item,
    ...presentedUrls,
    status: "deleted",
    deleted_at: "2026-08-11T00:00:00.000Z",
    created_at: item.created_at,
    image_time: item.image_time,
    tags: item.tags,
    diff_original: true
  };
  assert.deepEqual(
    {
      object_url: deletedAdminView.object_url,
      thumb_url: deletedAdminView.thumb_url
    },
    {
      object_url: readyAdminView.object_url,
      thumb_url: readyAdminView.thumb_url
    }
  );
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

test("external original serving 保持 direct/proxy、validator 与 deleted 边界", async () => {
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

test("ready cache coordinator 收口重连、revision、mutation 与 shutdown 行为", async () => {
  type CoordinatorDependencies = NonNullable<
    ConstructorParameters<typeof ReadyImageCacheCoordinator>[0]
  >;
  const capabilities = {
    available: true,
    commands: {},
    missing: []
  } as never;
  let connection = { ready: true, epoch: 1 };
  let operational: RedisOperationalState = {
    available: true,
    connectionEpoch: 1,
    reason: "ready",
    capabilities
  };
  let revision = "1";
  let persistedMeta = readyCacheMeta(revision);
  let cleanupCalls = 0;
  let rebuildCalls = 0;
  let validationCalls = 0;
  let validationFailureCalls = 0;
  let afterWriteFence = async () => undefined;
  let probe = async () => {
    if (!operational.available) throw new Error("Redis unavailable");
    return capabilities;
  };
  let handleValidationFailure = async () => {
    validationFailureCalls += 1;
  };
  let validate = async (_revision: string) => ({
    valid: true as const,
    meta: persistedMeta
  });
  let rebuild = async (_options: { signal?: AbortSignal }) => {
    rebuildCalls += 1;
    return readyCacheMeta(revision);
  };
  const dependencies = {
    getRedisConnectionState: () => connection,
    getRedisOperationalState: () => operational,
    probeRedisOperationalState: () => probe(),
    clearDisposableCaches: async () => {
      cleanupCalls += 1;
    },
    withWriteFence: async (work) => {
      const value = await work();
      await afterWriteFence();
      return value;
    },
    getRevision: async () => ({
      revision,
      updatedAt: "2026-08-11T00:00:00.000Z"
    }),
    validateCache: async (postgresRevision) => {
      validationCalls += 1;
      return validate(postgresRevision);
    },
    rebuildCache: (options) => rebuild(options),
    readMeta: async () => persistedMeta,
    handleValidationFailure: () => handleValidationFailure()
  } satisfies CoordinatorDependencies;
  const coordinator = new ReadyImageCacheCoordinator(dependencies);

  let status = await coordinator.initialize();
  assert.equal(status.initialized, true);
  assert.equal(status.readable, true);
  assert.equal(status.rebuilding, false);
  assert.equal(status.meta?.appliedRevision, "1");
  assert.equal(cleanupCalls, 1);
  assert.equal(rebuildCalls, 0);
  assert.deepEqual(
    await coordinator.withRead(async () => "redis"),
    { acquired: true, value: "redis" }
  );

  const manualProbeEntered = deferredPromise<void>();
  const finishManualProbe = deferredPromise<void>();
  const manualRebuildEntered = deferredPromise<void>();
  const finishManualRebuild = deferredPromise<void>();
  probe = async () => {
    manualProbeEntered.resolve();
    await finishManualProbe.promise;
    return capabilities;
  };
  rebuild = async ({ signal }) => {
    rebuildCalls += 1;
    manualRebuildEntered.resolve();
    await finishManualRebuild.promise;
    signal?.throwIfAborted();
    return persistedMeta;
  };
  const slowProbeRebuild = coordinator.requestRebuild();
  assert.equal(coordinator.getStatus().readable, false);
  assert.equal(coordinator.getStatus().rebuilding, true);
  assert.equal(coordinator.getStatus().reason, "rebuilding");
  await manualProbeEntered.promise;
  finishManualProbe.resolve();
  await manualRebuildEntered.promise;
  assert.equal(coordinator.getStatus().readable, false);
  assert.equal(coordinator.getStatus().rebuilding, true);
  finishManualRebuild.resolve();
  assert.equal((await slowProbeRebuild).appliedRevision, "1");
  probe = async () => {
    if (!operational.available) throw new Error("Redis unavailable");
    return capabilities;
  };
  rebuild = async () => {
    rebuildCalls += 1;
    return persistedMeta;
  };

  const currentValidationEntered = deferredPromise<void>();
  const finishCurrentValidation = deferredPromise<void>();
  const currentValidationHeldAtFence = deferredPromise<void>();
  const finishCurrentValidationFence = deferredPromise<void>();
  const pendingRebuildEntered = deferredPromise<void>();
  const finishPendingRebuild = deferredPromise<void>();
  validate = async () => {
    currentValidationEntered.resolve();
    await finishCurrentValidation.promise;
    return { valid: true as const, meta: persistedMeta };
  };
  afterWriteFence = async () => {
    currentValidationHeldAtFence.resolve();
    await finishCurrentValidationFence.promise;
  };
  rebuild = async ({ signal }) => {
    rebuildCalls += 1;
    pendingRebuildEntered.resolve();
    await finishPendingRebuild.promise;
    signal?.throwIfAborted();
    return persistedMeta;
  };
  coordinator.handleRedisOperationalStateChange(operational);
  await currentValidationEntered.promise;
  const rebuildAfterCurrentValidation = coordinator.requestRebuild();
  assert.equal(coordinator.getStatus().readable, false);
  assert.equal(coordinator.getStatus().rebuilding, true);
  finishCurrentValidation.resolve();
  await currentValidationHeldAtFence.promise;
  assert.equal(coordinator.getStatus().readable, false);
  assert.equal(coordinator.getStatus().rebuilding, true);
  finishCurrentValidationFence.resolve();
  await pendingRebuildEntered.promise;
  assert.equal(coordinator.getStatus().readable, false);
  assert.equal(coordinator.getStatus().rebuilding, true);
  finishPendingRebuild.resolve();
  assert.equal((await rebuildAfterCurrentValidation).appliedRevision, "1");
  assert.equal(coordinator.getStatus().readable, true);
  assert.equal(coordinator.getStatus().rebuilding, false);
  afterWriteFence = async () => undefined;

  connection = { ready: false, epoch: 1 };
  operational = {
    available: false,
    connectionEpoch: 1,
    reason: "connection_unavailable",
    capabilities: null
  };
  coordinator.handleRedisOperationalStateChange(operational);
  assert.equal(coordinator.getStatus().readable, false);
  assert.equal(coordinator.getStatus().reason, "connection_unavailable");
  assert.deepEqual(
    await coordinator.withRead(async () => "unused"),
    { acquired: false }
  );

  connection = { ready: true, epoch: 2 };
  operational = {
    available: true,
    connectionEpoch: 2,
    reason: "ready",
    capabilities
  };
  revision = "2";
  const reconnectRebuild = deferredPromise<ReturnType<typeof readyCacheMeta>>();
  const reconnectValidationEntered = deferredPromise<void>();
  const finishReconnectValidation = deferredPromise<void>();
  validate = async () => {
    reconnectValidationEntered.resolve();
    await finishReconnectValidation.promise;
    return {
      valid: false as const,
      reason: "revision_mismatch",
      meta: persistedMeta
    };
  };
  rebuild = async ({ signal }) => {
    rebuildCalls += 1;
    const meta = await reconnectRebuild.promise;
    signal?.throwIfAborted();
    return meta;
  };
  const rebuildCallsBeforeReconnect = rebuildCalls;
  const cleanupCallsBeforeReconnect = cleanupCalls;
  coordinator.handleRedisOperationalStateChange(operational);
  await reconnectValidationEntered.promise;
  const joinedRebuild = coordinator.requestRebuild();
  assert.equal(coordinator.getStatus().readable, false);
  assert.equal(coordinator.getStatus().rebuilding, true);
  assert.equal(coordinator.getStatus().reason, "rebuilding");
  finishReconnectValidation.resolve();
  await delay(0);
  assert.equal(coordinator.getStatus().rebuilding, true);
  const timeoutSignal = AbortSignal.timeout(5);
  await assert.rejects(
    coordinator.requestRebuild({ signal: timeoutSignal }),
    (error: Error) => error === timeoutSignal.reason
  );
  persistedMeta = readyCacheMeta("2");
  reconnectRebuild.resolve(persistedMeta);
  assert.equal((await joinedRebuild).appliedRevision, "2");
  assert.equal(rebuildCalls - rebuildCallsBeforeReconnect, 1);
  status = coordinator.getStatus();
  assert.equal(status.readable, true);
  assert.equal(status.meta?.appliedRevision, "2");
  assert.equal(cleanupCalls - cleanupCallsBeforeReconnect, 1);

  connection = { ready: true, epoch: 3 };
  operational = {
    available: true,
    connectionEpoch: 3,
    reason: "ready",
    capabilities
  };
  let drifted = false;
  validate = async () => {
    if (!drifted) {
      drifted = true;
      connection = { ready: true, epoch: 4 };
      operational = { ...operational, connectionEpoch: 4 };
    }
    return { valid: true as const, meta: persistedMeta };
  };
  const validationCallsBeforeDrift = validationCalls;
  coordinator.handleRedisOperationalStateChange({
    ...operational,
    connectionEpoch: 3
  });
  assert.equal((await coordinator.ensureCurrent()).appliedRevision, "2");
  assert.equal(validationCalls - validationCallsBeforeDrift, 2);
  assert.equal(coordinator.getStatus().readable, true);

  const failedValidation = new Error("controlled validation failure");
  const failedValidationEntered = deferredPromise<void>();
  const finishFailedValidation = deferredPromise<void>();
  validate = async () => {
    failedValidationEntered.resolve();
    await finishFailedValidation.promise;
    throw failedValidation;
  };
  rebuild = async () => {
    rebuildCalls += 1;
    return persistedMeta;
  };
  const rebuildCallsBeforeFailedValidation = rebuildCalls;
  coordinator.handleRedisOperationalStateChange(operational);
  await failedValidationEntered.promise;
  const rebuildAfterFailedValidation = coordinator.requestRebuild();
  finishFailedValidation.resolve();
  assert.equal(
    (await rebuildAfterFailedValidation).appliedRevision,
    persistedMeta.appliedRevision
  );
  assert.equal(rebuildCalls - rebuildCallsBeforeFailedValidation, 1);
  assert.equal(coordinator.getStatus().readable, true);

  revision = "3";
  const mutationRebuild = deferredPromise<ReturnType<typeof readyCacheMeta>>();
  rebuild = async ({ signal }) => {
    rebuildCalls += 1;
    const meta = await mutationRebuild.promise;
    signal?.throwIfAborted();
    return meta;
  };
  const releaseFirst = coordinator.beginPlannedMutation(5);
  const releaseSecond = coordinator.beginPlannedMutation(9);
  assert.equal(coordinator.plannedMutationIsActive(), true);
  assert.equal(coordinator.getStatus().readable, false);
  await assert.rejects(
    coordinator.requestRebuild(),
    /rebuild deferred until mutation completes/
  );
  assert.equal(coordinator.getStatus().rebuilding, true);
  const rebuildCallsBeforeMutation = rebuildCalls;
  assert.equal(releaseFirst(false), false);
  assert.equal(releaseSecond(false), true);
  assert.equal(coordinator.plannedMutationIsActive(), false);
  await delay(0);
  const mutationJoin = coordinator.requestRebuild();
  persistedMeta = readyCacheMeta("3");
  mutationRebuild.resolve(persistedMeta);
  assert.equal((await mutationJoin).appliedRevision, "3");
  assert.equal(rebuildCalls - rebuildCallsBeforeMutation, 1);
  assert.equal(coordinator.getStatus().readable, true);

  connection = { ready: true, epoch: 5 };
  operational = {
    available: true,
    connectionEpoch: 5,
    reason: "ready",
    capabilities
  };
  const validationEntered = deferredPromise<void>();
  const finishValidation = deferredPromise<void>();
  const validationFinishedInsideFence = deferredPromise<void>();
  const finishFence = deferredPromise<void>();
  let pauseFenceOnce = true;
  validate = async () => {
    validationEntered.resolve();
    await finishValidation.promise;
    return { valid: true as const, meta: persistedMeta };
  };
  afterWriteFence = async () => {
    if (!pauseFenceOnce) return;
    pauseFenceOnce = false;
    validationFinishedInsideFence.resolve();
    await finishFence.promise;
  };
  const validationCallsBeforeMutationOverlap = validationCalls;
  coordinator.handleRedisOperationalStateChange(operational);
  await validationEntered.promise;
  const releaseUnchangedMutation = coordinator.beginPlannedMutation(1);
  finishValidation.resolve();
  await validationFinishedInsideFence.promise;
  assert.equal(releaseUnchangedMutation(false), false);
  finishFence.resolve();
  assert.equal((await coordinator.ensureCurrent()).appliedRevision, "3");
  assert.equal(validationCalls - validationCallsBeforeMutationOverlap, 2);
  assert.equal(coordinator.getStatus().readable, true);
  afterWriteFence = async () => undefined;

  const staleRefreshFailure = new Error("stale connection refresh failure");
  const failureHandlingEntered = deferredPromise<void>();
  const finishFailureHandling = deferredPromise<void>();
  handleValidationFailure = async () => {
    validationFailureCalls += 1;
    failureHandlingEntered.resolve();
    await finishFailureHandling.promise;
  };
  rebuild = async () => {
    rebuildCalls += 1;
    throw staleRefreshFailure;
  };
  const staleRefresh = coordinator.requestRebuild();
  const staleRefreshRejected = assert.rejects(
    staleRefresh,
    (error: Error) => error === staleRefreshFailure
  );
  await failureHandlingEntered.promise;
  connection = { ready: true, epoch: 6 };
  operational = {
    available: true,
    connectionEpoch: 6,
    reason: "ready",
    capabilities
  };
  const validationCallsBeforeFailureOverlap = validationCalls;
  coordinator.handleRedisOperationalStateChange(operational);
  finishFailureHandling.resolve();
  await staleRefreshRejected;
  assert.equal((await coordinator.ensureCurrent()).appliedRevision, "3");
  assert.equal(validationCalls - validationCallsBeforeFailureOverlap, 1);
  assert.equal(coordinator.getStatus().readable, true);
  handleValidationFailure = async () => {
    validationFailureCalls += 1;
  };

  const rebuildFailure = new Error("controlled rebuild failure");
  const validationFailureCallsBeforeRebuild = validationFailureCalls;
  const rebuildFailureStarted = deferredPromise<void>();
  const finishRebuildFailure = deferredPromise<void>();
  const rebuildCallsBeforeSharedFailure = rebuildCalls;
  rebuild = async () => {
    rebuildCalls += 1;
    rebuildFailureStarted.resolve();
    await finishRebuildFailure.promise;
    throw rebuildFailure;
  };
  const firstFailedRebuild = coordinator.requestRebuild();
  await rebuildFailureStarted.promise;
  const joinedFailedRebuild = coordinator.requestRebuild();
  finishRebuildFailure.resolve();
  await Promise.all([
    assert.rejects(
      firstFailedRebuild,
      (error: Error) => error === rebuildFailure
    ),
    assert.rejects(
      joinedFailedRebuild,
      (error: Error) => error === rebuildFailure
    )
  ]);
  assert.equal(rebuildCalls - rebuildCallsBeforeSharedFailure, 1);
  assert.equal(coordinator.getStatus().readable, false);
  assert.match(coordinator.getStatus().reason, /^degraded:/);
  assert.equal(
    validationFailureCalls - validationFailureCallsBeforeRebuild,
    1
  );

  const degradedValidationEntered = deferredPromise<void>();
  const finishDegradedValidation = deferredPromise<void>();
  validate = async () => {
    degradedValidationEntered.resolve();
    await finishDegradedValidation.promise;
    return { valid: true as const, meta: persistedMeta };
  };
  const releaseDegradedMutation = coordinator.beginPlannedMutation(2);
  assert.equal(releaseDegradedMutation(false), false);
  await degradedValidationEntered.promise;
  assert.equal(coordinator.getStatus().readable, false);
  finishDegradedValidation.resolve();
  assert.equal((await coordinator.ensureCurrent()).appliedRevision, "3");
  assert.equal(coordinator.getStatus().readable, true);

  revision = "4";
  persistedMeta = readyCacheMeta("4");
  const finalRebuildEntered = deferredPromise<void>();
  const finishFinalRebuild = deferredPromise<ReturnType<typeof readyCacheMeta>>();
  rebuild = async () => {
    rebuildCalls += 1;
    finalRebuildEntered.resolve();
    return finishFinalRebuild.promise;
  };
  const finalRebuild = coordinator.requestRebuild();
  await finalRebuildEntered.promise;
  const lateJoinStarted = deferredPromise<void>();
  let lateJoin: ReturnType<typeof coordinator.requestRebuild> | null = null;
  finishFinalRebuild.resolve(persistedMeta);
  queueMicrotask(() => queueMicrotask(() => {
    lateJoin = coordinator.requestRebuild();
    lateJoinStarted.resolve();
  }));
  await lateJoinStarted.promise;
  assert.equal(coordinator.getStatus().readable, true);
  assert.equal(coordinator.getStatus().rebuilding, false);
  assert.ok(lateJoin);
  const [finalMeta, lateMeta] = await Promise.all([finalRebuild, lateJoin]);
  assert.equal(finalMeta.appliedRevision, "4");
  assert.equal(lateMeta.appliedRevision, "4");
  assert.equal(coordinator.getStatus().readable, true);
  assert.equal(coordinator.getStatus().rebuilding, false);
  coordinator.completeMutation(readyCacheMeta("5"));
  assert.equal(coordinator.getStatus().meta?.appliedRevision, "5");
  assert.equal(coordinator.getStatus().readable, true);

  const shutdownRebuild = deferredPromise<ReturnType<typeof readyCacheMeta>>();
  rebuild = async ({ signal }) => {
    rebuildCalls += 1;
    const meta = await shutdownRebuild.promise;
    signal?.throwIfAborted();
    return meta;
  };
  const activeRebuild = coordinator.requestRebuild();
  const activeRebuildRejected = assert.rejects(
    activeRebuild,
    /Ready-image cache coordinator stopped/
  );
  await delay(0);
  const releaseAfterStop = coordinator.beginPlannedMutation(1);
  const stopping = coordinator.stop();
  shutdownRebuild.resolve(readyCacheMeta("5"));
  await activeRebuildRejected;
  await stopping;
  assert.equal(coordinator.getStatus().readable, false);
  assert.equal(coordinator.getStatus().reason, "stopped");
  assert.equal(releaseAfterStop(false), false);
  assert.equal(coordinator.getStatus().readable, false);
  assert.equal(coordinator.getStatus().reason, "stopped");
  await assert.rejects(
    coordinator.requestRebuild(),
    /Ready-image cache coordinator is stopped/
  );
});

test("ready cache 管理状态以固定读取恢复数量、进度与完整重建时间", async () => {
  const meta = readyCacheMeta("8");
  const preservedRebuildSnapshot = rebuildingReadyImageCacheMeta(
    "8",
    "2026-08-11T00:00:01.000Z",
    meta
  );
  assert.equal(
    preservedRebuildSnapshot.lastFullRebuildCoreMemoryBytes,
    meta.lastFullRebuildCoreMemoryBytes
  );
  assert.equal(
    preservedRebuildSnapshot.lastFullRebuildMeasuredAt,
    meta.lastFullRebuildMeasuredAt
  );
  assert.equal(preservedRebuildSnapshot.fullRebuildCompletedAt, "");
  const recentCoreError = {
    category: "core" as const,
    code: "controlled_error",
    message: "controlled cache error",
    occurred_at: "2026-08-11T00:00:03.000Z"
  };
  const status = await readReadyImageCacheAdminStatus("8", {
    getCoordinatorStatus: () => ({
      initialized: true,
      readable: true,
      rebuilding: false,
      reason: "ready",
      meta
    }),
    getRevision: async () => ({
      revision: "8",
      updatedAt: "2026-08-11T00:00:00.000Z"
    }),
    readMeta: async () => meta,
    recentErrors: () => ({ core: recentCoreError, derived: null })
  });

  assert.deepEqual(Object.keys(status).sort(), [
    "applied_revision",
    "authoritative_revision",
    "full_rebuild_completed_at",
    "full_rebuild_duration_ms",
    "full_rebuild_started_at",
    "item_count",
    "last_full_rebuild_core_memory_bytes",
    "last_full_rebuild_measured_at",
    "last_updated_at",
    "processed",
    "readable",
    "reason",
    "rebuilding",
    "recent_errors",
    "state",
    "synchronized",
    "total"
  ]);
  assert.equal(status.synchronized, true);
  assert.equal(status.applied_revision, "8");
  assert.equal(status.item_count, 1);
  assert.equal(status.processed, null);
  assert.equal(status.total, null);
  assert.equal(status.last_updated_at, meta.lastUpdatedAt);
  assert.equal(status.full_rebuild_started_at, meta.fullRebuildStartedAt);
  assert.equal(status.full_rebuild_completed_at, meta.fullRebuildCompletedAt);
  assert.equal(status.full_rebuild_duration_ms, 1_000);
  assert.equal(
    status.last_full_rebuild_core_memory_bytes,
    meta.lastFullRebuildCoreMemoryBytes
  );
  assert.equal(
    status.last_full_rebuild_measured_at,
    meta.lastFullRebuildMeasuredAt
  );
  assert.deepEqual(status.recent_errors, {
    core: recentCoreError,
    derived: null
  });

  const rebuildingMeta = {
    ...meta,
    state: "rebuilding" as const,
    itemCount: 7,
    lastUpdatedAt: "2026-08-11T00:00:04.000Z",
    fullRebuildStartedAt: "2026-08-11T00:00:01.000Z",
    fullRebuildCompletedAt: "",
    processed: 7,
    total: 12
  };
  let persistedReads = 0;
  const rebuilding = await readReadyImageCacheAdminStatus("9", {
    getCoordinatorStatus: () => ({
      initialized: true,
      readable: false,
      rebuilding: true,
      reason: "rebuilding",
      meta
    }),
    getRevision: async () => ({
      revision: "9",
      updatedAt: "2026-08-11T00:00:00.000Z"
    }),
    readMeta: async () => {
      persistedReads += 1;
      return rebuildingMeta;
    },
    recentErrors: () => ({ core: null, derived: null })
  });
  assert.equal(persistedReads, 1);
  assert.equal(rebuilding.item_count, 7);
  assert.equal(rebuilding.processed, 7);
  assert.equal(rebuilding.total, 12);
  assert.equal(rebuilding.full_rebuild_completed_at, null);
  assert.equal(rebuilding.full_rebuild_duration_ms, null);

  const healthyWithCorruptPersisted = await readReadyImageCacheAdminStatus(
    "8",
    {
      getCoordinatorStatus: () => ({
        initialized: true,
        readable: true,
        rebuilding: false,
        reason: "ready",
        meta
      }),
      getRevision: async () => ({
        revision: "8",
        updatedAt: "2026-08-11T00:00:00.000Z"
      }),
      readMeta: async () => {
        throw new Error("controlled corrupt persisted meta");
      },
      recentErrors: () => ({ core: null, derived: null })
    }
  );
  assert.equal(healthyWithCorruptPersisted.synchronized, false);
  assert.equal(healthyWithCorruptPersisted.state, "unavailable");
  assert.equal(healthyWithCorruptPersisted.item_count, null);

  const missingPersisted = await readReadyImageCacheAdminStatus("9", {
    getCoordinatorStatus: () => ({
      initialized: true,
      readable: false,
      rebuilding: true,
      reason: "rebuilding",
      meta
    }),
    getRevision: async () => ({
      revision: "9",
      updatedAt: "2026-08-11T00:00:00.000Z"
    }),
    readMeta: async () => {
      throw new Error("controlled corrupt persisted meta");
    },
    recentErrors: () => ({ core: null, derived: null })
  });
  assert.equal(missingPersisted.item_count, null);
  assert.equal(missingPersisted.last_updated_at, null);
  assert.equal(missingPersisted.full_rebuild_started_at, null);
  assert.equal(missingPersisted.last_full_rebuild_core_memory_bytes, null);
  assert.equal(missingPersisted.last_full_rebuild_measured_at, null);
});

test("概览以固定核心键准确测量当前 Redis 占用并在并发与失败时收敛", async () => {
  const commands: unknown[][] = [];
  let scanCalls = 0;
  const redisClient = {
    scan: async () => {
      scanCalls += 1;
      return ["0", []];
    },
    pipeline: () => {
      const pipelineCommands: unknown[][] = [];
      return {
        call: (...command: unknown[]) => {
          pipelineCommands.push(command);
        },
        exec: async () => {
          commands.push(...pipelineCommands);
          return pipelineCommands.map((_, index) => [null, index + 1]);
        }
      };
    }
  };
  assert.equal(
    await measureReadyImageCoreMemory(redisClient as never),
    READY_IMAGE_CORE_KEYS.length * (READY_IMAGE_CORE_KEYS.length + 1) / 2
  );
  assert.equal(scanCalls, 0);
  assert.deepEqual(commands, READY_IMAGE_CORE_KEYS.map((key) => [
    "MEMORY",
    "USAGE",
    key,
    "SAMPLES",
    "0"
  ]));

  const meta = readyCacheMeta("18");
  const statusDependencies = {
    getCoordinatorStatus: () => ({
      initialized: true,
      readable: true,
      rebuilding: false,
      reason: "ready" as const,
      meta
    }),
    getRevision: async () => ({
      revision: "18",
      updatedAt: "2026-08-15T03:00:00.000Z"
    }),
    readMeta: async () => meta,
    recentErrors: () => ({ core: null, derived: null })
  };
  let releaseMeasurement!: () => void;
  const measurementGate = new Promise<void>((resolve) => {
    releaseMeasurement = resolve;
  });
  let measurementCalls = 0;
  const measurementDependencies = {
    measureCoreMemory: async () => {
      measurementCalls += 1;
      await measurementGate;
      return 12_345;
    },
    now: () => new Date("2026-08-15T03:00:00.000Z")
  };
  const first = getReadyImageCacheOverviewStatus(
    statusDependencies,
    measurementDependencies
  );
  const second = getReadyImageCacheOverviewStatus(
    statusDependencies,
    measurementDependencies
  );
  releaseMeasurement();
  const concurrentOverviews = await Promise.all([first, second]);
  assert.equal(measurementCalls, 1, "并发概览必须共用同一准确测量 Promise");
  assert.deepEqual(concurrentOverviews.map((item) => ({
    current_core_memory_bytes: item.current_core_memory_bytes,
    current_core_measured_at: item.current_core_measured_at
  })), [
    {
      current_core_memory_bytes: 12_345,
      current_core_measured_at: "2026-08-15T03:00:00.000Z"
    },
    {
      current_core_memory_bytes: 12_345,
      current_core_measured_at: "2026-08-15T03:00:00.000Z"
    }
  ]);
  const overview = await getReadyImageCacheOverviewStatus(
    statusDependencies,
    {
      measureCoreMemory: async () => 54_321,
      now: () => new Date("2026-08-15T03:01:00.000Z")
    }
  );
  assert.deepEqual(overview, {
    state: "ready",
    synchronized: true,
    rebuilding: false,
    item_count: meta.itemCount,
    current_core_memory_bytes: 54_321,
    current_core_measured_at: "2026-08-15T03:01:00.000Z",
    last_full_rebuild_core_memory_bytes:
      meta.lastFullRebuildCoreMemoryBytes,
    last_full_rebuild_measured_at: meta.lastFullRebuildMeasuredAt
  });

  const failedMeasurement = await getReadyImageCacheOverviewStatus(
    statusDependencies,
    {
      measureCoreMemory: async () => {
        throw new Error("controlled MEMORY USAGE failure");
      },
      now: () => new Date("2026-08-15T03:02:00.000Z")
    }
  );
  assert.equal(failedMeasurement.state, "ready");
  assert.equal(failedMeasurement.item_count, meta.itemCount);
  assert.equal(failedMeasurement.current_core_memory_bytes, null);
  assert.equal(failedMeasurement.current_core_measured_at, null);
  assert.equal(
    failedMeasurement.last_full_rebuild_core_memory_bytes,
    meta.lastFullRebuildCoreMemoryBytes,
    "当前测量失败不得抹掉明确标注的历史完整重建快照"
  );
});

test("Redis 手动深检保持截止时间、键上限、批次和取消边界", async () => {
  type MeasuredKey = readonly [string, number, number];
  const measurements = new Map<string, MeasuredKey>([
    ["imageshow:cache:images:meta", ["hash", 10, 12]],
    ["imageshow:cache:images:items", ["hash", 20, 3]],
    ["imageshow:cache:images:derived:filter:a", ["zset", 30, 2]]
  ]);
  const pipelineSizes: number[] = [];
  const scanPages = new Map<string, [string, string[]]>([
    ["0", ["1", [
      "imageshow:cache:images:meta",
      "imageshow:cache:images:items",
      "imageshow:cache:images:meta"
    ]]],
    ["1", ["0", [
      "imageshow:cache:images:derived:filter:a",
      "imageshow:other"
    ]]]
  ]);
  const client = {
    scan: async (cursor: string) => scanPages.get(cursor) ?? ["0", []],
    pipeline: () => {
      const keys: string[] = [];
      return {
        eval: (_script: string, _keyCount: number, key: string) => {
          keys.push(key);
        },
        exec: async () => {
          pipelineSizes.push(keys.length);
          return keys.map((key) => [
            null,
            measurements.get(key) ?? ["none", 0, 0]
          ]);
        }
      };
    }
  };
  const complete = await inspectRedisKeyspaceDeep({
    client: client as never,
    deadlineMs: 1_000,
    maxKeys: 10,
    pipelineMaxCommands: 2,
    now: () => new Date("2026-08-11T00:00:05.000Z")
  });
  assert.deepEqual(complete, {
    source: "deep",
    measured_at: "2026-08-11T00:00:05.000Z",
    complete: true,
    scanned_keys: 4,
    prefix_counts: {
      imageshow_total: 4,
      ready_image_cache: 3,
      ready_image_indexes: 0,
      ready_image_index_meta: 0,
      ready_image_filters: 1,
      ready_image_filter_meta: 0,
      ready_image_stats_results: 0,
      original_direct_cache: 0,
      sessions: 0,
      login_failures: 0,
      temporary: 0,
      other: 1
    },
    image_projection_usage: {
      core: { key_count: 2, member_count: 15, memory_bytes: 30 },
      derived: { key_count: 1, member_count: 2, memory_bytes: 30 }
    }
  });
  assert.ok(pipelineSizes.every((size) => size <= 2));

  const limited = await inspectRedisKeyspaceDeep({
    client: {
      ...client,
      scan: async () => ["0", [
        "imageshow:cache:images:meta",
        "imageshow:cache:images:items",
        "imageshow:cache:images:derived:filter:a"
      ]]
    } as never,
    deadlineMs: 1_000,
    maxKeys: 2,
    pipelineMaxCommands: 2
  });
  assert.equal(limited.complete, false);
  if (limited.complete) assert.fail("key-limited inspection must be partial");
  assert.equal(limited.reason, "max_keys");
  assert.equal(limited.scanned_keys, 2);
  assert.equal(limited.image_projection_usage.derived.key_count, 0);

  const pendingScan = deferredPromise<[string, string[]]>();
  let pendingScanCalls = 0;
  let pendingPipelineCalls = 0;
  const slowClient = {
    scan: async () => {
      pendingScanCalls += 1;
      return pendingScan.promise;
    },
    pipeline: () => {
      pendingPipelineCalls += 1;
      return { eval: () => undefined, exec: async () => [] };
    }
  };
  const timedOut = await inspectRedisKeyspaceDeep({
    client: slowClient as never,
    deadlineMs: 5,
    maxKeys: 10,
    pipelineMaxCommands: 2
  });
  assert.equal(timedOut.complete, false);
  if (timedOut.complete) assert.fail("deadline inspection must be partial");
  assert.equal(timedOut.reason, "deadline");
  assert.equal(timedOut.scanned_keys, 0);
  assert.equal(pendingScanCalls, 1);
  assert.equal(pendingPipelineCalls, 0);

  const abortScan = deferredPromise<[string, string[]]>();
  const abortController = new AbortController();
  const aborted = inspectRedisKeyspaceDeep({
    client: {
      scan: async () => abortScan.promise,
      pipeline: () => ({ eval: () => undefined, exec: async () => [] })
    } as never,
    signal: abortController.signal,
    deadlineMs: 1_000,
    maxKeys: 10,
    pipelineMaxCommands: 2
  });
  const abortReason = new Error("controlled request abort");
  abortController.abort(abortReason);
  await assert.rejects(aborted, (error: Error) => error === abortReason);

  await assert.rejects(
    inspectRedisKeyspaceDeep({
      client: client as never,
      deadlineMs: 0
    }),
    /deadlineMs must be an integer/
  );
  await assert.rejects(
    inspectRedisKeyspaceDeep({
      client: client as never,
      maxKeys: 1_000_001
    }),
    /maxKeys must be an integer/
  );
  await assert.rejects(
    inspectRedisKeyspaceDeep({
      client: client as never,
      pipelineMaxCommands: 1_001
    }),
    /pipelineMaxCommands must be an integer/
  );
});

test("Redis 窗口与 ready-image 脚本各归所属边界并严格解析返回值", async () => {
  assert.deepEqual(Object.keys(redisWindowScripts), [
    "imageshowReserveWindows"
  ]);
  assert.deepEqual(new Set(Object.keys(readyImageRedisScripts)), new Set([
    "imageshowTouchReadyImageIndexedResult",
    "imageshowTouchReadyImageStatsResult",
    "imageshowStoreReadyImageFilterSet",
    "imageshowPublishReadyImageAttributeIndex",
    "imageshowSampleReadyImageCoreIndex",
    "imageshowSampleReadyImageDerivedIndex"
  ]));
  const redisScripts = {
    ...redisWindowScripts,
    ...readyImageRedisScripts
  };
  const registrationOrder: string[] = [];
  const registrar = {
    options: {
      scripts: {
        retainedTestCommand: {
          lua: "return 1",
          readOnly: true
        }
      }
    },
    defineCommand(name: string) {
      registrationOrder.push(`define:${name}`);
      Object.assign(registrar, {
        [name]: async () => {
          registrationOrder.push(`call:${name}`);
          return name === "imageshowReserveWindows"
            ? [1, 1, 1, 30]
            : name === "imageshowSampleReadyImageCoreIndex"
              ? [2, 0]
              : 1;
        }
      });
    }
  };
  assert.deepEqual(await reserveRedisWindowsCommand(registrar as never, [
    { key: "registration:window", capacity: 1, windowSeconds: 30 }
  ]), [{
    attempted: true,
    allowed: true,
    value: 1,
    retryAfterSeconds: 30
  }]);
  assert.deepEqual(await sampleReadyImageCoreIndexCommand(
    registrar as never,
    {
      keys: ["meta", "integrity", "index", "items"],
      revision: "1",
      count: 0,
      bounds: {
        limit: 1,
        recentSize: 0,
        historySize: 30,
        maximumLimit: 200
      }
    }
  ), { status: "empty", pairs: [] });
  registerRedisWindowCommand(registrar as never);
  registerRedisWindowCommand(registrar as never);
  registerReadyImageRedisCommands(registrar as never);
  registerReadyImageRedisCommands(registrar as never);
  assert.deepEqual(
    registrationOrder.filter((entry) => entry.startsWith("define:")).sort(),
    Object.keys(redisScripts).map((name) => `define:${name}`).sort()
  );
  assert.ok(
    registrationOrder.indexOf("define:imageshowReserveWindows")
      < registrationOrder.indexOf("call:imageshowReserveWindows")
  );
  assert.ok(
    registrationOrder.indexOf("define:imageshowSampleReadyImageCoreIndex")
      < registrationOrder.indexOf("call:imageshowSampleReadyImageCoreIndex")
  );
  assert.deepEqual(
    new Set(Object.keys(registrar.options.scripts)),
    new Set(["retainedTestCommand", ...Object.keys(redisScripts)])
  );

  const windowCalls: unknown[][] = [];
  const windowClient = {
    async imageshowReserveWindows(...arguments_: unknown[]) {
      windowCalls.push(arguments_);
      return [1, 1, 1, 30, 0, 5, 0, 12];
    }
  } satisfies RedisWindowCommandClient;
  assert.deepEqual(await reserveRedisWindowsCommand(windowClient, [
    { key: "login:user", capacity: 3, windowSeconds: 30 },
    { key: "login:global", capacity: 5, windowSeconds: 60 }
  ]), [
    {
      attempted: true,
      allowed: true,
      value: 1,
      retryAfterSeconds: 30
    },
    {
      attempted: true,
      allowed: false,
      value: 5,
      retryAfterSeconds: 12
    }
  ]);
  assert.deepEqual(windowCalls, [[
    "2",
    "login:user",
    "login:global",
    "3",
    "30",
    "5",
    "60"
  ]]);
  await assert.rejects(
    reserveRedisWindowsCommand({
      async imageshowReserveWindows() { return [1, 1, 0, 30]; }
    }, [{ key: "broken", capacity: 1, windowSeconds: 30 }]),
    /inconsistent state/
  );
  await assert.rejects(
    reserveRedisWindowsCommand({
      async imageshowReserveWindows() { return []; }
    }, [{ key: "broken", capacity: 1, windowSeconds: 30 }]),
    /invalid result count/
  );

  const registry = {
    keys: ["registry:lru", "registry:counts", "registry:kinds", "registry:signatures"],
    ttlSeconds: 300,
    maxResults: 50,
    attributeIndexPrefix: "derived:index:",
    attributeAxisSuffixes: ["axis:pc:dark", "axis:mb:light"],
    namedAttributeKinds: ["theme", "tag", "author"],
    attributeSlugMaxLength: 63,
    filterKeyPrefix: "derived:filter:",
    statsResultKeyPrefix: "derived:stats:",
    maxResultMembers: 1_000,
    minimumTotalMembers: 500,
    totalMemberMultiplier: 4,
    maxActiveSignatures: 20,
    maxStatsResultBytes: 16_384
  } as const satisfies RedisDerivedRegistryCommandConfig;
  const indexedCalls: unknown[][] = [];
  const indexedReplies = [1, -1, "unexpected"];
  const indexedClient = {
    async imageshowTouchReadyImageIndexedResult(...arguments_: unknown[]) {
      indexedCalls.push(arguments_);
      return indexedReplies.shift();
    }
  } satisfies RedisIndexedTouchCommandClient;
  const indexedInput = {
    descriptor: {
      key: "derived:index:theme:night",
      kind: "attribute" as const,
      metaKey: "derived:index-meta:theme:night",
      signature: null
    },
    registry,
    revision: "42",
    count: 2,
    itemCount: 10,
    instanceToken: "a".repeat(32),
    accessedAt: "2026-08-21T00:00:00.000Z",
    accessScore: 123
  };
  assert.equal(
    await touchReadyImageIndexedResultCommand(indexedClient, indexedInput),
    1
  );
  assert.equal(
    await touchReadyImageIndexedResultCommand(indexedClient, indexedInput),
    -1
  );
  assert.equal(
    await touchReadyImageIndexedResultCommand(indexedClient, indexedInput),
    0
  );
  assert.deepEqual(indexedCalls[0], [
    "derived:index:theme:night",
    "derived:index-meta:theme:night",
    ...registry.keys,
    "derived:index:theme:night",
    "2",
    "42",
    "2026-08-21T00:00:00.000Z",
    "300",
    "a".repeat(32),
    "5",
    "attribute",
    "",
    "123",
    "50",
    "10",
    "derived:index:",
    "axis:pc:dark,axis:mb:light",
    "theme,tag,author",
    "63",
    "derived:filter:",
    "derived:stats:",
    "1000",
    "500",
    "4",
    "20",
    "16384"
  ]);

  const statsCalls: unknown[][] = [];
  const statsClient = {
    async imageshowTouchReadyImageStatsResult(...arguments_: unknown[]) {
      statsCalls.push(arguments_);
      return 1;
    }
  } satisfies RedisStatsTouchCommandClient;
  assert.equal(await touchReadyImageStatsResultCommand(statsClient, {
    descriptor: {
      key: "derived:stats:" + "b".repeat(64),
      kind: "stats-result",
      metaKey: null,
      signature: "b".repeat(64)
    },
    registry,
    serialized: "{\"count\":2}",
    itemCount: 10,
    accessScore: 124
  }), 1);
  assert.deepEqual(statsCalls[0], [
    "derived:stats:" + "b".repeat(64),
    "derived:stats:" + "b".repeat(64),
    ...registry.keys,
    "derived:stats:" + "b".repeat(64),
    "{\"count\":2}",
    "300",
    "b".repeat(64),
    "124",
    "50",
    "10",
    "derived:index:",
    "axis:pc:dark,axis:mb:light",
    "theme,tag,author",
    "63",
    "derived:filter:",
    "derived:stats:",
    "1000",
    "500",
    "4",
    "20",
    "16384"
  ]);

  const filterCalls: unknown[][] = [];
  const removedDestinations: string[] = [];
  const filterReplies: unknown[] = [
    [1, 3, 1, 3],
    "invalid",
    [0, 1, 7]
  ];
  const filterClient = {
    async imageshowStoreReadyImageFilterSet(...arguments_: unknown[]) {
      filterCalls.push(arguments_);
      return filterReplies.shift();
    },
    async unlink(...keys: string[]) {
      removedDestinations.push(...keys);
      return keys.length;
    }
  } satisfies RedisFilterSetCommandClient;
  const filterInput = {
    command: "zunionstore" as const,
    destination: "derived:temporary",
    sources: [
      { key: "source:first", count: 2 },
      { key: "source:second", count: 2 }
    ],
    expectedMembers: 3,
    temporaryTtlSeconds: 60
  };
  assert.equal(
    await storeReadyImageFilterSetCommand(filterClient, filterInput),
    3
  );
  assert.deepEqual(filterCalls[0], [
    "3",
    "source:first",
    "source:second",
    "derived:temporary",
    "2",
    "2",
    "ZUNIONSTORE",
    "3",
    "60"
  ]);
  await assert.rejects(
    storeReadyImageFilterSetCommand(filterClient, filterInput),
    /returned invalid data/
  );
  assert.deepEqual(removedDestinations, ["derived:temporary"]);
  await assert.rejects(
    storeReadyImageFilterSetCommand(filterClient, filterInput),
    /source changed during build/
  );
  assert.deepEqual(removedDestinations, ["derived:temporary"]);

  const attributeCalls: unknown[][] = [];
  const attributeClient = {
    async imageshowPublishReadyImageAttributeIndex(...arguments_: unknown[]) {
      attributeCalls.push(arguments_);
      return attributeCalls.length === 1 ? 1 : 0;
    }
  } satisfies RedisAttributePublishCommandClient;
  const attributeInput = {
    key: "derived:index:theme:night",
    metaKey: "derived:index-meta:theme:night",
    temporaryKey: "derived:temp:index",
    count: 2,
    revision: "42",
    now: "2026-08-21T00:00:00.000Z",
    instanceToken: "c".repeat(32),
    ttlSeconds: 300
  };
  assert.equal(
    await publishReadyImageAttributeIndexCommand(
      attributeClient,
      attributeInput
    ),
    true
  );
  assert.equal(
    await publishReadyImageAttributeIndexCommand(
      attributeClient,
      attributeInput
    ),
    false
  );
  assert.deepEqual(attributeCalls[0], [
    "derived:index:theme:night",
    "derived:index-meta:theme:night",
    "derived:temp:index",
    "2",
    "42",
    "2026-08-21T00:00:00.000Z",
    "2026-08-21T00:00:00.000Z",
    "c".repeat(32),
    "300"
  ]);

  const coreSampleCalls: unknown[][] = [];
  const coreSampleClient = {
    async imageshowSampleReadyImageCoreIndex(...arguments_: unknown[]) {
      coreSampleCalls.push(arguments_);
      return [
        1,
        2,
        "image:first",
        "{\"id\":\"first\"}",
        "image:second",
        "{\"id\":\"second\"}"
      ];
    }
  } satisfies RedisReadyImageCoreSampleCommandClient;
  assert.deepEqual(await sampleReadyImageCoreIndexCommand(coreSampleClient, {
    keys: ["core:meta", "core:integrity", "core:index", "core:items"],
    revision: "42",
    count: 2,
    bounds: { limit: 2, recentSize: 0, historySize: 30, maximumLimit: 200 }
  }), {
    status: "ok",
    pairs: [
      { member: "image:first", value: "{\"id\":\"first\"}" },
      { member: "image:second", value: "{\"id\":\"second\"}" }
    ]
  });
  assert.deepEqual(coreSampleCalls, [[
    "core:meta",
    "core:integrity",
    "core:index",
    "core:items",
    "42",
    "2",
    "2",
    "0",
    "30",
    "200"
  ]]);

  const derivedSampleCalls: unknown[][] = [];
  const derivedSampleClient = {
    async imageshowSampleReadyImageDerivedIndex(...arguments_: unknown[]) {
      derivedSampleCalls.push(arguments_);
      return [
        -7,
        2,
        "image:missing",
        null,
        "image:retained",
        "{\"id\":\"retained\"}"
      ];
    }
  } satisfies RedisReadyImageDerivedSampleCommandClient;
  assert.deepEqual(await sampleReadyImageDerivedIndexCommand(
    derivedSampleClient,
    {
      keys: [
        "core:meta",
        "core:integrity",
        "core:index",
        "core:items",
        "derived:index",
        "derived:meta"
      ],
      kind: "filter",
      revision: "42",
      coreCount: 10,
      indexCount: 2,
      instanceToken: "d".repeat(32),
      maximumIndexMembers: 1_000,
      bounds: { limit: 2, recentSize: 0, historySize: 30, maximumLimit: 200 }
    }
  ), {
    status: "derived_missing_item",
    pairs: [
      { member: "image:missing", value: null },
      { member: "image:retained", value: "{\"id\":\"retained\"}" }
    ]
  });
  assert.deepEqual(derivedSampleCalls, [[
    "core:meta",
    "core:integrity",
    "core:index",
    "core:items",
    "derived:index",
    "derived:meta",
    "42",
    "10",
    "2",
    "d".repeat(32),
    "filter",
    "2",
    "0",
    "30",
    "200",
    "1000"
  ]]);
  await assert.rejects(
    sampleReadyImageCoreIndexCommand({
      async imageshowSampleReadyImageCoreIndex() {
        return [1, 1, "image:missing", null];
      }
    }, {
      keys: ["core:meta", "core:integrity", "core:index", "core:items"],
      revision: "42",
      count: 1,
      bounds: { limit: 1, recentSize: 0, historySize: 0, maximumLimit: 200 }
    }),
    /inconsistent items/
  );
});

test("ready 随机抽样边界只调用一次 Redis 并保留近期排序", async () => {
  const samplingIds = [
    imageId,
    "019f8457-063a-7002-a580-7a432dc7fd8e",
    "019f8457-063a-7002-a580-7a432dc7fd8f",
    "019f8457-063a-7002-a580-7a432dc7fd90"
  ];
  const samplingItems = samplingIds.map((id, position) => (
    servingReadyCacheItem({
      id,
      object_key: storageObjectKey(id, "jpg"),
      sort_score: String(position + 1)
    })
  ));
  const coreCalls: unknown[] = [];
  let derivedCalls = 0;
  let revisionReads = 0;
  const coreDependencies = {
    currentRevision: () => {
      revisionReads += 1;
      return "42";
    },
    coreCount: () => {
      throw new Error("Core sampling must not request a derived count");
    },
    sampleCore: async (input) => {
      coreCalls.push(input);
      return {
        status: "ok" as const,
        pairs: samplingItems.map((item) => ({
          member: readyImageMember(item.id),
          value: serializeReadyImageCacheItem(item)
        }))
      };
    },
    sampleDerived: async () => {
      derivedCalls += 1;
      throw new Error("Core sampling must not call the derived command");
    }
  } satisfies ReadyImageSampleDependencies;
  const sampled = await sampleResolvedReadyImageIndex(
    {
      kind: "core",
      key: "core:index",
      revision: "42",
      count: samplingItems.length,
      metaKey: null,
      instanceToken: null
    },
    3,
    new Set([samplingIds[0]!, samplingIds[2]!]),
    coreDependencies
  );
  assert.deepEqual(sampled, [
    samplingItems[1],
    samplingItems[3],
    samplingItems[0]
  ]);
  assert.equal(coreCalls.length, 1);
  assert.equal(derivedCalls, 0);
  assert.equal(revisionReads, 2);

  let tokenReplacementCalls = 0;
  const tokenReplacementDependencies = {
    currentRevision: () => "42",
    coreCount: () => samplingItems.length,
    sampleCore: async () => {
      throw new Error("Derived sampling must not call the core command");
    },
    sampleDerived: async () => {
      tokenReplacementCalls += 1;
      return { status: "token_changed" as const, pairs: [] };
    }
  } satisfies ReadyImageSampleDependencies;
  assert.equal(await sampleResolvedReadyImageIndex(
    {
      kind: "filter",
      key: "derived:index",
      revision: "42",
      count: 2,
      metaKey: "derived:meta",
      instanceToken: "d".repeat(32)
    },
    1,
    new Set(),
    tokenReplacementDependencies
  ), null);
  assert.equal(tokenReplacementCalls, 1);
});

test("Redis 原生条件字符串命令严格解析替换、续期与部分批次结果", async () => {
  const commandCalls: string[][] = [];
  const replies: unknown[] = ["OK", null, "OK", null, 1, 0];
  const commandClient = {
    async call(command: string, ...arguments_: string[]) {
      commandCalls.push([command, ...arguments_]);
      return replies.shift();
    }
  };
  assert.equal(await replaceRedisStringIfEqualKeepingTtl(
    commandClient,
    "session",
    "before",
    "after"
  ), true);
  assert.equal(await replaceRedisStringIfEqualKeepingTtl(
    commandClient,
    "session",
    "stale",
    "unexpected"
  ), false);
  assert.equal(await refreshRedisStringTtlIfEqual(
    commandClient,
    "session",
    "after",
    300
  ), true);
  assert.equal(await refreshRedisStringTtlIfEqual(
    commandClient,
    "missing",
    "after",
    480
  ), false);
  assert.equal(await deleteRedisStringIfEqual(
    commandClient,
    "session",
    "after"
  ), true);
  assert.equal(await deleteRedisStringIfEqual(
    commandClient,
    "missing",
    "after"
  ), false);
  assert.deepEqual(commandCalls, [
    ["SET", "session", "after", "IFEQ", "before", "KEEPTTL"],
    ["SET", "session", "unexpected", "IFEQ", "stale", "KEEPTTL"],
    ["SET", "session", "after", "IFEQ", "after", "EX", "300"],
    ["SET", "missing", "after", "IFEQ", "after", "EX", "480"],
    ["DELEX", "session", "IFEQ", "after"],
    ["DELEX", "missing", "IFEQ", "after"]
  ]);
  assert.equal(parseRedisSetIfEqualReply("OK"), true);
  assert.equal(parseRedisSetIfEqualReply(null), false);
  assert.equal(parseRedisDeleteIfEqualReply(1), true);
  assert.equal(parseRedisDeleteIfEqualReply(0), false);
  assert.throws(() => parseRedisSetIfEqualReply(1), /invalid result/);
  assert.throws(() => parseRedisDeleteIfEqualReply("1"), /invalid result/);

  const pipelineCalls: string[][] = [];
  const snapshots = [
    { key: "first", value: "one" },
    { key: "raced", value: "old" },
    { key: "third", value: "three" }
  ];
  const partialClient = {
    pipeline: () => ({
      call(command: string, ...arguments_: string[]) {
        pipelineCalls.push([command, ...arguments_]);
      },
      async exec(): Promise<Array<[Error | null, unknown]>> {
        return [[null, 1], [null, 0], [null, 1]];
      }
    })
  };
  assert.deepEqual(
    await deleteRedisStringsIfEqual(partialClient, snapshots),
    [snapshots[0], snapshots[2]]
  );
  assert.deepEqual(pipelineCalls, [
    ["DELEX", "first", "IFEQ", "one"],
    ["DELEX", "raced", "IFEQ", "old"],
    ["DELEX", "third", "IFEQ", "three"]
  ]);

  const pipelineFailure = new Error("controlled DELEX failure");
  await assert.rejects(
    deleteRedisStringsIfEqual({
      pipeline: () => ({
        call() {},
        async exec(): Promise<Array<[Error | null, unknown]>> {
          return [[pipelineFailure, null]];
        }
      })
    }, [{ key: "first", value: "one" }]),
    (error: Error) => error === pipelineFailure
  );
  await assert.rejects(
    deleteRedisStringsIfEqual({
      pipeline: () => ({
        call() {},
        async exec(): Promise<Array<[Error | null, unknown]>> {
          return [[null, 2]];
        }
      })
    }, [{ key: "first", value: "one" }]),
    /invalid result/
  );
  await assert.rejects(
    deleteRedisStringsIfEqual({
      pipeline: () => ({
        call() {},
        async exec(): Promise<Array<[Error | null, unknown]>> {
          return [];
        }
      })
    }, [{ key: "first", value: "one" }]),
    /invalid result count/
  );
});

test("Redis 必需能力探针验证条件成功、失败、缺失与 TTL 保留", async () => {
  const successfulResults = (): Array<[Error | null, unknown]> => [
    [null, 1],
    [null, 1],
    [null, ["imageshow-required-command-probe"]],
    [null, "OK"],
    [null, 5_000],
    [null, "OK"],
    [null, 4_999],
    [null, null],
    [null, "after"],
    [null, null],
    [null, 0],
    [null, "OK"],
    [null, 0],
    [null, "owned"],
    [null, 1],
    [null, 0],
    [null, 0],
    [null, 4]
  ];
  const probeClient = (results: Array<[Error | null, unknown]>) => {
    const commands: string[][] = [];
    return {
      commands,
      client: {
        async call(command: string, ...arguments_: string[]) {
          commands.push([command, ...arguments_]);
          return [0, 1];
        },
        pipeline: () => ({
          call(command: string, ...arguments_: string[]) {
            commands.push([command, ...arguments_]);
          },
          async exec() {
            return results;
          }
        })
      }
    };
  };

  const successful = probeClient(successfulResults());
  assert.deepEqual(
    await readRequiredRedisCommandCapabilities(successful.client as never),
    {
      available: true,
      commands: {
        INCREX: true,
        ARRING: true,
        ARLASTITEMS: true,
        SET_IFEQ_KEEPTTL: true,
        DELEX_IFEQ: true
      },
      missing: []
    }
  );
  assert.deepEqual(successful.commands.map(([command]) => command), [
    "INCREX",
    "ARRING",
    "EXPIRE",
    "ARLASTITEMS",
    "SET",
    "PTTL",
    "SET",
    "PTTL",
    "SET",
    "GET",
    "SET",
    "EXISTS",
    "SET",
    "DELEX",
    "GET",
    "DELEX",
    "EXISTS",
    "DELEX",
    "UNLINK"
  ]);
  assert.deepEqual(successful.commands[6]?.slice(-3), [
    "IFEQ",
    "before",
    "KEEPTTL"
  ]);

  const invalidResults = successfulResults();
  invalidResults[6] = [null, -1];
  invalidResults[12] = [null, "0"];
  const invalid = probeClient(invalidResults);
  assert.deepEqual(
    await readRequiredRedisCommandCapabilities(invalid.client as never),
    {
      available: false,
      commands: {
        INCREX: true,
        ARRING: true,
        ARLASTITEMS: true,
        SET_IFEQ_KEEPTTL: false,
        DELEX_IFEQ: false
      },
      missing: ["SET_IFEQ_KEEPTTL", "DELEX_IFEQ"]
    }
  );
});

test("Redis 命令能力探针取消后不再调度阶段且原子收口探针键", async () => {
  const pendingIncrex = deferredPromise<unknown>();
  let pipelineCreations = 0;
  const increxCommands: string[] = [];
  const increxController = new AbortController();
  const increxProbe = readRequiredRedisCommandCapabilities({
    call: async (command: string) => {
      increxCommands.push(command);
      return pendingIncrex.promise;
    },
    pipeline: () => {
      pipelineCreations += 1;
      return { call: () => undefined, exec: async () => [] };
    }
  } as never, increxController.signal);
  await delay(0);
  assert.deepEqual(increxCommands, ["INCREX"]);
  const increxAbortReason = new Error("controlled INCREX probe abort");
  increxController.abort(increxAbortReason);
  await assert.rejects(
    increxProbe,
    (error: Error) => error === increxAbortReason
  );
  pendingIncrex.resolve([0, 1]);
  await delay(10);
  assert.equal(pipelineCreations, 0);

  const pendingArrayPipeline = deferredPromise<
    Array<[Error | null, unknown]>
  >();
  const pipelineStarted = deferredPromise<void>();
  const arrayCommands: string[] = [];
  const arrayController = new AbortController();
  const arrayProbe = readRequiredRedisCommandCapabilities({
    call: async () => [0, 1],
    pipeline: () => ({
      call: (command: string) => {
        arrayCommands.push(command);
      },
      exec: async () => {
        pipelineStarted.resolve();
        return pendingArrayPipeline.promise;
      }
    })
  } as never, arrayController.signal);
  await pipelineStarted.promise;
  assert.deepEqual(arrayCommands, [
    "ARRING",
    "EXPIRE",
    "ARLASTITEMS",
    "SET",
    "PTTL",
    "SET",
    "PTTL",
    "SET",
    "GET",
    "SET",
    "EXISTS",
    "SET",
    "DELEX",
    "GET",
    "DELEX",
    "EXISTS",
    "DELEX",
    "UNLINK"
  ]);
  const arrayAbortReason = new Error("controlled array probe abort");
  arrayController.abort(arrayAbortReason);
  await assert.rejects(
    arrayProbe,
    (error: Error) => error === arrayAbortReason
  );
  const scheduledAtReturn = [...arrayCommands];
  pendingArrayPipeline.resolve([
    [null, 1],
    [null, 1],
    [null, ["imageshow-required-command-probe"]],
    [null, 2]
  ]);
  await delay(10);
  assert.deepEqual(arrayCommands, scheduledAtReturn);
});

test("Redis 手动检查总期限覆盖连接与固定命令且保留请求取消原因", async () => {
  const pendingPing = deferredPromise<void>();
  let fixedCommandCalls = 0;
  const unusedClient = {
    status: "ready",
    info: async () => {
      fixedCommandCalls += 1;
      return "";
    },
    dbsize: async () => {
      fixedCommandCalls += 1;
      return 0;
    },
    scan: async () => ["0", []],
    pipeline: () => ({ eval: () => undefined, exec: async () => [] })
  };
  const dependencyBase = {
    client: unusedClient,
    ping: async () => pendingPing.promise,
    readMeta: async () => null,
    readRequiredCommands: async () => ({ commands: {}, missing: [] }),
    readProjection: async () => null,
    coordinatorStatus: () => ({ readable: true, reason: "ready" })
  };
  const pingStartedAt = performance.now();
  const pingDeadline = await inspectRedisState(undefined, {
    deadlineMs: 20,
    dependencies: dependencyBase as never
  });
  assert.ok(performance.now() - pingStartedAt < 1_000);
  assert.equal(pingDeadline.deep_inspection.complete, false);
  if (pingDeadline.deep_inspection.complete) {
    assert.fail("total-deadline inspection must be partial");
  }
  assert.equal(pingDeadline.deep_inspection.reason, "deadline");
  assert.equal(fixedCommandCalls, 0);

  const pendingInfo = deferredPromise<string>();
  const fixedDeadline = await inspectRedisState(undefined, {
    deadlineMs: 20,
    dependencies: {
      ...dependencyBase,
      ping: async () => undefined,
      client: {
        ...unusedClient,
        info: async () => {
          fixedCommandCalls += 1;
          return pendingInfo.promise;
        }
      }
    } as never
  });
  assert.equal(fixedDeadline.deep_inspection.complete, false);
  if (fixedDeadline.deep_inspection.complete) {
    assert.fail("fixed-command deadline inspection must be partial");
  }
  assert.equal(fixedDeadline.deep_inspection.reason, "deadline");
  assert.equal(fixedDeadline.connection.redis_version, "unknown");
  assert.ok(fixedCommandCalls >= 3);

  let scanCallsAfterFixedFailure = 0;
  const fixedFailure = new Error("controlled Redis INFO failure");
  await assert.rejects(
    inspectRedisState(undefined, {
      deadlineMs: 1_000,
      dependencies: {
        ...dependencyBase,
        ping: async () => undefined,
        client: {
          ...unusedClient,
          info: async (section: string) => {
            if (section === "server") throw fixedFailure;
            return "";
          },
          scan: async () => {
            scanCallsAfterFixedFailure += 1;
            await delay(5);
            return ["1", []];
          }
        }
      } as never
    }),
    (error: Error) => error === fixedFailure
  );
  const settledScanCalls = scanCallsAfterFixedFailure;
  assert.ok(settledScanCalls >= 1);
  await delay(50);
  assert.equal(scanCallsAfterFixedFailure, settledScanCalls);

  const abortController = new AbortController();
  const abortReason = new Error("controlled Redis inspection request abort");
  const aborted = inspectRedisState(abortController.signal, {
    deadlineMs: 1_000,
    dependencies: dependencyBase as never
  });
  abortController.abort(abortReason);
  await assert.rejects(aborted, (error: Error) => error === abortReason);
});

test("写路由集中拒绝无效 JSON、未知字段和空更新且无副作用", async () => {
  const app = new Hono();
  const writes: string[] = [];
  const auditEntries: string[] = [];
  const originalInfo = logger.info;
  const originalWarn = logger.warn;
  logger.info = (message) => auditEntries.push(message);
  logger.warn = (message) => auditEntries.push(message);
  const imageId = randomUUID();
  app.onError((error, context) => handleApiError(context, error));
  app.use("/read", async (context, next) => {
    markAdminReadRequest(context);
    await next();
  });
  app.use("/*", auditAdminMutation);
  app.use("/write", limitAdminLoginBody);
  app.post("/write", async (context) => {
    const input = parse(
      imageUpdateInput,
      await readJsonBody(context)
    );
    writes.push(input.items[0]?.title ?? "");
    return context.json({ ok: true });
  });
  app.post("/read", (context) => context.json({ ok: true }));

  const request = (
    body: string,
    contentType = "application/json; charset=utf-8",
    signal?: AbortSignal
  ) => app.request(new Request("http://imageshow.test/write", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
    signal
  }));
  const expectFailure = async (
    response: Response,
    code: string
  ) => {
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { code?: string }).code, code);
    assert.deepEqual(writes, []);
    assert.deepEqual(auditEntries, []);
  };

  try {
    await expectFailure(await request("not json"), "invalid_json");
    await expectFailure(await request('{"title":"truncated'), "invalid_json");
    await expectFailure(await request(""), "invalid_json");
    await expectFailure(
      await request(JSON.stringify({
        items: [{ id: imageId, title: "wrong media type" }]
      }), "text/plain"),
      "invalid_json"
    );
    await expectFailure(
      await request(JSON.stringify({
        items: [{
          id: imageId,
          title: "value",
          unknown_title: "unknown"
        }]
      })),
      "validation_error"
    );
    await expectFailure(await request('{"items":[]}'), "validation_error");

    const abortController = new AbortController();
    abortController.abort();
    await expectFailure(await request(
      JSON.stringify({
        items: [{ id: imageId, title: "must not commit" }]
      }),
      "application/json",
      abortController.signal
    ), "invalid_json");

    const valid = await request(
      JSON.stringify({ items: [{ id: imageId, title: "committed" }] }),
      "application/vnd.imageshow+json"
    );
    assert.equal(valid.status, 200);
    assert.deepEqual(writes, ["committed"]);
    assert.deepEqual(auditEntries, ["admin action"]);
    const read = await app.request(new Request("http://imageshow.test/read", {
      method: "POST"
    }));
    assert.equal(read.status, 200);
    assert.deepEqual(auditEntries, ["admin action"]);
  } finally {
    logger.info = originalInfo;
    logger.warn = originalWarn;
  }
});

test("存储键列举保持固定批大小、显式完整性和取消边界", async () => {
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
  let capturedOptions: Parameters<StorageDriver["listKeys"]>[1] = undefined;
  const snapshotDriver = {
    listKeys(_prefix, options) {
      capturedOptions = options;
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
  assert.equal(capturedOptions?.signal, snapshotAbort.signal);
  assert.equal(capturedOptions?.maxKeys, STORAGE_ADMIN_LIST_MAX_KEYS);
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

test("local / S3 配置只按实际连接参数复用 driver", () => {
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

test("S3 键列举按需分页并保持有界、可取消和错误透明", async () => {
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

test("S3 删除响应丢失后允许 move.cleanup 的幂等确认重试", async () => {
  const config: StorageConfig = {
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
      const name = command.constructor.name;
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

test("S3 自检在调用方取消后仍独立清理已落地探针", async () => {
  const config: StorageConfig = {
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
      const name = command.constructor.name;
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

test("S3 provider 中性 1…N 删除保持逐项结果、顺序分块和有限恢复", async (t) => {
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

test("S3 迁移优先使用条件 CopyObject，跨凭据时单次流式传输", async () => {
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
  ): StorageConfig => ({
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
        assert.equal(command.constructor.name, "GetObjectCommand");
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
          assert.equal(command.constructor.name, "GetObjectCommand");
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

test("跨 driver 迁移在目标提前拒绝、退休与取消时释放源流", async () => {
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

test("预存在迁移目标只在源完整性通过后读取目标", async () => {
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

test("S3 Range 错误释放响应体并保留权威对象总长度", async () => {
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

test("S3 响应期限和 driver 引用退休覆盖完整流生命周期", {
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
      async removeObjects(objects) {
        return objects.map((object) => ({
          ...object,
          status: "missing" as const
        }));
      },
      async copy() {},
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
  const managed = manageStorageDriver(
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
  const listingManaged = manageStorageDriver(
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
  let finishPendingExists;
  const pendingDriver = streamDriver(
    pendingBody,
    () => { pendingDriverClosed += 1; }
  );
  pendingDriver.exists = () => new Promise((resolve) => {
    finishPendingExists = resolve;
  });
  const pendingManaged = manageStorageDriver(pendingDriver);
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
    const lifecycleManaged = manageStorageDriver(driver);
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
    const lifecycleManaged = manageStorageDriver(
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
  const failingManaged = manageStorageDriver(failingDriver);
  const firstClose = failingManaged.close();
  const repeatedClose = failingManaged.close();
  assert.equal(firstClose, repeatedClose);
  await assert.rejects(firstClose, (error) => error === closeFailure);
  await assert.rejects(repeatedClose, (error) => error === closeFailure);
  assert.equal(failedCloseCalls, 1, "driver 只关闭一次");
});

test("图片标准化只信任 Sharp 编解码结果并保留既有格式与质量边界", async () => {
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

test("图片时间、UUIDv7、游标、分类和统一筛选保持一致", () => {
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

test("公开 cursor、后台 offset 与 Redis 有序窗口只读取精确目标页", async () => {
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

test("随机图查询以 auto 归一缺省设备并接受完整参数契约", async () => {
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

test("随机 JSON 卡片复用 canonical 字段且不额外读取详情", async () => {
  const item = servingReadyCacheItem({
    author: "photographer",
    title: "Random card"
  });
  let storageQueries = 0;
  const reader = {
    query: async () => {
      storageQueries += 1;
      return {
        rows: [{
          slug: "local",
          display_name: "Local",
          type: "local",
          config: {},
          enabled: true,
          is_default: true,
          namespace_identities: []
        }]
      };
    }
  } as never;
  invalidateStorageBackendRegistry();
  try {
    const [presented] = await presentRandomJsonItems(
      [item],
      undefined,
      { reader }
    );
    assert.equal(storageQueries, 1);
    assert.equal(presented.id, item.id);
    assert.equal(presented.title, "Random card");
    assert.equal(presented.author, "photographer");
    assert.equal(presented.diff_original, true);
    assert.match(presented.object_url, /\/full\//);
    assert.match(presented.thumb_url, /\/thumbs\//);
  } finally {
    invalidateStorageBackendRegistry();
  }
});

test("导入清单、下载进度与微博入口使用同一当前语义", () => {
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
    theme: "",
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

test("内容接入身份、稳定哈希、状态投影、TTL 与签名 purpose 契约", () => {
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
    theme: "none",
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
    status: "received"
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

test("不可逆协调器在同一 pair 边界区分可取消与已启动事务", async () => {
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
  let releaseTransaction = () => undefined;
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
  let releaseDiscard = () => undefined;
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
  let releaseFirst = () => undefined;
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
  let releaseSecond = () => undefined;
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

test("advisory lock 连接池等待可取消并释放迟到 client", async () => {
  const controller = new AbortController();
  const reason = new Error("stop while waiting for advisory client");
  let resolveClient!: (client: { release: () => void }) => void;
  const pending = new Promise<{ release: () => void }>((resolve) => {
    resolveClient = resolve;
  });
  let releases = 0;
  const acquiring = acquireAdvisoryLockClient(
    controller.signal,
    () => pending as never
  );
  controller.abort(reason);
  await assert.rejects(acquiring, (error) => error === reason);
  resolveClient({ release: () => {
    releases += 1;
  } });
  await delay(0);
  assert.equal(releases, 1);
});

test("图片处理共享许可并同时限制 commit 数量和字节", async () => {
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
  let releasePrepare = () => undefined;
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

  let releaseLargeCommit = () => undefined;
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

test("Ingestion Worker 跨页保持 Import queued 与 received 的 FIFO 调度", () => {
  const importSession = (
    position: number,
    status: "queued" | "received"
  ) => ({
    session_id: `import-session-${position}`,
    image_id: `import-image-${position}`,
    owner: "fifo-owner",
    queue: "import",
    status
  }) as never;
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
  } as never;

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

test("Ingestion Commit dispatch window 由公开并发派生且不会忽略等待许可的项", () => {
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

test("Ingestion pre-commit dispatch slot 由 Normalize 派生且交接后不重复领取活动 pair", () => {
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
  } as never;
  const successor = {
    ...normalizing,
    session_id: "successor-import",
    image_id: "successor-image",
    status: "queued"
  } as never;
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

test("Upload 与 Import 共用唯一 Prepare/Publish owner 并保留一批 Import 后继", async (t) => {
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
    const repositoryRoot = resolve(import.meta.dirname, "../..");
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

test("Import 后继窗口在 Normalize 准入时交接并完整释放许可", async (t) => {
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
    const repositoryRoot = resolve(import.meta.dirname, "../..");
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

test("动态数量与加权许可器保持 FIFO、热重载和取消释放语义", async (t) => {
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

test("微博上游调度保持串行、公平、随机节奏与单一访客身份", async (t) => {
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

test("下载进度写入失败会立即被观察并中止正文传输", async () => {
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

test("同一 execution 可接力草稿版本且身份变化仍会围栏", async () => {
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
      theme: "none",
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
    current: typeof staleExecution,
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
    updateProgress: async (current, expectedVersion, progress) => {
      assertCurrentExecution(current, expectedVersion);
      canonical = {
        ...canonical,
        ...progress,
        progress_seq: Number(canonical.progress_seq) + 1
      };
      return { session: canonical };
    },
    heartbeat: async (current, expectedVersion) => {
      assertCurrentExecution(current, expectedVersion);
      canonical = { ...canonical, discard_at: Date.now() + 120_000 };
      return { session: canonical };
    },
    mutateSemantic: async (current, expectedVersion, next) => {
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
    (error) => error?.code === "ingestion_execution_fenced"
  );
});


test("提交后两个暂存对象只调用一次批量清理并仅重试未完成项", async () => {
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

test("Ingestion 清理重试队列满载时背压且不丢失精确任务", async () => {
  const queue = new ingestionCleanupRetryQueue.constructor({
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

  const retrying = new ingestionCleanupRetryQueue.constructor({
    capacity: () => 1,
    retryDelayMs: () => 0
  });
  let attempts = 0;
  await retrying.enqueue(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient cleanup failure");
  });
  while (attempts < 2) await delay(0);

  const fairRetry = new ingestionCleanupRetryQueue.constructor({
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

test("可再发现的清理材料在满载与永久失败时保持有界", async () => {
  const queue = new ingestionCleanupRetryQueue.constructor({
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

test("取消批次只查询一次 PG 并在查询期间封住全部提交边界", async () => {
  const owner = "cancel-batch-owner";
  const coordinator = new IngestionIrreversibleCoordinator();
  const sessions = Array.from({ length: 100 }, (_, index) => {
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
        theme: "none",
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
          theme: "none",
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
    } as const;
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

test("取消批次把旧 incarnation 保留为逐项冲突", async () => {
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
  assert.deepEqual(results.map(({ status, code }) => ({ status, code })), [
    { status: "failed", code: "ingestion_incarnation_conflict" },
    { status: "completed", code: undefined }
  ]);
  assert.equal(results[1].completed_item.id, completed.image_id);
});

test("已启动事务的 expiry 只通过原子 cutoff 收敛", async () => {
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
        theme: "none",
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
    let releaseTransaction = () => undefined;
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

test("PG 完成清理不会越过新的 session incarnation", async () => {
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
      theme: "none",
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

test("PG 完成会清退保留 commit 的 failed canonical", async () => {
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
      theme: "none",
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
        theme: "none",
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

test("迟到失败接力同 execution 草稿版本且 prepared 丢响应保留引用", () => {
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

test("recovery 严格先收敛 expiry 并只重排一次未过期执行阶段", async () => {
  const now = 10_000;
  const session = (imageId: string, status: string, discardAt: number) => ({
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
      theme: "none",
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
  const sessions = new Map([
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
      current: { image_id: string; version: number },
      _version: number,
      next: { execution_token?: string }
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
        return active.map((item) => {
          operations.push(`cancel-${item.image_id}`);
          sessions.delete(item.image_id);
          return {
            session_id: item.session_id,
            image_id: item.image_id,
            status: "discarded" as const
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

test("恢复按实际扫描边界越过缺失 canonical 的满页", async () => {
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
        theme: "none",
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
    mutateSemantic: async (_current, _version, next) => {
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
      cancel: async (_repository, _coordinator, active) => active.map((item) => ({
        session_id: item.session_id,
        image_id: item.image_id,
        status: "discarded" as const
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

test("local 与 S3 对象命名、当前类型和物理命名空间保持统一", () => {
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

test("Redis ready 投影、管理员权限和密码验证保留当前安全边界", async () => {
  const item = readyImageCacheItemFromRow({
    id: imageId,
    object_key: storageObjectKey(imageId, "avif"),
    ext: "avif",
    device: "pc",
    brightness: "dark",
    theme: "none",
    storage_slug: "local",
    author: "alice",
    tags: ["stage", "concert", "stage"],
    width: 1920,
    height: 1080,
    image_size: 2048,
    cursor_image_time: "2026-08-04T12:00:00.654321Z",
    sort_score: "1785844800654321",
    title: "title",
    description: "description",
    source: "https://example.com/post",
    original: "https://example.com/image.jpg",
    md5: "0123456789abcdef0123456789abcdef",
    cursor_created_at: "2026-08-04T12:00:01.000Z",
    cursor_updated_at: "2026-08-04T12:00:02.000Z"
  });
  assert.deepEqual(item.tags, ["concert", "stage"]);
  assert.deepEqual(parseReadyImageCacheItem(serializeReadyImageCacheItem(item)), item);
  const member = readyImageMember(imageId);
  assert.equal(readyImageIdFromMember(member), imageId);
  assert.equal(readyImageThumbKey(item), storageObjectKey(imageId, "webp"));
  assert.deepEqual(readyImageStatFields(item), [
    "total",
    "device:pc",
    "brightness:dark",
    "axis:pc:dark",
    "theme:none",
    "tag:concert",
    "tag:stage",
    "author:alice"
  ]);
  assert.equal(parseReadyImageCacheItem("not-json"), null);

  assert.deepEqual(
    adminPermissionsForRole("super").sort(),
    Object.values(adminPermissions).sort()
  );
  assert.deepEqual(adminPermissionsForRole("image"), []);

  const password = "ImageShow-final-version-password";
  const encoded = await hashPassword(password);
  assert.match(encoded, /^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
  assert.equal(await verifyPassword(encoded, password), true);
  assert.equal(await verifyPassword(encoded, password + "-wrong"), false);
  assert.equal(isCurrentPasswordHash(encoded), true);
  assert.equal(isCurrentPasswordHash("invalid"), false);

  const malformedHash = "$argon2id$v=19$m=65536,t=3,p=4$"
    + "AAAAAAAAAAAAAAAAAAAAAA$"
    + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  assert.equal(isCurrentPasswordHash(malformedHash), false);
  assert.equal(await verifyPassword(malformedHash, password), false);
});

test("管理员会话只接受当前 namespace 和严格的一至两个凭据代际", async () => {
  const initialVersion = adminCredentialVersion("initial-password-hash");
  const firstVersion = adminCredentialVersion("first-password-hash");
  const secondVersion = adminCredentialVersion("second-password-hash");
  const thirdVersion = adminCredentialVersion("third-password-hash");
  assert.equal(firstVersion.length, 43);
  assert.deepEqual(parseAdminCredentialVersions([firstVersion]), [firstVersion]);
  assert.deepEqual(
    parseAdminCredentialVersions([firstVersion, secondVersion]),
    [firstVersion, secondVersion]
  );
  assert.deepEqual(
    adminCredentialTransitionVersions(
      "first-password-hash",
      secondVersion
    ),
    [firstVersion, secondVersion]
  );
  assert.notDeepEqual(
    adminCredentialTransitionVersions(
      "first-password-hash",
      secondVersion
    ),
    [initialVersion, secondVersion],
    "等待行锁后的第二次改密必须使用锁内最新代际"
  );
  for (const invalid of [
    undefined,
    null,
    [],
    ["invalid"],
    [firstVersion, firstVersion],
    [firstVersion, secondVersion, adminCredentialVersion("third")],
    [firstVersion, 7]
  ]) {
    assert.equal(parseAdminCredentialVersions(invalid), null);
  }

  assert.equal(adminSessionKey("session-id"), "imageshow:session:session-id");
  assert.equal(adminSessionKeyPattern, "imageshow:session:*");

  const authenticatedSession = {
    id: "authenticated-session",
    username: "alice",
    csrf: "csrf-token",
    role: "image" as const
  };
  const strictSessionPayload = (credentialVersions: string[]) => JSON.stringify({
    username: authenticatedSession.username,
    csrf: authenticatedSession.csrf,
    role: authenticatedSession.role,
    credential_versions: credentialVersions
  });
  let currentSessionPayload = strictSessionPayload([initialVersion]);
  const replacedSnapshots: string[] = [];
  const transitionStore = {
    async readSession(id: string) {
      assert.equal(id, authenticatedSession.id);
      return currentSessionPayload;
    },
    async replaceSessionSnapshot(
      id: string,
      expectedPayload: string,
      nextPayload: string
    ) {
      assert.equal(id, authenticatedSession.id);
      if (currentSessionPayload !== expectedPayload) return false;
      replacedSnapshots.push(expectedPayload);
      currentSessionPayload = nextPayload;
      return true;
    }
  };
  await authorizeAdminSessionCredentialTransition(
    authenticatedSession,
    adminCredentialTransitionVersions(
      "initial-password-hash",
      firstVersion
    ),
    transitionStore
  );
  assert.deepEqual(
    JSON.parse(currentSessionPayload).credential_versions,
    [initialVersion, firstVersion]
  );
  await authorizeAdminSessionCredentialTransition(
    authenticatedSession,
    adminCredentialTransitionVersions(
      "first-password-hash",
      secondVersion
    ),
    transitionStore
  );
  assert.deepEqual(
    JSON.parse(currentSessionPayload).credential_versions,
    [firstVersion, secondVersion],
    "合法连续改密必须使用行锁后的最新 stale 代际"
  );
  assert.equal(replacedSnapshots.length, 2);

  currentSessionPayload = strictSessionPayload([initialVersion]);
  await assert.rejects(
    authorizeAdminSessionCredentialTransition(
      authenticatedSession,
      adminCredentialTransitionVersions(
        "first-password-hash",
        secondVersion
      ),
      transitionStore
    ),
    (error: unknown) => (
      (error as { code?: string }).code === "unauthorized"
    ),
    "相同明文 reset 或同名重建后，stale 会话不得绑定新行锁代际"
  );
  assert.equal(
    currentSessionPayload,
    strictSessionPayload([initialVersion])
  );

  const snapshotRaceStore = {
    async readSession() {
      return strictSessionPayload([initialVersion]);
    },
    async replaceSessionSnapshot() {
      return false;
    }
  };
  await assert.rejects(
    authorizeAdminSessionCredentialTransition(
      authenticatedSession,
      adminCredentialTransitionVersions(
        "initial-password-hash",
        firstVersion
      ),
      snapshotRaceStore
    ),
    (error: unknown) => (
      (error as { code?: string }).code === "unauthorized"
    ),
    "读取后 payload 变化时必须拒绝盲写"
  );

  const preservedKey = adminSessionKey("preserved");
  const staleKey = adminSessionKey("stale");
  const transitionedKey = adminSessionKey("transitioned");
  const otherUserKey = adminSessionKey("other-user");
  const currentKeys = [preservedKey, staleKey, transitionedKey, otherUserKey];
  const payloads = new Map([
    [preservedKey, JSON.stringify({
      username: "alice",
      credential_versions: [firstVersion]
    })],
    [staleKey, JSON.stringify({
      username: "alice",
      credential_versions: [firstVersion]
    })],
    [transitionedKey, JSON.stringify({
      username: "alice",
      credential_versions: [firstVersion, secondVersion]
    })],
    [otherUserKey, JSON.stringify({
      username: "bob",
      credential_versions: [firstVersion]
    })]
  ]);
  const removed: string[] = [];
  const closedSessionConnections: string[] = [];
  for (const sessionId of ["preserved", "stale", "transitioned", "other-user"]) {
    registerAdminSessionConnection({
      sessionId,
      close: () => closedSessionConnections.push(sessionId)
    });
  }
  const client = {
    async scanSessions(cursor: string, pattern: string, count: number) {
      assert.equal(cursor, "0");
      assert.equal(pattern, adminSessionKeyPattern);
      assert.equal(count, 100);
      return ["0", currentKeys] as [string, string[]];
    },
    async readSessions(keys: string[]) {
      return keys.map((key) => payloads.get(key) ?? null);
    },
    async unlinkSessionsIfUnchanged(
      snapshots: Array<{ key: string; value: string }>
    ) {
      const targets = snapshots.filter(({ key, value }) => (
        payloads.get(key) === value
      ));
      removed.push(...targets.map(({ key }) => key));
      return targets;
    },
    async unlinkSessions(keys: string[]) {
      removed.push(...keys);
      return keys.length;
    }
  };
  assert.equal(await invalidateCommittedAdminSessionsByUsername(
    client,
    "alice",
    {
      operation: "password_change",
      preservedSessionId: "preserved",
      staleCredentialVersion: firstVersion,
      validCredentialVersion: secondVersion
    }
  ), 1);
  assert.deepEqual(removed, [staleKey]);
  assert.deepEqual(closedSessionConnections, ["stale"]);

  removed.length = 0;
  assert.equal(await invalidateAllAdminSessions(client), currentKeys.length);
  assert.deepEqual(removed, currentKeys);
  assert.deepEqual(
    new Set(closedSessionConnections),
    new Set(["stale", "preserved", "transitioned", "other-user"])
  );
  assert.equal(closeAllAdminSessionConnections(), 0);

  const racingKey = adminSessionKey("racing-transition");
  const stalePayload = JSON.stringify({
    username: "alice",
    credential_versions: [firstVersion]
  });
  const transitionedPayload = JSON.stringify({
    username: "alice",
    credential_versions: [firstVersion, secondVersion]
  });
  const racingPayloads = new Map([[racingKey, stalePayload]]);
  const racingRemoved: string[] = [];
  const racingClosed: string[] = [];
  registerAdminSessionConnection({
    sessionId: "racing-transition",
    close: () => racingClosed.push("racing-transition")
  });
  const racingClient = {
    async scanSessions() {
      return ["0", [racingKey]] as [string, string[]];
    },
    async readSessions(keys: string[]) {
      const snapshot = keys.map((key) => racingPayloads.get(key) ?? null);
      racingPayloads.set(racingKey, transitionedPayload);
      return snapshot;
    },
    async unlinkSessionsIfUnchanged(
      snapshots: Array<{ key: string; value: string }>
    ) {
      const targets = snapshots.filter(({ key, value }) => (
        racingPayloads.get(key) === value
      ));
      racingRemoved.push(...targets.map(({ key }) => key));
      return targets;
    },
    async unlinkSessions(keys: string[]) {
      racingRemoved.push(...keys);
      return keys.length;
    }
  };
  assert.equal(await invalidateCommittedAdminSessionsByUsername(
    racingClient,
    "alice",
    {
      operation: "password_change",
      preservedSessionId: "preserved",
      staleCredentialVersion: firstVersion,
      validCredentialVersion: secondVersion
    }
  ), 0);
  assert.deepEqual(racingRemoved, []);
  assert.equal(racingPayloads.get(racingKey), transitionedPayload);
  assert.deepEqual(racingClosed, []);
  assert.equal(
    closeAdminSessionConnections(["racing-transition"]),
    1,
    "条件删除未命中的有效会话连接必须保持打开"
  );

  const delayedKey = adminSessionKey("later-generation");
  const delayedPayload = JSON.stringify({
    username: "alice",
    credential_versions: [secondVersion, thirdVersion]
  });
  let delayedUnlinkCalls = 0;
  const delayedClient = {
    async scanSessions() {
      return ["0", [delayedKey]] as [string, string[]];
    },
    async readSessions() {
      return [delayedPayload];
    },
    async unlinkSessionsIfUnchanged(
      snapshots: Array<{ key: string; value: string }>
    ) {
      delayedUnlinkCalls += 1;
      return snapshots;
    },
    async unlinkSessions(keys: string[]) {
      return keys.length;
    }
  };
  assert.equal(await invalidateCommittedAdminSessionsByUsername(
    delayedClient,
    "alice",
    {
      operation: "password_change",
      preservedSessionId: "preserved",
      staleCredentialVersion: initialVersion,
      validCredentialVersion: firstVersion
    }
  ), 0);
  assert.equal(await invalidateCommittedAdminSessionsByUsername(
    delayedClient,
    "alice",
    {
      operation: "password_reset",
      staleCredentialVersion: initialVersion,
      validCredentialVersion: firstVersion
    }
  ), 0);
  assert.equal(await invalidateCommittedAdminSessionsByUsername(
    delayedClient,
    "alice",
    {
      operation: "account_delete",
      staleCredentialVersion: initialVersion
    }
  ), 0);
  assert.equal(
    delayedUnlinkCalls,
    0,
    "stale 清理不得选择已跨过其代际的新会话或同名重建会话"
  );

  const delexCalls: string[][] = [];
  const adapter = adminSessionRedisClient({
    async scan() {
      return ["0", []] as [string, string[]];
    },
    async mget() {
      return [];
    },
    async unlink() {
      return 0;
    },
    pipeline: () => ({
      call(command: string, ...arguments_: string[]) {
        delexCalls.push([command, ...arguments_]);
      },
      async exec(): Promise<Array<[Error | null, unknown]>> {
        return [[null, 0], [null, 1]];
      }
    })
  });
  assert.deepEqual(await adapter.unlinkSessionsIfUnchanged([
    { key: staleKey, value: stalePayload },
    { key: racingKey, value: transitionedPayload }
  ]), [{ key: racingKey, value: transitionedPayload }]);
  assert.deepEqual(delexCalls, [
    ["DELEX", staleKey, "IFEQ", stalePayload],
    ["DELEX", racingKey, "IFEQ", transitionedPayload]
  ]);
});

test("内容接入 SSE 先监听再快照、串行验权并响应登录立即失效", async () => {
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

test("HTTP 范围、缓存验证器和安全响应头遵循当前协议", async () => {
  assert.deepEqual(parseSingleByteRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseSingleByteRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseSingleByteRange("bytes=95-", 100), { start: 95, end: 99 });
  assert.throws(() => parseSingleByteRange("bytes=100-101", 100));
  assert.equal(normalizePartialContentRange("bytes 0-9/100"), "bytes 0-9/100");
  assert.equal(totalSizeFromContentRange("bytes */100"), 100);

  const url = "https://images.example.com/image.jpg";
  const upstreamEtag = '"upstream-v1"';
  const proxyEtag = proxyEtagForUpstream(url, upstreamEtag);
  assert.match(proxyEtag ?? "", /^W\/"imageshow-proxy\./);
  assert.equal(upstreamIfNoneMatchForProxy(url, proxyEtag), upstreamEtag);
  assert.equal(
    upstreamIfNoneMatchForProxy("https://images.example.com/other.jpg", proxyEtag),
    undefined
  );
  assert.equal(proxyLastModified(
    "Mon, 08 Jul 2013 18:06:40 GMT",
    "2026-08-07T10:00:00.500Z",
    Date.parse("2026-08-07T12:00:00Z")
  ), "Fri, 07 Aug 2026 10:00:01 GMT");
  assert.equal(upstreamIfModifiedSinceForProxy(
    "Fri, 07 Aug 2026 11:00:00 GMT",
    "2026-08-07T10:00:00Z",
    Date.parse("2026-08-07T12:00:00Z")
  ), "Fri, 07 Aug 2026 11:00:00 GMT");

  const app = new Hono();
  app.use("*", async (context, next) => {
    await next();
    finalizeSecurityHeaders(context);
  });
  app.get("/", (context) => context.text("ok"));
  app.get("/preferences", (context) => {
    context.header(adminImageListReadStartedAtHeader, "123");
    return privateCacheableApiSuccess(context, {
      preferences: { admin_scheme: "dark" }
    });
  });
  const response = await app.request("http://imageshow.test/");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(response.headers.get("permissions-policy"), null);
  const preferences = await app.request("http://imageshow.test/preferences");
  const preferenceEtag = preferences.headers.get("etag");
  assert.equal(preferences.status, 200);
  assert.equal(preferences.headers.get(adminImageListReadStartedAtHeader), "123");
  assert.equal(preferences.headers.get("cache-control"), "private, no-cache");
  assert.match(preferenceEtag ?? "", /^W\//u);
  assert.equal(preferenceEtag, apiSuccessEtag({
    preferences: { admin_scheme: "dark" }
  }), "认证首帧可复用完全相同的偏好表示验证器");
  assert.deepEqual(await preferences.json(), {
    ok: true,
    preferences: { admin_scheme: "dark" }
  });
  const unchangedPreferences = await app.request(
    "http://imageshow.test/preferences",
    { headers: { "If-None-Match": preferenceEtag ?? "" } }
  );
  assert.equal(unchangedPreferences.status, 304);
  assert.equal(
    unchangedPreferences.headers.get(adminImageListReadStartedAtHeader),
    "123"
  );
  assert.equal(unchangedPreferences.headers.get("etag"), preferenceEtag);
  assert.equal(await unchangedPreferences.text(), "");

});

test("日志尾读循环读取实际字节并区分缺失与 I/O 错误", async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  const helperRoot = await createTestDirectory("imageshow-log-tail-");
  const helperPath = join(helperRoot, "verify-log-tail.mjs");
  const runtimeConfigStoreUrl = pathToFileURL(resolve(
    repositoryRoot,
    "packages/server/src/config/runtime-config-store.ts"
  )).href;
  const logFilesUrl = pathToFileURL(resolve(
    repositoryRoot,
    "packages/server/src/core/log-files.ts"
  )).href;
  const helperSource = `
import assert from "node:assert/strict";
import { mkdir, open, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initializeRuntimeConfig } from ${JSON.stringify(runtimeConfigStoreUrl)};
import { readRecentLogFile } from ${JSON.stringify(logFilesUrl)};

const root = process.env.IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY;
assert.ok(root);
initializeRuntimeConfig();
const logDirectory = join(root, "log");
const logPath = join(logDirectory, "app.log");

const missing = await readRecentLogFile({});
assert.deepEqual(missing.files, []);
assert.equal(missing.content, "");
assert.equal(missing.bytes_read, 0);

await writeFile(logDirectory, "not a directory");
await assert.rejects(
  readRecentLogFile({}),
  (error) => error?.code === "ENOTDIR"
);
await rm(logDirectory, { force: true });
await mkdir(logDirectory, { recursive: true });

const payload = Array.from({ length: 2_048 }, (_, index) =>
  String.fromCharCode(65 + (index % 26))
).join("");
await writeFile(logPath, payload);
const probe = await open(logPath, "r");
const fileHandlePrototype = Object.getPrototypeOf(probe);
const originalRead = fileHandlePrototype.read;
await probe.close();
const originalEmit = fileHandlePrototype.emit;
let closeEvents = 0;
fileHandlePrototype.emit = function (event, ...args) {
  if (event === "close") closeEvents += 1;
  return originalEmit.call(this, event, ...args);
};

let shortReadCalls = 0;
fileHandlePrototype.read = function (buffer, offset, length, position) {
  shortReadCalls += 1;
  return originalRead.call(this, buffer, offset, Math.min(length, 7), position);
};
const closeEventsBeforeShortRead = closeEvents;
try {
  const result = await readRecentLogFile({ file: "app.log", limit: "1000" });
  assert.equal(result.truncated, true);
  assert.equal(result.bytes_read, 1_000);
  assert.equal(result.content, payload.slice(-1_000));
  assert.ok(shortReadCalls > 1);
} finally {
  fileHandlePrototype.read = originalRead;
}
assert.equal(closeEvents, closeEventsBeforeShortRead + 1);

let deletedDuringRead = false;
fileHandlePrototype.read = async function (buffer, offset, length, position) {
  const result = await originalRead.call(
    this,
    buffer,
    offset,
    Math.min(length, 7),
    position
  );
  if (!deletedDuringRead) {
    deletedDuringRead = true;
    await unlink(logPath);
  }
  return result;
};
const closeEventsBeforeDeletedRead = closeEvents;
try {
  const result = await readRecentLogFile({ file: "app.log", limit: "1000" });
  assert.equal(result.content, payload.slice(-1_000));
  assert.equal(result.bytes_read, 1_000);
} finally {
  fileHandlePrototype.read = originalRead;
}
assert.equal(closeEvents, closeEventsBeforeDeletedRead + 1);

await writeFile(logPath, payload);
fileHandlePrototype.read = async function () {
  throw Object.assign(new Error("permission denied"), { code: "EACCES" });
};
const closeEventsBeforeFailedRead = closeEvents;
try {
  await assert.rejects(
    readRecentLogFile({ file: "app.log", limit: "1000" }),
    (error) => error?.code === "EACCES"
  );
} finally {
  fileHandlePrototype.read = originalRead;
}
assert.equal(closeEvents, closeEventsBeforeFailedRead + 1);

const rotatedPath = join(logDirectory, "app.log.1");
await rename(logPath, rotatedPath);
await writeFile(logPath, "new active log");
const closeEventsBeforeRotatedRead = closeEvents;
const rotated = await readRecentLogFile({});
assert.deepEqual(rotated.files.map((file) => file.name), ["app.log", "app.log.1"]);
assert.equal(rotated.selected, "app.log");
assert.equal(rotated.content, "new active log");
assert.equal(closeEvents, closeEventsBeforeRotatedRead + 1);
fileHandlePrototype.emit = originalEmit;
console.log("log-tail-ok");
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
        IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY: toNamespacedPath(helperRoot)
      },
      timeoutMs: 30_000
    });
    assert.match(result.stdout, /log-tail-ok/);
  } finally {
    await rm(helperRoot, { recursive: true, force: true });
  }
});

type ProcessResult = { stdout: string; stderr: string };
const activeTestProcesses = new Set<ReturnType<typeof spawnManaged>>();
let activeTestInterruption: "SIGINT" | "SIGTERM" | null = null;

async function terminateActiveTestProcesses() {
  const processes = [...activeTestProcesses];
  const results = await Promise.allSettled(
    processes.map(forceTerminateProcessTree)
  );
  const errors = results.flatMap((result) => (
    result.status === "rejected" ? [result.reason] : []
  ));
  results.forEach((result, index) => {
    if (result.status === "rejected") releaseFailedProcessTree(processes[index]);
  });
  if (errors.length > 0) {
    throw new AggregateError(errors, "测试子进程树未能全部退出");
  }
}

function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    allowFailure?: boolean;
    allowDuringInterrupt?: boolean;
    timeoutMs?: number;
  } = {}
): Promise<ProcessResult & { code: number }> {
  if (activeTestInterruption && !options.allowDuringInterrupt) {
    return Promise.reject(new Error(
      `${command} refused after ${activeTestInterruption}`
    ));
  }
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawnManaged(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    activeTestProcesses.add(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? 60_000;
    const timeout = setTimeout(() => {
      timedOut = true;
      void forceTerminateProcessTree(child).then(
        () => finish(() => rejectProcess(new Error(
          `${command} exceeded ${timeoutMs} ms`
        ))),
        (error) => {
          releaseFailedProcessTree(child);
          activeTestProcesses.delete(child);
          finish(() => rejectProcess(new AggregateError(
            [error],
            `${command} exceeded ${timeoutMs} ms and did not terminate`
          )));
        }
      );
    }, timeoutMs);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      activeTestProcesses.delete(child);
      finish(() => rejectProcess(error));
    });
    child.on("close", (code) => {
      activeTestProcesses.delete(child);
      finish(() => {
        const exitCode = code ?? -1;
        if (timedOut) {
          rejectProcess(new Error(
            `${command} exceeded ${timeoutMs} ms: ${stderr || stdout}`
          ));
          return;
        }
        if (activeTestInterruption && !options.allowDuringInterrupt) {
          rejectProcess(new Error(
            `${command} interrupted with ${activeTestInterruption}`
          ));
          return;
        }
        if (exitCode !== 0 && !options.allowFailure) {
          rejectProcess(new Error(
            `${command} exited with ${exitCode}: ${stderr || stdout}`
          ));
          return;
        }
        resolveProcess({ code: exitCode, stdout, stderr });
      });
    });
  });
}

test("数据库以单一基线初始化空库并对现有库只读核对 readiness", {
  timeout: 240_000
}, async (context) => {
  const workspace = resolve(import.meta.dirname, "../..");
  const container = `imageshow-final-db-${randomUUID()}`;
  const redisContainer = `imageshow-final-redis-${randomUUID()}`;
  const password = `contract-${randomUUID()}`;
  let helperRoot: string | null = null;
  let helperRootPromise: Promise<string> | null = null;
  let helperRemoved = false;
  let containerAttempted = false;
  let redisContainerAttempted = false;
  let cleanupPromise: Promise<void> | null = null;
  let handlingSignal = false;
  const processResultText = (result: ProcessResult) => (
    `${result.stderr}\n${result.stdout}`.trim()
  );
  const processNotFound = (result: ProcessResult) => (
    /no such container|not found/i.test(processResultText(result))
  );
  const performResourceCleanup = async () => {
    const errors: unknown[] = [];
    if (containerAttempted) {
      try {
        const removed = await runProcess("docker", ["rm", "--force", container], {
          allowDuringInterrupt: true,
          allowFailure: true,
          timeoutMs: 30_000
        });
        if (removed.code !== 0 && !processNotFound(removed)) {
          throw new Error(
            `无法删除隔离 PostgreSQL 容器 ${container}: ${processResultText(removed)}`
          );
        }
        const inspected = await runProcess(
          "docker",
          ["container", "inspect", container],
          {
            allowDuringInterrupt: true,
            allowFailure: true,
            timeoutMs: 15_000
          }
        );
        if (inspected.code === 0 || !processNotFound(inspected)) {
          throw new Error(
            `无法证明隔离 PostgreSQL 容器 ${container} 已删除: ${processResultText(inspected)}`
          );
        }
        containerAttempted = false;
      } catch (error) {
        errors.push(error);
      }
    }
    if (redisContainerAttempted) {
      try {
        const removed = await runProcess(
          "docker",
          ["rm", "--force", redisContainer],
          {
            allowDuringInterrupt: true,
            allowFailure: true,
            timeoutMs: 30_000
          }
        );
        if (removed.code !== 0 && !processNotFound(removed)) {
          throw new Error(
            `无法删除隔离 Redis 容器 ${redisContainer}: ${processResultText(removed)}`
          );
        }
        const inspected = await runProcess(
          "docker",
          ["container", "inspect", redisContainer],
          {
            allowDuringInterrupt: true,
            allowFailure: true,
            timeoutMs: 15_000
          }
        );
        if (inspected.code === 0 || !processNotFound(inspected)) {
          throw new Error(
            `无法证明隔离 Redis 容器 ${redisContainer} 已删除: ${processResultText(inspected)}`
          );
        }
        redisContainerAttempted = false;
      } catch (error) {
        errors.push(error);
      }
    }
    if (helperRootPromise && !helperRemoved) {
      try {
        helperRoot = await helperRootPromise;
        await rm(helperRoot, { recursive: true, force: true });
        helperRemoved = true;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "数据库契约测试资源清理失败");
    }
  };
  const cleanupResources = () => {
    cleanupPromise ??= (async () => {
      const terminationErrors: unknown[] = [];
      try {
        await terminateActiveTestProcesses();
      } catch (error) {
        terminationErrors.push(error);
      }
      let lastCleanupErrors: unknown[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await performResourceCleanup();
          lastCleanupErrors = [];
        } catch (error) {
          lastCleanupErrors = [error];
        }
        const resourcesConverged = !containerAttempted
          && !redisContainerAttempted
          && (!helperRootPromise || helperRemoved);
        if (resourcesConverged) {
          if (terminationErrors.length > 0) {
            throw new AggregateError(
              terminationErrors,
              "数据库契约测试进程终止失败"
            );
          }
          return;
        }
        if (attempt === 0) await delay(250);
      }
      throw new AggregateError(
        [...terminationErrors, ...lastCleanupErrors],
        "数据库契约测试资源清理在有界重试后仍失败"
      );
    })();
    return cleanupPromise;
  };
  const handleTestSignal = (signal: "SIGINT" | "SIGTERM") => {
    if (handlingSignal) return;
    handlingSignal = true;
    activeTestInterruption = signal;
    void cleanupResources().then(
      () => process.exit(signal === "SIGINT" ? 130 : 143),
      (error) => {
        console.error("数据库契约测试中断清理失败:", error);
        process.exit(1);
      }
    );
  };
  const onSigInt = () => handleTestSignal("SIGINT");
  const onSigTerm = () => handleTestSignal("SIGTERM");
  const onShutdownMessage = (message: unknown) => {
    if (
      typeof message === "object"
      && message !== null
      && "type" in message
      && message.type === "imageshow:shutdown"
      && "signal" in message
      && (message.signal === "SIGINT" || message.signal === "SIGTERM")
    ) {
      handleTestSignal(message.signal);
    }
  };
  const inheritedSignalListeners = {
    SIGINT: process.listeners("SIGINT"),
    SIGTERM: process.listeners("SIGTERM")
  };
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);
  process.on("message", onShutdownMessage);
  const onTestAbort = () => handleTestSignal("SIGTERM");
  context.signal.addEventListener("abort", onTestAbort, { once: true });
  const restoreSignalListeners = () => {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    process.off("message", onShutdownMessage);
    context.signal.removeEventListener("abort", onTestAbort);
    for (const listener of inheritedSignalListeners.SIGINT) {
      process.on("SIGINT", listener);
    }
    for (const listener of inheritedSignalListeners.SIGTERM) {
      process.on("SIGTERM", listener);
    }
  };
  const failHelperSetup = async (error: unknown): Promise<never> => {
    let cleanupError: unknown;
    try {
      await cleanupResources();
    } catch (caught) {
      cleanupError = caught;
    } finally {
      restoreSignalListeners();
    }
    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "数据库契约测试 helper 初始化及清理均失败"
      );
    }
    throw error;
  };
  const writeHelperFile = async (path: string, contents: string) => {
    if (activeTestInterruption) {
      await failHelperSetup(new Error(
        `helper write refused after ${activeTestInterruption}`
      ));
    }
    try {
      await writeFile(path, contents, "utf8");
    } catch (error) {
      await failHelperSetup(error);
    }
  };

  try {
    helperRootPromise = createTestDirectory("imageshow-final-db-");
    helperRoot = await helperRootPromise;
  } catch (error) {
    await failHelperSetup(error);
  }
  if (!helperRoot) {
    await failHelperSetup(new Error("数据库契约测试 helper 目录未创建"));
  }

  const helper = join(helperRoot, "initialize-schema.mts");
  const faultHelper = join(helperRoot, "storage-faults.mts");
  const coldRedisHelper = join(helperRoot, "cold-redis.mts");
  const databasePoolsModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/core/database/pools.ts"
  )).href;
  const databaseSchemaModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/core/database/schema.ts"
  )).href;
  const adminBootstrapModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/users/admin-bootstrap.ts"
  )).href;
  const databaseAdvisoryLocksModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/core/database/advisory-locks.ts"
  )).href;
  await writeHelperFile(helper, `
const [host, port, name, user, password] = process.argv.slice(2);
const databasePools = await import(${JSON.stringify(databasePoolsModule)});
databasePools.configureDatabasePools({
  host,
  port: Number(port),
  name,
  user,
  password
});
const databaseSchema = await import(${JSON.stringify(databaseSchemaModule)});
let maximumConcurrentQueries = 0;
databasePools.pool.on("connect", (client) => {
  const query = client.query.bind(client);
  let activeQueries = 0;
  client.query = async (...args) => {
    maximumConcurrentQueries = Math.max(maximumConcurrentQueries, ++activeQueries);
    try { return await query(...args); }
    finally { activeQueries--; }
  };
});
try {
  await databaseSchema.initializeDatabaseSchema();
  if (maximumConcurrentQueries !== 1) {
    throw new Error("startup must execute one SQL query at a time per client: " + maximumConcurrentQueries);
  }
} finally {
  await databasePools.closeDatabasePools();
}
`);
  const maintenanceLockModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/storage/maintenance-lock.ts"
  )).href;
  const moveCleanupModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/storage/cleanup/service.ts"
  )).href;
  const moveCleanupJobModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/storage/cleanup/job.ts"
  )).href;
  const jobRepositoryModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/jobs/repository.ts"
  )).href;
  const backendRegistryModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/storage/backends/registry.ts"
  )).href;
  const backendUpdateModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/storage/backends/update.ts"
  )).href;
  const publicUrlsModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/storage/objects/public-urls.ts"
  )).href;
  const imagePathsModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/storage/objects/image-paths.ts"
  )).href;
  const localBackendModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/storage/drivers/local.ts"
  )).href;
  const s3BackendModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/storage/drivers/s3.ts"
  )).href;
  const keyListingModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/storage/objects/key-listing.ts"
  )).href;
  const runtimeConfigStoreModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/config/runtime-config-store.ts"
  )).href;
  const configPackageModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/config/config-package.ts"
  )).href;
  const loggerModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/core/logger.ts"
  )).href;
  const advancedConfigRoutesModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/routes/advanced-config.ts"
  )).href;
  const authRoutesModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/routes/auth.ts"
  )).href;
  const adminSessionModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/users/admin-session.ts"
  )).href;
  const adminSessionKeyModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/users/admin-session-key.ts"
  )).href;
  const requestBodyLimitModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/core/http/request-body-limit.ts"
  )).href;
  const httpResponsesModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/core/http/responses.ts"
  )).href;
  const honoModule = pathToFileURL(resolve(
    workspace,
    "node_modules/hono/dist/index.js"
  )).href;
  const storageCheckModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/checks/storage-check.ts"
  )).href;
  const storageMaintenanceModule = import.meta.resolve(
    "../../packages/server/src/checks/storage-maintenance.ts"
  );
  const storageThumbnailRepairModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/checks/storage-thumbnail-repair.ts"
  )).href;
  const objectTransferModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/storage/objects/transfer.ts"
  )).href;
  const objectAccessModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/storage/objects/access.ts"
  )).href;
  const storageMigrationModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/storage-location/image-migration.ts"
  )).href;
  const storageMigrationAdmissionModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/storage/objects/image-transfer-admission.ts"
  )).href;
  const imageStorageMigrationModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/storage-location/selected-images-migration.ts"
  )).href;
  const backendMigrationModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/storage-location/storage-backend-migration.ts"
  )).href;
  const trashModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/trash-purge.ts"
  )).href;
  const trashMutationsModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/trash-mutations.ts"
  )).href;
  const trashMembershipLockModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/trash-membership-lock.ts"
  )).href;
  const trashPurgeJobModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/trash-purge-job.ts"
  )).href;
  const trashPurgeMaintenanceModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/trash-purge-maintenance.ts"
  )).href;
  const databaseCheckModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/checks/database-check.ts"
  )).href;
  const imageUpdateModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/image-update.ts"
  )).href;
  const sharedAppConfigModule = pathToFileURL(resolve(
    workspace,
    "packages/shared/dist/app-config.js"
  )).href;
  const redisClientModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/core/redis/client.ts"
  )).href;
  const redisWindowLimitModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/core/redis/window-limit.ts"
  )).href;
  const readyCacheRedisClientModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ready-cache/redis/client.ts"
  )).href;
  const runtimeAvailabilityModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/core/runtime-availability.ts"
  )).href;
  const readyCacheCoordinatorModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ready-cache/coordinator.ts"
  )).href;
  const readyCacheMetaModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ready-cache/meta.ts"
  )).href;
  const readyCacheAdminStatusModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ready-cache/admin-status.ts"
  )).href;
  const ingestionSessionRepositoryModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/repository.ts"
  )).href;
  const ingestionSessionViewModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/queue/session-view.ts"
  )).href;
  const ingestionSessionTransitionsModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/sessions/transitions.ts"
  )).href;
  const ingestionSessionCodecModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/sessions/codec.ts"
  )).href;
  const ingestionSessionServiceModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/session-service.ts"
  )).href;
  const ingestionRawUploadModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/raw/upload.ts"
  )).href;
  const ingestionRawPathsModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/raw/paths.ts"
  )).href;
  const ingestionRawFileOperationsModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/raw/files.ts"
  )).href;
  const ingestionRawLeaseRegistryModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/raw/lease-registry.ts"
  )).href;
  const ingestionRawOrphanScannerModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/raw/orphan-scanner.ts"
  )).href;
  const ingestionPrepareSessionModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/workers/prepare-session.ts"
  )).href;
  const normalizationAdmissionModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/normalization-admission.ts"
  )).href;
  const ingestionCancelSessionModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/cancel/coordinator.ts"
  )).href;
  const ingestionOrphanCleanupModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/cleanup/orphans.ts"
  )).href;
  const ingestionCommitIntentModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/commit/intent.ts"
  )).href;
  const ingestionCommitWorkerModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/commit/worker.ts"
  )).href;
  const ingestionCommitCompletionModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/commit/completion.ts"
  )).href;
  const ingestionCommitConflictRecoveryModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/commit/conflict-recovery.ts"
  )).href;
  const apiErrorModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/core/api-error.ts"
  )).href;
  const ingestionIrreversibleCoordinatorModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/execution/irreversible-coordinator.ts"
  )).href;
  const ingestionTokenServiceModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/sessions/token-service.ts"
  )).href;
  const ingestionActionScopeModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/queue/action-scope.ts"
  )).href;
  const ingestionActionProtocolModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/queue/action-protocol.ts"
  )).href;
  const ingestionQueueSnapshotModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/queue/snapshot.ts"
  )).href;
  const ingestionQueueActionModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/queue/action.ts"
  )).href;
  const ingestionQueueActionHandlersModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/queue/action-handlers.ts"
  )).href;
  const ingestionSessionUpdateModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/queue/session-update.ts"
  )).href;
  const ingestionDuplicatesReadModelModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/read-models/duplicates.ts"
  )).href;
  const ingestionSessionIdentityModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/sessions/identity.ts"
  )).href;
  const ingestionSessionProjectionModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/sessions/projection.ts"
  )).href;
  const ingestionSessionKeysModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/sessions/keys.ts"
  )).href;
  const ingestionStagingKeysModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ingestion/staging-keys.ts"
  )).href;
  const coreUuidModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/core/uuid.ts"
  )).href;
  const imageTimeModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/image-time.ts"
  )).href;
  const adminImagesReadModelModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/read-models/admin-images.ts"
  )).href;
  const publicImagesReadModelModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/read-models/public-images.ts"
  )).href;
  const imageFilterPlanModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/filter-plan.ts"
  )).href;
  const readyCacheFilterIndexModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ready-cache/indexes/filter.ts"
  )).href;
  const readyCacheOrderedWindowModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ready-cache/ordered-window.ts"
  )).href;
  const readyCacheKeysModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/images/ready-cache/keys.ts"
  )).href;
  const redisInspectModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/checks/redis-inspect.ts"
  )).href;
  const vocabCacheModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/vocab/vocab-cache.ts"
  )).href;
  const authorMutationsModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/authors/mutations.ts"
  )).href;
  const authorQueryModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/authors/query.ts"
  )).href;
  const adminVocabularyRoutesModule = pathToFileURL(resolve(
    workspace,
    "packages/server/src/routes/admin-vocabulary.ts"
  )).href;
  await writeHelperFile(faultHelper, `
import assert from "node:assert/strict";
import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { mkdir, readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

const [
  host,
  port,
  name,
  user,
  password,
  dataDirectory,
  redisHost,
  redisPort
] = process.argv.slice(2);
Object.assign(process.env, {
  DATABASE_HOST: host,
  DATABASE_PORT: port,
  DATABASE_NAME: name,
  DATABASE_USER: user,
  DATABASE_PASSWORD: password,
  IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY: dataDirectory,
  REDIS_HOST: redisHost,
  REDIS_PORT: redisPort,
  INGESTION_MAX_FILE_SIZE_MB: "0.001"
});

const databasePools = await import(${JSON.stringify(databasePoolsModule)});
databasePools.configureDatabasePools({
  host,
  port: Number(port),
  name,
  user,
  password
});
const database = {
  ...databasePools,
  ...await import(${JSON.stringify(databaseAdvisoryLocksModule)})
};
const adminBootstrap = await import(${JSON.stringify(adminBootstrapModule)});
const locks = await import(${JSON.stringify(maintenanceLockModule)});
const cleanup = await import(${JSON.stringify(moveCleanupModule)});
const cleanupJob = await import(${JSON.stringify(moveCleanupJobModule)});
const jobs = await import(${JSON.stringify(jobRepositoryModule)});
const registry = await import(${JSON.stringify(backendRegistryModule)});
const backendUpdate = await import(${JSON.stringify(backendUpdateModule)});
const publicUrls = await import(${JSON.stringify(publicUrlsModule)});
const imagePaths = await import(${JSON.stringify(imagePathsModule)});
const { LocalBackend } = await import(${JSON.stringify(localBackendModule)});
const { S3Backend } = await import(${JSON.stringify(s3BackendModule)});
const keyListing = await import(${JSON.stringify(keyListingModule)});
const runtimeConfigStore = await import(${JSON.stringify(runtimeConfigStoreModule)});
const configPackage = await import(${JSON.stringify(configPackageModule)});
const coreLogger = await import(${JSON.stringify(loggerModule)});
const advancedConfigRoutes = await import(${JSON.stringify(advancedConfigRoutesModule)});
const authRoutes = await import(${JSON.stringify(authRoutesModule)});
const adminSession = await import(${JSON.stringify(adminSessionModule)});
const { adminSessionKey } = await import(${JSON.stringify(adminSessionKeyModule)});
const requestBodyLimit = await import(${JSON.stringify(requestBodyLimitModule)});
const httpResponses = await import(${JSON.stringify(httpResponsesModule)});
const storageCheck = await import(${JSON.stringify(storageCheckModule)});
const storageMaintenance = await import(${JSON.stringify(storageMaintenanceModule)});
const storageThumbnailRepair = await import(
  ${JSON.stringify(storageThumbnailRepairModule)}
);
const objectTransfer = await import(${JSON.stringify(objectTransferModule)});
const objectAccess = await import(${JSON.stringify(objectAccessModule)});
const storageMigration = await import(${JSON.stringify(storageMigrationModule)});
const storageMigrationAdmission = await import(
  ${JSON.stringify(storageMigrationAdmissionModule)}
);
const imageStorageMigration = await import(${JSON.stringify(imageStorageMigrationModule)});
const backendMigration = await import(${JSON.stringify(backendMigrationModule)});
const trash = await import(${JSON.stringify(trashModule)});
const trashMutations = await import(${JSON.stringify(trashMutationsModule)});
const trashMembershipLock = await import(${JSON.stringify(trashMembershipLockModule)});
const trashPurgeJob = await import(${JSON.stringify(trashPurgeJobModule)});
const trashPurgeMaintenance = await import(${JSON.stringify(trashPurgeMaintenanceModule)});
const databaseCheck = await import(${JSON.stringify(databaseCheckModule)});
  const imageUpdate = await import(${JSON.stringify(imageUpdateModule)});
const sharedAppConfig = await import(${JSON.stringify(sharedAppConfigModule)});
const redisClient = await import(${JSON.stringify(redisClientModule)});
const redisWindowLimit = await import(${JSON.stringify(redisWindowLimitModule)});
const readyCacheRedisClient = await import(
  ${JSON.stringify(readyCacheRedisClientModule)}
);
const runtimeAvailability = await import(${JSON.stringify(runtimeAvailabilityModule)});
const readyCacheCoordinator = await import(${JSON.stringify(readyCacheCoordinatorModule)});
const readyCacheMeta = await import(${JSON.stringify(readyCacheMetaModule)});
const readyCacheAdminStatus = await import(${JSON.stringify(readyCacheAdminStatusModule)});
const ingestionSessionRepository = await import(
  ${JSON.stringify(ingestionSessionRepositoryModule)}
);
const ingestionSessionView = await import(${JSON.stringify(ingestionSessionViewModule)});
const ingestionSessionTransitions = await import(
  ${JSON.stringify(ingestionSessionTransitionsModule)}
);
const ingestionSessionCodec = await import(${JSON.stringify(ingestionSessionCodecModule)});
const ingestionSessionService = await import(${JSON.stringify(ingestionSessionServiceModule)});
const ingestionRawUpload = await import(${JSON.stringify(ingestionRawUploadModule)});
const ingestionRawFiles = {
  ...await import(${JSON.stringify(ingestionRawPathsModule)}),
  ...await import(${JSON.stringify(ingestionRawFileOperationsModule)}),
  ...await import(${JSON.stringify(ingestionRawLeaseRegistryModule)}),
  ...await import(${JSON.stringify(ingestionRawOrphanScannerModule)})
};
const ingestionPrepareSession = await import(
  ${JSON.stringify(ingestionPrepareSessionModule)}
);
const normalizationAdmission = await import(
  ${JSON.stringify(normalizationAdmissionModule)}
);
const ingestionCancelSession = await import(
  ${JSON.stringify(ingestionCancelSessionModule)}
);
const ingestionOrphanCleanup = await import(${JSON.stringify(ingestionOrphanCleanupModule)});
const ingestionCommitIntent = await import(${JSON.stringify(ingestionCommitIntentModule)});
const ingestionCommitWorker = await import(${JSON.stringify(ingestionCommitWorkerModule)});
const ingestionCommitCompletion = await import(
  ${JSON.stringify(ingestionCommitCompletionModule)}
);
const ingestionCommitConflictRecovery = await import(
  ${JSON.stringify(ingestionCommitConflictRecoveryModule)}
);
const apiError = await import(${JSON.stringify(apiErrorModule)});
const ingestionIrreversibleCoordinator = await import(
  ${JSON.stringify(ingestionIrreversibleCoordinatorModule)}
);
const ingestionTokenService = await import(${JSON.stringify(ingestionTokenServiceModule)});
const ingestionActionScope = await import(${JSON.stringify(ingestionActionScopeModule)});
const ingestionActionProtocol = await import(${JSON.stringify(ingestionActionProtocolModule)});
const ingestionQueueSnapshot = await import(${JSON.stringify(ingestionQueueSnapshotModule)});
const ingestionQueueAction = await import(${JSON.stringify(ingestionQueueActionModule)});
const ingestionQueueActionHandlers = await import(
  ${JSON.stringify(ingestionQueueActionHandlersModule)}
);
const ingestionSessionUpdate = await import(${JSON.stringify(ingestionSessionUpdateModule)});
const ingestionDuplicatesReadModel = await import(
  ${JSON.stringify(ingestionDuplicatesReadModelModule)}
);
const ingestionSessionIdentity = await import(${JSON.stringify(ingestionSessionIdentityModule)});
const ingestionSessionProjection = await import(
  ${JSON.stringify(ingestionSessionProjectionModule)}
);
const ingestionSessionKeys = await import(${JSON.stringify(ingestionSessionKeysModule)});
const ingestionStagingKeys = await import(${JSON.stringify(ingestionStagingKeysModule)});
const coreUuid = await import(${JSON.stringify(coreUuidModule)});
const imageTime = await import(${JSON.stringify(imageTimeModule)});
const adminImagesReadModel = await import(${JSON.stringify(adminImagesReadModelModule)});
const publicImagesReadModel = await import(${JSON.stringify(publicImagesReadModelModule)});
const imageFilterPlan = await import(${JSON.stringify(imageFilterPlanModule)});
const readyCacheFilterIndex = await import(${JSON.stringify(readyCacheFilterIndexModule)});
const readyCacheOrderedWindow = await import(${JSON.stringify(readyCacheOrderedWindowModule)});
const readyCacheKeys = await import(${JSON.stringify(readyCacheKeysModule)});
const redisInspect = await import(${JSON.stringify(redisInspectModule)});
const vocabCache = await import(${JSON.stringify(vocabCacheModule)});
const authorMutations = await import(${JSON.stringify(authorMutationsModule)});
const authorQuery = await import(${JSON.stringify(authorQueryModule)});
const adminVocabularyRoutes = await import(
  ${JSON.stringify(adminVocabularyRoutesModule)}
);
const { Hono } = await import(${JSON.stringify(honoModule)});

async function removeDriverObject(driver, prefix, key) {
  const [result] = await driver.removeObjects([{ prefix, key }]);
  assert.ok(
    result?.status === "removed" || result?.status === "missing",
    "test fixture storage object must be removed"
  );
}
runtimeConfigStore.initializeRuntimeConfig();
assert.equal(await adminBootstrap.ensureSuperAdmin({
  username: "bootstrap-admin",
  password: "BootstrapAdmin123!"
}), true);
assert.equal(await adminBootstrap.ensureSuperAdmin({}), false);
const bootstrapAdmins = await database.pool.query(
  "SELECT username FROM admin_account WHERE role='super' ORDER BY username"
);
assert.deepEqual(
  bootstrapAdmins.rows.map((row) => row.username),
  ["bootstrap-admin"]
);

const authorAdminApi = "/api/admin";
const authorRouteCsrf = "author-route-csrf";
const vocabularyApp = new Hono();
vocabularyApp.onError((error, context) => (
  httpResponses.handleApiError(context, error)
));
vocabularyApp.use(authorAdminApi + "/*", async (context, next) => {
  const role = context.req.header("x-test-role");
  if (role !== "super" && role !== "image") {
    throw new apiError.ApiError(401, "unauthorized", "Authentication required");
  }
  context.set("session", {
    id: "author-route-session",
    username: "route-admin",
    role,
    csrf: authorRouteCsrf
  });
  await next();
});
vocabularyApp.use(authorAdminApi + "/*", async (context, next) => {
  if (context.req.method !== "GET") {
    return adminSession.requireAdminCsrf(context, next);
  }
  await next();
});
adminVocabularyRoutes.registerAdminVocabularyRoutes(vocabularyApp);
const authorRouteRequest = (path, {
  method = "GET",
  role,
  body
} = {}) => vocabularyApp.request(new Request(
  "http://imageshow.test" + authorAdminApi + "/authors" + path,
  {
    method,
    headers: {
      "content-type": "application/json",
      ...(role ? {
        "x-test-role": role,
        "x-csrf-token": authorRouteCsrf
      } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }
));

const unauthenticatedAuthors = await authorRouteRequest("");
assert.equal(unauthenticatedAuthors.status, 401);
assert.equal((await unauthenticatedAuthors.json()).code, "unauthorized");
const createdBySuperResponse = await authorRouteRequest("", {
  method: "POST",
  role: "super",
  body: {
    slug: "identity-route-super",
    display_name: "Identity Super",
    link: "https://weibo.com/u/4444444444"
  }
});
assert.equal(
  createdBySuperResponse.status,
  200,
  await createdBySuperResponse.clone().text()
);
const createdBySuper = await createdBySuperResponse.json();
assert.deepEqual(createdBySuper.item, {
  slug: "identity-route-super",
  display_name: "Identity Super",
  link: "https://weibo.com/u/4444444444",
  image_count: 0,
  derived_identity: { provider: "weibo", id: "4444444444" }
});
const createdByImageResponse = await authorRouteRequest("", {
  method: "POST",
  role: "image",
  body: {
    slug: "identity-route-image",
    display_name: "Identity Image",
    link: "https://example.com/author/image"
  }
});
assert.equal(
  createdByImageResponse.status,
  200,
  await createdByImageResponse.clone().text()
);
assert.equal((await createdByImageResponse.json()).item.derived_identity, null);

const internalFieldAttempt = await authorRouteRequest("", {
  method: "POST",
  role: "image",
  body: {
    slug: "identity-route-internal-field",
    display_name: "Rejected",
    link: "https://weibo.com/u/6666666666",
    identity_provider: "weibo",
    identity_id: "6666666666"
  }
});
assert.equal(internalFieldAttempt.status, 400);

const conflictingUpdate = await authorRouteRequest("/identity-route-image", {
  method: "POST",
  role: "image",
  body: {
    display_name: "Must Roll Back",
    link: "https://weibo.com/u/4444444444"
  }
});
const conflictingUpdateText = await conflictingUpdate.text();
assert.equal(conflictingUpdate.status, 409);
assert.match(conflictingUpdateText, /author_identity_exists/);
assert.doesNotMatch(
  conflictingUpdateText,
  /identity_provider|identity_id|derived_identity|4444444444/
);
const unchangedAfterConflict = (await database.pool.query(
  "SELECT display_name, link, identity_provider, identity_id FROM author WHERE slug=$1",
  ["identity-route-image"]
)).rows[0];
assert.deepEqual(unchangedAfterConflict, {
  display_name: "Identity Image",
  link: "https://example.com/author/image",
  identity_provider: null,
  identity_id: null
});

const clearedByImageResponse = await authorRouteRequest("/identity-route-super", {
  method: "POST",
  role: "image",
  body: {
    display_name: "Identity Super Cleared",
    link: "https://example.com/author/super"
  }
});
assert.equal(
  clearedByImageResponse.status,
  200,
  await clearedByImageResponse.clone().text()
);
assert.equal((await clearedByImageResponse.json()).item.derived_identity, null);
const reboundBySuperResponse = await authorRouteRequest("/identity-route-image", {
  method: "POST",
  role: "super",
  body: {
    display_name: "Identity Image Rebound",
    link: "https://weibo.com/u/5555555555"
  }
});
assert.equal(
  reboundBySuperResponse.status,
  200,
  await reboundBySuperResponse.clone().text()
);
const reboundBySuper = await reboundBySuperResponse.json();
assert.deepEqual(reboundBySuper.item.derived_identity, {
  provider: "weibo",
  id: "5555555555"
});
assert.equal(reboundBySuper.item.link, "https://weibo.com/u/5555555555");

const originalPoolQuery = database.pool.query;
let authorIdentityQueryCount = 0;
database.pool.query = function (query, ...parameters) {
  if (
    typeof query === "string"
    && query.includes("identity_provider='weibo'")
    && query.includes("identity_id=ANY")
  ) {
    authorIdentityQueryCount += 1;
  }
  return originalPoolQuery.call(this, query, ...parameters);
};
let resolvedAuthors;
try {
  resolvedAuthors = await authorQuery.resolveWeiboAuthorSlugs([
    "5555555555",
    "7777777777",
    "5555555555",
    "invalid"
  ]);
} finally {
  database.pool.query = originalPoolQuery;
}
assert.equal(authorIdentityQueryCount, 1);
assert.deepEqual([...resolvedAuthors], [["5555555555", "identity-route-image"]]);

const adminAuthorListResponse = await authorRouteRequest("", { role: "image" });
assert.equal(adminAuthorListResponse.status, 200);
const adminAuthorList = await adminAuthorListResponse.json();
assert.deepEqual(
  adminAuthorList.items.find((item) => item.slug === "identity-route-image")
    .derived_identity,
  { provider: "weibo", id: "5555555555" }
);
const adminAuthorJson = JSON.stringify(adminAuthorList);
assert.doesNotMatch(adminAuthorJson, /identity_provider|identity_id/);
const publicAuthorVocabulary = await vocabCache.getAuthorVocab();
const ingestionVocabulary = await vocabCache.getIngestionVocabulary();
for (const value of [publicAuthorVocabulary, ingestionVocabulary]) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(
    serialized,
    /identity_provider|identity_id|derived_identity/
  );
}
await authorMutations.deleteAuthor("identity-route-super");
await authorMutations.deleteAuthor("identity-route-image");

const readReadyRevision = async () => BigInt(String((
  await database.pool.query(
    "SELECT revision::text FROM ready_image_revision WHERE singleton=1"
  )
).rows[0].revision));

try {
  const baselineRuntimeConfig = structuredClone(
    runtimeConfigStore.getRuntimeConfig()
  );
  const packageBackend = (slug, secret) => ({
    slug,
    display_name: slug,
    enabled: true,
    is_default: false,
    s3: {
      endpoint: "objects.example.com",
      bucket: "gallery",
      access_key_id: slug + "-key",
      secret_access_key: secret
    }
  });
  const packageInput = (slug, siteName, secret) => ({
    format: "future-format-is-only-a-hint",
    application_version: "99.0.0",
    exported_at: "2026-08-30T00:00:00.000Z",
    config: {
      site: { name: siteName },
    },
    storage_backends: [packageBackend(slug, secret)]
  });
  const deletePackageBackend = async (slug) => {
    await database.pool.query(
      "DELETE FROM storage_backend WHERE slug=$1",
      [slug]
    );
    registry.invalidateStorageBackendRegistry();
  };
  const backendRow = async (slug) => (await database.pool.query(
    "SELECT slug, config FROM storage_backend WHERE slug=$1",
    [slug]
  )).rows[0] ?? null;
  const configFilePath = join(dataDirectory, "config.json");
  const readPersistedRuntimeConfig = async () => JSON.parse(
    await readFile(configFilePath, "utf8")
  );

  const withCommitFault = async (
    mode,
    work,
    { beforeCommit = async () => undefined } = {}
  ) => {
    const originalPoolConnect = database.pool.connect;
    const originalPoolQuery = database.pool.query;
    const patchedClients = new Map();
    database.pool.connect = function (...args) {
      const connection = originalPoolConnect.apply(this, args);
      if (typeof args.at(-1) === "function") return connection;
      return connection.then((client) => {
        const originalQuery = client.query;
        patchedClients.set(client, originalQuery);
        client.query = async function (query, ...parameters) {
          if (query === "COMMIT") {
            await beforeCommit();
            if (mode === "success") {
              return originalQuery.call(this, query, ...parameters);
            }
            if (mode === "committed") {
              await originalQuery.call(this, query, ...parameters);
              throw new Error("controlled commit acknowledgement loss");
            }
            throw mode === "unknown"
              ? new Error("controlled commit outcome unknown")
              : new Error("controlled commit rollback");
          }
          return originalQuery.call(this, query, ...parameters);
        };
        return client;
      });
    };
    if (mode === "unknown") {
      database.pool.query = function (query, ...parameters) {
        if (
          typeof query === "string"
          && query.includes("SELECT pg_xact_status")
        ) {
          throw new Error("controlled outcome inspection failure");
        }
        return originalPoolQuery.call(this, query, ...parameters);
      };
    }
    try {
      return await work();
    } finally {
      database.pool.connect = originalPoolConnect;
      database.pool.query = originalPoolQuery;
      for (const [client, originalQuery] of patchedClients) {
        client.query = originalQuery;
      }
    }
  };

  const observeRuntimeConfigChanges = () => {
    const siteNames = [];
    const remove = runtimeConfigStore.onRuntimeConfigChange(() => {
      siteNames.push(runtimeConfigStore.getRuntimeConfig().site.name);
    });
    return { siteNames, remove };
  };

  await runtimeConfigStore.updateRuntimeConfig({
    site: { description: "must be replaced by target defaults" }
  });
  const successChanges = observeRuntimeConfigChanges();
  let successBeforeCommit = null;
  try {
    await withCommitFault("success", () => (
      configPackage.importConfigPackage(
        packageInput("package-success", "Imported Success", "success-secret"),
        {}
      )
    ), {
      beforeCommit: async () => {
        successBeforeCommit = {
          memory: runtimeConfigStore.getRuntimeConfig().site.name,
          listener_count: successChanges.siteNames.length,
          file: (await readPersistedRuntimeConfig()).site.name
        };
      }
    });
  } finally {
    successChanges.remove();
  }
  assert.deepEqual(successBeforeCommit, {
    memory: baselineRuntimeConfig.site.name,
    listener_count: 0,
    file: "Imported Success"
  });
  assert.deepEqual(successChanges.siteNames, ["Imported Success"]);
  const successfulRuntimeConfig = runtimeConfigStore.getRuntimeConfig();
  assert.equal(successfulRuntimeConfig.site.name, "Imported Success");
  assert.equal(
    successfulRuntimeConfig.site.domain,
    baselineRuntimeConfig.site.domain,
    "配置包不得覆盖目标部署域名"
  );
  assert.equal(
    successfulRuntimeConfig.site.description,
    baselineRuntimeConfig.site.description,
    "缺失字段必须完整替换为目标版本默认值"
  );
  assert.equal(
    (await backendRow("package-success"))?.config.secret_access_key,
    "success-secret",
    "配置包凭据必须在同一 PostgreSQL 事务中正式入库"
  );
  await deletePackageBackend("package-success");
  await runtimeConfigStore.replaceRuntimeConfig(baselineRuntimeConfig);

  const fileFailureChanges = observeRuntimeConfigChanges();
  const originalOpenSync = fs.openSync;
  let fileFailureInjected = false;
  fs.openSync = (...args) => {
    if (
      !fileFailureInjected
      && String(args[0]).endsWith(".tmp")
    ) {
      fileFailureInjected = true;
      throw new Error("controlled runtime config file write failure");
    }
    return originalOpenSync(...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(configPackage.importConfigPackage(
      packageInput("package-file-failure", "File Failure", "file-failure-secret"),
      {}
    ), /controlled runtime config file write failure/);
  } finally {
    fileFailureChanges.remove();
    fs.openSync = originalOpenSync;
    syncBuiltinESMExports();
  }
  assert.equal(fileFailureInjected, true);
  assert.deepEqual(fileFailureChanges.siteNames, []);
  assert.deepEqual(runtimeConfigStore.getRuntimeConfig(), baselineRuntimeConfig);
  assert.deepEqual(await readPersistedRuntimeConfig(), baselineRuntimeConfig);
  assert.equal(await backendRow("package-file-failure"), null);

  const postRenameFailureChanges = observeRuntimeConfigChanges();
  const originalRenameSync = fs.renameSync;
  let postRenameFailureInjected = false;
  fs.renameSync = (...args) => {
    const result = originalRenameSync(...args);
    if (
      !postRenameFailureInjected
      && String(args[1]) === configFilePath
    ) {
      postRenameFailureInjected = true;
      throw new Error("controlled post-rename config durability failure");
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(configPackage.importConfigPackage(
      packageInput(
        "package-post-rename-failure",
        "Post Rename Failure",
        "post-rename-secret"
      ),
      {}
    ), /controlled post-rename config durability failure/);
  } finally {
    postRenameFailureChanges.remove();
    fs.renameSync = originalRenameSync;
    syncBuiltinESMExports();
  }
  assert.equal(postRenameFailureInjected, true);
  assert.deepEqual(postRenameFailureChanges.siteNames, []);
  assert.deepEqual(runtimeConfigStore.getRuntimeConfig(), baselineRuntimeConfig);
  assert.deepEqual(await readPersistedRuntimeConfig(), baselineRuntimeConfig);
  assert.equal(await backendRow("package-post-rename-failure"), null);

  const rollbackChanges = observeRuntimeConfigChanges();
  let rollbackBeforeCommit = null;
  try {
    await assert.rejects(withCommitFault("rolled_back", () => (
      configPackage.importConfigPackage(
        packageInput("package-rollback", "Rolled Back", "rollback-secret"),
        {}
      )
    ), {
      beforeCommit: async () => {
        rollbackBeforeCommit = {
          memory: runtimeConfigStore.getRuntimeConfig().site.name,
          listener_count: rollbackChanges.siteNames.length,
          file: (await readPersistedRuntimeConfig()).site.name
        };
      }
    }), /controlled commit rollback/);
  } finally {
    rollbackChanges.remove();
  }
  assert.deepEqual(rollbackBeforeCommit, {
    memory: baselineRuntimeConfig.site.name,
    listener_count: 0,
    file: "Rolled Back"
  });
  assert.deepEqual(rollbackChanges.siteNames, []);
  assert.deepEqual(
    runtimeConfigStore.getRuntimeConfig(),
    baselineRuntimeConfig,
    "PostgreSQL 已回滚时内存配置必须保持未变化"
  );
  assert.deepEqual(await readPersistedRuntimeConfig(), baselineRuntimeConfig);
  assert.equal(await backendRow("package-rollback"), null);

  const committedChanges = observeRuntimeConfigChanges();
  let committedBeforeCommit = null;
  try {
    await withCommitFault("committed", () => (
      configPackage.importConfigPackage(
        packageInput(
          "package-committed",
          "Committed Acknowledgement Lost",
          "committed-secret"
        ),
        {}
      )
    ), {
      beforeCommit: async () => {
        committedBeforeCommit = {
          memory: runtimeConfigStore.getRuntimeConfig().site.name,
          listener_count: committedChanges.siteNames.length
        };
      }
    });
  } finally {
    committedChanges.remove();
  }
  assert.deepEqual(committedBeforeCommit, {
    memory: baselineRuntimeConfig.site.name,
    listener_count: 0
  });
  assert.deepEqual(committedChanges.siteNames, [
    "Committed Acknowledgement Lost"
  ]);
  assert.equal(
    runtimeConfigStore.getRuntimeConfig().site.name,
    "Committed Acknowledgement Lost",
    "PostgreSQL 已提交但回执丢失时必须按成功收敛并发布"
  );
  assert.equal(
    (await backendRow("package-committed"))?.config.secret_access_key,
    "committed-secret"
  );
  await deletePackageBackend("package-committed");
  await runtimeConfigStore.replaceRuntimeConfig(baselineRuntimeConfig);

  const unknownChanges = observeRuntimeConfigChanges();
  const unknownLogs = [];
  const originalLoggerError = coreLogger.logger.error;
  coreLogger.logger.error = (message, context) => {
    unknownLogs.push({ message, context });
  };
  try {
    await assert.rejects(withCommitFault("unknown", () => (
      configPackage.importConfigPackage(
        packageInput("package-unknown", "Outcome Unknown", "unknown-secret"),
        {}
      )
    )), (error) => (
      error instanceof apiError.ApiError
      && error.status === 503
      && error.code === "config_package_outcome_unknown"
      && typeof error.details?.transaction_id === "string"
      && error.details?.original_error === "controlled commit outcome unknown"
    ));
  } finally {
    unknownChanges.remove();
    coreLogger.logger.error = originalLoggerError;
  }
  assert.deepEqual(unknownChanges.siteNames, ["Outcome Unknown"]);
  assert.equal(runtimeConfigStore.getRuntimeConfig().site.name, "Outcome Unknown");
  assert.equal((await readPersistedRuntimeConfig()).site.name, "Outcome Unknown");
  assert.equal(await backendRow("package-unknown"), null);
  assert.ok(unknownLogs.some(({ message, context }) => (
    message === "config_package_outcome_unknown"
    && typeof context?.transaction_id === "string"
    && context?.original_error === "controlled commit outcome unknown"
  )));
  await runtimeConfigStore.replaceRuntimeConfig(baselineRuntimeConfig);

  const restoreFailureChanges = observeRuntimeConfigChanges();
  const restoreFailureLogs = [];
  const restoreFailurePath = configFilePath + ".restore-failure-" + randomUUID();
  let restoreFileMoved = false;
  let restorePathBlocked = false;
  coreLogger.logger.error = (message, context) => {
    restoreFailureLogs.push({ message, context });
  };
  try {
    await assert.rejects(withCommitFault("rolled_back", () => (
      configPackage.importConfigPackage(
        packageInput(
          "package-restore-failure",
          "Restore Failure",
          "restore-failure-secret"
        ),
        {}
      )
    ), {
      beforeCommit: async () => {
        assert.equal(
          runtimeConfigStore.getRuntimeConfig().site.name,
          baselineRuntimeConfig.site.name
        );
        await rename(configFilePath, restoreFailurePath);
        restoreFileMoved = true;
        await mkdir(configFilePath);
        restorePathBlocked = true;
      }
    }), (error) => (
      error instanceof apiError.ApiError
      && error.status === 503
      && error.code === "config_package_file_restore_failed"
      && typeof error.details?.transaction_id === "string"
      && error.details?.original_error === "controlled commit rollback"
      && typeof error.details?.restore_error === "string"
    ));
  } finally {
    restoreFailureChanges.remove();
    coreLogger.logger.error = originalLoggerError;
    if (restorePathBlocked) {
      await rm(configFilePath, { recursive: true, force: true });
    }
    if (restoreFileMoved) {
      await rename(restoreFailurePath, configFilePath);
    }
  }
  assert.deepEqual(restoreFailureChanges.siteNames, []);
  assert.deepEqual(runtimeConfigStore.getRuntimeConfig(), baselineRuntimeConfig);
  assert.equal(await backendRow("package-restore-failure"), null);
  assert.ok(restoreFailureLogs.some(({ message, context }) => (
    message === "config_package_file_restore_failed"
    && typeof context?.transaction_id === "string"
    && context?.original_error === "controlled commit rollback"
    && typeof context?.restore_error === "string"
  )));
  await runtimeConfigStore.replaceRuntimeConfig(baselineRuntimeConfig);

  let signalCommitReached = () => undefined;
  const commitReached = new Promise((resolve) => {
    signalCommitReached = resolve;
  });
  let releaseCommit = () => undefined;
  const commitGate = new Promise((resolve) => {
    releaseCommit = resolve;
  });
  const leaseImport = withCommitFault("success", () => (
    configPackage.importConfigPackage(
      packageInput("package-lease", "Lease Candidate", "lease-secret"),
      {}
    )
  ), {
    beforeCommit: async () => {
      signalCommitReached();
      await commitGate;
    }
  });
  await commitReached;
  assert.equal(runtimeConfigStore.getRuntimeConfig().site.name, baselineRuntimeConfig.site.name);
  assert.equal((await readPersistedRuntimeConfig()).site.name, "Lease Candidate");
  let reloadSettled = false;
  const queuedReload = runtimeConfigStore.reloadRuntimeConfigFromDisk()
    .then(() => {
      reloadSettled = true;
    });
  await delay(25);
  assert.equal(reloadSettled, false, "手动重载必须在配置包写租约后排队");
  assert.equal(runtimeConfigStore.getRuntimeConfig().site.name, baselineRuntimeConfig.site.name);
  releaseCommit();
  await Promise.all([leaseImport, queuedReload]);
  assert.equal(reloadSettled, true);
  assert.equal(runtimeConfigStore.getRuntimeConfig().site.name, "Lease Candidate");
  await deletePackageBackend("package-lease");
  await runtimeConfigStore.replaceRuntimeConfig(baselineRuntimeConfig);

  const isolatedConfig = structuredClone(baselineRuntimeConfig);
  isolatedConfig.site.name = "Listener Isolation";
  const listenerFailureLogs = [];
  let followingListenerCalls = 0;
  coreLogger.logger.error = (message, context) => {
    listenerFailureLogs.push({ message, context });
  };
  const removeFailingListener = runtimeConfigStore.onRuntimeConfigChange(() => {
    throw new Error("controlled runtime config listener failure");
  });
  const removeFollowingListener = runtimeConfigStore.onRuntimeConfigChange(() => {
    followingListenerCalls += 1;
  });
  try {
    await runtimeConfigStore.replaceRuntimeConfig(isolatedConfig);
  } finally {
    removeFailingListener();
    removeFollowingListener();
    coreLogger.logger.error = originalLoggerError;
  }
  assert.equal(followingListenerCalls, 1);
  assert.equal(runtimeConfigStore.getRuntimeConfig().site.name, "Listener Isolation");
  assert.equal((await readPersistedRuntimeConfig()).site.name, "Listener Isolation");
  assert.ok(listenerFailureLogs.some(({ message, context }) => (
    message === "runtime_config_listener_failed"
    && Number.isInteger(context?.listener_index)
    && context?.error === "controlled runtime config listener failure"
  )));
  await runtimeConfigStore.replaceRuntimeConfig(baselineRuntimeConfig);

  const adminApi = "/api/admin";
  const routeCsrf = "advanced-config-route-csrf";
  const advancedApp = new Hono();
  advancedApp.onError((error, context) => (
    httpResponses.handleApiError(context, error)
  ));
  advancedApp.use(adminApi + "/*", async (context, next) => {
    const role = context.req.header("x-test-role");
    if (role === "super" || role === "image") {
      context.set("session", {
        id: "advanced-config-route-session",
        username: "route-admin",
        role,
        csrf: routeCsrf
      });
    }
    await next();
  });
  advancedApp.use(adminApi + "/*", async (context, next) => {
    if (context.req.method !== "GET") {
      return adminSession.requireAdminCsrf(context, next);
    }
    await next();
  });
  advancedApp.use(
    adminApi + "/*",
    requestBodyLimit.limitProtectedAdminRequestBody
  );
  advancedConfigRoutes.registerAdvancedConfigRoutes(advancedApp);
  const routeRequest = (path, {
    method = "GET",
    role = "super",
    csrf = routeCsrf,
    body
  } = {}) => advancedApp.request(new Request(
    "http://imageshow.test" + adminApi + "/advanced-config/" + path,
    {
      method,
      headers: {
        "content-type": "application/json",
        "x-test-role": role,
        ...(csrf ? { "x-csrf-token": csrf } : {})
      },
      body
    }
  ));

  for (const [path, method, body] of [
    ["export", "GET", undefined],
    ["preview", "POST", JSON.stringify({ package: {} })],
    ["import", "POST", JSON.stringify({ package: {}, slug_mappings: {} })]
  ]) {
    const forbidden = await routeRequest(path, {
      method,
      role: "image",
      body
    });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).code, "forbidden");
  }
  for (const path of ["preview", "import"]) {
    const withoutCsrf = await routeRequest(path, {
      method: "POST",
      csrf: "",
      body: JSON.stringify(path === "preview"
        ? { package: {} }
        : { package: {}, slug_mappings: {} })
    });
    assert.equal(withoutCsrf.status, 403);
    assert.equal((await withoutCsrf.json()).code, "csrf_invalid");
  }

  const exported = await routeRequest("export");
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get("cache-control"), "private, no-store");
  const currentManifest = JSON.parse(await readFile(
    ${JSON.stringify(resolve(workspace, "package.json"))}, "utf8"
  ));
  assert.equal((await exported.json()).application_version, currentManifest.version);

  const emptyPackageBytes = Buffer.byteLength(JSON.stringify({ content: "" }));
  const exactPackage = {
    content: "x".repeat(
      sharedAppConfig.appConfig.configPackage.maxBytes - emptyPackageBytes
    )
  };
  assert.equal(
    Buffer.byteLength(JSON.stringify(exactPackage)),
    sharedAppConfig.appConfig.configPackage.maxBytes
  );
  const exactPreview = await routeRequest("preview", {
    method: "POST",
    body: JSON.stringify({ package: exactPackage })
  });
  assert.equal(exactPreview.status, 200, await exactPreview.text());
  const oversizedPreview = await routeRequest("preview", {
    method: "POST",
    body: JSON.stringify({
      package: { content: exactPackage.content + "x" }
    })
  });
  assert.equal(oversizedPreview.status, 413);
  assert.equal(
    (await oversizedPreview.json()).code,
    "config_package_too_large"
  );
  const tooManyBackends = await routeRequest("preview", {
    method: "POST",
    body: JSON.stringify({
      package: {
        storage_backends: Array.from({ length: 101 }, () => null)
      }
    })
  });
  assert.equal(tooManyBackends.status, 400);
  assert.equal((await tooManyBackends.json()).code, "config_package_invalid");

  await configPackage.importConfigPackage(
    packageInput("route-existing", "Route Existing", "route-secret"),
    {}
  );
  await runtimeConfigStore.replaceRuntimeConfig(baselineRuntimeConfig);
  const invalidSlugMapping = await routeRequest("import", {
    method: "POST",
    body: JSON.stringify({
      package: packageInput(
        "route-existing",
        "Must Not Import",
        "must-not-replace"
      ),
      slug_mappings: { "route-existing": "bad_slug" }
    })
  });
  assert.equal(invalidSlugMapping.status, 400);
  assert.equal(
    (await invalidSlugMapping.json()).code,
    "config_slug_mapping_invalid"
  );
  assert.equal(
    (await backendRow("route-existing"))?.config.secret_access_key,
    "route-secret"
  );
  assert.deepEqual(
    runtimeConfigStore.getRuntimeConfig(),
    baselineRuntimeConfig
  );
  await deletePackageBackend("route-existing");

  const importedByRoute = await routeRequest("import", {
    method: "POST",
    body: JSON.stringify({
      package: { config: { site: { name: "Imported Through Route" } } },
      slug_mappings: {}
    })
  });
  assert.equal(importedByRoute.status, 200, await importedByRoute.text());
  assert.equal(
    runtimeConfigStore.getRuntimeConfig().site.name,
    "Imported Through Route"
  );
  await runtimeConfigStore.replaceRuntimeConfig(baselineRuntimeConfig);

  const imageUpdateIds = {
    first: randomUUID(),
    missing: randomUUID(),
    third: randomUUID(),
    fourth: randomUUID()
  };
  for (const [index, id] of [
    imageUpdateIds.first,
    imageUpdateIds.third,
    imageUpdateIds.fourth
  ].entries()) {
    await database.pool.query(
      "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
        + "theme, ext, md5) VALUES ($1, 'bootstrap-admin', 'local', $2, 'pc', 'dark', "
        + "'none', 'webp', $3)",
      [
        id,
        imagePaths.storageObjectKey(id, "webp"),
        String(index + 1).repeat(32)
      ]
    );
  }
  await redisClient.pingRedis();
  const requiredRedisCapabilities = await runtimeAvailability
    .requireOperationalRedis();
  assert.deepEqual(requiredRedisCapabilities.commands, {
    INCREX: true,
    ARRING: true,
    ARLASTITEMS: true,
    SET_IFEQ_KEEPTTL: true,
    DELEX_IFEQ: true
  });

  const ingestionRepository = new ingestionSessionRepository.IngestionSessionRepository(
    redisClient.redis,
    (work) => work()
  );
  const productionIngestionRepository = new (
    ingestionSessionRepository.IngestionSessionRepository
  )(redisClient.redis);
  const serviceNow = Date.parse("2026-08-23T01:02:03.456Z");
  const ingestionDisplayOrderKeys = new Map();
  const displayOrderKey = (sessionId, position, now = serviceNow) => {
    const existing = ingestionDisplayOrderKeys.get(sessionId);
    if (existing) return existing;
    const key = ingestionSessionIdentity.createIngestionDisplayOrderKey(
      coreUuid.randomUuidV7At(new Date(now)),
      position,
      sessionId
    );
    ingestionDisplayOrderKeys.set(sessionId, key);
    return key;
  };
  const serviceDraft = {
    device: "auto",
    brightness: "auto",
    theme: "none",
    author: "",
    title: "service batch",
    description: "",
    source: "",
    original: "",
    tags: []
  };
  const serviceDependencies = (readCommitted) => ({
    readCommitted,
    withStorageReadLock: async (work) => work(new AbortController().signal),
    resolveStorageSlug: async (slug) => slug ?? "local",
    assertStorageWriteTarget: async () => undefined
  });
  const serviceTokens = () => new ingestionTokenService.IngestionTokenService({
    rootKey: new Uint8Array(32).fill(19),
    now: () => serviceNow
  });
  const serviceBatchKey = coreUuid.randomUuidV7At(new Date(serviceNow));
  const uploadBatchItems = [
    {
      ...serviceDraft,
      idempotency_key: "upload-batch-first",
      batch_key: serviceBatchKey,
      image_time: "2026-08-23T01:02:03.456Z",
      batch_position: 0,
      expected_size: 10,
      max_long_edge: 100
    },
    {
      ...serviceDraft,
      idempotency_key: "upload-batch-second",
      batch_key: serviceBatchKey,
      image_time: "2026-08-23T01:02:03.456Z",
      batch_position: 1,
      expected_size: 10,
      max_long_edge: 100
    }
  ];
  let uploadBatchCall = 0;
  const uploadBatchService = new ingestionSessionService.IngestionSessionService({
    createUploadIntent: async (intent) => {
      uploadBatchCall += 1;
      if (uploadBatchCall === 2) throw new Error("second upload rejected");
      return { kind: "intent", created: true, intent };
    }
  }, serviceTokens(), serviceDependencies(async () => new Map()));
  const uploadBatchResult = await uploadBatchService.createUploadIntents(
    "service-owner",
    uploadBatchItems,
    serviceNow
  );
  assert.equal(uploadBatchCall, 2);
  assert.equal(uploadBatchResult[0].status, "intent");
  assert.deepEqual(uploadBatchResult[1], {
    idempotency_key: "upload-batch-second",
    status: "failed",
    code: "ingestion_item_failed",
    message: "second upload rejected"
  });
  const uploadBoundaryResult = await uploadBatchService.createUploadIntents(
    "service-owner",
    [
      {
        ...uploadBatchItems[0],
        idempotency_key: "upload-size-boundary",
        expected_size: 100 * 1024 * 1024 + 1
      },
      {
        ...uploadBatchItems[0],
        idempotency_key: "upload-edge-boundary",
        max_long_edge: 32_001
      }
    ],
    serviceNow
  );
  assert.deepEqual(
    uploadBoundaryResult.map(({ status, code }) => ({ status, code })),
    [
      { status: "failed", code: "upload_too_large" },
      { status: "failed", code: "upload_dimensions_exceeded" }
    ]
  );
  assert.equal(uploadBatchCall, 2, "越界 intent 不得进入存储或 Redis 接管");

  let importBatchCall = 0;
  const importBatchService = new ingestionSessionService.IngestionSessionService({
    acceptImportSession: async (template) => {
      importBatchCall += 1;
      if (importBatchCall === 2) throw new Error("second import rejected");
      return {
        created: true,
        session: {
          ...template,
          version: 1,
          last_semantic_revision: 1,
          accepted_at: serviceNow,
          accepted_order: 1
        }
      };
    }
  }, serviceTokens(), serviceDependencies(async () => new Map()));
  const importBatchResult = await importBatchService.acceptImportItems(
    "service-owner",
    uploadBatchItems.map((item, index) => ({
      ...item,
      idempotency_key: "import-batch-" + String(index),
      source_type: "url",
      download_url: "https://example.com/" + String(index) + ".jpg"
    })),
    serviceNow
  );
  assert.equal(importBatchCall, 2);
  assert.equal(importBatchResult[0].status, "accepted");
  assert.equal(
    importBatchResult[0].accepted_order,
    1,
    "accept 响应必须携带精确顺序供 snapshot 前的组合总数交接"
  );
  assert.deepEqual(importBatchResult[1], {
    idempotency_key: "import-batch-1",
    status: "failed",
    code: "ingestion_item_failed",
    message: "second import rejected"
  });

  const originalRuntimeConfig = structuredClone(runtimeConfigStore.getRuntimeConfig());
  const policyTemplates = [];
  const policyService = new ingestionSessionService.IngestionSessionService({
    acceptImportSession: async (template) => {
      policyTemplates.push(template);
      return {
        created: true,
        session: {
          ...template,
          version: 1,
          last_semantic_revision: 1,
          accepted_at: serviceNow,
          accepted_order: policyTemplates.length
        }
      };
    }
  }, serviceTokens(), serviceDependencies(async () => new Map()));
  await runtimeConfigStore.updateRuntimeConfig({
    import: { keep_original_link: ["url", "weibo"] },
    weibo: { source_enabled: false }
  });
  try {
    await policyService.acceptImportItems(
      "metadata-policy-owner",
      ["url", "jsonl", "weibo"].map((sourceType, index) => ({
        ...serviceDraft,
        source: "https://source.example.com/" + sourceType,
        original: "https://submitted.example.com/" + sourceType + ".jpg",
        idempotency_key: "metadata-policy-" + sourceType,
        batch_key: serviceBatchKey,
        source_type: sourceType,
        download_url: "https://download.example.com/" + sourceType + ".jpg",
        batch_position: index
      })),
      serviceNow
    );
  } finally {
    await runtimeConfigStore.updateRuntimeConfig({
      import: {
        keep_original_link: originalRuntimeConfig.import.keep_original_link
      },
      weibo: {
        source_enabled: originalRuntimeConfig.weibo.source_enabled
      }
    });
  }
  assert.deepEqual(
    policyTemplates.map((template) => ({
      source_type: template.source_type,
      download: template.import_download.url,
      source: template.metadata.source,
      original: template.metadata.original
    })),
    [
      {
        source_type: "url",
        download: "https://download.example.com/url.jpg",
        source: "https://source.example.com/url",
        original: "https://download.example.com/url.jpg"
      },
      {
        source_type: "jsonl",
        download: "https://download.example.com/jsonl.jpg",
        source: "https://source.example.com/jsonl",
        original: ""
      },
      {
        source_type: "weibo",
        download: "https://download.example.com/weibo.jpg",
        source: "",
        original: "https://download.example.com/weibo.jpg"
      }
    ]
  );

  let canonicalBatchCall = 0;
  let staleReceiptDeleted = null;
  let queriedCanonicalIds = [];
  const canonicalBatchRepository = {
    createUploadIntent: async (intent) => {
      canonicalBatchCall += 1;
      if (canonicalBatchCall === 1) {
        return {
          kind: "canonical",
          session: {
            owner: intent.owner,
            queue: "upload",
            source_type: "upload",
            session_id: intent.session_id,
            image_id: intent.candidate_image_id,
            image_time: intent.resolved_image_time,
            request_hash: intent.request_hash,
            metadata: intent.metadata,
            storage_slug: intent.storage_slug,
            status: "committing",
            phase: "committing",
            message: "committing",
            progress: null,
            version: 3,
            progress_seq: 0,
            last_semantic_revision: 3,
            accepted_at: serviceNow - 10,
            accepted_order: 1,
            execution_token: "execution",
            raw_generation: "",
            raw_size: 0,
            discard_at: serviceNow + 10_000,
            semantic_hash: "a".repeat(64)
          }
        };
      }
      return {
        kind: "canonical",
        session: {
          owner: intent.owner,
          queue: "upload",
          session_id: intent.session_id,
          image_id: intent.candidate_image_id,
          request_hash: intent.request_hash,
          commit_request_id: "stale-commit",
          commit_intent_hash: "b".repeat(64),
          status: "completed",
          version: 4,
          last_semantic_revision: 4,
          accepted_at: serviceNow - 10,
          accepted_order: 2,
          completed_at: serviceNow - 1,
          discard_at: serviceNow + 10_000
        }
      };
    },
    deleteSession: async (session) => {
      staleReceiptDeleted = session;
      return {};
    }
  };
  const canonicalBatchService = new ingestionSessionService.IngestionSessionService(
    canonicalBatchRepository,
    serviceTokens(),
    serviceDependencies(async (ids) => {
      queriedCanonicalIds = [...ids];
      return new Map([
        [ids[0].toLowerCase(), {
          image_id: ids[0].toLowerCase(),
          image_time: "2026-08-20T00:00:00.000Z",
          created_by: "service-owner",
          item: {}
        }],
        [ids[1].toLowerCase(), {
          image_id: ids[1].toLowerCase(),
          image_time: "2026-08-20T00:00:01.000Z",
          created_by: "different-owner",
          item: {}
        }]
      ]);
    })
  );
  const canonicalBatchResult = await canonicalBatchService.createUploadIntents(
    "service-owner",
    uploadBatchItems,
    serviceNow
  );
  assert.equal(queriedCanonicalIds.length, 2, "所有 canonical 都必须查询 PostgreSQL");
  assert.equal(canonicalBatchResult[0].status, "completed");
  assert.equal(canonicalBatchResult[0].accepted_order, 1);
  assert.equal(
    canonicalBatchResult[0].resolved_image_time,
    "2026-08-20T00:00:00.000Z",
    "即使 Redis 仍在 committing，PostgreSQL 已存在时也必须返回 completed"
  );
  assert.equal(
    canonicalBatchResult[0].last_semantic_revision,
    undefined,
    "PG 已完成但 Redis 尚未形成 completed 收据时不得伪造精确动作水位"
  );
  assert.deepEqual(canonicalBatchResult[1], {
    idempotency_key: "upload-batch-second",
    status: "failed",
    code: "ingestion_result_missing",
    message: "Redis 完成收据在 PostgreSQL 中没有对应图片，已清除过期收据，请重试"
  });
  assert.equal(staleReceiptDeleted?.status, "completed");

  const exactCompletedService = new ingestionSessionService.IngestionSessionService({
    createUploadIntent: async (intent) => ({
      kind: "canonical",
      session: {
        owner: intent.owner,
        queue: "upload",
        session_id: intent.session_id,
        image_id: intent.candidate_image_id,
        request_hash: intent.request_hash,
        commit_request_id: "completed-commit",
        commit_intent_hash: "c".repeat(64),
        status: "completed",
        version: 9,
        last_semantic_revision: 12,
        accepted_at: serviceNow - 10,
        accepted_order: 3,
        completed_at: serviceNow - 1,
        discard_at: serviceNow + 10_000
      }
    })
  }, serviceTokens(), serviceDependencies(async (ids) => new Map([[
    ids[0].toLowerCase(),
    {
      image_id: ids[0].toLowerCase(),
      image_time: "2026-08-20T00:00:02.000Z",
      created_by: "service-owner",
      item: {}
    }
  ]])));
  const [exactCompletedResult] = await exactCompletedService
    .createUploadIntents("service-owner", [uploadBatchItems[0]], serviceNow);
  assert.equal(exactCompletedResult.status, "completed");
  assert.equal(exactCompletedResult.accepted_order, 3);
  assert.equal(exactCompletedResult.version, 9);
  assert.equal(exactCompletedResult.last_semantic_revision, 12);

  const ingestionOwner = "current-domain-" + randomUUID();
  const ingestionSessionId = ingestionSessionIdentity.createIngestionSessionId(
    ingestionOwner,
    "upload",
    "stable-idempotency-key"
  );
  const ingestionResolvedTime = imageTime.parseImageTime(
    "2026-08-23T01:02:03.456Z"
  );
  const ingestionImageId = imageTime.createImageId(ingestionResolvedTime.date, 37);
  const intentTtlMs = sharedAppConfig.appConfig.ingestionRuntime
    .uploadIntentTtlSeconds * 1000;
  const intentClaimStaleMs = sharedAppConfig.appConfig.ingestionRuntime
    .uploadClaimStaleSeconds * 1000;
  const uploadTtlMs = sharedAppConfig.appConfig.ingestionRuntime
    .uploadSessionIdleTtlSeconds * 1000;
  const importTtlMs = sharedAppConfig.appConfig.ingestionRuntime
    .importSessionIdleTtlSeconds * 1000;
  const ingestionMetadata = {
    device: "auto",
    brightness: "auto",
    theme: "none",
    author: "",
    title: "current domain",
    description: "",
    source: "",
    original: "",
    tags: []
  };
  const ingestionIntent = {
    owner: ingestionOwner,
    session_id: ingestionSessionId,
    candidate_image_id: ingestionImageId,
    resolved_image_time: ingestionResolvedTime.iso,
    request_hash: "a".repeat(64),
    display_order_key: ingestionSessionIdentity.createIngestionDisplayOrderKey(
      coreUuid.randomUuidV7At(new Date(serviceNow)),
      37,
      ingestionSessionId
    ),
    batch_position: 37,
    metadata: ingestionMetadata,
    storage_slug: "local",
    expected_size: 10,
    max_long_edge: 1_000,
    created_at: 1_000,
    expires_at: 0,
    execution_token: "",
    claim_heartbeat_at: 0
  };
  const malformedIntentOwner = "current-malformed-intent-" + randomUUID();
  const malformedIntentSessionId = ingestionSessionIdentity.createIngestionSessionId(
    malformedIntentOwner,
    "upload",
    "invalid-clock"
  );
  const malformedIntentKey = ingestionSessionKeys.ingestionUploadIntentKey(
    malformedIntentOwner,
    malformedIntentSessionId
  );
  const malformedIntentBase = {
    ...ingestionIntent,
    owner: malformedIntentOwner,
    session_id: malformedIntentSessionId,
    display_order_key: displayOrderKey(
      malformedIntentSessionId,
      37,
      serviceNow
    )
  };
  await assert.rejects(ingestionRepository.createUploadIntent({
    ...malformedIntentBase,
    created_at: Number.NaN
  }));
  const malformedIntentTemplates = [
    {
      ...malformedIntentBase,
      raw_path: "forbidden/path"
    },
    {
      ...malformedIntentBase,
      metadata: { ...ingestionMetadata, raw_path: "forbidden/path" }
    },
    {
      ...malformedIntentBase,
      metadata: { ...ingestionMetadata, tags: {} }
    },
    {
      ...malformedIntentBase,
      metadata: null
    }
  ];
  for (const malformed of malformedIntentTemplates) {
    assert.throws(() => ingestionSessionCodec.parseUploadIntent(
      JSON.stringify({
        ...malformed,
        expires_at: ingestionIntent.created_at + intentTtlMs
      })
    ));
    await assert.rejects(ingestionRepository.createUploadIntent(malformed));
  }
  assert.equal(
    await redisClient.redis.type(malformedIntentKey),
    "none",
    "invalid 或开放 schema 的 intent 不得留下 Redis Hash"
  );
  assert.equal(
    (await ingestionRepository.createUploadIntent(ingestionIntent)).kind,
    "intent"
  );
  const initialIntent = await ingestionRepository.readUploadIntent(
    ingestionOwner,
    ingestionSessionId
  );
  assert.equal(initialIntent.expires_at, ingestionIntent.created_at + intentTtlMs);
  const liveIntentKey = ingestionSessionKeys.ingestionUploadIntentKey(
    ingestionOwner,
    ingestionSessionId
  );
  const originalIntentHash = await redisClient.redis.hgetall(liveIntentKey);
  for (const [field, value] of [
    ["unexpected", "leaks"],
    ["execution_token", coreUuid.randomUuidV7()]
  ]) {
    await redisClient.redis.hset(liveIntentKey, field, value);
    const malformedIntentHash = await redisClient.redis.hgetall(liveIntentKey);
    const operationalBeforeIntentHashFailure = {
      ...runtimeAvailability.getRedisOperationalState()
    };
    await assert.rejects(productionIngestionRepository.readUploadIntent(
      ingestionOwner,
      ingestionSessionId
    ), (error) => error?.code === "upload_intent_state_conflict");
    await assert.rejects(productionIngestionRepository.claimUploadIntent(
      ingestionOwner,
      {
        session_id: ingestionSessionId,
        candidate_image_id: ingestionImageId,
        request_hash: ingestionIntent.request_hash
      },
      coreUuid.randomUuidV7(),
      ingestionIntent.created_at + 1
    ), (error) => error?.code === "upload_intent_state_conflict");
    assert.deepEqual(
      await redisClient.redis.hgetall(liveIntentKey),
      malformedIntentHash,
      "intent Hash 结构或派生字段漂移必须零写入"
    );
    assert.deepEqual(
      runtimeAvailability.getRedisOperationalState(),
      operationalBeforeIntentHashFailure,
      "intent Hash 领域损坏不得降级全局 Redis operational state"
    );
    if (Object.hasOwn(originalIntentHash, field)) {
      await redisClient.redis.hset(liveIntentKey, field, originalIntentHash[field]);
    } else {
      await redisClient.redis.hdel(liveIntentKey, field);
    }
  }
  const intentOperationalBeforeSchemaFailure = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  await redisClient.redis.hset(liveIntentKey, "snapshot", JSON.stringify({
    ...initialIntent,
    raw_path: "forbidden/path"
  }));
  const openSchemaIntentState = await redisClient.redis.hgetall(liveIntentKey);
  await assert.rejects(productionIngestionRepository.claimUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    coreUuid.randomUuidV7(),
    ingestionIntent.created_at + 1
  ), (error) => error?.code === "upload_intent_state_conflict");
  assert.deepEqual(
    await redisClient.redis.hgetall(liveIntentKey),
    openSchemaIntentState,
    "含额外字段的 intent 必须在 claim 写入前 fail closed"
  );
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    intentOperationalBeforeSchemaFailure,
    "intent 领域 schema 错误不得降级全局 Redis operational state"
  );
  await redisClient.redis.hset(
    liveIntentKey,
    "snapshot",
    JSON.stringify(initialIntent)
  );
  await redisClient.redis.hset(liveIntentKey, "snapshot", JSON.stringify({
    ...initialIntent,
    metadata: {
      ...initialIntent.metadata,
      tags: { unexpected: "value" }
    }
  }));
  const malformedTagsIntentState = await redisClient.redis.hgetall(
    liveIntentKey
  );
  await assert.rejects(ingestionRepository.claimUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    coreUuid.randomUuidV7(),
    ingestionIntent.created_at + 1
  ));
  assert.deepEqual(
    await redisClient.redis.hgetall(liveIntentKey),
    malformedTagsIntentState,
    "非数组 tags 的 intent 必须 fail closed 且不得被 claim 重写"
  );
  await redisClient.redis.hset(
    liveIntentKey,
    "snapshot",
    JSON.stringify(initialIntent)
  );
  const regeneratedIntentTime = imageTime.parseImageTime(
    "2026-08-23T01:02:06.456Z"
  );
  const resignedIntent = await ingestionRepository.createUploadIntent({
    ...ingestionIntent,
    candidate_image_id: imageTime.createImageId(
      regeneratedIntentTime.date,
      41
    ),
    resolved_image_time: regeneratedIntentTime.iso,
    created_at: ingestionIntent.created_at + 10_000
  });
  assert.equal(resignedIntent.kind, "intent");
  assert.equal(resignedIntent.created, false);
  assert.equal(resignedIntent.intent.expires_at, initialIntent.expires_at);
  assert.deepEqual(
    await ingestionRepository.readUploadIntent(ingestionOwner, ingestionSessionId),
    initialIntent,
    "读取或重签不得延长上传意图的逻辑有效期"
  );
  await assert.rejects(ingestionRepository.createUploadIntent({
    ...ingestionIntent,
    request_hash: "b".repeat(64),
    created_at: ingestionIntent.created_at + 20_000
  }), (error) => error?.code === "idempotency_conflict");
  assert.deepEqual(
    await ingestionRepository.readUploadIntent(ingestionOwner, ingestionSessionId),
    initialIntent,
    "不同 request hash 的 intent 冲突不得改变现有 intent 或 TTL"
  );
  await assert.rejects(ingestionRepository.claimUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    "",
    initialIntent.created_at + 1
  ), (error) => error?.code === "ingestion_execution_fenced");
  assert.deepEqual(
    await ingestionRepository.readUploadIntent(ingestionOwner, ingestionSessionId),
    initialIntent,
    "空 execution token 不得 claim 或延长 intent"
  );

  const expiredIntentOwner = "current-expired-intent-" + randomUUID();
  const expiredIntentSessionId = ingestionSessionIdentity.createIngestionSessionId(
    expiredIntentOwner,
    "upload",
    "expires-at-boundary"
  );
  const expiredIntentTime = imageTime.parseImageTime(
    "2026-08-23T01:02:04.456Z"
  );
  const expiredIntentImageId = imageTime.createImageId(
    expiredIntentTime.date,
    38
  );
  const expiredIntent = {
    ...ingestionIntent,
    owner: expiredIntentOwner,
    session_id: expiredIntentSessionId,
    candidate_image_id: expiredIntentImageId,
    resolved_image_time: expiredIntentTime.iso,
    request_hash: "c".repeat(64),
    display_order_key: displayOrderKey(
      expiredIntentSessionId,
      38,
      expiredIntentTime.date.getTime()
    ),
    batch_position: 38,
    created_at: 2_000
  };
  await ingestionRepository.createUploadIntent(expiredIntent);
  await assert.rejects(ingestionRepository.claimUploadIntent(
    expiredIntentOwner,
    {
      session_id: expiredIntentSessionId,
      candidate_image_id: expiredIntentImageId,
      request_hash: expiredIntent.request_hash
    },
    coreUuid.randomUuidV7(),
    expiredIntent.created_at + intentTtlMs
  ), (error) => error?.code === "upload_intent_expired");
  assert.equal(await ingestionRepository.readUploadIntent(
    expiredIntentOwner,
    expiredIntentSessionId
  ), null);

  const ingestionExecutionToken = coreUuid.randomUuidV7();
  const firstIntentClaimedAt = initialIntent.expires_at - 1;
  const firstClaimedIngestionIntent = await ingestionRepository.claimUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    ingestionExecutionToken,
    firstIntentClaimedAt
  );
  assert.equal(
    firstClaimedIngestionIntent.expires_at,
    firstIntentClaimedAt + intentTtlMs
  );
  const takeoverToken = coreUuid.randomUuidV7();
  await assert.rejects(ingestionRepository.claimUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    takeoverToken,
    firstIntentClaimedAt + intentClaimStaleMs - 1
  ), (error) => error?.code === "upload_in_progress");
  assert.deepEqual(
    await ingestionRepository.readUploadIntent(ingestionOwner, ingestionSessionId),
    firstClaimedIngestionIntent,
    "未失活 claim 的第二 token 不得改变 intent 或 TTL"
  );
  const takeoverAt = firstIntentClaimedAt + intentClaimStaleMs;
  const takenOverIntent = await ingestionRepository.claimUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    takeoverToken,
    takeoverAt
  );
  assert.equal(takenOverIntent.execution_token, takeoverToken);
  const stateAfterTakeover = await ingestionRepository.readUploadIntent(
    ingestionOwner,
    ingestionSessionId
  );
  await assert.rejects(ingestionRepository.heartbeatUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    ingestionExecutionToken,
    takeoverAt + 1
  ), (error) => error?.code === "ingestion_execution_fenced");
  await assert.rejects(ingestionRepository.releaseUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    ingestionExecutionToken,
    takeoverAt + 1
  ), (error) => error?.code === "ingestion_execution_fenced");
  assert.deepEqual(
    await ingestionRepository.readUploadIntent(ingestionOwner, ingestionSessionId),
    stateAfterTakeover,
    "旧 token 的 heartbeat/release 必须 fenced 且不改变 intent"
  );
  const releasedIntent = await ingestionRepository.releaseUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    takeoverToken,
    takeoverAt + 1
  );
  assert.equal(releasedIntent.execution_token, "");
  assert.equal(releasedIntent.claim_heartbeat_at, 0);
  assert.equal(releasedIntent.expires_at, takenOverIntent.expires_at);
  const intentClaimedAt = takeoverAt + 1;
  const claimedIngestionIntent = await ingestionRepository.claimUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    ingestionExecutionToken,
    intentClaimedAt
  );
  assert.equal(claimedIngestionIntent.execution_token, ingestionExecutionToken);
  const oldIntentHeartbeat = await ingestionRepository.heartbeatUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    ingestionExecutionToken,
    intentClaimedAt - 100
  );
  assert.equal(oldIntentHeartbeat.claim_heartbeat_at, intentClaimedAt);
  assert.equal(oldIntentHeartbeat.expires_at, claimedIngestionIntent.expires_at);
  const intentHeartbeatAt = intentClaimedAt + 100;
  const heartbeatedIngestionIntent = await ingestionRepository.heartbeatUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    ingestionExecutionToken,
    intentHeartbeatAt
  );
  assert.equal(
    heartbeatedIngestionIntent.expires_at,
    intentHeartbeatAt + intentTtlMs
  );
  assert.deepEqual(heartbeatedIngestionIntent.metadata, ingestionMetadata);
  assert.equal(
    (await ingestionRepository.readUploadIntent(ingestionOwner, ingestionSessionId))
      .expires_at,
    heartbeatedIngestionIntent.expires_at
  );
  const canonicalCreatedAt = intentHeartbeatAt + 1;
  const ingestionCanonicalWithoutHash = {
    owner: ingestionOwner,
    queue: "upload",
    source_type: "upload",
    session_id: ingestionSessionId,
    image_id: ingestionImageId,
    image_time: claimedIngestionIntent.resolved_image_time,
    request_hash: claimedIngestionIntent.request_hash,
    metadata: ingestionMetadata,
    storage_slug: "local",
    status: "received",
    phase: "received",
    message: "received",
    progress: 100,
    version: 0,
    progress_seq: 0,
    last_semantic_revision: 0,
    accepted_at: 0,
    accepted_order: 0,
    execution_token: "",
    raw_generation: coreUuid.randomUuidV7(),
    raw_size: 10,
    discard_at: 0
  };
  const ingestionCanonical = {
    ...ingestionCanonicalWithoutHash,
    semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
      ingestionCanonicalWithoutHash
    )
  };
  const takeoverIntentSchemaVariants = [
    { ...heartbeatedIngestionIntent, raw_path: "forbidden/path" },
    {
      ...heartbeatedIngestionIntent,
      metadata: { ...heartbeatedIngestionIntent.metadata, tags: {} }
    },
    { ...heartbeatedIngestionIntent, metadata: null }
  ];
  const operationalBeforeIntentTakeoverFailures = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  for (const malformed of takeoverIntentSchemaVariants) {
    await redisClient.redis.hset(
      liveIntentKey,
      "snapshot",
      JSON.stringify(malformed)
    );
    const stateBeforeMalformedTakeover = {
      intent: await redisClient.redis.hgetall(liveIntentKey),
      canonicalType: await redisClient.redis.type(
        ingestionSessionKeys.ingestionCanonicalKey(ingestionOwner, ingestionSessionId)
      ),
      ownerType: await redisClient.redis.type(
        ingestionSessionKeys.ingestionOwnerQueueKey(ingestionOwner, "upload")
      ),
      metadataType: await redisClient.redis.type(
        ingestionSessionKeys.ingestionQueueMetadataKey(ingestionOwner, "upload")
      )
    };
    await assert.rejects(productionIngestionRepository.convertUploadIntent(
      ingestionCanonical,
      ingestionExecutionToken,
      canonicalCreatedAt
    ), (error) => error?.code === "upload_intent_state_conflict");
    assert.deepEqual({
      intent: await redisClient.redis.hgetall(liveIntentKey),
      canonicalType: await redisClient.redis.type(
        ingestionSessionKeys.ingestionCanonicalKey(ingestionOwner, ingestionSessionId)
      ),
      ownerType: await redisClient.redis.type(
        ingestionSessionKeys.ingestionOwnerQueueKey(ingestionOwner, "upload")
      ),
      metadataType: await redisClient.redis.type(
        ingestionSessionKeys.ingestionQueueMetadataKey(ingestionOwner, "upload")
      )
    }, stateBeforeMalformedTakeover,
    "畸形既存 intent 不得在 takeover 时被删除或创建 canonical");
  }
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeIntentTakeoverFailures,
    "intent takeover schema 错误不得降级全局 Redis operational state"
  );
  await redisClient.redis.hset(
    liveIntentKey,
    "snapshot",
    JSON.stringify(heartbeatedIngestionIntent)
  );
  let ingestionListenerCalls = 0;
  let ingestionAsyncListenerCalls = 0;
  ingestionRepository.subscribe(ingestionOwner, "upload", () => {
    ingestionListenerCalls += 1;
    throw new Error("listener failure must not reject a committed Redis write");
  });
  ingestionRepository.subscribe(ingestionOwner, "upload", async () => {
    ingestionAsyncListenerCalls += 1;
    throw new Error("async listener failure must be isolated");
  });
  const takeoverTampering = [
    { ...ingestionCanonical, image_time: regeneratedIntentTime.iso },
    {
      ...ingestionCanonical,
      metadata: { ...ingestionMetadata, title: "tampered" }
    },
    { ...ingestionCanonical, storage_slug: "tampered-storage" },
    { ...ingestionCanonical, raw_size: ingestionCanonical.raw_size + 1 },
    { ...ingestionCanonical, raw_generation: "" }
  ];
  for (const tampered of takeoverTampering) {
    await assert.rejects(ingestionRepository.convertUploadIntent(
      tampered,
      ingestionExecutionToken,
      canonicalCreatedAt
    ));
    assert.equal(ingestionListenerCalls, 0);
    assert.equal(ingestionAsyncListenerCalls, 0);
    assert.ok(await ingestionRepository.readUploadIntent(
      ingestionOwner,
      ingestionSessionId
    ));
  }
  assert.equal((await ingestionRepository.snapshot(
    ingestionOwner,
    "upload",
    0,
    10
  )).items.length, 0);
  const convertedUpload = await ingestionRepository.convertUploadIntent(
    ingestionCanonical,
    ingestionExecutionToken,
    canonicalCreatedAt
  );
  assert.equal(convertedUpload.session.version, 1);
  assert.equal(
    convertedUpload.session.discard_at,
    canonicalCreatedAt + uploadTtlMs
  );
  assert.equal(ingestionListenerCalls, 1);
  assert.equal(ingestionAsyncListenerCalls, 1);
  const unknownRawBody = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "red" }
  }).png().toBuffer();
  const unknownRawImageTime = imageTime.parseImageTime(
    "2026-08-23T01:02:09.456Z"
  );
  const unknownRawPair = {
    session_id: ingestionSessionIdentity.createIngestionSessionId(
      ingestionOwner,
      "upload",
      "unknown-convert-result"
    ),
    image_id: imageTime.createImageId(unknownRawImageTime.date, 49)
  };
  let unknownRawCanonical = null;
  const unknownRawService = {
    verifyUploadCredential: () => ({
      session_id: unknownRawPair.session_id,
      candidate_image_id: unknownRawPair.image_id,
      request_hash: "9".repeat(64)
    }),
    repository: {
      claimUploadIntent: async () => ({
        owner: ingestionOwner,
        session_id: unknownRawPair.session_id,
        candidate_image_id: unknownRawPair.image_id,
        resolved_image_time: unknownRawImageTime.iso,
        request_hash: "9".repeat(64),
        batch_position: 49,
        metadata: ingestionMetadata,
        storage_slug: "local",
        expected_size: unknownRawBody.length,
        max_long_edge: 16
      }),
      heartbeatUploadIntent: async () => undefined,
      convertUploadIntent: async (template) => {
        unknownRawCanonical = template;
        throw new Error("conversion response lost");
      },
      readSession: async () => unknownRawCanonical,
      releaseUploadIntent: async () => undefined
    },
    uploadReceivedTemplate: (intent, rawGeneration, rawSize) => ({
      ...intent,
      image_id: intent.candidate_image_id,
      image_time: intent.resolved_image_time,
      raw_generation: rawGeneration,
      raw_size: rawSize
    })
  };
  await assert.rejects(ingestionRawUpload.receiveUploadIntentBody(
    unknownRawService,
    ingestionOwner,
    "credential",
    new Response(unknownRawBody).body,
    new AbortController().signal
  ), /conversion response lost/);
  assert.ok(unknownRawCanonical);
  const retainedUnknownRawPath = ingestionRawFiles.ingestionRawPath(
    "upload",
    unknownRawPair,
    unknownRawCanonical.raw_generation
  );
  assert.deepEqual(
    await readFile(retainedUnknownRawPath),
    unknownRawBody,
    "convert 结果未知且 canonical 引用当前 generation 时不得删除 raw"
  );
  await rm(retainedUnknownRawPath, { force: true });
  const staleIngestionImageId = imageTime.createImageId(
    imageTime.parseImageTime("2026-08-23T01:02:04.456Z").date,
    38
  );
  const mixedIncarnationReads = await productionIngestionRepository.readSessions(
    ingestionOwner,
    [
      { session_id: ingestionSessionId, image_id: staleIngestionImageId },
      { session_id: ingestionSessionId, image_id: ingestionImageId }
    ]
  );
  assert.equal(
    mixedIncarnationReads[0],
    ingestionSessionRepository.ingestionSessionIncarnationMismatch
  );
  assert.deepEqual(mixedIncarnationReads[1], convertedUpload.session);
  const mixedIncarnationStatuses = await ingestionSessionView.readIngestionStatuses(
    productionIngestionRepository,
    ingestionOwner,
    [
      { session_id: ingestionSessionId, image_id: staleIngestionImageId },
      { session_id: ingestionSessionId, image_id: ingestionImageId }
    ]
  );
  assert.equal(mixedIncarnationStatuses[0].status, "missing");
  assert.equal(mixedIncarnationStatuses[1].status, "present");
  const ingestionTestKeys = ingestionSessionKeys.ingestionSessionKeys(
    ingestionOwner,
    "upload",
    ingestionSessionId
  );
  const readIngestionBusinessState = async () => ({
    canonical: await redisClient.redis.hget(
      ingestionTestKeys.canonical,
      "snapshot"
    ),
    metadata: await redisClient.redis.hgetall(ingestionTestKeys.metadata),
    owner: await redisClient.redis.zrange(
      ingestionTestKeys.owner,
      0,
      -1,
      "WITHSCORES"
    ),
    display: await redisClient.redis.zrange(
      ingestionTestKeys.display,
      0,
      -1,
      "WITHSCORES"
    )
  });
  const readActiveSchemaState = async () => ({
    ...await readIngestionBusinessState(),
    runnable: await redisClient.redis.zscore(
      ingestionTestKeys.runnable,
      ingestionTestKeys.canonical
    ),
    expires: await redisClient.redis.zscore(
      ingestionTestKeys.expires,
      ingestionTestKeys.canonical
    )
  });
  await redisClient.redis.hset(liveIntentKey, "unexpected", "stale-intent");
  const malformedIntentBesideCanonical = await redisClient.redis.hgetall(
    liveIntentKey
  );
  const reusedCanonicalBeforeMalformedIntent = await productionIngestionRepository
    .createUploadIntent({
      ...ingestionIntent,
      created_at: canonicalCreatedAt + 1
    });
  assert.equal(reusedCanonicalBeforeMalformedIntent.kind, "canonical");
  assert.equal(
    reusedCanonicalBeforeMalformedIntent.session.image_id,
    ingestionImageId
  );
  const convertedBeforeMalformedIntent = await productionIngestionRepository
    .convertUploadIntent(
      ingestionCanonical,
      ingestionExecutionToken,
      canonicalCreatedAt + 1
    );
  assert.equal(convertedBeforeMalformedIntent.created, false);
  assert.deepEqual(
    await redisClient.redis.hgetall(liveIntentKey),
    malformedIntentBesideCanonical,
    "已有 canonical 的幂等读取不得校验或改写残留 intent"
  );
  await redisClient.redis.del(liveIntentKey);
  const originalCanonicalHash = await redisClient.redis.hgetall(
    ingestionTestKeys.canonical
  );
  for (const [field, value] of [
    ["unexpected", "leaks"],
    ["status", "queued"]
  ]) {
    await redisClient.redis.hset(ingestionTestKeys.canonical, field, value);
    const malformedCanonicalHashState = await readActiveSchemaState();
    const operationalBeforeCanonicalHashFailure = {
      ...runtimeAvailability.getRedisOperationalState()
    };
    await assert.rejects(productionIngestionRepository.readSession(
      ingestionOwner,
      ingestionSessionId
    ), (error) => error?.code === "ingestion_queue_structure_invalid");
    await assert.rejects(productionIngestionRepository.readSessions(
      ingestionOwner,
      [{ session_id: ingestionSessionId, image_id: ingestionImageId }]
    ), (error) => error?.code === "ingestion_queue_structure_invalid");
    await assert.rejects(productionIngestionRepository.snapshot(
      ingestionOwner,
      "upload",
      0,
      10
    ), (error) => error?.code === "ingestion_queue_structure_invalid");
    await assert.rejects(productionIngestionRepository.discoverRunnable(),
      (error) => error?.code === "ingestion_queue_structure_invalid");
    await assert.rejects(productionIngestionRepository.mutateSemantic(
      convertedUpload.session,
      convertedUpload.session.version,
      {
        ...convertedUpload.session,
        message: "不得越过损坏的 canonical Hash"
      },
      canonicalCreatedAt + 1
    ), (error) => error?.code === "ingestion_queue_structure_invalid");
    assert.deepEqual(
      await readActiveSchemaState(),
      malformedCanonicalHashState,
      "canonical Hash 结构或派生字段漂移必须零写入"
    );
    assert.deepEqual(
      runtimeAvailability.getRedisOperationalState(),
      operationalBeforeCanonicalHashFailure,
      "canonical Hash 领域损坏不得降级全局 Redis operational state"
    );
    if (Object.hasOwn(originalCanonicalHash, field)) {
      await redisClient.redis.hset(
        ingestionTestKeys.canonical,
        field,
        originalCanonicalHash[field]
      );
    } else {
      await redisClient.redis.hdel(ingestionTestKeys.canonical, field);
    }
  }
  const siblingIngestionMetadataKey = ingestionSessionKeys.ingestionQueueMetadataKey(
    ingestionOwner,
    "import"
  );
  const operationalBeforeSiblingQueueFailure = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  await redisClient.redis.set(siblingIngestionMetadataKey, "wrong-type");
  assert.deepEqual(
    await productionIngestionRepository.readSession(ingestionOwner, ingestionSessionId),
    convertedUpload.session,
    "读取 upload canonical 不应校验同一 owner 的 import 队列"
  );
  assert.deepEqual(
    await productionIngestionRepository.readSessions(ingestionOwner, [{
      session_id: ingestionSessionId,
      image_id: ingestionImageId
    }]),
    [convertedUpload.session],
    "批量读取 upload canonical 不应被损坏的同级 import 队列阻断"
  );
  assert.equal(
    await redisClient.redis.get(siblingIngestionMetadataKey),
    "wrong-type"
  );
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeSiblingQueueFailure,
    "未访问队列的结构损坏不得污染 Redis 全局可用性"
  );
  await redisClient.redis.del(siblingIngestionMetadataKey);
  const malformedActiveCanonicals = [
    { ...convertedUpload.session, raw_path: "forbidden/path" },
    { ...convertedUpload.session, source_type: "url" },
    {
      ...convertedUpload.session,
      queue: "import",
      source_type: "upload",
      import_download: { url: "https://example.com/not-an-import.jpg" }
    },
    {
      ...convertedUpload.session,
      metadata: { ...convertedUpload.session.metadata, raw_path: "forbidden/path" }
    },
    {
      ...convertedUpload.session,
      metadata: { ...convertedUpload.session.metadata, tags: {} }
    },
    { ...convertedUpload.session, metadata: null },
    {
      ...convertedUpload.session,
      import_download: { url: "https://example.com/not-an-upload.jpg" }
    },
    {
      ...convertedUpload.session,
      prepared: { raw_path: "forbidden/path" }
    },
    {
      ...convertedUpload.session,
      commit: { raw_path: "forbidden/path" }
    }
  ];
  const stateBeforeActiveSchemaFailures = await readActiveSchemaState();
  const operationalBeforeActiveSchemaFailures = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  for (const malformed of malformedActiveCanonicals) {
    assert.throws(() => ingestionSessionCodec.parseStoredIngestionSession(
      JSON.stringify(malformed)
    ));
    await assert.rejects(productionIngestionRepository.mutateSemantic(
      convertedUpload.session,
      convertedUpload.session.version,
      malformed,
      canonicalCreatedAt + 1
    ), (error) => error?.code === "ingestion_queue_structure_invalid");
    assert.deepEqual(
      await readActiveSchemaState(),
      stateBeforeActiveSchemaFailures,
      "开放或畸形 active schema 必须在任何 Redis 写入前失败"
    );
  }
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeActiveSchemaFailures,
    "active schema 领域错误不得降级全局 Redis operational state"
  );

  const canonicalBeforeOpenSchemaRead = await redisClient.redis.hget(
    ingestionTestKeys.canonical,
    "snapshot"
  );
  assert.ok(canonicalBeforeOpenSchemaRead);
  const openSchemaCanonical = JSON.stringify({
    ...JSON.parse(canonicalBeforeOpenSchemaRead),
    raw_path: "forbidden/path"
  });
  await redisClient.redis.hset(
    ingestionTestKeys.canonical,
    "snapshot",
    openSchemaCanonical
  );
  await assert.rejects(productionIngestionRepository.readSession(
    ingestionOwner,
    ingestionSessionId
  ), (error) => error?.code === "ingestion_queue_structure_invalid");
  assert.equal(
    await redisClient.redis.hget(ingestionTestKeys.canonical, "snapshot"),
    openSchemaCanonical,
    "读取开放 schema canonical 必须 fail closed 且不得自动改写"
  );
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeActiveSchemaFailures
  );
  await redisClient.redis.hset(
    ingestionTestKeys.canonical,
    "snapshot",
    canonicalBeforeOpenSchemaRead
  );
  const stateBeforeActiveDelete = await readIngestionBusinessState();
  await assert.rejects(productionIngestionRepository.deleteSession(
    convertedUpload.session,
    convertedUpload.session.version,
    canonicalCreatedAt + 1
  ), (error) => error?.code === "ingestion_session_state_conflict");
  assert.deepEqual(
    await readIngestionBusinessState(),
    stateBeforeActiveDelete,
    "active canonical 的终态删除绕过必须零写入"
  );

  const originalOwnerScore = await redisClient.redis.zscore(
    ingestionTestKeys.owner,
    ingestionSessionId
  );
  const originalQueueMetadata = await redisClient.redis.hgetall(
    ingestionTestKeys.metadata
  );
  assert.ok(originalOwnerScore);
  const clockSessionId = ingestionSessionIdentity.createIngestionSessionId(
    ingestionOwner,
    "upload",
    "clock-regression"
  );
  const clockImageId = imageTime.createImageId(ingestionResolvedTime.date, 38);
  const clockRequestHash = "d".repeat(64);
  const clockIntent = {
    ...ingestionIntent,
    session_id: clockSessionId,
    candidate_image_id: clockImageId,
    request_hash: clockRequestHash,
    display_order_key: displayOrderKey(
      clockSessionId,
      38,
      canonicalCreatedAt + 10
    ),
    batch_position: 38,
    created_at: canonicalCreatedAt + 10
  };
  await ingestionRepository.createUploadIntent(clockIntent);
  const clockExecutionToken = coreUuid.randomUuidV7();
  const claimedClockIntent = await ingestionRepository.claimUploadIntent(
    ingestionOwner,
    {
      session_id: clockSessionId,
      candidate_image_id: clockImageId,
      request_hash: clockRequestHash
    },
    clockExecutionToken,
    clockIntent.created_at + 1
  );
  const clockCanonicalWithoutHash = {
    ...ingestionCanonicalWithoutHash,
    session_id: clockSessionId,
    image_id: clockImageId,
    image_time: claimedClockIntent.resolved_image_time,
    request_hash: clockRequestHash,
    raw_generation: coreUuid.randomUuidV7()
  };
  const clockCanonical = {
    ...clockCanonicalWithoutHash,
    semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
      clockCanonicalWithoutHash
    )
  };
  const clockTestKeys = ingestionSessionKeys.ingestionSessionKeys(
    ingestionOwner,
    "upload",
    clockSessionId
  );
  const clockIntentKey = ingestionSessionKeys.ingestionUploadIntentKey(
    ingestionOwner,
    clockSessionId
  );
  const readClockCreateState = async () => ({
    queue: await readActiveSchemaState(),
    canonicalType: await redisClient.redis.type(clockTestKeys.canonical),
    intent: await redisClient.redis.hgetall(clockIntentKey)
  });
  for (const [field, value] of [
    ["revision", "0"],
    ["last_accepted_order", "0"]
  ]) {
    await redisClient.redis.hset(ingestionTestKeys.metadata, field, value);
    const stateBeforeRegressedClockCreate = await readClockCreateState();
    const operationalBeforeRegressedClockCreate = {
      ...runtimeAvailability.getRedisOperationalState()
    };
    await assert.rejects(productionIngestionRepository.convertUploadIntent(
      clockCanonical,
      clockExecutionToken,
      clockIntent.created_at + 2
    ), (error) => error?.code === "ingestion_queue_structure_invalid");
    assert.deepEqual(
      await readClockCreateState(),
      stateBeforeRegressedClockCreate,
      "回退的队列时钟必须在 canonical 创建前 fail closed"
    );
    assert.deepEqual(
      runtimeAvailability.getRedisOperationalState(),
      operationalBeforeRegressedClockCreate,
      "队列时钟领域损坏不得降级全局 Redis operational state"
    );
    await redisClient.redis.hset(
      ingestionTestKeys.metadata,
      field,
      originalQueueMetadata[field]
    );
  }
  const assertQueueReadFailsClosed = async (message) => {
    const operationalBefore = {
      ...runtimeAvailability.getRedisOperationalState()
    };
    await assert.rejects(productionIngestionRepository.readSession(
      ingestionOwner,
      ingestionSessionId
    ), (error) => error?.code === "ingestion_queue_structure_invalid");
    await assert.rejects(productionIngestionRepository.readSessions(
      ingestionOwner,
      [{ session_id: ingestionSessionId, image_id: ingestionImageId }]
    ), (error) => error?.code === "ingestion_queue_structure_invalid");
    await assert.rejects(productionIngestionRepository.discoverRunnable(),
      (error) => error?.code === "ingestion_queue_structure_invalid");
    assert.deepEqual(
      runtimeAvailability.getRedisOperationalState(),
      operationalBefore,
      message
    );
  };
  const parsedOriginalQueueMetadata = ingestionSessionCodec.metadataFromHashReply(
    Object.entries(originalQueueMetadata).flat()
  );
  const operationalBeforeInvalidSnapshotRange = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  await assert.rejects(productionIngestionRepository.snapshot(
    ingestionOwner,
    "upload",
    0,
    sharedAppConfig.appConfig.ingestionRuntime.snapshotMaxItems + 1
  ), RangeError);
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeInvalidSnapshotRange,
    "超上限 snapshot 必须在 Redis 调用前拒绝"
  );
  await assert.rejects(productionIngestionRepository.discoverRunnable(
    sharedAppConfig.appConfig.ingestionRuntime.ingestionSessionScanBatchSize + 1
  ), RangeError);
  await assert.rejects(
    productionIngestionRepository.discoverRunnablePage(-1, 0),
    RangeError
  );
  await assert.rejects(
    productionIngestionRepository.discoverRunnablePage(0, -1),
    RangeError
  );
  await assert.rejects(productionIngestionRepository.discoverExpired(
    canonicalCreatedAt,
    sharedAppConfig.appConfig.ingestionRuntime.expiryScanBatchSize + 1
  ), RangeError);
  await assert.rejects(productionIngestionRepository.discoverExpiryPage(
    0,
    sharedAppConfig.appConfig.ingestionRuntime.ingestionSessionScanBatchSize + 1
  ), RangeError);
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeInvalidSnapshotRange,
    "超上限 discovery 必须在 Redis 调用前拒绝"
  );
  assert.throws(() => ingestionSessionCodec.parseIngestionQueueMetadata({
    ...parsedOriginalQueueMetadata,
    revision: parsedOriginalQueueMetadata.last_accepted_order - 1
  }));
  assert.throws(() => ingestionSessionCodec.parseIngestionQueueMetadata({
    ...parsedOriginalQueueMetadata,
    committing_resolving: 0,
    resolving: 1
  }));
  for (const invalidIntegerText of ["1.0", "01", ""]) {
    assert.throws(() => ingestionSessionCodec.metadataFromHashReply(
      Object.entries({
        ...originalQueueMetadata,
        revision: invalidIntegerText
      }).flat()
    ));
  }
  assert.throws(() => ingestionSessionCodec.parseIngestionQueueMetadata({
    ...parsedOriginalQueueMetadata,
    unexpected: "leaks"
  }));
  await redisClient.redis.hset(
    ingestionTestKeys.metadata,
    "unexpected",
    "leaks"
  );
  const stateWithUnexpectedMetadata = await readActiveSchemaState();
  await assertQueueReadFailsClosed(
    "metadata 额外字段必须只让当前队列 fail closed"
  );
  await assert.rejects(productionIngestionRepository.snapshot(
    ingestionOwner,
    "upload",
    0,
    10
  ), (error) => error?.code === "ingestion_queue_structure_invalid");
  await assert.rejects(productionIngestionRepository.mutateSemantic(
    convertedUpload.session,
    convertedUpload.session.version,
    {
      ...convertedUpload.session,
      message: "不得越过开放 metadata schema"
    },
    canonicalCreatedAt + 1
  ), (error) => error?.code === "ingestion_queue_structure_invalid");
  assert.deepEqual(
    await readActiveSchemaState(),
    stateWithUnexpectedMetadata,
    "metadata 额外字段必须在任何业务写入前失败"
  );
  await redisClient.redis.hdel(ingestionTestKeys.metadata, "unexpected");
  await redisClient.redis.zrem(ingestionTestKeys.owner, ingestionSessionId);
  await assertQueueReadFailsClosed(
    "owner 成员缺失必须让 pair read/discovery 领域失败而不降级全局 Redis"
  );
  await redisClient.redis.zadd(
    ingestionTestKeys.owner,
    originalOwnerScore,
    ingestionSessionId
  );
  await redisClient.redis.del(ingestionTestKeys.metadata);
  await assertQueueReadFailsClosed(
    "metadata 缺失必须让 pair read/discovery 领域失败而不降级全局 Redis"
  );
  await redisClient.redis.hset(
    ingestionTestKeys.metadata,
    ...Object.entries(originalQueueMetadata).flat()
  );

  const operationalBeforeMissingPairStructure = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  await redisClient.redis.del(ingestionTestKeys.canonical);
  const stateBeforeMissingCanonicalIntent = {
    owner: await redisClient.redis.zrange(
      ingestionTestKeys.owner,
      0,
      -1,
      "WITHSCORES"
    ),
    metadata: await redisClient.redis.hgetall(ingestionTestKeys.metadata),
    intentType: await redisClient.redis.type(liveIntentKey)
  };
  await assert.rejects(productionIngestionRepository.createUploadIntent({
    ...ingestionIntent,
    created_at: canonicalCreatedAt + 2
  }), (error) => error?.code === "ingestion_queue_structure_invalid");
  assert.deepEqual({
    owner: await redisClient.redis.zrange(
      ingestionTestKeys.owner,
      0,
      -1,
      "WITHSCORES"
    ),
    metadata: await redisClient.redis.hgetall(ingestionTestKeys.metadata),
    intentType: await redisClient.redis.type(liveIntentKey)
  }, stateBeforeMissingCanonicalIntent,
  "canonical 缺失但 owner 成员仍在时不得创建 upload intent");
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeMissingPairStructure,
    "缺失 canonical 的 intent 领域失败不得降级全局 Redis"
  );
  const readMissingCanonicalDiscoveryState = async () => ({
    canonicalType: await redisClient.redis.type(ingestionTestKeys.canonical),
    owner: await redisClient.redis.zrange(
      ingestionTestKeys.owner,
      0,
      -1,
      "WITHSCORES"
    ),
    display: await redisClient.redis.zrange(
      ingestionTestKeys.display,
      0,
      -1,
      "WITHSCORES"
    ),
    metadata: await redisClient.redis.hgetall(ingestionTestKeys.metadata),
    runnable: await redisClient.redis.zrange(
      ingestionTestKeys.runnable,
      0,
      -1,
      "WITHSCORES"
    ),
    expires: await redisClient.redis.zrange(
      ingestionTestKeys.expires,
      0,
      -1,
      "WITHSCORES"
    )
  });
  const stateBeforeMissingCanonicalDiscovery =
    await readMissingCanonicalDiscoveryState();
  for (const discover of [
    () => productionIngestionRepository.discoverRunnable(),
    () => productionIngestionRepository.discoverExpired(Number.MAX_SAFE_INTEGER),
    () => productionIngestionRepository.discoverExpiryPage(0)
  ]) {
    await assert.rejects(
      discover(),
      (error) => error?.code === "ingestion_queue_structure_invalid"
    );
    assert.deepEqual(
      await readMissingCanonicalDiscoveryState(),
      stateBeforeMissingCanonicalDiscovery,
      "owner 仍引用缺失 canonical 时 discovery 必须 fail closed 且零写入"
    );
    assert.deepEqual(
      runtimeAvailability.getRedisOperationalState(),
      operationalBeforeMissingPairStructure,
      "局部队列损坏不得降级全局 Redis operational state"
    );
  }
  const expiredIntentDuringMissingCanonical = {
    ...heartbeatedIngestionIntent,
    expires_at: canonicalCreatedAt + 1
  };
  await redisClient.redis.hset(
    liveIntentKey,
    "snapshot",
    JSON.stringify(expiredIntentDuringMissingCanonical),
    "session_id",
    expiredIntentDuringMissingCanonical.session_id,
    "candidate_image_id",
    expiredIntentDuringMissingCanonical.candidate_image_id,
    "request_hash",
    expiredIntentDuringMissingCanonical.request_hash,
    "display_order_key",
    expiredIntentDuringMissingCanonical.display_order_key,
    "execution_token",
    expiredIntentDuringMissingCanonical.execution_token
  );
  const expiredIntentHashDuringMissingCanonical = await redisClient.redis.hgetall(
    liveIntentKey
  );
  await assert.rejects(productionIngestionRepository.convertUploadIntent(
    ingestionCanonical,
    ingestionExecutionToken,
    canonicalCreatedAt + 2
  ), (error) => error?.code === "ingestion_queue_structure_invalid");
  assert.deepEqual(
    await redisClient.redis.hgetall(liveIntentKey),
    expiredIntentHashDuringMissingCanonical,
    "结构异常必须在删除过期 intent 前 fail closed"
  );
  await redisClient.redis.del(liveIntentKey);
  await redisClient.redis.zrem(ingestionTestKeys.owner, ingestionSessionId);
  const balancedOwnerSessionId = ingestionSessionIdentity.createIngestionSessionId(
    ingestionOwner,
    "upload",
    "balanced-display-corruption"
  );
  await redisClient.redis.zadd(
    ingestionTestKeys.owner,
    originalOwnerScore,
    balancedOwnerSessionId
  );
  const balancedMissingCanonicalState =
    await readMissingCanonicalDiscoveryState();
  for (const discover of [
    () => productionIngestionRepository.discoverRunnable(),
    () => productionIngestionRepository.discoverExpired(Number.MAX_SAFE_INTEGER),
    () => productionIngestionRepository.discoverExpiryPage(0)
  ]) {
    await assert.rejects(
      discover(),
      (error) => error?.code === "ingestion_queue_structure_invalid"
    );
    assert.deepEqual(
      await readMissingCanonicalDiscoveryState(),
      balancedMissingCanonicalState,
      "display 仍引用缺失 canonical 时 discovery 必须 fail closed 且零写入"
    );
    assert.deepEqual(
      runtimeAvailability.getRedisOperationalState(),
      operationalBeforeMissingPairStructure,
      "计数平衡的局部队列损坏不得降级全局 Redis operational state"
    );
  }
  await redisClient.redis.zrem(ingestionTestKeys.owner, balancedOwnerSessionId);
  await assert.rejects(productionIngestionRepository.readSession(
    ingestionOwner,
    ingestionSessionId
  ), (error) => error?.code === "ingestion_queue_structure_invalid");
  await assert.rejects(productionIngestionRepository.readSessions(
    ingestionOwner,
    [{ session_id: ingestionSessionId, image_id: ingestionImageId }]
  ), (error) => error?.code === "ingestion_queue_structure_invalid");
  assert.deepEqual(
    await redisClient.redis.hgetall(ingestionTestKeys.metadata),
    originalQueueMetadata,
    "canonical 与对应 owner 成员同时缺失时不得把残留 display 误报为 missing"
  );
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeMissingPairStructure
  );

  await redisClient.redis.del(ingestionTestKeys.metadata);
  await redisClient.redis.set(ingestionTestKeys.metadata, "wrong-type");
  await assert.rejects(productionIngestionRepository.readSession(
    ingestionOwner,
    ingestionSessionId
  ), (error) => error?.code === "ingestion_queue_structure_invalid");
  assert.equal(
    await redisClient.redis.get(ingestionTestKeys.metadata),
    "wrong-type",
    "missing pair read 不得改写 wrong-type metadata"
  );
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeMissingPairStructure
  );
  await redisClient.redis.del(ingestionTestKeys.metadata);
  await redisClient.redis.hset(
    ingestionTestKeys.metadata,
    ...Object.entries(originalQueueMetadata).flat()
  );
  await redisClient.redis.hset(
    ingestionTestKeys.canonical,
    ...Object.entries(originalCanonicalHash).flat()
  );
  await redisClient.redis.zadd(
    ingestionTestKeys.owner,
    originalOwnerScore,
    ingestionSessionId
  );

  const missingDiscoverySessionId = ingestionSessionIdentity.createIngestionSessionId(
    ingestionOwner,
    "upload",
    "missing-derived-canonical"
  );
  const missingDiscoveryKey = ingestionSessionKeys.ingestionCanonicalKey(
    ingestionOwner,
    missingDiscoverySessionId
  );
  await redisClient.redis.zadd(
    ingestionTestKeys.runnable,
    0,
    missingDiscoveryKey
  );
  await redisClient.redis.hset(
    ingestionTestKeys.canonical,
    "unexpected",
    "mixed-discovery-corruption"
  );
  const runnableBeforeMixedDiscoveryFailure = await redisClient.redis.zrange(
    ingestionTestKeys.runnable,
    0,
    -1,
    "WITHSCORES"
  );
  await assert.rejects(productionIngestionRepository.discoverRunnable(),
    (error) => error?.code === "ingestion_queue_structure_invalid");
  assert.deepEqual(
    await redisClient.redis.zrange(
      ingestionTestKeys.runnable,
      0,
      -1,
      "WITHSCORES"
    ),
    runnableBeforeMixedDiscoveryFailure,
    "discovery 必须在整批校验完成后才清理缺失 canonical 的成员"
  );
  await redisClient.redis.hdel(ingestionTestKeys.canonical, "unexpected");
  await ingestionRepository.discoverRunnable();
  assert.equal(
    await redisClient.redis.zscore(ingestionTestKeys.runnable, missingDiscoveryKey),
    null
  );
  await redisClient.redis.zadd(
    ingestionTestKeys.expires,
    0,
    missingDiscoveryKey
  );
  await ingestionRepository.discoverExpired(canonicalCreatedAt + 1);
  assert.equal(
    await redisClient.redis.zscore(ingestionTestKeys.runnable, missingDiscoveryKey),
    null,
    "runnable 指向缺失 canonical 时只清理派生成员"
  );
  assert.equal(
    await redisClient.redis.zscore(ingestionTestKeys.expires, missingDiscoveryKey),
    null,
    "expires 指向缺失 canonical 时只清理派生成员"
  );
  await assert.rejects(ingestionRepository.createUploadIntent({
    ...ingestionIntent,
    request_hash: "b".repeat(64),
    created_at: canonicalCreatedAt + 1
  }), (error) => error?.code === "idempotency_conflict");
  assert.equal(ingestionListenerCalls, 1);
  assert.equal(ingestionAsyncListenerCalls, 1);
  const reusedUpload = await ingestionRepository.convertUploadIntent(
    {
      ...ingestionCanonical,
      image_id: imageTime.createImageId(regeneratedIntentTime.date, 42),
      image_time: regeneratedIntentTime.iso
    },
    ingestionExecutionToken,
    canonicalCreatedAt + 1
  );
  assert.equal(reusedUpload.created, false);
  assert.equal(reusedUpload.session.image_id, convertedUpload.session.image_id);
  assert.equal(ingestionListenerCalls, 1, "幂等 canonical 复用不得发送 semantic 事件");
  assert.equal(ingestionAsyncListenerCalls, 1);
  const reusedViaIntent = await ingestionRepository.createUploadIntent({
    ...ingestionIntent,
    candidate_image_id: imageTime.createImageId(
      regeneratedIntentTime.date,
      43
    ),
    resolved_image_time: regeneratedIntentTime.iso,
    created_at: canonicalCreatedAt + 1
  });
  assert.equal(reusedViaIntent.kind, "canonical");
  assert.equal(reusedViaIntent.session.image_id, convertedUpload.session.image_id);
  assert.equal(ingestionListenerCalls, 1);
  const unchangedUpload = await ingestionRepository.mutateSemantic(
    convertedUpload.session,
    convertedUpload.session.version,
    { ...convertedUpload.session, semantic_hash: "f".repeat(64) },
    canonicalCreatedAt + 2
  );
  assert.equal(unchangedUpload.changed, false);
  assert.equal(unchangedUpload.session.version, 1);
  assert.equal(unchangedUpload.session.discard_at, convertedUpload.session.discard_at);
  assert.equal(ingestionListenerCalls, 1);
  assert.equal(ingestionAsyncListenerCalls, 1);
  const preparingUploadWithoutHash = {
    ...convertedUpload.session,
    status: "preparing",
    phase: "prepare-waiting",
    message: "waiting for normalization admission",
    progress: null,
    execution_token: coreUuid.randomUuidV7(),
    semantic_hash: ""
  };
  const preparingUpload = {
    ...preparingUploadWithoutHash,
    semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
      preparingUploadWithoutHash
    )
  };
  const preparedTransition = await ingestionRepository.mutateSemantic(
    convertedUpload.session,
    convertedUpload.session.version,
    preparingUpload,
    canonicalCreatedAt + 3
  );
  assert.equal(ingestionListenerCalls, 2);
  assert.equal(ingestionAsyncListenerCalls, 2);
  assert.equal(preparedTransition.metadata.waiting, 1);
  assert.equal(preparedTransition.metadata.running, 0);
  const progressUpload = await ingestionRepository.updateProgress(
    preparedTransition.session,
    preparedTransition.session.version,
    { phase: "normalizing", message: "normalizing", progress: 50 },
    canonicalCreatedAt + 4
  );
  assert.equal(
    progressUpload.session.discard_at,
    preparedTransition.session.discard_at
  );
  assert.equal(progressUpload.session.progress_seq, 1);
  assert.equal(progressUpload.metadata.waiting, 0);
  assert.equal(progressUpload.metadata.running, 1);
  assert.equal(ingestionListenerCalls, 3);
  assert.equal(ingestionAsyncListenerCalls, 3);
  const stateBeforeNullProgress = await readActiveSchemaState();
  const operationalBeforeNullProgress = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  await assert.rejects(productionIngestionRepository.updateProgress(
    progressUpload.session,
    progressUpload.session.version,
    null,
    canonicalCreatedAt + 5
  ), (error) => error?.code === "ingestion_queue_structure_invalid");
  assert.deepEqual(
    await readActiveSchemaState(),
    stateBeforeNullProgress,
    "null progress payload 必须在字段解引用前 fail closed"
  );
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeNullProgress,
    "null progress 领域错误不得降级全局 Redis operational state"
  );
  const discardAtBeforeOldHeartbeat = preparedTransition.session.discard_at;
  const oldHeartbeat = await ingestionRepository.heartbeat(
    progressUpload.session,
    progressUpload.session.version,
    canonicalCreatedAt
  );
  assert.equal(oldHeartbeat.session.discard_at, discardAtBeforeOldHeartbeat);
  assert.equal(ingestionListenerCalls, 3);
  assert.equal(ingestionAsyncListenerCalls, 3);
  const heartbeatAt = canonicalCreatedAt + 60_000;
  const extendedHeartbeat = await ingestionRepository.heartbeat(
    progressUpload.session,
    progressUpload.session.version,
    heartbeatAt
  );
  assert.equal(extendedHeartbeat.session.discard_at, heartbeatAt + uploadTtlMs);
  assert.equal(ingestionListenerCalls, 3, "执行心跳不得发布队列事件");
  assert.equal(ingestionAsyncListenerCalls, 3, "执行心跳不得发布异步队列事件");
  assert.equal(
    (await ingestionRepository.readSession(ingestionOwner, ingestionSessionId)).discard_at,
    extendedHeartbeat.session.discard_at,
    "读取 canonical 不得延长逻辑有效期"
  );
  await assert.rejects(ingestionRepository.expireSession(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    discardAtBeforeOldHeartbeat,
    ingestionSessionTransitions.discardedIngestionReceipt(
      extendedHeartbeat.session,
      discardAtBeforeOldHeartbeat
    )
  ), (error) => error?.code === "ingestion_session_not_expired");
  assert.equal(
    (await ingestionRepository.readSession(ingestionOwner, ingestionSessionId)).discard_at,
    extendedHeartbeat.session.discard_at,
    "旧 expiry 候选不得越过已经成功的 execution heartbeat"
  );
  await assert.rejects(ingestionRepository.updateProgress(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    { phase: "expired", message: "expired", progress: 75 },
    extendedHeartbeat.session.discard_at
  ), (error) => error?.code === "ingestion_session_expired");
  const changedImageTimeWithoutHash = {
    ...extendedHeartbeat.session,
    image_time: "2027-08-23T01:02:03.456Z",
    semantic_hash: ""
  };
  await assert.rejects(ingestionRepository.mutateSemantic(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    {
      ...changedImageTimeWithoutHash,
      semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
        changedImageTimeWithoutHash
      )
    },
    heartbeatAt + 1
  ));
  const canonicalBeforeStructureFailure = await ingestionRepository.readSession(
    ingestionOwner,
    ingestionSessionId
  );
  await redisClient.redis.hset(
    ingestionSessionKeys.ingestionQueueMetadataKey(ingestionOwner, "upload"),
    "unfinished",
    "999"
  );
  const operationalStateBeforeDomainFailure = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  await assert.rejects(productionIngestionRepository.snapshot(
    ingestionOwner,
    "upload",
    0,
    10
  ), (error) => error?.code === "ingestion_queue_structure_invalid");
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalStateBeforeDomainFailure,
    "单队列领域错误不得降级全局 Redis operational state"
  );
  await assert.rejects(ingestionRepository.snapshot(
    ingestionOwner,
    "upload",
    0,
    10
  ));
  await assert.rejects(ingestionRepository.mutateSemantic(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    {
      ...extendedHeartbeat.session,
      status: "ready",
      semantic_hash: "b".repeat(64)
    },
    heartbeatAt + 2
  ));
  await assert.rejects(productionIngestionRepository.readSession(
    ingestionOwner,
    ingestionSessionId
  ), (error) => error?.code === "ingestion_queue_structure_invalid");
  assert.equal(ingestionListenerCalls, 3);
  assert.equal(ingestionAsyncListenerCalls, 3);
  await redisClient.redis.hset(ingestionTestKeys.metadata, "unfinished", "1");
  assert.deepEqual(
    await ingestionRepository.readSession(ingestionOwner, ingestionSessionId),
    canonicalBeforeStructureFailure
  );

  const canonicalJsonBeforeCorruption = await redisClient.redis.hget(
    ingestionTestKeys.canonical,
    "snapshot"
  );
  assert.ok(canonicalJsonBeforeCorruption);
  await redisClient.redis.hset(
    ingestionTestKeys.canonical,
    "snapshot",
    "{truncated"
  );
  const operationalStateBeforeBadJson = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  await assert.rejects(productionIngestionRepository.snapshot(
    ingestionOwner,
    "upload",
    0,
    10
  ), (error) => error?.code === "ingestion_queue_structure_invalid");
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalStateBeforeBadJson,
    "队列内坏 JSON 不得降级全局 Redis operational state"
  );
  await redisClient.redis.hset(
    ingestionTestKeys.canonical,
    "snapshot",
    canonicalJsonBeforeCorruption
  );

  const ownerScoreBeforeWrongType = await redisClient.redis.zscore(
    ingestionTestKeys.owner,
    ingestionSessionId
  );
  assert.ok(ownerScoreBeforeWrongType);
  await redisClient.redis.del(ingestionTestKeys.owner);
  await redisClient.redis.set(ingestionTestKeys.owner, "wrong-type");
  const operationalStateBeforeWrongType = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  await assert.rejects(productionIngestionRepository.snapshot(
    ingestionOwner,
    "upload",
    0,
    10
  ), (error) => error?.code === "ingestion_queue_structure_invalid");
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalStateBeforeWrongType,
    "队列内 WRONGTYPE 不得降级全局 Redis operational state"
  );
  await redisClient.redis.del(ingestionTestKeys.owner);
  await redisClient.redis.zadd(
    ingestionTestKeys.owner,
    ownerScoreBeforeWrongType,
    ingestionSessionId
  );

  const displayOrderKeyBeforeWrongType = await redisClient.redis.hget(
    ingestionTestKeys.canonical,
    "display_order_key"
  );
  assert.ok(displayOrderKeyBeforeWrongType);
  assert.equal(
    await redisClient.redis.zscore(
      ingestionTestKeys.display,
      displayOrderKeyBeforeWrongType
    ),
    "0"
  );
  await redisClient.redis.del(ingestionTestKeys.display);
  await redisClient.redis.set(ingestionTestKeys.display, "wrong-type");
  await assert.rejects(productionIngestionRepository.snapshot(
    ingestionOwner,
    "upload",
    0,
    10
  ), (error) => error?.code === "ingestion_queue_structure_invalid");
  await redisClient.redis.del(ingestionTestKeys.display);
  await redisClient.redis.zadd(
    ingestionTestKeys.display,
    0,
    displayOrderKeyBeforeWrongType
  );

  const stateBeforeMalformedMutations = await readIngestionBusinessState();
  await assert.rejects(ingestionRepository.mutateSemantic(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    {
      ...extendedHeartbeat.session,
      raw_size: "1",
      semantic_hash: ""
    },
    heartbeatAt + 3
  ));
  await assert.rejects(ingestionRepository.updateProgress(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    { phase: "invalid", message: "invalid", progress: 101 },
    heartbeatAt + 3
  ));
  assert.deepEqual(
    await readIngestionBusinessState(),
    stateBeforeMalformedMutations,
    "malformed semantic/progress payload 必须在任何 Redis 写入前失败"
  );
  const blockedReady = {
    ...extendedHeartbeat.session,
    status: "ready",
    phase: "ready",
    message: "ready",
    progress: 100,
    execution_token: "",
    semantic_hash: ""
  };
  await redisClient.redis.hset(ingestionTestKeys.metadata, "running", "1.0");
  const readIntegerRegressionState = async () => ({
    ...await readIngestionBusinessState(),
    runnable: await redisClient.redis.zrange(
      ingestionTestKeys.runnable,
      0,
      -1,
      "WITHSCORES"
    ),
    expires: await redisClient.redis.zrange(
      ingestionTestKeys.expires,
      0,
      -1,
      "WITHSCORES"
    )
  });
  const stateWithNonCanonicalInteger = await readIntegerRegressionState();
  const operationalStateBeforeNonCanonicalInteger = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  await assert.rejects(productionIngestionRepository.mutateSemantic(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    blockedReady,
    heartbeatAt + 3
  ), (error) => error?.code === "ingestion_queue_structure_invalid");
  assert.deepEqual(
    await readIntegerRegressionState(),
    stateWithNonCanonicalInteger,
    "非规范整数文本必须在 revision 或任何队列投影写入前失败"
  );
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalStateBeforeNonCanonicalInteger,
    "单队列整数结构错误不得降级全局 Redis operational state"
  );
  await redisClient.redis.hset(ingestionTestKeys.metadata, "running", "1");
  const originalRevision = await redisClient.redis.hget(
    ingestionTestKeys.metadata,
    "revision"
  );
  await redisClient.redis.hset(
    ingestionTestKeys.metadata,
    "revision",
    String(Number.MAX_SAFE_INTEGER)
  );
  const stateAtMaximumRevision = await readIngestionBusinessState();
  await assert.rejects(ingestionRepository.mutateSemantic(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    blockedReady,
    heartbeatAt + 3
  ));
  assert.deepEqual(await readIngestionBusinessState(), stateAtMaximumRevision);
  await redisClient.redis.hset(
    ingestionTestKeys.metadata,
    "revision",
    String(Number.MAX_SAFE_INTEGER + 1)
  );
  const stateAtUnsafeRevision = await readIngestionBusinessState();
  await assert.rejects(ingestionRepository.updateProgress(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    { phase: "blocked", message: "blocked", progress: 99 },
    heartbeatAt + 3
  ));
  assert.deepEqual(await readIngestionBusinessState(), stateAtUnsafeRevision);
  await redisClient.redis.hset(
    ingestionTestKeys.metadata,
    "revision",
    originalRevision
  );
  const stateBeforeWrongTypes = await readIngestionBusinessState();
  await redisClient.redis.set(ingestionTestKeys.runnable, "wrong-type");
  await assert.rejects(ingestionRepository.mutateSemantic(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    blockedReady,
    heartbeatAt + 3
  ));
  await assert.rejects(ingestionRepository.deleteSession(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    heartbeatAt + 3
  ));
  await assert.rejects(ingestionRepository.createUploadIntent({
    ...ingestionIntent,
    created_at: heartbeatAt + 3
  }));
  assert.deepEqual(await readIngestionBusinessState(), stateBeforeWrongTypes);
  assert.equal(await redisClient.redis.get(ingestionTestKeys.runnable), "wrong-type");
  await redisClient.redis.del(ingestionTestKeys.runnable);

  const expiresScore = await redisClient.redis.zscore(
    ingestionTestKeys.expires,
    ingestionTestKeys.canonical
  );
  assert.ok(expiresScore);
  await redisClient.redis.del(ingestionTestKeys.expires);
  await redisClient.redis.set(ingestionTestKeys.expires, "wrong-type");
  await assert.rejects(ingestionRepository.heartbeat(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    heartbeatAt + 4
  ));
  assert.deepEqual(await readIngestionBusinessState(), stateBeforeWrongTypes);
  assert.equal(await redisClient.redis.get(ingestionTestKeys.expires), "wrong-type");
  await redisClient.redis.del(ingestionTestKeys.expires);
  await redisClient.redis.zadd(
    ingestionTestKeys.expires,
    expiresScore,
    ingestionTestKeys.canonical
  );

  const originalCanonicalJson = await redisClient.redis.hget(
    ingestionTestKeys.canonical,
    "snapshot"
  );
  const originalCanonicalValue = JSON.parse(originalCanonicalJson);
  const wrongOrderValue = {
    ...originalCanonicalValue,
    accepted_order: originalCanonicalValue.accepted_order + 1
  };
  await redisClient.redis.hset(
    ingestionTestKeys.canonical,
    "snapshot",
    JSON.stringify(wrongOrderValue),
    "accepted_order",
    String(wrongOrderValue.accepted_order)
  );
  const stateWithWrongOrder = await readIngestionBusinessState();
  await assert.rejects(ingestionRepository.mutateSemantic(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    blockedReady,
    heartbeatAt + 5
  ));
  assert.deepEqual(await readIngestionBusinessState(), stateWithWrongOrder);
  await redisClient.redis.hset(
    ingestionTestKeys.canonical,
    "snapshot",
    originalCanonicalJson,
    "accepted_order",
    String(originalCanonicalValue.accepted_order)
  );

  const wrongStatusValue = { ...originalCanonicalValue, status: "corrupt" };
  await redisClient.redis.hset(
    ingestionTestKeys.canonical,
    "snapshot",
    JSON.stringify(wrongStatusValue),
    "status",
    "corrupt"
  );
  const stateWithWrongStatus = await readIngestionBusinessState();
  await assert.rejects(ingestionRepository.deleteSession(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    heartbeatAt + 6
  ));
  assert.deepEqual(await readIngestionBusinessState(), stateWithWrongStatus);
  await redisClient.redis.hset(
    ingestionTestKeys.canonical,
    "snapshot",
    originalCanonicalJson,
    "status",
    originalCanonicalValue.status
  );

  const preparedManifest = {
    prepared_image_key: "current/prepared-image.webp",
    prepared_thumbnail_key: "current/prepared-thumbnail.webp",
    original_size: 10,
    original_width: 100,
    original_height: 100,
    width: 100,
    height: 100,
    ext: "webp",
    md5: "1".repeat(32),
    prepared_image_sha256: "2".repeat(64),
    prepared_thumbnail_sha256: "3".repeat(64),
    size: 8,
    thumbnail_size: 4,
    quality: 90,
    transcoded: true,
    detected_device: "pc",
    detected_brightness: "dark",
    duplicate_count: 2,
    generation: coreUuid.randomUuidV7()
  };
  const stateBeforeMissingPreparedHashes = await readActiveSchemaState();
  for (const omittedHash of [
    "prepared_image_sha256",
    "prepared_thumbnail_sha256"
  ]) {
    const preparedWithoutHash = { ...preparedManifest };
    delete preparedWithoutHash[omittedHash];
    const missingHashCandidate = {
      ...extendedHeartbeat.session,
      status: "ready",
      phase: "ready",
      message: "missing prepared hash",
      progress: 100,
      execution_token: "",
      prepared: preparedWithoutHash,
      semantic_hash: ""
    };
    const serializedMissingHashCandidate = {
      ...missingHashCandidate,
      semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
        missingHashCandidate
      )
    };
    assert.throws(() => ingestionSessionCodec.parseStoredIngestionSession(
      JSON.stringify(serializedMissingHashCandidate)
    ));
    await assert.rejects(ingestionRepository.mutateSemantic(
      extendedHeartbeat.session,
      extendedHeartbeat.session.version,
      missingHashCandidate,
      heartbeatAt + 9
    ), /INGESTION_QUEUE_STRUCTURE prepared_fields/);
    assert.deepEqual(
      await readActiveSchemaState(),
      stateBeforeMissingPreparedHashes,
      "缺少任一 prepared SHA-256 的 canonical 必须零写入"
    );
  }
  const readyDuplicate = await ingestionRepository.mutateSemantic(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    {
      ...extendedHeartbeat.session,
      status: "ready",
      phase: "ready",
      message: "duplicate decision required",
      progress: 100,
      execution_token: "",
      prepared: preparedManifest,
      semantic_hash: ""
    },
    heartbeatAt + 10
  );
  assert.equal(readyDuplicate.metadata.duplicate_pending, 1);
  assert.equal(readyDuplicate.metadata.ready, 0);
  const readyDecided = await ingestionRepository.mutateSemantic(
    readyDuplicate.session,
    readyDuplicate.session.version,
    {
      ...readyDuplicate.session,
      duplicate_decision: "upload",
      semantic_hash: ""
    },
    heartbeatAt + 11
  );
  assert.equal(readyDecided.metadata.duplicate_pending, 0);
  assert.equal(readyDecided.metadata.ready, 1);
  const commitRequestId = coreUuid.randomUuidV7();
  const committing = await ingestionRepository.mutateSemantic(
    readyDecided.session,
    readyDecided.session.version,
    {
      ...readyDecided.session,
      status: "committing",
      phase: "committing",
      message: "committing",
      progress: null,
      execution_token: coreUuid.randomUuidV7(),
      commit: {
        commit_request_id: commitRequestId,
        commit_intent_hash: "2".repeat(64),
        created_by: ingestionOwner,
        expected_md5: preparedManifest.md5,
        duplicate_decision: "upload",
        metadata: { ...ingestionMetadata, tags: [] },
        final_object_key: imagePaths.storageObjectKey(readyDecided.session.image_id, "webp")
      },
      semantic_hash: ""
    },
    heartbeatAt + 12
  );
  assert.equal(committing.metadata.committing_resolving, 1);
  assert.equal(committing.metadata.resolving, 0);
  assert.ok(Array.isArray(committing.session.metadata.tags));
  assert.ok(Array.isArray(committing.session.commit.metadata.tags));
  const committingRunnableScore = Number(await redisClient.redis.zscore(
    ingestionTestKeys.runnable,
    ingestionTestKeys.canonical
  ));
  assert.ok(
    Number.isSafeInteger(committingRunnableScore) && committingRunnableScore > 0
  );
  const stateBeforeCommittingDelete = await readIngestionBusinessState();
  await assert.rejects(productionIngestionRepository.deleteSession(
    committing.session,
    committing.session.version,
    heartbeatAt + 13
  ), (error) => error?.code === "ingestion_session_state_conflict");
  assert.deepEqual(
    await readIngestionBusinessState(),
    stateBeforeCommittingDelete,
    "committing canonical 不能绕过 irreversible coordinator 被直接删除"
  );
  const resolvingCandidate = ingestionSessionTransitions.semanticIngestionSession(
    committing.session,
    {
      status: "resolving",
      phase: "resolving",
      message: "resolving",
      progress: null
    }
  );
  const resolvingUpload = await ingestionRepository.expireSession(
    committing.session,
    committing.session.version,
    committing.session.discard_at,
    resolvingCandidate
  );
  assert.equal(resolvingUpload.metadata.committing_resolving, 1);
  assert.equal(resolvingUpload.metadata.resolving, 1);
  await redisClient.redis.hdel(ingestionTestKeys.metadata, "resolving");
  await assert.rejects(
    productionIngestionRepository.snapshot(ingestionOwner, "upload", 0, 1),
    (error) => error?.code === "ingestion_queue_structure_invalid",
    "当前 metadata 缺少 resolving 子计数必须 fail closed，不能扫描队列修复"
  );
  await redisClient.redis.hset(ingestionTestKeys.metadata, "resolving", "1");
  assert.ok(
    resolvingUpload.session.discard_at > committing.session.discard_at,
    "过期 committing 进入 resolving 时必须在同一个 Lua 中刷新期限"
  );
  assert.equal(
    await redisClient.redis.zscore(
      ingestionTestKeys.runnable,
      ingestionTestKeys.canonical
    ),
    null
  );
  await assert.rejects(ingestionRepository.expireSession(
    resolvingUpload.session,
    resolvingUpload.session.version,
    committing.session.discard_at,
    ingestionSessionTransitions.semanticIngestionSession(
      resolvingUpload.session,
      { message: "stale expiry must not win" }
    )
  ), (error) => error?.code === "ingestion_session_not_expired");
  const completedReceipt = ingestionCommitCompletion.completedIngestionReceipt(
    resolvingUpload.session,
    heartbeatAt + 14
  );
  let publishedCompletionMutation;
  const completionMutationClockLowerBound = Date.now();
  await ingestionCommitCompletion.publishCompletedReceipt({
    readSession: async () => resolvingUpload.session,
    mutateSemantic: async (...args) => {
      publishedCompletionMutation = args;
      return { changed: true, session: args[2], metadata: null };
    }
  }, resolvingUpload.session, heartbeatAt + 14);
  assert.equal(
    publishedCompletionMutation?.[2]?.completed_at,
    heartbeatAt + 14,
    "完成回执必须保留 PostgreSQL 投影可见时冻结的完成水位"
  );
  assert.ok(
    publishedCompletionMutation?.[3] >= completionMutationClockLowerBound,
    "Redis TTL 变更必须使用发布时钟而非较早的数据库可见水位"
  );
  const stateBeforeInvalidCompletedIdentity = await readActiveSchemaState();
  const operationalBeforeInvalidCompletedIdentity = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  const invalidCompletedIdentities = [
    {
      receipt: { ...completedReceipt, commit_intent_hash: "x" },
      code: "ingestion_queue_structure_invalid"
    },
    {
      receipt: { ...completedReceipt, commit_intent_hash: "3".repeat(64) },
      code: "ingestion_session_state_conflict"
    },
    {
      receipt: {
        ...completedReceipt,
        commit_request_id: coreUuid.randomUuidV7()
      },
      code: "ingestion_session_state_conflict"
    },
    {
      receipt: {
        ...completedReceipt,
        display: {
          ...completedReceipt.display,
          original_width: 0
        }
      },
      code: "ingestion_queue_structure_invalid"
    }
  ];
  assert.throws(() => ingestionSessionCodec.parseStoredIngestionSession(
    JSON.stringify(invalidCompletedIdentities[0].receipt)
  ));
  for (const invalid of invalidCompletedIdentities) {
    await assert.rejects(productionIngestionRepository.mutateSemantic(
      resolvingUpload.session,
      resolvingUpload.session.version,
      invalid.receipt,
      heartbeatAt + 14
    ), (error) => error?.code === invalid.code);
    assert.deepEqual(
      await readActiveSchemaState(),
      stateBeforeInvalidCompletedIdentity,
      "completed receipt 必须绑定冻结的 commit request 与 intent hash"
    );
  }
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeInvalidCompletedIdentity,
    "completed identity 领域错误不得降级全局 Redis operational state"
  );
  const completedUpload = await ingestionRepository.expireSession(
    resolvingUpload.session,
    resolvingUpload.session.version,
    resolvingUpload.session.discard_at,
    completedReceipt
  );
  assert.equal(completedUpload.metadata.completed, 1);
  assert.equal(completedUpload.metadata.unfinished, 0);
  assert.equal(completedUpload.metadata.total, 1);
  const completedReceiptFields = [
    "owner",
    "queue",
    "session_id",
    "image_id",
    "request_hash",
    "commit_request_id",
    "commit_intent_hash",
    "status",
    "version",
    "last_semantic_revision",
    "accepted_at",
    "accepted_order",
    "completed_at",
    "display",
    "discard_at"
  ].sort();
  assert.deepEqual(
    Object.keys(completedUpload.session).sort(),
    completedReceiptFields,
    "completed Redis 收据不得保留 progress_seq、semantic_hash 或活动态字段"
  );
  assert.deepEqual(
    Object.keys(JSON.parse(await redisClient.redis.hget(
      ingestionTestKeys.canonical,
      "snapshot"
    ))).sort(),
    completedReceiptFields
  );
  const metadataBeforeTerminalMutation = completedUpload.metadata;
  await assert.rejects(ingestionRepository.mutateSemantic(
    completedUpload.session,
    completedUpload.session.version,
    completedUpload.session,
    heartbeatAt + 15
  ));
  assert.deepEqual(
    (await ingestionRepository.snapshot(ingestionOwner, "upload", 0, 10)).metadata,
    metadataBeforeTerminalMutation,
    "终态收据不得再走 semantic mutation"
  );
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
      + "theme, ext, md5) VALUES ($1, $2, 'local', $3, 'pc', 'dark', "
      + "'none', 'webp', $4)",
    [
      completedUpload.session.image_id,
      ingestionOwner,
      imagePaths.storageObjectKey(completedUpload.session.image_id, "webp"),
      "9".repeat(32)
    ]
  );
  const completedStatus = await ingestionSessionView.readIngestionStatuses(
    ingestionRepository,
    ingestionOwner,
    [{
      session_id: completedUpload.session.session_id,
      image_id: completedUpload.session.image_id
    }]
  );
  assert.equal(completedStatus[0].status, "completed");
  assert.equal(completedStatus[0].redis_status, "completed");
  assert.deepEqual(
    completedStatus[0].display,
    completedUpload.session.display
  );
  assert.equal(
    completedStatus[0].redis_last_semantic_revision,
    completedUpload.session.last_semantic_revision
  );
  const statusBarrierImageId = coreUuid.randomUuidV7();
  const statusBarrierReceipt = {
    ...completedUpload.session,
    session_id: "B".repeat(43),
    image_id: statusBarrierImageId
  };
  let statusBarrierDeleteAttempted = false;
  const statusBarrierRepository = {
    async readSessions() {
      // With the former Promise.all ordering, the PG lookup has enough time
      // to finish before this simulated completed receipt becomes visible.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await database.pool.query(
        "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
          + "theme, ext, md5) VALUES ($1, $2, 'local', $3, 'pc', 'dark', "
          + "'none', 'webp', $4)",
        [
          statusBarrierImageId,
          ingestionOwner,
          imagePaths.storageObjectKey(statusBarrierImageId, "webp"),
          "7".repeat(32)
        ]
      );
      return [statusBarrierReceipt];
    },
    async deleteSession() {
      statusBarrierDeleteAttempted = true;
    }
  };
  const statusAfterCompletedPublication = await ingestionSessionView
    .readIngestionStatuses(
      statusBarrierRepository,
      ingestionOwner,
      [{
        session_id: statusBarrierReceipt.session_id,
        image_id: statusBarrierImageId
      }]
    );
  assert.equal(statusAfterCompletedPublication[0].status, "completed");
  assert.equal(statusAfterCompletedPublication[0].redis_status, "completed");
  assert.equal(
    statusBarrierDeleteAttempted,
    false,
    "先观察到 Redis completed 后的 PG 查询不得误删有效回执"
  );
  await database.pool.query(
    "DELETE FROM metadata WHERE id=$1",
    [statusBarrierImageId]
  );
  const pgOnlyImageId = coreUuid.randomUuidV7();
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
      + "theme, ext, md5) VALUES ($1, $2, 'local', $3, 'pc', 'dark', "
      + "'none', 'webp', $4)",
    [
      pgOnlyImageId,
      ingestionOwner,
      imagePaths.storageObjectKey(pgOnlyImageId, "webp"),
      "8".repeat(32)
    ]
  );
  const pgOnlyStatus = await ingestionSessionView.readIngestionStatuses(
    ingestionRepository,
    ingestionOwner,
    [{ session_id: "P".repeat(43), image_id: pgOnlyImageId }]
  );
  assert.equal(pgOnlyStatus[0].status, "completed");
  assert.equal(pgOnlyStatus[0].redis_status, "missing");
  await database.pool.query("DELETE FROM metadata WHERE id=$1", [pgOnlyImageId]);
  let actionTokenNow = 1_787_982_000_000;
  const actionTokenExpiresAt = 1_787_983_800_000;
  const actionTokenTokens = new ingestionTokenService.IngestionTokenService({
    rootKey: new Uint8Array(32).fill(73),
    now: () => actionTokenNow
  });
  const actionTokenSession = {
    id: "action-token-session",
    username: "action-owner"
  };
  const actionTokenScope = ingestionActionScope.openIngestionActionScope(
    actionTokenSession,
    "upload",
    () => undefined
  );
  const actionTokenMetadata = {
    owner: actionTokenSession.username,
    queue: "upload",
    revision: 654321,
    last_accepted_order: 123456,
    total: 123456,
    unfinished: 123455,
    waiting: 1234,
    running: 123,
    ready: 123,
    duplicate_pending: 12,
    committing_resolving: 2,
    resolving: 1,
    completed: 1,
    failed: 40
  };
  const actionTokenInternalScope = ingestionActionScope
    .requireIngestionActionScope({
      id: actionTokenScope.id,
      sessionId: actionTokenSession.id,
      owner: actionTokenSession.username,
      queue: "upload"
    });
  const actionTokenToken = ingestionActionScope
    .signIngestionActionWatermark(
      actionTokenInternalScope,
      actionTokenMetadata,
      actionTokenTokens,
      actionTokenNow
    );
  const verifyActionTokenToken = (token, overrides = {}) => (
    ingestionActionScope.verifyIngestionActionWatermark({
      token,
      tokens: actionTokenTokens,
      actionScope: actionTokenScope.id,
      sessionId: actionTokenSession.id,
      owner: actionTokenSession.username,
      queue: "upload",
      ...overrides
    })
  );
  const actionTokenClaims = verifyActionTokenToken(actionTokenToken);
  assert.deepEqual(Object.keys(actionTokenClaims).sort(), [
    "action_scope",
    "captured_queue_revision",
    "expires_at",
    "issued_at",
    "max_accepted_order",
    "owner",
    "purpose",
    "queue",
    "redis_connection_epoch"
  ].sort());
  const {
    purpose: actionTokenPurpose,
    issued_at: actionTokenIssuedAt,
    expires_at: verifiedActionTokenExpiresAt,
    ...actionTokenClaimBody
  } = actionTokenClaims;
  const {
    captured_queue_revision: _removedCapturedRevision,
    ...missingWatermarkClaimBody
  } = actionTokenClaimBody;
  const missingClaimWatermark = actionTokenTokens.sign(
    actionTokenPurpose,
    missingWatermarkClaimBody,
    verifiedActionTokenExpiresAt,
    actionTokenIssuedAt
  );
  assert.throws(
    () => verifyActionTokenToken(missingClaimWatermark),
    (error) => error?.code === "invalid_ingestion_token"
  );
  const wrongEpochWatermark = actionTokenTokens.sign(
    actionTokenPurpose,
    {
      ...actionTokenClaimBody,
      redis_connection_epoch:
        actionTokenClaimBody.redis_connection_epoch + 1
    },
    verifiedActionTokenExpiresAt,
    actionTokenIssuedAt
  );
  assert.throws(
    () => verifyActionTokenToken(wrongEpochWatermark),
    (error) => error?.code === "ingestion_action_scope_stale"
  );
  for (const overrides of [
    { actionScope: "C".repeat(32) },
    { sessionId: "other-watermark-session" },
    { owner: "other-watermark-owner" },
    { queue: "import" }
  ]) {
    assert.throws(
      () => verifyActionTokenToken(actionTokenToken, overrides),
      (error) => error?.code === "ingestion_action_scope_stale"
    );
  }
  const firstActionRequest = {
    queue: "upload",
    action_request_id: "0198d321-1111-7111-8111-111111111111",
    action: "clear_queue",
    action_watermark: actionTokenToken
  };
  const actionTokenResolved = ingestionActionProtocol
    .resolveIngestionQueueActionCursor({
      request: firstActionRequest,
      actionScope: actionTokenScope.id,
      session: actionTokenSession,
      tokens: actionTokenTokens
    });
  const actionTokenContinuation = ingestionActionProtocol
    .signIngestionQueueActionContinuation({
      tokens: actionTokenTokens,
      nextCursor: 123400,
      request: firstActionRequest,
      resolved: actionTokenResolved
    });
  assert.ok(actionTokenContinuation);
  assert.equal(ingestionActionProtocol.resolveIngestionQueueActionCursor({
    request: {
      ...firstActionRequest,
      continuation: actionTokenContinuation
    },
    actionScope: actionTokenScope.id,
    session: actionTokenSession,
    tokens: actionTokenTokens
  }).cursor, 123400);
  const continuationClaims = actionTokenTokens.verify(
    "imageshow/ingestion/action/continuation",
    actionTokenContinuation,
    () => true
  );
  const {
    purpose: continuationPurpose,
    issued_at: continuationIssuedAt,
    expires_at: continuationExpiresAt,
    ...continuationClaimBody
  } = continuationClaims;
  const wrongCapturedRevisionContinuation = actionTokenTokens.sign(
    continuationPurpose,
    {
      ...continuationClaimBody,
      captured_queue_revision:
        continuationClaimBody.captured_queue_revision + 1
    },
    continuationExpiresAt,
    continuationIssuedAt
  );
  assert.throws(() => ingestionActionProtocol.resolveIngestionQueueActionCursor({
    request: {
      ...firstActionRequest,
      continuation: wrongCapturedRevisionContinuation
    },
    actionScope: actionTokenScope.id,
    session: actionTokenSession,
    tokens: actionTokenTokens
  }), (error) => error?.code === "ingestion_action_continuation_invalid");
  actionTokenNow = actionTokenExpiresAt;
  assert.throws(
    () => verifyActionTokenToken(actionTokenToken),
    (error) => error?.code === "invalid_ingestion_token"
  );
  actionTokenScope.close();
  const snapshotTokens = new ingestionTokenService.IngestionTokenService({
    rootKey: new Uint8Array(32).fill(37)
  });
  const snapshotScope = ingestionActionScope.openIngestionActionScope(
    { id: "snapshot-admin-session", username: ingestionOwner },
    "upload",
    () => undefined
  );
  const hydratedCompletedPage = await ingestionQueueSnapshot
    .readStableIngestionQueueSnapshot({
      repository: ingestionRepository,
      tokens: snapshotTokens,
      session: { id: "snapshot-admin-session", username: ingestionOwner },
      actionScope: snapshotScope.id,
      queue: "upload",
      offset: 0,
      limit: 10
    });
  assert.equal(hydratedCompletedPage.items.length, 1);
  assert.equal(hydratedCompletedPage.items[0].status, "completed");
  assert.deepEqual(
    hydratedCompletedPage.items[0].display,
    completedUpload.session.display
  );
  assert.equal(
    hydratedCompletedPage.items[0].completed_item.id,
    completedUpload.session.image_id
  );
  assert.deepEqual({
    total: hydratedCompletedPage.total,
    unfinished: hydratedCompletedPage.unfinished,
    waiting: hydratedCompletedPage.waiting,
    running: hydratedCompletedPage.running,
    ready: hydratedCompletedPage.ready,
    duplicate_pending: hydratedCompletedPage.duplicate_pending,
    committing: hydratedCompletedPage.committing,
    resolving: hydratedCompletedPage.resolving,
    completed: hydratedCompletedPage.completed,
    failed: hydratedCompletedPage.failed
  }, ingestionSessionProjection.presentIngestionQueueSummary(
    completedUpload.metadata
  ), "稳定 snapshot 顶层 summary 必须独立于 action watermark");
  const watermarkClaims = snapshotTokens.verify(
    "imageshow/ingestion/action/watermark",
    hydratedCompletedPage.action_watermark,
    (value) => value.action_scope === snapshotScope.id
      && value.owner === ingestionOwner
      && value.queue === "upload"
  );
  assert.equal(
    watermarkClaims.captured_queue_revision,
    hydratedCompletedPage.revision
  );
  assert.equal(
    watermarkClaims.max_accepted_order,
    completedUpload.metadata.last_accepted_order
  );

  await database.pool.query(
    "DELETE FROM metadata WHERE id=$1",
    [completedUpload.session.image_id]
  );
  const stablePageAfterStaleCleanup = await ingestionQueueSnapshot
    .readStableIngestionQueueSnapshot({
      repository: ingestionRepository,
      tokens: snapshotTokens,
      session: { id: "snapshot-admin-session", username: ingestionOwner },
      actionScope: snapshotScope.id,
      queue: "upload",
      offset: 0,
      limit: 10
    });
  assert.equal(stablePageAfterStaleCleanup.items.length, 0);
  assert.equal(stablePageAfterStaleCleanup.total, 0);
  assert.equal(stablePageAfterStaleCleanup.completed, 0);
  assert.equal(await redisClient.redis.exists(ingestionTestKeys.canonical), 0);
  const metadataOnlyPage = await ingestionQueueSnapshot
    .readStableIngestionQueueSnapshot({
      repository: ingestionRepository,
      tokens: snapshotTokens,
      session: { id: "snapshot-admin-session", username: ingestionOwner },
      actionScope: snapshotScope.id,
      queue: "upload",
      offset: 500,
      limit: 0
    });
  assert.equal(metadataOnlyPage.offset, 500);
  assert.equal(metadataOnlyPage.limit, 0);
  assert.deepEqual(metadataOnlyPage.items, []);
  assert.ok(metadataOnlyPage.action_watermark);
  snapshotScope.close();
  await assert.rejects(ingestionQueueSnapshot.readStableIngestionQueueSnapshot({
    repository: ingestionRepository,
    tokens: snapshotTokens,
    session: { id: "snapshot-admin-session", username: ingestionOwner },
    actionScope: snapshotScope.id,
    queue: "upload",
    offset: 0,
    limit: 10
  }), (error) => error?.code === "ingestion_action_scope_stale");
  assert.equal(
    stablePageAfterStaleCleanup.action_watermark.length
      <= sharedAppConfig.appConfig.ingestionRuntime.tokenMaxBytes,
    true
  );
  assert.ok(
    stablePageAfterStaleCleanup.revision > completedUpload.metadata.revision
  );
  await redisClient.redis.del(
    ingestionTestKeys.owner,
    ingestionTestKeys.metadata
  );
  await redisClient.redis.del(
    ingestionSessionKeys.ingestionUploadIntentKey(
      expiredIntentOwner,
      expiredIntentSessionId
    )
  );

  const importOwner = "current-import-domain-" + randomUUID();
  const importSessionId = ingestionSessionIdentity.createIngestionSessionId(
    importOwner,
    "import",
    "import-ttl"
  );
  const importResolvedTime = imageTime.parseImageTime(
    "2026-08-23T01:02:05.456Z"
  );
  const importImageId = imageTime.createImageId(importResolvedTime.date, 39);
  const importCreatedAt = 5_000;
  const importCanonicalWithoutHash = {
    owner: importOwner,
    queue: "import",
    source_type: "url",
    session_id: importSessionId,
    image_id: importImageId,
    image_time: importResolvedTime.iso,
    request_hash: "d".repeat(64),
    import_download: { url: "https://example.com/current-domain.jpg" },
    metadata: ingestionMetadata,
    storage_slug: "local",
    status: "queued",
    phase: "queued",
    message: "queued",
    progress: null,
    version: 0,
    progress_seq: 0,
    last_semantic_revision: 0,
    accepted_at: 0,
    accepted_order: 0,
    execution_token: "",
    raw_generation: "",
    raw_size: 0,
    discard_at: 0
  };
  const importCanonical = {
    ...importCanonicalWithoutHash,
    semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
      importCanonicalWithoutHash
    )
  };
  const malformedImportOwner = "current-malformed-import-" + randomUUID();
  const malformedImportSessionId = ingestionSessionIdentity.createIngestionSessionId(
    malformedImportOwner,
    "import",
    "malformed-create"
  );
  const malformedImportDisplayOrderKey = displayOrderKey(
    malformedImportSessionId,
    39,
    importCreatedAt
  );
  const malformedImportKeys = ingestionSessionKeys.ingestionSessionKeys(
    malformedImportOwner,
    "import",
    malformedImportSessionId
  );
  const readMalformedImportState = async () => ({
    canonicalType: await redisClient.redis.type(malformedImportKeys.canonical),
    ownerType: await redisClient.redis.type(malformedImportKeys.owner),
    metadataType: await redisClient.redis.type(malformedImportKeys.metadata),
    runnableScore: await redisClient.redis.zscore(
      malformedImportKeys.runnable,
      malformedImportKeys.canonical
    ),
    expiresScore: await redisClient.redis.zscore(
      malformedImportKeys.expires,
      malformedImportKeys.canonical
    ),
    runnableCount: await redisClient.redis.zcard(malformedImportKeys.runnable),
    expiresCount: await redisClient.redis.zcard(malformedImportKeys.expires)
  });
  const malformedImportStateBefore = await readMalformedImportState();
  await assert.rejects(ingestionRepository.acceptImportSession({
    ...importCanonical,
    owner: malformedImportOwner,
    session_id: malformedImportSessionId,
    request_hash: ""
  }, malformedImportDisplayOrderKey, importCreatedAt));
  await assert.rejects(ingestionRepository.acceptImportSession({
    ...importCanonical,
    owner: malformedImportOwner,
    session_id: malformedImportSessionId
  }, malformedImportDisplayOrderKey, Number.NaN));
  const {
    import_download: retainedImportDownload,
    ...importWithoutDownload
  } = importCanonical;
  const malformedImportSchemas = [
    {
      ...importWithoutDownload,
      owner: malformedImportOwner,
      session_id: malformedImportSessionId
    },
    {
      ...importCanonical,
      owner: malformedImportOwner,
      session_id: malformedImportSessionId,
      raw_path: "forbidden/path"
    },
    {
      ...importCanonical,
      owner: malformedImportOwner,
      session_id: malformedImportSessionId,
      import_download: {
        ...importCanonical.import_download,
        response_body: "forbidden"
      }
    },
    {
      ...importCanonical,
      owner: malformedImportOwner,
      session_id: malformedImportSessionId,
      import_download: null
    },
    {
      ...importCanonical,
      owner: malformedImportOwner,
      session_id: malformedImportSessionId,
      metadata: null
    }
  ];
  assert.ok(retainedImportDownload);
  const operationalBeforeMalformedImportSchemas = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  for (const malformed of malformedImportSchemas) {
    assert.throws(() => ingestionSessionCodec.parseStoredIngestionSession(
      JSON.stringify({
        ...malformed,
        version: 1,
        last_semantic_revision: 1,
        accepted_at: importCreatedAt,
        accepted_order: 1,
        discard_at: importCreatedAt + importTtlMs
      })
    ));
    await assert.rejects(productionIngestionRepository.acceptImportSession(
      malformed,
      malformedImportDisplayOrderKey,
      importCreatedAt
    ), (error) => error?.code === "ingestion_queue_structure_invalid");
  }
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeMalformedImportSchemas,
    "import_download/metadata null 必须按队列领域错误处理而不降级全局 Redis"
  );
  assert.deepEqual(
    await readMalformedImportState(),
    malformedImportStateBefore,
    "malformed canonical create 必须在任何 Redis 写入前失败"
  );
  let importListenerCalls = 0;
  ingestionRepository.subscribe(importOwner, "import", () => {
    importListenerCalls += 1;
  });
  const acceptedImport = await ingestionRepository.acceptImportSession(
    importCanonical,
    displayOrderKey(importSessionId, 39, importCreatedAt),
    importCreatedAt
  );
  assert.equal(
    acceptedImport.session.discard_at,
    importCreatedAt + importTtlMs
  );
  assert.equal(importListenerCalls, 1);
  const importTestKeys = ingestionSessionKeys.ingestionSessionKeys(
    importOwner,
    "import",
    importSessionId
  );
  const importSnapshot = await ingestionRepository.snapshot(
    importOwner,
    "import",
    0,
    10
  );
  assert.equal(importSnapshot.items.length, 1);
  assert.equal(
    importSnapshot.items[0].discard_at,
    acceptedImport.session.discard_at,
    "队列快照不得延长 Import 任务的逻辑有效期"
  );

  const discardOrderProbe = async (session, now) => {
    const discarded = await ingestionRepository.mutateSemantic(
      session,
      session.version,
      ingestionSessionTransitions.discardedIngestionReceipt(session, now),
      now
    );
    await ingestionRepository.deleteSession(
      discarded.session,
      discarded.session.version,
      now + 1
    );
  };
  const importOrderOwner = "current-display-order-import-" + randomUUID();
  const olderImportBatchKey = coreUuid.randomUuidV7At(
    new Date(serviceNow + 1_000)
  );
  const newerImportBatchKey = coreUuid.randomUuidV7At(
    new Date(serviceNow + 2_000)
  );
  const importOrderSessions = new Map();
  const acceptImportOrderProbe = async (batchKey, label, position, now) => {
    const sessionId = ingestionSessionIdentity.createIngestionSessionId(
      importOrderOwner,
      "import",
      label + "-" + String(position)
    );
    const resolved = imageTime.parseImageTime(
      "2026-08-23T01:10:" + String(position).padStart(2, "0") + ".456Z"
    );
    const withoutHash = {
      ...importCanonicalWithoutHash,
      owner: importOrderOwner,
      session_id: sessionId,
      image_id: imageTime.createImageId(resolved.date, position),
      image_time: resolved.iso,
      request_hash: createHash("sha256")
        .update(label + "-" + String(position))
        .digest("hex")
    };
    const accepted = await ingestionRepository.acceptImportSession({
      ...withoutHash,
      semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
        withoutHash
      )
    }, ingestionSessionIdentity.createIngestionDisplayOrderKey(
      batchKey,
      position,
      sessionId
    ), now);
    importOrderSessions.set(label + "-" + String(position), accepted.session);
  };
  for (const position of [1, 0]) {
    await acceptImportOrderProbe(
      olderImportBatchKey,
      "older",
      position,
      serviceNow + 3_000 + position
    );
  }
  const scrambledNewerPositions = [5, 11, 2, 8, 0, 10, 4, 7, 1, 9, 3, 6];
  for (const [acceptIndex, position] of scrambledNewerPositions.entries()) {
    await acceptImportOrderProbe(
      newerImportBatchKey,
      "newer",
      position,
      serviceNow + 4_000 + acceptIndex
    );
  }
  const importOrderFirstPage = await ingestionRepository.snapshot(
    importOrderOwner,
    "import",
    0,
    10
  );
  const importOrderSecondPage = await ingestionRepository.snapshot(
    importOrderOwner,
    "import",
    10,
    10
  );
  assert.deepEqual(
    importOrderFirstPage.items.map((item) => item.session_id),
    Array.from({ length: 10 }, (_, position) => (
      importOrderSessions.get("newer-" + String(position)).session_id
    )),
    "新导入批次必须置顶，且第一页严格保持来源 1→N"
  );
  assert.deepEqual(
    importOrderSecondPage.items.map((item) => item.session_id),
    [
      importOrderSessions.get("newer-10").session_id,
      importOrderSessions.get("newer-11").session_id,
      importOrderSessions.get("older-0").session_id,
      importOrderSessions.get("older-1").session_id
    ],
    "批内来源顺序必须跨页稳定，旧批次紧随新批次"
  );
  const externalImportBatchKey = coreUuid.randomUuidV7At(
    new Date(serviceNow + 3_000)
  );
  await acceptImportOrderProbe(
    externalImportBatchKey,
    "external",
    0,
    serviceNow + 18_000
  );
  const currentDocumentPairs = Array.from({ length: 12 }, (_, position) => {
    const session = importOrderSessions.get("newer-" + String(position));
    return {
      session_id: session.session_id,
      image_id: session.image_id
    };
  });
  const filteredImportPage = await ingestionRepository.snapshot(
    importOrderOwner,
    "import",
    0,
    3,
    {
      excludeItems: currentDocumentPairs,
      includeItems: [currentDocumentPairs[0], currentDocumentPairs[11]]
    }
  );
  assert.deepEqual(
    filteredImportPage.items.map((item) => item.session_id),
    [
      importOrderSessions.get("external-0").session_id,
      importOrderSessions.get("older-0").session_id,
      importOrderSessions.get("older-1").session_id,
      importOrderSessions.get("newer-0").session_id,
      importOrderSessions.get("newer-11").session_id
    ],
    "快照须先排除当前文档 pair，再分页并原子补入当前页 canonical"
  );
  assert.deepEqual(filteredImportPage.staleItems, []);
  const staleCurrentDocumentTime = imageTime.parseImageTime(
    "2026-08-23T01:10:59.456Z"
  );
  const staleCurrentDocumentPair = {
    session_id: ingestionSessionIdentity.createIngestionSessionId(
      importOrderOwner,
      "import",
      "stale-current-document"
    ),
    image_id: imageTime.createImageId(staleCurrentDocumentTime.date, 0)
  };
  const mixedActiveAndStalePage = await ingestionRepository.snapshot(
    importOrderOwner,
    "import",
    0,
    3,
    {
      excludeItems: [...currentDocumentPairs, staleCurrentDocumentPair],
      includeItems: [currentDocumentPairs[0], currentDocumentPairs[11]]
    }
  );
  assert.deepEqual(
    mixedActiveAndStalePage.items.map((item) => ({
      session_id: item.session_id,
      image_id: item.image_id
    })),
    filteredImportPage.items.map((item) => ({
      session_id: item.session_id,
      image_id: item.image_id
    })),
    "active / stale 混合排除项不得改变过滤分页或原有顺序"
  );
  assert.deepEqual(
    mixedActiveAndStalePage.staleItems,
    [staleCurrentDocumentPair],
    "canonical、owner 与 display 均已退休的 pair 必须精确返回 stale"
  );
  const displacedDisplaySession = importOrderSessions.get("external-0");
  const displacedDisplayOrderKey = await redisClient.redis.hget(
    ingestionSessionKeys.ingestionCanonicalKey(
      importOrderOwner,
      displacedDisplaySession.session_id
    ),
    "display_order_key"
  );
  assert.equal(typeof displacedDisplayOrderKey, "string");
  const orphanDisplayOrderKey = ingestionSessionIdentity
    .createIngestionDisplayOrderKey(
      coreUuid.randomUuidV7At(new Date(serviceNow + 18_500)),
      0,
      staleCurrentDocumentPair.session_id
    );
  const importDisplayQueueKey = ingestionSessionKeys.ingestionDisplayQueueKey(
    importOrderOwner,
    "import"
  );
  assert.equal(
    await redisClient.redis.zrem(importDisplayQueueKey, displacedDisplayOrderKey),
    1
  );
  assert.equal(
    await redisClient.redis.zadd(importDisplayQueueKey, 0, orphanDisplayOrderKey),
    1
  );
  try {
    await assert.rejects(
      productionIngestionRepository.snapshot(
        importOrderOwner,
        "import",
        0,
        0,
        { excludeItems: [staleCurrentDocumentPair] }
      ),
      (error) => error?.code === "ingestion_queue_structure_invalid",
      "缺失 canonical 的 session 仍在 display 时必须报告真实孤儿投影"
    );
  } finally {
    await redisClient.redis.zrem(importDisplayQueueKey, orphanDisplayOrderKey);
    await redisClient.redis.zadd(
      importDisplayQueueKey,
      0,
      displacedDisplayOrderKey
    );
  }
  const beyondFilteredImportPage = await ingestionRepository.snapshot(
    importOrderOwner,
    "import",
    9_000_000,
    3,
    { excludeItems: currentDocumentPairs }
  );
  assert.deepEqual(
    beyondFilteredImportPage.items,
    [],
    "巨大 offset 必须直接读取目标 rank，不能线性扫描队列前缀"
  );
  const staleIncludedSession = importOrderSessions.get("newer-0");
  await discardOrderProbe(staleIncludedSession, serviceNow + 19_000);
  const staleIncludedImportPage = await ingestionRepository.snapshot(
    importOrderOwner,
    "import",
    0,
    3,
    {
      excludeItems: currentDocumentPairs,
      includeItems: [currentDocumentPairs[0], currentDocumentPairs[11]]
    }
  );
  assert.deepEqual(
    staleIncludedImportPage.items.map((item) => item.session_id),
    [
      importOrderSessions.get("external-0").session_id,
      importOrderSessions.get("older-0").session_id,
      importOrderSessions.get("older-1").session_id,
      importOrderSessions.get("newer-11").session_id
    ],
    "当前文档已释放的旧 pair 必须跳过，不能把正常状态变化误报为结构损坏"
  );
  assert.deepEqual(staleIncludedImportPage.staleItems, [
    currentDocumentPairs[0]
  ]);
  const replacementTime = imageTime.parseImageTime(
    "2026-08-23T01:11:00.456Z"
  );
  const replacementWithoutHash = {
    ...importCanonicalWithoutHash,
    owner: importOrderOwner,
    session_id: staleIncludedSession.session_id,
    image_id: imageTime.createImageId(replacementTime.date, 0),
    image_time: replacementTime.iso,
    request_hash: createHash("sha256")
      .update("newer-0-replacement")
      .digest("hex")
  };
  const replacement = await ingestionRepository.acceptImportSession({
    ...replacementWithoutHash,
    semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
      replacementWithoutHash
    )
  }, ingestionSessionIdentity.createIngestionDisplayOrderKey(
    coreUuid.randomUuidV7At(new Date(serviceNow + 19_500)),
    0,
    staleIncludedSession.session_id
  ), serviceNow + 19_500);
  const replacedIncarnationPage = await ingestionRepository.snapshot(
    importOrderOwner,
    "import",
    0,
    3,
    {
      excludeItems: currentDocumentPairs,
      includeItems: [currentDocumentPairs[0]]
    }
  );
  assert.deepEqual(replacedIncarnationPage.staleItems, [
    currentDocumentPairs[0]
  ]);
  assert.equal(
    replacedIncarnationPage.items.filter((item) => (
      item.session_id === replacement.session.session_id
      && item.image_id === replacement.session.image_id
    )).length,
    1,
    "同 session 新 incarnation 必须进入正常 Server 页且旧 pair 只作为 stale 返回"
  );
  await discardOrderProbe(replacement.session, serviceNow + 19_750);
  const importOrderActionPage = await ingestionRepository.scanAction(
    importOrderOwner,
    "import",
    importOrderSecondPage.metadata.last_accepted_order,
    importOrderSecondPage.metadata.last_accepted_order === 0 ? 0 : 1,
    20
  );
  assert.deepEqual(
    importOrderActionPage.items.map((item) => item.accepted_order),
    importOrderActionPage.items.map((item) => item.accepted_order)
      .toSorted((left, right) => left - right),
    "动作候选必须在冻结水位内按 accepted-order 递增扫描"
  );
  for (const session of importOrderSessions.values()) {
    if (session.session_id === staleIncludedSession.session_id) continue;
    await discardOrderProbe(session, serviceNow + 20_000);
  }

  const staleScaleOwner = "current-stale-scale-" + randomUUID();
  const staleScaleCount = 3_600;
  const staleScaleBatchKey = coreUuid.randomUuidV7At(
    new Date(serviceNow + 21_000)
  );
  const staleScaleTime = imageTime.parseImageTime(
    "2026-08-23T01:30:00.456Z"
  );
  const staleScaleMissingTime = imageTime.parseImageTime(
    "2026-08-23T01:31:00.456Z"
  );
  const staleScaleSeedSessionId = ingestionSessionIdentity
    .createIngestionSessionId(staleScaleOwner, "import", "active-seed");
  const staleScaleKeys = ingestionSessionKeys.ingestionSessionKeys(
    staleScaleOwner,
    "import",
    staleScaleSeedSessionId
  );
  const staleScaleCanonicalKeys = [];
  const staleScaleActiveSessionIds = [];
  const staleScaleMissingPairs = [];
  const staleScaleOwnerMembers = [];
  const staleScaleDisplayMembers = [];
  const staleScaleRunnableMembers = [];
  const staleScaleExpiryMembers = [];
  try {
    const staleScaleFixture = redisClient.redis.pipeline();
    const discardAt = serviceNow + 86_400_000;
    for (let position = 0; position < staleScaleCount; position += 1) {
      const acceptedOrder = position + 1;
      const sessionId = ingestionSessionIdentity.createIngestionSessionId(
        staleScaleOwner,
        "import",
        "active-" + String(position)
      );
      const imageId = imageTime.createImageId(staleScaleTime.date, position);
      const displayKey = ingestionSessionIdentity.createIngestionDisplayOrderKey(
        staleScaleBatchKey,
        position,
        sessionId
      );
      const canonicalKey = ingestionSessionKeys.ingestionCanonicalKey(
        staleScaleOwner,
        sessionId
      );
      const snapshotWithoutHash = {
        ...importCanonicalWithoutHash,
        owner: staleScaleOwner,
        session_id: sessionId,
        image_id: imageId,
        image_time: staleScaleTime.iso,
        request_hash: createHash("sha256")
          .update("stale-scale-active-" + String(position))
          .digest("hex"),
        batch_position: position,
        version: 1,
        last_semantic_revision: acceptedOrder,
        accepted_at: serviceNow + 21_000 + position,
        accepted_order: acceptedOrder,
        discard_at: discardAt
      };
      const snapshot = {
        ...snapshotWithoutHash,
        semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
          snapshotWithoutHash
        )
      };
      staleScaleCanonicalKeys.push(canonicalKey);
      staleScaleActiveSessionIds.push(sessionId);
      staleScaleOwnerMembers.push(acceptedOrder, sessionId);
      staleScaleDisplayMembers.push(0, displayKey);
      staleScaleRunnableMembers.push(acceptedOrder, canonicalKey);
      staleScaleExpiryMembers.push(discardAt, canonicalKey);
      staleScaleMissingPairs.push({
        session_id: ingestionSessionIdentity.createIngestionSessionId(
          staleScaleOwner,
          "import",
          "missing-" + String(position)
        ),
        image_id: imageTime.createImageId(staleScaleMissingTime.date, position)
      });
      staleScaleFixture.hset(
        canonicalKey,
        "snapshot", JSON.stringify(snapshot),
        "session_id", sessionId,
        "image_id", imageId,
        "owner", staleScaleOwner,
        "queue", "import",
        "status", "queued",
        "version", "1",
        "request_hash", snapshot.request_hash,
        "accepted_order", String(acceptedOrder),
        "display_order_key", displayKey,
        "discard_at", String(discardAt),
        "last_semantic_revision", String(acceptedOrder)
      );
    }
    staleScaleFixture.zadd(staleScaleKeys.owner, ...staleScaleOwnerMembers);
    staleScaleFixture.zadd(staleScaleKeys.display, ...staleScaleDisplayMembers);
    staleScaleFixture.zadd(staleScaleKeys.runnable, ...staleScaleRunnableMembers);
    staleScaleFixture.zadd(staleScaleKeys.expires, ...staleScaleExpiryMembers);
    staleScaleFixture.hset(
      staleScaleKeys.metadata,
      "owner", staleScaleOwner,
      "queue", "import",
      "revision", String(staleScaleCount),
      "last_accepted_order", String(staleScaleCount),
      "total", String(staleScaleCount),
      "unfinished", String(staleScaleCount),
      "waiting", String(staleScaleCount),
      "running", "0",
      "ready", "0",
      "duplicate_pending", "0",
      "committing_resolving", "0",
      "resolving", "0",
      "completed", "0",
      "failed", "0"
    );
    const staleScaleFixtureResult = await staleScaleFixture.exec();
    assert.ok(
      staleScaleFixtureResult
        && staleScaleFixtureResult.every(([error]) => error === null),
      "3,600 项合成队列夹具必须完整建立"
    );

    await redisClient.redis.call("CONFIG", "RESETSTAT");
    const staleScaleSnapshot = await productionIngestionRepository.snapshot(
      staleScaleOwner,
      "import",
      0,
      20,
      { excludeItems: staleScaleMissingPairs }
    );
    const staleScaleCommandStats = redisClient.parseRedisInfoFields(
      await redisClient.redis.info("commandstats")
    );
    const staleScaleZscanCalls = Number(
      staleScaleCommandStats.get("cmdstat_zscan")
        ?.split(",", 1)[0]
        ?.replace("calls=", "") ?? "0"
    );
    assert.deepEqual(
      staleScaleSnapshot.items.map((item) => item.session_id),
      staleScaleActiveSessionIds.slice(0, 20),
      "3,600 个 stale exclusion 不得改变非空大队列第一页顺序"
    );
    assert.deepEqual(
      staleScaleSnapshot.staleItems,
      staleScaleMissingPairs,
      "3,600 个已退休 pair 必须按请求顺序精确返回 stale"
    );
    assert.ok(
      staleScaleZscanCalls > 0 && staleScaleZscanCalls <= 64,
      "display ZSET 必须只扫描一遍，实际 ZSCAN 次数："
        + String(staleScaleZscanCalls)
    );
  } finally {
    const staleScaleCleanup = redisClient.redis.pipeline();
    for (
      let offset = 0;
      offset < staleScaleCanonicalKeys.length;
      offset += 250
    ) {
      const keys = staleScaleCanonicalKeys.slice(offset, offset + 250);
      if (keys.length > 0) {
        staleScaleCleanup.zrem(staleScaleKeys.runnable, ...keys);
        staleScaleCleanup.zrem(staleScaleKeys.expires, ...keys);
        staleScaleCleanup.unlink(...keys);
      }
    }
    staleScaleCleanup.unlink(
      staleScaleKeys.owner,
      staleScaleKeys.display,
      staleScaleKeys.metadata
    );
    const staleScaleCleanupResult = await staleScaleCleanup.exec();
    assert.ok(
      staleScaleCleanupResult
        && staleScaleCleanupResult.every(([error]) => error === null),
      "3,600 项合成队列夹具必须完整清理"
    );
  }

  const uploadOrderOwner = "current-display-order-upload-" + randomUUID();
  const uploadOrderBatchKey = coreUuid.randomUuidV7At(
    new Date(serviceNow + 30_000)
  );
  const uploadOrderTime = imageTime.parseImageTime(
    "2026-08-23T01:20:00.456Z"
  );
  const uploadOrderIntents = [];
  for (let position = 0; position < 5; position += 1) {
    const sessionId = ingestionSessionIdentity.createIngestionSessionId(
      uploadOrderOwner,
      "upload",
      "upload-order-" + String(position)
    );
    const requestHash = createHash("sha256")
      .update("upload-order-" + String(position))
      .digest("hex");
    const created = await ingestionRepository.createUploadIntent({
      owner: uploadOrderOwner,
      session_id: sessionId,
      candidate_image_id: imageTime.createImageId(
        uploadOrderTime.date,
        position
      ),
      resolved_image_time: uploadOrderTime.iso,
      request_hash: requestHash,
      display_order_key: ingestionSessionIdentity.createIngestionDisplayOrderKey(
        uploadOrderBatchKey,
        position,
        sessionId
      ),
      batch_position: position,
      metadata: ingestionMetadata,
      storage_slug: "local",
      expected_size: 10,
      max_long_edge: 1_000,
      created_at: serviceNow + 31_000,
      expires_at: 0,
      execution_token: "",
      claim_heartbeat_at: 0
    });
    uploadOrderIntents[position] = created.intent;
  }
  const convertedUploadOrderSessions = [];
  for (const [conversionIndex, position] of [4, 1, 3, 0, 2].entries()) {
    const intent = uploadOrderIntents[position];
    const token = coreUuid.randomUuidV7();
    await ingestionRepository.claimUploadIntent(
      uploadOrderOwner,
      {
        session_id: intent.session_id,
        candidate_image_id: intent.candidate_image_id,
        request_hash: intent.request_hash
      },
      token,
      serviceNow + 32_000 + conversionIndex
    );
    const withoutHash = {
      owner: uploadOrderOwner,
      queue: "upload",
      source_type: "upload",
      session_id: intent.session_id,
      image_id: intent.candidate_image_id,
      image_time: intent.resolved_image_time,
      request_hash: intent.request_hash,
      metadata: intent.metadata,
      storage_slug: intent.storage_slug,
      status: "received",
      phase: "received",
      message: "received",
      progress: 100,
      version: 0,
      progress_seq: 0,
      last_semantic_revision: 0,
      accepted_at: 0,
      accepted_order: 0,
      execution_token: "",
      raw_generation: coreUuid.randomUuidV7(),
      raw_size: intent.expected_size,
      discard_at: 0
    };
    convertedUploadOrderSessions[position] = (
      await ingestionRepository.convertUploadIntent({
        ...withoutHash,
        semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
          withoutHash
        )
      }, token, serviceNow + 33_000 + conversionIndex)
    ).session;
  }
  const uploadOrderSnapshot = await ingestionRepository.snapshot(
    uploadOrderOwner,
    "upload",
    0,
    10
  );
  assert.deepEqual(
    uploadOrderSnapshot.items.map((item) => item.session_id),
    convertedUploadOrderSessions.map((item) => item.session_id),
    "Upload raw 接管完成顺序不得打乱同批来源 1→N"
  );
  for (const session of convertedUploadOrderSessions) {
    await discardOrderProbe(session, serviceNow + 40_000);
  }

  const runnableProbe = async (label, position, createdAt) => {
    const owner = "current-runnable-" + label + "-" + randomUUID();
    const sessionId = ingestionSessionIdentity.createIngestionSessionId(
      owner,
      "import",
      label
    );
    const withoutHash = {
      ...importCanonicalWithoutHash,
      owner,
      session_id: sessionId,
      image_id: imageTime.createImageId(importResolvedTime.date, position),
      request_hash: createHash("sha256").update(label).digest("hex")
    };
    const accepted = await ingestionRepository.acceptImportSession({
      ...withoutHash,
      semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(withoutHash)
    }, displayOrderKey(sessionId, position, createdAt), createdAt);
    return {
      accepted,
      keys: ingestionSessionKeys.ingestionSessionKeys(owner, "import", sessionId)
    };
  };
  const oldRunnableProbes = [];
  for (let index = 0; index < 3; index += 1) {
    oldRunnableProbes.push(await runnableProbe(
      "old-" + String(index),
      100 + index,
      importCreatedAt + 20 + index
    ));
  }
  let runnablePage = await ingestionRepository.discoverRunnablePage(0, 0, 1);
  const frozenRunnableTail = runnablePage.frozenTailScore;
  const frozenRunnableKeys = new Set(
    runnablePage.items.map((item) => item.canonicalKey)
  );
  const newRunnableProbes = [];
  for (let index = 0; index < 3; index += 1) {
    newRunnableProbes.push(await runnableProbe(
      "new-" + String(index),
      110 + index,
      importCreatedAt + 30 + index
    ));
  }
  while (
    runnablePage.scanned
    && runnablePage.lastScannedScore < frozenRunnableTail
  ) {
    runnablePage = await ingestionRepository.discoverRunnablePage(
      runnablePage.lastScannedScore,
      frozenRunnableTail,
      1
    );
    for (const item of runnablePage.items) {
      frozenRunnableKeys.add(item.canonicalKey);
    }
  }
  assert.ok(oldRunnableProbes.every(
    (probe) => frozenRunnableKeys.has(probe.keys.canonical)
  ));
  assert.ok(newRunnableProbes.every(
    (probe) => !frozenRunnableKeys.has(probe.keys.canonical)
  ), "冻结尾部后的低 accepted_order 新 owner 不得把旧任务推出本轮扫描");
  const runnableProbeScores = await Promise.all([
    ...oldRunnableProbes,
    ...newRunnableProbes
  ].map((probe) => redisClient.redis.zscore(
    probe.keys.runnable,
    probe.keys.canonical
  )));
  assert.ok(runnableProbeScores.every((score) => score !== null));
  assert.ok(runnableProbeScores.every((score, index, scores) => (
    index === 0 || Number(score) > Number(scores[index - 1])
  )), "全局 runnable score 必须与各 owner 的 accepted_order 独立递增");
  assert.ok([
    ...oldRunnableProbes,
    ...newRunnableProbes
  ].every((probe) => probe.accepted.session.accepted_order === 1));
  const nextRunnablePassKeys = new Set();
  const runnableScanBatchSize = sharedAppConfig.appConfig.ingestionRuntime
    .ingestionSessionScanBatchSize;
  runnablePage = await ingestionRepository.discoverRunnablePage(
    0,
    0,
    runnableScanBatchSize
  );
  while (true) {
    for (const item of runnablePage.items) {
      nextRunnablePassKeys.add(item.canonicalKey);
    }
    if (
      !runnablePage.scanned
      || runnablePage.lastScannedScore >= runnablePage.frozenTailScore
    ) break;
    runnablePage = await ingestionRepository.discoverRunnablePage(
      runnablePage.lastScannedScore,
      runnablePage.frozenTailScore,
      runnableScanBatchSize
    );
  }
  assert.ok(newRunnableProbes.every(
    (probe) => nextRunnablePassKeys.has(probe.keys.canonical)
  ));
  for (const probe of [...oldRunnableProbes, ...newRunnableProbes]) {
    await redisClient.redis
      .multi()
      .zrem(probe.keys.runnable, probe.keys.canonical)
      .zrem(probe.keys.expires, probe.keys.canonical)
      .del(probe.keys.canonical, probe.keys.owner, probe.keys.metadata)
      .exec();
  }
  await redisClient.redis.zrem(
    importTestKeys.runnable,
    importTestKeys.canonical
  );
  await assert.rejects(ingestionRepository.snapshot(
    importOwner,
    "import",
    0,
    10
  ));
  await redisClient.redis.zadd(
    importTestKeys.runnable,
    acceptedImport.session.accepted_order,
    importTestKeys.canonical
  );
  await redisClient.redis.zrem(
    importTestKeys.expires,
    importTestKeys.canonical
  );
  await assert.rejects(ingestionRepository.snapshot(
    importOwner,
    "import",
    0,
    10
  ));
  await redisClient.redis.zadd(
    importTestKeys.expires,
    acceptedImport.session.discard_at,
    importTestKeys.canonical
  );
  const expiredImportWithoutHash = {
    ...acceptedImport.session,
    status: "failed",
    error: { code: "expired", message: "expired" },
    semantic_hash: ""
  };
  await assert.rejects(ingestionRepository.mutateSemantic(
    acceptedImport.session,
    acceptedImport.session.version,
    {
      ...expiredImportWithoutHash,
      semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
        expiredImportWithoutHash
      )
    },
    acceptedImport.session.discard_at
  ), (error) => error?.code === "ingestion_session_expired");
  const downloadingImport = await ingestionRepository.mutateSemantic(
    acceptedImport.session,
    acceptedImport.session.version,
    {
      ...acceptedImport.session,
      status: "downloading",
      phase: "downloading",
      message: "downloading",
      progress: 0,
      execution_token: coreUuid.randomUuidV7(),
      semantic_hash: ""
    },
    importCreatedAt + 1
  );
  assert.equal(downloadingImport.metadata.waiting, 0);
  assert.equal(downloadingImport.metadata.running, 1);
  assert.equal(
    await redisClient.redis.zscore(
      importTestKeys.runnable,
      importTestKeys.canonical
    ),
    null
  );
  const receivedImport = await ingestionRepository.mutateSemantic(
    downloadingImport.session,
    downloadingImport.session.version,
    {
      ...downloadingImport.session,
      status: "received",
      phase: "received",
      message: "received",
      progress: 100,
      execution_token: "",
      raw_generation: coreUuid.randomUuidV7(),
      raw_size: 10,
      semantic_hash: ""
    },
    importCreatedAt + 2
  );
  assert.equal(receivedImport.metadata.waiting, 1);
  assert.equal(receivedImport.metadata.running, 0);
  const receivedRunnableScore = Number(await redisClient.redis.zscore(
    importTestKeys.runnable,
    importTestKeys.canonical
  ));
  assert.ok(
    Number.isSafeInteger(receivedRunnableScore) && receivedRunnableScore > 0
  );
  const failedImport = await ingestionRepository.mutateSemantic(
    receivedImport.session,
    receivedImport.session.version,
    {
      ...receivedImport.session,
      status: "failed",
      phase: "failed",
      message: "failed",
      progress: null,
      execution_token: "",
      error: { code: "download_failed", message: "failed" },
      semantic_hash: ""
    },
    importCreatedAt + 3
  );
  assert.equal(failedImport.metadata.waiting, 0);
  assert.equal(failedImport.metadata.running, 0);
  assert.equal(failedImport.metadata.failed, 1);
  const retriedImport = await ingestionRepository.mutateSemantic(
    failedImport.session,
    failedImport.session.version,
    {
      ...failedImport.session,
      status: "queued",
      phase: "queued",
      message: "queued again",
      progress: null,
      execution_token: "",
      raw_generation: "",
      raw_size: 0,
      error: undefined,
      semantic_hash: ""
    },
    importCreatedAt + 4
  );
  assert.equal(retriedImport.metadata.waiting, 1);
  assert.equal(retriedImport.metadata.running, 0);
  assert.equal(retriedImport.metadata.failed, 0);
  const discardedImport = await ingestionRepository.expireSession(
    retriedImport.session,
    retriedImport.session.version,
    retriedImport.session.discard_at,
    ingestionSessionTransitions.discardedIngestionReceipt(
      retriedImport.session,
      importCreatedAt + 5
    )
  );
  assert.ok(discardedImport.session);
  assert.equal(discardedImport.session.status, "discarded");
  assert.equal(discardedImport.session.image_time, importResolvedTime.iso);
  const discardedReceiptFields = [
    "owner",
    "queue",
    "session_id",
    "image_id",
    "image_time",
    "request_hash",
    "status",
    "version",
    "last_semantic_revision",
    "accepted_at",
    "accepted_order",
    "discarded_at",
    "discard_at"
  ].sort();
  assert.deepEqual(
    Object.keys(discardedImport.session).sort(),
    discardedReceiptFields,
    "discarded Redis 收据不得保留 progress_seq、semantic_hash 或活动态字段"
  );
  assert.deepEqual(
    Object.keys(JSON.parse(await redisClient.redis.hget(
      importTestKeys.canonical,
      "snapshot"
    ))).sort(),
    discardedReceiptFields
  );
  assert.equal(discardedImport.metadata.total, 0);
  assert.equal(discardedImport.metadata.unfinished, 0);
  assert.equal(await redisClient.redis.zcard(importTestKeys.owner), 0);
  const importEventsBeforeReuse = importListenerCalls;
  const regeneratedImportTime = imageTime.parseImageTime(
    "2026-08-23T01:02:07.456Z"
  );
  const reusedDiscardedImport = await ingestionRepository.acceptImportSession(
    {
      ...importCanonical,
      image_id: imageTime.createImageId(regeneratedImportTime.date, 44),
      image_time: regeneratedImportTime.iso
    },
    displayOrderKey(importSessionId, 39, importCreatedAt),
    importCreatedAt + 6
  );
  assert.equal(reusedDiscardedImport.created, false);
  assert.equal(reusedDiscardedImport.session.image_time, importResolvedTime.iso);
  assert.equal(importListenerCalls, importEventsBeforeReuse);
  await ingestionRepository.expireSession(
    discardedImport.session,
    discardedImport.session.version,
    discardedImport.session.discard_at
  );
  assert.equal(
    importListenerCalls,
    importEventsBeforeReuse,
    "删除 owner 不可见的 discarded tombstone 不得发送事件"
  );
  assert.equal(
    await redisClient.redis.hget(importTestKeys.metadata, "last_accepted_order"),
    String(discardedImport.metadata.last_accepted_order)
  );
  await redisClient.redis.hset(
    importTestKeys.metadata,
    "last_accepted_order",
    String(Number.MAX_SAFE_INTEGER)
  );
  const exhaustedOrderSessionId = ingestionSessionIdentity.createIngestionSessionId(
    importOwner,
    "import",
    "exhausted-order"
  );
  const exhaustedOrderImageId = imageTime.createImageId(
    importResolvedTime.date,
    45
  );
  const exhaustedOrderWithoutHash = {
    ...importCanonicalWithoutHash,
    session_id: exhaustedOrderSessionId,
    image_id: exhaustedOrderImageId,
    request_hash: "6".repeat(64)
  };
  await assert.rejects(ingestionRepository.acceptImportSession({
    ...exhaustedOrderWithoutHash,
    semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
      exhaustedOrderWithoutHash
    )
  }, displayOrderKey(
    exhaustedOrderSessionId,
    45,
    importCreatedAt + 8
  ), importCreatedAt + 8));
  const exhaustedOrderKeys = ingestionSessionKeys.ingestionSessionKeys(
    importOwner,
    "import",
    exhaustedOrderSessionId
  );
  assert.equal(await redisClient.redis.exists(exhaustedOrderKeys.canonical), 0);
  assert.equal(await redisClient.redis.zcard(exhaustedOrderKeys.owner), 0);
  assert.equal(
    await redisClient.redis.hget(importTestKeys.metadata, "last_accepted_order"),
    String(Number.MAX_SAFE_INTEGER)
  );
  await redisClient.redis.del(
    importTestKeys.owner,
    importTestKeys.display,
    importTestKeys.metadata
  );

  const blockedCreateOwner = "current-blocked-create-" + randomUUID();
  const blockedCreateSessionId = ingestionSessionIdentity.createIngestionSessionId(
    blockedCreateOwner,
    "import",
    "wrong-index-type"
  );
  const blockedCreateImageId = imageTime.createImageId(
    importResolvedTime.date,
    40
  );
  const blockedCreateWithoutHash = {
    ...importCanonicalWithoutHash,
    owner: blockedCreateOwner,
    session_id: blockedCreateSessionId,
    image_id: blockedCreateImageId,
    request_hash: "e".repeat(64)
  };
  const blockedCreate = {
    ...blockedCreateWithoutHash,
    semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
      blockedCreateWithoutHash
    )
  };
  await redisClient.redis.set(importTestKeys.expires, "wrong-type");
  await assert.rejects(ingestionRepository.acceptImportSession(
    blockedCreate,
    displayOrderKey(blockedCreateSessionId, 40, importCreatedAt + 8),
    importCreatedAt + 8
  ));
  const blockedCreateKeys = ingestionSessionKeys.ingestionSessionKeys(
    blockedCreateOwner,
    "import",
    blockedCreateSessionId
  );
  assert.equal(await redisClient.redis.exists(blockedCreateKeys.canonical), 0);
  assert.equal(await redisClient.redis.exists(blockedCreateKeys.metadata), 0);
  assert.equal(await redisClient.redis.zcard(blockedCreateKeys.owner), 0);
  assert.equal(await redisClient.redis.get(importTestKeys.expires), "wrong-type");
  await redisClient.redis.del(importTestKeys.expires);

  const commitActor = "current-commit-actor-" + randomUUID();
  const commitSessionId = ingestionSessionIdentity.createIngestionSessionId(
    commitActor,
    "import",
    "real-commit"
  );
  const commitImageTime = imageTime.parseImageTime(
    "2026-08-23T01:02:06.456Z"
  );
  const commitImageId = imageTime.createImageId(commitImageTime.date, 46);
  const commitAcceptedAt = Date.now();
  const commitQueuedWithoutHash = {
    ...importCanonicalWithoutHash,
    owner: commitActor,
    source_type: "weibo",
    session_id: commitSessionId,
    image_id: commitImageId,
    image_time: commitImageTime.iso,
    request_hash: createHash("sha256")
      .update("real-commit-" + commitImageId)
      .digest("hex"),
    import_download: { url: "https://example.com/real-commit.webp" },
    metadata: {
      ...ingestionMetadata,
      title: "real commit actor",
      source: "https://weibo.com/1234567890/PolicyDraft",
      original: "https://submitted.example.com/policy-draft.webp"
    }
  };
  const commitQueued = (await ingestionRepository.acceptImportSession({
    ...commitQueuedWithoutHash,
    semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
      commitQueuedWithoutHash
    )
  }, displayOrderKey(
    commitSessionId,
    46,
    commitAcceptedAt
  ), commitAcceptedAt)).session;
  const commitPreparationToken = coreUuid.randomUuidV7();
  const commitGeneration = coreUuid.randomUuidV7();
  const commitImageKey = ingestionStagingKeys.ingestionStagingImageKey({
    session_id: commitSessionId,
    image_id: commitImageId,
    generation: commitGeneration,
    execution_token: commitPreparationToken
  });
  const commitThumbnailKey = ingestionStagingKeys.ingestionStagingThumbnailKey({
    session_id: commitSessionId,
    image_id: commitImageId,
    generation: commitGeneration,
    execution_token: commitPreparationToken
  });
  const commitImageBody = Buffer.from("current-real-commit-image-" + commitImageId);
  const commitThumbnailBody = Buffer.from(
    "current-real-commit-thumbnail-" + commitImageId
  );
  await objectAccess.writeStorageBuffer(
    "_uploads",
    commitImageKey,
    commitImageBody,
    "image/webp",
    "local"
  );
  await objectAccess.writeStorageBuffer(
    "_uploads",
    commitThumbnailKey,
    commitThumbnailBody,
    "image/webp",
    "local"
  );
  const realPrepared = {
    prepared_image_key: commitImageKey,
    prepared_thumbnail_key: commitThumbnailKey,
    prepared_image_sha256: createHash("sha256")
      .update(commitImageBody)
      .digest("hex"),
    prepared_thumbnail_sha256: createHash("sha256")
      .update(commitThumbnailBody)
      .digest("hex"),
    original_size: commitImageBody.length,
    original_width: 1200,
    original_height: 800,
    width: 1200,
    height: 800,
    ext: "webp",
    md5: createHash("md5").update(commitImageBody).digest("hex"),
    size: commitImageBody.length,
    thumbnail_size: commitThumbnailBody.length,
    quality: 90,
    transcoded: true,
    detected_device: "pc",
    detected_brightness: "dark",
    duplicate_count: 0,
    generation: commitGeneration
  };
  const commitReady = (await ingestionRepository.mutateSemantic(
    commitQueued,
    commitQueued.version,
    ingestionSessionTransitions.semanticIngestionSession(commitQueued, {
      status: "ready",
      phase: "ready",
      message: "ready for real commit",
      progress: 100,
      execution_token: "",
      prepared: realPrepared
    }),
    commitAcceptedAt + 1
  )).session;
  const [directPolicyUpdate] = await ingestionSessionUpdate.updateIngestionSessions(
    ingestionRepository,
    commitActor,
    [{
      session_id: commitReady.session_id,
      image_id: commitReady.image_id,
      expected_version: commitReady.version,
      metadata: {
        ...commitReady.metadata,
        source: "https://weibo.com/1234567890/DirectUpdate",
        original: "https://submitted.example.com/direct-update.webp"
      }
    }]
  );
  assert.equal(directPolicyUpdate.status, "changed");
  const afterDirectPolicyUpdate = await ingestionRepository.readSession(
    commitActor,
    commitSessionId
  );
  const [bulkPolicyUpdate] = await ingestionQueueActionHandlers
    .executeIngestionQueueActionBatch({
      repository: ingestionRepository,
      coordinator: new (
        ingestionIrreversibleCoordinator.IngestionIrreversibleCoordinator
      )(),
      owner: commitActor,
      request: {
        queue: "import",
        action_request_id: coreUuid.randomUuidV7(),
        action: "apply_metadata",
        action_watermark: afterDirectPolicyUpdate.last_semantic_revision,
        metadata: {
          source: "https://weibo.com/1234567890/BulkUpdate",
          original: "https://submitted.example.com/bulk-update.webp"
        }
      },
      sessions: [afterDirectPolicyUpdate],
      capturedRevision: afterDirectPolicyUpdate.last_semantic_revision,
      abortActive: () => {},
      assertScope: () => {}
    });
  assert.equal(bulkPolicyUpdate.status, "changed");
  const commitPolicyReady = await ingestionRepository.readSession(
    commitActor,
    commitSessionId
  );
  const realCommitRequest = {
    session_id: commitSessionId,
    image_id: commitImageId,
    expected_version: commitPolicyReady.version,
    expected_md5: realPrepared.md5,
    commit_request_id: coreUuid.randomUuidV7(),
    duplicate_decision: "upload",
    metadata: {
      ...commitPolicyReady.metadata,
      title: "committed by frozen actor",
      source: "https://weibo.com/1234567890/DirectCommit",
      original: "https://submitted.example.com/direct-commit.webp"
    }
  };
  const staleCommitRequest = {
    ...realCommitRequest,
    image_id: imageTime.createImageId(
      imageTime.parseImageTime("2026-08-23T01:02:08.456Z").date,
      47
    ),
    commit_request_id: coreUuid.randomUuidV7()
  };
  let concurrentCommitReads = 0;
  let releaseConcurrentCommitReads;
  let releaseFirstConcurrentRead;
  let releaseFirstConcurrentMutation;
  const concurrentCommitReadBarrier = new Promise((resolve) => {
    releaseConcurrentCommitReads = resolve;
  });
  const firstConcurrentRead = new Promise((resolve) => {
    releaseFirstConcurrentRead = resolve;
  });
  const firstConcurrentMutation = new Promise((resolve) => {
    releaseFirstConcurrentMutation = resolve;
  });
  const concurrentReadSessions = async (...args) => {
    const result = await ingestionRepository.readSessions(...args);
    concurrentCommitReads += 1;
    if (concurrentCommitReads === 1) releaseFirstConcurrentRead();
    if (concurrentCommitReads === 2) releaseConcurrentCommitReads();
    await concurrentCommitReadBarrier;
    return result;
  };
  const firstConcurrentCommitRepository = {
    readSessions: concurrentReadSessions,
    mutateSemantic: async (...args) => {
      try {
        return await ingestionRepository.mutateSemantic(...args);
      } finally {
        releaseFirstConcurrentMutation();
      }
    }
  };
  const secondConcurrentCommitRepository = {
    readSessions: concurrentReadSessions,
    mutateSemantic: async (...args) => {
      await firstConcurrentMutation;
      return ingestionRepository.mutateSemantic(...args);
    }
  };
  let overlappingCommitResults;
  await runtimeConfigStore.updateRuntimeConfig({
    import: { keep_original_link: ["url"] },
    weibo: { source_enabled: false }
  });
  try {
    const firstConcurrentCommit = ingestionCommitIntent
      .acceptIngestionCommitIntents(
        firstConcurrentCommitRepository,
        commitActor,
        [realCommitRequest]
      );
    await firstConcurrentRead;
    await runtimeConfigStore.updateRuntimeConfig({
      import: { keep_original_link: ["url", "jsonl", "weibo"] },
      weibo: { source_enabled: true }
    });
    const secondConcurrentCommit = ingestionCommitIntent
      .acceptIngestionCommitIntents(
        secondConcurrentCommitRepository,
        commitActor,
        [realCommitRequest]
      );
    overlappingCommitResults = await Promise.all([
      firstConcurrentCommit,
      secondConcurrentCommit
    ]);
  } finally {
    await runtimeConfigStore.updateRuntimeConfig({
      import: {
        keep_original_link: originalRuntimeConfig.import.keep_original_link
      },
      weibo: {
        source_enabled: originalRuntimeConfig.weibo.source_enabled
      }
    });
  }
  assert.deepEqual(
    overlappingCommitResults.map(([result]) => result.status),
    ["accepted", "accepted"],
    "重叠的相同提交意图必须在 CAS 冲突后收敛为已受理"
  );
  const realCommitAccepted = await ingestionCommitIntent.acceptIngestionCommitIntents(
    ingestionRepository,
    commitActor,
    [staleCommitRequest, realCommitRequest]
  );
  assert.equal(realCommitAccepted[0].status, "failed");
  assert.equal(realCommitAccepted[0].code, "ingestion_incarnation_conflict");
  assert.equal(realCommitAccepted[1].status, "accepted");
  const firstFrozenCommitSession = await ingestionRepository.readSession(
    commitActor,
    commitSessionId
  );
  assert.equal(firstFrozenCommitSession.status, "committing");
  assert.equal(firstFrozenCommitSession.commit.created_by, commitActor);
  assert.equal(firstFrozenCommitSession.commit.metadata.source, "");
  assert.equal(firstFrozenCommitSession.commit.metadata.original, "");
  const [controlledFieldReplay] = await ingestionCommitIntent
    .acceptIngestionCommitIntents(ingestionRepository, commitActor, [{
      ...realCommitRequest,
      metadata: {
        ...realCommitRequest.metadata,
        source: "https://weibo.com/1234567890/LateReplay",
        original: "https://submitted.example.com/late-replay.webp"
      }
    }]);
  assert.equal(controlledFieldReplay.status, "accepted");
  const [changedTitleReplay] = await ingestionCommitIntent
    .acceptIngestionCommitIntents(ingestionRepository, commitActor, [{
      ...realCommitRequest,
      metadata: {
        ...realCommitRequest.metadata,
        title: "conflicting replay title"
      }
    }]);
  assert.equal(changedTitleReplay.status, "failed");
  assert.equal(changedTitleReplay.code, "ingestion_commit_intent_conflict");
  const failedCommitSession = (await ingestionRepository.mutateSemantic(
    firstFrozenCommitSession,
    firstFrozenCommitSession.version,
    ingestionSessionTransitions.failedIngestionSession(
      firstFrozenCommitSession,
      new Error("retryable commit failure")
    )
  )).session;
  const retriedCommit = await ingestionCommitIntent.acceptIngestionCommitIntents(
    ingestionRepository,
    commitActor,
    [{ ...realCommitRequest, expected_version: failedCommitSession.version }]
  );
  assert.equal(retriedCommit[0].status, "accepted");
  assert.ok(retriedCommit[0].version > failedCommitSession.version);
  const frozenCommitSession = await ingestionRepository.readSession(
    commitActor,
    commitSessionId
  );
  assert.equal(frozenCommitSession.status, "committing");
  assert.equal(
    frozenCommitSession.commit.commit_request_id,
    realCommitRequest.commit_request_id,
    "提交失败重试必须复用已经冻结的意图"
  );
  assert.equal(frozenCommitSession.commit.created_by, commitActor);
  const realCommitCoordinator = new (
    ingestionIrreversibleCoordinator.IngestionIrreversibleCoordinator
  )();
  const committedObjectKey = frozenCommitSession.commit.final_object_key;
  const committedObjectPrefix = "full";
  const committedThumbnailKey = imagePaths.thumbnailObjectKey(
    committedObjectKey
  );
  const commitStorageAccess = await registry.resolveStorageAccess("local");
  const originalCommitCopy = commitStorageAccess.driver.copy.bind(
    commitStorageAccess.driver
  );
  let commitCopyCalls = 0;
  commitStorageAccess.driver.copy = async (...args) => {
    commitCopyCalls += 1;
    return originalCommitCopy(...args);
  };
  const preExistingConflictBody = Buffer.from(
    "unowned-formal-conflict-" + commitImageId
  );
  await commitStorageAccess.driver.writeBuffer(
    committedObjectPrefix,
    committedObjectKey,
    preExistingConflictBody,
    "image/webp"
  );
  const originalCommitExists = commitStorageAccess.driver.exists.bind(
    commitStorageAccess.driver
  );
  let siblingPreflightStarted = false;
  let siblingPreflightAborted = false;
  let siblingPreflightDrained = false;
  commitStorageAccess.driver.exists = async (prefix, key, options) => {
    if (prefix === "thumbs" && key === committedThumbnailKey) {
      siblingPreflightStarted = true;
      const preflightSignal = options?.signal;
      await new Promise((_, reject) => {
        const rejectAfterDrain = () => {
          siblingPreflightAborted = true;
          setTimeout(() => {
            siblingPreflightDrained = true;
            reject(preflightSignal?.reason ?? new Error("preflight aborted"));
          }, 10);
        };
        if (preflightSignal?.aborted) rejectAfterDrain();
        else preflightSignal?.addEventListener("abort", rejectAfterDrain, {
          once: true
        });
      });
    }
    return originalCommitExists(prefix, key, options);
  };
  try {
    await assert.rejects(
      ingestionCommitWorker.commitIngestionSessionSnapshot(
        ingestionRepository,
        realCommitCoordinator,
        frozenCommitSession,
        new AbortController().signal
      ),
      (error) => error?.code === "storage_object_conflict"
    );
  } finally {
    commitStorageAccess.driver.exists = originalCommitExists;
  }
  assert.equal(siblingPreflightStarted, true);
  assert.equal(siblingPreflightAborted, true);
  assert.equal(
    siblingPreflightDrained,
    true,
    "任一正式目标冲突时必须取消并排空另一条摘要读取后再释放锁"
  );
  assert.equal(commitCopyCalls, 0);
  assert.equal(Number((await database.pool.query(
    "SELECT count(*)::int AS count FROM background_job "
      + "WHERE type='move.cleanup' AND target_id=$1 "
      + "AND payload->>'reason'=$2",
    [commitImageId, "ingestion_commit_candidate_guard"]
  )).rows[0]?.count), 0, "不匹配的预存正式对象不得被 guard 接管");
  assert.deepEqual(
    await commitStorageAccess.driver.readBuffer(
      committedObjectPrefix,
      committedObjectKey
    ),
    preExistingConflictBody,
    "提交冲突不得删除本次从未创建或采用的正式对象"
  );
  await removeDriverObject(
    commitStorageAccess.driver,
    committedObjectPrefix,
    committedObjectKey
  );
  const originalGuardQuery = database.pool.query.bind(database.pool);
  const guardRegistrationFailure = new Error(
    "injected ingestion candidate guard registration failure"
  );
  database.pool.query = async (query, ...args) => {
    const sql = String(query);
    if (
      sql.includes("INSERT INTO background_job(")
      && sql.includes("jsonb_to_recordset")
    ) {
      throw guardRegistrationFailure;
    }
    return originalGuardQuery(query, ...args);
  };
  try {
    await assert.rejects(
      ingestionCommitWorker.commitIngestionSessionSnapshot(
        ingestionRepository,
        realCommitCoordinator,
        frozenCommitSession,
        new AbortController().signal
      ),
      (error) => error === guardRegistrationFailure
    );
  } finally {
    database.pool.query = originalGuardQuery;
  }
  assert.equal(commitCopyCalls, 0, "候选 guard 未落库前不得开始正式复制");
  const conflictingCommitActor = "current-conflicting-actor-" + randomUUID();
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, "
      + "brightness, theme, ext, md5, width, height, image_size, "
      + "thumbnail_size, image_time, title) VALUES "
      + "($1,$2,'local',$3,'pc','dark','none','webp',$4,1200,800,$5,$6,$7,$8)",
    [
      commitImageId,
      conflictingCommitActor,
      committedObjectKey,
      realPrepared.md5,
      commitImageBody.length,
      commitThumbnailBody.length,
      commitImageTime.iso,
      "conflicting owner"
    ]
  );
  let commitGuardJob;
  try {
    await assert.rejects(
      ingestionCommitWorker.commitIngestionSessionSnapshot(
        ingestionRepository,
        realCommitCoordinator,
        frozenCommitSession,
        new AbortController().signal
      ),
      (error) => error?.code === "ingestion_image_owner_conflict"
    );
    assert.equal(commitCopyCalls, 2, "guard 成功后 full/thumb 才能开始复制");
    assert.equal(
      (await database.pool.query(
        "SELECT created_by FROM metadata WHERE id=$1",
        [commitImageId]
      )).rows[0]?.created_by,
      conflictingCommitActor,
      "不同 owner 的既有正式图片不得被内容接入提交接管"
    );
    commitGuardJob = (await database.pool.query(
      "SELECT * FROM background_job WHERE type='move.cleanup' "
        + "AND target_id=$1 AND payload->>'reason'=$2",
      [commitImageId, "ingestion_commit_candidate_guard"]
    )).rows[0];
    assert.ok(commitGuardJob, "复制前必须已经持久化正式候选 guard");
    assert.match(commitGuardJob.payload.guard_token, /^[0-9a-f-]{36}$/i);
    const commitFullCandidateKey = committedObjectKey
      + ".candidate-" + commitGuardJob.payload.guard_token;
    const commitThumbnailCandidateKey = committedThumbnailKey
      + ".candidate-" + commitGuardJob.payload.guard_token;
    assert.deepEqual(
      commitGuardJob.payload.objects.map(({ prefix, key }) => ({ prefix, key })),
      [
        { prefix: committedObjectPrefix, key: committedObjectKey },
        { prefix: committedObjectPrefix, key: commitFullCandidateKey },
        { prefix: "thumbs", key: committedThumbnailKey },
        { prefix: "thumbs", key: commitThumbnailCandidateKey }
      ]
    );
    await database.pool.query(
      "DELETE FROM metadata WHERE id=$1",
      [commitImageId]
    );
    await commitStorageAccess.driver.writeBuffer(
      committedObjectPrefix,
      commitFullCandidateKey,
      Buffer.from("simulated-local-copy-crash"),
      "image/webp"
    );
    commitGuardJob = (await database.pool.query(
      "UPDATE background_job SET status='running', execution_token=$2 "
        + "WHERE id=$1 RETURNING *",
      [commitGuardJob.id, randomUUID()]
    )).rows[0];
    await cleanupJob.handleMoveCleanupJob(
      commitGuardJob,
      new AbortController().signal
    );
    assert.equal(
      await objectAccess.storageObjectExists(
        committedObjectPrefix,
        committedObjectKey,
        "local"
      ),
      false,
      "PG 失败后 guard 必须删除未引用 full 候选"
    );
    assert.equal(
      await objectAccess.storageObjectExists(
        "thumbs",
        committedThumbnailKey,
        "local"
      ),
      false,
      "PG 失败后 guard 必须删除未引用 thumbnail 候选"
    );
    assert.equal(
      await objectAccess.storageObjectExists(
        committedObjectPrefix,
        commitFullCandidateKey,
        "local"
      ),
      false,
      "guard 必须清理 local 原子复制崩溃候选"
    );
    await assert.rejects(
      ingestionCommitWorker.commitIngestionSessionSnapshot(
        ingestionRepository,
        realCommitCoordinator,
        frozenCommitSession,
        new AbortController().signal
      ),
      (error) => error?.code === "storage_object_cleanup_pending"
    );
    assert.equal(
      commitCopyCalls,
      2,
      "旧 guard 未收口时不得旁路其删除租约"
    );
    await database.pool.query(
      "UPDATE background_job SET status='succeeded' WHERE id=$1",
      [commitGuardJob.id]
    );
    await ingestionCommitWorker.commitIngestionSessionSnapshot(
      ingestionRepository,
      realCommitCoordinator,
      frozenCommitSession,
      new AbortController().signal
    );
    assert.equal(commitCopyCalls, 4, "同一 guard 只能放行持锁的本次重试");
    let retriedCommitGuardJob = (await database.pool.query(
      "SELECT * FROM background_job WHERE type='move.cleanup' "
        + "AND target_id=$1 AND payload->>'reason'=$2 "
        + "AND status='pending' ORDER BY created_at DESC LIMIT 1",
      [commitImageId, "ingestion_commit_candidate_guard"]
    )).rows[0];
    assert.ok(retriedCommitGuardJob);
    assert.notEqual(
      retriedCommitGuardJob.payload.guard_token,
      commitGuardJob.payload.guard_token,
      "每次复制尝试必须只旁路本次新建 guard"
    );
    const retriedThumbnailCandidateKey = committedThumbnailKey
      + ".candidate-" + retriedCommitGuardJob.payload.guard_token;
    await commitStorageAccess.driver.writeBuffer(
      "thumbs",
      retriedThumbnailCandidateKey,
      Buffer.from("simulated-post-commit-local-candidate"),
      "image/webp"
    );
    retriedCommitGuardJob = (await database.pool.query(
      "UPDATE background_job SET status='running', execution_token=$2 "
        + "WHERE id=$1 RETURNING *",
      [retriedCommitGuardJob.id, randomUUID()]
    )).rows[0];
    await cleanupJob.handleMoveCleanupJob(
      retriedCommitGuardJob,
      new AbortController().signal
    );
    assert.equal(
      await objectAccess.storageObjectExists(
        committedObjectPrefix,
        committedObjectKey,
        "local"
      ),
      true,
      "PG 引用建立后 guard 必须永久保留正式对象"
    );
    assert.equal(
      await objectAccess.storageObjectExists(
        "thumbs",
        committedThumbnailKey,
        "local"
      ),
      true,
      "PG 引用建立后 guard 必须永久保留正式缩略图"
    );
    assert.equal(
      await objectAccess.storageObjectExists(
        "thumbs",
        retriedThumbnailCandidateKey,
        "local"
      ),
      false,
      "PG 正式引用不应保留 local 原子复制临时候选"
    );
    assert.equal(
      await jobs.markBackgroundJobSucceeded(retriedCommitGuardJob),
      true
    );
  } finally {
    commitStorageAccess.driver.copy = originalCommitCopy;
  }
  const committedActorRow = (await database.pool.query(
    "SELECT created_by, image_time, title, source, original FROM metadata WHERE id=$1",
    [commitImageId]
  )).rows[0];
  assert.deepEqual(committedActorRow, {
    created_by: commitActor,
    image_time: commitImageTime.date,
    title: "committed by frozen actor",
    source: "",
    original: ""
  });
  const completedCommitRetry = await ingestionCommitIntent.acceptIngestionCommitIntents(
    ingestionRepository,
    commitActor,
    [realCommitRequest]
  );
  assert.equal(completedCommitRetry[0].status, "completed");
  assert.equal(completedCommitRetry[0].completed_item.id, commitImageId);
  assert.equal(
    await objectAccess.storageObjectExists(
      "_uploads",
      commitImageKey,
      "local"
    ),
    false,
    "PostgreSQL 提交后必须清理精确 staging 图片"
  );
  assert.equal(
    await objectAccess.storageObjectExists(
      "_uploads",
      commitThumbnailKey,
      "local"
    ),
    false,
    "PostgreSQL 提交后必须清理精确 staging 缩略图"
  );
  const completedCommitReceipt = await ingestionRepository.readSession(
    commitActor,
    commitSessionId
  );
  assert.equal(completedCommitReceipt.status, "completed");
  await ingestionRepository.deleteSession(
    completedCommitReceipt,
    completedCommitReceipt.version,
    Date.now()
  );
  const commitQueueKeys = ingestionSessionKeys.ingestionSessionKeys(
    commitActor,
    "import",
    commitSessionId
  );
  await redisClient.redis.del(
    commitQueueKeys.owner,
    commitQueueKeys.display,
    commitQueueKeys.metadata
  );
  await database.pool.query("DELETE FROM metadata WHERE id=$1", [commitImageId]);
  await database.pool.query(
    "DELETE FROM background_job WHERE type='move.cleanup' "
      + "AND target_id=$1 AND payload->>'reason'=$2",
    [commitImageId, "ingestion_commit_candidate_guard"]
  );
  objectAccess.assertStorageRemovalResults(
    await objectAccess.removeStorageObjectsAndConfirm([
      {
        prefix: committedObjectPrefix,
        key: committedObjectKey,
        storageSlug: "local"
      },
      {
        prefix: "thumbs",
        key: committedThumbnailKey,
        storageSlug: "local"
      }
    ])
  );

  const actionOwner = "current-queue-action-" + randomUUID();
  const actionSession = { id: "queue-action-session", username: actionOwner };
  let actionPosition = 200;
  const createActionReadySession = async (label, makeReady = true) => {
    const sessionId = ingestionSessionIdentity.createIngestionSessionId(
      actionOwner,
      "import",
      label
    );
    const resolved = imageTime.parseImageTime(
      "2026-08-23T02:03:" + String(actionPosition % 60).padStart(2, "0") + ".456Z"
    );
    const imageId = imageTime.createImageId(resolved.date, actionPosition % 4096);
    const batchPosition = actionPosition % 4096;
    actionPosition += 1;
    const withoutHash = {
      ...importCanonicalWithoutHash,
      owner: actionOwner,
      session_id: sessionId,
      image_id: imageId,
      image_time: resolved.iso,
      request_hash: createHash("sha256").update(label).digest("hex"),
      import_download: { url: "https://example.com/action-" + label + ".webp" },
      metadata: { ...ingestionMetadata, title: label }
    };
    const acceptedAt = Date.now();
    const queued = (await ingestionRepository.acceptImportSession({
      ...withoutHash,
      semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
        withoutHash
      )
    }, displayOrderKey(
      sessionId,
      batchPosition,
      acceptedAt
    ), acceptedAt)).session;
    if (!makeReady) return queued;
    const generation = coreUuid.randomUuidV7();
    const executionToken = coreUuid.randomUuidV7();
    const prepared = {
      ...realPrepared,
      prepared_image_key: ingestionStagingKeys.ingestionStagingImageKey({
        session_id: sessionId,
        image_id: imageId,
        generation,
        execution_token: executionToken
      }),
      prepared_thumbnail_key: ingestionStagingKeys.ingestionStagingThumbnailKey({
        session_id: sessionId,
        image_id: imageId,
        generation,
        execution_token: executionToken
      }),
      md5: createHash("md5").update(label).digest("hex"),
      generation
    };
    return (await ingestionRepository.mutateSemantic(
      queued,
      queued.version,
      ingestionSessionTransitions.semanticIngestionSession(queued, {
        status: "ready",
        phase: "ready",
        message: "ready",
        progress: 100,
        execution_token: "",
        prepared
      })
    )).session;
  };
  const actionTokens = new ingestionTokenService.IngestionTokenService({
    rootKey: new Uint8Array(32).fill(83)
  });
  const actionScope = ingestionActionScope.openIngestionActionScope(
    actionSession,
    "import",
    () => undefined
  );
  const actionFirst = await createActionReadySession("first");
  const actionSecond = await createActionReadySession("second");
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, "
      + "brightness, theme, ext, md5, status) VALUES "
      + "($1,$2,'local',$3,'pc','dark','none','webp',$4,'ready')",
    [
      actionFirst.image_id,
      actionOwner,
      imagePaths.storageObjectKey(actionFirst.image_id, "webp"),
      actionFirst.prepared.md5
    ]
  );
  const activePgStatus = await ingestionSessionView.readIngestionStatuses(
    ingestionRepository,
    actionOwner,
    [{
      session_id: actionFirst.session_id,
      image_id: actionFirst.image_id
    }]
  );
  assert.equal(activePgStatus[0].status, "completed");
  assert.equal(activePgStatus[0].redis_status, "active");
  assert.equal(
    activePgStatus[0].redis_last_semantic_revision,
    actionFirst.last_semantic_revision
  );
  await database.pool.query(
    "DELETE FROM metadata WHERE id=$1",
    [actionFirst.image_id]
  );
  const actionPage = await ingestionQueueSnapshot.readStableIngestionQueueSnapshot({
    repository: ingestionRepository,
    tokens: actionTokens,
    session: actionSession,
    actionScope: actionScope.id,
    queue: "import",
    offset: 0,
    limit: 10
  });
  const ascendingActionAfterFrozenWatermark = await createActionReadySession(
    "after-frozen-watermark"
  );
  assert.ok(
    ascendingActionAfterFrozenWatermark.accepted_order
      > actionPage.last_accepted_order,
    "冻结水位后新增任务必须取得更大的 accepted_order"
  );
  const limitedActionRepository = {
    scanAction: (owner, queue, maximumOrder, cursor) => (
      ingestionRepository.scanAction(owner, queue, maximumOrder, cursor, 1)
    ),
    readSession: (...args) => ingestionRepository.readSession(...args),
    mutateSemantic: (...args) => ingestionRepository.mutateSemantic(...args)
  };
  const applyActionRequest = {
    queue: "import",
    action_request_id: coreUuid.randomUuidV7(),
    action: "apply_metadata",
    action_watermark: actionPage.action_watermark,
    metadata: { title: "bounded action" }
  };
  const runAction = (repository, request) => ingestionQueueAction
    .runIngestionQueueAction({
      repository,
      coordinator: new (
        ingestionIrreversibleCoordinator.IngestionIrreversibleCoordinator
      )(),
      tokens: actionTokens,
      session: actionSession,
      actionScope: actionScope.id,
      request,
      abortActive: () => undefined
    });
  const firstActionBatch = await runAction(
    limitedActionRepository,
    applyActionRequest
  );
  assert.equal(firstActionBatch.processed, 1);
  assert.equal(
    firstActionBatch.changed,
    1,
    JSON.stringify(firstActionBatch)
  );
  assert.ok(firstActionBatch.continuation);
  assert.equal(firstActionBatch.items[0].session_id, actionFirst.session_id);
  const initialActionCursor = ingestionActionProtocol
    .resolveIngestionQueueActionCursor({
      request: applyActionRequest,
      actionScope: actionScope.id,
      session: actionSession,
      tokens: actionTokens
    });
  const continuedActionCursor = ingestionActionProtocol
    .resolveIngestionQueueActionCursor({
      request: {
        ...applyActionRequest,
        continuation: firstActionBatch.continuation
      },
      actionScope: actionScope.id,
      session: actionSession,
      tokens: actionTokens
    });
  assert.ok(continuedActionCursor.cursor > initialActionCursor.cursor);
  assert.ok(
    continuedActionCursor.cursor
      <= continuedActionCursor.watermark.max_accepted_order,
    "continuation 必须在冻结水位内单调向上推进"
  );
  const actionFirstAfterFirst = await ingestionRepository.readSession(
    actionOwner,
    actionFirst.session_id
  );
  await assert.rejects(runAction(limitedActionRepository, {
    ...applyActionRequest,
    continuation: firstActionBatch.continuation,
    metadata: { title: "tampered action" }
  }), (error) => error?.code === "ingestion_action_continuation_invalid");
  const editAfterLostResponse = await ingestionSessionUpdate.updateIngestionSessions(
    ingestionRepository,
    actionOwner,
    [{
      session_id: actionFirstAfterFirst.session_id,
      image_id: actionFirstAfterFirst.image_id,
      expected_version: actionFirstAfterFirst.version,
      metadata: {
        ...actionFirstAfterFirst.metadata,
        title: "newer edit after lost action response"
      }
    }]
  );
  assert.equal(editAfterLostResponse[0].status, "changed");
  const actionFirstAfterEdit = await ingestionRepository.readSession(
    actionOwner,
    actionFirst.session_id
  );
  const actionRevisionAfterEdit = (
    await ingestionRepository.snapshot(actionOwner, "import", 0, 0)
  ).metadata.revision;
  const retriedFirstActionBatch = await runAction(
    limitedActionRepository,
    applyActionRequest
  );
  assert.deepEqual(
    retriedFirstActionBatch,
    firstActionBatch,
    "首批响应丢失必须从进程内 action scope 逐字重放原批次结果"
  );
  assert.ok(retriedFirstActionBatch.continuation);
  assert.equal(
    (await ingestionRepository.readSession(
      actionOwner,
      actionFirst.session_id
    )).version,
    actionFirstAfterEdit.version,
    "首批响应丢失重试不得覆盖其后编辑或推进 version"
  );
  assert.equal(
    (await ingestionRepository.readSession(
      actionOwner,
      actionFirst.session_id
    )).metadata.title,
    "newer edit after lost action response"
  );
  assert.equal(
    (await ingestionRepository.snapshot(actionOwner, "import", 0, 0))
      .metadata.revision,
    actionRevisionAfterEdit,
    "首批响应丢失重试不得在后续编辑后推进 queue revision"
  );
  const secondActionBatch = await runAction(limitedActionRepository, {
    ...applyActionRequest,
    continuation: retriedFirstActionBatch.continuation
  });
  assert.equal(secondActionBatch.processed, 1);
  assert.equal(secondActionBatch.changed, 1);
  assert.equal(secondActionBatch.items[0].session_id, actionSecond.session_id);
  assert.equal(secondActionBatch.continuation, undefined);
  const ascendingActionAfterFrozenWatermarkResult =
    await ingestionRepository.readSession(
    actionOwner,
    ascendingActionAfterFrozenWatermark.session_id
  );
  assert.equal(
    ascendingActionAfterFrozenWatermarkResult.metadata.title,
    ascendingActionAfterFrozenWatermark.metadata.title,
    "accepted_order 超过冻结水位的新增任务不得进入本轮操作"
  );
  assert.equal(
    ascendingActionAfterFrozenWatermarkResult.version,
    ascendingActionAfterFrozenWatermark.version
  );
  await discardOrderProbe(
    ascendingActionAfterFrozenWatermarkResult,
    Date.now()
  );

  const noOpActionPage = await ingestionQueueSnapshot.readStableIngestionQueueSnapshot({
    repository: ingestionRepository,
    tokens: actionTokens,
    session: actionSession,
    actionScope: actionScope.id,
    queue: "import",
    offset: 0,
    limit: 10
  });
  const noOpActionCurrent = await ingestionRepository.readSession(
    actionOwner,
    actionFirst.session_id
  );
  const noOpVersionBefore = noOpActionCurrent.version;
  const noOpRevisionBefore = (
    await ingestionRepository.snapshot(actionOwner, "import", 0, 0)
  ).metadata.revision;
  const noOpActionRequest = {
    ...applyActionRequest,
    action_request_id: "019f8457-063a-7004-a580-7a432dc7fd90",
    action_watermark: noOpActionPage.action_watermark,
    metadata: { title: noOpActionCurrent.metadata.title }
  };
  const noOpActionResult = await runAction(
    limitedActionRepository,
    noOpActionRequest
  );
  assert.equal(noOpActionResult.items[0].status, "unchanged");
  assert.equal((await ingestionRepository.readSession(
    actionOwner,
    actionFirst.session_id
  )).version, noOpVersionBefore);
  assert.equal((await ingestionRepository.snapshot(
    actionOwner,
    "import",
    0,
    0
  )).metadata.revision, noOpRevisionBefore);

  const sameRevisionNewAction = {
    ...noOpActionRequest,
    action_request_id: "019f8457-063a-7004-a580-7a432dc7fd91",
    metadata: { title: "new defaults at the same revision" }
  };
  const sameRevisionNewResult = await runAction(
    limitedActionRepository,
    sameRevisionNewAction
  );
  assert.equal(sameRevisionNewResult.items[0].status, "changed");
  const afterSameRevisionNewAction = await ingestionRepository.readSession(
    actionOwner,
    actionFirst.session_id
  );
  assert.equal(
    afterSameRevisionNewAction.metadata.title,
    "new defaults at the same revision",
    "纯 no-op 不推进 revision，因此同水位后执行操作仍可生效"
  );
  const revisionAfterSameRevisionNewAction = (await ingestionRepository.snapshot(
    actionOwner,
    "import",
    0,
    0
  )).metadata.revision;
  const retriedOlderNoOpAction = await runAction(
    limitedActionRepository,
    noOpActionRequest
  );
  assert.equal(retriedOlderNoOpAction.items[0].status, "changed");
  const afterRetriedOlderAction = await ingestionRepository.readSession(
    actionOwner,
    actionFirst.session_id
  );
  assert.equal(
    afterRetriedOlderAction.metadata.title,
    noOpActionCurrent.metadata.title,
    "应用到全部只按执行顺序 CAS，不按旧点击水位后的语义修订筛选"
  );
  assert.ok((await ingestionRepository.snapshot(
    actionOwner,
    "import",
    0,
    0
  )).metadata.revision > revisionAfterSameRevisionNewAction);

  const editAfterNoOpAction = await ingestionSessionUpdate.updateIngestionSessions(
    ingestionRepository,
    actionOwner,
    [{
      session_id: afterRetriedOlderAction.session_id,
      image_id: afterRetriedOlderAction.image_id,
      expected_version: afterRetriedOlderAction.version,
      metadata: {
        ...afterRetriedOlderAction.metadata,
        title: "edit after newer action response loss"
      }
    }]
  );
  assert.equal(editAfterNoOpAction[0].status, "changed");
  const noOpAfterEdit = await ingestionRepository.readSession(
    actionOwner,
    actionFirst.session_id
  );
  const noOpRevisionAfterEdit = (await ingestionRepository.snapshot(
    actionOwner,
    "import",
    0,
    0
  )).metadata.revision;
  const retriedNoOpAction = await runAction(
    limitedActionRepository,
    sameRevisionNewAction
  );
  assert.equal(retriedNoOpAction.items[0].status, "changed");
  assert.equal((await ingestionRepository.readSession(
    actionOwner,
    actionFirst.session_id
  )).metadata.title, "new defaults at the same revision");
  assert.ok((await ingestionRepository.readSession(
    actionOwner,
    actionFirst.session_id
  )).version > noOpAfterEdit.version);
  assert.ok((await ingestionRepository.snapshot(
    actionOwner,
    "import",
    0,
    0
  )).metadata.revision > noOpRevisionAfterEdit);

  const atomicActionSession = await createActionReadySession("action-order");
  const atomicActionPage = await ingestionQueueSnapshot
    .readStableIngestionQueueSnapshot({
      repository: ingestionRepository,
      tokens: actionTokens,
      session: actionSession,
      actionScope: actionScope.id,
      queue: "import",
      offset: 0,
      limit: 10
    });
  const atomicStaleSnapshot = await ingestionRepository.readSession(
    actionOwner,
    atomicActionSession.session_id
  );
  const staleActionRepository = {
    scanAction: async () => ({
      items: [atomicStaleSnapshot],
      nextCursor: null
    }),
    readSession: (...args) => ingestionRepository.readSession(...args),
    mutateSemantic: (...args) => ingestionRepository.mutateSemantic(...args)
  };
  const atomicNewerRequest = {
    queue: "import",
    action_request_id: "019f8457-063a-7004-a580-7a432dc7fd95",
    action: "apply_metadata",
    action_watermark: atomicActionPage.action_watermark,
    metadata: { title: atomicStaleSnapshot.metadata.title }
  };
  const atomicNewerResult = await runAction(
    staleActionRepository,
    atomicNewerRequest
  );
  assert.equal(atomicNewerResult.items[0].status, "unchanged");

  const atomicOlderResult = await runAction(staleActionRepository, {
    ...atomicNewerRequest,
    action_request_id: "019f8457-063a-7004-a580-7a432dc7fd94",
    metadata: { title: "later smaller-id action must apply" }
  });
  assert.equal(atomicOlderResult.items[0].status, "changed");
  let atomicCurrent = await ingestionRepository.readSession(
    actionOwner,
    atomicActionSession.session_id
  );
  assert.equal(
    atomicCurrent.metadata.title,
    "later smaller-id action must apply",
    "同水位内没有语义变化时，后执行操作不得按跨客户端 UUID 大小丢弃"
  );

  await assert.rejects(runAction(staleActionRepository, {
    ...atomicNewerRequest,
    metadata: { title: "same id with different payload must lose" }
  }), (error) => error?.code === "ingestion_action_request_conflict");
  atomicCurrent = await ingestionRepository.readSession(
    actionOwner,
    atomicActionSession.session_id
  );
  assert.equal(
    atomicCurrent.metadata.title,
    "later smaller-id action must apply"
  );

  const businessEditAfterAction = await ingestionRepository.mutateSemantic(
    atomicCurrent,
    atomicCurrent.version,
    ingestionSessionTransitions.semanticIngestionSession(atomicCurrent, {
      metadata: {
        ...atomicCurrent.metadata,
        description: "ordinary edit after concurrent action"
      }
    })
  );
  assert.equal(businessEditAfterAction.changed, true);
  assert.equal(
    businessEditAfterAction.session.metadata.description,
    "ordinary edit after concurrent action"
  );
  await assert.rejects(runAction(
    staleActionRepository,
    {
      ...atomicNewerRequest,
      metadata: { title: "same id after version advance must lose" }
    }
  ), (error) => error?.code === "ingestion_action_request_conflict");
  const retiredAtomicAction = await ingestionRepository.mutateSemantic(
    businessEditAfterAction.session,
    businessEditAfterAction.session.version,
    ingestionSessionTransitions.discardedIngestionReceipt(
      businessEditAfterAction.session,
      Date.now()
    )
  );
  await ingestionRepository.deleteSession(
    retiredAtomicAction.session,
    retiredAtomicAction.session.version
  );

  const orderedActionSession = await createActionReadySession(
    "ordered-action-cas"
  );
  const orderedActionPage = await ingestionQueueSnapshot
    .readStableIngestionQueueSnapshot({
      repository: ingestionRepository,
      tokens: actionTokens,
      session: actionSession,
      actionScope: actionScope.id,
      queue: "import",
      offset: 0,
      limit: 10
    });
  const orderedStaleSnapshot = await ingestionRepository.readSession(
    actionOwner,
    orderedActionSession.session_id
  );
  const orderedStaleRepository = {
    scanAction: async () => ({
      items: [orderedStaleSnapshot],
      nextCursor: null
    }),
    readSession: (...args) => ingestionRepository.readSession(...args),
    mutateSemantic: (...args) => ingestionRepository.mutateSemantic(...args)
  };
  const orderedSmallerRequest = {
    queue: "import",
    action_request_id: "019f8457-063a-7004-a580-7a432dc7fd96",
    action: "apply_metadata",
    action_watermark: orderedActionPage.action_watermark,
    metadata: { title: "smaller action landed first" }
  };
  const orderedSmallerResult = await runAction(
    orderedStaleRepository,
    orderedSmallerRequest
  );
  assert.equal(orderedSmallerResult.items[0].status, "changed");
  const orderedAfterSmaller = await ingestionRepository.readSession(
    actionOwner,
    orderedActionSession.session_id
  );
  const editBetweenOrderedActions = await ingestionRepository.mutateSemantic(
    orderedAfterSmaller,
    orderedAfterSmaller.version,
    ingestionSessionTransitions.semanticIngestionSession(orderedAfterSmaller, {
      metadata: {
        ...orderedAfterSmaller.metadata,
        description: "ordinary edit between ordered actions"
      }
    })
  );
  assert.equal(editBetweenOrderedActions.changed, true);
  const orderedLargerResult = await runAction(orderedStaleRepository, {
    ...orderedSmallerRequest,
    action_request_id: "019f8457-063a-7004-a580-7a432dc7fd97",
    metadata: { title: "larger action must win" }
  });
  assert.equal(orderedLargerResult.items[0].status, "changed");
  const orderedCurrent = await ingestionRepository.readSession(
    actionOwner,
    orderedActionSession.session_id
  );
  assert.equal(orderedCurrent.metadata.title, "larger action must win");
  assert.equal(
    orderedCurrent.metadata.description,
    "ordinary edit between ordered actions",
    "后执行全局操作应在最新 canonical 上合并，保留未被 patch 覆盖的字段"
  );
  const retiredOrderedAction = await ingestionRepository.mutateSemantic(
    orderedCurrent,
    orderedCurrent.version,
    ingestionSessionTransitions.discardedIngestionReceipt(
      orderedCurrent,
      Date.now()
    )
  );
  await ingestionRepository.deleteSession(
    retiredOrderedAction.session,
    retiredOrderedAction.session.version
  );

  const actionFirstCurrent = await ingestionRepository.readSession(
    actionOwner,
    actionFirst.session_id
  );
  const noOpUpdate = await ingestionSessionUpdate.updateIngestionSessions(
    ingestionRepository,
    actionOwner,
    [{
      session_id: actionFirstCurrent.session_id,
      image_id: actionFirstCurrent.image_id,
      expected_version: 1,
      metadata: actionFirstCurrent.metadata
    }]
  );
  assert.equal(noOpUpdate[0].status, "unchanged");
  assert.equal(noOpUpdate[0].version, actionFirstCurrent.version);
  const changedUpdate = await ingestionSessionUpdate.updateIngestionSessions(
    ingestionRepository,
    actionOwner,
    [{
      session_id: actionFirstCurrent.session_id,
      image_id: actionFirstCurrent.image_id,
      expected_version: actionFirstCurrent.version,
      metadata: { ...actionFirstCurrent.metadata, description: "saved draft" }
    }]
  );
  assert.equal(changedUpdate[0].status, "changed");

  const commitActionPage = await ingestionQueueSnapshot
    .readStableIngestionQueueSnapshot({
      repository: ingestionRepository,
      tokens: actionTokens,
      session: actionSession,
      actionScope: actionScope.id,
      queue: "import",
      offset: 0,
      limit: 10
    });
  const actionSecondBeforeStale = await ingestionRepository.readSession(
    actionOwner,
    actionSecond.session_id
  );
  await ingestionSessionUpdate.updateIngestionSessions(
    ingestionRepository,
    actionOwner,
    [{
      session_id: actionSecondBeforeStale.session_id,
      image_id: actionSecondBeforeStale.image_id,
      expected_version: actionSecondBeforeStale.version,
      metadata: {
        ...actionSecondBeforeStale.metadata,
        description: "changed after watermark"
      }
    }]
  );
  const actionAfterWatermark = await createActionReadySession("after-watermark");
  const commitActionRequest = {
    queue: "import",
    action_request_id: coreUuid.randomUuidV7(),
    action: "commit_ready",
    action_watermark: commitActionPage.action_watermark
  };
  const commitActionResult = await runAction(
    ingestionRepository,
    commitActionRequest
  );
  assert.equal(commitActionResult.changed, 1);
  assert.equal(
    commitActionResult.items.filter((item) => (
      item.code === "ingestion_action_state_changed"
    )).length,
    1,
    "watermark 后发生语义变化的 ready 项必须跳过"
  );
  assert.equal(
    (await ingestionRepository.readSession(
      actionOwner,
      actionAfterWatermark.session_id
    )).status,
    "ready",
    "watermark 后新建的 canonical 不得进入旧全队列动作"
  );
  const actionRevisionAfterCommit = (
    await ingestionRepository.snapshot(actionOwner, "import", 0, 0)
  ).metadata.revision;
  const retriedCommitAction = await runAction(
    ingestionRepository,
    commitActionRequest
  );
  assert.equal(retriedCommitAction.failed, 0);
  assert.equal(
    (await ingestionRepository.snapshot(actionOwner, "import", 0, 0))
      .metadata.revision,
    actionRevisionAfterCommit,
    "相同全队列提交 action ID 重试必须语义 no-op"
  );

  const duplicateRecoveryReady = await createActionReadySession(
    "duplicate-recovery"
  );
  const duplicateRecoveryRequest = {
    session_id: duplicateRecoveryReady.session_id,
    image_id: duplicateRecoveryReady.image_id,
    expected_version: duplicateRecoveryReady.version,
    expected_md5: duplicateRecoveryReady.prepared.md5,
    commit_request_id: coreUuid.randomUuidV7(),
    duplicate_decision: "upload",
    metadata: duplicateRecoveryReady.metadata
  };
  assert.equal((await ingestionCommitIntent.acceptIngestionCommitIntents(
    ingestionRepository,
    actionOwner,
    [duplicateRecoveryRequest]
  ))[0].status, "accepted");
  const duplicateRecoveryCommitting = await ingestionRepository.readSession(
    actionOwner,
    duplicateRecoveryReady.session_id
  );
  const duplicateRecoveryImageId = coreUuid.randomUuidV7();
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, "
      + "brightness, theme, ext, md5, status) VALUES "
      + "($1,$2,'local',$3,'pc','dark','none','webp',$4,'ready')",
    [
      duplicateRecoveryImageId,
      actionOwner,
      imagePaths.storageObjectKey(duplicateRecoveryImageId, "webp"),
      duplicateRecoveryReady.prepared.md5
    ]
  );
  const duplicateRecoverySummaryBefore = (
    await ingestionRepository.snapshot(actionOwner, "import", 0, 0)
  ).metadata;
  assert.equal(await ingestionCommitConflictRecovery
    .recoverIngestionCommitDuplicateConflict(
      ingestionRepository,
      duplicateRecoveryCommitting,
      new apiError.ApiError(
        409,
        "ingestion_duplicate_conflict",
        "duplicate appeared under the content lock"
      )
    ), true);
  const duplicateRecoveryCurrent = await ingestionRepository.readSession(
    actionOwner,
    duplicateRecoveryReady.session_id
  );
  assert.equal(duplicateRecoveryCurrent.status, "ready");
  assert.equal(duplicateRecoveryCurrent.prepared.duplicate_count, 1);
  assert.equal(duplicateRecoveryCurrent.duplicate_decision, undefined);
  assert.equal(duplicateRecoveryCurrent.commit, undefined);
  assert.equal(duplicateRecoveryCurrent.error, undefined);
  assert.equal(
    duplicateRecoveryCurrent.version,
    duplicateRecoveryCommitting.version + 1
  );
  const duplicateRecoverySummaryAfter = (
    await ingestionRepository.snapshot(actionOwner, "import", 0, 0)
  ).metadata;
  assert.equal(
    duplicateRecoverySummaryAfter.committing_resolving,
    duplicateRecoverySummaryBefore.committing_resolving - 1
  );
  assert.equal(
    duplicateRecoverySummaryAfter.duplicate_pending,
    duplicateRecoverySummaryBefore.duplicate_pending + 1,
    "内容锁后出现的重复项必须回到可确认状态而不是冻结为提交失败"
  );
  await database.pool.query(
    "DELETE FROM metadata WHERE id=$1",
    [duplicateRecoveryImageId]
  );

  const duplicateIntentReady = await createActionReadySession(
    "duplicate-before-intent"
  );
  const duplicateIntentImageId = coreUuid.randomUuidV7();
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, "
      + "brightness, theme, ext, md5, status) VALUES "
      + "($1,$2,'local',$3,'pc','dark','none','webp',$4,'ready')",
    [
      duplicateIntentImageId,
      actionOwner,
      imagePaths.storageObjectKey(duplicateIntentImageId, "webp"),
      duplicateIntentReady.prepared.md5
    ]
  );
  const [duplicateIntentResult] = await ingestionCommitIntent
    .acceptIngestionCommitIntents(ingestionRepository, actionOwner, [{
      session_id: duplicateIntentReady.session_id,
      image_id: duplicateIntentReady.image_id,
      expected_version: duplicateIntentReady.version,
      expected_md5: duplicateIntentReady.prepared.md5,
      commit_request_id: coreUuid.randomUuidV7(),
      duplicate_decision: "upload",
      metadata: duplicateIntentReady.metadata
    }]);
  assert.equal(duplicateIntentResult.status, "failed");
  assert.equal(duplicateIntentResult.code, "ingestion_duplicate_conflict");
  assert.equal(duplicateIntentResult.duplicate_count, 1);
  assert.equal(duplicateIntentResult.version, duplicateIntentReady.version + 1);
  const duplicateIntentCurrent = await ingestionRepository.readSession(
    actionOwner,
    duplicateIntentReady.session_id
  );
  assert.equal(duplicateIntentCurrent.status, "ready");
  assert.equal(duplicateIntentCurrent.prepared.duplicate_count, 1);
  assert.equal(duplicateIntentCurrent.duplicate_decision, undefined);
  assert.equal(duplicateIntentCurrent.commit, undefined);
  await database.pool.query(
    "DELETE FROM metadata WHERE id=$1",
    [duplicateIntentImageId]
  );
  const duplicateCountRefresh = await ingestionSessionUpdate.updateIngestionSessions(
    ingestionRepository,
    actionOwner,
    [{
      session_id: duplicateIntentCurrent.session_id,
      image_id: duplicateIntentCurrent.image_id,
      expected_version: duplicateIntentCurrent.version,
      duplicate_decision: "upload"
    }]
  );
  assert.equal(duplicateCountRefresh[0].status, "changed");
  assert.equal(duplicateCountRefresh[0].duplicate_count, 0);
  assert.equal(duplicateCountRefresh[0].duplicate_decision, "upload");
  const duplicateCountCurrent = await ingestionRepository.readSession(
    actionOwner,
    duplicateIntentCurrent.session_id
  );
  assert.equal(duplicateCountCurrent.prepared.duplicate_count, 0);
  assert.equal(duplicateCountCurrent.duplicate_decision, "upload");
  const actionQueued = await createActionReadySession(
    "apply-defaults-while-queued",
    false
  );
  const queuedDraftUpdate = await ingestionSessionUpdate.updateIngestionSessions(
    ingestionRepository,
    actionOwner,
    [{
      session_id: actionQueued.session_id,
      image_id: actionQueued.image_id,
      expected_version: actionQueued.version,
      metadata: {
        ...actionQueued.metadata,
        title: "accepted 后补写的本地草稿"
      }
    }]
  );
  assert.equal(queuedDraftUpdate[0].status, "changed");
  assert.equal(queuedDraftUpdate[0].duplicate_count, 0);
  assert.equal(
    (await ingestionRepository.readSession(
      actionOwner,
      actionQueued.session_id
    )).metadata.title,
    "accepted 后补写的本地草稿",
    "页外 intent fence 必须能在 prepare 前写回 queued canonical"
  );
  const queuedActionPage = await ingestionQueueSnapshot.readStableIngestionQueueSnapshot({
    repository: ingestionRepository,
    tokens: actionTokens,
    session: actionSession,
    actionScope: actionScope.id,
    queue: "import",
    offset: 0,
    limit: 10
  });
  const queuedActionResult = await runAction(ingestionRepository, {
    queue: "import",
    action_request_id: coreUuid.randomUuidV7(),
    action: "apply_metadata",
    action_watermark: queuedActionPage.action_watermark,
    metadata: { author: "queued-default-author" }
  });
  assert.equal(
    queuedActionResult.items.find((item) => (
      item.image_id === actionQueued.image_id
    ))?.status,
    "changed",
    "应用到全部必须覆盖点击水位内仍在 queued 的 canonical"
  );
  assert.equal(
    (await ingestionRepository.readSession(
      actionOwner,
      actionQueued.session_id
    )).metadata.author,
    "queued-default-author"
  );

  const updateRaceSession = await createActionReadySession("update-race");
  let injectedConcurrentUpdate = false;
  const racingUpdateRepository = {
    readSessions: async (owner, pairs) => {
      const stale = await ingestionRepository.readSessions(owner, pairs);
      if (!injectedConcurrentUpdate) {
        injectedConcurrentUpdate = true;
        const current = stale[0];
        assert.ok(current);
        assert.notEqual(
          current,
          ingestionSessionRepository.ingestionSessionIncarnationMismatch
        );
        await ingestionRepository.mutateSemantic(
          current,
          current.version,
          ingestionSessionTransitions.semanticIngestionSession(current, {
            metadata: {
              ...current.metadata,
              title: "concurrent authoritative draft"
            }
          })
        );
      }
      return stale;
    },
    mutateSemantic: (...args) => ingestionRepository.mutateSemantic(...args)
  };
  const staleNoOpResult = await ingestionSessionUpdate.updateIngestionSessions(
    racingUpdateRepository,
    actionOwner,
    [{
      session_id: updateRaceSession.session_id,
      image_id: updateRaceSession.image_id,
      expected_version: updateRaceSession.version,
      metadata: updateRaceSession.metadata
    }]
  );
  assert.equal(staleNoOpResult[0].status, "failed");
  assert.equal(staleNoOpResult[0].code, "ingestion_version_conflict");
  const updateRaceCurrent = await ingestionRepository.readSession(
    actionOwner,
    updateRaceSession.session_id
  );
  assert.equal(
    updateRaceCurrent.metadata.title,
    "concurrent authoritative draft",
    "旧快照的语义 no-op 不得吞掉并发草稿并报告成功"
  );
  const updateRaceSummaryBeforeReplay = (
    await ingestionRepository.snapshot(actionOwner, "import", 0, 0)
  ).metadata;
  const updateRaceDiscardAt = updateRaceCurrent.discard_at;
  const lostResponseReplay = await ingestionSessionUpdate.updateIngestionSessions(
    ingestionRepository,
    actionOwner,
    [{
      session_id: updateRaceCurrent.session_id,
      image_id: updateRaceCurrent.image_id,
      expected_version: updateRaceSession.version,
      metadata: updateRaceCurrent.metadata
    }]
  );
  assert.equal(lostResponseReplay[0].status, "unchanged");
  assert.equal(lostResponseReplay[0].version, updateRaceCurrent.version);
  const updateRaceAfterReplay = await ingestionRepository.readSession(
    actionOwner,
    updateRaceSession.session_id
  );
  assert.equal(updateRaceAfterReplay.version, updateRaceCurrent.version);
  assert.equal(updateRaceAfterReplay.discard_at, updateRaceDiscardAt);
  const futureVersionNoOp = await ingestionSessionUpdate.updateIngestionSessions(
    ingestionRepository,
    actionOwner,
    [{
      session_id: updateRaceCurrent.session_id,
      image_id: updateRaceCurrent.image_id,
      expected_version: updateRaceCurrent.version + 1,
      metadata: updateRaceCurrent.metadata
    }]
  );
  assert.equal(futureVersionNoOp[0].status, "failed");
  assert.equal(futureVersionNoOp[0].code, "ingestion_version_conflict");
  assert.equal(
    (await ingestionRepository.snapshot(actionOwner, "import", 0, 0))
      .metadata.revision,
    updateRaceSummaryBeforeReplay.revision,
    "响应丢失后的同语义重试不得推进 version、TTL 或 queue revision"
  );

  const completedCommitActionReady = await createActionReadySession(
    "commit-action-completed-retry"
  );
  const completedCommitActionId = coreUuid.randomUuidV7();
  assert.equal((await ingestionCommitIntent.acceptIngestionCommitIntents(
    ingestionRepository,
    actionOwner,
    [{
      session_id: completedCommitActionReady.session_id,
      image_id: completedCommitActionReady.image_id,
      expected_version: completedCommitActionReady.version,
      expected_md5: completedCommitActionReady.prepared.md5,
      commit_request_id: completedCommitActionId,
      duplicate_decision: "upload",
      metadata: completedCommitActionReady.metadata
    }]
  ))[0].status, "accepted");
  const completedCommitActionCurrent = await ingestionRepository.readSession(
    actionOwner,
    completedCommitActionReady.session_id
  );
  assert.ok(completedCommitActionCurrent);
  assert.equal(completedCommitActionCurrent.status, "committing");
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, "
      + "brightness, theme, ext, md5, status) VALUES "
      + "($1,$2,'local',$3,'pc','dark','none','webp',$4,'ready')",
    [
      completedCommitActionReady.image_id,
      actionOwner,
      imagePaths.storageObjectKey(completedCommitActionReady.image_id, "webp"),
      completedCommitActionReady.prepared.md5
    ]
  );
  const completedCommitActionPage = await ingestionQueueSnapshot
    .readStableIngestionQueueSnapshot({
      repository: ingestionRepository,
      tokens: actionTokens,
      session: actionSession,
      actionScope: actionScope.id,
      queue: "import",
      offset: 0,
      limit: 10
    });
  const completedCommitActionResult = await runAction({
    scanAction: async () => ({
      items: [completedCommitActionCurrent],
      nextCursor: null
    }),
    readSessions: (...args) => ingestionRepository.readSessions(...args)
  }, {
    queue: "import",
    action_request_id: completedCommitActionId,
    action: "commit_ready",
    action_watermark: completedCommitActionPage.action_watermark
  });
  assert.equal(completedCommitActionResult.items[0]?.status, "unchanged");
  assert.equal(
    completedCommitActionResult.items[0]?.completed_item?.id,
    completedCommitActionReady.image_id,
    "PG 已提交而 Redis 仍 committing 时必须把完成 DTO 带回整队提交重试"
  );
  await database.pool.query(
    "DELETE FROM metadata WHERE id=$1",
    [completedCommitActionReady.image_id]
  );

  const clearQueueVersionRace = await createActionReadySession(
    "clear-queue-version-race",
    false
  );
  const clearQueueVersionRacePage = await ingestionQueueSnapshot
    .readStableIngestionQueueSnapshot({
      repository: ingestionRepository,
      tokens: actionTokens,
      session: actionSession,
      actionScope: actionScope.id,
      queue: "import",
      offset: 0,
      limit: 10
    });
  const clearQueueVersionRaceStale = await ingestionRepository.readSession(
    actionOwner,
    clearQueueVersionRace.session_id
  );
  let clearQueueVersionAdvanced = false;
  const clearQueueVersionRaceRepository = {
    scanAction: async () => {
      if (!clearQueueVersionAdvanced) {
        clearQueueVersionAdvanced = true;
        await ingestionRepository.mutateSemantic(
          clearQueueVersionRaceStale,
          clearQueueVersionRaceStale.version,
          ingestionSessionTransitions.semanticIngestionSession(
            clearQueueVersionRaceStale,
            {
              metadata: {
                ...clearQueueVersionRaceStale.metadata,
                description: "worker advanced after action scan"
              }
            }
          )
        );
      }
      return { items: [clearQueueVersionRaceStale], nextCursor: null };
    },
    readSessions: (...args) => ingestionRepository.readSessions(...args),
    readSession: (...args) => ingestionRepository.readSession(...args),
    mutateSemantic: (...args) => ingestionRepository.mutateSemantic(...args),
    deleteSession: (...args) => ingestionRepository.deleteSession(...args)
  };
  const clearQueueVersionRaceResult = await runAction(
    clearQueueVersionRaceRepository,
    {
      queue: "import",
      action_request_id: coreUuid.randomUuidV7(),
      action: "clear_queue",
      action_watermark: clearQueueVersionRacePage.action_watermark
    }
  );
  assert.equal(clearQueueVersionRaceResult.failed, 0);
  assert.equal(clearQueueVersionRaceResult.items[0]?.status, "changed");
  assert.equal((await ingestionRepository.readSession(
    actionOwner,
    clearQueueVersionRace.session_id
  ))?.status, "discarded");

  const filteredClearVersionRace = await createActionReadySession(
    "filtered-clear-version-race",
    false
  );
  const filteredClearVersionRacePage = await ingestionQueueSnapshot
    .readStableIngestionQueueSnapshot({
      repository: ingestionRepository,
      tokens: actionTokens,
      session: actionSession,
      actionScope: actionScope.id,
      queue: "import",
      offset: 0,
      limit: 10
    });
  const filteredClearVersionRaceStale = await ingestionRepository.readSession(
    actionOwner,
    filteredClearVersionRace.session_id
  );
  let filteredClearVersionAdvanced = false;
  const filteredClearVersionRaceRepository = {
    scanAction: async () => {
      if (!filteredClearVersionAdvanced) {
        filteredClearVersionAdvanced = true;
        await ingestionRepository.mutateSemantic(
          filteredClearVersionRaceStale,
          filteredClearVersionRaceStale.version,
          ingestionSessionTransitions.semanticIngestionSession(
            filteredClearVersionRaceStale,
            {
              metadata: {
                ...filteredClearVersionRaceStale.metadata,
                description: "semantic edit after filtered action scan"
              }
            }
          )
        );
      }
      return { items: [filteredClearVersionRaceStale], nextCursor: null };
    },
    readSessions: (...args) => ingestionRepository.readSessions(...args),
    readSession: (...args) => ingestionRepository.readSession(...args),
    mutateSemantic: (...args) => ingestionRepository.mutateSemantic(...args),
    deleteSession: (...args) => ingestionRepository.deleteSession(...args)
  };
  const filteredClearVersionRaceResult = await runAction(
    filteredClearVersionRaceRepository,
    {
      queue: "import",
      action_request_id: coreUuid.randomUuidV7(),
      action: "clear_uncommitted",
      action_watermark: filteredClearVersionRacePage.action_watermark
    }
  );
  assert.equal(filteredClearVersionRaceResult.failed, 0);
  assert.equal(
    filteredClearVersionRaceResult.items[0]?.code,
    "ingestion_action_state_changed",
    "筛选清理应在 scan/cancel 竞态后重读并按冻结 revision 跳过"
  );
  const filteredClearVersionRaceCurrent = await ingestionRepository.readSession(
    actionOwner,
    filteredClearVersionRace.session_id
  );
  assert.notEqual(filteredClearVersionRaceCurrent?.status, "discarded");
  const filteredClearVersionRaceDiscarded = await ingestionRepository
    .mutateSemantic(
      filteredClearVersionRaceCurrent,
      filteredClearVersionRaceCurrent.version,
      ingestionSessionTransitions.discardedIngestionReceipt(
        filteredClearVersionRaceCurrent,
        Date.now()
      )
    );
  await ingestionRepository.deleteSession(
    filteredClearVersionRaceDiscarded.session,
    filteredClearVersionRaceDiscarded.session.version
  );

  const clearCompletedReady = await createActionReadySession(
    "clear-completed-hydration"
  );
  const clearCompletedRequest = {
    session_id: clearCompletedReady.session_id,
    image_id: clearCompletedReady.image_id,
    expected_version: clearCompletedReady.version,
    expected_md5: clearCompletedReady.prepared.md5,
    commit_request_id: coreUuid.randomUuidV7(),
    duplicate_decision: "upload",
    metadata: clearCompletedReady.metadata
  };
  assert.equal((await ingestionCommitIntent.acceptIngestionCommitIntents(
    ingestionRepository,
    actionOwner,
    [clearCompletedRequest]
  ))[0].status, "accepted");
  const clearCompletedCommitting = await ingestionRepository.readSession(
    actionOwner,
    clearCompletedReady.session_id
  );
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, "
      + "brightness, theme, ext, md5, status) VALUES "
      + "($1,$2,'local',$3,'pc','dark','none','webp',$4,'ready')",
    [
      clearCompletedReady.image_id,
      actionOwner,
      imagePaths.storageObjectKey(clearCompletedReady.image_id, "webp"),
      clearCompletedReady.prepared.md5
    ]
  );
  await ingestionCommitCompletion.publishCompletedReceipt(
    ingestionRepository,
    clearCompletedCommitting,
    Date.now()
  );
  const clearCompletedPage = await ingestionQueueSnapshot
    .readStableIngestionQueueSnapshot({
      repository: ingestionRepository,
      tokens: actionTokens,
      session: actionSession,
      actionScope: actionScope.id,
      queue: "import",
      offset: 0,
      limit: 10
    });
  const deferredCompletedReady = await createActionReadySession(
    "deferred-clear-completed-boundary"
  );
  const deferredCompletedRequest = {
    session_id: deferredCompletedReady.session_id,
    image_id: deferredCompletedReady.image_id,
    expected_version: deferredCompletedReady.version,
    expected_md5: deferredCompletedReady.prepared.md5,
    commit_request_id: coreUuid.randomUuidV7(),
    duplicate_decision: "upload",
    metadata: deferredCompletedReady.metadata
  };
  assert.equal((await ingestionCommitIntent.acceptIngestionCommitIntents(
    ingestionRepository,
    actionOwner,
    [deferredCompletedRequest]
  ))[0].status, "accepted");
  const deferredCompletedCommitting = await ingestionRepository.readSession(
    actionOwner,
    deferredCompletedReady.session_id
  );
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, "
      + "brightness, theme, ext, md5, status) VALUES "
      + "($1,$2,'local',$3,'pc','dark','none','webp',$4,'ready')",
    [
      deferredCompletedReady.image_id,
      actionOwner,
      imagePaths.storageObjectKey(deferredCompletedReady.image_id, "webp"),
      deferredCompletedReady.prepared.md5
    ]
  );
  await ingestionCommitCompletion.publishCompletedReceipt(
    ingestionRepository,
    deferredCompletedCommitting,
    Date.now()
  );
  const deferredCompletedExecutionPage = await ingestionQueueSnapshot
    .readStableIngestionQueueSnapshot({
      repository: ingestionRepository,
      tokens: actionTokens,
      session: actionSession,
      actionScope: actionScope.id,
      queue: "import",
      offset: 0,
      limit: 10
    });
  const clearCompletedActionRequest = {
    queue: "import",
    action_request_id: coreUuid.randomUuidV7(),
    action: "clear_completed",
    action_watermark: deferredCompletedExecutionPage.action_watermark,
    max_semantic_revision: clearCompletedPage.revision
  };
  const clearCompletedResult = await runAction(
    ingestionRepository,
    clearCompletedActionRequest
  );
  const clearedCompletedItem = clearCompletedResult.items.find((item) => (
    item.session_id === clearCompletedReady.session_id
  ));
  assert.equal(clearedCompletedItem?.status, "changed");
  assert.equal(
    clearedCompletedItem?.completed_item?.id,
    clearCompletedReady.image_id,
    "页外 completed 回执必须在删除前把 PG 水合 DTO 带回动作响应"
  );
  assert.deepEqual(
    await runAction(ingestionRepository, clearCompletedActionRequest),
    clearCompletedResult,
    "completed 回执删除后的同批响应丢失重试必须重放原完成 DTO"
  );
  assert.equal(await ingestionRepository.readSession(
    actionOwner,
    clearCompletedReady.session_id
  ), null);
  const deferredCompletedResult = clearCompletedResult.items.find((item) => (
    item.session_id === deferredCompletedReady.session_id
  ));
  assert.equal(deferredCompletedResult?.status, "skipped");
  assert.equal(
    deferredCompletedResult?.code,
    "ingestion_action_state_changed",
    "重连后执行的关闭清理不得纳入旧 semantic revision 之后才完成的任务"
  );
  const retainedDeferredCompleted = await ingestionRepository.readSession(
    actionOwner,
    deferredCompletedReady.session_id
  );
  assert.ok(retainedDeferredCompleted);
  assert.equal(retainedDeferredCompleted?.status, "completed");
  await ingestionRepository.deleteSession(
    retainedDeferredCompleted,
    retainedDeferredCompleted.version
  );
  await database.pool.query(
    "DELETE FROM metadata WHERE id = ANY($1::uuid[])",
    [[clearCompletedReady.image_id, deferredCompletedReady.image_id]]
  );
  actionScope.close();

  const actionKeys = [
    actionFirst,
    actionSecond,
    actionAfterWatermark,
    duplicateRecoveryReady,
    duplicateIntentReady,
    actionQueued,
    updateRaceSession,
    completedCommitActionReady,
    clearQueueVersionRace,
    filteredClearVersionRace,
    clearCompletedReady,
    deferredCompletedReady
  ].map((session) => ingestionSessionKeys.ingestionSessionKeys(
    actionOwner,
    "import",
    session.session_id
  ));
  for (const keys of actionKeys) {
    await redisClient.redis.zrem(keys.runnable, keys.canonical);
    await redisClient.redis.zrem(keys.expires, keys.canonical);
    await redisClient.redis.del(keys.canonical);
  }
  await redisClient.redis.del(actionKeys[0].owner, actionKeys[0].metadata);

  const duplicateMd5 = createHash("md5")
    .update("current-duplicate-details")
    .digest("hex");
  const duplicateReadyId = coreUuid.randomUuidV7();
  const duplicateDeletedId = coreUuid.randomUuidV7();
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, "
      + "brightness, theme, ext, md5, status) VALUES "
      + "($1,$3,'local',$4,'pc','dark','none','webp',$5,'ready'),"
      + "($2,$3,'local',$6,'pc','dark','none','webp',$5,'deleted')",
    [
      duplicateReadyId,
      duplicateDeletedId,
      actionOwner,
      imagePaths.storageObjectKey(duplicateReadyId, "webp"),
      duplicateMd5,
      imagePaths.storageObjectKey(duplicateDeletedId, "webp")
    ]
  );
  const duplicateSnapshots = await ingestionDuplicatesReadModel
    .readDuplicateSnapshotsByMd5([duplicateMd5, "f".repeat(32)]);
  assert.equal(duplicateSnapshots.get(duplicateMd5).matchCount, 1);
  assert.deepEqual(
    duplicateSnapshots.get(duplicateMd5).items.map((item) => item.id),
    [duplicateReadyId],
    "重复详情只返回当前图库中的 ready 图片"
  );
  assert.equal(duplicateSnapshots.get("f".repeat(32)).matchCount, 0);
  await database.pool.query(
    "UPDATE metadata SET status='deleted', deleted_at=now() WHERE id=$1",
    [duplicateReadyId]
  );
  assert.equal(
    (await ingestionDuplicatesReadModel.readDuplicateSnapshotByMd5(duplicateMd5))
      .matchCount,
    0,
    "图库删除后重复查询必须按 PostgreSQL 当前事实收敛"
  );
  await database.pool.query(
    "DELETE FROM metadata WHERE id = ANY($1::uuid[])",
    [[duplicateReadyId, duplicateDeletedId]]
  );

  redisWindowLimit.registerRedisWindowCommand(redisClient.redis);
  readyCacheRedisClient.registerReadyImageRedisCommands(redisClient.redis);
  const businessPrefix = "imageshow:test:redis-business:" + randomUUID() + ":";
  const reserveKey = businessPrefix + "window:first";
  await redisClient.redis.call("CONFIG", "RESETSTAT");
  await redisClient.redis.call("SCRIPT", "FLUSH");
  assert.deepEqual(
    await redisClient.redis.imageshowReserveWindows(
      "1",
      reserveKey,
      "2",
      "60"
    ),
    [1, 1, 1, 60]
  );
  const repeatedReservation = await redisClient.redis.imageshowReserveWindows(
    "1",
    reserveKey,
    "2",
    "60"
  );
  assert.deepEqual(repeatedReservation.slice(0, 3), [1, 2, 1]);
  const commandStats = String(await redisClient.redis.call(
    "INFO",
    "commandstats"
  ));
  const commandCallCount = (command) => Number(
    new RegExp("^cmdstat_" + command + ":calls=(\\\\d+)", "m")
      .exec(commandStats)?.[1] ?? -1
  );
  assert.equal(commandCallCount("eval"), 1, commandStats);
  assert.equal(commandCallCount("evalsha"), 1, commandStats);

  const slidingSessionConfig = structuredClone(baselineRuntimeConfig);
  slidingSessionConfig.security.session_ttl_seconds = 360;
  slidingSessionConfig.altcha.enabled = false;
  await runtimeConfigStore.replaceRuntimeConfig(slidingSessionConfig);
  const authApp = new Hono();
  authApp.onError((error, context) => (
    httpResponses.handleApiError(context, error)
  ));
  authRoutes.registerPublicAuthRoutes(authApp);
  const loginResponse = await authApp.request(new Request(
    "http://imageshow.test/api/admin/auth/login",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "imageshow.test",
        origin: "http://imageshow.test"
      },
      body: JSON.stringify({
        username: "bootstrap-admin",
        password: "BootstrapAdmin123!"
      })
    }
  ));
  assert.equal(loginResponse.status, 200, await loginResponse.clone().text());
  const loginCookie = loginResponse.headers.get("set-cookie") ?? "";
  const sessionId = /imageshow_session=([^;]+)/u.exec(loginCookie)?.[1];
  assert.ok(sessionId);
  assert.match(loginCookie, /Max-Age=360/u);
  const slidingSessionKey = adminSessionKey(sessionId);
  const initialSessionTtl = await redisClient.redis.ttl(slidingSessionKey);
  assert.ok(initialSessionTtl > 350 && initialSessionTtl <= 360);

  const ordinaryAdminApp = new Hono();
  ordinaryAdminApp.get(
    "/ordinary-admin-request",
    adminSession.requireAdminSession,
    (context) => context.json({ ok: true })
  );
  assert.equal(await redisClient.redis.expire(slidingSessionKey, 60), 1);
  const ordinaryResponse = await ordinaryAdminApp.request(new Request(
    "http://imageshow.test/ordinary-admin-request",
    { headers: { cookie: "imageshow_session=" + sessionId } }
  ));
  assert.equal(ordinaryResponse.status, 200);
  assert.equal(ordinaryResponse.headers.get("set-cookie"), null);
  const ordinaryRequestTtl = await redisClient.redis.ttl(slidingSessionKey);
  assert.ok(ordinaryRequestTtl > 55 && ordinaryRequestTtl <= 60);

  const authMe = () => authApp.request(new Request(
    "http://imageshow.test/api/admin/auth/me",
    { headers: { cookie: "imageshow_session=" + sessionId } }
  ));
  const renewedResponse = await authMe();
  assert.equal(renewedResponse.status, 200, await renewedResponse.clone().text());
  assert.equal((await renewedResponse.clone().json()).authenticated, true);
  assert.match(renewedResponse.headers.get("set-cookie") ?? "", /Max-Age=360/u);
  const renewedSessionTtl = await redisClient.redis.ttl(slidingSessionKey);
  assert.ok(renewedSessionTtl > 350 && renewedSessionTtl <= 360);

  const hotSessionConfig = structuredClone(slidingSessionConfig);
  hotSessionConfig.security.session_ttl_seconds = 480;
  await runtimeConfigStore.replaceRuntimeConfig(hotSessionConfig);
  assert.equal(await redisClient.redis.expire(slidingSessionKey, 60), 1);
  const hotRenewalResponse = await authMe();
  assert.equal(hotRenewalResponse.status, 200);
  assert.match(
    hotRenewalResponse.headers.get("set-cookie") ?? "",
    /Max-Age=480/u
  );
  const hotRenewalTtl = await redisClient.redis.ttl(slidingSessionKey);
  assert.ok(hotRenewalTtl > 470 && hotRenewalTtl <= 480);

  assert.equal(await redisClient.redis.del(slidingSessionKey), 1);
  const expiredProbeResponse = await authMe();
  assert.equal(expiredProbeResponse.status, 200);
  assert.equal((await expiredProbeResponse.clone().json()).authenticated, false);
  assert.equal(expiredProbeResponse.headers.get("set-cookie"), null);
  assert.equal(await redisClient.redis.exists(slidingSessionKey), 0);
  await runtimeConfigStore.replaceRuntimeConfig(baselineRuntimeConfig);

  await redisClient.redis.call("SCRIPT", "FLUSH");
  const concurrentReservations = await Promise.all(Array.from(
    { length: 8 },
    (_, index) => redisClient.redis.imageshowReserveWindows(
      "1",
      businessPrefix + "window:concurrent:" + String(index),
      "1",
      "60"
    )
  ));
  assert.ok(concurrentReservations.every(
    (result) => JSON.stringify(result.slice(0, 3)) === "[1,1,1]"
  ));

  await redisClient.redis.call("SCRIPT", "FLUSH");
  const pipelineMarker = businessPrefix + "pipeline:marker";
  const pipelineWindow = businessPrefix + "pipeline:window";
  const pipeline = redisClient.redis.pipeline();
  pipeline.set(pipelineMarker, "pipeline-value");
  pipeline.imageshowReserveWindows("1", pipelineWindow, "1", "60");
  pipeline.get(pipelineMarker);
  const pipelineResults = await pipeline.exec();
  assert.equal(pipelineResults?.length, 3);
  assert.deepEqual(pipelineResults?.[0], [null, "OK"]);
  assert.deepEqual(pipelineResults?.[1], [null, [1, 1, 1, 60]]);
  assert.deepEqual(pipelineResults?.[2], [null, "pipeline-value"]);

  const multiMarker = businessPrefix + "multi:marker";
  const multiWindow = businessPrefix + "multi:window";
  const transaction = redisClient.redis.multi();
  transaction.set(multiMarker, "multi-value");
  transaction.imageshowReserveWindows("1", multiWindow, "1", "60");
  transaction.get(multiMarker);
  const transactionResults = await transaction.exec();
  assert.equal(transactionResults?.length, 3);
  assert.deepEqual(transactionResults?.[0], [null, "OK"]);
  assert.deepEqual(transactionResults?.[1], [null, [1, 1, 1, 60]]);
  assert.deepEqual(transactionResults?.[2], [null, "multi-value"]);

  const ttlSeconds = "300";
  const maximumResults = "50";
  const attributePrefix = businessPrefix + "derived:index:";
  const filterPrefix = businessPrefix + "derived:filter:";
  const statsPrefix = businessPrefix + "derived:stats:";
  const validationArguments = [
    attributePrefix,
    "axis:pc:dark,axis:pc:light,axis:mb:dark,axis:mb:light",
    "theme,tag,author",
    "63",
    filterPrefix,
    statsPrefix,
    "1000",
    "500",
    "4",
    "20",
    "16384"
  ];
  const registryKeys = (label) => [
    businessPrefix + label + ":registry:lru",
    businessPrefix + label + ":registry:counts",
    businessPrefix + label + ":registry:kinds",
    businessPrefix + label + ":registry:signatures"
  ];
  const installRegistryMember = async (
    keys,
    member,
    count,
    kind,
    signature
  ) => {
    await redisClient.redis.zadd(keys[0], "1", member);
    await redisClient.redis.hset(keys[1], member, count);
    await redisClient.redis.hset(keys[2], member, kind);
    await redisClient.redis.hset(keys[3], member, signature);
  };

  const indexedRegistry = registryKeys("indexed");
  const indexedKey = attributePrefix + "theme:night";
  const indexedMetaKey = businessPrefix + "derived:index-meta:theme:night";
  const indexedToken = "a".repeat(32);
  const indexedNow = "2026-08-21T00:00:00.000Z";
  await installRegistryMember(
    indexedRegistry,
    indexedKey,
    "1",
    "attribute",
    ""
  );
  await redisClient.redis.zadd(indexedKey, "1", "image:one");
  await redisClient.redis.expire(indexedKey, 300);
  await redisClient.redis.hset(indexedMetaKey, {
    applied_revision: "42",
    count: "1",
    built_at: indexedNow,
    last_accessed: indexedNow,
    instance_token: indexedToken
  });
  await redisClient.redis.expire(indexedMetaKey, 300);
  assert.equal(await redisClient.redis.imageshowTouchReadyImageIndexedResult(
    indexedKey,
    indexedMetaKey,
    ...indexedRegistry,
    indexedKey,
    "1",
    "42",
    "2026-08-21T00:00:01.000Z",
    ttlSeconds,
    indexedToken,
    "5",
    "attribute",
    "",
    "2",
    maximumResults,
    "10",
    ...validationArguments
  ), 1);
  assert.equal(
    await redisClient.redis.hget(indexedMetaKey, "last_accessed"),
    "2026-08-21T00:00:01.000Z"
  );
  await redisClient.redis.hdel(indexedRegistry[3], indexedKey);
  assert.equal(await redisClient.redis.imageshowTouchReadyImageIndexedResult(
    indexedKey,
    indexedMetaKey,
    ...indexedRegistry,
    indexedKey,
    "1",
    "42",
    "2026-08-21T00:00:02.000Z",
    ttlSeconds,
    indexedToken,
    "5",
    "attribute",
    "",
    "3",
    maximumResults,
    "10",
    ...validationArguments
  ), -1);

  const statsRegistry = registryKeys("stats");
  const statsSignature = "b".repeat(64);
  const statsKey = statsPrefix + statsSignature;
  const serializedStats = "{\\\"total\\\":1}";
  await installRegistryMember(
    statsRegistry,
    statsKey,
    "0",
    "stats-result",
    statsSignature
  );
  await redisClient.redis.set(statsKey, serializedStats, "EX", 300);
  assert.equal(await redisClient.redis.imageshowTouchReadyImageStatsResult(
    statsKey,
    statsKey,
    ...statsRegistry,
    statsKey,
    serializedStats,
    ttlSeconds,
    statsSignature,
    "2",
    maximumResults,
    "10",
    ...validationArguments
  ), 1);
  assert.equal(await redisClient.redis.imageshowTouchReadyImageStatsResult(
    statsKey,
    statsKey,
    ...statsRegistry,
    statsKey,
    "{\\\"total\\\":2}",
    ttlSeconds,
    statsSignature,
    "3",
    maximumResults,
    "10",
    ...validationArguments
  ), 0);

  const filterSourceA = businessPrefix + "filter:source:a";
  const filterSourceB = businessPrefix + "filter:source:b";
  const filterDestination = businessPrefix + "filter:destination";
  await redisClient.redis.zadd(filterSourceA, "1", "one", "2", "shared");
  await redisClient.redis.zadd(filterSourceB, "2", "shared", "3", "three");
  assert.deepEqual(await redisClient.redis.imageshowStoreReadyImageFilterSet(
    "3",
    filterSourceA,
    filterSourceB,
    filterDestination,
    "2",
    "2",
    "ZUNIONSTORE",
    "3",
    "60"
  ), [1, 3, 1, 3]);
  assert.deepEqual(await redisClient.redis.imageshowStoreReadyImageFilterSet(
    "3",
    filterSourceA,
    filterSourceB,
    filterDestination,
    "99",
    "2",
    "ZUNIONSTORE",
    "3",
    "60"
  ), [0, 1, 2]);

  const publishedKey = businessPrefix + "attribute:published";
  const publishedMetaKey = businessPrefix + "attribute:meta";
  const publishedTemporaryKey = businessPrefix + "attribute:temporary";
  const publishedToken = "c".repeat(32);
  await redisClient.redis.zadd(
    publishedTemporaryKey,
    "1",
    "one",
    "2",
    "two"
  );
  assert.equal(
    await redisClient.redis.imageshowPublishReadyImageAttributeIndex(
      publishedKey,
      publishedMetaKey,
      publishedTemporaryKey,
      "2",
      "42",
      indexedNow,
      indexedNow,
      publishedToken,
      ttlSeconds
    ),
    1
  );
  assert.equal(await redisClient.redis.zcard(publishedKey), 2);
  assert.equal(
    await redisClient.redis.hget(publishedMetaKey, "applied_revision"),
    "42"
  );
  assert.equal(
    await redisClient.redis.imageshowPublishReadyImageAttributeIndex(
      publishedKey,
      publishedMetaKey,
      businessPrefix + "attribute:missing",
      "1",
      "43",
      indexedNow,
      indexedNow,
      publishedToken,
      ttlSeconds
    ),
    0
  );
  assert.equal(
    await redisClient.redis.hget(publishedMetaKey, "applied_revision"),
    "42"
  );

  const sampleMetaKey = businessPrefix + "sample:core:meta";
  const sampleIntegrityKey = businessPrefix + "sample:core:integrity";
  const sampleCoreIndexKey = businessPrefix + "sample:core:index";
  const sampleItemsKey = businessPrefix + "sample:core:items";
  const sampleMembers = ["image:first", "image:second", "image:third"];
  const sampleValues = new Map(sampleMembers.map((member, index) => [
    member,
    JSON.stringify({ id: member.slice("image:".length), index })
  ]));
  await redisClient.redis.hset(sampleMetaKey, {
    state: "ready",
    applied_revision: "42",
    item_count: "3"
  });
  await redisClient.redis.hset(sampleIntegrityKey, {
    [sampleCoreIndexKey]: "3",
    [sampleItemsKey]: "3"
  });
  await redisClient.redis.zadd(
    sampleCoreIndexKey,
    ...sampleMembers.flatMap((member, index) => [String(index + 1), member])
  );
  await redisClient.redis.hset(
    sampleItemsKey,
    Object.fromEntries(sampleValues)
  );
  const coreSampleArguments = [
    sampleMetaKey,
    sampleIntegrityKey,
    sampleCoreIndexKey,
    sampleItemsKey,
    "42",
    "3",
    "2",
    "1",
    "30",
    "200"
  ];
  const coreSample = await redisClient.redis.imageshowSampleReadyImageCoreIndex(
    ...coreSampleArguments
  );
  assert.deepEqual(coreSample.slice(0, 2), [1, 3]);
  assert.equal(coreSample.length, 8);
  for (let index = 0; index < 3; index += 1) {
    const member = String(coreSample[2 + index * 2]);
    assert.equal(coreSample[3 + index * 2], sampleValues.get(member));
  }

  const emptyMetaKey = businessPrefix + "sample:empty:meta";
  const emptyIntegrityKey = businessPrefix + "sample:empty:integrity";
  const emptyIndexKey = businessPrefix + "sample:empty:index";
  const emptyItemsKey = businessPrefix + "sample:empty:items";
  await redisClient.redis.hset(emptyMetaKey, {
    state: "ready",
    applied_revision: "42",
    item_count: "0"
  });
  await redisClient.redis.hset(emptyIntegrityKey, {
    [emptyIndexKey]: "0",
    [emptyItemsKey]: "0"
  });
  assert.deepEqual(
    await redisClient.redis.imageshowSampleReadyImageCoreIndex(
      emptyMetaKey,
      emptyIntegrityKey,
      emptyIndexKey,
      emptyItemsKey,
      "42",
      "0",
      "1",
      "0",
      "30",
      "200"
    ),
    [2, 0]
  );

  const sampleAttributeIndexKey = businessPrefix + "sample:attribute:index";
  const sampleAttributeMetaKey = businessPrefix + "sample:attribute:meta";
  const sampleAttributeToken = "d".repeat(32);
  await redisClient.redis.zadd(
    sampleAttributeIndexKey,
    "1",
    sampleMembers[0],
    "2",
    sampleMembers[1]
  );
  await redisClient.redis.expire(sampleAttributeIndexKey, 300);
  await redisClient.redis.hset(sampleAttributeMetaKey, {
    applied_revision: "42",
    count: "2",
    built_at: indexedNow,
    last_accessed: indexedNow,
    instance_token: sampleAttributeToken
  });
  await redisClient.redis.expire(sampleAttributeMetaKey, 300);
  const derivedSampleArguments = [
    sampleMetaKey,
    sampleIntegrityKey,
    sampleCoreIndexKey,
    sampleItemsKey,
    sampleAttributeIndexKey,
    sampleAttributeMetaKey,
    "42",
    "3",
    "2",
    sampleAttributeToken,
    "attribute",
    "1",
    "0",
    "30",
    "200",
    "250000"
  ];
  const attributeSample = await redisClient.redis
    .imageshowSampleReadyImageDerivedIndex(...derivedSampleArguments);
  assert.deepEqual(attributeSample.slice(0, 2), [1, 2]);
  assert.equal(attributeSample.length, 6);

  const sampleFilterIndexKey = businessPrefix + "sample:filter:index";
  const sampleFilterMetaKey = businessPrefix + "sample:filter:meta";
  const sampleFilterToken = "e".repeat(32);
  await redisClient.redis.zadd(sampleFilterIndexKey, "1", sampleMembers[2]);
  await redisClient.redis.expire(sampleFilterIndexKey, 300);
  await redisClient.redis.hset(sampleFilterMetaKey, {
    applied_revision: "42",
    count: "1",
    built_at: indexedNow,
    instance_token: sampleFilterToken
  });
  await redisClient.redis.expire(sampleFilterMetaKey, 300);
  assert.deepEqual((await redisClient.redis.imageshowSampleReadyImageDerivedIndex(
    sampleMetaKey,
    sampleIntegrityKey,
    sampleCoreIndexKey,
    sampleItemsKey,
    sampleFilterIndexKey,
    sampleFilterMetaKey,
    "42",
    "3",
    "1",
    sampleFilterToken,
    "filter",
    "1",
    "0",
    "30",
    "200",
    "250000"
  )).slice(0, 2), [1, 1]);

  await redisClient.redis.hset(sampleMetaKey, "applied_revision", "43");
  assert.deepEqual(
    await redisClient.redis.imageshowSampleReadyImageCoreIndex(
      ...coreSampleArguments
    ),
    [-3, 0]
  );
  await redisClient.redis.hset(sampleMetaKey, "applied_revision", "42");
  assert.deepEqual((await redisClient.redis.imageshowSampleReadyImageDerivedIndex(
    ...derivedSampleArguments.slice(0, 9),
    "f".repeat(32),
    ...derivedSampleArguments.slice(10)
  )).slice(0, 2), [-4, 0]);
  await redisClient.redis.persist(sampleAttributeMetaKey);
  assert.deepEqual((await redisClient.redis.imageshowSampleReadyImageDerivedIndex(
    ...derivedSampleArguments
  )).slice(0, 2), [-5, 0]);
  await redisClient.redis.expire(sampleAttributeMetaKey, 300);
  await redisClient.redis.hset(sampleAttributeMetaKey, "built_at", "invalid");
  assert.deepEqual((await redisClient.redis.imageshowSampleReadyImageDerivedIndex(
    ...derivedSampleArguments
  )).slice(0, 2), [-2, 0]);
  await redisClient.redis.hset(
    sampleAttributeMetaKey,
    "built_at",
    "2026-13-40T25:61:61.999Z"
  );
  assert.deepEqual((await redisClient.redis.imageshowSampleReadyImageDerivedIndex(
    ...derivedSampleArguments
  )).slice(0, 2), [-2, 0]);
  await redisClient.redis.hset(sampleAttributeMetaKey, "built_at", indexedNow);
  await redisClient.redis.del(sampleAttributeIndexKey);
  assert.deepEqual((await redisClient.redis.imageshowSampleReadyImageDerivedIndex(
    ...derivedSampleArguments
  )).slice(0, 2), [-5, 0]);
  await redisClient.redis.zadd(
    sampleAttributeIndexKey,
    "1",
    sampleMembers[0],
    "2",
    sampleMembers[1]
  );
  await redisClient.redis.expire(sampleAttributeIndexKey, 300);
  await redisClient.redis.zrem(sampleAttributeIndexKey, sampleMembers[0]);
  assert.deepEqual((await redisClient.redis.imageshowSampleReadyImageDerivedIndex(
    ...derivedSampleArguments
  )).slice(0, 2), [-2, 0]);
  await redisClient.redis.zadd(sampleAttributeIndexKey, "1", sampleMembers[0]);
  await redisClient.redis.expire(sampleAttributeIndexKey, 300);

  await redisClient.redis.hset(
    sampleIntegrityKey,
    sampleCoreIndexKey,
    "2"
  );
  assert.deepEqual(
    await redisClient.redis.imageshowSampleReadyImageCoreIndex(
      ...coreSampleArguments
    ),
    [-1, 0]
  );
  await redisClient.redis.hset(
    sampleIntegrityKey,
    sampleCoreIndexKey,
    "3"
  );

  const orphanIndexKey = businessPrefix + "sample:orphan:index";
  const orphanMetaKey = businessPrefix + "sample:orphan:meta";
  const sampleOrphanToken = "f".repeat(32);
  await redisClient.redis.zadd(orphanIndexKey, "1", "image:orphan");
  await redisClient.redis.expire(orphanIndexKey, 300);
  await redisClient.redis.hset(orphanMetaKey, {
    applied_revision: "42",
    count: "1",
    built_at: indexedNow,
    instance_token: sampleOrphanToken
  });
  await redisClient.redis.expire(orphanMetaKey, 300);
  assert.deepEqual(
    await redisClient.redis.imageshowSampleReadyImageDerivedIndex(
      sampleMetaKey,
      sampleIntegrityKey,
      sampleCoreIndexKey,
      sampleItemsKey,
      orphanIndexKey,
      orphanMetaKey,
      "42",
      "3",
      "1",
      sampleOrphanToken,
      "filter",
      "1",
      "0",
      "30",
      "200",
      "250000"
    ),
    [-7, 1, "image:orphan", null]
  );

  await redisClient.redis.hdel(sampleItemsKey, sampleMembers[0]);
  await redisClient.redis.hset(sampleItemsKey, "image:extra", "{\\\"id\\\":\\\"extra\\\"}");
  const missingCoreSample = await redisClient.redis
    .imageshowSampleReadyImageCoreIndex(...coreSampleArguments);
  assert.equal(missingCoreSample[0], -6);
  assert.equal(missingCoreSample[1], 3);
  assert.ok(missingCoreSample.includes(null));
  await redisClient.redis.hdel(sampleItemsKey, "image:extra");
  await redisClient.redis.hset(
    sampleItemsKey,
    sampleMembers[0],
    sampleValues.get(sampleMembers[0])
  );

  await redisClient.redis.call("CONFIG", "RESETSTAT");
  await redisClient.redis.call("SCRIPT", "FLUSH");
  await redisClient.redis.imageshowSampleReadyImageCoreIndex(
    ...coreSampleArguments
  );
  await redisClient.redis.imageshowSampleReadyImageCoreIndex(
    ...coreSampleArguments
  );
  const sampleCommandStats = String(await redisClient.redis.call(
    "INFO",
    "commandstats"
  ));
  const sampleCommandCallCount = (command) => Number(
    new RegExp("^cmdstat_" + command + ":calls=(\\\\d+)", "m")
      .exec(sampleCommandStats)?.[1] ?? -1
  );
  assert.equal(sampleCommandCallCount("eval"), 1, sampleCommandStats);
  assert.equal(sampleCommandCallCount("evalsha"), 2, sampleCommandStats);

  await redisClient.redis.call("SCRIPT", "FLUSH");
  const concurrentSamples = await Promise.all(Array.from(
    { length: 8 },
    () => redisClient.redis.imageshowSampleReadyImageCoreIndex(
      ...coreSampleArguments
    )
  ));
  assert.ok(concurrentSamples.every((sample) => (
    sample[0] === 1 && sample[1] === 3
  )));

  const samplePipelineMarker = businessPrefix + "sample:pipeline:marker";
  const samplePipeline = redisClient.redis.pipeline();
  samplePipeline.set(samplePipelineMarker, "sample-pipeline");
  samplePipeline.imageshowSampleReadyImageCoreIndex(...coreSampleArguments);
  samplePipeline.get(samplePipelineMarker);
  const samplePipelineResults = await samplePipeline.exec();
  assert.equal(samplePipelineResults?.length, 3);
  assert.equal(samplePipelineResults?.[1]?.[0], null);
  assert.deepEqual(
    (samplePipelineResults?.[1]?.[1] as unknown[]).slice(0, 2),
    [1, 3]
  );

  const sampleMultiMarker = businessPrefix + "sample:multi:marker";
  await redisClient.redis.imageshowSampleReadyImageDerivedIndex(
    ...derivedSampleArguments
  );
  const sampleMulti = redisClient.redis.multi();
  sampleMulti.set(sampleMultiMarker, "sample-multi");
  sampleMulti.imageshowSampleReadyImageDerivedIndex(...derivedSampleArguments);
  sampleMulti.get(sampleMultiMarker);
  const sampleMultiResults = await sampleMulti.exec();
  assert.equal(sampleMultiResults?.length, 3);
  assert.equal(sampleMultiResults?.[1]?.[0], null);
  assert.deepEqual(
    (sampleMultiResults?.[1]?.[1] as unknown[]).slice(0, 2),
    [1, 2]
  );

  const firstSampleConnection = redisClient.redis.duplicate({
    lazyConnect: true,
    retryStrategy: () => 1
  });
  await firstSampleConnection.connect();
  await firstSampleConnection.ping();
  assert.deepEqual((await firstSampleConnection
    .imageshowSampleReadyImageCoreIndex(...coreSampleArguments)).slice(0, 2), [1, 3]);
  await firstSampleConnection.quit();
  const replacementSampleConnection = redisClient.redis.duplicate({
    lazyConnect: true
  });
  await replacementSampleConnection.connect();
  assert.deepEqual((await replacementSampleConnection
    .imageshowSampleReadyImageCoreIndex(...coreSampleArguments)).slice(0, 2), [1, 3]);
  await replacementSampleConnection.quit();

  let businessCursor = "0";
  do {
    const [nextCursor, keys] = await redisClient.redis.scan(
      businessCursor,
      "MATCH",
      businessPrefix + "*",
      "COUNT",
      "100"
    );
    businessCursor = nextCursor;
    if (keys.length > 0) await redisClient.redis.unlink(...keys);
  } while (businessCursor !== "0");

  const readyCacheStatus = await readyCacheCoordinator
    .initializeReadyImageCacheCoordinator();
  assert.equal(readyCacheStatus.readable, true);
  const initialReadyMeta = readyCacheStatus.meta;
  assert.ok(initialReadyMeta);
  assert.equal(initialReadyMeta.state, "ready");
  assert.equal(initialReadyMeta.itemCount, 3);
  assert.equal(initialReadyMeta.processed, 0);
  assert.equal(initialReadyMeta.total, 0);
  assert.ok(Number.isFinite(Date.parse(initialReadyMeta.lastUpdatedAt)));
  assert.ok(Number.isFinite(Date.parse(initialReadyMeta.fullRebuildStartedAt)));
  assert.ok(Number.isFinite(Date.parse(initialReadyMeta.fullRebuildCompletedAt)));
  assert.ok(initialReadyMeta.lastFullRebuildCoreMemoryBytes > 0);
  assert.ok(Number.isFinite(Date.parse(
    initialReadyMeta.lastFullRebuildMeasuredAt
  )));
  const initialFullRebuildSnapshot = {
    startedAt: initialReadyMeta.fullRebuildStartedAt,
    completedAt: initialReadyMeta.fullRebuildCompletedAt,
    memoryBytes: initialReadyMeta.lastFullRebuildCoreMemoryBytes,
    measuredAt: initialReadyMeta.lastFullRebuildMeasuredAt
  };


  const manyImageUpdate = await imageUpdate.updateImages([
    { id: imageUpdateIds.first, title: "first" },
    { id: imageUpdateIds.missing, title: "missing" },
    { id: imageUpdateIds.third, description: "third" }
  ]);
  assert.deepEqual(
    manyImageUpdate.results.map((result) => [
      result.id,
      result.status,
      result.status === "failed" ? result.code : null
    ]),
    [
      [imageUpdateIds.first, "updated", null],
      [imageUpdateIds.missing, "failed", "not_found"],
      [imageUpdateIds.third, "updated", null]
    ]
  );
  assert.equal(manyImageUpdate.updated, 2);
  assert.equal(manyImageUpdate.failed, 1);
  const incrementalMeta = await readyCacheMeta.readReadyImageCacheMeta();
  assert.ok(incrementalMeta);
  assert.equal(incrementalMeta.itemCount, 3);
  assert.equal(incrementalMeta.processed, 0);
  assert.equal(incrementalMeta.total, 0);
  assert.deepEqual({
    startedAt: incrementalMeta.fullRebuildStartedAt,
    completedAt: incrementalMeta.fullRebuildCompletedAt,
    memoryBytes: incrementalMeta.lastFullRebuildCoreMemoryBytes,
    measuredAt: incrementalMeta.lastFullRebuildMeasuredAt
  }, initialFullRebuildSnapshot);
  assert.ok(
    Date.parse(incrementalMeta.lastUpdatedAt)
      >= Date.parse(initialReadyMeta.lastUpdatedAt)
  );
  const incrementalStatus = await readyCacheAdminStatus
    .readReadyImageCacheAdminStatus(
      String(await readReadyRevision())
    );
  assert.equal(incrementalStatus.item_count, 3);
  assert.equal(incrementalStatus.processed, null);
  assert.equal(incrementalStatus.total, null);
  assert.equal(
    incrementalStatus.last_updated_at,
    incrementalMeta.lastUpdatedAt
  );
  assert.equal(incrementalStatus.full_rebuild_duration_ms, Math.max(
    0,
    Date.parse(incrementalMeta.fullRebuildCompletedAt)
      - Date.parse(incrementalMeta.fullRebuildStartedAt)
  ));

  const redisDeepCheck = await redisInspect.inspectRedisState(undefined, {
    deadlineMs: 5_000,
    maxKeys: 10_000,
    pipelineMaxCommands: 16
  });
  assert.equal(redisDeepCheck.deep_inspection.complete, true);
  assert.equal(redisDeepCheck.deep_inspection.source, "deep");
  assert.ok(Number.isFinite(Date.parse(
    redisDeepCheck.deep_inspection.measured_at
  )));
  assert.equal(
    redisDeepCheck.deep_inspection.image_projection_usage.core.key_count,
    8
  );
  assert.ok(
    redisDeepCheck.deep_inspection.image_projection_usage.core.member_count
      >= incrementalMeta.itemCount
  );
  let deepCursor = "0";
  const directCoreKeys = new Set();
  do {
    const [nextCursor, keys] = await redisClient.redis.scan(
      deepCursor,
      "MATCH",
      "imageshow:cache:images:*",
      "COUNT",
      100
    );
    deepCursor = nextCursor;
    for (const key of keys) {
      if (!key.startsWith("imageshow:cache:images:derived:")) {
        directCoreKeys.add(key);
      }
    }
  } while (deepCursor !== "0");
  const directCoreMemory = (await Promise.all(
    [...directCoreKeys].map((key) => redisClient.redis.call(
      "MEMORY",
      "USAGE",
      key,
      "SAMPLES",
      "0"
    ))
  )).reduce((sum, value) => sum + Number(value ?? 0), 0);
  assert.equal(
    redisDeepCheck.deep_inspection.image_projection_usage.core.memory_bytes,
    directCoreMemory
  );
  const singleImageUpdate = await imageUpdate.updateImages([{
    id: imageUpdateIds.first,
    title: "single"
  }]);
  assert.deepEqual(singleImageUpdate, {
    updated: 1,
    failed: 0,
    results: [{ id: imageUpdateIds.first, status: "updated" }]
  });
  assert.deepEqual(
    (await database.pool.query(
      "SELECT id::text, title, description FROM metadata "
        + "WHERE id=ANY($1::uuid[]) ORDER BY id",
      [[imageUpdateIds.first, imageUpdateIds.third]]
    )).rows,
    [
      { id: imageUpdateIds.first, title: "single", description: "" },
      { id: imageUpdateIds.third, title: "", description: "third" }
    ].sort((left, right) => left.id.localeCompare(right.id))
  );

  const readAtomicImage = async (id) => (await database.pool.query(
    \`SELECT title, ARRAY(
       SELECT tag_slug FROM image_tag
        WHERE image_id=metadata.id ORDER BY tag_slug
     ) AS tags
       FROM metadata WHERE id=$1\`,
    [id]
  )).rows[0];

  const revisionBeforeAtomicUpdate = await readReadyRevision();
  assert.equal((await imageUpdate.updateImages([{
    id: imageUpdateIds.first,
    title: "atomic",
    tags: ["atomic-tag"]
  }])).failed, 0);
  assert.equal(await readReadyRevision(), revisionBeforeAtomicUpdate + 1n);
  assert.deepEqual(await readAtomicImage(imageUpdateIds.first), {
    title: "atomic",
    tags: ["atomic-tag"]
  });

  const revisionBeforeNoop = await readReadyRevision();
  assert.deepEqual(await imageUpdate.updateImages([{
    id: imageUpdateIds.first,
    title: "atomic",
    tags: ["atomic-tag"]
  }]), {
    updated: 1,
    failed: 0,
    results: [{ id: imageUpdateIds.first, status: "updated" }]
  });
  assert.equal(await readReadyRevision(), revisionBeforeNoop);

  assert.equal((await imageUpdate.updateImages([{
    id: imageUpdateIds.third,
    title: "stable",
    tags: ["stable-tag"]
  }])).failed, 0);
  await database.pool.query(\`
    CREATE OR REPLACE FUNCTION imageshow_test_reject_atomic_tag()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NEW.tag_slug = 'atomic-fail' THEN
        RAISE EXCEPTION 'forced atomic image update failure';
      END IF;
      RETURN NEW;
    END;
    $function$;
    CREATE TRIGGER imageshow_test_reject_atomic_tag
      BEFORE INSERT ON image_tag
      FOR EACH ROW EXECUTE FUNCTION imageshow_test_reject_atomic_tag();
  \`);
  const revisionBeforeRollback = await readReadyRevision();
  const rolledBackUpdate = await imageUpdate.updateImages([{
    id: imageUpdateIds.third,
    title: "rolled-back",
    tags: ["atomic-fail"]
  }]);
  assert.equal(rolledBackUpdate.updated, 0);
  assert.equal(rolledBackUpdate.failed, 1);
  assert.equal(rolledBackUpdate.results[0]?.status, "failed");
  assert.equal(await readReadyRevision(), revisionBeforeRollback);
  assert.deepEqual(await readAtomicImage(imageUpdateIds.third), {
    title: "stable",
    tags: ["stable-tag"]
  });
  assert.equal(Number((await database.pool.query(
    "SELECT count(*)::int AS count FROM tag WHERE slug='atomic-fail'"
  )).rows[0].count), 0);
  await database.pool.query(\`
    DROP TRIGGER imageshow_test_reject_atomic_tag ON image_tag;
    DROP FUNCTION imageshow_test_reject_atomic_tag();
  \`);

  const revisionBeforeOverlap = await readReadyRevision();
  const completionOrder = [];
  const leftUpdate = imageUpdate.updateImages([
    { id: imageUpdateIds.first, description: "left-a" },
    { id: imageUpdateIds.third, title: "left-b", tags: ["left-tag"] }
  ]).then((result) => {
    completionOrder.push("left");
    return result;
  });
  const rightUpdate = imageUpdate.updateImages([
    { id: imageUpdateIds.third, title: "right-b", tags: ["right-tag"] },
    { id: imageUpdateIds.fourth, description: "right-c" }
  ]).then((result) => {
    completionOrder.push("right");
    return result;
  });
  const overlappingResults = await Promise.all([leftUpdate, rightUpdate]);
  assert.deepEqual(
    overlappingResults.map((result) => result.results.map((item) => item.status)),
    [["updated", "updated"], ["updated", "updated"]]
  );
  assert.equal(await readReadyRevision(), revisionBeforeOverlap + 4n);
  const expectedLastWriter = completionOrder.at(-1);
  assert.deepEqual(
    await readAtomicImage(imageUpdateIds.third),
    expectedLastWriter === "left"
      ? { title: "left-b", tags: ["left-tag"] }
      : { title: "right-b", tags: ["right-tag"] }
  );

  await readyCacheCoordinator.ensureReadyImageCacheCurrent();
  const revisionBeforeReadyCacheFailure = await readReadyRevision();
  const originalRedisSendCommand = redisClient.redis.sendCommand;
  let readyCacheFailureInjected = false;
  const observedRedisCommands = [];
  redisClient.redis.sendCommand = async function (command, ...args) {
    observedRedisCommands.push(command.name);
    if (command.name !== "ping" && !readyCacheFailureInjected) {
      readyCacheFailureInjected = true;
      throw new Error("injected ready-image cache publish failure");
    }
    return originalRedisSendCommand.call(this, command, ...args);
  };
  await redisClient.redis.ping();
  assert.deepEqual(observedRedisCommands, ["ping"]);
  assert.equal(
    readyCacheCoordinator.getReadyImageCacheCoordinatorStatus().readable,
    true
  );
  let committedThroughReadyCacheFailure;
  try {
    committedThroughReadyCacheFailure = await imageUpdate.updateImages([{
      id: imageUpdateIds.first,
      source: "https://example.com/ready-cache-failure-committed"
    }]);
  } finally {
    redisClient.redis.sendCommand = originalRedisSendCommand;
  }
  assert.deepEqual(committedThroughReadyCacheFailure, {
    updated: 1,
    failed: 0,
    results: [{ id: imageUpdateIds.first, status: "updated" }]
  });
  assert.equal(readyCacheFailureInjected, true);
  assert.equal(await readReadyRevision(), revisionBeforeReadyCacheFailure + 1n);
  assert.equal((await database.pool.query(
    "SELECT source FROM metadata WHERE id=$1",
    [imageUpdateIds.first]
  )).rows[0]?.source, "https://example.com/ready-cache-failure-committed");
  assert.equal(
    (await readyCacheCoordinator.ensureReadyImageCacheCurrent()).appliedRevision,
    String(await readReadyRevision())
  );

  await vocabCache.getTagVocab();
  await vocabCache.getAdminTagList();
  const revisionBeforeVocabularyCacheFailure = await readReadyRevision();
  const originalRedisUnlink = redisClient.redis.unlink;
  const originalRedisSet = redisClient.redis.set;
  let failedUnlinkCalls = 0;
  let failedSetCalls = 0;
  redisClient.redis.unlink = async function () {
    failedUnlinkCalls += 1;
    throw new Error("injected entity cache unlink failure");
  };
  redisClient.redis.set = async function () {
    failedSetCalls += 1;
    throw new Error("injected vocabulary cache set failure");
  };
  let committedThroughVocabularyCacheFailure;
  try {
    committedThroughVocabularyCacheFailure = await imageUpdate.updateImages([{
      id: imageUpdateIds.first,
      tags: ["cache-repair-tag"]
    }]);
  } finally {
    redisClient.redis.unlink = originalRedisUnlink;
    redisClient.redis.set = originalRedisSet;
  }
  assert.ok(failedUnlinkCalls >= 2);
  assert.ok(failedSetCalls >= 1);
  assert.deepEqual(committedThroughVocabularyCacheFailure, {
    updated: 1,
    failed: 0,
    results: [{ id: imageUpdateIds.first, status: "updated" }]
  });
  assert.equal(
    await readReadyRevision(),
    revisionBeforeVocabularyCacheFailure + 1n
  );
  assert.deepEqual(await readAtomicImage(imageUpdateIds.first), {
    title: "atomic",
    tags: ["cache-repair-tag"]
  });
  assert.equal(Number((await database.pool.query(
    "SELECT count(*)::int AS count FROM tag WHERE slug='cache-repair-tag'"
  )).rows[0].count), 1);

  await database.pool.query(
    "DELETE FROM metadata WHERE id=ANY($1::uuid[])",
    [[imageUpdateIds.first, imageUpdateIds.third, imageUpdateIds.fourth]]
  );
  await database.pool.query(
    "DELETE FROM tag WHERE slug=ANY($1::text[])",
    [[
      "atomic-tag",
      "stable-tag",
      "left-tag",
      "right-tag",
      "atomic-fail",
      "cache-repair-tag"
    ]]
  );

  const registryBackend = "registry-contract";
  const registryConfig = {
    endpoint: "https://objects.example.com",
    region: "ap-southeast-1",
    bucket: "gallery",
    access_key_id: "key",
    secret_access_key: "secret",
    force_path_style: false,
    root_path: "/images",
    public_base_url: "https://cdn.example.com",
    connect_timeout_seconds: 15,
    idle_timeout_seconds: 15,
    task_timeout_seconds: 300
  };
  await database.pool.query(
    "INSERT INTO storage_backend (slug, display_name, type, config) "
      + "VALUES ($1, 'Registry contract', 's3', $2::jsonb)",
    [registryBackend, JSON.stringify(registryConfig)]
  );
  registry.invalidateStorageBackendRegistry();
  const registryExampleKey = imagePaths.storageObjectKey(
    "00000000-0000-7000-8000-0000000000aa",
    "webp"
  );
  const projectedRegistryUrls = await publicUrls.publicImageUrls(
    registryExampleKey,
    registryBackend
  );
  assert.equal(
    projectedRegistryUrls.object_url,
    "https://cdn.example.com/images/full/" + registryExampleKey
  );
  const firstRegistryAccess = await registry.resolveStorageAccess(
    registryBackend
  );
  assert.equal(publicUrls.directStorageObjectUrl(
    firstRegistryAccess.config,
    "full",
    registryExampleKey
  ), "https://cdn.example.com/images/full/" + registryExampleKey);

  await backendUpdate.updateStorageBackend(registryBackend, {
    s3: { public_base_url: "https://assets.example.com" }
  });
  const presentationRegistryAccess = await registry.resolveStorageAccess(
    registryBackend
  );
  assert.equal(presentationRegistryAccess.driver, firstRegistryAccess.driver);
  assert.equal(publicUrls.directStorageObjectUrl(
    presentationRegistryAccess.config,
    "full",
    registryExampleKey
  ), "https://assets.example.com/images/full/" + registryExampleKey);

  await database.pool.query(
    "UPDATE storage_backend SET config = config || $2::jsonb WHERE slug=$1",
    [registryBackend, JSON.stringify({ region: "ap-southeast-2" })]
  );
  registry.invalidateStorageBackendRegistry();
  const replacementRegistryAccess = await registry.resolveStorageAccess(
    registryBackend
  );
  assert.notEqual(replacementRegistryAccess.driver, firstRegistryAccess.driver);
  await assert.rejects(
    () => firstRegistryAccess.driver.exists("full", "retired.webp"),
    (error) => error?.code === "storage_driver_retired"
  );

  const registryOriginalPoolQuery = database.pool.query.bind(database.pool);
  let releaseRegistryLoad;
  let registryLoadStarted;
  const registryLoadGate = new Promise((resolve) => {
    releaseRegistryLoad = resolve;
  });
  const registryLoadStartedPromise = new Promise((resolve) => {
    registryLoadStarted = resolve;
  });
  let delayRegistryLoad = true;
  database.pool.query = (text, values) => {
    const query = registryOriginalPoolQuery(text, values);
    if (
      delayRegistryLoad
      && typeof text === "string"
      && text.includes("FROM storage_backend")
    ) {
      delayRegistryLoad = false;
      return query.then(async (result) => {
        registryLoadStarted();
        await registryLoadGate;
        return result;
      });
    }
    return query;
  };
  try {
    registry.invalidateStorageBackendRegistry();
    const pendingRegistryAccess = registry.resolveStorageAccess(
      registryBackend
    );
    await registryLoadStartedPromise;
    await registryOriginalPoolQuery(
      "UPDATE storage_backend SET config = config || $2::jsonb WHERE slug=$1",
      [registryBackend, JSON.stringify({ region: "ap-southeast-3" })]
    );
    registry.invalidateStorageBackendRegistry();
    releaseRegistryLoad();
    const currentRegistryAccess = await pendingRegistryAccess;
    assert.equal(currentRegistryAccess.config.s3.region, "ap-southeast-3");
    assert.notEqual(
      currentRegistryAccess.driver,
      replacementRegistryAccess.driver
    );
  } finally {
    releaseRegistryLoad?.();
    database.pool.query = registryOriginalPoolQuery;
  }

  const inaccessibleAlias = "registry-inaccessible-alias";
  const inaccessibleAliasImage = randomUUID();
  const inaccessibleAliasKey = imagePaths.storageObjectKey(inaccessibleAliasImage, "webp");
  await database.pool.query(
    "INSERT INTO storage_backend (slug, display_name, type, config) "
      + "VALUES ($1, 'Registry inaccessible alias', 's3', $2::jsonb)",
    [
      inaccessibleAlias,
      JSON.stringify({
        ...registryConfig,
        access_key_id: "inaccessible-key",
        secret_access_key: "inaccessible-secret"
      })
    ]
  );
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
      + "theme, ext, md5, thumbnail_size) VALUES "
      + "($1, 'bootstrap-admin', $2, $3, 'pc', 'dark', 'none', 'webp', $4, 1)",
    [inaccessibleAliasImage, inaccessibleAlias, inaccessibleAliasKey, "0".repeat(32)]
  );
  registry.invalidateStorageBackendRegistry();
  const listingAliasAccess = await registry.resolveStorageAccess(registryBackend);
  const inaccessibleAliasAccess = await registry.resolveStorageAccess(inaccessibleAlias);
  assert.notEqual(listingAliasAccess.driver, inaccessibleAliasAccess.driver);
  const originalListingAliasListKeys = listingAliasAccess.driver.listKeys.bind(
    listingAliasAccess.driver
  );
  const originalInaccessibleAliasListKeys = inaccessibleAliasAccess.driver.listKeys.bind(
    inaccessibleAliasAccess.driver
  );
  const originalInaccessibleAliasExists = inaccessibleAliasAccess.driver.exists.bind(
    inaccessibleAliasAccess.driver
  );
  const visibleStorageListing = (prefix) => (async function* () {
    const keys = prefix === "full" ? [inaccessibleAliasKey] : [];
    if (keys.length) yield keys;
    return { complete: true, count: keys.length };
  })();
  listingAliasAccess.driver.listKeys = visibleStorageListing;
  inaccessibleAliasAccess.driver.listKeys = visibleStorageListing;
  inaccessibleAliasAccess.driver.exists = async () => false;
  try {
    const aliasCheck = await storageCheck.checkStorage();
    assert.ok(aliasCheck.unavailable_backends.some((entry) => (
      entry.backend === inaccessibleAlias
      && entry.blocks_maintenance === false
      && String(entry.error).includes("此逻辑后端不可读")
    )), JSON.stringify(aliasCheck));
  } finally {
    listingAliasAccess.driver.listKeys = originalListingAliasListKeys;
    inaccessibleAliasAccess.driver.listKeys = originalInaccessibleAliasListKeys;
    inaccessibleAliasAccess.driver.exists = originalInaccessibleAliasExists;
    await database.pool.query("DELETE FROM metadata WHERE id=$1", [inaccessibleAliasImage]);
    await database.pool.query("DELETE FROM storage_backend WHERE slug=$1", [inaccessibleAlias]);
    registry.invalidateStorageBackendRegistry();
    await registry.listStorageBackends();
  }

  const delayedReadBackend = "delayed-read-contract";
  const delayedReadKey = "registry/delayed-read.webp";
  await database.pool.query(
    "INSERT INTO storage_backend (slug, display_name, type) "
      + "VALUES ($1, 'Delayed read contract', 'local')",
    [delayedReadBackend]
  );
  registry.invalidateStorageBackendRegistry();
  const delayedReadAccess = await registry.resolveStorageAccess(
    delayedReadBackend
  );
  await delayedReadAccess.driver.writeBuffer(
    "full",
    delayedReadKey,
    Buffer.from("must-not-open-through-deleted-alias"),
    "image/webp"
  );
  const delayedReadable = await objectAccess.resolveReadableObject(
    "full",
    delayedReadKey,
    delayedReadBackend
  );
  await database.pool.query(
    "DELETE FROM storage_backend WHERE slug=$1",
    [delayedReadBackend]
  );
  registry.invalidateStorageBackendRegistry();
  await assert.rejects(
    () => delayedReadable.open(),
    (error) => error?.code === "storage_backend_not_found"
  );
  const currentLocalAccess = await registry.resolveStorageAccess("local");
  await removeDriverObject(currentLocalAccess.driver, "full", delayedReadKey);

  const detachedImage = randomUUID();
  const controller = new AbortController();
  await database.runWithAdvisoryLockAcquisitionSignal(controller.signal, () => (
    locks.withStorageLocationReadLock(async (lockSignal) => {
      const captured = await cleanup.captureMoveCleanupObjects([
        {
          prefix: "thumbs",
          key: detachedImage + ".webp",
          backend: "local"
        }
      ]);
      controller.abort(new Error("injected parent abort"));
      assert.equal(
        lockSignal.aborted,
        false,
        "调度取消不得污染已取得 advisory lock 的连接信号"
      );
      await cleanup.enqueueCapturedObjectsForCleanupWithoutLocationLock(
        detachedImage,
        captured,
        "fault_injected_after_publish"
      );
    })
  ));
  const receipt = await database.pool.query(
    "SELECT payload FROM background_job WHERE type='move.cleanup' AND target_id=$1",
    [detachedImage]
  );
  assert.equal(receipt.rowCount, 1);
  assert.equal(
    typeof receipt.rows[0]?.payload?.objects?.[0]?.namespace_identity,
    "string"
  );

  const lockLossReason = new Error("injected advisory connection loss");
  await assert.rejects(
    () => locks.withStorageLocationReadLock(async (lockSignal, lockClient) => {
      lockClient.emit("error", lockLossReason);
      lockSignal.throwIfAborted();
    }),
    (error) => error?.code === "advisory_lock_lost"
      && error?.cause === lockLossReason
  );

  const local = await registry.getStorageBackend("local");
  const localAccess = registry.resolveStorageAccessForConfig(local);

  const cleanupAdmissionPrefix = "cleanup-admission/" + randomUUID();
  const admittedRemovalKey = cleanupAdmissionPrefix + ".active.webp";
  const queuedRemovalKey = cleanupAdmissionPrefix + ".queued.webp";
  await localAccess.driver.writeBuffer(
    "_uploads",
    admittedRemovalKey,
    Buffer.from("active-cleanup-admission"),
    "image/webp"
  );
  await localAccess.driver.writeBuffer(
    "_uploads",
    queuedRemovalKey,
    Buffer.from("queued-cleanup-admission"),
    "image/webp"
  );
  const originalAdmissionRemove = localAccess.driver.removeObjects.bind(
    localAccess.driver
  );
  let releaseAdmittedRemoval;
  const admittedRemovalReleased = new Promise((resolve) => {
    releaseAdmittedRemoval = resolve;
  });
  let markAdmittedRemovalStarted;
  const admittedRemovalStarted = new Promise((resolve) => {
    markAdmittedRemovalStarted = resolve;
  });
  let queuedRemovalStarted = false;
  localAccess.driver.removeObjects = async (objects, options) => {
    if (objects.some((object) => object.key === admittedRemovalKey)) {
      markAdmittedRemovalStarted();
      await admittedRemovalReleased;
    }
    if (objects.some((object) => object.key === queuedRemovalKey)) {
      queuedRemovalStarted = true;
    }
    return originalAdmissionRemove(objects, options);
  };
  const queuedAdmission = new AbortController();
  const queuedAdmissionReason = new Error("cancel queued cleanup admission");
  let activeRemovalOutcome;
  let queuedRemovalOutcome;
  try {
    const activeRemoval = objectAccess.removeStorageObjectsAndConfirm([
      {
        prefix: "_uploads",
        key: admittedRemovalKey,
        storageSlug: "local"
      }
    ], {}, new AbortController().signal).then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason })
    );
    await admittedRemovalStarted;
    const queuedRemoval = objectAccess.removeStorageObjectsAndConfirm([
      {
        prefix: "_uploads",
        key: queuedRemovalKey,
        storageSlug: "local"
      }
    ], {}, queuedAdmission.signal).then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason })
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    queuedAdmission.abort(queuedAdmissionReason);
    releaseAdmittedRemoval();
    [activeRemovalOutcome, queuedRemovalOutcome] = await Promise.all([
      activeRemoval,
      queuedRemoval
    ]);
  } finally {
    releaseAdmittedRemoval();
    localAccess.driver.removeObjects = originalAdmissionRemove;
  }
  assert.equal(activeRemovalOutcome.status, "fulfilled");
  assert.equal(queuedRemovalOutcome.status, "rejected");
  assert.equal(queuedRemovalOutcome.reason, queuedAdmissionReason);
  assert.equal(queuedRemovalStarted, false);
  assert.equal(
    await localAccess.driver.exists("_uploads", admittedRemovalKey),
    false
  );
  assert.equal(
    await localAccess.driver.exists("_uploads", queuedRemovalKey),
    true,
    "取消的中央准入等待不得启动后续 driver 删除"
  );
  await removeDriverObject(localAccess.driver, "_uploads", queuedRemovalKey);

  const classificationRollbackId = randomUUID();
  const classificationRollbackSource = imagePaths.storageObjectKey(classificationRollbackId, "webp");
  const classificationRollbackBody = Buffer.from(
    "atomic-classification-rollback"
  );
  const classificationRollbackMd5 = createHash("md5")
    .update(classificationRollbackBody)
    .digest("hex");
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
      + "theme, ext, md5, thumbnail_size, title) VALUES "
      + "($1, 'bootstrap-admin', 'local', $2, 'pc', 'dark', 'none', 'webp', $3, $4, 'before')",
    [
      classificationRollbackId,
      classificationRollbackSource,
      classificationRollbackMd5,
      classificationRollbackBody.byteLength
    ]
  );
  await localAccess.driver.writeBuffer(
    "full",
    classificationRollbackSource,
    classificationRollbackBody,
    "image/webp"
  );
  await localAccess.driver.writeBuffer(
    "thumbs",
    imagePaths.thumbnailObjectKey(classificationRollbackSource),
    classificationRollbackBody,
    "image/webp"
  );
  await database.pool.query(\`
    CREATE OR REPLACE FUNCTION imageshow_test_reject_classification_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION 'forced classification transaction failure';
    END;
    $function$;
    CREATE TRIGGER imageshow_test_reject_classification_update
      BEFORE UPDATE ON metadata
      FOR EACH ROW EXECUTE FUNCTION imageshow_test_reject_classification_update();
  \`);
  const revisionBeforeClassificationRollback = await readReadyRevision();
  let failedClassificationUpdate;
  try {
    failedClassificationUpdate = await imageUpdate.updateImages([{
      id: classificationRollbackId,
      brightness: "light",
      title: "must-roll-back",
      tags: ["classification-rollback-tag"]
    }]);
  } finally {
    await database.pool.query(\`
      DROP TRIGGER imageshow_test_reject_classification_update ON metadata;
      DROP FUNCTION imageshow_test_reject_classification_update();
    \`);
  }
  assert.equal(failedClassificationUpdate.updated, 0);
  assert.equal(failedClassificationUpdate.failed, 1);
  assert.equal(await readReadyRevision(), revisionBeforeClassificationRollback);
  assert.deepEqual((await database.pool.query(
    "SELECT object_key, brightness, title FROM metadata WHERE id=$1",
    [classificationRollbackId]
  )).rows[0], {
    object_key: classificationRollbackSource,
    brightness: "dark",
    title: "before"
  });
  assert.equal(Number((await database.pool.query(
    "SELECT count(*)::int AS count FROM tag "
      + "WHERE slug='classification-rollback-tag'"
  )).rows[0].count), 0);
  assert.equal(
    Number((await database.pool.query(
      "SELECT count(*)::int AS count FROM background_job "
        + "WHERE target_id=$1 AND type='move.cleanup'",
      [classificationRollbackId]
    )).rows[0].count),
    0,
    "元数据事务失败不得生成存储补偿任务"
  );
  assert.equal(
    await localAccess.driver.exists("full", classificationRollbackSource),
    true
  );
  await database.pool.query(
    "DELETE FROM metadata WHERE id=$1",
    [classificationRollbackId]
  );
  await removeDriverObject(localAccess.driver, "full", classificationRollbackSource);
  await removeDriverObject(
    localAccess.driver,
    "thumbs",
    imagePaths.thumbnailObjectKey(classificationRollbackSource)
  );

  await database.pool.query(
    "INSERT INTO storage_backend (slug, display_name, type, enabled) "
      + "VALUES ('local-migration', 'Local migration', 'local', true)"
  );
  registry.invalidateStorageBackendRegistry();
  const migrationIds = {
    migrated: randomUUID(),
    notFound: randomUUID(),
    sourceMissing: randomUUID(),
    unchanged: randomUUID(),
    failed: randomUUID()
  };
  const addMigrationImage = async (id, storageSlug, body, md5 = undefined) => {
    const key = imagePaths.storageObjectKey(id, "webp");
    await database.pool.query(
      "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
        + "theme, ext, md5, image_size, thumbnail_size, status, deleted_at) VALUES "
        + "($1, 'bootstrap-admin', $2, $3, 'pc', 'dark', 'none', 'webp', $4, $5, $5, "
        + "'deleted', now())",
      [
        id,
        storageSlug,
        key,
        md5 ?? createHash("md5").update(body ?? Buffer.alloc(0)).digest("hex"),
        body?.byteLength ?? 0
      ]
    );
    if (body) {
      await localAccess.driver.writeBuffer("full", key, body, "image/webp");
      await localAccess.driver.writeBuffer(
        "thumbs",
        imagePaths.thumbnailObjectKey(key),
        body,
        "image/webp"
      );
    }
    return key;
  };
  const migratedKey = await addMigrationImage(
    migrationIds.migrated,
    "local",
    Buffer.from("migration-success")
  );
  await addMigrationImage(migrationIds.sourceMissing, "local", null);
  await addMigrationImage(
    migrationIds.unchanged,
    "local-migration",
    Buffer.from("migration-unchanged")
  );
  await addMigrationImage(
    migrationIds.failed,
    "local",
    Buffer.from("migration-integrity-failure"),
    "0".repeat(32)
  );
  const orderedMigrationIds = [
    migrationIds.failed,
    migrationIds.migrated,
    migrationIds.notFound,
    migrationIds.unchanged,
    migrationIds.sourceMissing
  ];
  const migrationReport = await imageStorageMigration.migrateSelectedImagesToStorageBackend(
    orderedMigrationIds,
    "local-migration"
  );
  assert.equal(migrationReport.requested, 5);
  assert.equal(migrationReport.migrated, 1);
  assert.equal(migrationReport.succeeded, 2);
  assert.equal(migrationReport.failed, 3);
  assert.deepEqual(
    migrationReport.results.map((result) => [
      result.id,
      result.status,
      result.status === "failed" ? result.code : null
    ]),
    [
      [migrationIds.failed, "failed", "storage_migration_failed"],
      [migrationIds.migrated, "migrated", null],
      [migrationIds.notFound, "failed", "not_found"],
      [migrationIds.unchanged, "unchanged", null],
      [migrationIds.sourceMissing, "failed", "source_missing"]
    ]
  );
  assert.deepEqual(
    (await imageStorageMigration.migrateSelectedImagesToStorageBackend(
      [migrationIds.unchanged],
      "local-migration"
    )).results,
    [{ id: migrationIds.unchanged, status: "unchanged" }]
  );
  assert.equal(
    (await database.pool.query(
      "SELECT storage_slug FROM metadata WHERE id=$1",
      [migrationIds.migrated]
    )).rows[0]?.storage_slug,
    "local-migration"
  );
  assert.equal(await localAccess.driver.exists("full", migratedKey), true);

  const thumbnailMissingMigrationId = randomUUID();
  const thumbnailMissingMigrationKey = imagePaths.storageObjectKey(thumbnailMissingMigrationId, "webp");
  const thumbnailMissingMigrationBody = Buffer.from(
    "migration-without-thumbnail"
  );
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
      + "theme, ext, md5, image_size, thumbnail_size) VALUES "
      + "($1, 'bootstrap-admin', 'local', $2, 'pc', 'dark', 'none', 'webp', $3, $4, 0)",
    [
      thumbnailMissingMigrationId,
      thumbnailMissingMigrationKey,
      createHash("md5").update(thumbnailMissingMigrationBody).digest("hex"),
      thumbnailMissingMigrationBody.byteLength
    ]
  );
  await localAccess.driver.writeBuffer(
    "full",
    thumbnailMissingMigrationKey,
    thumbnailMissingMigrationBody,
    "image/webp"
  );
  const thumbnailMissingMigration = await imageStorageMigration
    .migrateSelectedImagesToStorageBackend(
      [thumbnailMissingMigrationId],
      "local-migration"
    );
  assert.deepEqual(thumbnailMissingMigration.results, [{
    id: thumbnailMissingMigrationId,
    status: "failed",
    code: "storage_thumbnail_missing",
    message: "图片当前位置的缩略图不存在，请先在检查页运行“存储维护”"
  }]);
  assert.equal(
    (await database.pool.query(
      "SELECT storage_slug FROM metadata WHERE id=$1",
      [thumbnailMissingMigrationId]
    )).rows[0]?.storage_slug,
    "local"
  );
  await database.pool.query(
    "DELETE FROM metadata WHERE id=$1",
    [thumbnailMissingMigrationId]
  );
  await removeDriverObject(localAccess.driver, "full", thumbnailMissingMigrationKey);

  const backendErrorIds = {
    missing: randomUUID(),
    known: randomUUID(),
    unknown: randomUUID()
  };
  await addMigrationImage(
    backendErrorIds.missing,
    "local-migration",
    null
  );
  const backendKnownErrorKey = await addMigrationImage(
    backendErrorIds.known,
    "local-migration",
    Buffer.from("backend-migration-known-error")
  );
  await removeDriverObject(
    localAccess.driver,
    "thumbs",
    imagePaths.thumbnailObjectKey(backendKnownErrorKey)
  );
  const backendUnknownErrorKey = await addMigrationImage(
    backendErrorIds.unknown,
    "local-migration",
    Buffer.from("backend-migration-unknown-error")
  );
  const originalBackendErrorOpenRead = localAccess.driver.openRead;
  localAccess.driver.openRead = async function (...args) {
    if (args[0] === "full" && args[1] === backendUnknownErrorKey) {
      throw new Error("injected backend migration driver failure");
    }
    return originalBackendErrorOpenRead.apply(this, args);
  };
  let backendMigrationReport;
  try {
    backendMigrationReport = await backendMigration.migrateStorageBackendImages(
      "local-migration",
      "local"
    );
  } finally {
    localAccess.driver.openRead = originalBackendErrorOpenRead;
  }
  assert.equal(backendMigrationReport.migration.source, "local-migration");
  assert.equal(backendMigrationReport.migration.target, "local");
  assert.equal(backendMigrationReport.migration.migrated, 2);
  assert.equal(backendMigrationReport.migration.missing, 1);
  assert.equal(backendMigrationReport.migration.error_count, 3);
  assert.equal(backendMigrationReport.migration.error_samples.length, 3);
  assert.equal("errors" in backendMigrationReport.migration, false);
  assert.ok(backendMigrationReport.migration.error_samples.every((sample) => (
    Object.keys(sample).sort().join(",") === "code,id,message,object_key"
      && typeof sample.message === "string"
      && sample.message.length > 0
  )));
  assert.deepEqual(
    Object.fromEntries(backendMigrationReport.migration.error_samples.map(
      ({ id, code }) => [id, code]
    )),
    {
      [backendErrorIds.missing]: "source_object_missing",
      [backendErrorIds.known]: "storage_thumbnail_missing",
      [backendErrorIds.unknown]: "storage_migration_failed"
    }
  );
  assert.equal(
    (await database.pool.query(
      "SELECT storage_slug FROM metadata WHERE id=$1",
      [migrationIds.migrated]
    )).rows[0]?.storage_slug,
    "local"
  );
  const backendErrorFixtureIds = Object.values(backendErrorIds);
  await database.pool.query(
    "DELETE FROM metadata WHERE id=ANY($1::uuid[])",
    [backendErrorFixtureIds]
  );
  for (const key of [backendKnownErrorKey, backendUnknownErrorKey]) {
    await removeDriverObject(localAccess.driver, "full", key);
    await removeDriverObject(
      localAccess.driver,
      "thumbs",
      imagePaths.thumbnailObjectKey(key)
    );
  }

  const existingTargetSource = "migration-missing-source";
  const existingTargetDestination = "migration-existing-target";
  await database.pool.query(
    "INSERT INTO storage_backend (slug, display_name, type, config, enabled) VALUES "
      + "($1, 'Migration missing source', 's3', $3::jsonb, true), "
      + "($2, 'Migration existing target', 's3', $4::jsonb, true)",
    [
      existingTargetSource,
      existingTargetDestination,
      JSON.stringify({
        ...registryConfig,
        bucket: "migration-missing-source",
        root_path: "/existing-target-regression"
      }),
      JSON.stringify({
        ...registryConfig,
        bucket: "migration-existing-target",
        root_path: "/existing-target-regression"
      })
    ]
  );
  registry.invalidateStorageBackendRegistry();
  const missingSourceAccess = await registry.resolveStorageAccess(
    existingTargetSource
  );
  const existingTargetAccess = await registry.resolveStorageAccess(
    existingTargetDestination
  );
  const originalMissingSourceOpenRead = missingSourceAccess.driver.openRead;
  const originalExistingTargetExists = existingTargetAccess.driver.exists;
  const originalExistingTargetOpenRead = existingTargetAccess.driver.openRead;
  const existingTargetIds = [randomUUID(), randomUUID()];
  const existingTargetKeys = new Set(existingTargetIds.map(
    (id) => imagePaths.storageObjectKey(id, "webp")
  ));
  let existingTargetDigestReads = 0;
  missingSourceAccess.driver.openRead = async function (prefix, key, ...rest) {
    if (prefix === "full" && existingTargetKeys.has(key)) {
      throw new apiError.ApiError(
        404,
        "storage_object_not_found",
        "Storage object not found"
      );
    }
    return originalMissingSourceOpenRead.call(this, prefix, key, ...rest);
  };
  existingTargetAccess.driver.exists = async function (prefix, key, ...rest) {
    if (prefix === "full" && existingTargetKeys.has(key)) return true;
    return originalExistingTargetExists.call(this, prefix, key, ...rest);
  };
  existingTargetAccess.driver.openRead = async function (prefix, key, ...rest) {
    if (prefix === "full" && existingTargetKeys.has(key)) {
      existingTargetDigestReads += 1;
      throw new Error("existing target must remain unread when source is missing");
    }
    return originalExistingTargetOpenRead.call(this, prefix, key, ...rest);
  };
  try {
    for (const [index, id] of existingTargetIds.entries()) {
      const key = imagePaths.storageObjectKey(id, "webp");
      const expectedBody = "existing-target-" + index;
      await database.pool.query(
        "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, "
          + "brightness, theme, ext, md5, image_size, thumbnail_size, status, "
          + "deleted_at) VALUES ($1, 'bootstrap-admin', $2, $3, 'pc', 'dark', "
          + "'none', 'webp', $4, $5, $5, 'deleted', now())",
        [
          id,
          existingTargetSource,
          key,
          createHash("md5").update(expectedBody).digest("hex"),
          Buffer.byteLength(expectedBody)
        ]
      );
    }

    const existingTargetSourceRecord = (await database.pool.query(
      "SELECT id, object_key, ext, storage_slug, md5, image_size, thumbnail_size "
        + "FROM metadata WHERE id=$1",
      [existingTargetIds[0]]
    )).rows[0];
    assert.equal(
      await storageMigration.migrateImageToStorageBackend(
        existingTargetSourceRecord,
        existingTargetDestination
      ),
      "missing"
    );

    const selectedMissing = await imageStorageMigration.migrateSelectedImagesToStorageBackend(
      [existingTargetIds[0]],
      existingTargetDestination
    );
    assert.deepEqual(selectedMissing.results, [{
      id: existingTargetIds[0],
      status: "failed",
      code: "source_missing",
      message: "Image storage source is missing"
    }]);

    const backendExistingTargetMissing = await backendMigration
      .migrateStorageBackendImages(existingTargetSource, existingTargetDestination);
    assert.equal(backendExistingTargetMissing.migration.migrated, 0);
    assert.equal(backendExistingTargetMissing.migration.missing, 2);
    assert.equal(backendExistingTargetMissing.migration.error_count, 2);
    assert.deepEqual(
      Object.fromEntries(
        backendExistingTargetMissing.migration.error_samples.map(
          ({ id, code }) => [id, code]
        )
      ),
      Object.fromEntries(existingTargetIds.map((id) => [
        id,
        "source_object_missing"
      ]))
    );
    assert.equal(
      existingTargetDigestReads,
      0,
      "源对象缺失时选定迁移与后台迁移都不得读取或改写已有目标"
    );
  } finally {
    missingSourceAccess.driver.openRead = originalMissingSourceOpenRead;
    existingTargetAccess.driver.exists = originalExistingTargetExists;
    existingTargetAccess.driver.openRead = originalExistingTargetOpenRead;
    await database.pool.query(
      "DELETE FROM metadata WHERE id=ANY($1::uuid[])",
      [existingTargetIds]
    );
    await database.pool.query(
      "DELETE FROM storage_backend WHERE slug=ANY($1::text[])",
      [[existingTargetSource, existingTargetDestination]]
    );
    registry.invalidateStorageBackendRegistry();
  }

  const backendOverflowSource = "local-migration-overflow";
  await database.pool.query(
    "INSERT INTO storage_backend (slug, display_name, type, enabled) "
      + "VALUES ($1, 'Local migration overflow', 'local', true)",
    [backendOverflowSource]
  );
  registry.invalidateStorageBackendRegistry();
  const backendOverflowIds = [];
  for (let index = 0; index < 101; index += 1) {
    const id = randomUUID();
    backendOverflowIds.push(id);
    await addMigrationImage(id, backendOverflowSource, null);
  }
  const backendOverflowReport = await backendMigration.migrateStorageBackendImages(
    backendOverflowSource,
    "local"
  );
  assert.equal(backendOverflowReport.migration.missing, 101);
  assert.equal(backendOverflowReport.migration.error_count, 101);
  assert.equal(backendOverflowReport.migration.error_samples.length, 100);
  assert.equal("errors" in backendOverflowReport.migration, false);
  assert.deepEqual(
    backendOverflowReport.migration.error_samples.map(({ id }) => id),
    [...backendOverflowIds].sort().slice(0, 100),
    "错误总数保持权威，样本只保留稳定顺序的前 100 项"
  );
  assert.ok(backendOverflowReport.migration.error_samples.every(
    ({ code }) => code === "source_object_missing"
  ));
  await database.pool.query(
    "DELETE FROM metadata WHERE id=ANY($1::uuid[])",
    [backendOverflowIds]
  );
  await database.pool.query(
    "DELETE FROM storage_backend WHERE slug=$1",
    [backendOverflowSource]
  );
  registry.invalidateStorageBackendRegistry();

  const waitForAbortReads = async (startedPromise, label) => {
    let timer;
    try {
      await Promise.race([
        startedPromise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(label + " did not enter storage reads")),
            5_000
          );
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const addAbortMigrationImage = async (id, storageSlug) => {
    const key = imagePaths.storageObjectKey(id, "webp");
    const body = Buffer.from("migration-abort-" + storageSlug + "-" + id);
    await database.pool.query(
      "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, "
        + "brightness, theme, ext, md5, image_size, thumbnail_size, status, deleted_at) "
        + "VALUES ($1, 'bootstrap-admin', $2, $3, 'pc', 'dark', 'none', 'webp', $4, $5, $5, "
        + "'deleted', now())",
      [
        id,
        storageSlug,
        key,
        createHash("md5").update(body).digest("hex"),
        body.byteLength
      ]
    );
    await localAccess.driver.writeBuffer("full", key, body, "image/webp");
    await localAccess.driver.writeBuffer(
      "thumbs",
      imagePaths.thumbnailObjectKey(key),
      body,
      "image/webp"
    );
    return { id, key };
  };
  const removeAbortMigrationImages = async (fixtures) => {
    for (const fixture of fixtures) {
      await removeDriverObject(localAccess.driver, "full", fixture.key);
      await removeDriverObject(
        localAccess.driver,
        "thumbs",
        imagePaths.thumbnailObjectKey(fixture.key)
      );
    }
    await database.pool.query(
      "DELETE FROM background_job WHERE target_id=ANY($1::text[])",
      [fixtures.map((fixture) => fixture.id)]
    );
    await database.pool.query(
      "DELETE FROM metadata WHERE id=ANY($1::uuid[])",
      [fixtures.map((fixture) => fixture.id)]
    );
  };

  const migrationConcurrency = storageMigrationAdmission
    .IMAGE_TRANSFER_CONCURRENCY;
  const listAbortFixtures = [];
  for (let index = 0; index < migrationConcurrency + 2; index += 1) {
    listAbortFixtures.push(await addAbortMigrationImage(randomUUID(), "local"));
  }
  const listAbortKeys = new Set(
    listAbortFixtures.map((fixture) => fixture.key)
  );
  const originalListAbortOpenRead = localAccess.driver.openRead;
  let listAbortReadCount = 0;
  let releaseListAbortReads = () => undefined;
  let markListAbortReadsStarted = () => undefined;
  const listAbortReadGate = new Promise((resolve) => {
    releaseListAbortReads = resolve;
  });
  const listAbortReadsStarted = new Promise((resolve) => {
    markListAbortReadsStarted = resolve;
  });
  const expectedListAbortReads = Math.min(
    migrationConcurrency,
    listAbortFixtures.length
  );
  localAccess.driver.openRead = async function (...args) {
    if (args[0] === "full" && listAbortKeys.has(args[1])) {
      listAbortReadCount += 1;
      if (listAbortReadCount === expectedListAbortReads) {
        markListAbortReadsStarted();
      }
      await listAbortReadGate;
    }
    return originalListAbortOpenRead.apply(this, args);
  };
  const listAbortController = new AbortController();
  const listAbortReason = new Error("injected migration list abort");
  const interruptedListMigration = imageStorageMigration.migrateSelectedImagesToStorageBackend(
    listAbortFixtures.map((fixture) => fixture.id),
    "local-migration",
    { signal: listAbortController.signal }
  );
  try {
    await waitForAbortReads(
      listAbortReadsStarted,
      "image migration list"
    );
    listAbortController.abort(listAbortReason);
    releaseListAbortReads();
    await assert.rejects(
      interruptedListMigration,
      (error) => error === listAbortReason
    );
  } finally {
    releaseListAbortReads();
    await interruptedListMigration.catch(() => undefined);
    localAccess.driver.openRead = originalListAbortOpenRead;
  }
  assert.equal(listAbortReadCount, expectedListAbortReads);
  assert.equal(
    Number((await database.pool.query(
      "SELECT count(*) FROM metadata WHERE id=ANY($1::uuid[]) "
        + "AND storage_slug='local'",
      [listAbortFixtures.map((fixture) => fixture.id)]
    )).rows[0]?.count),
    listAbortFixtures.length,
    "请求中止时当前并发片收口，后续图片不得启动或提交迁移"
  );
  await removeAbortMigrationImages(listAbortFixtures);

  const backendAbortSource = "local-abort-source";
  await database.pool.query(
    "INSERT INTO storage_backend (slug, display_name, type, enabled) "
      + "VALUES ($1, 'Local abort source', 'local', true)",
    [backendAbortSource]
  );
  registry.invalidateStorageBackendRegistry();
  const backendAbortFixtures = [];
  for (let index = 0; index < 3; index += 1) {
    backendAbortFixtures.push(await addAbortMigrationImage(
      randomUUID(),
      backendAbortSource
    ));
  }
  const backendAbortKeys = new Set(
    backendAbortFixtures.map((fixture) => fixture.key)
  );
  const originalBackendAbortOpenRead = localAccess.driver.openRead;
  let backendAbortReadCount = 0;
  let releaseBackendAbortRead = () => undefined;
  let markBackendAbortReadStarted = () => undefined;
  const backendAbortReadGate = new Promise((resolve) => {
    releaseBackendAbortRead = resolve;
  });
  const backendAbortReadStarted = new Promise((resolve) => {
    markBackendAbortReadStarted = resolve;
  });
  localAccess.driver.openRead = async function (...args) {
    if (args[0] === "full" && backendAbortKeys.has(args[1])) {
      backendAbortReadCount += 1;
      markBackendAbortReadStarted();
      await backendAbortReadGate;
    }
    return originalBackendAbortOpenRead.apply(this, args);
  };
  const backendAbortController = new AbortController();
  const backendAbortReason = new Error("injected backend migration abort");
  const interruptedBackendMigration = backendMigration.migrateStorageBackendImages(
    backendAbortSource,
    "local-migration",
    { signal: backendAbortController.signal }
  );
  try {
    await waitForAbortReads(
      backendAbortReadStarted,
      "backend migration"
    );
    backendAbortController.abort(backendAbortReason);
    releaseBackendAbortRead();
    await assert.rejects(
      interruptedBackendMigration,
      (error) => error === backendAbortReason
    );
  } finally {
    releaseBackendAbortRead();
    await interruptedBackendMigration.catch(() => undefined);
    localAccess.driver.openRead = originalBackendAbortOpenRead;
  }
  assert.equal(
    backendAbortReadCount,
    Math.min(migrationConcurrency, backendAbortFixtures.length)
  );
  assert.equal(
    Number((await database.pool.query(
      "SELECT count(*) FROM metadata WHERE id=ANY($1::uuid[]) "
        + "AND storage_slug=$2",
      [
        backendAbortFixtures.map((fixture) => fixture.id),
        backendAbortSource
      ]
    )).rows[0]?.count),
    backendAbortFixtures.length,
    "整后端请求中止后只收口已进入固定准入片的项目，且不得提交当前位置"
  );
  await removeAbortMigrationImages(backendAbortFixtures);
  await database.pool.query(
    "DELETE FROM storage_backend WHERE slug=$1",
    [backendAbortSource]
  );
  registry.invalidateStorageBackendRegistry();

  const classificationId = randomUUID();
  const classificationSourceKey = imagePaths.storageObjectKey(classificationId, "webp");
  const classificationBody = Buffer.from("classification-metadata-only");
  const classificationMd5 = createHash("md5")
    .update(classificationBody)
    .digest("hex");
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
      + "theme, ext, md5, image_size, thumbnail_size, status) VALUES "
      + "($1, 'bootstrap-admin', 'local', $2, 'pc', 'dark', 'none', 'webp', $3, $4, $4, "
      + "'ready')",
    [
      classificationId,
      classificationSourceKey,
      classificationMd5,
      classificationBody.byteLength
    ]
  );
  await localAccess.driver.writeBuffer(
    "full",
    classificationSourceKey,
    classificationBody,
    "image/webp"
  );
  await localAccess.driver.writeBuffer(
    "thumbs",
    imagePaths.thumbnailObjectKey(classificationSourceKey),
    classificationBody,
    "image/webp"
  );
  assert.deepEqual(await imageUpdate.updateImages([{
    id: classificationId,
    brightness: "light"
  }]), {
    updated: 1,
    failed: 0,
    results: [{ id: classificationId, status: "updated" }]
  });
  assert.deepEqual((await database.pool.query(
    "SELECT object_key, brightness FROM metadata WHERE id=$1",
    [classificationId]
  )).rows[0], {
    object_key: classificationSourceKey,
    brightness: "light"
  });
  assert.equal(
    await localAccess.driver.exists("full", classificationSourceKey),
    true,
    "分类字段变化只修改 PostgreSQL 元数据"
  );
  assert.equal(
    await localAccess.driver.exists(
      "thumbs",
      imagePaths.thumbnailObjectKey(classificationSourceKey)
    ),
    true
  );
  assert.equal(
    Number((await database.pool.query(
      "SELECT count(*)::int AS count FROM background_job "
        + "WHERE target_id=$1 AND type='move.cleanup'",
      [classificationId]
    )).rows[0].count),
    0
  );
  await database.pool.query("DELETE FROM metadata WHERE id=$1", [classificationId]);
  await removeDriverObject(localAccess.driver, "full", classificationSourceKey);
  await removeDriverObject(
    localAccess.driver,
    "thumbs",
    imagePaths.thumbnailObjectKey(classificationSourceKey)
  );

  const classificationMissingThumbId = randomUUID();
  const classificationMissingThumbSource = imagePaths.storageObjectKey(classificationMissingThumbId, "webp");
  const classificationMissingThumbBody = Buffer.from(
    "classification-without-thumbnail"
  );
  const classificationMissingThumbMd5 = createHash("md5")
    .update(classificationMissingThumbBody)
    .digest("hex");
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
      + "theme, ext, md5, thumbnail_size) VALUES "
      + "($1, 'bootstrap-admin', 'local', $2, 'pc', 'dark', 'none', 'webp', $3, 0)",
    [
      classificationMissingThumbId,
      classificationMissingThumbSource,
      classificationMissingThumbMd5
    ]
  );
  await localAccess.driver.writeBuffer(
    "full",
    classificationMissingThumbSource,
    classificationMissingThumbBody,
    "image/webp"
  );
  assert.equal((await imageUpdate.updateImages([{
    id: classificationMissingThumbId,
    brightness: "light"
  }])).failed, 0);
  assert.deepEqual((await database.pool.query(
    "SELECT object_key, brightness FROM metadata WHERE id=$1",
    [classificationMissingThumbId]
  )).rows[0], {
    object_key: classificationMissingThumbSource,
    brightness: "light"
  });
  assert.equal(
    await localAccess.driver.exists("full", classificationMissingThumbSource),
    true,
    "明确的分类修改不应依赖缩略图或创建新存储位置"
  );
  await database.pool.query(
    "DELETE FROM metadata WHERE id=$1",
    [classificationMissingThumbId]
  );
  await removeDriverObject(localAccess.driver, "full", classificationMissingThumbSource);

  const responseLossId = randomUUID();
  const responseLossBody = Buffer.from("migration-response-loss");
  const responseLossKey = await addMigrationImage(
    responseLossId,
    "local",
    responseLossBody
  );
  const verifyStorageMigrationResponseLoss = async () => {
  const originalPoolConnect = database.pool.connect;
  const migrationPoolQuery = database.pool.query.bind(database.pool);
  let injectedClient;
  let originalInjectedClientQuery;
  let loseNextCommitResponse = true;
  let connectInjectionInstalled = false;
  database.pool.query = async (...args) => {
    const result = await migrationPoolQuery(...args);
    if (
      !connectInjectionInstalled
      && String(args[0]).includes("FROM ready_image_revision")
    ) {
      connectInjectionInstalled = true;
      database.pool.connect = async function () {
        const client = await originalPoolConnect.call(database.pool);
        injectedClient = client;
        const originalClientQuery = client.query.bind(client);
        originalInjectedClientQuery = originalClientQuery;
        client.query = async (...queryArgs) => {
          const queryResult = await originalClientQuery(...queryArgs);
          if (queryArgs[0] === "COMMIT" && loseNextCommitResponse) {
            loseNextCommitResponse = false;
            database.pool.connect = originalPoolConnect;
            throw new Error("injected committed response loss");
          }
          return queryResult;
        };
        return client;
      };
    }
    return result;
  };
  try {
    assert.equal(
      await storageMigration.migrateImageToStorageBackend(
        {
          id: responseLossId,
          object_key: responseLossKey,
          ext: "webp",
          storage_slug: "local",
          md5: createHash("md5").update(responseLossBody).digest("hex"),
          image_size: responseLossBody.byteLength,
          thumbnail_size: responseLossBody.byteLength
        },
        "local-migration"
      ),
      "migrated"
    );
  } finally {
    if (injectedClient && originalInjectedClientQuery) {
      injectedClient.query = originalInjectedClientQuery;
    }
    database.pool.connect = originalPoolConnect;
    database.pool.query = migrationPoolQuery;
  }
  assert.equal(
    (await database.pool.query(
      "SELECT storage_slug FROM metadata WHERE id=$1",
      [responseLossId]
    )).rows[0]?.storage_slug,
    "local-migration"
  );
  };

  const foregroundImage = randomUUID();
  const foregroundObjectKey = imagePaths.storageObjectKey(randomUUID(), "webp");
  const foregroundNextKey = imagePaths.storageObjectKey(foregroundImage, "webp");
  const foregroundFull = Buffer.from("move-cleanup-owned-full");
  const foregroundThumb = Buffer.from("move-cleanup-owned-thumbnail");
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
      + "theme, ext, md5, thumbnail_size) VALUES ($1, 'bootstrap-admin', 'local', $2, 'pc', "
      + "'light', 'none', 'webp', $3, $4)",
    [
      foregroundImage,
      foregroundNextKey,
      createHash("md5").update(foregroundFull).digest("hex"),
      foregroundThumb.byteLength
    ]
  );
  for (const key of [foregroundObjectKey, foregroundNextKey]) {
    await localAccess.driver.writeBuffer("full", key, foregroundFull, "image/webp");
    await localAccess.driver.writeBuffer(
      "thumbs",
      imagePaths.thumbnailObjectKey(key),
      foregroundThumb,
      "image/webp"
    );
  }
  const foregroundCleanupObjects = await cleanup.captureMoveCleanupObjects([
    { prefix: "full", key: foregroundObjectKey, backend: "local" },
    {
      prefix: "thumbs",
      key: imagePaths.thumbnailObjectKey(foregroundObjectKey),
      backend: "local"
    }
  ]);
  await cleanup.enqueueCapturedObjectsForCleanupWithoutLocationLock(
    foregroundImage,
    foregroundCleanupObjects,
    "test_cleanup_re_adoption"
  );
  const foregroundCleanupReceipt = (await database.pool.query(
    "SELECT * FROM background_job WHERE type='move.cleanup' AND target_id=$1",
    [foregroundImage]
  )).rows[0];
  assert.deepEqual(
    Object.keys(foregroundCleanupReceipt.payload).sort(),
    ["objects", "reason", "retain_exhausted"]
  );
  assert.ok(foregroundCleanupReceipt.payload.objects.every((object) => (
    Object.keys(object).sort().join(",")
      === "backend,key,namespace_identity,prefix"
  )));
  await database.pool.query(
    "UPDATE metadata SET object_key=$2, brightness='dark' WHERE id=$1",
    [foregroundImage, foregroundObjectKey]
  );
  const adoptedToken = randomUUID();
  const adoptedCleanupJob = (await database.pool.query(
    "UPDATE background_job SET status='running', execution_token=$2 "
      + "WHERE id=$1 RETURNING *",
    [foregroundCleanupReceipt.id, adoptedToken]
  )).rows[0];
  await cleanupJob.handleMoveCleanupJob(
    adoptedCleanupJob,
    new AbortController().signal
  );
  assert.equal(await jobs.markBackgroundJobSucceeded(adoptedCleanupJob), true);
  assert.equal(
    await localAccess.driver.exists("full", foregroundObjectKey),
    true,
    "删除边界重新采用的原图必须保留"
  );
  assert.equal(
    await localAccess.driver.exists(
      "thumbs",
      imagePaths.thumbnailObjectKey(foregroundObjectKey)
    ),
    true,
    "删除边界重新采用的缩略图必须保留"
  );

  await database.pool.query(
    "UPDATE metadata SET object_key=$2, brightness='light' WHERE id=$1",
    [foregroundImage, foregroundNextKey]
  );
  await cleanup.enqueueCapturedObjectsForCleanupWithoutLocationLock(
    foregroundImage,
    foregroundCleanupObjects,
    "test_cleanup_after_re_adoption"
  );
  const unreferencedToken = randomUUID();
  const unreferencedCleanupJob = (await database.pool.query(
    "UPDATE background_job SET status='running', execution_token=$2 "
      + "WHERE id=$1 RETURNING *",
    [foregroundCleanupReceipt.id, unreferencedToken]
  )).rows[0];
  await cleanupJob.handleMoveCleanupJob(
    unreferencedCleanupJob,
    new AbortController().signal
  );
  assert.equal(
    await jobs.markBackgroundJobSucceeded(unreferencedCleanupJob),
    true
  );
  assert.equal(await localAccess.driver.exists("full", foregroundObjectKey), false);
  assert.equal(
    await localAccess.driver.exists(
      "thumbs",
      imagePaths.thumbnailObjectKey(foregroundObjectKey)
    ),
    false
  );
  assert.equal(await localAccess.driver.exists("full", foregroundNextKey), true);

  const uncertainCleanupImage = randomUUID();
  const uncertainCleanupKey = imagePaths.storageObjectKey(
    uncertainCleanupImage,
    "webp"
  );
  await localAccess.driver.writeBuffer(
    "full",
    uncertainCleanupKey,
    Buffer.from("move-cleanup-delete-response-loss"),
    "image/webp"
  );
  const uncertainCleanupObjects = await cleanup.captureMoveCleanupObjects([
    { prefix: "full", key: uncertainCleanupKey, backend: "local" }
  ]);
  await cleanup.enqueueCapturedObjectsForCleanupWithoutLocationLock(
    uncertainCleanupImage,
    uncertainCleanupObjects,
    "test_cleanup_delete_response_loss"
  );
  const uncertainReceipt = (await database.pool.query(
    "SELECT * FROM background_job WHERE type='move.cleanup' AND target_id=$1",
    [uncertainCleanupImage]
  )).rows[0];
  const uncertainToken = randomUUID();
  const uncertainJob = (await database.pool.query(
    "UPDATE background_job SET status='running', execution_token=$2 "
      + "WHERE id=$1 RETURNING *",
    [uncertainReceipt.id, uncertainToken]
  )).rows[0];
  const originalCleanupRemoveObjects = localAccess.driver.removeObjects.bind(
    localAccess.driver
  );
  let loseCleanupDeleteResponse = true;
  localAccess.driver.removeObjects = async (objects, options) => {
    const results = await originalCleanupRemoveObjects(objects, options);
    if (
      loseCleanupDeleteResponse
      && objects.some((object) => (
        object.prefix === "full" && object.key === uncertainCleanupKey
      ))
    ) {
      loseCleanupDeleteResponse = false;
      throw new Error("injected move cleanup delete response loss");
    }
    return results;
  };
  try {
    await assert.rejects(() => cleanupJob.handleMoveCleanupJob(
      uncertainJob,
      new AbortController().signal
    ));
  } finally {
    localAccess.driver.removeObjects = originalCleanupRemoveObjects;
  }
  assert.equal(
    await localAccess.driver.exists("full", uncertainCleanupKey),
    false,
    "删除响应丢失后对象可以已经不存在"
  );
  await database.pool.query(
    "UPDATE background_job SET status='pending', execution_token=NULL WHERE id=$1",
    [uncertainReceipt.id]
  );
  const retryToken = randomUUID();
  const retryJob = (await database.pool.query(
    "UPDATE background_job SET status='running', execution_token=$2 "
      + "WHERE id=$1 RETURNING *",
    [uncertainReceipt.id, retryToken]
  )).rows[0];
  await cleanupJob.handleMoveCleanupJob(retryJob, new AbortController().signal);
  assert.equal(await jobs.markBackgroundJobSucceeded(retryJob), true);

  const latePublishImage = randomUUID();
  const latePublishKey = imagePaths.storageObjectKey(latePublishImage, "webp");
  const latePublishBody = Buffer.from("late-published-after-client-rejection");
  const latePublishObjects = await cleanup.captureMoveCleanupObjects([{
    prefix: "full",
    key: latePublishKey,
    backend: "local"
  }]);
  const confirmAbsentAfter = new Date(Date.now() + 200);
  await cleanup.enqueueCapturedObjectsForCleanupWithoutLocationLock(
    latePublishImage,
    latePublishObjects,
    "test_cleanup_late_publish",
    { confirmAbsentAfter }
  );
  const latePublishToken = randomUUID();
  const latePublishJob = (await database.pool.query(
    "UPDATE background_job SET status='running', execution_token=$2 "
      + "WHERE type='move.cleanup' AND target_id=$1 RETURNING *",
    [latePublishImage, latePublishToken]
  )).rows[0];
  assert.equal(
    latePublishJob.payload.confirm_absent_after,
    confirmAbsentAfter.toISOString()
  );
  const deferredCleanup = await cleanupJob.handleMoveCleanupJob(
    latePublishJob,
    new AbortController().signal
  );
  assert.equal(deferredCleanup.status, "reschedule");
  assert.ok(deferredCleanup.delayMs > 0);
  assert.equal(
    await jobs.rescheduleBackgroundJob(latePublishJob, deferredCleanup.delayMs),
    true
  );
  await localAccess.driver.writeBuffer(
    "full",
    latePublishKey,
    latePublishBody,
    "image/webp"
  );
  await new Promise((resolve) => setTimeout(
    resolve,
    deferredCleanup.delayMs + 25
  ));
  const latePublishRetryToken = randomUUID();
  const latePublishRetryJob = (await database.pool.query(
    "UPDATE background_job SET status='running', execution_token=$2 "
      + "WHERE id=$1 RETURNING *",
    [latePublishJob.id, latePublishRetryToken]
  )).rows[0];
  assert.deepEqual(
    await cleanupJob.handleMoveCleanupJob(
      latePublishRetryJob,
      new AbortController().signal
    ),
    { status: "succeeded" }
  );
  assert.equal(
    await jobs.markBackgroundJobSucceeded(latePublishRetryJob),
    true
  );
  assert.equal(
    await localAccess.driver.exists("full", latePublishKey),
    false,
    "不确定请求窗口结束后必须清理迟到发布的候选对象"
  );

  const guardedLatePublishImage = randomUUID();
  const guardedLatePublishKey = imagePaths.storageObjectKey(
    guardedLatePublishImage,
    "webp"
  );
  const guardedLatePublishBody = Buffer.from(
    "ingestion-guarded-late-publish"
  );
  const guardedLatePublishToken = randomUUID();
  await cleanup.enqueueObjectsForCleanup(
    guardedLatePublishImage,
    [{
      prefix: "full",
      key: guardedLatePublishKey,
      backend: "local"
    }],
    "ingestion_commit_candidate_guard",
    { guardToken: guardedLatePublishToken }
  );
  let guardedLatePublishJob = (await database.pool.query(
    "UPDATE background_job SET status='running', execution_token=$2 "
      + "WHERE type='move.cleanup' AND target_id=$1 RETURNING *",
    [guardedLatePublishImage, randomUUID()]
  )).rows[0];
  assert.equal(
    guardedLatePublishJob.payload.confirm_absent_after,
    undefined,
    "worker 领取预建 guard 时可以尚未观察到 S3 请求窗口"
  );
  let lateGuardPublish;
  const guardedTransferStorage = {
    config: {
      slug: "local",
      type: "s3",
      s3: { task_timeout_seconds: 0.5 }
    },
    driver: {
      async openRead(prefix, key) {
        assert.equal(prefix, "_uploads");
        assert.equal(key, "guarded-source.webp");
        return {
          body: Readable.from([guardedLatePublishBody]),
          size: guardedLatePublishBody.length,
          totalSize: guardedLatePublishBody.length,
          backend: "s3"
        };
      },
      async exists() { return false; },
      async copy(_fromPrefix, _fromKey, toPrefix, toKey) {
        assert.equal(toPrefix, "full");
        assert.equal(toKey, guardedLatePublishKey);
        const armedBeforeCopy = (await database.pool.query(
          "SELECT payload->>'confirm_absent_after' AS deadline "
            + "FROM background_job WHERE id=$1",
          [guardedLatePublishJob.id]
        )).rows[0]?.deadline;
        assert.ok(
          Date.parse(armedBeforeCopy) >= Date.now() + 1_300,
          "CopyObject 请求不得先于持久 guard 窗口"
        );
        lateGuardPublish = new Promise((resolve, reject) => {
          setTimeout(() => {
            localAccess.driver.writeBuffer(
              "full",
              guardedLatePublishKey,
              guardedLatePublishBody,
              "image/webp"
            ).then(resolve, reject);
          }, 50);
        });
        throw new Error("injected CopyObject response loss");
      }
    }
  };
  const guardedTransferStartedAt = Date.now();
  await assert.rejects(
    objectTransfer.copyVerifiedObjectWithinStorage({
      storage: guardedTransferStorage,
      fromPrefix: "_uploads",
      fromKey: "guarded-source.webp",
      toPrefix: "full",
      toKey: guardedLatePublishKey,
      expectedSource: {
        size: guardedLatePublishBody.length,
        sha256: createHash("sha256")
          .update(guardedLatePublishBody)
          .digest("hex")
      },
      ownedIngestionCandidateGuard: {
        imageId: guardedLatePublishImage,
        token: guardedLatePublishToken
      }
    }),
    /injected CopyObject response loss/
  );
  const persistedGuardDeadline = (await database.pool.query(
    "SELECT payload->>'confirm_absent_after' AS deadline "
      + "FROM background_job WHERE id=$1",
    [guardedLatePublishJob.id]
  )).rows[0]?.deadline;
  assert.ok(
    Date.parse(persistedGuardDeadline) >= guardedTransferStartedAt + 1_400,
    "CopyObject 发出前必须让预建 guard 覆盖请求、校验与迟到发布窗口"
  );
  const staleGuardOutcome = await cleanupJob.handleMoveCleanupJob(
    guardedLatePublishJob,
    new AbortController().signal
  );
  assert.equal(staleGuardOutcome.status, "reschedule");
  assert.ok(
    staleGuardOutcome.delayMs > 0,
    "已经领取的 guard 必须在单图锁内重读后来写入的截止时间"
  );
  assert.equal(
    await jobs.rescheduleBackgroundJob(
      guardedLatePublishJob,
      staleGuardOutcome.delayMs
    ),
    true
  );
  await lateGuardPublish;
  assert.equal(
    await localAccess.driver.exists("full", guardedLatePublishKey),
    true,
    "客户端失败后远端仍可在保护窗口内迟到发布"
  );
  await new Promise((resolve) => setTimeout(
    resolve,
    Math.max(0, Date.parse(persistedGuardDeadline) - Date.now()) + 25
  ));
  guardedLatePublishJob = (await database.pool.query(
    "UPDATE background_job SET status='running', execution_token=$2 "
      + "WHERE id=$1 RETURNING *",
    [guardedLatePublishJob.id, randomUUID()]
  )).rows[0];
  assert.deepEqual(
    await cleanupJob.handleMoveCleanupJob(
      guardedLatePublishJob,
      new AbortController().signal
    ),
    { status: "succeeded" }
  );
  assert.equal(
    await jobs.markBackgroundJobSucceeded(guardedLatePublishJob),
    true
  );
  assert.equal(
    await localAccess.driver.exists("full", guardedLatePublishKey),
    false,
    "预建 guard 必须在完整窗口后删除迟到发布且未入库的正式候选"
  );

  const settledGuardImage = randomUUID();
  const settledGuardKey = imagePaths.storageObjectKey(
    settledGuardImage,
    "webp"
  );
  const settledGuardToken = randomUUID();
  await cleanup.enqueueObjectsForCleanup(
    settledGuardImage,
    [{ prefix: "full", key: settledGuardKey, backend: "local" }],
    "ingestion_commit_candidate_guard",
    { guardToken: settledGuardToken }
  );
  let settledTargetBody;
  const settledSourceBody = Buffer.from("ingestion-guard-settled-copy");
  const settledTransferStorage = {
    config: {
      slug: "local",
      type: "s3",
      s3: { task_timeout_seconds: 0.5 }
    },
    driver: {
      async openRead(prefix, key) {
        const body = prefix === "_uploads"
          ? settledSourceBody
          : settledTargetBody;
        assert.ok(body);
        assert.equal(
          key,
          prefix === "_uploads" ? "settled-source.webp" : settledGuardKey
        );
        return {
          body: Readable.from([body]),
          size: body.length,
          totalSize: body.length,
          backend: "s3"
        };
      },
      async exists() { return false; },
      async copy() { settledTargetBody = Buffer.from(settledSourceBody); }
    }
  };
  assert.deepEqual(
    await objectTransfer.copyVerifiedObjectWithinStorage({
      storage: settledTransferStorage,
      fromPrefix: "_uploads",
      fromKey: "settled-source.webp",
      toPrefix: "full",
      toKey: settledGuardKey,
      expectedSource: {
        size: settledSourceBody.length,
        sha256: createHash("sha256").update(settledSourceBody).digest("hex")
      },
      ownedIngestionCandidateGuard: {
        imageId: settledGuardImage,
        token: settledGuardToken
      }
    }),
    {
      created: true,
      sourceDigest: {
        size: settledSourceBody.length,
        sha256: createHash("sha256").update(settledSourceBody).digest("hex")
      }
    }
  );
  assert.equal(
    (await database.pool.query(
      "SELECT payload ? 'confirm_absent_after' AS armed "
        + "FROM background_job WHERE type='move.cleanup' AND target_id=$1",
      [settledGuardImage]
    )).rows[0]?.armed,
    false,
    "CopyObject 与目标摘要均确认后应解除 guard 的不确定窗口"
  );
  await database.pool.query(
    "DELETE FROM background_job WHERE type='move.cleanup' AND target_id=$1",
    [settledGuardImage]
  );

  const admittedCleanupImage = randomUUID();
  const admittedCleanupKey = imagePaths.storageObjectKey(
    admittedCleanupImage,
    "webp"
  );
  await localAccess.driver.writeBuffer(
    "full",
    admittedCleanupKey,
    Buffer.from("move-cleanup-admitted-cancel"),
    "image/webp"
  );
  const admittedCleanupObjects = await cleanup.captureMoveCleanupObjects([
    { prefix: "full", key: admittedCleanupKey, backend: "local" }
  ]);
  await cleanup.enqueueCapturedObjectsForCleanupWithoutLocationLock(
    admittedCleanupImage,
    admittedCleanupObjects,
    "test_cleanup_admitted_cancel"
  );
  const admittedCleanupToken = randomUUID();
  const admittedCleanupJob = (await database.pool.query(
    "UPDATE background_job SET status='running', execution_token=$2 "
      + "WHERE type='move.cleanup' AND target_id=$1 RETURNING *",
    [admittedCleanupImage, admittedCleanupToken]
  )).rows[0];
  assert.ok(admittedCleanupJob);
  const admittedCleanupController = new AbortController();
  const admittedCleanupReason = new Error(
    "injected move cleanup cancellation after delete"
  );
  const originalAdmittedCleanupRemove = localAccess.driver.removeObjects.bind(
    localAccess.driver
  );
  let admittedCleanupDeleteStarted = false;
  localAccess.driver.removeObjects = async (objects, options) => {
    const results = await originalAdmittedCleanupRemove(objects, options);
    if (objects.some((object) => object.key === admittedCleanupKey)) {
      admittedCleanupDeleteStarted = true;
      admittedCleanupController.abort(admittedCleanupReason);
    }
    return results;
  };
  let admittedCleanupResult;
  try {
    admittedCleanupResult = await database.runWithAdvisoryLockAcquisitionSignal(
      admittedCleanupController.signal,
      () => cleanupJob.handleMoveCleanupJob(
        admittedCleanupJob,
        admittedCleanupController.signal
      )
    );
  } finally {
    localAccess.driver.removeObjects = originalAdmittedCleanupRemove;
  }
  assert.equal(admittedCleanupDeleteStarted, true);
  assert.deepEqual(admittedCleanupResult, { status: "succeeded" });
  assert.equal(
    await localAccess.driver.exists("full", admittedCleanupKey),
    false,
    "已准入的 move cleanup 必须接收删除结果"
  );
  assert.equal(await jobs.markBackgroundJobSucceeded(admittedCleanupJob), true);

  await database.pool.query(
    "INSERT INTO storage_backend (slug, display_name, type, enabled) "
      + "VALUES ('local-copy', 'Local copy', 'local', true)"
  );
  registry.invalidateStorageBackendRegistry();
  await verifyStorageMigrationResponseLoss();

  const claimTrashPurgeJob = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const job = await jobs.claimBackgroundJob("trash.purge");
      if (job) return job;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("trash.purge job was not claimable");
  };
  const finishTrashPurgeJob = async (initialJob) => {
    let job = initialJob;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const outcome = await trashPurgeJob.handleTrashPurgeJob(
        job,
        new AbortController().signal
      );
      if (outcome.status === "succeeded") {
        assert.equal(await jobs.markBackgroundJobSucceeded(job), true);
        return;
      }
      assert.equal(
        await jobs.rescheduleBackgroundJob(job, outcome.delayMs),
        true
      );
      job = await claimTrashPurgeJob();
    }
    assert.fail("trash.purge job did not settle");
  };

  const uncertainImage = randomUUID();
  const uncertainObjectKey = imagePaths.storageObjectKey(uncertainImage, "webp");
  const uncertainThumbKey = imagePaths.thumbnailObjectKey(uncertainObjectKey);
  const uncertainFull = Buffer.from("uncertain-purge-full");
  const uncertainThumbnail = Buffer.from("uncertain-purge-thumbnail");
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, status, storage_slug, object_key, device, "
      + "brightness, theme, ext, md5, thumbnail_size, deleted_at) VALUES "
      + "($1, 'bootstrap-admin', 'deleted', 'local', $2, 'pc', 'dark', 'none', 'webp', $3, $4, now())",
    [
      uncertainImage,
      uncertainObjectKey,
      createHash("md5").update(uncertainFull).digest("hex"),
      uncertainThumbnail.byteLength
    ]
  );
  await localAccess.driver.writeBuffer(
    "full",
    uncertainObjectKey,
    uncertainFull,
    "image/webp"
  );
  await localAccess.driver.writeBuffer(
    "thumbs",
    uncertainThumbKey,
    uncertainThumbnail,
    "image/webp"
  );
  const originalPoolQuery = database.pool.query.bind(database.pool);
  let metadataDeleteResponseLost = false;
  database.pool.query = async (...args) => {
    const [statement, values] = args;
    if (
      !metadataDeleteResponseLost
      && typeof statement === "string"
      && statement.includes("DELETE FROM metadata")
      && Array.isArray(values)
      && values[0] === uncertainImage
    ) {
      metadataDeleteResponseLost = true;
      await originalPoolQuery(...args);
      throw new Error("injected metadata delete response loss");
    }
    return originalPoolQuery(...args);
  };
  const uncertainPurgePromise = trash.purgeImages({
    scope: "selected",
    ids: [uncertainImage]
  });
  const uncertainPurgeJob = await claimTrashPurgeJob();
  try {
    await finishTrashPurgeJob(uncertainPurgeJob);
  } finally {
    database.pool.query = originalPoolQuery;
  }
  const uncertainPurge = await uncertainPurgePromise;
  assert.equal(metadataDeleteResponseLost, true);
  assert.deepEqual(uncertainPurge, {
    requested: 1,
    queued: 1,
    already_queued: 0,
    deleted: 1,
    remaining: 0,
    ignored: 0
  });
  assert.equal(
    Number((await database.pool.query(
      "SELECT count(*) FROM metadata WHERE id=$1",
      [uncertainImage]
    )).rows[0]?.count),
    0
  );

  const admittedCancelImage = randomUUID();
  const admittedCancelObjectKey = imagePaths.storageObjectKey(admittedCancelImage, "webp");
  const admittedCancelThumbKey = imagePaths.thumbnailObjectKey(
    admittedCancelObjectKey
  );
  const admittedCancelFull = Buffer.from("admitted-cancel-purge-full");
  const admittedCancelThumbnail = Buffer.from("admitted-cancel-purge-thumbnail");
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, status, storage_slug, object_key, device, "
      + "brightness, theme, ext, md5, thumbnail_size, deleted_at) VALUES "
      + "($1, 'bootstrap-admin', 'deleted', 'local', $2, 'pc', 'dark', 'none', "
      + "'webp', $3, $4, now())",
    [
      admittedCancelImage,
      admittedCancelObjectKey,
      createHash("md5").update(admittedCancelFull).digest("hex"),
      admittedCancelThumbnail.byteLength
    ]
  );
  await localAccess.driver.writeBuffer(
    "full",
    admittedCancelObjectKey,
    admittedCancelFull,
    "image/webp"
  );
  await localAccess.driver.writeBuffer(
    "thumbs",
    admittedCancelThumbKey,
    admittedCancelThumbnail,
    "image/webp"
  );
  const admittedCancelController = new AbortController();
  const admittedCancelReason = new Error(
    "injected purge cancellation after delete"
  );
  const originalAdmittedPurgeRemove = localAccess.driver.removeObjects.bind(
    localAccess.driver
  );
  let admittedPurgeDeleteStarted = false;
  localAccess.driver.removeObjects = async (objects, options) => {
    const results = await originalAdmittedPurgeRemove(objects, options);
    if (objects.some((object) => object.key === admittedCancelObjectKey)) {
      admittedPurgeDeleteStarted = true;
      admittedCancelController.abort(admittedCancelReason);
    }
    return results;
  };
  const admittedCancelPurge = trash.purgeImages({
    scope: "selected",
    ids: [admittedCancelImage]
  }, { signal: admittedCancelController.signal }).then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error })
  );
  const admittedCancelPurgeJob = await claimTrashPurgeJob();
  assert.equal(
    admittedPurgeDeleteStarted,
    false,
    "HTTP 请求等待期间不得执行对象删除"
  );
  assert.deepEqual(await trashMutations.restoreImages([admittedCancelImage]), {
    requested: 1,
    restored: 0,
    ignored: 1,
    results: [{ id: admittedCancelImage, status: "ignored" }]
  });
  try {
    await finishTrashPurgeJob(admittedCancelPurgeJob);
  } finally {
    localAccess.driver.removeObjects = originalAdmittedPurgeRemove;
  }
  assert.equal(admittedPurgeDeleteStarted, true);
  const admittedCancelOutcome = await admittedCancelPurge;
  assert.equal(admittedCancelOutcome.value, null);
  assert.equal(admittedCancelOutcome.error, admittedCancelReason);
  assert.equal(
    Number((await database.pool.query(
      "SELECT count(*) FROM metadata WHERE id=$1",
      [admittedCancelImage]
    )).rows[0]?.count),
    0,
    "物理删除开始后的调度取消必须继续完成 metadata 删除"
  );
  assert.equal(
    await localAccess.driver.exists("full", admittedCancelObjectKey),
    false
  );
  assert.equal(
    await localAccess.driver.exists("thumbs", admittedCancelThumbKey),
    false
  );
  const interruptedImage = randomUUID();
  const interruptedObjectKey = imagePaths.storageObjectKey(interruptedImage, "webp");
  const interruptedThumbKey = imagePaths.thumbnailObjectKey(
    interruptedObjectKey
  );
  const interruptedFull = Buffer.from("interrupted-purge-full");
  const interruptedThumbnail = Buffer.from("interrupted-purge-thumbnail");
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, status, storage_slug, object_key, device, "
      + "brightness, theme, ext, md5, thumbnail_size, deleted_at) VALUES "
      + "($1, 'bootstrap-admin', 'deleted', 'local', $2, 'pc', 'dark', 'none', 'webp', $3, $4, now())",
    [
      interruptedImage,
      interruptedObjectKey,
      createHash("md5").update(interruptedFull).digest("hex"),
      interruptedThumbnail.byteLength
    ]
  );
  await localAccess.driver.writeBuffer(
    "full",
    interruptedObjectKey,
    interruptedFull,
    "image/webp"
  );
  await localAccess.driver.writeBuffer(
    "thumbs",
    interruptedThumbKey,
    interruptedThumbnail,
    "image/webp"
  );
  const interruptedController = new AbortController();
  const interruptedReason = new Error("injected purge request interruption");
  const interruptedRequest = trash.purgeImages(
    { scope: "selected", ids: [interruptedImage] },
    { signal: interruptedController.signal }
  );
  const interruptedContinuation = await claimTrashPurgeJob();
  assert.deepEqual(interruptedContinuation.payload, {
    retain_exhausted: true
  });
  assert.equal(
    (await database.pool.query(
      "SELECT purge_job_id FROM metadata WHERE id=$1",
      [interruptedImage]
    )).rows[0]?.purge_job_id,
    interruptedContinuation.id
  );
  interruptedController.abort(interruptedReason);
  await assert.rejects(
    interruptedRequest,
    (error) => error === interruptedReason
  );
  await finishTrashPurgeJob(interruptedContinuation);
  assert.equal(
    Number((await database.pool.query(
      "SELECT count(*) FROM metadata WHERE id=$1",
      [interruptedImage]
    )).rows[0]?.count),
    0
  );

  const concurrentImage = randomUUID();
  const concurrentObjectKey = imagePaths.storageObjectKey(concurrentImage, "webp");
  const concurrentThumbKey = imagePaths.thumbnailObjectKey(concurrentObjectKey);
  const concurrentFull = Buffer.from("concurrent-trash-full");
  const concurrentThumbnail = Buffer.from("concurrent-trash-thumbnail");
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
      + "theme, ext, md5, thumbnail_size) VALUES ($1, 'bootstrap-admin', 'local', $2, 'pc', "
      + "'dark', 'none', 'webp', $3, $4)",
    [
      concurrentImage,
      concurrentObjectKey,
      createHash("md5").update(concurrentFull).digest("hex"),
      concurrentThumbnail.byteLength
    ]
  );
  await localAccess.driver.writeBuffer(
    "full",
    concurrentObjectKey,
    concurrentFull,
    "image/webp"
  );
  await localAccess.driver.writeBuffer(
    "thumbs",
    concurrentThumbKey,
    concurrentThumbnail,
    "image/webp"
  );
  const concurrentMutation = await database.pool.connect();
  let concurrentMutationFinished = false;
  let concurrentPurgePromise = null;
  try {
    await concurrentMutation.query("BEGIN");
    await trashMembershipLock.lockTrashMembershipForTransaction(
      concurrentMutation
    );
    await concurrentMutation.query(
      "UPDATE metadata SET status='deleted', deleted_at=clock_timestamp() "
        + "WHERE id=$1",
      [concurrentImage]
    );
    concurrentPurgePromise = trash.purgeImages({
      scope: "selected",
      ids: [concurrentImage]
    });
    let captureIsWaiting = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await database.pool.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity "
          + "WHERE datname=current_database() AND pid<>pg_backend_pid() "
          + "AND wait_event_type='Lock' AND wait_event='advisory'"
      );
      if (Number(waiting.rows[0]?.count) > 0) {
        captureIsWaiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(captureIsWaiting, true);
    await concurrentMutation.query("COMMIT");
    concurrentMutationFinished = true;
    const concurrentContinuation = await claimTrashPurgeJob();
    await finishTrashPurgeJob(concurrentContinuation);
    const concurrentPurge = await concurrentPurgePromise;
    assert.deepEqual(concurrentPurge, {
      requested: 1,
      queued: 1,
      already_queued: 0,
      deleted: 1,
      remaining: 0,
      ignored: 0
    });
    assert.equal(
      Number((await database.pool.query(
        "SELECT count(*) FROM metadata WHERE id=$1",
        [concurrentImage]
      )).rows[0]?.count),
      0
    );
    assert.equal(
      await localAccess.driver.exists("full", concurrentObjectKey),
      false
    );
    assert.equal(
      await localAccess.driver.exists("thumbs", concurrentThumbKey),
      false
    );
  } finally {
    if (!concurrentMutationFinished) {
      await concurrentMutation.query("ROLLBACK").catch(() => undefined);
    }
    concurrentMutation.release();
    if (concurrentPurgePromise && !concurrentMutationFinished) {
      await concurrentPurgePromise.catch(() => undefined);
    }
  }

  await database.pool.query(
    "DELETE FROM metadata WHERE status='deleted'"
  );
  const previousTrashBatchSize = sharedAppConfig.appConfig.trashBatchSize;
  sharedAppConfig.appConfig.trashBatchSize = 1;
  try {
    const createTrashImage = async (ageSeconds) => {
      const id = randomUUID();
      const objectKey = imagePaths.storageObjectKey(id, "webp");
      const thumbKey = imagePaths.thumbnailObjectKey(objectKey);
      const full = Buffer.from("watermark-full-" + id);
      const thumbnail = Buffer.from("watermark-thumb-" + id);
      await database.pool.query(
        "INSERT INTO metadata (id, created_by, status, storage_slug, object_key, device, "
          + "brightness, theme, ext, md5, thumbnail_size, deleted_at) VALUES "
          + "($1, 'bootstrap-admin', 'deleted', 'local', $2, 'pc', 'dark', 'none', 'webp', $3, "
          + "$4, clock_timestamp() - ($5 || ' seconds')::interval)",
        [
          id,
          objectKey,
          createHash("md5").update(full).digest("hex"),
          thumbnail.byteLength,
          ageSeconds
        ]
      );
      await localAccess.driver.writeBuffer(
        "full",
        objectKey,
        full,
        "image/webp"
      );
      await localAccess.driver.writeBuffer(
        "thumbs",
        thumbKey,
        thumbnail,
        "image/webp"
      );
      return { id, objectKey, thumbKey };
    };

    const oldest = await createTrashImage(3);
    const middle = await createTrashImage(2);
    const newest = await createTrashImage(1);
    const allPurgePromise = trash.purgeImages({ scope: "all" });
    const allPurgeJob = await claimTrashPurgeJob();
    assert.deepEqual(
      (await database.pool.query(
        "SELECT id FROM metadata WHERE purge_job_id=$1 ORDER BY deleted_at, id",
        [allPurgeJob.id]
      )).rows.map((row) => row.id),
      [oldest.id, middle.id, newest.id]
    );
    assert.deepEqual(await trashMutations.restoreImages([middle.id]), {
      requested: 1,
      restored: 0,
      ignored: 1,
      results: [{ id: middle.id, status: "ignored" }]
    });

    const addedAfterCapture = await createTrashImage(0);
    await finishTrashPurgeJob(allPurgeJob);
    const allPurge = await allPurgePromise;
    assert.deepEqual(allPurge, {
      requested: 3,
      queued: 3,
      already_queued: 0,
      deleted: 3,
      remaining: 0,
      ignored: 0
    });
    assert.deepEqual(
      (await database.pool.query(
        "SELECT id, purge_job_id FROM metadata WHERE id=$1",
        [addedAfterCapture.id]
      )).rows,
      [{ id: addedAfterCapture.id, purge_job_id: null }],
      "scope all 只处理事务快照，不包含之后进入回收站的图片"
    );

    const selectedPurgePromise = trash.purgeImages({
      scope: "selected",
      ids: [addedAfterCapture.id]
    });
    await finishTrashPurgeJob(await claimTrashPurgeJob());
    const selectedPurge = await selectedPurgePromise;
    assert.deepEqual(selectedPurge, {
      requested: 1,
      queued: 1,
      already_queued: 0,
      deleted: 1,
      remaining: 0,
      ignored: 0
    });
    const ignoredPurge = await trash.purgeImages({
      scope: "selected",
      ids: [foregroundImage]
    });
    assert.deepEqual(ignoredPurge, {
      requested: 1,
      queued: 0,
      already_queued: 0,
      deleted: 0,
      remaining: 0,
      ignored: 1
    });

    const failedItem = await createTrashImage(0);
    const failedPurgePromise = trash.purgeImages({
      scope: "selected",
      ids: [failedItem.id]
    });
    const failedJob = await claimTrashPurgeJob();
    const originalFailedRemove = localAccess.driver.removeObjects.bind(
      localAccess.driver
    );
    localAccess.driver.removeObjects = async (objects, options) => {
      if (objects.some((object) => object.key === failedItem.objectKey)) {
        throw new Error("injected trash purge driver failure");
      }
      return originalFailedRemove(objects, options);
    };
    let failedJobError;
    try {
      await trashPurgeJob.handleTrashPurgeJob(
        failedJob,
        new AbortController().signal
      );
      assert.fail("trash.purge driver failure should reject the handler");
    } catch (error) {
      failedJobError = error;
    } finally {
      localAccess.driver.removeObjects = originalFailedRemove;
    }
    assert.equal(
      await jobs.markBackgroundJobFailed(failedJob, failedJobError),
      true
    );
    assert.deepEqual(await failedPurgePromise, {
      requested: 1,
      queued: 1,
      already_queued: 0,
      deleted: 0,
      remaining: 1,
      ignored: 0
    });
    const retryingTrashCheck = await databaseCheck.checkTrash();
    assert.equal(retryingTrashCheck.purge_pending_count, 1);
    assert.equal(retryingTrashCheck.job_counts.retrying, 1);
    assert.equal(
      retryingTrashCheck.jobs.find((job) => job.id === failedJob.id)?.state,
      "retrying"
    );
    assert.deepEqual(await trash.purgeImages({
      scope: "selected",
      ids: [failedItem.id]
    }), {
      requested: 1,
      queued: 0,
      already_queued: 1,
      deleted: 0,
      remaining: 1,
      ignored: 0
    });
    assert.deepEqual(await trashMutations.restoreImages([failedItem.id]), {
      requested: 1,
      restored: 0,
      ignored: 1,
      results: [{ id: failedItem.id, status: "ignored" }]
    });
    await database.pool.query(
      "UPDATE background_job SET next_retry_at=NULL "
        + "WHERE id=$1",
      [failedJob.id]
    );
    const exhaustedTrashCheck = await databaseCheck.checkTrash();
    assert.equal(exhaustedTrashCheck.job_counts.exhausted, 1);
    assert.deepEqual(
      await trashPurgeMaintenance.maintainTrashPurgeTasks(),
      {
        retried_jobs: 1,
        retried_images: 1,
        repaired_jobs: 0,
        repaired_images: 0
      }
    );
    await finishTrashPurgeJob(await claimTrashPurgeJob());

    const missingReferenceItem = await createTrashImage(0);
    const missingReferenceJob = randomUUID();
    await database.pool.query(
      "UPDATE metadata SET purge_job_id=$2 WHERE id=$1",
      [missingReferenceItem.id, missingReferenceJob]
    );
    const missingReferenceCheck = await databaseCheck.checkTrash();
    assert.equal(
      missingReferenceCheck.issues.find(
        (issue) => issue.kind === "missing_job_reference"
      )?.count,
      1
    );
    assert.deepEqual(
      await trashPurgeMaintenance.maintainTrashPurgeTasks(),
      {
        retried_jobs: 0,
        retried_images: 0,
        repaired_jobs: 1,
        repaired_images: 1
      }
    );
    assert.notEqual(
      (await database.pool.query(
        "SELECT purge_job_id FROM metadata WHERE id=$1",
        [missingReferenceItem.id]
      )).rows[0]?.purge_job_id,
      missingReferenceJob
    );
    await finishTrashPurgeJob(await claimTrashPurgeJob());

    const wrongSucceededReferenceItem = await createTrashImage(0);
    const wrongSucceededReferenceJob = randomUUID();
    await database.pool.query(
      "INSERT INTO background_job(id, type, status, target_id, payload) "
        + "VALUES($1, 'move.cleanup', 'succeeded', '', '{}'::jsonb)",
      [wrongSucceededReferenceJob]
    );
    await database.pool.query(
      "UPDATE metadata SET purge_job_id=$2 WHERE id=$1",
      [wrongSucceededReferenceItem.id, wrongSucceededReferenceJob]
    );
    const wrongSucceededReferenceCheck = await databaseCheck.checkTrash();
    assert.equal(
      wrongSucceededReferenceCheck.issues.find(
        (issue) => issue.kind === "wrong_job_type"
      )?.count,
      1
    );
    assert.equal(
      wrongSucceededReferenceCheck.issues.find(
        (issue) => issue.kind === "succeeded_job_reference"
      ),
      undefined,
      "同一错误类型任务不得再被 succeeded purge 分类重复统计"
    );
    assert.deepEqual(
      await trashPurgeMaintenance.maintainTrashPurgeTasks(),
      {
        retried_jobs: 0,
        retried_images: 0,
        repaired_jobs: 1,
        repaired_images: 1
      }
    );
    await finishTrashPurgeJob(await claimTrashPurgeJob());
    await database.pool.query(
      "DELETE FROM background_job WHERE id=$1",
      [wrongSucceededReferenceJob]
    );

    const referencedHistoryItem = await createTrashImage(0);
    const referencedHistoryJob = randomUUID();
    const unreferencedHistoryJob = randomUUID();
    const retainedMoveHistoryJob = randomUUID();
    await database.pool.query(
      "INSERT INTO background_job("
        + "id, type, status, target_id, payload, error, next_retry_at, updated_at"
        + ") VALUES "
        + "($1, 'trash.purge', 'failed', '', $5::jsonb, 'exhausted', NULL, "
        + "now() - ($4 || ' seconds')::interval), "
        + "($2, 'trash.purge', 'failed', '', $5::jsonb, 'orphaned', NULL, "
        + "now() - ($4 || ' seconds')::interval), "
        + "($3, 'move.cleanup', 'failed', 'retained-history', $5::jsonb, "
        + "'protected cleanup receipt', NULL, "
        + "now() - ($4 || ' seconds')::interval)",
      [
        referencedHistoryJob,
        unreferencedHistoryJob,
        retainedMoveHistoryJob,
        sharedAppConfig.appConfig.backgroundJob.failedRetentionSeconds + 1,
        JSON.stringify({ retain_exhausted: true })
      ]
    );
    await database.pool.query(
      "UPDATE metadata SET purge_job_id=$2 WHERE id=$1",
      [referencedHistoryItem.id, referencedHistoryJob]
    );
    assert.deepEqual(await jobs.cleanupBackgroundJobHistory(), [
      { status: "failed", count: 1 }
    ]);
    assert.deepEqual(
      (await database.pool.query(
        "SELECT id FROM background_job WHERE id=ANY($1::uuid[]) ORDER BY id",
        [[
          referencedHistoryJob,
          unreferencedHistoryJob,
          retainedMoveHistoryJob
        ]]
      )).rows.map((row) => row.id),
      [referencedHistoryJob, retainedMoveHistoryJob].sort(),
      "无引用 purge 耗尽任务应按保留期裁剪，有引用 purge 与 move.cleanup 回执必须继续保留"
    );
    assert.deepEqual(
      await trashPurgeMaintenance.maintainTrashPurgeTasks(),
      {
        retried_jobs: 1,
        retried_images: 1,
        repaired_jobs: 0,
        repaired_images: 0
      }
    );
    await finishTrashPurgeJob(await claimTrashPurgeJob());
    await database.pool.query(
      "DELETE FROM background_job WHERE id=$1",
      [retainedMoveHistoryJob]
    );

  } finally {
    sharedAppConfig.appConfig.trashBatchSize = previousTrashBatchSize;
  }

  const abortedImage = randomUUID();
  const abortedObjectKey = imagePaths.storageObjectKey(abortedImage, "webp");
  const abortedBody = Buffer.from("cancelled-move-cleanup");
  await localAccess.driver.writeBuffer(
    "thumbs",
    abortedObjectKey,
    abortedBody,
    "image/webp"
  );
  const [abortedCleanupObject] = await cleanup.captureMoveCleanupObjects([
    { prefix: "thumbs", key: abortedObjectKey, backend: "local" }
  ]);
  await cleanup.enqueueCapturedObjectsForCleanupWithoutLocationLock(
    abortedImage,
    [abortedCleanupObject],
    "test_cancelled_move_cleanup"
  );
  const abortedExecutionToken = randomUUID();
  const abortedReceipt = (await database.pool.query(
    "UPDATE background_job SET status='running', execution_token=$2 "
      + "WHERE type='move.cleanup' AND target_id=$1 RETURNING *",
    [abortedImage, abortedExecutionToken]
  )).rows[0];
  assert.ok(abortedReceipt);
  const cleanupAbort = new AbortController();
  const originalCleanupQuery = database.pool.query.bind(database.pool);
  database.pool.query = async (text, values) => {
    const result = await originalCleanupQuery(text, values);
    if (
      typeof text === "string"
      && text.includes("SELECT object_key, storage_slug")
      && values?.[0] === abortedImage
    ) {
      cleanupAbort.abort(new Error("injected lock loss before cleanup delete"));
    }
    return result;
  };
  try {
    await assert.rejects(() => database.runWithAdvisoryLockAcquisitionSignal(
      cleanupAbort.signal,
      () => cleanupJob.handleMoveCleanupJob(
        abortedReceipt,
        cleanupAbort.signal
      )
    ));
  } finally {
    database.pool.query = originalCleanupQuery;
  }
  assert.deepEqual(
    await localAccess.driver.readBuffer("thumbs", abortedObjectKey),
    abortedBody,
    "取消后不得删除尚未开始处理的捕获对象"
  );
  await database.pool.query(
    "DELETE FROM background_job WHERE id=$1",
    [abortedReceipt.id]
  );
  await removeDriverObject(localAccess.driver, "thumbs", abortedObjectKey);
  const localDriver = new LocalBackend();
  await localDriver.writeBuffer(
    "full",
    "destroy-before-read.bin",
    Buffer.from("never-read"),
    "application/octet-stream"
  );
  const preReadAbort = new AbortController();
  const preReadAbortReason = new Error("cancel before local open");
  preReadAbort.abort(preReadAbortReason);
  await assert.rejects(
    localDriver.openRead(
      "full",
      "destroy-before-read.bin",
      undefined,
      { signal: preReadAbort.signal }
    ),
    (error) => error === preReadAbortReason
  );
  const activeReadAbort = new AbortController();
  const abortableRead = await localDriver.openRead(
    "full",
    "destroy-before-read.bin",
    undefined,
    { signal: activeReadAbort.signal }
  );
  let activeReadError: Error | undefined;
  abortableRead.body.once("error", (error) => {
    activeReadError = error;
  });
  const abortableReadClosed = new Promise<void>((resolve) => {
    abortableRead.body.once("close", resolve);
  });
  activeReadAbort.abort(new Error("cancel active local read"));
  await abortableReadClosed;
  assert.equal(abortableRead.body.destroyed, true);
  assert.equal((activeReadError as NodeJS.ErrnoException)?.code, "ABORT_ERR");
  const unopened = await localDriver.openRead("full", "destroy-before-read.bin");
  const unopenedClosed = once(unopened.body, "close");
  unopened.body.destroy();
  await unopenedClosed;
  await removeDriverObject(localDriver, "full", "destroy-before-read.bin");
  assert.equal(await localDriver.exists("full", "destroy-before-read.bin"), false);
  await localDriver.writeBuffer("full", "source.bin", Buffer.from("source"), "application/octet-stream");
  await localDriver.writeBuffer("full", "target.bin", Buffer.from("target"), "application/octet-stream");
  await assert.rejects(() => localDriver.copy("full", "source.bin", "full", "target.bin"));
  assert.equal((await localDriver.readBuffer("full", "target.bin")).toString(), "target");
  await localDriver.copy("full", "source.bin", "full", "copied.bin");
  assert.equal((await localDriver.readBuffer("full", "copied.bin")).toString(), "source");
  const localListing = await keyListing.collectStorageKeyListing(
    localDriver.listKeys("full")
  );
  assert.equal(localListing.complete, true);
  assert.ok(localListing.keys.includes("source.bin"));
  assert.ok(localListing.keys.includes("target.bin"));
  assert.ok(localListing.keys.includes("copied.bin"));

  await localDriver.writeBuffer(
    "full",
    "oversized.bin",
    Buffer.alloc(2_048, 1),
    "application/octet-stream"
  );
  await assert.rejects(
    () => localDriver.readBuffer("full", "oversized.bin"),
    (error) => error?.code === "object_too_large"
  );
  await removeDriverObject(localDriver, "full", "oversized.bin");
  assert.equal(await localDriver.exists("full", "oversized.bin"), false);

  const incompleteKey = "orphan/incomplete-" + randomUUID() + ".webp";
  const managedLocalAccess = await registry.resolveStorageAccess("local");
  await managedLocalAccess.driver.writeBuffer(
    "full",
    incompleteKey,
    Buffer.from("must-retain"),
    "image/webp"
  );
  const managedLocalCopyAccess = await registry.resolveStorageAccess("local-copy");
  const patchedDrivers = [managedLocalAccess.driver, managedLocalCopyAccess.driver]
    .map((driver) => ({
      driver,
      originalListKeys: driver.listKeys.bind(driver)
    }));
  for (const patched of patchedDrivers) {
    patched.driver.listKeys = (prefix, options) => {
      if (prefix !== "full") return patched.originalListKeys(prefix, options);
      return (async function* () {
        yield [incompleteKey];
        return { complete: false, count: 1, reason: "max_keys" };
      })();
    };
  }
  try {
    const checkResult = await storageCheck.checkStorage();
    assert.ok(checkResult.incomplete_listings.some((entry) => (
      entry.backend === "local" && entry.prefix === "full"
    )));
    const maintenanceResult = await storageMaintenance.maintainStorage();
    assert.ok(maintenanceResult.failed >= 1);
    assert.equal(
      await managedLocalAccess.driver.exists("full", incompleteKey),
      true,
      JSON.stringify(maintenanceResult)
    );
  } finally {
    for (const patched of patchedDrivers) {
      patched.driver.listKeys = patched.originalListKeys;
    }
    await removeDriverObject(managedLocalAccess.driver, "full", incompleteKey);
  }

  const storageLockBlocker = await database.pool.connect();
  const cleanupStop = new AbortController();
  const cleanupStopReason = new Error("stop orphan cleanup during lock wait");
  let blockedCleanup;
  try {
    await storageLockBlocker.query(
      "SELECT pg_advisory_lock(hashtext($1))",
      ["imageshow:storage-location"]
    );
    blockedCleanup = ingestionOrphanCleanup.cleanupIngestionOrphans(
      Date.now(),
      cleanupStop.signal
    );
    let observedStorageLockWait = false;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const waiting = await database.pool.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity "
          + "WHERE pid<>pg_backend_pid() AND state='active' "
          + "AND wait_event_type='Lock' "
          + "AND query LIKE '%pg_advisory_lock_shared%'"
      );
      if (Number(waiting.rows[0]?.count) > 0) {
        observedStorageLockWait = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      observedStorageLockWait,
      true,
      "自动 orphan 清理必须实际进入 storage advisory lock 等待"
    );
    cleanupStop.abort(cleanupStopReason);
    const stopped = await Promise.race([
      blockedCleanup.then(
        () => ({ status: "resolved" }),
        (error) => ({ status: "rejected", error })
      ),
      new Promise((resolve) => setTimeout(resolve, 1_000))
        .then(() => ({ status: "timeout" }))
    ]);
    assert.equal(stopped.status, "rejected", JSON.stringify(stopped));
    assert.equal(stopped.error, cleanupStopReason);
  } finally {
    await storageLockBlocker.query(
      "SELECT pg_advisory_unlock(hashtext($1))",
      ["imageshow:storage-location"]
    );
    storageLockBlocker.release();
    await blockedCleanup?.catch(() => undefined);
  }

  let releaseMaintenanceReadLock;
  let markMaintenanceReadLockStarted;
  const maintenanceReadLockGate = new Promise((resolve) => {
    releaseMaintenanceReadLock = resolve;
  });
  const maintenanceReadLockStarted = new Promise((resolve) => {
    markMaintenanceReadLockStarted = resolve;
  });
  const maintenanceReadLock = locks.withStorageLocationReadLock(async () => {
    markMaintenanceReadLockStarted();
    await maintenanceReadLockGate;
  });
  await maintenanceReadLockStarted;
  try {
    const maintenanceLockAbort = new AbortController();
    const maintenanceLockAbortReason = new Error(
      "stop storage maintenance during write-lock wait"
    );
    const maintenanceWaiting = storageMaintenance.maintainStorage(
      maintenanceLockAbort.signal
    );
    const maintenanceWaitingOutcome = maintenanceWaiting.then(
      () => ({ status: "resolved" }),
      (error) => ({ status: "rejected", error })
    );
    let observedMaintenanceWriteLockWait = false;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const waiting = await database.pool.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity "
          + "WHERE pid<>pg_backend_pid() AND state='active' "
          + "AND wait_event_type='Lock' "
          + "AND query LIKE '%pg_advisory_lock(hashtext%'"
      );
      if (Number(waiting.rows[0]?.count) > 0) {
        observedMaintenanceWriteLockWait = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      observedMaintenanceWriteLockWait,
      true,
      "存储维护必须实际进入 storage write advisory lock 等待"
    );
    maintenanceLockAbort.abort(maintenanceLockAbortReason);
    const stoppedMaintenanceWait = await Promise.race([
      maintenanceWaitingOutcome,
      new Promise((resolve) => setTimeout(resolve, 1_000))
        .then(() => ({ status: "timeout" }))
    ]);
    assert.equal(
      stoppedMaintenanceWait.status,
      "rejected",
      JSON.stringify(stoppedMaintenanceWait)
    );
    assert.equal(stoppedMaintenanceWait.error, maintenanceLockAbortReason);
  } finally {
    releaseMaintenanceReadLock();
    await maintenanceReadLock;
  }
  assert.equal(
    await locks.withStorageLocationWriteLock(async () => true),
    true,
    "取消维护锁等待后 advisory pool 必须仍可取得写锁"
  );

  const storageSharedLockWaiters = async () => Number((
    await database.pool.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity "
        + "WHERE pid<>pg_backend_pid() AND state='active' "
        + "AND wait_event_type='Lock' "
        + "AND query LIKE '%pg_advisory_lock_shared%'"
    )
  ).rows[0]?.count ?? 0);
  const matchesAbortReason = (error, reason) => (
    error === reason
      || (
        error instanceof Error
        && error.name === "AbortError"
        && error.cause === reason
      )
  );
  let lockWaitRawRequestIndex = 0;
  const createLockWaitRawRequest = () => {
    const requestIndex = lockWaitRawRequestIndex;
    const position = 60 + requestIndex;
    const parsedImageTime = imageTime.parseImageTime(
      new Date(Date.parse("2026-08-23T01:04:00.456Z") + requestIndex)
        .toISOString()
    );
    const pair = {
      session_id: ingestionSessionIdentity.createIngestionSessionId(
        ingestionOwner,
        "upload",
        "lock-wait-" + requestIndex
      ),
      image_id: imageTime.createImageId(parsedImageTime.date, position)
    };
    lockWaitRawRequestIndex += 1;
    let claimCalls = 0;
    let convertCalls = 0;
    let releaseCalls = 0;
    const service = {
      verifyUploadCredential: () => ({
        session_id: pair.session_id,
        candidate_image_id: pair.image_id,
        request_hash: "8".repeat(64)
      }),
      repository: {
        claimUploadIntent: async () => {
          claimCalls += 1;
          return {
            owner: ingestionOwner,
            session_id: pair.session_id,
            candidate_image_id: pair.image_id,
            resolved_image_time: parsedImageTime.iso,
            request_hash: "8".repeat(64),
            batch_position: position,
            metadata: ingestionMetadata,
            storage_slug: "local",
            expected_size: unknownRawBody.length,
            max_long_edge: 16
          };
        },
        heartbeatUploadIntent: async () => undefined,
        convertUploadIntent: async (template) => {
          convertCalls += 1;
          return { session: template };
        },
        readSession: async () => null,
        releaseUploadIntent: async () => {
          releaseCalls += 1;
        }
      },
      uploadReceivedTemplate: (intent, rawGeneration, rawSize) => ({
        ...intent,
        image_id: intent.candidate_image_id,
        image_time: intent.resolved_image_time,
        raw_generation: rawGeneration,
        raw_size: rawSize
      })
    };
    return {
      pair,
      service,
      claimCalls: () => claimCalls,
      convertCalls: () => convertCalls,
      releaseCalls: () => releaseCalls
    };
  };

  let releaseRawWriteLock;
  let markRawWriteLockStarted;
  const rawWriteLockGate = new Promise((resolve) => {
    releaseRawWriteLock = resolve;
  });
  const rawWriteLockStarted = new Promise((resolve) => {
    markRawWriteLockStarted = resolve;
  });
  const rawWriteLock = locks.withStorageLocationWriteLock(async () => {
    markRawWriteLockStarted();
    await rawWriteLockGate;
  });
  await rawWriteLockStarted;
  const firstRawLockWait = createLockWaitRawRequest();
  const firstRawAbort = new AbortController();
  const firstRawAbortReason = new Error("stop raw upload during read-lock wait");
  let firstRawWaitingOutcome;
  const secondRawLockWait = createLockWaitRawRequest();
  const secondRawAbort = new AbortController();
  const secondRawAbortReason = new Error("stop next raw upload lock wait");
  let secondRawWaitingOutcome;
  const thirdRawLockWait = createLockWaitRawRequest();
  const thirdRawAbort = new AbortController();
  const thirdRawAbortReason = new Error("stop final raw upload lock wait");
  let thirdRawWaitingOutcome;
  try {
    await runtimeConfigStore.updateRuntimeConfig({
      upload: { raw_concurrency: 1 }
    });
    assert.equal(
      runtimeConfigStore.getRuntimeConfig().upload.raw_concurrency,
      1,
      "raw admission 取消回归必须使用显式单许可"
    );
    const firstRawWaiting = ingestionRawUpload.receiveUploadIntentBody(
      firstRawLockWait.service,
      ingestionOwner,
      "credential",
      new Response(unknownRawBody).body,
      firstRawAbort.signal
    );
    firstRawWaitingOutcome = firstRawWaiting.then(
      () => ({ status: "resolved" }),
      (error) => ({ status: "rejected", error })
    );
    let observedFirstRawReadLockWait = false;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (await storageSharedLockWaiters() > 0) {
        observedFirstRawReadLockWait = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      observedFirstRawReadLockWait,
      true,
      "raw PUT 必须在正文发布后实际进入 storage read advisory lock 等待"
    );

    const secondRawWaiting = ingestionRawUpload.receiveUploadIntentBody(
      secondRawLockWait.service,
      ingestionOwner,
      "credential",
      new Response(unknownRawBody).body,
      secondRawAbort.signal
    );
    secondRawWaitingOutcome = secondRawWaiting.then(
      () => ({ status: "resolved" }),
      (error) => ({ status: "rejected", error })
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      secondRawLockWait.claimCalls(),
      0,
      "跨过必需微任务后，首个请求持有唯一 raw admission 时后续请求仍不得进入 claim"
    );

    firstRawAbort.abort(firstRawAbortReason);
    const stoppedFirstRawWait = await Promise.race([
      firstRawWaitingOutcome,
      new Promise((resolve) => setTimeout(resolve, 1_000))
        .then(() => ({ status: "timeout" }))
    ]);
    assert.equal(
      stoppedFirstRawWait.status,
      "rejected",
      JSON.stringify(stoppedFirstRawWait)
    );
    assert.equal(stoppedFirstRawWait.error, firstRawAbortReason);
    assert.equal(firstRawLockWait.convertCalls(), 0);
    assert.equal(firstRawLockWait.releaseCalls(), 1);

    let observedSecondRawAdmission = false;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (secondRawLockWait.claimCalls() > 0) {
        observedSecondRawAdmission = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      observedSecondRawAdmission,
      true,
      "首个取消请求必须释放唯一 raw admission，后续请求才能开始接收"
    );
    secondRawAbort.abort(secondRawAbortReason);
    const stoppedSecondRawWait = await Promise.race([
      secondRawWaitingOutcome,
      new Promise((resolve) => setTimeout(resolve, 1_000))
        .then(() => ({ status: "timeout" }))
    ]);
    assert.equal(
      stoppedSecondRawWait.status,
      "rejected",
      JSON.stringify(stoppedSecondRawWait)
    );
    assert.equal(
      matchesAbortReason(stoppedSecondRawWait.error, secondRawAbortReason),
      true
    );
    assert.equal(secondRawLockWait.convertCalls(), 0);
    assert.equal(secondRawLockWait.releaseCalls(), 1);

    const thirdRawWaiting = ingestionRawUpload.receiveUploadIntentBody(
      thirdRawLockWait.service,
      ingestionOwner,
      "credential",
      new Response(unknownRawBody).body,
      thirdRawAbort.signal
    );
    thirdRawWaitingOutcome = thirdRawWaiting.then(
      () => ({ status: "resolved" }),
      (error) => ({ status: "rejected", error })
    );
    let observedThirdRawAdmission = false;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (thirdRawLockWait.claimCalls() > 0) {
        observedThirdRawAdmission = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      observedThirdRawAdmission,
      true,
      "第二个取消请求也必须释放唯一 raw admission"
    );
    thirdRawAbort.abort(thirdRawAbortReason);
    const stoppedThirdRawWait = await Promise.race([
      thirdRawWaitingOutcome,
      new Promise((resolve) => setTimeout(resolve, 1_000))
        .then(() => ({ status: "timeout" }))
    ]);
    assert.equal(
      stoppedThirdRawWait.status,
      "rejected",
      JSON.stringify(stoppedThirdRawWait)
    );
    assert.equal(
      matchesAbortReason(stoppedThirdRawWait.error, thirdRawAbortReason),
      true
    );
    assert.equal(thirdRawLockWait.convertCalls(), 0);
    assert.equal(thirdRawLockWait.releaseCalls(), 1);
  } finally {
    const cleanupReason = new Error("clean up raw lock-wait test");
    if (!firstRawAbort.signal.aborted) firstRawAbort.abort(cleanupReason);
    if (!secondRawAbort.signal.aborted) secondRawAbort.abort(cleanupReason);
    if (!thirdRawAbort.signal.aborted) thirdRawAbort.abort(cleanupReason);
    releaseRawWriteLock();
    await rawWriteLock;
    await Promise.all([
      firstRawWaitingOutcome,
      secondRawWaitingOutcome,
      thirdRawWaitingOutcome
    ].filter((outcome) => outcome !== undefined));
    await runtimeConfigStore.updateRuntimeConfig({
      upload: {
        raw_concurrency: originalRuntimeConfig.upload.raw_concurrency
      }
    });
  }
  let clearedRawLockWaiters = false;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await storageSharedLockWaiters() === 0) {
      clearedRawLockWaiters = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(
    clearedRawLockWaiters,
    true,
    "释放阻塞写锁后，取消的 raw advisory 查询必须退出"
  );
  assert.equal(
    await locks.withStorageLocationReadLock(async () => true),
    true,
    "取消 raw 锁等待后 advisory pool 必须仍可取得读锁"
  );

  await objectTransfer.digestStorageObject(
    { config: local, driver: localDriver },
    "full",
    "copied.bin"
  );
  await removeDriverObject(localDriver, "full", "copied.bin");
  assert.equal(await localDriver.exists("full", "copied.bin"), false);
  const fullFiles = await readdir(join(dataDirectory, "storage", "full"));
  assert.equal(fullFiles.some((file) => file.includes(".candidate-")), false);

  const fullRoot = join(dataDirectory, "storage", "full");
  await rm(fullRoot, { recursive: true, force: true });
  const missingListing = await keyListing.collectStorageKeyListing(
    localDriver.listKeys("full")
  );
  assert.deepEqual(missingListing, {
    complete: true,
    count: 0,
    keys: []
  });
  await writeFile(fullRoot, "not-a-directory");
  await assert.rejects(
    () => keyListing.collectStorageKeyListing(localDriver.listKeys("full")),
    (error) => error?.code === "ENOTDIR"
  );
  await rm(fullRoot, { force: true });
  await mkdir(fullRoot, { recursive: true });

  const storageRoot = join(dataDirectory, "storage");
  await rm(storageRoot, { recursive: true, force: true });
  await writeFile(storageRoot, "not-a-directory");
  await assert.rejects(
    () => localDriver.pruneEmptyDirs(),
    (error) => error?.code === "ENOTDIR"
  );
  await rm(storageRoot, { force: true });
  await mkdir(storageRoot, { recursive: true });

  const maintenanceImage = randomUUID();
  const maintenanceObjectKey = imagePaths.storageObjectKey(maintenanceImage, "png");
  const maintenanceThumbKey = imagePaths.thumbnailObjectKey(
    maintenanceObjectKey
  );
  const maintenanceSource = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "red" }
  }).png().toBuffer();
  const thumbnailRequestObjects = new Map();
  const thumbnailRequestSdkCommands = [];
  let recordThumbnailRequestCommands = true;
  let loseNextThumbnailPutResponse = false;
  const missingThumbnailRequestObject = () => Object.assign(
    new Error("not found"),
    { name: "NotFound", $metadata: { httpStatusCode: 404 } }
  );
  const thumbnailRequestClient = {
    async send(command, options) {
      options?.abortSignal?.throwIfAborted();
      const name = command.constructor.name;
      if (recordThumbnailRequestCommands) {
        thumbnailRequestSdkCommands.push(name);
      }
      if (name === "HeadObjectCommand") {
        const body = thumbnailRequestObjects.get(command.input.Key);
        if (!body) throw missingThumbnailRequestObject();
        return { ContentLength: body.byteLength };
      }
      if (name === "GetObjectCommand") {
        const body = thumbnailRequestObjects.get(command.input.Key);
        if (!body) throw missingThumbnailRequestObject();
        return {
          Body: Readable.from([Buffer.from(body)]),
          ContentLength: body.byteLength,
          ETag: '"' + createHash("md5").update(body).digest("hex") + '"'
        };
      }
      if (name === "PutObjectCommand") {
        assert.ok(Buffer.isBuffer(command.input.Body));
        thumbnailRequestObjects.set(
          command.input.Key,
          Buffer.from(command.input.Body)
        );
        if (loseNextThumbnailPutResponse) {
          loseNextThumbnailPutResponse = false;
          throw new Error("injected thumbnail PUT response loss");
        }
        return {};
      }
      if (name === "DeleteObjectsCommand") {
        for (const object of command.input.Delete?.Objects ?? []) {
          if (object.Key) thumbnailRequestObjects.delete(object.Key);
        }
        return { Errors: [] };
      }
      throw new Error("Unexpected thumbnail request command: " + name);
    },
    destroy() {}
  };
  const thumbnailRequestStorage = new S3Backend({
    ...firstRegistryAccess.config,
    slug: "(test)",
    s3: {
      ...firstRegistryAccess.config.s3,
      bucket: "thumbnail-request-count",
      root_path: "/thumbnail-request-count"
    }
  }, { client: thumbnailRequestClient });
  const thumbnailRequestDriverCalls = {
    exists: 0,
    readBuffer: 0,
    openRead: 0,
    writeBuffer: 0,
    removeObjects: 0
  };
  const originalThumbnailRequestDriver = {
    exists: managedLocalAccess.driver.exists,
    readBuffer: managedLocalAccess.driver.readBuffer,
    openRead: managedLocalAccess.driver.openRead,
    writeBuffer: managedLocalAccess.driver.writeBuffer,
    removeObjects: managedLocalAccess.driver.removeObjects
  };
  let activeThumbnailRequestScenario;
  const seedThumbnailRequestObject = async (
    prefix,
    key,
    body,
    contentType
  ) => {
    const previousRecording = recordThumbnailRequestCommands;
    recordThumbnailRequestCommands = false;
    try {
      await thumbnailRequestStorage.writeBuffer(
        prefix,
        key,
        body,
        contentType
      );
    } finally {
      recordThumbnailRequestCommands = previousRecording;
    }
  };
  const resetThumbnailRequestCounts = () => {
    thumbnailRequestSdkCommands.length = 0;
    for (const key of Object.keys(thumbnailRequestDriverCalls)) {
      thumbnailRequestDriverCalls[key] = 0;
    }
  };
  const thumbnailRequestDriverSnapshot = () => Object.fromEntries(
    Object.entries(thumbnailRequestDriverCalls).filter(([, count]) => count > 0)
  );
  managedLocalAccess.driver.exists = async (...args) => {
    thumbnailRequestDriverCalls.exists += 1;
    const result = await thumbnailRequestStorage.exists(...args);
    if (
      activeThumbnailRequestScenario?.abortAfterFullHead
      && args[0] === "full"
    ) {
      activeThumbnailRequestScenario.abortAfterFullHead = false;
      activeThumbnailRequestScenario.controller.abort(
        activeThumbnailRequestScenario.cancellation
      );
    }
    return result;
  };
  managedLocalAccess.driver.readBuffer = async (...args) => {
    thumbnailRequestDriverCalls.readBuffer += 1;
    const body = await thumbnailRequestStorage.readBuffer(...args);
    const behavior = activeThumbnailRequestScenario?.afterSourceRead;
    if (!behavior) return body;
    activeThumbnailRequestScenario.afterSourceRead = null;
    if (behavior === "recover") {
      await seedThumbnailRequestObject(
        "thumbs",
        activeThumbnailRequestScenario.thumbKey,
        Buffer.from("thumbnail recovered by another operation"),
        "image/webp"
      );
      await database.pool.query(
        "UPDATE metadata SET thumbnail_size=$2 WHERE id=$1",
        [
          activeThumbnailRequestScenario.id,
          Buffer.byteLength("thumbnail recovered by another operation")
        ]
      );
    } else if (behavior === "move") {
      await database.pool.query(
        "UPDATE metadata SET object_key=$2 WHERE id=$1",
        [
          activeThumbnailRequestScenario.id,
          activeThumbnailRequestScenario.objectKey + ".moved"
        ]
      );
    } else {
      throw new Error("Unknown thumbnail repair source-read behavior");
    }
    return body;
  };
  managedLocalAccess.driver.openRead = (...args) => {
    thumbnailRequestDriverCalls.openRead += 1;
    return thumbnailRequestStorage.openRead(...args);
  };
  managedLocalAccess.driver.writeBuffer = (...args) => {
    thumbnailRequestDriverCalls.writeBuffer += 1;
    return thumbnailRequestStorage.writeBuffer(...args);
  };
  managedLocalAccess.driver.removeObjects = (...args) => {
    thumbnailRequestDriverCalls.removeObjects += 1;
    return thumbnailRequestStorage.removeObjects(...args);
  };
  const runThumbnailRequestScenario = async ({
    thumbnailSize,
    full = true,
    thumbnail = false,
    behavior = "normal"
  }) => {
    const id = randomUUID();
    const objectKey = imagePaths.storageObjectKey(id, "png");
    const thumbKey = imagePaths.thumbnailObjectKey(objectKey);
    let inserted = false;
    try {
      await database.pool.query(
        "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, "
          + "brightness, theme, ext, md5, image_size, thumbnail_size) VALUES "
          + "($1, 'bootstrap-admin', 'local', $2, 'pc', 'dark', 'none', 'png', "
          + "$3, $4, $5)",
        [
          id,
          objectKey,
          createHash("md5").update(maintenanceSource).digest("hex"),
          maintenanceSource.byteLength,
          thumbnailSize
        ]
      );
      inserted = true;
      if (full) {
        await seedThumbnailRequestObject(
          "full",
          objectKey,
          maintenanceSource,
          "image/png"
        );
      }
      if (thumbnail) {
        await seedThumbnailRequestObject(
          "thumbs",
          thumbKey,
          Buffer.from("existing thumbnail"),
          "image/webp"
        );
      }
      resetThumbnailRequestCounts();
      const controller = new AbortController();
      const cancellation = new Error("cancel after full HEAD");
      activeThumbnailRequestScenario = {
        id,
        objectKey,
        thumbKey,
        controller,
        cancellation,
        abortAfterFullHead: behavior === "cancel_after_full_head",
        afterSourceRead: behavior === "recover_during_generation"
          ? "recover"
          : behavior === "move_during_generation"
            ? "move"
            : null
      };
      loseNextThumbnailPutResponse = behavior === "put_response_loss";
      let outcome;
      let error;
      try {
        outcome = await storageThumbnailRepair.repairStorageThumbnail(
          id,
          controller.signal
        );
      } catch (caught) {
        error = caught;
      }
      return {
        outcome,
        error,
        cancellation,
        driver: thumbnailRequestDriverSnapshot(),
        sdk: [...thumbnailRequestSdkCommands]
      };
    } finally {
      activeThumbnailRequestScenario = undefined;
      loseNextThumbnailPutResponse = false;
      if (inserted) {
        await database.pool.query("DELETE FROM metadata WHERE id=$1", [id]);
      }
      thumbnailRequestObjects.clear();
    }
  };
  try {
    const missingOriginal = await runThumbnailRequestScenario({
      thumbnailSize: 0,
      full: false
    });
    assert.equal(missingOriginal.outcome?.outcome, "skipped");
    assert.equal(missingOriginal.outcome?.reason, "当前位置的原图不存在");
    assert.deepEqual(missingOriginal.driver, { exists: 1 });
    assert.deepEqual(missingOriginal.sdk, ["HeadObjectCommand"]);

    const existingFinalized = await runThumbnailRequestScenario({
      thumbnailSize: 18,
      thumbnail: true
    });
    assert.equal(existingFinalized.outcome?.outcome, "skipped");
    assert.equal(existingFinalized.outcome?.reason, "缩略图已存在，无需维修");
    assert.deepEqual(existingFinalized.driver, { exists: 2 });
    assert.deepEqual(existingFinalized.sdk, [
      "HeadObjectCommand",
      "HeadObjectCommand"
    ]);

    const missingFinalized = await runThumbnailRequestScenario({
      thumbnailSize: 18
    });
    assert.equal(missingFinalized.outcome?.outcome, "repaired");
    assert.deepEqual(missingFinalized.driver, {
      exists: 3,
      readBuffer: 1,
      openRead: 1,
      writeBuffer: 1
    });
    assert.deepEqual(missingFinalized.sdk, [
      "HeadObjectCommand",
      "HeadObjectCommand",
      "GetObjectCommand",
      "HeadObjectCommand",
      "PutObjectCommand",
      "GetObjectCommand"
    ]);

    const missingUnfinalized = await runThumbnailRequestScenario({
      thumbnailSize: 0
    });
    assert.equal(missingUnfinalized.outcome?.outcome, "repaired");
    assert.deepEqual(missingUnfinalized.driver, {
      exists: 2,
      readBuffer: 1,
      openRead: 1,
      writeBuffer: 1
    });
    assert.deepEqual(missingUnfinalized.sdk, [
      "HeadObjectCommand",
      "GetObjectCommand",
      "HeadObjectCommand",
      "PutObjectCommand",
      "GetObjectCommand"
    ]);

    const existingUnfinalized = await runThumbnailRequestScenario({
      thumbnailSize: 0,
      thumbnail: true
    });
    assert.equal(existingUnfinalized.outcome?.outcome, "repaired");
    assert.deepEqual(existingUnfinalized.driver, {
      exists: 2,
      readBuffer: 1,
      openRead: 1,
      writeBuffer: 1,
      removeObjects: 1
    });
    assert.deepEqual(existingUnfinalized.sdk, [
      "HeadObjectCommand",
      "GetObjectCommand",
      "HeadObjectCommand",
      "HeadObjectCommand",
      "DeleteObjectsCommand",
      "HeadObjectCommand",
      "PutObjectCommand",
      "GetObjectCommand"
    ]);

    const recoveredDuringGeneration = await runThumbnailRequestScenario({
      thumbnailSize: 0,
      behavior: "recover_during_generation"
    });
    assert.equal(recoveredDuringGeneration.outcome?.outcome, "skipped");
    assert.equal(
      recoveredDuringGeneration.outcome?.reason,
      "生成期间缩略图已恢复"
    );
    assert.deepEqual(recoveredDuringGeneration.driver, {
      exists: 2,
      readBuffer: 1
    });
    assert.deepEqual(recoveredDuringGeneration.sdk, [
      "HeadObjectCommand",
      "GetObjectCommand",
      "HeadObjectCommand"
    ]);

    const movedDuringGeneration = await runThumbnailRequestScenario({
      thumbnailSize: 0,
      behavior: "move_during_generation"
    });
    assert.equal(movedDuringGeneration.outcome?.outcome, "skipped");
    assert.equal(
      movedDuringGeneration.outcome?.reason,
      "生成后图片位置或状态已变化"
    );
    assert.deepEqual(movedDuringGeneration.driver, {
      exists: 1,
      readBuffer: 1
    });
    assert.deepEqual(movedDuringGeneration.sdk, [
      "HeadObjectCommand",
      "GetObjectCommand"
    ]);

    const putResponseLoss = await runThumbnailRequestScenario({
      thumbnailSize: 0,
      behavior: "put_response_loss"
    });
    assert.equal(putResponseLoss.outcome?.outcome, "repaired");
    assert.equal(
      putResponseLoss.outcome?.reason,
      "写入响应丢失后已通过完整性回读确认"
    );
    assert.deepEqual(putResponseLoss.driver, {
      exists: 2,
      readBuffer: 1,
      openRead: 1,
      writeBuffer: 1
    });
    assert.deepEqual(putResponseLoss.sdk, [
      "HeadObjectCommand",
      "GetObjectCommand",
      "HeadObjectCommand",
      "PutObjectCommand",
      "GetObjectCommand"
    ]);

    const cancelled = await runThumbnailRequestScenario({
      thumbnailSize: 0,
      behavior: "cancel_after_full_head"
    });
    assert.equal(cancelled.error, cancelled.cancellation);
    assert.deepEqual(cancelled.driver, { exists: 1 });
    assert.deepEqual(cancelled.sdk, ["HeadObjectCommand"]);
  } finally {
    managedLocalAccess.driver.exists = originalThumbnailRequestDriver.exists;
    managedLocalAccess.driver.readBuffer =
      originalThumbnailRequestDriver.readBuffer;
    managedLocalAccess.driver.openRead = originalThumbnailRequestDriver.openRead;
    managedLocalAccess.driver.writeBuffer =
      originalThumbnailRequestDriver.writeBuffer;
    managedLocalAccess.driver.removeObjects =
      originalThumbnailRequestDriver.removeObjects;
    await thumbnailRequestStorage.close();
  }
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
      + "theme, ext, md5, image_size, thumbnail_size) VALUES "
      + "($1, 'bootstrap-admin', 'local', $2, 'pc', 'dark', 'none', 'png', $3, $4, 777)",
    [
      maintenanceImage,
      maintenanceObjectKey,
      createHash("md5").update(maintenanceSource).digest("hex"),
      maintenanceSource.byteLength
    ]
  );
  await managedLocalAccess.driver.writeBuffer(
    "full",
    maintenanceObjectKey,
    maintenanceSource,
    "image/png"
  );
  const orphanToken = randomUUID();
  const orphanFull = "maintenance/" + orphanToken + ".webp";
  const orphanThumb = "maintenance/" + orphanToken + ".thumb.webp";
  const orphanUpload = orphanToken + ".stale.image.webp";
  await managedLocalAccess.driver.writeBuffer(
    "full",
    orphanFull,
    Buffer.from("orphan-full"),
    "image/webp"
  );
  await managedLocalAccess.driver.writeBuffer(
    "thumbs",
    orphanThumb,
    Buffer.from("orphan-thumb"),
    "image/webp"
  );
  await managedLocalAccess.driver.writeBuffer(
    "_uploads",
    orphanUpload,
    Buffer.from("orphan-upload"),
    "image/webp"
  );
  const maintenanceIngestionOwner = "maintenance-" + randomUUID();
  const activeImport = ingestionSessionIdentity.createIngestionSessionId(
    maintenanceIngestionOwner,
    "import",
    coreUuid.randomUuidV7()
  );
  const activeImportImage = imageTime.createImageId(
    new Date("2026-08-23T04:00:00.000Z"),
    1
  );
  const activeImportWithoutHash = {
    owner: maintenanceIngestionOwner,
    queue: "import",
    source_type: "url",
    session_id: activeImport,
    image_id: activeImportImage,
    image_time: "2026-08-23T04:00:00.000Z",
    request_hash: "8".repeat(64),
    import_download: { url: "https://img.example.com/maintenance.webp" },
    metadata: serviceDraft,
    storage_slug: "local",
    status: "queued",
    phase: "queued",
    message: "queued",
    progress: 0,
    version: 0,
    progress_seq: 0,
    last_semantic_revision: 0,
    accepted_at: 0,
    accepted_order: 0,
    execution_token: "",
    raw_generation: "",
    raw_size: 0,
    discard_at: 0
  };
  await productionIngestionRepository.acceptImportSession({
    ...activeImportWithoutHash,
    semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
      activeImportWithoutHash
    )
  }, displayOrderKey(activeImport, 1, Date.now()));
  const activeGeneration = coreUuid.randomUuidV7();
  const activeExecutionToken = coreUuid.randomUuidV7();
  const activeStagingInput = {
    session_id: activeImport,
    image_id: activeImportImage,
    generation: activeGeneration,
    execution_token: activeExecutionToken
  };
  const activeUpload = ingestionStagingKeys.ingestionStagingImageKey(activeStagingInput);
  const activeThumbnail = ingestionStagingKeys.ingestionStagingThumbnailKey(
    activeStagingInput
  );
  const activeCanonical = await productionIngestionRepository.readSession(
    maintenanceIngestionOwner,
    activeImport
  );
  assert.ok(activeCanonical && "execution_token" in activeCanonical);
  await productionIngestionRepository.mutateSemantic(
    activeCanonical,
    activeCanonical.version,
    {
      ...activeCanonical,
      status: "ready",
      phase: "ready",
      message: "ready",
      progress: 100,
      execution_token: "",
      raw_generation: "",
      prepared: {
        prepared_image_key: activeUpload,
        prepared_thumbnail_key: activeThumbnail,
        original_size: 10,
        original_width: 2,
        original_height: 2,
        width: 2,
        height: 2,
        ext: "webp",
        md5: "9".repeat(32),
        prepared_image_sha256: "a".repeat(64),
        prepared_thumbnail_sha256: "b".repeat(64),
        size: 8,
        thumbnail_size: 4,
        quality: 90,
        transcoded: true,
        detected_device: "pc",
        detected_brightness: "dark",
        duplicate_count: 0,
        generation: activeGeneration
      },
      semantic_hash: ""
    }
  );
  const retainedImport = ingestionSessionIdentity.createIngestionSessionId(
    maintenanceIngestionOwner,
    "import",
    coreUuid.randomUuidV7()
  );
  const retainedUpload = ingestionStagingKeys.ingestionStagingImageKey({
    session_id: retainedImport,
    image_id: imageTime.createImageId(
      new Date("2026-08-23T04:00:01.000Z"),
      2
    ),
    generation: coreUuid.randomUuidV7(),
    execution_token: coreUuid.randomUuidV7()
  });
  const staleUpload = ingestionStagingKeys.ingestionStagingImageKey({
    session_id: activeImport,
    image_id: activeImportImage,
    generation: coreUuid.randomUuidV7At(
      new Date(Date.now() - 25 * 60 * 60 * 1000)
    ),
    execution_token: coreUuid.randomUuidV7()
  });
  await managedLocalAccess.driver.writeBuffer(
    "_uploads",
    activeUpload,
    Buffer.from("active-upload"),
    "image/webp"
  );
  await managedLocalAccess.driver.writeBuffer(
    "_uploads",
    retainedUpload,
    Buffer.from("retained-upload"),
    "image/webp"
  );
  await managedLocalAccess.driver.writeBuffer(
    "_uploads",
    staleUpload,
    Buffer.from("stale-upload"),
    "image/webp"
  );
  const staleLocalCandidate = staleUpload + ".candidate-" + randomUUID();
  await managedLocalAccess.driver.writeBuffer(
    "_uploads",
    staleLocalCandidate,
    Buffer.from("stale-local-candidate"),
    "image/webp"
  );
  const staleRawPair = {
    session_id: ingestionSessionIdentity.createIngestionSessionId(
      maintenanceIngestionOwner,
      "import",
      coreUuid.randomUuidV7()
    ),
    image_id: imageTime.createImageId(
      new Date("2026-08-23T04:00:03.000Z"),
      4
    )
  };
  const staleRawGeneration = coreUuid.randomUuidV7();
  const stalePartExecution = coreUuid.randomUuidV7();
  const staleRawPath = ingestionRawFiles.ingestionRawPath(
    "import",
    staleRawPair,
    staleRawGeneration
  );
  const stalePartPath = ingestionRawFiles.ingestionRawPartPath(
    "import",
    staleRawPair,
    staleRawGeneration,
    stalePartExecution
  );
  await mkdir(dirname(staleRawPath), { recursive: true });
  await writeFile(staleRawPath, "stale-raw");
  await writeFile(stalePartPath, "stale-part");
  const staleMaterialTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await utimes(staleRawPath, staleMaterialTime, staleMaterialTime);
  await utimes(stalePartPath, staleMaterialTime, staleMaterialTime);
  const maintenancePreview = await storageCheck.checkStorage();
  assert.ok(maintenancePreview.active_staging_files.some((entry) => (
    entry.key === activeUpload
  )), JSON.stringify(maintenancePreview));
  assert.ok(maintenancePreview.retained_staging_files.some((entry) => (
    entry.key === retainedUpload
  )), JSON.stringify(maintenancePreview));
  assert.ok(maintenancePreview.retained_staging_files.some((entry) => (
    entry.key === orphanUpload
  )), JSON.stringify(maintenancePreview));
  assert.ok(maintenancePreview.orphan_staging_files.some((entry) => (
    entry.key === staleUpload
  )), JSON.stringify(maintenancePreview));
  assert.ok(maintenancePreview.orphan_staging_files.some((entry) => (
    entry.key === staleLocalCandidate
  )), JSON.stringify(maintenancePreview));
  assert.ok(maintenancePreview.stale_ingestion_raw_files.count >= 1);
  assert.ok(maintenancePreview.stale_ingestion_part_files.count >= 1);

  const originalMaintenanceListKeys = managedLocalAccess.driver.listKeys.bind(
    managedLocalAccess.driver
  );
  let releaseMaintenanceListing;
  let markMaintenanceListingStarted;
  let blockMaintenanceListing = true;
  const maintenanceListingGate = new Promise((resolve) => {
    releaseMaintenanceListing = resolve;
  });
  const maintenanceListingStarted = new Promise((resolve) => {
    markMaintenanceListingStarted = resolve;
  });
  managedLocalAccess.driver.listKeys = (prefix, options) => {
    const listing = originalMaintenanceListKeys(prefix, options);
    if (prefix !== "full" || !blockMaintenanceListing) return listing;
    blockMaintenanceListing = false;
    return (async function* () {
      markMaintenanceListingStarted();
      await maintenanceListingGate;
      return yield* listing;
    })();
  };
  const pendingMaintenance = storageMaintenance.maintainStorage();
  await maintenanceListingStarted;
  let concurrentMigrationSettled = false;
  const concurrentMigration = storageMigration.migrateImageToStorageBackend({
    id: maintenanceImage,
    object_key: maintenanceObjectKey,
    ext: "png",
    storage_slug: "local",
    md5: createHash("md5").update(maintenanceSource).digest("hex"),
    image_size: maintenanceSource.byteLength,
    thumbnail_size: 0
  }, "local-copy").finally(() => {
    concurrentMigrationSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(
    concurrentMigrationSettled,
    false,
    "整库维护持有写锁时，图片迁移不得越过共享位置锁"
  );
  releaseMaintenanceListing();
  let maintained;
  let concurrentMigrationResult;
  try {
    [maintained, concurrentMigrationResult] = await Promise.all([
      pendingMaintenance,
      concurrentMigration
    ]);
  } finally {
    managedLocalAccess.driver.listKeys = originalMaintenanceListKeys;
    releaseMaintenanceListing?.();
  }
  assert.equal(concurrentMigrationResult, "migrated");
  assert.equal(
    maintained.requested,
    maintained.repaired
      + maintained.removed
      + maintained.skipped
      + maintained.failed
  );
  assert.ok(maintained.items.some((item) => (
    item.image_id === maintenanceImage && item.outcome === "repaired"
  )), JSON.stringify(maintained));
  assert.ok(maintained.removed >= 3, JSON.stringify(maintained));
  assert.ok(maintained.active_staging_objects_retained >= 1);
  const maintainedThumb = await managedLocalAccess.driver.readBuffer(
    "thumbs",
    maintenanceThumbKey
  );
  const maintainedRow = await database.pool.query(
    "SELECT thumbnail_size FROM metadata WHERE id=$1",
    [maintenanceImage]
  );
  assert.equal(
    Number(maintainedRow.rows[0]?.thumbnail_size),
    maintainedThumb.byteLength
  );
  for (const [prefix, key] of [
    ["full", orphanFull],
    ["thumbs", orphanThumb],
    ["_uploads", staleUpload],
    ["_uploads", staleLocalCandidate]
  ]) {
    assert.equal(
      await managedLocalAccess.driver.exists(prefix, key),
      false
    );
  }
  assert.equal(
    await managedLocalAccess.driver.exists("_uploads", activeUpload),
    true
  );
  assert.equal(
    await managedLocalAccess.driver.exists("_uploads", retainedUpload),
    true
  );
  assert.ok(maintained.items.some((item) => (
    item.key === retainedUpload && item.outcome === "skipped"
  )), JSON.stringify(maintained));
  assert.equal(
    await managedLocalAccess.driver.exists("_uploads", orphanUpload),
    true
  );
  assert.ok(maintained.items.some((item) => (
    item.key === orphanUpload && item.outcome === "skipped"
  )), JSON.stringify(maintained));
  const autoStaleUpload = ingestionStagingKeys.ingestionStagingImageKey({
    session_id: ingestionSessionIdentity.createIngestionSessionId(
      maintenanceIngestionOwner,
      "import",
      coreUuid.randomUuidV7()
    ),
    image_id: imageTime.createImageId(
      new Date("2026-08-23T04:00:04.000Z"),
      5
    ),
    generation: coreUuid.randomUuidV7At(
      new Date(Date.now() - 25 * 60 * 60 * 1000)
    ),
    execution_token: coreUuid.randomUuidV7()
  });
  await managedLocalAccess.driver.writeBuffer(
    "_uploads",
    autoStaleUpload,
    Buffer.from("automatic-stale-upload"),
    "image/webp"
  );
  const autoStaleLocalCandidate = autoStaleUpload + ".candidate-" + randomUUID();
  await managedLocalAccess.driver.writeBuffer(
    "_uploads",
    autoStaleLocalCandidate,
    Buffer.from("automatic-stale-local-candidate"),
    "image/webp"
  );
  await ingestionRawFiles.withActiveIngestionRawPaths([stalePartPath], async () => {
    const automaticCleanup = await ingestionOrphanCleanup.cleanupIngestionOrphans();
    assert.equal(automaticCleanup.skipped, false);
    assert.ok(automaticCleanup.raw_removed >= 1, JSON.stringify(automaticCleanup));
    assert.ok(automaticCleanup.staging_removed >= 1, JSON.stringify(automaticCleanup));
    assert.equal(await readFile(stalePartPath, "utf8"), "stale-part");
  });
  await ingestionOrphanCleanup.cleanupIngestionOrphans();
  await assert.rejects(readFile(staleRawPath), (error) => error?.code === "ENOENT");
  await assert.rejects(readFile(stalePartPath), (error) => error?.code === "ENOENT");
  assert.equal(
    await managedLocalAccess.driver.exists("_uploads", autoStaleUpload),
    false
  );
  assert.equal(
    await managedLocalAccess.driver.exists(
      "_uploads",
      autoStaleLocalCandidate
    ),
    false,
    "local 原子发布崩溃候选必须沿基础 attempt generation 回收"
  );
  assert.equal(
    await managedLocalAccess.driver.exists("_uploads", activeUpload),
    true
  );
  assert.equal(
    await managedLocalAccess.driver.exists("_uploads", retainedUpload),
    true
  );
  assert.equal(
    await managedLocalAccess.driver.exists("_uploads", orphanUpload),
    true
  );
  const progressiveCleanupKeys = Array.from({ length: 101 }, (_, index) => (
    ingestionStagingKeys.ingestionStagingImageKey({
      session_id: ingestionSessionIdentity.createIngestionSessionId(
        maintenanceIngestionOwner,
        "import",
        \`progressive-\${index}\`
      ),
      image_id: imageTime.createImageId(
        new Date("2026-08-23T04:00:05.000Z"),
        index + 100
      ),
      generation: coreUuid.randomUuidV7At(
        new Date(Date.now() - 25 * 60 * 60 * 1000)
      ),
      execution_token: coreUuid.randomUuidV7()
    })
  ));
  await Promise.all(progressiveCleanupKeys.map((key) => (
    managedLocalAccess.driver.writeBuffer(
      "_uploads",
      key,
      Buffer.from("progressive-cleanup"),
      "image/webp"
    )
  )));
  const progressiveCleanupKeySet = new Set(progressiveCleanupKeys);
  const progressiveCleanupCalls = [];
  const originalProgressiveRemoveObjects = managedLocalAccess.driver
    .removeObjects.bind(managedLocalAccess.driver);
  managedLocalAccess.driver.removeObjects = async (objects, options) => {
    const matching = objects.filter((object) => (
      object.prefix === "_uploads" && progressiveCleanupKeySet.has(object.key)
    ));
    if (matching.length) {
      progressiveCleanupCalls.push({
        total: objects.length,
        matching: matching.length
      });
    }
    return originalProgressiveRemoveObjects(objects, options);
  };
  try {
    const progressiveCleanup = await ingestionOrphanCleanup
      .cleanupIngestionOrphans();
    assert.ok(
      progressiveCleanup.staging_removed >= progressiveCleanupKeys.length,
      JSON.stringify(progressiveCleanup)
    );
  } finally {
    managedLocalAccess.driver.removeObjects = originalProgressiveRemoveObjects;
  }
  assert.ok(progressiveCleanupCalls.length >= 2, JSON.stringify(
    progressiveCleanupCalls
  ));
  assert.ok(progressiveCleanupCalls.every((call) => call.total <= 100));
  assert.equal(
    progressiveCleanupCalls.reduce((total, call) => total + call.matching, 0),
    progressiveCleanupKeys.length
  );
  assert.equal(
    (await Promise.all(progressiveCleanupKeys.map((key) => (
      managedLocalAccess.driver.exists("_uploads", key)
    )))).some(Boolean),
    false
  );
  const rotationSlugs = Array.from(
    { length: 40 },
    (_, index) => "orphan-rotation-" + String(index).padStart(2, "0")
  );
  const rotationRows = rotationSlugs.map((slug) => ({
    slug,
    config: {
      ...registryConfig,
      endpoint: "https://orphan-rotation.invalid",
      bucket: "orphan-rotation",
      root_path: "roots/" + slug
    }
  }));
  await database.pool.query(
    "INSERT INTO storage_backend (slug, display_name, type, config, enabled) "
      + "SELECT item->>'slug', item->>'slug', 's3', item->'config', false "
      + "FROM jsonb_array_elements($1::jsonb) AS item",
    [JSON.stringify(rotationRows)]
  );
  registry.invalidateStorageBackendRegistry();
  const originalRotationListKeys = S3Backend.prototype.listKeys;
  const rotationPasses = [[], []];
  let rotationPass = 0;
  S3Backend.prototype.listKeys = function () {
    if (this.config.slug.startsWith("orphan-rotation-")) {
      rotationPasses[rotationPass].push(this.config.slug);
    }
    return (async function* () {
      return { complete: true, count: 0 };
    })();
  };
  try {
    const firstRotationCleanup = await ingestionOrphanCleanup.cleanupIngestionOrphans();
    assert.ok(firstRotationCleanup.incomplete_namespaces >= 1);
    rotationPass = 1;
    await ingestionOrphanCleanup.cleanupIngestionOrphans();
    const firstRotationSet = new Set(rotationPasses[0]);
    assert.ok(rotationPasses[0].length > 0);
    assert.ok(rotationPasses[1].some((slug) => !firstRotationSet.has(slug)),
      "超过 32 个物理组时下一周期必须从未访问组继续");
  } finally {
    S3Backend.prototype.listKeys = originalRotationListKeys;
    await database.pool.query(
      "DELETE FROM storage_backend WHERE slug=ANY($1::text[])",
      [rotationSlugs]
    );
    registry.invalidateStorageBackendRegistry();
  }
  const preparingLeaseOwner = "current-prepare-lease-" + randomUUID();
  const preparingLeaseSession = {
    owner: preparingLeaseOwner,
    queue: "import",
    source_type: "url",
    session_id: ingestionSessionIdentity.createIngestionSessionId(
      preparingLeaseOwner,
      "import",
      "transcode-gate"
    ),
    image_id: imageTime.createImageId(
      new Date("2026-08-23T04:00:04.250Z"),
      54
    ),
    image_time: "2026-08-23T04:00:04.250Z",
    request_hash: "4".repeat(64),
    import_download: { url: "https://example.com/transcode-gate.webp" },
    metadata: serviceDraft,
    storage_slug: "local",
    status: "preparing",
    phase: "prepare-waiting",
    message: "waiting for normalization admission",
    progress: null,
    version: 1,
    progress_seq: 0,
    last_semantic_revision: 1,
    accepted_at: Date.now(),
    accepted_order: 1,
    execution_token: coreUuid.randomUuidV7(),
    raw_generation: coreUuid.randomUuidV7(),
    raw_size: 16,
    discard_at: Date.now() + 60_000,
    semantic_hash: "5".repeat(64)
  };
  const preparingLeasePath = ingestionRawFiles.ingestionRawPath(
    preparingLeaseSession.queue,
    preparingLeaseSession,
    preparingLeaseSession.raw_generation
  );
  await mkdir(dirname(preparingLeasePath), { recursive: true });
  await writeFile(preparingLeasePath, "transcode-gate-raw");
  let releaseTranscode!: () => void;
  let markTranscodeStarted!: () => void;
  const transcodeGate = new Promise<void>((resolve) => {
    releaseTranscode = resolve;
  });
  const transcodeStarted = new Promise<void>((resolve) => {
    markTranscodeStarted = resolve;
  });
  const normalizationConcurrency = runtimeConfigStore.getRuntimeConfig()
    .normalize.concurrency;
  assert.ok(normalizationConcurrency > 0);
  let releaseNormalizationBlockers!: () => void;
  const normalizationBlockerGate = new Promise<void>((resolve) => {
    releaseNormalizationBlockers = resolve;
  });
  let normalizationBlockersEntered = 0;
  let markNormalizationBlockersEntered!: () => void;
  const allNormalizationBlockersEntered = new Promise<void>((resolve) => {
    markNormalizationBlockersEntered = resolve;
  });
  const normalizationBlockers = Array.from(
    { length: normalizationConcurrency },
    () => normalizationAdmission.withNormalizationAdmission(
      new AbortController().signal,
      async () => {
        normalizationBlockersEntered += 1;
        if (normalizationBlockersEntered === normalizationConcurrency) {
          markNormalizationBlockersEntered();
        }
        await normalizationBlockerGate;
      }
    )
  );
  await allNormalizationBlockersEntered;
  let normalizationAdmissionNotifications = 0;
  const prepareProgressPatches = [];
  let currentPreparingLease = preparingLeaseSession;
  const prepareAbort = new AbortController();
  const prepareAbortReason = new Error("cancel preparing transcode");
  const pendingPrepare = ingestionPrepareSession.prepareIngestionSessionSnapshot(
    {
      updateProgress: async (_current, _version, patch) => {
        prepareProgressPatches.push(patch);
        currentPreparingLease = {
          ...currentPreparingLease,
          ...patch,
          version: currentPreparingLease.version + 1
        };
        return { session: currentPreparingLease };
      },
      readSession: async () => currentPreparingLease
    },
    preparingLeaseSession,
    prepareAbort.signal,
    {
      onNormalizationAdmitted: () => {
        normalizationAdmissionNotifications += 1;
      },
      transcode: async (_path, _settings, signal) => {
        assert.equal(signal, prepareAbort.signal);
        markTranscodeStarted();
        await transcodeGate;
        return {};
      }
    }
  );
  await delay(0);
  assert.deepEqual(
    prepareProgressPatches,
    [],
    "等待 Normalize 许可期间不得提前发布 normalizing 进度"
  );
  assert.equal(normalizationAdmissionNotifications, 0);
  releaseNormalizationBlockers();
  await Promise.all(normalizationBlockers);
  await transcodeStarted;
  assert.equal(normalizationAdmissionNotifications, 1);
  assert.equal(prepareProgressPatches[0]?.phase, "normalizing");
  await ingestionRawFiles.removeIngestionRaw(
    preparingLeaseSession.queue,
    preparingLeaseSession,
    preparingLeaseSession.raw_generation
  );
  assert.equal(
    await readFile(preparingLeasePath, "utf8"),
    "transcode-gate-raw"
  );
  prepareAbort.abort(prepareAbortReason);
  releaseTranscode();
  await assert.rejects(pendingPrepare);
  assert.equal(
    await readFile(preparingLeasePath, "utf8"),
    "transcode-gate-raw",
    "取消不得在 Sharp 消费 raw 的活跃租约内删除文件"
  );
  await ingestionRawFiles.removeIngestionRaw(
    preparingLeaseSession.queue,
    preparingLeaseSession,
    preparingLeaseSession.raw_generation
  );
  await assert.rejects(
    readFile(preparingLeasePath, "utf8"),
    (error) => error?.code === "ENOENT"
  );
  const delayedCleanupOwner = "current-delayed-cleanup-" + randomUUID();
  const delayedCleanupPair = {
    session_id: ingestionSessionIdentity.createIngestionSessionId(
      delayedCleanupOwner,
      "import",
      "reused-pair"
    ),
    image_id: imageTime.createImageId(
      new Date("2026-08-23T04:00:04.375Z"),
      541
    )
  };
  const oldRawGeneration = coreUuid.randomUuidV7();
  const newRawGeneration = coreUuid.randomUuidV7();
  const delayedCleanupSession = {
    ...preparingLeaseSession,
    ...delayedCleanupPair,
    owner: delayedCleanupOwner,
    raw_generation: oldRawGeneration,
    status: "failed",
    phase: "failed",
    message: "failed",
    execution_token: "",
    version: 1
  };
  const oldDelayedRaw = ingestionRawFiles.ingestionRawPath(
    "import",
    delayedCleanupPair,
    oldRawGeneration
  );
  const newDelayedRaw = ingestionRawFiles.ingestionRawPath(
    "import",
    delayedCleanupPair,
    newRawGeneration
  );
  await mkdir(dirname(oldDelayedRaw), { recursive: true });
  await writeFile(oldDelayedRaw, "old-incarnation-raw");
  let delayedCleanupWork: (() => Promise<void>) | null = null;
  const delayedCleanupResults = await ingestionCancelSession.cancelIngestionSessions(
    {
      readSessions: async () => [delayedCleanupSession],
      mutateSemantic: async (_current, _version, next) => ({
        session: next,
        metadata: { revision: 2 }
      })
    },
    new ingestionIrreversibleCoordinator.IngestionIrreversibleCoordinator(),
    delayedCleanupOwner,
    [{
      ...delayedCleanupPair,
      expected_version: delayedCleanupSession.version
    }],
    () => undefined,
    {},
    {
      readCommitted: async () => new Map(),
      scheduleCleanup: (work) => {
        delayedCleanupWork = work;
      }
    }
  );
  assert.equal(delayedCleanupResults[0].status, "discarded");
  assert.equal(delayedCleanupResults[0].queue_revision, 2);
  assert.ok(delayedCleanupWork);
  await writeFile(newDelayedRaw, "new-incarnation-raw");
  await delayedCleanupWork!();
  await assert.rejects(
    readFile(oldDelayedRaw, "utf8"),
    (error) => error?.code === "ENOENT"
  );
  assert.equal(
    await readFile(newDelayedRaw, "utf8"),
    "new-incarnation-raw",
    "迟到的退休清理只能删除冻结 generation，不能递归越过新 incarnation"
  );
  await ingestionRawFiles.removeIngestionRaw(
    "import",
    delayedCleanupPair,
    newRawGeneration
  );
  const rawCursorOwner = "current-raw-cursor-" + randomUUID();
  const rawCursorPair = {
    session_id: ingestionSessionIdentity.createIngestionSessionId(
      rawCursorOwner,
      "upload",
      "nested-cursor"
    ),
    image_id: imageTime.createImageId(
      new Date("2026-08-23T04:00:04.500Z"),
      55
    )
  };
  const rawCursorBase = Date.now() - 25 * 60 * 60 * 1000;
  const rawCursorGenerations = Array.from({ length: 31 }, (_, index) => (
    coreUuid.randomUuidV7At(new Date(rawCursorBase + index))
  ));
  const rawCursorPaths = rawCursorGenerations.map((generation) => (
    ingestionRawFiles.ingestionRawPath("upload", rawCursorPair, generation)
  ));
  await mkdir(dirname(rawCursorPaths[0]), { recursive: true });
  for (const [index, path] of rawCursorPaths.entries()) {
    await writeFile(path, "raw-cursor-" + index);
    const modified = new Date(rawCursorBase + index);
    await utimes(path, modified, modified);
  }
  const rawCursorKeep = new Set(rawCursorPaths.slice(0, -1));
  const rawCursorTail = rawCursorPaths.at(-1)!;
  const originalRawScanBudget = sharedAppConfig.appConfig.ingestionRuntime
    .orphanCleanupMaxRawEntriesPerCycle;
  await ingestionRawFiles.closeIngestionRawCleanupCursor();
  try {
    Reflect.set(
      sharedAppConfig.appConfig.ingestionRuntime,
      "orphanCleanupMaxRawEntriesPerCycle",
      100_000
    );
    let timeoutTailRemoved = false;
    for (let pass = 0; pass < 1_024 && !timeoutTailRemoved; pass += 1) {
      let checks = 0;
      let aborted = false;
      const timeoutReason = new Error("controlled raw cleanup time slice");
      const timeSliceSignal = {
        get aborted() {
          return aborted;
        },
        throwIfAborted() {
          checks += 1;
          if (checks < 9) return;
          aborted = true;
          throw timeoutReason;
        }
      };
      await ingestionRawFiles.cleanupIngestionRawOrphans({
        keep: rawCursorKeep,
        rawCutoff: Date.now() - 1_000,
        partCutoff: Date.now() - 1_000,
        signal: timeSliceSignal
      });
      try {
        await readFile(rawCursorTail, "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        timeoutTailRemoved = true;
      }
    }
    assert.equal(
      timeoutTailRemoved,
      true,
      "周期时间片中止必须保留 DFS 位置并最终抵达慢目录尾部"
    );
    await writeFile(rawCursorTail, "raw-cursor-30");
    await utimes(
      rawCursorTail,
      new Date(rawCursorBase + 30),
      new Date(rawCursorBase + 30)
    );
    await ingestionRawFiles.closeIngestionRawCleanupCursor();

    Reflect.set(
      sharedAppConfig.appConfig.ingestionRuntime,
      "orphanCleanupMaxRawEntriesPerCycle",
      2
    );
    const truncatedRawPreview = await storageCheck.checkStorage();
    assert.ok(
      truncatedRawPreview.incomplete_ingestion_raw_scan.length >= 1,
      JSON.stringify(truncatedRawPreview.incomplete_ingestion_raw_scan)
    );
    assert.equal(
      await readFile(rawCursorTail, "utf8"),
      "raw-cursor-30",
      "只读检查即使截断也不得删除 raw 或空目录"
    );

    Reflect.set(
      sharedAppConfig.appConfig.ingestionRuntime,
      "orphanCleanupMaxRawEntriesPerCycle",
      10
    );
    let tailRemoved = false;
    for (let pass = 0; pass < 256 && !tailRemoved; pass += 1) {
      await ingestionRawFiles.cleanupIngestionRawOrphans({
        keep: rawCursorKeep,
        rawCutoff: Date.now() - 1_000,
        partCutoff: Date.now() - 1_000
      });
      try {
        await readFile(rawCursorTail, "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        tailRemoved = true;
      }
    }
    assert.equal(
      tailRemoved,
      true,
      "跨周期 DFS 游标必须越过单 session 前段保留文件抵达尾部"
    );
  } finally {
    Reflect.set(
      sharedAppConfig.appConfig.ingestionRuntime,
      "orphanCleanupMaxRawEntriesPerCycle",
      originalRawScanBudget
    );
    await ingestionRawFiles.closeIngestionRawCleanupCursor();
  }
  for (const generation of rawCursorGenerations.slice(0, -1)) {
    await ingestionRawFiles.removeIngestionRaw(
      "upload",
      rawCursorPair,
      generation
    );
  }
  const rawCursorImageDirectory = dirname(rawCursorPaths[0]);
  const rawCursorSessionDirectory = dirname(rawCursorImageDirectory);
  await assert.rejects(
    readdir(rawCursorImageDirectory),
    (error) => error?.code === "ENOENT"
  );
  await assert.rejects(
    readdir(rawCursorSessionDirectory),
    (error) => error?.code === "ENOENT"
  );
  const incompleteStaleUpload = ingestionStagingKeys.ingestionStagingImageKey({
    session_id: ingestionSessionIdentity.createIngestionSessionId(
      maintenanceIngestionOwner,
      "import",
      coreUuid.randomUuidV7()
    ),
    image_id: imageTime.createImageId(
      new Date("2026-08-23T04:00:05.000Z"),
      6
    ),
    generation: coreUuid.randomUuidV7At(
      new Date(Date.now() - 25 * 60 * 60 * 1000)
    ),
    execution_token: coreUuid.randomUuidV7()
  });
  await managedLocalAccess.driver.writeBuffer(
    "_uploads",
    incompleteStaleUpload,
    Buffer.from("incomplete-listing-retained"),
    "image/webp"
  );
  const completeAutomaticList = managedLocalAccess.driver.listKeys.bind(
    managedLocalAccess.driver
  );
  managedLocalAccess.driver.listKeys = (prefix, options) => {
    if (prefix !== "_uploads") return completeAutomaticList(prefix, options);
    return (async function* () {
      yield [incompleteStaleUpload];
      return { complete: false, count: 1, reason: "max_keys" };
    })();
  };
  try {
    const incompleteCleanup = await ingestionOrphanCleanup.cleanupIngestionOrphans();
    assert.ok(incompleteCleanup.incomplete_namespaces >= 1);
    assert.equal(
      await managedLocalAccess.driver.exists("_uploads", incompleteStaleUpload),
      true
    );
  } finally {
    managedLocalAccess.driver.listKeys = completeAutomaticList;
    await removeDriverObject(
      managedLocalAccess.driver,
      "_uploads",
      incompleteStaleUpload
    );
  }
  const maintainedAgain = await storageMaintenance.maintainStorage();
  assert.equal(maintainedAgain.repaired, 0, JSON.stringify(maintainedAgain));
  assert.equal(maintainedAgain.removed, 0, JSON.stringify(maintainedAgain));

  const leasedRepairImage = randomUUID();
  const leasedRepairKey = imagePaths.storageObjectKey(leasedRepairImage, "png");
  const leasedRepairThumb = imagePaths.thumbnailObjectKey(leasedRepairKey);
  const leasedRepairBody = Buffer.from("lease-protected-thumbnail");
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
      + "theme, ext, md5, thumbnail_size) VALUES "
      + "($1, 'bootstrap-admin', 'local', $2, 'pc', 'dark', 'none', 'png', $3, 0)",
    [
      leasedRepairImage,
      leasedRepairKey,
      createHash("md5").update(maintenanceSource).digest("hex")
    ]
  );
  await managedLocalAccess.driver.writeBuffer(
    "full",
    leasedRepairKey,
    maintenanceSource,
    "image/png"
  );
  await managedLocalAccess.driver.writeBuffer(
    "thumbs",
    leasedRepairThumb,
    leasedRepairBody,
    "image/webp"
  );
  const leasedCleanupObjects = await cleanup.captureMoveCleanupObjects([
    { prefix: "thumbs", key: leasedRepairThumb, backend: "local" }
  ]);
  await cleanup.enqueueCapturedObjectsForCleanupWithoutLocationLock(
    leasedRepairImage,
    leasedCleanupObjects,
    "test_maintenance_respects_cleanup_lease"
  );
  const leasedCleanupReceipt = (await database.pool.query(
    "SELECT id FROM background_job WHERE type='move.cleanup' AND target_id=$1",
    [leasedRepairImage]
  )).rows[0];
  assert.ok(leasedCleanupReceipt?.id);
  const originalLeasedExists = managedLocalAccess.driver.exists.bind(
    managedLocalAccess.driver
  );
  const originalLeasedReadBuffer = managedLocalAccess.driver.readBuffer.bind(
    managedLocalAccess.driver
  );
  const originalLeasedRemoveObjects = managedLocalAccess.driver.removeObjects.bind(
    managedLocalAccess.driver
  );
  const originalLeasedQuery = database.pool.query.bind(database.pool);
  const leasedRepairTouches = [];
  managedLocalAccess.driver.exists = async (prefix, key, options) => {
    if (prefix === "thumbs" && key === leasedRepairThumb) {
      leasedRepairTouches.push("exists");
    }
    return originalLeasedExists(prefix, key, options);
  };
  managedLocalAccess.driver.readBuffer = async (prefix, key, options) => {
    if (prefix === "thumbs" && key === leasedRepairThumb) {
      leasedRepairTouches.push("readBuffer");
    }
    return originalLeasedReadBuffer(prefix, key, options);
  };
  managedLocalAccess.driver.removeObjects = async (objects, options) => {
    if (objects.some((object) => (
      object.prefix === "thumbs" && object.key === leasedRepairThumb
    ))) {
      leasedRepairTouches.push("remove");
    }
    return originalLeasedRemoveObjects(objects, options);
  };
  database.pool.query = (text, values) => {
    if (
      typeof text === "string"
      && text.includes("SET thumbnail_size=$2")
      && values?.[0] === leasedRepairImage
    ) {
      leasedRepairTouches.push("thumbnail_size update");
    }
    return originalLeasedQuery(text, values);
  };
  let leasedMaintenance;
  try {
    leasedMaintenance = await storageMaintenance.maintainStorage();
  } finally {
    managedLocalAccess.driver.exists = originalLeasedExists;
    managedLocalAccess.driver.readBuffer = originalLeasedReadBuffer;
    managedLocalAccess.driver.removeObjects = originalLeasedRemoveObjects;
    database.pool.query = originalLeasedQuery;
  }
  assert.ok(leasedMaintenance.items.some((item) => (
    item.image_id === leasedRepairImage
    && item.outcome === "failed"
    && String(item.error).includes("未完成的删除任务")
  )), JSON.stringify(leasedMaintenance));
  assert.deepEqual(
    leasedRepairTouches,
    [],
    "维护必须先拒绝租约占用项，再进行对象探测、读取、删除或数据库标记"
  );
  assert.deepEqual(
    await managedLocalAccess.driver.readBuffer("thumbs", leasedRepairThumb),
    leasedRepairBody,
    "未完成的修复租约必须在维护读取、删除或标记前保护确定键"
  );
  assert.equal(
    Number((await database.pool.query(
      "SELECT thumbnail_size FROM metadata WHERE id=$1",
      [leasedRepairImage]
    )).rows[0]?.thumbnail_size),
    0
  );
  await database.pool.query(
    "DELETE FROM background_job WHERE id=$1",
    [leasedCleanupReceipt.id]
  );
  await database.pool.query("DELETE FROM metadata WHERE id=$1", [leasedRepairImage]);
  await removeDriverObject(managedLocalAccess.driver, "full", leasedRepairKey);
  await removeDriverObject(managedLocalAccess.driver, "thumbs", leasedRepairThumb);

  const failedRepairImage = randomUUID();
  const failedRepairKey = imagePaths.storageObjectKey(failedRepairImage, "png");
  const failedRepairThumb = imagePaths.thumbnailObjectKey(failedRepairKey);
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
      + "theme, ext, md5, thumbnail_size) VALUES "
      + "($1, 'bootstrap-admin', 'local', $2, 'pc', 'dark', 'none', 'png', $3, 456)",
    [
      failedRepairImage,
      failedRepairKey,
      createHash("md5").update(maintenanceSource).digest("hex")
    ]
  );
  await managedLocalAccess.driver.writeBuffer(
    "full",
    failedRepairKey,
    maintenanceSource,
    "image/png"
  );
  const originalMaintenanceQuery = database.pool.query.bind(database.pool);
  const originalFailedRepairRemoveObjects = managedLocalAccess.driver.removeObjects.bind(
    managedLocalAccess.driver
  );
  let rejectThumbnailSizeUpdate = true;
  let rejectFailedRepairCleanup = true;
  database.pool.query = (text, values) => {
    if (
      rejectThumbnailSizeUpdate
      && typeof text === "string"
      && text.includes("SET thumbnail_size=$2")
      && values?.[0] === failedRepairImage
      && Number(values?.[1]) > 0
    ) {
      rejectThumbnailSizeUpdate = false;
      return Promise.reject(new Error("injected thumbnail size update failure"));
    }
    return originalMaintenanceQuery(text, values);
  };
  managedLocalAccess.driver.removeObjects = async (objects, options) => {
    if (
      rejectFailedRepairCleanup
      && objects.some((object) => (
        object.prefix === "thumbs" && object.key === failedRepairThumb
      ))
    ) {
      rejectFailedRepairCleanup = false;
      throw new Error("injected failed repair cleanup uncertainty");
    }
    return originalFailedRepairRemoveObjects(objects, options);
  };
  let failedRepairResult;
  try {
    failedRepairResult = await storageMaintenance.maintainStorage();
  } finally {
    database.pool.query = originalMaintenanceQuery;
    managedLocalAccess.driver.removeObjects = originalFailedRepairRemoveObjects;
  }
  assert.ok(failedRepairResult.items.some((item) => (
    item.image_id === failedRepairImage && item.outcome === "failed"
  )), JSON.stringify(failedRepairResult));
  assert.equal(
    await managedLocalAccess.driver.exists("thumbs", failedRepairThumb),
    true,
    "删除结果无法确认时保留的候选必须仍由数据库标记进入下一次维护"
  );
  assert.equal(
    Number((await database.pool.query(
      "SELECT thumbnail_size FROM metadata WHERE id=$1",
      [failedRepairImage]
    )).rows[0]?.thumbnail_size),
    0
  );
  const failedRepairPreview = await storageCheck.checkStorage();
  assert.ok(failedRepairPreview.pending_thumbnail_repairs.some((entry) => (
    entry.id === failedRepairImage
    && entry.thumb_key === failedRepairThumb
  )), JSON.stringify(failedRepairPreview));
  const retriedRepair = await storageMaintenance.maintainStorage();
  assert.ok(retriedRepair.items.some((item) => (
    item.image_id === failedRepairImage && item.outcome === "repaired"
  )), JSON.stringify(retriedRepair));

  const abortKeys = Array.from({ length: 4 }, (_, position) => (
    ingestionStagingKeys.ingestionStagingImageKey({
      session_id: ingestionSessionIdentity.createIngestionSessionId(
        maintenanceIngestionOwner,
        "import",
        coreUuid.randomUuidV7()
      ),
      image_id: imageTime.createImageId(
        new Date(1787462400000 + position),
        position
      ),
      generation: coreUuid.randomUuidV7At(
        new Date(Date.now() - 25 * 60 * 60 * 1000 - position)
      ),
      execution_token: coreUuid.randomUuidV7()
    })
  )).sort();
  for (const key of abortKeys) {
    await managedLocalAccess.driver.writeBuffer(
      "_uploads",
      key,
      Buffer.from("abort-maintenance"),
      "image/webp"
    );
  }
  const originalMaintenanceRemoveObjects = managedLocalAccess.driver.removeObjects.bind(
    managedLocalAccess.driver
  );
  const startedAbortKeys = [];
  let startedAbortOperationSignal: AbortSignal | undefined;
  let abortBatchCalls = 0;
  const expectedAbortCalls = 1;
  let releaseAbortSlice;
  let markAbortSliceStarted;
  const abortSliceGate = new Promise((resolve) => {
    releaseAbortSlice = resolve;
  });
  const abortSliceStarted = new Promise((resolve) => {
    markAbortSliceStarted = resolve;
  });
  managedLocalAccess.driver.removeObjects = async (objects, options) => {
    const matching = objects.filter((object) => (
      object.prefix === "_uploads" && abortKeys.includes(object.key)
    ));
    if (matching.length) {
      abortBatchCalls += 1;
      startedAbortOperationSignal = options?.signal;
      startedAbortKeys.push(...matching.map((object) => object.key));
      const results = await originalMaintenanceRemoveObjects(objects, options);
      if (abortBatchCalls === expectedAbortCalls) markAbortSliceStarted();
      await abortSliceGate;
      return results;
    }
    return originalMaintenanceRemoveObjects(objects, options);
  };
  const maintenanceAbort = new AbortController();
  const maintenanceAbortReason = new Error("cancel storage maintenance");
  const abortedMaintenance = storageMaintenance.maintainStorage(
    maintenanceAbort.signal
  );
  await abortSliceStarted;
  maintenanceAbort.abort(maintenanceAbortReason);
  assert.notEqual(startedAbortOperationSignal, maintenanceAbort.signal);
  assert.equal(startedAbortOperationSignal?.aborted, false);
  releaseAbortSlice();
  try {
    await assert.rejects(
      abortedMaintenance,
      (error) => error === maintenanceAbortReason
    );
  } finally {
    managedLocalAccess.driver.removeObjects = originalMaintenanceRemoveObjects;
    releaseAbortSlice?.();
  }
  assert.equal(abortBatchCalls, expectedAbortCalls);
  assert.equal(startedAbortKeys.length, expectedAbortCalls);
  for (const key of startedAbortKeys) {
    assert.equal(
      await managedLocalAccess.driver.exists("_uploads", key),
      false,
      "维护 Promise 拒绝前必须等待已启动的并发片完成"
    );
  }
  for (const key of abortKeys.filter((key) => !startedAbortKeys.includes(key))) {
    assert.equal(
      await managedLocalAccess.driver.exists("_uploads", key),
      true,
      "请求中止后不得启动后续维护项"
    );
  }
  for (const key of abortKeys) {
    await removeDriverObject(managedLocalAccess.driver, "_uploads", key);
  }

  const mixedAbortImage = randomUUID();
  const mixedAbortObjectKey = imagePaths.storageObjectKey(mixedAbortImage, "png");
  const mixedAbortThumbKey = imagePaths.thumbnailObjectKey(mixedAbortObjectKey);
  const mixedAbortOrphanKey = "maintenance/mixed-abort-" + randomUUID() + ".webp";
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
      + "theme, ext, md5, image_size, thumbnail_size) VALUES "
      + "($1, 'bootstrap-admin', 'local', $2, 'pc', 'dark', 'none', 'png', $3, $4, 0)",
    [
      mixedAbortImage,
      mixedAbortObjectKey,
      createHash("md5").update(maintenanceSource).digest("hex"),
      maintenanceSource.byteLength
    ]
  );
  await managedLocalAccess.driver.writeBuffer(
    "full",
    mixedAbortObjectKey,
    maintenanceSource,
    "image/png"
  );
  await managedLocalAccess.driver.writeBuffer(
    "full",
    mixedAbortOrphanKey,
    Buffer.from("mixed-abort-orphan"),
    "image/webp"
  );
  const originalMixedReadBuffer = managedLocalAccess.driver.readBuffer.bind(
    managedLocalAccess.driver
  );
  const originalMixedRemoveObjects = managedLocalAccess.driver.removeObjects.bind(
    managedLocalAccess.driver
  );
  let releaseMixedRepair;
  let releaseMixedRemoval;
  let markMixedRepairStarted;
  let markMixedRemovalStarted;
  let markMixedRemovalFinished;
  const mixedRepairGate = new Promise((resolve) => {
    releaseMixedRepair = resolve;
  });
  const mixedRemovalGate = new Promise((resolve) => {
    releaseMixedRemoval = resolve;
  });
  const mixedRepairStarted = new Promise((resolve) => {
    markMixedRepairStarted = resolve;
  });
  const mixedRemovalStarted = new Promise((resolve) => {
    markMixedRemovalStarted = resolve;
  });
  const mixedRemovalFinished = new Promise((resolve) => {
    markMixedRemovalFinished = resolve;
  });
  managedLocalAccess.driver.readBuffer = async (prefix, key, options) => {
    const body = await originalMixedReadBuffer(prefix, key, options);
    if (prefix === "full" && key === mixedAbortObjectKey) {
      markMixedRepairStarted();
      await mixedRepairGate;
    }
    return body;
  };
  managedLocalAccess.driver.removeObjects = async (objects, options) => {
    const results = await originalMixedRemoveObjects(objects, options);
    if (objects.some((object) => (
      object.prefix === "full" && object.key === mixedAbortOrphanKey
    ))) {
      markMixedRemovalStarted();
      await mixedRemovalGate;
      markMixedRemovalFinished();
    }
    return results;
  };
  const mixedAbort = new AbortController();
  const mixedAbortReason = new Error("cancel mixed storage maintenance");
  let mixedMaintenanceSettled = false;
  const mixedMaintenanceOutcome = storageMaintenance.maintainStorage(
    mixedAbort.signal
  ).then(
    (value) => ({ status: "resolved", value }),
    (error) => ({ status: "rejected", error })
  ).finally(() => {
    mixedMaintenanceSettled = true;
  });
  await Promise.all([mixedRepairStarted, mixedRemovalStarted]);
  mixedAbort.abort(mixedAbortReason);
  let mixedReadLockSettled = false;
  const mixedReadLock = locks.withStorageLocationReadLock(
    async () => true
  ).finally(() => {
    mixedReadLockSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(mixedReadLockSettled, false);
  releaseMixedRemoval();
  await mixedRemovalFinished;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(
    mixedMaintenanceSettled,
    false,
    "混合维护取消后必须等待仍在执行的 repair pool 收口"
  );
  assert.equal(
    mixedReadLockSettled,
    false,
    "一个资源池先拒绝时不得提前释放 storage write lock"
  );
  releaseMixedRepair();
  try {
    const outcome = await mixedMaintenanceOutcome;
    assert.equal(outcome.status, "rejected", JSON.stringify(outcome));
    assert.equal(outcome.error, mixedAbortReason);
    assert.equal(await mixedReadLock, true);
  } finally {
    managedLocalAccess.driver.readBuffer = originalMixedReadBuffer;
    managedLocalAccess.driver.removeObjects = originalMixedRemoveObjects;
    releaseMixedRepair?.();
    releaseMixedRemoval?.();
    await mixedMaintenanceOutcome.catch(() => undefined);
    await mixedReadLock.catch(() => undefined);
  }
  assert.equal(
    await managedLocalAccess.driver.exists("full", mixedAbortOrphanKey),
    false,
    "先完成的 remove pool 结果必须在维护拒绝前落定"
  );
  assert.equal(
    await managedLocalAccess.driver.exists("thumbs", mixedAbortThumbKey),
    true,
    "后完成的 repair pool 也必须在维护拒绝前收口"
  );
  await database.pool.query("DELETE FROM metadata WHERE id=$1", [mixedAbortImage]);
  await removeDriverObject(managedLocalAccess.driver, "full", mixedAbortObjectKey);
  await removeDriverObject(managedLocalAccess.driver, "thumbs", mixedAbortThumbKey);
  await removeDriverObject(managedLocalAccess.driver, "full", mixedAbortOrphanKey);

  const paginationIds = [randomUUID(), randomUUID(), randomUUID()];
  const paginationNewest = "2026-08-15T00:00:00.000Z";
  const paginationOlder = "2026-08-14T00:00:00.000Z";
  await database.pool.query(
    "INSERT INTO tag(slug, display_name) VALUES "
      + "('pagination-old', 'Pagination old'), "
      + "('pagination-new', 'Pagination new') "
      + "ON CONFLICT (slug) DO NOTHING"
  );
  await database.pool.query(
    "INSERT INTO author(slug, display_name) VALUES "
      + "('alice', 'Alice'), ('bob', 'Bob') "
      + "ON CONFLICT (slug) DO NOTHING"
  );
  for (const [position, id] of paginationIds.entries()) {
    await database.pool.query(
      "INSERT INTO metadata (id, created_by, status, storage_slug, object_key, device, "
        + "brightness, theme, ext, md5, author, image_time, deleted_at, title) "
        + "VALUES ($1, 'bootstrap-admin', 'deleted', 'local', $2, 'pc', 'dark', 'none', "
        + "'webp', $3, $4, $5, now(), $6)",
      [
        id,
        imagePaths.storageObjectKey(id, "webp"),
        String(position + 4).repeat(32),
        position === 2 ? "bob" : "alice",
        position === 2 ? paginationOlder : paginationNewest,
        "pagination-" + String(position)
      ]
    );
  }
  await database.pool.query(
    "INSERT INTO image_tag(image_id, tag_slug) VALUES ($1, 'pagination-old')",
    [paginationIds[0]]
  );
  const initialPaginationOrder = [
    ...paginationIds.slice(0, 2).sort().reverse(),
    paginationIds[2]
  ];
  const firstDeletedPage = await adminImagesReadModel.listAdminImages({
    status: "deleted",
    page: 1,
    limit: 2
  });
  assert.equal(firstDeletedPage.total, 3);
  assert.deepEqual(
    firstDeletedPage.items.map((item) => item.id),
    initialPaginationOrder.slice(0, 2)
  );
  assert.equal("next_cursor" in firstDeletedPage, false);

  const originalPoolConnect = database.pool.connect.bind(database.pool);
  let pageWindowSelects = 0;
  database.pool.connect = async (...args) => {
    const client = await originalPoolConnect(...args);
    const clientQuery = client.query.bind(client);
    client.query = async (...queryArgs) => {
      const text = String(queryArgs[0]);
      if (/ORDER BY image_time DESC, id DESC[\\s\\S]*OFFSET/.test(text)) {
        pageWindowSelects += 1;
      }
      return clientQuery(...queryArgs);
    };
    return client;
  };
  try {
    const outside = await adminImagesReadModel.listAdminImages({
      status: "deleted",
      page: 10_000,
      limit: 2
    });
    assert.deepEqual(outside, { items: [], total: 3 });
    assert.equal(pageWindowSelects, 0);
  } finally {
    database.pool.connect = originalPoolConnect;
  }

  let countObserved;
  const countReached = new Promise((resolve) => {
    countObserved = resolve;
  });
  let releaseSnapshot;
  const snapshotGate = new Promise((resolve) => {
    releaseSnapshot = resolve;
  });
  let snapshotConnectionWrapped = false;
  database.pool.connect = async (...args) => {
    const client = await originalPoolConnect(...args);
    if (snapshotConnectionWrapped) return client;
    snapshotConnectionWrapped = true;
    const clientQuery = client.query.bind(client);
    let gated = false;
    client.query = async (...queryArgs) => {
      const result = await clientQuery(...queryArgs);
      if (
        !gated
        && /^SELECT count\\(\\*\\)::text AS count FROM metadata WHERE/.test(
          String(queryArgs[0]).trim()
        )
      ) {
        gated = true;
        countObserved();
        await snapshotGate;
      }
      return result;
    };
    return client;
  };
  const snapshotRead = adminImagesReadModel.listAdminImages({
    status: "deleted",
    page: 1,
    limit: 10
  });
  await countReached;
  const concurrentPaginationId = randomUUID();
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, status, storage_slug, object_key, device, "
      + "brightness, theme, ext, md5, author, image_time, deleted_at, title) "
      + "VALUES ($1, 'bootstrap-admin', 'deleted', 'local', $2, 'pc', 'dark', 'none', "
      + "'webp', $3, 'alice', '2026-08-16T00:00:00.000Z', now(), "
      + "'pagination-concurrent')",
    [
      concurrentPaginationId,
      imagePaths.storageObjectKey(concurrentPaginationId, "webp"),
      "8".repeat(32)
    ]
  );
  await database.pool.query(
    "DELETE FROM metadata WHERE id=$1",
    [paginationIds[2]]
  );
  await database.pool.query(
    "DELETE FROM image_tag WHERE image_id=$1",
    [paginationIds[0]]
  );
  await database.pool.query(
    "INSERT INTO image_tag(image_id, tag_slug) VALUES ($1, 'pagination-new')",
    [paginationIds[0]]
  );
  releaseSnapshot();
  let snapshotPage;
  try {
    snapshotPage = await snapshotRead;
  } finally {
    database.pool.connect = originalPoolConnect;
    releaseSnapshot?.();
  }
  assert.equal(snapshotPage.total, 3);
  assert.deepEqual(
    snapshotPage.items.map((item) => item.id),
    initialPaginationOrder
  );
  assert.deepEqual(
    snapshotPage.items.find((item) => item.id === paginationIds[0])?.tags,
    ["pagination-old"]
  );
  const currentDeletedPage = await adminImagesReadModel.listAdminImages({
    status: "deleted",
    page: 1,
    limit: 10
  });
  assert.equal(currentDeletedPage.total, 3);
  assert.equal(
    currentDeletedPage.items.some((item) => item.id === concurrentPaginationId),
    true
  );
  assert.equal(
    currentDeletedPage.items.some((item) => item.id === paginationIds[2]),
    false
  );
  assert.deepEqual(
    currentDeletedPage.items.find(
      (item) => item.id === paginationIds[0]
    )?.tags,
    ["pagination-new"]
  );
  await database.pool.query(
    "DELETE FROM metadata WHERE id = ANY($1::uuid[])",
    [[...paginationIds, concurrentPaginationId]]
  );
  await database.pool.query(
    "DELETE FROM tag WHERE slug IN ('pagination-old', 'pagination-new')"
  );
  await database.pool.query(
    "DELETE FROM author WHERE slug IN ('alice', 'bob')"
  );

  const matrixTheme = "pagination-matrix";
  const matrixTag = "pagination-matrix";
  const matrixExtraTag = "pagination-extra";
  const matrixAuthor = "pagination-matrix";
  const matrixIds = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID()
  ];
  const matrixTime = "2026-08-17T00:00:00.000Z";
  await database.pool.query(
    "INSERT INTO theme(slug, display_name) VALUES ($1, 'Pagination matrix')",
    [matrixTheme]
  );
  await database.pool.query(
    "INSERT INTO tag(slug, display_name) VALUES "
      + "($1, 'Pagination matrix'), ($2, 'Pagination extra')",
    [matrixTag, matrixExtraTag]
  );
  await database.pool.query(
    "INSERT INTO author(slug, display_name) VALUES ($1, 'Pagination matrix')",
    [matrixAuthor]
  );
  const matrixAxes = [
    ["pc", "dark"],
    ["pc", "dark"],
    ["mb", "light"],
    ["pc", "light"],
    ["mb", "dark"],
    ["mb", "dark"]
  ];
  for (const [position, id] of matrixIds.entries()) {
    const [device, brightness] = matrixAxes[position];
    await database.pool.query(
      "INSERT INTO metadata (id, created_by, status, storage_slug, object_key, device, "
        + "brightness, theme, ext, md5, author, image_time, title) "
        + "VALUES ($1, 'bootstrap-admin', 'ready', 'local', $2, $3, $4, $5, 'webp', $6, $7, $8, $9)",
      [
        id,
        imagePaths.storageObjectKey(id, "webp"),
        device,
        brightness,
        matrixTheme,
        createHash("md5").update(id).digest("hex"),
        matrixAuthor,
        matrixTime,
        "pagination-matrix-" + String(position)
      ]
    );
    await database.pool.query(
      "INSERT INTO image_tag(image_id, tag_slug) VALUES ($1, $2)",
      [id, matrixTag]
    );
  }
  await database.pool.query(
    "INSERT INTO image_tag(image_id, tag_slug) VALUES ($1, $2)",
    [matrixIds[0], matrixExtraTag]
  );
  await vocabCache.refreshEntityVocabularies(["theme", "tag", "author"]);
  await runtimeAvailability.requireOperationalRedis();
  await readyCacheCoordinator.requestReadyImageCacheRebuild();
  assert.equal(
    readyCacheCoordinator.getReadyImageCacheCoordinatorStatus().readable,
    true
  );

  const readyPageMatrix = [
    {
      name: "all",
      query: { status: "ready", page: 1, limit: 3 }
    },
    {
      name: "unset",
      query: { status: "ready", theme: "none", page: 1, limit: 3 }
    },
    {
      name: "device",
      query: { status: "ready", device: "mb", page: 1, limit: 3 }
    },
    {
      name: "brightness",
      query: { status: "ready", brightness: "light", page: 1, limit: 3 }
    },
    {
      name: "theme-first",
      query: { status: "ready", theme: matrixTheme, page: 1, limit: 3 }
    },
    {
      name: "theme-exact-last",
      query: { status: "ready", theme: matrixTheme, page: 2, limit: 3 }
    },
    {
      name: "tag",
      query: { status: "ready", tag: matrixTag, page: 1, limit: 6 }
    },
    {
      name: "author",
      query: { status: "ready", author: matrixAuthor, page: 1, limit: 6 }
    },
    {
      name: "combined",
      query: {
        status: "ready",
        device: "pc",
        brightness: "dark",
        theme: matrixTheme,
        tag: matrixTag,
        author: matrixAuthor,
        page: 1,
        limit: 2
      }
    },
    {
      name: "zero",
      query: {
        status: "ready",
        tag: "pagination-missing",
        page: 1,
        limit: 2
      }
    }
  ];
  for (const entry of readyPageMatrix) {
    const plan = await imageFilterPlan.resolveImageFilterPlan(
      entry.query,
      { redisMode: "required" }
    );
    assert.ok(
      await readyCacheFilterIndex.resolveReadyImageFilterIndex(plan),
      "matrix index must be warm: " + entry.name
    );
  }

  const redisMatrixPages = new Map();
  const publicCursorPages = [];
  let redisMatrixConnections = 0;
  database.pool.connect = async (...args) => {
    redisMatrixConnections += 1;
    return originalPoolConnect(...args);
  };
  try {
    for (const entry of readyPageMatrix) {
      const connectionsBefore = redisMatrixConnections;
      redisMatrixPages.set(
        entry.name,
        await adminImagesReadModel.listAdminImages(entry.query)
      );
      assert.equal(
        redisMatrixConnections,
        connectionsBefore,
        "matrix entry must stay on Redis: " + entry.name
      );
    }
    for (const order of ["latest", "oldest"]) {
      const orderedIds = [...matrixIds].sort();
      if (order === "latest") orderedIds.reverse();
      let cursor;
      for (const pageIndex of [0, 1]) {
        const query = {
          status: "ready", theme: matrixTheme, limit: 3, order, cursor
        };
        const page = await publicImagesReadModel.listPublicImages(
          query, new AbortController().signal
        );
        assert.deepEqual(
          page.items.map((item) => item.id),
          orderedIds.slice(pageIndex * 3, (pageIndex + 1) * 3),
          "public cursor must preserve time/ID order without repeating its anchor: " + order
        );
        assert.equal(
          redisMatrixConnections, 0,
          "both public cursor directions must stay on warm Redis: " + order
        );
        if (pageIndex === 0) assert.ok(page.next_cursor);
        else assert.equal(page.next_cursor, null, "exact final page must terminate the cursor");
        publicCursorPages.push({ query, page });
        cursor = page.next_cursor;
      }
    }
  } finally {
    database.pool.connect = originalPoolConnect;
  }
  assert.equal(redisMatrixConnections, 0);
  const matrixOrder = [...matrixIds].sort().reverse();
  const firstThemePage = redisMatrixPages.get("theme-first");
  const lastThemePage = redisMatrixPages.get("theme-exact-last");
  assert.equal(firstThemePage.total, 6);
  assert.equal(lastThemePage.total, 6);
  assert.deepEqual(
    firstThemePage.items.map((item) => item.id),
    matrixOrder.slice(0, 3)
  );
  assert.deepEqual(
    lastThemePage.items.map((item) => item.id),
    matrixOrder.slice(3)
  );
  assert.equal(lastThemePage.items.length, 3, "末页恰好填满时不得少读");
  assert.deepEqual(redisMatrixPages.get("zero"), { items: [], total: 0 });
  assert.deepEqual(
    redisMatrixPages.get("combined").items.map((item) => item.id),
    matrixOrder.filter((id) => matrixIds.slice(0, 2).includes(id))
  );
  assert.deepEqual(
    redisMatrixPages.get("tag").items.find(
      (item) => item.id === matrixIds[0]
    )?.tags,
    [matrixExtraTag, matrixTag]
  );
  for (const page of redisMatrixPages.values()) {
    assert.equal("next_cursor" in page, false);
  }

  const rebuildingRedisSendCommand = redisClient.redis.sendCommand;
  let rebuildCommandObserved;
  const rebuildCommandStarted = new Promise((resolve) => {
    rebuildCommandObserved = resolve;
  });
  let releaseRebuildCommand;
  const rebuildCommandGate = new Promise((resolve) => {
    releaseRebuildCommand = resolve;
  });
  let rebuildCommandHeld = false;
  redisClient.redis.sendCommand = async function (command, ...args) {
    if (command.name !== "ping" && !rebuildCommandHeld) {
      rebuildCommandHeld = true;
      rebuildCommandObserved();
      await rebuildCommandGate;
    }
    return rebuildingRedisSendCommand.call(this, command, ...args);
  };
  const controlledRebuild =
    readyCacheCoordinator.requestReadyImageCacheRebuild();
  await rebuildCommandStarted;
  assert.equal(
    readyCacheCoordinator.getReadyImageCacheCoordinatorStatus().rebuilding,
    true
  );
  let rebuildingFallbackConnections = 0;
  database.pool.connect = async (...args) => {
    rebuildingFallbackConnections += 1;
    return originalPoolConnect(...args);
  };
  try {
    for (const entry of readyPageMatrix) {
      const rebuildingFallback = await adminImagesReadModel.listAdminImages(
        entry.query
      );
      assert.deepEqual(
        rebuildingFallback,
        redisMatrixPages.get(entry.name),
        "Redis 与 PostgreSQL 页结果必须一致: " + entry.name
      );
    }
    for (const { query, page } of publicCursorPages) {
      assert.deepEqual(
        await publicImagesReadModel.listPublicImages(
          query, new AbortController().signal
        ),
        page,
        "public Redis/PostgreSQL cursor pages must agree: " + query.order
      );
    }
    assert.equal(
      rebuildingFallbackConnections,
      readyPageMatrix.length + publicCursorPages.length
    );
  } finally {
    database.pool.connect = originalPoolConnect;
    releaseRebuildCommand();
    await controlledRebuild;
    redisClient.redis.sendCommand = rebuildingRedisSendCommand;
  }

  const paginationRedisSendCommand = redisClient.redis.sendCommand;
  const interruptedRedis = new Error("controlled ready page zcard failure");
  let pageZcardCommands = 0;
  let interruptedPageConnections = 0;
  database.pool.connect = async (...args) => {
    interruptedPageConnections += 1;
    return originalPoolConnect(...args);
  };
  redisClient.redis.sendCommand = async function (command, ...args) {
    if (command.name === "zcard" && ++pageZcardCommands === 2) {
      throw interruptedRedis;
    }
    return paginationRedisSendCommand.call(this, command, ...args);
  };
  try {
    await assert.rejects(
      adminImagesReadModel.listAdminImages({
        status: "ready",
        page: 1,
        limit: 1
      }),
      (error) => error?.name === "redis_unavailable"
    );
    assert.equal(interruptedPageConnections, 0);
  } finally {
    redisClient.redis.sendCommand = paginationRedisSendCommand;
    database.pool.connect = originalPoolConnect;
  }
  assert.deepEqual(await ingestionOrphanCleanup.cleanupIngestionOrphans(), {
    skipped: true,
    raw_removed: 0,
    staging_removed: 0,
    staging_failed: 0,
    incomplete_namespaces: 0,
    incomplete_raw_scans: 0
  });
  await runtimeAvailability.requireOperationalRedis();
  await readyCacheCoordinator.requestReadyImageCacheRebuild();

  const vocabularyRedisSendCommand = redisClient.redis.sendCommand;
  const interruptedVocabulary = new Error("controlled vocabulary GET failure");
  let vocabularyCommandInterrupted = false;
  let interruptedVocabularyConnections = 0;
  database.pool.connect = async (...args) => {
    interruptedVocabularyConnections += 1;
    return originalPoolConnect(...args);
  };
  redisClient.redis.sendCommand = async function (command, ...args) {
    if (command.name === "get" && !vocabularyCommandInterrupted) {
      vocabularyCommandInterrupted = true;
      throw interruptedVocabulary;
    }
    return vocabularyRedisSendCommand.call(this, command, ...args);
  };
  try {
    await assert.rejects(
      adminImagesReadModel.listAdminImages({
        status: "ready",
        theme: "none",
        page: 1,
        limit: 1
      }),
      (error) => error?.name === "redis_unavailable"
    );
    assert.equal(interruptedVocabularyConnections, 0);
  } finally {
    redisClient.redis.sendCommand = vocabularyRedisSendCommand;
    database.pool.connect = originalPoolConnect;
  }
  await runtimeAvailability.requireOperationalRedis();
  await readyCacheCoordinator.requestReadyImageCacheRebuild();

  await database.pool.query(
    "DELETE FROM metadata WHERE id = ANY($1::uuid[])",
    [matrixIds]
  );
  await database.pool.query(
    "DELETE FROM tag WHERE slug = ANY($1::text[])",
    [[matrixTag, matrixExtraTag]]
  );
  await database.pool.query("DELETE FROM theme WHERE slug=$1", [matrixTheme]);
  await database.pool.query("DELETE FROM author WHERE slug=$1", [matrixAuthor]);

  await database.pool.query("DELETE FROM metadata WHERE id=$1", [failedRepairImage]);
  await database.pool.query("DELETE FROM metadata WHERE id=$1", [maintenanceImage]);
  await removeDriverObject(managedLocalAccess.driver, "_uploads", activeUpload);
  await removeDriverObject(managedLocalAccess.driver, "_uploads", retainedUpload);
  await removeDriverObject(managedLocalAccess.driver, "_uploads", orphanUpload);
  await removeDriverObject(managedLocalAccess.driver, "full", maintenanceObjectKey);
  await removeDriverObject(managedLocalAccess.driver, "thumbs", maintenanceThumbKey);
  await removeDriverObject(managedLocalAccess.driver, "full", failedRepairKey);
  await removeDriverObject(managedLocalAccess.driver, "thumbs", failedRepairThumb);

} finally {
  redisClient.redis.disconnect();
  await registry.closeStorageBackendRegistry().catch(() => undefined);
  await database.closeDatabasePools();
}
`);
  await writeHelperFile(coldRedisHelper, `
import assert from "node:assert/strict";

const [
  mode,
  host,
  port,
  name,
  user,
  password,
  dataDirectory,
  redisHost,
  redisPort
] = process.argv.slice(2);
Object.assign(process.env, {
  DATABASE_HOST: host,
  DATABASE_PORT: port,
  DATABASE_NAME: name,
  DATABASE_USER: user,
  DATABASE_PASSWORD: password,
  IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY: dataDirectory,
  REDIS_HOST: redisHost,
  REDIS_PORT: redisPort,
  REDIS_DB: "0"
});

const databasePools = await import(${JSON.stringify(databasePoolsModule)});
databasePools.configureDatabasePools({
  host,
  port: Number(port),
  name,
  user,
  password
});
const databaseSchema = await import(${JSON.stringify(databaseSchemaModule)});
const redisClient = await import(${JSON.stringify(redisClientModule)});
const ingestionSessionRepository = await import(
  ${JSON.stringify(ingestionSessionRepositoryModule)}
);
const ingestionSessionIdentity = await import(
  ${JSON.stringify(ingestionSessionIdentityModule)}
);
const ingestionSessionProjection = await import(
  ${JSON.stringify(ingestionSessionProjectionModule)}
);
const imageTime = await import(${JSON.stringify(imageTimeModule)});
const imagePaths = await import(${JSON.stringify(imagePathsModule)});

const owner = "current-cold-start-owner";
const beforeTime = imageTime.parseImageTime("2026-08-23T06:00:00.000Z");
const beforeSessionId = ingestionSessionIdentity.createIngestionSessionId(
  owner,
  "import",
  "before-flush"
);
const beforeImageId = "019f8457-063a-7021-a580-7a432dc7fd8e";
const persistedImageId = "019f8457-063a-7020-a580-7a432dc7fd8e";
const repository = new ingestionSessionRepository.IngestionSessionRepository(
  redisClient.redis,
  (work) => work()
);

try {
  await databaseSchema.initializeDatabaseSchema();
  await redisClient.pingRedis();
  if (mode === "seed") {
    await databasePools.pool.query(
      "INSERT INTO metadata (id, created_by, storage_slug, object_key, "
        + "device, brightness, theme, ext, md5, image_time, title) VALUES "
        + "($1,$2,'local',$3,'pc','dark','none','webp',$4,$5,$6)",
      [
        persistedImageId,
        owner,
        imagePaths.storageObjectKey(persistedImageId, "webp"),
        "8".repeat(32),
        "2026-08-23T05:59:59.000Z",
        "cold start persisted truth"
      ]
    );
    const withoutHash = {
      owner,
      queue: "import",
      source_type: "url",
      session_id: beforeSessionId,
      image_id: beforeImageId,
      image_time: beforeTime.iso,
      request_hash: "7".repeat(64),
      import_download: { url: "https://example.com/before-flush.webp" },
      metadata: {
        device: "auto",
        brightness: "auto",
        theme: "none",
        author: "",
        title: "discardable runtime",
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
      version: 0,
      progress_seq: 0,
      last_semantic_revision: 0,
      accepted_at: 0,
      accepted_order: 0,
      execution_token: "",
      raw_generation: "",
      raw_size: 0,
      discard_at: 0
    };
    await repository.acceptImportSession({
      ...withoutHash,
      semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
        withoutHash
      )
    }, ingestionSessionIdentity.createIngestionDisplayOrderKey(
      "019f8457-063a-7000-8000-000000000001",
      21,
      beforeSessionId
    ), Date.now());
    await redisClient.redis.set("imageshow:test:cold-start-marker", "present");
    assert.equal((await databasePools.pool.query(
      "SELECT count(*)::int AS count FROM metadata WHERE id=$1",
      [persistedImageId]
    )).rows[0]?.count, 1);
  } else if (mode === "verify") {
    assert.equal(await redisClient.redis.dbsize(), 0);
    assert.equal(
      await repository.readSession(owner, beforeSessionId),
      null,
      "停机清空后的旧 Redis canonical 必须无条件消失"
    );
    const persisted = (await databasePools.pool.query(
      "SELECT created_by, title FROM metadata WHERE id=$1",
      [persistedImageId]
    )).rows;
    assert.deepEqual(persisted, [{
      created_by: owner,
      title: "cold start persisted truth"
    }]);
    const afterTime = imageTime.parseImageTime("2026-08-23T06:00:01.000Z");
    const afterSessionId = ingestionSessionIdentity.createIngestionSessionId(
      owner,
      "import",
      "after-flush"
    );
    const afterWithoutHash = {
      owner,
      queue: "import",
      source_type: "url",
      session_id: afterSessionId,
      image_id: imageTime.createImageId(afterTime.date, 22),
      image_time: afterTime.iso,
      request_hash: "9".repeat(64),
      import_download: { url: "https://example.com/after-flush.webp" },
      metadata: {
        device: "auto",
        brightness: "auto",
        theme: "none",
        author: "",
        title: "new runtime after cold start",
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
      version: 0,
      progress_seq: 0,
      last_semantic_revision: 0,
      accepted_at: 0,
      accepted_order: 0,
      execution_token: "",
      raw_generation: "",
      raw_size: 0,
      discard_at: 0
    };
    const accepted = await repository.acceptImportSession({
      ...afterWithoutHash,
      semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
        afterWithoutHash
      )
    }, ingestionSessionIdentity.createIngestionDisplayOrderKey(
      "019f8457-063b-7000-8000-000000000002",
      22,
      afterSessionId
    ), Date.now());
    assert.equal(accepted.session.session_id, afterSessionId);
    assert.ok(await redisClient.redis.dbsize() > 0);
  } else {
    throw new Error("unknown cold Redis helper mode");
  }
} finally {
  redisClient.redis.disconnect();
  await databasePools.closeDatabasePools();
}
`);

  let port = 0;
  let redisPort = 0;
  const databaseName = (label: string) => (
    `imageshow_${label}_${randomUUID().replaceAll("-", "").slice(0, 12)}`
  );
  const clientFor = (name: string) => new Client({
    connectionTimeoutMillis: 5_000,
    host: "127.0.0.1",
    lock_timeout: 5_000,
    port,
    query_timeout: 15_000,
    database: name,
    statement_timeout: 15_000,
    user: "postgres",
    password
  });
  const withClient = async <T>(
    name: string,
    work: (client: Client) => Promise<T>
  ) => {
    const client = clientFor(name);
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  };
  const createDatabase = async (name: string) => {
    assert.match(name, /^[a-z0-9_]+$/);
    await withClient("postgres", async (client) => {
      await client.query(`CREATE DATABASE "${name}"`);
    });
  };
  const runTsx = (
    script: string,
    args: string[],
    allowFailure = false
  ) => runProcess(process.execPath, [
    resolve(workspace, "node_modules/tsx/dist/cli.mjs"),
    script,
    ...args
  ], {
      cwd: workspace,
      allowFailure
  });
  const initializeAs = async (
    name: string,
    user: string,
    userPassword: string,
    allowFailure = false
  ) => runTsx(
    helper,
    [
      "127.0.0.1",
      String(port),
      name,
      user,
      userPassword
    ],
    allowFailure
  );
  const initialize = async (name: string, allowFailure = false) => (
    initializeAs(name, "postgres", password, allowFailure)
  );
  const schemaDump = async (name: string) => {
    const dump = await runProcess("docker", [
      "exec",
      "-e",
      `PGPASSWORD=${password}`,
      container,
      "pg_dump",
      "-U",
      "postgres",
      "--schema-only",
      "--no-owner",
      "--no-privileges",
      name
    ]);
    return dump.stdout
      .replaceAll("\r\n", "\n")
      .split("\n")
      .filter((line) => !/^\\(?:un)?restrict\b/.test(line))
      .join("\n");
  };
  const dataDump = async (name: string) => {
    const dump = await runProcess("docker", [
      "exec",
      "-e",
      `PGPASSWORD=${password}`,
      container,
      "pg_dump",
      "-U",
      "postgres",
      "--data-only",
      "--column-inserts",
      "--no-owner",
      "--no-privileges",
      name
    ]);
    return dump.stdout
      .replaceAll("\r\n", "\n")
      .split("\n")
      .filter((line) => !/^\\(?:un)?restrict\b/.test(line))
      .join("\n");
  };
  const relationCount = (client: Client) => client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname NOT IN ('information_schema')
        AND left(namespace.nspname, 3) <> 'pg_'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`
  ).then((result) => Number(result.rows[0]?.count ?? -1));
  const quoteIdentifier = (value: string) => (
    `"${value.replaceAll('"', '""')}"`
  );
  const constraintName = async (
    client: Client,
    table: string,
    type: "p" | "u" | "f" | "c",
    columns: string[]
  ) => {
    const result = await client.query<{ constraint_name: string }>(
      `SELECT constraint_record.conname AS constraint_name
         FROM pg_constraint constraint_record
         JOIN pg_class relation ON relation.oid=constraint_record.conrelid
         JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
        WHERE namespace.nspname='public'
          AND relation.relname=$1
          AND constraint_record.contype=$2
          AND ARRAY(
                SELECT attribute.attname
                  FROM unnest(constraint_record.conkey)
                    WITH ORDINALITY AS key(attnum, ordinal)
                  JOIN pg_attribute attribute
                    ON attribute.attrelid=constraint_record.conrelid
                   AND attribute.attnum=key.attnum
                 ORDER BY key.ordinal
              )::text[]=$3::text[]`,
      [table, type, columns]
    );
    assert.equal(result.rowCount, 1, `${table}(${columns.join(",")}) 约束不唯一`);
    return result.rows[0]!.constraint_name;
  };
  const uniqueIndexName = async (
    client: Client,
    table: string,
    columns: string[]
  ) => {
    const result = await client.query<{
      index_name: string;
      predicate: string | null;
    }>(
      `SELECT index_relation.relname AS index_name,
              pg_get_expr(
                index_record.indpred,
                index_record.indrelid,
                true
              ) AS predicate
         FROM pg_index index_record
         JOIN pg_class relation ON relation.oid=index_record.indrelid
         JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
         JOIN pg_class index_relation ON index_relation.oid=index_record.indexrelid
        WHERE namespace.nspname='public'
          AND relation.relname=$1
          AND index_record.indisunique
          AND NOT index_record.indisprimary
          AND ARRAY(
                SELECT attribute.attname
                  FROM unnest(index_record.indkey::smallint[])
                    WITH ORDINALITY AS key(attnum, ordinal)
                  JOIN pg_attribute attribute
                    ON attribute.attrelid=index_record.indrelid
                   AND attribute.attnum=key.attnum
                 WHERE key.ordinal <= index_record.indnkeyatts
                 ORDER BY key.ordinal
              )::text[]=$2::text[]`,
      [table, columns]
    );
    assert.equal(result.rowCount, 1, `${table}(${columns.join(",")}) 唯一索引不唯一`);
    return result.rows[0]!;
  };
  const publishedPort = async (name: string, containerPort: number) => {
    const result = await runProcess("docker", [
      "port", name, `${containerPort}/tcp`
    ]);
    const match = /^127\.0\.0\.1:(\d+)$/.exec(result.stdout.trim());
    assert.ok(match, "隔离容器必须发布到本机动态端口");
    return Number(match[1]);
  };
  let cleanTableNames: string[] = [];

  try {
    containerAttempted = true;
    await runProcess("docker", [
      "run",
      "-d",
      "--name",
      container,
      "--tmpfs",
      "/var/lib/postgresql:rw",
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-p",
      "127.0.0.1::5432",
      "postgres:18"
    ], { timeoutMs: 120_000 });
    redisContainerAttempted = true;
    await runProcess("docker", [
      "run",
      "-d",
      "--name",
      redisContainer,
      "--tmpfs",
      "/data:rw",
      "-p",
      "127.0.0.1::6379",
      "redis:8",
      "--save",
      ""
    ], { timeoutMs: 120_000 });

    port = await publishedPort(container, 5432);
    redisPort = await publishedPort(redisContainer, 6379);

    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        await withClient("postgres", async (client) => {
          await client.query("SELECT 1");
        });
        ready = true;
        break;
      } catch {
        await delay(250);
      }
    }
    assert.equal(ready, true, "隔离 PostgreSQL 未按时就绪");
    let redisReady = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const ping = await runProcess(
        "docker",
        ["exec", redisContainer, "redis-cli", "ping"],
        { allowFailure: true, timeoutMs: 5_000 }
      );
      if (ping.code === 0 && ping.stdout.trim() === "PONG") {
        redisReady = true;
        break;
      }
      await delay(250);
    }
    assert.equal(redisReady, true, "隔离 Redis 未按时就绪");

    const clean = databaseName("clean");
    await createDatabase(clean);
    await initialize(clean);
    await initialize(clean);
    await initialize(clean);
    await withClient(clean, async (client) => {
      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema='public' AND table_type='BASE TABLE'
          ORDER BY table_name`
      );
      cleanTableNames = tables.rows.map((row) => row.table_name);
      assert.ok(cleanTableNames.length > 0);
      const backgroundChecks = await client.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(constraint_record.oid, true) AS definition
           FROM pg_constraint constraint_record
           JOIN pg_class relation ON relation.oid=constraint_record.conrelid
           JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          WHERE namespace.nspname='public'
            AND relation.relname='background_job'
            AND constraint_record.conname='background_job_current_type_check'`
      );
      assert.deepEqual(backgroundChecks.rows, [{
        definition: "CHECK (type = ANY (ARRAY['move.cleanup'::text, "
          + "'trash.purge'::text, 'cache.rebuild'::text]))"
      }]);
      const authorColumns = await client.query<{
        column_name: string;
        data_type: string;
      }>(
        `SELECT column_name, data_type
           FROM information_schema.columns
          WHERE table_schema='public'
            AND table_name='author'
            AND column_name IN ('identity_provider', 'identity_id')
          ORDER BY column_name`
      );
      assert.deepEqual(authorColumns.rows, [
        { column_name: "identity_id", data_type: "text" },
        { column_name: "identity_provider", data_type: "text" }
      ]);
      const purgeColumns = await client.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_schema='public'
            AND table_name='metadata'
            AND column_name='purge_job_id'`
      );
      assert.deepEqual(purgeColumns.rows, [{
        column_name: "purge_job_id",
        data_type: "uuid",
        is_nullable: "YES"
      }]);
      const purgeChecks = await client.query<{
        definition: string;
        validated: boolean;
      }>(
        `SELECT pg_get_constraintdef(constraint_record.oid, true) AS definition,
                constraint_record.convalidated AS validated
           FROM pg_constraint constraint_record
           JOIN pg_class relation ON relation.oid=constraint_record.conrelid
           JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          WHERE namespace.nspname='public'
            AND relation.relname='metadata'
            AND constraint_record.conname='metadata_purge_job_deleted_check'`
      );
      assert.equal(purgeChecks.rows.length, 1);
      assert.equal(purgeChecks.rows[0]?.validated, true);
      assert.match(
        purgeChecks.rows[0]?.definition ?? "",
        /purge_job_id IS NULL OR status = 'deleted'/i
      );
      const authorChecks = await client.query<{ constraint_name: string }>(
        `SELECT constraint_record.conname AS constraint_name
           FROM pg_constraint constraint_record
           JOIN pg_class relation ON relation.oid=constraint_record.conrelid
           JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          WHERE namespace.nspname='public'
             AND relation.relname='author'
             AND constraint_record.contype='c'
             AND constraint_record.convalidated
             AND constraint_record.conname LIKE 'author_identity_%'
           ORDER BY constraint_record.conname`
      );
      assert.deepEqual(authorChecks.rows.map((row) => row.constraint_name), [
        "author_identity_id_nonempty_check",
        "author_identity_pair_check",
        "author_identity_provider_token_check"
      ]);
      const authorIdentityIndex = await uniqueIndexName(
        client,
        "author",
        ["identity_provider", "identity_id"]
      );
      assert.match(
        authorIdentityIndex.predicate ?? "",
        /identity_provider IS NOT NULL.*identity_id IS NOT NULL/i
      );

      await client.query(
        `INSERT INTO author(slug, identity_provider, identity_id)
         VALUES('identity-test-future', 'future-provider', '1234567890'),
               ('identity-test-weibo', 'weibo', '1234567890')`
      );
      for (const [slug, provider, identity, expected] of [
        ["identity-test-half", "weibo", null, "author_identity_pair_check"],
        ["identity-test-token", "Bad-Provider", "55", "author_identity_provider_token_check"],
        ["identity-test-empty", "weibo", "", "author_identity_id_nonempty_check"],
        ["identity-test-duplicate", "weibo", "1234567890", "idx_author_identity"]
      ] as const) {
        await assert.rejects(
          client.query(
            `INSERT INTO author(slug, identity_provider, identity_id)
             VALUES($1, $2, $3)`,
            [slug, provider, identity]
          ),
          (error: unknown) => (
            (error as { constraint?: string }).constraint === expected
          )
        );
      }
      await client.query("DELETE FROM author WHERE slug LIKE 'identity-test-%'");
    });
    await runTsx(faultHelper, [
      "127.0.0.1",
      String(port),
      clean,
      "postgres",
      password,
      // Native image I/O uses long paths; keep script entry paths in ordinary form for Node.
      toNamespacedPath(join(helperRoot, "runtime")),
      "127.0.0.1",
      String(redisPort)
    ]);

    const coldRedisDatabase = databaseName("coldredis");
    await createDatabase(coldRedisDatabase);
    const coldRedisArgs = [
      "127.0.0.1",
      String(port),
      coldRedisDatabase,
      "postgres",
      password,
      toNamespacedPath(join(helperRoot, "cold-redis-runtime")),
      "127.0.0.1",
      String(redisPort)
    ];
    await runTsx(coldRedisHelper, ["seed", ...coldRedisArgs]);
    const coldRedisPostgresBefore = await dataDump(coldRedisDatabase);
    const redisSizeBeforeFlush = await runProcess("docker", [
      "exec",
      redisContainer,
      "redis-cli",
      "-n",
      "0",
      "DBSIZE"
    ]);
    assert.ok(Number(redisSizeBeforeFlush.stdout.trim()) > 0);
    const flushed = await runProcess("docker", [
      "exec",
      redisContainer,
      "redis-cli",
      "-n",
      "0",
      "FLUSHDB"
    ]);
    assert.equal(flushed.stdout.trim(), "OK");
    const redisSizeAfterFlush = await runProcess("docker", [
      "exec",
      redisContainer,
      "redis-cli",
      "-n",
      "0",
      "DBSIZE"
    ]);
    assert.equal(redisSizeAfterFlush.stdout.trim(), "0");
    await runTsx(coldRedisHelper, ["verify", ...coldRedisArgs]);
    assert.equal(
      await dataDump(coldRedisDatabase),
      coldRedisPostgresBefore,
      "隔离 Redis FLUSHDB 冷启动不得改写 PostgreSQL 正式图片"
    );

    const createCurrentDatabase = async (name) => {
      await createDatabase(name);
      await initialize(name);
    };

    const normalized = databaseName("normalized");
    await createCurrentDatabase(normalized);
    await withClient(normalized, async (client) => {
      await client.query(`
        INSERT INTO tag(slug, display_name)
        VALUES('current', 'Current data');
        INSERT INTO author(
          slug,
          display_name,
          link,
          identity_provider,
          identity_id
        ) VALUES(
          'current-author',
          'Current author',
          'https://weibo.com/u/1234567890',
          'weibo',
          '1234567890'
        );
      `);
    });
    const normalizedBefore = await Promise.all([
      schemaDump(normalized),
      dataDump(normalized)
    ]);
    await initialize(normalized);
    assert.deepEqual(
      await Promise.all([schemaDump(normalized), dataDump(normalized)]),
      normalizedBefore,
      "已归一化非空库 readiness 不得写入结构或数据"
    );

    const missingPurgeOwner = databaseName("missingpurgeowner");
    await createCurrentDatabase(missingPurgeOwner);
    await withClient(missingPurgeOwner, async (client) => {
      await client.query(`
        ALTER TABLE metadata DROP COLUMN purge_job_id;
        INSERT INTO tag(slug, display_name)
        VALUES('missing-purge-owner-data', 'Must remain unchanged');
      `);
    });
    const missingPurgeOwnerBefore = await Promise.all([
      schemaDump(missingPurgeOwner),
      dataDump(missingPurgeOwner)
    ]);
    const missingPurgeOwnerResult = await initialize(missingPurgeOwner, true);
    assert.notEqual(missingPurgeOwnerResult.code, 0);
    assert.match(
      processResultText(missingPurgeOwnerResult),
      /required columns.*metadata\.purge_job_id/i
    );
    assert.deepEqual(
      await Promise.all([
        schemaDump(missingPurgeOwner),
        dataDump(missingPurgeOwner)
      ]),
      missingPurgeOwnerBefore,
      "缺少当前 purge 归属列时不得自动迁移或改写现有数据"
    );

    const missingAuthorIdentity = databaseName("missingauthoridentity");
    await createCurrentDatabase(missingAuthorIdentity);
    await withClient(missingAuthorIdentity, async (client) => {
      await client.query(`
        ALTER TABLE author
          DROP COLUMN identity_provider,
          DROP COLUMN identity_id;
        INSERT INTO tag(slug, display_name)
        VALUES('readiness-data', 'Must remain unchanged');
      `);
    });
    const missingAuthorIdentityBefore = await Promise.all([
      schemaDump(missingAuthorIdentity),
      dataDump(missingAuthorIdentity)
    ]);
    const missingAuthorIdentityResult = await initialize(
      missingAuthorIdentity,
      true
    );
    assert.notEqual(missingAuthorIdentityResult.code, 0);
    assert.match(
      processResultText(missingAuthorIdentityResult),
      /required columns.*author\.identity_provider.*author\.identity_id/i
    );
    assert.deepEqual(
      await Promise.all([
        schemaDump(missingAuthorIdentity),
        dataDump(missingAuthorIdentity)
      ]),
      missingAuthorIdentityBefore,
      "readiness 失败不得猜测补列或改写现有数据"
    );

    const unsupportedStorage = databaseName("storagetype");
    await createCurrentDatabase(unsupportedStorage);
    await withClient(unsupportedStorage, async (client) => {
      await client.query(`
        ALTER TABLE storage_backend
          DROP CONSTRAINT storage_backend_type_check;
        ALTER TABLE storage_backend
          ADD CONSTRAINT storage_backend_type_check
          CHECK (type IN ('local', 's3', 'unsupported'));
        INSERT INTO storage_backend(slug, display_name, type)
         VALUES('unsupported', 'Unsupported backend', 'unsupported');
      `);
    });
    const unsupportedSchemaBefore = await schemaDump(unsupportedStorage);
    const unsupportedDataBefore = await dataDump(unsupportedStorage);
    const unsupportedStorageResult = await initialize(unsupportedStorage, true);
    assert.notEqual(unsupportedStorageResult.code, 0);
    assert.match(
      processResultText(unsupportedStorageResult),
      /unsupported storage backend types: unsupported/i
    );
    assert.equal(await schemaDump(unsupportedStorage), unsupportedSchemaBefore);
    assert.equal(await dataDump(unsupportedStorage), unsupportedDataBefore);

    const unsupportedAuthorProvider = databaseName("authorprovider");
    await createCurrentDatabase(unsupportedAuthorProvider);
    await withClient(unsupportedAuthorProvider, async (client) => {
      await client.query(
        `INSERT INTO author(slug, identity_provider, identity_id)
         VALUES('future-author', 'future-provider', '1234567890')`
      );
    });
    const unsupportedAuthorBefore = await Promise.all([
      schemaDump(unsupportedAuthorProvider),
      dataDump(unsupportedAuthorProvider)
    ]);
    const unsupportedAuthorResult = await initialize(
      unsupportedAuthorProvider,
      true
    );
    assert.notEqual(unsupportedAuthorResult.code, 0);
    assert.match(
      processResultText(unsupportedAuthorResult),
      /unsupported author identity providers are present/i
    );
    assert.deepEqual(
      await Promise.all([
        schemaDump(unsupportedAuthorProvider),
        dataDump(unsupportedAuthorProvider)
      ]),
      unsupportedAuthorBefore
    );

    const incompatibleAuthorCheck = databaseName("authorcheck");
    await createCurrentDatabase(incompatibleAuthorCheck);
    await withClient(incompatibleAuthorCheck, async (client) => {
      await client.query(`
        ALTER TABLE author
          DROP CONSTRAINT author_identity_provider_token_check;
        ALTER TABLE author
          ADD CONSTRAINT author_identity_provider_token_check
          CHECK (identity_provider IS NULL OR char_length(identity_provider) <= 32);
        ALTER TABLE author
          DROP CONSTRAINT author_identity_pair_check;
        ALTER TABLE author
          ADD CONSTRAINT author_identity_pair_check
          CHECK (
            identity_provider IS NULL
            OR identity_id IS NULL
            OR identity_provider IS NOT NULL
            OR identity_id IS NOT NULL
          );
      `);
    });
    const incompatibleAuthorCheckResult = await initialize(
      incompatibleAuthorCheck,
      true
    );
    assert.notEqual(incompatibleAuthorCheckResult.code, 0);
    assert.match(
      processResultText(incompatibleAuthorCheckResult),
      /required CHECK constraints.*author identity null pairing.*author identity provider token/i
    );

    const incompatibleAuthorIdentityIndex = databaseName("authorindex");
    await createCurrentDatabase(incompatibleAuthorIdentityIndex);
    await withClient(incompatibleAuthorIdentityIndex, async (client) => {
      await client.query(`
        DROP INDEX public.idx_author_identity;
        CREATE UNIQUE INDEX idx_author_identity
          ON author(identity_provider, identity_id)
          WHERE identity_provider IS NOT NULL;
      `);
    });
    const incompatibleAuthorIndexResult = await initialize(
      incompatibleAuthorIdentityIndex,
      true
    );
    assert.notEqual(incompatibleAuthorIndexResult.code, 0);
    assert.match(
      processResultText(incompatibleAuthorIndexResult),
      /required unique indexes.*author\(identity_provider,\s*identity_id\)/i
    );

    const compatibleSuperset = databaseName("superset");
    await createCurrentDatabase(compatibleSuperset);
    await withClient(compatibleSuperset, async (client) => {
      await client.query(`
        CREATE TABLE deployment_owned_marker(
          id integer PRIMARY KEY,
          note text NOT NULL
        );
        INSERT INTO deployment_owned_marker(id, note)
        VALUES(1, 'must remain untouched');
      `);
    });
    const supersetBefore = await Promise.all([
      schemaDump(compatibleSuperset),
      dataDump(compatibleSuperset)
    ]);
    await initialize(compatibleSuperset);
    assert.deepEqual(
      await Promise.all([
        schemaDump(compatibleSuperset),
        dataDump(compatibleSuperset)
      ]),
      supersetBefore,
      "部署方额外对象不得被 readiness 改写"
    );

    const missingPrimaryKey = databaseName("primarykey");
    await createCurrentDatabase(missingPrimaryKey);
    await withClient(missingPrimaryKey, async (client) => {
      const name = await constraintName(
        client,
        "background_job",
        "p",
        ["id"]
      );
      await client.query(
        `ALTER TABLE background_job DROP CONSTRAINT ${quoteIdentifier(name)}`
      );
    });
    const missingPrimaryKeyResult = await initialize(missingPrimaryKey, true);
    assert.notEqual(missingPrimaryKeyResult.code, 0);
    assert.match(
      processResultText(missingPrimaryKeyResult),
      /required primary keys.*background_job\(id\)/i
    );

    const incompatibleUniqueIndex = databaseName("uniqueindex");
    await createCurrentDatabase(incompatibleUniqueIndex);
    await withClient(incompatibleUniqueIndex, async (client) => {
      const activeCacheRebuild = await uniqueIndexName(
        client,
        "background_job",
        ["type"]
      );
      assert.match(activeCacheRebuild.predicate ?? "", /cache\.rebuild/i);
      await client.query(`
        DROP INDEX public.${quoteIdentifier(activeCacheRebuild.index_name)};
        CREATE UNIQUE INDEX incomplete_active_cache_rebuild
          ON background_job(type)
          WHERE type='cache.rebuild' AND status='pending';
      `);
    });
    const incompatibleUniqueResult = await initialize(
      incompatibleUniqueIndex,
      true
    );
    assert.notEqual(incompatibleUniqueResult.code, 0);
    assert.match(
      processResultText(incompatibleUniqueResult),
      /required unique indexes.*background_job\(type\).*cache\.rebuild/i
    );

    const incompatibleForeignKey = databaseName("foreignkey");
    await createCurrentDatabase(incompatibleForeignKey);
    await withClient(incompatibleForeignKey, async (client) => {
      const name = await constraintName(
        client,
        "metadata",
        "f",
        ["author"]
      );
      await client.query(`
        ALTER TABLE metadata DROP CONSTRAINT ${quoteIdentifier(name)};
        ALTER TABLE metadata
          ADD CONSTRAINT incompatible_author_delete
          FOREIGN KEY(author) REFERENCES author(slug) ON DELETE RESTRICT;
      `);
    });
    const incompatibleForeignResult = await initialize(
      incompatibleForeignKey,
      true
    );
    assert.notEqual(incompatibleForeignResult.code, 0);
    assert.match(
      processResultText(incompatibleForeignResult),
      /required foreign keys.*metadata\(author\).*SET NULL/i
    );

    const missingTable = databaseName("missingtable");
    await createCurrentDatabase(missingTable);
    await withClient(missingTable, async (client) => {
      await client.query("DROP TABLE author CASCADE");
    });
    const missingTableResult = await initialize(missingTable, true);
    assert.notEqual(missingTableResult.code, 0);
    assert.match(
      processResultText(missingTableResult),
      /(?:required public tables.*author|relation "author" does not exist)/i
    );

    const missingColumn = databaseName("missingcolumn");
    await createCurrentDatabase(missingColumn);
    await withClient(missingColumn, async (client) => {
      await client.query(
        "ALTER TABLE admin_account DROP COLUMN password_hash CASCADE"
      );
    });
    const missingColumnResult = await initialize(missingColumn, true);
    assert.notEqual(missingColumnResult.code, 0);
    assert.match(
      processResultText(missingColumnResult),
      /required columns.*admin_account\.password_hash/i
    );

    const incompatiblePurgeCheck = databaseName("purgecheck");
    await createCurrentDatabase(incompatiblePurgeCheck);
    await withClient(incompatiblePurgeCheck, async (client) => {
      await client.query(`
        ALTER TABLE metadata
          DROP CONSTRAINT metadata_purge_job_deleted_check;
        ALTER TABLE metadata
          ADD CONSTRAINT metadata_purge_job_deleted_check
          CHECK (purge_job_id IS NULL OR status IN ('ready', 'deleted'));
      `);
    });
    const incompatiblePurgeCheckResult = await initialize(
      incompatiblePurgeCheck,
      true
    );
    assert.notEqual(incompatiblePurgeCheckResult.code, 0);
    assert.match(
      processResultText(incompatiblePurgeCheckResult),
      /required CHECK constraints.*metadata purge job requires deleted status/i
    );

    const incompatibleType = databaseName("columntype");
    await createCurrentDatabase(incompatibleType);
    await withClient(incompatibleType, async (client) => {
      await client.query(
        "ALTER TABLE tag ALTER COLUMN sort_order TYPE BIGINT"
      );
    });
    const incompatibleTypeResult = await initialize(incompatibleType, true);
    assert.notEqual(incompatibleTypeResult.code, 0);
    assert.match(
      processResultText(incompatibleTypeResult),
      /required columns.*tag\.sort_order/i
    );

    const incompatibleTypeModifier = databaseName("typemod");
    await createCurrentDatabase(incompatibleTypeModifier);
    await withClient(incompatibleTypeModifier, async (client) => {
      await client.query(
        "ALTER TABLE metadata ALTER COLUMN image_time TYPE timestamptz(0)"
      );
    });
    const incompatibleModifierResult = await initialize(
      incompatibleTypeModifier,
      true
    );
    assert.notEqual(incompatibleModifierResult.code, 0);
    assert.match(
      processResultText(incompatibleModifierResult),
      /required columns.*metadata\.image_time/i
    );

    const readOnlyDatabase = databaseName("readonly");
    await createCurrentDatabase(readOnlyDatabase);
    await withClient("postgres", async (client) => {
      await client.query(
        `ALTER DATABASE "${readOnlyDatabase}"
           SET default_transaction_read_only=on`
      );
    });
    const readOnlyResult = await initialize(readOnlyDatabase, true);
    assert.notEqual(readOnlyResult.code, 0);
    assert.match(
      processResultText(readOnlyResult),
      /transaction_read_only=on|read-only transaction/i
    );

    const insufficientPrivileges = databaseName("privileges");
    const limitedRole = `imageshow_limited_${randomUUID().replaceAll("-", "")}`;
    const limitedPassword = `limited-${randomUUID()}`;
    await createCurrentDatabase(insufficientPrivileges);
    await withClient(insufficientPrivileges, async (client) => {
      await client.query(
        `CREATE ROLE "${limitedRole}" LOGIN PASSWORD '${limitedPassword}'`
      );
      await client.query(
        `GRANT CONNECT ON DATABASE "${insufficientPrivileges}" TO "${limitedRole}"`
      );
      await client.query(`GRANT USAGE ON SCHEMA public TO "${limitedRole}"`);
      await client.query(
        `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO "${limitedRole}"`
      );
    });
    const privilegeResult = await initializeAs(
      insufficientPrivileges,
      limitedRole,
      limitedPassword,
      true
    );
    assert.notEqual(privilegeResult.code, 0);
    assert.match(
      processResultText(privilegeResult),
      /lacks required table privileges/i
    );

    const invalidSeed = databaseName("seed");
    await createCurrentDatabase(invalidSeed);
    await withClient(invalidSeed, async (client) => {
      await client.query(`
        DELETE FROM ready_image_revision;
        DELETE FROM storage_backend WHERE slug='local';
      `);
    });
    const invalidSeedResult = await initialize(invalidSeed, true);
    assert.notEqual(invalidSeedResult.code, 0);
    const invalidSeedText = processResultText(invalidSeedResult);
    assert.match(invalidSeedText, /required seed rows/i);
    assert.match(invalidSeedText, /ready_image_revision singleton/i);
    assert.match(invalidSeedText, /storage_backend\.local/i);

    const rollback = databaseName("rollback");
    await createDatabase(rollback);
    await withClient(rollback, async (client) => {
      await client.query(`
        CREATE FUNCTION reject_schema_table() RETURNS event_trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'injected schema failure';
        END;
        $$;
        CREATE EVENT TRIGGER reject_schema_table
          ON ddl_command_end WHEN TAG IN ('CREATE TABLE')
          EXECUTE FUNCTION reject_schema_table()
      `);
    });
    const rollbackResult = await initialize(rollback, true);
    assert.notEqual(rollbackResult.code, 0);
    assert.match(processResultText(rollbackResult), /injected schema failure/i);
    await withClient(rollback, async (client) => {
      assert.equal(await relationCount(client), 0);
      await client.query(`
        DROP EVENT TRIGGER reject_schema_table;
        DROP FUNCTION reject_schema_table();
      `);
    });
    await initialize(rollback);
    await withClient(rollback, async (client) => {
      const recoveredTables = await client.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema='public' AND table_type='BASE TABLE'`
      );
      assert.deepEqual(
        recoveredTables.rows.map((row) => row.table_name).sort(),
        cleanTableNames,
        "失败启动回滚后必须能由下一次顺序启动恢复"
      );
    });
  } finally {
    try {
      await cleanupResources();
    } finally {
      restoreSignalListeners();
    }
  }
});

test("标准化取消等待当前编码与缩略图收口，停止降质及质量回补", async (t) => {
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
    sharp.prototype.toBuffer = (async function (options: any) {
      if (!options?.resolveWithObject) { await thumbnailGate; return Buffer.from("thumbnail"); }
      qualities.push((this as any).options.webpQuality);
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
    assert.deepEqual(qualities, [90, 60, 70].slice(0, cancelAt));
  }
});

test("安全抓取在预取消时不联网，原图代理头部及正文取消传到上游且不 fallback", async (t) => {
  const { safeFetchExternalImage } = await import("../../packages/server/src/core/external-image-fetch.ts");
  const { proxyExternalImage } = await import("../../packages/server/src/images/external-image-proxy.ts");
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

test("专属原图等待共享探测时单个 HTTP 取消不影响另一消费者", async () => {
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


test("静态出口默认空值并由当前配置归一化、严格校验和环境播种保留", () => {
  assert.equal(runtimeConfigDefaults().site.static_subdomain, "");
  for (const value of ["", "static", "media"]) {
    const config = runtimeConfigFromEnvironment({SITE_STATIC_SUBDOMAIN:value});
    assert.equal(config.site.static_subdomain,value);
    assert.equal(normalizeRuntimeConfig(config).site.static_subdomain,value);
    assert.equal(parseRuntimeConfig(config).site.static_subdomain,value);
    assert.equal(materializeImportedRuntimeConfig(config, "target.example.com").site.static_subdomain,value);
  }
  const missing = structuredClone(runtimeConfigDefaults());
  delete (missing.site as Partial<RuntimeConfig["site"]>).static_subdomain;
  assert.equal(normalizeRuntimeConfig(missing).site.static_subdomain, "");
  assert.equal(runtimeConfigFromEnvironment({}).site.static_subdomain, "");
  for (const value of ["-static", "static-", "static.example", "a".repeat(64), "UPPER"]) {
    assert.throws(() => runtimeConfigFromEnvironment({SITE_STATIC_SUBDOMAIN:value}));
  }
});

test("Local 驱动取消阻止发布，候选清理及并行自检互相隔离", async () => {
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
