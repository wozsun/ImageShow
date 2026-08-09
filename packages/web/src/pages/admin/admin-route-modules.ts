import {
  createPageLifetimeModuleLoader
} from "../../lib/page-lifetime-module-loader.js";

// React.lazy 与导航意图共用同一组页面生命周期加载器：预加载只获取模块及其
// 静态 CSS / 依赖，不挂载页面，也不会触发页面查询。
export const adminRouteModuleLoaders = {
  overview: createPageLifetimeModuleLoader(() => import("./Overview.js")),
  images: createPageLifetimeModuleLoader(() => import("./ImageAdmin.js")),
  entities: createPageLifetimeModuleLoader(() => import("./EntityAdmin.js")),
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

export function preloadAdminRouteModule(moduleKey: AdminRouteModuleKey) {
  void adminRouteModuleLoaders[moduleKey]().catch(() => undefined);
}
