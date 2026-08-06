import { pool } from "../core/db.ts";
import {
  migrateStorageBackendImages,
  type StorageMigrationImageRecord
} from "./migration.ts";
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
    `SELECT id, object_key, ext, storage_slug, device, brightness,
            theme, md5
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
  throughId: string
): AsyncGenerator<StorageMigrationImageRecord> {
  let afterId: string | null = null;
  for (;;) {
    const rows = (await pool.query(
      `SELECT id, object_key, ext, storage_slug, device, brightness,
              theme, md5
         FROM metadata
        WHERE storage_slug=$1
          AND ($2::uuid IS NULL OR id > $2::uuid)
          AND id <= $3::uuid
        ORDER BY id ASC
        LIMIT $4`,
      [source, afterId, throughId, storageMigrationPageSize]
    )).rows as StorageMigrationImageRecord[];
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

export async function migrateStorageBackend(source: string, target: string) {
  await getStorageBackend(source);
  await getStorageBackend(target);
  const plan = await readStorageMigrationPlan(source);
  if (!plan.affectedCount || !plan.throughId) {
    return {
      migration: await migrateStorageBackendImages(source, target, [])
    };
  }
  await assertStorageWriteTarget(target);

  const decision = decideImageMutationSync(plan.affectedCount);
  const executeRebuild = async () => {
    const entries = streamStorageMigrationRows(source, plan.throughId!);
    const migration = await migrateStorageBackendImages(source, target, entries);
    return { migration };
  };
  if (decision.mode === "rebuild") {
    return withPlannedImageMutationRebuild(
      decision,
      executeRebuild
    );
  }

  const rows = await readStorageMigrationRows(source, plan.throughId);
  const refreshedDecision = decideImageMutationSync(rows.length);
  return refreshedDecision.mode === "rebuild"
    ? withPlannedImageMutationRebuild(
        refreshedDecision,
        executeRebuild
      )
    : { migration: await migrateStorageBackendImages(source, target, rows) };
}
