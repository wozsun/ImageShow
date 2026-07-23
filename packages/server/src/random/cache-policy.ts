export const RANDOM_UPDATE_LOCK_TTL_MS = 30_000;
export const RANDOM_UPDATE_LOCK_RENEW_INTERVAL_MS = 10_000;
export const RANDOM_REBUILD_LOCK_TTL_MS = 120_000;
export const RANDOM_REBUILD_WAIT_INTERVAL_MS = 100;
export const RANDOM_REBUILD_WAIT_ATTEMPTS =
  RANDOM_REBUILD_LOCK_TTL_MS / RANDOM_REBUILD_WAIT_INTERVAL_MS;
export const RANDOM_OLD_GENERATION_TTL_SECONDS = 60 * 60;
export const RANDOM_FILTER_TTL_SECONDS = 90;
export const RANDOM_FILTER_CONSISTENCY_WAIT_MS = 3_000;
export const RANDOM_FILTER_WAIT_BASE_MS = 25;
export const RANDOM_FILTER_WAIT_MAX_MS = 250;
export const RANDOM_REBUILD_BATCH_SIZE = 500;
export const RANDOM_CLEANUP_BATCH_SIZE = 500;

type RetryableRandomPoolError = Error & { retryAfterSeconds: number };

export function redisUnavailable(): RetryableRandomPoolError {
  const error = new Error("Redis unavailable");
  error.name = "redis_unavailable";
  return Object.assign(error, { retryAfterSeconds: 1 });
}

export function randomPoolUpdating(): RetryableRandomPoolError {
  const error = new Error("Random pool update is still in progress");
  error.name = "random_pool_updating";
  return Object.assign(error, { retryAfterSeconds: 1 });
}

export function randomPoolRetryAfterSeconds(error: unknown) {
  if (
    !error
    || typeof error !== "object"
    || !["redis_unavailable", "random_pool_updating"].includes(
      String((error as { name?: unknown }).name)
    )
  ) {
    return undefined;
  }
  const seconds = Number(
    (error as { retryAfterSeconds?: unknown }).retryAfterSeconds
  );
  return Number.isInteger(seconds) && seconds > 0 ? seconds : 1;
}

export function redisRevision(raw: string | null) {
  const revision = Number(raw ?? "0");
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}
