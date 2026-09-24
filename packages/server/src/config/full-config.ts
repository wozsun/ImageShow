import type { RuntimeConfig, RuntimeConfigChangeSummaryDto } from "@imageshow/shared/browser";
import { z } from "zod";
import { ApiError } from "../core/api-error.ts";
import { assertLocalImageHostForSite } from "../storage/backends/registry.ts";
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
    access_changes: current.site.domain === candidate.site.domain ? [] : ["site.domain" as const]
  };
}

export function getFullRuntimeConfig() {
  return structuredClone(getRuntimeConfig());
}

export async function validateFullRuntimeConfig(value: unknown) {
  let config: RuntimeConfig;
  try {
    config = parseRuntimeConfig(value);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ApiError(
        400,
        "validation_error",
        error.issues[0]?.message ?? "Validation failed",
        error.flatten()
      );
    }
    throw error;
  }
  await assertLocalImageHostForSite(config.site.domain);
  return {
    config,
    changes: summarizeRuntimeConfigChanges(getRuntimeConfig(), config)
  };
}

export function saveFullRuntimeConfig(value: unknown) {
  return withRuntimeConfigWriteLease(async () => {
    const { config } = await validateFullRuntimeConfig(value);
    return {
      config: structuredClone(await replaceRuntimeConfig(config))
    };
  });
}
