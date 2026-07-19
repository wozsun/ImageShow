import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { AltchaWidgetElement } from "altcha";
import { Link, Navigate, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, clearCsrfToken, setCsrfToken } from "../../lib/api/client.js";
import { Icon } from "../../components/icon/Icon.js";
import { PasswordInput } from "../../components/form/PasswordInput.js";
import { OverlayScrollbar } from "../../components/layout/OverlayScrollbar.js";
import { adminApiBasePath, adminBasePath } from "../../lib/constants.js";
import { clearSessionProbeHint, rememberSessionProbeHint, useAuthMe, useSiteConfig } from "../../lib/api/site-data.js";
import { clearAdminCacheAfterLogin } from "../../lib/api/query-invalidation.js";
import { cssUrl } from "../../lib/ui/formatters.js";
import { MobileNavigation } from "../../components/navigation/MobileNavigation.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import { AdminNavGroup } from "./AdminNavGroup.js";
import { CheckPage } from "./CheckPage.js";
import { ImageAdmin } from "./ImageAdmin.js";
import { EntityAdmin } from "./EntityAdmin.js";
import { UserAdmin } from "./UserAdmin.js";
import { Overview } from "./Overview.js";
import { SettingsPage } from "./SettingsPage.js";
import { StorageSettings } from "./StorageSettings.js";
import { AccountSettings } from "./AccountSettings.js";
import { LogPage } from "./LogPage.js";
import { LoginChallenge } from "./LoginChallenge.js";
import { AdminPreferencesProvider } from "../../hooks/useAdminPreferences.js";
// 后台样式在此引入（而非全局 styles.css），随 AdminShell 懒加载分块下载，公共页不会加载。
import "../../styles/admin.css";

const AdvancedConfigPage = lazy(() => import("./AdvancedConfigPage.js").then((module) => ({
  default: module.AdvancedConfigPage
})));

