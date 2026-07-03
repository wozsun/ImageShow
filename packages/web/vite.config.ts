import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function resolveProxyTarget() {
  const configPath = fileURLToPath(new URL("../../data/config.json", import.meta.url));
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8")) as { site?: { domain?: string }; port?: number };
      const domain = config.site?.domain;
      if (domain) return `http://${domain.replace(/:\d+$/, "")}:${config.port ?? 5518}`;
    } catch {
    }
  }
  if (process.env.SITE_DOMAIN) return `http://${process.env.SITE_DOMAIN.replace(/:\d+$/, "")}:${process.env.PORT ?? 5518}`;
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

        chunkFileNames(chunk) {
          const isVendor = chunk.name === "react-vendor" || chunk.name === "query-vendor";
          const isShared = !chunk.isEntry && !chunk.isDynamicEntry && !isVendor;
          return isShared ? "assets/shared-[hash:6].js" : "assets/[name]-[hash:6].js";
        },
        assetFileNames: "assets/[name]-[hash:6][extname]",

        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@tanstack")) return "query-vendor";
          if (/[\\/](react-router-dom|react-router|react-dom|react|scheduler)[\\/]/.test(id)) return "react-vendor";
          return undefined;
        }
      }
    }
  },
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

    proxy: {
      "/api": target,
      "/random": target,
      "/img-count": target
    }
  }
});
