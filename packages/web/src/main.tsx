import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, useLocation } from "react-router";
import { AppRoutes } from "./AppRoutes.js";
import { SiteHead } from "./components/layout/SiteHead.js";
import { OverlayScrollbar } from "./components/layout/OverlayScrollbar.js";
import { adminBasePath } from "./lib/constants.js";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 90_000 } }
});

function AppOverlayScrollbar() {
  const { pathname } = useLocation();
  const adminRoute = pathname === adminBasePath
    || pathname.startsWith(`${adminBasePath}/`);
  return <OverlayScrollbar tone={adminRoute ? "default" : "dark"} />;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SiteHead />
        <AppRoutes />
        <AppOverlayScrollbar />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
