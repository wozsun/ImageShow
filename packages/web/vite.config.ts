import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolve the dev proxy target the same way the app resolves its own domain, so
// `npm run dev` talks to whatever backend the local config points at. Priority:
// data/config/config.json (site.domain + port) → APP_DOMAIN + PORT env → localhost:5518.
function resolveProxyTarget() {
  const configPath = fileURLToPath(new URL("../../data/config/config.json", import.meta.url));
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8")) as { site?: { domain?: string }; port?: number };
      const domain = config.site?.domain;
      if (domain) return `http://${domain.replace(/:\d+$/, "")}:${config.port ?? 5518}`;
    } catch {
      // Fall through to env / default on a missing or malformed config.
    }
  }
  if (process.env.APP_DOMAIN) return `http://${process.env.APP_DOMAIN.replace(/:\d+$/, "")}:${process.env.PORT ?? 5518}`;
  return "http://localhost:5518";
}

const target = resolveProxyTarget();

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  server: {
    // Only the API surface is proxied. /media and /thumbs are intentionally NOT
    // proxied: image bytes are served from the static object host, so any stray
    // same-origin image reference fails fast in dev instead of silently working.
    proxy: {
      "/api": target,
      "/random": target,
      "/img-count": target
    }
  }
});
