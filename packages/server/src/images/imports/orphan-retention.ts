import { appConfig } from "@imageshow/shared";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";

export function importOrphanCleanupIntervalMs() {
  return appConfig.importRuntime.orphanCleanupIntervalSeconds * 1000;
}

function importOrphanCleanupSafetyMs() {
  return appConfig.importRuntime.orphanCleanupSafetySeconds * 1000;
}

export function importOrphanCutoffs(now = Date.now()) {
  const cleanupCycleAndSafety = importOrphanCleanupIntervalMs()
    + importOrphanCleanupSafetyMs();
  const rawRetention = appConfig.importRuntime.importSessionIdleTtlSeconds * 1000
    + cleanupCycleAndSafety;
  const requestRetention = Math.max(
    appConfig.importRuntime.uploadClaimStaleSeconds * 1000,
    getRuntimeConfig().link_image.fetch_timeout_seconds * 1000
  ) + cleanupCycleAndSafety;
  return {
    rawCutoff: now - rawRetention,
    partCutoff: now - requestRetention,
    stagingCutoff: now - rawRetention
  };
}
