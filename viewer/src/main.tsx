import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";

import { queryClient } from "@/lib/queryClient";
import { GatewayContext } from "@/gateway/GatewayContext";
import { HttpAdapter } from "@/gateway/HttpAdapter";
import { ThemeProvider } from "@/components/theme-provider";
import App from "@/App";

import "@/styles/tokens.css";
import "@/styles/global.css";

/**
 * Bootstrap (architecture.md §5): the gateway is created once and injected
 * via context; the base URL stays same-origin "/api" so the Vite dev-proxy
 * (and the production reverse proxy) route requests to mnemos without CORS.
 * Phase 2 swaps `new HttpAdapter(...)` for `new TauriAdapter()` — zero
 * component changes.
 */
const BASE_URL = import.meta.env.VITE_MNEMOS_API_URL ?? "/api";
const gateway = new HttpAdapter(BASE_URL);

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Bootstrap failed: #root element not found in index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    <GatewayContext.Provider value={gateway}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ThemeProvider>
      </QueryClientProvider>
    </GatewayContext.Provider>
  </StrictMode>,
);
