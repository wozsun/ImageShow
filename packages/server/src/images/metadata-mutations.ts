import type { Pool, PoolClient } from "pg";
import { pool } from "../core/db.ts";
import { ApiError } from "../core/api-error.ts";
import { metadataUpdateInput, parse } from "../core/validation.ts";
import { thumbnailRef } from "../storage/image-paths.ts";
import {
  readStorageBuffer,
  storageObjectExists
} from "../storage/object-access.ts";
import {
  imageStorageMutationLockKey,
  withImageStorageMutationLock,
  withStorageLocationReadAndAdvisoryLocks
} from "../storage/maintenance-lock.ts";
import {
  completePreparedImageRelocation,
  discardPreparedImageRelocationIfUnreferenced,
  prepareVerifiedImageRelocation
} from "../storage/image-relocation.ts";
import { isReservedSubdomain } from "../themes/host.ts";
import { ensureThemeWithMutationLockHeld } from "../themes/mutations.ts";
import { ensureAuthorWithMutationLockHeld } from "../authors/mutations.ts";
import {
  invalidateOrCollectEntityCountCaches,
  refreshEntityVocabularies,
  type EntityCacheKind,
  type EntityCountCacheInvalidationBatch
} from "../vocab/vocab-cache.ts";
import {
  vocabularyAssociationLockRequests,
  withVocabularyAssociationLock
} from "../vocab/mutation-sync.ts";
import { detectBrightness } from "./brightness.ts";
import {
  deviceFromDimensions,
  resolveOptionalBrightnessWith,
  resolveOptionalDeviceWith
} from "./classification.ts";
import type { ImageRecord } from "./presenter.ts";
import {
  applyOrCollectImageMutationSync,
  type ImageMutationSyncBatch
} from "./mutation-sync.ts";

type MutationImageRecord = Pick<
  ImageRecord,
  | "id"
  | "device"
  | "brightness"
  | "theme"
  | "width"
  | "height"
  | "ext"
  | "md5"
  | "object_key"
  | "storage_slug"
  | "author"
  | "status"
>;

const mutationImageColumns = [
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
  "status"
].join(", ");

async function detectImageBrightness(image: MutationImageRecord) {
  if (image.status !== "ready") return undefined;
  const thumb = thumbnailRef(image);
  if (!(await storageObjectExists(thumb.prefix, thumb.key, thumb.slug))) {
    return undefined;
  }
  return detectBrightness(
    await readStorageBuffer(thumb.prefix, thumb.key, thumb.slug)
  );
}

function detectImageDevice(image: MutationImageRecord) {
  if (image.status !== "ready") return undefined;
  return deviceFromDimensions(image.width, image.height);
}

type ImageMutationOptions = {
  entityCountInvalidationBatch?: EntityCountCacheInvalidationBatch;
  mutationSyncBatch?: ImageMutationSyncBatch;
};

async function applyImageFieldEdits(
  executor: Pool | PoolClient,
  id: string,
  fields: {
    title?: string;
    description?: string;
    source?: string;
    original?: string;
  },
  authorValue: string | null,
  touchAuthor: boolean
): Promise<MutationImageRecord> {
  const result = await executor.query(
    `UPDATE metadata
        SET title=COALESCE($2,title),
            description=COALESCE($3,description),
            source=COALESCE($4,source),
            original=COALESCE($5,original),
            author=CASE WHEN $7::boolean THEN $6 ELSE author END,
            updated_at=now()
      WHERE id=$1
      RETURNING ${mutationImageColumns}`,
    [
      id,
      fields.title,
      fields.description,
      fields.source,
      fields.original,
      authorValue,
      touchAuthor
    ]
  );
  return result.rows[0] as MutationImageRecord;
}

