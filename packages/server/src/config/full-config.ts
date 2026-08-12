import type {
  RuntimeConfig,
  RuntimeConfigChangeSummaryDto
} from "@imageshow/shared/browser";
import { parseRuntimeConfig } from "./runtime-config.ts";
import {
  getRuntimeConfig,
  replaceRuntimeConfig,
  withRuntimeConfigWriteLease
} from "./runtime-config-store.ts";

function summarizeRuntimeConfigChanges(
  current: RuntimeConfig,
  candidate: RuntimeConfig
): RuntimeConfigChangeSummaryDto {
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
  return withRuntimeConfigWriteLease(async () => {
    const config = parseRuntimeConfig(value);
    return {
      config: structuredClone(await replaceRuntimeConfig(config))
    };
  });
}
