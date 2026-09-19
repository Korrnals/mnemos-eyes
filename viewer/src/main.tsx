import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";

import { queryClient } from "@/lib/queryClient";
import { GatewayContext } from "@/gateway/GatewayContext";
import { createGateway, routerBasename } from "@/gateway/adapterConfig";
import { ThemeProvider } from "@/components/theme-provider";
import App from "@/App";

import "@/styles/fonts.css";
import "@/styles/tokens.css";
import "@/styles/global.css";

/**
 * Bootstrap (architecture.md §5): the gateway is created once and injected
 * via context; the base URL stays same-origin "/api" so the Vite dev-proxy
 * (and the production reverse proxy) route requests without CORS.
 *
 * Adapter selection lives in gateway/adapterConfig.ts (`VITE_ADAPTER`):
 * "mnemos" (default — HttpAdapter against the mnemos API), "mock"
 * (in-memory fixtures, `.env.development` default) and "board" (BoardAdapter
 * speaking the board merge-API, ADR 0011 Ф0).
 *
 * The router mounts under the Vite base ("/app" in production, root in dev)
 * so the deployed `/app` deep links resolve client-side (ADR 0011 §2 Ф0a:
 * server history-fallback serves index.html for `/app/{path}`).
 */
const gateway = createGateway();
const basename = routerBasename(import.meta.env.BASE_URL);

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Bootstrap failed: #root element not found in index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    <GatewayContext.Provider value={gateway}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <BrowserRouter basename={basename}>
            <App />
          </BrowserRouter>
        </ThemeProvider>
      </QueryClientProvider>
    </GatewayContext.Provider>
  </StrictMode>,
);
