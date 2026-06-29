import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolve the dev proxy target the same way the app resolves its own domain, so
// `npm run dev` talks to whatever backend the local config points at. Priority:
// data/config.json (site.domain + port) → APP_DOMAIN + PORT env → localhost:5518.
function resolveProxyTarget() {
  const configPath = fileURLToPath(new URL("../../data/config.json", import.meta.url));
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
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // 缓存失效指纹：把默认 8 位哈希缩短为 6 位（仍是内容哈希，base64 字符集不变）。任一资源内容
        // 变化即改名，CDN/浏览器据此拉新文件、不会命中旧缓存。6 位 base64 ≈ 687 亿种，足够防碰撞。
        entryFileNames: "assets/[name]-[hash:6].js",
        chunkFileNames: "assets/[name]-[hash:6].js",
        assetFileNames: "assets/[name]-[hash:6][extname]",
        // Split the framework deps into their own long-cache chunks, separate from app code
        // (which is further route-split via React.lazy in AppRoutes), so a public visitor
        // doesn't download the admin bundle and vendor code stays cached across app deploys.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@tanstack")) return "query-vendor";
          if (/[\\/](react-router-dom|react-router|react-dom|react|scheduler)[\\/]/.test(id)) return "react-vendor";
          return undefined;
        }
      }
    }
  },
  // Web Worker（md5.worker）走独立的打包管线，命名不受 build.rollupOptions 影响，单独同样设为 6 位哈希。
  worker: {
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash:6].js",
        chunkFileNames: "assets/[name]-[hash:6].js",
        assetFileNames: "assets/[name]-[hash:6][extname]"
      }
    }
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
