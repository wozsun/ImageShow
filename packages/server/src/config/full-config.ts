import type { RuntimeConfig } from "@imageshow/shared";
import { withAdvisoryLock } from "../core/db.ts";
import { parseRuntimeConfig } from "./runtime-config.ts";
import {
  getRuntimeConfig,
  replaceRuntimeConfig,
  withRuntimeConfigWriteLease
} from "./runtime-config-store.ts";

export const advancedConfigWriteLockKey = "advanced-config-write";

function summarizeRuntimeConfigChanges(
  current: RuntimeConfig,
  candidate: RuntimeConfig
) {
  return {
    access_changes: current.site.domain === candidate.site.domain
      ? []
      : ["site.domain" as const]
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
      signal.throwIfAborted();
      return {
        config: structuredClone(await replaceRuntimeConfig(config))
      };
    }
  ));
}
