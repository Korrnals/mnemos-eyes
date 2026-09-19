import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TopBar } from "./TopBar";
import { LanguageToggle } from "./LanguageToggle";
import { ThemeProvider } from "@/components/theme-provider";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { GatewayContext } from "@/gateway/GatewayContext";
import { MockAdapter } from "@/gateway/MockAdapter";
import { I18nProvider, type Lang } from "@/i18n";

/**
 * TopBar i18n regression (owner feedback 1.4.0): the rendered strings and the
 * RU|EN segmented control in both languages. renderToString keeps this
 * DOM-free (project vitest pattern); snapshots pin the copy per language.
 *
 * Node env ⇒ ThemeProvider falls back to the system default "dark", so the
 * toggle label is deterministically the "switch to light" branch.
 */
function renderTopBar(lang: Lang): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  return renderToString(
    <GatewayContext.Provider value={new MockAdapter({ latency: false })}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AuthProvider adapterMode="mock" endpoint="/api">
            <I18nProvider initialLang={lang}>
              <TopBar title={lang === "ru" ? "Поиск" : "Search"} />
            </I18nProvider>
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </GatewayContext.Provider>,
  );
}

describe("TopBar i18n (ru default, en switch)", () => {
  it("renders Russian copy with RU pressed by default", () => {
    const html = renderTopBar("ru");
    expect(html).toContain("Язык интерфейса");
    expect(html).toContain("Светлая тема");
    expect(html).toContain('aria-label="Переключить на светлую тему"');
    // Segmented control: RU is the pressed segment, EN is not.
    expect(html).toMatch(/aria-pressed="true"[^>]*>ru</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>en</);
    expect(html).toMatchSnapshot();
  });

  it("renders English copy with EN pressed when switched", () => {
    const html = renderTopBar("en");
    expect(html).toContain("Interface language");
    expect(html).toContain("Light theme");
    expect(html).toContain('aria-label="Switch to light theme"');
    expect(html).toMatch(/aria-pressed="false"[^>]*>ru</);
    expect(html).toMatch(/aria-pressed="true"[^>]*>en</);
    expect(html).toMatchSnapshot();
  });

  it("language toggle exposes a labelled group with focusable segments", () => {
    const html = renderToString(
      <I18nProvider initialLang="ru">
        <LanguageToggle />
      </I18nProvider>,
    );
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Язык интерфейса"');
    expect(html).toContain("focus-visible:outline-iris-bright");
    // Both segments are real buttons (keyboard reachable, no roving tabindex).
    expect(html.match(/<button /g)?.length).toBe(2);
  });
});
