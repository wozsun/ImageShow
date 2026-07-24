import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appConfig } from "@imageshow/shared";

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

// 只合并极小的通用模块入口子组，减少 HTTP 请求开销；页面专有实现不经过此阈值，
// 仍按实际路由精确拆分。2 KiB 足以收敛零碎辅助函数，又不会形成新的大杂烩共享块。
const smallSharedMergeThreshold = 2 * 1024;

// 最低权限层可用的全站基础能力。后台角色也能访问公开页面，因此可以直接复用
// 这一块；这里只列通用机制，不纳入任何后台 API、后台组件或路由页面实现。
const appFoundationModuleSuffixes = [
  "/packages/shared/dist/browser.js",
  "/components/feedback/QueryErrorState.tsx",
  "/components/icon/Icon.tsx",
  "/components/icon/icons.generated.ts",
  "/components/layout/OverlayScrollbar.tsx",
  "/components/navigation/MobileNavigation.tsx",
  "/hooks/useAnimatedClose.ts",
  "/hooks/useBodyScrollLock.ts",
  "/hooks/useDialogFocus.ts",
  "/lib/api/client.ts",
  "/lib/api/query-keys.ts",
  "/lib/api/site-data.ts",
  "/lib/constants.ts",
  "/lib/ui/async-action-timing.ts",
  "/lib/ui/error-reporting.ts",
  "/lib/ui/formatters.ts",
  "/lib/ui/page-scroll-insets.ts",
  "/lib/ui/select-options.ts"
] as const;

// 这些模块只服务于已认证后台，且横跨图片管理员可访问的多个页面。把它们作为
// 一个权限边界内的基础块复用，避免为几百字节的控件各发一次请求；不得把公开页
// 也会静态使用的模块加入此表。
const adminFoundationModuleSuffixes = [
  "/components/actions/AsyncActionButton.tsx",
  "/components/data-display/SlugChip.tsx",
  "/components/data-display/StableButtonLabel.tsx",
  "/components/feedback/ActionFeedback.tsx",
  "/components/feedback/ActionFeedbackRegion.tsx",
  "/components/feedback/ConfirmDialog.tsx",
  "/components/feedback/DialogFrame.tsx",
  "/components/form/PasswordInput.tsx",
  "/components/image/ThumbImage.tsx",
  "/components/layout/WorkspaceHeader.tsx",
  "/components/navigation/AdminPagination.tsx",
  "/hooks/useAdminPreferences.tsx",
  "/hooks/useAsyncActionStatus.ts",
  "/lib/api/query-invalidation.ts",
  "/lib/api/storage-options.ts",
  "/lib/auth/password.ts"
] as const;

function matchesModuleSuffix(id: string, suffixes: readonly string[]) {
  const normalizedId = id.replaceAll("\\", "/");
  return suffixes.some((suffix) => normalizedId.endsWith(suffix));
}

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
          const hasStableGroupName = (
            chunk.name === "react-vendor"
            || chunk.name === "query-vendor"
            || chunk.name === "app-foundation"
            || chunk.name === "admin-foundation"
          );
          const isShared = !chunk.isEntry && !chunk.isDynamicEntry && !hasStableGroupName;
          return isShared ? "assets/shared-[hash:6].js" : "assets/[name]-[hash:6].js";
        },
        assetFileNames: "assets/[name]-[hash:6][extname]",

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
              test: /[\\/]node_modules[\\/](?:react-router-dom|react-router|react-dom|react|scheduler)[\\/]/,
              priority: 4
            },
            {
              name: "app-foundation",
              test: (id) => matchesModuleSuffix(id, appFoundationModuleSuffixes),
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
      "/random": target,
      "/img-count": target
    }
  }
});
