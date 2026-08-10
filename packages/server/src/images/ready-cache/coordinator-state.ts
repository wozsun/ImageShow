import type { RedisRequiredCommandCapabilities } from "../../core/redis-client.ts";
import type { ReadyImageCacheMeta } from "./model.ts";

export type ReadyImageCacheCoordinatorState = {
  lifecycle: {
    initialized: boolean;
    stopped: boolean;
    reason: string;
  };
  publication: {
    readable: boolean;
    meta: ReadyImageCacheMeta | null;
    requiredCommands: RedisRequiredCommandCapabilities | null;
  };
  rebuild: {
    task: Promise<ReadyImageCacheMeta> | null;
    startedAt: string | null;
    abortController: AbortController | null;
  };
  redis: {
    validatedConnectionEpoch: number;
    revalidationTask: Promise<void> | null;
    pendingRevalidationEpoch: number;
    clearDisposableCachesOnNextReady: boolean;
  };
  mutation: {
    holds: number;
    rebuildRequired: boolean;
    affectedCount: number;
    releaseTask: Promise<void> | null;
    release: (() => void) | null;
  };
};

export function createReadyImageCacheCoordinatorState(): ReadyImageCacheCoordinatorState {
  return {
    lifecycle: {
      initialized: false,
      stopped: false,
      reason: "not_initialized"
    },
    publication: {
      readable: false,
      meta: null,
      requiredCommands: null
    },
    rebuild: {
      task: null,
      startedAt: null,
      abortController: null
    },
    redis: {
      validatedConnectionEpoch: 0,
      revalidationTask: null,
      pendingRevalidationEpoch: 0,
      clearDisposableCachesOnNextReady: true
    },
    mutation: {
      holds: 0,
      rebuildRequired: false,
      affectedCount: 0,
      releaseTask: null,
      release: null
    }
  };
}
