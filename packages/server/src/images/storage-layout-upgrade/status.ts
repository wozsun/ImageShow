import type {
  StorageLayoutUpgradeNamespaceDto,
  StorageLayoutUpgradeStatusDto
} from "@imageshow/shared/browser";
import { errorMessage } from "../../core/api-error.ts";
import { pool } from "../../core/database/pools.ts";
import { activeIngestionStorageReferences } from "../ingestion/cleanup/storage-references.ts";
import { readReadyImageCacheAdminStatus } from "../ready-cache/admin-status.ts";
import { getReadyImageRevision } from "../ready-cache/revision.ts";
import { listStorageBackends } from "../../storage/backends/registry.ts";
import { collectStorageKeys } from "../../storage/objects/access.ts";
import {
  isLegacyImageObjectKey,
  isStableImageObjectKey
} from "../../storage/objects/image-paths.ts";
import { STORAGE_ADMIN_LIST_MAX_KEYS } from "../../storage/objects/key-listing.ts";
import { groupStorageNamespaces } from "../../storage/objects/namespace.ts";

type LayoutImageRow = {
  object_key: string;
  image_size: string | number;
  thumbnail_size: string | number;
};

const layoutImageRowsQuery = `
  SELECT object_key, image_size, thumbnail_size
    FROM metadata
   WHERE status IN ('ready', 'deleted')`;

async function countPendingMediaCleanupJobs() {
  const row = (await pool.query(
    `SELECT count(DISTINCT job.id)::int AS count
       FROM background_job AS job
      WHERE job.type='move.cleanup'
        AND job.status IN ('pending', 'running', 'failed')
        AND EXISTS (
          SELECT 1
            FROM jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(job.payload->'objects')='array'
                  THEN job.payload->'objects'
                ELSE '[]'::jsonb
              END
            ) AS object
           WHERE object->>'prefix'='media'
        )`
  )).rows[0] as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

async function inspectLegacyMediaNamespaces(
  signal?: AbortSignal
): Promise<StorageLayoutUpgradeNamespaceDto[]> {
  const groups = groupStorageNamespaces(await listStorageBackends());
  const results: StorageLayoutUpgradeNamespaceDto[] = [];
  for (const group of groups) {
    signal?.throwIfAborted();
    const errors: string[] = [];
    let result: StorageLayoutUpgradeNamespaceDto | null = null;
    for (const backend of group) {
      try {
        const listing = await collectStorageKeys("media", backend.slug, {
          signal,
          maxKeys: STORAGE_ADMIN_LIST_MAX_KEYS
        });
        result = {
          namespace: group.map((item) => item.slug).toSorted().join(" / "),
          backends: group.map((item) => item.slug),
          media_objects: listing.count,
          complete: listing.complete,
          error: listing.complete
            ? ""
            : `旧 media 对象列举达到 ${STORAGE_ADMIN_LIST_MAX_KEYS} 项上限`
        };
        break;
      } catch (error) {
        signal?.throwIfAborted();
        errors.push(`${backend.slug}: ${errorMessage(error)}`);
      }
    }
    results.push(result ?? {
      namespace: group.map((item) => item.slug).toSorted().join(" / "),
      backends: group.map((item) => item.slug),
      media_objects: null,
      complete: false,
      error: errors.join("; ") || "存储命名空间不可用"
    });
  }
  return results;
}

export async function readStorageLayoutUpgradeStatus(
  signal?: AbortSignal
): Promise<StorageLayoutUpgradeStatusDto> {
  signal?.throwIfAborted();
  const [imagesResult, ingestion, pendingCleanup, revision] =
    await Promise.all([
      pool.query<LayoutImageRow>(layoutImageRowsQuery),
      activeIngestionStorageReferences({ signal }),
      countPendingMediaCleanupJobs(),
      getReadyImageRevision()
    ]);
  signal?.throwIfAborted();

  let compliantImages = 0;
  let remainingImages = 0;
  let invalidLayoutImages = 0;
  let estimatedTransferBytes = 0;
  for (const image of imagesResult.rows) {
    if (isStableImageObjectKey(image.object_key)) {
      compliantImages += 1;
      continue;
    }
    if (!isLegacyImageObjectKey(image.object_key)) {
      invalidLayoutImages += 1;
      continue;
    }
    remainingImages += 1;
    estimatedTransferBytes += Number(image.image_size)
      + Number(image.thumbnail_size);
  }
  if (!Number.isSafeInteger(estimatedTransferBytes)) {
    estimatedTransferBytes = Number.MAX_SAFE_INTEGER;
  }

  const activeLegacyIngestions = ingestion.rows.filter((row) => (
    row.final_object_key
    && isLegacyImageObjectKey(row.final_object_key)
  )).length;
  const projection = await readReadyImageCacheAdminStatus(revision.revision);
  signal?.throwIfAborted();
  // Re-listing a large S3 prefix after every short migration batch would make
  // progress O(batch count * object count). Physical media is only a final
  // completion gate after every cheaper authority has already converged.
  const inspectPhysicalMedia = remainingImages === 0
    && invalidLayoutImages === 0
    && activeLegacyIngestions === 0
    && pendingCleanup === 0
    && projection.synchronized === true;
  const namespaces = inspectPhysicalMedia
    ? await inspectLegacyMediaNamespaces(signal)
    : [];
  signal?.throwIfAborted();
  const mediaListingComplete = inspectPhysicalMedia
    && namespaces.every((item) => item.complete);
  const mediaObjects = mediaListingComplete
    ? namespaces.reduce((sum, item) => sum + (item.media_objects ?? 0), 0)
    : null;
  const complete = remainingImages === 0
    && invalidLayoutImages === 0
    && activeLegacyIngestions === 0
    && pendingCleanup === 0
    && mediaListingComplete
    && mediaObjects === 0
    && projection.synchronized === true;

  return {
    total_images: imagesResult.rows.length,
    compliant_images: compliantImages,
    remaining_images: remainingImages,
    invalid_layout_images: invalidLayoutImages,
    estimated_transfer_bytes: estimatedTransferBytes,
    active_legacy_ingestions: activeLegacyIngestions,
    pending_media_cleanup_jobs: pendingCleanup,
    media_objects: mediaObjects,
    media_listing_complete: mediaListingComplete,
    namespaces,
    projection: {
      authoritative_revision: revision.revision,
      applied_revision: projection.applied_revision,
      synchronized: projection.synchronized === true
    },
    can_migrate: activeLegacyIngestions === 0
      && invalidLayoutImages === 0,
    complete
  };
}
