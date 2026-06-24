import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ColumnType, Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import argon2 from "argon2";
import { appConfig } from "@imageshow/shared";
import { env } from "../config/env.js";

type TimestampColumn = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestampColumn = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type JsonColumn<T = unknown> = ColumnType<T, T | string | undefined, T | string>;
type DeviceValue = "pc" | "mb" | "none";
type BrightnessValue = "dark" | "light" | "none";
type ImageStatus = "ready" | "deleted";
type StorageBackendValue = "local" | "s3";
type UploadSessionStatus = "created" | "finalizing" | "finalized" | "expired" | "failed";
type OperationStatus = "pending" | "running" | "succeeded" | "failed" | "ignored";
type OperationType = "delete.finalize" | "restore.finalize" | "move.cleanup" | "empty-trash" | "upload.cleanup" | "cache.rebuild" | "thumb.generate";

export interface MetadataTable {
  id: string;
  device: DeviceValue;
  brightness: BrightnessValue;
  theme: string;
  category_key: string;
  category_index: number;
  index_key: string;
  width: number;
  height: number;
  ext: "jpg" | "png" | "webp" | "gif" | "avif";
  object_key: string;
  title: string;
  description: string;
  source: string;
  original: string;
  md5: string;
  storage_backend: StorageBackendValue;
  status: ImageStatus;
  deleted_at: NullableTimestampColumn;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface CategoryTable {
  category_key: string;
  device: DeviceValue;
  brightness: BrightnessValue;
  theme: string;
  count: number;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface UploadSessionTable {
  id: string;
  staging_object_key: string;
  final_object_key: string;
  storage_backend: StorageBackendValue;
  expected_size: ColumnType<number, number | string, number | string>;
  metadata_payload: JsonColumn<Record<string, unknown>>;
  status: UploadSessionStatus;
  idempotency_key: string;
  error: string;
  expires_at: TimestampColumn;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface OperationLogTable {
  id: string;
  type: OperationType;
  target_id: string;
  idempotency_key: string | null;
  status: OperationStatus;
  payload: JsonColumn<Record<string, unknown>>;
  result: JsonColumn<Record<string, unknown>>;
  error: string;
  retry_count: number;
  next_retry_at: NullableTimestampColumn;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface AppConfigTable {
  key: string;
  value: JsonColumn;
  updated_at: TimestampColumn;
}

export interface AdminAccountTable {
  username: string;
  password_hash: string;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface SchemaMigrationsTable {
  version: string;
  applied_at: TimestampColumn;
}

export interface Database {
  metadata: MetadataTable;
  category: CategoryTable;
  upload_session: UploadSessionTable;
  operation_log: OperationLogTable;
  app_config: AppConfigTable;
  admin_account: AdminAccountTable;
  schema_migrations: SchemaMigrationsTable;
}

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
pool.on("error", (error) => console.error("Idle PostgreSQL client error", error));

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool })
});

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
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(body);
      await client.query("INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING", [version]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function initializeAdmin() {
  const existing = await pool.query("SELECT username FROM admin_account LIMIT 1");
  if (existing.rowCount) return;
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
    throw new Error("ADMIN_USERNAME and ADMIN_PASSWORD are required only for first admin initialization.");
  }
  // Password hashing is intentionally deferred until the first account is needed.
  const hash = await argon2.hash(env.ADMIN_PASSWORD, { type: argon2.argon2id });
  await pool.query(
    "INSERT INTO admin_account(username, password_hash) VALUES($1, $2) ON CONFLICT DO NOTHING",
    [env.ADMIN_USERNAME, hash]
  );
}

export async function pingDb() {
  await sql`SELECT 1`.execute(db);
}

export async function cleanupEmptyCategories() {
  await pool.query(`
    DELETE FROM category c
    WHERE c.count <= 0
      AND NOT EXISTS (
        SELECT 1
        FROM metadata m
        WHERE m.category_key = c.category_key
          AND m.status = 'ready'
      )
  `);
}
