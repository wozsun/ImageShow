import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appConfig } from "../shared/src/app-config.ts";
import {
  adminAuthSharedModuleSuffixes,
  adminFoundationModuleSuffixes,
  appFoundationModuleSuffixes,
  javaScriptAssetName,
  matchesModuleSuffix,
  smallSharedMergeThreshold,
  styleAssetName
} from "../../scripts/build/web-build-contract.ts";

function resolveProxyTarget() {
  const configPath = fileURLToPath(new URL("../../data/config.json", import.meta.url));
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8")) as { site?: { domain?: string } };
      const domain = config.site?.domain;
      if (domain) return `http://${domain.replace(/:\d+$/, "")}:${appConfig.applicationPort}`;
    } catch {
    }
  }
  if (process.env.SITE_DOMAIN) {
    return `http://${process.env.SITE_DOMAIN.replace(/:\d+$/, "")}:${appConfig.applicationPort}`;
  }
  return `http://localhost:${appConfig.applicationPort}`;
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
        entryFileNames(chunk) {
          return `assets/${javaScriptAssetName(chunk.name)}-[hash:6].js`;
        },

        chunkFileNames(chunk) {
          const hasStableGroupName = (
            chunk.name === "react-vendor"
            || chunk.name === "query-vendor"
            || chunk.name === "app-foundation"
            || chunk.name === "admin-auth-shared"
            || chunk.name === "admin-foundation"
          );
          const isShared = !chunk.isEntry && !chunk.isDynamicEntry && !hasStableGroupName;
          return isShared
            ? "assets/shared-[hash:6].js"
            : `assets/${javaScriptAssetName(chunk.name)}-[hash:6].js`;
        },
        assetFileNames(asset) {
          const primaryName = asset.names[0] ?? "";
          const semanticStyleName = styleAssetName(primaryName);
          // Rolldown derives shared CSS names by joining every consuming route.
          // Keep that ownership untouched while naming the stable consumer
          // domain instead of exposing the complete route set.
          return semanticStyleName
            ? semanticStyleName
            : "assets/[name]-[hash:6][extname]";
        },

        codeSplitting: {
          // 路由页面及其就近模块按实际入口集合精确拆分，不把公开页面、图片管理员页面
          // 和超级管理员页面的专有实现互相打包；跨页面通用模块仍交给默认分块器复用。
          groups: [
            {
              name: "query-vendor",
              test: /[\\/]node_modules[\\/]@tanstack[\\/]/,
              priority: 5
            },
            {
              name: "react-vendor",
              test: /[\\/]node_modules[\\/](?:react-router|react-dom|react|scheduler)[\\/]/,
              priority: 4
            },
            {
              name: "app-foundation",
              test: (id) => matchesModuleSuffix(id, appFoundationModuleSuffixes),
              priority: 3,
              includeDependenciesRecursively: false
            },
            {
              name: "admin-auth-shared",
              test: (id) => matchesModuleSuffix(
                id,
                adminAuthSharedModuleSuffixes
              ),
              priority: 3,
              includeDependenciesRecursively: false
            },
            {
              name: "admin-foundation",
              test: (id) => matchesModuleSuffix(id, adminFoundationModuleSuffixes),
              priority: 2,
              minShareCount: 2,
              // 只收明确列出的后台模块；依赖仍按其真实入口集合分块，避免公开页
              // 因共用 Icon、对话框 Hook 等基础能力而加载后台基础块。
              includeDependenciesRecursively: false
            },
            {
              name: "app-shared",
              test: (id) => (
                /[\\/]packages[\\/]web[\\/]src[\\/]/.test(id)
                && !/[\\/]packages[\\/]web[\\/]src[\\/]pages[\\/]/.test(id)
                && !id.endsWith(".css")
              ),
              priority: 1,
              minShareCount: 2,
              entriesAware: true,
              entriesAwareMergeThreshold: smallSharedMergeThreshold
            },
            {
              name: "route-pages",
              test: /[\\/]packages[\\/]web[\\/]src[\\/]pages[\\/]/,
              minShareCount: 2,
              entriesAware: true,
              entriesAwareMergeThreshold: 0
            }
          ]
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
      "/random": target
    }
  }
});
