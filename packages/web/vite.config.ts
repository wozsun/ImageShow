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
  "/packages/shared/dist/browser/common.js",
  "/packages/shared/dist/browser/imports.js",
  "/packages/shared/dist/browser/settings.js",
  "/packages/shared/dist/browser/storage.js",
  "/components/feedback/AppLoadingScreen.tsx",
  "/components/feedback/DialogLayerPortal.tsx",
  "/components/feedback/DialogPortalContext.ts",
  "/components/feedback/QueryErrorState.tsx",
  "/components/feedback/RouteLoadBoundary.tsx",
  "/components/icon/Icon.tsx",
  "/components/icon/icons.generated.ts",
  "/components/image/image-admin-details-loader.ts",
  "/components/image/image-element-loader.ts",
  "/components/layout/OverlayScrollbar.tsx",
  "/components/navigation/MobileNavigation.tsx",
  "/hooks/useAnimatedClose.ts",
  "/hooks/usePageScrollLock.ts",
  "/hooks/useDialogFocus.ts",
  "/hooks/useMediaQuery.ts",
  "/lib/api/client.ts",
  "/lib/api/query-keys.ts",
  "/lib/api/site-data.ts",
  "/lib/async-intent-fence.ts",
  "/lib/constants.ts",
  "/lib/page-lifetime-module-loader.ts",
  "/lib/ui/async-action-timing.ts",
  "/lib/ui/apply-ui-color-context.ts",
  "/lib/ui/color-scheme.ts",
  "/lib/ui/clipboard.ts",
  "/lib/ui/error-reporting.ts",
  "/lib/ui/formatters.ts",
  "/lib/ui/preload-intent.ts",
  "/lib/ui/select-options.ts"
] as const;

// 登录、账号设置与管理员账号页共用的极小认证表单能力。登录页需要密码控件，
// 但不应为此提前下载完整 admin-foundation；把密码规则一并放入同一语义块，
// 既供认证后台复用，也避免生成一个不足 1 KiB 的 PasswordInput 独立请求。
const adminAuthSharedModuleSuffixes = [
  "/components/form/PasswordInput.tsx",
  "/lib/auth/password.ts"
] as const;

// 这些模块只服务于已认证后台，且横跨图片管理员可访问的多个页面。把它们作为
// 一个权限边界内的基础块复用，避免为几百字节的控件各发一次请求；不得把公开页
// 也会静态使用的模块加入此表。
const adminFoundationModuleSuffixes = [
  "/components/actions/AsyncActionButton.tsx",
  "/components/icon/AdminIcon.tsx",
  "/components/icon/admin-icons.generated.ts",
  "/components/data-display/SlugChip.tsx",
  "/components/data-display/StableButtonLabel.tsx",
  "/components/feedback/ActionFeedback.tsx",
  "/components/feedback/ActionFeedbackRegion.tsx",
  "/components/feedback/ConfirmDialog.tsx",
  "/components/feedback/DialogFrame.tsx",
  "/components/image/ThumbImage.tsx",
  "/components/layout/WorkspaceHeader.tsx",
  "/components/navigation/AdminPagination.tsx",
  "/components/navigation/admin-pagination.ts",
  "/hooks/useAdminPreferences.tsx",
  "/hooks/useAsyncActionStatus.ts",
  "/lib/api/admin-preference-cache.ts",
  "/lib/api/admin-settings.ts",
  "/lib/api/image-edit.ts",
  "/lib/api/import-vocabulary.ts",
  "/lib/api/query-invalidation.ts",
  "/lib/api/storage-options.ts"
] as const;

function matchesModuleSuffix(id: string, suffixes: readonly string[]) {
  const normalizedId = id.replaceAll("\\", "/");
  return suffixes.some((suffix) => normalizedId.endsWith(suffix));
}

const imageAdminStyleOwners = new Set([
  "EntityAdmin",
  "ImageAdmin",
  "LinkUrlDialog",
  "Uploader"
]);

// These modules are admin capabilities, but an authenticated visitor can open
// them lazily from the public gallery's image-detail dialog.
const crossDomainStyleOwners = new Set([
  "ImageDetailModal",
  "ImageAdminDetails",
  "ImageEditModal",
  "image-editor-capability"
]);

const superAdminStyleOwners = new Set([
  "AdvancedConfigPage",
  "LogPage",
  "SettingsPage",
  "StorageSettings"
]);

const styleOwnerGroupNames = new Set([
  "app-shared",
  "route-pages"
]);

const adminStyleOwners = new Set([
  ...imageAdminStyleOwners,
  ...crossDomainStyleOwners,
  ...superAdminStyleOwners,
  "AccountSettings",
  "AdminLogin",
  "LoginChallenge",
  "AdminShell",
  "AuthenticatedAdminShell",
  "BatchStorageMigrationDialog",
  "CheckPage",
  "Overview",
  "UserAdmin"
]);

