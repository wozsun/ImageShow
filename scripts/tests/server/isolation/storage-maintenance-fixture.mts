import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import type { Pool } from "pg";
import type { IntegrationRuntime } from "./integration-runtime.mts";

export async function settleWithin<T>(pending: Promise<T>, milliseconds = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("controlled operation failed to settle")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export async function createMaintenanceFixture(runtime: IntegrationRuntime) {
  const { requireOperationalRedis } = await import("../../../../packages/server/src/core/runtime-availability.ts");
  await requireOperationalRedis();
  const registry = runtime.storageRegistry;
  const access = await registry.resolveStorageAccess("local");
  const paths = await import("../../../../packages/server/src/storage/objects/image-paths.ts");
  const body = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  const createImage = async (options: { source?: boolean; thumbnail?: Buffer; confirmedSize?: number } = {}) => {
    const id = randomUUID();
    const key = paths.storageObjectKey(id, "png");
    const thumb = paths.thumbnailObjectKey(key);
    await runtime.databasePools.pool.query(
      "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, theme, ext, md5, image_size, thumbnail_size) "
        + "VALUES ($1,'integration-admin','local',$2,'pc','dark',NULL,'png',$3,$4,$5)",
      [id, key, createHash("md5").update(body).digest("hex"), body.length, options.confirmedSize ?? 0]
    );
    if (options.source !== false) await access.driver.writeBuffer("full", key, body, "image/png");
    if (options.thumbnail) await access.driver.writeBuffer("thumbs", thumb, options.thumbnail, "image/webp");
    const row = async () => (await runtime.databasePools.pool.query<{
      storage_slug: string; object_key: string; thumbnail_size: string;
    }>("SELECT storage_slug, object_key, thumbnail_size FROM metadata WHERE id=$1", [id])).rows[0]!;
    return { id, key, thumb, row };
  };
  return { access, body, createImage };
}

export async function waitForStorageLockWait(pool: Pool, shared: boolean) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ waiting: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() "
        + "AND pid<>pg_backend_pid() AND state='active' AND wait_event_type='Lock' AND query LIKE $1) AS waiting",
      [shared ? "%pg_advisory_lock_shared%" : "%pg_advisory_lock(hashtext%"]
    );
    if (result.rows[0]?.waiting) return;
    await delay(10);
  }
  assert.fail("operation did not enter the expected storage advisory lock wait");
}
