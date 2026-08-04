import {
  isRedisOutOfMemoryError,
  readRedisMemoryState
} from "../../core/redis-client.ts";
import {
  clearReadyImageDisposableCaches,
  trimLeastRecentlyUsedDerivedCaches
} from "./derived-cache-policy.ts";
import { withReadyImageCacheWriteFence } from "./fence.ts";

const MEMORY_PRESSURE_RATIO = 0.8;
const MEMORY_PRESSURE_RETRY_MS = 10_000;

let memoryReliefPromise: Promise<void> | null = null;
let derivedWritesBlockedUntil = 0;

function memoryIsPressured(
  state: Awaited<ReturnType<typeof readRedisMemoryState>>
) {
  return state.usedMemory / state.maxMemory >= MEMORY_PRESSURE_RATIO;
}

async function relieveReadyImageMemoryPressure(clearAll: boolean) {
  memoryReliefPromise ??= withReadyImageCacheWriteFence(async () => {
    if (clearAll) return clearReadyImageDisposableCaches();
    await trimLeastRecentlyUsedDerivedCaches();
    if (memoryIsPressured(await readRedisMemoryState())) {
      await clearReadyImageDisposableCaches();
    }
  }).finally(() => {
    memoryReliefPromise = null;
  });
  await memoryReliefPromise;
}

export async function readyImageDerivedCacheHasHeadroom() {
  if (derivedWritesBlockedUntil > Date.now()) return false;
  const state = await readRedisMemoryState();
  if (!memoryIsPressured(state)) {
    derivedWritesBlockedUntil = 0;
    return true;
  }
  await relieveReadyImageMemoryPressure(false);
  const relieved = !memoryIsPressured(await readRedisMemoryState());
  if (!relieved) derivedWritesBlockedUntil = Date.now() + MEMORY_PRESSURE_RETRY_MS;
  return relieved;
}

export async function handleReadyImageDerivedCacheError(error: unknown) {
  if (!isRedisOutOfMemoryError(error)) return false;
  await relieveReadyImageMemoryPressure(true).catch(() => undefined);
  derivedWritesBlockedUntil = Date.now() + MEMORY_PRESSURE_RETRY_MS;
  return true;
}
