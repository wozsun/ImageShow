import { useQuery } from "@tanstack/react-query";
import { Link, NavLink } from "react-router-dom";
import { api } from "../lib/api.js";
import { adminApiBasePath, adminBasePath, defaultSite, queryKeys } from "../lib/constants.js";
import type { AuthState, SiteConfig } from "../lib/types.js";
import { Icon } from "./Icon.js";
import { MobileNavigation } from "./MobileNavigation.js";

export function AppHeader() {
  const { data } = useQuery<SiteConfig>({ queryKey: queryKeys.siteConfig, queryFn: () => api("/api/site-config") });
  const { data: auth } = useQuery<AuthState>({ queryKey: queryKeys.me, queryFn: () => api(`${adminApiBasePath}/auth/me`) });
  const siteName = data?.site?.name ?? defaultSite.name;
  return (
    <header className="topbar">
      <Link className="brand" to="/home">{siteName}</Link>
      <nav className="desktop-nav">
        <NavLink to="/home"><Icon name="home-4-line" />首页</NavLink>
        <NavLink to="/gallery"><Icon name="image-line" />画廊</NavLink>
        {auth?.authenticated && <NavLink to={adminBasePath}><Icon name="settings-3-line" />管理</NavLink>}
      </nav>
      <MobileNavigation>
        <NavLink to="/home"><Icon name="home-4-line" />首页</NavLink>
        <NavLink to="/gallery"><Icon name="image-line" />画廊</NavLink>
        {auth?.authenticated && <NavLink to={adminBasePath}><Icon name="settings-3-line" />管理</NavLink>}
      </MobileNavigation>
    </header>
  );
}
