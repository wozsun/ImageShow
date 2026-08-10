import type { Pool, PoolClient } from "pg";
import { pool, withTransaction } from "../core/db.ts";
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
  discardPreparedImageRelocationIfUnreferenced,
  enqueuePreparedImageSourceCleanup,
  prepareVerifiedImageRelocation
} from "../storage/image-relocation.ts";
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
  withImageMutationSync
} from "./mutation-sync.ts";
import { bumpReadyImageRevision } from "./ready-cache/revision.ts";

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

async function detectImageBrightness(
  image: MutationImageRecord,
  signal: AbortSignal
) {
  if (image.status !== "ready") return undefined;
  const thumb = thumbnailRef(image);
  if (!(await storageObjectExists(
    thumb.prefix,
    thumb.key,
    thumb.slug,
    { signal }
  ))) {
    return undefined;
  }
  return detectBrightness(
    await readStorageBuffer(
      thumb.prefix,
      thumb.key,
      thumb.slug,
      { signal }
    )
  );
}

function detectImageDevice(image: MutationImageRecord) {
  if (image.status !== "ready") return undefined;
  return deviceFromDimensions(image.width, image.height);
}

type ImageMutationOptions = {
  entityCountInvalidationBatch?: EntityCountCacheInvalidationBatch;
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

export function updateImageMetadata(
  id: string,
  body: unknown,
  options: ImageMutationOptions = {}
) {
  const parsed = parse(metadataUpdateInput, body);
  const touchAuthor = parsed.author !== undefined;
  const authorValue = parsed.author ? parsed.author : null;
  const classificationRequested = parsed.device !== undefined
    || parsed.brightness !== undefined
    || parsed.theme !== undefined;

  if (!classificationRequested) {
    const applyFields = (signal?: AbortSignal) => withImageMutationSync(
      async (mutationSyncBatch) => {
        const current = (await pool.query(
          `SELECT ${mutationImageColumns} FROM metadata WHERE id=$1`,
          [id]
        )).rows[0] as MutationImageRecord | undefined;
        if (!current) throw new ApiError(404, "not_found", "Image not found");

        const authorChanged = touchAuthor && authorValue !== current.author;
        const createdAuthor = await withTransaction(async (client) => {
          signal?.throwIfAborted();
          const created = parsed.author
            ? await ensureAuthorWithMutationLockHeld(client, parsed.author)
            : false;
          signal?.throwIfAborted();
          await applyImageFieldEdits(client, id, parsed, authorValue, touchAuthor);
          await bumpReadyImageRevision(client);
          return created;
        });
        mutationSyncBatch.add({ id });
        const cacheTasks: Array<Promise<unknown>> = [];
        if (authorChanged) {
          cacheTasks.push(invalidateOrCollectEntityCountCaches(
            ["author"],
            options.entityCountInvalidationBatch
          ));
        }
        if (createdAuthor) {
          cacheTasks.push(refreshEntityVocabularies(["author"]));
        }
        await Promise.all(cacheTasks);
      }
    );
    return parsed.author
      ? withVocabularyAssociationLock("author", parsed.author, applyFields)
      : applyFields();
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
        () => detectImageBrightness(sourceImage, signal)
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

    const mutation = await withImageMutationSync(async (mutationSyncBatch) => {
      let committedImage: MutationImageRecord | null = null;
      let lockedAuthor: MutationImageRecord["author"];
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
        lockedAuthor = locked.author;
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
                  thumbnail_size=COALESCE($17,thumbnail_size),
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
            sourceImage.theme,
            relocation?.thumbnailSize ?? null
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
        if (relocation) {
          await enqueuePreparedImageSourceCleanup(
            client,
            relocation,
            "category_move_source_cleanup"
          );
        }
        await bumpReadyImageRevision(client);
        committedImage = updatedRow;
        signal.throwIfAborted();
        await client.query("COMMIT");
      } catch (error) {
        await client?.query("ROLLBACK").catch(() => undefined);
        if (relocation) {
          try {
            await discardPreparedImageRelocationIfUnreferenced(
              relocation,
              "category_move_compare_and_swap_failed"
            );
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "Category move failed and candidate cleanup could not be queued"
            );
          }
        }
        throw error;
      } finally {
        client?.release();
      }
      if (!committedImage) {
        throw new Error("Category update committed without an image result");
      }
      mutationSyncBatch.add({ id });
      return { updated: committedImage, previousAuthor: lockedAuthor };
    });
    const { updated, previousAuthor } = mutation;

    const changedEntityKinds: EntityCacheKind[] = [];
    if (sourceImage.theme !== updated.theme) changedEntityKinds.push("theme");
    if (previousAuthor !== updated.author) changedEntityKinds.push("author");
    await Promise.all([
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