export async function updateImageMetadata(
  id: string,
  body: unknown,
  options: ImageMutationOptions = {}
) {
  const current = (await pool.query(
    `SELECT ${mutationImageColumns} FROM metadata WHERE id=$1`,
    [id]
  )).rows[0] as MutationImageRecord | undefined;
  if (!current) throw new ApiError(404, "not_found", "Image not found");

  const parsed = parse(metadataUpdateInput, body);
  if (parsed.theme && isReservedSubdomain(parsed.theme)) {
    throw new ApiError(
      400,
      "theme_reserved",
      "Theme conflicts with a reserved subdomain prefix",
      { theme: parsed.theme }
    );
  }

  const touchAuthor = parsed.author !== undefined;
  const authorValue = parsed.author ? parsed.author : null;
  const classificationRequested = parsed.device !== undefined
    || parsed.brightness !== undefined
    || parsed.theme !== undefined;

  if (!classificationRequested) {
    const authorChanged = touchAuthor && authorValue !== current.author;
    const applyFields = async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const createdAuthor = parsed.author
        ? await ensureAuthorWithMutationLockHeld(pool, parsed.author)
        : false;
      signal?.throwIfAborted();
      await applyImageFieldEdits(pool, id, parsed, authorValue, touchAuthor);
      return createdAuthor;
    };
    const createdAuthor = parsed.author
      ? await withVocabularyAssociationLock("author", parsed.author, applyFields)
      : await applyFields();
    const cacheTasks: Array<Promise<unknown>> = [
      applyOrCollectImageMutationSync(
        {
          id,
          md5: current.md5 ?? "",
          lookupEntries: [{ id, object_key: current.object_key }]
        },
        options.mutationSyncBatch
      )
    ];
    if (authorChanged) {
      cacheTasks.push(invalidateOrCollectEntityCountCaches(
        ["author"],
        options.entityCountInvalidationBatch
      ));
    }
    if (createdAuthor) cacheTasks.push(refreshEntityVocabularies(["author"]));
    await Promise.all(cacheTasks);
    return;
  }

  const mutateImageLocation = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    // Derive omitted fields only after owning the image location. This keeps a
    // concurrent storage migration from being overwritten by an old snapshot.
    const sourceImage = (await pool.query(
      `SELECT ${mutationImageColumns} FROM metadata WHERE id=$1`,
      [id]
    )).rows[0] as MutationImageRecord | undefined;
    signal.throwIfAborted();
    if (!sourceImage) throw new ApiError(404, "not_found", "Image not found");
    if (sourceImage.status !== "ready") {
      throw new ApiError(
        409,
        "invalid_image_state",
        "Only ready images can change category"
      );
    }

    const next = {
      ...parsed,
      device: resolveOptionalDeviceWith(
        parsed.device,
        () => detectImageDevice(sourceImage)
      ),
      brightness: await resolveOptionalBrightnessWith(
        parsed.brightness,
        () => detectImageBrightness(sourceImage)
      )
    };
    signal.throwIfAborted();
    const target = {
      device: next.device ?? sourceImage.device,
      brightness: next.brightness ?? sourceImage.brightness,
      theme: next.theme ?? sourceImage.theme
    };
    const classificationChanged = target.device !== sourceImage.device
      || target.brightness !== sourceImage.brightness
      || target.theme !== sourceImage.theme;
    const relocation = classificationChanged
      ? await prepareVerifiedImageRelocation(
          sourceImage,
          target,
          "category_move",
          signal
        )
      : null;
    const createdEntityKinds = new Set<EntityCacheKind>();
    let client: PoolClient | undefined;
    let updated: MutationImageRecord;

    try {
      signal.throwIfAborted();
      client = await pool.connect();
      signal.throwIfAborted();
      await client.query("BEGIN");
      const locked = (await client.query(
        `SELECT ${mutationImageColumns} FROM metadata WHERE id=$1 FOR UPDATE`,
        [id]
      )).rows[0] as MutationImageRecord | undefined;
      signal.throwIfAborted();
      if (!locked) throw new ApiError(404, "not_found", "Image not found");
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

      if (
        parsed.theme
        && parsed.theme !== "none"
        && await ensureThemeWithMutationLockHeld(client, target.theme)
      ) {
        createdEntityKinds.add("theme");
      }
      if (
        next.author
        && await ensureAuthorWithMutationLockHeld(client, next.author)
      ) {
        createdEntityKinds.add("author");
      }

      signal.throwIfAborted();
      const result = await client.query(
        `UPDATE metadata
            SET device=$2,
                brightness=$3,
                theme=$4,
                object_key=$5,
                title=COALESCE($6,title),
                description=COALESCE($7,description),
                source=COALESCE($8,source),
                original=COALESCE($9,original),
                author=CASE WHEN $11::boolean THEN $10 ELSE author END,
                updated_at=now()
          WHERE id=$1
            AND storage_slug=$12
            AND object_key=$13
            AND device=$14
            AND brightness=$15
            AND theme=$16
          RETURNING ${mutationImageColumns}`,
        [
          id,
          target.device,
          target.brightness,
          target.theme,
          relocation?.nextObjectKey ?? locked.object_key,
          next.title,
          next.description,
          next.source,
          next.original,
          authorValue,
          touchAuthor,
          sourceImage.storage_slug,
          sourceImage.object_key,
          sourceImage.device,
          sourceImage.brightness,
          sourceImage.theme
        ]
      );
      const updatedRow = result.rows[0] as MutationImageRecord | undefined;
      if (!updatedRow) {
        throw new ApiError(
          409,
          "image_location_changed",
          "Image location changed before the category update was committed"
        );
      }
      updated = updatedRow;
      signal.throwIfAborted();
      await client.query("COMMIT");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      if (relocation) {
        await discardPreparedImageRelocationIfUnreferenced(
          relocation,
          "category_move_compare_and_swap_failed"
        );
      }
      throw error;
    } finally {
      client?.release();
    }

    if (relocation) {
      await completePreparedImageRelocation(
        relocation,
        "category_move_source_cleanup"
      );
    }

    const changedEntityKinds: EntityCacheKind[] = [];
    if (sourceImage.theme !== updated.theme) changedEntityKinds.push("theme");
    if (sourceImage.author !== updated.author) changedEntityKinds.push("author");
    await Promise.all([
      applyOrCollectImageMutationSync({
        id,
        md5: sourceImage.md5 ?? "",
        lookupEntries: [
          { id, object_key: sourceImage.object_key },
          { object_key: updated.object_key }
        ]
      }, options.mutationSyncBatch),
      invalidateOrCollectEntityCountCaches(
        changedEntityKinds,
        options.entityCountInvalidationBatch
      ),
      refreshEntityVocabularies(createdEntityKinds)
    ]);
  };

  const vocabularyLocks = vocabularyAssociationLockRequests([
    ...(parsed.author
      ? [{ entity: "author" as const, slug: parsed.author }]
      : []),
    ...(parsed.theme && parsed.theme !== "none"
      ? [{ entity: "theme" as const, slug: parsed.theme }]
      : [])
  ]);
  if (vocabularyLocks.length) {
    return withStorageLocationReadAndAdvisoryLocks(
      [...vocabularyLocks, { key: imageStorageMutationLockKey(id) }],
      mutateImageLocation
    );
  }
  return withImageStorageMutationLock(id, mutateImageLocation);
}
