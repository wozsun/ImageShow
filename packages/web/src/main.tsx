import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { AppRoutes } from "./AppRoutes.js";
import { SiteHead } from "./components/layout/SiteHead.js";
import { OverlayScrollbar } from "./components/layout/OverlayScrollbar.js";
import "./styles.css";

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
