import type { RuntimeConfig } from "@imageshow/shared/browser";
import { getRuntimeConfig } from "./runtime-config-store.ts";
import { trustedOriginSources } from "./trusted-origins.ts";

type EmbedAncestorConfig = Pick<RuntimeConfig, "site" | "embed">;

export function effectiveEmbedAncestorSources(config: EmbedAncestorConfig = getRuntimeConfig()) {
  if (!config.embed.enabled) return [];
  return trustedOriginSources(config);
}
