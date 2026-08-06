import type {
  ReadyImageCacheAdminStatusDto,
  ReadyImageCacheRecentErrorDto
} from "@imageshow/shared/browser";
import {
  getReadyImageCacheCoordinatorStatus
} from "./coordinator.ts";
import {
  readReadyImageDerivedOccupancy
} from "./derived-cache-occupancy.ts";
import { readReadyImageCacheMeta } from "./meta.ts";
import {
  readReadyImageCacheLastUpdated
} from "./last-updated.ts";
import { getReadyImageRevision } from "./revision.ts";
import {
  getReadyImageCacheRecentErrors,
  recordReadyImageCacheError
} from "./status-observability.ts";

const READY_IMAGE_NONEMPTY_CORE_KEY_COUNT = 9;
const READY_IMAGE_EMPTY_CORE_KEY_COUNT = 4;

type ReadyImageCacheAdminStatusDependencies = {
  getCoordinatorStatus: typeof getReadyImageCacheCoordinatorStatus;
  getRevision: typeof getReadyImageRevision;
  readMeta: typeof readReadyImageCacheMeta;
  readLastUpdated: typeof readReadyImageCacheLastUpdated;
  readDerivedOccupancy: typeof readReadyImageDerivedOccupancy;
  recentErrors: typeof getReadyImageCacheRecentErrors;
  now(): number;
};

const defaultAdminStatusDependencies: ReadyImageCacheAdminStatusDependencies = {
  getCoordinatorStatus: getReadyImageCacheCoordinatorStatus,
  getRevision: getReadyImageRevision,
  readMeta: readReadyImageCacheMeta,
  readLastUpdated: readReadyImageCacheLastUpdated,
  readDerivedOccupancy: readReadyImageDerivedOccupancy,
  recentErrors: getReadyImageCacheRecentErrors,
  now: Date.now
};

function elapsedMilliseconds(
  startedAt: string | null,
  builtAt: string | null,
  rebuilding: boolean,
  now: number
) {
  const started = Date.parse(startedAt ?? "");
  const ended = rebuilding ? now : Date.parse(builtAt ?? "");
  return Number.isFinite(started) && Number.isFinite(ended)
    ? Math.max(0, Math.round(ended - started))
    : null;
}

function projectionBuildTiming(
  coordinator: ReturnType<typeof getReadyImageCacheCoordinatorStatus>,
  meta: Awaited<ReturnType<typeof readReadyImageCacheMeta>>,
  now: number
) {
  if (!coordinator.rebuilding) {
    return {
      startedAt: meta?.startedAt ?? null,
      builtAt: meta?.builtAt ?? null,
      elapsedMs: elapsedMilliseconds(
        meta?.startedAt ?? null,
        meta?.builtAt ?? null,
        false,
        now
      )
    };
  }
  const activeStartedAt = coordinator.rebuildStartedAt;
  const activeStarted = Date.parse(activeStartedAt ?? "");
  const persistedStarted = Date.parse(meta?.startedAt ?? "");
  const persistedBelongsToActiveRebuild = Number.isFinite(activeStarted)
    && Number.isFinite(persistedStarted)
    && persistedStarted >= activeStarted;
  const startedAt = persistedBelongsToActiveRebuild
    ? meta?.startedAt ?? activeStartedAt
    : activeStartedAt;
  const builtAt = persistedBelongsToActiveRebuild
    ? meta?.builtAt ?? null
    : null;
  const running = !persistedBelongsToActiveRebuild
    || meta?.state === "rebuilding";
  return {
    startedAt,
    builtAt,
    elapsedMs: elapsedMilliseconds(startedAt, builtAt, running, now)
  };
}

function cacheStage(
  initialized: boolean,
  rebuilding: boolean,
  readable: boolean,
  reason: string
): ReadyImageCacheAdminStatusDto["stage"] {
  if (rebuilding) return "rebuilding_core";
  if (!initialized || reason.includes("validat")) return "validating";
  return readable ? "idle" : "degraded";
}

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

function coreKeyCount(state: string | undefined, itemCount: number | undefined) {
  if (state !== "ready" || itemCount === undefined) return null;
  return itemCount === 0
    ? READY_IMAGE_EMPTY_CORE_KEY_COUNT
    : READY_IMAGE_NONEMPTY_CORE_KEY_COUNT;
}

export async function readReadyImageCacheAdminStatus(
  authoritativeRevision: string | null,
  dependencies: ReadyImageCacheAdminStatusDependencies =
    defaultAdminStatusDependencies
): Promise<ReadyImageCacheAdminStatusDto> {
  const coordinator = dependencies.getCoordinatorStatus();
  const meta = coordinator.rebuilding || !coordinator.readable
    ? await dependencies.readMeta().catch(() => coordinator.meta)
    : coordinator.meta;
  const [derived, lastUpdatedAt] = await Promise.all([
    dependencies.readDerivedOccupancy().catch((error) => {
      recordReadyImageCacheError(
        "derived",
        "derived_occupancy_unavailable",
        error
      );
      return null;
    }),
    dependencies.readLastUpdated().catch(() => null)
  ]);
  const timing = projectionBuildTiming(
    coordinator,
    meta,
    dependencies.now()
  );
  const recent = dependencies.recentErrors();
  const synchronized = authoritativeRevision === null
    ? null
    : Boolean(
      coordinator.readable
      && meta?.state === "ready"
      && meta.appliedRevision === authoritativeRevision
    );
  return {
    initialized: coordinator.initialized,
    readable: coordinator.readable,
    rebuilding: coordinator.rebuilding,
    synchronized,
    state: coordinator.rebuilding
      ? meta?.state ?? "rebuilding"
      : coordinator.readable
        ? meta?.state ?? "unavailable"
        : "degraded",
    reason: coordinator.reason,
    stage: cacheStage(
      coordinator.initialized,
      coordinator.rebuilding,
      coordinator.readable,
      coordinator.reason
    ),
    authoritative_revision: authoritativeRevision,
    applied_revision: meta?.appliedRevision ?? null,
    item_count: meta?.itemCount ?? null,
    processed: meta?.processed ?? null,
    total: meta?.total ?? null,
    memory_bytes: meta?.memoryBytes ?? null,
    last_updated_at: lastUpdatedAt,
    built_at: timing.builtAt,
    started_at: timing.startedAt,
    elapsed_ms: timing.elapsedMs,
    core: {
      key_count: meta
        ? coreKeyCount(meta.state, meta.itemCount)
        : null,
      member_count: meta?.itemCount ?? null,
      memory_bytes: meta?.memoryBytes ?? null,
      source: "meta"
    },
    derived: {
      key_count: derived?.keyCount ?? null,
      member_count: derived?.memberCount ?? null,
      memory_bytes: derived?.memoryBytes ?? null,
      source: "registry"
    },
    recent_errors: {
      core: recent.core ?? persistedCoreError(
        meta?.lastError ?? "",
        meta?.startedAt ?? null
      ),
      derived: recent.derived
    },
    required_commands: {
      INCREX: coordinator.requiredCommands?.commands.INCREX ?? null,
      ARRING: coordinator.requiredCommands?.commands.ARRING ?? null,
      ARLASTITEMS: coordinator.requiredCommands?.commands.ARLASTITEMS ?? null
    }
  };
}

export async function getReadyImageCacheAdminStatus(
  dependencies: ReadyImageCacheAdminStatusDependencies =
    defaultAdminStatusDependencies
) {
  const revision = await dependencies.getRevision();
  return readReadyImageCacheAdminStatus(revision.revision, dependencies);
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
