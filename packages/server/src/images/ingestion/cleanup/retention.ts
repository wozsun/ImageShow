import { appConfig } from "@imageshow/shared";
import { getRuntimeConfig } from "../../../config/runtime-config-store.ts";

export function ingestionOrphanCleanupIntervalMs() {
  return appConfig.ingestionRuntime.orphanCleanupIntervalSeconds * 1000;
}

function ingestionOrphanCleanupSafetyMs() {
  return appConfig.ingestionRuntime.orphanCleanupSafetySeconds * 1000;
}

export function ingestionOrphanCutoffs(now = Date.now()) {
  const cleanupCycleAndSafety = ingestionOrphanCleanupIntervalMs()
    + ingestionOrphanCleanupSafetyMs();
  const rawRetention = appConfig.ingestionRuntime.importSessionIdleTtlSeconds * 1000
    + cleanupCycleAndSafety;
  const requestRetention = Math.max(
    appConfig.ingestionRuntime.uploadClaimStaleSeconds * 1000,
    getRuntimeConfig().import.fetch_timeout_seconds * 1000
  ) + cleanupCycleAndSafety;
  return {
    rawCutoff: now - rawRetention,
    partCutoff: now - requestRetention,
    stagingCutoff: now - rawRetention
  };
}
