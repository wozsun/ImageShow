import { useEffect, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { adminBasePath, defaultSite, publicHomePath } from "../../lib/constants.js";
import { clearSessionProbeHint, hasSessionProbeHint, rememberSessionProbeHint, useAuthMe, useSiteConfig } from "../../lib/api/site-data.js";
import { Icon } from "../icon/Icon.js";
import { MobileNavigation } from "./MobileNavigation.js";

export function AppHeader() {
  const { data } = useSiteConfig();
  const [shouldProbeSession, setShouldProbeSession] = useState(hasSessionProbeHint);
  const { data: auth } = useAuthMe(shouldProbeSession);
  const siteName = data?.site?.name ?? defaultSite.name;

  const homeEnabled = data?.site?.home?.enabled ?? true;
  const homePath = publicHomePath(data?.site ?? defaultSite);
  const showAdminEntry = Boolean(auth?.authenticated);

  useEffect(() => {
    if (!auth) return;
    if (auth.authenticated) {
      rememberSessionProbeHint();
      return;
    }
    clearSessionProbeHint();
    setShouldProbeSession(false);
  }, [auth]);

  return (
    <header className="topbar">
      <Link className="brand" to={homePath}>{siteName}</Link>
      <nav className="desktop-nav">
        {homeEnabled && <NavLink to="/home"><Icon name="home-4-line" />首页</NavLink>}
        <NavLink to="/gallery"><Icon name="image-line" />画廊</NavLink>
        {showAdminEntry && <NavLink to={adminBasePath}><Icon name="settings-3-line" />管理</NavLink>}
      </nav>
      <MobileNavigation>
        {homeEnabled && <NavLink to="/home"><Icon name="home-4-line" />首页</NavLink>}
        <NavLink to="/gallery"><Icon name="image-line" />画廊</NavLink>
        {showAdminEntry && <NavLink to={adminBasePath}><Icon name="settings-3-line" />管理</NavLink>}
      </MobileNavigation>
    </header>
  );
}
