import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, useLocation } from "react-router";
import { AppRoutes, loadInitialPage } from "./AppRoutes.js";
import { prefetchAuthSession } from "./hooks/useAuthSession.js";
import { SiteHead } from "./components/layout/SiteHead.js";
import { OverlayScrollbar } from "./components/layout/OverlayScrollbar.js";
import { adminBasePath } from "@imageshow/shared/browser";
import "./styles/app-core.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 90_000 } }
});
const authSession = prefetchAuthSession(queryClient, window.location.pathname);

function AppOverlayScrollbar() {
  const { pathname } = useLocation();
  const adminRoute = pathname === adminBasePath
    || pathname.startsWith(`${adminBasePath}/`);
  return <OverlayScrollbar tone={adminRoute ? "default" : "dark"} />;
}

const root = createRoot(document.getElementById("root")!);
void loadInitialPage(window.location.pathname, authSession).then(() => root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SiteHead />
        <AppRoutes />
        <AppOverlayScrollbar />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
));
