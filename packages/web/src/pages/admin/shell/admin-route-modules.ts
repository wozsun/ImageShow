import { matchPath } from "react-router";
import {
  adminBasePath,
  adminPermissions,
  type AdminPermission
} from "@imageshow/shared/browser";
import { createPageLifetimeModuleLoader } from "../../../lib/page-lifetime-module-loader.js";

// 路由页面、导航意图与首屏共用同一组页面生命周期加载器：预加载只获取模块及其
// 静态 CSS / 依赖，不挂载页面，也不会触发页面查询。
export const adminRouteModuleLoaders = {
  overview: createPageLifetimeModuleLoader(() => import("../overview/Overview.js")),
  images: createPageLifetimeModuleLoader(() => import("../images/ImageAdmin.js")),
  groupDetail: createPageLifetimeModuleLoader(() => import("../groups/GroupDetail.js")),
  groups: createPageLifetimeModuleLoader(() => import("../groups/GroupAdmin.js")),
  vocabulary: createPageLifetimeModuleLoader(() => import("../vocabulary/VocabularyAdmin.js")),
  account: createPageLifetimeModuleLoader(() => import(/* @chunk visits: rare */ "../account/AccountSettings.js")),
  settings: createPageLifetimeModuleLoader(() => import(/* @chunk access: super */ "../settings/SettingsPage.js")),
  storage: createPageLifetimeModuleLoader(() => import(/* @chunk access: super */ "../storage/StorageSettings.js")),
  users: createPageLifetimeModuleLoader(() => import(/* @chunk access: super */ "../users/UserAdmin.js")),
  check: createPageLifetimeModuleLoader(() => import(/* @chunk visits: occasional */ "../check/CheckPage.js")),
  logs: createPageLifetimeModuleLoader(() => import(/* @chunk access: super, visits: rare */ "../logs/LogPage.js"))
} as const;

export type AdminRouteModuleKey = keyof typeof adminRouteModuleLoaders;

// 工作区页面：相对后台根的地址、页面模块与所需权限。路由注册与首屏加载共用此表，
// 无权或未列出的地址回到后台根的概览。需要超级管理员权限的页面同时在上方 import 处
// 声明 `@chunk access: super`：此处的权限只管路由，分块按声明划分权限层。
const adminRoutes = [
  { path: "", module: "overview" },
  { path: "overview", module: "overview" },
  { path: "images", module: "images" },
  { path: "groups/:slug", module: "groupDetail" },
  { path: "groups", module: "groups" },
  { path: "tags", module: "vocabulary" },
  { path: "themes", module: "vocabulary" },
  { path: "authors", module: "vocabulary" },
  { path: "account", module: "account" },
  { path: "settings", module: "settings", permission: adminPermissions.settingsManage },
  { path: "storage", module: "storage", permission: adminPermissions.storageManage },
  { path: "users", module: "users", permission: adminPermissions.usersManage },
  { path: "check", module: "check" },
  { path: "logs", module: "logs", permission: adminPermissions.logsManage }
] as const satisfies readonly {
  path: string;
  module: AdminRouteModuleKey;
  permission?: AdminPermission;
}[];

export type AdminRoute = (typeof adminRoutes)[number];

export function adminRoutesFor(permissions: readonly AdminPermission[]) {
  return adminRoutes.filter((route) =>
    !("permission" in route) || permissions.includes(route.permission)
  );
}

/** 加载该地址打开的页面，供首屏在渲染前取得。 */
export function loadAdminRouteModule(
  pathname: string,
  permissions: readonly AdminPermission[]
): Promise<unknown> {
  const route = adminRoutesFor(permissions).find((candidate) =>
    matchPath(`${adminBasePath}/${candidate.path}`, pathname)
  );
  return adminRouteModuleLoaders[route?.module ?? "overview"]();
}

export function preloadAdminRouteModule(moduleKey: AdminRouteModuleKey) {
  void adminRouteModuleLoaders[moduleKey]().catch(() => undefined);
}