export function AdminShell() {
  const navigate = useNavigate();
  const client = useQueryClient();

  const navScrollRef = useRef<HTMLDivElement | null>(null);
  const { data: siteConfig } = useSiteConfig();
  const siteName = siteConfig?.site?.name || "ImageShow";

  const viewSite = { to: "/", icon: "home-4-line", label: "首页" } as const;
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
    <Login
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
  const isSuper = data.role === "super";
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
        <Link className="brand" to={adminBasePath}>{siteName}</Link>
        <NavLink className={({ isActive }) => `home-link${isActive ? " active" : ""}`} to={viewSite.to}>
          <Icon name={viewSite.icon} />{viewSite.label}
        </NavLink>
        <div className="admin-nav-divider" role="separator" />
        <div className="admin-nav-scroll" ref={navScrollRef}>
          <NavLink className={({ isActive }) => isActive ? "active" : ""} end to={adminBasePath}>
            <Icon name="dashboard-line" />概览
          </NavLink>
          <AdminNavGroup
            icon="image-line"
            label="图片"
            items={[
              { to: `${adminBasePath}/images`, label: "图片列表", end: true },
              { to: `${adminBasePath}/themes`, label: "主题管理" },
              { to: `${adminBasePath}/tags`, label: "标签管理" },
              { to: `${adminBasePath}/authors`, label: "作者管理" }
            ]}
          />
          {isSuper && (
            <AdminNavGroup
              icon="settings-3-line"
              label="设置"
              items={[
                { to: `${adminBasePath}/site`, label: "站点配置" },
                { to: `${adminBasePath}/advanced-config`, label: "高级配置" },
                { to: `${adminBasePath}/storage`, label: "存储管理" },
                { to: `${adminBasePath}/users`, label: "用户管理" }
              ]}
            />
          )}
          {isSuper && (
            <NavLink className={({ isActive }) => isActive ? "active" : ""} to={`${adminBasePath}/check`}>
              <Icon name="checkbox-circle-line" />检查
            </NavLink>
          )}
          {isSuper && (
            <NavLink className={({ isActive }) => isActive ? "active" : ""} to={`${adminBasePath}/logs`}>
              <Icon name="history-line" />日志
            </NavLink>
          )}
        </div>
        <OverlayScrollbar targetRef={navScrollRef} />
        <div className="admin-nav-divider logout-divider" role="separator" />
        <NavLink className={({ isActive }) => isActive ? "active" : ""} to={`${adminBasePath}/account`}>
          <Icon name="key-2-line" />账户
        </NavLink>
        <button className="logout-button" type="button" onClick={logout}>
          <Icon name="logout-box-r-line" />退出
        </button>
      </aside>
      <header className="admin-mobile-header">
        <Link className="brand" to={adminBasePath}>{siteName}</Link>
        <MobileNavigation className="admin-mobile-navigation">
          <NavLink className={({ isActive }) => isActive ? "active" : ""} to={viewSite.to}>
            <Icon name={viewSite.icon} />{viewSite.label}
          </NavLink>
          <div className="admin-nav-divider" role="separator" />
          <NavLink className={({ isActive }) => isActive ? "active" : ""} end to={adminBasePath}>
            <Icon name="dashboard-line" />概览
          </NavLink>
          <NavLink className={({ isActive }) => isActive ? "active" : ""} end to={`${adminBasePath}/images`}>
            <Icon name="image-line" />图片列表
          </NavLink>
          <NavLink className={({ isActive }) => isActive ? "active" : ""} to={`${adminBasePath}/themes`}>
            <Icon name="palette-line" />主题管理
          </NavLink>
          <NavLink className={({ isActive }) => isActive ? "active" : ""} to={`${adminBasePath}/tags`}>
            <Icon name="price-tag-3-line" />标签管理
          </NavLink>
          <NavLink className={({ isActive }) => isActive ? "active" : ""} to={`${adminBasePath}/authors`}>
            <Icon name="quill-pen-line" />作者管理
          </NavLink>
          {isSuper && (
            <NavLink className={({ isActive }) => isActive ? "active" : ""} to={`${adminBasePath}/site`}>
              <Icon name="settings-3-line" />站点配置
            </NavLink>
          )}
          {isSuper && (
            <NavLink className={({ isActive }) => isActive ? "active" : ""} to={`${adminBasePath}/advanced-config`}>
              <Icon name="settings-3-line" />高级配置
            </NavLink>
          )}
          {isSuper && (
            <NavLink className={({ isActive }) => isActive ? "active" : ""} to={`${adminBasePath}/storage`}>
              <Icon name="hard-drive-2-line" />存储管理
            </NavLink>
          )}
          {isSuper && (
            <NavLink className={({ isActive }) => isActive ? "active" : ""} to={`${adminBasePath}/users`}>
              <Icon name="group-line" />用户管理
            </NavLink>
          )}
          {isSuper && (
            <NavLink className={({ isActive }) => isActive ? "active" : ""} to={`${adminBasePath}/check`}>
              <Icon name="checkbox-circle-line" />检查
            </NavLink>
          )}
          {isSuper && (
            <NavLink className={({ isActive }) => isActive ? "active" : ""} to={`${adminBasePath}/logs`}>
              <Icon name="history-line" />日志
            </NavLink>
          )}
          <div className="admin-nav-divider" role="separator" />
          <NavLink className={({ isActive }) => isActive ? "active" : ""} to={`${adminBasePath}/account`}>
            <Icon name="key-2-line" />账户
          </NavLink>
          <button type="button" onClick={logout}>
            <Icon name="logout-box-r-line" />退出
          </button>
        </MobileNavigation>
      </header>
      <Routes>
        <Route index element={<Overview />} />
        <Route path="images" element={<ImageAdmin />} />
        <Route path="tags" element={<EntityAdmin kind="tags" />} />
        <Route path="themes" element={<EntityAdmin kind="themes" />} />
        <Route path="authors" element={<EntityAdmin kind="authors" />} />
        <Route path="account" element={<AccountSettings />} />
        {isSuper && <Route path="site" element={<SettingsPage />} />}
        {isSuper && (
          <Route
            path="advanced-config"
            element={(
              <Suspense fallback={<div className="center">正在加载高级配置…</div>}>
                <AdvancedConfigPage />
              </Suspense>
            )}
          />
        )}
        {isSuper && <Route path="storage" element={<StorageSettings />} />}
        {isSuper && <Route path="users" element={<UserAdmin />} />}
        {isSuper && <Route path="check" element={<CheckPage />} />}
        {isSuper && <Route path="logs" element={<LogPage />} />}
        <Route path="*" element={<Navigate to={adminBasePath} replace />} />
      </Routes>
      </main>
    </AdminPreferencesProvider>
  );
}

