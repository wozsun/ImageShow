import {
  createPageLifetimeModuleLoader
} from "../../lib/page-lifetime-module-loader.js";
import type {
  PreloadIntentPolicy
} from "../../lib/ui/preload-intent.js";

// React.lazy 与导航意图共用同一组页面生命周期加载器：预加载只获取模块及其
// 静态 CSS / 依赖，不挂载页面，也不会触发页面查询。
export const adminRouteModuleLoaders = {
  overview: createPageLifetimeModuleLoader(() => import("./Overview.js")),
  images: createPageLifetimeModuleLoader(() => import("./ImageAdmin.js")),
  vocabulary: createPageLifetimeModuleLoader(() => import("./VocabularyAdmin.js")),
  account: createPageLifetimeModuleLoader(() => import("./AccountSettings.js")),
  site: createPageLifetimeModuleLoader(() => import("./SettingsPage.js")),
  advancedConfig: createPageLifetimeModuleLoader(
    () => import("./AdvancedConfigPage.js")
  ),
  storage: createPageLifetimeModuleLoader(() => import("./StorageSettings.js")),
  users: createPageLifetimeModuleLoader(() => import("./UserAdmin.js")),
  check: createPageLifetimeModuleLoader(() => import("./CheckPage.js")),
  logs: createPageLifetimeModuleLoader(() => import("./LogPage.js"))
} as const;

export type AdminRouteModuleKey = keyof typeof adminRouteModuleLoaders;

const immediateRoutePreload = { hover: "immediate" } as const;

export const adminRoutePreloadPolicies = {
  overview: immediateRoutePreload,
  images: immediateRoutePreload,
  vocabulary: immediateRoutePreload,
  account: immediateRoutePreload,
  site: immediateRoutePreload,
  // 高级配置编辑器明显大于其他后台页；短暂划过不下载，150 ms 停留仍能
  // 在明确导航意图下提前获取模块。
  advancedConfig: { hover: "dwell", delayMs: 150 },
  storage: immediateRoutePreload,
  users: immediateRoutePreload,
  check: immediateRoutePreload,
  logs: immediateRoutePreload
} as const satisfies Record<AdminRouteModuleKey, PreloadIntentPolicy>;

export function preloadAdminRouteModule(moduleKey: AdminRouteModuleKey) {
  void adminRouteModuleLoaders[moduleKey]().catch(() => undefined);
}
