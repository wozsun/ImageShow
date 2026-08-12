import type {
  ReadyImageCacheAdminStatusDto,
  ReadyImageCacheRecentErrorDto
} from "@imageshow/shared/browser";
import {
  getReadyImageCacheCoordinatorStatus
} from "./coordinator.ts";
import { readReadyImageCacheMeta } from "./meta.ts";
import { getReadyImageRevision } from "./revision.ts";
import {
  getReadyImageCacheRecentErrors
} from "./status-observability.ts";

type ReadyImageCacheAdminStatusDependencies = {
  getCoordinatorStatus: typeof getReadyImageCacheCoordinatorStatus;
  getRevision: typeof getReadyImageRevision;
  readMeta: typeof readReadyImageCacheMeta;
  recentErrors: typeof getReadyImageCacheRecentErrors;
};

const defaultAdminStatusDependencies: ReadyImageCacheAdminStatusDependencies = {
  getCoordinatorStatus: getReadyImageCacheCoordinatorStatus,
  getRevision: getReadyImageRevision,
  readMeta: readReadyImageCacheMeta,
  recentErrors: getReadyImageCacheRecentErrors
};

function persistedCoreError(
  message: string,
  occurredAt: string | null
): ReadyImageCacheRecentErrorDto | null {
  if (!message) return null;
  return {
    category: "core",
    code: "core_rebuild_failed",
    message,
    occurred_at: occurredAt ?? new Date(0).toISOString()
  };
}

async function readProjectionSnapshot(
  authoritativeRevision: string | null,
  dependencies: ReadyImageCacheAdminStatusDependencies
) {
  const coordinator = dependencies.getCoordinatorStatus();
  // The persisted hash is the observable contract. Reading it is one fixed
  // command and avoids presenting an old in-process snapshot after external
  // corruption or an interrupted publish.
  const meta = await dependencies.readMeta().catch(() => null);
  return {
    coordinator,
    meta,
    synchronized: authoritativeRevision === null
      ? null
      : Boolean(
        coordinator.readable
        && meta?.state === "ready"
        && meta.appliedRevision === authoritativeRevision
      ),
    state: coordinator.rebuilding
      ? meta?.state ?? "rebuilding"
      : coordinator.readable
        ? meta?.state ?? "unavailable"
        : "degraded"
  };
}

function rebuildDurationMs(startedAt: string, completedAt: string) {
  if (!startedAt || !completedAt) return null;
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  const duration = completed - started;
  return Number.isSafeInteger(duration) && duration >= 0 ? duration : null;
}

export async function readReadyImageCacheAdminStatus(
  authoritativeRevision: string | null,
  dependencies: ReadyImageCacheAdminStatusDependencies =
    defaultAdminStatusDependencies
): Promise<ReadyImageCacheAdminStatusDto> {
  const snapshot = await readProjectionSnapshot(
    authoritativeRevision,
    dependencies
  );
  const { coordinator, meta } = snapshot;
  const recent = dependencies.recentErrors();
  return {
    readable: coordinator.readable,
    rebuilding: coordinator.rebuilding,
    synchronized: snapshot.synchronized,
    state: snapshot.state,
    reason: coordinator.reason,
    authoritative_revision: authoritativeRevision,
    applied_revision: meta?.appliedRevision ?? null,
    item_count: meta?.itemCount ?? null,
    processed: coordinator.rebuilding && meta?.state === "rebuilding"
      ? meta.processed
      : null,
    total: coordinator.rebuilding && meta?.state === "rebuilding"
      ? meta.total
      : null,
    last_updated_at: meta?.lastUpdatedAt ?? null,
    full_rebuild_started_at: meta?.fullRebuildStartedAt ?? null,
    full_rebuild_completed_at: meta?.fullRebuildCompletedAt || null,
    full_rebuild_duration_ms: meta
      ? rebuildDurationMs(
          meta.fullRebuildStartedAt,
          meta.fullRebuildCompletedAt
        )
      : null,
    last_full_rebuild_core_memory_bytes:
      meta?.lastFullRebuildCoreMemoryBytes ?? null,
    last_full_rebuild_measured_at:
      meta?.lastFullRebuildMeasuredAt || null,
    recent_errors: {
      core: recent.core ?? persistedCoreError(
        meta?.lastError ?? "",
        meta?.lastUpdatedAt ?? null
      ),
      derived: recent.derived
    }
  };
}

export async function getReadyImageCacheOverviewStatus(
  dependencies: ReadyImageCacheAdminStatusDependencies =
    defaultAdminStatusDependencies
) {
  const revision = await dependencies.getRevision();
  const snapshot = await readProjectionSnapshot(revision.revision, dependencies);
  return {
    state: snapshot.state,
    synchronized: snapshot.synchronized === true,
    rebuilding: snapshot.coordinator.rebuilding,
    item_count: snapshot.meta?.itemCount ?? null,
    last_full_rebuild_core_memory_bytes:
      snapshot.meta?.lastFullRebuildCoreMemoryBytes ?? null,
    last_full_rebuild_measured_at:
      snapshot.meta?.lastFullRebuildMeasuredAt || null
  };
}

export function applyReadyImageAuthoritativeRevision(
  status: ReadyImageCacheAdminStatusDto,
  authoritativeRevision: string | null
): ReadyImageCacheAdminStatusDto {
  return {
    ...status,
    authoritative_revision: authoritativeRevision,
    synchronized: authoritativeRevision === null
      ? null
      : Boolean(
        status.readable
        && status.state === "ready"
        && status.applied_revision === authoritativeRevision
      )
  };
}
