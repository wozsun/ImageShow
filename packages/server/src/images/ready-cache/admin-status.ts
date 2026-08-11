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
  const meta = coordinator.rebuilding || !coordinator.readable
    ? await dependencies.readMeta().catch(() => coordinator.meta)
    : coordinator.meta;
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
    recent_errors: {
      core: recent.core ?? persistedCoreError(
        meta?.lastError ?? "",
        meta?.startedAt ?? null
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
    memory_bytes: snapshot.meta?.memoryBytes ?? null
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
