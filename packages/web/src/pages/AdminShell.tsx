import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { api, clearCsrfToken, setCsrfToken } from "../lib/api/client.js";
import { Icon } from "../components/icon/Icon.js";
import { NavGroup } from "../components/navigation/NavGroup.js";
import { PasswordInput } from "../components/form/PasswordInput.js";
import { OverlayScrollbar } from "../components/layout/OverlayScrollbar.js";
import { adminApiBasePath, adminBasePath, defaultSite } from "../lib/constants.js";
import { clearSessionProbeHint, rememberSessionProbeHint, useAuthMe, useSiteConfig } from "../lib/api/site-data.js";
import { cssUrl } from "../lib/ui/formatters.js";
import { CheckPage } from "./admin/CheckPage.js";
import { ImageAdmin } from "./admin/ImageAdmin.js";
import { EntityAdmin } from "./admin/EntityAdmin.js";
import { UserAdmin } from "./admin/UserAdmin.js";
import { Overview } from "./admin/Overview.js";
import { SettingsPage } from "./admin/SettingsPage.js";
import { StorageSettings } from "./admin/StorageSettings.js";
import { AccountSettings } from "./admin/AccountSettings.js";
import { LogPage } from "./admin/LogPage.js";
import { MobileNavigation } from "../components/navigation/MobileNavigation.js";
// 后台样式在此引入（而非全局 styles.css），随 AdminShell 懒加载分块下载，公共页不会加载。
import "../styles/admin.css";

export function AdminShell() {
  const navigate = useNavigate();

  const navScrollRef = useRef<HTMLDivElement | null>(null);
  const { data: siteConfig } = useSiteConfig();
  const siteName = siteConfig?.site?.name ?? defaultSite.name;

  const viewSite = { to: "/", icon: "home-4-line", label: "首页" } as const;
  const { data, refetch } = useAuthMe();
  useEffect(() => {
    if (!data) return;
    if (data.authenticated) {
      if (data.csrf_token) setCsrfToken(data.csrf_token);
      rememberSessionProbeHint();
    } else {
      clearSessionProbeHint();
    }
  }, [data]);
  if (!data) return <div className="center">加载中</div>;
  if (!data.authenticated) return <Login onLogin={() => refetch()} captchaEnabled={data.captcha_enabled} loginBackground={data.login_background} />;
  const isSuper = data.role === "super";
  const logout = async () => {
    await api(`${adminApiBasePath}/auth/logout`, { method: "POST" });
    clearCsrfToken();
    clearSessionProbeHint();
    navigate(adminBasePath);
    location.reload();
  };
  return (
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
          <NavGroup
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
            <NavGroup
              icon="settings-3-line"
              label="设置"
              items={[
                { to: `${adminBasePath}/site`, label: "站点配置" },
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
        {isSuper && <Route path="storage" element={<StorageSettings />} />}
        {isSuper && <Route path="users" element={<UserAdmin />} />}
        {isSuper && <Route path="check" element={<CheckPage />} />}
        {isSuper && <Route path="logs" element={<LogPage />} />}
      </Routes>
    </main>
  );
}

function Login({ onLogin, captchaEnabled, loginBackground }: { onLogin: () => void; captchaEnabled: boolean; loginBackground: string }) {
  const { data: siteConfig } = useSiteConfig();
  const siteName = siteConfig?.site?.name ?? defaultSite.name;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [captcha, setCaptcha] = useState("");

  const [captchaNonce, setCaptchaNonce] = useState(() => Date.now());
  const [error, setError] = useState("");
  const refreshCaptcha = () => { setCaptcha(""); setCaptchaNonce(Date.now()); };

  const background = loginBackground || "/random?m=redirect";
  return (
    <main
      className="login"
      style={{ backgroundImage: `linear-gradient(rgba(12, 18, 28, .45), rgba(12, 18, 28, .72)), ${cssUrl(background)}` }}
    >
      <form onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        try {
          const res = await api<{ csrf_token: string }>(`${adminApiBasePath}/auth/login`, { method: "POST", body: JSON.stringify({ username, password, ...(captchaEnabled ? { captcha } : {}) }) });
          setCsrfToken(res.csrf_token);
          rememberSessionProbeHint();
          onLogin();
        } catch (err) {
          setError((err as Error).message);
          if (captchaEnabled) refreshCaptcha();
        }
      }}>
        <a className="login-site-title" href="/"><h1>{siteName}</h1></a>
        <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="用户名" />
        <PasswordInput value={password} onChange={setPassword} placeholder="密码" autoComplete="current-password" />
        {captchaEnabled && (
          <div className="login-captcha">
            <input
              value={captcha}
              onChange={(event) => setCaptcha(event.target.value)}
              placeholder="验证码"
              autoComplete="off"
            />
            <img
              src={`${adminApiBasePath}/auth/captcha?n=${captchaNonce}`}
              alt="验证码"
              title="点击刷新验证码"
              onClick={refreshCaptcha}
            />
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <button className="button">登录</button>
      </form>
    </main>
  );
}
