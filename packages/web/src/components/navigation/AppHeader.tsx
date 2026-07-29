import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { adminBasePath, publicRootPath } from "../../lib/constants.js";
import { clearSessionProbeHint, hasSessionProbeHint, rememberSessionProbeHint, useAuthMe, useSiteConfig } from "../../lib/api/site-data.js";
import { usePageScrollMovement } from "../../hooks/usePageScrollMovement.js";
import { Icon } from "../icon/Icon.js";
import { MobileNavigation } from "./MobileNavigation.js";

const headerScrollDirectionThreshold = 18;

export function AppHeader({
  onMenuExpandedChange,
  visible
}: {
  onMenuExpandedChange?: (expanded: boolean) => void;
  visible?: boolean;
} = {}) {
  const { pathname } = useLocation();
  const { data } = useSiteConfig();
  const [shouldProbeSession, setShouldProbeSession] = useState(hasSessionProbeHint);
  const { data: auth } = useAuthMe(shouldProbeSession);
  const siteName = data?.site?.name || "ImageShow";
  const headerRef = useRef<HTMLElement | null>(null);
  const upwardDistanceRef = useRef(0);
  const downwardDistanceRef = useRef(0);
  const [standaloneVisible, setStandaloneVisible] = useState(true);
  const headerVisible = visible ?? standaloneVisible;

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header || headerVisible) return;
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && header.contains(activeElement)) {
      activeElement.blur();
    }
  }, [headerVisible]);

  const homeEnabled = data?.site?.home?.enabled ?? true;
  const rootPath = data?.site ? publicRootPath(data.site) : "/home";
  const showAdminEntry = Boolean(auth?.authenticated);
  const navClassName = (target: "/home" | "/gallery") => ({ isActive }: { isActive: boolean }) =>
    isActive || (pathname === "/" && rootPath === target) ? "active" : undefined;

  useEffect(() => {
    if (!auth) return;
    if (auth.authenticated) {
      rememberSessionProbeHint();
      return;
    }
    clearSessionProbeHint();
    setShouldProbeSession(false);
  }, [auth]);

  usePageScrollMovement(({ delta: scrollStep, position }) => {
    const header = headerRef.current;
    if (!header) return;
    const scrollTop = position.top;
    if (scrollStep < 0) {
      upwardDistanceRef.current += -scrollStep;
      downwardDistanceRef.current = 0;
    } else if (scrollStep > 0) {
      downwardDistanceRef.current += scrollStep;
      upwardDistanceRef.current = 0;
    }
    if (header.querySelector('[aria-expanded="true"]')) {
      upwardDistanceRef.current = 0;
      downwardDistanceRef.current = 0;
      setStandaloneVisible(true);
      return;
    }
    if (scrollTop <= headerScrollDirectionThreshold) {
      upwardDistanceRef.current = 0;
      downwardDistanceRef.current = 0;
      setStandaloneVisible(true);
      return;
    }
    if (upwardDistanceRef.current >= headerScrollDirectionThreshold) {
      upwardDistanceRef.current = 0;
      downwardDistanceRef.current = 0;
      setStandaloneVisible(true);
      return;
    }
    if (downwardDistanceRef.current < headerScrollDirectionThreshold) return;
    upwardDistanceRef.current = 0;
    downwardDistanceRef.current = 0;
    if (scrollTop < header.offsetHeight) {
      setStandaloneVisible(true);
      return;
    }
    setStandaloneVisible(false);
  }, visible === undefined);

  return (
    <header
      ref={headerRef}
      className={`topbar${headerVisible ? "" : " is-scroll-hidden"}`}
      inert={!headerVisible}
    >
      <Link className="brand" to="/">{siteName}</Link>
      <nav className="desktop-nav">
        {homeEnabled && <NavLink to="/home" className={navClassName("/home")}><Icon name="home-4-line" />首页</NavLink>}
        <NavLink to="/gallery" className={navClassName("/gallery")}><Icon name="image-line" />画廊</NavLink>
        {showAdminEntry && <NavLink to={adminBasePath}><Icon name="settings-3-line" />管理</NavLink>}
      </nav>
      <MobileNavigation onExpandedChange={onMenuExpandedChange}>
        {homeEnabled && <NavLink to="/home" className={navClassName("/home")}><Icon name="home-4-line" />首页</NavLink>}
        <NavLink to="/gallery" className={navClassName("/gallery")}><Icon name="image-line" />画廊</NavLink>
        {showAdminEntry && <NavLink to={adminBasePath}><Icon name="settings-3-line" />管理</NavLink>}
      </MobileNavigation>
    </header>
  );
}
