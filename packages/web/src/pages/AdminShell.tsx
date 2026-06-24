import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { api, clearCsrfToken, setCsrfToken } from "../lib/api.js";
import { Icon } from "../components/Icon.js";
import { adminApiBasePath, adminBasePath, defaultSite, queryKeys } from "../lib/constants.js";
import type { AuthState, SiteConfig } from "../lib/types.js";
import { CheckPage } from "./admin/CheckPage.js";
import { ImageAdmin } from "./admin/ImageAdmin.js";
import { Overview } from "./admin/Overview.js";
import { SettingsPage } from "./admin/SettingsPage.js";
import { MobileNavigation } from "../components/MobileNavigation.js";

export function AdminShell() {
  const navigate = useNavigate();
  const { data: siteConfig } = useQuery<SiteConfig>({ queryKey: queryKeys.siteConfig, queryFn: () => api("/api/site-config") });
  const siteName = siteConfig?.site?.name ?? defaultSite.name;
  const { data, refetch } = useQuery<AuthState>({
    queryKey: queryKeys.me,
    queryFn: () => api(`${adminApiBasePath}/auth/me`)
  });
  useEffect(() => { if (data?.csrf_token) setCsrfToken(data.csrf_token); }, [data]);
  if (!data) return <div className="center">加载中</div>;
  if (!data.authenticated) return <Login onLogin={() => refetch()} />;
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
        <NavLink className={({ isActive }) => `home-link${isActive ? " active" : ""}`} to="/home"><Icon name="home-4-line" />首页</NavLink>
        <div className="admin-nav-divider" role="separator" />
        <NavLink className={({ isActive }) => isActive ? "active" : ""} end to={adminBasePath}><Icon name="dashboard-line" />概览</NavLink>
        <NavLink className={({ isActive }) => isActive ? "active" : ""} to={`${adminBasePath}/images`}><Icon name="image-line" />图片</NavLink>
        <NavLink className={({ isActive }) => isActive ? "active" : ""} to={`${adminBasePath}/settings`}><Icon name="settings-3-line" />设置</NavLink>
        <NavLink className={({ isActive }) => isActive ? "active" : ""} to={`${adminBasePath}/check`}><Icon name="checkbox-circle-line" />检查</NavLink>
        <div className="admin-nav-divider logout-divider" role="separator" />
        <button className="logout-button" type="button" onClick={logout}><Icon name="logout-box-r-line" />退出</button>
      </aside>
      <header className="admin-mobile-header">
        <Link className="brand" to={adminBasePath}>{siteName}</Link>
        <MobileNavigation className="admin-mobile-navigation">
          <NavLink className={({ isActive }) => isActive ? "active" : ""} to="/home"><Icon name="home-4-line" />首页</NavLink>
          <div className="admin-nav-divider" role="separator" />
          <NavLink className={({ isActive }) => isActive ? "active" : ""} end to={adminBasePath}><Icon name="dashboard-line" />概览</NavLink>
          <NavLink className={({ isActive }) => isActive ? "active" : ""} to={`${adminBasePath}/images`}><Icon name="image-line" />图片</NavLink>
          <NavLink className={({ isActive }) => isActive ? "active" : ""} to={`${adminBasePath}/settings`}><Icon name="settings-3-line" />设置</NavLink>
          <NavLink className={({ isActive }) => isActive ? "active" : ""} to={`${adminBasePath}/check`}><Icon name="checkbox-circle-line" />检查</NavLink>
          <div className="admin-nav-divider" role="separator" />
          <button type="button" onClick={logout}><Icon name="logout-box-r-line" />退出</button>
        </MobileNavigation>
      </header>
      <Routes>
        <Route index element={<Overview />} />
        <Route path="images" element={<ImageAdmin />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="check" element={<CheckPage />} />
      </Routes>
    </main>
  );
}

function Login({ onLogin }: { onLogin: () => void }) {
  const { data: siteConfig } = useQuery<SiteConfig>({ queryKey: queryKeys.siteConfig, queryFn: () => api("/api/site-config") });
  const siteName = siteConfig?.site?.name ?? defaultSite.name;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  return (
    <main className="login">
      <form onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        try {
          const res = await api<{ csrf_token: string }>(`${adminApiBasePath}/auth/login`, { method: "POST", body: JSON.stringify({ username, password }) });
          setCsrfToken(res.csrf_token);
          onLogin();
        } catch (err) { setError((err as Error).message); }
      }}>
        <a className="login-site-title" href="/"><h1>{siteName}</h1></a>
        <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="管理员用户名" />
        <input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密码" type="password" />
        {error && <p className="error">{error}</p>}
        <button className="button">登录</button>
      </form>
    </main>
  );
}
