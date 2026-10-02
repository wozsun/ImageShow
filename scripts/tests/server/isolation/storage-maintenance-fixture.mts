import { storageObjectKey } from "@imageshow/shared/browser";
import assert from "node:assert/strict";
import { createHash, randomUUIDv7 } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import type { Pool } from "pg";
import type { IntegrationRuntime } from "./integration-runtime.mts";

export async function settleWithin<T>(pending: Promise<T>, milliseconds = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("controlled operation failed to settle")),
          milliseconds
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function createMaintenanceFixture(runtime: IntegrationRuntime) {
  const { requireOperationalRedis } =
    await import("../../../../packages/server/src/core/runtime-availability.ts");
  await requireOperationalRedis();
  const registry = runtime.storageRegistry;
  const access = await registry.resolveStorageAccess("local");
  const body = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
    .webp()
    .toBuffer();
  const createImage = async (
    options: { source?: boolean; thumbnail?: Buffer; confirmedSize?: number } = {}
  ) => {
    const id = randomUUIDv7();
    const key = storageObjectKey(id);
    const thumb = key;
    const small = options.thumbnail ?? body;
    await runtime.databasePools.pool.query(
      "INSERT INTO metadata (id,created_by,storage_slug,device,brightness,l_width,l_height,l_byte_size,l_md5,m_width,m_height,m_byte_size,m_md5,s_width,s_height,s_byte_size,s_md5) VALUES ($1,'integration-admin','local','pc','dark',2,2,$2,$3,2,2,$2,$3,2,2,$4,$5)",
      [id,body.length,createHash("md5").update(body).digest("hex"),small.length,createHash("md5").update(small).digest("hex")]
    );
    if (options.source !== false) for(const prefix of ["large","medium"] as const) await access.driver.writeBuffer(prefix,key,body,"image/webp");
    if (options.thumbnail) await access.driver.writeBuffer("small",thumb,small,"image/webp");
    const row=async()=>(await runtime.databasePools.pool.query<{storage_slug:string;s_byte_size:string}>("SELECT storage_slug,s_byte_size FROM metadata WHERE id=$1",[id])).rows[0]!;
    return { id, key, thumb, row };
  };
  return { access, body, createImage };
}

export async function waitForStorageLockWait(pool: Pool, shared: boolean) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ waiting: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() " +
        "AND pid<>pg_backend_pid() AND state='active' AND wait_event_type='Lock' AND query LIKE $1) AS waiting",
      [shared ? "%pg_advisory_lock_shared%" : "%pg_advisory_lock(hashtext%"]
    );
    if (result.rows[0]?.waiting) return;
    await delay(10);
  }
  assert.fail("operation did not enter the expected storage advisory lock wait");
}
