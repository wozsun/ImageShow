import { useLayoutEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { adminBasePath, publicRootPath } from "../../lib/constants.js";
import { useSiteConfig } from "../../lib/api/site-data.js";
import { useAuthMe } from "../../hooks/useAuthSession.js";
import {
  publicNavigationHeaderHideThreshold,
  publicNavigationHeaderRevealThreshold,
  publicNavigationTopRevealThreshold
} from "../../lib/ui/public-navigation.js";
import { useOneShotAnimation } from "../../hooks/useOneShotAnimation.js";
import { usePageScrollMovement } from "../../hooks/usePageScrollMovement.js";
import { Icon } from "../icon/Icon.js";
import { MobileNavigation } from "./MobileNavigation.js";
import {
  usePublicRoutePreloadIntents
} from "../../lib/public-route-modules.js";

export function AppHeader({
  animateEntrance,
  onMenuExpandedChange,
  visible
}: {
  animateEntrance?: boolean;
  onMenuExpandedChange?: (expanded: boolean) => void;
  visible?: boolean;
} = {}) {
  const { pathname } = useLocation();
  const { data } = useSiteConfig();
  const { data: auth } = useAuthMe();
  const siteName = data?.site?.name || "ImageShow";
  const headerRef = useRef<HTMLElement | null>(null);
  const upwardDistanceRef = useRef(0);
  const downwardDistanceRef = useRef(0);
  const [standaloneVisible, setStandaloneVisible] = useState(true);
  const headerVisible = visible ?? standaloneVisible;
  const entrance = useOneShotAnimation(Boolean(animateEntrance));

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
  const publicRoutePreloadIntents = usePublicRoutePreloadIntents();
  const currentPublicRoute = pathname === "/gallery"
    || (pathname === "/" && rootPath === "/gallery")
    ? "gallery"
    : pathname === "/home" || (pathname === "/" && rootPath === "/home")
      ? "home"
      : null;
  const homePreloadProps = currentPublicRoute === "gallery"
    ? publicRoutePreloadIntents.home
    : {};
  const galleryPreloadProps = currentPublicRoute === "home"
    ? publicRoutePreloadIntents.gallery
    : {};
  const navClassName = (target: "/home" | "/gallery") => ({ isActive }: { isActive: boolean }) =>
    isActive || (pathname === "/" && rootPath === target) ? "active" : undefined;

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
    if (scrollTop <= publicNavigationTopRevealThreshold) {
      upwardDistanceRef.current = 0;
      downwardDistanceRef.current = 0;
      setStandaloneVisible(true);
      return;
    }
    if (upwardDistanceRef.current >= publicNavigationHeaderRevealThreshold) {
      upwardDistanceRef.current = 0;
      downwardDistanceRef.current = 0;
      setStandaloneVisible(true);
      return;
    }
    if (downwardDistanceRef.current < publicNavigationHeaderHideThreshold) return;
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
      className={[
        "topbar",
        entrance.active ? "is-public-navigation-entrance" : "",
        headerVisible ? "" : "is-scroll-hidden"
      ].filter(Boolean).join(" ")}
      inert={!headerVisible}
      onAnimationEnd={(event) => {
        if (
          event.currentTarget === event.target
          && event.animationName === "public-navigation-entrance"
        ) {
          entrance.finish();
        }
      }}
    >
      <Link
        className="brand"
        to="/"
      >
        {siteName}
      </Link>
      <nav className="desktop-nav">
        {homeEnabled && <NavLink to="/home" className={navClassName("/home")} {...homePreloadProps}><Icon name="home-4-line" />首页</NavLink>}
        <NavLink to="/gallery" className={navClassName("/gallery")} {...galleryPreloadProps}><Icon name="image-line" />画廊</NavLink>
        {showAdminEntry && <NavLink to={adminBasePath}><Icon name="settings-3-line" />管理</NavLink>}
      </nav>
      <MobileNavigation onExpandedChange={onMenuExpandedChange}>
        {homeEnabled && <NavLink to="/home" className={navClassName("/home")} {...homePreloadProps}><Icon name="home-4-line" />首页</NavLink>}
        <NavLink to="/gallery" className={navClassName("/gallery")} {...galleryPreloadProps}><Icon name="image-line" />画廊</NavLink>
        {showAdminEntry && <NavLink to={adminBasePath}><Icon name="settings-3-line" />管理</NavLink>}
      </MobileNavigation>
    </header>
  );
}
