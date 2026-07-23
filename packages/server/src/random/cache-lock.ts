import { redis } from "../core/redis-client.ts";
import { randomUuidV7 } from "../core/uuid.ts";
import {
  RANDOM_REBUILD_LOCK_KEY,
  RANDOM_REBUILD_LOCK_TTL_MS,
  RANDOM_UPDATE_LOCK_KEY,
  RANDOM_UPDATE_LOCK_RENEW_INTERVAL_MS,
  RANDOM_UPDATE_LOCK_RENEW_SCRIPT,
  RANDOM_UPDATE_LOCK_TTL_MS
} from "./cache-schema.ts";

async function releaseOwnedRandomLock(key: string, token: string) {
  const script = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    end
    return 0
  `;
  await redis.eval(script, 1, key, token).catch(() => undefined);
}

export async function acquireRandomRebuildLock() {
  const token = randomUuidV7();
  const locked = await redis.set(
    RANDOM_REBUILD_LOCK_KEY,
    token,
    "PX",
    RANDOM_REBUILD_LOCK_TTL_MS,
    "NX"
  );
  return locked ? token : "";
}

export function startRandomRebuildLockRenewal(token: string) {
  const renewal = setInterval(() => {
    void redis.eval(
      RANDOM_UPDATE_LOCK_RENEW_SCRIPT,
      1,
      RANDOM_REBUILD_LOCK_KEY,
      token,
      RANDOM_REBUILD_LOCK_TTL_MS
    ).catch(() => undefined);
  }, 30_000);
  renewal.unref();

  return async () => {
    clearInterval(renewal);
    await releaseOwnedRandomLock(RANDOM_REBUILD_LOCK_KEY, token);
  };
}

export async function acquireRandomUpdateLock() {
  const token = randomUuidV7();
  const locked = await redis.set(
    RANDOM_UPDATE_LOCK_KEY,
    token,
    "PX",
    RANDOM_UPDATE_LOCK_TTL_MS,
    "NX"
  );
  return locked ? token : "";
}

export async function releaseRandomUpdateLock(token: string) {
  await releaseOwnedRandomLock(RANDOM_UPDATE_LOCK_KEY, token);
}

async function renewRandomUpdateLock(token: string) {
  const renewed = await redis.eval(
    RANDOM_UPDATE_LOCK_RENEW_SCRIPT,
    1,
    RANDOM_UPDATE_LOCK_KEY,
    token,
    RANDOM_UPDATE_LOCK_TTL_MS
  );
  return Number(renewed) === 1;
}

export function startRandomUpdateLockRenewal(token: string) {
  let ownershipLost = false;
  let stopped = false;
  let renewalChain = Promise.resolve();

  const renew = async () => {
    if (stopped || ownershipLost) return !ownershipLost;
    try {
      if (!await renewRandomUpdateLock(token)) ownershipLost = true;
    } catch {
      // 不确定租约状态时禁止发布 completed revision。
      ownershipLost = true;
    }
    return !ownershipLost;
  };
  const queueRenewal = () => {
    const result = renewalChain.then(renew);
    renewalChain = result.then(() => undefined, () => undefined);
    return result;
  };
  const timer = setInterval(() => {
    void queueRenewal();
  }, RANDOM_UPDATE_LOCK_RENEW_INTERVAL_MS);
  timer.unref();

  return {
    ownershipLost: () => ownershipLost,
    renewNow: queueRenewal,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await renewalChain;
    }
  };
}
