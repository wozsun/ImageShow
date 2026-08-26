import { lazy, Suspense, useLayoutEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import type {
  AdminPreferences,
  AdminRole
} from "@imageshow/shared/browser";
import { AdminIcon } from "../../../components/icon/AdminIcon.js";
import { OverlayScrollbar } from "../../../components/layout/OverlayScrollbar.js";
import { MobileNavigation } from "../../../components/navigation/MobileNavigation.js";
import { RouteLoadBoundary } from "../../../components/feedback/RouteLoadBoundary.js";
import { ActionFeedbackProvider } from "../../../components/feedback/ActionFeedbackRegion.js";
import { adminBasePath } from "../../../lib/constants.js";
import {
  AdminPreferencesProvider,
  useAdminPreference
} from "../../../hooks/useAdminPreferences.js";
import { useAdminColorScheme } from "../../../hooks/useAdminColorScheme.js";
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
  adminNavigationForRole
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
  adminRouteModuleLoaders.site().then((module) => ({
    default: module.SettingsPage
  }))
);
const AdvancedConfigPage = lazy(() =>
  adminRouteModuleLoaders.advancedConfig().then((module) => ({
    default: module.AdvancedConfigPage
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
  username: string;
  serverPreferences: AdminPreferences;
  serverPreferencesEtag: string;
  serverPreferencesUpdatedAt: number;
  siteName: string;
  applicationVersion: string;
  versionEnabled: boolean;
  versionLinkEnabled: boolean;
  onLogout: () => Promise<void>;
};

function AuthenticatedAdminLayout({
  role,
  siteName,
  applicationVersion,
  versionEnabled,
  versionLinkEnabled,
  onLogout
}: Omit<
  AuthenticatedAdminShellProps,
  | "username"
  | "serverPreferences"
  | "serverPreferencesEtag"
  | "serverPreferencesUpdatedAt"
>) {
  const routeLocation = useLocation();
  const navScrollRef = useRef<HTMLDivElement | null>(null);
  const [colorScheme, setColorScheme] = useAdminPreference("color_scheme");
  const [colorSchemeCycle, setColorSchemeCycle] =
    useState<AdminColorSchemeCycle | null>(null);
  const isSuper = role === "super";
  const navigation = adminNavigationForRole(role);

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
          siteName={siteName}
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
          <AdminIcon name="logout-box-r-line" />退出
        </button>
      </aside>
      <header className="admin-mobile-header">
        <AdminBrand
          siteName={siteName}
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
            <AdminIcon name="logout-box-r-line" />退出
          </button>
        </MobileNavigation>
      </header>
      <ActionFeedbackProvider>
        <RouteLoadBoundary resetKey={routeLocation.pathname}>
          <Suspense fallback={<div className="center">加载中</div>}>
            <Routes>
              <Route index element={<Overview canManageStorage={isSuper} />} />
              <Route path="images" element={<ImageAdmin />} />
              <Route path="tags" element={<VocabularyAdmin key="tags" kind="tags" />} />
              <Route path="themes" element={<VocabularyAdmin key="themes" kind="themes" />} />
              <Route path="authors" element={<VocabularyAdmin key="authors" kind="authors" />} />
              <Route path="account" element={<AccountSettings />} />
              {isSuper && <Route path="site" element={<SettingsPage />} />}
              {isSuper && <Route path="advanced-config" element={<AdvancedConfigPage />} />}
              {isSuper && <Route path="storage" element={<StorageSettings />} />}
              {isSuper && <Route path="users" element={<UserAdmin />} />}
              <Route path="check" element={<CheckPage />} />
              {isSuper && <Route path="logs" element={<LogPage />} />}
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
