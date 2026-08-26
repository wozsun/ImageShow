import type { Brightness, Device } from "@imageshow/shared/browser";
import type { PoolClient } from "pg";
import { ensureAuthorWithMutationLockHeld } from "../authors/mutations.ts";
import { ApiError, errorMessage } from "../core/api-error.ts";
import { withAdvisoryLocks } from "../core/database/advisory-locks.ts";
import { pool } from "../core/database/pools.ts";
import { logger } from "../core/logger.ts";
import type { ImageUpdateItemInput } from "../core/validation.ts";
import { readStorageBuffer, storageObjectExists } from "../storage/objects/access.ts";
import { thumbnailRef } from "../storage/objects/image-paths.ts";
import {
  discardPreparedImageRelocationIfUnreferenced,
  enqueuePreparedImageSourceCleanup,
  prepareVerifiedImageRelocation,
  type PreparedImageRelocation
} from "../storage/migration/image-relocation.ts";
import {
  imageStorageMutationLockKey,
  withStorageLocationReadAndAdvisoryLocks
} from "../storage/maintenance-lock.ts";
import {
  replaceImageTagAssociations
} from "../tags/mutations.ts";
import { resolveTagNames } from "../tags/query.ts";
import { ensureThemeWithMutationLockHeld } from "../themes/mutations.ts";
import {
  invalidateOrCollectEntityCountCaches,
  refreshEntityVocabularies,
  type EntityCacheKind,
  type EntityCountCacheInvalidationBatch
} from "../vocab/vocab-cache.ts";
import {
  vocabularyAssociationLockRequests
} from "../vocab/mutation-sync.ts";
import { detectBrightness } from "./brightness.ts";
import {
  deviceFromDimensions,
  resolveOptionalBrightnessWith,
  resolveOptionalDeviceWith
} from "./classification.ts";
import { withImageMutationSync } from "./mutation-sync.ts";
import {
  reportReadyImageCacheFailure,
  requestReadyImageCacheRebuildAfterMutation
} from "./ready-cache/coordinator.ts";
import { bumpReadyImageRevision } from "./ready-cache/revision.ts";

type UpdateImageRecord = {
  id: string;
  device: Device;
  brightness: Brightness;
  theme: string;
  width: number | string | null;
  height: number | string | null;
  ext: string;
  md5: string | null;
  object_key: string;
  storage_slug: string;
  author: string | null;
  title: string;
  description: string;
  source: string;
  original: string;
  status: string;
};

type ImageUpdateItemOptions = {
  entityCountInvalidationBatch: EntityCountCacheInvalidationBatch;
};

type ImageUpdateTransactionOutcome = {
  changed: boolean;
  changedEntityKinds: Set<EntityCacheKind>;
  createdEntityKinds: Set<EntityCacheKind>;
};

const updateImageColumns = [
  "id",
  "device",
  "brightness",
  "theme",
  "width",
  "height",
  "ext",
  "md5",
  "object_key",
  "storage_slug",
  "author",
  "title",
  "description",
  "source",
  "original",
  "status"
].join(", ");

function detectImageDevice(image: UpdateImageRecord) {
  if (image.status !== "ready") return undefined;
  return deviceFromDimensions(image.width, image.height);
}

async function detectImageBrightness(
  image: UpdateImageRecord,
  signal: AbortSignal
) {
  if (image.status !== "ready") return undefined;
  const thumb = thumbnailRef(image);
  if (!await storageObjectExists(
    thumb.prefix,
    thumb.key,
    thumb.slug,
    { signal }
  )) {
    return undefined;
  }
  return detectBrightness(await readStorageBuffer(
    thumb.prefix,
    thumb.key,
    thumb.slug,
    { signal }
  ));
}

function sameTags(left: readonly string[], right: readonly string[]) {
  return left.length === right.length
    && left.every((slug, index) => slug === right[index]);
}

async function repairDerivedCaches(
  outcome: ImageUpdateTransactionOutcome,
  options: ImageUpdateItemOptions
) {
  const tasks: Array<{ label: string; promise: Promise<unknown> }> = [];
  if (outcome.changedEntityKinds.size) {
    tasks.push({
      label: "entity_count",
      promise: invalidateOrCollectEntityCountCaches(
        outcome.changedEntityKinds,
        options.entityCountInvalidationBatch
      )
    });
  }
  if (outcome.createdEntityKinds.size) {
    tasks.push({
      label: "vocabulary",
      promise: refreshEntityVocabularies(outcome.createdEntityKinds)
    });
  }
  const results = await Promise.allSettled(tasks.map((task) => task.promise));
  results.forEach((result, index) => {
    if (result.status === "fulfilled") return;
    logger.warn("image_update_derived_cache_repair_failed", {
      repair: tasks[index].label,
      error: errorMessage(result.reason)
    });
  });
}

