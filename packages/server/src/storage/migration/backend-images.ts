import type {
  StorageBackendMigrationErrorSampleDto
} from "@imageshow/shared/browser";
import { ApiError, errorMessage } from "../../core/api-error.ts";
import { mapWithWorkerPool } from "../../core/concurrency.ts";
import { pool } from "../../core/database/pools.ts";
import {
  migrateImageToStorageBackend,
  type ImageStorageMigrationRecord
} from "./image.ts";
import {
  assertStorageWriteTarget,
  getStorageBackend
} from "../backends/registry.ts";
import { withPlannedImageMutationRebuild } from "../../images/mutation-sync.ts";
import {
  READY_IMAGE_EXACT_SYNC_MAX_ITEMS,
  decideImageMutationSync
} from "../../images/mutation-sync-policy.ts";
import { STORAGE_MIGRATION_CONCURRENCY } from "./admission.ts";

const storageBackendImageMigrationPageSize = 100;

type StorageBackendImageMigrationPlan = {
  affectedCount: number;
  upperBoundImageId: string | null;
};

type StorageBackendImageMigrationOutcome =
  | { status: "migrated" | "unchanged" }
  | {
      status: "missing" | "failed";
      error: StorageBackendMigrationErrorSampleDto;
    };

async function readStorageBackendImageMigrationPlan(
  source: string
): Promise<StorageBackendImageMigrationPlan> {
  const row = (await pool.query(
    `SELECT count(*)::int AS affected_count,
            max(id::text) AS upper_bound_image_id
       FROM metadata
      WHERE storage_slug=$1`,
    [source]
  )).rows[0] as {
    affected_count?: number;
    upper_bound_image_id?: string | null;
  } | undefined;
  return {
    affectedCount: Number(row?.affected_count ?? 0),
    upperBoundImageId: row?.upper_bound_image_id ?? null
  };
}

async function readStorageBackendImageMigrationRows(
  source: string,
  upperBoundImageId: string
) {
  return (await pool.query(
    `SELECT id, object_key, ext, storage_slug, md5,
            image_size, thumbnail_size
       FROM metadata
      WHERE storage_slug=$1
        AND id <= $2::uuid
      ORDER BY id ASC
      LIMIT $3`,
    [source, upperBoundImageId, READY_IMAGE_EXACT_SYNC_MAX_ITEMS + 1]
  )).rows as ImageStorageMigrationRecord[];
}

async function* streamStorageBackendImageMigrationRows(
  source: string,
  upperBoundImageId: string,
  signal?: AbortSignal
): AsyncGenerator<ImageStorageMigrationRecord> {
  let afterId: string | null = null;
  for (;;) {
    signal?.throwIfAborted();
    const rows = (await pool.query(
      `SELECT id, object_key, ext, storage_slug, md5,
              image_size, thumbnail_size
         FROM metadata
        WHERE storage_slug=$1
          AND ($2::uuid IS NULL OR id > $2::uuid)
          AND id <= $3::uuid
        ORDER BY id ASC
        LIMIT $4`,
      [source, afterId, upperBoundImageId, storageBackendImageMigrationPageSize]
    )).rows as ImageStorageMigrationRecord[];
    signal?.throwIfAborted();
    if (!rows.length) return;
    const nextAfterId = rows.at(-1)?.id;
    if (!nextAfterId || nextAfterId === afterId) {
      throw new Error("Storage migration keyset cursor did not advance");
    }
    for (const row of rows) yield row;
    afterId = nextAfterId;
    if (rows.length < storageBackendImageMigrationPageSize) return;
  }
}

