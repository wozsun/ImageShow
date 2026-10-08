import { lazy, Suspense, useLayoutEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import {
  adminPermissions,
  type AdminPermission,
  type AdminPreferences,
  type AdminRole,
  adminBasePath
} from "@imageshow/shared/browser";
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
import { adminRouteModuleLoaders } from "./admin-route-modules.js";
import {
  AdminNavigationLinks,
  AdminSiteNavigation,
  adminNavigationForPermissions
} from "./AdminNavigation.js";
import { AdminBrand } from "./AdminBrand.js";
// 认证成功后才加载后台导航、布局与共享管理控件；登录页不会下载这一块。
import "../../../styles/admin/semantic-colors.css";
import "../../../styles/admin-core.css";

const Overview = lazy(() =>
  adminRouteModuleLoaders.overview().then((module) => ({
    default: module.Overview
  }))
);
const ImageAdmin = lazy(() =>
  adminRouteModuleLoaders.images().then((module) => ({
    default: module.ImageAdmin
  }))
);
const GroupDetail = lazy(() =>
  adminRouteModuleLoaders.groupDetail().then((module) => ({ default: module.GroupDetail }))
);
const GroupAdmin = lazy(() =>
  adminRouteModuleLoaders.groups().then((module) => ({ default: module.GroupAdmin }))
);
const VocabularyAdmin = lazy(() =>
  adminRouteModuleLoaders.vocabulary().then((module) => ({
    default: module.VocabularyAdmin
  }))
);
const AccountSettings = lazy(() =>
  adminRouteModuleLoaders.account().then((module) => ({
    default: module.AccountSettings
  }))
);
const SettingsPage = lazy(() =>
  adminRouteModuleLoaders.settings().then((module) => ({
    default: module.SettingsPage
  }))
);
const StorageSettings = lazy(() =>
  adminRouteModuleLoaders.storage().then((module) => ({
    default: module.StorageSettings
  }))
);
const UserAdmin = lazy(() =>
  adminRouteModuleLoaders.users().then((module) => ({
    default: module.UserAdmin
  }))
);
const CheckPage = lazy(() =>
  adminRouteModuleLoaders.check().then((module) => ({
    default: module.CheckPage
  }))
);
const LogPage = lazy(() =>
  adminRouteModuleLoaders.logs().then((module) => ({
    default: module.LogPage
  }))
);

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
  const canManageSettings = permissions.includes(adminPermissions.settingsManage);
  const canManageStorage = permissions.includes(adminPermissions.storageManage);
  const canManageUsers = permissions.includes(adminPermissions.usersManage);
  const canManageLogs = permissions.includes(adminPermissions.logsManage);
  const overviewPage = <Overview canManageStorage={canManageStorage} />;
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
              <Route index element={overviewPage} />
              <Route path="overview" element={overviewPage} />
              <Route path="images" element={<ImageAdmin />} />
              <Route path="groups/:slug" element={<GroupDetail />} />
            <Route path="groups" element={<GroupAdmin />} />
              <Route path="tags" element={<VocabularyAdmin key="tags" kind="tags" />} />
              <Route path="themes" element={<VocabularyAdmin key="themes" kind="themes" />} />
              <Route path="authors" element={<VocabularyAdmin key="authors" kind="authors" />} />
              <Route path="account" element={<AccountSettings />} />
              {canManageSettings && <Route path="settings" element={<SettingsPage />} />}
              {canManageStorage && <Route path="storage" element={<StorageSettings />} />}
              {canManageUsers && <Route path="users" element={<UserAdmin />} />}
              <Route path="check" element={<CheckPage />} />
              {canManageLogs && <Route path="logs" element={<LogPage />} />}
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
