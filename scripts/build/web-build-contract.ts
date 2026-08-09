// Shared by Vite's production chunk naming and the post-build inspector. Keep
// module ownership, semantic asset names, route matrices and request budgets in
// one declaration so a build rule cannot drift from its verifier.

export const smallSharedMergeThreshold = 2 * 1024;

export const appFoundationModuleSuffixes = [
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

export const adminAuthSharedModuleSuffixes = [
  "/components/form/PasswordInput.tsx",
  "/lib/auth/password.ts"
] as const;

export const adminFoundationModuleSuffixes = [
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

export function matchesModuleSuffix(id: string, suffixes: readonly string[]) {
  const normalizedId = id.replaceAll("\\", "/");
  return suffixes.some((suffix) => normalizedId.endsWith(suffix));
}

const imageAdminStyleOwners = new Set([
  "EntityAdmin",
  "ImageAdmin",
  "LinkUrlDialog",
  "Uploader"
]);
const crossDomainStyleOwners = new Set([
  "ImageDetailModal",
  "ImageAdminDetails",
  "image-editor-capability"
]);
const superAdminStyleOwners = new Set([
  "AdvancedConfigPage",
  "LogPage",
  "SettingsPage",
  "StorageSettings"
]);
const styleOwnerGroupNames = new Set(["app-shared", "route-pages"]);
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
const publicStyleOwners = new Set(["GalleryPage", "HomePage"]);
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

function routeStyleAssetName(primaryName: string) {
  const suffix = ".css";
  if (!primaryName.endsWith(suffix)) return null;
  const parts = primaryName.slice(0, -suffix.length).split("~");
  if (parts.length < 2) return null;
  const owners = styleOwnerGroupNames.has(parts[0]!) ? parts.slice(1) : parts;
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
  if (owners.every((owner) => superAdminStyleOwners.has(owner))) {
    return "assets/super-admin-[hash:6][extname]";
  }
  if (owners.every((owner) => imageAdminStyleOwners.has(owner))) {
    return "assets/image-admin-common-[hash:6][extname]";
  }
  if (owners.every((owner) => adminStyleOwners.has(owner))) {
    return "assets/admin-common-[hash:6][extname]";
  }
  if (owners.every((owner) => publicStyleOwners.has(owner))) {
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
  ["image-editor-capability.css", "image-editor"],
  ["image-workflow.css", "image-workflow"],
  ["semantic-colors.css", "admin-theme"],
  ["AdminLogin.css", "login"],
  ["LoginChallenge.css", "login-challenge"],
  ["Overview.css", "overview"],
  ["CheckPage.css", "check"],
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

export const webBuildAssetContract = {
  requiredEntryCssPrefixes: [
    "app-core", "home", "gallery", "admin-core", "images", "upload",
    "login", "login-challenge", "overview", "check", "entities",
    "site-settings", "advanced-config", "storage", "log"
  ],
  requiredSharedCssPrefixes: [
    "public-common", "image-management", "image-detail", "image-workflow",
    "admin-theme", "admin-common"
  ],
  optionalCssPrefixes: ["image-editor", "image-admin-common", "super-admin"],
  requiredJavaScriptPrefixes: [
    "app", "home", "gallery", "admin", "admin-app", "login",
    "login-challenge", "overview", "images", "image-management",
    "image-editor", "upload", "link-import", "storage-migration", "account",
    "entities", "site-settings", "advanced-config", "storage", "users",
    "check", "log", "pbkdf2", "app-foundation", "admin-auth-shared",
    "admin-foundation", "query-vendor", "react-vendor"
  ],
  publicInitialAssetBudgets: { HomePage: 10, GalleryPage: 16 },
  generatedIconCounts: { common: 16, admin: 34 },
  routeCss: {
    HomePage: {
      allowed: ["home", "public-common"],
      required: ["home", "public-common"]
    },
    GalleryPage: {
      allowed: ["gallery", "public-common", "image-detail"],
      required: ["gallery", "public-common", "image-detail"]
    },
    AdminLogin: {
      allowed: ["login", "admin-theme", "admin-common"],
      required: ["login", "admin-theme", "admin-common"]
    },
    AuthenticatedAdminShell: {
      allowed: ["admin-core", "admin-theme"],
      required: ["admin-core", "admin-theme"]
    },
    ImageAdmin: {
      allowed: ["images", "admin-theme"],
      required: ["images"]
    },
    Uploader: {
      allowed: ["upload", "image-workflow", "image-detail"],
      required: ["upload", "image-workflow", "image-detail"]
    },
    ImageEditor: {
      allowed: ["image-editor", "image-workflow", "admin-theme"],
      required: ["image-editor", "image-workflow", "admin-theme"]
    }
  }
} as const;
