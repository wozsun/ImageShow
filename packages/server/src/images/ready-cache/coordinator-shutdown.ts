import type { ReadyImageCacheCoordinatorState } from "./coordinator-state.ts";

export async function stopReadyImageCacheCoordinatorState(
  state: ReadyImageCacheCoordinatorState
) {
  state.lifecycle.stopped = true;
  state.publication.readable = false;
  state.redis.validatedConnectionEpoch = 0;
  state.lifecycle.reason = "stopped";
  state.rebuild.abortController?.abort(
    new Error("Ready-image cache coordinator stopped")
  );
  await Promise.all([
    state.rebuild.task?.catch(() => undefined),
    state.redis.revalidationTask?.catch(() => undefined)
  ]);
  state.publication.readable = false;
  state.redis.validatedConnectionEpoch = 0;
  state.lifecycle.reason = "stopped";
}
