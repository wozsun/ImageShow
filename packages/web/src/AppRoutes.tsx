import { Suspense } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router";
import { AuthSessionProvider } from "./hooks/useAuthSession.js";
import {
  adminBasePath,
  publicPageTarget,
  publicRootPath,
  siteRoots
} from "@imageshow/shared/browser";
import type { AuthState } from "./lib/api/auth-session.js";
import { initialSiteConfig, useSiteConfig, type SiteConfig } from "./lib/api/site-queries.js";
import { QueryErrorState } from "./components/feedback/QueryErrorState.js";
import { RouteLoadBoundary } from "./components/feedback/RouteLoadBoundary.js";
import { AppLoadingScreen } from "./components/feedback/AppLoadingScreen.js";
import {
  createPageLifetimeModuleLoader,
  moduleComponent
} from "./lib/page-lifetime-module-loader.js";
import {
  createPublicRouteModuleLoader,
  createPublicRoutePreloadIntents,
  PublicRoutePreloadProvider
} from "./lib/public-route-modules.js";

const homeRouteModule = createPublicRouteModuleLoader(
  () => import(/* @chunk document: home */ "./pages/home/HomePage.js")
);
const galleryRouteModule = createPublicRouteModuleLoader(
  () => import(/* @chunk document: gallery */ "./pages/gallery/GalleryPage.js")
);
const showRouteModule = createPublicRouteModuleLoader(
  () => import(/* @chunk document: show */ "./pages/show/ShowPage.js")
);
const adminShellModule = createPageLifetimeModuleLoader(
  () => import(/* @chunk access: admin, document: admin */ "./pages/admin/shell/AdminShell.js")
);
const embeddedPageLayoutModule = createPageLifetimeModuleLoader(
  () => import(/* @chunk document: embed */ "./components/layout/EmbeddedPageLayout.js")
);
const publicRoutePreloadIntents = createPublicRoutePreloadIntents(
  homeRouteModule,
  showRouteModule,
  galleryRouteModule
);

const HomePage = moduleComponent(homeRouteModule.module, (module) => module.HomePage);
const GalleryPage = moduleComponent(galleryRouteModule.module, (module) => module.GalleryPage);
const ShowPage = moduleComponent(showRouteModule.module, (module) => module.ShowPage);
const AdminShell = moduleComponent(adminShellModule, (module) => module.AdminShell);
const EmbeddedPageLayout = moduleComponent(
  embeddedPageLayoutModule,
  (module) => module.EmbeddedPageLayout
);

function loadPage(pathname: string, authSession: Promise<AuthState | undefined>) {
  if (pathname === adminBasePath || pathname.startsWith(`${adminBasePath}/`)) {
    return Promise.all([adminShellModule(), authSession])
      .then(([{ loadInitialAdminPage }, auth]) => loadInitialAdminPage(pathname, auth));
  }
  const config = initialSiteConfig();
  const target = config && publicPageTarget(config.site, config.embed.enabled, pathname);
  if (!target) return Promise.resolve();
  const embedded = target.startsWith("/embed/");
  const page = embedded ? target.slice("/embed".length) : target;
  const loader = page === "/home"
    ? homeRouteModule
    : page === "/gallery" ? galleryRouteModule : showRouteModule;
  return Promise.all([embedded ? embeddedPageLayoutModule() : null, loader.module()]);
}

/**
 * Loads what the document's first render shows, from the entry's first run
 * instead of the first render; the server preloads the page's files with the
 * document, and administrator pages also wait for the session read. Rendering
 * once it settles shows the page directly; a failed load surfaces through the
 * route's own boundary.
 */
export function loadInitialPage(pathname: string, authSession: Promise<AuthState | undefined>) {
  return loadPage(pathname, authSession).then(() => undefined, () => undefined);
}

function PublicPageNotFound() {
  return (
    <main className="center">
      <div className="query-error-state">
        <strong>404</strong>
        <p>当前没有启用的公开页面</p>
      </div>
    </main>
  );
}

function publicFallback(rootPath: ReturnType<typeof publicRootPath>) {
  return rootPath
    ? <Navigate to={rootPath} replace />
    : <PublicPageNotFound />;
}

/**
 * The element for a public path: the page it shows under the enable and
 * fallback rules, which the startup load and the server's preloads follow
 * too. The root path shows its page in place; other paths redirect to it.
 */
function publicPage(path: string, { site, embed }: SiteConfig) {
  const target = publicPageTarget(site, embed.enabled, path);
  if (target === null) return <PublicPageNotFound />;
  if (target !== path && path !== "/") return <Navigate to={target} replace />;
  const embedded = target.startsWith("/embed/");
  const page = embedded ? target.slice("/embed".length) : target;
  return page === "/home" ? (
    <HomePage embedded={embedded} site={site} />
  ) : page === "/show" ? (
    <ShowPage embedded={embedded} settings={site.show} />
  ) : (
    <GalleryPage embedded={embedded} order={site.gallery.order} />
  );
}

export function AppRoutes() {
  const routeLocation = useLocation();
  const siteConfig = useSiteConfig();
  const { data } = siteConfig;
  if (!data) {
    if (siteConfig.isError)
      return (
        <QueryErrorState
          error={siteConfig.error}
          onRetry={() => void siteConfig.refetch()}
          fullPage
        />
      );
    return <AppLoadingScreen />;
  }
  // Only an embed path that shows its own page loads the embed layout; one
  // that falls back redirects without it.
  const embedPaths = data.embed.enabled ? siteRoots.map((root) => `/embed/${root}`) : [];
  const showsItself = (path: string) =>
    publicPageTarget(data.site, data.embed.enabled, path) === path;
  return (
    <PublicRoutePreloadProvider intents={publicRoutePreloadIntents}>
      <RouteLoadBoundary resetKey={routeLocation.pathname} fullPage>
        <Suspense fallback={<AppLoadingScreen />}>
          <Routes>
            <Route
              element={
                <AuthSessionProvider>
                  <Outlet />
                </AuthSessionProvider>
              }
            >
              {["/", ...siteRoots.map((root) => `/${root}`)].map((path) => (
                <Route key={path} path={path} element={publicPage(path, data)} />
              ))}
              <Route
                path={`${adminBasePath}/*`}
                element={<AdminShell siteHeaderName={data.site.header_name} />}
              />
            </Route>
            {embedPaths.some(showsItself) && (
              <Route element={<EmbeddedPageLayout />}>
                {embedPaths.filter(showsItself).map((path) => (
                  <Route key={path} path={path} element={publicPage(path, data)} />
                ))}
              </Route>
            )}
            {embedPaths.filter((path) => !showsItself(path)).map((path) => (
              <Route key={path} path={path} element={publicPage(path, data)} />
            ))}
            <Route path="*" element={publicFallback(publicRootPath(data.site))} />
          </Routes>
        </Suspense>
      </RouteLoadBoundary>
    </PublicRoutePreloadProvider>
  );
}
