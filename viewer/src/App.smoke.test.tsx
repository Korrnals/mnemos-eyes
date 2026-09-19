import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import App from "./App";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { ThemeProvider } from "@/components/theme-provider";
import { I18nProvider } from "@/i18n";

/**
 * T5 mock-mode smoke: the full app mounts against the MockAdapter
 * (`latency: false`, queries suppressed — renderToString runs no effects) and
 * emits the shell (nav, top bar) plus the eager search hero.
 *
 * Test-env note: the project runs vitest in the node environment and adds no
 * DOM/testing-library dependencies, so mounting uses `renderToString` — it
 * exercises the real component tree without a DOM.
 */
function renderAppAt(path: string): string {
  const gateway = new MockAdapter({ latency: false });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  return renderToString(
    <GatewayContext.Provider value={gateway}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          {/* English copy via initialLang — the smoke test pins English. */}
          <I18nProvider initialLang="en">
            <MemoryRouter initialEntries={[path]}>
              <App />
            </MemoryRouter>
          </I18nProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </GatewayContext.Provider>,
  );
}

describe("App (smoke)", () => {
  it("is defined and is a function component", () => {
    expect(App).toBeDefined();
    expect(typeof App).toBe("function");
  });

  it("mounts the shell with all L1 nav entries and the search hero (mock adapter)", () => {
    const html = renderAppAt("/");
    // Brand + every L1 nav item from the inventory sidebar.
    for (const label of ["mnemos-eyes", "Search", "Memories", "Tags", "Status", "Sessions", "Traces"]) {
      expect(html).toContain(label);
    }
    // §8.1 hero: tagline + the pupil search input.
    expect(html).toContain("a gaze into oneself");
    expect(html).toContain('placeholder="Search the well…"');
    expect(html).toContain('role="search"');
  });

  it("renders top-bar status indicator and theme toggle", () => {
    const html = renderAppAt("/");
    expect(html).toContain("status: ");
    expect(html).toContain("theme");
  });

  it("renders a not-found EmptyState for unknown paths", () => {
    const html = renderAppAt("/definitely-not-a-route");
    expect(html).toContain("404");
    expect(html).toContain('role="alert"');
  });
});
