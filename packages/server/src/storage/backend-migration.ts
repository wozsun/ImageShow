import type {
  StorageBackendMigrationErrorSampleDto
} from "@imageshow/shared/browser";
import { ApiError, errorMessage } from "../core/api-error.ts";
import { pool } from "../core/database-pools.ts";
import {
  migrateImageStorage,
  type StorageMigrationImageRecord
} from "./image-storage-migration.ts";
import {
  assertStorageWriteTarget,
  getStorageBackend
} from "./backend-registry.ts";
import { withPlannedImageMutationRebuild } from "../images/mutation-sync.ts";
import {
  READY_IMAGE_EXACT_SYNC_MAX_ITEMS,
  decideImageMutationSync
} from "../images/mutation-sync-policy.ts";

const storageMigrationPageSize = 100;

type StorageMigrationPlan = {
  affectedCount: number;
  throughId: string | null;
};

async function readStorageMigrationPlan(
  source: string
): Promise<StorageMigrationPlan> {
  const row = (await pool.query(
    `SELECT count(*)::int AS affected_count,
            max(id::text) AS through_id
       FROM metadata
      WHERE storage_slug=$1`,
    [source]
  )).rows[0] as {
    affected_count?: number;
    through_id?: string | null;
  } | undefined;
  return {
    affectedCount: Number(row?.affected_count ?? 0),
    throughId: row?.through_id ?? null
  };
}

async function readStorageMigrationRows(
  source: string,
  throughId: string
) {
  return (await pool.query(
    `SELECT id, object_key, ext, storage_slug, md5
       FROM metadata
      WHERE storage_slug=$1
        AND id <= $2::uuid
      ORDER BY id ASC
      LIMIT $3`,
    [source, throughId, READY_IMAGE_EXACT_SYNC_MAX_ITEMS + 1]
  )).rows as StorageMigrationImageRecord[];
}

async function* streamStorageMigrationRows(
  source: string,
  throughId: string,
  signal?: AbortSignal
): AsyncGenerator<StorageMigrationImageRecord> {
  let afterId: string | null = null;
  for (;;) {
    signal?.throwIfAborted();
    const rows = (await pool.query(
      `SELECT id, object_key, ext, storage_slug, md5
         FROM metadata
        WHERE storage_slug=$1
          AND ($2::uuid IS NULL OR id > $2::uuid)
          AND id <= $3::uuid
        ORDER BY id ASC
        LIMIT $4`,
      [source, afterId, throughId, storageMigrationPageSize]
    )).rows as StorageMigrationImageRecord[];
    signal?.throwIfAborted();
    if (!rows.length) return;
    const nextAfterId = rows.at(-1)?.id;
    if (!nextAfterId || nextAfterId === afterId) {
      throw new Error("Storage migration keyset cursor did not advance");
    }
    for (const row of rows) yield row;
    afterId = nextAfterId;
    if (rows.length < storageMigrationPageSize) return;
  }
}

async function migrateBackendEntries(
  source: string,
  target: string,
  entries:
    | Iterable<StorageMigrationImageRecord>
    | AsyncIterable<StorageMigrationImageRecord>,
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

  for await (const entry of entries) {
    signal?.throwIfAborted();
    if (entry.storage_slug !== source) {
      unchanged += 1;
      continue;
    }
    try {
      const result = await migrateImageStorage(entry, target, {
        expectedSource: source,
        signal
      });
      signal?.throwIfAborted();
      if (result === "migrated") {
        migrated += 1;
      } else if (result === "missing") {
        missing += 1;
        recordError({
          id: entry.id,
          object_key: entry.object_key,
          code: "source_object_missing",
          message: "源存储对象不存在"
        });
      } else {
        unchanged += 1;
      }
    } catch (error) {
      signal?.throwIfAborted();
      recordError({
        id: entry.id,
        object_key: entry.object_key,
        code: error instanceof ApiError
          ? error.code
          : "storage_migration_failed",
        message: errorMessage(error)
      });
    }
  }
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

export async function migrateStorageBackend(
  source: string,
  target: string,
  options: { signal?: AbortSignal } = {}
) {
  options.signal?.throwIfAborted();
  await getStorageBackend(source);
  await getStorageBackend(target);
  options.signal?.throwIfAborted();
  const plan = await readStorageMigrationPlan(source);
  options.signal?.throwIfAborted();
  if (!plan.affectedCount || !plan.throughId) {
    return {
      migration: await migrateBackendEntries(
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
    const entries = streamStorageMigrationRows(
      source,
      plan.throughId!,
      options.signal
    );
    const migration = await migrateBackendEntries(
      source,
      target,
      entries,
      options.signal
    );
    return { migration };
  };
  if (decision.mode === "rebuild") {
    return withPlannedImageMutationRebuild(decision, executeRebuild);
  }

  const rows = await readStorageMigrationRows(source, plan.throughId);
  options.signal?.throwIfAborted();
  const refreshedDecision = decideImageMutationSync(rows.length);
  return refreshedDecision.mode === "rebuild"
    ? withPlannedImageMutationRebuild(refreshedDecision, executeRebuild)
    : {
        migration: await migrateBackendEntries(
          source,
          target,
          rows,
          options.signal
        )
      };
}
