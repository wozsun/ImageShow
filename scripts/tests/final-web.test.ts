import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { parseHTML } from "linkedom";
import { Container, Texture, type Rectangle, type Renderer } from "pixi.js";
import {
  adminPermissions,
  ingestionActionPath,
  ingestionActionScopeHeader,
  ingestionCancelPath,
  ingestionCommitPath,
  ingestionDuplicatesPath,
  ingestionSnapshotPath,
  ingestionStatusPath,
  ingestionUpdatePath,
  importAcceptPath,
  uploadCredentialHeader,
  uploadIntentPath,
  uploadRawPath,
  type AdminCheckStatusDto,
  type AdminImageListItemDto,
  type AdminOverviewDto,
  type GalleryImageCardDto,
  type ImageUpdateResponseDto,
  type IngestionQueueActionResultDto,
  type IngestionQueueSummaryDto,
  type IngestionVocabularyDto,
  type PublicImageListResponseDto,
  type RandomImageJsonItemDto,
  type StorageBackendMigrationResultDto
} from "../../packages/shared/src/browser.ts";
import {
  emptyGalleryFilters,
  galleryApiSearchParams,
  galleryFiltersFromSearchParams,
  galleryHref,
  galleryRandomRequestDevice,
  showModeFromSearchParams,
  showOrderFromSearchParams,
  showOrderedApiSearchParams,
  showRouteSearchParams
} from "../../packages/web/src/lib/gallery/gallery-query.ts";
import {
  galleryResidenceBufferScreens,
  galleryVirtualOverscanScreens,
  publicHomeBrowsePath,
  publicRootPath
} from "../../packages/web/src/lib/constants.ts";
import { buildRandomUrl } from "../../packages/web/src/lib/gallery/random-url.ts";
import {
  createGalleryTaxonomyDisplayFormatter
} from "../../packages/web/src/lib/gallery/card-display.ts";
import type {
  EditableImageSnapshot,
  GalleryImageCard,
  IngestionJob,
  PublicImageItem,
  StorageBackendAdmin
} from "../../packages/web/src/lib/types.ts";
import {
  ApiClientError,
  api,
  apiWithEtag,
  authExpiredEvent,
  clearCsrfToken,
  setCsrfToken
} from "../../packages/web/src/lib/api/client.ts";
import {
  invalidateDataAfterAuthorProfileSave,
  invalidateImageDataAfterIngestion,
  invalidateImageDataAfterMetadataSave
} from "../../packages/web/src/lib/api/query-invalidation.ts";
import { queryKeys } from "../../packages/web/src/lib/api/query-keys.ts";
import {
  recordAdminImageListValidation
} from "../../packages/web/src/lib/api/admin-image-list-validation.ts";
import {
  AuthSessionRefreshCoordinator
} from "../../packages/web/src/lib/api/auth-session.ts";
import {
  advanceAdminColorSchemeCycle,
  nextAdminColorScheme,
  resolveUiColorContext,
  type AdminColorSchemeCycle
} from "../../packages/web/src/lib/ui/color-scheme.ts";
import {
  parseAdminPaginationPage,
  releaseAdminPaginationSubmission,
  resolveAdminPaginationCommit,
  shouldCommitAdminPaginationInput
} from "../../packages/web/src/components/navigation/admin-pagination-model.ts";
import {
  adminNavigationForRole
} from "../../packages/web/src/pages/admin/shell/AdminNavigation.tsx";
import {
  adminRoutePreloadPolicies
} from "../../packages/web/src/pages/admin/shell/admin-route-modules.ts";
import {
  configPackageRecognitionNotice,
  configPackageSlugMappingError
} from "../../packages/web/src/pages/admin/advanced-config/ConfigPackageImportDialog.tsx";
import {
  createPageLifetimeModuleLoader
} from "../../packages/web/src/lib/page-lifetime-module-loader.ts";
import {
  createPublicRouteModuleLoader
} from "../../packages/web/src/lib/public-route-modules.ts";
import {
  preloadIntentProps,
  usePreloadIntentProps
} from "../../packages/web/src/lib/ui/preload-intent.ts";
import {
  applyPointerMagnet,
  resetPointerMagnet
} from "../../packages/web/src/lib/ui/pointer-magnet.ts";
import {
  webIngestionBatchKey,
  webUuidV7
} from "../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-identity.ts";
import {
  BrowserUploadBatchSequencer,
  BrowserUploadLane
} from "../../packages/web/src/pages/admin/ingestion/upload/browser-upload-lane.ts";
import {
  showCardGeometry,
  showCardRect,
  showRectsIntersect,
  showViewportWindow,
  type ShowResidencePolicy
} from "../../packages/web/src/pages/show/show-layout.ts";
import {
  ShowDataPool,
  shuffledShowImages
} from "../../packages/web/src/pages/show/show-data-pool.ts";
import {
  ShowWindowController
} from "../../packages/web/src/pages/show/show-window-controller.ts";
import {
  clampShowFloatSizeIndex,
  clampShowWaterfallColumns,
  defaultShowFloatSizeIndex,
  largerShowWaterfallImages,
  showFloatSizeSteps,
  showFloatDefaultWidth,
  showWaterfallDensity,
  smallerShowWaterfallImages
} from "../../packages/web/src/pages/show/pixi/show-pixi-layout.ts";
import {
  ShowPixiCamera
} from "../../packages/web/src/pages/show/pixi/show-pixi-camera.ts";
import { ShowPixiFloatScene } from "../../packages/web/src/pages/show/pixi/show-pixi-float-scene.ts";
import { ShowPixiWaterfallScene } from "../../packages/web/src/pages/show/pixi/show-pixi-waterfall-scene.ts";
import { ShowPixiRuntime } from "../../packages/web/src/pages/show/pixi/show-pixi-runtime.ts";
import type { ShowPixiTextureCache } from "../../packages/web/src/pages/show/pixi/show-pixi-texture-cache.ts";
import type { ShowPixiVisibleItem } from "../../packages/web/src/pages/show/pixi/show-pixi-types.ts";
import {
  publicNavigationAutoHideDelayMs,
  publicNavigationTopEdgeRevealHeight
} from "../../packages/web/src/lib/ui/public-navigation.ts";
import {
  reorderItemByDirection,
  reorderItemByKey,
  reorderPageForKey,
  reorderPositionByKey
} from "../../packages/web/src/lib/ui/reorder.ts";
import {
  ImageListSelectionController,
  isImageSelectionPreservingTarget
} from "../../packages/web/src/pages/admin/images/image-list-selection.ts";
import {
  imageAdminConfirmationCopy,
  settleConfirmedImageAdminMutation
} from "../../packages/web/src/pages/admin/images/useImageAdminOperations.ts";
import {
  useImageAdminPageNavigation
} from "../../packages/web/src/pages/admin/images/useImageAdminPageNavigation.ts";
import {
  adminImageListQuery,
  effectiveImageAdminPage,
  imageAdminPaginationScopeKey,
  imageAdminTotalPages,
  resetImageAdminPage,
  resolveImageAdminScopeTotal
} from "../../packages/web/src/pages/admin/images/image-admin-list-query.ts";
import {
  emptyImageAdminFilters,
  imageAdminDoubleRowMaxWidth,
  imageAdminFilterDomGroups,
  isImageAdminDoubleRowWidth
} from "../../packages/web/src/pages/admin/images/ImageAdminFilters.tsx";
import {
  imageMetadataCardSaveState,
  changedMetadataUpdate,
  createImageMetadataSaveReport,
  createImageMetadataSession,
  fieldsChangedFor,
  reconcileImageMetadataSession,
  type ImageMetadataSaveAttempt
} from "../../packages/web/src/components/image/editor/image-metadata-session.ts";
import {
  imageTrashIdsNeedingSnapshot,
  pruneImageMetadataSessionAfterTrash,
  reconcileImageEditorTrash
} from "../../packages/web/src/components/image/editor/image-editor-trash.ts";
import {
  storageBackendAfterDeleteRejection,
  storageBackendDeletionReasons,
  storageBackendWithHiddenStagingBlocker
} from "../../packages/web/src/pages/admin/storage/storage-backend-deletion-policy.ts";
import {
  storageBackendEditConfigPatch,
  storageBackendS3AfterSuccessfulSave,
  storageBackendS3FormSettings
} from "../../packages/web/src/pages/admin/storage/storage-backend-form.ts";
import {
  storageMaintenancePreview
} from "../../packages/web/src/pages/admin/storage/storage-maintenance-preview.ts";
import {
  canApplyIngestionAttributeDefaults,
  ingestionAttributeDefaultsPatch,
  ingestionJobAttributesEditable
} from "../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-attribute-policy.ts";
import {
  browserDisplayPrefixJobs,
  combinedIngestionQueuePagePlan,
  createIngestionCommitIntent,
  ingestionJobCanBeCancelled,
  ingestionJobCanBeRemovedLocally,
  ingestionJobCanLeaveQueue,
  ingestionJobCanStartCommit,
  ingestionQueuePageCount,
  reduceIngestionQueue,
  summarizeIngestionJobs
} from "../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-queue-state.ts";
import {
  ingestionStatusEventPatch
} from "../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-status-state.ts";
import {
  commitSelectedIngestions
} from "../../packages/web/src/pages/admin/ingestion/queue/ingestion-commit-batch.ts";
import {
  cancelServerIngestionJob,
  cancelServerIngestionJobs
} from "../../packages/web/src/pages/admin/ingestion/queue/ingestion-cancel.ts";
import {
  acceptImports,
  createUploadIntents,
  getIngestionQueueSnapshot,
  getIngestionStatuses,
  uploadRaw
} from "../../packages/web/src/pages/admin/ingestion/queue/ingestion-api.ts";
import {
  ingestionJobStatusDetail,
  ingestionJobStatusLabel
} from "../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-status-detail.ts";
import {
  baselineFromIngestionSnapshot,
  ingestionQueueBaselineCoversSelection,
  mergeIngestionQueueMutation
} from "../../packages/web/src/pages/admin/ingestion/queue/model/server-ingestion-queue-state.ts";
import {
  emptyServerIngestionQueueView,
  parseServerIngestionQueueEvent
} from "../../packages/web/src/pages/admin/ingestion/queue/model/server-ingestion-queue-view.ts";
import {
  draftSyncTarget,
  matchesDraftTarget
} from "../../packages/web/src/pages/admin/ingestion/queue/model/stored-ingestion-draft-model.ts";
import {
  completedIngestionOwnerPatch,
  completedIngestionReceiptOwnerPatch,
  ingestionJobFromServerItem,
  ingestionJobFromKnownCompletedStatus,
  ingestionJobAwaitsActionCoverage,
  ingestionJobHasServerAuthority,
  ingestionHandoffRetryDecision,
  serverIngestionJobsForCombinedPage
} from "../../packages/web/src/pages/admin/ingestion/queue/model/server-ingestion-job.ts";
import {
  isUnconfirmedUploadRawAttempt,
  resetImportJobForPrepareRetry,
  resetJobForPrepareRetry
} from "../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-job-retry.ts";
import {
  createUrlImportJobs
} from "../../packages/web/src/pages/admin/ingestion/queue/model/import-job-source.ts";
import { createManifestImportJobs } from "../../packages/web/src/pages/admin/ingestion/import/manifest-jobs.ts";
import {
  buildUploadIntentItemInput
} from "../../packages/web/src/pages/admin/ingestion/upload/upload-jobs.ts";
import {
  cleanupActionType,
  preserveUnresolvedLocalOutcomes,
  retainUnresolvedLocalJobs
} from "../../packages/web/src/pages/admin/ingestion/workflow/ingestion-workflow-action-model.ts";
import {
  boundedHomeRevealIndexes,
  homeRevealItemLimits,
  homeThemesWithUnsetLast
} from "../../packages/web/src/pages/home/home-ui.ts";
import { galleryColumnCount } from "../../packages/web/src/lib/gallery/gallery-columns.ts";
import {
  advancePublicImageNavigation,
  initialPublicImageNavigationState
} from "../../packages/web/src/lib/ui/public-image-navigation-visibility.ts";
import {
  CompactMasonryLayout
} from "../../packages/web/src/pages/gallery/compact-masonry-layout.ts";
import {
  GalleryDataWindow,
  type GalleryPageIntent
} from "../../packages/web/src/pages/gallery/gallery-data-window.ts";
import {
  createGalleryRenderViewport,
  galleryRenderViewportHysteresisScreens,
  shouldRefreshGalleryRenderViewport
} from "../../packages/web/src/pages/gallery/gallery-render-viewport.ts";
import {
  GalleryCardRevealRegistry
} from "../../packages/web/src/pages/gallery/gallery-card-reveal.ts";
import {
  imageDisplayTitle
} from "../../packages/web/src/lib/ui/formatters.ts";
import {
  GalleryDebugStats
} from "../../packages/web/src/pages/gallery/gallery-debug-stats.ts";
import {
  ImageLoadScheduler
} from "../../packages/web/src/components/image/image-load-scheduler.ts";
import {
  createDialogTouchBoundary
} from "../../packages/web/src/lib/ui/dialog-touch-boundary.ts";
import {
  canDialogHorizontalScrollOwnerConsumeTouchMove,
  canDialogScrollOwnerConsumeTouchMove,
  consumeDialogHorizontalTouchMove,
  findDialogHorizontalTouchScrollOwner,
  findDialogTouchScrollOwner
} from "../../packages/web/src/lib/ui/dialog-scroll-boundary.ts";
import {
  tagScrollAvailability,
  tagScrollContentMetrics,
  tagScrollItemMetrics,
  tagScrollNavigationTarget,
  tagVerticalWheelPixels,
  tagWheelScrollTarget
} from "../../packages/web/src/components/form/tag-input-scroll.ts";
import { TagInput } from "../../packages/web/src/components/form/TagInput.tsx";

function galleryCardDto(
  id: string,
  width = 100,
  height = 100
): GalleryImageCardDto {
  return {
    id,
    title: id,
    device: "pc",
    brightness: "dark",
    theme: "none",
    author: "",
    thumb_url: "/thumbs/" + id + ".webp",
    width,
    height,
    tags: [],
    diff_original: false,
    image_time: "2026-09-01T00:00:00.000Z"
  };
}

function galleryCard(id: string, width = 100, height = 100): GalleryImageCard {
  return galleryCardDto(id, width, height);
}

function syntheticGalleryPage({
  count,
  start,
  total
}: {
  count: number;
  start: number;
  total: number;
}): PublicImageListResponseDto {
  const end = Math.min(total, start + count);
  return {
    items: Array.from({ length: end - start }, (_, offset) => {
      const index = start + offset;
      const serial = String(index).padStart(12, "0");
      return galleryCard(
        `00000000-0000-7000-8000-${serial}`,
        index % 3 === 0 ? 900 : 1600,
        index % 3 === 0 ? 1600 : 900
      );
    }),
    next_cursor: end < total ? `cursor-${end}` : null
  };
}

function resolveGalleryIntent(
  window: GalleryDataWindow,
  intent: GalleryPageIntent,
  payload: PublicImageListResponseDto
) {
  const request = window.claimRequest(intent);
  assert.ok(request);
  assert.equal(window.resolvePage(request, payload), true);
}

function ingestionJob(patch: Partial<IngestionJob> = {}): IngestionJob {
  return {
    id: "job-1",
    attemptKey: "attempt-1",
    batchKey: "batch-1",
    kind: "import",
    status: "queued",
    message: "等待下载",
    preview: "",
    draft: {
      title: "",
      description: "",
      source: "",
      original: "https://example.com/image.jpg",
      device: "pc",
      brightness: "dark",
      theme: "existing-theme",
      author: "existing-author",
      tags: ["existing-tag"]
    },
    width: 0,
    height: 0,
    md5: "f".repeat(32),
    duplicates: [],
    duplicateDecision: "upload",
    storageSlug: "local",
    ...patch
  };
}

function adminImageListItem(
  patch: Partial<AdminImageListItemDto> = {}
): AdminImageListItemDto {
  const timestamp = "2026-08-13T00:00:00.000Z";
  return {
    id: "00000000-0000-7000-8000-000000000001",
    title: "fixture",
    description: "",
    source: "",
    original: "fixture.jpg",
    object_url: "/full/01/00000000-0000-7000-8000-000000000001.jpg",
    thumb_url: "/thumbs/01/00000000-0000-7000-8000-000000000001.webp",
    device: "pc",
    brightness: "dark",
    theme: "none",
    author: "",
    tags: [],
    width: 1600,
    height: 900,
    diff_original: false,
    image_time: timestamp,
    status: "ready",
    object_key: "01/00000000-0000-7000-8000-000000000001.jpg",
    storage_slug: "local",
    md5: "00000000000000000000000000000000",
    image_size: 1,
    deleted_at: null,
    created_at: timestamp,
    updated_at: timestamp,
    ...patch
  };
}

function editableImage(
  id: string,
  overrides: Partial<EditableImageSnapshot> = {}
): EditableImageSnapshot {
  return {
    id,
    title: id + "-title",
    description: id + "-description",
    source: "https://example.com/" + id,
    original: "https://example.com/" + id + ".jpg",
    device: "pc",
    brightness: "dark",
    theme: "theme",
    author: "author",
    tags: ["tag"],
    thumb_url: "/thumb/" + id,
    object_url: "/image/" + id,
    width: 1920,
    height: 1080,
    image_size: 1024,
    object_key: id + ".webp",
    storage_slug: "local",
    ...overrides
  };
}

function imageUpdateResponse(
  updatedIds: string[],
  failedIds: string[] = []
): ImageUpdateResponseDto {
  return {
    updated: updatedIds.length,
    failed: failedIds.length,
    results: [
      ...updatedIds.map((id) => ({ id, status: "updated" as const })),
      ...failedIds.map((id) => ({
        id,
        status: "failed" as const,
        code: "update_failed",
        message: "failed"
      }))
    ]
  };
}

test("内容接入模块保持 view、草稿、上传与清理纯边界", () => {
  assert.deepEqual(emptyServerIngestionQueueView("connecting", 3), {
    status: "connecting",
    connectionGeneration: 3,
    actionScope: "",
    revision: null,
    lastAcceptedOrder: null,
    summary: null,
    items: [],
    staleItems: [],
    actionWatermark: "",
    error: ""
  });
  assert.deepEqual(parseServerIngestionQueueEvent(JSON.stringify({
    type: "ready",
    queue: "upload",
    revision: 4,
    action_scope: "scope-four"
  }), "ready", "upload"), {
    type: "ready",
    queue: "upload",
    revision: 4,
    action_scope: "scope-four"
  });
  assert.throws(
    () => parseServerIngestionQueueEvent(
      JSON.stringify({ type: "ready", queue: "import" }),
      "ready",
      "upload"
    ),
    /内容接入队列事件格式无效/u
  );

  const imageId = "019f8457-063a-7001-a580-7a432dc7fd8e";
  const authoritative = ingestionJob({
    serverAccepted: true,
    sessionId: "session-one",
    imageId,
    serverVersion: 6,
    status: "ready"
  });
  const target = draftSyncTarget(authoritative);
  assert.ok(target);
  assert.equal(target.expectedVersion, 6);
  assert.equal(matchesDraftTarget({
    ...authoritative,
    imageId: imageId.toUpperCase()
  }, target), true);
  assert.equal(draftSyncTarget({
    ...authoritative,
    serverAccepted: false
  }), null);

  const localFile = new File(["raw"], "fixture.png", { type: "image/png" });
  const local = ingestionJob({
    kind: "upload",
    file: localFile,
    attemptKey: "attempt-local",
    batchPosition: 2,
    storageSlug: "local"
  });
  assert.deepEqual(buildUploadIntentItemInput(local, 4096), {
    ...local.draft,
    idempotency_key: "attempt-local",
    batch_key: local.batchKey,
    storage_slug: "local",
    batch_time: local.batchTime,
    batch_position: 2,
    expected_size: localFile.size,
    max_long_edge: 4096
  });

  const importedUrl = "https://example.com/image.jpg";
  const importDefaults = {
    device: "auto" as const,
    brightness: "auto" as const,
    theme: "",
    author: "",
    tags: []
  };
  assert.equal(
    createUrlImportJobs([importedUrl], importDefaults, false, "local")[0]?.draft.original,
    ""
  );
  assert.equal(
    createUrlImportJobs([importedUrl], importDefaults, true, "local")[0]?.draft.original,
    importedUrl
  );
  const manifestItem = {
    line: 1,
    batch_position: 0,
    original: importedUrl
  };
  const hiddenManifestLink = createManifestImportJobs(
    [manifestItem],
    importDefaults,
    "local",
    "jsonl",
    false
  )[0];
  const retainedManifestLink = createManifestImportJobs(
    [manifestItem],
    importDefaults,
    "local",
    "jsonl",
    true
  )[0];
  assert.equal(hiddenManifestLink?.downloadUrl, importedUrl);
  assert.equal(hiddenManifestLink?.draft.original, "");
  assert.equal(retainedManifestLink?.draft.original, importedUrl);

  const nextAttempt = ingestionJob({ id: "job-2", attemptKey: "attempt-2" });
  assert.deepEqual(retainUnresolvedLocalJobs([local, nextAttempt], {
    unresolved: [{ id: nextAttempt.id, attemptKey: nextAttempt.attemptKey }]
  }), [nextAttempt]);
  assert.deepEqual(preserveUnresolvedLocalOutcomes({
    unresolved: [{ id: nextAttempt.id, attemptKey: nextAttempt.attemptKey }]
  }, {
    unresolved: [{
      id: nextAttempt.id,
      attemptKey: nextAttempt.attemptKey,
      outcome: { succeeded: false }
    }]
  }).unresolved[0]?.outcome, { succeeded: false });
  assert.equal(cleanupActionType("duplicates"), "clear_duplicate_pending");
  assert.equal(cleanupActionType("uncommitted"), "clear_uncommitted");
  assert.equal(cleanupActionType("completed"), "clear_completed");
});

test("Web UUID 只使用安全随机源并设置 UUIDv7 时间、版本与 variant", () => {
  const timestamp = Date.UTC(2026, 7, 23, 1, 2, 3, 456);
  const uuid = webUuidV7(timestamp);
  assert.match(
    uuid,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
  );
  const compact = uuid.replaceAll("-", "");
  assert.equal(Number.parseInt(compact.slice(0, 12), 16), timestamp);
  assert.notEqual(webUuidV7(timestamp), uuid);
  assert.throws(() => webUuidV7(-1));
});

test("存储维护预览区分可修复、不可修复、可删除与受保护项", () => {
  assert.deepEqual(storageMaintenancePreview({
    missing_objects: [{ id: "missing-source", backend: "local", namespace: "local" }],
    missing_thumbs: [
      { id: "missing-source", backend: "local", namespace: "local" },
      { id: "repairable", backend: "local", namespace: "local" },
      { id: "blocked", backend: "archive", namespace: "archive" },
      { id: "broken-alias", backend: "broken-alias", namespace: "shared" }
    ],
    pending_thumbnail_repairs: [
      { id: "pending", backend: "local", namespace: "local" }
    ],
    orphan_objects: [
      { key: "orphan-full", backend: "local", namespace: "local" },
      { key: "shared-orphan", backend: "working-alias", namespace: "shared" }
    ],
    orphan_thumbs: [
      { key: "orphan-thumb", backend: "archive", namespace: "archive" }
    ],
    active_staging_files: [{ key: "active-upload", namespace: "local" }],
    retained_staging_files: [{ key: "retained-upload", namespace: "local" }],
    orphan_staging_files: [
      { key: "orphan-upload", backend: "local", namespace: "local" }
    ],
    incomplete_listings: [
      { backend: "archive", namespace: "archive", prefix: "full" },
      { backend: "archive", namespace: "archive", prefix: "thumbs" }
    ],
    unavailable_backends: [
      {
        backend: "offline",
        namespace: "offline",
        blocks_maintenance: true
      },
      {
        backend: "broken-alias",
        namespace: "shared",
        blocks_maintenance: false
      }
    ]
  }), {
    repairable_thumbnails: 2,
    missing_originals: 1,
    removable_objects: 3,
    protected_staging_objects: 2,
    blocked_namespaces: 2,
    unavailable_logical_backends: 1,
    blocked_items: 3,
    preview_items: 6
  });
  assert.equal(storageMaintenancePreview({ missing_objects: [] }), null);
});

test("站点根入口保持 home、show、gallery 与关闭回退语义", () => {
  function site(
    root: "home" | "show" | "gallery",
    homeEnabled: boolean,
    showEnabled = true,
    browseTarget: "gallery" | "show" = "gallery",
    galleryEnabled = true
  ) {
    return {
      root,
      home: {
        enabled: homeEnabled,
        browse_target: browseTarget,
        background: "",
        banner_label: "",
        banner_title: ""
      },
      show: {
        enabled: showEnabled,
        mode: "waterfall" as const,
        density: "balanced" as const,
        drift_speed: 28,
        order: "random" as const
      },
      gallery: { enabled: galleryEnabled }
    };
  }

  assert.equal(publicRootPath(site("home", true)), "/home");
  assert.equal(publicRootPath(site("show", true)), "/show");
  assert.equal(publicRootPath(site("gallery", true)), "/gallery");
  assert.equal(publicRootPath(site("home", false)), "/gallery");
  assert.equal(publicRootPath(site("show", true, false)), "/gallery");
  assert.equal(publicRootPath(site("gallery", false)), "/gallery");
  assert.equal(publicRootPath(site("gallery", false, true, "gallery", false)), "/show");
  assert.equal(publicRootPath(site("gallery", true, false, "gallery", false)), "/home");
  assert.equal(publicRootPath(site("gallery", false, false, "gallery", false)), null);
  assert.equal(publicHomeBrowsePath(site("home", true, true, "show")), "/show");
  assert.equal(publicHomeBrowsePath(site("home", true, false, "show")), "/gallery");
  assert.equal(publicHomeBrowsePath(site("home", true, true, "gallery")), "/gallery");
  assert.equal(
    publicHomeBrowsePath(site("home", true, true, "gallery", false)),
    "/show"
  );
  assert.equal(
    publicHomeBrowsePath(site("home", true, false, "gallery", false)),
    null
  );
  assert.equal(
    publicHomeBrowsePath(site("home", true, true, "show"), true),
    "/embed/show"
  );
  assert.equal(
    publicHomeBrowsePath(site("home", true, true, "show", false), true),
    "/embed/show"
  );
  assert.equal(
    publicHomeBrowsePath(site("home", true, false, "show"), true),
    "/embed/gallery"
  );
  assert.equal(
    publicHomeBrowsePath(site("home", true, false, "show", false), true),
    null
  );
});

test("公开图片磁吸按指针全域连续映射并可同步复位", () => {
  const properties = new Map<string, string>();
  const element = {
    style: {
      setProperty: (name: string, value: string) => properties.set(name, value)
    },
    getBoundingClientRect: () => ({
      bottom: 100,
      height: 100,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({})
    }),
    offsetParent: null
  } as unknown as HTMLElement;
  assert.equal(applyPointerMagnet(
    element,
    element,
    { clientX: 100, clientY: 50, pointerType: "mouse" },
    { maximumAngleDegrees: 10, maximumShadowOffsetPixels: 9 }
  ), true);
  assert.equal(properties.get("--public-card-magnet-axis-x"), "0");
  assert.equal(properties.get("--public-card-magnet-axis-y"), "-1");
  assert.equal(properties.get("--public-card-magnet-angle"), "10deg");
  assert.equal(properties.get("--public-card-magnet-shadow-x"), "9px");
  assert.equal(properties.get("--public-card-magnet-shadow-y"), "0px");
  assert.equal(properties.get("--public-card-magnet-light-x"), "100%");
  assert.equal(properties.get("--public-card-magnet-light-strength"), "1");
  applyPointerMagnet(element, element,
    { clientX: 75, clientY: 50, pointerType: "mouse" },
    { maximumAngleDegrees: 10, maximumShadowOffsetPixels: 9 });
  assert.equal(properties.get("--public-card-magnet-light-strength"), "0.25");
  assert.equal(applyPointerMagnet(
    element,
    element,
    { clientX: 100, clientY: 50, pointerType: "touch" },
    { maximumAngleDegrees: 10, maximumShadowOffsetPixels: 9 }
  ), false);
  resetPointerMagnet(element);
  assert.equal(properties.get("--public-card-magnet-angle"), "0deg");
  assert.equal(properties.get("--public-card-magnet-shadow-x"), "0px");
  assert.equal(properties.get("--public-card-magnet-light-strength"), "0");
});


async function createPublicNavigationHarness(
  t: TestContext,
  { movement = "manual", headerPresent = true, mobileLayout = false }: {
    movement?: "manual" | "page";
    headerPresent?: boolean;
    mobileLayout?: boolean;
  } = {}
) {
  const { window: domWindow, document } = parseHTML('<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id=root></div></body></html>');
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')!;
  const originalViewport = viewport.content;
  const React = await import("react");
  let now = 0;
  let serial = 0;
  let hovered = false;
  let focused = false;
  let keyboardFocus = false;
  let activeElement: HTMLElement | null = null;
  let toolbarVisible = false;
  let filtersOpen = false;
  let setPlaying: (playing: boolean) => void;
  let setPaused: (paused: boolean) => void;
  let hidden = false;
  let advanceManualNavigation: (delta: number, pointerType?: string) => void;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const schedule = (callback: () => void, delay = 0) => {
    const id = ++serial;
    timers.set(id, { due: now + delay, callback });
    return id;
  };
  const overrides: Record<string, unknown> = {
    innerWidth: mobileLayout ? 390 : 1440,
    innerHeight: 900,
    scrollY: 0,
    setTimeout: schedule,
    clearTimeout: (id: number) => timers.delete(id),
    requestAnimationFrame: (callback: FrameRequestCallback) => schedule(() => callback(now), 16),
    cancelAnimationFrame: (id: number) => timers.delete(id),
    matchMedia: (media: string) => ({
      matches: media === "(max-width: 760px)" ? mobileLayout
        : media === "(hover: hover) and (pointer: fine)" && !mobileLayout,
      media, addEventListener() {}, removeEventListener() {}
    })
  };
  const window = new Proxy(domWindow, {
    get: (target, key) => typeof key === "string" && key in overrides
      ? overrides[key] : Reflect.get(target, key),
    set: (_target, key, value) => { overrides[String(key)] = value; return true; }
  });
  for (const element of [document.documentElement, document.body]) {
    Object.defineProperty(element, "scrollHeight", { configurable: true, value: 10_000 });
  }
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => activeElement });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  const globals = {
    window, self: window, document, navigator: domWindow.navigator,
    Node: domWindow.Node, Element: domWindow.Element, HTMLElement: domWindow.HTMLElement,
    Event: domWindow.Event, MutationObserver: domWindow.MutationObserver,
    ResizeObserver: class { observe() {} disconnect() {} },
    React, IS_REACT_ACT_ENVIRONMENT: true
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let unmount: (() => Promise<void>) | undefined;
  t.after(async () => {
    try {
      await unmount?.();
      assert.equal(timers.size, 0, "卸载清理导航计时与滚动帧");
      assert.equal(viewport.content, originalViewport, "离开图片页后恢复视口，不影响首页和后台");
    } finally {
      timers.clear();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    }
  });
  const { createRoot } = await import("react-dom/client");
  const { usePublicImageViewportControls } = await import("../../packages/web/src/hooks/usePublicImageViewportControls.ts");
  const installed = new WeakSet<HTMLElement>();
  function Harness() {
    const [playing, updatePlaying] = React.useState(true);
    setPlaying = updatePlaying;
    const [paused, updatePaused] = React.useState(false);
    setPaused = updatePaused;
    const controls = usePublicImageViewportControls({
      movement, headerPresent, paused,
      autoHideAfterMs: movement === "manual" && playing ? publicNavigationAutoHideDelayMs : undefined
    });
    toolbarVisible = controls.toolbarVisible;
    filtersOpen = controls.filtersOpen;
    advanceManualNavigation = controls.advanceManualNavigation;
    return React.createElement("div", {
      className: "public-navigation-stack",
      ref: (element: HTMLElement | null) => {
        if (!element || installed.has(element)) return;
        installed.add(element);
        const nativeMatches = element.matches.bind(element);
        const nativeQuerySelector = element.querySelector.bind(element);
        element.matches = (selector) => selector === ":hover, :focus-within"
          ? hovered || focused : selector === ":focus-visible" ? false : nativeMatches(selector);
        element.querySelector = ((selector: string) => selector === ":focus-visible"
          ? focused && keyboardFocus ? nativeQuerySelector("button") : null
          : nativeQuerySelector(selector)) as typeof element.querySelector;
        element.getBoundingClientRect = () => ({ height: 96 } as DOMRect);
      }
    }, React.createElement("div", {
      ref: (element: HTMLElement | null) => {
        controls.toolbarRef.current = element;
        if (element) element.getBoundingClientRect = () => ({ height: 36 } as DOMRect);
      }
    }, React.createElement("button", {
      "aria-expanded": controls.filtersOpen,
      onClick: controls.toggleFilters,
      ref: (element: HTMLButtonElement | null) => {
        controls.filterToggleRef.current = element;
        if (!element) return;
        element.getBoundingClientRect = () => ({ bottom: 96, height: 36 } as DOMRect);
        element.focus = () => { focused = true; activeElement = element; };
        element.blur = () => { focused = false; activeElement = null; };
      }
    }, "筛选"), React.createElement("div", {
      ref: controls.filterPanelRef,
      "aria-hidden": controls.filterPanelHidden,
      inert: controls.filterPanelHidden
    })));
  }
  const root = createRoot(document.getElementById("root")!);
  unmount = async () => { await React.act(async () => root.unmount()); };
  await React.act(async () => root.render(React.createElement(Harness)));
  assert.equal(viewport.content, `${originalViewport}, viewport-fit=cover`, "普通及嵌入图片页统一启用安全区布局");
  const navigation = document.querySelector<HTMLElement>(".public-navigation-stack")!;
  const dispatch = async (target: EventTarget, type: string, values: Record<string, unknown> = {}) => {
    await React.act(async () => {
      const event = new domWindow.Event(type, { bubbles: true });
      Object.assign(event, values);
      target.dispatchEvent(event);
      await Promise.resolve();
    });
  };
  return {
    visible: () => toolbarVisible,
    filtersOpen: () => filtersOpen,
    timerCount: () => timers.size,
    advance: async (milliseconds: number) => {
      await React.act(async () => {
        const until = now + milliseconds;
        while (true) {
          const next = [...timers].filter(([, value]) => value.due <= until)
            .sort((left, right) => left[1].due - right[1].due)[0];
          if (!next) break;
          now = next[1].due;
          timers.delete(next[0]);
          next[1].callback();
        }
        now = until;
      });
    },
    pointer: (clientY: number, buttons = 0, isTrusted = true) => dispatch(document, "pointermove", { clientY, buttons, pointerType: "mouse", isTrusted }),
    pointerOver: (relatedTarget: EventTarget | null) => dispatch(document, "pointerover", {
      clientY: 10, buttons: 0, pointerType: "mouse", isTrusted: true, relatedTarget
    }),
    documentBody: document.body,
    playing: async (playing: boolean) => { await React.act(async () => setPlaying(playing)); },
    paused: async (paused: boolean) => { await React.act(async () => setPaused(paused)); },
    hidden: async (value: boolean) => { hidden = value; await dispatch(document, "visibilitychange"); },
    click: () => dispatch(document.body, "click"),
    toggleFilters: () => dispatch(navigation.querySelector("button")!, "click"),
    manual: async (delta: number, pointerType?: string) => {
      await React.act(async () => advanceManualNavigation(delta, pointerType));
    },
    hover: async (value: boolean) => { hovered = value; await dispatch(navigation, value ? "mouseenter" : "mouseleave"); },
    focus: async (value: boolean, visible = true) => {
      focused = value;
      keyboardFocus = visible;
      activeElement = value ? navigation.querySelector("button") : null;
      await dispatch(navigation, value ? "focusin" : "focusout");
    },
    scroll: async (scrollY: number) => { overrides.scrollY = scrollY; await dispatch(window, "scroll"); }
  };
}

test("桌面与嵌入展映三秒无点击收起，顶部 36px 唤出，导航内悬停和焦点取消计时", async (t) => {
  assert.equal(publicNavigationAutoHideDelayMs, 3000);
  assert.equal(publicNavigationTopEdgeRevealHeight, 36);
  for (const headerPresent of [true, false]) {
    await t.test(headerPresent ? "普通展映" : "嵌入展映", async (t) => {
      const h = await createPublicNavigationHarness(t, { headerPresent });
      await h.advance(2000);
      await h.pointer(200);
      await h.advance(1000);
      assert.equal(h.visible(), false, "普通鼠标移动不重置无点击计时");
      await h.pointer(36);
      assert.equal(h.visible(), false);
      await h.pointer(35);
      assert.equal(h.visible(), true);
      await h.advance(2000);
      await h.pointer(34);
      await h.advance(1000);
      assert.equal(h.visible(), false, "顶部区域内移动也不续期");
      await h.pointer(100);
      await h.pointer(35);
      await h.advance(2000);
      await h.click();
      await h.advance(2999);
      assert.equal(h.visible(), true);
      await h.hover(true);
      assert.equal(h.timerCount(), 0, "悬停期间取消计时器");
      await h.advance(6000);
      assert.equal(h.visible(), true);
      await h.focus(true);
      await h.hover(false);
      assert.equal(h.timerCount(), 0, "鼠标离开但焦点仍在导航内时继续保护");
      await h.advance(6000);
      assert.equal(h.visible(), true);
      await h.focus(false);
      await h.advance(2999);
      assert.equal(h.visible(), true);
      await h.advance(1);
      assert.equal(h.visible(), false);
    });
  }
});

test("画廊只随滚动显隐，任何页面位置均不启用无操作计时器", async (t) => {
  const h = await createPublicNavigationHarness(t, { movement: "page" });
  await h.advance(6000);
  assert.equal(h.visible(), true);
  await h.scroll(96);
  await h.advance(16);
  await h.advance(6000);
  assert.equal(h.visible(), true);
  await h.scroll(97);
  await h.advance(16);
  await h.advance(6000);
  assert.equal(h.visible(), true);
  assert.equal(h.timerCount(), 0);
  await h.scroll(400);
  await h.advance(16);
  assert.equal(h.visible(), false);
  await h.scroll(0);
  await h.advance(16);
  await h.advance(6000);
  assert.equal(h.visible(), true, "向上滚动唤出后也不会自动收起");
});

test("展映暂停或后台取消计时，恢复后重新计满三秒，合成移动不唤出", async (t) => {
  const h = await createPublicNavigationHarness(t);
  await h.advance(2999);
  await h.playing(false);
  assert.equal(h.timerCount(), 0);
  await h.advance(6000);
  assert.equal(h.visible(), true);
  await h.playing(true);
  await h.advance(2999);
  assert.equal(h.visible(), true);
  await h.hidden(true);
  assert.equal(h.timerCount(), 0);
  await h.advance(6000);
  await h.hidden(false);
  await h.advance(2999);
  assert.equal(h.visible(), true);
  await h.advance(1);
  assert.equal(h.visible(), false);
  await h.pointer(10, 0, false);
  await h.pointerOver(h.documentBody);
  assert.equal(h.visible(), false, "Pixi 合成事件和导航动画引起的内部悬停切换不能重新展开");
  await h.pointerOver(null);
  assert.equal(h.visible(), true, "真实鼠标从文档外进入顶部仍可唤出");
});

test("展映桌面鼠标拖动只收起导航，滚轮和触控仍可唤出", async (t) => {
  for (const headerPresent of [true, false]) {
    await t.test(headerPresent ? "普通展映" : "嵌入展映", async (t) => {
      const h = await createPublicNavigationHarness(t, { headerPresent });
      await h.manual(300, "mouse");
      assert.equal(h.visible(), false, "向上拖动仍收起导航");
      await h.manual(-300, "mouse");
      assert.equal(h.visible(), false, "向下拖动回到起点也不唤出");
      await h.manual(1, "mouse");
      assert.equal(h.visible(), false, "反向或小幅惯性不触发顶部自动唤出");
      await h.manual(-1);
      assert.equal(h.visible(), true, "滚轮仍可唤出");
      await h.manual(300, "mouse");
      await h.manual(-300, "touch");
      assert.equal(h.visible(), true, "触控保持原有唤出行为");
    });
  }
});

test("移动展映拖动继续双向控制导航，并保护键盘可见焦点", async (t) => {
  const h = await createPublicNavigationHarness(t, { mobileLayout: true });
  for (const pointerType of ["touch", "mouse"]) {
    await h.manual(300, pointerType);
    assert.equal(h.visible(), false);
    await h.manual(-300, pointerType);
    assert.equal(h.visible(), true);
  }
  await h.focus(true);
  await h.manual(300, "touch");
  await h.advance(6000);
  assert.equal(h.visible(), true, "移动端键盘操作期间仍保护导航");
  await h.focus(false);
  await h.advance(3000);
  assert.equal(h.visible(), false);
});

test("移动画廊与展映关闭筛选后，触摸残留的悬停和按钮焦点不阻止收起", async (t) => {
  for (const movement of ["page", "manual"] as const) {
    for (const headerPresent of [true, false]) {
      await t.test(`${movement} / ${headerPresent ? "普通页" : "嵌入页"}`, async (t) => {
        const h = await createPublicNavigationHarness(t, { movement, headerPresent, mobileLayout: true });
        if (movement === "page") {
          await h.scroll(97);
          await h.advance(16);
        }
        await h.hover(true);
        await h.focus(true, false);
        await h.toggleFilters();
        assert.equal(h.filtersOpen(), true);
        await h.advance(6000);
        assert.equal(h.visible(), true, "面板展开期间保持导航");
        await h.toggleFilters();
        assert.equal(h.filtersOpen(), false);
        await h.advance(2999);
        assert.equal(h.visible(), true);
        await h.advance(1);
        assert.equal(h.visible(), movement === "page", "只有展映在关闭后重新计满三秒；画廊保持滚动显隐");
        if (movement === "page") {
          await h.scroll(0);
          await h.advance(16);
          await h.scroll(97);
          await h.advance(16);
        } else {
          await h.manual(-1, "touch");
        }
        await h.toggleFilters();
        await h.toggleFilters();
        if (movement === "page") {
          await h.scroll(400);
          await h.advance(16);
        } else {
          await h.manual(300, "touch");
        }
        assert.equal(h.visible(), false, "关闭后也可随滚动或上拖收起");
      });
    }
  }
});

test("配置包预览明确提示目标版本的采用、回退、忽略与跳过结果", () => {
  assert.equal(
    configPackageRecognitionNotice({
      config_values: {
        recognized: 37,
        defaulted: 9,
        ignored: 3
      },
      skipped_storage_backends: 2
    }),
    "当前版本将逐项读取：采用 37 个运行时配置项，9 个运行时配置项使用当前默认值；忽略 3 个未知或错误的运行时配置字段，跳过 2 个无法安全识别的存储后端。未知、已删除或错误的运行时配置字段不会阻止其余内容导入。"
  );
  assert.equal(
    configPackageRecognitionNotice({
      config_values: {
        recognized: 46,
        defaulted: 0,
        ignored: 0
      },
      skipped_storage_backends: 0
    }),
    "当前版本将逐项读取：采用 46 个运行时配置项，0 个运行时配置项使用当前默认值。未知、已删除或错误的运行时配置字段不会阻止其余内容导入。"
  );
});

test("配置包冲突重命名在提交前执行与服务端一致的 slug 长度边界", () => {
  const preview = {
    conflicts: ["archive"],
    existing_slugs: ["local", "archive"],
    storage_backends: [{
      slug: "archive",
      display_name: "Archive",
      enabled: true,
      is_default: false
    }]
  };
  assert.equal(
    configPackageSlugMappingError(
      preview,
      { archive: "a".repeat(33) },
      "archive"
    ),
    "slug 不能超过 32 个字符"
  );
  assert.equal(
    configPackageSlugMappingError(
      preview,
      { archive: "a".repeat(32) },
      "archive"
    ),
    ""
  );
});

test("公开图库筛选与随机图链接使用同一当前参数契约", () => {
  const filters = galleryFiltersFromSearchParams(new URLSearchParams(
    "device=pc&brightness=dark&theme=stage,editorial&tag=concert,red-carpet&author=startrail-photo"
  ));
  assert.deepEqual(filters, {
    device: "pc",
    brightness: "dark",
    theme: "stage,editorial",
    tag: "concert,red-carpet",
    author: "startrail-photo"
  });
  assert.equal(
    galleryHref(filters),
    "/gallery?device=pc&brightness=dark&theme=stage%2Ceditorial&tag=concert%2Cred-carpet&author=startrail-photo"
  );
  assert.equal(
    galleryHref(filters, "/embed/gallery"),
    "/embed/gallery?device=pc&brightness=dark&theme=stage%2Ceditorial&tag=concert%2Cred-carpet&author=startrail-photo"
  );
  assert.equal(galleryHref(emptyGalleryFilters), "/gallery");
  assert.equal(
    galleryHref(emptyGalleryFilters, "/embed/gallery"),
    "/embed/gallery"
  );

  const automaticDevice = galleryFiltersFromSearchParams(
    new URLSearchParams("device=auto&brightness=light&theme=stage")
  );
  assert.equal(
    galleryHref(automaticDevice),
    "/gallery?device=auto&brightness=light&theme=stage"
  );
  assert.equal(
    galleryApiSearchParams(automaticDevice, "random", {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    }).toString(),
    "device=pc&brightness=light&theme=stage&shuffle=1"
  );
  assert.equal(
    galleryApiSearchParams(automaticDevice, "latest", {
      userAgent: "Mozilla/5.0 (iPhone)"
    }).toString(),
    "device=mb&brightness=light&theme=stage"
  );
  assert.equal(
    galleryApiSearchParams(automaticDevice, "latest", {
      userAgent: "unrecognized-client"
    }).toString(),
    "brightness=light&theme=stage"
  );
  assert.equal(galleryRandomRequestDevice(""), "all");
  assert.equal(galleryRandomRequestDevice("auto"), "");
  assert.equal(galleryRandomRequestDevice("pc"), "pc");
  assert.equal(showOrderFromSearchParams(new URLSearchParams(), "oldest"), "oldest");
  assert.equal(showModeFromSearchParams(new URLSearchParams(), "float"), "float");
  assert.equal(
    showModeFromSearchParams(new URLSearchParams("mode=waterfall"), "float"),
    "waterfall"
  );
  assert.equal(
    showModeFromSearchParams(new URLSearchParams("mode=invalid"), "float"),
    "float"
  );
  assert.equal(
    showOrderFromSearchParams(new URLSearchParams("order=latest"), "random"),
    "latest"
  );
  assert.equal(
    showOrderFromSearchParams(new URLSearchParams("order=invalid"), "random"),
    "random"
  );
  assert.equal(
    showRouteSearchParams(filters, "oldest", "float").toString(),
    "device=pc&brightness=dark&theme=stage%2Ceditorial&tag=concert%2Cred-carpet&author=startrail-photo&order=oldest&mode=float"
  );
  assert.equal(
    showOrderedApiSearchParams(automaticDevice, "oldest", {
      cursor: "cursor-token",
      userAgent: "Mozilla/5.0 (iPhone)"
    }).toString(),
    "device=mb&brightness=light&theme=stage&cursor=cursor-token&order=oldest"
  );
  assert.deepEqual(
    galleryFiltersFromSearchParams(new URLSearchParams("device=all")),
    {
      device: "",
      brightness: "",
      theme: "",
      tag: "",
      author: ""
    }
  );
  assert.equal(
    galleryFiltersFromSearchParams(
      new URLSearchParams(
        "theme=stage,!editorial&tag=valid,INVALID_VALUE"
      )
    ).theme,
    ""
  );

  assert.equal(buildRandomUrl({
    origin: "https://img.example.com",
    device: "pc",
    brightness: "random",
    theme: " Stage, !Archive ",
    tag: "Live",
    author: "Alice",
    mode: "json"
  }), "https://img.example.com/random?device=pc&theme=stage,!archive&tag=live&author=alice&mode=json");
  assert.equal(buildRandomUrl({
    origin: "https://img.example.com",
    device: galleryRandomRequestDevice(""),
    brightness: "random",
    theme: "",
    tag: "",
    author: ""
  }), "https://img.example.com/random?device=all");
  assert.equal(buildRandomUrl({
    origin: "https://img.example.com",
    device: galleryRandomRequestDevice("auto"),
    brightness: "random",
    theme: "",
    tag: "",
    author: ""
  }), "https://img.example.com/random");
});

test("首页目录、瀑布流、分页预载与滚动导航组成完整公开浏览流程", () => {
  const none = { slug: "none", image_count: 7 };
  const portrait = { slug: "portrait", image_count: 4 };
  const stage = { slug: "stage", image_count: 3 };
  assert.deepEqual(
    homeThemesWithUnsetLast([none, portrait, stage]).map(({ slug }) => slug),
    ["portrait", "stage", "none"]
  );
  const revealItems = Array.from({ length: 40 }, (_, index) => ({
    slug: "item-" + index,
    image_count: index % 3 === 0 ? 0 : index + 1
  }));
  const reveals = boundedHomeRevealIndexes(
    revealItems,
    new Set(["item-0"]),
    false,
    homeRevealItemLimits.tags
  );
  assert.equal(reveals.size, homeRevealItemLimits.tags);
  assert.equal(reveals.get("item-0"), 0);
  assert.equal(reveals.has("item-3"), false);

  assert.equal(galleryColumnCount(359), 1);
  assert.equal(galleryColumnCount(360), 2);
  assert.equal(galleryColumnCount(761), 3);
  assert.equal(galleryColumnCount(1920), 5);
  assert.equal(galleryColumnCount(3840), 8);

  const layout = new CompactMasonryLayout({
    contentWidth: 210,
    gap: 10,
    columnCount: 2
  });
  for (let index = 0; index < 4; index += 1) layout.append(1);
  assert.deepEqual(
    Array.from({ length: 4 }, (_, index) => {
      const position = layout.position(index)!;
      return { index, x: position.x, y: position.y };
    }),
    [
      { index: 0, x: 0, y: 0 },
      { index: 1, x: 110, y: 0 },
      { index: 2, x: 0, y: 110 },
      { index: 3, x: 110, y: 110 }
    ]
  );
  assert.deepEqual(
    layout.windowIndexes({ start: 105, end: 215 }),
    [2, 3]
  );

  const dataWindow = new GalleryDataWindow({
    geometry: { contentWidth: 210, gap: 10, columnCount: 2 }
  });
  const viewport = {
    start: 0,
    end: 400,
    visibleStart: 0,
    visibleEnd: 200,
    preloadEnd: 1_000
  };
  const [initialIntent] = dataWindow.updateViewport(viewport, null);
  assert.deepEqual(initialIntent, { cursor: "", kind: "initial" });
  resolveGalleryIntent(dataWindow, initialIntent!, syntheticGalleryPage({
    count: 2,
    start: 0,
    total: 4
  }));
  const appendIntent = dataWindow.updateViewport(viewport, null)
    .find(({ kind }) => kind === "append");
  assert.deepEqual(appendIntent, { cursor: "cursor-2", kind: "append" });
  resolveGalleryIntent(dataWindow, appendIntent!, syntheticGalleryPage({
    count: 2,
    start: 2,
    total: 4
  }));
  assert.deepEqual(
    dataWindow.windowPositions({
      ...viewport,
      pinnedId: null
    }).map(({ id }) => id),
    syntheticGalleryPage({ count: 4, start: 0, total: 4 })
      .items.map(({ id }) => id)
  );

  const hidden = advancePublicImageNavigation(initialPublicImageNavigationState, {
    delta: 100,
    headerPresent: true,
    scrollTop: 240,
    toolbarHeight: 140,
    lockedOpen: false
  });
  assert.equal(hidden.stage, "hidden");
  assert.deepEqual(advancePublicImageNavigation(hidden, {
    delta: -100,
    headerPresent: true,
    scrollTop: 140,
    toolbarHeight: 140,
    lockedOpen: false
  }), initialPublicImageNavigationState);
});

test("画廊渲染窗口只在半屏边界重定位并覆盖图片驻留区", () => {
  const viewportHeight = 800;
  const initial = createGalleryRenderViewport(0, viewportHeight);
  assert.deepEqual(initial, {
    start: 0,
    end: 3_200,
    visibleStart: 0,
    visibleEnd: 800,
    preloadEnd: 1_600
  });
  assert.equal(
    shouldRefreshGalleryRenderViewport(initial, 399, viewportHeight),
    false
  );
  assert.equal(
    shouldRefreshGalleryRenderViewport(initial, 400, viewportHeight),
    true
  );

  const deep = createGalleryRenderViewport(1_600, viewportHeight);
  assert.equal(
    shouldRefreshGalleryRenderViewport(deep, 1_201, viewportHeight),
    false
  );
  assert.equal(
    shouldRefreshGalleryRenderViewport(deep, 1_200, viewportHeight),
    true
  );
  assert.equal(
    shouldRefreshGalleryRenderViewport(deep, 1_999, viewportHeight),
    false
  );
  assert.equal(
    shouldRefreshGalleryRenderViewport(deep, 2_000, viewportHeight),
    true
  );
  assert.equal(
    shouldRefreshGalleryRenderViewport(deep, 1_600, 799),
    true
  );
  assert.ok(
    galleryVirtualOverscanScreens - galleryRenderViewportHysteresisScreens
      > galleryResidenceBufferScreens
  );
});

test("画廊标题只使用标题或 UUID 后十二位", () => {
  const card = galleryCard("019ffefe-24d8-7d83-9ae1-12e720b651c9");
  assert.equal(imageDisplayTitle({ ...card, title: "  已命名图片  " }), "已命名图片");
  assert.equal(imageDisplayTitle({ ...card, title: "" }), "#12e720b651c9");
  assert.equal(imageDisplayTitle({
    ...card,
    title: "",
    theme: "night",
    tags: ["blue", "stars"]
  }), "#12e720b651c9");
});

test("公开列表 slug 复用 facets 生成卡片与详情显示值", () => {
  const item = {
    ...galleryCardDto("00000000-0000-7000-8000-000000000001"),
    theme: "night",
    tags: ["blue", "stars"]
  };
  const display = createGalleryTaxonomyDisplayFormatter({
    themes: [{ slug: "night", display_name: "夜景" }],
    tags: [
      { slug: "blue", display_name: "蓝色" },
      { slug: "stars", display_name: "星空" }
    ]
  });
  assert.deepEqual(display(item), {
    themeLabel: "夜景",
    tagLabels: ["蓝色", "星空"],
    subtitle: "夜景 · 蓝色/星空"
  });
  assert.equal("subtitle" in item, false);
  assert.deepEqual(createGalleryTaxonomyDisplayFormatter(undefined)({
    theme: "none",
    tags: ["blue"]
  }), {
    themeLabel: "未设置",
    tagLabels: ["blue"],
    subtitle: "blue"
  });
});

test("画廊数据窗口在 1 千、1 万和 5 万张长会话中保持有界", () => {
  const pageSize = 60;
  const compactBudgets = new Map([
    [1_000, 512 * 1024],
    [10_000, 2 * 1024 * 1024],
    [50_000, 8 * 1024 * 1024]
  ]);

  for (const total of compactBudgets.keys()) {
    const dataWindow = new GalleryDataWindow({
      geometry: { contentWidth: 1_600, gap: 16, columnCount: 5 },
      fullItemBudget: 480
    });
    for (let start = 0; start < total; start += pageSize) {
      const cursor = start === 0 ? "" : `cursor-${start}`;
      resolveGalleryIntent(dataWindow, {
        cursor,
        kind: start === 0 ? "initial" : "append"
      }, syntheticGalleryPage({ count: pageSize, start, total }));
      const totalHeight = dataWindow.snapshot().totalHeight;
      dataWindow.updateViewport({
        start: Math.max(0, totalHeight - 3_200),
        end: totalHeight,
        visibleStart: Math.max(0, totalHeight - 900),
        visibleEnd: totalHeight,
        preloadEnd: totalHeight + 1_800
      }, null);
    }

    const snapshot = dataWindow.snapshot();
    assert.equal(snapshot.compactItems, total);
    assert.ok(snapshot.fullItems <= 480, `${total}: full DTO budget`);
    assert.ok(snapshot.retainedPages <= 8, `${total}: retained page budget`);
    assert.ok(
      snapshot.estimatedCompactBytes <= compactBudgets.get(total)!,
      `${total}: compact index budget`
    );
    assert.ok(
      snapshot.estimatedFullDtoBytes < 1024 * 1024,
      `${total}: retained DTO bytes`
    );
    const tailPositions = dataWindow.windowPositions({
      start: Math.max(0, snapshot.totalHeight - 4_000),
      end: snapshot.totalHeight,
      visibleStart: Math.max(0, snapshot.totalHeight - 900),
      visibleEnd: snapshot.totalHeight,
      pinnedId: null
    });
    assert.ok(tailPositions.length <= 180);
    assert.equal(
      new Set(tailPositions.map(({ id }) => id)).size,
      tailPositions.length
    );
    assert.ok(tailPositions.every(({ item }) => item !== null));

    assert.equal(dataWindow.setGeometry({
      contentWidth: 360,
      gap: 12,
      columnCount: 2
    }), true);
    const mobileSnapshot = dataWindow.snapshot();
    assert.equal(mobileSnapshot.compactItems, total);
    assert.ok(mobileSnapshot.fullItems <= 480);
    assert.ok(
      mobileSnapshot.estimatedCompactBytes <= compactBudgets.get(total)!,
      `${total}: mobile compact index budget`
    );
    assert.ok(dataWindow.windowPositions({
      start: Math.max(0, mobileSnapshot.totalHeight - 4_000),
      end: mobileSnapshot.totalHeight,
      visibleStart: Math.max(0, mobileSnapshot.totalHeight - 900),
      visibleEnd: mobileSnapshot.totalHeight,
      pinnedId: null
    }).length <= 180);
    assert.equal(dataWindow.setGeometry({
      contentWidth: 1_600,
      gap: 16,
      columnCount: 5
    }), true);

    if (total !== 50_000) continue;

    const firstId = syntheticGalleryPage({
      count: pageSize,
      start: 0,
      total
    }).items[0]!.id;
    const pinRequests = dataWindow.updateViewport({
      start: Math.max(0, snapshot.totalHeight - 4_000),
      end: snapshot.totalHeight,
      visibleStart: Math.max(0, snapshot.totalHeight - 900),
      visibleEnd: snapshot.totalHeight,
      preloadEnd: snapshot.totalHeight
    }, firstId);
    const pinnedHydration = pinRequests.find(({ cursor }) => cursor === "");
    assert.deepEqual(pinnedHydration, { cursor: "", kind: "hydrate" });
    resolveGalleryIntent(dataWindow, pinnedHydration!, syntheticGalleryPage({
      count: pageSize,
      start: 0,
      total
    }));
    assert.ok(dataWindow.snapshot().fullItems <= 480 + pageSize);

    dataWindow.updateViewport({
      start: Math.max(0, snapshot.totalHeight - 4_000),
      end: snapshot.totalHeight,
      visibleStart: Math.max(0, snapshot.totalHeight - 900),
      visibleEnd: snapshot.totalHeight,
      preloadEnd: snapshot.totalHeight
    }, null);
    const returnRequests = dataWindow.updateViewport({
      start: 0,
      end: 4_000,
      visibleStart: 0,
      visibleEnd: 900,
      preloadEnd: 2_000
    }, null);
    const firstPageHydration = returnRequests.find(({ cursor }) => cursor === "");
    assert.deepEqual(firstPageHydration, { cursor: "", kind: "hydrate" });
    const shuffledFirstPage = syntheticGalleryPage({
      count: pageSize,
      start: 0,
      total
    });
    shuffledFirstPage.items.reverse();
    resolveGalleryIntent(dataWindow, firstPageHydration!, shuffledFirstPage);
    const returnedPositions = dataWindow.windowPositions({
      start: 0,
      end: 4_000,
      visibleStart: 0,
      visibleEnd: 900,
      pinnedId: null
    });
    assert.equal(returnedPositions[0]?.id, firstId);
    assert.notEqual(returnedPositions[0]?.item, null);
    assert.equal(
      dataWindow.updateViewport({
        start: 0,
        end: 4_000,
        visibleStart: 0,
        visibleEnd: 900,
        preloadEnd: 2_000
      }, null).some(({ cursor }) => cursor === ""),
      false
    );

    const beforeResize = dataWindow.positionForId(firstId)!;
    assert.equal(dataWindow.setGeometry({
      contentWidth: 360,
      gap: 12,
      columnCount: 2
    }), true);
    const afterResize = dataWindow.positionForId(firstId)!;
    assert.equal(beforeResize.index, afterResize.index);
    assert.notEqual(beforeResize.width, afterResize.width);

    const secondId = syntheticGalleryPage({
      count: pageSize,
      start: 0,
      total
    }).items[1]!.id;
    const removal = dataWindow.removeImage(firstId);
    assert.deepEqual(removal, {
      removed: true,
      index: 0,
      focusId: secondId
    });
    assert.equal(dataWindow.snapshot().compactItems, total - 1);
    assert.equal(dataWindow.indexOfId(firstId), -1);

    const reveal = new GalleryCardRevealRegistry({
      enteredAt: 0,
      routeEntrance: false
    });
    reveal.markRevealed(total - 1);
    assert.equal(reveal.revealedThroughIndex, total - 1);
    assert.deepEqual(reveal.prepare(10, {
      initialViewport: false,
      now: 10,
      order: 10,
      reduceMotion: false
    }), { variant: "settled", delayMs: 0 });
  }
});

test("画廊窗口在插入改变游标链时废弃迟到页请求", () => {
  const dataWindow = new GalleryDataWindow({
    geometry: { contentWidth: 800, gap: 16, columnCount: 3 },
    fullItemBudget: 120
  });
  for (let start = 0; start < 300; start += 60) {
    resolveGalleryIntent(dataWindow, {
      cursor: start === 0 ? "" : `cursor-${start}`,
      kind: start === 0 ? "initial" : "append"
    }, syntheticGalleryPage({ count: 60, start, total: 300 }));
    const totalHeight = dataWindow.snapshot().totalHeight;
    dataWindow.updateViewport({
      start: Math.max(0, totalHeight - 2_000),
      end: totalHeight,
      visibleStart: Math.max(0, totalHeight - 700),
      visibleEnd: totalHeight,
      preloadEnd: totalHeight
    }, null);
  }

  const topRequests = dataWindow.updateViewport({
    start: 0,
    end: 4_000,
    visibleStart: 0,
    visibleEnd: 700,
    preloadEnd: 1_500
  }, null);
  const firstIntent = topRequests.find(({ cursor }) => cursor === "")!;
  const staleIntent = topRequests.find(({ cursor }) => cursor === "cursor-60")!;
  assert.ok(firstIntent);
  assert.ok(staleIntent);
  const firstRequest = dataWindow.claimRequest(firstIntent)!;
  const staleRequest = dataWindow.claimRequest(staleIntent)!;
  const replacement = syntheticGalleryPage({ count: 60, start: 0, total: 300 });
  replacement.items[0] = galleryCard("00000000-0000-7000-8000-inserted0001");
  replacement.next_cursor = "cursor-authoritative-60";
  assert.equal(dataWindow.resolvePage(firstRequest, replacement), true);
  assert.equal(
    dataWindow.resolvePage(
      staleRequest,
      syntheticGalleryPage({ count: 60, start: 60, total: 300 })
    ),
    false
  );
  assert.equal(dataWindow.snapshot().failedQueryPages, 0);
  assert.equal(dataWindow.snapshot().compactItems, 60);
  assert.deepEqual(
    dataWindow.updateViewport({
      start: 0,
      end: 4_000,
      visibleStart: 0,
      visibleEnd: 700,
      preloadEnd: 10_000
    }, null).find(({ kind }) => kind === "append"),
    { cursor: "cursor-authoritative-60", kind: "append" }
  );
});

test("画廊远页水合失败保留可见错误边界并可恢复", () => {
  const dataWindow = new GalleryDataWindow({
    geometry: { contentWidth: 800, gap: 16, columnCount: 3 },
    fullItemBudget: 60
  });
  for (let start = 0; start < 180; start += 60) {
    resolveGalleryIntent(dataWindow, {
      cursor: start === 0 ? "" : `cursor-${start}`,
      kind: start === 0 ? "initial" : "append"
    }, syntheticGalleryPage({ count: 60, start, total: 180 }));
    const totalHeight = dataWindow.snapshot().totalHeight;
    dataWindow.updateViewport({
      start: Math.max(0, totalHeight - 1_500),
      end: totalHeight,
      visibleStart: Math.max(0, totalHeight - 700),
      visibleEnd: totalHeight,
      preloadEnd: totalHeight
    }, null);
  }

  const topViewport = {
    start: 0,
    end: 1_500,
    visibleStart: 0,
    visibleEnd: 700,
    preloadEnd: 1_500
  };
  const hydrate = dataWindow.updateViewport(topViewport, null)
    .find(({ cursor }) => cursor === "")!;
  assert.deepEqual(hydrate, { cursor: "", kind: "hydrate" });
  const failedRequest = dataWindow.claimRequest(hydrate)!;
  assert.equal(
    dataWindow.rejectPage(failedRequest, new Error("hydrate failed")),
    true
  );
  const failedSnapshot = dataWindow.snapshot();
  assert.equal(failedSnapshot.error?.message, "hydrate failed");
  assert.equal(failedSnapshot.errorRequest?.kind, "hydrate");
  assert.equal(failedSnapshot.errorRequest?.cursor, "");
  assert.equal(failedSnapshot.errorRequest?.top, 0);
  assert.ok((failedSnapshot.errorRequest?.bottom ?? 0) > 0);

  const retry = dataWindow.retryRequest("")!;
  assert.deepEqual(retry, hydrate);
  resolveGalleryIntent(dataWindow, retry, syntheticGalleryPage({
    count: 60,
    start: 0,
    total: 180
  }));
  assert.equal(dataWindow.snapshot().error, null);
  assert.equal(dataWindow.snapshot().errorRequest, null);
  assert.ok(dataWindow.windowPositions({
    ...topViewport,
    pinnedId: null
  }).every(({ item }) => item !== null));
});

test("公共详情保存为目标页建立新权威边界", () => {
  const dataWindow = new GalleryDataWindow({
    geometry: { contentWidth: 800, gap: 16, columnCount: 3 },
    fullItemBudget: 120
  });
  const viewport = {
    start: 0,
    end: 2_000,
    visibleStart: 0,
    visibleEnd: 700,
    preloadEnd: 3_000
  };
  const [initial] = dataWindow.updateViewport(viewport, null);
  resolveGalleryIntent(dataWindow, initial!, syntheticGalleryPage({
    count: 60,
    start: 0,
    total: 120
  }));
  const firstPage = syntheticGalleryPage({ count: 60, start: 0, total: 120 });
  const firstId = firstPage.items[0]!.id;
  const secondId = firstPage.items[1]!.id;
  const before = dataWindow.positionForId(firstId)!;
  const beforeItems = dataWindow.windowPositions({
    ...viewport,
    pinnedId: firstId
  });
  const firstBefore = beforeItems.find(({ id }) => id === firstId)!.item!;
  const secondBefore = beforeItems.find(({ id }) => id === secondId)!.item!;

  const appendIntent = dataWindow.updateViewport(viewport, null)
    .find(({ kind }) => kind === "append")!;
  const staleAppend = dataWindow.claimRequest(appendIntent)!;
  const authoritativeSnapshot = editableImage(firstId, {
    title: "saved title",
    theme: "saved-theme",
    author: firstBefore.author,
    tags: ["saved-tag"],
    thumb_url: firstBefore.thumb_url,
    width: 100,
    height: 300,
    device: firstBefore.device,
    brightness: firstBefore.brightness,
    original: "https://example.com/saved.webp",
    object_url: "https://example.com/saved.webp"
  });
  const refreshIntent = dataWindow.prepareImageRefresh(
    firstId,
    authoritativeSnapshot
  );
  assert.deepEqual(refreshIntent, { cursor: "", kind: "hydrate" });
  const immediateItems = dataWindow.windowPositions({
    ...viewport,
    pinnedId: firstId
  });
  const firstImmediate = immediateItems.find(({ id }) => id === firstId)!.item!;
  const secondImmediate = immediateItems.find(({ id }) => id === secondId)!.item!;
  assert.equal(firstImmediate.title, "saved title");
  assert.equal(firstImmediate.theme, "saved-theme");
  assert.deepEqual(firstImmediate.tags, ["saved-tag"]);
  assert.notStrictEqual(firstImmediate, firstBefore);
  assert.strictEqual(secondImmediate, secondBefore);
  assert.notEqual(dataWindow.positionForId(firstId)!.height, before.height);
  assert.equal(
    dataWindow.resolvePage(
      staleAppend,
      syntheticGalleryPage({ count: 60, start: 60, total: 120 })
    ),
    false
  );

  const refreshedPage = syntheticGalleryPage({
    count: 60,
    start: 0,
    total: 120
  });
  refreshedPage.items[0] = {
    ...refreshedPage.items[0]!,
    title: "saved title",
    theme: "saved-theme",
    tags: ["saved-tag"],
    width: 100,
    height: 300,
    diff_original: false
  };
  resolveGalleryIntent(dataWindow, refreshIntent!, refreshedPage);
  const refreshedPosition = dataWindow.windowPositions({
    ...viewport,
    pinnedId: firstId
  }).find(({ id }) => id === firstId)!;
  assert.equal(refreshedPosition.item?.title, "saved title");
  assert.equal(refreshedPosition.item?.theme, "saved-theme");
  assert.notEqual(refreshedPosition.height, before.height);
  assert.strictEqual(refreshedPosition.item, firstImmediate);
  assert.strictEqual(
    dataWindow.windowPositions({
      ...viewport,
      pinnedId: firstId
    }).find(({ id }) => id === secondId)!.item,
    secondBefore
  );

  const membershipIntent = dataWindow.prepareImageRefresh(secondId)!;
  assert.strictEqual(
    dataWindow.windowPositions({
      ...viewport,
      pinnedId: secondId
    }).find(({ id }) => id === secondId)!.item,
    secondBefore
  );
  const membershipPage = syntheticGalleryPage({
    count: 60,
    start: 0,
    total: 120
  });
  const replacementId = "00000000-0000-7000-8000-filtered0001";
  membershipPage.items[1] = galleryCard(replacementId);
  membershipPage.next_cursor = "cursor-authoritative-60";
  resolveGalleryIntent(dataWindow, membershipIntent, membershipPage);
  assert.equal(dataWindow.indexOfId(secondId), -1);
  assert.ok(dataWindow.indexOfId(replacementId) >= 0);
  assert.equal(dataWindow.snapshot().compactItems, 60);
});

test("画廊图片同节点换源隔离失败与迟到解码并保留驻留取消", async () => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const React = await import("react");
  const globals = {
    window, document, React, IS_REACT_ACT_ENVIRONMENT: true,
    navigator: window.navigator, HTMLElement: window.HTMLElement,
    Node: window.Node, Element: window.Element
  };
  const previous = new Map(Object.keys(globals).map((key) => [
    key, Object.getOwnPropertyDescriptor(globalThis, key)
  ]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.assign(window, { innerWidth: 1280, innerHeight: 720, location: new URL("https://img.example.test/gallery") });
  const { GalleryImageVisibilityController } = await import(
    "../../packages/web/src/pages/gallery/gallery-image-visibility.ts"
  );
  const originalObserve = GalleryImageVisibilityController.prototype.observe;
  let notify!: (visibility: { inViewport: boolean; inLoadRange: boolean; inResidenceRange: boolean }) => void;
  let observations = 0;
  let unobserved = 0;
  GalleryImageVisibilityController.prototype.observe = function (_target, callback) {
    observations += 1;
    notify = callback;
    callback({ inViewport: true, inLoadRange: true, inResidenceRange: true });
    return () => { unobserved += 1; };
  };
  let root: ReturnType<typeof import("react-dom/client")["createRoot"]> | undefined;
  try {
    const { createRoot } = await import("react-dom/client");
    const { GalleryImageRuntime } = await import("../../packages/web/src/pages/gallery/GalleryImageRuntime.tsx");
    const { LazyGalleryImage } = await import("../../packages/web/src/pages/gallery/LazyGalleryImage.tsx");
    root = createRoot(document.getElementById("root")!);
    const render = async (src: string, detailOpen = false) => React.act(async () => {
      root!.render(React.createElement(GalleryImageRuntime, {
        dataWindowMetrics: null, detailOpen, resetKey: "same-query",
        children: React.createElement(LazyGalleryImage, {
          src, alt: "测试缩略图", width: 800, height: 600, device: "pc"
        })
      }));
    });
    const image = () => document.querySelector<HTMLImageElement>(".tile-image-shell img");
    const shell = () => document.querySelector<HTMLElement>(".tile-image-shell")!;
    const settle = async (type: "load" | "error") => React.act(async () => {
      assert.ok(image());
      image()!.dispatchEvent(new window.Event(type));
    });
    await render("/a.webp");
    const holder = shell();
    assert.equal(image()?.getAttribute("src"), "/a.webp");
    await settle("error");
    assert.ok(document.querySelector(".tile-image-fallback"));
    await render("/b.webp");
    assert.strictEqual(shell(), holder);
    assert.equal(image()?.getAttribute("src"), "/b.webp", "旧地址失败不得阻止新地址加载");
    assert.equal(document.querySelector(".tile-image-fallback"), null);
    await settle("load");
    assert.ok(shell().classList.contains("loaded"));

    await render("/slow.webp");
    const slowImage = image()!;
    const decode = Promise.withResolvers<void>();
    Object.defineProperty(slowImage, "decode", { configurable: true, value: () => decode.promise });
    await settle("load");
    await render("/new.webp");
    assert.strictEqual(image(), slowImage, "正常换源复用最终 img 节点");
    assert.equal(image()?.getAttribute("src"), "/new.webp");
    await React.act(async () => decode.resolve());
    assert.equal(shell().classList.contains("loaded"), false, "旧解码完成不得标记新地址就绪");
    await settle("error");
    assert.ok(document.querySelector(".tile-image-fallback"), "新地址失败仍需显示反馈");
    await render("/slow.webp");
    assert.equal(image()?.getAttribute("src"), "/slow.webp", "再次使用旧地址应重新请求");
    const departingImage = image()!;
    await React.act(async () => notify({ inViewport: false, inLoadRange: false, inResidenceRange: false }));
    assert.equal(image(), null);
    assert.equal(departingImage.getAttribute("src"), null);
    await React.act(async () => notify({ inViewport: true, inLoadRange: true, inResidenceRange: true }));
    assert.equal(image()?.getAttribute("src"), "/slow.webp");
    await render("/paused.webp", true);
    assert.equal(image(), null, "详情打开时换源继续遵守画廊暂停");
    await render("/paused.webp", false);
    assert.equal(image()?.getAttribute("src"), "/paused.webp");
    await settle("load");
    assert.ok(shell().classList.contains("loaded"));
    assert.equal(observations, 1, "换源不能重建共享可见性注册");
    await React.act(async () => root!.unmount());
    root = undefined;
    assert.equal(unobserved, 1);
  } finally {
    if (root) await React.act(async () => root!.unmount());
    GalleryImageVisibilityController.prototype.observe = originalObserve;
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test("画廊调试快照覆盖查询、DTO、紧凑布局、揭示与 JS heap 指标", () => {
  const scheduler = new ImageLoadScheduler(2);
  const debug = new GalleryDebugStats(scheduler);
  debug.updateDataWindow({
    fetchedPages: 834,
    retainedPages: 8,
    queryCachePages: 2,
    compactItems: 50_000,
    fullItems: 480,
    materializedPositions: 180,
    compactLayoutBytes: 1_500_000,
    estimatedCompactBytes: 6_000_000,
    estimatedFullDtoBytes: 400_000
  });
  debug.recordReveal(49_999);
  debug.sampleJsHeap();
  const snapshot = debug.snapshot();
  assert.equal(snapshot.fetchedPages, 834);
  assert.equal(snapshot.retainedPages, 8);
  assert.equal(snapshot.queryCachePages, 2);
  assert.equal(snapshot.compactItems, 50_000);
  assert.equal(snapshot.fullItems, 480);
  assert.equal(snapshot.materializedPositions, 180);
  assert.equal(snapshot.revealHighWater, 49_999);
  assert.ok(
    snapshot.usedJsHeapBytes === null
    || snapshot.usedJsHeapBytes >= 0
  );
  debug.resetDataWindow();
  assert.equal(debug.snapshot().revealHighWater, -1);
  assert.equal(debug.snapshot().compactItems, 0);
  debug.dispose();
});

test("图片管理保留连续选择、直接分页和管理员外观语义", () => {
  const pageIds = ["a", "b", "c", "d", "e"];
  const controller = new ImageListSelectionController();
  let selected = controller.update({
    pageIds,
    selectedIds: [],
    targetId: "b",
    checked: true,
    extendRange: false,
    busy: false
  });
  selected = controller.update({
    pageIds,
    selectedIds: selected,
    targetId: "e",
    checked: true,
    extendRange: true,
    busy: false
  });
  assert.deepEqual(selected, ["b", "c", "d", "e"]);
  selected = controller.update({
    pageIds,
    selectedIds: selected,
    targetId: "d",
    checked: false,
    extendRange: true,
    busy: false
  });
  assert.deepEqual(selected, ["e"]);
  assert.strictEqual(controller.update({
    pageIds,
    selectedIds: selected,
    targetId: "a",
    checked: true,
    extendRange: false,
    busy: true
  }), selected);
  assert.equal(isImageSelectionPreservingTarget({ closest: () => ({}) }), true);
  assert.equal(isImageSelectionPreservingTarget({ closest: () => null }), false);

  assert.equal(parseAdminPaginationPage("012", 12), 12);
  assert.equal(parseAdminPaginationPage("13", 12), null);
  const firstCommit = resolveAdminPaginationCommit({
    value: "003",
    page: 1,
    totalPages: 5,
    submittedPage: null
  });
  assert.deepEqual(firstCommit, {
    value: "3",
    invalid: false,
    submittedPage: 3,
    targetPage: 3
  });
  assert.equal(resolveAdminPaginationCommit({
    value: firstCommit.value,
    page: 1,
    totalPages: 5,
    submittedPage: firstCommit.submittedPage
  }).targetPage, null);
  assert.equal(releaseAdminPaginationSubmission(true, false, 3), null);
  assert.equal(shouldCommitAdminPaginationInput("Enter", false, 13), true);
  assert.equal(shouldCommitAdminPaginationInput("Enter", true, 13), false);

  const navigationModules = (role: "image" | "super") => new Set(
    Object.values(adminNavigationForRole(role)).flatMap((entries) => (
      entries.flatMap((entry) => entry.kind === "link"
        ? [entry.routeModule].filter((value) => value !== undefined)
        : entry.items.flatMap((item) => (
            item.routeModule ? [item.routeModule] : []
          )))
    ))
  );
  assert.deepEqual(
    [...navigationModules("image")].sort(),
    ["account", "check", "images", "overview", "vocabulary"]
  );
  assert.deepEqual(
    [...navigationModules("super")].sort(),
    [
      "account",
      "advancedConfig",
      "check",
      "images",
      "logs",
      "overview",
      "site",
      "storage",
      "users",
      "vocabulary"
    ]
  );

  assert.equal(resolveUiColorContext("public", "light", false), "dark");
  assert.equal(resolveUiColorContext("admin", "system", true), "dark");
  assert.equal(resolveUiColorContext("admin", "system", false), "light");
  let colorScheme: "system" | "dark" | "light" = "system";
  let cycle: AdminColorSchemeCycle = null;
  const sequence = [colorScheme];
  for (let index = 0; index < 3; index += 1) {
    const next = nextAdminColorScheme(colorScheme, "dark", cycle);
    cycle = advanceAdminColorSchemeCycle(colorScheme, "dark", next);
    colorScheme = next;
    sequence.push(colorScheme);
  }
  assert.deepEqual(sequence, ["system", "light", "dark", "system"]);
});

test("后台颜色偏好在首个布局观察前接管 bootstrap 颜色域", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html data-ui-context=bootstrap data-color-scheme=dark><head>"
      + "<meta name=color-scheme content=dark><meta name=theme-color content=#070b15>"
      + "</head><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true
  });
  Object.assign(window, { matchMedia });

  const getComputedStyle = () => ({
    backgroundColor: "rgb(255, 255, 255)",
    getPropertyValue: (name: string) => (
      name === "--color-browser-canvas" ? "#ffffff" : ""
    )
  });
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
    getComputedStyle,
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
    const { useAdminColorScheme } = await import(
      "../../packages/web/src/hooks/useAdminColorScheme.ts"
    );
    const layoutObservations: string[] = [];

    function Harness() {
      const resolved = useAdminColorScheme("light");
      React.useLayoutEffect(() => {
        layoutObservations.push(
          `${document.documentElement.dataset.uiContext}/`
            + `${document.documentElement.dataset.colorScheme}/${resolved}`
        );
      }, [resolved]);
      return null;
    }

    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    assert.deepEqual(layoutObservations, ["admin/light/light"]);
    assert.equal(
      document.querySelector('meta[name="color-scheme"]')?.getAttribute("content"),
      "light"
    );
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

test("动画关闭捕获最新回调并在请求阶段冻结完成动作", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  let reduceMotion = true;
  const matchMedia = (query: string) => ({
    matches: reduceMotion && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true
  });
  Object.assign(window, { matchMedia });
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
    const { useAnimatedClose } = await import(
      "../../packages/web/src/hooks/useAnimatedClose.ts"
    );
    const closedRevisions: number[] = [];
    const preparedRevisions: number[] = [];
    let commitCompletedRevision: ((revision: number) => void) | undefined;
    let finishAnimatedClose: (() => void) | undefined;
    const animationTarget = document.createElement("div");

    function Harness() {
      const [completedRevision, setCompletedRevision] = React.useState(0);
      commitCompletedRevision = setCompletedRevision;
      const exit = useAnimatedClose(() => {
        closedRevisions.push(completedRevision);
      });
      finishAnimatedClose = () => exit.onAnimationEnd({
        currentTarget: animationTarget,
        target: animationTarget
      } as never);
      React.useLayoutEffect(() => {
        if (completedRevision === 1) {
          exit.requestClose();
        } else if (completedRevision > 1) {
          exit.requestClose(undefined, () => {
            preparedRevisions.push(completedRevision);
            return () => closedRevisions.push(completedRevision);
          });
        }
      }, [completedRevision, exit.requestClose]);
      return null;
    }

    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });
    await React.act(async () => {
      commitCompletedRevision?.(1);
      await Promise.resolve();
    });

    assert.deepEqual(
      closedRevisions,
      [1],
      "完成态提交后立即关闭必须使用最新已提交的清理回调"
    );
    reduceMotion = false;
    await React.act(async () => {
      commitCompletedRevision?.(2);
      await Promise.resolve();
    });
    await React.act(async () => {
      commitCompletedRevision?.(3);
      await Promise.resolve();
    });
    await React.act(async () => finishAnimatedClose?.());
    assert.deepEqual(
      preparedRevisions,
      [2],
      "重复关闭请求不得重新准备或扩大已经冻结的动作"
    );
    assert.deepEqual(
      closedRevisions,
      [1, 2],
      "退场动画期间的新完成态不得扩大已经请求的关闭清理范围"
    );
    await React.act(async () => root.unmount());

    let requestBoundaryClose: (() => void) | undefined;
    let finishBoundaryClose: (() => void) | undefined;
    function ExitBoundary({ onFinish }: Readonly<{ onFinish: () => void }>) {
      const exit = useAnimatedClose(onFinish);
      requestBoundaryClose = exit.requestClose;
      finishBoundaryClose = () => exit.onAnimationEnd({
        currentTarget: animationTarget,
        target: animationTarget
      } as never);
      return React.createElement("div", {
        id: "animated-close-boundary",
        className: exit.closing ? "is-closing" : ""
      });
    }
    function ExitBoundaryHarness() {
      const [locked, setLocked] = React.useState(true);
      const [open, setOpen] = React.useState(true);
      return React.createElement(
        React.Fragment,
        null,
        React.createElement("button", {
          id: "animated-close-background-action",
          disabled: locked
        }, "后台操作"),
        open && React.createElement(ExitBoundary, {
          onFinish: () => {
            setLocked(false);
            setOpen(false);
          }
        })
      );
    }
    const boundaryHost = document.createElement("div");
    document.body.append(boundaryHost);
    const boundaryRoot = createRoot(boundaryHost);
    await React.act(async () => {
      boundaryRoot.render(React.createElement(ExitBoundaryHarness));
      await Promise.resolve();
    });
    await React.act(async () => requestBoundaryClose?.());
    assert.equal(
      document.getElementById("animated-close-boundary")
        ?.classList.contains("is-closing"),
      true
    );
    await React.act(() => {
      finishBoundaryClose?.();
      assert.equal(
        document.getElementById("animated-close-boundary"),
        null,
        "动画结束回调返回前必须同步移除已经透明的弹窗"
      );
      assert.equal(
        (document.getElementById(
          "animated-close-background-action"
        ) as HTMLButtonElement | null)?.disabled,
        false,
        "首个无弹窗画面中的后台操作必须已经恢复可用"
      );
    });
    await React.act(async () => boundaryRoot.unmount());
    boundaryHost.remove();

    const requestAnimationFrame = (callback: FrameRequestCallback) => (
      setTimeout(() => callback(Date.now()), 0) as unknown as number
    );
    Object.assign(window, {
      requestAnimationFrame,
      cancelAnimationFrame: (handle: number) => clearTimeout(handle),
      scrollTo() {},
      scrollY: 0,
      innerWidth: 1280
    });
    const { DialogFrame } = await import(
      "../../packages/web/src/components/feedback/DialogFrame.tsx"
    );
    let noAnimationPrepared = 0;
    let noAnimationFinished = 0;
    let noAnimationFallback = 0;
    function NoAnimationDialog() {
      const [open, setOpen] = React.useState(true);
      const closeRef = React.useRef<HTMLButtonElement | null>(null);
      if (!open) return null;
      return React.createElement(DialogFrame, {
        className: "no-animation-dialog",
        ariaLabel: "无动画关闭测试",
        animateClose: false,
        initialFocusRef: closeRef,
        prepareClose: () => {
          noAnimationPrepared += 1;
          return () => {
            noAnimationFinished += 1;
            setOpen(false);
          };
        },
        onClose: () => { noAnimationFallback += 1; }
      }, ({ requestClose }) => React.createElement("button", {
        id: "no-animation-close",
        ref: closeRef,
        onClick: () => requestClose()
      }, "关闭"));
    }
    const noAnimationHost = document.createElement("div");
    document.body.append(noAnimationHost);
    const noAnimationRoot = createRoot(noAnimationHost);
    await React.act(async () => {
      noAnimationRoot.render(React.createElement(NoAnimationDialog));
      await Promise.resolve();
    });
    const noAnimationClose = document.getElementById("no-animation-close");
    assert.ok(noAnimationClose);
    await React.act(async () => {
      noAnimationClose.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.equal(noAnimationPrepared, 1);
    assert.equal(noAnimationFinished, 1);
    assert.equal(noAnimationFallback, 0);
    assert.equal(document.getElementById("no-animation-close"), null);
    await React.act(async () => noAnimationRoot.unmount());
    noAnimationHost.remove();
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

test("共享 FacetSelector 在原按钮位置内联搜索并保持 Portal 筛选流程", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const frameTimers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextFrame = 1;
  const requestAnimationFrame = (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frameTimers.set(id, setTimeout(() => {
      frameTimers.delete(id);
      callback(Date.now());
    }, 0));
    return id;
  };
  const cancelAnimationFrame = (id: number) => {
    const timer = frameTimers.get(id);
    if (timer) clearTimeout(timer);
    frameTimers.delete(id);
  };
  const matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true
  });
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const visualViewport = new window.EventTarget() as EventTarget & {
    width: number;
    height: number;
    offsetLeft: number;
    offsetTop: number;
  };
  Object.assign(visualViewport, {
    width: 390,
    height: 844,
    offsetLeft: 0,
    offsetTop: 0
  });
  Object.assign(window, {
    innerWidth: 390,
    innerHeight: 844,
    matchMedia,
    requestAnimationFrame,
    cancelAnimationFrame,
    ResizeObserver: TestResizeObserver,
    visualViewport
  });
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    ResizeObserver: TestResizeObserver,
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

  const elementPrototype = window.HTMLElement.prototype;
  const previousFocus = Object.getOwnPropertyDescriptor(elementPrototype, "focus");
  const previousBlur = Object.getOwnPropertyDescriptor(elementPrototype, "blur");
  const previousRect = Object.getOwnPropertyDescriptor(
    elementPrototype,
    "getBoundingClientRect"
  );
  const previousOnInput = Object.getOwnPropertyDescriptor(
    elementPrototype,
    "oninput"
  );
  let controlTop = 100;
  let fixedOriginTop = 0;
  let activeElement = document.body as HTMLElement;
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => activeElement
  });
  Object.defineProperty(elementPrototype, "getBoundingClientRect", {
    configurable: true,
    value: function getBoundingClientRect() {
      if ((this as HTMLElement).hasAttribute("data-anchored-fixed-origin")) {
        return {
          x: 0,
          y: fixedOriginTop,
          left: 0,
          top: fixedOriginTop,
          right: 0,
          bottom: fixedOriginTop,
          width: 0,
          height: 0,
          toJSON() { return this; }
        };
      }
      return {
        x: 20,
        y: controlTop,
        left: 20,
        top: controlTop,
        right: 340,
        bottom: controlTop + 40,
        width: 320,
        height: 40,
        toJSON() { return this; }
      };
    }
  });
  Object.defineProperty(elementPrototype, "oninput", {
    configurable: true,
    writable: true,
    value: null
  });
  Object.defineProperty(elementPrototype, "focus", {
    configurable: true,
    value: function focus() {
      activeElement = this as HTMLElement;
    }
  });
  Object.defineProperty(elementPrototype, "blur", {
    configurable: true,
    value: function blur() {
      if (activeElement === this) activeElement = document.body as HTMLElement;
    }
  });

  const dispatch = (
    target: EventTarget,
    type: string,
    properties: Record<string, unknown> = {}
  ) => {
    const event = new window.Event(type, {
      bubbles: true,
      cancelable: true
    });
    Object.defineProperties(event, Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [
        key,
        { configurable: true, value }
      ])
    ));
    target.dispatchEvent(event);
    return event;
  };
  const reactProps = <T,>(element: Element) => {
    const propsKey = Object.keys(element).find((key) => (
      key.startsWith("__reactProps$")
    ));
    assert.ok(propsKey, "React props 应已绑定到测试元素");
    return (element as unknown as Record<string, T>)[propsKey];
  };
  let nextPointerId = 40;
  const touchActivate = async (button: HTMLButtonElement) => {
    const pointerId = nextPointerId++;
    const rect = button.getBoundingClientRect();
    let pointerDownPrevented = false;
    let pointerUpPrevented = false;
    let activeAfterPointerUp: Element | null = null;
    const activation = reactProps<{
      onPointerDown: (event: {
        currentTarget: HTMLButtonElement;
        pointerId: number;
        pointerType: string;
        isPrimary: boolean;
        button: number;
        clientX: number;
        clientY: number;
        preventDefault: () => void;
      }) => void;
      onPointerUp: (event: {
        currentTarget: HTMLButtonElement;
        pointerId: number;
        pointerType: string;
        isPrimary: boolean;
        button: number;
        clientX: number;
        clientY: number;
        preventDefault: () => void;
      }) => void;
    }>(button);
    await React.act(async () => {
      activation.onPointerDown({
        currentTarget: button,
        pointerId,
        pointerType: "touch",
        isPrimary: true,
        button: 0,
        clientX: rect.left + 1,
        clientY: rect.top + 1,
        preventDefault: () => { pointerDownPrevented = true; }
      });
      activation.onPointerUp({
        currentTarget: button,
        pointerId,
        pointerType: "touch",
        isPrimary: true,
        button: 0,
        clientX: rect.left + 1,
        clientY: rect.top + 1,
        preventDefault: () => { pointerUpPrevented = true; }
      });
      activeAfterPointerUp = document.activeElement;
      await Promise.resolve();
    });
    assert.equal(pointerDownPrevented, true);
    assert.equal(pointerUpPrevented, true);
    return activeAfterPointerUp;
  };
  const finishFacetClose = async (closingMenu: HTMLElement) => {
    assert.equal(closingMenu.classList.contains("is-closing"), true);
    await React.act(async () => {
      reactProps<{
        onAnimationEnd: (event: {
          currentTarget: HTMLElement;
          target: HTMLElement;
        }) => void;
      }>(closingMenu).onAnimationEnd({
        currentTarget: closingMenu,
        target: closingMenu
      });
      await Promise.resolve();
    });
  };

  let setDismissSignal: React.Dispatch<React.SetStateAction<number>> | undefined;
  const observedValues: string[] = [];
  try {
    const { createRoot } = await import("react-dom/client");
    const { FacetSelector } = await import(
      "../../packages/web/src/components/data-display/FacetSelector.tsx"
    );
    const { AnchoredMenuDismissSignalContext } = await import(
      "../../packages/web/src/hooks/useAnchoredMenu.ts"
    );
    function Harness() {
      const [value, setValue] = React.useState("!legacy,!night");
      const [dismissSignal, commitDismissSignal] = React.useState(0);
      setDismissSignal = commitDismissSignal;
      return React.createElement(
        AnchoredMenuDismissSignalContext.Provider,
        { value: dismissSignal },
        React.createElement(FacetSelector, {
          options: [
            { slug: "night", display_name: "夜景" },
            { slug: "stage", display_name: "舞台" },
            { slug: "editorial", display_name: "编辑精选" }
          ],
          value,
          noun: "主题",
          ariaLabel: "主题",
          menuClassName: "public-gallery-menu",
          onChange: (next: string) => {
            observedValues.push(next);
            setValue(next);
          }
        }),
        React.createElement("output", { className: "facet-value" }, value)
      );
    }

    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    let trigger = container.querySelector<HTMLButtonElement>(".select-trigger");
    assert.ok(trigger);
    assert.equal(trigger.textContent, "排除 2 个主题");
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(trigger.querySelector("input"), null);

    const activeAfterOpeningPointerUp = await touchActivate(trigger);
    let search = container.querySelector<HTMLInputElement>(".facet-search-input");
    let collapse = container.querySelector<HTMLButtonElement>(
      ".facet-search-collapse"
    );
    let menu = document.querySelector<HTMLElement>(".facet-select-menu");
    assert.ok(search && collapse && menu);
    assert.equal(container.querySelector(".select-trigger"), null);
    assert.equal(search.closest("button"), null, "搜索框不得嵌套在按钮中");
    assert.equal(search.getAttribute("aria-controls"), menu.id);
    assert.equal(search.hasAttribute("aria-expanded"), false);
    assert.equal(search.hasAttribute("aria-haspopup"), false);
    assert.equal(collapse.getAttribute("aria-label"), "收起主题筛选");
    assert.equal(collapse.getAttribute("aria-controls"), menu.id);
    assert.equal(collapse.getAttribute("aria-expanded"), "true");
    assert.equal(menu.getAttribute("role"), "region");
    assert.equal(menu.getAttribute("aria-label"), "主题筛选选项");
    const searchStatus = container.querySelector<HTMLElement>(
      ".facet-search-status"
    );
    assert.ok(searchStatus);
    assert.equal(search.getAttribute("aria-describedby"), searchStatus.id);
    assert.match(searchStatus.textContent, /按 Tab 浏览已选主题和筛选方式/);
    assert.equal(
      activeAfterOpeningPointerUp,
      search,
      "触摸 pointerup 返回前必须同步挂载并聚焦搜索框，保留 iOS 键盘激活"
    );
    assert.equal(document.activeElement, search);
    assert.deepEqual(
      [...menu.children].map((child) => child.className),
      [
        "facet-search-results",
        "facet-menu-divider",
        "facet-selected-list",
        "facet-mode-switch"
      ]
    );
    assert.match(menu.querySelector(".facet-selected-list")?.textContent ?? "", /legacy/);
    assert.match(menu.querySelector(".facet-selected-list")?.textContent ?? "", /夜景/);

    await React.act(async () => {
      search!.value = "sta";
      reactProps<{ onChange: (event: { target: HTMLInputElement }) => void }>(
        search!
      ).onChange({ target: search! });
      await Promise.resolve();
    });
    let candidate = menu.querySelector<HTMLButtonElement>(".facet-search-option");
    assert.ok(candidate);
    assert.equal(candidate.textContent, "stage舞台");
    assert.equal(searchStatus.textContent, "1 个可添加的主题");

    let tabPrevented = false;
    reactProps<{
      onKeyDown: (event: {
        key: string;
        shiftKey: boolean;
        preventDefault: () => void;
      }) => void;
    }>(search).onKeyDown({
      key: "Tab",
      shiftKey: false,
      preventDefault: () => { tabPrevented = true; }
    });
    assert.equal(tabPrevented, true);
    assert.equal(document.activeElement, candidate);
    tabPrevented = false;
    reactProps<{
      onKeyDown: (event: {
        key: string;
        shiftKey: boolean;
        target: EventTarget;
        preventDefault: () => void;
      }) => void;
    }>(menu).onKeyDown({
      key: "Tab",
      shiftKey: true,
      target: candidate,
      preventDefault: () => { tabPrevented = true; }
    });
    assert.equal(tabPrevented, true);
    assert.equal(document.activeElement, search);

    await touchActivate(candidate);
    assert.equal(
      document.querySelector(".facet-value")?.textContent,
      "!legacy,!night,!stage"
    );
    assert.equal(search.value, "sta", "连续选择期间必须保留搜索词");
    assert.equal(menu.querySelector(".facet-search-option"), null);

    await React.act(async () => {
      search!.value = "edi";
      reactProps<{ onChange: (event: { target: HTMLInputElement }) => void }>(
        search!
      ).onChange({ target: search! });
      await Promise.resolve();
    });
    candidate = menu.querySelector<HTMLButtonElement>(".facet-search-option");
    assert.ok(candidate);
    await React.act(async () => {
      dispatch(candidate!, "click", { detail: 0 });
      await Promise.resolve();
    });
    assert.equal(
      document.querySelector(".facet-value")?.textContent,
      "!legacy,!night,!stage,!editorial"
    );

    const modeButtons = menu.querySelectorAll<HTMLButtonElement>(
      ".facet-mode-switch button"
    );
    assert.equal(modeButtons.length, 2);
    const lastModeButton = modeButtons[1];
    tabPrevented = false;
    reactProps<{
      onKeyDown: (event: {
        key: string;
        shiftKey: boolean;
        target: EventTarget;
        preventDefault: () => void;
      }) => void;
    }>(menu).onKeyDown({
      key: "Tab",
      shiftKey: false,
      target: lastModeButton,
      preventDefault: () => { tabPrevented = true; }
    });
    assert.equal(tabPrevented, true);
    assert.equal(document.activeElement, collapse);
    tabPrevented = false;
    reactProps<{
      onKeyDown: (event: {
        key: string;
        shiftKey: boolean;
        preventDefault: () => void;
      }) => void;
    }>(collapse).onKeyDown({
      key: "Tab",
      shiftKey: true,
      preventDefault: () => { tabPrevented = true; }
    });
    assert.equal(tabPrevented, true);
    assert.equal(document.activeElement, lastModeButton);

    await touchActivate(modeButtons[0]);
    assert.equal(
      document.querySelector(".facet-value")?.textContent,
      "legacy,night,stage,editorial"
    );
    const legacyRemoval = [...menu.querySelectorAll<HTMLButtonElement>(
      ".facet-selected-list button"
    )].find((button) => button.getAttribute("title") === "移除 legacy");
    assert.ok(legacyRemoval);
    await touchActivate(legacyRemoval);
    assert.equal(
      document.querySelector(".facet-value")?.textContent,
      "night,stage,editorial"
    );

    visualViewport.height = 360;
    await React.act(async () => {
      visualViewport.dispatchEvent(new window.Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    assert.ok(document.querySelector(".facet-select-menu"));
    assert.equal(search.value, "edi", "软键盘视口变化不得清空搜索或关闭弹层");
    assert.equal(menu.classList.contains("opens-up"), false);
    assert.ok(Number.parseFloat(menu.style.maxHeight) <= 212);

    controlTop = 300;
    visualViewport.offsetTop = 180;
    fixedOriginTop = -180;
    await React.act(async () => {
      visualViewport.dispatchEvent(new window.Event("scroll"));
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    assert.equal(menu.classList.contains("opens-up"), true);
    const paintedMenuTop = Number.parseFloat(menu.style.top) + fixedOriginTop;
    const paintedMenuBottom = paintedMenuTop
      + Number.parseFloat(menu.style.maxHeight);
    const paintedViewportTop = visualViewport.offsetTop + fixedOriginTop;
    const paintedViewportBottom = paintedViewportTop + visualViewport.height;
    assert.equal(
      paintedMenuBottom,
      controlTop - 6,
      "iOS 键盘平移 fixed 原点后，弹层仍须停在内联搜索框上方"
    );
    assert.ok(
      paintedMenuTop >= paintedViewportTop
      && paintedMenuBottom <= paintedViewportBottom,
      "弹层翻转与 maxHeight 必须使用校正后的可见视口边界"
    );

    visualViewport.offsetTop = 0;
    fixedOriginTop = 0;
    controlTop = 700;
    visualViewport.height = 844;
    await React.act(async () => {
      visualViewport.dispatchEvent(new window.Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    assert.equal(menu.classList.contains("opens-up"), true);
    controlTop = 100;
    await React.act(async () => {
      visualViewport.dispatchEvent(new window.Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    assert.equal(menu.classList.contains("opens-up"), false);

    search.focus();
    await touchActivate(collapse);
    trigger = container.querySelector<HTMLButtonElement>(".select-trigger");
    assert.ok(trigger);
    assert.equal(trigger.textContent, "包含 3 个主题");
    assert.equal(trigger.getAttribute("aria-controls"), menu.id);
    assert.equal(container.querySelector(".facet-search-input"), null);
    assert.ok(document.querySelector(".facet-select-menu.is-closing"));
    await finishFacetClose(menu);
    assert.equal(document.querySelector(".facet-select-menu"), null);
    assert.equal(document.activeElement, trigger, "显式收起后应恢复筛选按钮焦点");
    assert.equal(trigger.hasAttribute("aria-controls"), false);
    const compatibilityClick = dispatch(window, "click", { detail: 1 });
    assert.equal(
      compatibilityClick.defaultPrevented,
      true,
      "触控收起后的兼容 click 不得重开筛选"
    );

    await React.act(async () => {
      dispatch(trigger!, "click", { detail: 0 });
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    search = container.querySelector<HTMLInputElement>(".facet-search-input");
    assert.ok(search);
    assert.equal(search.value, "", "重新展开必须使用已清空的搜索词");
    assert.match(
      document.querySelector(".facet-search-results")?.textContent ?? "",
      /输入关键字搜索主题/
    );
    await React.act(async () => {
      search!.focus();
      setDismissSignal?.((current) => current + 1);
      await Promise.resolve();
    });
    assert.equal(container.querySelector(".facet-search-input"), null);
    assert.ok(container.querySelector(".select-trigger"));
    menu = document.querySelector<HTMLElement>(".facet-select-menu");
    assert.ok(menu);
    await finishFacetClose(menu);
    assert.equal(
      document.activeElement,
      document.body,
      "页眉或移动筛选面板自动收起时不得把焦点送回即将隐藏的按钮"
    );

    trigger = container.querySelector<HTMLButtonElement>(".select-trigger");
    await React.act(async () => {
      dispatch(trigger!, "click", { detail: 0 });
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    search = container.querySelector<HTMLInputElement>(".facet-search-input");
    assert.ok(search);
    await React.act(async () => {
      dispatch(document, "keydown", { key: "Escape", shiftKey: false });
      await Promise.resolve();
    });
    menu = document.querySelector<HTMLElement>(".facet-select-menu");
    assert.ok(menu);
    await finishFacetClose(menu);
    trigger = container.querySelector<HTMLButtonElement>(".select-trigger");
    assert.ok(trigger);
    assert.equal(document.activeElement, trigger, "Escape 收起后应恢复按钮焦点");

    await React.act(async () => root.unmount());
    assert.deepEqual(observedValues, [
      "!legacy,!night,!stage",
      "!legacy,!night,!stage,!editorial",
      "legacy,night,stage,editorial",
      "night,stage,editorial"
    ]);
  } finally {
    for (const timer of frameTimers.values()) clearTimeout(timer);
    if (previousFocus) {
      Object.defineProperty(elementPrototype, "focus", previousFocus);
    } else {
      delete (elementPrototype as unknown as Record<string, unknown>).focus;
    }
    if (previousBlur) {
      Object.defineProperty(elementPrototype, "blur", previousBlur);
    } else {
      delete (elementPrototype as unknown as Record<string, unknown>).blur;
    }
    if (previousRect) {
      Object.defineProperty(elementPrototype, "getBoundingClientRect", previousRect);
    } else {
      delete (elementPrototype as unknown as Record<string, unknown>)
        .getBoundingClientRect;
    }
    if (previousOnInput) {
      Object.defineProperty(elementPrototype, "oninput", previousOnInput);
    } else {
      delete (elementPrototype as unknown as Record<string, unknown>).oninput;
    }
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

test("后台筛选布局按容器宽度选择字段分组", () => {
  assert.deepEqual(
    imageAdminFilterDomGroups(false),
    {
      primary: ["device", "brightness", "theme"],
      secondary: ["tag", "author"]
    },
    "后台单行与移动布局必须保持设备、亮度、主题、标签、作者的 DOM 顺序"
  );
  assert.deepEqual(
    imageAdminFilterDomGroups(true),
    {
      primary: ["device", "brightness", "author"],
      secondary: ["theme", "tag"]
    },
    "后台双行必须把作者放在首行，并让主题与标签依次位于第二行"
  );
  assert.equal(imageAdminDoubleRowMaxWidth, 947);
  assert.equal(isImageAdminDoubleRowWidth(0), false);
  assert.equal(isImageAdminDoubleRowWidth(946.99), true);
  assert.equal(isImageAdminDoubleRowWidth(947), true);
  assert.equal(isImageAdminDoubleRowWidth(947.01), false);
  assert.equal(isImageAdminDoubleRowWidth(948), false);
});

test("公开图库与后台图片筛选在清空动作临界视口真实挂载并保持无障碍名称与搜索交互边界", async () => {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { PublicImageToolbar, randomLinkNeedsTruncation } = await import(
    "../../packages/web/src/components/navigation/PublicImageToolbar.tsx"
  );
  const { ImageAdminFilters } = await import(
    "../../packages/web/src/pages/admin/images/ImageAdminFilters.tsx"
  );
  const filters = {
    device: "",
    brightness: "",
    theme: "",
    tag: "",
    author: ""
  };
  const randomUrl = "https://img.example/random";
  assert.equal(randomLinkNeedsTruncation(120, 120), false);
  assert.equal(randomLinkNeedsTruncation(120.5, 120), false);
  assert.equal(randomLinkNeedsTruncation(120.6, 120), true);
  assert.equal(randomLinkNeedsTruncation(240, 0), false);
  const facets = {
    devices: ["pc", "mb"],
    brightnesses: ["light", "dark"],
    themes: [{ slug: "night", display_name: "夜景" }],
    tags: [{ slug: "blue", display_name: "蓝色" }],
    authors: [{ slug: "camera", display_name: "摄影师", link: "" }]
  };
  const vocabulary: IngestionVocabularyDto = {
    themes: facets.themes,
    tags: facets.tags,
    authors: facets.authors
  };
  const fieldIds = [
    "gallery-theme-facet",
    "gallery-tag-facet",
    "gallery-author-facet",
    "admin-image-theme-facet",
    "admin-image-tag-facet",
    "admin-image-author-facet"
  ];
  const structures: string[][] = [];

  for (const width of [760, 761, 999, 1000, 1389, 1390]) {
    const { window, document } = parseHTML(
      "<!doctype html><html><body><div id=root></div></body></html>"
    );
    const frameTimers = new Map<number, ReturnType<typeof setTimeout>>();
    let nextFrame = 1;
    const requestAnimationFrame = (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frameTimers.set(id, setTimeout(() => {
        frameTimers.delete(id);
        callback(Date.now());
      }, 0));
      return id;
    };
    const cancelAnimationFrame = (id: number) => {
      const timer = frameTimers.get(id);
      if (timer) clearTimeout(timer);
      frameTimers.delete(id);
    };
    const matchMedia = (query: string) => {
      const maxWidth = /max-width:\s*(\d+)px/.exec(query)?.[1];
      const minWidth = /min-width:\s*(\d+)px/.exec(query)?.[1];
      const widthConstrained = Boolean(maxWidth || minWidth);
      return {
        matches: query.includes("prefers-reduced-motion")
          || widthConstrained
            && (maxWidth ? width <= Number(maxWidth) : true)
            && (minWidth ? width >= Number(minWidth) : true),
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => true
      };
    };
    class TestResizeObserver {
      static callbacks = new Set<() => void>();
      readonly callback: () => void;

      constructor(callback: () => void) {
        this.callback = callback;
        TestResizeObserver.callbacks.add(callback);
      }

      static notify() {
        for (const callback of TestResizeObserver.callbacks) callback();
      }

      observe() {}
      unobserve() {}
      disconnect() { TestResizeObserver.callbacks.delete(this.callback); }
    }
    const visualViewport = new window.EventTarget() as EventTarget & {
      width: number;
      height: number;
      offsetLeft: number;
      offsetTop: number;
    };
    Object.assign(visualViewport, {
      width,
      height: 844,
      offsetLeft: 0,
      offsetTop: 0
    });
    Object.assign(window, {
      innerWidth: width,
      innerHeight: 844,
      matchMedia,
      requestAnimationFrame,
      cancelAnimationFrame,
      ResizeObserver: TestResizeObserver,
      visualViewport
    });
    const installedGlobals = {
      window,
      self: window,
      document,
      navigator: window.navigator,
      Node: window.Node,
      Element: window.Element,
      HTMLElement: window.HTMLElement,
      HTMLButtonElement: window.HTMLButtonElement,
      HTMLInputElement: window.HTMLInputElement,
      Event: window.Event,
      EventTarget: window.EventTarget,
      MutationObserver: window.MutationObserver,
      ResizeObserver: TestResizeObserver,
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

    const elementPrototype = window.HTMLElement.prototype;
    const previousFocus = Object.getOwnPropertyDescriptor(elementPrototype, "focus");
    const previousBlur = Object.getOwnPropertyDescriptor(elementPrototype, "blur");
    const previousRect = Object.getOwnPropertyDescriptor(
      elementPrototype,
      "getBoundingClientRect"
    );
    let activeElement = document.body as HTMLElement;
    Object.defineProperty(document, "activeElement", {
      configurable: true,
      get: () => activeElement
    });
    Object.defineProperty(elementPrototype, "focus", {
      configurable: true,
      value: function focus() { activeElement = this as HTMLElement; }
    });
    Object.defineProperty(elementPrototype, "blur", {
      configurable: true,
      value: function blur() {
        if (activeElement === this) activeElement = document.body as HTMLElement;
      }
    });
    Object.defineProperty(elementPrototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 20,
        y: 100,
        left: 20,
        top: 100,
        right: Math.max(320, width - 20),
        bottom: 140,
        width: Math.max(300, width - 40),
        height: 40,
        toJSON() { return this; }
      })
    });
    const dispatch = (
      target: EventTarget,
      type: string,
      properties: Record<string, unknown> = {}
    ) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [
          key,
          { configurable: true, value }
        ])
      ));
      target.dispatchEvent(event);
      return event;
    };

    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    let galleryClearCalls = 0;
    let adminClearCalls = 0;
    const galleryFilterChanges: string[] = [];
    const adminFilterChanges: string[] = [];
    let setGalleryHarnessFilters: ((next: typeof filters) => void) | undefined;
    let setAdminHarnessFilters: ((next: typeof filters) => void) | undefined;
    let setAdminHarnessDisabled: ((next: boolean) => void) | undefined;
    try {
      const mobileLayout = window.matchMedia("(max-width: 760px)").matches;
      assert.equal(mobileLayout, width === 760);
      function Harness() {
        const [galleryFilters, setGalleryFilters] = React.useState(filters);
        const [adminFilters, setAdminFilters] = React.useState(filters);
        const [adminDisabled, setAdminDisabled] = React.useState(false);
        const [galleryDismissSignal, setGalleryDismissSignal] = React.useState(0);
        const toolbarRef = React.useRef<HTMLElement | null>(null);
        const galleryToggleRef = React.useRef<HTMLButtonElement | null>(null);
        const galleryClearRef = React.useRef<HTMLButtonElement | null>(null);
        const galleryPanelRef = React.useRef<HTMLDivElement | null>(null);
        setGalleryHarnessFilters = setGalleryFilters;
        setAdminHarnessFilters = setAdminFilters;
        setAdminHarnessDisabled = setAdminDisabled;
        return React.createElement(
          "main",
          null,
          React.createElement(PublicImageToolbar, {
            filters: galleryFilters,
            facets,
            randomUrl,
            filtersOpen: mobileLayout,
            filterPanelHidden: mobileLayout ? false : undefined,
            filterMenuDismissSignal: galleryDismissSignal,
            toolbarVisible: true,
            toolbarRef,
            filterToggleRef: galleryToggleRef,
            clearFiltersRef: galleryClearRef,
            filterPanelRef: galleryPanelRef,
            toggleFilters() {},
            dismissFilterMenus() {
              setGalleryDismissSignal((current) => current + 1);
            },
            onFilterChange(key, value) {
              galleryFilterChanges.push(`${key}:${value}`);
              setGalleryFilters((current) => ({ ...current, [key]: value }));
            },
            onClearFilters() {
              galleryClearCalls += 1;
              setGalleryFilters({ ...filters });
            }
          }),
          React.createElement(ImageAdminFilters, {
            value: adminFilters,
            vocabulary,
            view: "ready",
            mobileLayout,
            disabled: adminDisabled,
            onChange(key, value) {
              adminFilterChanges.push(`${key}:${value}`);
              setAdminFilters((current) => ({ ...current, [key]: value }));
            },
            onClear() {
              adminClearCalls += 1;
              setAdminFilters({ ...filters });
            }
          })
        );
      }
      await React.act(async () => {
        root.render(React.createElement(Harness));
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      if (mobileLayout) {
        const adminToggle = container.querySelector<HTMLButtonElement>(
          ".image-list-filter-toggle"
        );
        assert.ok(adminToggle);
        await React.act(async () => {
          dispatch(adminToggle, "click", { detail: 1 });
          await Promise.resolve();
        });
      }

      const galleryClear = container.querySelector<HTMLButtonElement>(
        ".gallery-filter-clear"
      );
      const adminClear = container.querySelector<HTMLButtonElement>(
        ".image-list-filter-clear"
      );
      assert.ok(galleryClear && adminClear);
      assert.equal(galleryClear.disabled, true);
      assert.equal(adminClear.disabled, true);
      assert.equal(galleryClear.textContent?.trim(), mobileLayout ? "清空" : "清空筛选");
      assert.equal(adminClear.textContent?.trim(), "清空");
      assert.equal(
        container.querySelector(".generated-link-field code > span")?.textContent,
        randomUrl
      );
      const randomLinkViewport = container.querySelector<HTMLElement>(
        ".generated-link-value"
      );
      const randomLinkText = container.querySelector<HTMLElement>(
        ".generated-link-text"
      );
      assert.ok(randomLinkViewport && randomLinkText);
      let randomLinkAvailableWidth = 120;
      let randomLinkContentWidth = 240;
      Object.defineProperty(randomLinkViewport, "clientWidth", {
        configurable: true,
        get: () => randomLinkAvailableWidth
      });
      Object.defineProperty(randomLinkText, "scrollWidth", {
        configurable: true,
        get: () => randomLinkContentWidth
      });
      await React.act(async () => TestResizeObserver.notify());
      assert.equal(randomLinkViewport.classList.contains("is-truncated"), true);
      assert.equal(randomLinkViewport.title, randomUrl);
      assert.equal(
        randomLinkViewport.querySelector(".generated-link-truncation")?.textContent,
        "..."
      );
      assert.doesNotMatch(randomLinkViewport.textContent ?? "", /…/u);

      const selections: Node[] = [];
      Object.defineProperty(document, "getSelection", { configurable: true, value: () => ({
        selectAllChildren: (node: Node) => selections.push(node)
      }) });
      assert.equal(randomLinkViewport.getAttribute("role"), "textbox");
      assert.equal(randomLinkViewport.getAttribute("aria-readonly"), "true");
      assert.equal(container.querySelector(".generated-link-label")?.textContent, "随机API");
      await React.act(async () => {
        dispatch(randomLinkViewport, "pointerdown", { button: 0 });
        randomLinkViewport.focus();
        dispatch(randomLinkViewport, "focusin");
        dispatch(randomLinkViewport, "click");
      });
      assert.ok(selections.length > 0);
      assert.ok(selections.every((node) => node === randomLinkText), "选区只包含完整 URL，不含标签或截断标记");
      const firstSelectionCount = selections.length;
      await React.act(async () => {
        dispatch(randomLinkViewport, "pointerdown", { button: 0 });
        dispatch(randomLinkViewport, "click");
      });
      assert.equal(selections.length, firstSelectionCount, "再次点击不覆盖浏览器局部选区");
      await React.act(async () => {
        randomLinkViewport.blur();
        dispatch(randomLinkViewport, "focusout");
      });

      randomLinkContentWidth = randomLinkAvailableWidth;
      await React.act(async () => TestResizeObserver.notify());
      assert.equal(randomLinkViewport.classList.contains("is-truncated"), false);
      assert.equal(randomLinkViewport.hasAttribute("title"), false);
      assert.equal(
        randomLinkViewport.querySelector(".generated-link-truncation"),
        null
      );

      const galleryPanel = container.querySelector<HTMLElement>(
        ".gallery-filter-panel"
      );
      if (mobileLayout && !container.querySelector(".image-list-filter-bar.filters-open")) {
        await React.act(async () => dispatch(container.querySelector(".image-list-filter-toggle")!, "click"));
      }
      const adminPanel = container.querySelector<HTMLElement>(
        ".image-list-filter-panel"
      );
      assert.ok(galleryPanel && adminPanel);
      const galleryPanelOrder = [...galleryPanel.children].map((child) => (
        child.className
      ));
      if (mobileLayout) {
        const galleryActions = container.querySelector<HTMLElement>(
          ".gallery-filter-actions"
        );
        const adminActions = container.querySelector<HTMLElement>(
          ".image-list-filter-actions"
        );
        assert.ok(galleryActions && adminActions);
        assert.deepEqual(
          [...galleryActions.children].map((child) => child.tagName),
          ["BUTTON", "SPAN", "BUTTON"]
        );
        assert.deepEqual(
          [...adminActions.children].map((child) => child.tagName),
          ["BUTTON", "SPAN", "BUTTON"]
        );
        for (const divider of container.querySelectorAll(
          ".gallery-filter-action-divider, .image-list-filter-action-divider"
        )) {
          assert.equal(divider.getAttribute("aria-hidden"), "true");
          assert.equal(divider.hasAttribute("role"), false);
        }
        assert.deepEqual(galleryPanelOrder, ["gallery-filter-fields", "theme-link"]);
        assert.equal(
          container.querySelector(".image-list-filter-bar")?.classList.contains(
            "filters-open"
          ),
          true
        );
      } else {
        assert.equal(
          container.querySelectorAll(
            ".gallery-filter-action-divider, .image-list-filter-action-divider"
          ).length,
          0
        );
        assert.deepEqual(
          galleryPanelOrder,
          width < 1000
            ? ["gallery-filter-fields", "theme-link", "gallery-filter-action"]
            : ["gallery-filter-fields", "gallery-filter-action", "theme-link"]
        );
        assert.equal(
          adminPanel.lastElementChild?.classList.contains("image-list-filter-action"),
          true
        );
      }

      const controls = [...container.querySelectorAll<HTMLElement>(
        ".facet-select-control"
      )];
      assert.equal(controls.length, 6);
      assert.equal(document.querySelector(".facet-search-input"), null);
      for (const id of fieldIds) {
        const target = document.getElementById(id);
        assert.equal(container.querySelector(`label[for="${id}"]`), null);
        assert.ok(target?.getAttribute("aria-label"), `${width}px 下 ${id} 必须保留无障碍名称`);
        assert.equal(target.tagName, "BUTTON");
        assert.equal(target.classList.contains("select-trigger"), true);
        assert.equal(target.hasAttribute("aria-controls"), false);
        assert.equal(target.hasAttribute("aria-haspopup"), false);
      }
      structures.push(controls.map((control) => (
        [...control.children]
          .map((child) => `${child.tagName}.${child.className}`)
          .join(">")
      )));

      for (const id of ["gallery-theme-facet", "admin-image-theme-facet"]) {
        const trigger = document.getElementById(id) as HTMLButtonElement | null;
        assert.ok(trigger);
        const accessibleName = trigger.getAttribute("aria-label");
        await React.act(async () => {
          dispatch(trigger, "click", { detail: 0 });
          await new Promise((resolve) => setTimeout(resolve, 5));
        });
        const search = document.getElementById(id) as HTMLInputElement | null;
        assert.ok(search);
        const menuId = search.getAttribute("aria-controls");
        assert.ok(menuId);
        const menu = document.getElementById(menuId);
        const collapse = container.querySelector<HTMLButtonElement>(
          `#${id} + .facet-search-status + .facet-search-collapse`
        );
        assert.ok(menu && collapse);
        assert.equal(menu.getAttribute("role"), "region");
        assert.equal(search.hasAttribute("aria-expanded"), false);
        assert.equal(collapse.getAttribute("aria-expanded"), "true");

        assert.equal(search.getAttribute("aria-label"), `搜索${accessibleName}`);
        assert.equal(document.getElementById(id), search);
        assert.ok(document.getElementById(menuId));
        search.focus();
        assert.equal(document.activeElement, search);

        await React.act(async () => {
          dispatch(document, "keydown", { key: "Escape", shiftKey: false });
          await Promise.resolve();
        });
        const restoredTrigger = document.getElementById(id);
        assert.ok(restoredTrigger);
        assert.equal(restoredTrigger.tagName, "BUTTON");
        assert.equal(restoredTrigger.hasAttribute("aria-controls"), false);
        await React.act(async () => {
          dispatch(menu, "animationend");
          await Promise.resolve();
        });
      }

      const populatedFilters = {
        device: "pc",
        brightness: "dark",
        theme: "night",
        tag: "blue",
        author: "camera"
      };
      assert.ok(setGalleryHarnessFilters && setAdminHarnessFilters);
      await React.act(async () => {
        setGalleryHarnessFilters?.(populatedFilters);
        setAdminHarnessFilters?.(populatedFilters);
        await Promise.resolve();
      });
      assert.equal(galleryClear.disabled, false);
      assert.equal(adminClear.disabled, false);

      if (
        mobileLayout
        && !container.querySelector(".image-list-filter-bar")?.classList.contains(
          "filters-open"
        )
      ) {
        const adminToggle = container.querySelector<HTMLButtonElement>(
          ".image-list-filter-toggle"
        );
        assert.ok(adminToggle);
        await React.act(async () => {
          dispatch(adminToggle, "click", { detail: 1 });
          await Promise.resolve();
        });
      }

      const adminThemeTrigger = document.getElementById(
        "admin-image-theme-facet"
      ) as HTMLButtonElement | null;
      assert.ok(adminThemeTrigger);
      await React.act(async () => {
        dispatch(adminThemeTrigger, "click", { detail: 0 });
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      const openAdminSearch = document.getElementById(
        "admin-image-theme-facet"
      ) as HTMLInputElement | null;
      assert.ok(openAdminSearch);
      const openAdminMenuId = openAdminSearch.getAttribute("aria-controls");
      assert.ok(openAdminMenuId);
      const openAdminMenu = document.getElementById(openAdminMenuId);
      assert.ok(openAdminMenu);

      await React.act(async () => {
        dispatch(adminClear, "click", { detail: 1 });
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      assert.equal(adminClearCalls, 1);
      assert.deepEqual(adminFilterChanges, []);
      assert.equal(adminClear.disabled, true);
      assert.equal(
        openAdminMenu.isConnected
          ? openAdminMenu.classList.contains("is-closing")
          : true,
        true,
        "清空必须收起已打开的后台 Facet 子菜单"
      );
      if (mobileLayout) {
        assert.equal(
          container.querySelector(".image-list-filter-bar")?.classList.contains(
            "filters-open"
          ),
          true,
          "移动后台清空不得关闭外层筛选面板"
        );
      }

      await React.act(async () => {
        dispatch(galleryClear, "click", { detail: 1 });
        await Promise.resolve();
      });
      assert.equal(galleryClearCalls, 1);
      assert.deepEqual(galleryFilterChanges, []);
      assert.equal(galleryClear.disabled, true);
      if (mobileLayout) {
        assert.equal(
          container.querySelector(".gallery-toolbar")?.classList.contains(
            "filters-open"
          ),
          true,
          "移动画廊清空不得关闭外层筛选面板"
        );
      }

      assert.ok(setAdminHarnessDisabled);
      await React.act(async () => {
        setAdminHarnessFilters?.(populatedFilters);
        setAdminHarnessDisabled?.(true);
        await Promise.resolve();
      });
      assert.equal(adminClear.disabled, true);
      assert.equal(
        container.querySelector<HTMLButtonElement>(
          ".image-list-filter-toggle"
        )?.disabled,
        true,
        "后台忙碌态必须同时禁用筛选与清空"
      );
    } finally {
      await React.act(async () => root.unmount());
      for (const timer of frameTimers.values()) clearTimeout(timer);
      if (previousFocus) {
        Object.defineProperty(elementPrototype, "focus", previousFocus);
      } else {
        delete (elementPrototype as unknown as Record<string, unknown>).focus;
      }
      if (previousBlur) {
        Object.defineProperty(elementPrototype, "blur", previousBlur);
      } else {
        delete (elementPrototype as unknown as Record<string, unknown>).blur;
      }
      if (previousRect) {
        Object.defineProperty(elementPrototype, "getBoundingClientRect", previousRect);
      } else {
        delete (elementPrototype as unknown as Record<string, unknown>)
          .getBoundingClientRect;
      }
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) {
          Object.defineProperty(globalThis, key, descriptor);
        } else {
          delete (globalThis as Record<string, unknown>)[key];
        }
      }
    }
  }
  for (const structure of structures.slice(1)) {
    assert.deepEqual(
      structure,
      structures[0],
      "所有清空动作临界视口都不得切换 FacetSelector DOM"
    );
  }
});

test("后台偏好五分钟内聚焦零请求且首次过期重验证命中 304", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const localStorageValues = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageValues.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageValues.delete(key);
    }
  };
  Object.assign(window, { localStorage });
  let preferenceReads = 0;
  let preferenceWrites = 0;
  const preferenceEtag = 'W/"preference-focus-v1"';
  const updatedPreferenceEtag = 'W/"preference-focus-v2"';
  const fetchStub = async (
    input: RequestInfo | URL,
    init: RequestInit = {}
  ) => {
    const url = new URL(String(input), "https://imageshow.test");
    assert.equal(url.pathname, "/api/admin/preferences");
    if (init.method === "PATCH") {
      preferenceWrites += 1;
      return new Response(JSON.stringify({
        ok: true,
        preferences: { color_scheme: "light" }
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          etag: updatedPreferenceEtag
        }
      });
    }
    preferenceReads += 1;
    assert.equal(
      new Headers(init.headers).get("if-none-match"),
      preferenceEtag,
      "首次偏好 GET 必须复用 /auth/me 提供的验证器"
    );
    return new Response(null, {
      status: 304,
      headers: { etag: preferenceEtag }
    });
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
    localStorage,
    fetch: fetchStub,
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
    const {
      focusManager,
      QueryClient,
      QueryClientProvider
    } = await import("@tanstack/react-query");
    const { AdminPreferencesProvider, useAdminPreference } = await import(
      "../../packages/web/src/hooks/useAdminPreferences.tsx"
    );
    const username = "preference-focus-test";
    const initialUpdatedAt = Date.now();
    const queryKey = [...queryKeys.adminPreferences, username] as const;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
    client.setQueryData(queryKeys.me, {
      authenticated: true,
      username,
      role: "super",
      permissions: [],
      csrf_token: "preference-focus-token",
      application_version: "current-test",
      preferences: { color_scheme: "dark" },
      preferences_etag: preferenceEtag,
      version_settings: { enabled: true, link_enabled: true }
    });
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    let setColorScheme: ((value: "light" | "dark" | "system") => void)
      | undefined;

    function PreferenceProbe() {
      const [, setPreference] = useAdminPreference("color_scheme");
      setColorScheme = setPreference;
      return React.createElement("span", null, "ready");
    }

    await React.act(async () => {
      root.render(React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          AdminPreferencesProvider,
          {
            username,
            serverPreferences: { color_scheme: "dark" },
            serverPreferencesEtag: preferenceEtag,
            serverPreferencesUpdatedAt: initialUpdatedAt
          },
          React.createElement(PreferenceProbe)
        )
      ));
      await Promise.resolve();
    });
    assert.equal(preferenceReads, 0, "认证首帧快照新鲜时不得追加偏好 GET");

    await React.act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await Promise.resolve();
    });
    assert.equal(preferenceReads, 0, "五分钟内重新聚焦不得读取偏好");

    const current = client.getQueryData(queryKey);
    assert.ok(current);
    client.setQueryData(queryKey, current, {
      updatedAt: initialUpdatedAt - 5 * 60 * 1000 - 1
    });
    await React.act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      for (let attempt = 0; attempt < 20 && preferenceReads === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    assert.equal(preferenceReads, 1, "过期快照应在重新聚焦时重验证一次");
    assert.deepEqual(client.getQueryData(queryKey), {
      preferences: { color_scheme: "dark" },
      etag: preferenceEtag
    }, "304 应继续使用认证首帧的偏好快照");

    let authReadAborted = false;
    let authReadStarted = false;
    const staleAuthRead = client.fetchQuery({
      queryKey: queryKeys.me,
      staleTime: 0,
      queryFn: ({ signal }) => new Promise<never>((_resolve, reject) => {
        authReadStarted = true;
        signal.addEventListener("abort", () => {
          authReadAborted = true;
          reject(signal.reason);
        }, { once: true });
      })
    }).catch(() => undefined);
    assert.equal(authReadStarted, true);
    await React.act(async () => {
      setColorScheme?.("light");
      for (let attempt = 0; attempt < 30 && preferenceWrites === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    await staleAuthRead;
    assert.equal(preferenceWrites, 1);
    assert.equal(
      authReadAborted,
      true,
      "偏好 PATCH 必须取消可能携带旧偏好和 ETag 的在途 /auth/me"
    );
    assert.deepEqual(client.getQueryData(queryKeys.me), {
      authenticated: true,
      username,
      role: "super",
      permissions: [],
      csrf_token: "preference-focus-token",
      application_version: "current-test",
      preferences: { color_scheme: "light" },
      preferences_etag: updatedPreferenceEtag,
      version_settings: { enabled: true, link_enabled: true }
    });
    await React.act(async () => root.unmount());
    client.clear();
    focusManager.setFocused(undefined);
  } finally {
    const { focusManager } = await import("@tanstack/react-query");
    focusManager.setFocused(undefined);
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

test("API 拒绝损坏成功响应且保留已有查询快照和安全 HTTP 错误", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  const originalFetch = globalThis.fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    for (const body of ["<html>proxy-private-body</html>", '{"site":', "", "   "]) {
      globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
      const assertSafeError = (error: unknown) => {
        assert.ok(error instanceof ApiClientError);
        assert.equal(error.status, 200);
        assert.equal(error.code, "invalid_json_response");
        assert.equal(error.message, "服务器响应不是有效的 JSON");
        assert.deepEqual(error.details, {});
        return true;
      };
      await assert.rejects(client.fetchQuery({
        queryKey: queryKeys.siteConfig,
        queryFn: () => api("/api/site-config")
      }), assertSafeError);
      assert.equal(client.getQueryData(queryKeys.siteConfig), undefined);
      assert.equal(client.getQueryState(queryKeys.siteConfig)?.status, "error");
      await assert.rejects(apiWithEtag("/api/site-config"), assertSafeError);
    }
    const prior = { site: { title: "可用快照" } };
    client.setQueryData(queryKeys.siteConfig, prior, { updatedAt: 123 });
    await assert.rejects(client.fetchQuery({
      queryKey: queryKeys.siteConfig, queryFn: () => api("/api/site-config"), staleTime: 0
    }));
    assert.strictEqual(client.getQueryData(queryKeys.siteConfig), prior);
    assert.equal(client.getQueryState(queryKeys.siteConfig)?.dataUpdatedAt, 123);
    for (const value of [{ ok: true, items: [] }, [1, 2], null]) {
      globalThis.fetch = (async () => Response.json(value)) as typeof fetch;
      assert.deepEqual(await api("/api/site-config"), value);
    }
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    assert.deepEqual(await api("/api/security-reports", { method: "POST" }), {});
    globalThis.fetch = (async () => new Response("<html>private proxy error</html>", { status: 502 })) as typeof fetch;
    await assert.rejects(api("/api/site-config"), (error: unknown) => {
      assert.ok(error instanceof ApiClientError);
      assert.equal(error.message, "HTTP 502");
      assert.equal(error.status, 502);
      assert.deepEqual(error.details, {});
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
    client.clear();
  }
});

test("条件读取只让 304 复用旧 ETag，新的 200 表示必须自带验证器", async () => {
  const previousFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const validators: Array<string | null> = [];
  let request = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (_input: unknown, init: RequestInit = {}) => {
      validators.push(new Headers(init.headers).get("if-none-match"));
      request += 1;
      if (request === 1) {
        return new Response(JSON.stringify({ ok: true, value: "new" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(null, { status: 304 });
    }
  });
  try {
    const replaced = await apiWithEtag<{ ok: true; value: string }>(
      "/api/admin/etag-contract",
      {},
      { etag: 'W/"old"', data: { ok: true, value: "old" } }
    );
    assert.deepEqual(replaced, {
      data: { ok: true, value: "new" },
      etag: ""
    });
    const unchanged = await apiWithEtag<{ ok: true; value: string }>(
      "/api/admin/etag-contract",
      {},
      { etag: 'W/"current"', data: { ok: true, value: "cached" } }
    );
    assert.deepEqual(unchanged, {
      data: { ok: true, value: "cached" },
      etag: 'W/"current"'
    });
    assert.deepEqual(validators, ['W/"old"', 'W/"current"']);
  } finally {
    if (previousFetch) {
      Object.defineProperty(globalThis, "fetch", previousFetch);
    } else {
      delete (globalThis as { fetch?: unknown }).fetch;
    }
  }
});

test("后台模块预加载只响应可执行意图并复用页面生命周期请求", async () => {
  let immediatePreloads = 0;
  const immediateBindings = preloadIntentProps(() => {
    immediatePreloads += 1;
  });
  immediateBindings.onPointerEnter?.();
  immediateBindings.onFocus?.();
  immediateBindings.onPointerDown?.();
  assert.equal(immediatePreloads, 3);

  assert.deepEqual(adminRoutePreloadPolicies.advancedConfig, {
    hover: "dwell",
    delayMs: 150
  });
  for (const [route, policy] of Object.entries(adminRoutePreloadPolicies)) {
    if (route !== "advancedConfig") assert.deepEqual(policy, { hover: "immediate" });
  }

  let importCount = 0;
  let finishImport!: (value: { page: string }) => void;
  const pendingImport = new Promise<{ page: string }>((resolve) => {
    finishImport = resolve;
  });
  const loadModule = createPageLifetimeModuleLoader(() => {
    importCount += 1;
    return pendingImport;
  });
  const firstLoad = loadModule();
  const navigationLoad = loadModule();
  assert.strictEqual(navigationLoad, firstLoad);
  assert.equal(importCount, 1);
  finishImport({ page: "advanced-config" });
  assert.deepEqual(await firstLoad, { page: "advanced-config" });
  assert.strictEqual(loadModule(), firstLoad);

  let retryImportCount = 0;
  const attempts: Array<{
    resolve: (value: { page: string }) => void;
    reject: (error: Error) => void;
  }> = [];
  const retryableLoader = createPublicRouteModuleLoader(() => {
    retryImportCount += 1;
    return new Promise<{ page: string }>((resolve, reject) => {
      attempts.push({ resolve, reject });
    });
  });
  retryableLoader.preload();
  retryableLoader.preload();
  const routeNavigation = retryableLoader.load();
  assert.equal(retryImportCount, 1);
  attempts[0]!.reject(new Error("passive preload failed"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(retryableLoader.passivePreloadFailed(), true);
  assert.equal(retryImportCount, 2);
  attempts[1]!.resolve({ page: "gallery" });
  assert.deepEqual(await routeNavigation, { page: "gallery" });
  assert.equal(retryableLoader.passivePreloadFailed(), false);
  assert.deepEqual(await retryableLoader.load(), { page: "gallery" });
  assert.equal(retryImportCount, 2);

  let documentReloads = 0;
  let rejectCompletedPreload!: (error: Error) => void;
  let completedPreloadImports = 0;
  const completedFailureLoader = createPublicRouteModuleLoader(() => {
    completedPreloadImports += 1;
    return new Promise<{ page: string }>((_resolve, reject) => {
      rejectCompletedPreload = reject;
    });
  });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { location: { reload: () => { documentReloads += 1; } } }
  });
  try {
    completedFailureLoader.preload();
    rejectCompletedPreload(new Error("completed passive preload failed"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const recovery = completedFailureLoader.load();
    assert.ok(recovery instanceof Promise);
    assert.equal(documentReloads, 1);
    assert.equal(
      completedPreloadImports,
      1,
      "已缓存失败不能在当前文档重试同一原生模块"
    );
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      delete (globalThis as Record<string, unknown>).window;
    }
  }

  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  Object.assign(window, {
    matchMedia: (query: string) => ({
      matches: query === "(hover: hover) and (pointer: fine)",
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true
    })
  });
  const React = await import("react");
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
    let dwellPreloads = 0;
    let bindings: ReturnType<typeof usePreloadIntentProps> | undefined;
    function Harness() {
      bindings = usePreloadIntentProps(() => {
        dwellPreloads += 1;
      }, adminRoutePreloadPolicies.advancedConfig);
      return React.createElement("button", bindings, "高级配置");
    }

    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });
    assert.ok(bindings);

    bindings.onPointerEnter({ pointerType: "mouse" } as never);
    await new Promise((resolve) => setTimeout(resolve, 60));
    bindings.onPointerLeave();
    await new Promise((resolve) => setTimeout(resolve, 110));
    assert.equal(dwellPreloads, 0, "短暂 hover 必须可取消");

    bindings.onPointerEnter({ pointerType: "touch" } as never);
    await new Promise((resolve) => setTimeout(resolve, 170));
    assert.equal(dwellPreloads, 0, "触摸进入不应伪装成 hover 意图");

    bindings.onPointerEnter({ pointerType: "mouse" } as never);
    await new Promise((resolve) => setTimeout(resolve, 170));
    assert.equal(dwellPreloads, 1, "持续鼠标 hover 应达到 dwell 门槛");

    bindings.onFocus();
    assert.equal(dwellPreloads, 2, "键盘 focus 应立即预加载");
    bindings.onPointerEnter({ pointerType: "mouse" } as never);
    bindings.onPointerDown();
    await new Promise((resolve) => setTimeout(resolve, 170));
    assert.equal(dwellPreloads, 3, "pointerdown 应立即加载并取消待定 dwell");

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

test("持久排序模型统一固定项、键盘移动、拖拽位置和分页焦点", () => {
  const entries = ["fixed", "one", "two", "three"].map((slug) => ({ slug }));
  const getKey = (entry: { slug: string }) => entry.slug;
  const isFixed = (entry: { slug: string }) => entry.slug === "fixed";

  assert.equal(
    reorderItemByDirection(entries, "one", "previous", getKey, isFixed).moved,
    false
  );
  const keyboard = reorderItemByDirection(
    entries,
    "two",
    "previous",
    getKey,
    isFixed
  );
  assert.deepEqual(keyboard.items.map(getKey), ["fixed", "two", "one", "three"]);
  const pointer = reorderItemByKey(
    keyboard.items,
    "two",
    "three",
    getKey,
    isFixed
  );
  assert.deepEqual(pointer.items.map(getKey), ["fixed", "one", "three", "two"]);
  assert.deepEqual(
    reorderPositionByKey(pointer.items, "three", getKey, isFixed),
    { position: 2, total: 3 }
  );
  assert.equal(reorderPageForKey(["fixed", "one", "three", "two"], "two", 2), 2);
});

test("后台图片数字页由单一目标查询直达并隔离分页 scope", async () => {
  const filters = {
    ...emptyImageAdminFilters,
    device: "pc",
    brightness: "dark",
    theme: "night",
    tag: "blue",
    author: "alice"
  };
  const scope = imageAdminPaginationScopeKey("ready", filters, 60);
  const pageSizeScope = imageAdminPaginationScopeKey("ready", filters, 30);
  const unsetScope = imageAdminPaginationScopeKey("unset", filters, 60);
  assert.notEqual(scope, pageSizeScope);
  assert.notEqual(scope, unsetScope);
  assert.equal(
    effectiveImageAdminPage({
      scopeKey: scope,
      page: 100,
      total: 6_000,
      totalUpdatedAt: 1
    }, scope),
    100
  );
  assert.equal(
    effectiveImageAdminPage({
      scopeKey: scope,
      page: 100,
      total: 6_000,
      totalUpdatedAt: 1
    }, unsetScope),
    1
  );
  const hiddenThemeScope = imageAdminPaginationScopeKey("unset", {
    ...emptyImageAdminFilters,
    theme: "night"
  }, 60);
  const emptyUnsetScope = imageAdminPaginationScopeKey(
    "unset",
    emptyImageAdminFilters,
    60
  );
  assert.equal(
    hiddenThemeScope,
    emptyUnsetScope,
    "无主题视图的隐藏主题值不得建立第二个查询 scope"
  );
  assert.deepEqual(
    resetImageAdminPage({
      scopeKey: hiddenThemeScope,
      page: 8,
      total: 480,
      totalUpdatedAt: 12
    }, hiddenThemeScope),
    {
      scopeKey: hiddenThemeScope,
      page: 1,
      total: 480,
      totalUpdatedAt: 12
    },
    "只清除无主题视图的隐藏主题值时也必须显式返回第一页"
  );
  assert.equal(imageAdminTotalPages(0, 60), 1);
  assert.equal(imageAdminTotalPages(6_000, 60), 100);
  for (const scenario of [
    {
      name: "无快照或数据时从零开始",
      input: {
        retainedTotal: null,
        retainedUpdatedAt: 0,
        queryData: undefined,
        queryUpdatedAt: 0,
        fetchedAfterMount: false,
        isSuccess: false
      },
      expected: {
        currentQueryHasObservedSuccessfulData: false,
        queryTotal: null,
        total: 0
      }
    },
    {
      name: "同时间戳旧热缓存不得覆盖快照",
      input: {
        retainedTotal: 6_000,
        retainedUpdatedAt: 100,
        queryData: { total: 3_000 },
        queryUpdatedAt: 100,
        fetchedAfterMount: false,
        isSuccess: true
      },
      expected: {
        currentQueryHasObservedSuccessfulData: false,
        queryTotal: null,
        total: 6_000
      }
    },
    {
      name: "更新时间较新的缓存可以覆盖快照",
      input: {
        retainedTotal: 6_000,
        retainedUpdatedAt: 100,
        queryData: { total: 7_200 },
        queryUpdatedAt: 101,
        fetchedAfterMount: false,
        isSuccess: true
      },
      expected: {
        currentQueryHasObservedSuccessfulData: false,
        queryTotal: 7_200,
        total: 7_200
      }
    },
    {
      name: "挂载后成功结果可以在相同时间戳胜出",
      input: {
        retainedTotal: 6_000,
        retainedUpdatedAt: 100,
        queryData: { total: 7_200 },
        queryUpdatedAt: 100,
        fetchedAfterMount: true,
        isSuccess: true
      },
      expected: {
        currentQueryHasObservedSuccessfulData: true,
        queryTotal: 7_200,
        total: 7_200
      }
    },
    {
      name: "失败重试保留相同时间戳快照",
      input: {
        retainedTotal: 6_000,
        retainedUpdatedAt: 100,
        queryData: { total: 3_000 },
        queryUpdatedAt: 100,
        fetchedAfterMount: true,
        isSuccess: false
      },
      expected: {
        currentQueryHasObservedSuccessfulData: false,
        queryTotal: null,
        total: 6_000
      }
    },
    {
      name: "首份可用缓存建立 scope 快照",
      input: {
        retainedTotal: null,
        retainedUpdatedAt: 0,
        queryData: { total: 180 },
        queryUpdatedAt: 50,
        fetchedAfterMount: false,
        isSuccess: false
      },
      expected: {
        currentQueryHasObservedSuccessfulData: false,
        queryTotal: 180,
        total: 180
      }
    }
  ]) {
    assert.deepEqual(
      resolveImageAdminScopeTotal(scenario.input),
      scenario.expected,
      scenario.name
    );
  }
  const options = adminImageListQuery(
    "ready",
    filters,
    scope,
    100,
    60
  );
  assert.deepEqual(options.queryKey, [
    ...queryKeys.adminImages,
    scope,
    100,
    60
  ]);
  const requested: string[] = [];
  const validators: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requested.push(String(input));
    validators.push(new Headers(init?.headers).get("if-none-match") ?? "");
    if (requested.length === 2) {
      return new Response(null, {
        status: 304,
        headers: { ETag: 'W/"admin-page"' }
      });
    }
    return new Response(JSON.stringify({
      ok: true,
      items: [],
      total: 6_000
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ETag: 'W/"admin-page"'
      }
    });
  };
  try {
    const { QueryClient } = await import("@tanstack/react-query");
    const client = new QueryClient();
    const firstPage = await client.fetchQuery(options);
    assert.equal(firstPage.total, 6_000);
    assert.strictEqual(await client.fetchQuery(options), firstPage);
    assert.equal(requested.length, 1, "90 秒新鲜目标页不得重复请求");
    await client.invalidateQueries({
      queryKey: options.queryKey,
      exact: true,
      refetchType: "none"
    });
    assert.strictEqual(
      await client.fetchQuery(options),
      firstPage,
      "相同管理员列表应以 304 复用缓存对象"
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(requested.length, 2);
  assert.deepEqual(validators, ["", 'W/"admin-page"']);
  const target = new URL(requested[0]!, "https://imageshow.test");
  assert.equal(target.searchParams.get("page"), "100");
  assert.equal(target.searchParams.get("limit"), "60");
  assert.equal(target.searchParams.get("cursor"), null);
  assert.equal(target.searchParams.get("device"), "pc");
  assert.equal(target.searchParams.get("brightness"), "dark");
  assert.equal(target.searchParams.get("theme"), "night");
  assert.equal(target.searchParams.get("tag"), "blue");
  assert.equal(target.searchParams.get("author"), "alice");

  const unsetOptions = adminImageListQuery(
    "unset",
    filters,
    unsetScope,
    1,
    60
  );
  const previousUnsetFetch = globalThis.fetch;
  let unsetUrl = "";
  globalThis.fetch = async (input) => {
    unsetUrl = String(input);
    return new Response(JSON.stringify({ ok: true, items: [], total: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const { QueryClient } = await import("@tanstack/react-query");
    await unsetOptions.queryFn({
      client: new QueryClient(),
      signal: new AbortController().signal
    });
  } finally {
    globalThis.fetch = previousUnsetFetch;
  }
  const unsetTarget = new URL(unsetUrl, "https://imageshow.test");
  assert.equal(unsetTarget.searchParams.get("status"), "ready");
  assert.equal(unsetTarget.searchParams.get("theme"), "none");
  assert.equal(unsetTarget.searchParams.get("page"), "1");

});

test("后台数字页 Hook 在 Strict Mode 下直达、重试并一次夹紧", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
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

  const previousFetch = globalThis.fetch;
  const requests: string[] = [];
  let page50Attempts = 0;
  let page75Started = false;
  let page75Aborted = false;
  let page100Started = false;
  let resolvePage100: ((response: Response) => void) | null = null;
  let resolveUnsetPage: ((response: Response) => void) | null = null;
  let pageSizeRequestStarted = false;
  let resolvePageSizeRequest: ((response: Response) => void) | null = null;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "https://imageshow.test");
    requests.push(url.toString());
    const page = Number(url.searchParams.get("page"));
    if (url.searchParams.get("limit") === "30") {
      pageSizeRequestStarted = true;
      return new Promise<Response>((resolve) => {
        resolvePageSizeRequest = resolve;
      });
    }
    if (url.searchParams.get("status") === "ready" && page === 75) {
      page75Started = true;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const aborted = () => {
          page75Aborted = true;
          reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        };
        if (signal?.aborted) aborted();
        else signal?.addEventListener("abort", aborted, { once: true });
      });
    }
    if (url.searchParams.get("status") === "ready" && page === 100) {
      page100Started = true;
      return new Promise<Response>((resolve) => {
        resolvePage100 = resolve;
      });
    }
    if (
      url.searchParams.get("status") === "ready"
      && page === 50
      && page50Attempts++ === 0
    ) {
      return new Response(JSON.stringify({
        ok: false,
        code: "controlled_failure",
        error: "controlled page failure",
        details: {}
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.searchParams.get("theme") === "none") {
      return new Promise<Response>((resolve) => {
        resolveUnsetPage = resolve;
      });
    }
    const total = url.searchParams.get("status") === "ready" && page === 50
      ? 120
      : 6_000;
    return new Response(JSON.stringify({ ok: true, items: [], total }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          refetchOnWindowFocus: false
        }
      }
    });
    let props = {
      view: "ready" as const,
      filters: emptyImageAdminFilters,
      pageSize: 60
    };
    let latest!: ReturnType<typeof useImageAdminPageNavigation>;
    function Harness() {
      latest = useImageAdminPageNavigation(props);
      return React.createElement(
        "output",
        null,
        `${latest.pageNumber}:${latest.totalPages}`
      );
    }
    const tree = () => React.createElement(
      React.StrictMode,
      null,
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(Harness)
      )
    );
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    const waitFor = async (condition: () => boolean) => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        if (condition()) return;
      }
      assert.fail("等待后台数字页 Hook 状态超时");
    };

    await React.act(async () => root.render(tree()));
    await waitFor(() => latest.total === 6_000 && !latest.isFetching);
    assert.equal(latest.hasCurrentPageData, true);
    assert.equal(requests.length, 1, "Strict Mode 初始查询必须单飞");

    const pageOneState = client.getQueryState([
      ...queryKeys.adminImages,
      latest.scopeKey,
      1,
      60
    ]);
    assert.ok(pageOneState);
    const page80Key = [...queryKeys.adminImages, latest.scopeKey, 80, 60];
    client.setQueryData(
      page80Key,
      { items: [{ id: "cached-page-80" }], total: 3_000 },
      { updatedAt: pageOneState.dataUpdatedAt }
    );
    await React.act(async () => latest.loadPage(80, false));
    assert.equal(latest.pageNumber, 80);
    assert.equal(latest.totalPages, 100, "同时间戳旧缓存不得覆盖当前 scope 总数");
    assert.equal(latest.total, 6_000);
    assert.equal(latest.hasCurrentPageData, true);
    assert.equal(latest.items[0]?.id, "cached-page-80");
    assert.equal(requests.length, 1, "90 秒内的目标页缓存必须零网络复用");
    client.setQueryData(
      page80Key,
      { items: [{ id: "updated-page-80" }], total: 7_200 },
      { updatedAt: pageOneState.dataUpdatedAt }
    );
    await waitFor(() => latest.total === 7_200);
    assert.equal(latest.totalPages, 120, "同时间戳的新成功结果必须覆盖旧快照");
    client.setQueryData(
      page80Key,
      { items: [{ id: "current-page-80" }], total: 6_000 },
      { updatedAt: pageOneState.dataUpdatedAt }
    );
    await waitFor(() => latest.items[0]?.id === "current-page-80");
    assert.equal(latest.totalPages, 100);
    assert.equal(latest.total, 6_000);

    await React.act(async () => latest.loadPage(100, false));
    await waitFor(() => page100Started && latest.pageNumber === 100);
    assert.equal(latest.pageNumber, 100);
    assert.equal(latest.totalPages, 100, "加载目标页时必须保留已知总页数");
    assert.equal(latest.total, 6_000, "加载目标页时必须保留已知总项数");
    assert.equal(latest.hasCurrentPageData, false);
    assert.equal(latest.items.length, 0, "不得把上一页 items 伪装成目标页内容");
    const finishPage100 = resolvePage100;
    assert.ok(finishPage100);
    await React.act(async () => finishPage100(new Response(JSON.stringify({
      ok: true,
      items: [],
      total: 6_000
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));
    await waitFor(() => latest.pageNumber === 100 && !latest.isFetching);
    assert.equal(
      requests.filter((value) => new URL(value).searchParams.get("page") === "100").length,
      1
    );

    await React.act(async () => latest.loadPage(75, false));
    await waitFor(() => page75Started);
    assert.equal(latest.pageNumber, 75);
    assert.equal(latest.totalPages, 100);
    assert.equal(latest.total, 6_000);
    assert.equal(latest.items.length, 0);
    props = { ...props, view: "unset" };
    await React.act(async () => root.render(tree()));
    await waitFor(() => resolveUnsetPage !== null && page75Aborted);
    assert.equal(latest.pageNumber, 1, "scope 变化的同一渲染必须立即使用第 1 页");
    assert.equal(latest.totalPages, 1, "新 scope 不得沿用旧总页数");
    assert.equal(latest.total, 0, "新 scope 不得沿用旧总项数");
    const finishUnsetPage = resolveUnsetPage;
    assert.ok(finishUnsetPage);
    await React.act(async () => finishUnsetPage(new Response(JSON.stringify({
      ok: true,
      items: [],
      total: 180
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));
    await waitFor(() => page75Aborted && latest.total === 180);
    assert.equal(latest.totalPages, 3);
    assert.equal(requests.some((value) => {
      const url = new URL(value);
      return url.searchParams.get("theme") === "none"
        && url.searchParams.get("page") !== "1";
    }), false);

    const beforeRouteReturn = requests.length;
    props = { ...props, view: "ready" };
    await React.act(async () => root.render(tree()));
    await waitFor(() => latest.pageNumber === 1 && latest.total === 6_000);
    assert.equal(
      requests.length,
      beforeRouteReturn,
      "返回 90 秒内的新鲜 scope 不得重新请求"
    );

    await React.act(async () => latest.loadPage(50, false));
    await waitFor(() => latest.pageNumber === 50 && latest.isError);
    assert.equal(latest.pageNumber, 50, "失败后必须保留目标页");
    assert.equal(latest.totalPages, 100, "失败后必须保留最近成功总页数");
    assert.equal(latest.total, 6_000, "失败后必须保留最近成功总项数");
    assert.equal(latest.hasCurrentPageData, false, "失败页不得伪造空列表数据");
    await React.act(async () => {
      await latest.refetch();
    });
    await waitFor(() => (
      latest.pageNumber === 2
      && latest.total === 6_000
      && !latest.isFetching
    ));
    const readyPages = requests
      .map((value) => new URL(value))
      .filter((url) => (
        url.searchParams.get("status") === "ready"
        && url.searchParams.get("theme") !== "none"
      ))
      .map((url) => url.searchParams.get("page"));
    assert.equal(readyPages.filter((page) => page === "50").length, 2);
    assert.equal(readyPages.filter((page) => page === "2").length, 1);
    assert.equal(
      readyPages.some((page) => (
        Number(page) > 2
        && page !== "50"
        && page !== "75"
        && page !== "100"
      )),
      false,
      "total 收缩只能直接夹到最终页，不能逐页回退"
    );

    const beforeStableRender = requests.length;
    await React.act(async () => root.render(tree()));
    assert.equal(requests.length, beforeStableRender);

    props = { ...props, pageSize: 30 };
    await React.act(async () => root.render(tree()));
    await waitFor(() => pageSizeRequestStarted);
    assert.equal(latest.pageNumber, 1);
    assert.equal(latest.totalPages, 1, "page size scope 不得沿用旧总页数");
    assert.equal(latest.total, 0, "page size scope 不得沿用旧总项数");
    assert.equal(latest.items.length, 0);
    const finishPageSizeRequest = resolvePageSizeRequest;
    assert.ok(finishPageSizeRequest);
    await React.act(async () => finishPageSizeRequest(new Response(JSON.stringify({
      ok: true,
      items: [],
      total: 6_000
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));
    await waitFor(() => latest.total === 6_000 && !latest.isFetching);
    assert.equal(requests.length, beforeStableRender + 1);
    const resized = new URL(requests.at(-1)!);
    assert.equal(resized.searchParams.get("page"), "1");
    assert.equal(resized.searchParams.get("limit"), "30");

    await React.act(async () => root.unmount());
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

test("图片后台真实挂载保持弹窗页码、操作后夹紧并按权限隐藏永久删除", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const localStorageValues = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageValues.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageValues.delete(key);
    }
  };
  const requestAnimationFrame = (callback: FrameRequestCallback) => (
    setTimeout(() => callback(Date.now()), 0) as unknown as number
  );
  const cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL("https://imageshow.test/admin/images")
  });
  Object.assign(window, {
    localStorage,
    matchMedia: (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true
    }),
    requestAnimationFrame,
    cancelAnimationFrame,
    scrollTo() {}
  });
  const elementScrollTo = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    "scrollTo"
  );
  Object.defineProperty(window.HTMLElement.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value() {}
  });
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
    localStorage,
    requestAnimationFrame,
    cancelAnimationFrame,
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
  const previousConsoleError = console.error;
  const expectedListErrors: unknown[][] = [];
  const expectedMutationErrors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    if (args[0] === "[ImageShow] image_admin.list_load") {
      expectedListErrors.push(args);
      return;
    }
    if (args[0] === "[ImageShow] image_admin.trash_or_purge") {
      expectedMutationErrors.push(args);
      return;
    }
    previousConsoleError(...args);
  };

  try {
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const { MemoryRouter } = await import("react-router");
    const { AuthSessionProvider } = await import(
      "../../packages/web/src/hooks/useAuthSession.tsx"
    );
    const { AdminPreferencesProvider } = await import(
      "../../packages/web/src/hooks/useAdminPreferences.tsx"
    );
    const { ActionFeedbackProvider } = await import(
      "../../packages/web/src/components/feedback/ActionFeedbackRegion.tsx"
    );
    const { registerHooks } = await import("node:module");
    const cssHooks = registerHooks({
      load(url, context, nextLoad) {
        if (url.endsWith(".css")) {
          return { format: "module", source: "", shortCircuit: true };
        }
        return nextLoad(url, context);
      }
    });
    const { ImageAdmin } = await import(
      "../../packages/web/src/pages/admin/images/ImageAdmin.tsx"
    ).finally(() => cssHooks.deregister());
    const { ADMIN_ICONS } = await import(
      "../../packages/web/src/components/icon/admin-icons.generated.ts"
    );
    const container = document.getElementById("root");
    assert.ok(container);

    const jsonResponse = (value: unknown) => new Response(
      JSON.stringify({ ok: true, ...value as Record<string, unknown> }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
    const image = (serial: string): AdminImageListItemDto => ({
      ...galleryCard(`00000000-0000-7000-8000-${serial}`),
      description: "",
      object_url: `/full/${serial.slice(-2)}/00000000-0000-7000-8000-${serial}.webp`,
      source: "",
      thumb_url: "",
      status: "deleted",
      purge_pending: false,
      object_key: `${serial.slice(-2)}/00000000-0000-7000-8000-${serial}.webp`,
      storage_slug: "local",
      md5: serial.padStart(32, "0").slice(-32),
      original: "",
      image_size: 1,
      deleted_at: "2026-08-15T00:00:00.000Z",
      created_at: "2026-08-14T00:00:00.000Z",
      updated_at: "2026-08-15T00:00:00.000Z"
    });
    const waitFor = async (condition: () => boolean, message: string) => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
        if (condition()) return;
      }
      assert.fail(message);
    };
    const click = async (target: HTMLElement) => {
      await React.act(async () => {
        target.dispatchEvent(new window.Event("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    const submitForm = async (target: HTMLFormElement) => {
      await React.act(async () => {
        target.dispatchEvent(new window.Event("submit", {
          bubbles: true,
          cancelable: true
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    const buttonWithText = (text: string) => {
      const target = [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes(text));
      assert.ok(target, `missing ${text} button`);
      return target;
    };

    const runMutationScenario = async (
      mode: "restore" | "purge" | "purge-unknown"
    ) => {
      const purgeMode = mode !== "restore";
      const mutationKind = purgeMode ? "purge" : "restore";
      const permissions = purgeMode
        ? [adminPermissions.imageTrashPurge]
        : [];
      const client = new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false }
        }
      });
      client.setQueryData(queryKeys.me, {
        authenticated: true,
        username: `pagination-${mode}`,
        role: purgeMode ? "super" : "image",
        permissions,
        csrf_token: "pagination-test-token",
        application_version: "current-test",
        preferences: {},
        preferences_etag: 'W/"pagination-preferences"',
        version_settings: { enabled: true, link_enabled: true }
      });
      client.setQueryData(queryKeys.settings, {
        settings: {
          admin: { image_page_size: 1 },
          ingestion: { list_page_size: 1 }
        }
      });
      client.setQueryData(queryKeys.ingestionVocabulary, {
        themes: [],
        tags: [],
        authors: []
      });
      client.setQueryData(queryKeys.storageOptions, {
        backends: [{
          slug: "local",
          display_name: "本地存储",
          enabled: true,
          is_default: true
        }]
      });

      const listRequests: number[] = [];
      let shrunk = false;
      let mutationRequests = 0;
      let pageTwoAttempts = 0;
      let pageTwoStarted = false;
      let resolvePageTwo: ((response: Response) => void) | null = null;
      let postMutationRefreshStarted = false;
      let resolvePostMutationRefresh: ((response: Response) => void) | null = null;
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input), "https://imageshow.test");
        if (url.pathname === "/api/admin/images") {
          const page = Number(url.searchParams.get("page"));
          listRequests.push(page);
          const total = shrunk ? 1 : 2;
          if (page === 2 && shrunk && !postMutationRefreshStarted) {
            postMutationRefreshStarted = true;
            return new Promise<Response>((resolve) => {
              resolvePostMutationRefresh = resolve;
            });
          }
          if (page === 2 && !shrunk && pageTwoAttempts++ === 0) {
            return new Response(JSON.stringify({
              ok: false,
              code: "controlled_failure",
              error: "controlled page failure",
              details: {}
            }), {
              status: 500,
              headers: { "Content-Type": "application/json" }
            });
          }
          if (page === 2 && !shrunk && !pageTwoStarted) {
            pageTwoStarted = true;
            return new Promise<Response>((resolve) => {
              resolvePageTwo = resolve;
            });
          }
          return jsonResponse({
            items: page <= total
              ? [image(String(page).padStart(12, "0"))]
              : [],
            total
          });
        }
        if (url.pathname === "/api/admin/ingestion/vocabulary") {
          return jsonResponse({ themes: [], tags: [], authors: [] });
        }
        if (url.pathname === `/api/admin/images/${mutationKind}`) {
          assert.equal(init?.method, "POST");
          mutationRequests += 1;
          if (mode === "purge-unknown") {
            throw new Error("controlled unknown purge result");
          }
          shrunk = true;
          return mode === "restore"
            ? jsonResponse({
                requested: 1,
                restored: 1,
                ignored: 0,
                results: [{
                  id: "00000000-0000-7000-8000-000000000002",
                  status: "restored"
                }]
              })
            : jsonResponse({
                requested: 1,
                queued: 1,
                already_queued: 0,
                deleted: 1,
                remaining: 0,
                ignored: 0
              });
        }
        if (url.pathname === "/api/admin/logs/client-errors") {
          return jsonResponse({});
        }
        throw new Error(`unexpected ImageAdmin request: ${url.pathname}`);
      };

      const root = createRoot(container);
      try {
        await React.act(async () => {
          root.render(React.createElement(
            QueryClientProvider,
            { client },
            React.createElement(
              MemoryRouter,
              { initialEntries: ["/admin/images?view=deleted"] },
              React.createElement(
                AuthSessionProvider,
                null,
                React.createElement(
                  AdminPreferencesProvider,
                  {
                    username: `pagination-${mode}`,
                    serverPreferences: {},
                    serverPreferencesEtag: 'W/"pagination-preferences"',
                    serverPreferencesUpdatedAt: Date.now()
                  },
                  React.createElement(
                    ActionFeedbackProvider,
                    null,
                    React.createElement(ImageAdmin)
                  )
                )
              )
            )
          ));
        });
        await waitFor(
          () => listRequests.length === 1 && /第 1 \/ 2 页/.test(
            container.textContent ?? ""
          ),
          `${mode} scenario initial page did not load`
        );
        await click(buttonWithText("下一页"));
        await waitFor(
          () => [...container.querySelectorAll("button")].some(
            (button) => button.textContent?.includes("重试")
          ),
          `${mode} scenario page 2 failure did not render`
        );
        const pageStatus = container.querySelector<HTMLElement>(
          '.image-admin-head-copy > p[role="status"]'
        );
        assert.ok(pageStatus);
        assert.equal(
          pageStatus.textContent,
          "第 2 / 2 页 · 共 2 项",
          "失败且无页数据时不得伪造本页 0 项"
        );
        await click(buttonWithText("重试"));
        await waitFor(
          () => pageTwoStarted,
          `${mode} scenario page 2 request did not start`
        );
        assert.equal(
          pageStatus.textContent,
          "第 2 / 2 页 · 共 2 项 · 加载中",
          "加载期间只应显示稳定分页元数据和加载状态"
        );
        const finishPageTwo = resolvePageTwo;
        assert.ok(finishPageTwo);
        await React.act(async () => finishPageTwo(jsonResponse({
          items: [image("000000000002")],
          total: 2
        })));
        await waitFor(
          () => pageStatus.textContent === "第 2 / 2 页 · 共 2 项 · 本页 1 项",
          `${mode} scenario page 2 did not load`
        );

        const purgeButton = container.querySelector<HTMLButtonElement>(
          'button[aria-label^="永久删除图片："]'
        );
        if (mode === "restore") {
          assert.equal(purgeButton, null, "图片管理员不得看到永久删除入口");
          assert.doesNotMatch(container.textContent ?? "", /清空回收站/);
        } else {
          assert.ok(purgeButton, "超级管理员必须看到永久删除入口");
          const listRequestsBeforeDialog = listRequests.length;
          await click(buttonWithText("清空回收站"));
          await waitFor(
            () => Boolean(document.querySelector('[data-dialog-frame]')),
            "purge confirmation did not open"
          );
          await click(buttonWithText("取消"));
          await waitFor(
            () => !document.querySelector('[data-dialog-frame]'),
            "purge confirmation did not close"
          );
          assert.equal(
            listRequests.length,
            listRequestsBeforeDialog,
            "关闭确认弹窗不得重取当前数字页"
          );
          assert.match(container.textContent ?? "", /第 2 \/ 2 页/);
        }

        if (mode === "restore") {
          const restoreButton = container.querySelector<HTMLButtonElement>(
            'button[aria-label^="恢复图片："]'
          );
          assert.ok(restoreButton);
          await click(restoreButton);
        } else {
          const firstPurge = container.querySelector<HTMLButtonElement>(
            'button[aria-label^="永久删除图片："]'
          );
          assert.ok(firstPurge);
          await click(firstPurge);
          await waitFor(
            () => Boolean(document.querySelector('[data-dialog-frame]')),
            "single purge confirmation did not open"
          );
          assert.equal(mutationRequests, 0);
          const purgeDialog = document.querySelector<HTMLElement>(
            '[data-dialog-frame]'
          );
          assert.ok(purgeDialog);
          const permanentDelete = purgeDialog.querySelector<HTMLButtonElement>(
            'button[aria-label="永久删除"]'
          );
          assert.ok(permanentDelete);
          assert.equal(
            permanentDelete.querySelector("path")?.getAttribute("d"),
            ADMIN_ICONS["delete-bin-7-line"]
          );
          const purgeForm = purgeDialog.querySelector<HTMLFormElement>("form");
          assert.ok(purgeForm);
          await submitForm(purgeForm);
          assert.equal(mutationRequests, 0, "首次弹窗确认只能进入二次确认态");
          await waitFor(
            () => Boolean(purgeDialog.querySelector(
              'button[aria-label="确认删除"]'
            )),
            "purge dialog did not enter final confirmation state"
          );
          const confirmedPurge = purgeDialog.querySelector<HTMLButtonElement>(
            'button[aria-label="确认删除"]'
          );
          assert.ok(confirmedPurge);
          assert.equal(
            confirmedPurge.querySelector("path")?.getAttribute("d"),
            ADMIN_ICONS["delete-bin-2-line"]
          );
          await submitForm(purgeForm);
          await waitFor(
            () => Boolean(purgeDialog.querySelector(
              'button[aria-label="正在删除"]'
            )),
            "purge dialog did not enter pending state"
          );
          const pendingPurge = purgeDialog.querySelector<HTMLButtonElement>(
            'button[aria-label="正在删除"]'
          );
          assert.ok(pendingPurge);
          assert.equal(
            pendingPurge.querySelector("path")?.getAttribute("d"),
            ADMIN_ICONS["delete-bin-5-line"]
          );
        }
        if (mode === "purge-unknown") {
          const unknownMessage = "操作结果未能确认，图片列表已刷新，但无法确认操作已经收口，请稍后再次刷新";
          await waitFor(
            () => Boolean(document.querySelector(
              ".confirm-dialog-error"
            )?.textContent?.includes(unknownMessage)),
            "unknown purge result was not presented inside the dialog"
          );
          const purgeDialog = document.querySelector<HTMLElement>(
            '[data-dialog-frame]'
          );
          assert.ok(purgeDialog);
          const failedConfirm = purgeDialog.querySelector<HTMLButtonElement>(
            "button.danger-button"
          );
          assert.ok(failedConfirm);
          assert.equal(failedConfirm.disabled, true, "未知删除结果不得盲目重试");
          assert.equal(
            document.querySelector(".image-admin-feedback-region .action-feedback-error"),
            null,
            "未知删除结果不得在 inert 页面背后启动短反馈"
          );
          await React.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 3_200));
          });
          assert.ok(document.querySelector('[data-dialog-frame]'));
          assert.match(
            document.querySelector(".confirm-dialog-error")?.textContent ?? "",
            /操作结果未能确认/,
            "弹窗内错误不得按页面反馈时长自动消失"
          );
          assert.equal(mutationRequests, 1);
          await click(buttonWithText("取消"));
          await waitFor(
            () => !document.querySelector('[data-dialog-frame]'),
            "unknown purge dialog did not close explicitly"
          );
          const reopenPurge = container.querySelector<HTMLButtonElement>(
            'button[aria-label^="永久删除图片："]'
          );
          assert.ok(reopenPurge);
          await click(reopenPurge);
          await waitFor(
            () => Boolean(document.querySelector('[data-dialog-frame]')),
            "purge dialog did not reopen after an unknown result"
          );
          const reopenedDialog = document.querySelector<HTMLElement>(
            '[data-dialog-frame]'
          );
          assert.ok(reopenedDialog);
          assert.equal(reopenedDialog.querySelector(".confirm-dialog-error"), null);
          const reopenedConfirm = reopenedDialog.querySelector<HTMLButtonElement>(
            'button[aria-label="永久删除"]'
          );
          assert.ok(reopenedConfirm);
          assert.equal(reopenedConfirm.disabled, false);
          await click(buttonWithText("取消"));
          await waitFor(
            () => !document.querySelector('[data-dialog-frame]'),
            "reopened purge dialog did not close"
          );
          return;
        }
        const expectedResult = mode === "restore"
          ? "已恢复 1 张"
          : "已永久删除 1 张";
        await waitFor(
          () => postMutationRefreshStarted
            && (mode === "purge"
              || (container.textContent ?? "").includes(expectedResult)),
          `${mode} list refresh did not start at the expected result boundary`
        );
        assert.ok(
          document.getElementById(
            "admin-image-select-00000000-0000-7000-8000-000000000002"
          ),
          `${mode} must retain the affected card until the list refresh settles`
        );
        if (mode === "restore") {
          const visibleResult = document.querySelector<HTMLElement>(
            ".image-admin-feedback-region .action-feedback-success"
          );
          assert.ok(visibleResult);
          assert.equal(visibleResult.textContent?.includes(expectedResult), true);
          assert.doesNotMatch(visibleResult.textContent ?? "", /0 张未处理/);
        } else {
          assert.equal(
            (container.textContent ?? "").includes(expectedResult),
            false,
            "永久删除结果不得在仍覆盖页面的确认弹窗后方开始倒计时"
          );
          await React.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 3_200));
          });
          assert.ok(document.querySelector('[data-dialog-frame]'));
          assert.equal(
            (container.textContent ?? "").includes(expectedResult),
            false
          );
        }
        const finishPostMutationRefresh = resolvePostMutationRefresh;
        assert.ok(finishPostMutationRefresh);
        await React.act(async () => finishPostMutationRefresh(jsonResponse({
          items: [],
          total: 1
        })));
        await waitFor(
          () => mutationRequests === 1
            && /第 1 \/ 1 页/.test(container.textContent ?? "")
            && listRequests.at(-1) === 1,
          `${mode} scenario did not clamp to the new last page`
        );
        assert.deepEqual(
          listRequests.slice(-2),
          [2, 1],
          `${mode} must refetch the target page once and clamp directly`
        );
        if (mode === "purge") {
          await waitFor(
            () => !document.querySelector('[data-dialog-frame]')
              && (container.textContent ?? "").includes(expectedResult),
            "purge result did not become visible after the slow dialog operation"
          );
          assert.ok(document.querySelector(
            ".image-admin-feedback-region .action-feedback-success"
          ));
        }
      } finally {
        await React.act(async () => root.unmount());
        client.clear();
        globalThis.fetch = previousFetch;
        container.replaceChildren();
      }
    };

    const runTrashScenario = async () => {
      const client = new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false }
        }
      });
      client.setQueryData(queryKeys.me, {
        authenticated: true,
        username: "trash-interface",
        role: "image",
        permissions: [],
        csrf_token: "trash-interface-token",
        application_version: "current-test",
        preferences: {},
        preferences_etag: 'W/"trash-interface-preferences"',
        version_settings: { enabled: true, link_enabled: true }
      });
      client.setQueryData(queryKeys.settings, {
        settings: {
          admin: { image_page_size: 2 },
          ingestion: { list_page_size: 20 }
        }
      });
      client.setQueryData(queryKeys.ingestionVocabulary, {
        themes: [],
        tags: [],
        authors: []
      });
      client.setQueryData(queryKeys.storageOptions, {
        backends: [{
          slug: "local",
          display_name: "本地存储",
          enabled: true,
          is_default: true
        }]
      });

      const readyItems = [
        "000000000011",
        "000000000012",
        "000000000013"
      ].map((serial) => ({
        ...image(serial),
        status: "ready" as const,
        deleted_at: null
      }));
      const initialReadyItems = readyItems.slice(0, 2);
      const trashedIds = new Set<string>();
      const trashBodies: Array<{ ids: string[] }> = [];
      const releaseTrashMutations: Array<() => void> = [];
      const pendingTrashRefreshes: Array<{
        resolve: () => void;
        reject: () => void;
      }> = [];
      let deferNextTrashRefresh = false;
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input), "https://imageshow.test");
        if (url.pathname === "/api/admin/images") {
          const remaining = readyItems.filter((item) => !trashedIds.has(item.id));
          const response = jsonResponse({
            items: remaining.slice(0, 2),
            total: remaining.length
          });
          if (deferNextTrashRefresh) {
            deferNextTrashRefresh = false;
            return new Promise<Response>((resolve, reject) => {
              pendingTrashRefreshes.push({
                resolve: () => resolve(response),
                reject: () => reject(new Error(
                  "controlled trash list refresh failure"
                ))
              });
            });
          }
          return response;
        }
        if (url.pathname === "/api/admin/ingestion/vocabulary") {
          return jsonResponse({ themes: [], tags: [], authors: [] });
        }
        if (url.pathname === "/api/admin/images/trash") {
          assert.equal(init?.method, "POST");
          const body = JSON.parse(String(init?.body)) as { ids: string[] };
          trashBodies.push(body);
          return new Promise<Response>((resolve) => {
            releaseTrashMutations.push(() => {
              for (const id of body.ids) trashedIds.add(id);
              deferNextTrashRefresh = true;
              resolve(jsonResponse({
                requested: body.ids.length,
                trashed: body.ids.length,
                ignored: 0,
                results: body.ids.map((id) => ({ id, status: "trashed" }))
              }));
            });
          });
        }
        if (url.pathname === "/api/admin/logs/client-errors") {
          return jsonResponse({});
        }
        throw new Error(`unexpected trash interface request: ${url.pathname}`);
      };

      const root = createRoot(container);
      try {
        await React.act(async () => {
          root.render(React.createElement(
            QueryClientProvider,
            { client },
            React.createElement(
              MemoryRouter,
              { initialEntries: ["/admin/images"] },
              React.createElement(
                AuthSessionProvider,
                null,
                React.createElement(
                  AdminPreferencesProvider,
                  {
                    username: "trash-interface",
                    serverPreferences: {},
                    serverPreferencesEtag: 'W/"trash-interface-preferences"',
                    serverPreferencesUpdatedAt: Date.now()
                  },
                  React.createElement(
                    ActionFeedbackProvider,
                    null,
                    React.createElement(ImageAdmin)
                  )
                )
              )
            )
          ));
        });
        await waitFor(
          () => container.querySelectorAll(".admin-image-card").length === 2,
          "trash interface scenario did not load ready items"
        );
        const selectionTargets = [
          ...container.querySelectorAll<HTMLElement>(
            ".admin-image-card-checkbox-hit-area"
          )
        ];
        assert.equal(selectionTargets.length, 2);
        await click(selectionTargets[0]!);
        await click(selectionTargets[1]!);
        await waitFor(
          () => /已选 2/.test(container.textContent ?? ""),
          "trash interface scenario did not select both items"
        );

        let batchTrash = buttonWithText("批量删除");
        await click(batchTrash);
        assert.equal(trashBodies.length, 0);
        assert.equal(batchTrash.getAttribute("aria-pressed"), "true");
        assert.match(batchTrash.textContent ?? "", /确认删除/);
        assert.equal(document.querySelector('[data-dialog-frame]'), null);

        await click(selectionTargets[0]!);
        await waitFor(
          () => /已选 1/.test(container.textContent ?? "")
            && Boolean(buttonWithText("批量删除")),
          "selection change did not disarm frozen batch delete"
        );
        assert.equal(trashBodies.length, 0);
        await click(selectionTargets[0]!);
        await waitFor(
          () => /已选 2/.test(container.textContent ?? ""),
          "trash interface scenario did not restore both selections"
        );

        batchTrash = buttonWithText("批量删除");
        await click(batchTrash);
        await click(buttonWithText("确认删除"));
        await waitFor(
          () => trashBodies.length === 1,
          "batch trash did not submit after the second click"
        );
        assert.deepEqual(trashBodies[0], {
          ids: initialReadyItems.map((item) => item.id)
        });
        const pendingBatchTrash = container.querySelector<HTMLButtonElement>(
          '.two-step-confirm-text-button[aria-label="正在删除"]'
        );
        assert.ok(pendingBatchTrash);
        assert.equal(
          pendingBatchTrash.querySelector("path")?.getAttribute("d"),
          ADMIN_ICONS["delete-bin-5-line"]
        );
        await React.act(async () => releaseTrashMutations.shift()?.());
        await waitFor(
          () => pendingTrashRefreshes.length === 1
            && (container.textContent ?? "").includes(
              "已移入回收站 2 张"
            ),
          "batch trash result was not rendered before list refresh"
        );
        assert.equal(
          container.querySelectorAll(".admin-image-card").length,
          2,
          "批量删除已知结果出现时原卡片必须仍在当前图库"
        );
        for (const item of initialReadyItems) {
          assert.ok(document.getElementById(`admin-image-select-${item.id}`));
        }
        assert.ok(container.querySelector(
          ".image-admin-feedback-region .action-feedback-success"
        ));
        assert.doesNotMatch(container.textContent ?? "", /0 张未处理/);
        await React.act(async () => pendingTrashRefreshes.shift()?.resolve());
        await waitFor(
          () => Boolean(buttonWithText("批量删除"))
            && !container.querySelector('[aria-busy="true"].two-step-confirm-text-button')
            && container.querySelectorAll(".admin-image-card").length === 1
            && Boolean(document.getElementById(
              `admin-image-select-${readyItems[2]!.id}`
            )),
          "batch trash did not return to its idle state"
        );

        const singleTrash = container.querySelector<HTMLButtonElement>(
          'button[aria-label^="删除图片："]'
        );
        assert.ok(singleTrash);
        await click(singleTrash);
        assert.equal(trashBodies.length, 1);
        assert.equal(singleTrash.getAttribute("aria-pressed"), "true");
        await click(singleTrash);
        await waitFor(
          () => trashBodies.length === 2,
          "single trash did not submit after the second click"
        );
        assert.deepEqual(trashBodies[1], { ids: [readyItems[2]!.id] });
        const pendingSingleTrash = container.querySelector<HTMLButtonElement>(
          'button[aria-label^="删除中："]'
        );
        assert.ok(pendingSingleTrash);
        assert.equal(
          pendingSingleTrash.querySelector("path")?.getAttribute("d"),
          ADMIN_ICONS["delete-bin-5-line"]
        );
        assert.equal(document.querySelector('[data-dialog-frame]'), null);
        await React.act(async () => releaseTrashMutations.shift()?.());
        await waitFor(
          () => pendingTrashRefreshes.length === 1
            && (container.textContent ?? "").includes(
              "已移入回收站 1 张"
            ),
          "single trash result was not rendered before list refresh"
        );
        assert.ok(document.getElementById(
          `admin-image-select-${readyItems[2]!.id}`
        ));
        await React.act(async () => pendingTrashRefreshes.shift()?.reject());
        await waitFor(
            () => !container.querySelector('button[aria-label^="删除中："]')
            && (container.textContent ?? "").includes(
              "已移入回收站 1 张；图片列表刷新失败，请重新加载页面"
            ),
          "single trash did not surface the real list refresh failure"
        );
        assert.equal(
          container.querySelectorAll(".admin-image-card").length,
          1,
          "刷新失败时必须保留缓存卡片并明确要求重新加载"
        );
        assert.ok(container.querySelector(
          ".image-admin-feedback-region .action-feedback-error"
        ));
      } finally {
        await React.act(async () => root.unmount());
        client.clear();
        globalThis.fetch = previousFetch;
        container.replaceChildren();
      }
    };

    await runMutationScenario("restore");
    await runMutationScenario("purge");
    await runMutationScenario("purge-unknown");
    await runTrashScenario();
    assert.deepEqual(
      expectedListErrors.map((args) => (
        args[1] as { code?: string } | undefined
      )?.code).filter((code) => code === "controlled_failure"),
      ["controlled_failure", "controlled_failure", "controlled_failure"],
      "三轮受控列表失败必须各报告一次且不得污染测试输出"
    );
    assert.equal(
      expectedListErrors.length,
      4,
      "每次列表失败只能由查询 owner 上报一次"
    );
    assert.equal(
      expectedMutationErrors.length,
      1,
      "未知永久删除请求必须只记录一次 mutation 错误"
    );
  } finally {
    console.error = previousConsoleError;
    clearCsrfToken();
    if (elementScrollTo) {
      Object.defineProperty(
        window.HTMLElement.prototype,
        "scrollTo",
        elementScrollTo
      );
    } else {
      delete (window.HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    }
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

test("内容接入队列以 pair、version 与 progress_seq 单调合并服务端状态", () => {
  assert.deepEqual(summarizeIngestionJobs([
    ingestionJob({ id: "waiting-download", status: "queued" }),
    ingestionJob({ id: "waiting-prepare", status: "received" }),
    ingestionJob({ id: "active-download", status: "downloading" }),
    ingestionJob({ id: "active-prepare", status: "processing" })
  ]), {
    readyCount: 0,
    unfinishedCount: 4,
    duplicateJobs: 0,
    waitingJobs: 2,
    runningJobs: 2,
    commitQueuedJobs: 0,
    committingJobs: 0,
    finalizedJobs: 0,
    doneJobs: 0,
    failedJobs: 0
  }, "等待 worker 准入的任务不得计入处理中");

  const sessionId = "A".repeat(43);
  const imageId = "019f8457-063a-7002-a580-7a432dc7fd8e";
  const attemptKey = "019f8457-063a-7003-a580-7a432dc7fd8e";
  const base = ingestionJob({
    attemptKey,
    sessionId,
    imageId,
    status: "processing",
    serverVersion: 2,
    serverProgressSeq: 2
  });
  const prepareWaitingItem = {
    session_id: sessionId,
    image_id: imageId,
    queue: "import" as const,
    source_type: "url" as const,
    resolved_image_time: "2026-08-23T01:02:03.456Z",
    status: "preparing" as const,
    phase: "prepare-waiting",
    message: "等待图片处理许可",
    progress: null,
    version: 3,
    progress_seq: 0,
    last_semantic_revision: 3,
    accepted_at: 1,
    accepted_order: 1,
    metadata: base.draft,
    storage_slug: "local"
  };
  const waitingForNormalization = ingestionJobFromServerItem(
    prepareWaitingItem,
    base
  );
  assert.equal(waitingForNormalization.status, "received");
  assert.equal(ingestionJobStatusLabel(waitingForNormalization), "待处理");
  assert.equal(
    ingestionJobStatusDetail(waitingForNormalization),
    "原图素材已接收，等待处理"
  );
  assert.equal(
    summarizeIngestionJobs([waitingForNormalization]).waitingJobs,
    1,
    "取得 Normalize 许可前必须计入等待数量"
  );
  const normalizationStarted = ingestionJobFromServerItem({
    ...prepareWaitingItem,
    phase: "normalizing",
    message: "校验格式、压缩原图并生成缩略图",
    progress_seq: 1
  }, waitingForNormalization);
  assert.equal(normalizationStarted.status, "processing");
  assert.equal(ingestionJobStatusLabel(normalizationStarted), "处理中");
  assert.equal(summarizeIngestionJobs([normalizationStarted]).runningJobs, 1);

  const progress = ingestionStatusEventPatch(base, {
    session_id: sessionId,
    image_id: imageId,
    status: "present",
    item: {
      session_id: sessionId,
      image_id: imageId,
      queue: "import",
      source_type: "url",
      resolved_image_time: "2026-08-23T01:02:03.456Z",
      status: "preparing",
      phase: "thumbnail",
      message: "processing",
      progress: 80,
      version: 2,
      progress_seq: 9,
      accepted_at: 1,
      accepted_order: 1
    }
  });
  assert.ok(progress);
  const advanced = reduceIngestionQueue({ jobs: [base], page: 1 }, {
    type: "patch",
    id: base.id,
    patch: progress
  });
  assert.equal(advanced.jobs[0]?.serverProgressSeq, 9);
  assert.equal(advanced.jobs[0]?.serverProgress, 80);

  const resolving = ingestionStatusEventPatch(base, {
    session_id: sessionId,
    image_id: imageId,
    status: "present",
    item: {
      session_id: sessionId,
      image_id: imageId,
      queue: "import",
      source_type: "url",
      resolved_image_time: "2026-08-23T01:02:03.456Z",
      status: "resolving",
      phase: "commit-result",
      message: "核对提交结果",
      version: 3,
      progress_seq: 0,
      last_semantic_revision: 3,
      accepted_at: 1,
      accepted_order: 1
    }
  });
  assert.equal(resolving?.status, "finalized");

  const stale = ingestionStatusEventPatch(advanced.jobs[0]!, {
    session_id: sessionId,
    image_id: imageId,
    status: "present",
    item: {
      session_id: sessionId,
      image_id: imageId,
      queue: "import",
      source_type: "url",
      status: "preparing",
      phase: "thumbnail",
      message: "stale",
      progress: 20,
      version: 2,
      progress_seq: 3,
      accepted_at: 1,
      accepted_order: 1
    }
  });
  assert.ok(stale);
  assert.equal(reduceIngestionQueue(advanced, {
    type: "patch",
    id: base.id,
    patch: stale
  }), advanced);
  assert.equal(ingestionStatusEventPatch(base, {
    session_id: "B".repeat(43),
    image_id: imageId,
    status: "missing"
  }), null);
  const accepted = ingestionJob({
    ...base,
    objectUrl: "blob:retained-missing-card",
    serverAccepted: true,
    serverHandoffPending: true,
    serverDraftPending: true,
    serverHandoffRevision: 12,
    serverAcceptedOrder: 4
  });
  const missingPatch = ingestionStatusEventPatch(accepted, {
    session_id: sessionId,
    image_id: imageId,
    status: "missing"
  });
  assert.ok(missingPatch);
  const missingCard = { ...accepted, ...missingPatch };
  assert.equal(missingCard.status, "failed");
  assert.equal(missingCard.serverAccepted, false);
  assert.equal(missingCard.serverHandoffPending, false);
  assert.equal(missingCard.serverDraftPending, false);
  assert.equal(missingCard.serverHandoffRevision, undefined);
  assert.equal(missingCard.serverAcceptedOrder, undefined);
  assert.equal(missingCard.objectUrl, "blob:retained-missing-card");
  assert.equal(missingCard.message, "未完成内容接入已过期或被服务器丢弃");
  assert.equal(isUnconfirmedUploadRawAttempt(ingestionJob({
    kind: "upload",
    sessionId,
    imageId,
    status: "failed",
    failureStage: "prepare",
    serverStatus: "missing"
  })), true, "canonical 缺失的 raw 失败必须复用原幂等身份重传");
  assert.equal(isUnconfirmedUploadRawAttempt(ingestionJob({
    kind: "upload",
    sessionId,
    imageId,
    status: "failed",
    failureStage: "prepare",
    serverVersion: 1
  })), false, "已由 canonical 接管的失败不得走 raw 意图重放");
  const frozenUploadInput = {
    ...base.draft,
    idempotency_key: attemptKey,
    storage_slug: "local",
    batch_time: "2026-08-23T01:02:03.456Z",
    batch_position: 0,
    expected_size: 1,
    max_long_edge: 4096
  };
  const frozenUploadJob = ingestionJob({
    kind: "upload",
    attemptKey,
    sessionId,
    imageId,
    status: "failed",
    failureStage: "prepare",
    uploadIntentItemInput: frozenUploadInput
  });
  assert.equal(
    ingestionJobAttributesEditable(frozenUploadJob),
    false,
    "接管请求开始后必须冻结会进入 request hash 的草稿"
  );
  assert.equal(
    resetJobForPrepareRetry(frozenUploadJob).uploadIntentItemInput,
    undefined,
    "新尝试不得继承旧 upload intent 正文"
  );
  const retriedServerJob = resetJobForPrepareRetry(ingestionJob({
    ...frozenUploadJob,
    serverAccepted: true,
    serverSemanticRevision: 11,
    serverAcceptedOrder: 19
  }));
  assert.equal(retriedServerJob.serverAccepted, undefined);
  assert.equal(retriedServerJob.serverSemanticRevision, undefined);
  assert.equal(retriedServerJob.serverAcceptedOrder, undefined);
  const frozenImportInput = {
    ...base.draft,
    idempotency_key: attemptKey,
    source_type: "url" as const,
    download_url: "https://example.com/frozen.webp",
    storage_slug: "local"
  };
  assert.equal(
    resetImportJobForPrepareRetry(ingestionJob({
      attemptKey,
      status: "failed",
      failureStage: "create",
      importAcceptItemInput: frozenImportInput
    })).importAcceptItemInput,
    frozenImportInput,
    "Import 响应未知重放必须保留原幂等正文"
  );
  const inFlightPlaceholder = ingestionJob({
    id: "in-flight-defaults",
    attemptKey,
    status: "queued",
    importAcceptItemInput: frozenImportInput,
    serverAccepted: false
  });
  const inFlightDefaults = {
    device: "auto" as const,
    brightness: "auto" as const,
    theme: "",
    author: "clicked-while-accepting",
    tags: []
  };
  assert.equal(
    ingestionAttributeDefaultsPatch(inFlightPlaceholder, inFlightDefaults).author,
    "clicked-while-accepting",
    "已发出 accept 的 placeholder 仍属于应用到全部捕获的本地前缀"
  );
  assert.equal(
    canApplyIngestionAttributeDefaults(inFlightPlaceholder, inFlightDefaults),
    true,
    "只有在途 placeholder 时也必须启用应用到全部"
  );
  const defaultsAppliedInFlight = reduceIngestionQueue({
    jobs: [inFlightPlaceholder],
    page: 1
  }, {
    type: "apply-defaults",
    defaults: inFlightDefaults,
    attempts: new Map([[inFlightPlaceholder.id, attemptKey]])
  }).jobs[0]!;
  assert.equal(defaultsAppliedInFlight.draft.author, "clicked-while-accepting");
  assert.equal(defaultsAppliedInFlight.serverDraftPending, true);
  assert.equal(
    defaultsAppliedInFlight.importAcceptItemInput,
    frozenImportInput,
    "已冻结的 accept 正文不得随本地前缀草稿一起改写"
  );

  const ready = ingestionJob({
    attemptKey,
    sessionId,
    imageId,
    status: "ready",
    serverVersion: 3
  });
  assert.equal(ingestionJobCanStartCommit(ready, "new"), true);
  assert.equal(ingestionJobCanBeCancelled(ready), true);
  assert.equal(ingestionJobCanLeaveQueue(ready), true);
  assert.equal(ingestionJobCanBeRemovedLocally(ingestionJob({
    ...ready,
    status: "done",
    serverAccepted: true,
    serverStatus: "completed"
  })), false, "Server completed 回执只能通过清空已完成持久删除");
  assert.equal(ingestionJobCanBeRemovedLocally(ingestionJob({
    ...ready,
    status: "done",
    serverAccepted: false
  })), true, "PG 已接管且 Redis 回执缺失的本地完成卡仍可移除");
  assert.equal(ingestionQueuePageCount(51, 20), 3);
  const intent = createIngestionCommitIntent(
    ready,
    "019f8457-063a-7004-a580-7a432dc7fd8e"
  );
  assert.equal(intent.attemptId[14], "7");
  assert.deepEqual(intent.metadata.tags, ["existing-tag"]);
  const failedFrozenCommit = ingestionJob({
    ...ready,
    status: "failed",
    failureStage: "commit",
    serverStatus: "failed",
    commitIntent: intent
  });
  assert.equal(ingestionJobCanStartCommit(failedFrozenCommit, "resume"), true);
  assert.equal(
    ingestionJobCanBeCancelled(failedFrozenCommit),
    true,
    "服务端确认提交失败后必须允许显式取消冻结意图"
  );
  assert.equal(ingestionJobCanLeaveQueue(failedFrozenCommit), true);
  assert.equal(ingestionJobCanBeCancelled(ingestionJob({
    ...failedFrozenCommit,
    serverStatus: undefined
  })), false, "结果未知的本地提交失败不得被当成可安全移除");

  const completedStatus = {
    session_id: sessionId,
    image_id: imageId,
    status: "completed" as const,
    completed_item: adminImageListItem({ id: imageId }),
    redis_status: "completed" as const,
    redis_version: 4,
    redis_last_semantic_revision: 4
  };
  assert.equal(
    ingestionJobFromKnownCompletedStatus(base, completedStatus),
    null,
    "Redis 回执仍在分页队列时不得追加第二张本地完成卡"
  );
  assert.equal(
    ingestionJobFromKnownCompletedStatus(base, {
      ...completedStatus,
      redis_status: "missing" as const,
      redis_version: undefined,
      redis_last_semantic_revision: undefined
    })?.status,
    "done",
    "只有 Redis 回执缺失时才由已知 PG 结果接管本地卡片"
  );

  const localPlaceholder = ingestionJob({
    id: "local-placeholder",
    kind: "upload",
    sessionId,
    imageId,
    serverAccepted: false,
    status: "received",
    file: { name: "handoff.webp" } as File
  });
  const acceptedBeforeChannel = ingestionJob({
    ...localPlaceholder,
    serverAccepted: true,
    serverSemanticRevision: 10,
    serverHandoffPending: true,
    serverHandoffRevision: 10
  });
  assert.equal(
    ingestionJobAwaitsActionCoverage(acceptedBeforeChannel, 9),
    true,
    "HTTP accept 后必须等状态通道水位覆盖 canonical 才能执行全队列动作"
  );
  assert.equal(ingestionJobAwaitsActionCoverage(acceptedBeforeChannel, 10), false);
  assert.equal(ingestionJobAwaitsActionCoverage({
    ...acceptedBeforeChannel,
    serverAcceptedOrder: 1
  }, 9), true, "旧 DTO 的 accepted_order 不得越过更新的 HTTP 接管围栏");
  const canonical = ingestionJobFromServerItem({
    session_id: sessionId,
    image_id: imageId,
    queue: "upload",
    source_type: "upload",
    resolved_image_time: "2026-08-23T01:02:03.456Z",
    status: "preparing",
    phase: "thumbnail",
    message: "processing",
    progress: 50,
    version: 2,
    progress_seq: 1,
    last_semantic_revision: 8,
    accepted_at: 1,
    accepted_order: 1,
    metadata: localPlaceholder.draft,
    storage_slug: "local"
  }, localPlaceholder);
  const handedOff = reduceIngestionQueue({
    jobs: [localPlaceholder],
    page: 1
  }, {
    type: "replace-server-page",
    jobs: [canonical]
  });
  assert.equal(handedOff.jobs.length, 1);
  assert.equal(handedOff.jobs[0]?.id, localPlaceholder.id);
  assert.equal(handedOff.jobs[0]?.serverAccepted, true);
  assert.equal(handedOff.jobs[0]?.file, localPlaceholder.file);

  const unboundLocal = ingestionJob({
    id: "late-http-placeholder",
    kind: "import",
    sessionId: undefined,
    imageId: undefined,
    serverAccepted: false,
    serverDraftPending: true,
    status: "queued",
    draft: {
      ...ingestionJob().draft,
      title: "点击时冻结的新草稿"
    },
    file: { name: "late-handoff.webp" } as File
  });
  const earlyCanonical = ingestionJobFromServerItem({
    session_id: sessionId,
    image_id: imageId,
    queue: "import",
    source_type: "url",
    download_url: "https://example.com/late.webp",
    resolved_image_time: "2026-08-23T01:02:03.456Z",
    status: "preparing",
    phase: "thumbnail",
    message: "processing",
    progress: 60,
    version: 3,
    progress_seq: 2,
    last_semantic_revision: 9,
    accepted_at: 1,
    accepted_order: 2,
    metadata: {
      ...unboundLocal.draft,
      title: "accept 请求里的旧草稿"
    },
    storage_slug: "local"
  });
  const lateBinding = reduceIngestionQueue({
    jobs: [unboundLocal, earlyCanonical],
    page: 1
  }, {
    type: "bind-server",
    id: unboundLocal.id,
    binding: {
      sessionId,
      imageId,
      imageTime: "2026-08-23T01:02:03.456Z",
      serverVersion: 4,
      serverSemanticRevision: 10,
      serverHandoffPending: true,
      serverHandoffRevision: 10,
      serverHandoffDisplayPage: 1,
      serverHandoffProvisionalTotal: true,
      status: "queued",
      message: "等待服务器下载"
    }
  });
  assert.equal(lateBinding.jobs.length, 1);
  assert.equal(lateBinding.jobs[0]?.id, unboundLocal.id);
  assert.equal(lateBinding.jobs[0]?.file, unboundLocal.file);
  assert.equal(lateBinding.jobs[0]?.serverAccepted, true);
  assert.equal(lateBinding.jobs[0]?.status, "processing");
  assert.equal(lateBinding.jobs[0]?.serverVersion, 4);
  assert.equal(lateBinding.jobs[0]?.serverSemanticRevision, 10);
  assert.equal(lateBinding.jobs[0]?.serverAcceptedOrder, 2);
  assert.equal(lateBinding.jobs[0]?.serverHandoffRevision, 10);
  assert.equal(lateBinding.jobs[0]?.serverDraftPending, true);
  assert.equal(lateBinding.jobs[0]?.draft.title, "点击时冻结的新草稿");
  assert.equal(lateBinding.jobs[0]?.serverHandoffDisplayPage, 1);
  assert.equal(lateBinding.jobs[0]?.serverHandoffProvisionalTotal, true);
  assert.equal(
    ingestionJobAwaitsActionCoverage(lateBinding.jobs[0]!, 9),
    true,
    "HTTP R+1 响应先于 SSE 时必须保留独立围栏"
  );
  assert.equal(ingestionJobAwaitsActionCoverage(lateBinding.jobs[0]!, 10), false);

  const oldIncarnationImageId =
    "019f8457-063a-7008-a580-7a432dc7fd8e";
  const newIncarnationPlaceholder = ingestionJob({
    id: "new-incarnation-placeholder",
    attemptKey: "new-incarnation-attempt",
    batchKey: "new-incarnation-batch",
    kind: "import",
    status: "queued",
    preview: "new-incarnation-preview"
  });
  const oldIncarnation = ingestionJob({
    id: "server:old-incarnation",
    attemptKey: "old-incarnation-attempt",
    batchKey: "old-incarnation-batch",
    kind: "import",
    sessionId,
    imageId: oldIncarnationImageId,
    serverAccepted: true,
    serverVersion: 99,
    serverStatus: "failed",
    serverError: "old incarnation error",
    preview: "old-incarnation-preview",
    status: "failed"
  });
  const replacedIncarnation = reduceIngestionQueue({
    jobs: [newIncarnationPlaceholder, oldIncarnation],
    page: 1
  }, {
    type: "bind-server",
    id: newIncarnationPlaceholder.id,
    binding: {
      sessionId,
      imageId,
      serverVersion: 1,
      serverSemanticRevision: 12,
      serverHandoffPending: true,
      serverHandoffRevision: 12,
      serverHandoffDisplayPage: 1,
      status: "received",
      message: "服务器已接管新 incarnation"
    }
  });
  assert.equal(replacedIncarnation.jobs.length, 1);
  assert.equal(replacedIncarnation.jobs[0]?.id, newIncarnationPlaceholder.id);
  assert.equal(replacedIncarnation.jobs[0]?.imageId, imageId);
  assert.equal(replacedIncarnation.jobs[0]?.serverVersion, 1);
  assert.equal(
    replacedIncarnation.jobs[0]?.preview,
    "new-incarnation-preview",
    "同 session 新 incarnation 不得继承旧 canonical preview"
  );
  assert.equal(replacedIncarnation.jobs[0]?.serverStatus, undefined);
  assert.equal(replacedIncarnation.jobs[0]?.serverError, undefined);

  const staleSnapshotDuringDraftFence = ingestionJobFromServerItem({
    session_id: sessionId,
    image_id: imageId,
    queue: "import",
    source_type: "url",
    download_url: "https://example.com/late.webp",
    resolved_image_time: "2026-08-23T01:02:03.456Z",
    status: "preparing",
    phase: "thumbnail",
    message: "processing",
    progress: 70,
    version: 4,
    progress_seq: 3,
    last_semantic_revision: 10,
    accepted_at: 1,
    accepted_order: 2,
    metadata: {
      ...unboundLocal.draft,
      title: "旧快照中的草稿"
    },
    storage_slug: "local"
  }, {
    ...lateBinding.jobs[0]!,
    serverVersion: 5,
    serverSemanticRevision: 11,
    serverDraftPending: true,
    draft: {
      ...unboundLocal.draft,
      title: "HTTP 已确认的新草稿"
    }
  }, 10);
  assert.equal(staleSnapshotDuringDraftFence.serverVersion, 5);
  assert.equal(staleSnapshotDuringDraftFence.serverSemanticRevision, 11);
  assert.equal(staleSnapshotDuringDraftFence.serverDraftPending, true);
  assert.equal(
    staleSnapshotDuringDraftFence.draft.title,
    "HTTP 已确认的新草稿",
    "草稿围栏解除前，旧快照不得回退版本或覆盖新草稿"
  );

  const completedReplayBeforeSnapshot = reduceIngestionQueue({
    jobs: [localPlaceholder],
    page: 1
  }, {
    type: "bind-server",
    id: localPlaceholder.id,
    binding: {
      sessionId,
      imageId,
      serverAccepted: true,
      serverHandoffPending: true,
      serverHandoffRevision: undefined,
      status: "finalized",
      resultState: "recovering",
      message: "图片已写入图库，正在读取结果"
    }
  }).jobs[0]!;
  assert.equal(
    ingestionJobAwaitsActionCoverage(completedReplayBeforeSnapshot, 999),
    true,
    "未知 Redis 水位的 completed 重放必须等待一次新权威快照"
  );
  const completedReplayDuringActiveSnapshot = ingestionJobFromServerItem({
    session_id: sessionId,
    image_id: imageId,
    queue: "upload",
    source_type: "upload",
    resolved_image_time: "2026-08-23T01:02:03.456Z",
    status: "preparing",
    phase: "thumbnail",
    message: "processing",
    progress: 50,
    version: 5,
    progress_seq: 1,
    last_semantic_revision: 11,
    accepted_at: 1,
    accepted_order: 1,
    metadata: localPlaceholder.draft,
    storage_slug: "local"
  }, completedReplayBeforeSnapshot, 11);
  assert.equal(completedReplayDuringActiveSnapshot.serverHandoffPending, true);
  assert.equal(
    ingestionJobAwaitsActionCoverage(completedReplayDuringActiveSnapshot, 11),
    true,
    "active 快照不能冒充尚未形成的 Redis completed transition"
  );
  const completionDisplaySource = {
    ...completedReplayDuringActiveSnapshot,
    originalWidth: 6002,
    originalHeight: 9000,
    originalSize: 12_345_678,
    manifestSource: "weibo" as const,
    batchPosition: 4
  };
  const completedReplayAfterSnapshot = ingestionJobFromServerItem({
    session_id: sessionId,
    image_id: imageId,
    queue: "upload",
    status: "completed",
    version: 6,
    progress_seq: 0,
    last_semantic_revision: 12,
    accepted_at: 1,
    accepted_order: 1,
    completed_at: 2,
    completed_item: adminImageListItem({ id: imageId })
  }, completionDisplaySource, 12);
  assert.equal(completedReplayAfterSnapshot.serverHandoffPending, false);
  assert.equal(completedReplayAfterSnapshot.finalSize, 1);
  assert.equal(completedReplayAfterSnapshot.width, 1600);
  assert.equal(completedReplayAfterSnapshot.height, 900);
  assert.equal(completedReplayAfterSnapshot.originalWidth, 6002);
  assert.equal(completedReplayAfterSnapshot.originalHeight, 9000);
  assert.equal(completedReplayAfterSnapshot.originalSize, 12_345_678);
  assert.equal(completedReplayAfterSnapshot.manifestSource, "weibo");
  assert.equal(completedReplayAfterSnapshot.batchPosition, 4);
  assert.equal(
    ingestionJobAwaitsActionCoverage(completedReplayAfterSnapshot, 12),
    false
  );

  const recoveredCompleted = ingestionJobFromServerItem({
    session_id: sessionId,
    image_id: imageId,
    queue: "import",
    status: "completed",
    version: 6,
    progress_seq: 0,
    last_semantic_revision: 12,
    accepted_at: 1,
    accepted_order: 1,
    completed_at: 2,
    display: {
      source_type: "weibo",
      batch_position: 6,
      original_width: 6002,
      original_height: 9000,
      original_size: 12_345_678,
      quality: 80,
      transcoded: true
    },
    completed_item: adminImageListItem({
      id: imageId,
      width: 3001,
      height: 4500,
      image_size: 456_789
    })
  }, ingestionJob({
    batchPosition: 6,
    browserDisplayReleased: true
  }));
  assert.equal(recoveredCompleted.width, 3001);
  assert.equal(recoveredCompleted.height, 4500);
  assert.equal(recoveredCompleted.finalSize, 456_789);
  assert.equal(recoveredCompleted.originalWidth, 6002);
  assert.equal(recoveredCompleted.originalHeight, 9000);
  assert.equal(recoveredCompleted.originalSize, 12_345_678);
  assert.equal(recoveredCompleted.quality, 80);
  assert.equal(recoveredCompleted.transcoded, true);
  assert.equal(recoveredCompleted.manifestSource, "weibo");
  assert.equal(recoveredCompleted.batchPosition, 6);
  assert.equal(
    recoveredCompleted.browserDisplayReleased,
    true,
    "完成回执重映射不得反复夺回已释放的浏览器排序所有权"
  );
  const restoredActive = ingestionJobFromServerItem({
    session_id: "A".repeat(43),
    image_id: "019f8457-063a-7091-a580-7a432dc7fd8e",
    queue: "import",
    source_type: "weibo",
    resolved_image_time: "2026-08-23T01:02:03.456Z",
    status: "queued",
    phase: "queued",
    message: "queued",
    version: 1,
    progress_seq: 0,
    last_semantic_revision: 1,
    accepted_at: 1,
    accepted_order: 2,
    metadata: localPlaceholder.draft,
    storage_slug: "local",
    batch_position: 2
  });
  assert.equal(
    restoredActive.browserDisplayReleased,
    true,
    "无本地 owner 的恢复卡片必须立即使用 Server 稳定顺序"
  );
  assert.equal(
    completedReplayDuringActiveSnapshot.browserDisplayReleased,
    undefined,
    "已有浏览器占位的接管卡片必须保留同批展示所有权"
  );
  const restoredCompletedWithoutOwner = ingestionJobFromServerItem({
    session_id: "B".repeat(43),
    image_id: "019f8457-063a-7092-a580-7a432dc7fd8e",
    queue: "import",
    status: "completed",
    version: 2,
    progress_seq: 0,
    last_semantic_revision: 2,
    accepted_at: 1,
    accepted_order: 3,
    completed_at: 2,
    completed_item: adminImageListItem({
      id: "019f8457-063a-7092-a580-7a432dc7fd8e"
    })
  });
  assert.equal(
    restoredCompletedWithoutOwner.browserDisplayReleased,
    true,
    "窗口重开水合的完成卡片不得再经历一次浏览器批次释放"
  );

  const acceptedWithoutSnapshot = reduceIngestionQueue({
    jobs: [localPlaceholder],
    page: 1
  }, {
    type: "bind-server",
    id: localPlaceholder.id,
    binding: {
      sessionId,
      imageId,
      status: "received",
      message: "服务器已接管"
    }
  }).jobs[0]!;
  assert.equal(
    ingestionJobHasServerAuthority(acceptedWithoutSnapshot),
    true,
    "accept 成功必须立即转交业务权威，不能等待 accepted_order"
  );
  assert.equal(acceptedWithoutSnapshot.serverAcceptedOrder, undefined);

  const handoffBatchKey = webUuidV7();
  const sourceOrderedBatch = Array.from({ length: 5 }, (_, position) => (
    ingestionJob({
      id: `source-order-${position}`,
      attemptKey: `source-order-attempt-${position}`,
      batchKey: handoffBatchKey,
      batchPosition: position,
      serverAccepted: false,
      status: "uploading"
    })
  ));
  let partiallyAccepted = {
    jobs: sourceOrderedBatch,
    page: 1
  };
  for (const position of [4, 1]) {
    partiallyAccepted = reduceIngestionQueue(partiallyAccepted, {
      type: "bind-server",
      id: `source-order-${position}`,
      binding: {
        sessionId: String(position).padStart(43, "S"),
        imageId: `019f8457-063a-7${String(position).padStart(3, "0")}-a580-7a432dc7fd8e`,
        serverAccepted: true,
        serverHandoffPending: true,
        serverHandoffRevision: position + 1,
        serverHandoffDisplayPage: 1,
        status: "received"
      }
    });
  }
  const acceptedBySnapshotOrder = [1, 4].map((position) => (
    partiallyAccepted.jobs.find((job) => (
      job.id === `source-order-${position}`
    ))!
  ));
  partiallyAccepted = reduceIngestionQueue(partiallyAccepted, {
    type: "replace-server-page",
    jobs: acceptedBySnapshotOrder
  });
  assert.deepEqual(
    browserDisplayPrefixJobs(partiallyAccepted.jobs).map((job) => (
      job.batchPosition
    )),
    [0, 1, 2, 3, 4],
    "同批 raw 乱序接管时，浏览器展示所有权必须保留来源顺序"
  );
  assert.equal(
    partiallyAccepted.jobs.length,
    5,
    "Server 快照不得从当前文档展示所有权中拆走已接管卡片"
  );
  partiallyAccepted = reduceIngestionQueue(partiallyAccepted, {
    type: "replace-server-page",
    jobs: []
  });
  assert.deepEqual(
    browserDisplayPrefixJobs(partiallyAccepted.jobs).map((job) => (
      job.batchPosition
    )),
    [0, 1, 2, 3, 4],
    "后续页未覆盖 pair 时也不得丢失当前文档的已接管展示项"
  );
  const partialPagePlan = combinedIngestionQueuePagePlan(
    partiallyAccepted.jobs,
    1,
    20,
    100
  );
  assert.equal(partialPagePlan.serverOffset, 0);
  assert.equal(partialPagePlan.serverLimit, 20);
  assert.equal(partialPagePlan.serverDisplayLimit, 15);
  assert.equal(partialPagePlan.acceptedDisplayPairs.size, 2);
  assert.equal(partialPagePlan.excludedServerItems.length, 2);
  assert.equal(partialPagePlan.includedServerItems.length, 2);
  assert.deepEqual(
    partialPagePlan.visibleDisplayPrefixJobs.map((job) => job.batchPosition),
    [0, 1, 2, 3, 4],
    "逐项接管只能扩大覆盖读取，不得改变当前页卡片位置"
  );

  const fullyAcceptedBatch = sourceOrderedBatch.map((job, position) => ({
    ...job,
    sessionId: String(position).padStart(43, "F"),
    imageId: `019f8457-063a-71${String(position).padStart(2, "0")}-a580-7a432dc7fd8e`,
    serverAccepted: true,
    serverHandoffPending: false,
    status: "received" as const
  }));
  const fullyAcceptedPlan = combinedIngestionQueuePagePlan(
    fullyAcceptedBatch,
    1,
    20,
    100
  );
  assert.deepEqual(
    fullyAcceptedPlan.visibleDisplayPrefixJobs.map((job) => job.batchPosition),
    [0, 1, 2, 3, 4],
    "整批接管后当前文档仍须保留原卡片位置"
  );
  assert.equal(fullyAcceptedPlan.excludedServerItems.length, 5);
  assert.equal(fullyAcceptedPlan.includedServerItems.length, 5);
  assert.equal(fullyAcceptedPlan.serverLimit, 20);
  const retainedBatch = reduceIngestionQueue({
    jobs: fullyAcceptedBatch,
    page: 1
  }, {
    type: "replace-server-page",
    jobs: [...fullyAcceptedBatch]
  });
  assert.deepEqual(
    browserDisplayPrefixJobs(retainedBatch.jobs).map((job) => job.batchPosition),
    [0, 1, 2, 3, 4],
    "当前文档必须在完整接管后继续保序，避免快照参数扩张尾请求"
  );
  assert.ok(retainedBatch.jobs.every((job) => (
    job.browserDisplayReleased !== true && job.batchPosition !== undefined
  )), "只有窗口重开后的 Server-only 任务才应释放浏览器展示顺序");

  const paginationBatchKey = webUuidV7();
  const paginationJobs = Array.from({ length: 23 }, (_, position) => {
    const positionHex = position.toString(16).padStart(3, "0");
    return ingestionJob({
      id: `pagination-owner-${position}`,
      attemptKey: `pagination-attempt-${position}`,
      batchKey: paginationBatchKey,
      batchPosition: position,
      sessionId: `pagination-session-${position}`,
      imageId: `019f8457-063a-7${positionHex}-a580-7a432dc7fd8e`,
      serverAccepted: true,
      status: "committing",
      serverStatus: "committing",
      serverPhase: "committing",
      serverVersion: 5,
      serverProgressSeq: 0,
      serverSemanticRevision: 5
    });
  });
  const compactCompletionOwner = {
    ...paginationJobs[22]!,
    preview: "blob:compact-completion-preview",
    objectUrl: "blob:compact-completion-preview"
  };
  const compactCompletionPatch = completedIngestionReceiptOwnerPatch(
    compactCompletionOwner,
    {
      session_id: compactCompletionOwner.sessionId!,
      image_id: compactCompletionOwner.imageId!,
      status: "completed",
      version: 6,
      progress_seq: 0,
      last_semantic_revision: 6,
      accepted_at: 1,
      accepted_order: 23
    }
  );
  assert.ok(compactCompletionPatch);
  assert.equal(compactCompletionPatch.status, "done");
  assert.equal(compactCompletionPatch.resultState, "recovering");
  assert.equal(
    compactCompletionPatch.objectUrl,
    undefined,
    "compact 回执不得在 PostgreSQL DTO 水合前覆盖或提前回收本地预览"
  );
  const compactCompletedJob = {
    ...compactCompletionOwner,
    ...compactCompletionPatch
  };
  assert.equal(
    compactCompletedJob.objectUrl,
    "blob:compact-completion-preview",
    "compact 终态围栏必须把 Blob 保留到完整 DTO 水合"
  );
  assert.equal(
    ingestionJobFromServerItem({
      session_id: compactCompletionOwner.sessionId!,
      image_id: compactCompletionOwner.imageId!,
      queue: "upload",
      source_type: "upload",
      resolved_image_time: "2026-08-23T01:02:03.456Z",
      status: "resolving",
      phase: "resolving",
      message: "迟到的提交响应",
      progress: null,
      version: 5,
      progress_seq: 0,
      last_semantic_revision: 5,
      accepted_at: 1,
      accepted_order: 23,
      metadata: compactCompletionOwner.draft,
      storage_slug: "local"
    }, compactCompletedJob),
    compactCompletedJob,
    "compact completed 必须立即建立不可回退的逐项终态围栏"
  );
  const completedPatchFor = (job: IngestionJob, version = 6) => {
    const patch = completedIngestionOwnerPatch(job, {
      pair: {
        session_id: job.sessionId!,
        image_id: job.imageId!
      },
      item: adminImageListItem({
        id: job.imageId!,
        title: `completed-${job.batchPosition}`
      }),
      serverVersion: version,
      serverSemanticRevision: version
    });
    assert.ok(patch);
    return patch;
  };
  const allCompletionPatches = new Map(paginationJobs.map((job) => (
    [job.id, completedPatchFor(job)] as const
  )));
  allCompletionPatches.set(
    paginationJobs[22]!.id,
    compactCompletionPatch
  );
  let completedPaginationState = reduceIngestionQueue({
    jobs: paginationJobs,
    page: 1
  }, {
    type: "patch-many",
    patches: allCompletionPatches
  });
  assert.equal(completedPaginationState.jobs.length, 23);
  assert.ok(completedPaginationState.jobs.every((job) => job.status === "done"));
  completedPaginationState = reduceIngestionQueue(completedPaginationState, {
    type: "set-page",
    page: 2,
    pageSize: 20,
    totalItems: 23
  });
  const completedSecondPageFirstRender = combinedIngestionQueuePagePlan(
    completedPaginationState.jobs,
    completedPaginationState.page,
    20,
    100
  ).visibleDisplayPrefixJobs;
  assert.deepEqual(
    completedSecondPageFirstRender.map((job) => job.batchPosition),
    [20, 21, 22]
  );
  assert.deepEqual(
    completedSecondPageFirstRender.map((job) => job.status),
    ["done", "done", "done"],
    "23 项在第一页停留期间完成后，第二页首次渲染必须直接使用逐项最终状态"
  );

  const partialCompletionPatches = new Map<string, Partial<IngestionJob>>();
  for (const position of [20, 22]) {
    const job = paginationJobs[position]!;
    partialCompletionPatches.set(job.id, completedPatchFor(job));
  }
  const failedSecondPageOwner = paginationJobs[21]!;
  partialCompletionPatches.set(
    failedSecondPageOwner.id,
    ingestionJobFromServerItem({
      session_id: failedSecondPageOwner.sessionId!,
      image_id: failedSecondPageOwner.imageId!,
      queue: "import",
      source_type: "url",
      resolved_image_time: "2026-08-23T01:02:03.456Z",
      status: "failed",
      phase: "commit-failed",
      message: "逐项提交失败",
      error: { code: "commit_failed", message: "逐项提交失败" },
      version: 6,
      progress_seq: 0,
      last_semantic_revision: 6,
      accepted_at: 1,
      accepted_order: 22,
      metadata: failedSecondPageOwner.draft,
      storage_slug: "local"
    }, failedSecondPageOwner)
  );
  let partialPaginationState = reduceIngestionQueue({
    jobs: paginationJobs,
    page: 1
  }, {
    type: "patch-many",
    patches: partialCompletionPatches
  });
  assert.ok(
    partialPaginationState.jobs.slice(0, 20)
      .every((job) => job.status === "committing"),
    "顶部汇总不得被用来批量猜测未收到逐项事实的卡片"
  );
  partialPaginationState = reduceIngestionQueue(partialPaginationState, {
    type: "set-page",
    page: 2,
    pageSize: 20,
    totalItems: 23
  });
  assert.deepEqual(
    combinedIngestionQueuePagePlan(
      partialPaginationState.jobs,
      partialPaginationState.page,
      20,
      100
    ).visibleDisplayPrefixJobs.map((job) => job.status),
    ["done", "failed", "done"],
    "离页逐项成功与失败必须保持各自权威结果"
  );

  const completedOwner = completedPaginationState.jobs[20]!;
  const staleSnapshotOwner = ingestionJobFromServerItem({
    session_id: completedOwner.sessionId!,
    image_id: completedOwner.imageId!,
    queue: "import",
    source_type: "url",
    resolved_image_time: "2026-08-23T01:02:03.456Z",
    status: "resolving",
    phase: "commit-result",
    message: "旧分页快照",
    version: 5,
    progress_seq: 0,
    last_semantic_revision: 5,
    accepted_at: 1,
    accepted_order: 21,
    metadata: completedOwner.draft,
    storage_slug: "local"
  }, completedOwner);
  assert.equal(
    staleSnapshotOwner,
    completedOwner,
    "完成事件先于分页 snapshot 时，旧 active DTO 必须被单调围栏"
  );
  const racedSnapshotState = reduceIngestionQueue(
    completedPaginationState,
    { type: "replace-server-page", jobs: [staleSnapshotOwner] }
  );
  assert.equal(racedSnapshotState.jobs.length, 23);
  assert.equal(
    racedSnapshotState.jobs.find((job) => job.id === completedOwner.id)?.status,
    "done"
  );
  assert.equal(
    new Set(racedSnapshotState.jobs.map((job) => job.id)).size,
    23,
    "分页 snapshot 与完成事件交叉不得重复挂载卡片"
  );

  const responseRaceOwner = paginationJobs[0]!;
  const finalizedResponsePatch = {
    serverAttemptKey: responseRaceOwner.attemptKey,
    serverSessionId: responseRaceOwner.sessionId,
    serverImageId: responseRaceOwner.imageId,
    serverVersion: 7,
    serverProgressSeq: 0,
    serverStatus: "resolving",
    serverPhase: "commit-result",
    status: "finalized" as const,
    resultState: "pending" as const,
    message: "等待完成结果"
  };
  const finalizedBeforeEvent = reduceIngestionQueue({
    jobs: [responseRaceOwner],
    page: 1
  }, {
    type: "patch",
    id: responseRaceOwner.id,
    patch: finalizedResponsePatch
  });
  const eventAfterResponse = reduceIngestionQueue(finalizedBeforeEvent, {
    type: "patch",
    id: responseRaceOwner.id,
    patch: completedPatchFor(finalizedBeforeEvent.jobs[0]!, 6)
  });
  assert.equal(eventAfterResponse.jobs[0]?.status, "done");
  assert.equal(eventAfterResponse.jobs[0]?.serverVersion, 7);
  const progressedResponseOwner = {
    ...finalizedBeforeEvent.jobs[0]!,
    serverProgressSeq: 4
  };
  const eventAfterProgressedResponse = reduceIngestionQueue({
    jobs: [progressedResponseOwner],
    page: 1
  }, {
    type: "patch",
    id: progressedResponseOwner.id,
    patch: completedPatchFor(progressedResponseOwner, 6)
  });
  assert.equal(eventAfterProgressedResponse.jobs[0]?.status, "done");
  assert.equal(eventAfterProgressedResponse.jobs[0]?.serverVersion, 7);
  assert.equal(
    eventAfterProgressedResponse.jobs[0]?.serverProgressSeq,
    4,
    "较旧完成事实必须取胜，但不能倒退浏览器已观察到的 Redis 时钟"
  );
  const completedSnapshotAfterNewerActive = ingestionJobFromServerItem({
    session_id: responseRaceOwner.sessionId!,
    image_id: responseRaceOwner.imageId!,
    queue: "import",
    status: "completed",
    version: 6,
    progress_seq: 0,
    last_semantic_revision: 6,
    accepted_at: 1,
    accepted_order: 1,
    completed_at: 2,
    completed_item: adminImageListItem({ id: responseRaceOwner.imageId! })
  }, progressedResponseOwner);
  assert.equal(completedSnapshotAfterNewerActive.status, "done");
  assert.equal(completedSnapshotAfterNewerActive.serverVersion, 7);
  assert.equal(completedSnapshotAfterNewerActive.serverProgressSeq, 4);
  const eventBeforeResponse = reduceIngestionQueue({
    jobs: [responseRaceOwner],
    page: 1
  }, {
    type: "patch",
    id: responseRaceOwner.id,
    patch: completedPatchFor(responseRaceOwner, 6)
  });
  assert.equal(reduceIngestionQueue(eventBeforeResponse, {
    type: "patch",
    id: responseRaceOwner.id,
    patch: finalizedResponsePatch
  }), eventBeforeResponse, "迟到的提交 HTTP 状态不得把 completed 卡片回退为 finalized");

  const displayOldIncarnation = fullyAcceptedBatch[0]!;
  const replacementIncarnation = ingestionJob({
    ...displayOldIncarnation,
    id: displayOldIncarnation.id,
    imageId: "019f8457-063a-7200-a580-7a432dc7fd8e",
    batchPosition: undefined,
    browserDisplayReleased: true
  });
  const staleReplaced = reduceIngestionQueue({
    jobs: [displayOldIncarnation, sourceOrderedBatch[1]!],
    page: 1
  }, {
    type: "replace-server-page",
    jobs: [replacementIncarnation],
    stalePairKeys: new Set([
      `${displayOldIncarnation.sessionId}\0${displayOldIncarnation.imageId!.toLowerCase()}`
    ])
  });
  assert.equal(staleReplaced.jobs.length, 2);
  assert.equal(staleReplaced.jobs[0]?.id, sourceOrderedBatch[1]!.id);
  assert.equal(staleReplaced.jobs[1]?.imageId, replacementIncarnation.imageId);
  assert.equal(staleReplaced.jobs[1]?.batchPosition, undefined);

  const fullPageAcceptedPositions = new Set([0, 3, 19, 21, 25, 39]);
  const fullPageBatch = Array.from({ length: 40 }, (_, position) => ingestionJob({
    id: `full-page-${position}`,
    attemptKey: `full-page-attempt-${position}`,
    batchKey: handoffBatchKey,
    batchPosition: position,
    sessionId: fullPageAcceptedPositions.has(position)
      ? `full-page-session-${position}`
      : undefined,
    imageId: fullPageAcceptedPositions.has(position)
      ? `full-page-image-${position}`
      : undefined,
    serverAccepted: fullPageAcceptedPositions.has(position),
    status: fullPageAcceptedPositions.has(position) ? "received" : "uploading"
  }));
  const firstFullPagePlan = combinedIngestionQueuePagePlan(
    fullPageBatch,
    1,
    20,
    100
  );
  assert.equal(firstFullPagePlan.serverOffset, 0);
  assert.equal(
    firstFullPagePlan.serverLimit,
    20,
    "浏览器前缀占满整页时仍应保留一页 Server 替补，避免 handoff 重读"
  );
  assert.deepEqual(firstFullPagePlan.includedServerItems, [
    {
      session_id: "full-page-session-0",
      image_id: "full-page-image-0"
    },
    {
      session_id: "full-page-session-3",
      image_id: "full-page-image-3"
    },
    {
      session_id: "full-page-session-19",
      image_id: "full-page-image-19"
    }
  ]);
  const secondFullPagePlan = combinedIngestionQueuePagePlan(
    fullPageBatch,
    2,
    20,
    100
  );
  assert.equal(
    secondFullPagePlan.serverOffset,
    0,
    "跨页展示前缀仍从排除当前文档后的 Server 候选首页开始"
  );
  assert.equal(secondFullPagePlan.serverLimit, 20);
  assert.equal(secondFullPagePlan.includedServerItems.length, 3);

  const partialSecondPagePlan = combinedIngestionQueuePagePlan(
    fullPageBatch.slice(0, 25),
    2,
    20,
    100
  );
  assert.equal(partialSecondPagePlan.serverOffset, 0);
  assert.equal(
    partialSecondPagePlan.serverLimit,
    20,
    "末页读取须同时覆盖已接管卡片与一页稳定 Server 替补"
  );
  assert.equal(partialSecondPagePlan.serverDisplayLimit, 15);
  assert.equal(partialSecondPagePlan.includedServerItems.length, 1);

  const takeoverJobs = Array.from({ length: 30 }, (_, index) => ingestionJob({
    id: `takeover-${index}`,
    sessionId: `session-${index}`,
    imageId: `image-${index}`,
    serverAccepted: true,
    status: "received"
  }));
  assert.deepEqual(
    serverIngestionJobsForCombinedPage(takeoverJobs, [], 0),
    [],
    "本地前缀填满页面时，逐项 takeover 不得把 Server 占位追加到当前页"
  );
  assert.deepEqual(
    serverIngestionJobsForCombinedPage(
      takeoverJobs,
      [],
      1,
      new Set(["session-0\0image-0"])
    ).map((job) => job.id),
    ["takeover-0"],
    "响应先于 snapshot 时须在现有 Server 槽位保留原占位卡"
  );
  assert.deepEqual(
    serverIngestionJobsForCombinedPage(takeoverJobs, [
      { session_id: "session-8", image_id: "image-8" },
      { session_id: "session-3", image_id: "image-3" }
    ], 1).map((job) => job.id),
    ["takeover-8"],
    "canonical 接管后的展示顺序必须服从当前有界快照"
  );
});

test("逐项 active 事件在 bounded snapshot 前保留来源无关 handoff 汇总", () => {
  const sourceCases = [
    { queue: "upload", sourceType: "upload" },
    { queue: "import", sourceType: "url" },
    { queue: "import", sourceType: "jsonl" },
    { queue: "import", sourceType: "weibo" }
  ] as const;
  const provisionalOwners = Array.from({ length: 25 }, (_, index) => {
    const source = sourceCases[index % sourceCases.length]!;
    return ingestionJob({
      id: `provisional-owner-${index}`,
      attemptKey: `provisional-attempt-${index}`,
      batchKey: "provisional-batch",
      batchPosition: index,
      kind: source.queue,
      sessionId: String(index).padStart(43, "P"),
      imageId: `019f8457-063a-7${index.toString(16).padStart(3, "0")}`
        + "-a580-7a432dc7fd8e",
      status: "queued",
      serverAccepted: true,
      serverVersion: 1,
      serverProgressSeq: 0,
      serverSemanticRevision: 25,
      serverHandoffPending: true,
      serverHandoffRevision: 25,
      serverHandoffDisplayPage: 1,
      serverHandoffProvisionalTotal: true,
      serverAcceptedOrder: index + 1
    });
  });
  const activeEventFor = (job: IngestionJob, index: number) => {
    const source = sourceCases[index % sourceCases.length]!;
    return {
      session_id: job.sessionId!,
      image_id: job.imageId!,
      queue: source.queue,
      source_type: source.sourceType,
      resolved_image_time: "2026-09-04T00:00:00.000Z",
      status: "preparing" as const,
      phase: "normalizing",
      message: "校验格式、压缩原图并生成缩略图",
      progress: null,
      version: 2,
      progress_seq: 0,
      last_semantic_revision: 25,
      accepted_at: 1,
      accepted_order: index + 1,
      metadata: job.draft,
      storage_slug: "local"
    };
  };
  const projectedOwners = provisionalOwners.map((job, index) => (
    index < 18
      ? ingestionJobFromServerItem(activeEventFor(job, index), job)
      : job
  ));
  const retainedProvisionalOwners = projectedOwners.filter((job) => (
    job.serverHandoffPending === true
    && job.serverHandoffProvisionalTotal === true
  ));
  assert.equal(
    retainedProvisionalOwners.length,
    25,
    "bounded snapshot 接管汇总前，任意来源的逐项事件不得逐张撤掉临时总数"
  );
  assert.ok(projectedOwners.every((job) => (
    job.serverHandoffDisplayPage === 1
  )), "逐项事件也不得撤掉尚未被 snapshot 覆盖的展示页租约");
  assert.deepEqual(summarizeIngestionJobs(retainedProvisionalOwners), {
    readyCount: 0,
    unfinishedCount: 25,
    duplicateJobs: 0,
    waitingJobs: 7,
    runningJobs: 18,
    commitQueuedJobs: 0,
    committingJobs: 0,
    finalizedJobs: 0,
    doneJobs: 0,
    failedJobs: 0
  }, "处理阶段只应在等待与处理中之间逐项迁移，总数必须保持 25");
  assert.deepEqual(
    combinedIngestionQueuePagePlan(
      projectedOwners,
      1,
      20,
      100
    ).visibleDisplayPrefixJobs.map((job) => job.batchPosition),
    Array.from({ length: 20 }, (_, index) => index),
    "pageSize=20 时首个 bounded page 的当前文档顺序必须保持稳定"
  );

  const snapshotCoveredOwner = ingestionJobFromServerItem(
    activeEventFor(projectedOwners[0]!, 0),
    projectedOwners[0],
    25
  );
  assert.equal(snapshotCoveredOwner.serverHandoffPending, false);
  assert.equal(snapshotCoveredOwner.serverHandoffDisplayPage, undefined);
  assert.equal(snapshotCoveredOwner.serverHandoffProvisionalTotal, undefined);
});

test("completed status 与 SSE revision 交叉时立即补查且不轮询", () => {
  assert.deepEqual(ingestionHandoffRetryDecision(100, 100, 100), {
    retryAfterRevision: 100,
    retryImmediately: false
  });
  assert.deepEqual(ingestionHandoffRetryDecision(100, 101, 100), {
    retryAfterRevision: 100,
    retryImmediately: true
  });
  assert.deepEqual(ingestionHandoffRetryDecision(100, 101, 101), {
    retryAfterRevision: 101,
    retryImmediately: false
  });
});

test("Server 内容接入队列 Hook 在重连与任意分页时只保留一个 SSE 和当前页基线", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=strict-root></div>"
      + "<div id=empty-root></div><div id=root></div></body></html>"
  );
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
      "../../packages/web/src/pages/admin/ingestion/queue/useServerIngestionQueue.ts"
    );
    const { useIngestionQueue } = await import(
      "../../packages/web/src/pages/admin/ingestion/queue/useIngestionQueue.ts"
    );
    const sessionId = "S".repeat(43);
    const imageId = "019f8457-063a-7009-a580-7a432dc7fd8e";
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
      accepted_at: 1,
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
    const handoffImageId = "019f8457-063a-7011-a580-7a432dc7fd8e";
    const unknownSessionId = "U".repeat(43);
    const unknownImageId = "019f8457-063a-7013-a580-7a432dc7fd8e";
    const unknownPlaceholderId = "owner-unknown-completed-placeholder-0";
    const coveredSessionId = "V".repeat(43);
    const coveredImageId = "019f8457-063a-7014-a580-7a432dc7fd8e";
    const crossGenerationCompletedSessionId = "Q".repeat(43);
    const crossGenerationCompletedImageId =
      "019f8457-063a-7019-a580-7a432dc7fd8e";
    const crossGenerationPresentSessionId = "P".repeat(43);
    const crossGenerationPresentImageId =
      "019f8457-063a-7018-a580-7a432dc7fd8e";
    const crossGenerationSessionId = "W".repeat(43);
    const crossGenerationImageId = "019f8457-063a-7015-a580-7a432dc7fd8e";
    const releaseRaceSessionId = "X".repeat(43);
    const releaseRaceImageId = "019f8457-063a-7016-a580-7a432dc7fd8e";
    const releaseRacePlaceholderId = "owner-release-race-placeholder";
    const releaseRaceAttemptKey = "owner-release-race-attempt";
    const mountedReleaseSessionId = "Y".repeat(43);
    const mountedReleaseImageId = "019f8457-063a-7017-a580-7a432dc7fd8e";
    const incarnationSessionId = "I".repeat(43);
    const oldIncarnationImageId = "019f8457-063a-7028-a580-7a432dc7fd8e";
    const nextIncarnationImageId = "019f8457-063a-7029-a580-7a432dc7fd8e";
    const nextIncarnationPlaceholderId = "owner-next-incarnation-placeholder";
    const nextIncarnationAttemptKey = "owner-next-incarnation-attempt";
    const reconnectVisibleSessionId = "J".repeat(43);
    const reconnectVisibleImageId = "019f8457-063a-7038-a580-7a432dc7fd8e";
    const reconnectOffPageSessionId = "K".repeat(43);
    const reconnectOffPageImageId = "019f8457-063a-7039-a580-7a432dc7fd8e";
    const loadingAcceptedSessionId = "L".repeat(43);
    const visibleReadyReleaseImageIds = [
      "019f8457-063a-703f-a580-7a432dc7fd8e",
      "019f8457-063a-7040-a580-7a432dc7fd8e",
      "019f8457-063a-7041-a580-7a432dc7fd8e",
      "019f8457-063a-7042-a580-7a432dc7fd8e",
      "019f8457-063a-7043-a580-7a432dc7fd8e",
      "019f8457-063a-7044-a580-7a432dc7fd8e",
      "019f8457-063a-7045-a580-7a432dc7fd8e"
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
          + "-b580-7a432dc7fd8e"
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
          + "-c580-7a432dc7fd8e"
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
        queue.bindServerJob(placeholder.id, {
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
        queue.bindServerJob(placeholder.id, {
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
        queue.bindServerJob(placeholder.id, {
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
        queue.bindServerJob("owner-cross-generation-completed-placeholder", {
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
        queue.bindServerJob("owner-cross-generation-present-placeholder", {
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
        queue.bindServerJob("owner-cross-generation-placeholder", {
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
        queue.bindServerJob(releaseRacePlaceholderId, {
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
        queue.bindServerJob(placeholder.id, {
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
        queue.bindServerJob(oldPlaceholder.id, {
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
        queue.bindServerJob(nextPlaceholder.id, {
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
        queue.bindServerJob("owner-reconnect-off-page-placeholder", {
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
        queue.bindServerJob("owner-reconnect-visible-placeholder", {
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
        queue.bindServerJob("owner-loading-accepted-placeholder", {
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
        const placeholders = visibleReadyReleaseImageIds.map((imageId, index) => (
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
          queue.bindServerJob(placeholder.id, {
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
    const strictContainer = document.getElementById("strict-root");
    const emptyContainer = document.getElementById("empty-root");
    assert.ok(container);
    assert.ok(strictContainer);
    assert.ok(emptyContainer);
    const root = createRoot(container);
    const strictRoot = createRoot(strictContainer);
    const emptyRoot = createRoot(emptyContainer);
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
    const respond = (request: PendingSnapshot, payload: unknown) => {
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

    try {
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
      }
      assert.equal(ControlledEventSource.active.size, 0);
      ControlledEventSource.all.length = 0;
      requests.length = 0;

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
      }
      assert.equal(ControlledEventSource.active.size, 0);
      ControlledEventSource.all.length = 0;
      requests.length = 0;

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
        await new Promise((resolve) => setTimeout(resolve, 120));
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
        accepted_at: 1,
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
        "019f8457-063a-7092-a580-7a432dc7fd8e";
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
            accepted_at: 1,
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
        "019f8457-063a-7093-a580-7a432dc7fd8e";
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
            accepted_at: 1,
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
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      assert.equal(
        requests.length,
        failedRefreshStart + 1,
        "重复普通 refresh 失败后不得绕过首档有界退避"
      );
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 70));
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
      const capturedImageId = "019f8457-063a-7042-a580-7a432dc7fd8e";
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
        await new Promise((resolve) => setTimeout(resolve, 120));
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
        image_id: "019f8457-063a-7044-a580-7a432dc7fd8e"
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
        await new Promise((resolve) => setTimeout(resolve, 120));
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
        await new Promise((resolve) => setTimeout(resolve, 150));
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
        await new Promise((resolve) => setTimeout(resolve, 120));
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
        await new Promise((resolve) => setTimeout(resolve, 520));
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
        await new Promise((resolve) => setTimeout(resolve, 120));
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
            accepted_at: 1,
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

      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(OwnerProbe, { displayed: true })
        ));
        await Promise.resolve();
      });
      await settleUntil(() => ControlledEventSource.all.length === 2);
      const ownerSource = ControlledEventSource.all[1]!;
      await React.act(async () => {
        ownerSource.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 30,
          action_scope: "scope-owner"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === 4);
      await React.act(async () => {
        respond(requests[3]!, {
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
      const ownerView = () => JSON.parse(container.textContent || "{}") as {
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
      await settleUntil(() => requests.length === 5);
      assert.equal(
        new URL(requests[4]!.url, "https://imageshow.test")
          .searchParams.get("offset"),
        "40"
      );
      await React.act(async () => {
        respond(requests[4]!, {
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
            accepted_at: 1,
            accepted_order: 20
          },
          action_watermark: "watermark-reduced"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === 6);
      await React.act(async () => {
        respond(requests[5]!, {
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
      await settleUntil(() => requests.length === 7);
      assert.equal(ownerView().page, 1);
      assert.equal(
        new URL(requests[6]!.url, "https://imageshow.test")
          .searchParams.get("offset"),
        "0"
      );
      const remainingImageId = "019f8457-063a-7010-a580-7a432dc7fd8e";
      await React.act(async () => {
        respond(requests[6]!, {
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
      assert.equal(ControlledEventSource.all.length, 2);
      assert.equal(ControlledEventSource.active.size, 1);

      assert.ok(bindOwnerHandoff);
      await React.act(async () => {
        bindOwnerHandoff!(33);
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().pendingHandoff && requests.length === 8
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
              "019f8457-063a-7012-a580-7a432dc7fd8e"
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
        respond(requests[7]!, {
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
        "019f8457-063a-7044-a580-7a432dc7fd8e";
      const completedSnapshotItem = adminImageListItem({
        id: completedSnapshotImageId,
        author: "snapshot-author",
        tags: ["snapshot-tag"]
      });
      const adjacentCompletedItem = adminImageListItem({
        id: "019f8457-063a-7045-a580-7a432dc7fd8e",
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
        accepted_at: 1,
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
        `019f8457-063a-${(0x7050 + index).toString(16)}-a580-7a432dc7fd8e`
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
        await new Promise((resolve) => setTimeout(resolve, 120));
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

      const recoveryDelays = [120, 520, 1_520] as const;
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
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
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
        root.render(withQueryClient(
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
        root.render(withQueryClient(
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
        "019f8457-063a-7046-a580-7a432dc7fd8e";
      const retainedCompletedSessionId = "O".repeat(43);
      const retainedCompletedImageId =
        "019f8457-063a-7047-a580-7a432dc7fd8e";
      const browserCompletedSessionId = "R".repeat(43);
      const browserCompletedImageId =
        "019f8457-063a-7048-a580-7a432dc7fd8e";
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
        accepted_at: 1,
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
            accepted_at: 1,
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
                  accepted_at: 1,
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
                  accepted_at: 1,
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
            accepted_at: 1,
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
            accepted_at: 1,
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
        accepted_at: 1,
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
              accepted_at: 1,
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
            accepted_at: 1,
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
      )).items;
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
        JSON.parse(String(compactChunkRetryFirstRequest.init.body)).items
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
        root.render(withQueryClient(
          React.createElement(OwnerProbe, { displayed: false })
        ));
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().status === "idle");
      assert.equal(reopenedOwnerSource.closed, true);
      assert.equal(ControlledEventSource.active.size, 0);
    } finally {
      await React.act(async () => root.unmount());
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

test("全队列动作冻结水位并以同一 action ID 有界续传", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const requests: Array<Record<string, unknown>> = [];
    let fetchCalls = 0;
    let refreshes = 0;
    const observedActionCompleted: string[] = [];
    const actionCompletedItem = adminImageListItem({
      id: "019f8457-063a-7001-a580-7a432dc7fd8e"
    });
    const connectionHold = { current: false };
    const fetchStub = async (_path: string, init?: RequestInit) => {
      assert.equal(
        connectionHold.current,
        true,
        "continuation 执行期间必须持有当前 owner 状态通道"
      );
    fetchCalls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push(body);
    if (fetchCalls === 1) {
      return new Response("upstream response lost", { status: 502 });
    }
    if (body.action === "clear_completed") {
      return new Response(JSON.stringify({
        ok: true,
        processed: 0,
        changed: 0,
        failed: 0,
        items: []
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const continuation = body.continuation;
    const skipped = Boolean(continuation);
    return new Response(JSON.stringify({
      ok: true,
      processed: 1,
      changed: skipped ? 0 : 1,
      failed: 0,
      items: [{
        session_id: continuation ? "B".repeat(43) : "A".repeat(43),
        image_id: continuation
          ? "019f8457-063a-7002-a580-7a432dc7fd8e"
          : "019f8457-063a-7001-a580-7a432dc7fd8e",
        status: skipped ? "skipped" : "changed",
        ...(continuation ? {} : { completed_item: actionCompletedItem })
      }],
      ...(continuation ? {} : { continuation: "signed-next-cursor" })
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
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
    fetch: fetchStub,
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
    const { useIngestionQueueActions } = await import(
      "../../packages/web/src/pages/admin/ingestion/queue/useIngestionQueueActions.ts"
    );
    const server = {
      status: "ready",
      actionScope: "S".repeat(32),
      actionWatermark: "frozen-watermark",
      lastAcceptedOrder: 120,
      connectionGeneration: 7,
      refresh: () => { refreshes += 1; },
      recoverAuthority: async () => { refreshes += 1; }
    };
    let actions: ReturnType<typeof useIngestionQueueActions> | undefined;
    function Probe() {
      actions = useIngestionQueueActions(
        "upload",
        server as never,
        connectionHold,
        (entries) => {
          assert.equal(refreshes, 0, "完成 DTO 必须在动作刷新前交给 owner");
          observedActionCompleted.push(...entries.map(({ pair }) => pair.image_id));
        }
      );
      return null;
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.ok(actions);
    const originalDateNow = Date.now;
    let frozen: ReturnType<typeof actions.freeze>;
    let laterFrozen: ReturnType<typeof actions.freeze>;
    try {
      Date.now = () => 1_700_000_000_000;
      frozen = actions.freeze("apply_metadata", { title: "全部标题" });
      laterFrozen = actions.freeze("apply_metadata", { title: "稍后标题" });
    } finally {
      Date.now = originalDateNow;
    }
    assert.ok(frozen);
    assert.ok(laterFrozen);
    assert.ok(
      frozen.actionRequestId < laterFrozen.actionRequestId,
      "同毫秒冻结的新动作必须取得更大的 UUIDv7 序值"
    );
    assert.equal(frozen.actionWatermark, "frozen-watermark");
    let result: Awaited<ReturnType<typeof actions.run>> | undefined;
    let queuedResult: Awaited<ReturnType<typeof actions.run>> | undefined;
    let queuedRun: ReturnType<typeof actions.run> | undefined;
    let preflightHeld = false;
    let overlappingFrozen: ReturnType<typeof actions.freeze> | undefined;
    await React.act(async () => {
      result = await actions!.run(frozen, async () => {
        preflightHeld = connectionHold.current;
        overlappingFrozen = actions!.freeze("clear_completed");
        assert.ok(overlappingFrozen);
        queuedRun = actions!.run(overlappingFrozen);
        await Promise.resolve();
      });
      queuedResult = await queuedRun;
    });
    assert.equal(preflightHeld, true, "动作前置草稿排空也必须保持 SSE");
    assert.ok(overlappingFrozen, "在途阶段仍须冻结点击时的第二个队列动作");
    assert.notEqual(
      overlappingFrozen.actionRequestId,
      frozen.actionRequestId,
      "排队动作必须使用独立幂等 ID"
    );
    assert.deepEqual(queuedResult && {
      processed: queuedResult.processed,
      changed: queuedResult.changed,
      failed: queuedResult.failed
    }, { processed: 0, changed: 0, failed: 0 });
    assert.equal(connectionHold.current, false);
    assert.deepEqual(result && {
      processed: result.processed,
      changed: result.changed,
      failed: result.failed
    }, { processed: 2, changed: 1, failed: 0 });
    assert.equal(
      actions.notice,
      "",
      "只有状态变化而无真实失败时不得显示协议动作汇总"
    );
    assert.equal(fetchCalls, 4);
    assert.equal(refreshes, 0, "成功动作由 SSE 收敛，不得追加同页快照");
    assert.deepEqual(
      observedActionCompleted,
      [actionCompletedItem.id],
      "页外清理动作返回的完成 DTO 必须进入 owner 失效入口"
    );
    assert.equal(requests[0]?.action_request_id, frozen.actionRequestId);
    assert.equal(requests[1]?.action_request_id, frozen.actionRequestId);
    assert.equal(requests[2]?.action_request_id, frozen.actionRequestId);
    assert.equal(
      requests[3]?.action_request_id,
      overlappingFrozen.actionRequestId,
      "第二个动作必须等首个动作完整续传后再执行"
    );
    assert.equal(requests[0]?.action_watermark, "frozen-watermark");
    assert.equal(requests[1]?.continuation, undefined);
    assert.equal(requests[2]?.continuation, "signed-next-cursor");
    assert.deepEqual(requests[0], requests[1], "网络重试必须复用首批完整请求");

    const nonBlockingFrozen = actions.freeze(
      "apply_metadata",
      { title: "不阻塞输入框" }
    );
    assert.ok(nonBlockingFrozen);
    let releaseNonBlockingPreflight!: () => void;
    const nonBlockingPreflight = new Promise<void>((resolve) => {
      releaseNonBlockingPreflight = resolve;
    });
    let nonBlockingRun!: ReturnType<typeof actions.run>;
    await React.act(async () => {
      nonBlockingRun = actions!.run(
        nonBlockingFrozen,
        () => nonBlockingPreflight,
        { blockUi: false }
      );
      await Promise.resolve();
    });
    assert.equal(connectionHold.current, true);
    assert.equal(
      actions.busy,
      false,
      "应用默认值的后台持久化不得禁用整窗卡片控件"
    );
    await React.act(async () => {
      releaseNonBlockingPreflight();
      await nonBlockingRun;
    });
    assert.equal(connectionHold.current, false);
    assert.equal(actions.busy, false);

    server.status = "loading";
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(
      actions.freeze("commit_ready"),
      null,
      "只读保留页不得复用旧水位，也不得在未来快照上扩大动作范围"
    );
    server.status = "ready";
    server.actionScope = "T".repeat(32);
    server.actionWatermark = "reconnected-watermark";
    server.connectionGeneration = 8;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const reconnected = actions.freeze("commit_ready");
    assert.ok(reconnected);
    assert.equal(reconnected.actionScope, "T".repeat(32));
    assert.equal(reconnected.actionWatermark, "reconnected-watermark");
    server.connectionGeneration = 9;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await React.act(async () => {
      assert.equal(await actions!.run(reconnected), null);
    });
    assert.equal(refreshes, 1, "动作失败仍须请求一次权威收敛");
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

test("失效动作凭证先恢复 CSRF 再按 owner 刷新权威水位", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const requestOrder: string[] = [];
  let actionRequests = 0;
  let uploadSnapshotRequests = 0;
  let importSnapshotRequests = 0;
  let authRecoveries = 0;
  let ordinaryRefreshes = 0;
  const fetchStub = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), "https://imageshow.test");
    const csrf = new Headers(init.headers).get("x-csrf-token") ?? "";
    if (url.pathname === ingestionActionPath) {
      actionRequests += 1;
      requestOrder.push(`action:${csrf}`);
      return new Response(JSON.stringify({
        ok: false,
        code: "invalid_ingestion_token",
        error: "内容接入凭证已过期或时间无效"
      }), {
        status: 401,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.pathname === ingestionSnapshotPath) {
      const queue = url.searchParams.get("queue");
      if (queue === "upload") uploadSnapshotRequests += 1;
      else importSnapshotRequests += 1;
      requestOrder.push(`snapshot:${queue}:${csrf}`);
      return new Response(JSON.stringify({
        ok: true,
        queue,
        revision: 2,
        last_accepted_order: 0,
        offset: Number(url.searchParams.get("offset")),
        limit: Number(url.searchParams.get("limit")),
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
        stale_items: [],
        action_watermark: "fresh-upload-watermark"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
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
    fetch: fetchStub,
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
    setCsrfToken("expired-csrf");
    const { createRoot } = await import("react-dom/client");
    const { useIngestionQueueActions } = await import(
      "../../packages/web/src/pages/admin/ingestion/queue/useIngestionQueueActions.ts"
    );
    const uploadServer = {
      status: "ready",
      actionScope: "U".repeat(32),
      actionWatermark: "expired-upload-watermark",
      connectionGeneration: 1,
      refresh: () => { ordinaryRefreshes += 1; },
      recoverAuthority: async () => {
        const snapshot = await getIngestionQueueSnapshot({
          queue: "upload",
          offset: 0,
          limit: 20,
          exclude_items: [],
          include_items: []
        }, uploadServer.actionScope);
        uploadServer.actionWatermark = snapshot.action_watermark;
      }
    };
    const importServer = {
      ...uploadServer,
      actionScope: "I".repeat(32),
      actionWatermark: "untouched-import-watermark",
      recoverAuthority: async () => {
        importSnapshotRequests += 1;
      }
    };
    const recoverAuthSession = async () => {
      authRecoveries += 1;
      requestOrder.push("auth");
      setCsrfToken("current-csrf");
    };
    let uploadActions: ReturnType<typeof useIngestionQueueActions> | undefined;
    let importActions: ReturnType<typeof useIngestionQueueActions> | undefined;
    function Probe() {
      uploadActions = useIngestionQueueActions(
        "upload",
        uploadServer as never,
        { current: false },
        () => undefined,
        recoverAuthSession
      );
      importActions = useIngestionQueueActions(
        "import",
        importServer as never,
        { current: false },
        () => undefined,
        recoverAuthSession
      );
      return null;
    }
    const root = createRoot(document.getElementById("root")!);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const frozen = uploadActions!.freeze("commit_ready");
    assert.ok(frozen);
    let result: Awaited<ReturnType<typeof uploadActions.run>> | undefined;
    await React.act(async () => {
      result = await uploadActions!.run(frozen);
    });
    assert.equal(result, null);
    assert.equal(actionRequests, 1, "失效凭证不得自动重放原动作");
    assert.equal(authRecoveries, 1);
    assert.equal(uploadSnapshotRequests, 1);
    assert.equal(importSnapshotRequests, 0, "upload 恢复不得刷新 import owner");
    assert.equal(ordinaryRefreshes, 0, "凭证恢复不得抢先发出旧 CSRF snapshot");
    assert.deepEqual(requestOrder, [
      "action:expired-csrf",
      "auth",
      "snapshot:upload:current-csrf"
    ]);
    assert.equal(uploadServer.actionWatermark, "fresh-upload-watermark");
    assert.equal(uploadActions!.notice, "", "新权威 snapshot 后应清除旧凭证提示");
    assert.equal(importActions!.notice, "");
    await React.act(async () => root.unmount());
  } finally {
    clearCsrfToken();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

test("应用到全部在默认空主题下发送规范化稀疏 metadata", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const actionBodies: Array<Record<string, unknown>> = [];
  let appliedDefaults: Record<string, unknown> | undefined;
  let refreshes = 0;
  let postActionRecoveries = 0;
  let authRecoveries = 0;
  let nextActionResponseGate: Promise<void> | null = null;
  let nextAuthorityRecoveryGate: Promise<void> | null = null;
  const postActionConnectionHolds: boolean[] = [];
  const recoveryConnectionHolds: boolean[] = [];
  let pendingDraftUpdates = false;
    let pendingAuthorityHandoff = false;
    let draftFlushes = 0;
    let doneSignals = 0;
    let actionFailureMode = false;
    let completedActionResponseHandler: ((
      body: Record<string, unknown>
    ) => Response | Promise<Response>) | null = null;
    const projectedCompletedCleanupImageIds: string[] = [];
    const locallyCommittedJobs: string[] = [];
    const clearedJobIds: string[] = [];
  const fetchStub = async (input: unknown, init: RequestInit = {}) => {
    const path = new URL(
      typeof input === "string" ? input : (input as Request).url,
      "http://localhost"
    ).pathname;
    assert.equal(path, ingestionActionPath);
    const actionBody = JSON.parse(
      String(init.body)
    ) as Record<string, unknown>;
    actionBodies.push(actionBody);
    const responseGate = nextActionResponseGate;
    if (responseGate) {
      nextActionResponseGate = null;
      await responseGate;
    }
    if (actionFailureMode) {
      return new Response(JSON.stringify({
        ok: false,
        error: { code: "temporary_failure", message: "temporary failure" }
      }), {
        status: 503,
        headers: { "content-type": "application/json" }
      });
    }
    if (
      actionBody.action === "clear_completed"
      && completedActionResponseHandler
    ) return completedActionResponseHandler(actionBody);
    return new Response(JSON.stringify({
      ok: true,
      processed: 0,
      changed: 0,
      failed: 0,
      items: []
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
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
    fetch: fetchStub,
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
    setCsrfToken("apply-defaults-token");
    const { createRoot } = await import("react-dom/client");
    const { useIngestionQueueActions } = await import(
      "../../packages/web/src/pages/admin/ingestion/queue/useIngestionQueueActions.ts"
    );
    const { useIngestionQueueWorkflowActions } = await import(
      "../../packages/web/src/pages/admin/ingestion/workflow/useIngestionQueueWorkflowActions.ts"
    );
    const localJob = ingestionJob({
      id: "apply-defaults-local",
      attemptKey: "apply-defaults-attempt",
      status: "queued",
      serverAccepted: false
    });
    const jobsRef = { current: [localJob] };
    const connectionHold = { current: false };
    const recoverFakeAuthority = async () => {
      refreshes += 1;
      recoveryConnectionHolds.push(connectionHold.current);
      const recoveryGate = nextAuthorityRecoveryGate;
      if (recoveryGate) {
        nextAuthorityRecoveryGate = null;
        await recoveryGate;
      }
    };
    const server = {
      status: "ready",
      actionScope: "A".repeat(32),
      actionWatermark: "apply-defaults-watermark",
      connectionGeneration: 1,
      recoverAfterSuccessfulAction: async () => {
        postActionRecoveries += 1;
        postActionConnectionHolds.push(connectionHold.current);
        await recoverFakeAuthority();
      },
      recoverAuthority: recoverFakeAuthority,
      refresh: () => { refreshes += 1; }
    };
    const recoverAuthSession = async () => {
      authRecoveries += 1;
    };
    let workflow: ReturnType<typeof useIngestionQueueWorkflowActions> | undefined;
    function Probe() {
      const actions = useIngestionQueueActions(
        "upload",
        server as never,
        connectionHold,
        () => undefined,
        recoverAuthSession
      );
      workflow = useIngestionQueueWorkflowActions({
        queue: {
          queueType: "upload",
          localJobs: jobsRef.current,
          jobsRef,
          pendingAuthorityHandoff,
          summary: { unfinishedCount: 1, doneJobs: 0 },
          actions,
          server,
          appendJobs: () => true,
          captureBrowserActionJobs: (predicate: (job: IngestionJob) => boolean) => (
            jobsRef.current.filter(predicate)
          ),
          clearJobIds: (ids: ReadonlySet<string>) => {
            clearedJobIds.push(...ids);
            jobsRef.current = jobsRef.current.filter((job) => !ids.has(job.id));
          },
          releaseResolvedServerJobs: () => new Set<string>(),
          projectCompletedCleanupBatch: (result: IngestionQueueActionResultDto) => {
            const successful = result.items.filter((item) => (
              item.status === "changed" || item.status === "unchanged"
            ));
            projectedCompletedCleanupImageIds.push(...successful.map(
              (item) => item.image_id
            ));
            return successful.length;
          },
          recoverAfterSuccessfulAction: server.recoverAfterSuccessfulAction,
          applyDefaultsToLocalJobs: (defaults: Record<string, unknown>) => {
            appliedDefaults = defaults;
          },
          flushPendingUpdates: async () => {
            draftFlushes += 1;
            pendingDraftUpdates = false;
          },
          hasPendingDraftUpdates: () => pendingDraftUpdates
        } as never,
        defaults: {
          device: "auto",
          brightness: "auto",
          theme: "",
          author: "",
          tags: []
        },
        cancelJobs: async () => new Map(),
        commitJobs: async (jobs) => {
          draftFlushes += 1;
          pendingDraftUpdates = false;
          locallyCommittedJobs.push(...jobs.map((job) => job.id));
          return jobs.length > 0;
        },
        onDone: () => { doneSignals += 1; }
      });
      return null;
    }
    const root = createRoot(document.getElementById("root")!);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await React.act(async () => {
      workflow!.applyDefaultsToQueue();
      for (let attempt = 0; attempt < 20 && !actionBodies.length; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    const actionBody = actionBodies[0];
    assert.ok(actionBody);
    assert.equal(actionBody.action, "apply_metadata");
    assert.deepEqual(actionBody.metadata, {
      device: "auto",
      brightness: "auto"
    });
    assert.equal("theme" in (actionBody.metadata as object), false);
    assert.equal("author" in (actionBody.metadata as object), false);
    assert.equal("tags" in (actionBody.metadata as object), false);
    assert.deepEqual(appliedDefaults, {
      device: "auto",
      brightness: "auto",
      theme: "",
      author: "",
      tags: []
    });
    assert.equal(connectionHold.current, false);
    assert.equal(refreshes, 0);

    const draftFlushesBeforeLocalOnlyDefaults = draftFlushes;
    Object.assign(server, {
      summary: {
        total: 0,
        unfinished: 0,
        waiting: 0,
        running: 0,
        ready: 0,
        duplicate_pending: 0,
        committing: 0,
        resolving: 0,
        completed: 0,
        failed: 0
      }
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      workflow!.applyDefaultsToQueue();
      await Promise.resolve();
    });
    assert.equal(
      actionBodies.length,
      1,
      "权威摘要已知为空时，纯本地默认值更新不得发送空 Server 动作"
    );
    assert.equal(
      draftFlushes,
      draftFlushesBeforeLocalOnlyDefaults + 1,
      "纯本地默认值更新仍须排空可能存在的逐项草稿写回"
    );
    assert.equal(refreshes, 0, "纯本地动作不应触发无意义的队列重读");

    const draftFlushesBeforeCommit = draftFlushes;
    pendingDraftUpdates = true;
    pendingAuthorityHandoff = true;
    jobsRef.current = [{ ...localJob, status: "ready" }];
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const actionsBeforePendingApply = actionBodies.length;
    const refreshesBeforePendingApply = refreshes;
    const draftFlushesBeforePendingApply = draftFlushes;
    await React.act(async () => {
      workflow!.applyDefaultsToQueue();
      await Promise.resolve();
    });
    assert.equal(
      actionBodies.length,
      actionsBeforePendingApply,
      "交接期间的本地精确集合不得伪造新的 Server 水位动作"
    );
    assert.equal(refreshes, refreshesBeforePendingApply);
    assert.equal(
      draftFlushes,
      draftFlushesBeforePendingApply + 1,
      "交接期间点击应用到全部必须立即处理点击时捕获的精确任务"
    );
    await React.act(async () => {
      workflow!.commitReadyJobs();
      for (let attempt = 0; attempt < 20 && actionBodies.length < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    assert.equal(actionBodies.length, 1);
    assert.equal(
      draftFlushes,
      draftFlushesBeforeCommit + 2,
      "应用与提交都必须由点击时冻结的逐项 owner 真正受理"
    );
    assert.deepEqual(locallyCommittedJobs, [localJob.id]);
    assert.equal(connectionHold.current, false);
    assert.equal(refreshes, 0);

    server.status = "loading";
    server.actionScope = "";
    server.actionWatermark = "";
    jobsRef.current = [{
      ...localJob,
      id: "local-ready-without-watermark",
      attemptKey: "local-ready-without-watermark-attempt",
      status: "ready"
    }];
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await React.act(async () => {
      workflow!.commitReadyJobs();
      await Promise.resolve();
    });
    assert.equal(actionBodies.length, 1, "无签名水位时不得补冻全队列动作");
    assert.deepEqual(
      locallyCommittedJobs,
      [localJob.id],
      "首个 Server 摘要未知时不得把未恢复队列误判为空并部分提交本地任务"
    );
    assert.equal(doneSignals, 1);

    Object.assign(server, {
      revision: 117,
      summary: {
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
      }
    });
    jobsRef.current = [{
      ...localJob,
      id: "local-completed-at-close",
      attemptKey: "local-completed-at-close-attempt",
      status: "done"
    }];
    await React.act(async () => {
      root.render(React.createElement(Probe));
      workflow!.runCleanupAction("completed");
      workflow!.runCleanupAction("completed");
      await Promise.resolve();
    });
    assert.equal(actionBodies.length, 1);
    assert.equal(
      connectionHold.current,
      true,
      "关闭瞬间重连时必须在后台保留唯一队列连接直至清理收敛"
    );
    Object.assign(server, { status: "error" });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(
      connectionHold.current,
      false,
      "后台重连进入错误态后必须释放连接占用，同时保留冻结的清理意图"
    );
    completedActionResponseHandler = () => new Response(JSON.stringify({
      ok: true,
      processed: 1,
      changed: 1,
      failed: 0,
      items: [{
        session_id: "D".repeat(43),
        image_id: "019f8457-063a-70a1-a580-7a432dc7fd8e",
        status: "changed"
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
    Object.assign(server, {
      status: "ready",
      actionScope: "B".repeat(32),
      actionWatermark: "reconnected-close-cleanup-watermark",
      connectionGeneration: 2
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      for (let attempt = 0; attempt < 20 && actionBodies.length < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    assert.equal(actionBodies[1]?.action, "clear_completed");
    assert.equal(
      actionBodies.filter((body) => body.action === "clear_completed").length,
      1,
      "同一队列与关闭水位的 completed 清理必须合并为单次动作"
    );
    assert.equal(
      actionBodies[1]?.max_semantic_revision,
      117,
      "重连后的关闭清理必须沿用关闭前最后权威 semantic revision"
    );
    assert.equal(connectionHold.current, false);
    assert.equal(doneSignals, 2);
    assert.equal(postActionRecoveries, 1);
    assert.equal(
      postActionConnectionHolds.at(-1),
      true,
      "延迟清理成功后启动动作后收敛时必须仍持有队列连接"
    );
    completedActionResponseHandler = null;

    const failedDeferredActionStart = actionBodies.length;
    const failedDeferredRefreshStart = refreshes;
    actionFailureMode = true;
    Object.assign(server, {
      status: "loading",
      actionScope: "",
      actionWatermark: "",
      revision: 118,
      summary: {
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
      }
    });
    jobsRef.current = [{
      ...localJob,
      id: "local-completed-before-action-failure",
      attemptKey: "local-completed-before-action-failure-attempt",
      status: "done"
    }];
    await React.act(async () => {
      root.render(React.createElement(Probe));
      workflow!.runCleanupAction("completed");
      await Promise.resolve();
    });
    Object.assign(server, {
      status: "ready",
      actionScope: "C".repeat(32),
      actionWatermark: "failed-close-cleanup-watermark",
      connectionGeneration: 3
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      for (
        let attempt = 0;
        attempt < 20 && actionBodies.length < failedDeferredActionStart + 2;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    assert.equal(
      actionBodies.length,
      failedDeferredActionStart + 2,
      "延迟清理的 5xx 只能使用动作客户端自身的两次有界重试"
    );
    assert.equal(connectionHold.current, false);
    const failedDeferredActionSettled = actionBodies.length;
    const failedDeferredRefreshSettled = refreshes;
    assert.equal(
      failedDeferredRefreshSettled,
      failedDeferredRefreshStart + 2,
      "冻结清理只允许一次准入刷新和一次失败后的权威刷新"
    );
    await React.act(async () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        root.render(React.createElement(Probe));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    assert.equal(
      actionBodies.length,
      failedDeferredActionSettled,
      "同一 connection/revision 不得自激重发延迟清理"
    );
    assert.equal(
      refreshes,
      failedDeferredRefreshSettled,
      "同一失败 authority 不得形成 snapshot 尾随循环"
    );
    assert.equal(
      postActionRecoveries,
      1,
      "清理动作没有成功时不得启动成功后的收敛"
    );
    Object.assign(server, {
      actionWatermark: "freshly-signed-same-revision-watermark"
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      actionBodies.length,
      failedDeferredActionSettled,
      "同 revision 的新签名 watermark 不能被误认成新的队列 authority"
    );
    actionFailureMode = false;
    Object.assign(server, {
      actionWatermark: "revision-advanced-close-cleanup-watermark",
      revision: 119
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      for (
        let attempt = 0;
        attempt < 20 && (
          actionBodies.length < failedDeferredActionSettled + 1
          || doneSignals < 3
        );
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    assert.equal(
      actionBodies.length,
      failedDeferredActionSettled + 1,
      "同一 connection 内 semantic revision 推进后必须恰好恢复一次"
    );
    assert.equal(actionBodies.at(-1)?.max_semantic_revision, 118);
    assert.equal(
      doneSignals,
      2,
      "失败前已清理的本地卡片与零变更 Server 重试不应重复发送完成通知"
    );

    const completedAtCloseRequest = ingestionJob({
      ...localJob,
      id: "completed-at-close-request",
      attemptKey: "completed-at-close-request-attempt",
      status: "done"
    });
    const completedDuringExit = ingestionJob({
      ...localJob,
      id: "completed-during-close-exit",
      attemptKey: "completed-during-close-exit-attempt",
      status: "done"
    });
    jobsRef.current = [completedAtCloseRequest];
    Object.assign(server, {
      status: "ready",
      actionWatermark: "close-request-watermark",
      revision: 120,
      summary: {
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
      }
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const closeActionStart = actionBodies.length;
    const closeClearStart = clearedJobIds.length;
    const closeRecoveryStart = postActionRecoveries;
    completedActionResponseHandler = () => new Response(JSON.stringify({
      ok: true,
      processed: 1,
      changed: 1,
      failed: 0,
      items: [{
        session_id: "E".repeat(43),
        image_id: "019f8457-063a-70a2-a580-7a432dc7fd8e",
        status: "changed"
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
    let releaseActionResponse!: () => void;
    let releaseAuthorityRecovery!: () => void;
    nextActionResponseGate = new Promise<void>((resolve) => {
      releaseActionResponse = resolve;
    });
    nextAuthorityRecoveryGate = new Promise<void>((resolve) => {
      releaseAuthorityRecovery = resolve;
    });
    await React.act(async () => {
      workflow!.runCleanupAction("completed");
      jobsRef.current = [...jobsRef.current, completedDuringExit];
      Object.assign(server, {
        actionWatermark: "after-close-request-watermark",
        revision: 121,
        summary: {
          total: 2,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 2,
          failed: 0
        }
      });
      root.render(React.createElement(Probe));
      for (
        let attempt = 0;
        attempt < 20 && actionBodies.length < closeActionStart + 1;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    assert.equal(
      postActionRecoveries,
      closeRecoveryStart,
      "动作响应尚未成功时允许快速重开看到尚未清理的旧卡片"
    );
    assert.equal(
      connectionHold.current,
      true,
      "异步清理在慢响应期间必须保留唯一连接且不得阻塞关闭"
    );
    await React.act(async () => {
      releaseActionResponse();
      for (
        let attempt = 0;
        attempt < 20 && postActionRecoveries === closeRecoveryStart;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    assert.equal(postActionRecoveries, closeRecoveryStart + 1);
    assert.equal(
      connectionHold.current,
      true,
      "动作成功后必须持有连接直至权威快照收敛"
    );
    assert.equal(postActionConnectionHolds.at(-1), true);
    assert.equal(recoveryConnectionHolds.at(-1), true);
    await React.act(async () => {
      releaseAuthorityRecovery();
      for (let attempt = 0; attempt < 20 && connectionHold.current; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    assert.equal(connectionHold.current, false);
    assert.equal(
      actionBodies[closeActionStart]?.action_watermark,
      "close-request-watermark",
      "关闭请求必须立即复用清理动作并冻结当时的 Server 水位"
    );
    assert.deepEqual(
      clearedJobIds.slice(closeClearStart),
      [completedAtCloseRequest.id],
      "退场期间才完成的浏览器任务不得进入关闭请求的精确清理集合"
    );
    assert.deepEqual(
      jobsRef.current.map((job) => job.id),
      [completedDuringExit.id]
    );
    completedActionResponseHandler = null;

    const pagedSuccessFirstImageId =
      "019f8457-063a-70b1-a580-7a432dc7fd8e";
    const pagedSuccessSecondImageId =
      "019f8457-063a-70b2-a580-7a432dc7fd8e";
    let releasePagedSuccessSecond!: () => void;
    const pagedSuccessSecondGate = new Promise<void>((resolve) => {
      releasePagedSuccessSecond = resolve;
    });
    let pagedSuccessSecondStarted = false;
    completedActionResponseHandler = async (body) => {
      if (!body.continuation) {
        return new Response(JSON.stringify({
          ok: true,
          processed: 100,
          changed: 1,
          failed: 0,
          items: [{
            session_id: "F".repeat(43),
            image_id: pagedSuccessFirstImageId,
            status: "changed"
          }],
          continuation: "completed-page-two-success"
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      pagedSuccessSecondStarted = true;
      await pagedSuccessSecondGate;
      return new Response(JSON.stringify({
        ok: true,
        processed: 1,
        changed: 1,
        failed: 0,
        items: [{
          session_id: "G".repeat(43),
          image_id: pagedSuccessSecondImageId,
          status: "changed"
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    jobsRef.current = [];
    Object.assign(server, {
      status: "ready",
      actionScope: "F".repeat(32),
      actionWatermark: "paged-success-watermark",
      connectionGeneration: 4,
      revision: 122,
      summary: {
        total: 101,
        unfinished: 0,
        waiting: 0,
        running: 0,
        ready: 0,
        duplicate_pending: 0,
        committing: 0,
        resolving: 0,
        completed: 101,
        failed: 0
      }
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const pagedSuccessProjectionStart =
      projectedCompletedCleanupImageIds.length;
    const pagedSuccessRecoveryStart = postActionRecoveries;
    const pagedSuccessDoneStart = doneSignals;
    await React.act(async () => {
      workflow!.runCleanupAction("completed");
      for (let attempt = 0; attempt < 20 && !pagedSuccessSecondStarted; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    assert.equal(pagedSuccessSecondStarted, true);
    assert.deepEqual(
      projectedCompletedCleanupImageIds.slice(pagedSuccessProjectionStart),
      [pagedSuccessFirstImageId],
      "第二批慢响应期间，首批成功 pair 必须已经同步进入展示释放投影"
    );
    assert.equal(
      postActionRecoveries,
      pagedSuccessRecoveryStart,
      "continuation 尚未结束时不得抢先把首批快照当作完整动作证明"
    );
    await React.act(async () => {
      releasePagedSuccessSecond();
      for (
        let attempt = 0;
        attempt < 30 && (
          connectionHold.current
          || postActionRecoveries === pagedSuccessRecoveryStart
        );
        attempt += 1
      ) await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(
      projectedCompletedCleanupImageIds.slice(pagedSuccessProjectionStart),
      [pagedSuccessFirstImageId, pagedSuccessSecondImageId]
    );
    assert.equal(postActionRecoveries, pagedSuccessRecoveryStart + 1);
    assert.equal(doneSignals, pagedSuccessDoneStart + 1);
    assert.equal(connectionHold.current, false);

    const pagedFailureFirstImageId =
      "019f8457-063a-70b3-a580-7a432dc7fd8e";
    let releasePagedFailureSecond!: () => void;
    const pagedFailureSecondGate = new Promise<void>((resolve) => {
      releasePagedFailureSecond = resolve;
    });
    let pagedFailureContinuationCalls = 0;
    completedActionResponseHandler = async (body) => {
      if (!body.continuation) {
        return new Response(JSON.stringify({
          ok: true,
          processed: 100,
          changed: 1,
          failed: 0,
          items: [{
            session_id: "H".repeat(43),
            image_id: pagedFailureFirstImageId,
            status: "changed"
          }],
          continuation: "completed-page-two-failure"
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      pagedFailureContinuationCalls += 1;
      await pagedFailureSecondGate;
      return new Response(JSON.stringify({
        ok: false,
        error: {
          code: "temporary_failure",
          message: "controlled second page failure"
        }
      }), {
        status: 503,
        headers: { "content-type": "application/json" }
      });
    };
    Object.assign(server, {
      actionScope: "G".repeat(32),
      actionWatermark: "paged-failure-watermark",
      connectionGeneration: 5,
      revision: 123
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const pagedFailureActionStart = actionBodies.length;
    const pagedFailureProjectionStart =
      projectedCompletedCleanupImageIds.length;
    const pagedFailureRecoveryStart = postActionRecoveries;
    const pagedFailureRefreshStart = refreshes;
    const pagedFailureDoneStart = doneSignals;
    await React.act(async () => {
      workflow!.runCleanupAction("completed");
      for (
        let attempt = 0;
        attempt < 20 && pagedFailureContinuationCalls === 0;
        attempt += 1
      ) await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(pagedFailureContinuationCalls, 1);
    assert.deepEqual(
      projectedCompletedCleanupImageIds.slice(pagedFailureProjectionStart),
      [pagedFailureFirstImageId],
      "后续批失败前，首批成功证据也不得停留在动作聚合器里"
    );
    await React.act(async () => {
      releasePagedFailureSecond();
      for (
        let attempt = 0;
        attempt < 30 && (
          connectionHold.current
          || pagedFailureContinuationCalls < 2
        );
        attempt += 1
      ) await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      actionBodies.length,
      pagedFailureActionStart + 3,
      "第二批失败只允许沿用 continuation 做两次有界请求"
    );
    assert.deepEqual(
      projectedCompletedCleanupImageIds.slice(pagedFailureProjectionStart),
      [pagedFailureFirstImageId],
      "后续批最终失败不得撤销首批已成功 pair 的展示投影"
    );
    assert.equal(postActionRecoveries, pagedFailureRecoveryStart + 1);
    assert.equal(
      refreshes,
      pagedFailureRefreshStart + 1,
      "部分成功后的 owner 恢复必须取代普通失败恢复，不能发两条快照链"
    );
    assert.equal(doneSignals, pagedFailureDoneStart + 1);
    assert.equal(connectionHold.current, false);

    const pagedAuthFirstImageId =
      "019f8457-063a-70b4-a580-7a432dc7fd8e";
    let pagedAuthContinuationCalls = 0;
    completedActionResponseHandler = (body) => {
      if (!body.continuation) {
        return new Response(JSON.stringify({
          ok: true,
          processed: 100,
          changed: 1,
          failed: 0,
          items: [{
            session_id: "J".repeat(43),
            image_id: pagedAuthFirstImageId,
            status: "changed"
          }],
          continuation: "completed-page-two-invalid-token"
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      pagedAuthContinuationCalls += 1;
      return new Response(JSON.stringify({
        ok: false,
        code: "invalid_ingestion_token",
        error: "内容接入凭证已过期或时间无效"
      }), {
        status: 401,
        headers: { "content-type": "application/json" }
      });
    };
    Object.assign(server, {
      actionScope: "H".repeat(32),
      actionWatermark: "paged-invalid-token-watermark",
      connectionGeneration: 6,
      revision: 124
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const pagedAuthActionStart = actionBodies.length;
    const pagedAuthProjectionStart =
      projectedCompletedCleanupImageIds.length;
    const pagedAuthRecoveryStart = postActionRecoveries;
    const pagedAuthRefreshStart = refreshes;
    const pagedAuthSessionStart = authRecoveries;
    const pagedAuthDoneStart = doneSignals;
    await React.act(async () => {
      workflow!.runCleanupAction("completed");
      for (
        let attempt = 0;
        attempt < 30 && (
          connectionHold.current
          || authRecoveries === pagedAuthSessionStart
        );
        attempt += 1
      ) await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      actionBodies.length,
      pagedAuthActionStart + 2,
      "失效 continuation 不得重放已执行的动作批次"
    );
    assert.equal(pagedAuthContinuationCalls, 1);
    assert.equal(authRecoveries, pagedAuthSessionStart + 1);
    assert.deepEqual(
      projectedCompletedCleanupImageIds.slice(pagedAuthProjectionStart),
      [pagedAuthFirstImageId],
      "续页凭证失效不得撤销首批已成功 pair 的展示投影"
    );
    assert.equal(postActionRecoveries, pagedAuthRecoveryStart + 1);
    assert.equal(
      refreshes,
      pagedAuthRefreshStart + 1,
      "登录恢复后必须由部分成功动作接管唯一 post-action snapshot"
    );
    assert.equal(doneSignals, pagedAuthDoneStart + 1);
    assert.equal(connectionHold.current, false);
    completedActionResponseHandler = null;

    jobsRef.current = [];
    Object.assign(server, {
      status: "loading",
      actionScope: "",
      actionWatermark: "",
      summary: {
        total: 1,
        unfinished: 1,
        waiting: 0,
        running: 0,
        ready: 1,
        duplicate_pending: 1,
        committing: 0,
        resolving: 0,
        completed: 0,
        failed: 0
      }
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const actionsBeforeUnavailableActions = actionBodies.length;
    const refreshesBeforeUnavailableActions = refreshes;
    let cleanupArmed = true;
    let clearQueueArmed = true;
    await React.act(async () => {
      workflow!.commitReadyJobs();
      workflow!.runCleanupAction("duplicates");
      cleanupArmed = workflow!.armCleanupAction("uncommitted");
      clearQueueArmed = workflow!.armClearQueue();
      await Promise.resolve();
    });
    assert.equal(actionBodies.length, actionsBeforeUnavailableActions);
    assert.equal(cleanupArmed, false);
    assert.equal(clearQueueArmed, false);
    assert.equal(
      refreshes,
      refreshesBeforeUnavailableActions + 4,
      "只有旧展示而没有签名水位时必须重取权威，不能静默执行部分 Server 动作"
    );
    await React.act(async () => root.unmount());
  } finally {
    clearCsrfToken();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

test("ready 草稿串行写回并以语义 no-op 收敛响应丢失", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const requests: Array<Record<string, unknown>> = [];
  let fetchCalls = 0;
  const observedDraftCompleted: string[] = [];
  let releaseThird: (() => void) | undefined;
  let markThirdStarted: (() => void) | undefined;
  let releaseLateGeneration: (() => void) | undefined;
  let markLateGenerationStarted: (() => void) | undefined;
  const thirdStarted = new Promise<void>((resolve) => {
    markThirdStarted = resolve;
  });
  const thirdGate = new Promise<void>((resolve) => {
    releaseThird = resolve;
  });
  const lateGenerationStarted = new Promise<void>((resolve) => {
    markLateGenerationStarted = resolve;
  });
  const lateGenerationGate = new Promise<void>((resolve) => {
    releaseLateGeneration = resolve;
  });
  const fetchStub = async (_path: string, init?: RequestInit) => {
    fetchCalls += 1;
    const path = String(_path);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push(body);
    if (fetchCalls === 1) {
      return new Response("upstream response lost", { status: 503 });
    }
    if (fetchCalls === 3) {
      markThirdStarted?.();
      await thirdGate;
    }
    if (fetchCalls === 8) {
      markLateGenerationStarted?.();
      await lateGenerationGate;
    }
    if (fetchCalls === 9 || fetchCalls === 10) {
      return new Response("draft service unavailable", { status: 503 });
    }
    if (fetchCalls === 11) {
      assert.equal(path, ingestionStatusPath);
      const pair = (body.items as Array<Record<string, unknown>>)[0]!;
      return new Response(JSON.stringify({
        ok: true,
        items: [{
          session_id: pair.session_id,
          image_id: pair.image_id,
          status: "present",
          item: {
            session_id: pair.session_id,
            image_id: pair.image_id,
            queue: "upload",
            source_type: "upload",
            resolved_image_time: "2026-08-23T01:02:03.456Z",
            status: "ready",
            phase: "ready",
            message: "ready",
            version: 2,
            progress_seq: 0,
            last_semantic_revision: 2,
            accepted_at: 1,
            accepted_order: 1,
            metadata: ingestionJob().draft,
            storage_slug: "local"
          }
        }]
      }), { status: 200 });
    }
    if (fetchCalls === 13) {
      assert.equal(path, ingestionStatusPath);
      const pair = (body.items as Array<Record<string, unknown>>)[0]!;
      return new Response(JSON.stringify({
        ok: true,
        items: [{
          session_id: pair.session_id,
          image_id: pair.image_id,
          status: "completed",
          completed_item: adminImageListItem({ id: String(pair.image_id) }),
          redis_status: "missing"
        }]
      }), { status: 200 });
    }
    const item = (body.items as Array<Record<string, unknown>>)[0]!;
    const version = fetchCalls === 2 ? 2 : fetchCalls === 3 ? 3 : 4;
    return new Response(JSON.stringify({
      ok: true,
      items: [{
        session_id: item.session_id,
        image_id: item.image_id,
        status: fetchCalls === 2 ? "unchanged" : "changed",
        version,
        last_semantic_revision: version,
        duplicate_count: 0,
        duplicate_decision: "upload"
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
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
    fetch: fetchStub,
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
    const { reduceIngestionQueue } = await import(
      "../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-queue-state.ts"
    );
    const { useStoredIngestionDraftSync } = await import(
      "../../packages/web/src/pages/admin/ingestion/queue/useStoredIngestionDraftSync.ts"
    );
    const sessionId = "D".repeat(43);
    const imageId = "019f8457-063a-7004-a580-7a432dc7fd8e";
    let state = {
      page: 1,
      jobs: [ingestionJob({
        status: "ready",
        serverAccepted: true,
        serverAcceptedOrder: 1,
        serverVersion: 1,
        sessionId,
        imageId
      })]
    };
    const jobsRef = { current: state.jobs };
    const dispatch = (action: Parameters<typeof reduceIngestionQueue>[1]) => {
      const next = reduceIngestionQueue(state, action);
      if (next === state) return false;
      state = next;
      jobsRef.current = next.jobs;
      return true;
    };
    const errors: string[] = [];
    const ensuredRevisions: Array<{
      revision?: number;
      connectionGeneration?: number;
    }> = [];
    let authorityRecoveries = 0;
    const server = {
      status: "ready",
      revision: 100,
      connectionGeneration: 1,
      items: [] as Array<Record<string, unknown>>,
      ensureRevision(revision?: number, connectionGeneration?: number) {
        if (connectionGeneration !== server.connectionGeneration) return false;
        ensuredRevisions.push({ revision, connectionGeneration });
        return true;
      },
      async recoverAuthority() { authorityRecoveries += 1; },
      refresh() {}
    };
    let sync: ReturnType<typeof useStoredIngestionDraftSync> | undefined;
    function Probe() {
      sync = useStoredIngestionDraftSync({
        jobsRef,
        dispatch,
        server: server as never,
        reportError: (message) => errors.push(message),
        observeCompletedIngestions: (entries) => {
          observedDraftCompleted.push(...entries.map(({ pair }) => pair.image_id));
        }
      });
      return null;
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.ok(sync);
    await React.act(async () => {
      sync!.updateJobDraft("job-1", { title: "响应丢失仍保留" });
      await sync!.flushPendingUpdates();
    });
    assert.equal(fetchCalls, 2);
    assert.deepEqual(requests[0], requests[1], "响应丢失必须重放同一草稿写入");
    assert.equal(jobsRef.current[0]?.serverVersion, 2);
    assert.equal(jobsRef.current[0]?.draft.title, "响应丢失仍保留");
    assert.equal(jobsRef.current[0]?.serverDraftPending, false);

    let flush: Promise<void> | undefined;
    await React.act(async () => {
      sync!.updateJobDraft("job-1", { title: "第一版" });
      flush = sync!.flushPendingUpdates();
      await thirdStarted;
    });
    await React.act(async () => {
      sync!.updateJobDraft("job-1", { title: "等待期间的新版本" });
    });
    await React.act(async () => {
      releaseThird?.();
      await flush;
    });
    const thirdItem = (requests[2]?.items as Array<Record<string, unknown>>)[0]!;
    const fourthItem = (requests[3]?.items as Array<Record<string, unknown>>)[0]!;
    assert.equal(thirdItem.expected_version, 2);
    assert.equal((thirdItem.metadata as Record<string, unknown>).title, "第一版");
    assert.equal(fourthItem.expected_version, 3);
    assert.equal(
      (fourthItem.metadata as Record<string, unknown>).title,
      "等待期间的新版本"
    );
    assert.equal(jobsRef.current[0]?.serverVersion, 4);
    assert.equal(jobsRef.current[0]?.serverDraftPending, false);
    assert.deepEqual(errors, []);

    server.revision = 3;
    state = { page: 1, jobs: [ingestionJob()] };
    jobsRef.current = state.jobs;
    await React.act(async () => {
      sync!.updateJobDraft("job-1", { title: "接管前冻结的草稿" });
    });
    assert.equal(fetchCalls, 4, "本地 placeholder 不应提前发草稿请求");
    assert.equal(jobsRef.current[0]?.serverDraftPending, true);
    await React.act(async () => {
      dispatch({
        type: "bind-server",
        id: "job-1",
        binding: {
          sessionId,
          imageId,
          serverAccepted: true,
          serverVersion: 1,
          status: "queued"
        }
      });
      const detached = jobsRef.current[0]!;
      state = { page: 2, jobs: [] };
      jobsRef.current = state.jobs;
      sync!.ensureJobSnapshot(detached);
      root.render(React.createElement(Probe));
      await sync!.flushPendingUpdates();
    });
    assert.equal(fetchCalls, 5);
    const fencedItem = (
      requests[4]?.items as Array<Record<string, unknown>>
    )[0]!;
    assert.equal(
      (fencedItem.metadata as Record<string, unknown>).title,
      "接管前冻结的草稿"
    );
    assert.equal(
      sync!.hasPendingUpdates(),
      true,
      "页外 accepted canonical 必须由 owner 继续持有草稿 revision 围栏"
    );
    server.revision = 4;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(sync!.hasPendingUpdates(), false);

    state = {
      page: 1,
      jobs: [ingestionJob({
        status: "ready",
        serverAccepted: true,
        serverAcceptedOrder: 1,
        serverVersion: 1,
        sessionId,
        imageId
      })]
    };
    jobsRef.current = state.jobs;
    await React.act(async () => {
      sync!.updateJobDraft("job-1", { title: "翻页后仍须写回" });
    });
    state = { page: 2, jobs: [] };
    jobsRef.current = state.jobs;
    await React.act(async () => {
      await sync!.flushPendingUpdates();
    });
    assert.equal(fetchCalls, 6, "pending sync 必须独立持有离页任务快照");
    const offPageItem = (
      requests[5]?.items as Array<Record<string, unknown>>
    )[0]!;
    assert.equal(offPageItem.session_id, sessionId);
    assert.equal(offPageItem.image_id, imageId);
    assert.equal(
      (offPageItem.metadata as Record<string, unknown>).title,
      "翻页后仍须写回"
    );

    state = {
      page: 1,
      jobs: [ingestionJob({
        status: "ready",
        serverAccepted: true,
        serverAcceptedOrder: 1,
        serverVersion: 1,
        sessionId,
        imageId
      })]
    };
    jobsRef.current = state.jobs;
    server.revision = 3;
    await React.act(async () => {
      sync!.updateJobDraft("job-1", { title: "等待旧连接 revision" });
      await sync!.flushPendingUpdates();
    });
    assert.equal(sync!.hasPendingUpdates(), true);
    assert.equal(jobsRef.current[0]?.serverDraftPending, true);
    server.connectionGeneration = 2;
    server.revision = 0;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(
      sync!.hasPendingUpdates(),
      false,
      "新连接的权威空基线不得永远等待旧 Redis revision"
    );
    assert.equal(jobsRef.current[0]?.serverDraftPending, false);

    state = {
      page: 1,
      jobs: [ingestionJob({
        status: "ready",
        serverAccepted: true,
        serverAcceptedOrder: 1,
        serverVersion: 1,
        sessionId,
        imageId
      })]
    };
    jobsRef.current = state.jobs;
    server.connectionGeneration = 2;
    server.revision = 0;
    const ensuredBeforeLateGeneration = ensuredRevisions.length;
    const recoveriesBeforeLateGeneration = authorityRecoveries;
    let lateGenerationFlush: Promise<void> | undefined;
    await React.act(async () => {
      sync!.updateJobDraft("job-1", { title: "请求期间连接换代" });
      lateGenerationFlush = sync!.flushPendingUpdates();
      await lateGenerationStarted;
    });
    server.connectionGeneration = 3;
    server.revision = 0;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      releaseLateGeneration?.();
      await lateGenerationFlush;
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(fetchCalls, 8);
    assert.equal(
      ensuredRevisions.length,
      ensuredBeforeLateGeneration,
      "旧连接的迟到写响应不得把 generation-local revision 交给新连接"
    );
    assert.equal(
      authorityRecoveries,
      recoveriesBeforeLateGeneration + 1,
      "跨连接写响应必须改由触发后的权威 snapshot 收敛"
    );
    assert.equal(
      sync!.hasPendingUpdates(),
      false,
      "旧连接请求的迟到响应不得绑定到新连接空 revision"
    );
    assert.equal(jobsRef.current[0]?.serverDraftPending, false);

    const detachedFailure = ingestionJob({
      id: "detached-draft-failure",
      attemptKey: "detached-draft-failure",
      status: "ready",
      serverAccepted: true,
      serverAcceptedOrder: 1,
      serverVersion: 1,
      serverDraftPending: true,
      sessionId,
      imageId,
      draft: {
        ...ingestionJob().draft,
        title: "连续失败后仍须保留的离页草稿"
      }
    });
    state = { page: 2, jobs: [] };
    jobsRef.current = state.jobs;
    let detachedFailureError: unknown;
    await React.act(async () => {
      sync!.ensureJobSnapshot(detachedFailure);
      try {
        await sync!.flushPendingUpdates();
      } catch (error) {
        detachedFailureError = error;
      }
    });
    assert.ok(detachedFailureError instanceof Error);
    assert.equal(fetchCalls, 10);
    assert.equal(sync!.hasPendingUpdates(), true);
    assert.equal(errors.length, 1);
    await React.act(async () => {
      assert.equal(await sync!.retryPendingUpdates(), true);
    });
    assert.equal(fetchCalls, 12);
    const retriedDetachedItem = (
      requests[11]?.items as Array<Record<string, unknown>>
    )[0]!;
    assert.equal(retriedDetachedItem.expected_version, 2);
    assert.equal(
      (retriedDetachedItem.metadata as Record<string, unknown>).title,
      "连续失败后仍须保留的离页草稿"
    );
    assert.equal(sync!.hasPendingUpdates(), true);
    server.revision = 4;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(sync!.hasPendingUpdates(), false);

    state = {
      page: 1,
      jobs: [ingestionJob({
        status: "ready",
        serverAccepted: true,
        serverAcceptedOrder: 1,
        serverVersion: 1,
        sessionId,
        imageId
      })]
    };
    jobsRef.current = state.jobs;
    server.revision = 5;
    server.items = [{
      session_id: sessionId,
      image_id: imageId,
      queue: "upload",
      source_type: "upload",
      resolved_image_time: "2026-08-23T01:02:03.456Z",
      status: "committing",
      phase: "committing",
      message: "另一设备已冻结提交",
      progress: 100,
      version: 2,
      progress_seq: 0,
      last_semantic_revision: 5,
      accepted_at: 1,
      accepted_order: 1,
      metadata: {
        ...ingestionJob().draft,
        title: "另一设备已冻结的权威草稿"
      },
      storage_slug: "local"
    }];
    let frozenDraftError: unknown;
    const previousErrorCount = errors.length;
    await React.act(async () => {
      sync!.updateJobDraft("job-1", { title: "尚未写入的本地草稿" });
      state = {
        ...state,
        jobs: [{
          ...jobsRef.current[0]!,
          status: "committing",
          serverStatus: "committing"
        }]
      };
      jobsRef.current = state.jobs;
      assert.equal(sync!.hasPendingUpdates(), true);
      assert.equal(jobsRef.current[0]?.status, "committing");
      root.render(React.createElement(Probe));
      try {
        await sync!.flushPendingUpdates();
      } catch (error) {
        frozenDraftError = error;
      }
    });
    assert.ok(frozenDraftError instanceof Error);
    assert.equal(fetchCalls, 12, "已有 Server DTO 时不得额外逐卡读取草稿");
    assert.equal(errors.length, previousErrorCount + 1);
    assert.match(errors.at(-1) ?? "", /本地草稿未写入/u);
    assert.equal(jobsRef.current[0]?.serverDraftPending, false);
    assert.equal(
      jobsRef.current[0]?.draft.title,
      "另一设备已冻结的权威草稿"
    );
    server.items = [];

    state = {
      page: 1,
      jobs: [ingestionJob({
        status: "ready",
        serverAccepted: true,
        serverAcceptedOrder: 1,
        serverVersion: 1,
        sessionId,
        imageId
      })]
    };
    jobsRef.current = state.jobs;
    let completedDraftError: unknown;
    await React.act(async () => {
      sync!.updateJobDraft("job-1", { title: "完成前尚未写入的草稿" });
      state = {
        ...state,
        jobs: [{
          ...jobsRef.current[0]!,
          status: "committing",
          serverStatus: "committing"
        }]
      };
      jobsRef.current = state.jobs;
      try {
        await sync!.flushPendingUpdates();
      } catch (error) {
        completedDraftError = error;
      }
    });
    assert.ok(completedDraftError instanceof Error);
    assert.deepEqual(
      observedDraftCompleted,
      [imageId],
      "草稿冻结后的 completed status 必须先进入 owner 失效入口"
    );
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

test("任务卡片连续文本只在失焦发布一次并围栏旧 incarnation", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true
  });
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const requestAnimationFrame = (callback: FrameRequestCallback) => (
    setTimeout(() => callback(Date.now()), 0) as unknown as number
  );
  const cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  Object.assign(window, {
    matchMedia,
    requestAnimationFrame,
    cancelAnimationFrame,
    innerWidth: 1280,
    innerHeight: 720
  });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: 240,
    height: 32,
    top: 0,
    right: 240,
    bottom: 32,
    left: 0,
    toJSON() { return {}; }
  });
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    ResizeObserver: ResizeObserverStub,
    requestAnimationFrame,
    cancelAnimationFrame,
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
    const { IngestionJobCard } = await import(
      "../../packages/web/src/pages/admin/ingestion/queue/cards/IngestionJobCard.tsx"
    );
    const initialJob = ingestionJob({
      id: "deferred-card",
      attemptKey: "deferred-attempt",
      status: "ready",
      serverAccepted: true,
      serverVersion: 1,
      sessionId: "T".repeat(43),
      imageId: "019f8457-063a-7004-a580-7a432dc7fd8e"
    });
    const publications: Array<{
      baseline: IngestionJob;
      patch: Partial<IngestionJob["draft"]>;
    }> = [];
    let setHarnessJob: React.Dispatch<React.SetStateAction<IngestionJob>> | undefined;
    let setHarnessBusy: React.Dispatch<React.SetStateAction<boolean>> | undefined;
    function Harness() {
      const [job, setJob] = React.useState(initialJob);
      const [busy, setBusy] = React.useState(false);
      setHarnessJob = setJob;
      setHarnessBusy = setBusy;
      return React.createElement(IngestionJobCard, {
        job,
        busy,
        storageDisplayName: "本地",
        themes: [
          { slug: "existing-theme", display_name: "已有主题" },
          { slug: "new-theme", display_name: "新主题" },
          { slug: "candidate-theme", display_name: "候选主题" }
        ],
        allTags: [],
        authors: [
          { slug: "existing-author", display_name: "已有作者" },
          { slug: "ime-author", display_name: "输入法作者" }
        ],
        onPatch: (current, patch) => {
          publications.push({ baseline: current, patch });
          setJob({ ...current, draft: { ...current.draft, ...patch } });
        },
        onCancel() {},
        onRetry() {},
        onRemove() {},
        onConfirmDuplicate() {},
        onOpenDetail() {},
        onFocusWithin() {},
        onPreview() {}
      });
    }
    const container = document.getElementById("root")!;
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    const reactProps = <T,>(element: Element) => {
      const key = Object.keys(element).find((entry) => (
        entry.startsWith("__reactProps$")
      ));
      assert.ok(key);
      return (element as unknown as Record<string, T>)[key]!;
    };
    type PlainInputProps = {
      onFocus: () => void;
      onChange: (event: { target: { value: string } }) => void;
      onBlur: () => void;
    };
    type ComboInputProps = {
      onFocus: () => void;
      onChange: (event: {
        currentTarget: HTMLInputElement;
        nativeEvent: { isComposing: boolean };
      }) => void;
      onBlur: (event: { currentTarget: HTMLInputElement }) => void;
      onCompositionStart: () => void;
      onCompositionEnd: (event: { currentTarget: HTMLInputElement }) => void;
      onKeyDown: (event: {
        key: string;
        keyCode: number;
        nativeEvent: { isComposing: boolean };
        preventDefault: () => void;
      }) => void;
    };

    const title = container.querySelector<HTMLInputElement>(
      "input[placeholder='标题']"
    )!;
    await React.act(async () => reactProps<PlainInputProps>(title).onFocus());
    for (const value of ["慢", "慢速", "慢速输入"]) {
      await React.act(async () => {
        reactProps<PlainInputProps>(title).onChange({ target: { value } });
        await new Promise((resolve) => setTimeout(resolve, 275));
      });
    }
    assert.equal(publications.length, 0, "焦点内跨越多个防抖间隔仍不得发布草稿");
    assert.match(
      container.querySelector(".ingestion-job-head strong")?.textContent ?? "",
      /慢速输入/u,
      "卡片标题必须即时显示焦点会话临时值"
    );
    await React.act(async () => {
      setHarnessJob?.((current) => ({
        ...current,
        serverVersion: (current.serverVersion ?? 0) + 1,
        draft: { ...current.draft, title: "同 incarnation 远端标题" }
      }));
      await Promise.resolve();
    });
    assert.match(
      container.querySelector(".ingestion-job-head strong")?.textContent ?? "",
      /慢速输入/u,
      "同 incarnation snapshot 不得覆盖焦点内临时值"
    );
    await React.act(async () => reactProps<PlainInputProps>(title).onBlur());
    assert.equal(publications.length, 1);
    assert.equal(publications[0]?.baseline.draft.title, "同 incarnation 远端标题");
    assert.deepEqual(publications[0]?.patch, { title: "慢速输入" });

    const noChangeCount = publications.length;
    await React.act(async () => {
      reactProps<PlainInputProps>(title).onFocus();
      reactProps<PlainInputProps>(title).onBlur();
      await Promise.resolve();
    });
    assert.equal(publications.length, noChangeCount, "无变化失焦不得发布草稿");

    const theme = container.querySelector<HTMLInputElement>(
      "input[aria-label$='主题']"
    )!;
    await React.act(async () => reactProps<ComboInputProps>(theme).onFocus());
    for (const value of ["new", "new-theme"]) {
      await React.act(async () => {
        theme.value = value;
        reactProps<ComboInputProps>(theme).onChange({
          currentTarget: theme,
          nativeEvent: { isComposing: false }
        });
        await new Promise((resolve) => setTimeout(resolve, 275));
      });
    }
    assert.equal(publications.length, noChangeCount);
    await React.act(async () => {
      reactProps<ComboInputProps>(theme).onBlur({ currentTarget: theme });
      await Promise.resolve();
    });
    assert.deepEqual(publications.at(-1)?.patch, { theme: "new-theme" });

    const author = container.querySelector<HTMLInputElement>(
      "input[aria-label$='作者']"
    )!;
    const beforeIme = publications.length;
    await React.act(async () => {
      const props = reactProps<ComboInputProps>(author);
      props.onFocus();
      props.onCompositionStart();
      author.value = "ime-author";
      props.onChange({
        currentTarget: author,
        nativeEvent: { isComposing: true }
      });
      props.onCompositionEnd({ currentTarget: author });
      await Promise.resolve();
    });
    assert.equal(publications.length, beforeIme, "IME 组合期间不得发布草稿");
    await React.act(async () => {
      reactProps<ComboInputProps>(author).onBlur({ currentTarget: author });
      await Promise.resolve();
    });
    assert.deepEqual(publications.at(-1)?.patch, { author: "ime-author" });

    const beforeCandidate = publications.length;
    await React.act(async () => reactProps<ComboInputProps>(theme).onFocus());
    await React.act(async () => {
      theme.value = "candidate";
      reactProps<ComboInputProps>(theme).onChange({
        currentTarget: theme,
        nativeEvent: { isComposing: false }
      });
      await Promise.resolve();
    });
    await React.act(async () => {
      reactProps<ComboInputProps>(theme).onKeyDown({
        key: "ArrowDown",
        keyCode: 40,
        nativeEvent: { isComposing: false },
        preventDefault() {}
      });
      await Promise.resolve();
    });
    await React.act(async () => {
      reactProps<ComboInputProps>(theme).onKeyDown({
        key: "Enter",
        keyCode: 13,
        nativeEvent: { isComposing: false },
        preventDefault() {}
      });
      await Promise.resolve();
    });
    assert.equal(
      publications.length,
      beforeCandidate + 1,
      "候选选择必须维持即时离散发布语义"
    );
    assert.deepEqual(publications.at(-1)?.patch, { theme: "candidate-theme" });
    await React.act(async () => {
      reactProps<ComboInputProps>(theme).onBlur({ currentTarget: theme });
      await Promise.resolve();
    });
    assert.equal(publications.length, beforeCandidate + 1);

    const description = container.querySelector<HTMLTextAreaElement>(
      "textarea[placeholder='详情描述']"
    )!;
    const descriptionProps = reactProps<PlainInputProps>(description);
    await React.act(async () => {
      descriptionProps.onFocus();
      descriptionProps.onChange({ target: { value: "冻结前临时描述" } });
      setHarnessBusy?.(true);
      await Promise.resolve();
    });
    const beforeFrozenBlur = publications.length;
    await React.act(async () => descriptionProps.onBlur());
    assert.equal(publications.length, beforeFrozenBlur, "失去可编辑资格后不得发布临时值");
    await React.act(async () => setHarnessBusy?.(false));

    const original = container.querySelector<HTMLInputElement>(
      "input[placeholder='原图 URL']"
    )!;
    const originalProps = reactProps<PlainInputProps>(original);
    await React.act(async () => {
      originalProps.onFocus();
      originalProps.onChange({ target: { value: "https://local.example/new.jpg" } });
      setHarnessJob?.((current) => ({
        ...current,
        attemptKey: "replacement-attempt",
        imageId: "019f8457-063a-7004-a580-7a432dc7fd99",
        draft: {
          ...current.draft,
          original: "https://canonical.example/replacement.jpg"
        }
      }));
      await Promise.resolve();
    });
    const beforeReplacementBlur = publications.length;
    await React.act(async () => originalProps.onBlur());
    assert.equal(publications.length, beforeReplacementBlur, "换代后不得写入旧临时值");

    const source = container.querySelector<HTMLInputElement>(
      "input[placeholder='来源 URL']"
    )!;
    const sourceProps = reactProps<PlainInputProps>(source);
    await React.act(async () => {
      sourceProps.onFocus();
      sourceProps.onChange({ target: { value: "https://discarded.example/source" } });
      root.unmount();
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    assert.equal(publications.length, beforeReplacementBlur, "卡片卸载不得补发临时值");
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

test("任务卡片慢速键入与 URL 格式校验只产生必要的失焦草稿请求", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  let requestCount = 0;
  const requestPaths: string[] = [];
  let version = 1;
  const fetchStub = async (path: string, init?: RequestInit) => {
    requestCount += 1;
    requestPaths.push(path);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const item = (body.items as Array<Record<string, unknown>>)[0]!;
    version += 1;
    return new Response(JSON.stringify({
      ok: true,
      items: [{
        session_id: item.session_id,
        image_id: item.image_id,
        status: "changed",
        version,
        last_semantic_revision: version,
        duplicate_count: 0,
        duplicate_decision: "upload"
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });
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
    fetch: fetchStub,
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
  const consoleMessages: string[] = [];
  const previousConsoleInfo = console.info;
  console.info = (...values: unknown[]) => {
    consoleMessages.push(values.map(String).join(" "));
  };

  try {
    const { createRoot } = await import("react-dom/client");
    const { reduceIngestionQueue } = await import(
      "../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-queue-state.ts"
    );
    const { useStoredIngestionDraftSync } = await import(
      "../../packages/web/src/pages/admin/ingestion/queue/useStoredIngestionDraftSync.ts"
    );
    const { IngestionJobCard } = await import(
      "../../packages/web/src/pages/admin/ingestion/queue/cards/IngestionJobCard.tsx"
    );
    const job = ingestionJob({
      status: "ready",
      serverAccepted: true,
      serverAcceptedOrder: 1,
      serverVersion: 1,
      sessionId: "R".repeat(43),
      imageId: "019f8457-063a-7004-a580-7a432dc7fd8e"
    });
    let state = { page: 1, jobs: [job] };
    const reportedErrors: string[] = [];
    const jobsRef = { current: state.jobs };
    let rerender = () => undefined;
    const dispatch = (action: Parameters<typeof reduceIngestionQueue>[1]) => {
      const next = reduceIngestionQueue(state, action);
      if (next === state) return false;
      state = next;
      jobsRef.current = next.jobs;
      rerender();
      return true;
    };
    const server = {
      status: "ready",
      revision: 100,
      connectionGeneration: 1,
      items: [],
      ensureRevision() { return true; },
      async recoverAuthority() {},
      refresh() {}
    };
    let sync: ReturnType<typeof useStoredIngestionDraftSync> | undefined;
    function Harness() {
      const [, setEpoch] = React.useState(0);
      rerender = () => setEpoch((current) => current + 1);
      sync = useStoredIngestionDraftSync({
        jobsRef,
        dispatch,
        server: server as never,
        reportError: (message) => reportedErrors.push(message),
        observeCompletedIngestions: () => undefined
      });
      return React.createElement(IngestionJobCard, {
        job: jobsRef.current[0]!,
        busy: false,
        storageDisplayName: "本地",
        themes: [],
        allTags: [],
        authors: [],
        onPatch: (current, patch) => sync!.updateJobDraft(current.id, patch),
        onCancel() {},
        onRetry() {},
        onRemove() {},
        onConfirmDuplicate() {},
        onOpenDetail() {},
        onFocusWithin() {},
        onPreview() {}
      });
    }
    const container = document.getElementById("root")!;
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });
    const title = container.querySelector<HTMLInputElement>(
      "input[placeholder='标题']"
    )!;
    const propsKey = Object.keys(title).find((key) => (
      key.startsWith("__reactProps$")
    ));
    assert.ok(propsKey);
    const props = () => (title as unknown as Record<string, {
      onFocus: () => void;
      onChange: (event: { target: { value: string } }) => void;
      onBlur: () => void;
    }>)[propsKey]!;
    await React.act(async () => props().onFocus());
    for (const value of ["慢", "慢速", "慢速输入"]) {
      await React.act(async () => {
        props().onChange({ target: { value } });
        await new Promise((resolve) => setTimeout(resolve, 275));
      });
    }
    assert.equal(requestCount, 0);
    await React.act(async () => {
      props().onBlur();
      await sync!.flushPendingUpdates();
    });
    assert.equal(requestCount, 1);
    assert.equal(jobsRef.current[0]?.draft.title, "慢速输入");

    await React.act(async () => {
      props().onFocus();
      props().onBlur();
      await sync!.flushPendingUpdates();
    });
    assert.equal(requestCount, 1, "无变化失焦不得产生第二次请求");

    const original = container.querySelector<HTMLInputElement>(
      "input[placeholder='原图 URL']"
    )!;
    const originalKey = Object.keys(original).find((key) => (
      key.startsWith("__reactProps$")
    ));
    assert.ok(originalKey);
    const originalProps = () => (original as unknown as Record<string, {
      onFocus: () => void;
      onChange: (event: { target: { value: string } }) => void;
      onBlur: () => void;
    }>)[originalKey]!;
    await React.act(async () => {
      originalProps().onFocus();
      originalProps().onChange({
        target: { value: "http://draft-image.invalid/image.jpg" }
      });
      originalProps().onBlur();
      await sync!.flushPendingUpdates();
    });
    assert.equal(requestCount, 1, "无效原图 URL 不得进入草稿同步请求");
    assert.equal(reportedErrors.length, 0, "无效 URL 不得进入可见草稿错误入口");
    assert.equal(original.classList.contains("is-changed"), false);
    assert.equal(
      consoleMessages.at(-1),
      "[ImageShow] 内容接入草稿原图 URL 格式无效，未保存"
    );

    await React.act(async () => {
      originalProps().onFocus();
      originalProps().onChange({ target: { value: "draft-image.invalid/image.jpg" } });
      originalProps().onBlur();
      await sync!.flushPendingUpdates();
    });
    assert.equal(requestCount, 2, "不可解析的保留域名仍应按纯格式合法草稿保存");
    assert.equal(requestPaths.every((path) => path === ingestionUpdatePath), true);
    assert.equal(
      jobsRef.current[0]?.draft.original,
      "draft-image.invalid/image.jpg",
      "浏览器校验不得以探测结果改写或拒绝格式合法草稿"
    );

    const source = container.querySelector<HTMLInputElement>(
      "input[placeholder='来源 URL']"
    )!;
    const sourceKey = Object.keys(source).find((key) => (
      key.startsWith("__reactProps$")
    ));
    assert.ok(sourceKey);
    const sourceProps = () => (source as unknown as Record<string, {
      onFocus: () => void;
      onChange: (event: { target: { value: string } }) => void;
      onBlur: () => void;
    }>)[sourceKey]!;
    await React.act(async () => {
      sourceProps().onFocus();
      sourceProps().onChange({
        target: { value: "https://user:password@example.com/post" }
      });
      sourceProps().onBlur();
      await sync!.flushPendingUpdates();
    });
    assert.equal(requestCount, 2, "无效来源 URL 不得进入草稿同步请求");
    assert.equal(reportedErrors.length, 0);
    assert.equal(
      consoleMessages.at(-1),
      "[ImageShow] 内容接入草稿来源 URL 格式无效，未保存"
    );
    await React.act(async () => root.unmount());
  } finally {
    console.info = previousConsoleInfo;
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

test("未接管 placeholder 的草稿 fence 不阻塞 Server 全局动作", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
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
    const { useStoredIngestionDraftSync } = await import(
      "../../packages/web/src/pages/admin/ingestion/queue/useStoredIngestionDraftSync.ts"
    );
    const jobsRef = { current: [ingestionJob({
      id: "unaccepted-draft-fence",
      serverAccepted: false,
      serverDraftPending: true,
      serverVersion: undefined,
      sessionId: undefined,
      imageId: undefined
    })] };
    const server = {
      status: "ready",
      revision: 1,
      connectionGeneration: 1,
      ensureRevision() { return true; },
      async recoverAuthority() {},
      refresh() {}
    };
    let sync: ReturnType<typeof useStoredIngestionDraftSync> | undefined;
    function Probe() {
      sync = useStoredIngestionDraftSync({
        jobsRef,
        dispatch: () => false,
        server: server as never,
        reportError: () => undefined,
        observeCompletedIngestions: () => undefined
      });
      return React.createElement("output", null, String(
        sync.hasPendingUpdates()
      ));
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(container.textContent, "false");
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

test("离页草稿 owner 可按 session incarnation 静默退休", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  let fetchCalls = 0;
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
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("已退休的离页草稿不得再发送旧 pair 更新");
    },
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
    const { useStoredIngestionDraftSync } = await import(
      "../../packages/web/src/pages/admin/ingestion/queue/useStoredIngestionDraftSync.ts"
    );
    const sessionId = "O".repeat(43);
    const imageId = "019f8457-063a-7040-a580-7a432dc7fd8e";
    const jobsRef = { current: [ingestionJob({
      id: "off-page-draft-owner",
      attemptKey: "off-page-draft-attempt",
      sessionId,
      imageId,
      serverAccepted: true,
      serverVersion: 1,
      status: "ready"
    })] };
    let state = { jobs: jobsRef.current, page: 1 };
    let sync: ReturnType<typeof useStoredIngestionDraftSync> | undefined;
    const dispatch = (action: Parameters<typeof reduceIngestionQueue>[1]) => {
      const next = reduceIngestionQueue(state, action);
      const changed = next !== state;
      state = next;
      jobsRef.current = next.jobs;
      return changed;
    };
    function Probe() {
      sync = useStoredIngestionDraftSync({
        jobsRef,
        dispatch,
        server: {
          status: "ready",
          revision: 1,
          connectionGeneration: 1,
          items: [],
          ensureRevision() { return true; },
          async recoverAuthority() {},
          refresh() {}
        } as never,
        reportError: () => undefined,
        observeCompletedIngestions: () => undefined
      });
      return React.createElement(
        "output",
        null,
        String(sync.hasPendingUpdates())
      );
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await React.act(async () => {
      sync!.updateJobDraft("off-page-draft-owner", { title: "离页草稿" });
      await Promise.resolve();
    });
    const oldPair = `${sessionId}\0${imageId}`;
    assert.deepEqual(sync!.pairKeysForSession(sessionId), new Set([oldPair]));
    state = { jobs: [], page: 1 };
    jobsRef.current = [];
    await React.act(async () => {
      sync!.retirePairOwners(new Set([oldPair]));
      await Promise.resolve();
    });
    assert.equal(sync!.hasPendingUpdates(), false);
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    assert.equal(fetchCalls, 0);
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

test("重复详情请求单飞执行并及时合并到最新队列", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const md5s = ["a".repeat(32), "b".repeat(32), "c".repeat(32)];
  const requestMd5s: string[][] = [];
  const requestSignals: Array<AbortSignal | undefined> = [];
  const responses: Array<(response: Response) => void> = [];
  const fetchStub = async (
    input: RequestInfo | URL,
    init: RequestInit = {}
  ) => {
    const path = new URL(String(input), "http://localhost").pathname;
    assert.equal(path, ingestionDuplicatesPath);
    const body = JSON.parse(String(init.body ?? "{}")) as { md5s: string[] };
    requestMd5s.push(body.md5s);
    requestSignals.push(init.signal ?? undefined);
    return await new Promise<Response>((resolve) => responses.push(resolve));
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
    fetch: fetchStub,
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
    setCsrfToken("duplicate-details-single-flight-token");
    const { createRoot } = await import("react-dom/client");
    const {
      invalidateIngestionDuplicateDetails,
      useIngestionDuplicateDetails
    } = await import(
      "../../packages/web/src/pages/admin/ingestion/queue/useIngestionDuplicateDetails.ts"
    );
    const jobsFor = (count: number) => md5s.slice(0, count).map((md5, index) => (
      ingestionJob({
        id: `duplicate-details-single-flight-${index}`,
        status: "ready",
        md5,
        duplicateDecision: "undecided",
        duplicateCount: 1,
        serverVersion: index + 1,
        serverAccepted: true
      })
    ));
    const libraryItems = md5s.map((md5) => adminImageListItem({
      id: webUuidV7(),
      md5
    }));
    const responseFor = (indexes: readonly number[]) => new Response(JSON.stringify({
      ok: true,
      items: indexes.map((index) => ({
        md5: md5s[index]!,
        match_count: 1,
        duplicates: [libraryItems[index]!]
      }))
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
    const updatedJobIds = new Set<string>();
    let duplicateDetails: ReturnType<typeof useIngestionDuplicateDetails> | undefined;
    function Probe({ jobs }: { jobs: IngestionJob[] }) {
      duplicateDetails = useIngestionDuplicateDetails({
        jobs,
        updateJobs: (patches) => {
          for (const [id, patch] of patches) {
            if (patch.duplicates?.length) updatedJobIds.add(id);
          }
        },
        updateDuplicateDecision: async () => true
      });
      return React.createElement("output", null, String(jobs.length));
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    const settleUntil = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      assert.fail("duplicate details single-flight request did not settle");
    };
    await React.act(async () => {
      root.render(React.createElement(Probe, { jobs: jobsFor(1) }));
      await Promise.resolve();
    });
    await settleUntil(() => requestMd5s.length === 1);
    await React.act(async () => {
      root.render(React.createElement(Probe, { jobs: jobsFor(2) }));
      await Promise.resolve();
    });
    await React.act(async () => {
      root.render(React.createElement(Probe, { jobs: jobsFor(3) }));
      await Promise.resolve();
    });
    assert.equal(requestMd5s.length, 1);
    await React.act(async () => {
      responses[0]!(responseFor([0]));
      await Promise.resolve();
    });
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settleUntil(() => requestMd5s.length === 2);
    assert.deepEqual(requestMd5s[1], md5s.slice(1));
    await settleUntil(() => updatedJobIds.has("duplicate-details-single-flight-0"));
    assert.equal(updatedJobIds.has("duplicate-details-single-flight-1"), false);
    assert.equal(updatedJobIds.has("duplicate-details-single-flight-2"), false);
    assert.equal(requestSignals[0], undefined);
    assert.equal(requestSignals[1], undefined);
    await React.act(async () => {
      responses[1]!(responseFor([1, 2]));
      await Promise.resolve();
    });
    await settleUntil(() => responses.length === 2);
    assert.equal(requestMd5s.length, 2);
    await React.act(async () => {
      root.render(React.createElement(Probe, { jobs: jobsFor(2) }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(requestMd5s.length, 2);
    await React.act(async () => {
      root.render(React.createElement(Probe, { jobs: jobsFor(3) }));
      await Promise.resolve();
    });
    assert.equal(requestMd5s.length, 2);
    await React.act(async () => {
      duplicateDetails!.refresh();
      await Promise.resolve();
    });
    await settleUntil(() => requestMd5s.length === 3);
    await React.act(async () => {
      root.render(React.createElement(Probe, { jobs: jobsFor(2) }));
      await Promise.resolve();
    });
    await React.act(async () => {
      responses[2]!(responseFor([0, 1, 2]));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(requestMd5s.length, 3);
    await React.act(async () => {
      invalidateIngestionDuplicateDetails(md5s[2]!);
      await Promise.resolve();
    });
    await settleUntil(() => requestMd5s.length === 4);
    assert.deepEqual(requestMd5s[3], md5s.slice(0, 2));
    await React.act(async () => {
      responses[3]!(responseFor([0, 1]));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await React.act(async () => {
      root.render(React.createElement(Probe, { jobs: jobsFor(3) }));
      await Promise.resolve();
    });
    await settleUntil(() => requestMd5s.length === 5);
    assert.deepEqual(requestMd5s[4], md5s.slice(2));
    await React.act(async () => {
      responses[4]!(responseFor([2]));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(requestMd5s.length, 5);
    await React.act(async () => root.unmount());
  } finally {
    clearCsrfToken();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

test("新完成图片按 MD5 精确刷新仍在展示的重复详情", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const md5 = "e".repeat(32);
  const completedItem = adminImageListItem({ id: webUuidV7(), md5 });
  let fetchCalls = 0;
  const observedCounts: number[] = [];
  const fetchStub = async (input: unknown) => {
    const path = new URL(
      typeof input === "string" ? input : (input as Request).url,
      "http://localhost"
    ).pathname;
    assert.equal(path, ingestionDuplicatesPath);
    fetchCalls += 1;
    return new Response(JSON.stringify({
      ok: true,
      items: [{
        md5,
        match_count: fetchCalls,
        duplicates: [completedItem]
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
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
    fetch: fetchStub,
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
    setCsrfToken("duplicate-completed-invalidation-token");
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const { useIngestionQueue } = await import(
      "../../packages/web/src/pages/admin/ingestion/queue/useIngestionQueue.ts"
    );
    const { useIngestionDuplicateDetails } = await import(
      "../../packages/web/src/pages/admin/ingestion/queue/useIngestionDuplicateDetails.ts"
    );
    const jobs = [ingestionJob({
      id: "duplicate-completed-invalidation",
      status: "ready",
      md5,
      duplicateDecision: "undecided",
      duplicateCount: 1,
      duplicates: [completedItem],
      serverVersion: 3,
      serverAccepted: true
    })];
    let observeCompleted: (() => void) | undefined;
    function Probe() {
      const queue = useIngestionQueue(20, "upload", false);
      observeCompleted = () => queue.observeCompletedIngestions([{
        pair: {
          session_id: "D".repeat(43),
          image_id: completedItem.id
        },
        item: completedItem
      }]);
      useIngestionDuplicateDetails({
        jobs,
        updateJobs: (patches) => {
          const count = patches.get(jobs[0]!.id)?.duplicateCount;
          if (typeof count === "number") observedCounts.push(count);
        },
        updateDuplicateDecision: async () => true
      });
      return React.createElement("output", null, String(fetchCalls));
    }
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    const settleUntil = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      assert.fail("completed duplicate invalidation did not settle");
    };
    await React.act(async () => {
      root.render(React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(Probe)
      ));
      await Promise.resolve();
    });
    await settleUntil(() => observedCounts.includes(1));
    await React.act(async () => {
      observeCompleted!();
      await Promise.resolve();
    });
    await settleUntil(() => observedCounts.includes(2));
    assert.equal(fetchCalls, 2);
    await React.act(async () => root.unmount());
    queryClient.clear();
  } finally {
    clearCsrfToken();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

test("重复归零 CAS 失败保留可操作卡片并允许刷新重试", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const md5 = "d".repeat(32);
  let fetchCalls = 0;
  const fetchStub = async (input: unknown) => {
    const path = new URL(
      typeof input === "string" ? input : (input as Request).url,
      "http://localhost"
    ).pathname;
    assert.equal(path, ingestionDuplicatesPath);
    fetchCalls += 1;
    return new Response(JSON.stringify({
      ok: true,
      items: [{ md5, match_count: 0, duplicates: [] }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
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
    fetch: fetchStub,
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
    setCsrfToken("duplicate-zero-cas-token");
    const { createRoot } = await import("react-dom/client");
    const { useIngestionDuplicateDetails } = await import(
      "../../packages/web/src/pages/admin/ingestion/queue/useIngestionDuplicateDetails.ts"
    );
    const duplicate = adminImageListItem({ id: webUuidV7(), md5 });
    const jobs = [ingestionJob({
      id: "duplicate-zero-cas",
      status: "ready",
      md5,
      duplicateDecision: "undecided",
      duplicateCount: 1,
      duplicates: [duplicate],
      serverVersion: 3,
      serverAccepted: true
    })];
    const appliedPatches: Array<ReadonlyMap<string, Partial<IngestionJob>>> = [];
    let decisionCalls = 0;
    const updateJobs = (patches: ReadonlyMap<string, Partial<IngestionJob>>) => {
      appliedPatches.push(patches);
    };
    const updateDuplicateDecision = async () => {
      decisionCalls += 1;
      return decisionCalls > 1;
    };
    let details: ReturnType<typeof useIngestionDuplicateDetails> | undefined;
    function Probe() {
      details = useIngestionDuplicateDetails({
        jobs,
        updateJobs,
        updateDuplicateDecision
      });
      return React.createElement("output", null, details.error);
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    const settleUntil = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      assert.fail("duplicate zero CAS did not settle");
    };
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await settleUntil(() => decisionCalls === 1 && Boolean(details?.error));
    assert.match(details?.error ?? "", /重复状态恢复失败/);
    const firstPatch = appliedPatches[0]?.get(jobs[0]!.id);
    assert.ok(firstPatch);
    assert.equal("duplicateCount" in firstPatch, false);
    assert.equal("duplicates" in firstPatch, false);
    assert.equal(jobs[0]?.duplicateCount, 1);
    assert.equal(jobs[0]?.duplicates.length, 1);
    await React.act(async () => {
      details!.refresh();
      await Promise.resolve();
    });
    await settleUntil(() => decisionCalls === 2 && details?.error === "");
    assert.equal(fetchCalls, 2);
    await React.act(async () => root.unmount());
  } finally {
    clearCsrfToken();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

test("重复决定合并同一在途请求且拒绝跨 incarnation 响应", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const oldSessionId = "R".repeat(43);
  const oldImageId = "019f8457-063a-7036-a580-7a432dc7fd8e";
  let resolveUpdate: ((response: Response) => void) | undefined;
  let updateCalls = 0;
  const requiredRevisions: number[] = [];
  const fetchStub = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    assert.equal(String(input), ingestionUpdatePath);
    updateCalls += 1;
    const body = JSON.parse(String(init.body ?? "{}")) as {
      items: Array<Record<string, unknown>>;
    };
    assert.equal(body.items[0]?.session_id, oldSessionId);
    assert.equal(body.items[0]?.image_id, oldImageId);
    return new Promise<Response>((resolve) => {
      resolveUpdate = resolve;
    });
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
    fetch: fetchStub,
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
    setCsrfToken("duplicate-incarnation-token");
    const { createRoot } = await import("react-dom/client");
    const { useStoredIngestionDraftSync } = await import(
      "../../packages/web/src/pages/admin/ingestion/queue/useStoredIngestionDraftSync.ts"
    );
    const oldJob = ingestionJob({
      id: "duplicate-incarnation-card",
      attemptKey: "duplicate-incarnation-old-attempt",
      sessionId: oldSessionId,
      imageId: oldImageId,
      serverAccepted: true,
      serverVersion: 1,
      status: "ready",
      duplicateDecision: "undecided",
      duplicateCount: 1
    });
    const jobsRef = { current: [oldJob] };
    let state = { jobs: jobsRef.current, page: 1 };
    let sync: ReturnType<typeof useStoredIngestionDraftSync> | undefined;
    const dispatch = (action: Parameters<typeof reduceIngestionQueue>[1]) => {
      const next = reduceIngestionQueue(state, action);
      const changed = next !== state;
      state = next;
      jobsRef.current = next.jobs;
      return changed;
    };
    const server = {
      status: "ready",
      revision: 1,
      connectionGeneration: 1,
      items: [],
      ensureRevision(revision: number) {
        requiredRevisions.push(revision);
        return true;
      },
      async recoverAuthority() {},
      refresh() {}
    };
    function Probe() {
      sync = useStoredIngestionDraftSync({
        jobsRef,
        dispatch,
        server: server as never,
        reportError: () => undefined,
        observeCompletedIngestions: () => undefined
      });
      return React.createElement("output", null, String(
        sync.hasPendingUpdates()
      ));
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });

    const first = sync!.updateDuplicateDecision(oldJob.id, "confirmed");
    const repeated = sync!.updateDuplicateDecision(oldJob.id, "confirmed");
    assert.equal(first, repeated, "同一 target 与决定必须复用同一在途请求");
    for (let attempt = 0; attempt < 20 && !resolveUpdate; attempt += 1) {
      await React.act(async () => {
        await Promise.resolve();
      });
    }
    assert.ok(resolveUpdate);
    const newJob = ingestionJob({
      ...oldJob,
      attemptKey: "duplicate-incarnation-new-attempt",
      sessionId: "N".repeat(43),
      imageId: "019f8457-063a-7037-a580-7a432dc7fd8e",
      serverVersion: 1,
      duplicateDecision: "undecided",
      duplicateCount: 4
    });
    jobsRef.current = [newJob];
    state = { jobs: jobsRef.current, page: 1 };
    await React.act(async () => {
      resolveUpdate!(new Response(JSON.stringify({
        ok: true,
        items: [{
          session_id: oldSessionId,
          image_id: oldImageId,
          status: "changed",
          version: 2,
          last_semantic_revision: 2,
          duplicate_count: 0,
          duplicate_decision: "confirmed"
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
      assert.equal(await first, false);
      assert.equal(await repeated, false);
    });
    assert.equal(updateCalls, 1);
    assert.equal(jobsRef.current[0]?.attemptKey, newJob.attemptKey);
    assert.equal(jobsRef.current[0]?.duplicateDecision, "undecided");
    assert.equal(jobsRef.current[0]?.duplicateCount, 4);
    assert.equal(jobsRef.current[0]?.serverVersion, 1);
    assert.deepEqual(
      requiredRevisions,
      [2],
      "已知旧 incarnation 写入结果必须按 semantic revision 对账"
    );
    await React.act(async () => root.unmount());
  } finally {
    clearCsrfToken();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

test("双队列重复确认各自单飞且 busy 互不阻塞", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
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
    const { useIngestionCommit } = await import(
      "../../packages/web/src/pages/admin/ingestion/queue/useIngestionCommit.ts"
    );

    const uploadJob = ingestionJob({
      id: "upload-duplicate-single-flight",
      sessionId: "G".repeat(43),
      imageId: "019f8457-063a-7041-a580-7a432dc7fd8e",
      serverAccepted: true,
      serverVersion: 1,
      status: "ready",
      duplicateDecision: "undecided",
      duplicateCount: 1
    });
    const importOwnerJob = ingestionJob({
      id: "import-duplicate-independent",
      sessionId: "I".repeat(43),
      imageId: "019f8457-063a-7042-a580-7a432dc7fd8e",
      serverAccepted: true,
      serverVersion: 1,
      status: "ready",
      duplicateDecision: "undecided",
      duplicateCount: 1
    });
    const uploadJobsRef = { current: [uploadJob] };
    const ingestionJobsRef = { current: [importOwnerJob] };
    let uploadDecisionCalls = 0;
    let importDecisionCalls = 0;
    let finishUploadDecision: (() => void) | undefined;
    let uploadCommit: ReturnType<typeof useIngestionCommit> | undefined;
    let importCommit: ReturnType<typeof useIngestionCommit> | undefined;
    function Probe() {
      uploadCommit = useIngestionCommit({
        jobsRef: uploadJobsRef,
        updateJob: () => undefined,
        updateJobs: () => undefined,
        updateDuplicateDecision: async () => {
          uploadDecisionCalls += 1;
          return new Promise<boolean>((resolve) => {
            finishUploadDecision = () => {
              uploadJobsRef.current = [{
                ...uploadJobsRef.current[0]!,
                duplicateDecision: "confirmed"
              }];
              resolve(true);
            };
          });
        },
        flushPendingUpdates: async () => undefined,
        onDone: () => undefined
      });
      importCommit = useIngestionCommit({
        jobsRef: ingestionJobsRef,
        updateJob: () => undefined,
        updateJobs: () => undefined,
        updateDuplicateDecision: async () => {
          importDecisionCalls += 1;
          ingestionJobsRef.current = [{
            ...ingestionJobsRef.current[0]!,
            duplicateDecision: "confirmed"
          }];
          return true;
        },
        flushPendingUpdates: async () => undefined,
        onDone: () => undefined
      });
      return React.createElement("output", null, JSON.stringify({
        uploadBusy: uploadCommit.busy,
        importBusy: importCommit.busy
      }));
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const view = () => JSON.parse(container.textContent || "{}") as {
      uploadBusy: boolean;
      importBusy: boolean;
    };
    let uploadFirst: Promise<boolean> | undefined;
    let uploadSecond: Promise<boolean> | undefined;
    await React.act(async () => {
      uploadFirst = uploadCommit!.confirmDuplicate(uploadJob.id);
      uploadSecond = uploadCommit!.confirmDuplicate(uploadJob.id);
      await Promise.resolve();
    });
    assert.equal(await uploadSecond, false);
    assert.equal(uploadDecisionCalls, 1);
    assert.deepEqual(view(), { uploadBusy: true, importBusy: false });
    let importResult = false;
    await React.act(async () => {
      importResult = await importCommit!.confirmDuplicate(importOwnerJob.id);
    });
    assert.equal(importResult, true);
    assert.equal(importDecisionCalls, 1);
    assert.deepEqual(
      view(),
      { uploadBusy: true, importBusy: false },
      "upload 请求在途时 import owner 必须仍可独立确认"
    );
    await React.act(async () => {
      finishUploadDecision!();
      assert.equal(await uploadFirst, true);
    });
    assert.deepEqual(view(), { uploadBusy: false, importBusy: false });
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

test("旧提交点击不会命中同 ID 的新任务尝试", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  let fetchCalls = 0;
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
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("旧尝试不得发起提交请求");
    },
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
    const { useIngestionCommit } = await import(
      "../../packages/web/src/pages/admin/ingestion/queue/useIngestionCommit.ts"
    );
    const oldAttempt = ingestionJob({
      id: "reused-job-id",
      attemptKey: "old-attempt",
      status: "ready",
      serverAccepted: true,
      serverVersion: 1,
      sessionId: "O".repeat(43),
      imageId: "019f8457-063a-7043-a580-7a432dc7fd8e"
    });
    const newAttempt = ingestionJob({
      ...oldAttempt,
      attemptKey: "new-attempt",
      sessionId: "N".repeat(43),
      imageId: "019f8457-063a-7044-a580-7a432dc7fd8e"
    });
    const jobsRef = { current: [newAttempt] };
    let commit: ReturnType<typeof useIngestionCommit>["commit"] | undefined;
    let patchedJobs = 0;
    let doneSignals = 0;
    function Probe() {
      ({ commit } = useIngestionCommit({
        jobsRef,
        updateJob: () => undefined,
        updateJobs: (patches) => {
          patchedJobs += patches.size;
        },
        updateDuplicateDecision: async () => false,
        flushPendingUpdates: async () => undefined,
        observeCompletedIngestions: () => undefined,
        onDone: () => {
          doneSignals += 1;
        }
      }));
      return null;
    }
    const root = createRoot(document.getElementById("root")!);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    let accepted = true;
    await React.act(async () => {
      accepted = await commit!([oldAttempt]);
    });
    assert.equal(accepted, false);
    assert.equal(fetchCalls, 0);
    assert.equal(patchedJobs, 0);
    assert.equal(doneSignals, 0);
    assert.equal(jobsRef.current[0]?.attemptKey, "new-attempt");
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

test("placeholder 草稿按批写回并自动跨越 worker 版本推进", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const paths: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  let updateCalls = 0;
  const sessionIds = ["K".repeat(43), "L".repeat(43), "M".repeat(43)];
  const imageIds = [
    "019f8457-063a-7004-a580-7a432dc7fd92",
    "019f8457-063a-7004-a580-7a432dc7fd93",
    "019f8457-063a-7004-a580-7a432dc7fd94"
  ];
  const json = (value: unknown) => new Response(JSON.stringify({
    ok: true,
    ...value as object
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  const fetchStub = async (input: unknown, init: RequestInit = {}) => {
    const path = String(input);
    const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    paths.push(path);
    bodies.push(body);
    if (path === ingestionUpdatePath) {
      updateCalls += 1;
      const items = body.items as Array<Record<string, unknown>>;
      if (updateCalls === 1) {
        assert.equal(items.length, 3, "同一 debounce 窗口必须合并为一个 update 批次");
        return json({
          items: items.map((item, index) => index === 0 ? {
            session_id: item.session_id,
            image_id: item.image_id,
            status: "failed",
            code: "ingestion_version_conflict",
            message: "内容接入任务版本已变化"
          } : {
            session_id: item.session_id,
            image_id: item.image_id,
            status: index === 1 ? "changed" : "unchanged",
            version: index === 1 ? 2 : 1,
            last_semantic_revision: index === 1 ? 2 : 1,
            duplicate_count: 0,
            duplicate_decision: "upload"
          })
        });
      }
      assert.equal(items.length, 1);
      assert.equal(items[0]?.expected_version, 2);
      assert.equal(
        (items[0]?.metadata as Record<string, unknown>).title,
        "clicked-draft-0"
      );
      return json({
        items: [{
          session_id: items[0]?.session_id,
          image_id: items[0]?.image_id,
          status: "changed",
          version: 3,
          last_semantic_revision: 3,
          duplicate_count: 0,
          duplicate_decision: "upload"
        }]
      });
    }
    if (path === ingestionStatusPath) {
      const requested = body.items as Array<Record<string, unknown>>;
      assert.equal(requested.length, 1);
      return json({
        items: [{
          session_id: sessionIds[0],
          image_id: imageIds[0],
          status: "present",
          item: {
            session_id: sessionIds[0],
            image_id: imageIds[0],
            queue: "import",
            source_type: "url",
            resolved_image_time: "2026-08-23T01:02:03.456Z",
            status: "preparing",
            phase: "prepare",
            message: "worker advanced",
            progress: 10,
            version: 2,
            progress_seq: 1,
            last_semantic_revision: 2,
            accepted_at: 1,
            accepted_order: 1,
            metadata: ingestionJob().draft,
            storage_slug: "local"
          }
        }]
      });
    }
    throw new Error(`unexpected fetch ${path}`);
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
    fetch: fetchStub,
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
    const { useStoredIngestionDraftSync } = await import(
      "../../packages/web/src/pages/admin/ingestion/queue/useStoredIngestionDraftSync.ts"
    );
    let state = {
      page: 1,
      jobs: sessionIds.map((sessionId, index) => ingestionJob({
        id: `batched-draft-${index}`,
        attemptKey: `batched-draft-attempt-${index}`,
        status: "queued",
        serverAccepted: true,
        serverAcceptedOrder: index + 1,
        serverVersion: 1,
        serverDraftPending: true,
        sessionId,
        imageId: imageIds[index],
        draft: {
          ...ingestionJob().draft,
          title: `clicked-draft-${index}`
        }
      }))
    };
    const jobsRef = { current: state.jobs };
    const dispatch = (action: Parameters<typeof reduceIngestionQueue>[1]) => {
      const next = reduceIngestionQueue(state, action);
      if (next === state) return false;
      state = next;
      jobsRef.current = next.jobs;
      return true;
    };
    const errors: string[] = [];
    const server = {
      status: "ready",
      revision: 0,
      connectionGeneration: 1,
      ensureRevision() { return true; },
      async recoverAuthority() {},
      refresh() {}
    };
    let sync: ReturnType<typeof useStoredIngestionDraftSync> | undefined;
    function Probe() {
      sync = useStoredIngestionDraftSync({
        jobsRef,
        dispatch,
        server: server as never,
        reportError: (message) => errors.push(message),
        observeCompletedIngestions: () => undefined
      });
      return null;
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    let flushError: unknown;
    await React.act(async () => {
      try {
        await sync!.flushPendingUpdates();
      } catch (error) {
        flushError = error;
      }
    });
    assert.equal(
      flushError,
      undefined,
      JSON.stringify({ paths, bodies, errors })
    );
    assert.deepEqual(paths, [ingestionUpdatePath, ingestionStatusPath, ingestionUpdatePath]);
    assert.equal(jobsRef.current[0]?.serverVersion, 3);
    assert.equal(jobsRef.current[1]?.serverVersion, 2);
    assert.equal(jobsRef.current[2]?.serverVersion, 1);
    assert.deepEqual(errors, []);
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

test("未知 completed 交接在 status 失败后可显式重试", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  let fetchCalls = 0;
  let releaseHeldStatus: ((response: Response) => void) | undefined;
  let heldStatusAborted = false;
  const fetchStub = async (_input: unknown, init: RequestInit = {}) => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return new Response(JSON.stringify({
        ok: false,
        error: { code: "temporary", message: "temporary status failure" }
      }), {
        status: 503,
        headers: { "content-type": "application/json" }
      });
    }
    if (fetchCalls === 4) {
      return new Promise<Response>((resolve, reject) => {
        releaseHeldStatus = resolve;
        init.signal?.addEventListener("abort", () => {
          heldStatusAborted = true;
          reject(new Error("held status aborted"));
        }, { once: true });
      });
    }
    if (fetchCalls === 5 || fetchCalls === 6) {
      const active = fetchCalls === 5;
      return new Response(JSON.stringify({
        ok: true,
        items: [{
          session_id: "J".repeat(43),
          image_id: "019f8457-063a-7004-a580-7a432dc7fd90",
          status: "completed",
          completed_item: adminImageListItem({
            id: "019f8457-063a-7004-a580-7a432dc7fd90"
          }),
          redis_status: active ? "active" : "completed",
          redis_version: active ? 2 : 3,
          redis_last_semantic_revision: active ? 101 : 102
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({
      ok: true,
      items: [{
        session_id: "H".repeat(43),
        image_id: "019f8457-063a-7004-a580-7a432dc7fd8f",
        status: "missing"
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
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
    fetch: fetchStub,
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
    const { useIngestionAuthorityHandoffs } = await import(
      "../../packages/web/src/pages/admin/ingestion/queue/useIngestionAuthorityHandoffs.ts"
    );
    const errors: Array<{ message: string; retryable: boolean }> = [];
    const observedHandoffCompleted: string[] = [];
    const ensuredHandoffCoverage: Array<{
      revision?: number;
      connectionGeneration?: number;
    }> = [];
    const jobsRef = { current: [] as IngestionJob[] };
    const server = {
      status: "ready",
      connectionGeneration: 1,
      revision: 7,
      ensureRevision(revision?: number, connectionGeneration?: number) {
        ensuredHandoffCoverage.push({ revision, connectionGeneration });
        return true;
      },
      async recoverAuthority() {},
      refresh() {}
    };
    let handoffs: ReturnType<typeof useIngestionAuthorityHandoffs> | undefined;
    function Probe() {
      handoffs = useIngestionAuthorityHandoffs({
        jobs: [],
        jobsRef,
        dispatch: () => false,
        server: server as never,
        reportError: (message, retryable = true) => {
          errors.push({ message, retryable });
        },
        promoteReconnectOwners: () => new Set(),
        observeCompletedIngestions: (entries) => {
          observedHandoffCompleted.push(...entries.map(({ pair }) => pair.image_id));
        }
      });
      return React.createElement("output", null, String(handoffs.pending));
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    const settleUntil = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      assert.fail("authority handoff retry did not settle");
    };
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await React.act(async () => {
      handoffs!.prepareBinding({
        sessionId: "H".repeat(43),
        imageId: "019f8457-063a-7004-a580-7a432dc7fd8f",
        serverAccepted: true,
        serverHandoffPending: true,
        serverHandoffRevision: undefined
      });
      handoffs!.prepareBinding({
        sessionId: "H".repeat(43),
        imageId: "019f8457-063a-7004-a580-7a432dc7fd8f",
        serverAccepted: true,
        serverHandoffPending: true,
        serverHandoffRevision: 8
      }, 1);
      await Promise.resolve();
    });
    assert.deepEqual(
      ensuredHandoffCoverage.slice(0, 2),
      [
        { revision: undefined, connectionGeneration: 1 },
        { revision: 8, connectionGeneration: 1 }
      ],
      "同一轮 unknown 与已知 revision 必须同时登记到单一 snapshot owner"
    );
    await settleUntil(() => fetchCalls === 1 && errors.length === 1);
    assert.equal(container.textContent, "true");
    await React.act(async () => {
      handoffs!.retry();
      await Promise.resolve();
    });
    await settleUntil(() => fetchCalls === 2 && container.textContent === "false");
    assert.equal(
      errors.length,
      1,
      "missing 只收敛交接围栏，不应再发布队列级提示"
    );
    server.connectionGeneration = 2;
    server.revision = 100;
    const coverageBeforeCrossGeneration = ensuredHandoffCoverage.length;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await React.act(async () => {
      handoffs!.prepareBinding({
        sessionId: "H".repeat(43),
        imageId: "019f8457-063a-7004-a580-7a432dc7fd8f",
        serverAccepted: true,
        serverHandoffPending: true,
        serverHandoffRevision: 44
      }, 1);
      await Promise.resolve();
    });
    await settleUntil(() => fetchCalls === 3 && container.textContent === "false");
    assert.equal(
      fetchCalls,
      3,
      "旧连接的迟到 HTTP revision 即使数值已覆盖也必须先查当前 status"
    );
    assert.equal(
      ensuredHandoffCoverage.length,
      coverageBeforeCrossGeneration,
      "旧连接 handoff revision 不得直接排入新连接 snapshot 围栏"
    );

    server.connectionGeneration = 3;
    server.revision = 100;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const coverageBeforeCurrentPairResponse = ensuredHandoffCoverage.length;
    await React.act(async () => {
      handoffs!.prepareBinding({
        sessionId: "I".repeat(43),
        imageId: "019f8457-063a-7004-a580-7a432dc7fd91",
        serverAccepted: true,
        serverHandoffPending: true,
        serverHandoffRevision: 99
      }, 2);
      handoffs!.prepareBinding({
        sessionId: "I".repeat(43),
        imageId: "019f8457-063a-7004-a580-7a432dc7fd91",
        serverAccepted: true,
        serverHandoffPending: true,
        serverHandoffRevision: 2
      }, 3);
      await Promise.resolve();
    });
    await settleUntil(() => fetchCalls === 4 && Boolean(releaseHeldStatus));
    assert.deepEqual(
      ensuredHandoffCoverage.slice(coverageBeforeCurrentPairResponse),
      [{ revision: 2, connectionGeneration: 3 }],
      "当前代同 pair 响应不得继承 status 未验证的旧代高 revision"
    );
    server.revision = 101;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(fetchCalls, 4, "无关 revision 推进不得重启在途 status 查询");
    assert.equal(heldStatusAborted, false);
    await React.act(async () => {
      releaseHeldStatus?.(new Response(JSON.stringify({
        ok: true,
        items: [{
          session_id: "I".repeat(43),
          image_id: "019f8457-063a-7004-a580-7a432dc7fd91",
          status: "missing"
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
      await Promise.resolve();
    });
    await settleUntil(() => container.textContent === "false");
    assert.equal(
      errors.length,
      1,
      "迟到的 missing 结果同样不得覆盖可重试错误或插入新提示"
    );

    await React.act(async () => {
      handoffs!.prepareBinding({
        sessionId: "J".repeat(43),
        imageId: "019f8457-063a-7004-a580-7a432dc7fd90",
        serverAccepted: true,
        serverHandoffPending: true,
        serverHandoffRevision: undefined
      }, 3);
      await Promise.resolve();
    });
    await settleUntil(() => fetchCalls === 5);
    assert.equal(container.textContent, "true");
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(
      fetchCalls,
      5,
      "PG completed 但 Redis active 时同一 revision 不得轮询"
    );
    server.revision = 102;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await settleUntil(() => fetchCalls === 6 && container.textContent === "false");
    assert.deepEqual(
      ensuredHandoffCoverage.at(-1),
      { revision: 102, connectionGeneration: 3 },
      "跨代围栏必须改用当前连接 status 返回的 revision 证明"
    );
    assert.deepEqual(observedHandoffCompleted, [
      "019f8457-063a-7004-a580-7a432dc7fd90",
      "019f8457-063a-7004-a580-7a432dc7fd90"
    ], "权威交接每次完成态 status 都必须交给 owner 统一去重");

    server.connectionGeneration = 4;
    server.revision = 200;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const externalPairKey = `${"K".repeat(43)}\0${
      "019f8457-063a-7004-a580-7a432dc7fd92"
    }`;
    await React.act(async () => {
      handoffs!.prepareBinding({
        sessionId: "K".repeat(43),
        imageId: "019f8457-063a-7004-a580-7a432dc7fd92",
        serverAccepted: true,
        serverHandoffPending: true,
        serverHandoffRevision: undefined
      }, 4, true);
      await Promise.resolve();
    });
    assert.equal(container.textContent, "true");
    server.connectionGeneration = 5;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(
      container.textContent,
      "true",
      "unknown completed 围栏不得因 SSE 连接代际变化而清除"
    );
    assert.equal(fetchCalls, 6, "external status owner 仍只允许外部查询");
    await React.act(async () => {
      handoffs!.verifyExternalStatusRevisions(new Map([
        [externalPairKey, 202]
      ]));
      await Promise.resolve();
    });
    assert.equal(container.textContent, "true");
    server.revision = 202;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(
      container.textContent,
      "true",
      "external status owner 必须等待外层 snapshot coverage 显式释放"
    );
    await React.act(async () => {
      handoffs!.resolveExternalStatuses(new Set([externalPairKey]));
      await Promise.resolve();
    });
    assert.equal(container.textContent, "false");
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

test("取消只在服务端明确丢弃后报告成功", async () => {
  const originalFetch = globalThis.fetch;
  const sessionId = "C".repeat(43);
  const imageId = "019f8457-063a-7003-a580-7a432dc7fd8e";
  let jobs = [ingestionJob({
    kind: "upload",
    sessionId,
    imageId,
    serverVersion: undefined,
    status: "failed",
    failureStage: "prepare"
  })];
  const jobsRef = { current: jobs };
  const observedCompleted: string[] = [];
  const queue = {
    jobsRef,
    observeCompletedIngestions(entries: Array<{
      pair: { session_id: string; image_id: string };
    }>) {
      observedCompleted.push(...entries.map(({ pair }) => (
        `${pair.session_id}\0${pair.image_id}`
      )));
    },
    updateJob(id: string, patch: Partial<IngestionJob>) {
      jobs = jobs.map((job) => job.id === id ? { ...job, ...patch } : job);
      jobsRef.current = jobs;
    }
  };
  const paths: string[] = [];
  let statusItem: Record<string, unknown> = {
    session_id: sessionId,
    image_id: imageId,
    status: "missing"
  };
  let cancelStatus: "discarded" | "completed" = "discarded";
  const completedCancelItem = adminImageListItem({ id: imageId });
  globalThis.fetch = (async (input) => {
    const path = String(input);
    paths.push(path);
    if (path === ingestionStatusPath) {
      return new Response(JSON.stringify({
        ok: true,
        items: [statusItem]
      }), { status: 200 });
    }
    if (path === ingestionCancelPath) {
      return new Response(JSON.stringify({
        ok: true,
        items: [{
          session_id: sessionId,
          image_id: imageId,
          status: cancelStatus,
          ...(cancelStatus === "completed"
            ? { completed_item: completedCancelItem }
            : { queue_revision: 17 })
        }]
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${path}`);
  }) as typeof fetch;
  try {
    assert.equal(await cancelServerIngestionJob(queue, jobs[0]!), false);
    assert.equal(jobs[0]?.status, "failed");
    assert.equal(jobs[0]?.failureStage, "cancel");
    assert.match(jobs[0]?.message ?? "", /尚未确认/);
    assert.deepEqual(paths, [ingestionStatusPath]);

    jobs = [ingestionJob({
      kind: "upload",
      sessionId,
      imageId,
      serverVersion: 3,
      status: "failed",
      failureStage: "cancel"
    })];
    jobsRef.current = jobs;
    const discardedJob = jobs[0]!;
    const discardedOutcome = (
      await cancelServerIngestionJobs(queue, [discardedJob])
    ).get(discardedJob.id);
    assert.equal(discardedOutcome?.succeeded, true);
    assert.equal(
      discardedOutcome?.releasedRevision,
      17,
      "discarded queue_revision 必须传入 owner 的 releasedRevision"
    );
    assert.equal(jobs[0]?.status, "cancelled");
    assert.deepEqual(paths, [ingestionStatusPath, ingestionCancelPath]);

    jobs = [ingestionJob({
      kind: "upload",
      sessionId,
      imageId,
      serverVersion: undefined,
      status: "failed",
      failureStage: "cancel"
    })];
    jobsRef.current = jobs;
    statusItem = {
      session_id: sessionId,
      image_id: imageId,
      status: "completed",
      completed_item: completedCancelItem,
      redis_status: "active",
      redis_version: 4,
      redis_last_semantic_revision: 9
    };
    cancelStatus = "completed";
    assert.equal(await cancelServerIngestionJob(queue, jobs[0]!), false);
    assert.equal(jobs[0]?.status, "finalized");
    assert.deepEqual(
      paths.slice(-2),
      [ingestionStatusPath, ingestionCancelPath],
      "PG completed 但 Redis receipt 仍存在时必须继续调用 cancel 收口回执"
    );
    assert.deepEqual(observedCompleted, [
      `${sessionId}\0${imageId}`,
      `${sessionId}\0${imageId}`
    ], "status 与取消终态都必须先交给 owner 的 pair 去重入口");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("清空队列按 pair 合并 placeholder 与同一 Server 动作结果", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
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
    const { useIngestionQueueWorkflowActions } = await import(
      "../../packages/web/src/pages/admin/ingestion/workflow/useIngestionQueueWorkflowActions.ts"
    );
    const pair = {
      session_id: "C".repeat(43),
      image_id: "019f8457-063a-7021-a580-7a432dc7fd8e"
    };
    const placeholder = ingestionJob({
      id: "overlap-placeholder",
      attemptKey: "overlap-attempt",
      batchKey: "overlap-batch",
      kind: "import",
      status: "queued"
    });
    const jobsRef = { current: [placeholder] };
    let serverPair = pair;
    let serverItems: Array<{
      session_id: string;
      image_id: string;
      status: "changed" | "unchanged" | "skipped" | "failed";
      message?: string;
    }> = [{ ...serverPair, status: "changed" }];
    let outcomeAcceptedOrder = 1;
    let cancellationMode: "completed" | "discarded" | "missing" = "completed";
    let failNextAction = false;
    let freezeCalls = 0;
    let refreshes = 0;
    const actionRuns: unknown[] = [];
    const queue = {
      queueType: "import" as const,
      localJobs: jobsRef.current,
      jobsRef,
      pendingAuthorityHandoff: false,
      summary: { unfinishedCount: 1, doneJobs: 0 },
      actions: {
        identity: "generation\0scope\0watermark",
        freeze: (action: string) => {
          freezeCalls += 1;
          return {
            queue: "import",
            actionRequestId: "019f8457-063a-7022-a580-7a432dc7fd8e",
            action,
            actionScope: "scope",
            actionWatermark: "watermark",
            connectionGeneration: 1
          };
        },
        run: async (frozen: unknown) => {
          actionRuns.push(frozen);
          if (failNextAction) {
            failNextAction = false;
            refreshes += 1;
            return null;
          }
          const result = {
            processed: serverItems.length,
            changed: serverItems.filter(
              (item) => item.status === "changed"
            ).length,
            failed: serverItems.filter(
              (item) => item.status === "failed"
            ).length,
            items: serverItems
          };
          refreshes += 1;
          return result;
        }
      },
      server: {
        status: "ready" as const,
        connectionGeneration: 1,
        actionScope: "scope",
        recoverAfterSuccessfulAction: async () => { refreshes += 1; },
        recoverAuthority: async () => { refreshes += 1; },
        refresh() { refreshes += 1; }
      },
      projectCompletedCleanupBatch: () => 0,
      recoverAfterSuccessfulAction: async () => { refreshes += 1; },
      captureBrowserActionJobs: (predicate: (job: IngestionJob) => boolean) => (
        jobsRef.current.filter(predicate)
      ),
      appendJobs: (jobs: IngestionJob[]) => {
        jobsRef.current = [...jobsRef.current, ...jobs];
        queue.localJobs = jobsRef.current;
        return true;
      },
      clearJobIds: (ids: ReadonlySet<string>) => {
        jobsRef.current = jobsRef.current.filter((job) => !ids.has(job.id));
        queue.localJobs = jobsRef.current;
      },
      releaseResolvedServerJobs: (targets: readonly {
        id: string;
        attemptKey: string;
        pair: { session_id: string; image_id: string };
      }[]) => {
        const released = new Set<string>();
        for (const target of targets) {
          const current = jobsRef.current.find((job) => job.id === target.id);
          if (
            current?.attemptKey === target.attemptKey
            && current.sessionId === target.pair.session_id
            && current.imageId?.toLowerCase() === target.pair.image_id.toLowerCase()
            && current.serverAccepted === true
          ) released.add(target.id);
        }
        jobsRef.current = jobsRef.current.filter((job) => !released.has(job.id));
        queue.localJobs = jobsRef.current;
        return released;
      },
      applyDefaultsToLocalJobs() {},
      flushPendingUpdates: async () => undefined,
      hasPendingDraftUpdates: () => false
    };
    const cancelJobs = async (jobs: readonly IngestionJob[]) => {
      const targetPairs = new Map(jobs.map((target) => [
        target.id,
        target.sessionId && target.imageId
          ? {
              session_id: target.sessionId,
              image_id: target.imageId
            }
          : pair
      ]));
      jobsRef.current = jobsRef.current.map((job) => {
        const target = jobs.find((candidate) => (
          candidate.id === job.id && candidate.attemptKey === job.attemptKey
        ));
        if (!target) return job;
        const targetPair = targetPairs.get(target.id)!;
        return {
          ...target,
          sessionId: targetPair.session_id,
          imageId: targetPair.image_id,
          serverAccepted: true,
          serverAcceptedOrder: outcomeAcceptedOrder,
          status: cancellationMode === "completed"
            ? "finalized"
            : cancellationMode === "discarded"
              ? "cancelled"
              : "failed"
        };
      });
      queue.localJobs = jobsRef.current;
      return new Map(jobs.map((target) => [target.id, {
        succeeded: cancellationMode === "discarded",
        pair: targetPairs.get(target.id)!,
        ...(cancellationMode === "completed"
          ? { terminal: "completed" as const }
          : {})
      }]));
    };
    let workflow: ReturnType<typeof useIngestionQueueWorkflowActions> | undefined;
    function Probe() {
      workflow = useIngestionQueueWorkflowActions({
        queue: queue as never,
        defaults: {
          device: "pc",
          brightness: "dark",
          theme: "none",
          author: "",
          tags: []
        },
        cancelJobs,
        commitJobs: async () => false,
        onDone() {}
      });
      return null;
    }
    const root = createRoot(document.getElementById("root")!);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const abandonedCleanupJob = ingestionJob({
      id: "abandoned-cleanup",
      attemptKey: "abandoned-cleanup-attempt",
      status: "ready"
    });
    const replacementCleanupJob = ingestionJob({
      id: "replacement-cleanup",
      attemptKey: "replacement-cleanup-attempt",
      status: "ready"
    });
    jobsRef.current = [abandonedCleanupJob];
    queue.localJobs = jobsRef.current;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const abandonedFreezeStart = freezeCalls;
    assert.deepEqual(
      workflow!.armCleanupAction("uncommitted", 1),
      { count: 1 }
    );
    workflow!.discardUnconfirmedIntents();
    jobsRef.current = [replacementCleanupJob];
    queue.localJobs = jobsRef.current;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.deepEqual(
      workflow!.armCleanupAction("uncommitted", 2),
      { count: 2 }
    );
    assert.equal(
      freezeCalls,
      abandonedFreezeStart + 2,
      "未执行的确认被关闭后必须释放冻结任务并为下一次操作重新取界"
    );
    workflow!.discardUnconfirmedIntents();
    jobsRef.current = [placeholder];
    queue.localJobs = jobsRef.current;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(workflow!.armClearQueue(), true);
    assert.equal(await workflow!.confirmClearQueue(), true);
    assert.deepEqual(jobsRef.current, []);

    jobsRef.current = [placeholder];
    queue.localJobs = jobsRef.current;
    serverPair = {
      ...pair,
      image_id: "019f8457-063a-7023-a580-7a432dc7fd8e"
    };
    serverItems = [{ ...serverPair, status: "changed" }];
    outcomeAcceptedOrder = 2;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.notEqual(workflow!.armCleanupAction("uncommitted"), false);
    assert.equal(
      await workflow!.confirmCleanupAction("uncommitted"),
      true,
      "并行 status 已推进出原筛选集合时应保留卡片并收起确认"
    );
    assert.equal(jobsRef.current.length, 1);

    jobsRef.current = [placeholder];
    queue.localJobs = jobsRef.current;
    serverItems = [];
    outcomeAcceptedOrder = 99;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(workflow!.armClearQueue(), true);
    assert.equal(
      await workflow!.confirmClearQueue(),
      true,
      "clear 首响应丢失或确认后 accept 的本地 attempt 仍属于冻结清空意图"
    );
    assert.deepEqual(jobsRef.current, []);

    jobsRef.current = [placeholder];
    queue.localJobs = jobsRef.current;
    cancellationMode = "discarded";
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(workflow!.armClearQueue(), true);
    assert.equal(await workflow!.confirmClearQueue(), true);
    assert.deepEqual(
      jobsRef.current,
      [],
      "明确 discarded 的 Server pair 必须同步释放本地 owner"
    );

    jobsRef.current = [placeholder];
    queue.localJobs = jobsRef.current;
    cancellationMode = "missing";
    serverItems = [{ ...pair, status: "changed" }];
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.notEqual(workflow!.armCleanupAction("uncommitted"), false);
    assert.equal(
      await workflow!.confirmCleanupAction("uncommitted"),
      true,
      "Server 已 changed 的 exact pair 必须收敛本地 missing 结果"
    );
    assert.deepEqual(
      jobsRef.current,
      [],
      "全局清理先完成时，本地 status/cancel 的 missing 不得卡住 owner"
    );
    cancellationMode = "discarded";

    const laterJob = ingestionJob({
      id: "later-uncommitted-job",
      attemptKey: "later-uncommitted-attempt",
      status: "ready"
    });
    jobsRef.current = [placeholder];
    queue.localJobs = jobsRef.current;
    serverItems = [];
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.notEqual(workflow!.armCleanupAction("uncommitted"), false);
    jobsRef.current = [placeholder, laterJob];
    queue.localJobs = jobsRef.current;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(await workflow!.confirmCleanupAction("uncommitted"), true);
    assert.deepEqual(
      jobsRef.current.map((job) => job.id),
      [laterJob.id],
      "状态清理确认必须保留打开确认后新加入的任务"
    );

    const replacedAttempt = ingestionJob({
      id: "cleanup-replaced-attempt",
      attemptKey: "cleanup-replaced-old",
      status: "queued"
    });
    const replacementAttempt = ingestionJob({
      ...replacedAttempt,
      attemptKey: "cleanup-replaced-new"
    });
    jobsRef.current = [replacedAttempt];
    queue.localJobs = jobsRef.current;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.notEqual(workflow!.armCleanupAction("uncommitted"), false);
    jobsRef.current = [replacementAttempt];
    queue.localJobs = jobsRef.current;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(
      await workflow!.confirmCleanupAction("uncommitted"),
      true,
      "同 id 新 attempt 应跳过旧冻结任务并正常结束确认"
    );
    assert.deepEqual(
      jobsRef.current.map((job) => job.attemptKey),
      [replacementAttempt.attemptKey]
    );

    jobsRef.current = [placeholder];
    queue.localJobs = jobsRef.current;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(workflow!.armClearQueue(), true);
    jobsRef.current = [placeholder, laterJob];
    queue.localJobs = jobsRef.current;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(await workflow!.confirmClearQueue(), true);
    assert.deepEqual(
      jobsRef.current.map((job) => job.id),
      [laterJob.id],
      "整队列确认也只能清理打开确认时冻结的任务"
    );

    const advancedJob = { ...placeholder, status: "done" as const };
    jobsRef.current = [placeholder];
    queue.localJobs = jobsRef.current;
    serverItems = [{ ...serverPair, status: "skipped" }];
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.notEqual(workflow!.armCleanupAction("uncommitted"), false);
    jobsRef.current = [advancedJob];
    queue.localJobs = jobsRef.current;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(
      await workflow!.confirmCleanupAction("uncommitted"),
      true,
      "状态变化造成的 skipped 应关闭确认并由卡片直接反映"
    );
    assert.deepEqual(
      jobsRef.current.map((job) => job.id),
      [advancedJob.id],
      "确认时已不匹配原清理谓词的冻结任务不得被本地路径移除"
    );

    const retryDoneJob = ingestionJob({
      id: "cleanup-retry-done",
      attemptKey: "cleanup-retry-attempt",
      status: "done"
    });
    let retryDoneStatusReads = 0;
    Object.defineProperty(retryDoneJob, "status", {
      configurable: true,
      enumerable: true,
      get() {
        retryDoneStatusReads += 1;
        return "done";
      }
    });
    jobsRef.current = [retryDoneJob];
    queue.localJobs = jobsRef.current;
    serverItems = [];
    failNextAction = true;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const cleanupFreezeStart = freezeCalls;
    const cleanupRunStart = actionRuns.length;
    const cleanupRefreshStart = refreshes;
    assert.deepEqual(
      workflow!.armCleanupAction("completed", 1),
      { count: 1 }
    );
    assert.equal(await workflow!.confirmCleanupAction("completed"), false);
    const retryDoneReadsAfterFirstRun = retryDoneStatusReads;
    assert.equal(
      refreshes,
      cleanupRefreshStart + 1,
      "失败确认只能由 action 所有者刷新一次 snapshot"
    );
    const retryCleanupLaterJob = ingestionJob({
      id: "cleanup-retry-later",
      attemptKey: "cleanup-retry-later-attempt",
      status: "done"
    });
    jobsRef.current = [retryCleanupLaterJob];
    queue.localJobs = jobsRef.current;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    workflow!.discardUnconfirmedIntents();
    assert.deepEqual(
      workflow!.armCleanupAction("completed", 2),
      { count: 1 },
      "结果未知后重开弹窗必须继续显示首次冻结数量"
    );
    assert.equal(
      await workflow!.confirmCleanupAction("completed"),
      true,
      "结果未知后即使关闭弹窗也必须能重试同一冻结意图"
    );
    assert.equal(
      retryDoneStatusReads,
      retryDoneReadsAfterFirstRun,
      "重试意图不得继续持有或重新读取已明确清除的本地任务"
    );
    assert.equal(refreshes, cleanupRefreshStart + 2);
    assert.equal(freezeCalls, cleanupFreezeStart + 1);
    assert.strictEqual(
      actionRuns[cleanupRunStart],
      actionRuns[cleanupRunStart + 1],
      "清理重试必须复用原 action ID、水位与冻结集合"
    );

    const partialResolvedPair = {
      session_id: "P".repeat(43),
      image_id: "019f8457-063a-7024-a580-7a432dc7fd8e"
    };
    const partialUnknownPair = {
      session_id: "Q".repeat(43),
      image_id: "019f8457-063a-7025-a580-7a432dc7fd8e"
    };
    const partialResolvedJob = ingestionJob({
      id: "cleanup-partial-resolved",
      attemptKey: "cleanup-partial-resolved-attempt",
      status: "queued",
      sessionId: partialResolvedPair.session_id,
      imageId: partialResolvedPair.image_id
    });
    const partialUnknownJob = ingestionJob({
      id: "cleanup-partial-unknown",
      attemptKey: "cleanup-partial-unknown-attempt",
      status: "queued",
      sessionId: partialUnknownPair.session_id,
      imageId: partialUnknownPair.image_id
    });
    let partialResolvedStatusReads = 0;
    Object.defineProperty(partialResolvedJob, "status", {
      configurable: true,
      enumerable: true,
      get() {
        partialResolvedStatusReads += 1;
        return "queued";
      }
    });
    jobsRef.current = [partialResolvedJob, partialUnknownJob];
    queue.localJobs = jobsRef.current;
    cancellationMode = "missing";
    serverItems = [{ ...partialResolvedPair, status: "changed" }];
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.deepEqual(
      workflow!.armCleanupAction("uncommitted", 2),
      { count: 2 }
    );
    assert.equal(
      await workflow!.confirmCleanupAction("uncommitted"),
      false,
      "部分对账仍未知时必须保留同一冻结动作"
    );
    assert.deepEqual(
      jobsRef.current.map((job) => job.id),
      [partialUnknownJob.id],
      "服务端已对账的本地卡片应在首次响应后立即释放"
    );
    const partialResolvedReadsAfterFirstRun = partialResolvedStatusReads;
    cancellationMode = "completed";
    serverItems = [{ ...partialUnknownPair, status: "changed" }];
    assert.deepEqual(
      workflow!.armCleanupAction("uncommitted", 99),
      { count: 2 },
      "部分重试仍须显示首次冻结数量"
    );
    assert.equal(
      await workflow!.confirmCleanupAction("uncommitted"),
      true,
      "后续响应应使用保留的 exact pair 收敛最后一项"
    );
    assert.equal(
      partialResolvedStatusReads,
      partialResolvedReadsAfterFirstRun,
      "部分重试不得继续持有或读取已对账任务"
    );
    assert.deepEqual(jobsRef.current, []);

    const retryClearJob = ingestionJob({
      id: "clear-retry-done",
      attemptKey: "clear-retry-attempt",
      status: "done"
    });
    let retryClearStatusReads = 0;
    Object.defineProperty(retryClearJob, "status", {
      configurable: true,
      enumerable: true,
      get() {
        retryClearStatusReads += 1;
        return "done";
      }
    });
    jobsRef.current = [retryClearJob];
    queue.localJobs = jobsRef.current;
    failNextAction = true;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const clearFreezeStart = freezeCalls;
    const clearRunStart = actionRuns.length;
    const clearRefreshStart = refreshes;
    assert.equal(workflow!.armClearQueue(), true);
    assert.equal(await workflow!.confirmClearQueue(), false);
    const retryClearReadsAfterFirstRun = retryClearStatusReads;
    assert.equal(refreshes, clearRefreshStart + 1);
    workflow!.discardUnconfirmedIntents();
    const retryClearLaterJob = ingestionJob({
      id: "clear-retry-later",
      attemptKey: "clear-retry-later-attempt",
      status: "done"
    });
    jobsRef.current = [retryClearLaterJob];
    queue.localJobs = jobsRef.current;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(
      workflow!.armClearQueue(),
      true,
      "真实 UI 解除武装后应在下一次第一击恢复原冻结意图"
    );
    assert.equal(
      await workflow!.confirmClearQueue(),
      true,
      "整队列清空失败后也必须保留原冻结意图供重试"
    );
    assert.equal(
      retryClearStatusReads,
      retryClearReadsAfterFirstRun,
      "整队列重试不得继续持有或重新读取已明确清除的本地任务"
    );
    assert.equal(refreshes, clearRefreshStart + 2);
    assert.equal(freezeCalls, clearFreezeStart + 1);
    assert.strictEqual(
      actionRuns[clearRunStart],
      actionRuns[clearRunStart + 1]
    );
    assert.deepEqual(
      jobsRef.current.map((job) => job.id),
      [retryClearLaterJob.id],
      "结果未知期间加入的任务不得进入恢复后的清空范围"
    );

    jobsRef.current = [placeholder];
    queue.localJobs = jobsRef.current;
    cancellationMode = "missing";
    Object.assign(queue.server, {
      summary: {
        total: 0,
        unfinished: 0,
        waiting: 0,
        running: 0,
        ready: 0,
        duplicate_pending: 0,
        committing: 0,
        resolving: 0,
        completed: 0,
        failed: 0
      }
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const localRetryFreezeStart = freezeCalls;
    const localRetryRunStart = actionRuns.length;
    const localRetryRefreshStart = refreshes;
    assert.equal(workflow!.armClearQueue(), true);
    assert.equal(await workflow!.confirmClearQueue(), false);
    const localRetryLater = ingestionJob({
      id: "local-clear-retry-later",
      attemptKey: "local-clear-retry-later-attempt",
      status: "done"
    });
    jobsRef.current = [...jobsRef.current, localRetryLater];
    queue.localJobs = jobsRef.current;
    cancellationMode = "discarded";
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(workflow!.armClearQueue(), true);
    assert.equal(await workflow!.confirmClearQueue(), true);
    assert.equal(
      freezeCalls,
      localRetryFreezeStart,
      "权威 Server 计数为零时不得为本地清空重试补冻空动作"
    );
    assert.equal(actionRuns.length, localRetryRunStart);
    assert.equal(refreshes, localRetryRefreshStart);
    assert.deepEqual(
      jobsRef.current.map((job) => job.id),
      [localRetryLater.id],
      "纯本地结果未知后的重试也必须复用原冻结集合"
    );
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

test("本地重试按 completed 与 discarded 结果保留或重建 attempt", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  let cancelRequests = 0;
  let uploadIntentRequests = 0;
  let releaseRequests = 0;
  let refreshRequests = 0;
  let boundDisplayPage: number | undefined;
  let uploadIntentBatchKey: string | undefined;
  let uploadIntentBatchTime: string | undefined;
  let cancelResponseStatus: "completed" | "discarded" = "completed";
  const fetchStub = async (input: unknown, init: RequestInit = {}) => {
    const path = new URL(
      typeof input === "string" ? input : (input as Request).url,
      "http://localhost"
    ).pathname;
    if (path === uploadIntentPath) {
      uploadIntentRequests += 1;
      const body = JSON.parse(String(init.body)) as {
        items: Array<{
          idempotency_key: string;
          batch_key: string;
          batch_time: string;
          batch_position: number;
        }>;
      };
      uploadIntentBatchKey = body.items[0]!.batch_key;
      uploadIntentBatchTime = body.items[0]!.batch_time;
      assert.match(
        body.items[0]!.batch_key,
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      );
      assert.equal(body.items[0]!.batch_position, 0);
      return new Response(JSON.stringify({
        ok: true,
        items: body.items.map(() => ({
          session_id: "N".repeat(43),
          image_id: "019f8457-063a-7026-a580-7a432dc7fd8e",
          resolved_image_time: "2026-08-23T01:02:03.456Z",
          request_hash: "a".repeat(64),
          status: "accepted",
          accepted_order: 1,
          version: 1,
          last_semantic_revision: 1
        }))
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (path !== ingestionCancelPath) throw new Error(`unexpected fetch ${path}`);
    cancelRequests += 1;
    const body = JSON.parse(String(init.body)) as {
      items: Array<{ session_id: string; image_id: string }>;
    };
    return new Response(JSON.stringify({
      ok: true,
      items: body.items.map((item) => ({
        ...item,
        status: cancelResponseStatus,
        ...(cancelResponseStatus === "completed" ? {
          completed_item: adminImageListItem({ id: item.image_id })
        } : {})
      }))
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
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
    fetch: fetchStub,
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
    setCsrfToken("local-retry-completed-token");
    const { createRoot } = await import("react-dom/client");
    const { useUpload } = await import(
      "../../packages/web/src/pages/admin/ingestion/upload/useUpload.ts"
    );
    const retryJob = ingestionJob({
      id: "local-retry-completed",
      attemptKey: "local-retry-completed-attempt",
      batchKey: webUuidV7(),
      batchPosition: 0,
      kind: "upload",
      file: new File(["completed"], "completed.webp", {
        type: "image/webp"
      }),
      sessionId: "L".repeat(43),
      imageId: "019f8457-063a-7025-a580-7a432dc7fd8e",
      serverAccepted: true,
      serverVersion: 1,
      status: "failed",
      failureStage: "prepare"
    });
    const jobsRef = { current: [retryJob] };
    const updateJob = (id: string, patch: Partial<IngestionJob>) => {
      jobsRef.current = jobsRef.current.map((job) => (
        job.id === id ? { ...job, ...patch } : job
      ));
    };
    const queue = {
      jobsRef,
      observeCompletedIngestions: () => undefined,
      appendJobs: (jobs: IngestionJob[]) => {
        jobsRef.current = [...jobsRef.current, ...jobs];
        return true;
      },
      updateJob,
      bindServerJob: (
        id: string,
        binding: Partial<IngestionJob> & { serverHandoffPending?: boolean }
      ) => {
        const current = jobsRef.current.find((job) => job.id === id);
        boundDisplayPage = binding.serverHandoffPending
          ? current?.serverHandoffDisplayPage ?? 1
          : undefined;
        updateJob(id, {
          ...binding,
          serverHandoffDisplayPage: boundDisplayPage,
          serverAccepted: true
        });
      },
      captureServerConnectionGeneration: () => 1,
      releaseResolvedServerJobs: (targets: readonly { id: string }[]) => {
        releaseRequests += 1;
        const released = new Set(targets.map((target) => target.id));
        jobsRef.current = jobsRef.current.filter((job) => !released.has(job.id));
        return released;
      },
      server: {
        recoverAuthority: async () => { refreshRequests += 1; },
        refresh: () => { refreshRequests += 1; }
      }
    };
    let owner: ReturnType<typeof useUpload> | undefined;
    function Probe() {
      owner = useUpload({
        queue: queue as never,
        defaults: {
          device: "pc",
          brightness: "dark",
          theme: "none",
          author: "",
          tags: []
        },
        storageSlug: "local",
        maxItems: 100,
        maxBytes: 1024 * 1024,
        maxLongEdge: 4096,
        browserConcurrency: 2
      });
      return null;
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await owner!.retry(retryJob);
    assert.equal(cancelRequests, 1);
    assert.equal(releaseRequests, 0);
    assert.equal(refreshRequests, 0);
    assert.equal(jobsRef.current.length, 1);
    assert.equal(jobsRef.current[0]?.attemptKey, retryJob.attemptKey);
    assert.equal(jobsRef.current[0]?.status, "finalized");

    cancelResponseStatus = "discarded";
    const releasedRetryBatchKey = webIngestionBatchKey();
    const releasedRetryJob = ingestionJob({
      ...retryJob,
      id: "local-retry-released",
      attemptKey: "local-retry-released-attempt",
      batchKey: releasedRetryBatchKey,
      batchTime: "2026-08-23T00:00:00.000Z",
      batchPosition: 37,
      sessionId: "M".repeat(43),
      imageId: "019f8457-063a-7027-a580-7a432dc7fd8e",
      serverHandoffPending: true,
      serverHandoffRevision: 8,
      serverHandoffDisplayPage: 3,
      serverHandoffProvisionalTotal: true,
      serverStatus: "failed",
      serverAttemptKey: "local-retry-released-attempt",
      serverSessionId: "M".repeat(43),
      serverImageId: "019f8457-063a-7027-a580-7a432dc7fd8e",
      status: "failed",
      failureStage: "prepare"
    });
    jobsRef.current = [releasedRetryJob];
    await owner!.retry(releasedRetryJob);
    assert.equal(cancelRequests, 2);
    assert.equal(uploadIntentRequests, 1);
    assert.equal(releaseRequests, 1);
    assert.equal(refreshRequests, 0);
    assert.notEqual(
      jobsRef.current[0]?.attemptKey,
      releasedRetryJob.attemptKey,
      "discarded old owner 后必须创建新 attempt"
    );
    assert.equal(
      uploadIntentBatchKey,
      releasedRetryJob.batchKey,
      "discarded old owner 的新 attempt 仍须保留原批次展示位置"
    );
    assert.equal(
      jobsRef.current[0]?.batchKey,
      uploadIntentBatchKey
    );
    assert.equal(uploadIntentBatchTime, releasedRetryJob.batchTime);
    assert.equal(jobsRef.current[0]?.batchTime, uploadIntentBatchTime);
    assert.equal(jobsRef.current[0]?.batchPosition, 37);
    assert.equal(
      boundDisplayPage,
      undefined,
      "保留原批次位置的重试无需创建额外 handoff 页锚点"
    );
    assert.equal(jobsRef.current[0]?.serverHandoffDisplayPage, undefined);
    assert.equal(jobsRef.current[0]?.serverHandoffProvisionalTotal, undefined);
    assert.equal(jobsRef.current[0]?.serverStatus, undefined);
    assert.equal(jobsRef.current[0]?.serverAttemptKey, undefined);
    assert.equal(jobsRef.current[0]?.serverSessionId, undefined);
    assert.equal(jobsRef.current[0]?.serverImageId, undefined);
    if (jobsRef.current[0]?.objectUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(jobsRef.current[0]!.objectUrl!);
    }
    await React.act(async () => root.unmount());
  } finally {
    clearCsrfToken();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

test("Import 批次清空只等待一次 accept 并聚合 50+ 取消", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  let releaseAccept: ((response: Response) => void) | undefined;
  let acceptRequests = 0;
  let statusRequests = 0;
  let cancelResponseStatus: "discarded" | "completed" = "discarded";
  const cancelBodies: Array<{ items: unknown[] }> = [];
  const fetchStub = async (input: unknown, init: RequestInit = {}) => {
    const path = new URL(
      typeof input === "string" ? input : (input as Request).url,
      "http://localhost"
    ).pathname;
    if (path === importAcceptPath) {
      acceptRequests += 1;
      const body = JSON.parse(String(init.body)) as {
        items: Array<{ batch_key: string; batch_position: number }>;
      };
      assert.equal(new Set(body.items.map((item) => item.batch_key)).size, 1);
      assert.deepEqual(
        body.items.map((item) => item.batch_position),
        Array.from({ length: 60 }, (_, index) => index)
      );
      return new Promise<Response>((resolve) => {
        releaseAccept = resolve;
      });
    }
    if (path === ingestionStatusPath) {
      statusRequests += 1;
      throw new Error("known accepted versions must not need status reads");
    }
    if (path === ingestionCancelPath) {
      const body = JSON.parse(String(init.body)) as {
        items: Array<{ session_id: string; image_id: string }>;
      };
      cancelBodies.push(body);
      return new Response(JSON.stringify({
        ok: true,
        items: body.items.map((item) => ({
          ...item,
          status: cancelResponseStatus,
          ...(cancelResponseStatus === "completed" ? {
            completed_item: adminImageListItem({ id: item.image_id })
          } : {})
        }))
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`unexpected fetch ${path}`);
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
    fetch: fetchStub,
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
    setCsrfToken("import-batch-cancel-token");
    const { createRoot } = await import("react-dom/client");
    const { useImport } = await import(
      "../../packages/web/src/pages/admin/ingestion/import/useImport.ts"
    );
    const jobsRef = { current: [] as IngestionJob[] };
    const updateJob = (id: string, patch: Partial<IngestionJob>) => {
      jobsRef.current = jobsRef.current.map((job) => (
        job.id === id ? { ...job, ...patch } : job
      ));
    };
    const queue = {
      jobsRef,
      observeCompletedIngestions: () => undefined,
      appendJobs: (jobs: IngestionJob[]) => {
        jobsRef.current = [...jobsRef.current, ...jobs];
        return true;
      },
      updateJob,
      bindServerJob: (
        id: string,
        binding: Partial<IngestionJob> & {
          sessionId: string;
          imageId: string;
        }
      ) => {
        updateJob(id, binding);
        // Simulate the combined-page owner immediately detaching an off-page
        // accepted pair while the frozen clear intent is still waiting.
        jobsRef.current = jobsRef.current.filter((job) => job.id !== id);
      },
      captureServerConnectionGeneration: () => 1
    };
    let owner: ReturnType<typeof useImport> | undefined;
    function Probe() {
      owner = useImport({
        queue: queue as never,
        defaults: {
          device: "pc",
          brightness: "dark",
          theme: "none",
          author: "",
          tags: []
        },
        keepOriginalLinkForUrlImports: true,
        storageSlug: "local"
      });
      return null;
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const importBatchKey = webUuidV7();
    const jobs = Array.from({ length: 60 }, (_, index) => ingestionJob({
      id: `import-batch-${index}`,
      attemptKey: webUuidV7(),
      batchKey: importBatchKey,
      batchPosition: index,
      downloadUrl: `https://example.com/image-${index}.jpg`,
      draft: {
        ...ingestionJob().draft,
        original: `https://example.com/image-${index}.jpg`
      }
    }));
    await owner!.addParsedImports(jobs);
    assert.equal(acceptRequests, 1);
    assert.ok(releaseAccept);
    const cancellation = owner!.cancelMany([...jobsRef.current]);
    await Promise.resolve();
    assert.equal(
      jobsRef.current.filter((job) => job.status === "cancelling").length,
      60
    );
    releaseAccept!(new Response(JSON.stringify({
      ok: true,
      items: jobs.map((job, index) => ({
        session_id: String(index).padStart(43, "S"),
        image_id: `019f8457-063a-7${String(index).padStart(3, "0")}-a580-7a432dc7fd8e`,
        resolved_image_time: "2026-08-23T01:02:03.456Z",
        request_hash: job.attemptKey,
        status: "accepted",
        accepted_order: index + 1,
        version: 1,
        last_semantic_revision: index + 1
      }))
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const outcomes = await cancellation;
    assert.equal(statusRequests, 0);
    assert.equal(cancelBodies.length, 1);
    assert.equal(cancelBodies[0]?.items.length, 60);
    assert.equal(
      [...outcomes.values()].filter((outcome) => outcome.succeeded).length,
      60
    );
    cancelResponseStatus = "completed";
    const retryJob = ingestionJob({
      id: "import-retry-completed",
      attemptKey: "import-retry-completed-attempt",
      kind: "import",
      downloadUrl: "https://example.com/completed.jpg",
      sessionId: "R".repeat(43),
      imageId: "019f8457-063a-7024-a580-7a432dc7fd8e",
      serverAccepted: true,
      serverVersion: 1,
      status: "failed",
      failureStage: "prepare"
    });
    jobsRef.current = [retryJob];
    await owner!.retry(retryJob);
    assert.equal(
      acceptRequests,
      1,
      "取消返回 completed 时 retry 不得生成新 attempt 或重新 accept"
    );
    assert.equal(jobsRef.current[0]?.attemptKey, retryJob.attemptKey);
    assert.equal(jobsRef.current[0]?.status, "finalized");
    await React.act(async () => root.unmount());
  } finally {
    clearCsrfToken();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

test("Upload 与 Import 接管只使用固定短路由和 1 + N 请求预算", async () => {
  const originalFetch = globalThis.fetch;
  const originalXhr = globalThis.XMLHttpRequest;
  const fetchCalls: Array<{ path: string; init: RequestInit }> = [];
  const sessionIds = ["A".repeat(43), "B".repeat(43)];
  const imageIds = [
    "019f8457-063a-7001-a580-7a432dc7fd8e",
    "019f8457-063a-7002-a580-7a432dc7fd8e"
  ];
  const metadata = {
    device: "auto" as const,
    brightness: "auto" as const,
    theme: "none",
    author: "",
    title: "最大字段由 JSON 承载",
    description: "description",
    source: "",
    original: "",
    tags: Array.from({ length: 50 }, (_, index) => `tag-${index}`)
  };

  class FakeXmlHttpRequest {
    static instances: FakeXmlHttpRequest[] = [];
    upload: { onprogress?: (event: ProgressEvent) => void } = {};
    headers = new Map<string, string>();
    method = "";
    url = "";
    status = 0;
    responseText = "";
    body: unknown;
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;

    constructor() {
      FakeXmlHttpRequest.instances.push(this);
    }

    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }

    setRequestHeader(name: string, value: string) {
      this.headers.set(name.toLowerCase(), value);
    }

    send(body: unknown) {
      this.body = body;
      const index = FakeXmlHttpRequest.instances.indexOf(this);
      this.status = 200;
      this.responseText = JSON.stringify({
        ok: true,
        session_id: sessionIds[index],
        image_id: imageIds[index],
        status: "accepted",
        version: 1
      });
      queueMicrotask(() => {
        this.upload.onprogress?.({
          lengthComputable: true,
          loaded: 1,
          total: 1
        } as ProgressEvent);
        this.onload?.();
      });
    }

    abort() {
      this.onabort?.();
    }
  }

  globalThis.fetch = (async (input, init = {}) => {
    const path = String(input);
    fetchCalls.push({ path, init });
    if (path === uploadIntentPath) {
      const items = JSON.parse(String(init.body)).items as unknown[];
      return new Response(JSON.stringify({
        ok: true,
        items: items.map((_, index) => ({
          session_id: sessionIds[index],
          candidate_image_id: imageIds[index],
          resolved_image_time: "2026-08-23T01:02:03.456Z",
          request_hash: String(index + 1).repeat(64),
          credential: `credential-${index}`,
          expires_at: 1,
          status: "intent"
        }))
      }), { status: 200 });
    }
    if (path === importAcceptPath) {
      const items = JSON.parse(String(init.body)).items as unknown[];
      return new Response(JSON.stringify({
        ok: true,
        items: items.map((_, index) => ({
          session_id: sessionIds[index],
          image_id: imageIds[index],
          resolved_image_time: "2026-08-23T01:02:03.456Z",
          request_hash: String(index + 3).repeat(64),
          status: "accepted"
        }))
      }), { status: 200 });
    }
    if (path === ingestionStatusPath) {
      const items = JSON.parse(String(init.body)).items as Array<{
        session_id: string;
        image_id: string;
      }>;
      return new Response(JSON.stringify({
        ok: true,
        items: items.map((item) => ({ ...item, status: "missing" }))
      }), { status: 200 });
    }
    if (path.startsWith(`${ingestionSnapshotPath}?`)) {
      const request = new URL(path, "https://imageshow.test");
      return new Response(JSON.stringify({
        ok: true,
        queue: request.searchParams.get("queue"),
        revision: 0,
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
        offset: Number(request.searchParams.get("offset")),
        limit: Number(request.searchParams.get("limit")),
        items: [],
        action_watermark: "watermark"
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${path}`);
  }) as typeof fetch;
  globalThis.XMLHttpRequest = FakeXmlHttpRequest as unknown as typeof XMLHttpRequest;
  setCsrfToken("csrf-current-import");
  try {
    const intentItems = imageIds.map((id, index) => ({
      ...metadata,
      idempotency_key: id,
      batch_time: "2026-08-23T01:02:03.456Z",
      batch_position: index,
      storage_slug: "local",
      expected_size: 1,
      max_long_edge: 4096
    }));
    const intents = await createUploadIntents({ items: intentItems });
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]?.path, uploadIntentPath);
    assert.equal(new URL(fetchCalls[0]!.path, "https://imageshow.test").search, "");
    assert.equal((JSON.parse(String(fetchCalls[0]?.init.body)).items as unknown[]).length, 2);
    assert.equal(
      new Headers(fetchCalls[0]?.init.headers).get("x-csrf-token"),
      "csrf-current-import"
    );

    const files = [
      new File(["a"], "a.webp", { type: "image/webp" }),
      new File(["b"], "b.webp", { type: "image/webp" })
    ];
    await Promise.all(intents.items.map((item, index) => {
      assert.equal(item.status, "intent");
      if (item.status !== "intent") throw new Error("intent expected");
      return uploadRaw(item.credential, files[index]!, {
        onProgress: () => undefined
      }).promise;
    }));
    assert.equal(FakeXmlHttpRequest.instances.length, 2);
    assert.ok(FakeXmlHttpRequest.instances.every((request) => (
      request.method === "PUT"
      && request.url === uploadRawPath
      && new URL(request.url, "https://imageshow.test").search === ""
      && request.headers.has(uploadCredentialHeader)
      && request.body instanceof File
    )));

    await acceptImports({
      items: imageIds.map((id, index) => ({
        ...metadata,
        idempotency_key: id,
        source_type: "url",
        download_url: `https://example.com/${index}.webp`,
        batch_position: index,
        storage_slug: "local"
      }))
    });
    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[1]?.path, importAcceptPath);
    assert.equal(
      (JSON.parse(String(fetchCalls[1]?.init.body)).items as unknown[]).length,
      2
    );
    await getIngestionStatuses(sessionIds.map((sessionId, index) => ({
      session_id: sessionId,
      image_id: imageIds[index]!
    })));
    assert.equal(fetchCalls[2]?.path, ingestionStatusPath);
    await getIngestionQueueSnapshot({
      queue: "upload",
      offset: 20,
      limit: 10,
      exclude_items: [{
        session_id: sessionIds[0]!,
        image_id: imageIds[0]!
      }],
      include_items: [{
        session_id: sessionIds[0]!,
        image_id: imageIds[0]!
      }]
    }, "A".repeat(32));
    const snapshotCall = fetchCalls[3]!;
    const snapshotUrl = new URL(snapshotCall.path, "https://imageshow.test");
    assert.equal(snapshotUrl.pathname, ingestionSnapshotPath);
    assert.equal(snapshotCall.init.method, "POST");
    assert.deepEqual(Object.fromEntries(snapshotUrl.searchParams), {
      queue: "upload",
      offset: "20",
      limit: "10"
    });
    assert.deepEqual(JSON.parse(String(snapshotCall.init.body)), {
      exclude_items: [{
        session_id: sessionIds[0],
        image_id: imageIds[0]
      }],
      include_items: [{
        session_id: sessionIds[0],
        image_id: imageIds[0]
      }]
    });
    assert.equal(
      new Headers(snapshotCall.init.headers).get(ingestionActionScopeHeader),
      "A".repeat(32)
    );
  } finally {
    clearCsrfToken();
    globalThis.fetch = originalFetch;
    globalThis.XMLHttpRequest = originalXhr;
  }
});

test("队列事件只合并连续 semantic 与同版本递增 progress", () => {
  const summary = {
    total: 1,
    unfinished: 1,
    waiting: 0,
    running: 1,
    ready: 0,
    duplicate_pending: 0,
    committing: 0,
    resolving: 0,
    completed: 0,
    failed: 0
  };
  const active = {
    session_id: "S".repeat(43),
    image_id: "019f8457-063a-7005-a580-7a432dc7fd8e",
    queue: "upload" as const,
    source_type: "upload" as const,
    resolved_image_time: "2026-08-23T01:02:03.456Z",
    status: "preparing" as const,
    phase: "prepare",
    message: "processing",
    progress: 20,
    version: 2,
    progress_seq: 2,
    last_semantic_revision: 5,
    accepted_at: 1,
    accepted_order: 1,
    metadata: {
      device: "auto" as const,
      brightness: "auto" as const,
      theme: "none",
      author: "",
      title: "event item",
      description: "",
      source: "",
      original: "",
      tags: []
    },
    storage_slug: "local"
  };
  let baseline = baselineFromIngestionSnapshot({
    ...summary,
    queue: "upload",
    revision: 5,
    last_accepted_order: 1,
    offset: 0,
    limit: 20,
    items: [active],
    action_watermark: "watermark-5"
  });
  const emptySelection = {
    offset: 0,
    limit: 20,
    requiredItems: 20,
    excludeItems: [],
    includeItems: []
  };
  const selectedPair = {
    session_id: active.session_id,
    image_id: active.image_id
  };
  const selectedCurrentItem = {
    ...emptySelection,
    excludeItems: [selectedPair],
    includeItems: [selectedPair]
  };
  assert.equal(
    ingestionQueueBaselineCoversSelection(
      baseline,
      emptySelection,
      selectedCurrentItem
    ),
    true,
    "已读到队尾且新筛选任务已在基线中时不得重复 snapshot"
  );
  assert.equal(
    ingestionQueueBaselineCoversSelection(
      {
        ...baseline,
        summary: { ...baseline.summary, total: 60 }
      },
      emptySelection,
      selectedCurrentItem
    ),
    false,
    "满队列中筛掉当前行后可能需要补位，不能错误复用短基线"
  );
  const reservoirItems = Array.from({ length: 20 }, (_, index) => ({
    ...active,
    session_id: index === 0
      ? active.session_id
      : String(index).padStart(43, "R"),
    image_id: index === 0
      ? active.image_id
      : `019f8457-063a-72${String(index).padStart(2, "0")}-a580-7a432dc7fd8e`,
    accepted_order: index + 1
  }));
  const reservoirBaseline = {
    ...baseline,
    summary: { ...baseline.summary, total: 60 },
    items: reservoirItems
  };
  assert.equal(
    ingestionQueueBaselineCoversSelection(
      reservoirBaseline,
      emptySelection,
      {
        ...selectedCurrentItem,
        requiredItems: 19
      }
    ),
    true,
    "筛选变化后替补仍覆盖实际展示槽位时不得为补满缓存重复读取"
  );
  assert.equal(
    ingestionQueueBaselineCoversSelection(
      reservoirBaseline,
      emptySelection,
      selectedCurrentItem
    ),
    false,
    "实际展示需要完整 20 行时不能把 19 行替补误判为覆盖"
  );
  assert.equal(
    ingestionQueueBaselineCoversSelection(
      baseline,
      selectedCurrentItem,
      emptySelection
    ),
    false,
    "移除筛选会改变 Server 页面成员，必须重新读取"
  );
  const skippedProgress = mergeIngestionQueueMutation(baseline, {
    type: "mutation",
    queue: "upload",
    kind: "progress",
    revision: 5,
    last_accepted_order: 1,
    summary,
    session: { ...active, progress: 90, progress_seq: 9 }
  });
  assert.equal(skippedProgress.kind, "accepted");
  assert.equal(skippedProgress.baseline.items[0]?.progress_seq, 9);
  baseline = skippedProgress.baseline;

  const delayedProgress = mergeIngestionQueueMutation(baseline, {
    type: "mutation",
    queue: "upload",
    kind: "progress",
    revision: 5,
    last_accepted_order: 1,
    summary,
    session: { ...active, version: 1, progress_seq: 99 }
  });
  assert.equal(delayedProgress.kind, "ignored");

  const semantic = mergeIngestionQueueMutation(baseline, {
    type: "mutation",
    queue: "upload",
    kind: "semantic",
    revision: 6,
    last_accepted_order: 1,
    summary: { ...summary, running: 0, ready: 1 },
    action_watermark: "watermark-6",
    session: {
      ...active,
      status: "ready",
      phase: "ready",
      message: "ready",
      progress: 100,
      version: 3,
      progress_seq: 0,
      last_semantic_revision: 6
    }
  });
  assert.equal(semantic.kind, "accepted");
  assert.equal(semantic.baseline.revision, 6);
  assert.equal(semantic.baseline.items[0]?.version, 3);
  assert.equal(semantic.baseline.actionWatermark, "watermark-6");

  const semanticGap = mergeIngestionQueueMutation(semantic.baseline, {
    type: "mutation",
    queue: "upload",
    kind: "semantic",
    revision: 8,
    last_accepted_order: 1,
    summary,
    session: { ...active, version: 4, last_semantic_revision: 8 }
  });
  assert.equal(semanticGap.kind, "reload");

  const completed = mergeIngestionQueueMutation(semantic.baseline, {
    type: "mutation",
    queue: "upload",
    kind: "semantic",
    revision: 7,
    last_accepted_order: 1,
    summary: { ...summary, unfinished: 0, running: 0, completed: 1 },
    action_watermark: "watermark-7",
    session: {
      session_id: active.session_id,
      image_id: active.image_id,
      status: "completed",
      version: 4,
      progress_seq: 0,
      last_semantic_revision: 7,
      accepted_at: 1,
      accepted_order: 1
    }
  });
  assert.equal(
    completed.kind,
    "accepted",
    "compact completed 应推进全局 metadata，并由精确 status owner 补齐 DTO"
  );
  assert.equal(completed.baseline.revision, 7);
  assert.equal(completed.baseline.summary.completed, 1);
  assert.equal(
    completed.baseline.items[0]?.status,
    "ready",
    "bounded page 不得用 compact 回执伪造完整 completed DTO"
  );
  const completedItem = adminImageListItem({ id: active.image_id });
  const hydratedCompleted = mergeIngestionQueueMutation(semantic.baseline, {
    type: "mutation",
    queue: "upload",
    kind: "semantic",
    revision: 7,
    last_accepted_order: 1,
    summary: { ...summary, unfinished: 0, running: 0, completed: 1 },
    action_watermark: "watermark-7",
    session: {
      session_id: active.session_id,
      image_id: active.image_id,
      queue: "upload",
      status: "completed",
      version: 4,
      progress_seq: 0,
      last_semantic_revision: 7,
      accepted_at: 1,
      accepted_order: 1,
      completed_at: 2,
      completed_item: completedItem
    }
  });
  assert.equal(
    hydratedCompleted.kind,
    "accepted",
    "携带 PostgreSQL 完成投影的 SSE 不得再请求同页 snapshot"
  );
  assert.equal(hydratedCompleted.baseline.items[0]?.status, "completed");
  assert.equal(
    hydratedCompleted.baseline.items[0]?.completed_item.id,
    completedItem.id
  );
});

test("队列 progress 以当前 revision 同步页内与离页汇总且不回退", () => {
  const waitingSummary = {
    total: 1,
    unfinished: 1,
    waiting: 1,
    running: 0,
    ready: 0,
    duplicate_pending: 0,
    committing: 0,
    resolving: 0,
    completed: 0,
    failed: 0
  };
  const runningSummary = {
    ...waitingSummary,
    waiting: 0,
    running: 1
  };
  const waiting = {
    session_id: "W".repeat(43),
    image_id: "019f8457-063a-7005-a580-7a432dc7fd8e",
    queue: "upload" as const,
    source_type: "upload" as const,
    resolved_image_time: "2026-08-23T01:02:03.456Z",
    status: "preparing" as const,
    phase: "prepare-waiting",
    message: "waiting",
    progress: 0,
    version: 2,
    progress_seq: 0,
    last_semantic_revision: 5,
    accepted_at: 1,
    accepted_order: 1,
    metadata: {
      device: "auto" as const,
      brightness: "auto" as const,
      theme: "none",
      author: "",
      title: "waiting item",
      description: "",
      source: "",
      original: "",
      tags: []
    },
    storage_slug: "local"
  };
  const normalizing = {
    ...waiting,
    phase: "normalizing",
    message: "processing",
    progress: 1,
    progress_seq: 1
  };
  const progressEvent = {
    type: "mutation" as const,
    queue: "upload" as const,
    kind: "progress" as const,
    revision: 5,
    last_accepted_order: 1,
    summary: runningSummary,
    session: normalizing
  };
  const pageBaseline = baselineFromIngestionSnapshot({
    ...waitingSummary,
    queue: "upload",
    revision: 5,
    last_accepted_order: 1,
    offset: 0,
    limit: 20,
    items: [waiting],
    action_watermark: "watermark-5"
  });
  const pageResult = mergeIngestionQueueMutation(pageBaseline, progressEvent);
  assert.equal(pageResult.kind, "accepted");
  assert.equal(pageResult.baseline.items[0]?.phase, "normalizing");
  assert.deepEqual(pageResult.baseline.summary, runningSummary);

  const offPageBaseline = {
    ...pageBaseline,
    items: []
  };
  const offPageResult = mergeIngestionQueueMutation(
    offPageBaseline,
    progressEvent
  );
  assert.equal(offPageResult.kind, "accepted");
  assert.deepEqual(offPageResult.baseline.summary, runningSummary);
  assert.deepEqual(offPageResult.baseline.items, []);

  const delayedRevision = mergeIngestionQueueMutation(
    {
      ...offPageBaseline,
      revision: 6,
      summary: runningSummary
    },
    {
      ...progressEvent,
      revision: 5,
      summary: waitingSummary
    }
  );
  assert.equal(delayedRevision.kind, "ignored");
  assert.deepEqual(delayedRevision.baseline.summary, runningSummary);

  const delayedSameRevisionOffPage = mergeIngestionQueueMutation(
    {
      ...offPageBaseline,
      summary: {
        ...runningSummary,
        total: 2,
        unfinished: 2,
        running: 2
      }
    },
    {
      ...progressEvent,
      summary: {
        ...runningSummary,
        total: 2,
        unfinished: 2,
        waiting: 1,
        running: 1
      }
    }
  );
  assert.equal(delayedSameRevisionOffPage.kind, "ignored");
  assert.equal(delayedSameRevisionOffPage.baseline.summary.waiting, 0);
  assert.equal(delayedSameRevisionOffPage.baseline.summary.running, 2);

  const delayedProgress = mergeIngestionQueueMutation(
    pageResult.baseline,
    {
      ...progressEvent,
      summary: waitingSummary,
      session: waiting
    }
  );
  assert.equal(delayedProgress.kind, "ignored");
  assert.deepEqual(delayedProgress.baseline.summary, runningSummary);
});

test("异步提交仅发送冻结意图并由 pair 状态完成水合", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const sessionIds = ["A".repeat(43), "B".repeat(43)];
  const imageIds = [
    "019f8457-063a-7005-a580-7a432dc7fd8e",
    "019f8457-063a-7006-a580-7a432dc7fd8e"
  ];
  const attemptIds = [
    "019f8457-063a-7007-a580-7a432dc7fd8e",
    "019f8457-063a-7008-a580-7a432dc7fd8e"
  ];
  const commitRequestIds = [
    "019f8457-063a-7009-a580-7a432dc7fd8e",
    "019f8457-063a-700a-a580-7a432dc7fd8e"
  ];
  const jobs = imageIds.map((imageId, index) => {
    const ready = ingestionJob({
      id: `commit-${index}`,
      attemptKey: attemptIds[index],
      sessionId: sessionIds[index],
      imageId,
      status: "ready",
      serverVersion: 4,
      duplicateDecision: "upload"
    });
    return {
      ...ready,
      commitIntent: createIngestionCommitIntent(
        ready,
        commitRequestIds[index]
      )
    };
  });
  const current = new Map(jobs.map((job) => [job.id, job]));
  const completedCommitItem = adminImageListItem({ id: imageIds[1] });
  const observedCompleted: string[] = [];
  globalThis.fetch = (async (input, init = {}) => {
    const path = String(input);
    calls.push({ path, init });
    if (path !== ingestionCommitPath) throw new Error(`unexpected fetch ${path}`);
    return new Response(JSON.stringify({
      ok: true,
      items: jobs.map((job, index) => ({
        session_id: job.sessionId,
        image_id: job.imageId,
        status: index === 0 ? "accepted" : "completed",
        version: 5,
        ...(index === 0 ? {} : { completed_item: completedCommitItem })
      }))
    }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await commitSelectedIngestions({
      selected: jobs,
      getJob: (id) => current.get(id),
      observeCompletedIngestions: (entries) => {
        observedCompleted.push(...entries.map(({ pair }) => pair.image_id));
      },
      updateJob: (id, patch) => {
        const job = current.get(id);
        if (job) current.set(id, { ...job, ...patch });
      }
    }), 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.path, ingestionCommitPath);
    const body = JSON.parse(String(calls[0]?.init.body));
    assert.equal(body.items.length, 2);
    assert.equal("created_by" in body.items[0], false);
    assert.deepEqual(
      body.items.map((item: Record<string, unknown>) => [
        item.session_id,
        item.image_id,
        item.expected_version,
        item.expected_md5,
        item.commit_request_id
      ]),
      jobs.map((job) => [
        job.sessionId,
        job.imageId,
        4,
        job.commitIntent.md5,
        job.commitIntent.attemptId
      ])
    );
    assert.equal(current.get(jobs[0]!.id)?.status, "committing");
    assert.equal(current.get(jobs[1]!.id)?.status, "finalized");
    assert.deepEqual(
      observedCompleted,
      [imageIds[1]],
      "同步 completed 提交响应必须先进入 owner 失效入口"
    );

    const first = current.get(jobs[0]!.id)!;
    const completedItem = adminImageListItem({ id: imageIds[0] });
    const hydrated = ingestionStatusEventPatch(first, {
      session_id: sessionIds[0]!,
      image_id: imageIds[0]!,
      status: "completed",
      completed_item: completedItem
    });
    assert.equal(hydrated?.status, "done");
    assert.equal(hydrated?.resultState, "hydrated");
    assert.equal(hydrated?.md5, completedItem.md5);
    assert.equal(hydrated?.width, completedItem.width);
    assert.equal(hydrated?.height, completedItem.height);
    assert.equal(hydrated?.finalSize, completedItem.image_size);

    const lostResponseReady = ingestionJob({
      id: "commit-response-lost",
      attemptKey: "019f8457-063a-7014-a580-7a432dc7fd8e",
      sessionId: "R".repeat(43),
      imageId: "019f8457-063a-7015-a580-7a432dc7fd8e",
      status: "ready",
      serverVersion: 7,
      duplicateDecision: "upload"
    });
    const lostResponseJob = {
      ...lostResponseReady,
      commitIntent: createIngestionCommitIntent(
        lostResponseReady,
        "019f8457-063a-7016-a580-7a432dc7fd8e"
      )
    };
    const lostResponseCurrent = new Map([
      [lostResponseJob.id, lostResponseJob]
    ]);
    const lostResponseCompleted = adminImageListItem({
      id: lostResponseJob.imageId
    });
    const reconciledCompleted: string[] = [];
    globalThis.fetch = (async (input) => {
      if (String(input) === ingestionCommitPath) {
        return new Response("commit response lost", { status: 502 });
      }
      assert.equal(String(input), ingestionStatusPath);
      return new Response(JSON.stringify({
        ok: true,
        items: [{
          session_id: lostResponseJob.sessionId,
          image_id: lostResponseJob.imageId,
          status: "completed",
          completed_item: lostResponseCompleted,
          redis_status: "missing"
        }]
      }), { status: 200 });
    }) as typeof fetch;
    assert.equal(await commitSelectedIngestions({
      selected: [lostResponseJob],
      getJob: (id) => lostResponseCurrent.get(id),
      observeCompletedIngestions: (entries) => {
        reconciledCompleted.push(...entries.map(({ pair }) => pair.image_id));
      },
      updateJob: (id, patch) => {
        const job = lostResponseCurrent.get(id);
        if (job) lostResponseCurrent.set(id, { ...job, ...patch });
      }
    }), 0);
    assert.equal(lostResponseCurrent.get(lostResponseJob.id)?.status, "done");
    assert.deepEqual(
      reconciledCompleted,
      [lostResponseJob.imageId],
      "提交响应丢失后的 status 完成态必须进入 owner 失效入口"
    );

    const duplicateReady = ingestionJob({
      id: "commit-duplicate",
      attemptKey: "019f8457-063a-700b-a580-7a432dc7fd8e",
      sessionId: "C".repeat(43),
      imageId: "019f8457-063a-700c-a580-7a432dc7fd8e",
      status: "ready",
      serverVersion: 5,
      duplicateDecision: "upload"
    });
    const duplicateJob = {
      ...duplicateReady,
      commitIntent: createIngestionCommitIntent(
        duplicateReady,
        "019f8457-063a-700d-a580-7a432dc7fd8e"
      )
    };
    const duplicateCurrent = new Map([[duplicateJob.id, duplicateJob]]);
    const duplicateItem = adminImageListItem({
      id: "019f8457-063a-700e-a580-7a432dc7fd8e"
    });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      ok: true,
      items: [{
        session_id: duplicateJob.sessionId,
        image_id: duplicateJob.imageId,
        status: "failed",
        code: "ingestion_duplicate_conflict",
        message: "提交前发现相同内容图片",
        version: 6,
        duplicate_count: 23,
        duplicates: [duplicateItem]
      }]
    }), { status: 200 })) as typeof fetch;
    assert.equal(await commitSelectedIngestions({
      selected: [duplicateJob],
      getJob: (id) => duplicateCurrent.get(id),
      observeCompletedIngestions: () => undefined,
      updateJob: (id, patch) => {
        const job = duplicateCurrent.get(id);
        if (job) duplicateCurrent.set(id, { ...job, ...patch });
      }
    }), 0);
    const duplicateConflict = duplicateCurrent.get(duplicateJob.id)!;
    assert.equal(duplicateConflict.status, "ready");
    assert.equal(duplicateConflict.serverVersion, 6);
    assert.equal(duplicateConflict.duplicateCount, 23);
    assert.equal(duplicateConflict.duplicateDecision, "undecided");
    assert.deepEqual(duplicateConflict.duplicates, [duplicateItem]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("内容接入写后缓存每批只失效受新增图片影响的查询", async () => {
  const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
  const allKeys = [
    queryKeys.publicImages,
    queryKeys.publicImageDetail,
    queryKeys.galleryFacets,
    queryKeys.galleryStats,
    queryKeys.adminImages,
    queryKeys.adminImageInfo,
    queryKeys.overview,
    queryKeys.themes,
    queryKeys.tags,
    queryKeys.authors,
    queryKeys.ingestionVocabulary
  ] as const;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  for (const key of allKeys) client.setQueryData([...key, "fixture"], {});
  const vocabulary: IngestionVocabularyDto = {
    themes: [{ slug: "none", display_name: "未分类" }],
    tags: [{ slug: "existing-tag", display_name: "既有标签" }],
    authors: [{ slug: "existing-author", display_name: "既有作者" }]
  };
  client.setQueryData(queryKeys.ingestionVocabulary, vocabulary);

  await invalidateImageDataAfterIngestion(client, [adminImageListItem()]);
  const invalidated = (
    queryClient: InstanceType<typeof QueryClient>,
    key: readonly unknown[]
  ) => (
    queryClient.getQueryState(key)?.isInvalidated === true
  );
  for (const key of [
    queryKeys.publicImages,
    queryKeys.galleryFacets,
    queryKeys.galleryStats,
    queryKeys.adminImages,
    queryKeys.overview,
    queryKeys.themes
  ]) {
    assert.equal(invalidated(client, [...key, "fixture"]), true, key[0]);
  }
  for (const key of [
    queryKeys.publicImageDetail,
    queryKeys.adminImageInfo,
    queryKeys.tags,
    queryKeys.authors
  ]) {
    assert.equal(invalidated(client, [...key, "fixture"]), false, key[0]);
  }
  assert.equal(invalidated(client, queryKeys.ingestionVocabulary), false);

  const changedClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  for (const key of [
    queryKeys.tags,
    queryKeys.authors,
    queryKeys.ingestionVocabulary
  ]) changedClient.setQueryData(key, key === queryKeys.ingestionVocabulary ? vocabulary : {});
  await invalidateImageDataAfterIngestion(changedClient, [adminImageListItem({
    theme: "new-theme",
    author: "new-author",
    tags: ["new-tag"]
  })]);
  assert.equal(changedClient.getQueryState(queryKeys.tags)?.isInvalidated, true);
  assert.equal(changedClient.getQueryState(queryKeys.authors)?.isInvalidated, true);
  assert.equal(
    changedClient.getQueryState(queryKeys.ingestionVocabulary)?.isInvalidated,
    true
  );
  const coveredClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  const coveredKey = [...queryKeys.adminImages, "covered-page"] as const;
  const coveredData = { items: [], total: 0, etag: 'W/"covered"' };
  coveredClient.setQueryData(coveredKey, coveredData);
  recordAdminImageListValidation(coveredClient, coveredKey, 200);
  let coveredReads = 0;
  const coveredObserver = new QueryObserver(coveredClient, {
    queryKey: coveredKey,
    queryFn: async () => {
      coveredReads += 1;
      recordAdminImageListValidation(coveredClient, coveredKey, Date.now());
      return coveredData;
    },
    staleTime: Infinity
  });
  const unsubscribeCovered = coveredObserver.subscribe(() => undefined);
  await invalidateImageDataAfterIngestion(
    coveredClient,
    [adminImageListItem()],
    { completedAt: 100 }
  );
  assert.equal(coveredReads, 0, "已覆盖完成水位的列表不得条件重读");
  recordAdminImageListValidation(coveredClient, coveredKey, 300);
  await invalidateImageDataAfterIngestion(
    coveredClient,
    [adminImageListItem()],
    { completedAt: 300 }
  );
  assert.equal(
    coveredReads,
    1,
    "列表读取与完成事件处于同一毫秒时仍必须恰好重读一次"
  );
  unsubscribeCovered();

  const inFlightClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  const inFlightKey = [...queryKeys.adminImages, "in-flight-page"] as const;
  let inFlightReads = 0;
  let inFlightAborted = false;
  let resolveInFlight: (() => void) | undefined;
  const inFlightObserver = new QueryObserver(inFlightClient, {
    queryKey: inFlightKey,
    queryFn: async ({ signal }) => {
      inFlightReads += 1;
      signal.addEventListener("abort", () => { inFlightAborted = true; });
      const validationStartedAt = inFlightReads === 1 ? 300 : 500;
      if (inFlightReads === 1) {
        await new Promise<void>((resolve) => { resolveInFlight = resolve; });
      }
      recordAdminImageListValidation(
        inFlightClient,
        inFlightKey,
        validationStartedAt
      );
      return coveredData;
    }
  });
  const unsubscribeInFlight = inFlightObserver.subscribe(() => undefined);
  await Promise.resolve();
  const invalidatingInFlight = invalidateImageDataAfterIngestion(
    inFlightClient,
    [adminImageListItem()],
    { completedAt: 400 }
  );
  await Promise.resolve();
  assert.equal(inFlightAborted, false, "完成失效不得取消同一在途列表");
  assert.equal(inFlightReads, 1, "在途列表不得叠加第二个读取");
  assert.ok(resolveInFlight);
  resolveInFlight();
  await invalidatingInFlight;
  assert.equal(
    inFlightReads,
    2,
    "早于完成水位的在途读取结束后必须顺序补一次读取"
  );
  assert.equal(inFlightAborted, false, "尾随读取也不得取消原始请求");
  unsubscribeInFlight();

  const authorProfileClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  for (const key of allKeys) authorProfileClient.setQueryData(key, {});
  await invalidateDataAfterAuthorProfileSave(authorProfileClient);
  for (const key of [
    queryKeys.galleryFacets,
    queryKeys.galleryStats,
    queryKeys.ingestionVocabulary
  ]) {
    assert.equal(invalidated(authorProfileClient, key), true, key[0]);
  }
  for (const key of [
    queryKeys.authors,
    queryKeys.publicImages,
    queryKeys.adminImages,
    queryKeys.overview,
    queryKeys.tags,
    queryKeys.themes
  ]) {
    assert.equal(invalidated(authorProfileClient, key), false, key[0]);
  }
  client.clear();
  changedClient.clear();
  coveredClient.clear();
  inFlightClient.clear();
  authorProfileClient.clear();
});

test("元数据保存只在词条超出共享接入词表时刷新一次", async () => {
  const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
  const vocabulary: IngestionVocabularyDto = {
    themes: [{ slug: "none", display_name: "未分类" }],
    authors: [{ slug: "known-author", display_name: "已有作者" }],
    tags: [{ slug: "known-tag", display_name: "已有标签" }]
  };
  for (const scenario of [
    { updates: [{ id: "one", title: "仅标题" }], reads: 0 },
    { updates: [{ id: "one", theme: "none", author: "known-author", tags: ["known-tag"] }], reads: 0 },
    { updates: [{ id: "one", author: "", tags: [] }], reads: 0 },
    { updates: [{ id: "one", theme: "new-theme" }], reads: 1 },
    { updates: [{ id: "one", author: "new-author" }], reads: 1 },
    { updates: [{ id: "one", tags: ["new-tag"] }], reads: 1 },
    { updates: [{ id: "one", theme: "new-theme" }, { id: "two", tags: ["new-tag"] }], reads: 1 },
    { updates: [{ id: "one", tags: ["unconfirmed-tag"] }], reads: 1, confirmationLost: true },
    { updates: [], reads: 0 }
  ]) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(queryKeys.ingestionVocabulary, vocabulary);
    let reads = 0;
    const observer = new QueryObserver(client, {
      queryKey: queryKeys.ingestionVocabulary,
      staleTime: Infinity,
      queryFn: async () => {
        reads += 1;
        return { ...vocabulary, tags: [...vocabulary.tags, { slug: "new-tag", display_name: "新标签" }] };
      }
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await invalidateImageDataAfterMetadataSave(client, scenario.updates,
        scenario.confirmationLost ? null : scenario.updates.map(({ id }) => ({ id })));
      assert.equal(reads, scenario.reads, JSON.stringify(scenario));
      if (reads) assert.ok(client.getQueryData<IngestionVocabularyDto>(queryKeys.ingestionVocabulary)?.tags.some(({ slug }) => slug === "new-tag"));
    } finally {
      unsubscribe();
      client.clear();
    }
  }
  const unusedClient = new QueryClient();
  await invalidateImageDataAfterMetadataSave(unusedClient, [{ id: "one", theme: "new-theme" }], null);
  assert.equal(unusedClient.getQueryState(queryKeys.ingestionVocabulary), undefined, "未打开过的词表不创建新查询");
  unusedClient.clear();
});

test("图片元数据保存按实际字段失效投影并复用权威详情", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  const createClient = () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
    for (const key of [
      queryKeys.publicImages,
      queryKeys.galleryFacets,
      queryKeys.galleryStats,
      queryKeys.adminImages,
      queryKeys.overview,
      queryKeys.themes,
      queryKeys.tags,
      queryKeys.authors
    ]) client.setQueryData(key, {});
    client.setQueryData([...queryKeys.publicImageDetail, "image-1"], {});
    client.setQueryData([...queryKeys.adminImageInfo, "image-1"], {});
    return client;
  };
  const invalidated = (
    client: InstanceType<typeof QueryClient>,
    key: readonly unknown[]
  ) => client.getQueryState(key)?.isInvalidated === true;

  const titleClient = createClient();
  await invalidateImageDataAfterMetadataSave(
    titleClient,
    [{ id: "image-1", title: "new", description: "new detail" }],
    [{ id: "image-1" }]
  );
  assert.equal(invalidated(titleClient, queryKeys.adminImages), true);
  assert.equal(invalidated(titleClient, queryKeys.overview), true);
  assert.equal(
    invalidated(titleClient, [...queryKeys.adminImageInfo, "image-1"]),
    true
  );
  assert.equal(invalidated(titleClient, queryKeys.galleryStats), false);
  assert.equal(invalidated(titleClient, queryKeys.galleryFacets), false);
  assert.equal(
    invalidated(titleClient, [...queryKeys.publicImageDetail, "image-1"]),
    false
  );

  const membershipClient = createClient();
  await invalidateImageDataAfterMetadataSave(
    membershipClient,
    [{ id: "image-1", theme: "night", tags: ["blue"] }],
    [{ id: "image-1" }]
  );
  for (const key of [
    queryKeys.galleryStats,
    queryKeys.galleryFacets,
    queryKeys.themes,
    queryKeys.tags
  ]) assert.equal(invalidated(membershipClient, key), true, key[0]);
  assert.equal(invalidated(membershipClient, queryKeys.authors), false);

  const missingSnapshotClient = createClient();
  await invalidateImageDataAfterMetadataSave(
    missingSnapshotClient,
    [{ id: "image-1", title: "unconfirmed title", theme: "night" }],
    null
  );
  assert.equal(
    invalidated(
      missingSnapshotClient,
      [...queryKeys.publicImageDetail, "image-1"]
    ),
    true
  );

  titleClient.clear();
  membershipClient.clear();
  missingSnapshotClient.clear();
});

test("概览渲染当前、历史与未知 Redis 占用且重建结束只刷新一次", async () => {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { MemoryRouter } = await import("react-router");
  const { registerHooks } = await import("node:module");
  const cssHooks = registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith(".css")) {
        return { format: "module", source: "", shortCircuit: true };
      }
      return nextLoad(url, context);
    }
  });
  const { Overview } = await import(
    "../../packages/web/src/pages/admin/Overview.tsx"
  ).finally(() => cssHooks.deregister());

  const overviewResult = (
    redisCache: AdminOverviewDto["redis_cache"]
  ): AdminOverviewDto => ({
    gallery: 7,
    theme_unset: 0,
    trash: 0,
    total: 7,
    local: 7,
    nonlocal: 0,
    local_image_size: 1_024,
    local_thumb_size: 256,
    nonlocal_image_size: 0,
    nonlocal_thumb_size: 0,
    theme_count: 1,
    backend_count: 1,
    pc: 7,
    mb: 0,
    dark: 7,
    light: 0,
    top_themes: [],
    recent: [],
    redis_cache: redisCache
  });
  const cacheResult = (
    currentBytes: number | null,
    currentMeasuredAt: string | null,
    historicalBytes: number | null,
    historicalMeasuredAt: string | null,
    rebuilding = false
  ): AdminOverviewDto["redis_cache"] => ({
    state: rebuilding ? "rebuilding" : "ready",
    synchronized: !rebuilding,
    rebuilding,
    item_count: 7,
    current_core_memory_bytes: currentBytes,
    current_core_measured_at: currentMeasuredAt,
    last_full_rebuild_core_memory_bytes: historicalBytes,
    last_full_rebuild_measured_at: historicalMeasuredAt
  });
  const checkStatus = (rebuilding: boolean): AdminCheckStatusDto => ({
    postgresql: {
      status: "ok",
      data: {
        connection: "connected",
        version: "18",
        latency_ms: 1,
        ready_images: 7,
        total_images: 7,
        authoritative_revision: "7",
        abnormal_jobs: 0
      },
      error: null
    },
    redis: {
      status: "ok",
      data: {
        connection: "connected",
        version: "8",
        configured_db: 0,
        latency_ms: 1,
        memory: {
          scope: "redis_instance",
          used_memory_bytes: 4_096,
          used_memory_rss_bytes: 8_192,
          fragmentation_ratio: 1
        },
        image_projection: {
          readable: !rebuilding,
          rebuilding,
          synchronized: !rebuilding,
          state: rebuilding ? "rebuilding" : "ready",
          reason: rebuilding ? "rebuilding" : "ready",
          authoritative_revision: "7",
          applied_revision: rebuilding ? "6" : "7",
          item_count: 7,
          processed: rebuilding ? 3 : null,
          total: rebuilding ? 7 : null,
          last_updated_at: "2026-08-15T01:00:00.000Z",
          full_rebuild_started_at: "2026-08-15T00:59:00.000Z",
          full_rebuild_completed_at: rebuilding
            ? null
            : "2026-08-15T01:00:00.000Z",
          full_rebuild_duration_ms: rebuilding ? null : 60_000,
          last_full_rebuild_core_memory_bytes: 2_048,
          last_full_rebuild_measured_at: "2026-08-15T01:00:00.000Z",
          recent_errors: { core: null, derived: null }
        }
      },
      error: null
    }
  });
  const renderOverviewMarkup = (overview: AdminOverviewDto) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } }
    });
    client.setQueryData(queryKeys.overview, overview);
    const previousReact = Object.getOwnPropertyDescriptor(globalThis, "React");
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      writable: true,
      value: React
    });
    try {
      return renderToStaticMarkup(React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/admin"] },
          React.createElement(Overview, { canManageStorage: true })
        )
      ));
    } finally {
      client.clear();
      if (previousReact) {
        Object.defineProperty(globalThis, "React", previousReact);
      } else {
        delete (globalThis as { React?: unknown }).React;
      }
    }
  };

  const currentMarkup = renderOverviewMarkup(overviewResult(cacheResult(
    1_024,
    "2026-08-15T01:00:01.000Z",
    2_048,
    "2026-08-15T01:00:00.000Z"
  )));
  assert.match(currentMarkup, />1\.0 KB · 已同步</);
  assert.match(
    currentMarkup,
    /title="当前核心图片投影占用 1\.0 KB，测量于 [^"]+"/
  );
  const historicalMarkup = renderOverviewMarkup(overviewResult(cacheResult(
    null,
    null,
    2_048,
    "2026-08-15T01:00:00.000Z"
  )));
  assert.match(historicalMarkup, />2\.0 KB · 已同步</);
  assert.match(
    historicalMarkup,
    /title="当前核心占用未知；最近完整重建核心占用 2\.0 KB，测量于 [^"]+"/
  );
  const unknownMarkup = renderOverviewMarkup(overviewResult(cacheResult(
    null,
    null,
    null,
    null
  )));
  assert.match(unknownMarkup, />— · 已同步</);
  assert.match(unknownMarkup, /title="当前核心图片投影占用未知"/);

  const { document, window } = parseHTML(
    "<!doctype html><html><body><div id=\"root\"></div></body></html>"
  );
  const initialOverview = overviewResult(cacheResult(
    null,
    null,
    2_048,
    "2026-08-15T01:00:00.000Z",
    true
  ));
  const refreshedOverview = overviewResult(cacheResult(
    3_072,
    "2026-08-15T01:01:00.000Z",
    2_048,
    "2026-08-15T01:00:00.000Z"
  ));
  let statusRequests = 0;
  let overviewRequests = 0;
  const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  const fetchStub = async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/admin/check/status") {
      statusRequests += 1;
      return jsonResponse(checkStatus(true));
    }
    if (path === "/api/admin/overview") {
      overviewRequests += 1;
      return jsonResponse(refreshedOverview);
    }
    throw new Error(`unexpected request ${path}`);
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
    fetch: fetchStub,
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
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  client.setQueryData(queryKeys.overview, initialOverview);
  const container = document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  const settleUntil = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (predicate()) return;
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    assert.fail("overview transition did not settle");
  };

  try {
    await React.act(async () => {
      root.render(React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/admin"] },
          React.createElement(Overview, { canManageStorage: true })
        )
      ));
    });
    await settleUntil(() => (
      statusRequests === 1
      && client.getQueryState(queryKeys.overview)?.isInvalidated === true
    ));
    assert.equal(overviewRequests, 0, "重建中只标脏，不得刷新 overview");

    await React.act(async () => {
      client.setQueryData(queryKeys.adminCheckStatus, checkStatus(false));
    });
    await settleUntil(() => overviewRequests === 1);
    await settleUntil(() => container.textContent?.includes("3.0 KB · 已同步") === true);
    await React.act(async () => {
      client.setQueryData(queryKeys.adminCheckStatus, checkStatus(false));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      overviewRequests,
      1,
      "rebuilding→ready 后只允许唯一 overview owner 刷新一次"
    );
  } finally {
    await React.act(async () => root.unmount());
    client.clear();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

test("图片详情原图入口真实挂载覆盖公开开关、认证状态与后台调用方", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const requestAnimationFrame = (callback: FrameRequestCallback) => (
    setTimeout(() => callback(Date.now()), 0) as unknown as number
  );
  const cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  const matchMedia = (query: string) => ({
    matches: false,
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
  const localStorageValues = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageValues.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageValues.delete(key);
    },
    clear: () => localStorageValues.clear()
  };
  Object.assign(window, { localStorage });
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

  const fetchStub = async (input: RequestInfo | URL) => {
    throw new Error(`图片详情真值表不应发起请求: ${String(input)}`);
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
    localStorage,
    fetch: fetchStub,
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
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const { MemoryRouter } = await import("react-router");
    const { AuthSessionProvider } = await import(
      "../../packages/web/src/hooks/useAuthSession.tsx"
    );
    const { ImageDetailModal } = await import(
      "../../packages/web/src/components/image/ImageDetailModal.tsx"
    );
    const container = document.getElementById("root");
    assert.ok(container);
    const publicItem = (diffOriginal: boolean): PublicImageItem => ({
      id: "00000000-0000-7000-8000-000000000544",
      title: "原图入口真值表",
      description: "",
      source: "",
      object_url: "https://static.example.com/full/544.webp",
      thumb_url: "",
      device: "pc",
      brightness: "dark",
      theme: "night",
      author: "",
      tags: ["blue", "stars"],
      width: 1600,
      height: 900,
      diff_original: diffOriginal,
      image_time: "2026-09-01T00:00:00.000Z"
    });
    type AuthScenario = "pending" | "expired" | "guest" | "image" | "super";
    type OriginalActionSnapshot = Readonly<{
      titleText: string;
      titleHref: string | null;
      titleFocusable: boolean;
      present: boolean;
      href: string | null;
      ariaDisabled: string | null;
      sourceHref: string | null;
      sourceAriaDisabled: string | null;
      publicProperties: string;
      actionClasses: string[];
    }>;
    const renderScenario = async ({
      auth,
      publicOriginalButton,
      diffOriginal = true,
      admin = false,
      objectUrl,
      detailLoading = false,
      detailError = "",
      staticUrl = "https://static.example.com"
    }: {
      auth: AuthScenario;
      publicOriginalButton: boolean;
      diffOriginal?: boolean;
      admin?: boolean;
      objectUrl?: string;
      detailLoading?: boolean;
      detailError?: string;
      staticUrl?: string;
    }): Promise<OriginalActionSnapshot> => {
      localStorage.clear();
      const client = new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            staleTime: Number.POSITIVE_INFINITY,
            refetchOnWindowFocus: false
          }
        }
      });
      client.setQueryData(queryKeys.siteConfig, {
        site: {
          static_url: staticUrl,
          gallery: { public_original_button: publicOriginalButton }
        }
      });
      client.setQueryData(queryKeys.galleryFacets, {
        devices: [],
        brightnesses: [],
        themes: [{ slug: "night", display_name: "夜景" }],
        tags: [
          { slug: "blue", display_name: "蓝色" },
          { slug: "stars", display_name: "星空" }
        ],
        authors: []
      });
      if (auth === "guest") {
        client.setQueryData(queryKeys.me, {
          authenticated: false,
          altcha_enabled: false,
          login_background: ""
        });
      } else if (auth === "image" || auth === "super") {
        client.setQueryData(queryKeys.me, {
          authenticated: true,
          username: `${auth}-original-action-test`,
          role: auth,
          permissions: [],
          csrf_token: `${auth}-original-action-csrf`,
          application_version: "current-test",
          preferences: {},
          preferences_etag: `W/\"${auth}-original-action-preferences\"`,
          version_settings: { enabled: true, link_enabled: true }
        });
      } else if (auth === "expired") {
        await client.fetchQuery({
          queryKey: queryKeys.me,
          queryFn: async () => {
            throw new ApiClientError("管理员登录已失效", 401);
          },
          retry: false
        }).catch(() => undefined);
      }

      const root = createRoot(container);
      try {
        await React.act(async () => {
          root.render(React.createElement(
            QueryClientProvider,
            { client },
            React.createElement(
              MemoryRouter,
              { initialEntries: ["/"] },
              React.createElement(
                AuthSessionProvider,
                null,
                admin
                  ? React.createElement(ImageDetailModal, {
                      item: adminImageListItem({
                        id: publicItem(diffOriginal).id,
                        diff_original: diffOriginal
                      }),
                      admin: true,
                      storageLabel: "本地存储",
                      onClose() {}
                    })
                  : React.createElement(ImageDetailModal, {
                      item: { ...publicItem(diffOriginal), ...(objectUrl === undefined ? {} : { object_url: objectUrl }) },
                      admin: false,
                      detailLoading,
                      detailError,
                      onClose() {}
                    })
              )
            )
          ));
          await Promise.resolve();
        });
        const original = document.querySelector<HTMLAnchorElement>(
          ".image-detail-original"
        );
        const source = document.querySelector<HTMLAnchorElement>(
          ".image-detail-source"
        );
        return {
          titleText: document.querySelector(".image-detail-title-row h2")?.textContent ?? "",
          titleHref: document.querySelector(".image-detail-title-link")?.getAttribute("href") ?? null,
          titleFocusable: Boolean(document.querySelector('.image-detail-title-row h2 a[href], .image-detail-title-row h2 [tabindex]')),
          present: Boolean(original),
          href: original?.getAttribute("href") ?? null,
          ariaDisabled: original?.getAttribute("aria-disabled") ?? null,
          sourceHref: source?.getAttribute("href") ?? null,
          sourceAriaDisabled: source?.getAttribute("aria-disabled") ?? null,
          publicProperties: document.querySelector(
            ".image-detail-public-properties"
          )?.textContent ?? "",
          actionClasses: [...document.querySelectorAll<HTMLElement>(
            ".image-detail-actions > a"
          )].map((element) => element.className)
        };
      } finally {
        await React.act(async () => root.unmount());
        client.clear();
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
    };

    for (const state of [
      { objectUrl: "", detailLoading: true },
      { objectUrl: "", detailError: "详情加载失败" },
      { objectUrl: "  " }
    ]) {
      const pendingTitle = await renderScenario({ auth: "guest", publicOriginalButton: false, ...state });
      assert.equal(pendingTitle.titleText, "原图入口真值表");
      assert.equal(pendingTitle.titleHref, null, "占位标题不得生成当前页空链接");
      assert.equal(pendingTitle.titleFocusable, false, "无直链标题不占用 Tab 焦点");
    }
    const loadedTitle = await renderScenario({ auth: "guest", publicOriginalButton: false });
    assert.equal(loadedTitle.titleHref, "https://static.example.com/full/544.webp");
    assert.equal(loadedTitle.titleFocusable, true);

    for (const auth of ["pending", "expired", "guest"] as const) {
      assert.equal((await renderScenario({
        auth,
        publicOriginalButton: false
      })).present, false, `${auth} 不得绕过关闭的公开开关`);
    }
    const publicEnabled = await renderScenario({
      auth: "guest",
      publicOriginalButton: true
    });
    assert.equal(publicEnabled.present, true);
    assert.equal(
      publicEnabled.href,
      "https://static.example.com/link/00000000-0000-7000-8000-000000000544"
    );
    for (const admin of [false, true]) {
      const sameOrigin = await renderScenario({
        auth: admin ? "super" : "guest", publicOriginalButton: true, admin,
        staticUrl: "https://img.example.com/static"
      });
      assert.equal(sameOrigin.href, "https://img.example.com/static/link/00000000-0000-7000-8000-000000000544");
    }
    assert.equal(
      publicEnabled.sourceHref,
      null,
      "公开卡片不应把任意长度来源地址预载进列表响应"
    );
    assert.equal(publicEnabled.sourceAriaDisabled, "true");
    assert.match(publicEnabled.publicProperties, /主题夜景/);
    assert.match(publicEnabled.publicProperties, /标签蓝色星空/);
    assert.deepEqual(
      publicEnabled.actionClasses.map((className) => (
        className.includes("image-detail-source") ? "source" : "original"
      )),
      ["source", "original"],
      "来源必须位于原图左侧"
    );
    for (const auth of ["image", "super"] as const) {
      assert.equal((await renderScenario({
        auth,
        publicOriginalButton: false
      })).present, true, `${auth} 管理员必须复用既有认证结果显示原图`);
    }
    assert.equal((await renderScenario({
      auth: "pending",
      publicOriginalButton: false,
      admin: true
    })).present, true, "后台调用方必须继续由 admin 上下文显示原图");
    const unavailableOriginal = await renderScenario({
      auth: "guest",
      publicOriginalButton: true,
      diffOriginal: false
    });
    assert.equal(unavailableOriginal.present, true);
    assert.equal(unavailableOriginal.href, null);
    assert.equal(unavailableOriginal.ariaDisabled, "true");
  } finally {
    window.HTMLElement.prototype.focus = originalFocus;
    window.HTMLElement.prototype.blur = originalBlur;
    deregisterCssHooks();
    clearCsrfToken();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

test("作者链接保存直接采用权威 DTO 更新原生提示且不重读作者列表", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=\"root\"></div></body></html>"
  );
  const React = await import("react");
  const matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true
  });
  Object.assign(window, {
    matchMedia,
    innerWidth: 1280,
    innerHeight: 720,
    scrollTo() {}
  });
  let authorGets = 0;
  let authorPosts = 0;
  let holdAuthorRead = false;
  let releaseAuthorRead!: (response: Response) => void;
  let oldReadSignal: AbortSignal | null | undefined;
  const requestedAuthorPaths: string[] = [];
  const submittedBodies: unknown[] = [];
  const initialAuthor = {
    slug: "author-profile-test",
    display_name: "Profile Test",
    link: "https://example.com/profile",
    image_count: 0,
    derived_identity: null
  };
  const committedAuthor = {
    ...initialAuthor,
    link: "https://weibo.com/u/4444444444",
    derived_identity: { provider: "weibo", id: "4444444444" }
  };
  const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "https://imageshow.test").pathname;
    const method = String(init?.method ?? "GET").toUpperCase();
    requestedAuthorPaths.push(`${method} ${path}`);
    if (path === "/api/admin/authors" && method === "GET") {
      authorGets += 1;
      if (holdAuthorRead) {
        oldReadSignal = init?.signal;
        return new Promise<Response>((resolve) => { releaseAuthorRead = resolve; });
      }
      return jsonResponse({ ok: true, items: [initialAuthor] });
    }
    if (
      path === "/api/admin/authors/author-profile-test"
      && method === "POST"
    ) {
      authorPosts += 1;
      submittedBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return jsonResponse({ ok: true, item: committedAuthor });
    }
    throw new Error(`unexpected author profile request: ${method} ${path}`);
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
    fetch: fetchStub,
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
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const { MemoryRouter } = await import("react-router");
    const { AuthSessionProvider } = await import(
      "../../packages/web/src/hooks/useAuthSession.tsx"
    );
    const { ActionFeedbackProvider } = await import(
      "../../packages/web/src/components/feedback/ActionFeedbackRegion.tsx"
    );
    const { VocabularyAdmin } = await import(
      "../../packages/web/src/pages/admin/VocabularyAdmin.tsx"
    );
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Number.POSITIVE_INFINITY,
          refetchOnWindowFocus: false
        }
      }
    });
    client.setQueryData(queryKeys.me, {
      authenticated: true,
      username: "author-profile-test",
      role: "image",
      permissions: [],
      csrf_token: "author-profile-csrf",
      application_version: "current-test",
      preferences: {},
      preferences_etag: 'W/"author-profile-preferences"',
      version_settings: { enabled: true, link_enabled: true }
    });
    client.setQueryData(queryKeys.settings, {
      settings: { admin: { image_page_size: 20 } }
    });
    for (const key of [
      queryKeys.galleryFacets,
      queryKeys.galleryStats,
      queryKeys.ingestionVocabulary
    ]) client.setQueryData(key, {});
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    const settleUntil = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        });
      }
      assert.fail(
        `author profile save did not settle; requests=${requestedAuthorPaths.join(",")}; html=${container.innerHTML}`
      );
    };
    try {
      await React.act(async () => {
        root.render(React.createElement(
          React.StrictMode,
          null,
          React.createElement(
            QueryClientProvider,
            { client },
            React.createElement(
              MemoryRouter,
              { initialEntries: ["/admin/authors"] },
              React.createElement(
                AuthSessionProvider,
                null,
                React.createElement(
                  ActionFeedbackProvider,
                  null,
                  React.createElement(VocabularyAdmin, { kind: "authors" })
                )
              )
            )
          )
        ));
      });
      await settleUntil(() => authorGets >= 1 && Boolean(
        container.querySelector("input[aria-label='作者 author-profile-test 链接']")
      ));
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      holdAuthorRead = true;
      await React.act(async () => {
        void client.refetchQueries({ queryKey: queryKeys.authors, exact: true });
      });
      assert.ok(releaseAuthorRead);
      const authorGetsBeforeSave = authorGets;
      const linkInput = container.querySelector<HTMLInputElement>(
        "input[aria-label='作者 author-profile-test 链接']"
      );
      const card = container.querySelector<HTMLElement>(".entity-card");
      assert.ok(linkInput);
      assert.ok(card);
      assert.equal(linkInput.getAttribute("title"), null);
      assert.equal(card.querySelectorAll(".entity-card-link-row").length, 1);
      const initialCardChildren = card.childElementCount;

      await React.act(async () => {
        const reactPropsKey = Reflect.ownKeys(linkInput).find(
          (key) => typeof key === "string" && key.startsWith("__reactProps$")
        );
        assert.ok(reactPropsKey);
        const reactProps = (
          linkInput as unknown as Record<PropertyKey, {
            onChange?: (event: { target: { value: string } }) => void;
          }>
        )[reactPropsKey];
        assert.ok(reactProps.onChange);
        reactProps.onChange({ target: { value: committedAuthor.link } });
        await Promise.resolve();
      });
      await settleUntil(() => [...container.querySelectorAll("button")].some(
        (button) => button.textContent?.includes("保存")
      ));
      const saveButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("保存"));
      assert.ok(saveButton);
      await React.act(async () => {
        saveButton.dispatchEvent(new window.Event("click", {
          bubbles: true,
          cancelable: true
        }));
        await Promise.resolve();
      });
      await settleUntil(() => (
        authorPosts === 1
        && linkInput.getAttribute("title")
          === "平台: weibo; UID: 4444444444"
      ));
      assert.equal(authorGets, authorGetsBeforeSave, "保存成功不得追加作者列表 GET");
      assert.deepEqual(submittedBodies, [{
        display_name: "Profile Test",
        link: "https://weibo.com/u/4444444444"
      }]);
      assert.deepEqual(
        client.getQueryData<{ items: unknown[] }>(queryKeys.authors),
        { ok: true, items: [committedAuthor] }
      );
      assert.equal(oldReadSignal?.aborted, true, "发布保存结果前取消旧作者列表读取");
      await React.act(async () => {
        releaseAuthorRead(jsonResponse({ ok: true, items: [initialAuthor] }));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      assert.deepEqual(client.getQueryData<{ items: unknown[] }>(queryKeys.authors),
        { ok: true, items: [committedAuthor] }, "不响应取消的旧 GET 也不能覆盖保存后的 DTO");
      assert.equal(linkInput.value, committedAuthor.link);
      assert.equal(linkInput.getAttribute("title"), "平台: weibo; UID: 4444444444");
      assert.equal(authorGets, authorGetsBeforeSave);
      assert.equal(card.childElementCount, initialCardChildren);
      assert.equal(card.querySelectorAll(".entity-card-link-row").length, 1);
      assert.equal(card.querySelectorAll("[role='tooltip']").length, 0);
      assert.equal(
        client.getQueryState(queryKeys.authors)?.isInvalidated,
        false
      );
      for (const key of [
        queryKeys.galleryFacets,
        queryKeys.galleryStats,
        queryKeys.ingestionVocabulary
      ]) {
        assert.equal(client.getQueryState(key)?.isInvalidated, true, key[0]);
      }
    } finally {
      await React.act(async () => root.unmount());
      client.clear();
    }
  } finally {
    deregisterCssHooks();
    clearCsrfToken();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

test("站点配置与后台认证初始失败真实挂载保持 bootstrap 反馈语义", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html data-ui-context=bootstrap data-color-scheme=dark>"
      + "<head><meta name=color-scheme content=dark>"
      + "<meta name=theme-color content=#070b15></head>"
      + "<body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const localStorageValues = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageValues.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageValues.delete(key);
    }
  };
  const getComputedStyle = () => ({
    backgroundColor: "rgb(7, 11, 21)",
    getPropertyValue: (name: string) => (
      name === "--color-browser-canvas" ? "#070b15" : ""
    )
  });
  let scenario: "site-config" | "admin-auth" | "public-auth-401" =
    "site-config";
  const requestedPaths: string[] = [];
  const siteConfig = {
    site: {
      name: "ImageShow",
      icon: "/assets/brand/favicon.svg",
      description: "自定义站点描述",
      root: "home",
      home: {
        enabled: true,
        browse_target: "gallery",
        background: "",
        banner_label: "",
        banner_title: ""
      },
      show: {
        enabled: true,
        mode: "waterfall",
        density: "balanced",
        drift_speed: 28,
        order: "random"
      },
      gallery: {
        enabled: true,
        order: "latest",
        public_original_button: false
      },
      static_url: "https://static.example.com"
    },
    embed: { enabled: false }
  };
  const fetchStub = async (input: RequestInfo | URL) => {
    const path = String(input);
    requestedPaths.push(path);
    if (path === "/api/site-config" && scenario === "admin-auth") {
      return new Response(JSON.stringify(siteConfig), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({
      ok: false,
      error: scenario === "site-config"
        ? "site config unavailable"
        : "auth unavailable"
    }), {
      status: scenario === "public-auth-401" ? 401 : 503,
      headers: { "content-type": "application/json" }
    });
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
    getComputedStyle,
    localStorage,
    fetch: fetchStub,
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
    const { MemoryRouter } = await import("react-router");
    const { AppRoutes } = await import(
      "../../packages/web/src/AppRoutes.tsx"
    );
    const { SiteHead } = await import(
      "../../packages/web/src/components/layout/SiteHead.tsx"
    );
    const { AdminShell } = await import(
      "../../packages/web/src/pages/admin/shell/AdminShell.tsx"
    );
    const { AuthSessionProvider, useAuthMe } = await import(
      "../../packages/web/src/hooks/useAuthSession.tsx"
    );
    const container = document.getElementById("root");
    assert.ok(container);

    const renderFailure = async (
      path: "/" | "/admin",
      content: React.ReactNode
    ) => {
      document.documentElement.dataset.uiContext = "bootstrap";
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } }
      });
      const root = createRoot(container);
      await React.act(async () => {
        root.render(React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(
            MemoryRouter,
            { initialEntries: [path] },
            React.createElement(
              AuthSessionProvider,
              null,
              content
            )
          )
        ));
      });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        if (container.querySelector('[role="alert"]')) break;
      }
      const alert = container.querySelector('[role="alert"]');
      assert.ok(alert);
      assert.match(alert.className, /\bcenter\b/);
      assert.match(alert.textContent ?? "", /加载失败，请稍后重试/);
      assert.equal(document.documentElement.dataset.uiContext, "bootstrap");
      await React.act(async () => root.unmount());
      client.clear();
    };

    await renderFailure(
      "/",
      React.createElement(React.Fragment, null,
        React.createElement(SiteHead),
        React.createElement(AppRoutes)
      )
    );
    assert.deepEqual(requestedPaths, ["/api/site-config"]);

    requestedPaths.length = 0;
    scenario = "admin-auth";
    await renderFailure(
      "/admin",
      React.createElement(React.Fragment, null,
        React.createElement(SiteHead),
        React.createElement(AdminShell, { siteName: siteConfig.site.name })
      )
    );
    assert.deepEqual(
      requestedPaths.sort(),
      ["/api/admin/auth/me", "/api/site-config"]
    );
    assert.equal(
      document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content,
      "自定义站点描述"
    );

    requestedPaths.length = 0;
    siteConfig.site.name = "站点名称回退";
    siteConfig.site.description = "服务端投影后的描述";
    await renderFailure(
      "/admin",
      React.createElement(React.Fragment, null,
        React.createElement(SiteHead),
        React.createElement(AdminShell, { siteName: siteConfig.site.name })
      )
    );
    assert.deepEqual(
      requestedPaths.sort(),
      ["/api/admin/auth/me", "/api/site-config"]
    );
    assert.equal(
      document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content,
      "服务端投影后的描述"
    );

    requestedPaths.length = 0;
    siteConfig.site.name = "另一站点";
    siteConfig.site.description = "服务端权威描述";
    await renderFailure(
      "/admin",
      React.createElement(React.Fragment, null,
        React.createElement(SiteHead),
        React.createElement(AdminShell, { siteName: siteConfig.site.name })
      )
    );
    assert.deepEqual(
      requestedPaths.sort(),
      ["/api/admin/auth/me", "/api/site-config"]
    );
    assert.equal(
      document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content,
      "服务端权威描述"
    );

    requestedPaths.length = 0;
    scenario = "public-auth-401";
    localStorage.setItem("site_session_hint", "1");
    const authClient = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
    const authRoot = createRoot(container);
    function PublicAuthProbe() {
      const query = useAuthMe();
      return React.createElement(
        "span",
        { "data-auth-probe": true },
        query.isError ? "failed" : "pending"
      );
    }
    await React.act(async () => {
      authRoot.render(React.createElement(
        QueryClientProvider,
        { client: authClient },
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/"] },
          React.createElement(
            AuthSessionProvider,
            null,
            React.createElement(PublicAuthProbe)
          )
        )
      ));
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (container.textContent === "failed") break;
    }
    assert.equal(container.textContent, "failed");
    assert.deepEqual(requestedPaths, ["/api/admin/auth/me"]);
    assert.equal(localStorage.getItem("site_session_hint"), null);
    await React.act(async () => authRoot.unmount());
    authClient.clear();
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

test("上传与导入窗口真实挂载保持双行摘要、来源切换和关闭回焦", async () => {
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
  const requestAnimationFrame = (callback: FrameRequestCallback) => (
    setTimeout(() => callback(Date.now()), 0) as unknown as number
  );
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
    id: "019f8457-063a-7034-a580-7a432dc7fd8e",
    md5: windowDuplicateMd5
  });
  const fetchStub = async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "https://imageshow.test").pathname;
    if (path === ingestionDuplicatesPath) {
      return new Response(JSON.stringify({
        ok: true,
        items: [{
          md5: windowDuplicateMd5,
          match_count: 1,
          duplicates: [windowDuplicateItem]
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
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
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const { MemoryRouter } = await import("react-router");
    const { AuthSessionProvider } = await import(
      "../../packages/web/src/hooks/useAuthSession.tsx"
    );
    const { IngestionWorkflowWindow } = await import(
      "../../packages/web/src/pages/admin/ingestion/workflow/IngestionWorkflowWindow.tsx"
    );
    const rootElement = document.getElementById("root");
    const returnTarget = document.getElementById("return-target") as HTMLElement;
    assert.ok(rootElement);
    returnTarget.focus();
    const client = new QueryClient({
      defaultOptions: {
        queries: {
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
    client.setQueryData(queryKeys.siteConfig, {
      site: { static_url: "https://static.example.com" }
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
    const closeOptions: Array<Readonly<{
      skipCompletedCleanup?: boolean;
    }> | undefined> = [];
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
      | "idle"
      | "connecting"
      | "loading"
      | "ready"
      | "disconnected"
      | "error";
    let setHarnessServerStatus: ((status: HarnessServerStatus) => void)
      | undefined;
    let setHarnessTransientFlags: ((flags: {
      actionBusy: boolean;
      pendingAuthorityHandoff: boolean;
    }) => void) | undefined;
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
      const [workflowMode, setWorkflowMode] = React.useState<"upload" | "import">(
        "import"
      );
      const [jobs, setJobs] = React.useState(emptyJobs);
      const [totalItemsOverride, setTotalItemsOverride] = React.useState<
        number | null
      >(null);
      const [serverStatus, setServerStatus] = React.useState<
        HarnessServerStatus
      >("loading");
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
      const [sourceMode, setSourceMode] = React.useState<
        "urls" | "jsonl" | "weibo"
      >("urls");
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
        onApplyDefaults() { applyDefaultsCount += 1; },
        onCleanupAction() { cleanupRunCount += 1; },
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
        onCommitReady() { commitReadyCount += 1; },
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
      root.render(React.createElement(
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
      ));
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
    const buttonByText = (label: string) => (
      [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === label
      )
    );
    assert.equal(activeElement, dialog.querySelector(".ingestion-close-button"));
    for (const label of ["链接", "清单", "微博"]) {
      const button = buttonByText(label);
      assert.ok(button);
      await React.act(async () => {
        button.dispatchEvent(new window.Event("click", {
          bubbles: true,
          cancelable: true
        }));
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
    const localFileInput = dialog.querySelector<HTMLInputElement>(
      'input[type="file"]'
    );
    assert.ok(localFileInput);
    assert.equal(
      localFileInput.disabled,
      false,
      "本地上传忙碌阶段仍须保持选择图片入口稳定可用"
    );
    assert.equal(
      localFileInput.closest(".upload-picker")?.classList.contains(
        "is-disabled"
      ),
      false,
      "本地上传入口不得在提交瞬间切换禁用外观"
    );
    const pendingSnapshotJob = ingestionJob({
      id: "window-pending-snapshot",
      attemptKey: "window-pending-snapshot-attempt",
      sessionId: "S".repeat(43),
      imageId: "019f8457-063a-7037-a580-7a432dc7fd8e",
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
      setHarnessJobs?.([{
        ...applyTransitionJob,
        status: "commit-queued",
        commitIntent: createIngestionCommitIntent(
          applyTransitionJob,
          "019f8457-063a-702f-a580-7a432dc7fd8e"
        )
      }]);
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
    assert.equal(
      dialog.querySelector(".ingestion-summary-primary")?.textContent
        ?.replace(/\s+/gu, " ").trim(),
      "共 1 张图片，1 张等待中，0 张处理中；"
    );

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
    assert.equal(
      dialog.querySelector(".ingestion-summary-primary")?.textContent
        ?.replace(/\s+/gu, " ").trim(),
      "共 1 张图片，0 张等待中，0 张处理中；"
    );
    assert.equal(
      dialog.querySelector(".ingestion-summary-secondary")?.textContent
        ?.replace(/\s+/gu, " ").trim(),
      "1 张待提交，0 张提交中，0 张已完成"
    );

    const clearUncommitted = buttonByText("清空未提交");
    assert.ok(clearUncommitted);
    const phaseDuplicateJob = ingestionJob({
      id: "window-phase-duplicate",
      attemptKey: "window-phase-duplicate-attempt",
      sessionId: "Q".repeat(43),
      imageId: "019f8457-063a-7036-a580-7a432dc7fd8e",
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
    const submitReady = dialog.querySelector<HTMLButtonElement>(
      ".workflow-submit-button"
    );
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
    assert.equal(submitReady.disabled, false);
    assert.equal(alwaysClickableCancel.disabled, false);
    assert.equal(
      duplicateCancel.disabled,
      false,
      "重复待确认卡片的取消按钮在队列操作期间仍须可点击"
    );
    assert.equal(applyDefaults.disabled, false);
    assert.equal(sourceButtons.every((button) => !button.disabled), true);
    assert.match(submitReady.textContent ?? "", /提交\s*1\s*张/u);
    await React.act(async () => {
      clearDuplicates.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      submitReady.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      for (const button of sourceButtons) {
        button.dispatchEvent(new window.Event("click", {
          bubbles: true,
          cancelable: true
        }));
      }
      await Promise.resolve();
    });
    assert.equal(cleanupRunCount, 1);
    assert.equal(commitReadyCount, 1);
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
      clearUncommitted.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
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
    const frozenCleanupConfirm = cleanupDialog.querySelector<HTMLButtonElement>(
      'button[type="submit"]'
    );
    assert.ok(frozenCleanupConfirm);
    assert.match(
      frozenCleanupConfirm.querySelector(
        ".async-action-state:not(.is-hidden) .async-action-label"
      )?.textContent ?? "",
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
      frozenCleanupForm.dispatchEvent(new window.Event("submit", {
        bubbles: true,
        cancelable: true
      }));
      await new Promise((resolve) => setTimeout(resolve, 550));
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
      clearQueueButton.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
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
      clearQueueButton.dispatchEvent(new window.Event("blur", {
        bubbles: false
      }));
      await Promise.resolve();
    });
    assert.equal(
      clearQueueButton.textContent?.trim(),
      "清空",
      "权威快照交接导致的禁用和失焦不得解除二次确认"
    );
    await React.act(async () => {
      setHarnessServerStatus?.("ready");
      setHarnessJobs?.([
        firstConfirmationJob,
        laterConfirmationJob,
        ingestionJob({
          id: "window-confirmation-newest",
          attemptKey: "window-confirmation-newest-attempt",
          status: "ready"
        })
      ].map((job) => ({ ...job, status: "done" as const })));
      await Promise.resolve();
    });
    assert.equal(
      clearQueueButton.textContent?.trim(),
      "清空",
      "冻结范围内任务转为已完成也不得改写二次确认意图"
    );
    assert.equal(clearQueueButton.classList.contains("danger-button"), true);
    await React.act(async () => {
      clearQueueButton.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    assert.equal(clearQueueButton.textContent?.trim(), "取消");
    assert.equal(clearArmCount, 1, "确认时不得按最新队列重新冻结一次范围");
    assert.equal(clearConfirmCount, 1);

    const incarnationSessionId = "Z".repeat(43);
    await React.act(async () => {
      setHarnessJobs?.([ingestionJob({
        id: "window-old-incarnation",
        attemptKey: "window-old-incarnation-attempt",
        batchKey: "window-incarnation-batch",
        sessionId: incarnationSessionId,
        imageId: "019f8457-063a-7030-a580-7a432dc7fd8e",
        serverAccepted: true,
        status: "received",
        preview: "blob:window-old-incarnation",
        previewFull: "blob:window-old-incarnation"
      })]);
      await Promise.resolve();
    });
    const oldPreviewOpener = dialog.querySelector<HTMLElement>(
      ".ingestion-job-thumbnail[role='button']"
    );
    assert.ok(oldPreviewOpener);
    await React.act(async () => {
      oldPreviewOpener.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    assert.ok(document.querySelector(".image-preview-modal"));

    await React.act(async () => {
      setHarnessJobs?.([ingestionJob({
        id: "window-next-incarnation",
        attemptKey: "window-next-incarnation-attempt",
        batchKey: "window-incarnation-batch",
        sessionId: incarnationSessionId,
        imageId: "019f8457-063a-7031-a580-7a432dc7fd8e",
        serverAccepted: true,
        status: "received",
        preview: "https://static.example/new-incarnation.webp",
        previewFull: "https://static.example/new-incarnation-full.webp"
      })]);
      await Promise.resolve();
    });
    const nextPreviewOpener = dialog.querySelector<HTMLElement>(
      ".ingestion-job-thumbnail[role='button']"
    );
    assert.ok(nextPreviewOpener);
    const transferredPreview = document.querySelector<HTMLElement>(
      ".image-preview-modal"
    );
    assert.ok(
      transferredPreview,
      "同 session 新 image 接管后必须把已打开预览切换到新 incarnation"
    );
    const previewClose = transferredPreview.querySelector<HTMLButtonElement>(
      ".image-preview-close"
    );
    assert.ok(previewClose);
    await React.act(async () => {
      previewClose.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    assert.equal(document.querySelector(".image-preview-modal"), null);
    assert.equal(
      activeElement,
      nextPreviewOpener,
      "旧预览关闭后必须把焦点转交给新 incarnation 卡片"
    );

    const focusSessionId = "F".repeat(43);
    const focusImageId = "019f8457-063a-7032-a580-7a432dc7fd8e";
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
      oldTitleInput.dispatchEvent(new window.Event("focusin", {
        bubbles: true
      }));
      await Promise.resolve();
    });
    const firstBoundFocus = ingestionJob({
      ...focusPlaceholder,
      sessionId: focusSessionId,
      imageId: focusImageId,
      serverAccepted: true,
      preview: "https://static.example/first-bound-focus.webp"
    });
    await React.act(async () => {
      setHarnessJobs?.([firstBoundFocus]);
      await Promise.resolve();
    });
    await React.act(async () => {
      setHarnessJobs?.([ingestionJob({
        ...firstBoundFocus,
        id: "server:next-incarnation-focus",
        attemptKey: "next-incarnation-focus-attempt",
        imageId: "019f8457-063a-7035-a580-7a432dc7fd8e"
      })]);
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
      preview: "https://static.example/event-first-focus.webp"
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
      eventFirstTitleInput.dispatchEvent(new window.Event("focusin", {
        bubbles: true
      }));
      await Promise.resolve();
    });
    await React.act(async () => {
      setHarnessJobs?.([ingestionJob({
        ...eventFirstCanonical,
        id: "local:http-late-focus",
        attemptKey: "http-late-focus-attempt"
      })]);
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
    const detailImageId = "019f8457-063a-7033-a580-7a432dc7fd8e";
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
    const duplicateStatusLabel = dialog.querySelector<HTMLElement>(
      ".ingestion-status-label"
    );
    assert.equal(duplicateStatusLabel?.textContent, "【待确认】");
    assert.equal(
      duplicateStatusLabel?.classList.contains("is-duplicate-pending"),
      true,
      "重复待确认标签必须复用重复提示标题的语义警告色"
    );
    const oldDetailOpener = dialog.querySelector<HTMLButtonElement>(
      ".duplicate-item"
    );
    assert.ok(oldDetailOpener);
    await React.act(async () => {
      oldDetailOpener.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    assert.ok(document.querySelector(".image-detail-modal"));
    await React.act(async () => {
      setHarnessJobs?.([ingestionJob({
        ...detailCanonical,
        id: "local:http-late-detail",
        attemptKey: "http-late-detail-attempt"
      })]);
      await Promise.resolve();
    });
    const detailClose = document.querySelector<HTMLButtonElement>(
      ".image-detail-modal button[aria-label='关闭图片详情']"
    );
    assert.ok(detailClose);
    await React.act(async () => {
      detailClose.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    const transferredDetailOpener = dialog.querySelector<HTMLButtonElement>(
      ".duplicate-item"
    );
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

    const waitForPageScrollRestore = () => new Promise<void>((resolve) => {
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
    const reopenedDialog = document.querySelector<HTMLElement>(
      "[data-dialog-frame]"
    );
    const closeButton = reopenedDialog?.querySelector<HTMLButtonElement>(
      ".ingestion-close-button"
    );
    assert.ok(closeButton);
    assert.equal(closeButton.disabled, false, "忙碌阶段仍必须允许隐藏窗口");
    const buttonScrollRestored = waitForPageScrollRestore();
    await React.act(async () => {
      closeButton.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
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
    const staleDialog = document.querySelector<HTMLElement>(
      "[data-dialog-frame]"
    );
    const staleClearQueueButton = staleDialog?.querySelector<HTMLButtonElement>(
      ".ingestion-queue-clear-button"
    );
    const staleCloseButton = staleDialog?.querySelector<HTMLButtonElement>(
      ".ingestion-close-button"
    );
    assert.ok(staleClearQueueButton);
    assert.ok(staleCloseButton);
    delayClearConfirmation = true;
    await React.act(async () => {
      staleClearQueueButton.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    await React.act(async () => {
      staleClearQueueButton.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    assert.ok(resolveClearConfirmation);

    const staleScrollRestored = waitForPageScrollRestore();
    await React.act(async () => {
      staleCloseButton.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
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
    const reopenedAfterStaleConfirmation = document.querySelector<HTMLElement>(
      "[data-dialog-frame]"
    );
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
      finalClearQueueButton.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    assert.equal(finalClearQueueButton.textContent?.trim(), "清空");
    await React.act(async () => {
      finalClearQueueButton.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await new Promise((resolve) => setTimeout(resolve, 550));
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

test("内容接入入口只在模态边界接管前锁定页面且五类激活与失败都正确交接", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><button id=opener>打开导入</button><div id=root></div></body></html>"
  );
  const React = await import("react");
  const requestAnimationFrame = (callback: FrameRequestCallback) => (
    setTimeout(() => callback(Date.now()), 0) as unknown as number
  );
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
      import("../../packages/web/src/pages/admin/ingestion/Ingestion.tsx"),
      import("../../packages/web/src/pages/admin/ingestion/IngestionLauncher.tsx")
    ]).finally(() => cssHooks.deregister());
    const container = document.getElementById("root");
    const opener = document.getElementById("opener") as HTMLButtonElement;
    assert.ok(container);
    assert.ok(opener);

    const client = new QueryClient({
      defaultOptions: {
        queries: {
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
      backends: [{
        slug: "local",
        display_name: "本地存储",
        enabled: true,
        is_default: true
      }]
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
        initialMode === "jsonl" ? React.createElement("button", {
          type: "button",
          "data-submit-jsonl-error": true,
          onClick() {
            onSubmit({
              mode: "jsonl",
              manifest: {
                items: [],
                errors: [{
                  line: 7,
                  raw: "invalid jsonl row",
                  error: "受控清单错误"
                }]
              }
            });
            onClose();
          }
        }, "提交错误清单") : null
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
        root.render(React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(Ingestion, {
            settings: client.getQueryData<{ settings: Parameters<typeof Ingestion>[0]["settings"] }>(queryKeys.settings)!.settings,
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
        ));
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
          document.querySelector("[data-import-source-mode]")
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
          submitJsonlError.dispatchEvent(new window.Event("click", {
            bubbles: true,
            cancelable: true
          }));
          await Promise.resolve();
        });
        await waitFor(
          () => (document.querySelector("[data-dialog-frame]")?.textContent ?? "")
            .includes("1 行未创建任务"),
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

      const closeButton = document.querySelector<HTMLButtonElement>(
        ".ingestion-close-button"
      );
      assert.ok(closeButton);
      await React.act(async () => {
        closeButton.dispatchEvent(new window.Event("click", {
          bubbles: true,
          cancelable: true
        }));
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
        React.createElement("button", {
          id: "background-single-image-edit",
          type: "button",
          onClick: () => {
            backgroundEditClicks += 1;
          }
        }, "编辑图片"),
        React.createElement(IngestionLauncher, {
          settings: client.getQueryData<{ settings: Parameters<typeof IngestionLauncher>[0]["settings"] }>(queryKeys.settings)!.settings,
          showTriggers: true,
          disabled: false,
          onDone() {},
          onLoadError: (error) => loadErrors.push(error),
          moduleLoaders: launcherModuleLoaders
        })
      );
    }
    await React.act(async () => {
      root.render(React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(LauncherHarness)
      ));
      await Promise.resolve();
    });
    const uploadTrigger = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button")
    ).find((button) => button.textContent?.includes("上传图片"));
    assert.ok(uploadTrigger);
    client.removeQueries({ queryKey: queryKeys.storageOptions });
    let resolveStorage!: (response: Response) => void;
    storageResponse = new Promise((resolve) => { resolveStorage = resolve; });
    React.act(() => {
      uploadTrigger.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
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
      (document.getElementById(
        "background-single-image-edit"
      ) as HTMLButtonElement).disabled,
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
    assert.equal(document.querySelector("[data-dialog-frame]"), null,
      "存储尚未返回时不能提前打开工作流并采用临时 local");
    await React.act(async () => resolveStorage(Response.json({ backends: [{
      slug: "cos", display_name: "COS", enabled: true, is_default: true
    }] })));
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

    const launcherCloseButton = document.querySelector<HTMLButtonElement>(
      ".ingestion-close-button"
    );
    assert.ok(launcherCloseButton);
    await React.act(async () => {
      launcherCloseButton.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    const closingFrame = document.querySelector<HTMLElement>(
      "[data-dialog-frame]"
    );
    assert.ok(closingFrame);
    assert.equal(closingFrame.classList.contains("is-closing"), true);
    assert.equal(backgroundEdit.disabled, false);
    assert.equal(
      container.inert,
      true,
      "淡出期间仍由现存 DialogFrame 阻止底层操作"
    );
    await React.act(async () => {
      closingFrame.dispatchEvent(new window.Event("animationend", {
        bubbles: true
      }));
      await Promise.resolve();
    });
    assert.equal(document.querySelector("[data-dialog-frame]"), null);
    assert.notEqual(container.inert, true);
    await React.act(async () => {
      backgroundEdit.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    assert.equal(
      backgroundEditClicks,
      1,
      "弹窗卸载后的首次单图编辑操作必须立即生效"
    );
    await waitFor(
      () => !document.documentElement.classList.contains(
        "page-scroll-restoring"
      ),
      "弹窗关闭后的页面滚动位置未完成恢复"
    );

    const loadErrorCountBeforeLauncherFailure = loadErrors.length;
    rejectLauncherWorkflowLoad = true;
    uploadTrigger.focus();
    React.act(() => {
      uploadTrigger.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
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
      () => !document.documentElement.classList.contains(
        "page-scroll-restoring"
      ),
      "Launcher 加载失败后的页面滚动位置未完成恢复"
    );

    rejectLauncherWorkflowLoad = false;
    client.removeQueries({ queryKey: queryKeys.storageOptions });
    storageResponse = Promise.resolve(Response.json({ error: "存储查询失败" }, { status: 503 }));
    const errorsBeforeStorageFailure = loadErrors.length;
    await React.act(async () => uploadTrigger.click());
    await waitFor(() => loadErrors.length === errorsBeforeStorageFailure + 1 && !container.inert,
      "存储查询失败必须释放入口锁并允许重试");
    assert.equal(document.querySelector("[data-dialog-frame]"), null);
    assert.equal(activeElement, uploadTrigger);
    storageResponse = Promise.resolve(Response.json({ backends: [{
      slug: "cos", display_name: "COS", enabled: true, is_default: true
    }] }));
    await React.act(async () => uploadTrigger.click());
    await waitFor(() => document.querySelector("[data-dialog-frame]") !== null,
      "存储查询失败后重试应打开工作流");

    await React.act(async () => root.unmount());
    await waitFor(() => !document.documentElement.classList.contains("page-scroll-restoring"),
      "最终卸载应先完成页面滚动恢复，再释放测试 DOM");
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

test("导入组合按钮共同预载且来源选择在菜单退场前取得页面启动锁", async () => {
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
    requestAnimationFrame: (callback: FrameRequestCallback) => (
      setTimeout(() => callback(Date.now()), 0) as unknown as number
    ),
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
    const { registerHooks } = await import("node:module");
    const cssHooks = registerHooks({
      load(url, context, nextLoad) {
        if (url.endsWith(".css")) {
          return { format: "module", source: "", shortCircuit: true };
        }
        return nextLoad(url, context);
      }
    });
    const { IngestionTriggers } = await import(
      "../../packages/web/src/pages/admin/ingestion/IngestionTriggers.tsx"
    ).finally(() => cssHooks.deregister());
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

    const mainButton = container.querySelector<HTMLButtonElement>(
      ".import-source-main"
    );
    const menuButton = container.querySelector<HTMLButtonElement>(
      ".import-source-menu-trigger"
    );
    const uploadButton = [...container.querySelectorAll<HTMLButtonElement>(
      ".ingestion-trigger"
    )].find((button) => button.textContent?.includes("上传图片"));
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
    const urlItem = [...document.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]'
    )].find((button) => button.textContent?.includes("链接导入"));
    assert.ok(urlItem);
    await dispatch(urlItem, "click");
    assert.equal(
      sourceActivations,
      1,
      "来源激活不得延迟到菜单退出动画完成后"
    );
    const closingMenu = document.querySelector<HTMLElement>(
      ".import-source-menu.is-closing"
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

for (const itemCount of [1, 3]) {
  test(`图片元数据会话以同一契约处理 ${itemCount} 项`, () => {
    const ids = Array.from({ length: itemCount }, (_, index) => `image-${index}`);
    let state = createImageMetadataSession(ids.map((id) => editableImage(id)));
    state = {
      ...state,
      drafts: Object.fromEntries(ids.map((id) => [
        id,
        { ...state.drafts[id]!, title: `${id}-saved` }
      ]))
    };
    const updates = ids.map((id, index) => changedMetadataUpdate(
      state.baselineItems[index]!,
      state.drafts[id]!,
      fieldsChangedFor(state.baselineItems[index]!, state.drafts[id]!)
    ));
    assert.deepEqual(updates, ids.map((id) => ({
      id,
      title: `${id}-saved`
    })));

    const attempt: ImageMetadataSaveAttempt = {
      activeIds: ids,
      items: updates,
      response: imageUpdateResponse(ids)
    };
    const authority = ids.map((id) => editableImage(id, {
      title: `${id}-saved`
    }));
    const report = createImageMetadataSaveReport(attempt, authority);
    const next = reconcileImageMetadataSession(state, attempt, authority);
    assert.deepEqual(
      { updated: report.updated, failed: report.failed },
      { updated: itemCount, failed: 0 }
    );
    assert.equal(report.responseReceived, true);
    for (const id of ids) {
      assert.equal(imageMetadataCardSaveState(report, id), "saved");
      assert.equal(fieldsChangedFor(
        authority.find((item) => item.id === id)!,
        next.drafts[id]!
      ).title, false);
    }

    const pendingWithResponse = createImageMetadataSaveReport(attempt, null);
    assert.equal(pendingWithResponse.responseReceived, true);
    for (const id of ids) {
      assert.equal(imageMetadataCardSaveState(
        pendingWithResponse,
        id
      ), "pending");
    }

    const unknownAttempt: ImageMetadataSaveAttempt = {
      ...attempt,
      response: null
    };
    const pendingWithoutResponse = createImageMetadataSaveReport(
      unknownAttempt,
      null
    );
    const confirmedWithoutResponse = createImageMetadataSaveReport(
      unknownAttempt,
      authority
    );
    assert.equal(pendingWithoutResponse.responseReceived, false);
    assert.equal(confirmedWithoutResponse.responseReceived, false);
    for (const id of ids) {
      assert.equal(imageMetadataCardSaveState(
        pendingWithoutResponse,
        id
      ), "pending");
      assert.equal(imageMetadataCardSaveState(
        confirmedWithoutResponse,
        id
      ), "saved");
    }
  });
}

test("图片元数据部分失败保留对应卡片草稿", () => {
  let state = createImageMetadataSession([
    editableImage("a"),
    editableImage("b")
  ]);
  state = {
    ...state,
    drafts: {
      a: { ...state.drafts.a!, title: "a-saved" },
      b: { ...state.drafts.b!, title: "b-retry", tags: ["landed"] }
    }
  };
  const attempt: ImageMetadataSaveAttempt = {
    activeIds: ["a", "b"],
    items: [
      { id: "a", title: "a-saved" },
      { id: "b", title: "b-retry", tags: ["landed"] }
    ],
    response: imageUpdateResponse(["a"], ["b"])
  };
  const authority = [
    editableImage("a", { title: "a-saved" }),
    editableImage("b", { tags: ["landed"] })
  ];
  const report = createImageMetadataSaveReport(attempt, authority);
  const next = reconcileImageMetadataSession(state, attempt, authority);
  assert.equal(imageMetadataCardSaveState(report, "a"), "saved");
  assert.equal(imageMetadataCardSaveState(report, "b"), "failed");
  assert.equal(fieldsChangedFor(authority[0]!, next.drafts.a!).title, false);
  assert.equal(fieldsChangedFor(authority[1]!, next.drafts.b!).title, true);
  assert.equal(fieldsChangedFor(authority[1]!, next.drafts.b!).tags, false);
});

test("图片编辑器 trash 以逐项结果和权威回读收敛成员", () => {
  const requestedIds = ["A", "b", "c"];
  const response = {
    requested: 3,
    // 聚合计数即使与逐项结果矛盾也不能成为成功依据。
    trashed: 3,
    ignored: 0,
    results: [
      { id: "a", status: "trashed" as const },
      { id: "b", status: "ignored" as const },
      { id: "outside", status: "trashed" as const }
    ]
  };
  assert.deepEqual(
    imageTrashIdsNeedingSnapshot(requestedIds, response),
    ["b", "c"]
  );
  const reconciled = reconcileImageEditorTrash(
    requestedIds,
    response,
    [editableImage("B")]
  );
  assert.deepEqual(reconciled, {
    trashedIds: ["A", "c"],
    editableIds: ["b"],
    unknownIds: []
  });

  const responseLost = reconcileImageEditorTrash(
    requestedIds,
    null,
    [editableImage("A")]
  );
  assert.deepEqual(responseLost, {
    trashedIds: ["b", "c"],
    editableIds: ["A"],
    unknownIds: []
  });
  assert.deepEqual(
    reconcileImageEditorTrash(requestedIds, null, null),
    {
      trashedIds: [],
      editableIds: [],
      unknownIds: requestedIds
    }
  );

  const session = createImageMetadataSession(
    requestedIds.map((id) => editableImage(id))
  );
  assert.deepEqual(
    pruneImageMetadataSessionAfterTrash(session, ["a", "C"]),
    {
      activeIds: ["b"],
      baselineItems: [editableImage("b")],
      drafts: { b: session.drafts.b }
    }
  );
});

test("存储删除反馈以服务端权威结果收口", () => {
  const backend = {
    slug: "archive",
    display_name: "Archive",
    enabled: true,
    is_default: false,
    type: "local",
    image_count: 3,
    ingestion_session_count: 0,
    cleanup_job_count: 0,
    failed_cleanup_job_count: 0,
    exhausted_cleanup_job_count: 0,
    deletion: { action: "migrate", blockers: ["images"] }
  } satisfies StorageBackendAdmin;
  assert.deepEqual(storageBackendDeletionReasons(backend), [
    "仍有 3 张图片使用该后端；请先迁移这些图片。"
  ]);
  const rejected = storageBackendAfterDeleteRejection(backend, new ApiClientError(
    "后端仍在使用",
    409,
    "storage_backend_in_use",
    {
      image_count: 0,
      ingestion_session_count: 2,
      cleanup_job_count: 1,
      deletion: {
        action: "blocked",
        blockers: ["ingestion_sessions", "cleanup_jobs"]
      }
    }
  ));
  assert.deepEqual(rejected.deletion.blockers, ["ingestion_sessions", "cleanup_jobs"]);
  assert.deepEqual(storageBackendWithHiddenStagingBlocker(backend, {
    ...backend,
    deletion: { action: "blocked", blockers: ["staging_objects"] }
  }).deletion.blockers, ["images", "staging_objects"]);
});

test("整后端迁移以错误总数为权威并只发布稳定错误样本", () => {
  const migration = {
    source: "archive",
    target: "local",
    migrated: 8,
    unchanged: 1,
    missing: 0,
    error_samples: [{
      id: "0198f6f8-168f-74fd-b3f2-a71d71742845",
      object_key: "45/0198f6f8-168f-74fd-b3f2-a71d71742845.webp",
      code: "storage_object_conflict",
      message: "仅供展示的诊断文本"
    }],
    error_count: 2
  } satisfies StorageBackendMigrationResultDto;
  assert.equal(migration.error_count, 2);
  assert.equal(migration.error_samples.length, 1);
  assert.deepEqual(
    migration.error_samples.map(({ code }) => code),
    ["storage_object_conflict"]
  );
  assert.equal("errors" in migration, false);
});

test("存储编辑只提交变化字段并省略空凭据", () => {
  const backend = {
    slug: "archive",
    display_name: "Archive",
    enabled: true,
    is_default: false,
    type: "s3",
    image_count: 0,
    ingestion_session_count: 0,
    cleanup_job_count: 0,
    failed_cleanup_job_count: 0,
    exhausted_cleanup_job_count: 0,
    deletion: { action: "delete", blockers: [] },
    s3: {
      endpoint: "https://objects.example.com",
      region: "ap-southeast-1",
      bucket: "gallery",
      access_key_id: "key",
      force_path_style: false,
      root_path: "/images",
      public_base_url: "https://cdn.example.com",
      connect_timeout_seconds: 15,
      idle_timeout_seconds: 15,
      task_timeout_seconds: 300,
      secret_access_key_configured: false
    }
  } satisfies StorageBackendAdmin;
  assert.deepEqual(storageBackendS3FormSettings(), {
    endpoint: "",
    region: "auto",
    bucket: "",
    access_key_id: "",
    force_path_style: true,
    root_path: "/",
    public_base_url: "",
    connect_timeout_seconds: 15,
    idle_timeout_seconds: 15,
    task_timeout_seconds: 300,
    secret_access_key: ""
  });
  const unchanged = storageBackendS3FormSettings(backend);
  assert.equal("secret_access_key_configured" in unchanged, false);
  assert.deepEqual(storageBackendEditConfigPatch(backend, unchanged), {});

  const presentationPatch = storageBackendEditConfigPatch(backend, {
    ...unchanged,
    public_base_url: "https://assets.example.com"
  });
  assert.deepEqual(
    { display_name: backend.display_name, ...presentationPatch },
    {
      display_name: "Archive",
      s3: { public_base_url: "https://assets.example.com" }
    },
    "保存请求不应重新发送未变化配置或空 Secret"
  );
  assert.deepEqual(
    { slug: backend.slug, ...presentationPatch },
    {
      slug: "archive",
      s3: { public_base_url: "https://assets.example.com" }
    },
    "连接测试应复用同一个差异 patch"
  );
  const credentialPatch = storageBackendEditConfigPatch(backend, {
    ...unchanged,
    secret_access_key: "replacement"
  });
  assert.deepEqual(credentialPatch, {
    s3: { secret_access_key: "replacement" }
  });
  const afterSave = storageBackendS3AfterSuccessfulSave({
    ...unchanged,
    secret_access_key: "replacement"
  });
  const refreshedBackend = {
    ...backend,
    s3: { ...backend.s3, secret_access_key_configured: true }
  };
  assert.equal(afterSave.secret_access_key, "");
  assert.deepEqual(
    storageBackendEditConfigPatch(refreshedBackend, afterSave),
    {},
    "Secret false→true 刷新后再次保存或测试不应发送只读标记或明文凭据"
  );
});
test("图片回收站永久删除确认区分已选与全部范围", () => {
  const manyPurge = imageAdminConfirmationCopy({
    kind: "purge",
    request: { scope: "selected", ids: ["one", "two"] }
  });
  const allPurge = imageAdminConfirmationCopy({
    kind: "purge",
    request: { scope: "all" }
  });

  assert.equal(manyPurge?.title, "确认删除已选图片");
  assert.match(manyPurge?.description ?? "", /2 张/);
  assert.equal(manyPurge?.label, "永久删除");
  assert.equal(allPurge?.title, "确认清空回收站");
  assert.match(allPurge?.description ?? "", /之后才移入回收站/);
  assert.equal(allPurge?.label, "永久删除");
});

test("单图移入回收站按钮必须在同一按钮上点击两次才执行", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
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
    const { TwoStepConfirmIconButton } = await import(
      "../../packages/web/src/components/actions/TwoStepConfirmIconButton.tsx"
    );
    const { ADMIN_ICONS } = await import(
      "../../packages/web/src/components/icon/admin-icons.generated.ts"
    );
    let confirmed = 0;
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(TwoStepConfirmIconButton, {
        idleIcon: "delete-bin-6-line",
        confirmIcon: "delete-bin-2-line",
        busyIcon: "delete-bin-5-line",
        idleLabel: "删除图片",
        confirmLabel: "再次点击确认删除图片",
        busyLabel: "删除中",
        onConfirm: () => { confirmed += 1; }
      }));
      await Promise.resolve();
    });
    const button = container.querySelector("button");
    assert.ok(button);
    await React.act(async () => {
      button.dispatchEvent(new window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.equal(confirmed, 0);
    assert.equal(button.getAttribute("aria-pressed"), "true");
    assert.equal(button.getAttribute("aria-label"), "再次点击确认删除图片");
    await React.act(async () => {
      button.dispatchEvent(new window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.equal(confirmed, 1);
    assert.equal(button.getAttribute("aria-pressed"), "false");
    await React.act(async () => {
      button.dispatchEvent(new window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.equal(button.getAttribute("aria-pressed"), "true");
    await React.act(async () => {
      document.body.dispatchEvent(new window.Event("pointerdown", {
        bubbles: true
      }));
      await Promise.resolve();
    });
    assert.equal(
      button.getAttribute("aria-pressed"),
      "false",
      "外部 pointerdown 必须解除无计时二次确认"
    );
    await React.act(async () => {
      button.dispatchEvent(new window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.equal(confirmed, 1, "解除后下一次点击只能重新 armed");
    await React.act(async () => {
      root.render(React.createElement(TwoStepConfirmIconButton, {
        idleIcon: "delete-bin-6-line",
        confirmIcon: "delete-bin-2-line",
        busyIcon: "delete-bin-5-line",
        idleLabel: "删除图片",
        confirmLabel: "再次点击确认删除图片",
        busyLabel: "删除中",
        busy: true,
        disabled: true,
        onConfirm: () => { confirmed += 1; }
      }));
      await Promise.resolve();
    });
    assert.equal(button.getAttribute("aria-label"), "删除中");
    assert.equal(
      button.querySelector("path")?.getAttribute("d"),
      ADMIN_ICONS["delete-bin-5-line"]
    );
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

test("认证过期事件在同一在途窗口只触发一次权威刷新", async () => {
  const coordinator = new AuthSessionRefreshCoordinator();
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let refreshCount = 0;
  const refresh = async () => {
    refreshCount += 1;
    await refreshGate;
  };

  const first = coordinator.run(refresh);
  const second = coordinator.run(refresh);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(refreshCount, 1);
  releaseRefresh();
  await Promise.all([first, second]);

  await coordinator.run(async () => {
    refreshCount += 1;
  });
  assert.equal(refreshCount, 2);
});

test("认证刷新失败后会释放在途状态并允许成功重试", async () => {
  const coordinator = new AuthSessionRefreshCoordinator();
  let refreshCount = 0;

  await assert.rejects(
    coordinator.run(async () => {
      refreshCount += 1;
      throw new Error("refresh failed");
    }),
    /refresh failed/
  );

  await coordinator.run(async () => {
    refreshCount += 1;
  });
  assert.equal(refreshCount, 2);
});

test("认证会话恢复保持最新刷新并只注册一个过期监听器", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const localStorageValues = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageValues.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageValues.delete(key);
    }
  };
  Object.assign(window, { localStorage });

  const activeAuthListeners = new Set<EventListenerOrEventListenerObject>();
  let authListenerAdds = 0;
  let authListenerRemoves = 0;
  const addWindowEventListener = window.addEventListener.bind(window);
  const removeWindowEventListener = window.removeEventListener.bind(window);
  window.addEventListener = ((type, listener, options) => {
    if (type === authExpiredEvent) {
      authListenerAdds += 1;
      activeAuthListeners.add(listener);
    }
    addWindowEventListener(type, listener, options);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((type, listener, options) => {
    if (type === authExpiredEvent) {
      authListenerRemoves += 1;
      activeAuthListeners.delete(listener);
    }
    removeWindowEventListener(type, listener, options);
  }) as typeof window.removeEventListener;

  let fetchCount = 0;
  const fetchStub = async (input: RequestInfo | URL) => {
    assert.equal(String(input), "/api/admin/auth/me");
    fetchCount += 1;
    return new Response(JSON.stringify({
      ok: true,
      authenticated: true,
      username: `auth-recovery-${fetchCount}`,
      role: "super",
      permissions: [],
      csrf_token: `csrf-${fetchCount}`,
      application_version: "current-test",
      preferences: {},
      preferences_etag: `W/"auth-recovery-preferences-${fetchCount}"`,
      version_settings: { enabled: true, link_enabled: true }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
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
    localStorage,
    fetch: fetchStub,
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
    const { MemoryRouter } = await import("react-router");
    const { AuthSessionProvider, useAuthMe } = await import(
      "../../packages/web/src/hooks/useAuthSession.tsx"
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);

    let authIsFetching = true;
    function AuthProbe() {
      const query = useAuthMe();
      authIsFetching = query.isFetching;
      return React.createElement(
        "span",
        null,
        query.data?.authenticated ? query.data.username : "pending"
      );
    }
    const tree = () => React.createElement(
      React.StrictMode,
      null,
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/admin"] },
          React.createElement(
            AuthSessionProvider,
            null,
            React.createElement(AuthProbe)
          )
        )
      )
    );
    const settleUntil = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        if (predicate()) return;
      }
      assert.fail(
        "auth session recovery did not settle: "
          + `text=${container.textContent} fetches=${fetchCount} `
          + `listeners=${activeAuthListeners.size}`
      );
    };

    await React.act(async () => root.render(tree()));
    await settleUntil(() => (
      !authIsFetching
      && container.textContent === `auth-recovery-${fetchCount}`
    ));
    const initialFetchCount = fetchCount;
    assert.ok(initialFetchCount >= 1);
    assert.equal(activeAuthListeners.size, 1);
    const listenerCountsAfterMount = {
      adds: authListenerAdds,
      removes: authListenerRemoves
    };

    await React.act(async () => root.render(tree()));
    assert.deepEqual({
      adds: authListenerAdds,
      removes: authListenerRemoves
    }, listenerCountsAfterMount, "普通重渲染不得重绑认证过期监听器");

    await React.act(async () => {
      window.dispatchEvent(new window.Event(authExpiredEvent));
      window.dispatchEvent(new window.Event(authExpiredEvent));
      await Promise.resolve();
    });
    await settleUntil(() => (
      !authIsFetching
      && fetchCount === initialFetchCount + 1
      && container.textContent === `auth-recovery-${fetchCount}`
    ));
    assert.equal(
      fetchCount,
      initialFetchCount + 1,
      "同一在途窗口的过期事件应合并为一次最新 refetch"
    );
    assert.equal(activeAuthListeners.size, 1);
    assert.deepEqual({
      adds: authListenerAdds,
      removes: authListenerRemoves
    }, listenerCountsAfterMount);

    await React.act(async () => root.unmount());
    assert.equal(activeAuthListeners.size, 0);
    assert.equal(authListenerRemoves, authListenerAdds);
    window.dispatchEvent(new window.Event(authExpiredEvent));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(fetchCount, initialFetchCount + 1, "卸载后不得保留认证刷新入口");
    client.clear();
  } finally {
    clearCsrfToken();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

test("缩略图真实挂载只请求一次并忽略快速换源的迟到结果", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body></body></html>"
  );
  const React = await import("react");
  const requestAnimationFrame = (callback: FrameRequestCallback) => (
    setTimeout(() => callback(Date.now()), 0) as unknown as number
  );
  const cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  Object.assign(window, { requestAnimationFrame, cancelAnimationFrame });

  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLImageElement: window.HTMLImageElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame,
    cancelAnimationFrame,
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

  const imagePrototype = window.HTMLImageElement.prototype;
  const originalSetAttribute = imagePrototype.setAttribute;
  const sourceWrites: string[] = [];
  imagePrototype.setAttribute = function setAttribute(name, value) {
    if (name.toLowerCase() === "src") sourceWrites.push(String(value));
    return originalSetAttribute.call(this, name, value);
  };

  try {
    const { createRoot } = await import("react-dom/client");
    const { flushSync } = await import("react-dom");
    const { ThumbImage } = await import(
      "../../packages/web/src/components/image/ThumbImage.tsx"
    );

    const settleReact = async () => {
      await Promise.resolve();
      await Promise.resolve();
    };
    const imageWithSource = (container: HTMLElement, source: string) => (
      [...container.querySelectorAll("img")].find(
        (image) => image.getAttribute("src") === source
      )
    );

    for (const lateOutcome of ["load", "error"] as const) {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const prefix = `https://static.example.test/${lateOutcome}`;
      const sourceA = `${prefix}-a.webp`;
      const sourceB = `${prefix}-b.webp`;
      const sourceC = `${prefix}-c.webp`;
      const startWrite = sourceWrites.length;
      const renderThumb = (source: string) => React.createElement(
        React.StrictMode,
        null,
        React.createElement(ThumbImage, { src: source, alt: "测试缩略图" })
      );

      await React.act(async () => {
        root.render(renderThumb(sourceA));
        await settleReact();
      });
      const imageA = imageWithSource(container, sourceA);
      assert.ok(imageA);
      await React.act(async () => {
        imageA.dispatchEvent(new window.Event("load"));
        await settleReact();
      });
      assert.equal(
        container.querySelector("img.is-ready")?.getAttribute("src"),
        sourceA
      );

      await React.act(async () => {
        root.render(renderThumb(sourceB));
        await settleReact();
      });
      const imageB = imageWithSource(container, sourceB);
      assert.ok(imageB);

      await React.act(async () => {
        imageB.dispatchEvent(new window.Event(lateOutcome));
        flushSync(() => root.render(renderThumb(sourceC)));
        await settleReact();
      });
      assert.equal(
        container.querySelector("img.is-ready")?.getAttribute("src"),
        sourceA
      );
      const imageC = imageWithSource(container, sourceC);
      assert.ok(imageC);
      assert.deepEqual(
        sourceWrites.slice(startWrite),
        [sourceA, sourceB, sourceC]
      );

      await React.act(async () => {
        imageC.dispatchEvent(new window.Event("load"));
        await settleReact();
      });
      assert.equal(
        container.querySelector("img.is-ready")?.getAttribute("src"),
        sourceC
      );
      assert.equal(container.querySelectorAll("img").length, 1);

      await React.act(async () => root.unmount());
      container.remove();
    }
  } finally {
    imagePrototype.setAttribute = originalSetAttribute;
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

test("ready cache 检查面板区分当前数量与完整重建进度时间", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { ReadyImageCachePanel } = await import(
    "../../packages/web/src/pages/admin/check/ReadyImageCachePanel.tsx"
  );
  const { readyImageProjectionUsage } = await import(
    "../../packages/web/src/pages/admin/check/check-redis-inspection.ts"
  );
  const { registerHooks } = await import("node:module");
  const cssHooks = registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith(".css")) {
        return { format: "module", source: "", shortCircuit: true };
      }
      return nextLoad(url, context);
    }
  });
  const { ReadyImageCacheMaintenancePanel } = await import(
    "../../packages/web/src/pages/admin/check/CheckMaintenanceCapability.tsx"
  ).finally(() => cssHooks.deregister());
  const previousReact = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", {
    configurable: true,
    writable: true,
    value: React
  });
  try {
  const projection = {
    readable: true,
    rebuilding: false,
    synchronized: true,
    state: "ready",
    reason: "ready",
    authoritative_revision: "17",
    applied_revision: "17",
    item_count: 123,
    processed: null,
    total: null,
    last_updated_at: "2026-08-11T00:00:04.000Z",
    full_rebuild_started_at: "2026-08-11T00:00:01.000Z",
    full_rebuild_completed_at: "2026-08-11T00:00:02.500Z",
    full_rebuild_duration_ms: 1_500,
    last_full_rebuild_core_memory_bytes: 4_404_019,
    last_full_rebuild_measured_at: "2026-08-11T00:00:02.400Z",
    recent_errors: {
      core: {
        category: "core" as const,
        code: "controlled_error",
        message: "受控的最近错误",
        occurred_at: "2026-08-11T00:00:03.000Z"
      },
      derived: null
    }
  };
  const query = {
    data: {
      postgresql: {
        status: "ok",
        data: {
          connection: "connected",
          version: "18",
          latency_ms: 1,
          ready_images: 123,
          total_images: 123,
          authoritative_revision: "17",
          abnormal_jobs: 0
        },
        error: null
      },
      redis: {
        status: "ok",
        data: {
          connection: "connected",
          version: "8",
          configured_db: 0,
          latency_ms: 1,
          memory: {
            scope: "redis_instance",
            used_memory_bytes: 456,
            used_memory_rss_bytes: 789,
            fragmentation_ratio: 1
          },
          image_projection: projection
        },
        error: null
      }
    },
    dataUpdatedAt: 1,
    error: null,
    isError: false,
    isFetching: false,
    isSuccess: true,
    refetch: async () => ({ isSuccess: true })
  };
  const readOnlyHtml = renderToStaticMarkup(React.createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    React.createElement(ReadyImageCachePanel, {
      query: query as never
    })
  ));
  assert.doesNotMatch(readOnlyHtml, /重建图片投影/);

  const html = renderToStaticMarkup(React.createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    React.createElement(ReadyImageCacheMaintenancePanel, {
      query: query as never
    })
  ));

  for (const visible of [
    "状态",
    "图片数量",
    "123",
    "最后更新时间",
    "完整重建开始时间",
    "完整重建完成时间",
    "完整重建耗时",
    "1.5 秒",
    "数据库 revision 指纹",
    "Redis revision 指纹",
    "核心投影",
    "123 个图片成员",
    "4.2 MB",
    "派生缓存",
    "受控的最近错误",
    "重建图片投影"
  ]) {
    assert.match(html, new RegExp(visible));
  }
  assert.doesNotMatch(html, /完整重建进度/);
  assert.doesNotMatch(html, /123\s*\/\s*123/);
  assert.match(html, /最近完整重建快照/);
  assert.match(html, /完成 Redis 检测后显示当前派生缓存占用/);

  const detectingHtml = renderToStaticMarkup(React.createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    React.createElement(ReadyImageCachePanel, {
      query: query as never,
      projectionUsageNotice: "正在后台自动检测当前 Redis 占用。"
    })
  ));
  assert.match(detectingHtml, /正在后台自动检测当前 Redis 占用/);
  assert.match(detectingHtml, /aria-busy="true"/);

  const deepHtml = renderToStaticMarkup(React.createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    React.createElement(ReadyImageCachePanel, {
      query: query as never,
      projectionUsage: {
        measured_at: "2026-08-11T00:00:05.000Z",
        core: {
          key_count: 8,
          memory_bytes: 8_192
        },
        derived: {
          key_count: 3,
          member_count: 41,
          memory_bytes: 2_048
        }
      }
    })
  ));
  assert.match(deepHtml, /8 个键/);
  assert.match(deepHtml, /123 个图片成员/);
  assert.doesNotMatch(deepHtml, /456 个图片/);
  assert.match(deepHtml, /8.0 KB/);
  assert.match(deepHtml, /3 个键/);
  assert.match(deepHtml, /41 个结果成员/);
  assert.match(deepHtml, /2.0 KB/);
  assert.match(deepHtml, /最近一次完整 Redis 深检快照/);

  const deepResult = {
    ok: true,
    deep_inspection: {
      complete: true,
      source: "deep",
      measured_at: "2026-08-11T00:00:05.000Z",
      image_projection_usage: {
        core: {
          key_count: 8,
          member_count: 456,
          memory_bytes: 8_192
        },
        derived: {
          key_count: 3,
          member_count: 41,
          memory_bytes: 2_048
        }
      }
    }
  };
  assert.deepEqual(
    readyImageProjectionUsage(deepResult, "redis"),
    {
      measured_at: "2026-08-11T00:00:05.000Z",
      core: { key_count: 8, memory_bytes: 8_192 },
      derived: { key_count: 3, member_count: 41, memory_bytes: 2_048 }
    }
  );
  assert.deepEqual(
    readyImageProjectionUsage({
      redis: { status: "ok", data: deepResult }
    }, "all"),
    readyImageProjectionUsage(deepResult, "redis")
  );
  assert.equal(
    readyImageProjectionUsage({
      ...deepResult,
      deep_inspection: {
        ...deepResult.deep_inspection,
        complete: false
      }
    }, "redis"),
    null
  );

  const rebuildingProjection = {
    ...projection,
    readable: false,
    rebuilding: true,
    synchronized: false,
    state: "rebuilding",
    reason: "rebuilding",
    item_count: 41,
    processed: 41,
    total: 123,
    full_rebuild_completed_at: null,
    full_rebuild_duration_ms: null
  };
  const rebuildingHtml = renderToStaticMarkup(React.createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    React.createElement(ReadyImageCachePanel, {
      query: {
        ...query,
        data: {
          ...query.data,
          redis: {
            ...query.data.redis,
            data: {
              ...query.data.redis.data,
              image_projection: rebuildingProjection
            }
          }
        }
      } as never
    })
  ));
  assert.match(rebuildingHtml, /完整重建进度/);
  assert.match(rebuildingHtml, /41\s*\/\s*123/);
  } finally {
    if (previousReact) {
      Object.defineProperty(globalThis, "React", previousReact);
    } else {
      delete (globalThis as Record<string, unknown>).React;
    }
  }
});

test("自动 Redis 占用检测在 Strict Mode 单飞并在重新进入时重测", async () => {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { useAdminRedisInspection } = await import(
    "../../packages/web/src/pages/admin/check/check-redis-inspection.ts"
  );
  const { document, window } = parseHTML(
    "<!doctype html><html><body><div id=\"root\"></div></body></html>"
  );
  let fetchCount = 0;
  let resolveFirstFetch!: (response: Response) => void;
  const firstFetch = new Promise<Response>((resolve) => {
    resolveFirstFetch = resolve;
  });
  const responseBody = JSON.stringify({
    ok: true,
    deep_inspection: {
      complete: true,
      source: "deep",
      measured_at: "2026-08-11T00:00:05.000Z",
      image_projection_usage: {
        core: { key_count: 8, member_count: 123, memory_bytes: 8_192 },
        derived: { key_count: 0, member_count: 0, memory_bytes: 0 }
      }
    }
  });
  const fetchStub = (input: RequestInfo | URL) => {
    assert.equal(String(input), "/api/admin/check/redis");
    fetchCount += 1;
    return fetchCount === 1
      ? firstFetch
      : Promise.resolve(new Response(responseBody, {
          status: 200,
          headers: { "content-type": "application/json" }
        }));
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
    fetch: fetchStub,
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

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  const container = document.getElementById("root");
  assert.ok(container);
  function Probe() {
    const query = useAdminRedisInspection();
    return React.createElement(
      "span",
      null,
      query.isSuccess ? "complete" : "pending"
    );
  }
  const renderProbe = () => React.createElement(
    React.StrictMode,
    null,
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(Probe)
    )
  );
  const settleUntil = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (predicate()) return;
    }
    assert.fail("Redis inspection query did not settle");
  };

  try {
    const firstRoot = createRoot(container);
    await React.act(async () => {
      firstRoot.render(renderProbe());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(fetchCount, 1);

    await React.act(async () => {
      resolveFirstFetch(new Response(responseBody, {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    });
    await settleUntil(() => container.textContent === "complete");
    assert.equal(container.textContent, "complete");
    assert.equal(fetchCount, 1);
    await React.act(async () => firstRoot.unmount());

    const secondRoot = createRoot(container);
    await React.act(async () => {
      secondRoot.render(renderProbe());
    });
    await settleUntil(() => (
      container.textContent === "complete" && fetchCount === 2
    ));
    assert.equal(container.textContent, "complete");
    assert.equal(fetchCount, 2);
    await React.act(async () => secondRoot.unmount());
  } finally {
    client.clear();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

test("存储维护直接合并存储对象与持久彻底删除任务预览", async () => {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { document, window } = parseHTML(
    "<!doctype html><html><body><div id=\"root\"></div></body></html>"
  );
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL("https://imageshow.test/admin/check")
  });
  Object.assign(window, {
    requestAnimationFrame: (callback: FrameRequestCallback) => (
      setTimeout(() => callback(Date.now()), 0) as unknown as number
    ),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    scrollTo() {},
    innerWidth: 1280,
    innerHeight: 720
  });
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const getClientRectsDescriptor = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    "getClientRects"
  );
  Object.defineProperty(window.HTMLElement.prototype, "getClientRects", {
    configurable: true,
    value: () => []
  });
  const storageResult = {
    ok: true,
    missing_objects: [],
    missing_thumbs: [],
    pending_thumbnail_repairs: [],
    orphan_objects: [],
    orphan_thumbs: [],
    active_staging_files: [],
    retained_staging_files: [],
    orphan_staging_files: [],
    incomplete_listings: [],
    unavailable_backends: []
  };
  const trashResult = {
    ok: true,
    deleted_count: 5,
    unqueued_count: 2,
    purge_pending_count: 3,
    job_counts: { pending: 0, running: 1, retrying: 0, exhausted: 2 },
    jobs: [],
    issues: [
      {
        kind: "missing_job_reference",
        count: 2,
        sample_ids: []
      },
      {
        kind: "stalled_job",
        count: 1,
        sample_ids: []
      }
    ],
    candidates: []
  };
  let trashResponse: unknown = trashResult;
  const requestPaths: string[] = [];
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
    fetch: async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/logs/client-errors")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      requestPaths.push(path);
      const data = path.endsWith("/check/storage")
        ? storageResult
        : path.endsWith("/check/trash")
          ? trashResponse
          : null;
      assert.ok(data, `unexpected request: ${path}`);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    },
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

  const { registerHooks } = await import("node:module");
  const cssHooks = registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith(".css")) {
        return { format: "module", source: "", shortCircuit: true };
      }
      return nextLoad(url, context);
    }
  });
  const { CheckStorageMaintenanceActions } = await import(
    "../../packages/web/src/pages/admin/check/CheckMaintenanceCapability.tsx"
  ).finally(() => cssHooks.deregister());
  const checkNames: string[] = [];
  const published: unknown[] = [];
  let showStorageCount = 0;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  const container = document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const click = async (target: HTMLElement) => {
    await React.act(async () => {
      target.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await settle();
    });
  };

  try {
    await React.act(async () => {
      root.render(React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(CheckStorageMaintenanceActions, {
          canMaintainStorage: true,
          canMigrateStorage: false,
          running: "",
          onPublishResult(value: unknown) {
            published.push(value);
          },
          async onRunCheck(name: string) {
            checkNames.push(name);
            return null;
          },
          onRunningChange() {},
          onShowStorage() {
            showStorageCount += 1;
          }
        })
      ));
      await settle();
    });

    const topLevelButtons = [...container.querySelectorAll<HTMLButtonElement>(
      "button"
    )];
    const maintenanceButton = topLevelButtons.find((button) => (
      button.textContent?.includes("存储维护")
    ));
    assert.ok(maintenanceButton);
    await click(maintenanceButton);
    assert.deepEqual(
      requestPaths.toSorted(),
      [
        "/api/admin/check/storage",
        "/api/admin/check/trash"
      ].toSorted()
    );
    assert.deepEqual(checkNames, []);
    assert.equal(showStorageCount, 1);
    assert.equal(published.length, 1);
    assert.deepEqual(published[0], {
      storage: storageResult,
      trash: trashResult
    });
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.ok(document.querySelector(
      '[role="dialog"][aria-label="存储维护"]'
    ));
    assert.match(document.body.textContent ?? "", /持久彻底删除任务/);
    assert.match(document.body.textContent ?? "", /将重试耗尽任务2/);
    assert.match(document.body.textContent ?? "", /将修复异常引用2/);
    assert.match(document.body.textContent ?? "", /停滞任务只报告/);

    const cancelButton = [...document.querySelectorAll<HTMLButtonElement>(
      '[role="dialog"] button'
    )].find((button) => button.textContent?.trim() === "取消");
    assert.ok(cancelButton);
    await click(cancelButton);
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    assert.equal(document.querySelector('[role="dialog"]') === null, true);

    trashResponse = { ...trashResult, job_counts: undefined };
    await click(maintenanceButton);
    assert.equal(
      document.querySelector('[role="dialog"]') === null,
      true,
      "缺失任务计数的响应必须走预览失败分支，而不是在渲染时崩溃"
    );
    assert.deepEqual(published.at(-1), {
      ok: false,
      error: "存储维护预览失败，请稍后重试"
    });
  } finally {
    await React.act(async () => root.unmount());
    await React.act(async () => settle());
    client.clear();
    if (getClientRectsDescriptor) {
      Object.defineProperty(
        window.HTMLElement.prototype,
        "getClientRects",
        getClientRectsDescriptor
      );
    } else {
      delete (window.HTMLElement.prototype as unknown as Record<
        string,
        unknown
      >).getClientRects;
    }
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

test("检查页保留完整 Redis 快照并串行化自动检测与全部检查", async () => {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { MemoryRouter } = await import("react-router");
  const { AuthSessionProvider } = await import(
    "../../packages/web/src/hooks/useAuthSession.tsx"
  );
  const { registerHooks } = await import("node:module");
  const cssHooks = registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith(".css")) {
        return { format: "module", source: "", shortCircuit: true };
      }
      return nextLoad(url, context);
    }
  });
  const { CheckPage } = await import(
    "../../packages/web/src/pages/admin/check/CheckPage.tsx"
  ).finally(() => cssHooks.deregister());
  const { document, window } = parseHTML(
    "<!doctype html><html><body><div id=\"root\"></div></body></html>"
  );

  const projection = (rebuilding = false) => ({
    readable: !rebuilding,
    rebuilding,
    synchronized: rebuilding ? false : true,
    state: rebuilding ? "rebuilding" : "ready",
    reason: rebuilding ? "rebuilding" : "ready",
    authoritative_revision: "17",
    applied_revision: rebuilding ? "16" : "17",
    item_count: 124,
    processed: rebuilding ? 62 : null,
    total: rebuilding ? 124 : null,
    last_updated_at: "2026-08-11T00:00:04.000Z",
    full_rebuild_started_at: "2026-08-11T00:00:01.000Z",
    full_rebuild_completed_at: rebuilding
      ? null
      : "2026-08-11T00:00:02.500Z",
    full_rebuild_duration_ms: rebuilding ? null : 1_500,
    last_full_rebuild_core_memory_bytes: 4_404_019,
    last_full_rebuild_measured_at: "2026-08-11T00:00:02.400Z",
    recent_errors: { core: null, derived: null }
  });
  const statusResult = (rebuilding = false) => ({
    postgresql: {
      status: "ok",
      data: {
        connection: "connected",
        version: "18",
        latency_ms: 1,
        ready_images: 124,
        total_images: 124,
        authoritative_revision: "17",
        abnormal_jobs: 0
      },
      error: null
    },
    redis: {
      status: "ok",
      data: {
        connection: "connected",
        version: "8",
        configured_db: 0,
        latency_ms: 1,
        memory: {
          scope: "redis_instance",
          used_memory_bytes: 456,
          used_memory_rss_bytes: 789,
          fragmentation_ratio: 1
        },
        image_projection: projection(rebuilding)
      },
      error: null
    }
  });
  const redisResult = (
    measuredAt: string,
    memoryBytes: number,
    complete = true
  ) => ({
    ok: true,
    deep_inspection: {
      complete,
      source: "deep",
      measured_at: measuredAt,
      image_projection_usage: {
        core: {
          key_count: 8,
          member_count: 124,
          memory_bytes: memoryBytes
        },
        derived: { key_count: 0, member_count: 0, memory_bytes: 0 }
      }
    }
  });
  const allResult = {
    ok: true,
    postgresql: { status: "ok", data: {} },
    redis: {
      status: "ok",
      data: redisResult("2026-08-11T00:00:07.000Z", 16_384)
    },
    storage: { status: "ok", data: {} },
    trash: { status: "ok", data: {} }
  };
  const trashResult = {
    deleted_count: 1,
    unqueued_count: 1,
    purge_pending_count: 0,
    job_counts: { pending: 0, running: 0, retrying: 0, exhausted: 0 },
    jobs: [],
    issues: [],
    candidates: [{
      id: "00000000-0000-7000-8000-000000000001",
      object_key: "01/00000000-0000-7000-8000-000000000001.webp",
      deleted_at: "2026-08-11T00:00:03.000Z",
      purge_pending: false
    }]
  };
  let resolveStatus!: (response: Response) => void;
  let resolveAutomaticRedis!: (response: Response) => void;
  let resolvePartialRedis!: (response: Response) => void;
  let resolveAll!: (response: Response) => void;
  const statusResponse = new Promise<Response>((resolve) => {
    resolveStatus = resolve;
  });
  const automaticRedisResponse = new Promise<Response>((resolve) => {
    resolveAutomaticRedis = resolve;
  });
  const partialRedisResponse = new Promise<Response>((resolve) => {
    resolvePartialRedis = resolve;
  });
  const allResponse = new Promise<Response>((resolve) => {
    resolveAll = resolve;
  });
  let redisRequests = 0;
  let allRequests = 0;
  let trashRequests = 0;
  const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  const fetchStub = (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/admin/check/status") return statusResponse;
    if (path === "/api/admin/check/redis") {
      redisRequests += 1;
      if (redisRequests === 1) return automaticRedisResponse;
      if (redisRequests === 2) return partialRedisResponse;
      throw new Error(`unexpected Redis inspection ${redisRequests}`);
    }
    if (path === "/api/admin/check/all") {
      allRequests += 1;
      return allResponse;
    }
    if (path === "/api/admin/check/trash") {
      trashRequests += 1;
      return Promise.resolve(jsonResponse(trashResult));
    }
    throw new Error(`unexpected request ${path}`);
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
    fetch: fetchStub,
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

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  client.setQueryData(["me"], {
    authenticated: true,
    username: "review",
    role: "image",
    permissions: [],
    csrf_token: "test-token",
    application_version: "current-build",
    preferences: {},
    preferences_etag: 'W/"review-preferences"',
    version_settings: {}
  });
  const container = document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const button = (label: string) => {
    const match = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.includes(label)
    );
    assert.ok(match, `missing ${label} button`);
    return match as HTMLButtonElement;
  };
  const click = async (target: HTMLButtonElement) => {
    await React.act(async () => {
      target.dispatchEvent(new window.Event("click", { bubbles: true }));
      await settle();
    });
  };

  try {
    await React.act(async () => {
      root.render(React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/admin/check"] },
          React.createElement(
            AuthSessionProvider,
            null,
            React.createElement(CheckPage)
          )
        )
      ));
      await settle();
    });

    assert.equal(button("全部").disabled, true);
    assert.equal(allRequests, 0);
    assert.equal(redisRequests, 0);
    assert.equal(
      [...container.querySelectorAll("button")].some(
        (candidate) => candidate.textContent?.includes("彻底删除维护")
      ),
      false,
      "图片管理员不应加载或显示超级管理员彻底删除维护入口"
    );
    await React.act(async () => {
      resolveStatus(jsonResponse(statusResult()));
      await settle();
    });
    assert.equal(redisRequests, 1);
    assert.equal(button("全部").disabled, true);

    await React.act(async () => {
      resolveAutomaticRedis(jsonResponse(redisResult(
        "2026-08-11T00:00:05.000Z",
        8_192
      )));
      await settle();
    });
    assert.equal(button("全部").disabled, false);
    assert.match(container.textContent ?? "", /8\.0 KB/);

    await click(button("Redis"));
    assert.equal(redisRequests, 2);
    assert.equal(button("全部").disabled, true);
    await React.act(async () => {
      resolvePartialRedis(jsonResponse(redisResult(
        "2026-08-11T00:00:06.000Z",
        4_096,
        false
      )));
      await settle();
    });
    await click(button("状态"));
    assert.match(container.textContent ?? "", /8\.0 KB/);
    assert.ok([...container.querySelectorAll("[title]")].some((element) => (
      element.getAttribute("title")?.includes("本次检测未完成")
      && element.getAttribute("title")?.includes("最近一次完整 Redis 深检快照")
    )));

    await click(button("全部"));
    assert.equal(allRequests, 1);
    await React.act(async () => {
      client.setQueryData(["admin-check-status"], statusResult(true));
      await Promise.resolve();
      client.setQueryData(["admin-check-status"], statusResult(false));
      await settle();
    });
    assert.equal(redisRequests, 2);

    await React.act(async () => {
      resolveAll(jsonResponse(allResult));
      await settle();
    });
    assert.equal(redisRequests, 2);
    assert.match(container.textContent ?? "", /16\.0 KB/);

    await click(button("回收站"));
    assert.equal(trashRequests, 1);
    assert.match(container.textContent ?? "", /未排队数量/);
  } finally {
    await React.act(async () => root.unmount());
    client.clear();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

test("标签可视窗口逐个补齐相邻项目并独占纯纵向滚轮", () => {
  assert.deepEqual(
    tagScrollItemMetrics(747, 5_922, { left: -5_171, width: 117 }, 4),
    { offsetLeft: 0, offsetWidth: 117 },
    "弹窗外层坐标与 viewport 内边距必须归一化到标签内容坐标"
  );
  assert.deepEqual(
    tagScrollContentMetrics({
      clientWidth: 208,
      scrollLeft: 300,
      scrollWidth: 508
    }, 4, 4),
    {
      clientWidth: 200,
      scrollLeft: 300,
      scrollWidth: 500
    },
    "内容模型应同时扣除两侧内边距且保持真实最大 scrollLeft"
  );
  const metrics = {
    clientWidth: 200,
    scrollLeft: 0,
    scrollWidth: 410
  };
  const items = [
    { offsetLeft: 0, offsetWidth: 60 },
    { offsetLeft: 66, offsetWidth: 60 },
    { offsetLeft: 132, offsetWidth: 60 },
    { offsetLeft: 198, offsetWidth: 60 },
    { offsetLeft: 264, offsetWidth: 140 }
  ];
  assert.deepEqual(tagScrollAvailability(metrics), {
    backward: false,
    forward: true
  });
  assert.equal(
    tagScrollNavigationTarget(metrics, items, 1),
    58,
    "前进应以最小位移只补齐首个被右侧遮挡的标签"
  );
  assert.equal(
    tagScrollNavigationTarget({ ...metrics, scrollLeft: 58 }, items, -1),
    0,
    "后退应以最小位移只补齐首个被左侧遮挡的标签"
  );
  const navigationInsets = {
    leading: 14,
    trailing: 14
  };
  assert.equal(
    tagScrollNavigationTarget(metrics, items, 1, navigationInsets),
    7,
    "按钮渐变覆盖了当前末项的一小部分时，应先以最小位移将该项补齐"
  );
  assert.equal(
    tagScrollNavigationTarget(
      { ...metrics, scrollLeft: 58 },
      items,
      1,
      navigationInsets
    ),
    73,
    "继续前进时必须把目标标签完整移出按钮包含半透明渐变在内的覆盖区"
  );
  assert.equal(
    tagScrollNavigationTarget(
      { ...metrics, scrollLeft: 72 },
      items,
      -1,
      navigationInsets
    ),
    51,
    "后退补齐标签时必须把其左边界移出按钮的完整覆盖区"
  );
  assert.equal(
    tagScrollNavigationTarget(
      { clientWidth: 200, scrollLeft: 526, scrollWidth: 726 },
      [
        ...items,
        { offsetLeft: 500, offsetWidth: 140 },
        { offsetLeft: 646, offsetWidth: 80 }
      ],
      -1
    ),
    500,
    "末端输入恰好对齐时应以最小位移完整显示前一个标签"
  );
  const wideMetrics = {
    clientWidth: 200,
    scrollLeft: 0,
    scrollWidth: 490
  };
  const wideItems = [
    { offsetLeft: 0, offsetWidth: 400 },
    { offsetLeft: 406, offsetWidth: 80 }
  ];
  assert.equal(
    tagScrollNavigationTarget(wideMetrics, wideItems, 1),
    200,
    "超宽首项应先显示连续中段，不能只移动内边距"
  );
  assert.equal(
    tagScrollNavigationTarget(
      { ...wideMetrics, scrollLeft: 200 },
      wideItems,
      1
    ),
    286,
    "超宽首项末端已对齐后应以最小位移补齐尾部输入组"
  );
  assert.equal(
    tagScrollNavigationTarget(
      { ...wideMetrics, scrollLeft: 290 },
      wideItems,
      -1
    ),
    200,
    "从尾部后退应先对齐超宽项末端"
  );
  assert.equal(
    tagScrollNavigationTarget(
      { ...wideMetrics, scrollLeft: 200 },
      wideItems,
      -1
    ),
    0,
    "超宽项第二次后退应回到其起始边界"
  );
  const extraWideMetrics = {
    clientWidth: 200,
    scrollLeft: 0,
    scrollWidth: 690
  };
  const extraWideItems = [
    { offsetLeft: 0, offsetWidth: 600 },
    { offsetLeft: 606, offsetWidth: 80 }
  ];
  assert.deepEqual(
    [0, 200, 400].map((scrollLeft) => tagScrollNavigationTarget(
      { ...extraWideMetrics, scrollLeft },
      extraWideItems,
      1
    )),
    [200, 400, 486],
    "超过两个 viewport 的标签必须逐屏连续前进后才进入尾部输入组"
  );
  assert.deepEqual(
    [490, 400, 200].map((scrollLeft) => tagScrollNavigationTarget(
      { ...extraWideMetrics, scrollLeft },
      extraWideItems,
      -1
    )),
    [400, 200, 0],
    "超过两个 viewport 的标签必须逐屏连续后退"
  );
  assert.equal(
    tagScrollNavigationTarget(
      tagScrollContentMetrics({
        clientWidth: 208,
        scrollLeft: 300,
        scrollWidth: 508
      }, 4, 4),
      [{ offsetLeft: 250, offsetWidth: 100 }],
      -1
    ),
    250,
    "普通项后退时应以最小位移让左边界落入物理可视区"
  );
  assert.deepEqual(
    tagScrollAvailability({ ...metrics, scrollLeft: 210 }),
    { backward: true, forward: false }
  );
  assert.equal(tagVerticalWheelPixels({
    clientWidth: 200,
    deltaMode: 0,
    deltaX: 0,
    deltaY: 48
  }), 48);
  assert.equal(tagVerticalWheelPixels({
    clientWidth: 200,
    deltaMode: 1,
    deltaX: 0,
    deltaY: -3
  }), -48);
  assert.equal(tagVerticalWheelPixels({
    clientWidth: 200,
    deltaMode: 2,
    deltaX: 0,
    deltaY: 1
  }), 200);
  assert.equal(tagVerticalWheelPixels({
    clientWidth: 200,
    deltaMode: 0,
    deltaX: 0,
    deltaY: 0.5
  }), null, "不足一个像素的纵向噪声不得接管滚轮");
  assert.equal(tagVerticalWheelPixels({
    clientWidth: 200,
    deltaMode: 0,
    deltaX: 0.25,
    deltaY: 30
  }), null, "混合 deltaX/deltaY 应保留触控板原生横向路径");
  assert.equal(tagWheelScrollTarget(metrics, 80), 80);
  assert.equal(
    tagWheelScrollTarget({ ...metrics, scrollLeft: 210 }, 80),
    210,
    "末端纵向滚轮仍应锁定在标签横向边界"
  );
});

test("直接激活在键盘视口中延后目标聚焦并区分保留与释放", async () => {

  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  class TestResizeObserver {
    constructor(_callback: ResizeObserverCallback) {}
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const matchMedia = (query: string) => ({
    matches: query.includes("max-width: 760px"),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true
  });
  let animationFrame = 0;
  const frameTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const requestAnimationFrame = (callback: FrameRequestCallback) => {
    const id = ++animationFrame;
    frameTimers.set(id, setTimeout(() => {
      frameTimers.delete(id);
      callback(0);
    }, 0));
    return id;
  };
  const cancelAnimationFrame = (id: number) => {
    const timer = frameTimers.get(id);
    if (timer) clearTimeout(timer);
    frameTimers.delete(id);
  };
  Object.assign(window, {
    matchMedia,
    requestAnimationFrame,
    cancelAnimationFrame,
    ResizeObserver: TestResizeObserver
  });
  const eventWindow = window as unknown as Window;
  const captureListeners = new Map<
    string,
    Set<EventListenerOrEventListenerObject>
  >();
  const nativeAddEventListener = eventWindow.addEventListener.bind(eventWindow);
  const nativeRemoveEventListener = eventWindow.removeEventListener.bind(eventWindow);
  eventWindow.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ) => {
    const capture = options === true || (
      typeof options === "object" && options.capture === true
    );
    if (listener && capture) {
      const listeners = captureListeners.get(type) ?? new Set();
      listeners.add(listener);
      captureListeners.set(type, listeners);
    }
    nativeAddEventListener(type, listener, options);
  }) as typeof eventWindow.addEventListener;
  eventWindow.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions
  ) => {
    const capture = options === true || (
      typeof options === "object" && options.capture === true
    );
    if (listener && capture) {
      captureListeners.get(type)?.delete(listener);
    }
    nativeRemoveEventListener(type, listener, options);
  }) as typeof eventWindow.removeEventListener;
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
    ResizeObserver: TestResizeObserver,
    requestAnimationFrame,
    cancelAnimationFrame,
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

  const dispatch = (target: Element, type: string, properties: object) => {
    const event = new window.Event(type, {
      bubbles: true,
      cancelable: true
    });
    Object.defineProperties(event, Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [
        key,
        { configurable: true, value }
      ])
    ));
    target.dispatchEvent(event);
    return event;
  };
  const runWindowCapture = (
    target: EventTarget,
    type: string,
    properties: Record<string, unknown>
  ) => {
    let defaultPrevented = false;
    let immediatePropagationStopped = false;
    const event = {
      type,
      target,
      currentTarget: eventWindow,
      cancelable: true,
      ...properties,
      preventDefault() {
        defaultPrevented = true;
      },
      stopPropagation() {},
      stopImmediatePropagation() {
        immediatePropagationStopped = true;
      }
    } as unknown as Event;
    for (const listener of [...(captureListeners.get(type) ?? [])]) {
      if (typeof listener === "function") {
        listener.call(eventWindow, event);
      } else {
        listener.handleEvent(event);
      }
      if (immediatePropagationStopped) break;
    }
    return { defaultPrevented, immediatePropagationStopped };
  };
  const dispatchThroughWindowCapture = (
    target: Element,
    type: string,
    properties: Record<string, unknown>
  ) => {
    const capture = runWindowCapture(target, type, properties);
    if (capture.immediatePropagationStopped) {
      return { ...capture, targetDispatched: false };
    }
    const targetEvent = dispatch(target, type, properties);
    return {
      defaultPrevented: capture.defaultPrevented || targetEvent.defaultPrevented,
      immediatePropagationStopped: false,
      targetDispatched: true
    };
  };

  try {
    const { createRoot } = await import("react-dom/client");
    const { WorkflowCollapsePanel } = await import(
      "../../packages/web/src/components/layout/WorkflowCollapsePanel.tsx"
    );
    const { DirectActivationButton } = await import(
      "../../packages/web/src/components/feedback/DirectActivationButton.tsx"
    );
    const { TagInput } = await import(
      "../../packages/web/src/components/form/TagInput.tsx"
    );

    function Harness() {
      const [expanded, setExpanded] = React.useState(false);
      const [drafts, setDrafts] = React.useState(
        () => Array.from({ length: 200 }, () => false)
      );
      const [applyCount, setApplyCount] = React.useState(0);
      const [targetCount, setTargetCount] = React.useState(0);
      const [tags, setTags] = React.useState<string[]>([]);
      const [targetTags, setTargetTags] = React.useState<string[]>([]);
      const [appliedTags, setAppliedTags] = React.useState<string[]>([]);
      return React.createElement(
        "div",
        null,
        React.createElement(
          WorkflowCollapsePanel,
          {
            className: "extreme-panel",
            contentClassName: "extreme-content",
            title: "批量默认属性",
            summary: `${drafts.filter(Boolean).length} 项已应用`,
            expanded,
            onExpandedChange: setExpanded
          },
          React.createElement(TagInput, {
            className: "active-tag-editor",
            value: tags,
            onChange: setTags,
            suggestions: [],
            ariaLabel: "默认标签"
          }),
          React.createElement(DirectActivationButton, {
            type: "button",
            className: "target-focus-button",
            onActivate: () => {
              setTargetCount((current) => current + 1);
              setTargetTags(tags);
            }
          }, "亮暗不变"),
          React.createElement(DirectActivationButton, {
            type: "button",
            className: "apply-to-all-button",
            onActivate: () => {
              setDrafts((current) => current.map(() => true));
              setApplyCount((current) => current + 1);
              setAppliedTags(tags);
            }
          }, "应用到全部"),
          React.createElement(
            "output",
            { className: "activation-output" },
            `${targetCount}:${applyCount}:${drafts.filter(Boolean).length}`
          ),
          React.createElement(
            "output",
            { className: "settled-output" },
            targetTags.join(",")
          ),
          React.createElement(
            "output",
            { className: "applied-tags-output" },
            appliedTags.join(",")
          )
        ),
        React.createElement("button", {
          type: "button",
          className: "dialog-close-button"
        }, "关闭")
      );
    }

    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    const toggle = document.querySelector<HTMLButtonElement>(
      ".workflow-collapse-toggle"
    );
    const apply = document.querySelector<HTMLButtonElement>(
      ".apply-to-all-button"
    );
    const targetFocusButton = document.querySelector<HTMLButtonElement>(
      ".target-focus-button"
    );
    const editor = document.querySelector<HTMLInputElement>(
      ".active-tag-editor input"
    );
    const dialogClose = document.querySelector<HTMLButtonElement>(
      ".dialog-close-button"
    );
    assert.ok(toggle && apply && targetFocusButton && editor && dialogClose);
    let toggleBlurCount = 0;
    let toggleFocusCount = 0;
    let editorBlurCount = 0;
    let dialogCloseFocusCount = 0;
    let applyFocusCount = 0;
    let targetFocusCount = 0;
    let keyboardOpen = false;
    let activeElement: HTMLElement = document.body;
    Object.defineProperty(document, "activeElement", {
      configurable: true,
      get: () => activeElement
    });
    const nativeToggleBlur = toggle.blur.bind(toggle);
    const nativeToggleFocus = toggle.focus.bind(toggle);
    const nativeEditorBlur = editor.blur.bind(editor);
    const nativeEditorFocus = editor.focus.bind(editor);
    const nativeDialogCloseFocus = dialogClose.focus.bind(dialogClose);
    const nativeApplyFocus = apply.focus.bind(apply);
    const nativeTargetFocus = targetFocusButton.focus.bind(targetFocusButton);
    const settleEditorFocus = (nextTarget: HTMLElement) => {
      if (activeElement !== editor) return;
      dispatch(editor, "focusout", { relatedTarget: nextTarget });
    };
    Object.defineProperty(toggle, "blur", {
      configurable: true,
      value: () => {
        toggleBlurCount += 1;
        if (activeElement === toggle) activeElement = document.body;
        nativeToggleBlur();
      }
    });
    Object.defineProperty(toggle, "focus", {
      configurable: true,
      value: () => {
        toggleFocusCount += 1;
        keyboardOpen = false;
        settleEditorFocus(toggle);
        activeElement = toggle;
        nativeToggleFocus();
      }
    });
    Object.defineProperty(editor, "focus", {
      configurable: true,
      value: () => {
        activeElement = editor;
        nativeEditorFocus();
      }
    });
    Object.defineProperty(editor, "blur", {
      configurable: true,
      value: () => {
        editorBlurCount += 1;
        keyboardOpen = false;
        if (activeElement === editor) activeElement = document.body;
        nativeEditorBlur();
      }
    });
    Object.defineProperty(dialogClose, "focus", {
      configurable: true,
      value: () => {
        dialogCloseFocusCount += 1;
        settleEditorFocus(dialogClose);
        activeElement = dialogClose;
        nativeDialogCloseFocus();
      }
    });
    Object.defineProperty(apply, "focus", {
      configurable: true,
      value: () => {
        applyFocusCount += 1;
        keyboardOpen = false;
        settleEditorFocus(apply);
        activeElement = apply;
        nativeApplyFocus();
      }
    });
    Object.defineProperty(targetFocusButton, "focus", {
      configurable: true,
      value: () => {
        targetFocusCount += 1;
        keyboardOpen = false;
        settleEditorFocus(targetFocusButton);
        activeElement = targetFocusButton;
        nativeTargetFocus();
      }
    });
    Object.defineProperty(toggle, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        const top = keyboardOpen ? 0 : 100;
        return {
          left: 0,
          top,
          right: 320,
          bottom: top + 48,
          width: 320,
          height: 48,
          x: 0,
          y: top,
          toJSON() { return this; }
        };
      }
    });
    Object.defineProperty(targetFocusButton, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        const top = keyboardOpen ? 48 : 148;
        return {
          left: 0,
          top,
          right: 320,
          bottom: top + 48,
          width: 320,
          height: 48,
          x: 0,
          y: top,
          toJSON() { return this; }
        };
      }
    });
    Object.defineProperty(apply, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        const top = keyboardOpen ? 96 : 196;
        return {
          left: 0,
          top,
          right: 320,
          bottom: top + 48,
          width: 320,
          height: 48,
          x: 0,
          y: top,
          toJSON() { return this; }
        };
      }
    });
    const touchProperties = {
      pointerType: "touch",
      pointerId: 7,
      isPrimary: true,
      button: 0,
      clientX: 24,
      clientY: 24
    };

    await React.act(async () => {
      dispatchThroughWindowCapture(toggle, "click", { detail: 1 });
      await Promise.resolve();
    });
    assert.equal(toggle.getAttribute("aria-expanded"), "true");

    editor.focus();
    keyboardOpen = true;
    await React.act(async () => {
      editor.value = "after-blur";
      dispatch(editor, "input", {});
      await Promise.resolve();
    });
    assert.equal(
      document.activeElement === editor,
      true,
      `测试编辑器必须先取得焦点，实际为 ${document.activeElement?.className}`
    );
    const targetTouchProperties = {
      ...touchProperties,
      pointerId: 70,
      clientY: 72
    };
    await React.act(async () => {
      dispatchThroughWindowCapture(
        targetFocusButton,
        "pointerdown",
        targetTouchProperties
      );
      await Promise.resolve();
    });
    assert.equal(targetFocusCount, 0, "目标聚焦策略不得在触控按下时收起键盘");
    assert.equal(keyboardOpen, true);
    assert.equal(
      document.activeElement === editor,
      true,
      `pointerdown 后焦点不得改变，实际为 ${document.activeElement?.className}`
    );
    await React.act(async () => {
      dispatchThroughWindowCapture(
        targetFocusButton,
        "pointerup",
        targetTouchProperties
      );
      await Promise.resolve();
    });
    assert.equal(
      document.querySelector(".activation-output")?.textContent,
      "1:0:0",
      "目标聚焦策略必须先按原位置提交手势再激活动作"
    );
    assert.equal(targetFocusCount, 1);
    assert.equal(keyboardOpen, false);
    assert.equal(document.activeElement === targetFocusButton, true);
    assert.equal(
      document.querySelector(".settled-output")?.textContent,
      "after-blur",
      "目标激活必须读取同次焦点转移已结算的最新草稿"
    );

    editor.focus();
    keyboardOpen = true;
    await React.act(async () => {
      editor.value = "apply-blur";
      dispatch(editor, "input", {});
      await Promise.resolve();
    });

    const applyTouchProperties = {
      ...touchProperties,
      pointerId: 8,
      clientY: 120
    };
    await React.act(async () => {
      dispatchThroughWindowCapture(apply, "pointerdown", applyTouchProperties);
      dispatchThroughWindowCapture(apply, "pointermove", {
        ...applyTouchProperties,
        clientX: 48
      });
      dispatchThroughWindowCapture(apply, "pointerup", {
        ...applyTouchProperties,
        clientX: 48
      });
      await Promise.resolve();
    });
    assert.equal(
      document.querySelector(".activation-output")?.textContent,
      "1:0:0",
      "超过 5px 的移动必须取消应用"
    );
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    const movedRetarget = dispatchThroughWindowCapture(
      toggle,
      "click",
      { detail: 1 }
    );
    assert.deepEqual(movedRetarget, {
      defaultPrevented: true,
      immediatePropagationStopped: true,
      targetDispatched: false
    });
    assert.equal(toggle.getAttribute("aria-expanded"), "true");

    await React.act(async () => {
      dispatchThroughWindowCapture(apply, "pointerdown", {
        ...applyTouchProperties,
        pointerId: 9
      });
      dispatchThroughWindowCapture(apply, "pointercancel", {
        ...applyTouchProperties,
        pointerId: 9
      });
      await Promise.resolve();
    });
    assert.equal(
      document.querySelector(".activation-output")?.textContent,
      "1:0:0",
      "取消手势不得应用"
    );
    const cancelledRetarget = dispatchThroughWindowCapture(
      toggle,
      "click",
      { detail: 1 }
    );
    assert.equal(cancelledRetarget.immediatePropagationStopped, true);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");

    await React.act(async () => {
      dispatchThroughWindowCapture(apply, "pointerdown", {
        ...applyTouchProperties,
        pointerId: 10
      });
      await Promise.resolve();
    });
    assert.equal(applyFocusCount, 0, "应用按钮不得在 pointerdown 转移焦点");
    assert.equal(keyboardOpen, true, "应用按钮按下时必须保持键盘视口");
    assert.equal(document.activeElement === editor, true);
    await React.act(async () => {
      dispatchThroughWindowCapture(apply, "pointerup", {
        ...applyTouchProperties,
        pointerId: 10
      });
      await Promise.resolve();
    });
    assert.equal(
      document.querySelector(".activation-output")?.textContent,
      "1:1:200"
    );
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(applyFocusCount, 1, "应用按钮必须在 pointerup 提交后取得焦点");
    assert.equal(keyboardOpen, false);
    assert.equal(document.activeElement === apply, true);
    assert.equal(
      document.querySelector(".applied-tags-output")?.textContent,
      "after-blur,apply-blur",
      "应用动作必须一次读取 TagInput 失焦结算后的最后标签"
    );

    for (const type of ["mousedown", "mouseup", "click"]) {
      const compatibilityEvent = dispatchThroughWindowCapture(
        toggle,
        type,
        { detail: 1 }
      );
      assert.equal(
        compatibilityEvent.defaultPrevented,
        true,
        `迟到的 ${type} 必须被兼容守卫取消`
      );
      assert.equal(compatibilityEvent.immediatePropagationStopped, true);
      assert.equal(compatibilityEvent.targetDispatched, false);
    }
    assert.equal(
      toggle.getAttribute("aria-expanded"),
      "true",
      "应用后的迟到 click 即使重命中折叠按钮也不得收起面板"
    );

    editor.focus();
    keyboardOpen = true;
    const localHTMLElement = globalThis.HTMLElement;
    Object.defineProperty(globalThis, "HTMLElement", {
      configurable: true,
      writable: true,
      value: class ForeignRealmHTMLElement {}
    });
    try {
      await React.act(async () => {
        dispatchThroughWindowCapture(toggle, "pointerdown", {
          ...touchProperties,
          pointerId: 11
        });
        await Promise.resolve();
      });
      assert.equal(toggleFocusCount, 0, "折叠触控不得在按下阶段转移焦点");
      assert.equal(keyboardOpen, true, "折叠触控按下时必须保持键盘视口");
      assert.equal(document.activeElement === editor, true);
      await React.act(async () => {
        dispatchThroughWindowCapture(toggle, "pointerup", {
          ...touchProperties,
          pointerId: 11
        });
        await Promise.resolve();
      });
    } finally {
      Object.defineProperty(globalThis, "HTMLElement", {
        configurable: true,
        writable: true,
        value: localHTMLElement
      });
    }
    assert.equal(
      toggle.getAttribute("aria-expanded"),
      "false",
      "下一次物理按下必须释放旧守卫并在本次 pointerup 折叠"
    );
    assert.equal(editorBlurCount, 1, "指针折叠提交后必须释放原编辑焦点");
    assert.equal(keyboardOpen, false);
    assert.equal(document.activeElement === editor, false);
    assert.equal(document.activeElement === toggle, false);

    for (const type of ["mousedown", "mouseup", "click"]) {
      const restoredPositionEvent = dispatchThroughWindowCapture(
        dialogClose,
        type,
        { detail: 1 }
      );
      assert.equal(restoredPositionEvent.defaultPrevented, true);
      assert.equal(restoredPositionEvent.immediatePropagationStopped, true);
      assert.equal(restoredPositionEvent.targetDispatched, false);
    }
    assert.equal(
      dialogCloseFocusCount,
      0,
      "视口复位后的迟到兼容序列不得聚焦关闭按钮"
    );

    await React.act(async () => {
      dispatchThroughWindowCapture(toggle, "pointerdown", {
        ...touchProperties,
        pointerId: 12,
        clientY: 124
      });
      await Promise.resolve();
    });
    assert.equal(toggleFocusCount, 0, "目标按钮仍不得在 pointerdown 聚焦");
    await React.act(async () => {
      dispatchThroughWindowCapture(toggle, "pointerup", {
        ...touchProperties,
        pointerId: 12,
        clientY: 124
      });
      await Promise.resolve();
    });
    assert.equal(
      toggle.getAttribute("aria-expanded"),
      "true",
      "新的物理手势必须释放上一手势的旧守卫并正常展开"
    );
    assert.equal(toggleFocusCount, 1, "目标焦点必须在 pointerup 提交后转移");
    assert.equal(document.activeElement === toggle, true);
    assert.equal(toggleBlurCount, 0, "指针展开不能释放焦点");

    await React.act(async () => {
      dispatchThroughWindowCapture(toggle, "click", { detail: 0 });
      await Promise.resolve();
    });
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(toggleBlurCount, 0, "键盘折叠必须保留披露按钮焦点");
    assert.equal(document.activeElement === toggle, true);
    await React.act(async () => {
      dispatchThroughWindowCapture(toggle, "click", { detail: 0 });
      await Promise.resolve();
    });
    assert.equal(toggle.getAttribute("aria-expanded"), "true");

    const mouseProperties = {
      pointerType: "mouse",
      pointerId: 13,
      isPrimary: true,
      button: 0,
      clientX: 24,
      clientY: 120
    };
    await React.act(async () => {
      dispatchThroughWindowCapture(apply, "pointerdown", mouseProperties);
      dispatchThroughWindowCapture(apply, "pointerup", mouseProperties);
      assert.equal(
        document.querySelector(".activation-output")?.textContent,
        "1:1:200"
      );
      dispatchThroughWindowCapture(apply, "click", { detail: 1 });
      await Promise.resolve();
    });
    assert.equal(
      document.querySelector(".activation-output")?.textContent,
      "1:2:200",
      "鼠标必须只由原生 click 激活一次"
    );
    assert.equal(toggle.getAttribute("aria-expanded"), "true");

    await React.act(async () => {
      dispatchThroughWindowCapture(apply, "pointerdown", {
        ...applyTouchProperties,
        pointerId: 14
      });
      dispatchThroughWindowCapture(apply, "pointercancel", {
        ...applyTouchProperties,
        pointerId: 14
      });
      const keyboardClick = dispatchThroughWindowCapture(
        apply,
        "click",
        { detail: 0 }
      );
      assert.equal(keyboardClick.immediatePropagationStopped, false);
      assert.equal(keyboardClick.targetDispatched, true);
      await Promise.resolve();
    });
    assert.equal(
      document.querySelector(".activation-output")?.textContent,
      "1:3:200",
      "键盘 detail=0 激活不得被触控兼容守卫吞掉"
    );
    assert.equal(toggle.getAttribute("aria-expanded"), "true");

    const cleanupClick = runWindowCapture(apply, "click", { detail: 1 });
    assert.equal(cleanupClick.immediatePropagationStopped, true);

    await React.act(async () => root.unmount());
  } finally {
    for (const timer of frameTimers.values()) clearTimeout(timer);
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

test("图片成员已知结果必须先呈现再刷新移出当前标签页", async () => {
  const calls: string[] = [];
  const present = (text: string, status: "error" | "success") => {
    calls.push(`present:${status}:${text}`);
  };

  const refreshFailed = await settleConfirmedImageAdminMutation({
    startedAt: Date.now() - 1_000,
    text: "已恢复 199 张，1 张未处理",
    status: "error",
    feedbackTiming: "before-list-refresh",
    refresh: async () => {
      calls.push("refresh");
    },
    present
  });
  assert.equal(refreshFailed, false);
  assert.deepEqual(calls, [
    "present:error:已恢复 199 张，1 张未处理",
    "refresh"
  ]);

  calls.length = 0;
  const failed = await settleConfirmedImageAdminMutation({
    startedAt: Date.now() - 1_000,
    text: "已永久删除 200 张",
    status: "success",
    feedbackTiming: "after-list-refresh",
    refresh: async () => {
      calls.push("refresh");
      throw new Error("refresh failed");
    },
    present
  });
  assert.equal(failed, true);
  assert.deepEqual(calls, [
    "refresh",
    "present:error:已永久删除 200 张；图片列表刷新失败，请重新加载页面"
  ]);
});

test("标签翻页键的键盘焦点保留草稿且 disabled 切换重算溢出", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div><button id=outside>外部</button></body></html>"
  );
  const React = await import("react");
  class TestResizeObserver {
    constructor(_callback: ResizeObserverCallback) {}
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const matchMedia = (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true
  });
  let animationFrame = 0;
  const frameTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const requestAnimationFrame = (callback: FrameRequestCallback) => {
    const id = ++animationFrame;
    frameTimers.set(id, setTimeout(() => {
      frameTimers.delete(id);
      callback(0);
    }, 0));
    return id;
  };
  const cancelAnimationFrame = (id: number) => {
    const timer = frameTimers.get(id);
    if (timer) clearTimeout(timer);
    frameTimers.delete(id);
  };
  const getComputedStyle = () => ({
    paddingLeft: "4px",
    paddingRight: "4px",
    overflow: "visible",
    overflowX: "auto",
    overflowY: "visible"
  }) as CSSStyleDeclaration;
  Object.assign(window, {
    innerWidth: 1_024,
    innerHeight: 768,
    matchMedia,
    ResizeObserver: TestResizeObserver,
    requestAnimationFrame,
    cancelAnimationFrame,
    getComputedStyle
  });
  Object.defineProperties(window.HTMLElement.prototype, {
    clientHeight: { configurable: true, get: () => 0 },
    clientWidth: { configurable: true, get: () => 0 },
    offsetHeight: { configurable: true, get: () => 0 },
    offsetWidth: { configurable: true, get: () => 0 },
    scrollHeight: { configurable: true, get: () => 0 },
    scrollWidth: { configurable: true, get: () => 0 }
  });
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    ResizeObserver: TestResizeObserver,
    requestAnimationFrame,
    cancelAnimationFrame,
    getComputedStyle,
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
    const changes: string[][] = [];
    const renderTagInputs = (disabled: boolean) => React.createElement(
      React.Fragment,
      null,
      React.createElement(TagInput, {
        key: "decoy",
        value: ["decoy"],
        onChange: () => {},
        suggestions: [],
        disabled,
        ariaLabel: "前置标签",
        className: "decoy-tag-input"
      }),
      React.createElement(TagInput, {
        key: "target",
        value: ["alpha", "beta"],
        onChange: (next: string[]) => changes.push(next),
        suggestions: [{
          slug: "draft-pending",
          display_name: "Draft pending"
        }],
        disabled,
        ariaLabel: "测试标签",
        className: "target-tag-input"
      })
    );
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(renderTagInputs(true));
      await Promise.resolve();
    });

    const control = container.querySelector<HTMLElement>(
      ".target-tag-input"
    );
    assert.ok(control);
    const viewport = control.querySelector<HTMLElement>(
      ".tag-input-scroll-window"
    );
    assert.ok(viewport);
    let clientWidth = 100;
    let scrollWidth = 300;
    let scrollLeft = 0;
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, get: () => clientWidth },
      scrollWidth: { configurable: true, get: () => scrollWidth },
      scrollLeft: {
        configurable: true,
        get: () => scrollLeft,
        set: (value: number) => { scrollLeft = value; }
      }
    });
    await React.act(async () => {
      root.render(renderTagInputs(false));
      await Promise.resolve();
    });

    const input = control.querySelector<HTMLInputElement>(".tag-input-field");
    const decoyInput = container.querySelector<HTMLInputElement>(
      ".decoy-tag-input .tag-input-field"
    );
    const navigation = [...control.querySelectorAll<HTMLButtonElement>(
      "[data-tag-scroll-navigation]"
    )];
    const removeButton = control.querySelector<HTMLButtonElement>(
      ".tag-chip-remove"
    );
    const backward = navigation[0];
    const forward = navigation[1];
    assert.ok(input && decoyInput && removeButton && backward && forward);
    const testRect = (left: number, width: number) => ({
      bottom: 36,
      height: 36,
      left,
      right: left + width,
      top: 0,
      width,
      x: left,
      y: 0,
      toJSON: () => ({})
    });
    Object.defineProperty(viewport, "getBoundingClientRect", {
      configurable: true,
      value: () => testRect(0, 100)
    });
    Object.defineProperty(backward, "getBoundingClientRect", {
      configurable: true,
      value: () => testRect(-4, 22)
    });
    Object.defineProperty(forward, "getBoundingClientRect", {
      configurable: true,
      value: () => testRect(82, 22)
    });
    Object.defineProperty(removeButton, "getBoundingClientRect", {
      configurable: true,
      value: () => testRect(0, 24)
    });
    for (const item of control.querySelectorAll<HTMLElement>(
      "[data-tag-scroll-item]"
    )) {
      Object.defineProperty(item, "getBoundingClientRect", {
        configurable: true,
        value: () => testRect(4, 0)
      });
    }
    assert.equal(forward.disabled, false, "启用态内容溢出后应显示前进键");

    const dispatchWheel = async (
      target: Element,
      deltaX: number,
      deltaY: number
    ) => {
      const event = new window.Event("wheel", {
        bubbles: true,
        cancelable: true
      });
      Object.defineProperties(event, {
        deltaMode: { configurable: true, value: 0 },
        deltaX: { configurable: true, value: deltaX },
        deltaY: { configurable: true, value: deltaY }
      });
      await React.act(async () => {
        target.dispatchEvent(event);
        await Promise.resolve();
      });
      return event;
    };
    const movingWheel = await dispatchWheel(forward, 0, 40);
    assert.equal(movingWheel.defaultPrevented, true, "按钮覆盖区的鼠标滚轮也应归标签框所有");
    assert.equal(scrollLeft, 40, "标签框内纯纵向滚轮应转换为横向位移");
    scrollLeft = 200;
    const edgeWheel = await dispatchWheel(forward, 0, 40);
    assert.equal(edgeWheel.defaultPrevented, true, "到达横向边界后不得把滚轮交还页面");
    assert.equal(scrollLeft, 200, "边界滚轮不得越过标签内容范围");
    const trackpadWheel = await dispatchWheel(viewport, 12, 40);
    assert.equal(trackpadWheel.defaultPrevented, false, "带水平分量的触控板事件应保留原生路径");
    assert.equal(scrollLeft, 200, "触控板事件不得再由纵向转换路径重复移动");
    scrollLeft = 0;

    let activeElement: Element | null = null;
    Object.defineProperty(document, "activeElement", {
      configurable: true,
      get: () => activeElement
    });
    Object.defineProperty(input, "focus", {
      configurable: true,
      value: () => { activeElement = input; }
    });
    Object.defineProperty(decoyInput, "focus", {
      configurable: true,
      value: () => { activeElement = decoyInput; }
    });
    for (const button of navigation) {
      Object.defineProperty(button, "focus", {
        configurable: true,
        value: () => {
          if (!button.disabled) activeElement = button;
        }
      });
    }
    const reactProps = <T,>(element: Element) => {
      const key = Object.keys(element).find((entry) => (
        entry.startsWith("__reactProps$")
      ));
      assert.ok(key);
      return (element as unknown as Record<string, T>)[key]!;
    };
    type InputProps = {
      onFocus: () => void;
      onChange: (event: {
        currentTarget: HTMLInputElement;
        nativeEvent: { isComposing: boolean };
      }) => void;
    };
    type ControlProps = {
      onClick: (event: {
        preventDefault: () => void;
        target: EventTarget;
      }) => void;
      onPointerDown: (event: {
        button: number;
        clientX: number;
        clientY: number;
        isPrimary: boolean;
        pointerId: number;
        pointerType: string;
        preventDefault: () => void;
        target: EventTarget;
      }) => void;
      onBlur: (event: {
        currentTarget: HTMLElement;
        relatedTarget: EventTarget | null;
        target: EventTarget;
      }) => void;
    };
    type ViewportProps = {
      onScroll: () => void;
    };
    type DirectButtonPointerEvent = {
      button: number;
      clientX: number;
      clientY: number;
      currentTarget: HTMLButtonElement;
      isPrimary: boolean;
      pointerId: number;
      pointerType: string;
      preventDefault: () => void;
    };
    type DirectButtonProps = {
      onPointerDown: (event: DirectButtonPointerEvent) => void;
      onPointerMove: (event: DirectButtonPointerEvent) => void;
      onPointerUp: (event: DirectButtonPointerEvent) => void;
    };
    await React.act(async () => {
      input.focus();
      reactProps<InputProps>(input).onFocus();
      input.value = "draft-pending";
      reactProps<InputProps>(input).onChange({
        currentTarget: input,
        nativeEvent: { isComposing: false }
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(input.value, "draft-pending");
    assert.equal(input.getAttribute("aria-expanded"), "true");

    let blankPressPrevented = false;
    reactProps<ControlProps>(control).onPointerDown({
      button: 0,
      clientX: 0,
      clientY: 0,
      isPrimary: true,
      pointerId: 1,
      pointerType: "mouse",
      preventDefault: () => { blankPressPrevented = true; },
      target: viewport
    });
    assert.equal(blankPressPrevented, true, "内部空白按下必须保留编辑器焦点");
    assert.equal(document.activeElement, input);
    let touchPressPrevented = false;
    reactProps<ControlProps>(control).onPointerDown({
      button: 0,
      clientX: 20,
      clientY: 20,
      isPrimary: true,
      pointerId: 2,
      pointerType: "touch",
      preventDefault: () => { touchPressPrevented = true; },
      target: viewport
    });
    assert.equal(touchPressPrevented, false, "内部触控按下必须继续交给横向手势");
    const firstChip = control.querySelector<HTMLElement>(".tag-chip");
    assert.ok(firstChip);
    type TestTouch = {
      identifier: number;
      clientX: number;
      clientY: number;
    };
    const dispatchTouch = async (
      target: Element,
      type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
      touches: TestTouch[],
      changedTouches: TestTouch[]
    ) => {
      const event = new window.Event(type, {
        bubbles: true,
        cancelable: true
      });
      Object.defineProperties(event, {
        touches: { configurable: true, value: touches },
        changedTouches: { configurable: true, value: changedTouches }
      });
      await React.act(async () => {
        target.dispatchEvent(event);
        await Promise.resolve();
      });
      return event;
    };
    activeElement = forward;
    scrollLeft = 0;
    await dispatchTouch(
      viewport,
      "touchstart",
      [{ identifier: 2, clientX: 20, clientY: 20 }],
      [{ identifier: 2, clientX: 20, clientY: 20 }]
    );
    await dispatchTouch(
      viewport,
      "touchmove",
      [{ identifier: 2, clientX: 25, clientY: 20 }],
      [{ identifier: 2, clientX: 25, clientY: 20 }]
    );
    const dragTouchEnd = await dispatchTouch(
      viewport,
      "touchend",
      [],
      [{ identifier: 2, clientX: 25, clientY: 20 }]
    );
    assert.equal(dragTouchEnd.defaultPrevented, false, "横向手势抬起不得取消原生路径");
    assert.equal(document.activeElement, forward, "横向移动达到手势阈值后不得抢回输入焦点");
    assert.equal(scrollLeft, 0, "横向手势的触控路径不得重复移动标签窗口");
    await dispatchTouch(
      firstChip,
      "touchstart",
      [{ identifier: 3, clientX: 20, clientY: 20 }],
      [{ identifier: 3, clientX: 20, clientY: 20 }]
    );
    await dispatchTouch(
      firstChip,
      "touchmove",
      [{ identifier: 3, clientX: 22, clientY: 21 }],
      [{ identifier: 3, clientX: 22, clientY: 21 }]
    );
    const tapTouchEnd = await dispatchTouch(
      firstChip,
      "touchend",
      [],
      [{ identifier: 3, clientX: 22, clientY: 21 }]
    );
    assert.equal(
      tapTouchEnd.defaultPrevented,
      true,
      "触控轻点必须在原生 touchend 取消兼容焦点与 click"
    );
    assert.equal(
      document.activeElement,
      input,
      "未达到手势阈值的 touchend 必须直接聚焦末尾编辑器"
    );
    assert.equal(
      scrollLeft,
      200,
      "已有标签占满视区时，聚焦必须同时露出末尾输入位置"
    );
    let synthesizedClickPrevented = false;
    reactProps<ControlProps>(control).onClick({
      preventDefault: () => { synthesizedClickPrevented = true; },
      target: firstChip
    });
    assert.equal(
      synthesizedClickPrevented,
      true,
      "非 Touch-Event 浏览器的 click 回退仍须阻止默认焦点离开编辑器"
    );
    assert.equal(document.activeElement, input);
    await React.act(async () => {
      scrollLeft = 0;
      reactProps<ViewportProps>(viewport).onScroll();
      await Promise.resolve();
    });
    const removeProps = reactProps<DirectButtonProps>(removeButton);
    activeElement = decoyInput;
    let dragPressPrevented = false;
    let dragReleasePrevented = false;
    removeProps.onPointerDown({
      button: 0,
      clientX: 10,
      clientY: 18,
      currentTarget: removeButton,
      isPrimary: true,
      pointerId: 40,
      pointerType: "touch",
      preventDefault: () => { dragPressPrevented = true; }
    });
    removeProps.onPointerMove({
      button: 0,
      clientX: 15,
      clientY: 18,
      currentTarget: removeButton,
      isPrimary: true,
      pointerId: 40,
      pointerType: "touch",
      preventDefault: () => {}
    });
    removeProps.onPointerUp({
      button: 0,
      clientX: 15,
      clientY: 18,
      currentTarget: removeButton,
      isPrimary: true,
      pointerId: 40,
      pointerType: "touch",
      preventDefault: () => { dragReleasePrevented = true; }
    });
    assert.equal(dragPressPrevented, true, "删除键触控按下应继续保留原输入焦点");
    assert.equal(dragReleasePrevented, false, "达到手势阈值的松手不得提交按钮激活");
    assert.equal(changes.length, 0, "从删除键开始拖动标签窗口不得移除标签");
    assert.equal(document.activeElement, decoyInput, "删除键拖动不得抢走其他输入框焦点");

    let tapReleasePrevented = false;
    removeProps.onPointerDown({
      button: 0,
      clientX: 10,
      clientY: 18,
      currentTarget: removeButton,
      isPrimary: true,
      pointerId: 41,
      pointerType: "touch",
      preventDefault: () => {}
    });
    removeProps.onPointerMove({
      button: 0,
      clientX: 13,
      clientY: 18,
      currentTarget: removeButton,
      isPrimary: true,
      pointerId: 41,
      pointerType: "touch",
      preventDefault: () => {}
    });
    removeProps.onPointerUp({
      button: 0,
      clientX: 13,
      clientY: 18,
      currentTarget: removeButton,
      isPrimary: true,
      pointerId: 41,
      pointerType: "touch",
      preventDefault: () => { tapReleasePrevented = true; }
    });
    assert.equal(tapReleasePrevented, true, "阈值内轻点仍应激活标签删除键");
    assert.deepEqual(changes, [["beta"]], "轻点标签删除键仍应只移除对应标签");
    changes.length = 0;
    input.focus();

    let removePressPrevented = false;
    removeProps.onPointerDown({
      button: 0,
      clientX: 10,
      clientY: 18,
      currentTarget: removeButton,
      isPrimary: true,
      pointerId: 1,
      pointerType: "mouse",
      preventDefault: () => { removePressPrevented = true; }
    });
    assert.equal(removePressPrevented, true, "chip 移除键按下必须保留编辑器焦点");
    assert.equal(document.activeElement, input);

    await React.act(async () => {
      reactProps<ControlProps>(control).onBlur({
        currentTarget: control,
        relatedTarget: forward,
        target: input
      });
      await Promise.resolve();
    });
    assert.equal(changes.length, 0, "Tab 到翻页键不得提交草稿");
    assert.equal(input.value, "draft-pending", "Tab 到翻页键不得清空输入");
    assert.equal(
      input.getAttribute("aria-expanded"),
      "true",
      "翻页键取得键盘焦点时建议菜单应保持"
    );

    await React.act(async () => {
      activeElement = forward;
      assert.equal(document.activeElement, forward);
      reactProps<{ onClick: () => void }>(forward).onClick();
      reactProps<ControlProps>(control).onBlur({
        currentTarget: control,
        relatedTarget: input,
        target: forward
      });
      await Promise.resolve();
    });
    assert.equal(changes.length, 0, "键盘与辅助技术 click 路径不得提交草稿");
    assert.equal(input.value, "draft-pending");
    assert.equal(forward.disabled, true, "到达末端后前进键必须立即失效");
    assert.equal(
      document.activeElement,
      input,
      "当前键盘导航按钮失效前必须把焦点无结算地归还输入"
    );
    assert.equal(changes.length, 0, "边界禁用导致的焦点转移不得提交草稿");
    assert.equal(input.value, "draft-pending");
    assert.equal(input.getAttribute("aria-expanded"), "true");

    reactProps<{ onCompositionStart: () => void }>(input).onCompositionStart();
    activeElement = removeButton;
    scrollWidth = 180;
    scrollLeft = 0;
    await React.act(async () => {
      root.render(renderTagInputs(true));
      await Promise.resolve();
    });
    assert.equal(input.disabled, false, "复合禁用不应原生禁用焦点落点");
    assert.equal(reactProps<{ readOnly: boolean }>(input).readOnly, true);
    assert.equal(input.getAttribute("aria-disabled"), "true");
    assert.equal(control.hasAttribute("aria-disabled"), false);
    assert.equal(control.hasAttribute("data-tag-input-disabled"), true);
    assert.equal(removeButton.isConnected, true, "禁用切换不得移除当前内部焦点 owner");
    assert.equal(removeButton.getAttribute("aria-disabled"), "true");
    assert.equal(removeButton.tabIndex, -1);
    await React.act(async () => {
      reactProps<{ onClick: () => void }>(removeButton).onClick();
      await Promise.resolve();
    });
    assert.equal(changes.length, 0, "禁用态保留可见删除符号仍不得移除标签");
    assert.equal(document.activeElement, input, "禁用切换应先把 chip 移除键焦点归还输入");
    assert.equal(input.tabIndex, -1, "禁用态输入不得进入顺序 Tab 导航");
    assert.equal(scrollLeft, 0, "禁用态方向交接测试应从左端开始");
    assert.equal(backward.disabled, true);
    assert.equal(forward.disabled, false);
    await React.act(async () => {
      activeElement = forward;
      reactProps<{ onClick: () => void }>(forward).onClick();
      await Promise.resolve();
    });
    assert.equal(scrollLeft, 80, "禁用态前进键应移动到右端");
    assert.equal(forward.disabled, true);
    assert.equal(backward.disabled, false);
    assert.equal(
      document.activeElement,
      input,
      "整体禁用时应由只读编辑器稳定接管键盘焦点"
    );
    assert.equal(changes.length, 0, "禁用态翻页方向互换不得提交草稿");
    assert.equal(input.value, "draft-pending");

    scrollWidth = 100;
    scrollLeft = 0;
    await React.act(async () => {
      reactProps<ViewportProps>(viewport).onScroll();
      await Promise.resolve();
    });
    assert.equal(backward.disabled, true);
    assert.equal(forward.disabled, true);
    assert.equal(
      document.activeElement,
      input,
      "禁用态无可用方向时焦点仍应留在标签复合控件内"
    );
    assert.equal(changes.length, 0, "整体禁用时导航键失焦不得提交草稿");
    assert.equal(input.value, "draft-pending", "整体禁用时应保留未结算草稿");
    assert.equal(
      forward.disabled,
      true,
      "禁用期间可用宽度变化后应立即隐藏失效翻页键"
    );

    scrollWidth = 300;
    await React.act(async () => {
      root.render(renderTagInputs(false));
      await Promise.resolve();
    });
    assert.equal(
      forward.disabled,
      false,
      "恢复可编辑并重新溢出后应立即恢复前进键"
    );
    assert.equal(
      document.activeElement,
      input,
      "复合控件恢复编辑时应保留输入焦点"
    );
    let enterPrevented = false;
    await React.act(async () => {
      reactProps<{
        onKeyDown: (event: {
          currentTarget: HTMLInputElement;
          key: string;
          keyCode: number;
          nativeEvent: { isComposing: boolean };
          preventDefault: () => void;
        }) => void;
      }>(input).onKeyDown({
        currentTarget: input,
        key: "Enter",
        keyCode: 13,
        nativeEvent: { isComposing: false },
        preventDefault: () => { enterPrevented = true; }
      });
      await Promise.resolve();
    });
    assert.equal(enterPrevented, true, "恢复编辑后 Enter 不得被残留 IME 状态吞掉");
    assert.deepEqual(changes, [["alpha", "beta", "draft-pending"]]);
    await React.act(async () => {
      input.value = "draft-final";
      reactProps<InputProps>(input).onChange({
        currentTarget: input,
        nativeEvent: { isComposing: false }
      });
      await Promise.resolve();
    });

    const outside = document.getElementById("outside");
    assert.ok(outside);
    await React.act(async () => {
      reactProps<ControlProps>(control).onBlur({
        currentTarget: control,
        relatedTarget: outside,
        target: input
      });
      await Promise.resolve();
    });
    assert.deepEqual(
      changes,
      [
        ["alpha", "beta", "draft-pending"],
        ["alpha", "beta", "draft-final"]
      ],
      "焦点真正离开整个控件后才结算草稿"
    );

    await React.act(async () => root.unmount());
  } finally {
    for (const timer of frameTimers.values()) clearTimeout(timer);
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

test("弹窗触摸边界按意图区分纵向与标签横向 owner", () => {
  const metrics = (
    scrollTop: number,
    clientHeight = 100,
    scrollHeight = 300
  ) => ({ scrollTop, clientHeight, scrollHeight });
  assert.equal(
    canDialogScrollOwnerConsumeTouchMove(metrics(0), -20),
    true,
    "顶部向上拖动应继续向内容底部滚动"
  );
  assert.equal(
    canDialogScrollOwnerConsumeTouchMove(metrics(0), 20),
    false,
    "顶部向下拖动不得交给背景页"
  );
  assert.equal(
    canDialogScrollOwnerConsumeTouchMove(metrics(100), -20),
    true
  );
  assert.equal(
    canDialogScrollOwnerConsumeTouchMove(metrics(100), 20),
    true
  );
  assert.equal(
    canDialogScrollOwnerConsumeTouchMove(metrics(200), -20),
    false,
    "底部向上拖动不得交给背景页"
  );
  assert.equal(
    canDialogScrollOwnerConsumeTouchMove(metrics(200), 20),
    true
  );
  assert.equal(
    canDialogScrollOwnerConsumeTouchMove(
      metrics(0, 100, 100),
      -20
    ),
    false
  );
  const horizontalMetrics = (
    scrollLeft: number,
    clientWidth = 100,
    scrollWidth = 300
  ) => ({ scrollLeft, clientWidth, scrollWidth });
  assert.equal(
    canDialogHorizontalScrollOwnerConsumeTouchMove(
      horizontalMetrics(0),
      -20
    ),
    true
  );
  assert.equal(
    canDialogHorizontalScrollOwnerConsumeTouchMove(
      horizontalMetrics(0),
      20
    ),
    false
  );
  const horizontalOwner = horizontalMetrics(50);
  assert.equal(consumeDialogHorizontalTouchMove(horizontalOwner, -20), true);
  assert.equal(horizontalOwner.scrollLeft, 70);

  const { window, document } = parseHTML(
    "<!doctype html><html><body>"
      + "<div data-dialog-frame id=frame>"
      + "<div data-overflow=auto id=article>"
      + "<div data-overflow=auto id=inner><span id=target>目标</span></div>"
      + "<div data-overflow-x=auto data-dialog-horizontal-scroll-owner id=tags>"
      + "<span id=tag-target>标签</span><input id=input>"
      + "</div>"
      + "</div></div><span id=outside>外部</span>"
      + "</body></html>"
  );
  Object.assign(window, {
    getComputedStyle(element: Element) {
      return {
        overflow: "visible",
        overflowX: element.getAttribute("data-overflow-x") ?? "visible",
        overflowY: element.getAttribute("data-overflow") ?? "visible"
      };
    }
  });
  const installedGlobals = {
    window,
    self: window,
    document,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement
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

  const frame = document.getElementById("frame") as HTMLElement;
  const article = document.getElementById("article") as HTMLElement;
  const inner = document.getElementById("inner") as HTMLElement;
  const target = document.getElementById("target") as HTMLElement;
  const tags = document.getElementById("tags") as HTMLElement;
  const tagTarget = document.getElementById("tag-target") as HTMLElement;
  const input = document.getElementById("input") as HTMLElement;
  const outside = document.getElementById("outside") as HTMLElement;
  const setMetrics = (
    element: HTMLElement,
    values: { clientHeight: number; scrollHeight: number; scrollTop: number }
  ) => {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(element, key, {
        configurable: true,
        writable: true,
        value
      });
    }
  };
  setMetrics(frame, metrics(0, 300, 300));
  setMetrics(article, metrics(25, 100, 500));
  setMetrics(inner, metrics(0, 100, 100));
  const setHorizontalMetrics = (
    element: HTMLElement,
    values: { clientWidth: number; scrollLeft: number; scrollWidth: number }
  ) => {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(element, key, {
        configurable: true,
        writable: true,
        value
      });
    }
  };
  setHorizontalMetrics(tags, horizontalMetrics(0));

  try {
    assert.equal(findDialogTouchScrollOwner(target, frame), article);
    setMetrics(inner, metrics(0, 100, 300));
    assert.equal(findDialogTouchScrollOwner(target, frame), inner);
    assert.equal(findDialogTouchScrollOwner(outside, frame), null);
    assert.equal(findDialogHorizontalTouchScrollOwner(tagTarget, frame), tags);
    assert.equal(findDialogHorizontalTouchScrollOwner(input, frame), tags);
    assert.equal(findDialogHorizontalTouchScrollOwner(target, frame), null);

    setHorizontalMetrics(tags, horizontalMetrics(0, 100, 100));
    assert.equal(
      findDialogHorizontalTouchScrollOwner(input, frame),
      null,
      "没有横向溢出时输入框应保留原生光标与选择手势"
    );
    setHorizontalMetrics(tags, horizontalMetrics(0));

    const touchList = (...points: Array<{
      identifier: number;
      clientX: number;
      clientY: number;
    }>) => ({
      length: points.length,
      item: (index: number) => points[index] ?? null
    }) as unknown as TouchList;
    let prevented = 0;
    const touchEvent = (
      eventTarget: EventTarget,
      points: Array<{ identifier: number; clientX: number; clientY: number }>
    ) => ({
      cancelable: true,
      target: eventTarget,
      touches: touchList(...points),
      preventDefault() {
        prevented += 1;
      }
    }) as unknown as TouchEvent;
    const boundary = createDialogTouchBoundary(document);
    const point = (identifier: number, clientX: number, clientY: number) => ({
      identifier,
      clientX,
      clientY
    });

    boundary.onTouchStart(touchEvent(target, [point(7, 100, 100)]));
    boundary.onTouchMove(touchEvent(target, [point(7, 100, 120)]));
    assert.equal(prevented, 1, "顶部边界应阻止滚动链回到文档");

    inner.scrollTop = 50;
    boundary.onTouchStart(touchEvent(target, [point(8, 100, 100)]));
    boundary.onTouchMove(touchEvent(target, [point(8, 100, 120)]));
    assert.equal(prevented, 1, "owner 有可用方向时保留浏览器原生滚动");

    inner.scrollTop = 0;
    boundary.onTouchStart(touchEvent(input, [point(9, 100, 100)]));
    boundary.onTouchMove(touchEvent(input, [point(9, 100, 120)]));
    assert.equal(prevented, 1, "输入控件保留原生文本手势");

    boundary.onTouchStart(touchEvent(target, [
      point(10, 100, 100),
      point(11, 120, 100)
    ]));
    boundary.onTouchMove(touchEvent(target, [
      point(10, 100, 120),
      point(11, 120, 120)
    ]));
    assert.equal(prevented, 1, "双指缩放不得被滚动边界接管");

    boundary.onTouchStart(touchEvent(tagTarget, [point(12, 100, 100)]));
    boundary.onTouchMove(touchEvent(tagTarget, [point(12, 76, 102)]));
    assert.equal(tags.scrollLeft, 24, "chip 起手应移动共享标签 viewport");
    assert.equal(prevented, 2);

    boundary.onTouchStart(touchEvent(input, [point(13, 100, 100)]));
    boundary.onTouchMove(touchEvent(input, [point(13, 80, 101)]));
    assert.equal(tags.scrollLeft, 44, "输入区起手也应移动同一 viewport");
    assert.equal(prevented, 3);

    const beforeDiagonal = tags.scrollLeft;
    boundary.onTouchStart(touchEvent(tags, [point(14, 100, 100)]));
    boundary.onTouchMove(touchEvent(tags, [point(14, 98, 78)]));
    assert.equal(tags.scrollLeft, beforeDiagonal);
    assert.equal(prevented, 3, "纵向意图应继续交给弹窗纵向 owner");

    tags.scrollLeft = 200;
    boundary.onTouchStart(touchEvent(tags, [point(15, 100, 100)]));
    boundary.onTouchMove(touchEvent(tags, [point(15, 78, 100)]));
    assert.equal(tags.scrollLeft, 200);
    assert.equal(prevented, 4, "标签末端必须锁住横向滚动链");

    tags.scrollLeft = 0;
    const beforeSubpixel = prevented;
    boundary.onTouchStart(touchEvent(tagTarget, [point(16, 100, 100)]));
    for (let step = 1; step <= 12; step += 1) {
      boundary.onTouchMove(touchEvent(tagTarget, [
        point(16, 100 - step * 0.5, 100)
      ]));
    }
    assert.equal(
      tags.scrollLeft,
      1.5,
      "越过意图阈值后的连续亚像素样本必须逐帧保留"
    );
    assert.equal(prevented - beforeSubpixel, 3);

    setHorizontalMetrics(tags, horizontalMetrics(0, 100, 100));
    boundary.onTouchStart(touchEvent(input, [point(17, 100, 100)]));
    boundary.onTouchMove(touchEvent(input, [point(17, 78, 100)]));
    assert.equal(
      prevented,
      beforeSubpixel + 3,
      "无溢出输入框的横向文本手势不得被显式取消"
    );
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

test("页面滚动 Effect Event 更新回调时不重绑监听器并清理待执行帧", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  let scrollY = 0;
  Object.defineProperty(window, "scrollY", {
    configurable: true,
    get: () => scrollY
  });
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    value: 2_000
  });
  Object.defineProperty(document.body, "scrollHeight", {
    configurable: true,
    value: 2_000
  });

  const frameCallbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const requestAnimationFrame = (callback: FrameRequestCallback) => {
    const id = nextFrame;
    nextFrame += 1;
    frameCallbacks.set(id, callback);
    return id;
  };
  const cancelAnimationFrame = (id: number) => {
    frameCallbacks.delete(id);
  };
  const flushFrames = () => {
    const callbacks = [...frameCallbacks.values()];
    frameCallbacks.clear();
    for (const callback of callbacks) callback(Date.now());
  };
  Object.assign(window, {
    innerHeight: 600,
    requestAnimationFrame,
    cancelAnimationFrame
  });

  const activeScrollListeners = new Set<EventListenerOrEventListenerObject>();
  let scrollListenerAdds = 0;
  let scrollListenerRemoves = 0;
  const addWindowEventListener = window.addEventListener.bind(window);
  const removeWindowEventListener = window.removeEventListener.bind(window);
  window.addEventListener = ((type, listener, options) => {
    if (type === "scroll") {
      scrollListenerAdds += 1;
      activeScrollListeners.add(listener);
    }
    addWindowEventListener(type, listener, options);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((type, listener, options) => {
    if (type === "scroll") {
      scrollListenerRemoves += 1;
      activeScrollListeners.delete(listener);
    }
    removeWindowEventListener(type, listener, options);
  }) as typeof window.removeEventListener;

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
    const { usePageScrollMovement } = await import(
      "../../packages/web/src/hooks/usePageScrollMovement.ts"
    );
    const movements: Array<{ version: number; delta: number; top: number }> = [];

    function ScrollProbe({ version }: { version: number }) {
      usePageScrollMovement(({ delta, position }) => {
        movements.push({ version, delta, top: position.top });
      });
      return null;
    }
    const tree = (version: number) => React.createElement(
      React.StrictMode,
      null,
      React.createElement(ScrollProbe, { version })
    );
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);

    await React.act(async () => root.render(tree(1)));
    assert.equal(activeScrollListeners.size, 1, "Strict Mode 重放后只能保留一个 scroll listener");
    const listenerCountsAfterMount = {
      adds: scrollListenerAdds,
      removes: scrollListenerRemoves
    };

    scrollY = 120;
    window.dispatchEvent(new window.Event("scroll"));
    assert.equal(frameCallbacks.size, 1);
    await React.act(async () => flushFrames());
    assert.deepEqual(movements, [{ version: 1, delta: 120, top: 120 }]);

    await React.act(async () => root.render(tree(2)));
    assert.deepEqual({
      adds: scrollListenerAdds,
      removes: scrollListenerRemoves
    }, listenerCountsAfterMount, "回调 identity 变化不得重绑 scroll listener");

    scrollY = 175;
    window.dispatchEvent(new window.Event("scroll"));
    await React.act(async () => flushFrames());
    assert.deepEqual(movements.at(-1), { version: 2, delta: 55, top: 175 });

    scrollY = 200;
    window.dispatchEvent(new window.Event("scroll"));
    assert.equal(frameCallbacks.size, 1);
    await React.act(async () => root.unmount());
    assert.equal(frameCallbacks.size, 0, "卸载必须取消尚未执行的滚动帧");
    assert.equal(activeScrollListeners.size, 0);
    assert.equal(scrollListenerRemoves, scrollListenerAdds);
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

test("共享页面锁计数化冻结根节点并按层级归还滚动与焦点", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const { createPortal } = await import("react-dom");
  const frameCallbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const requestAnimationFrame = (callback: FrameRequestCallback) => {
    const id = nextFrame;
    nextFrame += 1;
    frameCallbacks.set(id, callback);
    return id;
  };
  const cancelAnimationFrame = (id: number) => {
    frameCallbacks.delete(id);
  };
  const flushFrame = () => {
    const callbacks = [...frameCallbacks.values()];
    frameCallbacks.clear();
    for (const callback of callbacks) callback(Date.now());
  };
  const scrollCalls: number[] = [];
  Object.assign(window, {
    innerWidth: 1200,
    requestAnimationFrame,
    cancelAnimationFrame,
    scrollTo(_x: number, y: number) {
      scrollCalls.push(y);
    }
  });
  Object.defineProperty(window, "scrollY", {
    configurable: true,
    value: 137
  });
  Object.defineProperty(document.documentElement, "clientWidth", {
    configurable: true,
    value: 1180
  });

  let activeElement: HTMLElement = document.body;
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
    if (activeElement === this) activeElement = document.body;
  };

  const activeKeydownListeners = new Set<EventListenerOrEventListenerObject>();
  let keydownListenerAdds = 0;
  let keydownListenerRemoves = 0;
  const addDocumentEventListener = document.addEventListener.bind(document);
  const removeDocumentEventListener = document.removeEventListener.bind(document);
  document.addEventListener = ((type, listener, options) => {
    if (type === "keydown") {
      keydownListenerAdds += 1;
      activeKeydownListeners.add(listener);
    }
    addDocumentEventListener(type, listener, options);
  }) as typeof document.addEventListener;
  document.removeEventListener = ((type, listener, options) => {
    if (type === "keydown") {
      keydownListenerRemoves += 1;
      activeKeydownListeners.delete(listener);
    }
    removeDocumentEventListener(type, listener, options);
  }) as typeof document.removeEventListener;

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
    const { usePageScrollLock } = await import(
      "../../packages/web/src/hooks/usePageScrollLock.ts"
    );
    const { useDialogFocus } = await import(
      "../../packages/web/src/hooks/useDialogFocus.ts"
    );
    const pageRoot = document.getElementById("root") as HTMLElement;
    Object.assign(pageRoot.style, {
      position: "relative",
      top: "3px",
      left: "4px",
      right: "5px",
      width: "91%"
    });
    pageRoot.setAttribute("aria-hidden", "preexisting");
    pageRoot.inert = false;
    const root = createRoot(pageRoot);

    const escapeVersions: number[] = [];

    function LockProbe({
      index,
      escapeVersion
    }: {
      index: number;
      escapeVersion: number;
    }) {
      const frameRef = React.useRef<HTMLDivElement | null>(null);
      const closeRef = React.useRef<HTMLButtonElement | null>(null);
      usePageScrollLock();
      useDialogFocus({
        containerRef: frameRef,
        initialFocusRef: closeRef,
        onEscape() {
          escapeVersions.push(escapeVersion);
        }
      });
      return createPortal(React.createElement(
        "div",
        {
          ref: frameRef,
          "data-dialog-frame": "",
          tabIndex: -1
        },
        React.createElement("button", {
          ref: closeRef,
          id: `dialog-close-${index}`
        }, "关闭")
      ), document.body);
    }

    function Harness({
      locks,
      escapeVersion = 0
    }: {
      locks: number;
      escapeVersion?: number;
    }) {
      return React.createElement(
        React.Fragment,
        null,
        React.createElement("button", { id: "page-opener" }, "打开"),
        ...Array.from({ length: locks }, (_, index) => (
          React.createElement(LockProbe, { index, escapeVersion, key: index })
        ))
      );
    }

    await React.act(async () => {
      root.render(React.createElement(Harness, { locks: 0 }));
    });
    const opener = document.getElementById("page-opener") as HTMLElement;
    opener.focus();

    await React.act(async () => {
      root.render(React.createElement(Harness, { locks: 1, escapeVersion: 1 }));
    });
    assert.equal(pageRoot.inert, true);
    assert.equal(pageRoot.getAttribute("aria-hidden"), "true");
    assert.equal(pageRoot.style.position, "fixed");
    assert.equal(pageRoot.style.top, "-137px");
    assert.equal(pageRoot.style.right, "20px");
    assert.equal(activeElement.id, "dialog-close-0");
    assert.equal(activeKeydownListeners.size, 1);
    const keydownCountsBeforeCallbackUpdate = {
      adds: keydownListenerAdds,
      removes: keydownListenerRemoves
    };

    await React.act(async () => {
      root.render(React.createElement(Harness, { locks: 1, escapeVersion: 2 }));
    });
    assert.deepEqual({
      adds: keydownListenerAdds,
      removes: keydownListenerRemoves
    }, keydownCountsBeforeCallbackUpdate, "Escape 回调更新不得重绑 keydown listener");
    const escapeEvent = new window.Event("keydown", {
      bubbles: true,
      cancelable: true
    });
    Object.defineProperties(escapeEvent, {
      key: { value: "Escape" },
      keyCode: { value: 27 },
      isComposing: { value: false }
    });
    document.dispatchEvent(escapeEvent);
    assert.deepEqual(escapeVersions, [2], "Escape 必须读取最新已提交回调");
    assert.equal(escapeEvent.defaultPrevented, true);

    await React.act(async () => {
      root.render(React.createElement(Harness, { locks: 2, escapeVersion: 2 }));
    });
    assert.equal(activeElement.id, "dialog-close-1");
    assert.equal(pageRoot.inert, true);

    await React.act(async () => {
      root.render(React.createElement(Harness, { locks: 1, escapeVersion: 2 }));
    });
    assert.equal(activeElement.id, "dialog-close-0");
    assert.equal(pageRoot.inert, true, "子弹窗释放不得解冻页面根");
    assert.equal(pageRoot.getAttribute("aria-hidden"), "true");

    let restoredEvents = 0;
    window.addEventListener("imageshow:page-scroll-restored", () => {
      restoredEvents += 1;
    });
    await React.act(async () => {
      root.render(React.createElement(Harness, { locks: 0 }));
    });
    assert.equal(pageRoot.inert, false);
    assert.equal(pageRoot.getAttribute("aria-hidden"), "preexisting");
    assert.deepEqual({
      position: pageRoot.style.position,
      top: pageRoot.style.top,
      left: pageRoot.style.left,
      right: pageRoot.style.right,
      width: pageRoot.style.width
    }, {
      position: "relative",
      top: "3px",
      left: "4px",
      right: "5px",
      width: "91%"
    });
    assert.equal(activeElement, opener, "最后释放应在根恢复后归还 opener 焦点");
    assert.deepEqual(scrollCalls, [137]);
    flushFrame();
    assert.deepEqual(scrollCalls, [137, 137]);
    flushFrame();
    assert.equal(restoredEvents, 1);

    const strictReturnTarget = document.createElement("button");
    strictReturnTarget.id = "strict-dialog-return-target";
    document.body.append(strictReturnTarget);
    strictReturnTarget.focus();
    const strictReturnFocusRef = { current: strictReturnTarget };
    function StrictDialogProbe({
      active,
      escapeVersion
    }: {
      active: boolean;
      escapeVersion: number;
    }) {
      const frameRef = React.useRef<HTMLDivElement | null>(null);
      const closeRef = React.useRef<HTMLButtonElement | null>(null);
      useDialogFocus({
        containerRef: frameRef,
        initialFocusRef: closeRef,
        returnFocusRef: strictReturnFocusRef,
        onEscape() {
          escapeVersions.push(escapeVersion);
        },
        active
      });
      return React.createElement(
        "div",
        { ref: frameRef, tabIndex: -1 },
        React.createElement("button", {
          ref: closeRef,
          id: "strict-dialog-close"
        }, "关闭")
      );
    }
    const strictDialogTree = (active: boolean, escapeVersion: number) => (
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(StrictDialogProbe, { active, escapeVersion })
      )
    );
    const strictCountsBeforeMount = {
      adds: keydownListenerAdds,
      removes: keydownListenerRemoves
    };
    await React.act(async () => root.render(strictDialogTree(true, 3)));
    assert.deepEqual({
      adds: keydownListenerAdds - strictCountsBeforeMount.adds,
      removes: keydownListenerRemoves - strictCountsBeforeMount.removes
    }, {
      adds: 2,
      removes: 1
    }, "Strict Mode 应重放一次 keydown listener setup 与 cleanup");
    assert.equal(activeKeydownListeners.size, 1);
    assert.equal(activeElement.id, "strict-dialog-close");
    const strictCountsBeforeCallbackUpdate = {
      adds: keydownListenerAdds,
      removes: keydownListenerRemoves
    };

    await React.act(async () => root.render(strictDialogTree(true, 4)));
    assert.deepEqual({
      adds: keydownListenerAdds,
      removes: keydownListenerRemoves
    }, strictCountsBeforeCallbackUpdate);
    const strictEscapeEvent = new window.Event("keydown", {
      bubbles: true,
      cancelable: true
    });
    Object.defineProperties(strictEscapeEvent, {
      key: { value: "Escape" },
      keyCode: { value: 27 },
      isComposing: { value: false }
    });
    document.dispatchEvent(strictEscapeEvent);
    assert.deepEqual(escapeVersions, [2, 4]);

    await React.act(async () => root.render(strictDialogTree(false, 4)));
    assert.equal(activeKeydownListeners.size, 0);
    assert.equal(activeElement, strictReturnTarget);
    await React.act(async () => root.unmount());
    assert.equal(activeKeydownListeners.size, 0);
    assert.equal(keydownListenerRemoves, keydownListenerAdds);
    strictReturnTarget.remove();
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

test("浏览器上传 lane 统一约束页面工作并响应动态容量与取消", async (t) => {
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
    const runLane = (name: string, work = async () => undefined) => lane.run(
      signal,
      async () => {
        starts.push(name);
        await work();
      }
    );

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
    const run = (name: string, release: ReturnType<typeof gate>) => lane.run(
      new AbortController().signal,
      async () => {
        starts.push(name);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await release.promise;
        } finally {
          active -= 1;
        }
      }
    );
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
    const runs = releases.map((release, index) => lane.run(
      new AbortController().signal,
      async () => {
        starts.push(index);
        await release.promise;
      }
    ));
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

function showImages(count: number): RandomImageJsonItemDto[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`,
    title: `Image ${index}`,
    author: `author-${index % 5}`,
    object_url: `/media/${index}.webp`,
    thumb_url: `/thumbs/${index}.webp`,
    device: index % 2 ? "pc" : "mb",
    brightness: index % 3 ? "dark" : "light",
    theme: `theme-${index % 7}`,
    tags: [`tag-${index % 11}`],
    diff_original: false,
    width: index % 2 ? 1600 : 900,
    height: index % 2 ? 900 : 1600,
    image_time: new Date(1_700_000_000_000 + index * 1000).toISOString()
  }));
}

test("Pixi waterfall 的按钮步长和密度边界严格限制为 0.5G 至 8G", () => {
  const desktop = showWaterfallDensity(1440);
  assert.deepEqual(desktop, {
    galleryColumns: 4,
    minimumColumns: 2,
    defaultColumns: 4,
    normalMaximumColumns: 6,
    warningColumns: 12,
    maximumColumns: 32
  });
  assert.equal(smallerShowWaterfallImages(4, desktop), 5);
  assert.equal(smallerShowWaterfallImages(31, desktop), 32);
  assert.equal(smallerShowWaterfallImages(32, desktop), 32);
  assert.equal(largerShowWaterfallImages(4, desktop), 3);
  assert.equal(largerShowWaterfallImages(2, desktop), 2);
  assert.equal(clampShowWaterfallColumns(-100, desktop), 2);
  assert.equal(clampShowWaterfallColumns(100, desktop), 32);

  const compact = showWaterfallDensity(1080);
  assert.equal(compact.galleryColumns, 3);
  assert.equal(compact.minimumColumns, 1.5);
  assert.equal(compact.normalMaximumColumns, 4.5);
  assert.equal(compact.warningColumns, 9);
  assert.equal(compact.maximumColumns, 24);
});

test("Pixi float 只暴露有界图片尺寸档位", () => {
  assert.deepEqual([...showFloatSizeSteps], [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5]);
  assert.equal(defaultShowFloatSizeIndex, 5);
  assert.equal(clampShowFloatSizeIndex(-100), 0);
  assert.equal(clampShowFloatSizeIndex(100), 10);
  assert.equal(clampShowFloatSizeIndex(2.6), 3);
});

function createCameraTestElement(width = 800, height = 600) {
  const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  const capturedPointers = new Set<number>();
  const element = {
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      const entries = listeners.get(type) ?? new Set();
      entries.add(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      listeners.get(type)?.delete(listener);
    },
    getBoundingClientRect: () => ({
      bottom: height,
      height,
      left: 0,
      right: width,
      top: 0,
      width,
      x: 0,
      y: 0,
      toJSON: () => ({})
    }),
    hasPointerCapture: (pointerId: number) => capturedPointers.has(pointerId),
    releasePointerCapture: (pointerId: number) => capturedPointers.delete(pointerId),
    setPointerCapture: (pointerId: number) => capturedPointers.add(pointerId)
  } as unknown as HTMLElement;
  return {
    element,
    emit(type: string, values: Record<string, unknown>) {
      let prevented = false;
      const event = {
        button: 0,
        cancelable: true,
        clientX: 0,
        clientY: 0,
        deltaMode: 0,
        deltaY: 0,
        pointerId: 1,
        pointerType: "mouse",
        preventDefault: () => {
          prevented = true;
        },
        timeStamp: 0,
        ...values
      };
      for (const listener of listeners.get(type) ?? []) listener(event);
      return prevented;
    },
    listenerCount: () => [...listeners.values()].reduce(
      (total, entries) => total + entries.size,
      0
    )
  };
}

test("Show Pixi 窄相机保持中心缩放、坐标换算与 resize 不漂移", () => {
  const target = createCameraTestElement();
  const camera = new ShowPixiCamera({
    element: target.element,
    width: 800,
    height: 600,
    initialScale: 1,
    minimumScale: 0.5,
    maximumScale: 2
  });
  camera.moveCorner(100, 50);
  assert.deepEqual(camera.getVisibleBounds(), {
    x: 100,
    y: 50,
    width: 800,
    height: 600
  });
  const center = camera.center;
  camera.setZoom(2);
  assert.ok(Math.abs(camera.center.x - center.x) < 0.0001);
  assert.ok(Math.abs(camera.center.y - center.y) < 0.0001);
  assert.deepEqual(camera.getVisibleBounds(), {
    x: 300,
    y: 200,
    width: 400,
    height: 300
  });
  camera.resize(1_000, 700);
  assert.ok(Math.abs(camera.center.x - center.x) < 0.0001);
  assert.ok(Math.abs(camera.center.y - center.y) < 0.0001);
  const world = { x: 420, y: 260 };
  const roundTrip = camera.screenToWorld(camera.worldToScreen(world));
  assert.ok(Math.abs(roundTrip.x - world.x) < 0.0001);
  assert.ok(Math.abs(roundTrip.y - world.y) < 0.0001);
  camera.destroy();
});

test("Show Pixi 窄相机覆盖 drag、惯性、输入禁用与事件清理", () => {
  const target = createCameraTestElement();
  const movements: number[] = [];
  const camera = new ShowPixiCamera({
    element: target.element,
    width: 800,
    height: 600,
    initialScale: 1,
    minimumScale: 0.5,
    maximumScale: 2,
    onManualVerticalMovement: (delta) => movements.push(delta)
  });
  assert.equal(camera.listenerCount, 7);
  assert.equal(target.listenerCount(), 7);
  target.emit("pointerdown", {
    clientX: 100,
    clientY: 100,
    pointerId: 7,
    timeStamp: 10
  });
  target.emit("pointermove", {
    clientX: 180,
    clientY: 132,
    pointerId: 7,
    timeStamp: 26
  });
  assert.equal(camera.activePointers, 1);
  assert.equal(camera.left, -80);
  assert.equal(camera.top, -32);
  target.emit("pointerup", { pointerId: 7, timeStamp: 30 });
  const beforeInertia = camera.left;
  camera.update(16);
  assert.ok(camera.left < beforeInertia);
  assert.ok(movements.length >= 2);
  assert.ok(movements.every((delta) => delta < 0));
  camera.setInputEnabled(false);
  assert.equal(camera.activePointers, 0);
  assert.equal(camera.moving, false);
  const disabledLeft = camera.left;
  target.emit("pointerdown", { clientX: 10, clientY: 10, pointerId: 8 });
  target.emit("pointermove", { clientX: 80, clientY: 80, pointerId: 8 });
  assert.equal(camera.left, disabledLeft);
  camera.destroy();
  assert.equal(camera.listenerCount, 0);
  assert.equal(target.listenerCount(), 0);
});

test("waterfall 导航位移保留拖动和惯性的指针类型，滚轮独立上报", async (t) => {
  for (const pointerType of ["mouse", "touch"]) {
    await t.test(pointerType, (t) => {
      const target = createCameraTestElement();
      const pointerTypes: Array<string | undefined> = [];
      const camera = new ShowPixiCamera({
        element: target.element, width: 800, height: 600,
        initialScale: 1, minimumScale: 0.5, maximumScale: 2,
        onManualVerticalMovement: (_delta, type) => pointerTypes.push(type)
      });
      t.after(() => camera.destroy());
      target.emit("pointerdown", { clientY: 100, timeStamp: 0, pointerType });
      target.emit("pointermove", { clientY: 180, timeStamp: 16, pointerType });
      assert.deepEqual(pointerTypes, [pointerType]);
      target.emit("pointerup", { timeStamp: 20, pointerType });
      camera.update(16);
      assert.deepEqual(pointerTypes, [pointerType, pointerType], "松手后的惯性沿用输入类型");
      pointerTypes.length = 0;
      target.emit("wheel", { deltaY: -120 });
      camera.update(16);
      assert.ok(pointerTypes.length > 0);
      assert.ok(pointerTypes.every((type) => type === undefined), "后续滚轮不继承鼠标拖动限制");
    });
  }
});

test("相机在应用滚轮或双指缩放前取得允许的尺寸，程序化调整不再次请求", (t) => {
  const target = createCameraTestElement();
  const requests: Array<{ requested: number; before: number }> = [];
  const movements: number[] = [];
  const camera = new ShowPixiCamera({
    element: target.element, width: 800, height: 600,
    initialScale: 1, minimumScale: 0.1, maximumScale: 2,
    onManualVerticalMovement: (delta) => movements.push(delta),
    onZoomRequest: (requested) => {
      requests.push({ requested, before: camera.scale });
      return Math.max(0.5, requested);
    }
  });
  t.after(() => camera.destroy());
  target.emit("wheel", { ctrlKey: true, deltaY: 720, clientX: 400, clientY: 300 });
  assert.ok(requests[0].requested < 0.5);
  assert.equal(requests[0].before, 1);
  assert.equal(camera.scale, 0.5, "未应用请求中尚未允许的缩放");
  camera.setZoom(1);
  assert.equal(requests.length, 1);
  target.emit("pointerdown", { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 200 });
  target.emit("pointerdown", { pointerId: 2, pointerType: "touch", clientX: 300, clientY: 200 });
  target.emit("pointermove", { pointerId: 2, pointerType: "touch", clientX: 150, clientY: 200, timeStamp: 16 });
  assert.equal(requests[1].requested, 0.25);
  assert.equal(requests[1].before, 1);
  assert.equal(camera.scale, 0.5);
  camera.setZoom(0.2);
  assert.equal(camera.scale, 0.2, "确认后的程序化调整不再请求");
  assert.equal(requests.length, 2);
  assert.deepEqual(movements, [], "提示和缩放不产生导航位移");
});

test("waterfall 超过 3G 前停在边界，允许后继续缩放，窄屏和宽屏同源", async (t) => {
  for (const width of [760, 761, 1440]) {
    await t.test(`${width}px`, (t) => {
      const density = showWaterfallDensity(width);
      const target = createCameraTestElement(width, 600);
      const requests: number[] = [];
      let confirmed = false;
      const scene = new ShowPixiWaterfallScene({
        width, height: 600, columns: density.warningColumns - 1,
        images: [], dataKey: "density-warning", order: "latest",
        running: false, reducedMotion: false, speed: 28,
        inputElement: target.element,
        textureCache: {} as ShowPixiTextureCache,
        renderer: {} as Renderer,
        onNeedImages: () => undefined,
        onOpen: () => undefined,
        onVisibleItems: () => undefined,
        onManualVerticalMovement: () => undefined,
        onColumnsChange: (columns) => {
          requests.push(columns);
          return confirmed ? columns : Math.min(columns, density.warningColumns);
        }
      });
      t.after(() => scene.destroy());
      target.emit("wheel", { ctrlKey: true, deltaY: 720, clientX: width / 2, clientY: 300 });
      assert.ok(requests[0] > density.warningColumns);
      assert.equal(scene.stats().waterfallColumns, density.warningColumns);
      const boundaryScale = scene.stats().waterfallScale!;
      for (let frame = 0; frame < 6; frame += 1) scene.update(48);
      assert.ok(Math.abs(scene.stats().waterfallScale! - boundaryScale) < 0.00001);
      confirmed = true;
      target.emit("wheel", { ctrlKey: true, deltaY: 120, clientX: width / 2, clientY: 300 });
      assert.ok(scene.stats().waterfallColumns! > density.warningColumns);
      assert.ok(scene.stats().waterfallScale! < boundaryScale, "确认后可以显示更多图片");
    });
  }
});

test("Show Pixi 窄相机 wheel 与 pinch 按锚点缩放、夹取边界并结束租约", () => {
  const target = createCameraTestElement();
  const zoomEnds: number[] = [];
  const camera = new ShowPixiCamera({
    element: target.element,
    width: 800,
    height: 600,
    initialScale: 1,
    minimumScale: 0.5,
    maximumScale: 2,
    onZoomEnd: (scale) => zoomEnds.push(scale)
  });
  const wheelAnchor = { x: 300, y: 240 };
  const wheelWorld = camera.screenToWorld(wheelAnchor);
  assert.equal(target.emit("wheel", {
    ctrlKey: true,
    clientX: wheelAnchor.x,
    clientY: wheelAnchor.y,
    deltaY: -180
  }), true);
  assert.ok(camera.scale > 1 && camera.scale < 2);
  const wheelScreen = camera.worldToScreen(wheelWorld);
  assert.ok(Math.abs(wheelScreen.x - wheelAnchor.x) < 0.0001);
  assert.ok(Math.abs(wheelScreen.y - wheelAnchor.y) < 0.0001);
  camera.update(64);
  camera.update(64);
  camera.update(64);
  assert.equal(zoomEnds.length, 1);

  camera.setZoom(1);
  target.emit("pointerdown", {
    clientX: 200,
    clientY: 300,
    pointerId: 1,
    pointerType: "touch",
    timeStamp: 10
  });
  target.emit("pointerdown", {
    clientX: 600,
    clientY: 300,
    pointerId: 2,
    pointerType: "touch",
    timeStamp: 10
  });
  const pinchCenter = camera.center;
  target.emit("pointermove", {
    clientX: 100,
    clientY: 300,
    pointerId: 1,
    pointerType: "touch",
    timeStamp: 26
  });
  target.emit("pointermove", {
    clientX: 700,
    clientY: 300,
    pointerId: 2,
    pointerType: "touch",
    timeStamp: 26
  });
  assert.ok(Math.abs(camera.scale - 1.5) < 0.0001);
  assert.ok(Math.abs(camera.center.x - pinchCenter.x) < 0.0001);
  assert.ok(Math.abs(camera.center.y - pinchCenter.y) < 0.0001);
  target.emit("pointerup", { pointerId: 1, pointerType: "touch", timeStamp: 30 });
  target.emit("pointerup", { pointerId: 2, pointerType: "touch", timeStamp: 30 });
  assert.equal(zoomEnds.length, 2);
  camera.setZoom(100);
  assert.equal(camera.scale, 2);
  camera.setScaleLimits(0.75, 1.25);
  assert.equal(camera.scale, 1.25);
  camera.destroy();
});

test("waterfall 只有手动纵向平移上报导航，缩放、resize 和自动平移不触发", () => {
  const target = createCameraTestElement();
  const movements: number[] = [];
  const camera = new ShowPixiCamera({
    element: target.element,
    width: 800,
    height: 600,
    initialScale: 1,
    minimumScale: 0.5,
    maximumScale: 2,
    onManualVerticalMovement: (delta) => movements.push(delta)
  });
  try {
    camera.moveCorner(80, 140);
    camera.setZoom(1.5);
    camera.resize(1000, 700);
    target.emit("wheel", { ctrlKey: true, deltaY: -120, clientX: 300, clientY: 200 });
    for (let frame = 0; frame < 12; frame += 1) camera.update(16);
    assert.deepEqual(movements, []);

    const scale = camera.scale;
    const top = camera.top;
    target.emit("wheel", { deltaY: 180 });
    assert.equal(camera.top, top, "滚轮位移由 ticker 平滑消费");
    camera.update(16);
    assert.equal(camera.scale, scale);
    assert.ok(camera.top > top);
    assert.ok(movements.some((delta) => delta > 0));
    for (let frame = 0; frame < 120; frame += 1) camera.update(16);
    assert.equal(camera.moving, false, "余量结束即释放运动，不附加固定等待");

    movements.length = 0;
    target.emit("pointerdown", { clientX: 200, clientY: 200, pointerId: 1, pointerType: "touch" });
    target.emit("pointerdown", { clientX: 600, clientY: 200, pointerId: 2, pointerType: "touch" });
    target.emit("pointermove", { clientX: 700, clientY: 260, pointerId: 2, pointerType: "touch", timeStamp: 16 });
    target.emit("pointerup", { pointerId: 1, pointerType: "touch", timeStamp: 20 });
    target.emit("pointerup", { pointerId: 2, pointerType: "touch", timeStamp: 20 });
    camera.update(16);
    assert.deepEqual(movements, [], "双指锚点修正不冒充手动纵移");
  } finally {
    camera.destroy();
  }
});

function installPixiPaletteFixture(t: TestContext) {
  // Exercise the production palette using its real CSS values. Geometry tests
  // do not need a GPU, but cards now correctly share the browser color owner.
  const css = ["semantic-colors.css", "gallery-semantic-colors.css"]
    .map((name) => readFileSync(`packages/web/src/styles/${name}`, "utf8")).join("\n");
  const tokens = new Map([...css.matchAll(/(--[\w-]+):\s*([^;]+);/gu)]
    .map((match) => [match[1], match[2].trim()]));
  const globals = {
    document: { documentElement: {} },
    getComputedStyle: () => ({ getPropertyValue: (key: string) => tokens.get(key) ?? "" })
  };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  });
}

function createFloatSceneHarness(
  t: TestContext,
  { width = 1440, height = 900, sizeIndex = defaultShowFloatSizeIndex, count = 700 } = {}
) {
  installPixiPaletteFixture(t);
  const dpr = Object.getOwnPropertyDescriptor(globalThis, "devicePixelRatio");
  Object.defineProperty(globalThis, "devicePixelRatio", { configurable: true, value: 1 });
  t.after(() => {
    if (dpr) Object.defineProperty(globalThis, "devicePixelRatio", dpr);
    else delete (globalThis as Record<string, unknown>).devicePixelRatio;
  });
  type Acquisition = {
    key: string;
    active: boolean;
    shared: boolean;
    readyAtAcquire: boolean;
    notify: Parameters<ShowPixiTextureCache["acquire"]>[2];
  };
  const acquisitions: Acquisition[] = [];
  const ready = new Set<string>();
  const cache = {
    acquire(
      url: string,
      lod: Parameters<ShowPixiTextureCache["acquire"]>[1],
      notify: Acquisition["notify"]
    ) {
      const key = `${url}:${lod.pixelWidth}x${lod.pixelHeight}`;
      const acquisition: Acquisition = {
        key,
        active: true,
        shared: acquisitions.some((entry) => entry.active && entry.key === key),
        readyAtAcquire: ready.has(key),
        notify
      };
      acquisitions.push(acquisition);
      if (ready.has(key)) queueMicrotask(() => {
        if (acquisition.active) notify(Texture.EMPTY, false);
      });
      return { release: () => { acquisition.active = false; } };
    }
  } as unknown as ShowPixiTextureCache;
  let visibleItems: readonly ShowPixiVisibleItem[] = [];
  let requests = 0;
  let pointerY = height / 2;
  let pointerTime = 0;
  const movements: number[] = [];
  const movementPointerTypes: Array<string | undefined> = [];
  const target = createCameraTestElement(width, height);
  const scene = new ShowPixiFloatScene({
    width,
    height,
    sizeIndex,
    images: showImages(count),
    dataKey: "desktop-float",
    order: "latest",
    inputElement: target.element,
    textureCache: cache,
    // Geometry/stream tests never create a renderer or open the browser.
    renderer: {} as Renderer,
    running: false,
    reducedMotion: false,
    speed: 28,
    onNeedImages: () => { requests += 1; },
    onOpen: () => undefined,
    onVisibleItems: (items) => { visibleItems = items; },
    onSizeIndexChange: (index) => index,
    onManualVerticalMovement: (delta, pointerType) => {
      movements.push(delta);
      movementPointerTypes.push(pointerType);
    }
  });
  scene.update(0);
  t.after(() => {
    scene.destroy();
    scene.destroy();
    assert.equal(target.listenerCount(), 0);
    assert.equal(acquisitions.filter((entry) => entry.active).length, 0);
    assert.deepEqual(visibleItems, []);
  });
  return {
    scene,
    target,
    visibleItems: () => visibleItems,
    acquisitions,
    movements,
    movementPointerTypes,
    requests: () => requests,
    activeLeases: () => acquisitions.filter((entry) => entry.active),
    resolveTextures() {
      for (const entry of acquisitions) {
        if (!entry.active) continue;
        ready.add(entry.key);
        entry.notify(Texture.EMPTY, false);
      }
    },
    advance(frames: number) {
      for (let frame = 0; frame < frames; frame += 1) scene.update(16);
    },
    dragBy(delta: number) {
      if (scene.stats().activePointers === 0) {
        target.emit("pointerdown", { clientY: pointerY, timeStamp: pointerTime });
      }
      pointerY += delta;
      pointerTime += 16;
      target.emit("pointermove", { clientY: pointerY, timeStamp: pointerTime });
      scene.update(16);
    }
  };
}

function floatCardPositions(scene: ShowPixiFloatScene) {
  return scene.root.children.map((root) => {
    const bounds = root.hitArea as Rectangle;
    return { root, x: root.x, y: root.y, width: bounds.width, height: bounds.height, rotation: root.rotation };
  });
}

test("纹理缓存保留原图比例做居中裁剪，共享引用且释放全部解码资源", async (t) => {
  const { ShowPixiTextureCache } = await import("../../packages/web/src/pages/show/pixi/show-pixi-texture-cache.ts");
  const calls: unknown[][] = [];
  const bitmaps: Array<{ width: number; height: number; closed: boolean; close: () => void }> = [];
  let requests = 0;
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const replacements = {
    fetch: async () => { requests += 1; return new Response(new Blob(["image"])); },
    createImageBitmap: async (...args: unknown[]) => {
      calls.push(args);
      const options = args.at(-1) as { resizeWidth?: number; resizeHeight?: number };
      const bitmap = {
        width: options.resizeWidth ?? 200,
        height: options.resizeHeight ?? 800,
        closed: false,
        close() { this.closed = true; }
      };
      bitmaps.push(bitmap);
      return bitmap;
    }
  };
  for (const [key, value] of Object.entries(replacements)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const cache = new ShowPixiTextureCache({
    maximumEntries: 2, maximumPixels: 100_000, maximumInFlight: 1,
    maximumUnreferenced: 0, generateMipmaps: false
  });
  t.after(() => {
    cache.destroy();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  let lease!: ReturnType<ShowPixiTextureCache["acquire"]>;
  const texture = await new Promise<Texture | null>((resolve) => {
    lease = cache.acquire("https://images.example/tall.webp", {
      pixelWidth: 128, pixelHeight: 128, sourceRatio: 4
    }, resolve);
  });
  assert.ok(texture);
  assert.equal(requests, 1);
  assert.equal(calls.length, 2, "极高原图必须先解码再裁剪，不能直接挤压到方形");
  assert.deepEqual(calls[1].slice(1, 5), [0, 300, 200, 200]);
  assert.equal(bitmaps[0].closed, true);
  let secondLease!: ReturnType<ShowPixiTextureCache["acquire"]>;
  const reused = await new Promise<Texture | null>((resolve) => {
    secondLease = cache.acquire("https://images.example/tall.webp", {
      pixelWidth: 128, pixelHeight: 128, sourceRatio: 4
    }, resolve);
  });
  assert.equal(reused, texture);
  assert.equal(requests, 1);
  lease.release();
  assert.equal(cache.stats().entries, 1, "另一个使用者仍持有引用时不销毁纹理");
  secondLease.release();
  assert.equal(cache.stats().entries, 0);
  assert.equal(cache.stats().reservedPixels, 0);
  assert.ok(bitmaps.every((bitmap) => bitmap.closed));
});

test("详情暂停导航保持原显隐状态，关闭后只在自动播放时重新计时", async (t) => {
  for (const movement of ["manual", "page"] as const) {
    await t.test(movement, async (t) => {
      const h = await createPublicNavigationHarness(t, { movement });
      await h.paused(true);
      await h.advance(6_000);
      assert.equal(h.visible(), true);
      await h.manual(600);
      assert.equal(h.visible(), true);
      await h.paused(false);
      await h.manual(600);
      assert.equal(h.visible(), false);
      await h.paused(true);
      await h.pointer(10);
      await h.manual(-600);
      await h.advance(6_000);
      assert.equal(h.visible(), false, "详情不唤出此前收起的导航");
      await h.paused(false);
      assert.equal(h.visible(), false);
      await h.pointer(100);
      await h.pointer(10);
      assert.equal(h.visible(), true);
      await h.advance(2_000);
      await h.paused(true);
      await h.advance(4_000);
      await h.paused(false);
      await h.advance(2_999);
      assert.equal(h.visible(), true);
      await h.advance(1);
      assert.equal(h.visible(), movement === "page");
    });
  }
});

async function createTextureRecoveryHarness(t: TestContext, {
  maximumEntries = 1,
  maximumPixels = maximumEntries * 128 * 128,
  maximumUnreferenced = 0
} = {}) {
  installPixiPaletteFixture(t);
  const { ShowPixiTextureCache } = await import("../../packages/web/src/pages/show/pixi/show-pixi-texture-cache.ts");
  const { ShowPixiCard, ShowPixiPerspectiveCoordinator } = await import("../../packages/web/src/pages/show/pixi/show-pixi-card.ts");
  const requests: string[] = [];
  const holds = new Map<string, Promise<void>>();
  const statuses = new Map<string, number>();
  let offline = false;
  let decodeFails = false;
  let failurePhase: "headers" | "body" = "headers";
  const globals = {
    window: { location: new URL("https://img.example/show") },
    devicePixelRatio: 1,
    fetch: async (url: string) => {
      requests.push(url);
      await holds.get(url);
      if (offline) {
        if (failurePhase === "headers") throw new TypeError("Failed to fetch");
        return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("Response interrupted")); } }));
      }
      return new Response(new Blob(["image"]), { status: statuses.get(url) ?? (url.includes("missing") ? 404 : 200) });
    },
    createImageBitmap: async (_blob: Blob, options: ImageBitmapOptions = {}) => {
      if (decodeFails) throw new Error("Invalid image bytes");
      return { width: options.resizeWidth ?? 128, height: options.resizeHeight ?? 128, close() {} };
    }
  };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const cache = new ShowPixiTextureCache({
    maximumEntries, maximumPixels, maximumInFlight: 1,
    maximumUnreferenced, generateMipmaps: false
  });
  const cards: InstanceType<typeof ShowPixiCard>[] = [];
  const coordinator = new ShowPixiPerspectiveCoordinator();
  t.after(() => {
    for (const card of cards) card.destroy();
    cache.destroy();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  return {
    cache, requests,
    hold(id: string) {
      const pending = Promise.withResolvers<void>();
      holds.set(`https://textures.example/${id}.webp`, pending.promise);
      t.after(() => pending.resolve());
      return pending.resolve;
    },
    setOffline(value: boolean, phase: "headers" | "body" = "headers") { offline = value; failurePhase = phase; },
    setStatus(id: string, status: number) { statuses.set(`https://textures.example/${id}.webp`, status); },
    setDecodeFailure(value: boolean) { decodeFails = value; },
    async flush() {
      const deadline = performance.now() + 1_000;
      do {
        await new Promise((resolve) => setImmediate(resolve));
        if (cache.stats().inFlight === 0 && cache.stats().queued === 0) return;
      } while (performance.now() < deadline);
      assert.fail(`纹理队列未收敛: ${JSON.stringify(cache.stats())}`);
    },
    card(id: string, onOpen: (image: { id: string }, key: string) => void = () => undefined,
      thumbUrl = `https://textures.example/${id}.webp`) {
      const card = new ShowPixiCard(cache, onOpen, {} as Renderer, coordinator);
      cards.push(card);
      card.assign(id, { ...showImages(1)[0], id, width: 128, height: 128, thumb_url: thumbUrl }, 100, 100, .04);
      return card;
    }
  };
}

test("展映图片只响应完整点击，来回拖动、取消与多指不打开详情", async (t) => {
  const h = await createTextureRecoveryHarness(t);
  let opened = 0;
  let openedIdentity: { id: string; key: string } | undefined;
  const card = h.card("pointer", (image, key) => {
    opened++;
    openedIdentity = { id: image.id, key };
  });
  await h.flush();
  const event = (x: number, pointerId = 1, isPrimary = true) => ({
    global: { x, y: 100 }, pointerId, isPrimary, pointerType: "touch", button: 0
  });
  card.root.emit("pointerdown", event(100));
  card.root.emit("pointermove", event(300));
  card.root.emit("pointermove", event(100));
  card.root.emit("pointerup", event(100));
  assert.equal(opened, 0, "拖回起点仍是拖动");
  card.root.emit("pointerdown", event(100));
  card.clearPointerHover();
  card.root.emit("pointerup", event(100));
  assert.equal(opened, 0);
  card.root.emit("pointerdown", event(100));
  card.root.emit("pointerdown", event(101, 2, false));
  card.root.emit("pointerup", event(101, 2, false));
  card.root.emit("pointerup", event(100));
  assert.equal(opened, 0);
  card.root.emit("pointerdown", event(100));
  card.clearPointerHover();
  card.root.emit("pointerup", event(100));
  assert.equal(opened, 0, "场景取消跨卡片多指意图后不能打开详情");
  card.assign("second-copy", card.image!, 100, 100, .04);
  card.root.emit("pointerdown", event(100));
  card.root.emit("pointermove", event(103));
  card.root.emit("pointerup", event(102));
  assert.equal(opened, 1, "保留正常点击的小幅抖动容差");
  assert.deepEqual(openedIdentity, { id: "pointer", key: "second-copy" }, "详情查询和返回焦点分别使用图片 ID 与当前槽位");
});

test("展映卡片身份更换清理旧焦点，调整尺寸仍保留当前焦点", async (t) => {
  const h = await createTextureRecoveryHarness(t);
  const card = h.card("focus");
  await h.flush();
  const image = card.image!;
  card.setFocused(true);
  card.assign(card.key, image, 110, 110, .04, true);
  assert.equal(card.isInteractionActive, true, "同一图片缩放不丢失键盘焦点");
  card.assign("replacement", { ...image, id: "replacement" }, 110, 110, .04);
  assert.equal(card.isInteractionActive, false, "复用卡片不能把旧焦点转给新图");
  assert.equal(card.root.zIndex, 1);
});

test("悬浮卡片缩放时快照图片边缘与实时边框保持对齐并复用快照", async (t) => {
  installPixiPaletteFixture(t);
  const { ShowPixiCard, ShowPixiPerspectiveCoordinator } = await import("../../packages/web/src/pages/show/pixi/show-pixi-card.ts");
  const { RenderTexture, PerspectiveMesh, MeshSimple } = await import("pixi.js");
  class TestCanvas {
    width = 128;
    height = 1;
    getContext() {
      return {
        createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
        putImageData() {}
      };
    }
  }
  const globals = {
    HTMLCanvasElement: TestCanvas,
    document: { documentElement: {}, createElement: () => new TestCanvas() },
    window: { devicePixelRatio: 1 }, devicePixelRatio: 1
  };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let snapshotCount = 0;
  let snapshot: { frame: Rectangle; photo: number[]; texture: InstanceType<typeof RenderTexture> };
  const photoRect = (surface: import("pixi.js").Graphics) => {
    const fill = surface.context.instructions.at(-1)!;
    return (fill.data as any).path.instructions.at(-1).data as number[];
  };
  const renderer = {
    generateTexture({ frame, target }: { frame: Rectangle; target: import("pixi.js").Graphics }) {
      snapshotCount += 1;
      const texture = RenderTexture.create({ width: Math.floor(frame.width), height: Math.floor(frame.height) });
      snapshot = { frame: frame.clone(), photo: [...photoRect(target)], texture };
      return texture;
    }
  } as Renderer;
  const cache = { acquire: () => ({ release() {} }) } as unknown as import("../../packages/web/src/pages/show/pixi/show-pixi-texture-cache.ts").ShowPixiTextureCache;
  const card = new ShowPixiCard(cache, () => {}, renderer, new ShowPixiPerspectiveCoordinator());
  t.after(() => {
    card.destroy();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  const image = { ...showImages(1)[0], width: 400, height: 600 };
  card.assign("zoom", image, 240.35, 360.525, 0);
  card.setVisible(true);
  card.root.emit("pointerover", { pointerType: "mouse", global: { x: 80, y: -100 } });
  card.setFocused(true);
  // Map a snapshot pixel through the actual four mesh corners, independently
  // of the card's projection code, then compare with the edge mesh's inner rim.
  const projectSnapshot = (x: number, y: number, corners: number[]) => {
    const u = (x - snapshot.frame.x) / snapshot.texture.width;
    const v = (y - snapshot.frame.y) / snapshot.texture.height;
    const [x0,y0,x1,y1,x2,y2,x3,y3] = corners;
    const dx1=x1-x2, dx2=x3-x2, dx3=x0-x1+x2-x3;
    const dy1=y1-y2, dy2=y3-y2, dy3=y0-y1+y2-y3;
    const denominator=dx1*dy2-dx2*dy1;
    const g=(dx3*dy2-dx2*dy3)/denominator;
    const h=(dx1*dy3-dx3*dy1)/denominator;
    const divisor=g*u+h*v+1;
    return [((x1-x0+g*x1)*u+(x3-x0+h*x3)*v+x0)/divisor,
      ((y1-y0+g*y1)*u+(y3-y0+h*y3)*v+y0)/divisor];
  };
  const assertAligned = () => {
    const photoMesh = card.visual.children.find((child) => child instanceof PerspectiveMesh)! as InstanceType<typeof PerspectiveMesh>;
    const edge = card.visual.children.find((child) => child instanceof MeshSimple)! as InstanceType<typeof MeshSimple>;
    assert.ok(photoMesh); assert.ok(edge);
    const [x,y,width,height] = snapshot.photo;
    const edgePositions = edge.geometry.getBuffer("aPosition").data;
    // Each side midpoint is an actual vertex: 6 arc samples + 8 straight samples.
    for (const [side, sx, sy] of [[0,0,y+height],[1,x,0],[2,0,y],[3,x+width,0]]) {
      const projected = projectSnapshot(sx, sy, photoMesh.geometry.corners);
      const offset = (side * 22 + 14) * 4 + 2;
      const error = Math.hypot(projected[0]-edgePositions[offset], projected[1]-edgePositions[offset+1]);
      assert.ok(error < .002, `图片与边框偏移 ${error.toFixed(4)}px`);
    }
  };
  card.update(16);
  assertAligned();
  const initialCount = snapshotCount;
  for (const scale of [1.02,1.05,1.08,1.03,.96,1]) {
    card.setRenderScale(scale);
    card.update(16);
    assertAligned();
  }
  assert.equal(snapshotCount, initialCount, "同档连续缩放不逐帧重新截图");
  card.assign("zoom", image, 400.75, 601.125, 0, true);
  for (let frame=0; frame<50; frame+=1) { card.update(16, true); assertAligned(); }
  assert.equal(snapshotCount, initialCount, "Float 平滑尺寸变化继续复用快照");
  card.setRenderScale(1.3); card.update(16); assertAligned();
  assert.equal(snapshotCount, initialCount+1, "跨分辨率档位仅重建一次快照");
  card.clearPointerHover();
  assert.equal(card.visual.children.length, 1, "离开悬浮释放快照和边框网格");
  assert.equal(snapshot.texture.destroyed, true);
});

test("float 单图循环填屏时键盘只固定当前卡片，其余副本继续运动", (t) => {
  const h = createFloatSceneHarness(t, { count: 1 });
  h.scene.setMotion(true, false);
  h.scene.focusCard(h.visibleItems()[0].key);
  const focused = h.scene.root.children.filter((card) => card.zIndex === 100_000);
  assert.equal(focused.length, 1);
  const before = new Map(h.scene.root.children.map((card) => [card, card.y]));
  h.advance(30);
  assert.equal(focused[0].y, before.get(focused[0]));
  assert.ok(h.scene.root.children.some((card) => card !== focused[0] && card.y !== before.get(card)));
  h.scene.focusCard(null);
  h.advance(2);
  assert.ok(focused[0].y < before.get(focused[0])!);
});

test("waterfall 单图循环填屏时焦点只属于当前卡片槽位", (t) => {
  installPixiPaletteFixture(t);
  const original = Object.getOwnPropertyDescriptor(globalThis, "devicePixelRatio");
  Object.defineProperty(globalThis, "devicePixelRatio", { configurable: true, value: 1 });
  let visible: readonly ShowPixiVisibleItem[] = [];
  const target = createCameraTestElement(1440, 900);
  const scene = new ShowPixiWaterfallScene({
    width: 1440, height: 900, columns: 4,
    images: showImages(1), dataKey: "single-image", order: "latest",
    running: false, reducedMotion: false, speed: 28,
    inputElement: target.element,
    textureCache: { acquire: () => ({ release() {} }) } as unknown as ShowPixiTextureCache,
    renderer: {} as Renderer,
    onNeedImages() {}, onOpen() {}, onManualVerticalMovement() {},
    onVisibleItems: (items) => { visible = items; },
    onColumnsChange: (columns) => columns
  });
  t.after(() => {
    scene.destroy();
    if (original) Object.defineProperty(globalThis, "devicePixelRatio", original);
    else delete (globalThis as Record<string, unknown>).devicePixelRatio;
  });
  assert.ok(visible.length > 1);
  assert.equal(new Set(visible.map((item) => item.image.id)).size, 1);
  const focused = () => scene.root.children.filter((card) => card.zIndex === 100_000);
  scene.focusCard(visible[0].key);
  assert.equal(focused().length, 1);
  const first = focused()[0];
  scene.focusCard(visible[1].key);
  assert.equal(focused().length, 1);
  assert.notEqual(focused()[0], first);
  scene.focusCard(null);
  assert.equal(focused().length, 0);
});

test("展映诊断按需采集，运动回调和销毁不依赖诊断开关", async (t) => {
  for (const enabled of [false, true]) {
    await t.test(enabled ? "开启诊断" : "生产默认关闭", (t) => {
      const { document } = parseHTML("<html><body></body></html>");
      const motion: boolean[] = [];
      let observed = 0;
      let disconnected = 0;
      let resizeDisconnected = 0;
      let tick = (_ticker: { elapsedMS: number }) => {};
      const globals = {
        document, devicePixelRatio: 1,
        window: Object.assign(new EventTarget(), {
          innerWidth: 1440, innerHeight: 900,
          matchMedia: () => Object.assign(new EventTarget(), { matches: false })
        }),
        ResizeObserver: class {
          observe() {}
          disconnect() { resizeDisconnected++; }
        },
        PerformanceObserver: class {
          static supportedEntryTypes = ["longtask"];
          observe() { observed++; }
          disconnect() { disconnected++; }
        }
      };
      const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
      for (const [key, value] of Object.entries(globals)) {
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
      }
      let runtime: ShowPixiRuntime | undefined;
      t.after(() => {
        runtime?.destroy();
        for (const [key, descriptor] of originals) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else delete (globalThis as Record<string, unknown>)[key];
        }
      });
      const host = document.createElement("div");
      Object.defineProperties(host, {
        clientWidth: { configurable: true, value: 1440 },
        clientHeight: { configurable: true, value: 900 }
      });
      document.body.appendChild(host);
      const output = enabled ? document.createElement("output") : null;
      const app = {
        canvas: document.createElement("canvas"), stage: new Container(),
        renderer: { resize() {}, events: { setCursor() {} } },
        ticker: {
          count: 0, started: true,
          add(callback: typeof tick) { tick = callback; this.count++; },
          remove(callback: typeof tick) { assert.equal(callback, tick); this.count--; }
        },
        start() { this.ticker.started = true; },
        stop() { this.ticker.started = false; },
        destroy() { this.canvas.remove(); this.stage.destroy({ children: true }); }
      };
      // Inject the GPU shell; exercise the actual runtime and scenes, without
      // creating another initialization or diagnostic implementation for tests.
      runtime = Reflect.construct(ShowPixiRuntime, [host, app, {
        scene: "float", images: [], dataKey: "diagnostics", order: "latest",
        waterfallColumns: 4, floatSizeIndex: 5,
        running: true, reducedMotion: false, speed: 28, statsElement: output,
        onColumnsChange: (value: number) => value,
        onFloatSizeIndexChange: (value: number) => value,
        onMotionActiveChange: (active: boolean) => motion.push(active),
        onManualVerticalMovement() {}, onNeedImages() {}, onOpen() {}, onVisibleItems() {}
      }]) as ShowPixiRuntime;
      for (let i = 0; i < 10; i++) tick({ elapsedMS: 16 });
      assert.equal(runtime.snapshot().frames, enabled ? 10 : 0);
      assert.equal(observed, enabled ? 1 : 0);
      assert.deepEqual(motion, [true]);
      runtime.setRunning(false);
      runtime.setRunning(true);
      runtime.setDialogOpen(true);
      runtime.setDialogOpen(false);
      runtime.setScene("waterfall");
      assert.deepEqual(motion, [true, false, true, false, true]);
      assert.equal(runtime.snapshot().inputEnabled, true);
      if (enabled) {
        runtime.exposeDebug();
        assert.equal(output!.dataset.scene, "waterfall");
        assert.equal(window.__imageShowPixiDebug?.snapshot().frames, 10);
      } else {
        assert.equal(window.__imageShowPixiDebug, undefined);
      }
      runtime.destroy();
      assert.equal(motion.at(-1), false);
      assert.equal(disconnected, enabled ? 1 : 0);
      assert.equal(resizeDisconnected, 1);
      assert.equal(app.ticker.count, 0);
      assert.equal(app.ticker.started, false);
      assert.equal(app.canvas.isConnected, false);
      assert.equal(window.__imageShowPixiDebug, undefined);
      if (enabled) assert.deepEqual(window.__imageShowPixiLastCleanup, {
        activePointers: 0, canvasConnected: false, inputListenerCount: 0,
        runtimeTickerRemoved: true, sceneActive: false, textureEntries: 0,
        tickerStarted: false
      });
    });
  }
});

test("展映稳定几何复用命中矩形，缩放和聚焦变化仍更新几何", async (t) => {
  const h = await createTextureRecoveryHarness(t);
  const card = h.card("stable-geometry");
  await h.flush();
  const bounds = card.root.hitArea as Rectangle;
  card.update(16);
  assert.equal(card.root.hitArea, bounds);
  assert.deepEqual([bounds.x, bounds.y, bounds.width, bounds.height], [-50, -50, 100, 100]);
  card.assign(card.key, card.image!, 180, 260, .04, true);
  card.setFocused(true);
  for (let i = 0; i < 150; i++) card.update(16, true);
  assert.equal(card.root.hitArea, bounds);
  assert.deepEqual([bounds.x, bounds.y, bounds.width, bounds.height], [-90, -130, 180, 260]);
  assert.equal(card.root.zIndex, 100_000);
  assert.ok(card.root.scale.x > 1);
  card.setRenderScale(.5);
  card.update(16);
  assert.equal(card.root.hitArea, bounds);
  assert.equal(card.isInteractionActive, true);
});

test("float 键盘聚焦卡片回收后不向新图片传递焦点", (t) => {
  const h = createFloatSceneHarness(t);
  h.scene.focusCard(h.visibleItems()[0].key);
  const focused = h.scene.root.children.find((card) => card.zIndex === 100_000);
  assert.ok(focused);
  h.dragBy(-6_000);
  assert.ok(h.scene.stats().recycledSprites > 0);
  assert.equal(focused.zIndex, 1, "回收后的图片必须退出旧聚焦层级");
  h.target.emit("pointerup", { timeStamp: 32 });
  h.advance(180);
  const recycledY = focused.y;
  h.scene.setMotion(true, false);
  h.advance(2);
  assert.ok(focused.y < recycledY, "释放手动输入后新图片继续自动上浮");
});

test("纹理容量释放唤醒等待卡片且不重置位置，销毁卡片取消等待", async (t) => {
  const h = await createTextureRecoveryHarness(t);
  const first = h.card("first");
  await h.flush();
  assert.equal(first.isTextureReady, true);
  const waiting = h.card("waiting");
  waiting.root.position.set(143, 257);
  waiting.root.rotation = .08;
  await h.flush();
  assert.equal(waiting.isTextureReady, false);
  assert.equal(h.requests.length, 1, "容量不足不发请求");
  first.destroy();
  await h.flush();
  assert.equal(waiting.isTextureReady, true, "不依赖重新 assign 或 ticker 才恢复");
  assert.deepEqual([waiting.root.x, waiting.root.y, waiting.root.rotation], [143, 257, .08]);
  const removed = h.card("removed");
  await h.flush();
  removed.destroy();
  waiting.destroy();
  await h.flush();
  assert.equal(h.requests.length, 2, "已回收卡片不能被缓存唤醒");
  assert.equal(h.cache.stats().entries, 0);
  assert.equal(h.cache.stats().reservedPixels, 0);
});

test("加载中释放的纹理在完成后唤醒等待卡片，即使空闲 LRU 未超限", async (t) => {
  const h = await createTextureRecoveryHarness(t, { maximumUnreferenced: 1, maximumPixels: 100_000 });
  const finish = h.hold("held");
  const first = h.card("held");
  const waiting = h.card("waiting");
  await new Promise((resolve) => setImmediate(resolve));
  first.destroy();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(waiting.isTextureReady, false);
  assert.equal(h.requests.length, 1);
  assert.ok(h.cache.stats().rejected >= 2, "loading 时释放引用仍不能淘汰该纹理");
  finish();
  await h.flush();
  assert.equal(waiting.isTextureReady, true, "ready 后可淘汰的状态转换必须唤醒等待者");
  assert.equal(h.requests.length, 2);
});

test("纹理传输失败有界暂停，恢复联网允许重试且不重试 HTTP 错误", async (t) => {
  for (const phase of ["headers", "body"] as const) {
    await t.test(phase, async (t) => {
      const h = await createTextureRecoveryHarness(t, { maximumEntries: 6 });
      const missing = h.card("missing");
      await h.flush();
      h.setOffline(true, phase);
      const cards = [];
      for (let i = 0; i < 4; i += 1) {
        cards.push(h.card(`offline-${i}`));
        await h.flush();
      }
      assert.equal(h.requests.length, 4, "同源三次传输失败后停止该来源请求");
      await h.flush();
      assert.equal(h.requests.length, 4, "等待期间不轮询网络");
      const resumedCard = h.card("offline-0");
      h.setOffline(false);
      h.cache.resumeTransportRequests();
      await h.flush();
      assert.equal(resumedCard.isTextureReady, true, "同一提交内创建卡片并恢复播放不能丢掉待恢复租约");
      assert.ok(cards.every((card) => card.isTextureReady), JSON.stringify({ ready: cards.map((card) => card.isTextureReady), requests: h.requests, stats: h.cache.stats() }));
      assert.equal(missing.isTextureReady, false);
      assert.equal(h.requests.filter((url) => url.includes("missing")).length, 1);
      assert.equal(h.requests.length, 8);
    });
  }
});

test("详情成功加载同一 URL 后恢复失败纹理，原位共享且不重试其他失败图", async (t) => {
  for (const failure of ["headers", "body", "http", "decode"] as const) {
    await t.test(failure, async (t) => {
      const h = await createTextureRecoveryHarness(t, { maximumEntries: 6 });
      const healthy = h.card("healthy");
      await h.flush();
      const other = h.card("missing-other");
      await h.flush();
      if (failure === "http") h.setStatus("recover", 503);
      else if (failure === "decode") h.setDecodeFailure(true);
      else h.setOffline(true, failure);
      const first = h.card("recover");
      await h.flush();
      const second = h.card("recover");
      first.root.position.set(143, 257);
      first.root.rotation = .08;
      await h.flush();
      assert.equal(first.isTextureReady, false);
      assert.equal(h.requests.length, 3);
      h.setOffline(false);
      h.setDecodeFailure(false);
      h.setStatus("recover", 200);
      h.cache.retryFailedUrl("https://textures.example/full-recover.webp");
      await h.flush();
      assert.equal(h.requests.length, 3, "不同原图 URL 成功不证明缩略图已恢复");
      const url = "https://textures.example/recover.webp";
      h.cache.retryFailedUrl(url);
      h.cache.retryFailedUrl(url);
      await h.flush();
      assert.equal(first.isTextureReady, true);
      assert.equal(second.isTextureReady, true);
      assert.equal(healthy.isTextureReady, true);
      assert.equal(other.isTextureReady, false);
      assert.equal(h.requests.length, 4, "重复成功信号和相同 LOD 副本共用一次重试，健康纹理保持复用");
      assert.deepEqual([first.root.x, first.root.y, first.root.rotation], [143, 257, .08]);
      h.cache.retryFailedUrl(url);
      await h.flush();
      assert.equal(h.requests.length, 4, "已恢复纹理不会再次请求");
    });
  }
});

test("纹理恢复按浏览器资源 URL 匹配，域名大小写与默认端口不产生两套失败记录", async (t) => {
  const h = await createTextureRecoveryHarness(t);
  h.setStatus("canonical", 503);
  const card = h.card("canonical", () => undefined, "https://TEXTURES.example:443/canonical.webp");
  await h.flush();
  assert.equal(card.isTextureReady, false);
  h.setStatus("canonical", 200);
  h.cache.retryFailedUrl("https://textures.example/canonical.webp");
  await h.flush();
  assert.equal(card.isTextureReady, true);
  assert.deepEqual(h.requests, Array(2).fill("https://textures.example/canonical.webp"));
});

test("图片成功信号解除来源暂停，CORS 仍失败时再次暂停且回收后不唤醒", async (t) => {
  const h = await createTextureRecoveryHarness(t, { maximumEntries: 6 });
  h.setOffline(true);
  const cards = [];
  for (let i = 0; i < 4; i++) {
    cards.push(h.card(`recovery-${i}`));
    await h.flush();
  }
  assert.equal(h.requests.length, 3);
  h.setOffline(false);
  h.cache.retryFailedUrl("https://textures.example/recovery-3.webp");
  await h.flush();
  assert.equal(cards[3].isTextureReady, true, "尚未发请求、仅被来源暂停拦住的卡片也能恢复");
  assert.ok(cards.slice(0, 3).every(card => !card.isTextureReady));
  h.setOffline(true);
  h.cache.retryFailedUrl("https://textures.example/recovery-0.webp");
  await h.flush();
  assert.equal(h.requests.length, 5);
  await h.flush();
  assert.equal(h.requests.length, 5, "DOM 图片成功不保证 CORS 成功；再次失败不能自动循环");
  cards[0].destroy();
  h.setOffline(false);
  h.cache.retryFailedUrl("https://textures.example/recovery-0.webp");
  await h.flush();
  assert.equal(h.requests.length, 5, "已回收卡片不会因迟到成功信号发起请求");
});

test("float 随机候选增量更新保留屏内卡片和纹理引用，500 张上限不触发重排", (t) => {
  const h = createFloatSceneHarness(t, { count: 800 });
  const images = showImages(800);
  h.scene.setImages(images, "random-float", "random");
  const positions = floatCardPositions(h.scene);
  const leases = h.activeLeases().map((entry) => entry.key);
  h.scene.setImages(images.map((image) => ({ ...image, title: "更新标题" })), "random-float", "random");
  assert.equal(h.scene.stats().retainedDtos, 500);
  assert.deepEqual(floatCardPositions(h.scene), positions, "元数据刷新不重置图片位置与身份");
  assert.deepEqual(h.activeLeases().map((entry) => entry.key), leases, "保留相同纹理引用，避免重新加载闪白");
});

test("float 导航位移保留拖动和惯性的指针类型，滚轮独立上报", async (t) => {
  for (const pointerType of ["mouse", "touch"]) {
    await t.test(pointerType, (t) => {
      const h = createFloatSceneHarness(t);
      h.target.emit("pointerdown", { clientY: 200, timeStamp: 0, pointerType });
      h.target.emit("pointermove", { clientY: 280, timeStamp: 16, pointerType });
      assert.deepEqual(h.movementPointerTypes, [pointerType]);
      h.target.emit("pointerup", { timeStamp: 20, pointerType });
      h.advance(1);
      assert.deepEqual(h.movementPointerTypes, [pointerType, pointerType]);
      h.movementPointerTypes.length = 0;
      h.target.emit("wheel", { deltaY: -120 });
      h.advance(1);
      assert.ok(h.movementPointerTypes.length > 0);
      assert.ok(h.movementPointerTypes.every((type) => type === undefined));
    });
  }
});

test("float 桌面三种尺寸保持混排宽度、卡片与候选上限、两端预取总预算", async (t) => {
  for (const sizeIndex of [0, defaultShowFloatSizeIndex, showFloatSizeSteps.length - 1]) {
    await t.test(`尺寸 ${showFloatSizeSteps[sizeIndex]}×`, (t) => {
      const h = createFloatSceneHarness(t, { sizeIndex });
      const stats = h.scene.stats();
      assert.equal(stats.retainedDtos, 500);
      assert.ok(stats.activeSprites >= 8 && stats.activeSprites <= 180);
      const prefetches = h.activeLeases().length - stats.activeSprites;
      assert.ok(prefetches >= 12 && prefetches <= 36, "上下队列共享一个总预算");
      const targetWidth = showFloatDefaultWidth(1440) * showFloatSizeSteps[sizeIndex];
      const widths = floatCardPositions(h.scene).map((card) => card.width / targetWidth);
      assert.ok(widths.every((width) => width >= 0.5 && width <= 1.3));
      assert.ok(Math.min(...widths) < 0.7 && Math.max(...widths) > 1.1);
      assert.ok(h.scene.stats().coverageRatio > 0);
    });
  }
});

test("float 暂停时连续双向补图，保留反向预取并接管已加载纹理", (t) => {
  const h = createFloatSceneHarness(t);
  const initialCount = h.scene.stats().activeSprites;
  const prefetches = h.acquisitions.slice(initialCount);
  const reverseReserve = prefetches.slice(Math.ceil(prefetches.length / 2));
  assert.ok(reverseReserve.length >= 6);
  h.resolveTextures();
  h.dragBy(-2700);
  assert.ok(reverseReserve.every((entry) => entry.active), "向上移动不取消上方的反向储备");
  assert.ok(h.acquisitions.some((entry) => entry.shared && entry.readyAtAcquire));
  const upwardRecycles = h.scene.stats().recycledSprites;
  assert.ok(upwardRecycles > 0);
  h.dragBy(2700);
  assert.ok(h.scene.stats().recycledSprites > upwardRecycles);
  assert.ok(reverseReserve.some((entry) => !entry.active), "向下移动消费事先保留的上方队列");
  for (const delta of [-450, 450, -3600, 3600, -900, 900]) {
    h.dragBy(delta);
    assert.equal(h.scene.stats().activeSprites, initialCount);
    assert.ok(h.scene.stats().visibleSprites > 0);
    assert.ok(h.activeLeases().length <= initialCount + 36);
  }
  assert.ok(h.movements.some((delta) => delta > 0));
  assert.ok(h.movements.some((delta) => delta < 0));
  assert.equal(h.requests(), 0, "候选充足不因反向重复请求元数据");
});

test("float 快速反向直接响应新滚轮方向，屏内卡片不跳位且暂停保持", (t) => {
  const h = createFloatSceneHarness(t);
  h.resolveTextures();
  h.target.emit("wheel", { deltaY: 360 });
  h.scene.update(16);
  const before = floatCardPositions(h.scene).filter((card) => card.y > 100 && card.y < 800);
  assert.ok(before.length > 0);
  const movementCount = h.movements.length;
  h.target.emit("wheel", { deltaY: -72 });
  h.scene.update(16);
  assert.ok(h.movements[movementCount] < 0, "不先抵消旧方向的剩余滚动量");
  for (const card of before) {
    assert.equal(card.root.x, card.x);
    assert.ok(card.root.y > card.y && card.root.y - card.y < 72);
    assert.equal((card.root.hitArea as Rectangle).width, card.width);
  }
  h.advance(120);
  const settled = floatCardPositions(h.scene).map(({ x, y, rotation }) => ({ x, y, rotation }));
  h.advance(30);
  assert.deepEqual(floatCardPositions(h.scene).map(({ x, y, rotation }) => ({ x, y, rotation })), settled);
});

test("float 自动上浮与轻旋转保留，手动输入让位后无需等待恢复", (t) => {
  const h = createFloatSceneHarness(t);
  const card = floatCardPositions(h.scene).find((item) => item.y > 300 && item.y < 600);
  assert.ok(card);
  h.scene.setMotion(true, false);
  h.advance(30);
  assert.ok(card.root.y < card.y);
  assert.ok(Math.abs(card.root.rotation - card.rotation) > 0);
  assert.ok(Math.abs(card.root.rotation - card.rotation) <= 3 * Math.PI / 180);
  h.target.emit("pointerdown", { clientY: 400, timeStamp: 100 });
  const heldY = card.root.y;
  h.advance(5);
  assert.equal(card.root.y, heldY);
  h.target.emit("pointerup", { timeStamp: 200 });
  h.scene.update(16);
  assert.ok(card.root.y < heldY, "无手动余量时下一帧即恢复自动上浮");
});

test("float 元数据补充使用少于 96 张的边界", async (t) => {
  for (const count of [95, 96]) {
    await t.test(`${count} 张候选`, (t) => {
      const h = createFloatSceneHarness(t, { count });
      assert.equal(h.requests() > 0, count < 96);
    });
  }
});

async function createConfigStreamHarness(t: TestContext, { honorAbort = true } = {}) {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { window, document } = parseHTML("<html><body><div id=root></div></body></html>");
  const pending: Array<{ path: string; body?: BodyInit | null; signal: AbortSignal | null | undefined; resolve: (response: Response) => void }> = [];
  const globals = {
    window, document, self: window, navigator: window.navigator,
    location: new URL("https://img.example/show"),
    matchMedia: (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }),
    HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
    React, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (path: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      if (String(path).endsWith("/logs/client-errors")) { resolve(Response.json({ ok: true })); return; }
      pending.push({ path: String(path), body: init?.body, signal: init?.signal, resolve });
      if (honorAbort) init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })
  };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const root = createRoot(document.getElementById("root")!);
  t.after(async () => {
    try { await React.act(async () => root.unmount()); }
    finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    }
  });
  const flush = async () => {
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  return {
    React, root, document, pending, flush,
    render: async (node: import("react").ReactNode) => { await React.act(async () => root.render(node)); },
    respond: async (index: number, body: unknown, status = 200) => {
      await React.act(async () => pending[index].resolve(Response.json(body, { status })));
      await flush();
    }
  };
}

test("后台配置首载失败可重试，配置到达前不挂载，后台刷新失败保留已编辑页面", async (t) => {
  const h = await createConfigStreamHarness(t);
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { AdminSettingsBoundary } = await import("../../packages/web/src/components/feedback/AdminSettingsBoundary.tsx");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  t.after(() => client.clear());
  let mounts = 0;
  function Page({ pageSize }: { pageSize: number }) {
    const [value, setValue] = h.React.useState(() => { mounts += 1; return pageSize; });
    return h.React.createElement("button", { onClick: () => setValue((current) => current + 1) }, String(value));
  }
  await h.render(h.React.createElement(QueryClientProvider, { client },
    h.React.createElement(AdminSettingsBoundary, {
      children: (settings) => h.React.createElement(Page, { pageSize: settings.admin.image_page_size })
    })
  ));
  assert.equal(mounts, 0);
  assert.equal(h.pending.length, 1);
  await h.respond(0, { error: "暂时不可用" }, 503);
  assert.equal(mounts, 0);
  assert.ok(h.document.querySelector('[role="alert"]'));
  const retry = [...h.document.querySelectorAll("button")].find((button) => button.textContent?.includes("重试"));
  assert.ok(retry);
  await h.React.act(async () => retry.click());
  assert.equal(h.pending.length, 2);
  await h.respond(1, { settings: { admin: { image_page_size: 73 } } });
  assert.equal(mounts, 1);
  assert.equal(h.document.querySelector("button")?.textContent, "73");
  await h.React.act(async () => h.document.querySelector("button")!.click());
  await h.React.act(async () => { void client.refetchQueries({ queryKey: queryKeys.settings }); });
  await h.respond(2, { error: "刷新失败" }, 503);
  assert.equal(h.document.querySelector("button")?.textContent, "74");
  assert.equal(mounts, 1, "已有设置的后台失败不能重挂内容接入与编辑状态");
});

test("float 鼠标悬停平滑摆正，提前释放和完整释放均从当前角度继续", async (t) => {
  for (const frames of [4, 20]) {
    await t.test(`${frames} 帧后释放`, (t) => {
      const h = createFloatSceneHarness(t);
      h.scene.setMotion(true, false);
      h.advance(10);
      const card = floatCardPositions(h.scene).find((item) => item.y > 200 && item.y < 700 && Math.abs(item.rotation) > .01)!;
      assert.ok(card);
      const heldY = card.root.y;
      card.root.emit("pointerover", { pointerType: "mouse", global: { x: card.x, y: card.y } });
      h.advance(frames);
      assert.equal(card.root.y, heldY);
      assert.ok(Math.abs(card.root.rotation) < Math.abs(card.rotation));
      if (frames === 20) assert.ok(Math.abs(card.root.rotation) < .00001);
      const releasedAngle = card.root.rotation;
      card.root.emit("pointerout");
      h.advance(1);
      assert.ok(Math.abs(card.root.rotation - releasedAngle) < .001, "释放不能跳回旧倾角");
      assert.ok(card.root.y < heldY);
    });
  }
});

test("展映补图失败只等待显式重试，切换查询会取消旧请求并保留提交边界", async (t) => {
  const h = await createConfigStreamHarness(t);
  const { useShowData } = await import("../../packages/web/src/pages/show/useShowData.ts");
  let current!: ReturnType<typeof useShowData>;
  function Probe({ theme }: { theme: string }) {
    current = useShowData({ ...emptyGalleryFilters, theme }, theme, "latest");
    return null;
  }
  await h.render(h.React.createElement(Probe, { theme: "first" }));
  await h.respond(0, { items: showImages(3), next_cursor: "next" });
  assert.equal(current.images.length, 3);
  await h.React.act(async () => current.loadMore());
  await h.respond(1, { error: "补图失败" }, 503);
  assert.ok(current.error);
  await h.React.act(async () => { for (let frame = 0; frame < 100; frame += 1) current.loadMore(); });
  assert.equal(h.pending.length, 2, "场景逐帧补图信号不能变成网络重试循环");
  await h.React.act(async () => current.retry());
  assert.equal(h.pending.length, 3);
  assert.equal(new URL(h.pending[2].path, "https://img.example").searchParams.get("cursor"), "next");
  await h.render(h.React.createElement(Probe, { theme: "second" }));
  assert.equal(h.pending[2].signal?.aborted, true);
  assert.equal(current.committedKey, "first");
  await h.respond(2, { items: showImages(9), next_cursor: "stale" });
  assert.equal(current.committedKey, "first", "旧请求晚到不能提交到新筛选");
  await h.respond(3, { items: showImages(1), next_cursor: "" });
  assert.equal(current.committedKey, "second");
  assert.equal(current.images.length, 1);
  await h.React.act(async () => current.loadMore());
  assert.equal(h.pending.length, 4, "有序游标耗尽后不重复首批");
});

test("展映删除隔离晚到补图，编辑通过原查询刷新筛选成员并正确重试替换", async (t) => {
  const h = await createConfigStreamHarness(t, { honorAbort: false });
  const { useShowData } = await import("../../packages/web/src/pages/show/useShowData.ts");
  let current!: ReturnType<typeof useShowData>;
  function Probe() {
    current = useShowData({ ...emptyGalleryFilters, theme: "included", device: "auto" }, "filtered", "latest");
    return null;
  }
  const initial = showImages(3);
  await h.render(h.React.createElement(Probe));
  await h.respond(0, { items: initial, next_cursor: "next" });
  await h.React.act(async () => current.loadMore());
  await h.React.act(async () => current.removeImage(initial[0].id));
  assert.equal(h.pending[1].signal?.aborted, true);
  await h.respond(1, { items: initial, next_cursor: "stale" });
  assert.deepEqual(current.images.map((image) => image.id), initial.slice(1).map((image) => image.id));
  assert.equal(new URL(h.pending[2].path, "https://img.example").searchParams.get("cursor"), "next");
  await h.respond(2, { items: initial.slice(1), next_cursor: "end" });
  await h.React.act(async () => current.refreshImages());
  const refreshUrl = new URL(h.pending[3].path, "https://img.example");
  assert.equal(refreshUrl.searchParams.get("cursor"), null);
  assert.equal(refreshUrl.searchParams.get("theme"), "included");
  await h.React.act(async () => current.removeImage(initial[1].id));
  assert.equal(h.pending[3].signal?.aborted, true);
  assert.equal(new URL(h.pending[4].path, "https://img.example").searchParams.get("cursor"), null, "中断替换后仍从首批刷新");
  await h.respond(3, { items: initial, next_cursor: "stale" });
  await h.respond(4, { error: "刷新失败" }, 503);
  assert.equal(current.images.length, 1, "失败保留已提交画面");
  await h.React.act(async () => current.retry());
  assert.equal(new URL(h.pending[5].path, "https://img.example").searchParams.get("cursor"), null);
  await h.respond(5, { items: [], next_cursor: "" });
  assert.deepEqual(current.images, [], "改过分类而不再匹配的图片由权威查询移除");
  assert.equal(current.initialLoading, false);
});

test("瀑布缩放保持视口四周 35% 驻留缓冲并按世界坐标换算", () => {
  const residence: ShowResidencePolicy = {
    horizontalOverscanScreens: 0.35,
    verticalOverscanScreens: 0.35
  };
  const window = showViewportWindow(
    { x: 120, y: 240 },
    { width: 800, height: 600 },
    2,
    residence
  );
  assert.deepEqual(window.visible, {
    left: 60,
    top: 120,
    right: 460,
    bottom: 420
  });
  assert.deepEqual(window.resident, {
    left: -80,
    top: 15,
    right: 600,
    bottom: 525
  });
  const zoomed = showViewportWindow(
    { x: -140, y: -30 },
    { width: 800, height: 600 },
    1,
    residence
  );
  assert.deepEqual(zoomed.resident, { left: -420, top: -240, right: 940, bottom: 780 });
});

test("展映窗口可独立指定四向缓冲比例", () => {
  const window = showViewportWindow(
    { x: 120, y: 240 },
    { width: 800, height: 600 },
    2,
    {
      horizontalOverscanScreens: 0.5,
      verticalOverscanScreens: 0.5
    }
  );
  assert.deepEqual(window.resident, {
    left: -140,
    top: -30,
    right: 660,
    bottom: 570
  });
});

test("展映卡片维持窄缝且不回退为刚性网格", () => {
  const source = showImages(1)[0];
  const geometries = Array.from({ length: 80 }, (_, index) => (
    showCardGeometry(source, index % 9 - 4, index - 40)
  ));
  for (const geometry of geometries) {
    assert.ok(geometry.width >= 360 * 0.985);
    assert.ok(geometry.width < 360 * 0.992);
    assert.ok(geometry.gapAfter >= 4);
    assert.ok(geometry.gapAfter < 6);
  }
  assert.ok(new Set(geometries.map((geometry) => geometry.gapAfter)).size > 70);
  assert.ok(new Set(geometries.map((geometry) => geometry.angle)).size > 70);
});

test("展映乱序采用 Fisher-Yates 且不改写输入", () => {
  const source = showImages(4);
  const values = [0.25, 0.75, 0.5];
  const shuffled = shuffledShowImages(source, () => values.shift() ?? 0);
  assert.deepEqual(
    source.map((image) => image.id),
    showImages(4).map((image) => image.id)
  );
  assert.deepEqual(shuffled.map((image) => image.id), [
    source[0].id,
    source[3].id,
    source[2].id,
    source[1].id
  ]);
});

test("展映数据池先耗尽唯一图片再进行有界复用", () => {
  const pool = new ShowDataPool(10);
  pool.add(showImages(10));
  const claimed = Array.from({ length: 10 }, (_, index) => pool.claim(`slot-${index}`));
  assert.equal(new Set(claimed.map((image) => image?.id)).size, 10);
  assert.equal(pool.claim("overflow")?.id, claimed[0]?.id);
  pool.release("slot-4");
  assert.equal(pool.claim("replacement")?.id, claimed[4]?.id);
  assert.deepEqual(pool.snapshot(), { active: 11, available: 0, retained: 10 });
  pool.release("overflow");
  assert.deepEqual(pool.snapshot(), { active: 10, available: 0, retained: 10 });
  pool.release("slot-0");
  assert.equal(pool.snapshot().available, 1);
  assert.equal(pool.claim("returned")?.id, claimed[0]?.id);
  assert.equal(pool.remove(claimed[0]!.id), true);
  assert.notEqual(pool.claim("after-remove")?.id, claimed[0]?.id);
  assert.deepEqual(pool.snapshot(), { active: 10, available: 0, retained: 9 });
});

test("展映有限图片池仍填满超密驻留窗口", () => {
  const pool = new ShowDataPool(4);
  pool.add(showImages(4));
  const controller = new ShowWindowController(pool);
  const viewport = { width: 736, height: 526 };
  controller.reconcile(
    { x: 0, y: 0 },
    viewport,
    0.25,
    {
      horizontalOverscanScreens: 0.5,
      verticalOverscanScreens: 0.5
    }
  );
  const snapshot = controller.snapshot();
  assert.equal(snapshot.missingCards, 0);
  assert.ok(snapshot.cards.length > 4);
  assert.equal(new Set(snapshot.cards.map((card) => card.image.id)).size, 4);
  assert.deepEqual(pool.snapshot(), {
    active: snapshot.cards.length,
    available: 0,
    retained: 4
  });
});

test("展映长距离二维移动保持卡片有界并填满驻留区", () => {
  const pool = new ShowDataPool(800);
  pool.add(showImages(800));
  const controller = new ShowWindowController(pool);
  const viewport = { width: 1440, height: 900 };
  const density = showWaterfallDensity(1440);
  const denseScale = 1440 / density.normalMaximumColumns / 360;
  const residence: ShowResidencePolicy = {
    horizontalOverscanScreens: 0.35, verticalOverscanScreens: 0.35
  };
  let maximumCards = 0;
  let minimumCards = Number.POSITIVE_INFINITY;

  for (let step = 0; step < 1200; step += 1) {
    const camera = {
      x: Math.sin(step / 31) * 2200,
      y: step * 21 - 6000
    };
    controller.reconcile(camera, viewport, denseScale, residence);
    const snapshot = controller.snapshot();
    assert.ok(snapshot.activeColumns < 32);
    maximumCards = Math.max(maximumCards, snapshot.cards.length);
    minimumCards = Math.min(minimumCards, snapshot.cards.length);
    assert.equal(snapshot.missingCards, 0);
    assert.equal(
      new Set(snapshot.cards.map((card) => card.image.id)).size,
      snapshot.cards.length
    );
    const outside = snapshot.cards.find((card) => !showRectsIntersect(
      showCardRect(card),
      snapshot.window.resident
    ));
    assert.equal(
      outside,
      undefined,
      JSON.stringify({ step, outside, resident: snapshot.window.resident })
    );
  }

  assert.ok(minimumCards > 20);
  assert.ok(maximumCards < 240);
  assert.ok(pool.snapshot().retained <= 800);
  assert.equal(pool.snapshot().active, controller.snapshot().cards.length);
});

test("展映远距离横移只保留驻留列并为回程生成新卡位", () => {
  const pool = new ShowDataPool(800);
  pool.add(showImages(800));
  const controller = new ShowWindowController(pool);
  const viewport = { width: 736, height: 526 };
  const residence: ShowResidencePolicy = {
    horizontalOverscanScreens: 0.35, verticalOverscanScreens: 0.35
  };
  controller.reconcile({ x: 0, y: 0 }, viewport, 1, residence);
  const initialKey = controller.snapshot().cards.find((card) => card.column === 0)?.key;
  assert.ok(initialKey);

  for (let step = 1; step <= 2_000; step += 1) {
    controller.reconcile(
      { x: step * 1_000, y: step * 3 },
      viewport,
      1,
      residence
    );
    const snapshot = controller.snapshot();
    assert.ok(snapshot.activeColumns < 32);
    assert.ok(snapshot.cards.length < 320);
    assert.equal(pool.snapshot().active, snapshot.cards.length);
  }

  controller.reconcile({ x: 0, y: 0 }, viewport, 1, residence);
  const reentryKey = controller.snapshot().cards.find((card) => card.column === 0)?.key;
  assert.ok(reentryKey);
  assert.notEqual(reentryKey, initialKey);
});

test("展映窗口清空时释放全部卡位与 DTO 强引用", () => {
  const pool = new ShowDataPool(300);
  pool.add(showImages(300));
  const controller = new ShowWindowController(pool);
  controller.reconcile(
    { x: 0, y: 0 },
    { width: 736, height: 526 },
    1,
    { horizontalOverscanScreens: 0.35, verticalOverscanScreens: 0.35 }
  );
  assert.ok(pool.snapshot().active > 0);
  controller.clear();
  assert.equal(controller.snapshot().cards.length, 0);
  assert.deepEqual(pool.snapshot(), { active: 0, available: 300, retained: 300 });
  pool.clear();
  assert.deepEqual(pool.snapshot(), { active: 0, available: 0, retained: 0 });
});

test("配置包原始响应复用认证与 CSRF 边界且不探测 auth/me", async (t) => {
  const { apiResponse, getCsrfToken, setCsrfToken } = await import("../../packages/web/src/lib/api/client.ts");
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const events = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: events });
  t.after(() => { globalThis.fetch = originalFetch; clearCsrfToken(); if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else delete (globalThis as any).window; });
  let expired = 0;
  events.addEventListener(authExpiredEvent, () => expired++);
  const calls: string[] = [];
  setCsrfToken("export-token");
  globalThis.fetch = async (path, init) => {
    calls.push(String(path));
    assert.equal(init?.credentials, "same-origin");
    assert.equal(new Headers(init?.headers).get("x-csrf-token"), calls.length === 1 ? "export-token" : null);
    return calls.length === 1 ? new Response("proxy error", { status: 401 })
      : new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Disposition": 'attachment; filename="config.zip"' } });
  };
  await assert.rejects(apiResponse("/api/admin/advanced-config/export", { method: "POST" }), (e: any) => e.status === 401 && e.message === "HTTP 401");
  assert.equal(expired, 1);
  assert.equal(getCsrfToken(), "");
  const response = await apiResponse("/api/admin/advanced-config/export", { method: "POST" });
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
  assert.match(response.headers.get("content-disposition")!, /config.zip/);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((path) => !path.includes("/auth/me")));
});

test("日志等级保存隔离旧读取，跨文件缓存采用确认值且刷新失败不回退", async (t) => {
  const h = await createConfigStreamHarness(t, { honorAbort: false });
  const { registerHooks } = await import("node:module");
  const hooks = registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); } });
  const { LogPage } = await import("../../packages/web/src/pages/admin/LogPage.tsx").finally(() => hooks.deregister());
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { ActionFeedbackProvider } = await import("../../packages/web/src/components/feedback/ActionFeedbackRegion.tsx");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  t.after(() => client.clear());
  const payload = (level: string, selected = "app.log") => ({
    level, selected, content: "existing log", bytes_read: 12, limit_bytes: 100, truncated: false,
    files: ["app.log", "old.log"].map((name) => ({ name, size: 12, modified_at: "2026-09-05T00:00:00Z" }))
  });
  client.setQueryData([...queryKeys.logs, ""], payload("WARN"));
  client.setQueryData([...queryKeys.logs, "old.log"], payload("WARN", "old.log"));
  await h.render(h.React.createElement(QueryClientProvider, { client }, h.React.createElement(ActionFeedbackProvider, null, h.React.createElement(LogPage))));
  const select = (label: string) => h.document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
  const choose = async (label: string, value: string) => {
    const node = select(label) as any;
    let fiber = node[Object.keys(node).find((key) => key.startsWith("__reactFiber$"))!];
    while (fiber && !(fiber.memoizedProps?.ariaLabel === label && fiber.memoizedProps?.onChange)) fiber = fiber.return;
    assert.ok(fiber, label);
    await h.React.act(async () => { void fiber.memoizedProps.onChange(value); });
    await h.flush();
  };
  const visibleLevel = () => select("日志写入等级").textContent;
  await h.React.act(async () => { void client.refetchQueries({ queryKey: [...queryKeys.logs, ""], exact: true }); });
  await choose("日志写入等级", "INFO");
  assert.equal(h.pending.length, 2);
  await choose("日志文件", "old.log");
  await h.respond(1, { level: "INFO" });
  assert.equal(h.pending[0].signal?.aborted, true);
  assert.equal(h.pending.length, 3, "保存后只刷新当前文件一次");
  assert.equal(h.pending[2].path, "/api/admin/logs?file=old.log");
  await h.respond(0, payload("WARN"));
  await h.respond(2, { error: "failed" }, 503);
  await h.React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
  assert.equal(visibleLevel(), "INFO");
  for (const file of ["", "old.log"]) assert.equal(client.getQueryData<any>([...queryKeys.logs, file]).level, "INFO");
  await choose("日志文件", "");
  assert.equal(visibleLevel(), "INFO");
  await h.respond(3, payload("INFO"));
  await choose("日志写入等级", "DEBUG");
  await h.respond(4, { error: "POST failed" }, 503);
  await h.React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
  assert.equal(visibleLevel(), "INFO");
  assert.equal(h.pending.length, 5, "失败提交不发起刷新");
});

test("词条卡片同 slug 按字段保护 dirty，clean 跟随权威且成功保存立即归于 clean", async (t) => {
  const h = await createConfigStreamHarness(t);
  const { VocabularyAdminCard } = await import("../../packages/web/src/pages/admin/VocabularyAdminCard.tsx");
  const propsFor = (node: Element) => (node as any)[Object.keys(node).find((key) => key.startsWith("__reactProps$"))!];
  for (const kind of ["themes", "tags", "authors"] as const) {
    let item = { slug: kind, display_name: "old", image_count: 1, link: "https://example.com/old" };
    let refreshFails = false;
    const props = { kind, onChanged: async () => { if (refreshFails) throw Error("refresh failed"); }, onDelete() {}, onError() {}, reorderBusy: false, canMovePrevious: false, canMoveNext: false, onMove() {}, onReorderControlRef() {} };
    const render = async () => h.render(h.React.createElement(VocabularyAdminCard, { ...props, item }));
    await render();
    const display = () => h.document.querySelector<HTMLInputElement>(".entity-display-input")!;
    const change = async (value: string) => h.React.act(async () => propsFor(display()).onChange({ target: { value } }));
    item = { ...item, display_name: "fresh" }; await render();
    assert.equal(display().value, "fresh");
    await change(" mine ");
    item = { ...item, display_name: "remote", link: "https://example.com/fresh" }; await render();
    assert.equal(display().value, " mine ");
    if (kind === "authors") assert.equal(h.document.querySelector<HTMLInputElement>(".entity-link-input")!.value, item.link);
    const save = h.document.querySelector<HTMLButtonElement>(".entity-card-foot .button")!;
    refreshFails = true;
    await h.React.act(async () => save.click());
    const requestIndex = h.pending.length - 1;
    await h.respond(requestIndex, kind === "authors" ? { item: { ...item, display_name: "mine" } } : { ok: true });
    assert.equal(display().value, "mine");
    // Props stay stale after failed refresh; the next authority update should still replace clean saved input.
    item = { ...item, display_name: "new authority" }; await render();
    assert.equal(display().value, "new authority");
    await change("unsaved");
    item = { ...item, slug: kind + "-other", display_name: "replacement" }; await render();
    assert.equal(display().value, "replacement");
    await h.render(null);
  }
});

test("站点配置保留未保存值，保存锁住所有控件并在超时、失败和卸载后收口", async (t) => {
  const h = await createConfigStreamHarness(t);
  const { registerHooks } = await import("node:module");
  const hooks = registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); } });
  const { SettingsPage } = await import("../../packages/web/src/pages/admin/SettingsPage.tsx").finally(() => hooks.deregister());
  const { appConfig } = await import("../../packages/shared/src/app-config.ts");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  t.after(() => client.clear());
  const originalTimeout = AbortSignal.timeout;
  let deadline = new AbortController();
  AbortSignal.timeout = (ms) => { assert.equal(ms, 15_000); deadline = new AbortController(); return deadline.signal; };
  t.after(() => { AbortSignal.timeout = originalTimeout; });
  let settings = structuredClone(appConfig.runtimeDefaults);
  client.setQueryData(queryKeys.settings, { settings });
  await h.render(h.React.createElement(QueryClientProvider, { client }, h.React.createElement(SettingsPage)));
  const input = () => h.document.querySelector<HTMLInputElement>('input[placeholder="站点名称"]')!;
  const propsFor = (node: Element) => (node as any)[Object.keys(node).find((key) => key.startsWith("__reactProps$"))!];
  const edit = async (value: string) => h.React.act(async () => propsFor(input()).onChange({ target: { value } }));
  const publish = async (name: string) => { settings = { ...settings, site: { ...settings.site, name } }; await h.React.act(async () => client.setQueryData(queryKeys.settings, { settings })); await h.flush(); };
  const save = () => [...h.document.querySelectorAll<HTMLButtonElement>(".settings-head-actions button")].at(-1)!;
  const locked = () => h.document.querySelector("fieldset")!.hasAttribute("disabled");
  await publish("fresh"); assert.equal(input().value, "fresh");
  await edit("unsaved"); await publish("background"); assert.equal(input().value, "unsaved");
  const number = h.document.querySelector<HTMLInputElement>('input[type="number"]')!;
  await h.React.act(async () => { propsFor(number).onFocus(); propsFor(number).onChange({target:{value:"77"}}); });
  Object.defineProperty(h.document,"activeElement",{configurable:true,get:()=>number});
  number.blur = () => propsFor(number).onBlur({target:{value:number.value}});
  await h.React.act(async () => { save().click(); save().click(); });
  assert.equal(JSON.parse(String(h.pending[0].body)).site.gallery.limit,77,"锁定前同步结算数字输入，提交当前可见值");
  delete (h.document as any).activeElement;
  assert.equal(h.pending.length, 1); assert.equal(locked(), true);
  assert.ok([...h.document.querySelectorAll('.select-trigger')].every((element) => element.hasAttribute("disabled")));
  await edit("blocked"); assert.equal(input().value, "unsaved");
  await h.React.act(async () => deadline.abort(new DOMException("timed out", "TimeoutError")));
  await h.React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
  assert.equal(locked(), false); assert.equal(input().value, "unsaved");
  assert.match(h.document.querySelector('[role="alert"]')!.textContent!, /超时/);
  await edit("normalized input ");
  await h.React.act(async () => save().click());
  await h.respond(1, { settings: { ...settings, site: { ...settings.site, name: "normalized input" } } });
  await h.React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
  assert.equal(input().value, "normalized input"); assert.equal(locked(), false);
  assert.equal(h.pending.length, 2, "成功响应直接发布配置，无 GET 回读");
  await publish("after save"); assert.equal(input().value, "after save");
  await edit("retain after failure"); await h.React.act(async () => save().click());
  await h.respond(2, { error: "save failure" }, 503);
  await h.React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
  assert.equal(locked(), false); assert.equal(input().value, "retain after failure");
  await h.React.act(async () => save().click());
  await h.render(null);
  assert.equal(h.pending[3].signal?.aborted, true);
});

test("词表首份请求尚未完成时新词条提交隔离旧响应", async () => {
  const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  let resolveOld!: (value: IngestionVocabularyDto) => void;
  let calls = 0;
  const old = { themes: [], authors: [], tags: [] } as IngestionVocabularyDto;
  const fresh = { ...old, tags: [{ slug: "new", display_name: "new" }] } as IngestionVocabularyDto;
  const observer = new QueryObserver(client, { queryKey: queryKeys.ingestionVocabulary, queryFn: () => ++calls === 1 ? new Promise<IngestionVocabularyDto>((resolve) => { resolveOld = resolve; }) : Promise.resolve(fresh) });
  const unsubscribe = observer.subscribe(() => {});
  try {
    const refresh = invalidateImageDataAfterMetadataSave(client, [{ id: "image", tags: ["new"] }], []);
    resolveOld(old);
    await refresh;
    assert.deepEqual(client.getQueryData(queryKeys.ingestionVocabulary), fresh);
    assert.equal(calls, 2);
  } finally { unsubscribe(); client.clear(); }
});

test("单项服务端状态桶覆盖等待、执行、重复待决和全部终态", async () => {
  const { ingestionStatusSummary } = await import("../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-status-summary.ts");
  const cases = [
    ["queued", false, false, "waiting"], ["received", false, false, "waiting"],
    ["downloading", false, false, "running"], ["preparing", false, false, "running"],
    ["preparing", false, true, "waiting"], ["ready", false, false, "ready"],
    ["ready", true, false, "duplicate_pending"], ["committing", false, false, "committing"],
    ["resolving", false, false, "resolving"], ["completed", true, true, "completed"],
    ["failed", true, true, "failed"]
  ] as const;
  for (const [status, duplicate, waiting, bucket] of cases) {
    const summary = ingestionStatusSummary(status, duplicate, waiting);
    assert.equal(summary.total, 1); assert.equal(summary.unfinished, status === "completed" ? 0 : 1);
    const { total, unfinished, ...buckets } = summary;
    assert.deepEqual(Object.entries(buckets).filter(([, value]) => value), [[bucket, 1]]);
  }
});

test("导入菜单键盘与来源标签保持真实 DOM 焦点和读屏关联", async (t) => {
  const h = await createConfigStreamHarness(t);
  const dom = h.document.defaultView!;
  let active: HTMLElement | null = h.document.body;
  Object.defineProperty(h.document, "activeElement", { configurable: true, get: () => active });
  const priorFocus = Object.getOwnPropertyDescriptor(dom.HTMLElement.prototype, "focus");
  const priorAttach = Object.getOwnPropertyDescriptor(dom.HTMLElement.prototype, "attachEvent");
  const priorDetach = Object.getOwnPropertyDescriptor(dom.HTMLElement.prototype, "detachEvent");
  (dom.HTMLElement.prototype as any).attachEvent = () => {};
  (dom.HTMLElement.prototype as any).detachEvent = () => {};
  const priorBlur = Object.getOwnPropertyDescriptor(dom.HTMLElement.prototype, "blur");
  dom.HTMLElement.prototype.focus = function () { active = this; this.dispatchEvent(new dom.Event("focusin", { bubbles: true })); };
  dom.HTMLElement.prototype.blur = function () { if (active === this) active = h.document.body; };
  const extra = {
    Event: dom.Event, MutationObserver: dom.MutationObserver,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    scrollTo() {}, scrollY: 0, innerWidth: 1440, innerHeight: 900,
    getComputedStyle: () => ({ getPropertyValue: () => "", display: "block", visibility: "visible", position: "static", overflowY: "visible" }),
    matchMedia: (media: string) => ({ media, matches: media.includes("prefers-reduced-motion") || media.includes("min-width"), addEventListener() {}, removeEventListener() {} })
  };
  const previous = new Map(Object.keys(extra).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key,value] of Object.entries(extra)) Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  const props = (node: Element) => (node as any)[Object.keys(node).find((key) => key.startsWith("__reactProps$"))!];
  const key = async (node: Element, value: string) => h.React.act(async () => props(node).onKeyDown({ key: value, preventDefault() {} }));
  try {
    const { ImportSplitButton } = await import("../../packages/web/src/pages/admin/ingestion/import/ImportSplitButton.tsx");
    let selected = ""; let opener: Element | undefined;
    const choose = (name: string) => (element: HTMLButtonElement) => { selected = name; opener = element; };
    const base = { pending:false, onPreloadWorkflow() {}, onPreloadImportSource() {}, onOpenWorkflow() {}, onOpenUrls:choose("urls"), onOpenJsonl:choose("jsonl"), onOpenWeibo:choose("weibo") };
    const renderMenu = async (pending=false) => h.render(h.React.createElement("div", null, h.React.createElement(ImportSplitButton, {...base,pending}), h.React.createElement("input", {id:"outside-menu"})));
    await renderMenu();
    const trigger = () => h.document.querySelector<HTMLButtonElement>('[title="更多导入方式"]')!;
    const items = () => [...h.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    for (const [index,mode] of [[0,"urls"],[1,"jsonl"],[2,"weibo"]] as const) {
      await h.React.act(async () => trigger().focus()); await key(trigger(),"ArrowDown"); await h.flush();
      assert.equal(h.document.activeElement, items()[0]);
      await key(items()[0],"End"); assert.equal(h.document.activeElement, items()[2]);
      await key(items()[2],"ArrowDown"); assert.equal(h.document.activeElement, items()[0]);
      await key(items()[0],"ArrowUp"); assert.equal(h.document.activeElement, items()[2]);
      await h.React.act(async () => items()[index].click());
      assert.equal(selected,mode); assert.equal(opener,trigger());
    }
    const outside = h.document.getElementById("outside-menu")!;
    await h.React.act(async () => outside.focus());
    await h.React.act(async () => props(trigger()).onPointerEnter({pointerType:"mouse"})); await h.flush();
    assert.equal(h.document.activeElement,outside);
    await h.React.act(async () => { const event = new dom.Event("keydown",{bubbles:true}); (event as any).key="Escape"; h.document.dispatchEvent(event); });
    assert.equal(h.document.activeElement,outside);
    await key(trigger(),"ArrowUp"); await h.flush();
    await h.React.act(async () => outside.focus()); assert.equal(items().length,0);
    await renderMenu(true); await key(trigger(),"ArrowDown"); assert.equal(items().length,0);
    await h.render(null);
    const { ImportSourceDialog } = await import("../../packages/web/src/pages/admin/ingestion/import/ImportSourceDialog.tsx");
    await h.render(h.React.createElement(ImportSourceDialog,{initialMode:"urls",autoImportAfterParse:false,maxItems:200,weiboMaxItems:10,onClose(){},onSubmit(){}}));
    const tabs = () => [...h.document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    for(const [value,index] of [["ArrowLeft",2],["ArrowRight",0],["End",2],["Home",0],["ArrowRight",1]] as const){
      const selectedTab=tabs().find(tab=>tab.getAttribute("aria-selected")==="true")!;
      await key(selectedTab,value);
      assert.equal(h.document.activeElement,tabs()[index]);
      assert.equal(tabs().filter(tab=>tab.getAttribute("tabindex")==="0").length,1);
      const panel=h.document.querySelector('[role="tabpanel"]')!;
      assert.equal(panel.getAttribute("aria-labelledby"),tabs()[index].id);
      assert.equal(tabs()[index].getAttribute("aria-controls"),panel.id);
    }
    await h.React.act(async () => tabs()[0].click());
    assert.equal(h.document.activeElement,h.document.querySelector("textarea"));

    // 解析请求尚未完成时父层重渲染，自动导入必须采用最新提交回调。
    for (const mode of ["weibo", "jsonl"] as const) {
      await h.render(null);
      const jobs: IngestionJob[] = [];
      let closed = 0;
      const renderSource = (storageSlug: string, theme: string) => h.render(
        h.React.createElement(ImportSourceDialog, {
          initialMode: mode, autoImportAfterParse: true, maxItems: 200, weiboMaxItems: 10,
          onClose() { closed += 1; },
          onSubmit(submission) {
            assert.notEqual(submission.mode, "urls");
            if (submission.mode === "urls") return;
            jobs.push(...createManifestImportJobs(
              submission.mode === "weibo" ? submission.result.manifest.items : submission.manifest.items,
              { device: "auto", brightness: "auto", theme, author: "", tags: [] },
              storageSlug, mode, false
            ));
          }
        })
      );
      await renderSource("local", "old");
      const textarea = h.document.querySelector("textarea")!;
      await h.React.act(async () => props(textarea).onChange({ target: { value: mode === "weibo"
        ? "https://weibo.com/123/Abc" : '{"original":"https://example.com/image.jpg"}' } }));
      const requestIndex = h.pending.length;
      await h.React.act(async () => h.document.querySelector<HTMLButtonElement>(".import-source-submit-button")!.click());
      assert.equal(h.pending.length, requestIndex + 1);
      assert.equal(jobs.length, 0);
      await renderSource("cos", "current");
      const manifest = { items: [{ original: "https://example.com/image.jpg", line: 1, batch_position: 0 }], errors: [] };
      await h.respond(requestIndex, mode === "weibo" ? { manifest, errors: [], posts: [] } : manifest);
      assert.equal(jobs.length, 1, "自动导入只提交一次");
      assert.equal(jobs[0].storageSlug, "cos");
      assert.equal(jobs[0].draft.theme, "current");
      assert.equal(closed, 1);
    }
  } finally {
    await h.render(null); await h.flush(); await h.flush();
    if(priorAttach) Object.defineProperty(dom.HTMLElement.prototype,"attachEvent",priorAttach); else delete (dom.HTMLElement.prototype as any).attachEvent;
    if(priorDetach) Object.defineProperty(dom.HTMLElement.prototype,"detachEvent",priorDetach); else delete (dom.HTMLElement.prototype as any).detachEvent;
    if(priorFocus) Object.defineProperty(dom.HTMLElement.prototype,"focus",priorFocus);
    if(priorBlur) Object.defineProperty(dom.HTMLElement.prototype,"blur",priorBlur);
    for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete(globalThis as any)[key];}
  }
});
