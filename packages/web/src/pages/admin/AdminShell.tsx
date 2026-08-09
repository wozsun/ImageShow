import { lazy, useLayoutEffect } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { api, clearCsrfToken } from "../../lib/api/client.js";
import { adminApiBasePath, adminBasePath } from "../../lib/constants.js";
import {
  clearSessionProbeHint
} from "../../lib/api/auth-session.js";
import { useSiteConfig } from "../../lib/api/site-data.js";
import { useAuthMe } from "../../hooks/useAuthSession.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import { AppLoadingScreen } from "../../components/feedback/AppLoadingScreen.js";
import { applyUiColorContext } from "../../lib/ui/apply-ui-color-context.js";

type AdminCacheModule = typeof import("../../lib/api/query-invalidation.js");

let adminCacheModulePromise: Promise<AdminCacheModule> | undefined;

function loadAdminCacheModule() {
  if (!adminCacheModulePromise) {
    // This helper has no CSS preload, so a transient JavaScript failure may be
    // retried in the same page. CSS-bearing capabilities use the page-lifetime
    // loader and require a full reload instead.
    adminCacheModulePromise = import("../../lib/api/query-invalidation.js")
      .catch((error: unknown) => {
        adminCacheModulePromise = undefined;
        throw error;
      });
  }
  return adminCacheModulePromise;
}

const AdminLogin = lazy(() => import("./AdminLogin.js").then((module) => ({
  default: module.AdminLogin
})));
const AuthenticatedAdminShell = lazy(() => (
  import("./AuthenticatedAdminShell.js").then((module) => ({
    default: module.AuthenticatedAdminShell
  }))
));

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
  useLayoutEffect(() => {
    if (unauthenticatedAppearanceReady) applyUiColorContext("public");
  }, [unauthenticatedAppearanceReady]);
  // 初次认证读取失败时没有可用界面；登录后的确认请求失败则仍保留旧的
  // unauthenticated 快照和 AdminLogin，由它提供不重复 POST 的安全恢复入口。
  if (authFailed && data?.authenticated !== false) {
    return (
      <QueryErrorState
        error={authError}
        onRetry={() => void refetch()}
        fullPage
      />
    );
  }
  if (!data) return <AppLoadingScreen />;
  if (!data.authenticated) {
    return (
      <AdminLogin
        siteName={siteName}
        onLogin={async () => {
          // 先同步移除可能跨登录复用的后台缓存，再重新读取认证状态。移除操作
          // 不主动取数；认证完成后由真正挂载的后台路由按需读取，避免显示旧会话数据。
          const { clearAdminCacheAfterLogin } = await loadAdminCacheModule();
          clearAdminCacheAfterLogin(client);
          const result = await refetch({ throwOnError: true });
          return Boolean(result.data?.authenticated);
        }}
        altchaEnabled={data.altcha_enabled}
        loginBackground={data.login_background}
      />
    );
  }
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
  return (
    <AuthenticatedAdminShell
      role={role}
      username={data.username}
      serverPreferences={data.preferences}
      serverPreferencesUpdatedAt={dataUpdatedAt}
      siteName={siteName}
      applicationVersion={data.application_version}
      versionEnabled={data.version_settings.enabled}
      versionLinkEnabled={data.version_settings.link_enabled}
      onLogout={logout}
    />
  );
}
