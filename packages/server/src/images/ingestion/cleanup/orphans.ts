import { appConfig } from "@imageshow/shared";
import { errorMessage } from "../../../core/api-error.ts";
import {
  runWithAdvisoryLockAcquisitionSignal
} from "../../../core/database/advisory-locks.ts";
import { logger } from "../../../core/logger.ts";
import {
  getRedisOperationalState,
  requireOperationalRedis
} from "../../../core/runtime-availability.ts";
import { listStorageBackends } from "../../../storage/backends/registry.ts";
import type { StorageBackendRecord } from "../../../storage/backends/config.ts";
import { STORAGE_ADMIN_LIST_MAX_KEYS } from "../../../storage/objects/key-listing.ts";
import {
  withStorageLocationReadLock,
  withStorageLocationWriteLock
} from "../../../storage/maintenance-lock.ts";
import {
  collectStorageKeys,
  pruneEmptyStorageDirs,
  removeStorageObjectsAndConfirm
} from "../../../storage/objects/access.ts";
import {
  groupStorageNamespaces,
  storageNamespaceGroupIdentity,
  storageNamespaceIdentity
} from "../../../storage/objects/namespace.ts";
import {
  ingestionOrphanCleanupIntervalMs,
  ingestionOrphanCutoffs
} from "./retention.ts";
import { cleanupIngestionRawOrphans } from "../raw/orphan-scanner.ts";
import { parseIngestionStagingCleanupKey } from "../staging-keys.ts";
import { activeIngestionStorageReferences } from "./storage-references.ts";

type StorageGroup = Readonly<{
  key: string;
  identity: string;
  referenceIdentity: string;
  backends: StorageBackendRecord[];
  referenceBackends: StorageBackendRecord[];
}>;

export type IngestionOrphanCleanupReport = Readonly<{
  skipped: boolean;
  raw_removed: number;
  staging_removed: number;
  staging_failed: number;
  incomplete_namespaces: number;
  incomplete_raw_scans: number;
}>;

type StagingScanBudget = { remaining: number };
// Bound preflight and confirmation latency so a periodic cleanup can commit
// progress before its cycle deadline even when one namespace has many orphans.
const INGESTION_STAGING_REMOVAL_BATCH_SIZE = 100;
let nextStagingGroupKey: string | null = null;

function runWithCleanupLockSignal<T>(
  signal: AbortSignal | undefined,
  work: () => Promise<T>
) {
  signal?.throwIfAborted();
  return signal
    ? runWithAdvisoryLockAcquisitionSignal(signal, work)
    : work();
}

type CleanupLockWork<T> = (signal: AbortSignal) => Promise<T>;

function withCleanupReadLock<T>(
  callerSignal: AbortSignal | undefined,
  work: CleanupLockWork<T>
) {
  return runWithCleanupLockSignal(callerSignal, () => (
    withStorageLocationReadLock((lockSignal) => {
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, lockSignal])
        : lockSignal;
      signal.throwIfAborted();
      return work(signal);
    })
  ));
}

function withCleanupWriteLock<T>(
  callerSignal: AbortSignal | undefined,
  work: CleanupLockWork<T>
) {
  return runWithCleanupLockSignal(callerSignal, () => (
    withStorageLocationWriteLock((lockSignal) => {
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, lockSignal])
        : lockSignal;
      signal.throwIfAborted();
      return work(signal);
    })
  ));
}

function rotatedStorageGroups(groups: readonly StorageGroup[]) {
  const ordered = [...groups].toSorted((left, right) => (
    left.key.localeCompare(right.key)
  ));
  const cursorIndex = nextStagingGroupKey
    ? ordered.findIndex((group) => group.key === nextStagingGroupKey)
    : -1;
  const start = cursorIndex >= 0 ? cursorIndex : 0;
  return [...ordered.slice(start), ...ordered.slice(0, start)];
}

