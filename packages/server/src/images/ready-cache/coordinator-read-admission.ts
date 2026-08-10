import { getRedisConnectionState } from "../../core/redis-client.ts";
import { getRedisOperationalState } from "../../core/runtime-availability.ts";
import {
  readyImageCacheWriteFenceIsClosed,
  tryWithReadyImageCacheReadFence,
  withReadyImageCacheReadFence,
  type ReadyImageCacheReadLease
} from "./fence.ts";
import type { ReadyImageCacheCoordinatorState } from "./coordinator-state.ts";

export type ReadyImageCacheCoordinatorStatus = {
  initialized: boolean;
  readable: boolean;
  rebuilding: boolean;
  rebuildStartedAt: string | null;
  reason: string;
  meta: ReadyImageCacheCoordinatorState["publication"]["meta"];
  requiredCommands: ReadyImageCacheCoordinatorState["publication"]["requiredCommands"];
};

export function redisConnectionIsValidated(
  state: ReadyImageCacheCoordinatorState
) {
  const connection = getRedisConnectionState();
  const operational = getRedisOperationalState();
  return connection.ready
    && operational.available
    && operational.connectionEpoch === connection.epoch
    && connection.epoch === state.redis.validatedConnectionEpoch;
}

function coordinatorIsReadable(
  state: ReadyImageCacheCoordinatorState
) {
  return state.publication.readable
    && !state.lifecycle.stopped
    && state.mutation.holds === 0
    && redisConnectionIsValidated(state);
}

export function coordinatorStatus(
  state: ReadyImageCacheCoordinatorState
): ReadyImageCacheCoordinatorStatus {
  return {
    initialized: state.lifecycle.initialized,
    readable: coordinatorIsReadable(state),
    rebuilding: state.rebuild.task !== null,
    rebuildStartedAt: state.rebuild.startedAt,
    reason: state.mutation.holds > 0
      ? "mutation_in_progress"
      : state.lifecycle.reason,
    meta: state.publication.meta,
    requiredCommands: state.publication.requiredCommands
  };
}

export function readyImageCacheIsReadableForState(
  state: ReadyImageCacheCoordinatorState
) {
  return coordinatorIsReadable(state) && !readyImageCacheWriteFenceIsClosed();
}

export function withReadyImageCacheReadForState<T>(
  state: ReadyImageCacheCoordinatorState,
  work: () => Promise<T>,
  options: { waitForFence?: boolean; signal?: AbortSignal } = {}
): Promise<ReadyImageCacheReadLease<T>> {
  if (!options.waitForFence && !coordinatorIsReadable(state)) {
    return Promise.resolve({ acquired: false });
  }

  const guardedWork = async () => {
    const initialConnection = getRedisConnectionState();
    if (!coordinatorIsReadable(state) || !initialConnection.ready) {
      return { valid: false } as const;
    }
    const epoch = initialConnection.epoch;
    const connectionStillMatches = () => {
      const current = getRedisConnectionState();
      return current.ready
        && current.epoch === epoch
        && coordinatorIsReadable(state);
    };
    if (!connectionStillMatches()) return { valid: false } as const;
    try {
      const value = await work();
      return connectionStillMatches()
        ? { valid: true, value } as const
        : { valid: false } as const;
    } catch (error) {
      if (!connectionStillMatches()) return { valid: false } as const;
      throw error;
    }
  };
  const lease = options.waitForFence
    ? withReadyImageCacheReadFence(guardedWork, options.signal).then(
      (value) => ({ acquired: true, value }) as const
    )
    : tryWithReadyImageCacheReadFence(guardedWork);
  return lease.then((result): ReadyImageCacheReadLease<T> => (
    result.acquired && result.value.valid
      ? { acquired: true, value: result.value.value }
      : { acquired: false }
  ));
}
