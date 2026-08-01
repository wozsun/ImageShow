import type { RuntimeConfig } from "@imageshow/shared/browser";
import { getRuntimeConfig } from "./runtime-config-store.ts";

type EmbedAncestorConfig = Pick<RuntimeConfig, "site" | "embed">;

export function effectiveEmbedAncestorSources(
  config: EmbedAncestorConfig = getRuntimeConfig()
) {
  if (!config.embed.enabled) return [];

  const siteUrl = new URL(`https://${config.site.domain}`);
  const port = siteUrl.port ? `:${siteUrl.port}` : "";
  const siteAuthority = `${siteUrl.hostname}${port}`;
  return [...new Set([
    `https://${siteAuthority}`,
    `https://*.${siteAuthority}`,
    ...config.embed.allowed_origins
  ])];
}
