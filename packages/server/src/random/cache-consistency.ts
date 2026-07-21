import { redis } from "../core/redis-client.ts";
import {
  RANDOM_FILTER_CONSISTENCY_SCRIPT,
  RANDOM_FILTER_CONSISTENCY_WAIT_MS,
  RANDOM_FILTER_WAIT_BASE_MS,
  RANDOM_FILTER_WAIT_MAX_MS,
  RANDOM_MUTATION_REVISION_KEY,
  RANDOM_REBUILD_COMPLETED_KEY,
  RANDOM_UPDATE_LOCK_KEY,
  redisRevision
} from "./cache-schema.ts";

export type RandomFilterConsistencyKeys = {
  requestedRevision: string;
  completedRevision: string;
  updateLock: string;
};

export type RandomFilterConsistency =
  | { status: "ready"; revision: string }
  | { status: "stale"; revision: string }
  | { status: "updating"; revision: string };

export type RandomFilterConsistencyReader = (
  keys: RandomFilterConsistencyKeys
) => Promise<[string, string, number]>;

const defaultKeys: RandomFilterConsistencyKeys = {
  requestedRevision: RANDOM_MUTATION_REVISION_KEY,
  completedRevision: RANDOM_REBUILD_COMPLETED_KEY,
  updateLock: RANDOM_UPDATE_LOCK_KEY
};

function jitteredDelay(delayMs: number) {
  return Math.max(1, Math.round(delayMs * (0.8 + Math.random() * 0.4)));
}

function sleep(delayMs: number) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

const readRedisConsistencyState: RandomFilterConsistencyReader = async (keys) => (
  await redis.eval(
    RANDOM_FILTER_CONSISTENCY_SCRIPT,
    3,
    keys.requestedRevision,
    keys.completedRevision,
    keys.updateLock
  ) as [string, string, number]
);

/**
 * Wait for a legitimate incremental update to publish its completed revision.
 * A revision gap without an update owner is a stale cache and should be
 * rebuilt; a live owner is allowed enough time for normal 1-2 second syncs.
 */
export async function waitForRandomFilterConsistency(options: {
  keys?: RandomFilterConsistencyKeys;
  deadline?: number;
  readState?: RandomFilterConsistencyReader;
} = {}): Promise<RandomFilterConsistency> {
  const keys = options.keys ?? defaultKeys;
  const readState = options.readState ?? readRedisConsistencyState;
  const deadline = options.deadline
    ?? Date.now() + RANDOM_FILTER_CONSISTENCY_WAIT_MS;
  let delayMs = RANDOM_FILTER_WAIT_BASE_MS;

  for (;;) {
    const state = await readState(keys);
    const revision = redisRevision(state[0]);
    const completedRevision = redisRevision(state[1]);
    const updateInProgress = Number(state[2]) === 1;

    if (!updateInProgress) {
      return completedRevision >= revision
        ? { status: "ready", revision: String(revision) }
        : { status: "stale", revision: String(revision) };
    }
    if (Date.now() >= deadline) {
      return { status: "updating", revision: String(revision) };
    }

    const remainingMs = deadline - Date.now();
    await sleep(Math.min(remainingMs, jitteredDelay(delayMs)));
    delayMs = Math.min(
      RANDOM_FILTER_WAIT_MAX_MS,
      Math.ceil(delayMs * 1.7)
    );
  }
}
