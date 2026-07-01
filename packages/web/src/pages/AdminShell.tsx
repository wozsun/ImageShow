import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { api, clearCsrfToken, setCsrfToken } from "../lib/api.js";
import { Icon } from "../components/Icon.js";
import { NavGroup } from "../components/NavGroup.js";
import { PasswordInput } from "../components/PasswordInput.js";
import { OverlayScrollbar } from "../components/OverlayScrollbar.js";
import { adminApiBasePath, adminBasePath, defaultSite } from "../lib/constants.js";
import { useAuthMe, useSiteConfig } from "../lib/site-data.js";
import { CheckPage } from "./admin/CheckPage.js";
import { ImageAdmin } from "./admin/ImageAdmin.js";
import { EntityAdmin } from "./admin/EntityAdmin.js";
import { UserAdmin } from "./admin/UserAdmin.js";
import { Overview } from "./admin/Overview.js";
import { SettingsPage } from "./admin/SettingsPage.js";
import { StorageSettings } from "./admin/StorageSettings.js";
import { AccountSettings } from "./admin/AccountSettings.js";
import { MobileNavigation } from "../components/MobileNavigation.js";
// 后台样式在此引入（而非全局 styles.css），随 AdminShell 懒加载分块下载，公共页不会加载。
import "../styles/admin.css";

export function AdminShell() {
  const navigate = useNavigate();
  // The middle nav band scrolls; drive it with the floating OverlayScrollbar (like the admin
  // content areas) so an appearing bar doesn't reserve gutter and shove the items left.
  const navScrollRef = useRef<HTMLDivElement | null>(null);
  const { data: siteConfig } = useSiteConfig();
  const siteName = siteConfig?.site?.name ?? defaultSite.name;
  // The "view public site" shortcut always points at the site root (/), which redirects to the
  // configured landing (root_redirect / home_enabled). Always labelled 首页 — no need to relabel
  // it 画廊 when the homepage is off, since / lands on the right page either way.
  const viewSite = { to: "/", icon: "home-4-line", label: "首页" } as const;
  const { data, refetch } = useAuthMe();
  useEffect(() => { if (data?.csrf_token) setCsrfToken(data.csrf_token); }, [data]);
  if (!data) return <div className="center">加载中</div>;
  if (!data.authenticated) return <Login onLogin={() => refetch()} />;
  const isSuper = data.role === "super";
  const logout = async () => {
    await api(`${adminApiBasePath}/auth/logout`, { method: "POST" });
    clearCsrfToken();
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
      </Routes>
    </main>
  );
}

function Login({ onLogin }: { onLogin: () => void }) {
  const { data: siteConfig } = useSiteConfig();
  const siteName = siteConfig?.site?.name ?? defaultSite.name;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [captcha, setCaptcha] = useState("");
  // Bumped to fetch a fresh captcha image (a new server-side code). The captcha is one-time,
  // so we also refresh it after every failed login.
  const [captchaNonce, setCaptchaNonce] = useState(() => Date.now());
  const [error, setError] = useState("");
  const refreshCaptcha = () => { setCaptcha(""); setCaptchaNonce(Date.now()); };
  // Captcha can be turned off site-wide (config.json captcha.enabled); default on until the
  // site config loads, so a fresh page never briefly drops the challenge.
  const captchaEnabled = siteConfig?.captcha?.enabled ?? true;
  // Effective URL comes from /api/site-config (default: the site's own random API).
  // Before it loads, fall back to the same-host random endpoint so there's no flash.
  const background = siteConfig?.site?.login_background || "/random?m=redirect";
  return (
    <main
      className="login"
      style={{ backgroundImage: `linear-gradient(rgba(12, 18, 28, .45), rgba(12, 18, 28, .72)), url("${background}")` }}
    >
      <form onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        try {
          const res = await api<{ csrf_token: string }>(`${adminApiBasePath}/auth/login`, { method: "POST", body: JSON.stringify({ username, password, ...(captchaEnabled ? { captcha } : {}) }) });
          setCsrfToken(res.csrf_token);
          onLogin();
        } catch (err) {
          setError((err as Error).message);
          if (captchaEnabled) refreshCaptcha(); // the one-time captcha is now spent — load a fresh one
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