function storageGroups(backends: readonly StorageBackendRecord[]) {
  return groupStorageNamespaces(backends).flatMap((referenceBackends) => {
    const referenceIdentity = storageNamespaceGroupIdentity(referenceBackends);
    const physical = new Map<string, StorageBackendRecord[]>();
    for (const backend of referenceBackends) {
      const identity = storageNamespaceIdentity(backend);
      physical.getOrInsertComputed(identity, () => []).push(backend);
    }
    return [...physical].map(([identity, grouped]) => ({
      key: `${identity}\0${referenceIdentity}`,
      identity,
      referenceIdentity,
      backends: grouped,
      referenceBackends
    } satisfies StorageGroup));
  });
}

function stagingKeysForGroup(
  references: Awaited<ReturnType<typeof activeIngestionStorageReferences>>,
  group: StorageGroup
) {
  const keys = new Set<string>();
  for (const backend of group.referenceBackends) {
    for (const key of references.stagingKeysByBackend.get(backend.slug) ?? []) {
      keys.add(key);
    }
  }
  return keys;
}

async function collectGroupStagingKeys(
  group: StorageGroup,
  budget: StagingScanBudget,
  callerSignal?: AbortSignal
) {
  const failures: Array<{ backend: string; error: string }> = [];
  const timeoutSignal = AbortSignal.timeout(Math.max(
    1_000,
    Math.min(15_000, Math.floor(ingestionOrphanCleanupIntervalMs() / 2))
  ));
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
  for (const backend of group.backends) {
    if (budget.remaining <= 0) break;
    const maxKeys = Math.min(
      STORAGE_ADMIN_LIST_MAX_KEYS,
      budget.remaining
    );
    try {
      const listing = await collectStorageKeys("_uploads", backend.slug, {
        signal,
        maxKeys
      });
      budget.remaining -= listing.count;
      return {
        backend: backend.slug,
        listing,
        failures
      };
    } catch (error) {
      callerSignal?.throwIfAborted();
      // A failed driver does not expose its partial count. Charge the entire
      // per-attempt allowance so retries through aliases cannot exceed the
      // cycle-wide enumeration budget.
      budget.remaining -= maxKeys;
      failures.push({ backend: backend.slug, error: errorMessage(error) });
    }
  }
  return { backend: null, listing: null, failures };
}

async function captureStagingGroup(
  group: StorageGroup,
  budget: StagingScanBudget,
  callerSignal?: AbortSignal
) {
  return withCleanupReadLock(callerSignal, async (signal) => {
    await requireOperationalRedis();
    const currentGroup = new Map(
      storageGroups(await listStorageBackends()).map((candidate) => [
        candidate.key,
        candidate
      ])
    ).get(group.key);
    if (!currentGroup) {
      return { group, referencesBefore: null, captured: null };
    }
    const referencesBefore = await activeIngestionStorageReferences({ signal });
    const captured = await collectGroupStagingKeys(currentGroup, budget, signal);
    signal.throwIfAborted();
    return { group: currentGroup, referencesBefore, captured };
  });
}

