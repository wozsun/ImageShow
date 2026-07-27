import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { adminBasePath, publicRootPath } from "../../lib/constants.js";
import { clearSessionProbeHint, hasSessionProbeHint, rememberSessionProbeHint, useAuthMe, useSiteConfig } from "../../lib/api/site-data.js";
import { getPageScrollY, isPageScrollLocked } from "../../hooks/usePageScrollLock.js";
import { Icon } from "../icon/Icon.js";
import { MobileNavigation } from "./MobileNavigation.js";

const headerScrollDirectionThreshold = 8;
const galleryHeaderSecondStageDistance = 48;

export function AppHeader() {
  const { pathname } = useLocation();
  const { data } = useSiteConfig();
  const [shouldProbeSession, setShouldProbeSession] = useState(hasSessionProbeHint);
  const { data: auth } = useAuthMe(shouldProbeSession);
  const siteName = data?.site?.name || "ImageShow";
  const headerRef = useRef<HTMLElement | null>(null);
  const previousScrollTopRef = useRef(0);
  const upwardDistanceRef = useRef(0);
  const downwardDistanceRef = useRef(0);
  const [headerVisible, setHeaderVisible] = useState(true);

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

  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    previousScrollTopRef.current = getPageScrollY();
    let frame: number | undefined;

    const update = () => {
      frame = undefined;
      if (isPageScrollLocked()) return;
      const scrollTop = Math.max(0, getPageScrollY());
      const scrollStep = scrollTop - previousScrollTopRef.current;
      previousScrollTopRef.current = scrollTop;
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
        setHeaderVisible(true);
        return;
      }
      if (scrollTop <= headerScrollDirectionThreshold) {
        upwardDistanceRef.current = 0;
        downwardDistanceRef.current = 0;
        setHeaderVisible(true);
        return;
      }
      const galleryToolbar = document.querySelector<HTMLElement>(".gallery-toolbar");
      if (galleryToolbar && !galleryToolbar.classList.contains("is-scroll-hidden")) {
        upwardDistanceRef.current = 0;
        downwardDistanceRef.current = 0;
        setHeaderVisible(true);
        return;
      }
      if (upwardDistanceRef.current >= headerScrollDirectionThreshold) {
        upwardDistanceRef.current = 0;
        downwardDistanceRef.current = 0;
        setHeaderVisible(true);
        return;
      }
      const downwardDistance = galleryToolbar
        ? galleryHeaderSecondStageDistance
        : headerScrollDirectionThreshold;
      if (downwardDistanceRef.current < downwardDistance) return;
      upwardDistanceRef.current = 0;
      downwardDistanceRef.current = 0;
      if (scrollTop < header.offsetHeight) {
        setHeaderVisible(true);
        return;
      }
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && header.contains(activeElement)) {
        activeElement.blur();
      }
      setHeaderVisible(false);
    };
    const onScroll = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(update);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, []);

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
      <MobileNavigation>
        {homeEnabled && <NavLink to="/home" className={navClassName("/home")}><Icon name="home-4-line" />首页</NavLink>}
        <NavLink to="/gallery" className={navClassName("/gallery")}><Icon name="image-line" />画廊</NavLink>
        {showAdminEntry && <NavLink to={adminBasePath}><Icon name="settings-3-line" />管理</NavLink>}
      </MobileNavigation>
    </header>
  );
}
