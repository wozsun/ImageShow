import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { AppRoutes } from "./AppRoutes.js";
import { SiteHead } from "./components/SiteHead.js";
import { OverlayScrollbar } from "./components/OverlayScrollbar.js";
import "./styles.css";

// A modest default staleTime so a window refocus / route remount doesn't immediately re-fetch
// every active query (the React Query default is staleTime: 0). Mutations still call
// invalidateQueries to force fresh data, and site-config / gallery-options override this with
// staleTime: Infinity (they're load-once, see lib/site-data.ts).
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 90_000 } }
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SiteHead />
        <AppRoutes />
        <OverlayScrollbar />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
