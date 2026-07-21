import type { RuntimeConfig } from "@imageshow/shared";
import { withAdvisoryLock } from "../core/db.ts";
import { parseRuntimeConfig } from "./runtime-config.ts";
import {
  getRuntimeConfig,
  replaceRuntimeConfig,
  withRuntimeConfigWriteLease
} from "./runtime-config-store.ts";

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
  return withRuntimeConfigWriteLease(() => withAdvisoryLock(
    advancedConfigWriteLockKey,
    async (signal) => {
      signal.throwIfAborted();
      const config = parseRuntimeConfig(value);
      const changes = summarizeRuntimeConfigChanges(getRuntimeConfig(), config);
      signal.throwIfAborted();
      return {
        config: structuredClone(await replaceRuntimeConfig(config)),
        changes
      };
    }
  ));
}
