import type { RuntimeConfig } from "@imageshow/shared";
import { withAdvisoryLock } from "../core/db.ts";
import { parseRuntimeConfig } from "./runtime-config.ts";
import { getRuntimeConfig, replaceRuntimeConfig } from "./runtime-config-store.ts";

export const advancedConfigWriteLockKey = "advanced-config-write";

export type RuntimeConfigChangeSummary = {
  access_changes: Array<"site.domain">;
};

/** @internal Exported for focused change-summary tests. */
export function summarizeRuntimeConfigChanges(
  current: RuntimeConfig,
  candidate: RuntimeConfig
): RuntimeConfigChangeSummary {
  return {
    access_changes: current.site.domain === candidate.site.domain ? [] : ["site.domain"]
  };
}

export function getFullRuntimeConfig() {
  return structuredClone(getRuntimeConfig());
}

export function validateFullRuntimeConfig(value: unknown) {
  const config = parseRuntimeConfig(value);
  return {
    config,
    changes: summarizeRuntimeConfigChanges(getRuntimeConfig(), config)
  };
}

export function saveFullRuntimeConfig(value: unknown) {
  return withAdvisoryLock(advancedConfigWriteLockKey, async () => {
    const config = parseRuntimeConfig(value);
    const changes = summarizeRuntimeConfigChanges(getRuntimeConfig(), config);
    return {
      config: structuredClone(replaceRuntimeConfig(config)),
      changes
    };
  });
}
