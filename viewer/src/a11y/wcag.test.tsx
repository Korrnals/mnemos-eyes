import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Shell } from "@/layout/Shell";
import App from "@/App";
import { Badge } from "@/components/ui/badge";
import { TraceRow } from "@/components/TraceRow/TraceRow";
import { MemoryCard } from "@/components/MemoryCard/MemoryCard";
import { MOCK_MEMORIES, MOCK_TRACES } from "@/gateway/fixtures";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { ThemeProvider } from "@/components/theme-provider";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { I18nProvider } from "@/i18n";

/**
 * T7 a11y regression guards (WCAG 2.2 AA fixes). renderToString keeps these
 * DOM-free (node vitest env, project pattern): they assert that the accessible
 * semantics — landmarks, headings, skip link, live regions, AA badge tints,
 * ≥24px link targets — are present in the real component markup.
 */
function renderTree(ui: React.ReactElement, path = "/"): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  return renderToString(
    <GatewayContext.Provider value={new MockAdapter({ latency: false })}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AuthProvider adapterMode="mock" endpoint="/api">
            {/* English copy via initialLang — the a11y assertions pin English
             * labels; semantics under test are language-independent. */}
            <I18nProvider initialLang="en">
              {/* No <Routes> wrapper: Shell's <Outlet> may stay empty and App owns
               * its own routes — only router context is provided here. */}
              <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
            </I18nProvider>
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </GatewayContext.Provider>,
  );
}

describe("Shell landmarks and keyboard bypass (WCAG 2.4.1 / 1.3.1)", () => {
  it("renders a skip-to-content link ahead of the navigation", () => {
    const html = renderTree(<Shell />);
    expect(html).toContain("Skip to content");
    expect(html).toContain('href="#main"');
    // The skip link precedes the primary nav in DOM (tab) order.
    expect(html.indexOf('href="#main"')).toBeLessThan(html.indexOf('aria-label="Primary"'));
  });

  it("exposes the landmark structure: header, nav, main", () => {
    const html = renderTree(<Shell />);
    expect(html).toContain("<main id=\"main\"");
    expect(html).toContain('aria-label="Primary"');
    expect(html).toContain("<header");
    expect(html).toContain("<aside");
  });

  it("does not use a heading for the top-bar route label (pages own the h1)", () => {
    const html = renderTree(<Shell />);
    expect(html).not.toContain("<h2");
  });
});

describe("Page headings (WCAG 1.3.1)", () => {
  it("search page carries an h1 even on the hero (imagery + form) branch", () => {
    const html = renderTree(<App />);
    expect(html).toContain('<h1 class="sr-only">Search</h1>');
  });

  it("memory cards use h2 under the page h1 and give links a ≥24px target", () => {
    const html = renderToString(
      <MemoryRouter>
        <MemoryCard memory={MOCK_MEMORIES[0]} />
      </MemoryRouter>,
    );
    expect(html).toContain("<h2");
    expect(html).not.toContain("<h3");
    expect(html).toContain("min-h-6"); // 24px minimum interactive target (2.5.8)
  });
});

describe("Badge variants (WCAG 1.4.3 — AA tint composition)", () => {
  it("iris and confidence badges use the 15% tint + bright-text combination", () => {
    const iris = renderToString(<Badge variant="iris">hybrid</Badge>);
    expect(iris).toContain("bg-iris/15");
    expect(iris).toContain("text-iris-bright");
    const confidence = renderToString(<Badge variant="confidence">semantic</Badge>);
    expect(confidence).toContain("bg-confidence/15");
    expect(confidence).toContain("text-confidence");
  });
});

describe("Trace row (WCAG 2.5.8 / 1.4.3)", () => {
  it("gives the Raw JSON disclosure a ≥24px target and an AA text token", () => {
    const html = renderToString(<TraceRow trace={MOCK_TRACES[0]} />);
    expect(html).toMatch(/<summary[^>]*min-h-6/);
    expect(html).toMatch(/<summary[^>]*text-iris-bright/);
  });
});