function Login({
  onLogin,
  altchaEnabled,
  loginBackground
}: {
  onLogin: () => Promise<void>;
  altchaEnabled: boolean;
  loginBackground: string;
}) {
  const { data: siteConfig } = useSiteConfig();
  const siteName = siteConfig?.site?.name || "ImageShow";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [challengeLoaded, setChallengeLoaded] = useState(!altchaEnabled);
  const [challengeVerified, setChallengeVerified] = useState(!altchaEnabled);
  const [challengeLoadFailed, setChallengeLoadFailed] = useState(false);
  const [challengeInstance, setChallengeInstance] = useState(0);
  const challengeRef = useRef<AltchaWidgetElement | null>(null);
  const submissionActiveRef = useRef(false);
  const automaticChallengeRetryUsedRef = useRef(false);
  const markChallengeReady = useCallback(() => {
    setChallengeLoaded(true);
    setChallengeLoadFailed(false);
    automaticChallengeRetryUsedRef.current = false;
  }, []);
  const markChallengeError = useCallback(() => {
    setChallengeLoaded(false);
    setChallengeVerified(false);
    if (!automaticChallengeRetryUsedRef.current) {
      automaticChallengeRetryUsedRef.current = true;
      setChallengeInstance((current) => current + 1);
      return;
    }
    setChallengeLoadFailed(true);
  }, []);
  const retryChallenge = useCallback(() => {
    automaticChallengeRetryUsedRef.current = true;
    setChallengeLoadFailed(false);
    setChallengeLoaded(false);
    setChallengeVerified(false);
    setChallengeInstance((current) => current + 1);
  }, []);

  const background = loginBackground || "/random?m=redirect";
  const credentialsComplete = username.trim().length > 0 && password.length > 0;
  const buttonLabel = loggingIn
    ? "登录中…"
    : !challengeLoaded
      ? "加载验证…"
      : "登录";

  return (
    <main
      className="login"
      style={{ backgroundImage: `linear-gradient(rgba(12, 18, 28, .45), rgba(12, 18, 28, .72)), ${cssUrl(background)}` }}
    >
      <form onSubmit={async (event) => {
        event.preventDefault();
        if (submissionActiveRef.current || !credentialsComplete) return;
        let altcha: string | undefined;
        if (altchaEnabled) {
          const proof = new FormData(event.currentTarget).get("altcha");
          if (typeof proof !== "string" || proof.length === 0) return;
          altcha = proof;
        }

        submissionActiveRef.current = true;
        setError("");
        setLoggingIn(true);
        try {
          const res = await api<{ csrf_token: string }>(`${adminApiBasePath}/auth/login`, {
            method: "POST",
            body: JSON.stringify({ username, password, ...(altcha ? { altcha } : {}) })
          });
          setCsrfToken(res.csrf_token);
          rememberSessionProbeHint();
          await onLogin();
        } catch (err) {
          clearCsrfToken();
          clearSessionProbeHint();
          setError((err as Error).message);
          if (altchaEnabled) {
            setChallengeVerified(false);
            challengeRef.current?.reset();
          }
          submissionActiveRef.current = false;
          setLoggingIn(false);
        }
      }}>
        <a className="login-site-title" href="/"><h1>{siteName}</h1></a>
        <input
          name="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder="用户名"
          autoComplete="username"
        />
        <PasswordInput value={password} onChange={setPassword} placeholder="密码" autoComplete="current-password" />
        {altchaEnabled && (
          <LoginChallenge
            key={challengeInstance}
            ref={challengeRef}
            onError={markChallengeError}
            onReady={markChallengeReady}
            onVerificationChange={setChallengeVerified}
          />
        )}
        {challengeLoadFailed && (
          <button className="login-challenge-retry" type="button" onClick={retryChallenge}>
            安全验证加载失败，点击重试
          </button>
        )}
        {error && <p className="error">{error}</p>}
        <button
          id="admin-login-submit"
          className="button"
          disabled={!credentialsComplete || !challengeLoaded || !challengeVerified || loggingIn}
          type="submit"
        >
          {buttonLabel}
        </button>
      </form>
    </main>
  );
}
