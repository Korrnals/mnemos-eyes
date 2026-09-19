import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { buildRoutes } from "@/app/routes";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { ThemeProvider } from "@/components/theme-provider";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { DensityProvider, type Density } from "@/components/density-provider";
import { HotkeysProvider } from "@/layout/Hotkeys";
import { I18nProvider, type Lang } from "@/i18n";

/**
 * Ф1 shell snapshots (QA gate "shell-снапшоты ru/en + density"): pin the
 * whole shell chrome — domain sidebar with soon-slots, top bar with the
 * global search + density/theme toggles, breadcrumbs row — per language and
 * per density mode. renderToString keeps this DOM-free (project pattern).
 */
function renderShell(options: { lang: Lang; density: Density; path?: string }): string {
  const { lang, density, path = "/memory" } = options;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  return renderToString(
    <GatewayContext.Provider value={new MockAdapter({ latency: false })}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AuthProvider adapterMode="mock" endpoint="/api">
            <I18nProvider initialLang={lang}>
              <DensityProvider initialDensity={density}>
                <HotkeysProvider>
                  <RouterProvider
                    router={createMemoryRouter(buildRoutes(), {
                      initialEntries: [path],
                    })}
                  />
                </HotkeysProvider>
              </DensityProvider>
            </I18nProvider>
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </GatewayContext.Provider>,
  );
}

/**
 * Strip the renderToString Suspense tombstone — an HTML comment carrying a
 * component-stack trace (file paths + line numbers) for lazy routes. It is
 * SSR bookkeeping, not chrome; pinning it would make snapshots fail on every
 * internal line move.
 */
function normalizeForSnapshot(html: string): string {
  return html.replace(/<template data-msg=[\s\S]*?<\/template>/, "<!--suspense -->");
}

describe("Shell snapshots (ru/en + density)", () => {
  it("pins the Russian shell on a domain page (breadcrumbs + sections)", () => {
    expect(
      normalizeForSnapshot(renderShell({ lang: "ru", density: "comfortable" })),
    ).toMatchSnapshot();
  });

  it("pins the English shell on the same page", () => {
    expect(
      normalizeForSnapshot(renderShell({ lang: "en", density: "comfortable" })),
    ).toMatchSnapshot();
  });

  it("pins the compact-density shell (toggle shows the switch-back label)", () => {
    const html = renderShell({ lang: "en", density: "compact" });
    expect(html).toContain("Switch density to comfortable");
    expect(normalizeForSnapshot(html)).toMatchSnapshot();
  });

  it("keeps the last breadcrumb non-link and the trail in DOM order", () => {
    const html = renderShell({ lang: "en", density: "comfortable" });
    // Memory / Records — the last crumb is a span with aria-current,
    // never an href; the trail order is Memory → Records.
    expect(html).toMatch(/Memory<\/a>/);
    expect(html).toMatch(/aria-current="page"[^>]*>Records<\/span>/);
    const memoryAt = html.indexOf(">Memory<");
    const recordsAt = html.search(/aria-current="page"[^>]*>Records</);
    expect(memoryAt).toBeGreaterThan(-1);
    expect(recordsAt).toBeGreaterThan(-1);
    expect(memoryAt).toBeLessThan(recordsAt);
  });
});