async function cleanupCapturedStagingGroup(
  capture: Awaited<ReturnType<typeof captureStagingGroup>>,
  now: number,
  callerSignal?: AbortSignal
) {
  callerSignal?.throwIfAborted();
  return withCleanupWriteLock(callerSignal, async (signal) => {
    await requireOperationalRedis();
    const referencesAfter = await activeIngestionStorageReferences({ signal });
    const currentGroups = new Map(
      storageGroups(await listStorageBackends()).map((group) => [
        group.key,
        group
      ])
    );
    const { stagingCutoff } = ingestionOrphanCutoffs(now);
    const group = capture.group;
    const result = capture.captured;
    const currentGroup = currentGroups.get(group.key);
    if (!currentGroup || !capture.referencesBefore || !result) {
      logger.warn("ingestion_orphan_staging_namespace_changed", {
        namespace: group.identity,
        reference_namespace: group.referenceIdentity
      });
      return { stagingRemoved: 0, stagingFailed: 0, incompleteNamespaces: 1 };
    }
    if (!result.backend || !result.listing) {
      logger.warn("ingestion_orphan_staging_namespace_unavailable", {
        namespace: group.identity,
        errors: result.failures
      });
      return { stagingRemoved: 0, stagingFailed: 0, incompleteNamespaces: 1 };
    }
    if (!result.listing.complete) {
      logger.warn("ingestion_orphan_staging_listing_incomplete", {
        backend: result.backend,
        scanned: result.listing.count,
        limit: STORAGE_ADMIN_LIST_MAX_KEYS
      });
      return { stagingRemoved: 0, stagingFailed: 0, incompleteNamespaces: 1 };
    }
    const keep = stagingKeysForGroup(capture.referencesBefore, group);
    for (const key of stagingKeysForGroup(referencesAfter, currentGroup)) {
      keep.add(key);
    }
    const deletionBackend = currentGroup.backends.find((backend) => (
      backend.slug === result.backend
    )) ?? currentGroup.backends[0];
    if (!deletionBackend) {
      return { stagingRemoved: 0, stagingFailed: 0, incompleteNamespaces: 1 };
    }
    const candidates = result.listing.keys.filter((key) => {
      if (keep.has(key)) return false;
      const identity = parseIngestionStagingCleanupKey(key);
      if (
        !identity
        || (identity.local_atomic_candidate
          && deletionBackend.type !== "local")
        || keep.has(identity.base_key)
      ) return false;
      return identity.created_at < stagingCutoff;
    });
    let stagingRemoved = 0;
    let stagingFailed = 0;
    for (
      let offset = 0;
      offset < candidates.length;
      offset += INGESTION_STAGING_REMOVAL_BATCH_SIZE
    ) {
      signal.throwIfAborted();
      const batch = candidates.slice(
        offset,
        offset + INGESTION_STAGING_REMOVAL_BATCH_SIZE
      );
      try {
        const results = await removeStorageObjectsAndConfirm(
          batch.map((key) => ({
            prefix: "_uploads" as const,
            key,
            storageSlug: deletionBackend.slug
          })),
          { signal }
        );
        for (const result of results) {
          if (result.status === "removed" || result.status === "missing") {
            stagingRemoved += 1;
            continue;
          }
          stagingFailed += 1;
          logger.warn("ingestion_orphan_staging_cleanup_failed", {
            backend: deletionBackend.slug,
            key: result.key,
            outcome: result.status,
            error: result.error.message
          });
        }
      } catch (error) {
        signal.throwIfAborted();
        const remaining = candidates.length - offset;
        stagingFailed += remaining;
        logger.warn("ingestion_orphan_staging_cleanup_failed", {
          backend: deletionBackend.slug,
          objects: remaining,
          error: errorMessage(error)
        });
        break;
      }
    }
    if (deletionBackend.type === "local") {
      await pruneEmptyStorageDirs(deletionBackend.slug, {
        signal,
        prefix: "_uploads",
        maxEntries: appConfig.ingestionRuntime.orphanCleanupMaxRawEntriesPerCycle
      }).catch((error) => {
        signal.throwIfAborted();
        stagingFailed += 1;
        logger.warn("ingestion_orphan_staging_directory_cleanup_failed", {
          backend: deletionBackend.slug,
          error: errorMessage(error)
        });
      });
    }
    return { stagingRemoved, stagingFailed, incompleteNamespaces: 0 };
  });
}

