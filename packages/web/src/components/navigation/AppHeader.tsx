import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { adminBasePath, publicRootPath } from "../../lib/constants.js";
import { clearSessionProbeHint, hasSessionProbeHint, rememberSessionProbeHint, useAuthMe, useSiteConfig } from "../../lib/api/site-data.js";
import { registerPageTopInset } from "../../lib/ui/page-scroll-insets.js";
import { Icon } from "../icon/Icon.js";
import { MobileNavigation } from "./MobileNavigation.js";

export function AppHeader() {
  const { pathname } = useLocation();
  const { data } = useSiteConfig();
  const [shouldProbeSession, setShouldProbeSession] = useState(hasSessionProbeHint);
  const { data: auth } = useAuthMe(shouldProbeSession);
  const siteName = data?.site?.name || "ImageShow";
  const headerRef = useRef<HTMLElement | null>(null);

  const homeEnabled = data?.site?.home?.enabled ?? true;
  const rootPath = data?.site ? publicRootPath(data.site) : "/home";
  const showAdminEntry = Boolean(auth?.authenticated);
  const navClassName = (target: "/home" | "/gallery") => ({ isActive }: { isActive: boolean }) =>
    isActive || (pathname === "/" && rootPath === target) ? "active" : undefined;

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    return registerPageTopInset(header);
  }, []);

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
    <header ref={headerRef} className="topbar" data-scroll-lock-anchor>
      <Link className="brand" to="/">{siteName}</Link>
      <nav className="desktop-nav">
        {homeEnabled && <NavLink to="/home" className={navClassName("/home")}><Icon name="home-4-line" />首页</NavLink>}
        <NavLink to="/gallery" className={navClassName("/gallery")}><Icon name="image-line" />画廊</NavLink>
        {showAdminEntry && <NavLink to={adminBasePath}><Icon name="settings-3-line" />管理</NavLink>}
      </nav>
      <MobileNavigation>
        {homeEnabled && <NavLink to="/home" className={navClassName("/home")}><Icon name="home-4-line" />首页</NavLink>}
        <NavLink to="/gallery" className={navClassName("/gallery")}><Icon name="image-line" />画廊</NavLink>
        {showAdminEntry && <NavLink to={adminBasePath}><Icon name="settings-3-line" />管理</NavLink>}
      </MobileNavigation>
    </header>
  );
}