const publicStyleOwners = new Set([
  "GalleryPage",
  "HomePage"
]);

const imageDetailStyleOwners = new Set([
  "GalleryPage",
  "ImageAdmin",
  "ImageDetailModal",
  "LinkUrlDialog",
  "Overview",
  "Uploader"
]);

const knownStyleOwners = new Set([
  ...adminStyleOwners,
  ...publicStyleOwners
]);

export function routeStyleAssetName(primaryName: string) {
  const suffix = ".css";
  if (!primaryName.endsWith(suffix)) {
    return null;
  }
  const parts = primaryName
    .slice(0, -suffix.length)
    .split("~");
  if (parts.length < 2) return null;
  const owners = styleOwnerGroupNames.has(parts[0]) ? parts.slice(1) : parts;
  if (
    owners.length === 0
    || owners.some((owner) => !knownStyleOwners.has(owner))
  ) {
    return "assets/common-[hash:6][extname]";
  }
  if (
    owners.includes("ImageDetailModal")
    && owners.every((owner) => imageDetailStyleOwners.has(owner))
  ) {
    return "assets/image-detail-[hash:6][extname]";
  }
  if (owners.some((owner) => crossDomainStyleOwners.has(owner))) {
    return "assets/shared-[hash:6][extname]";
  }
  if (
    owners.every((owner) => superAdminStyleOwners.has(owner))
  ) {
    return "assets/super-admin-[hash:6][extname]";
  }
  if (
    owners.every((owner) => imageAdminStyleOwners.has(owner))
  ) {
    return "assets/image-admin-common-[hash:6][extname]";
  }
  if (
    owners.every((owner) => adminStyleOwners.has(owner))
  ) {
    return "assets/admin-common-[hash:6][extname]";
  }
  if (
    owners.every((owner) => publicStyleOwners.has(owner))
  ) {
    return "assets/public-common-[hash:6][extname]";
  }
  return "assets/shared-[hash:6][extname]";
}

const entryStyleAssetNames = new Map([
  ["index.css", "app-core"],
  ["HomePage.css", "home"],
  ["GalleryPage.css", "gallery"],
  ["public-core.css", "public-common"],
  ["AdminShell.css", "admin-core"],
  ["AuthenticatedAdminShell.css", "admin-core"],
  ["ImageAdmin.css", "images"],
  ["Uploader.css", "upload"],
  ["ImageAdminDetails.css", "image-management"],
  ["ImageDetailModal.css", "image-detail"],
  ["ImageEditModal.css", "image-edit"],
  ["image-editor-capability.css", "image-editor"],
  ["image-workflow.css", "image-workflow"],
  ["semantic-colors.css", "admin-theme"],
  ["AdminLogin.css", "login"],
  ["LoginChallenge.css", "login-challenge"],
  ["Overview.css", "overview"],
  ["CheckPage.css", "check"],
  ["AccountSettings.css", "account"],
  ["entity.css", "entities"],
  ["SettingsPage.css", "site-settings"],
  ["AdvancedConfigPage.css", "advanced-config"],
  ["StorageSettings.css", "storage"],
  ["LogPage.css", "log"]
]);

export function styleAssetName(primaryName: string) {
  const entryStyleName = entryStyleAssetNames.get(primaryName);
  if (entryStyleName) {
    return `assets/${entryStyleName}-[hash:6][extname]`;
  }
  const routeStyleName = routeStyleAssetName(primaryName);
  if (routeStyleName) return routeStyleName;
  return primaryName.endsWith(".css")
    ? "assets/common-[hash:6][extname]"
    : null;
}

const entryJavaScriptAssetNames = new Map([
  ["index", "app"],
  ["HomePage", "home"],
  ["GalleryPage", "gallery"],
  ["AdminShell", "admin"],
  ["AuthenticatedAdminShell", "admin-app"],
  ["AdminLogin", "login"],
  ["LoginChallenge", "login-challenge"],
  ["Overview", "overview"],
  ["ImageAdmin", "images"],
  ["ImageAdminDetails", "image-management"],
  ["image-editor-capability", "image-editor"],
  ["Uploader", "upload"],
  ["LinkUrlDialog", "link-import"],
  ["BatchStorageMigrationDialog", "storage-migration"],
  ["AccountSettings", "account"],
  ["EntityAdmin", "entities"],
  ["SettingsPage", "site-settings"],
  ["AdvancedConfigPage", "advanced-config"],
  ["StorageSettings", "storage"],
  ["UserAdmin", "users"],
  ["CheckPage", "check"],
  ["LogPage", "log"]
]);

export function javaScriptAssetName(entryName: string) {
  return entryJavaScriptAssetNames.get(entryName) ?? entryName;
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
