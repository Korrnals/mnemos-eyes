import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { StatusPage } from "./StatusPage";
import { AuthProvider } from "@/features/auth/AuthProvider";
import type { AdapterKind } from "@/gateway/adapterConfig";
import { GatewayContext } from "@/gateway/GatewayContext";
import { MockAdapter } from "@/gateway/MockAdapter";
import { ApiError } from "@/lib/errors";
import { keys } from "@/lib/queryKeys";

/**
 * Board-mode honesty for /metrics (owner feedback 1.4.0): the BoardAdapter
 * declares /metrics unsupported (501) while /health works — the status page
 * shows the calm "not available in board mode" empty state instead of the
 * scary "health is fine, metrics are not" error.
 *
 * Both query states are seeded into the cache so renderToString renders the
 * resolved branches synchronously; ru copy is the no-provider default.
 */
function renderStatus(adapterMode: AdapterKind): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Health: fresh success (board mode serves /api/health).
  const health = queryClient
    .getQueryCache()
    .build(queryClient, {
      queryKey: keys.status.health(),
      queryFn: () => Promise.resolve(null as unknown),
    });
  health.setState({
    status: "success",
    fetchStatus: "idle",
    data: { status: "ok", service: "vesmaro-eyes" },
    dataUpdatedAt: Date.now(),
  });
  // Metrics: honest 501 from the BoardAdapter.
  const metrics = queryClient
    .getQueryCache()
    .build(queryClient, {
      queryKey: keys.status.metrics(),
      queryFn: () => Promise.resolve(null),
    });
  metrics.setState({
    status: "error",
    fetchStatus: "idle",
    error: new ApiError(
      501,
      "BoardAdapter.metrics: the board merge-API does not expose the mnemos /metrics view (ADR 0011 §6).",
    ),
  });
  // Keep observers on the seeded states (retryOnMount rationale: see the
  // sessions board test).
  queryClient.setQueryDefaults(keys.status.metrics(), {
    retryOnMount: false,
    retry: false,
  });
  queryClient.setQueryDefaults(keys.status.health(), {
    retryOnMount: false,
    retry: false,
  });

  return renderToString(
    <GatewayContext.Provider value={new MockAdapter({ latency: false })}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider adapterMode={adapterMode} endpoint="/api">
          <MemoryRouter initialEntries={["/status"]}>
            <StatusPage />
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>
    </GatewayContext.Provider>,
  );
}

describe("status board-mode 501 (metrics)", () => {
  it("shows the honest board-mode empty state, not an error alert", () => {
    const html = renderStatus("board");
    expect(html).toContain("Метрики недоступны в board-режиме");
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("501");
    // The board copy — not the mnemos "health fine, metrics broken" error.
    expect(html).not.toContain("Со здоровьем порядок, с метриками — нет");
  });

  it("keeps the mnemos error treatment on the mnemos adapter", () => {
    const html = renderStatus("mnemos");
    expect(html).toContain("Со здоровьем порядок, с метриками — нет");
    expect(html).not.toContain("Метрики недоступны в board-режиме");
  });
});
