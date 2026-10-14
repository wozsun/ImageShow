import { Suspense, useLayoutEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import {
  adminPermissions,
  type AdminPermission,
  type AdminPreferences,
  type AdminRole,
  adminBasePath
} from "@imageshow/shared/browser";
import { moduleComponent } from "../../../lib/page-lifetime-module-loader.js";
import { AdminIcon } from "../../../components/icon/AdminIcon.js";
import { OverlayScrollbar } from "../../../components/layout/OverlayScrollbar.js";
import { MobileNavigation } from "../../../components/navigation/MobileNavigation.js";
import { RouteLoadBoundary } from "../../../components/feedback/RouteLoadBoundary.js";
import { ActionFeedbackProvider } from "../../../components/feedback/ActionFeedbackRegion.js";
import {
  AdminPreferencesProvider,
  useAdminPreference
} from "../../../hooks/useAdminPreferences.js";
import { useAdminColorScheme } from "./useAdminColorScheme.js";
import {
  advanceAdminColorSchemeCycle,
  nextAdminColorScheme,
  reconcileAdminColorSchemeCycle,
  type AdminColorSchemeCycle
} from "../../../lib/ui/color-scheme.js";
import {
  adminRouteModuleLoaders,
  adminRoutesFor,
  type AdminRoute
} from "./admin-route-modules.js";
import {
  AdminNavigationLinks,
  AdminSiteNavigation,
  adminNavigationForPermissions
} from "./AdminNavigation.js";
import { AdminBrand } from "./AdminBrand.js";
// 认证成功后才加载后台导航、布局与共享管理控件；登录页不会下载这一块。
import "../../../styles/admin/semantic-colors.css";
import "../../../styles/admin-core.css";

// 登录前外壳经工作区取得当前页面，页面表不进入登录页。
export { loadAdminRouteModule } from "./admin-route-modules.js";

const pages = adminRouteModuleLoaders;
const Overview = moduleComponent(pages.overview, (module) => module.Overview);
const ImageAdmin = moduleComponent(pages.images, (module) => module.ImageAdmin);
const GroupDetail = moduleComponent(pages.groupDetail, (module) => module.GroupDetail);
const GroupAdmin = moduleComponent(pages.groups, (module) => module.GroupAdmin);
const VocabularyAdmin = moduleComponent(pages.vocabulary, (module) => module.VocabularyAdmin);
const AccountSettings = moduleComponent(pages.account, (module) => module.AccountSettings);
const SettingsPage = moduleComponent(pages.settings, (module) => module.SettingsPage);
const StorageSettings = moduleComponent(pages.storage, (module) => module.StorageSettings);
const UserAdmin = moduleComponent(pages.users, (module) => module.UserAdmin);
const CheckPage = moduleComponent(pages.check, (module) => module.CheckPage);
const LogPage = moduleComponent(pages.logs, (module) => module.LogPage);

function adminPage(route: AdminRoute, canManageStorage: boolean) {
  switch (route.module) {
    case "overview":
      return <Overview canManageStorage={canManageStorage} />;
    case "images":
      return <ImageAdmin />;
    case "groupDetail":
      return <GroupDetail />;
    case "groups":
      return <GroupAdmin />;
    case "vocabulary":
      return <VocabularyAdmin key={route.path} kind={route.path} />;
    case "account":
      return <AccountSettings />;
    case "settings":
      return <SettingsPage />;
    case "storage":
      return <StorageSettings />;
    case "users":
      return <UserAdmin />;
    case "check":
      return <CheckPage />;
    case "logs":
      return <LogPage />;
  }
}

type AuthenticatedAdminShellProps = {
  role: AdminRole;
  permissions: readonly AdminPermission[];
  username: string;
  serverPreferences: AdminPreferences;
  serverPreferencesEtag: string;
  serverPreferencesUpdatedAt: number;
  siteHeaderName: string;
  applicationVersion: string;
  versionEnabled: boolean;
  versionLinkEnabled: boolean;
  onLogout: () => Promise<void>;
};

function AuthenticatedAdminLayout({
  role,
  permissions,
  siteHeaderName,
  applicationVersion,
  versionEnabled,
  versionLinkEnabled,
  onLogout
}: Omit<
  AuthenticatedAdminShellProps,
  "username" | "serverPreferences" | "serverPreferencesEtag" | "serverPreferencesUpdatedAt"
>) {
  const routeLocation = useLocation();
  const navScrollRef = useRef<HTMLDivElement | null>(null);
  const [colorScheme, setColorScheme] = useAdminPreference("color_scheme");
  const [colorSchemeCycle, setColorSchemeCycle] = useState<AdminColorSchemeCycle | null>(null);
  const canManageStorage = permissions.includes(adminPermissions.storageManage);
  const navigation = adminNavigationForPermissions(role, permissions);

  const resolvedColorScheme = useAdminColorScheme(colorScheme);
  useLayoutEffect(() => {
    setColorSchemeCycle((current) => reconcileAdminColorSchemeCycle(
      colorScheme,
      current
    ));
  }, [colorScheme]);
  const nextColorScheme = nextAdminColorScheme(
    colorScheme,
    resolvedColorScheme,
    colorSchemeCycle
  );
  const handleColorSchemeChange = (next: typeof colorScheme) => {
    setColorSchemeCycle(advanceAdminColorSchemeCycle(
      colorScheme,
      resolvedColorScheme,
      next
    ));
    setColorScheme(next);
  };

  return (
    <main className="admin">
      <aside>
        <AdminBrand
          siteHeaderName={siteHeaderName}
          applicationVersion={applicationVersion}
          versionEnabled={versionEnabled}
          versionLinkEnabled={versionLinkEnabled}
          to={adminBasePath}
        />
        <AdminSiteNavigation
          entries={navigation.site}
          variant="desktop"
          colorScheme={colorScheme}
          nextColorScheme={nextColorScheme}
          onColorSchemeChange={handleColorSchemeChange}
        />
        <div className="admin-nav-divider" role="separator" />
        <div className="admin-nav-scroll" ref={navScrollRef}>
          <AdminNavigationLinks entries={navigation.main} variant="desktop" />
        </div>
        <OverlayScrollbar targetRef={navScrollRef} />
        <div className="admin-nav-divider logout-divider" role="separator" />
        <AdminNavigationLinks entries={navigation.account} variant="desktop" />
        <button className="logout-button" type="button" onClick={() => void onLogout()}>
          <AdminIcon name="logout-box-r-line" />
          退出
        </button>
      </aside>
      <header className="admin-mobile-header">
        <AdminBrand
          siteHeaderName={siteHeaderName}
          applicationVersion={applicationVersion}
          versionEnabled={versionEnabled}
          versionLinkEnabled={versionLinkEnabled}
          to={adminBasePath}
        />
        <MobileNavigation className="admin-mobile-navigation">
          <AdminSiteNavigation
            entries={navigation.site}
            variant="mobile"
            colorScheme={colorScheme}
            nextColorScheme={nextColorScheme}
            onColorSchemeChange={handleColorSchemeChange}
          />
          <div className="admin-nav-divider" role="separator" />
          <AdminNavigationLinks entries={navigation.main} variant="mobile" />
          <div className="admin-nav-divider" role="separator" />
          <AdminNavigationLinks entries={navigation.account} variant="mobile" />
          <button type="button" onClick={() => void onLogout()}>
            <AdminIcon name="logout-box-r-line" />
            退出
          </button>
        </MobileNavigation>
      </header>
      <ActionFeedbackProvider>
        <RouteLoadBoundary resetKey={routeLocation.pathname}>
          <Suspense fallback={<div className="center">加载中</div>}>
            <Routes>
              {adminRoutesFor(permissions).map((route) => route.path ? (
                <Route
                  key={route.path}
                  path={route.path}
                  element={adminPage(route, canManageStorage)}
                />
              ) : (
                <Route key="index" index element={adminPage(route, canManageStorage)} />
              ))}
              <Route path="*" element={<Navigate to={adminBasePath} replace />} />
            </Routes>
          </Suspense>
        </RouteLoadBoundary>
      </ActionFeedbackProvider>
    </main>
  );
}

export function AuthenticatedAdminShell({
  username,
  serverPreferences,
  serverPreferencesEtag,
  serverPreferencesUpdatedAt,
  ...layoutProps
}: AuthenticatedAdminShellProps) {
  return (
    <AdminPreferencesProvider
      key={username}
      username={username}
      serverPreferences={serverPreferences}
      serverPreferencesEtag={serverPreferencesEtag}
      serverPreferencesUpdatedAt={serverPreferencesUpdatedAt}
    >
      <AuthenticatedAdminLayout {...layoutProps} />
    </AdminPreferencesProvider>
  );
}
