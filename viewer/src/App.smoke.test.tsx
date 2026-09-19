import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { buildRoutes } from "@/app/routes";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { ThemeProvider } from "@/components/theme-provider";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { DensityProvider } from "@/components/density-provider";
import { HotkeysProvider } from "@/layout/Hotkeys";
import { I18nProvider } from "@/i18n";

/**
 * Ф1 smoke: the converged route tree (the very same buildRoutes() the
 * production data router mounts) renders against the MockAdapter (`latency:
 * false`, queries suppressed — renderToString runs no effects) and emits the
 * domain sidebar (Обзор + 5 domains incl. honest "soon" slots), the top-bar
 * global search, and the eager search page under the memory domain.
 *
 * Test-env note: the project runs vitest in the node environment and adds no
 * DOM/testing-library dependencies, so mounting uses `renderToString` with a
 * memory DATA router (ScrollRestoration requires one).
 */
function renderAppAt(path: string): string {
  const gateway = new MockAdapter({ latency: false });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  const router = createMemoryRouter(buildRoutes(), { initialEntries: [path] });
  return renderToString(
    <GatewayContext.Provider value={gateway}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          {/* English copy via initialLang — the smoke test pins English. */}
          <I18nProvider initialLang="en">
            <DensityProvider initialDensity="comfortable">
              <HotkeysProvider>
                <AuthProvider adapterMode="mock" endpoint="/api">
                  <RouterProvider router={router} />
                </AuthProvider>
              </HotkeysProvider>
            </DensityProvider>
          </I18nProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </GatewayContext.Provider>,
  );
}

describe("App (smoke)", () => {
  it("is defined and is a function component", () => {
    expect(buildRoutes).toBeDefined();
    expect(typeof buildRoutes).toBe("function");
  });

  it("mounts the domain sidebar: 5 domains + honest soon-slots (mock adapter)", () => {
    const html = renderAppAt("/");
    // Brand + every Ф1 domain of the concept IA (§2.1).
    for (const label of [
      "mnemos-eyes",
      "Overview",
      "Memory",
      "Tasks",
      "Agents",
      "Stores",
      "System",
    ]) {
      expect(html).toContain(label);
    }
    // Ф2: the Tasks domain is LIVE — a real link, not a soon-slot anymore.
    expect(html).toContain('href="/tasks"');
    // Phase-4+ slots stay honest disabled items with a visible "soon" badge —
    // never dead links (no href to /agents or /stores).
    expect(html).toContain(">soon<");
    expect(html).not.toContain('href="/agents"');
    expect(html).not.toContain('href="/stores"');
  });

  it("mounts the global search entry in the top bar (every route)", () => {
    const html = renderAppAt("/");
    expect(html).toContain('role="search"');
    expect(html).toContain('placeholder="Search memory…"');
    expect(html).toContain('id="topbar-global-search"');
    // The `/` hotkey affordance sits inside the search form.
    expect(html).toContain("<kbd");
  });

  it("serves the eager search page under the memory domain", () => {
    const html = renderAppAt("/memory/search");
    // §8.1 hero moved with its route: /memory/search (re-parented Ф1).
    expect(html).toContain("a gaze into oneself");
    expect(html).toContain('placeholder="Search the well…"');
    expect(html).toContain('role="search"');
  });

  it("renders top-bar status indicator, density and theme toggles", () => {
    const html = renderAppAt("/");
    expect(html).toContain("status: ");
    expect(html).toContain("Switch density to compact");
    expect(html).toContain("Light theme");
  });

  it("renders a not-found EmptyState for unknown paths", () => {
    const html = renderAppAt("/definitely-not-a-route");
    expect(html).toContain("404");
    expect(html).toContain('role="alert"');
  });
});