async function cleanupStagingOrphans(
  now: number,
  callerSignal?: AbortSignal,
  stopSignal?: AbortSignal
) {
  callerSignal?.throwIfAborted();
  const backends = await withCleanupReadLock(
    callerSignal,
    async () => listStorageBackends()
  );
  const storageBackendHardLimit =
    appConfig.ingestionRuntime.orphanCleanupStorageBackendHardLimit;
  if (backends.length > storageBackendHardLimit) {
    logger.warn("ingestion_orphan_staging_supported_backend_limit_exceeded", {
      backends: backends.length,
      limit: storageBackendHardLimit
    });
    return {
      stagingRemoved: 0,
      stagingFailed: 0,
      incompleteNamespaces: backends.length
    };
  }
  const groups = rotatedStorageGroups(storageGroups(backends));
  if (!groups.length) nextStagingGroupKey = null;
  const budget: StagingScanBudget = {
    remaining: appConfig.ingestionRuntime.orphanCleanupMaxStagingKeysPerCycle
  };
  const totals = {
    stagingRemoved: 0,
    stagingFailed: 0,
    incompleteNamespaces: 0
  };
  for (const [index, group] of groups.entries()) {
    stopSignal?.throwIfAborted();
    if (index >= appConfig.ingestionRuntime.orphanCleanupMaxStorageBackends) {
      totals.incompleteNamespaces += groups.length - index;
      logger.warn("ingestion_orphan_staging_group_cycle_limit_reached", {
        remaining_namespaces: groups.length - index,
        limit: appConfig.ingestionRuntime.orphanCleanupMaxStorageBackends
      });
      break;
    }
    if (callerSignal?.aborted) {
      totals.incompleteNamespaces += groups.length - index;
      break;
    }
    if (budget.remaining <= 0) {
      totals.incompleteNamespaces += groups.length - index;
      logger.warn("ingestion_orphan_staging_cycle_budget_exhausted", {
        remaining_namespaces: groups.length - index,
        limit: appConfig.ingestionRuntime.orphanCleanupMaxStagingKeysPerCycle
      });
      break;
    }
    nextStagingGroupKey = groups[(index + 1) % groups.length]?.key ?? null;
    try {
      const capture = await captureStagingGroup(group, budget, callerSignal);
      const result = await cleanupCapturedStagingGroup(capture, now, callerSignal);
      totals.stagingRemoved += result.stagingRemoved;
      totals.stagingFailed += result.stagingFailed;
      totals.incompleteNamespaces += result.incompleteNamespaces;
    } catch (error) {
      stopSignal?.throwIfAborted();
      if (callerSignal?.aborted) {
        totals.incompleteNamespaces += groups.length - index;
        logger.warn("ingestion_orphan_staging_cycle_timeout", {
          remaining_namespaces: groups.length - index
        });
        break;
      }
      throw error;
    }
  }
  return totals;
}

/**
 * Delete only disposable material whose absence from a stable Redis projection
 * has been proven. Redis loss therefore skips both raw and staging cleanup;
 * formal media/thumb candidates remain owned by persistent move.cleanup jobs.
 */
export async function cleanupIngestionOrphans(
  now = Date.now(),
  signal?: AbortSignal
): Promise<IngestionOrphanCleanupReport> {
  signal?.throwIfAborted();
  if (!getRedisOperationalState().available) {
    return {
      skipped: true,
      raw_removed: 0,
      staging_removed: 0,
      staging_failed: 0,
      incomplete_namespaces: 0,
      incomplete_raw_scans: 0
    };
  }
  await requireOperationalRedis();
  const cutoffs = ingestionOrphanCutoffs(now);
  const cycleTimeoutMs = (
    appConfig.ingestionRuntime.orphanCleanupCycleTimeoutSeconds * 1000
  );
  const rawTimeoutSignal = AbortSignal.timeout(Math.max(
    1_000,
    Math.floor(cycleTimeoutMs * 0.4)
  ));
  const rawSignal = signal
    ? AbortSignal.any([signal, rawTimeoutSignal])
    : rawTimeoutSignal;
  let raw = { removed: 0, complete: false };
  try {
    const rawReferences = await activeIngestionStorageReferences({
      signal: rawSignal
    });
    raw = await cleanupIngestionRawOrphans({
      keep: rawReferences.rawPaths,
      rawCutoff: cutoffs.rawCutoff,
      partCutoff: cutoffs.partCutoff,
      signal: rawSignal,
      stopSignal: signal
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (!rawTimeoutSignal.aborted) throw error;
    logger.warn("ingestion_orphan_raw_cycle_timeout", {
      timeout_ms: Math.max(1_000, Math.floor(cycleTimeoutMs * 0.4))
    });
  }
  const stagingTimeoutSignal = AbortSignal.timeout(Math.max(
    1_000,
    cycleTimeoutMs - Math.floor(cycleTimeoutMs * 0.4)
  ));
  const stagingSignal = signal
    ? AbortSignal.any([signal, stagingTimeoutSignal])
    : stagingTimeoutSignal;
  const staging = await cleanupStagingOrphans(
    now,
    stagingSignal,
    signal
  );
  return {
    skipped: false,
    raw_removed: raw.removed,
    staging_removed: staging.stagingRemoved,
    staging_failed: staging.stagingFailed,
    incomplete_namespaces: staging.incompleteNamespaces,
    incomplete_raw_scans: raw.complete ? 0 : 1
  };
}
