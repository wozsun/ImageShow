import type {
  AdminCheckStatusDto,
  AdminPostgresqlStatusDto,
  AdminRedisStatusDto
} from "@imageshow/shared/browser";
import { deploymentConfig } from "../config/deployment-config.ts";
import { pool } from "../core/db.ts";
import {
  parseRedisInfoFields,
  parseRedisMemoryState,
  pingRedis,
  redis
} from "../core/redis-client.ts";
import {
  applyReadyImageAuthoritativeRevision,
  readReadyImageCacheAdminStatus
} from "../images/ready-cache/admin-status.ts";
import { captureAdminCheck } from "./status-errors.ts";

const STATUS_QUERY_TIMEOUT_MS = 2_500;

function nonNegativeInteger(value: unknown, field: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`PostgreSQL returned invalid ${field}`);
  }
  return number;
}

function finiteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function readAdminPostgresqlStatus(): Promise<
  AdminPostgresqlStatusDto
> {
  const startedAt = performance.now();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout='${STATUS_QUERY_TIMEOUT_MS}ms'`);
    const row = (await client.query(`
      SELECT current_setting('server_version') AS version,
             (SELECT count(*) FROM metadata) AS total_images,
             (SELECT count(*) FROM metadata WHERE status='ready') AS ready_images,
             (SELECT revision::text
                FROM ready_image_revision
               WHERE singleton=1) AS authoritative_revision,
             (SELECT count(*)
                FROM background_job
               WHERE status='failed') AS abnormal_jobs
    `)).rows[0] as Record<string, unknown> | undefined;
    await client.query("COMMIT");
    if (!row || typeof row.version !== "string") {
      throw new Error("PostgreSQL status summary is incomplete");
    }
    const authoritativeRevision = String(row.authoritative_revision ?? "");
    if (!/^\d+$/u.test(authoritativeRevision)) {
      throw new Error("PostgreSQL ready-image revision is invalid");
    }
    return {
      connection: "connected",
      version: row.version,
      latency_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      ready_images: nonNegativeInteger(row.ready_images, "ready image count"),
      total_images: nonNegativeInteger(row.total_images, "image count"),
      authoritative_revision: authoritativeRevision,
      abnormal_jobs: nonNegativeInteger(row.abnormal_jobs, "abnormal job count")
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function readAdminRedisStatus(): Promise<AdminRedisStatusDto> {
  const startedAt = performance.now();
  await pingRedis();
  const [serverInfo, memoryInfo, imageProjection] = await Promise.all([
    redis.info("server"),
    redis.info("memory"),
    readReadyImageCacheAdminStatus(null)
  ]);
  const memory = parseRedisMemoryState(memoryInfo);
  const serverFields = parseRedisInfoFields(serverInfo);
  const memoryFields = parseRedisInfoFields(memoryInfo);
  const version = serverFields.get("redis_version");
  if (!version) throw new Error("Redis server version is unavailable");
  return {
    connection: "connected",
    version,
    configured_db: deploymentConfig.redis.db,
    latency_ms: Math.max(0, Math.round(performance.now() - startedAt)),
    memory: {
      scope: "redis_instance",
      used_memory_bytes: memory.usedMemory,
      used_memory_rss_bytes: memory.usedMemoryRss,
      fragmentation_ratio: finiteNumber(
        memoryFields.get("mem_fragmentation_ratio")
      )
    },
    image_projection: imageProjection
  };
}

type AdminCheckStatusDependencies = {
  readPostgresql: typeof readAdminPostgresqlStatus;
  readRedis: typeof readAdminRedisStatus;
};

const defaultAdminCheckStatusDependencies: AdminCheckStatusDependencies = {
  readPostgresql: readAdminPostgresqlStatus,
  readRedis: readAdminRedisStatus
};

export async function readAdminCheckStatus(
  dependencies: AdminCheckStatusDependencies =
    defaultAdminCheckStatusDependencies
): Promise<AdminCheckStatusDto> {
  const [postgresql, redisStatus] = await Promise.all([
    captureAdminCheck(
      dependencies.readPostgresql,
      "query",
      "postgresql_status_failed"
    ),
    captureAdminCheck(
      dependencies.readRedis,
      "command",
      "redis_status_failed"
    )
  ]);
  if (redisStatus.status === "ok") {
    redisStatus.data.image_projection = applyReadyImageAuthoritativeRevision(
      redisStatus.data.image_projection,
      postgresql.status === "ok"
        ? postgresql.data.authoritative_revision
        : null
    );
  }
  return { postgresql, redis: redisStatus };
}
