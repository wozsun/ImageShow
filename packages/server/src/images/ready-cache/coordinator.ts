import { onRedisOperationalStateChange } from "../../core/runtime-availability.ts";
import { ReadyImageCacheCoordinator } from "./coordinator-machine.ts";
import type { ReadyImageCacheMeta } from "./model.ts";

const coordinator = new ReadyImageCacheCoordinator();

onRedisOperationalStateChange((operational) => {
  coordinator.handleRedisOperationalStateChange(operational);
});

export function initializeReadyImageCacheCoordinator() {
  return coordinator.initialize();
}

export function requestReadyImageCacheRebuild(options: { signal: AbortSignal }) {
  return coordinator.requestRebuild(options);
}

export function ensureReadyImageCacheCurrent(options: { signal: AbortSignal }) {
  return coordinator.ensureCurrent(options);
}

export function readyImageCacheIsReadable() {
  return coordinator.readyImageCacheIsReadable();
}

export function withReadyImageCacheRead<T>(work: () => Promise<T>) {
  return coordinator.withRead(work);
}

export function getReadyImageCacheCoordinatorStatus() {
  return coordinator.getStatus();
}

/** The projection revision public reads may use, or null while the cache is not readable and ready. */
export function readyImageCacheRevision() {
  const status = coordinator.getStatus();
  return status.readable && status.meta?.state === "ready"
    ? status.meta.appliedRevision
    : null;
}

/** Item count recorded in the last projection meta; unlike the revision it does not require a readable cache. */
export function readyImageCacheItemCount() {
  return coordinator.getStatus().meta?.itemCount ?? 0;
}

export function reportReadyImageCacheFailure(error: unknown) {
  coordinator.reportFailure(error);
}

export function beginReadyImageCachePlannedMutation(affectedCount: number) {
  return coordinator.beginPlannedMutation(affectedCount);
}

export function readyImageCachePlannedMutationIsActive() {
  return coordinator.plannedMutationIsActive();
}

export function requestReadyImageCacheRebuildAfterMutation(affectedCount: number) {
  return coordinator.requestRebuildAfterMutation(affectedCount);
}

export function completeReadyImageCacheMutation(meta: ReadyImageCacheMeta) {
  coordinator.completeMutation(meta);
}

export function stopReadyImageCacheCoordinator() {
  return coordinator.stop();
}