async function migrateBackendImages(
  source: string,
  target: string,
  images:
    | Iterable<ImageStorageMigrationRecord>
    | AsyncIterable<ImageStorageMigrationRecord>,
  signal?: AbortSignal
) {
  let migrated = 0;
  let unchanged = 0;
  let missing = 0;
  let errorCount = 0;
  const errorSamples: StorageBackendMigrationErrorSampleDto[] = [];
  const recordError = (error: StorageBackendMigrationErrorSampleDto) => {
    errorCount += 1;
    if (errorSamples.length < 100) errorSamples.push(error);
  };

  const migrateImage = async (image: ImageStorageMigrationRecord) => {
    signal?.throwIfAborted();
    if (image.storage_slug !== source) {
      return { status: "unchanged" } satisfies StorageBackendImageMigrationOutcome;
    }
    try {
      const result = await migrateImageToStorageBackend(image, target, {
        expectedSource: source,
        signal
      });
      signal?.throwIfAborted();
      if (result === "migrated") {
        return { status: "migrated" } satisfies StorageBackendImageMigrationOutcome;
      }
      if (result === "unchanged") {
        return { status: "unchanged" } satisfies StorageBackendImageMigrationOutcome;
      }
      return {
        status: "missing",
        error: {
          id: image.id,
          object_key: image.object_key,
          code: "source_object_missing",
          message: "源存储对象不存在"
        }
      } satisfies StorageBackendImageMigrationOutcome;
    } catch (error) {
      signal?.throwIfAborted();
      return {
        status: "failed",
        error: {
          id: image.id,
          object_key: image.object_key,
          code: error instanceof ApiError
            ? error.code
            : "storage_migration_failed",
          message: errorMessage(error)
        }
      } satisfies StorageBackendImageMigrationOutcome;
    }
  };
  let page: ImageStorageMigrationRecord[] = [];
  const processPage = async () => {
    if (!page.length) return;
    const current = page;
    page = [];
    const results = await mapWithWorkerPool(
      current,
      STORAGE_MIGRATION_CONCURRENCY,
      migrateImage,
      { signal }
    );
    for (const result of results) {
      if (result.status === "migrated") migrated += 1;
      else if (result.status === "unchanged") unchanged += 1;
      else {
        if (result.status === "missing") missing += 1;
        recordError(result.error);
      }
    }
  };
  for await (const image of images) {
    signal?.throwIfAborted();
    page.push(image);
    if (page.length >= storageBackendImageMigrationPageSize) await processPage();
  }
  await processPage();
  return {
    source,
    target,
    migrated,
    unchanged,
    missing,
    error_samples: errorSamples,
    error_count: errorCount
  };
}

export async function migrateStorageBackendImages(
  source: string,
  target: string,
  options: { signal?: AbortSignal } = {}
) {
  options.signal?.throwIfAborted();
  await getStorageBackend(source);
  await getStorageBackend(target);
  options.signal?.throwIfAborted();
  const plan = await readStorageBackendImageMigrationPlan(source);
  options.signal?.throwIfAborted();
  if (!plan.affectedCount || !plan.upperBoundImageId) {
    return {
      migration: await migrateBackendImages(
        source,
        target,
        [],
        options.signal
      )
    };
  }
  await assertStorageWriteTarget(target);
  options.signal?.throwIfAborted();

  const decision = decideImageMutationSync(plan.affectedCount);
  const executeRebuild = async () => {
    const images = streamStorageBackendImageMigrationRows(
      source,
      plan.upperBoundImageId!,
      options.signal
    );
    const migration = await migrateBackendImages(
      source,
      target,
      images,
      options.signal
    );
    return { migration };
  };
  if (decision.mode === "rebuild") {
    return withPlannedImageMutationRebuild(decision, executeRebuild);
  }

  const rows = await readStorageBackendImageMigrationRows(
    source,
    plan.upperBoundImageId
  );
  options.signal?.throwIfAborted();
  const refreshedDecision = decideImageMutationSync(rows.length);
  return refreshedDecision.mode === "rebuild"
    ? withPlannedImageMutationRebuild(refreshedDecision, executeRebuild)
    : {
        migration: await migrateBackendImages(
          source,
          target,
          rows,
          options.signal
        )
      };
}
