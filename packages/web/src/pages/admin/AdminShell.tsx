import { lazy, Suspense, useEffect, useRef } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, clearCsrfToken, setCsrfToken } from "../../lib/api/client.js";
import { Icon } from "../../components/icon/Icon.js";
import { OverlayScrollbar } from "../../components/layout/OverlayScrollbar.js";
import { adminApiBasePath, adminBasePath } from "../../lib/constants.js";
import { clearSessionProbeHint, rememberSessionProbeHint, useAuthMe, useSiteConfig } from "../../lib/api/site-data.js";
import { clearAdminCacheAfterLogin } from "../../lib/api/query-invalidation.js";
import { MobileNavigation } from "../../components/navigation/MobileNavigation.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import { RouteLoadBoundary } from "../../components/feedback/RouteLoadBoundary.js";
import { ActionFeedbackProvider } from "../../components/feedback/ActionFeedbackRegion.js";
import { AdminLogin } from "./AdminLogin.js";
import {
  AdminNavigationLinks,
  adminNavigationForRole
} from "./AdminNavigation.js";
import { AdminBrand } from "./AdminBrand.js";
import { AdminPreferencesProvider } from "../../hooks/useAdminPreferences.js";
// 后台样式在此引入（而非全局 styles.css），随 AdminShell 懒加载分块下载，公共页不会加载。
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

export function AdminShell() {
  const navigate = useNavigate();
  const routeLocation = useLocation();
  const client = useQueryClient();

  const navScrollRef = useRef<HTMLDivElement | null>(null);
  const { data: siteConfig } = useSiteConfig();
  const siteName = siteConfig?.site?.name || "ImageShow";
  const versionEnabled = siteConfig?.site?.version?.enabled ?? true;
  const versionLinkEnabled = siteConfig?.site?.version?.link_enabled ?? true;

  const { data, error: authError, isError: authFailed, refetch } = useAuthMe();
  useEffect(() => {
    if (!data) return;
    if (data.authenticated) {
      if (data.csrf_token) setCsrfToken(data.csrf_token);
      rememberSessionProbeHint();
    } else {
      clearSessionProbeHint();
    }
  }, [data]);
  if (authFailed) return <QueryErrorState error={authError} onRetry={() => void refetch()} fullPage />;
  if (!data) return <div className="center">加载中</div>;
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
  const isSuper = role === "super";
  const navigation = adminNavigationForRole(role);
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
  return (
    <AdminPreferencesProvider key={data.username} username={data.username}>
      <main className="admin">
      <aside>
        <AdminBrand
          siteName={siteName}
          applicationVersion={data.application_version}
          versionEnabled={versionEnabled}
          versionLinkEnabled={versionLinkEnabled}
          to={adminBasePath}
        />
        <AdminNavigationLinks entries={navigation.site} variant="desktop" />
        <div className="admin-nav-divider" role="separator" />
        <div className="admin-nav-scroll" ref={navScrollRef}>
          <AdminNavigationLinks entries={navigation.main} variant="desktop" />
        </div>
        <OverlayScrollbar targetRef={navScrollRef} />
        <div className="admin-nav-divider logout-divider" role="separator" />
        <AdminNavigationLinks entries={navigation.account} variant="desktop" />
        <button className="logout-button" type="button" onClick={logout}>
          <Icon name="logout-box-r-line" />退出
        </button>
      </aside>
      <header className="admin-mobile-header">
        <AdminBrand
          siteName={siteName}
          applicationVersion={data.application_version}
          versionEnabled={versionEnabled}
          versionLinkEnabled={versionLinkEnabled}
          to={adminBasePath}
        />
        <MobileNavigation className="admin-mobile-navigation">
          <AdminNavigationLinks entries={navigation.site} variant="mobile" />
          <div className="admin-nav-divider" role="separator" />
          <AdminNavigationLinks entries={navigation.main} variant="mobile" />
          <div className="admin-nav-divider" role="separator" />
          <AdminNavigationLinks entries={navigation.account} variant="mobile" />
          <button type="button" onClick={logout}>
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
              <Route path="tags" element={<EntityAdmin kind="tags" />} />
              <Route path="themes" element={<EntityAdmin kind="themes" />} />
              <Route path="authors" element={<EntityAdmin kind="authors" />} />
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
    </AdminPreferencesProvider>
  );
}
