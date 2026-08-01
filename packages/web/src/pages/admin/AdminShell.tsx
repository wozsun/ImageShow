import { lazy, Suspense, useLayoutEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  defaultAdminPreferences,
  type AdminRole
} from "@imageshow/shared/browser";
import { api, clearCsrfToken } from "../../lib/api/client.js";
import { Icon } from "../../components/icon/Icon.js";
import { OverlayScrollbar } from "../../components/layout/OverlayScrollbar.js";
import { adminApiBasePath, adminBasePath } from "../../lib/constants.js";
import { clearSessionProbeHint, useAuthMe, useSiteConfig } from "../../lib/api/site-data.js";
import { clearAdminCacheAfterLogin } from "../../lib/api/query-invalidation.js";
import { MobileNavigation } from "../../components/navigation/MobileNavigation.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import { RouteLoadBoundary } from "../../components/feedback/RouteLoadBoundary.js";
import { AppLoadingScreen } from "../../components/feedback/AppLoadingScreen.js";
import { ActionFeedbackProvider } from "../../components/feedback/ActionFeedbackRegion.js";
import { AdminLogin } from "./AdminLogin.js";
import {
  AdminNavigationLinks,
  AdminSiteNavigation,
  adminNavigationForRole
} from "./AdminNavigation.js";
import { AdminBrand } from "./AdminBrand.js";
import {
  AdminPreferencesProvider,
  useAdminPreference
} from "../../hooks/useAdminPreferences.js";
import { useAdminColorScheme } from "../../hooks/useAdminColorScheme.js";
import {
  nextAdminColorScheme,
  reconcileSystemNextAfter
} from "../../lib/ui/color-scheme.js";
// 后台颜色契约与组件样式都随 AdminShell 懒加载，公开入口不会下载。
import "../../styles/admin/semantic-colors.css";
import "../../styles/admin.css";

const Overview = lazy(() => import("./Overview.js").then((module) => ({
  default: module.Overview
})));
const ImageAdmin = lazy(() => {
  // 后台详情默认展开；与图片页并行预载管理信息，避免首次开卡时再插入整块内容。
  // 公共详情仍保留自身的按需 import，不会因此加载后台管理模块。
  const adminDetailsReady = import("../../components/image/ImageAdminDetails.js");
  return import("./ImageAdmin.js").then(async (module) => {
    await adminDetailsReady;
    return { default: module.ImageAdmin };
  });
});
const EntityAdmin = lazy(() => import("./EntityAdmin.js").then((module) => ({
  default: module.EntityAdmin
})));
const AccountSettings = lazy(() => import("./AccountSettings.js").then((module) => ({
  default: module.AccountSettings
})));
const SettingsPage = lazy(() => import("./SettingsPage.js").then((module) => ({
  default: module.SettingsPage
})));
const AdvancedConfigPage = lazy(() => import("./AdvancedConfigPage.js").then((module) => ({
  default: module.AdvancedConfigPage
})));
const StorageSettings = lazy(() => import("./StorageSettings.js").then((module) => ({
  default: module.StorageSettings
})));
const UserAdmin = lazy(() => import("./UserAdmin.js").then((module) => ({
  default: module.UserAdmin
})));
const CheckPage = lazy(() => import("./CheckPage.js").then((module) => ({
  default: module.CheckPage
})));
const LogPage = lazy(() => import("./LogPage.js").then((module) => ({
  default: module.LogPage
})));

function AuthenticatedAdminShell({
  role,
  siteName,
  applicationVersion,
  versionEnabled,
  versionLinkEnabled,
  onLogout
}: {
  role: AdminRole;
  siteName: string;
  applicationVersion: string;
  versionEnabled: boolean;
  versionLinkEnabled: boolean;
  onLogout: () => Promise<void>;
}) {
  const routeLocation = useLocation();
  const navScrollRef = useRef<HTMLDivElement | null>(null);
  const [colorScheme, setColorScheme] = useAdminPreference("color_scheme");
  const [systemNextAfter, setSystemNextAfter] = useState<"dark" | "light" | null>(null);
  const isSuper = role === "super";
  const navigation = adminNavigationForRole(role);

  const resolvedColorScheme = useAdminColorScheme(colorScheme);
  useLayoutEffect(() => {
    setSystemNextAfter((current) => reconcileSystemNextAfter(
      colorScheme,
      current
    ));
  }, [colorScheme]);
  const nextColorScheme = nextAdminColorScheme(
    resolvedColorScheme,
    systemNextAfter === colorScheme
  );
  const handleColorSchemeChange = (next: typeof colorScheme) => {
    setSystemNextAfter(next === "system" ? null : next);
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
          <Icon name="logout-box-r-line" />退出
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
            <Icon name="logout-box-r-line" />退出
          </button>
        </MobileNavigation>
      </header>
      <ActionFeedbackProvider>
        <RouteLoadBoundary resetKey={routeLocation.pathname}>
          <Suspense fallback={<div className="center">加载中</div>}>
            <Routes>
              <Route index element={<Overview />} />
              <Route path="images" element={<ImageAdmin />} />
              <Route path="tags" element={<EntityAdmin key="tags" kind="tags" />} />
              <Route path="themes" element={<EntityAdmin key="themes" kind="themes" />} />
              <Route path="authors" element={<EntityAdmin key="authors" kind="authors" />} />
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

export function AdminShell() {
  const navigate = useNavigate();
  const client = useQueryClient();

  const { data: siteConfig } = useSiteConfig();
  const siteName = siteConfig?.site?.name || "ImageShow";

  const {
    data,
    dataUpdatedAt,
    error: authError,
    isError: authFailed,
    refetch
  } = useAuthMe();
  const unauthenticatedAppearanceReady =
    authFailed || Boolean(data && !data.authenticated);
  useAdminColorScheme(
    defaultAdminPreferences.color_scheme,
    unauthenticatedAppearanceReady
  );
  if (authFailed) return <QueryErrorState error={authError} onRetry={() => void refetch()} fullPage />;
  if (!data) return <AppLoadingScreen />;
  if (!data.authenticated) return (
    <AdminLogin
      siteName={siteName}
      onLogin={async () => {
        // 先同步移除可能跨登录复用的后台缓存，再重新读取认证状态。移除操作
        // 不主动取数；认证完成后由真正挂载的后台路由按需读取，避免显示旧会话数据。
        clearAdminCacheAfterLogin(client);
        const result = await refetch({ throwOnError: true });
        if (!result.data?.authenticated) {
          throw new Error("登录状态确认失败，请重试");
        }
      }}
      altchaEnabled={data.altcha_enabled}
      loginBackground={data.login_background}
    />
  );
  const role = data.role === "super" ? "super" : "image";
  const logout = async () => {
    try {
      await api(`${adminApiBasePath}/auth/logout`, { method: "POST" });
    } finally {
      clearCsrfToken();
      clearSessionProbeHint();
      navigate(adminBasePath);
      location.reload();
    }
  };
  const versionEnabled = data.version_settings.enabled;
  const versionLinkEnabled = data.version_settings.link_enabled;
  return (
    <AdminPreferencesProvider
      key={data.username}
      username={data.username}
      serverPreferences={data.preferences}
      serverPreferencesUpdatedAt={dataUpdatedAt}
    >
      <AuthenticatedAdminShell
        role={role}
        siteName={siteName}
        applicationVersion={data.application_version}
        versionEnabled={versionEnabled}
        versionLinkEnabled={versionLinkEnabled}
        onLogout={logout}
      />
    </AdminPreferencesProvider>
  );
}
