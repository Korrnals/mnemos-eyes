import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";

import { queryClient } from "@/lib/queryClient";
import { GatewayContext } from "@/gateway/GatewayContext";
import { createGateway, routerBasename } from "@/gateway/adapterConfig";
import { ThemeProvider } from "@/components/theme-provider";
import { I18nProvider } from "@/i18n";
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
 * "board" (production default — the read-only merge-API, no auth wall),
 * "mock" (in-memory fixtures, dev default) and "mnemos" (HttpAdapter against
 * the mnemos API, via VITE_ADAPTER=mnemos).
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
          {/* i18n (owner feedback 1.4.0): ru default, persisted choice in
           * localStorage "vesmaro.lang", mirrored into <html lang>. */}
          <I18nProvider>
            <BrowserRouter basename={basename}>
              <App />
            </BrowserRouter>
          </I18nProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </GatewayContext.Provider>
  </StrictMode>,
);