async function commitImageUpdate({
  item,
  resolvedTags,
  sourceImage,
  target,
  relocation,
  signal
}: {
  item: ImageUpdateItemInput;
  resolvedTags: string[] | null;
  sourceImage: UpdateImageRecord | null;
  target: Pick<UpdateImageRecord, "device" | "brightness" | "theme"> | null;
  relocation: PreparedImageRelocation | null;
  signal: AbortSignal;
}): Promise<ImageUpdateTransactionOutcome> {
  let client: PoolClient | undefined;
  let committed = false;
  try {
    signal.throwIfAborted();
    client = await pool.connect();
    signal.throwIfAborted();
    await client.query("BEGIN");
    const locked = (await client.query(
      `SELECT ${updateImageColumns} FROM metadata WHERE id=$1 FOR UPDATE`,
      [item.id]
    )).rows[0] as UpdateImageRecord | undefined;
    signal.throwIfAborted();
    if (!locked) throw new ApiError(404, "not_found", "Image not found");

    if (sourceImage) {
      if (locked.status !== "ready") {
        throw new ApiError(
          409,
          "invalid_image_state",
          "Only ready images can change category"
        );
      }
      if (
        locked.storage_slug !== sourceImage.storage_slug
        || locked.object_key !== sourceImage.object_key
        || locked.device !== sourceImage.device
        || locked.brightness !== sourceImage.brightness
        || locked.theme !== sourceImage.theme
      ) {
        throw new ApiError(
          409,
          "image_location_changed",
          "Image location changed while preparing the category update"
        );
      }
    }

    const currentTags = resolvedTags === null
      ? null
      : (await client.query(
          `SELECT tag_slug
             FROM image_tag
            WHERE image_id=$1
            ORDER BY tag_slug`,
          [item.id]
        )).rows.map((row) => String(row.tag_slug));
    signal.throwIfAborted();

    const nextClassification = target ?? {
      device: locked.device,
      brightness: locked.brightness,
      theme: locked.theme
    };
    const nextAuthor = item.author === undefined
      ? locked.author
      : item.author || null;
    const nextFields = {
      title: item.title ?? locked.title,
      description: item.description ?? locked.description,
      source: item.source ?? locked.source,
      original: item.original ?? locked.original
    };
    const classificationChanged = nextClassification.device !== locked.device
      || nextClassification.brightness !== locked.brightness
      || nextClassification.theme !== locked.theme;
    const authorChanged = nextAuthor !== locked.author;
    const fieldsChanged = (
      (item.title !== undefined && nextFields.title !== locked.title)
      || (item.description !== undefined
        && nextFields.description !== locked.description)
      || (item.source !== undefined && nextFields.source !== locked.source)
      || (item.original !== undefined && nextFields.original !== locked.original)
    );
    const metadataChanged = classificationChanged
      || authorChanged
      || fieldsChanged;
    const tagsChanged = resolvedTags !== null
      && !sameTags(resolvedTags, currentTags ?? []);
    const changed = metadataChanged || tagsChanged;
    const changedEntityKinds = new Set<EntityCacheKind>();
    const createdEntityKinds = new Set<EntityCacheKind>();

    if (!changed) {
      signal.throwIfAborted();
      await client.query("COMMIT");
      committed = true;
      return { changed, changedEntityKinds, createdEntityKinds };
    }

    if (
      locked.theme !== nextClassification.theme
      && nextClassification.theme !== "none"
      && await ensureThemeWithMutationLockHeld(
        client,
        nextClassification.theme
      )
    ) {
      createdEntityKinds.add("theme");
    }
    if (
      authorChanged
      && nextAuthor
      && await ensureAuthorWithMutationLockHeld(client, nextAuthor)
    ) {
      createdEntityKinds.add("author");
    }

    if (metadataChanged) {
      signal.throwIfAborted();
      const updated = await client.query(
        `UPDATE metadata
            SET device=$2,
                brightness=$3,
                theme=$4,
                object_key=$5,
                title=$6,
                description=$7,
                source=$8,
                original=$9,
                author=$10,
                thumbnail_size=COALESCE($11::bigint,thumbnail_size),
                updated_at=now()
          WHERE id=$1
            AND storage_slug=$12
            AND object_key=$13
            AND device=$14
            AND brightness=$15
            AND theme=$16
          RETURNING id`,
        [
          item.id,
          nextClassification.device,
          nextClassification.brightness,
          nextClassification.theme,
          relocation?.nextObjectKey ?? locked.object_key,
          nextFields.title,
          nextFields.description,
          nextFields.source,
          nextFields.original,
          nextAuthor,
          relocation?.thumbnailSize ?? null,
          locked.storage_slug,
          locked.object_key,
          locked.device,
          locked.brightness,
          locked.theme
        ]
      );
      if (!updated.rowCount) {
        throw new ApiError(
          409,
          "image_location_changed",
          "Image location changed before the update was committed"
        );
      }
    }

    if (tagsChanged) {
      const tagMutation = await replaceImageTagAssociations(
        client,
        item.id,
        resolvedTags ?? [],
        signal
      );
      if (tagMutation.createdTag) createdEntityKinds.add("tag");
    }
    if (relocation) {
      await enqueuePreparedImageSourceCleanup(
        client,
        relocation,
        "category_move_source_cleanup"
      );
    }

    if (locked.theme !== nextClassification.theme) {
      changedEntityKinds.add("theme");
    }
    if (authorChanged) changedEntityKinds.add("author");
    if (tagsChanged) changedEntityKinds.add("tag");

    await bumpReadyImageRevision(client);
    signal.throwIfAborted();
    await client.query("COMMIT");
    committed = true;
    return { changed, changedEntityKinds, createdEntityKinds };
  } catch (error) {
    if (!committed) await client?.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client?.release();
  }
}

