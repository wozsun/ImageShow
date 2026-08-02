import { redis } from "../core/redis-client.ts";
import { randomUuidV7 } from "../core/uuid.ts";
import {
  RANDOM_REBUILD_LOCK_KEY,
  RANDOM_UPDATE_LOCK_KEY
} from "./cache-keys.ts";
import {
  RANDOM_REBUILD_LOCK_TTL_MS,
  RANDOM_REBUILD_LOCK_RENEW_INTERVAL_MS,
  RANDOM_UPDATE_LOCK_RENEW_INTERVAL_MS,
  RANDOM_UPDATE_LOCK_TTL_MS
} from "./cache-policy.ts";
import { RANDOM_OWNED_LOCK_RENEW_SCRIPT } from "./cache-scripts.ts";

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
  const controller = new AbortController();
  let ownershipLost = false;
  let stopped = false;
  let renewalInFlight: Promise<boolean> | null = null;

  const renew = async () => {
    if (stopped || ownershipLost) return !ownershipLost;
    try {
      const renewed = Number(await redis.eval(
        RANDOM_OWNED_LOCK_RENEW_SCRIPT,
        1,
        RANDOM_REBUILD_LOCK_KEY,
        token,
        RANDOM_REBUILD_LOCK_TTL_MS
      )) === 1;
      if (!renewed) ownershipLost = true;
    } catch {
      ownershipLost = true;
    }
    if (ownershipLost && !controller.signal.aborted) {
      controller.abort(new Error("Random rebuild lock ownership was lost"));
    }
    return !ownershipLost;
  };
  const queueRenewal = () => {
    if (renewalInFlight) return renewalInFlight;
    const result = renew().finally(() => {
      if (renewalInFlight === result) renewalInFlight = null;
    });
    renewalInFlight = result;
    return result;
  };
  const timer = setInterval(() => {
    void queueRenewal();
  }, RANDOM_REBUILD_LOCK_RENEW_INTERVAL_MS);
  timer.unref();

  return {
    signal: controller.signal,
    renewNow: queueRenewal,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await renewalInFlight;
      await releaseOwnedRandomLock(RANDOM_REBUILD_LOCK_KEY, token);
    }
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
    RANDOM_OWNED_LOCK_RENEW_SCRIPT,
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
  let renewalInFlight: Promise<boolean> | null = null;

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
    if (renewalInFlight) return renewalInFlight;
    const result = renew().finally(() => {
      if (renewalInFlight === result) renewalInFlight = null;
    });
    renewalInFlight = result;
    return result;
  };
  const timer = setInterval(() => {
    void queueRenewal();
  }, RANDOM_UPDATE_LOCK_RENEW_INTERVAL_MS);
  timer.unref();

  return {
    renewNow: queueRenewal,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await renewalInFlight;
    }
  };
}
