import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg, { type PoolClient } from "pg";
import argon2 from "argon2";
import { appConfig, indexKey } from "@imageshow/shared";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

export const pool = new pg.Pool({
  host: env.POSTGRES_HOST,
  port: env.POSTGRES_PORT,
  database: env.POSTGRES_DB,
  user: env.POSTGRES_USER,
  password: env.POSTGRES_PASSWORD,
  max: appConfig.pgPool.max,
  idleTimeoutMillis: appConfig.pgPool.idleTimeoutMillis,
  connectionTimeoutMillis: appConfig.pgPool.connectionTimeoutMillis,
  maxLifetimeSeconds: appConfig.pgPool.maxLifetimeSeconds
});

// An idle client emitting an error (e.g. the backend dropped the connection)
// otherwise crashes the process; log and let the pool evict it instead.
pool.on("error", (error) => logger.error("idle PostgreSQL client error", error));

// Runs `work` inside a transaction on a pooled client: BEGIN, COMMIT on success,
// ROLLBACK on throw, and always release the client. The shared wrapper for the
// straightforward write paths; flows that need the client after rollback, an early
// commit, or a mid-transaction rollback (updateImageMetadata, batch delete, restore)
// keep their own control flow.
export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function runMigrations() {
  const here = dirname(fileURLToPath(import.meta.url));
  // db.js lives in core/, while copy-assets places migrations at the dist root.
  const migrationDir = join(here, "..", "migrations");
  const files = (await readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const exists = await pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]).catch(() => ({ rowCount: 0 }));
    if (exists.rowCount) continue;
    const body = await readFile(join(migrationDir, file), "utf8");
    await withTransaction(async (client) => {
      await client.query(body);
      await client.query("INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING", [version]);
    });
  }
}

// Provision — and on every restart resync — the single super admin from
// ADMIN_USERNAME / ADMIN_PASSWORD, so a forgotten password is always recoverable
// by redeploying with new env values. Image admins are created in the UI and are
// never touched here. If env creds are absent but a super admin already exists,
// this is a no-op so a restart without env vars keeps working.
export async function initializeAdmin() {
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
    const hasSuper = await pool.query("SELECT 1 FROM admin_account WHERE role = 'super' LIMIT 1");
    if (hasSuper.rowCount) return;
    throw new Error("ADMIN_USERNAME and ADMIN_PASSWORD are required to provision the super admin.");
  }
  const hash = await argon2.hash(env.ADMIN_PASSWORD, { type: argon2.argon2id });
  await withTransaction(async (client) => {
    // Only one super admin may exist; drop a stale one if the env username changed.
    await client.query("DELETE FROM admin_account WHERE role = 'super' AND username <> $1", [env.ADMIN_USERNAME]);
    // Upsert the configured super admin, resyncing its password every start. If the
    // username already belonged to an image admin, it is promoted to super.
    await client.query(
      `INSERT INTO admin_account(username, password_hash, role) VALUES($1, $2, 'super')
       ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'super', updated_at = now()`,
      [env.ADMIN_USERNAME, hash]
    );
  });
}

export async function pingDb() {
  await pool.query("SELECT 1");
}

// Idempotently registers a category row (count starts at 0) so a later count bump has a
// row to update. Shared by every image-write path that may introduce a new category.
export async function upsertCategory(client: PoolClient, key: string, device: string, brightness: string, theme: string) {
  await client.query(
    "INSERT INTO category(category_key, device, brightness, theme, count) VALUES($1,$2,$3,$4,0) ON CONFLICT (category_key) DO NOTHING",
    [key, device, brightness, theme]
  );
}

// Adjusts a category's image count by `delta` (+1 on insert, -1 on remove), shared by the
// upload / link-import / edit / delete paths.
export async function adjustCategoryCount(client: PoolClient, key: string, delta: number) {
  await client.query("UPDATE category SET count=count+$2, updated_at=now() WHERE category_key=$1", [key, delta]);
}

// Fills the index slot a removed/moved image vacated, by pulling the category's last ready
// image (at `lastIndex`) into `vacatedIndex` so category_index stays a contiguous 1..N. A
// no-op when the vacated slot was already the last one. The caller must already hold the
// category row lock and have freed the vacated index_key (delete flips status first; a move
// re-keys the moved row out first), so the filler's new index_key never collides on the
// ready partial-unique index. Shared by the delete and category-move paths.
export async function backfillCategoryHole(client: PoolClient, categoryKey: string, vacatedIndex: number, lastIndex: number) {
  if (vacatedIndex === lastIndex) return;
  const filler = (await client.query(
    "SELECT id FROM metadata WHERE category_key=$1 AND status='ready' AND category_index=$2 FOR UPDATE",
    [categoryKey, lastIndex]
  )).rows[0];
  if (filler) {
    await client.query(
      "UPDATE metadata SET category_index=$2, index_key=$3, updated_at=now() WHERE id=$1",
      [filler.id, vacatedIndex, indexKey(categoryKey, vacatedIndex)]
    );
  }
}

// Drops categories no image references anymore. A soft-deleted image still points
// at its category_key (so it can be restored into it), and the metadata.category_key
// foreign key forbids removing a category out from under such a row — so a category
// is cleaned only once NO metadata row of any status references it (i.e. after the
// trashed images that held it are purged), not merely when it has no ready rows.
export async function cleanupEmptyCategories() {
  await pool.query(`
    DELETE FROM category c
    WHERE c.count <= 0
      AND NOT EXISTS (
        SELECT 1
        FROM metadata m
        WHERE m.category_key = c.category_key
      )
  `);
}
