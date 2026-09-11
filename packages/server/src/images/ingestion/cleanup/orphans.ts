import { appConfig } from "@imageshow/shared";
import { getRedisOperationalState } from "../../../core/runtime-availability.ts";
import { logger } from "../../../core/logger.ts";
import { cleanupIngestionTempOrphans } from "../raw/orphan-scanner.ts";
import { ingestionOrphanCutoffs } from "./retention.ts";
import { activeIngestionStorageReferences } from "./storage-references.ts";

export async function cleanupIngestionOrphans(now = Date.now(), signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!getRedisOperationalState().available) {
    return { skipped: true, temp_removed: 0, incomplete_temp_scans: 0 };
  }
  const timeoutMs = appConfig.ingestionRuntime.orphanCleanupCycleTimeoutSeconds * 1000;
  const timeout = AbortSignal.timeout(timeoutMs);
  const cycleSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const references = await activeIngestionStorageReferences({ signal: cycleSignal });
    const result = await cleanupIngestionTempOrphans({
      keep: references.tempPaths,
      ...ingestionOrphanCutoffs(now),
      signal: cycleSignal,
      stopSignal: signal
    });
    return { skipped: false, temp_removed: result.removed, incomplete_temp_scans: result.complete ? 0 : 1 };
  } catch (error) {
    signal?.throwIfAborted();
    if (!timeout.aborted) throw error;
    logger.warn("ingestion_orphan_temp_cycle_timeout", { timeout_ms: timeoutMs });
    return { skipped: false, temp_removed: 0, incomplete_temp_scans: 1 };
  }
}