async function mutateImageItem(
  item: ImageUpdateItemInput,
  resolvedTags: string[] | null,
  options: ImageUpdateItemOptions,
  signal: AbortSignal
) {
  const classificationRequested = item.device !== undefined
    || item.brightness !== undefined
    || item.theme !== undefined;
  let sourceImage: UpdateImageRecord | null = null;
  let target: Pick<UpdateImageRecord, "device" | "brightness" | "theme"> | null = null;
  let relocation: PreparedImageRelocation | null = null;
  const commitState: {
    outcome: ImageUpdateTransactionOutcome | null;
  } = { outcome: null };

  try {
    if (classificationRequested) {
      signal.throwIfAborted();
      sourceImage = (await pool.query(
        `SELECT ${updateImageColumns} FROM metadata WHERE id=$1`,
        [item.id]
      )).rows[0] as UpdateImageRecord | undefined ?? null;
      signal.throwIfAborted();
      if (!sourceImage) throw new ApiError(404, "not_found", "Image not found");
      if (sourceImage.status !== "ready") {
        throw new ApiError(
          409,
          "invalid_image_state",
          "Only ready images can change category"
        );
      }
      const resolvedDevice = resolveOptionalDeviceWith(
        item.device,
        () => detectImageDevice(sourceImage as UpdateImageRecord)
      );
      const resolvedBrightness = await resolveOptionalBrightnessWith(
        item.brightness,
        () => detectImageBrightness(sourceImage as UpdateImageRecord, signal)
      );
      signal.throwIfAborted();
      target = {
        device: resolvedDevice ?? sourceImage.device,
        brightness: resolvedBrightness ?? sourceImage.brightness,
        theme: item.theme ?? sourceImage.theme
      };
      if (
        target.device !== sourceImage.device
        || target.brightness !== sourceImage.brightness
        || target.theme !== sourceImage.theme
      ) {
        relocation = await prepareVerifiedImageRelocation(
          sourceImage,
          target,
          "category_move",
          signal
        );
      }
    }

    const outcome = await withImageMutationSync(async (mutationSyncBatch) => {
      const transactionOutcome = await commitImageUpdate({
        item,
        resolvedTags,
        sourceImage,
        target,
        relocation,
        signal
      });
      commitState.outcome = transactionOutcome;
      if (transactionOutcome.changed) mutationSyncBatch.add({ id: item.id });
      return transactionOutcome;
    });
    await repairDerivedCaches(outcome, options);
    return outcome;
  } catch (error) {
    const committedOutcome = commitState.outcome;
    if (committedOutcome) {
      reportReadyImageCacheFailure(error);
      logger.warn("image_update_cache_handoff_failed_after_commit", {
        image_id: item.id,
        error: errorMessage(error)
      });
      if (committedOutcome.changed) {
        requestReadyImageCacheRebuildAfterMutation(1);
      }
      await repairDerivedCaches(committedOutcome, options);
      return committedOutcome;
    }
    if (relocation) {
      try {
        await discardPreparedImageRelocationIfUnreferenced(
          relocation,
          "category_move_compare_and_swap_failed"
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Image update failed and candidate cleanup could not be queued"
        );
      }
    }
    throw error;
  }
}

export async function updateImageItem(
  item: ImageUpdateItemInput,
  options: ImageUpdateItemOptions,
  parentSignal?: AbortSignal
) {
  const resolvedTags = item.tags === undefined
    ? null
    : [...await resolveTagNames(item.tags)].sort();
  const vocabularyLocks = vocabularyAssociationLockRequests([
    ...(item.author
      ? [{ entity: "author" as const, slug: item.author }]
      : []),
    ...(item.theme && item.theme !== "none"
      ? [{ entity: "theme" as const, slug: item.theme }]
      : []),
    ...(resolvedTags ?? []).map((slug) => ({
      entity: "tag" as const,
      slug
    }))
  ]);
  const classificationRequested = item.device !== undefined
    || item.brightness !== undefined
    || item.theme !== undefined;
  const work = (lockSignal: AbortSignal) => mutateImageItem(
    item,
    resolvedTags,
    options,
    parentSignal && parentSignal !== lockSignal
      ? AbortSignal.any([parentSignal, lockSignal])
      : lockSignal
  );

  if (classificationRequested) {
    return withStorageLocationReadAndAdvisoryLocks(
      [
        ...vocabularyLocks,
        { key: imageStorageMutationLockKey(item.id) }
      ],
      work
    );
  }
  if (vocabularyLocks.length) {
    return withAdvisoryLocks(vocabularyLocks, work);
  }
  return work(parentSignal ?? new AbortController().signal);
}
