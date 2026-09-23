import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Sidebar } from "./Sidebar";
import { BoardAdapter } from "@/gateway/BoardAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { I18nProvider } from "@/i18n";

/**
 * Sidebar horizontal-overflow hygiene + collapse control placement (UI-19
 * owner feedback): long translations («Устройства и подключение», docs
 * domain) must NEVER force the fixed-width panel into a horizontal scroll —
 * labels truncate under a full-name title/aria-label and the nav clips
 * overflow-x. The collapse control lives in the sidebar HEADER (the old
 * footer corner went unnoticed), carries aria-expanded + a tooltip title,
 * and the icon-only mode keeps accessible names on every row.
 * renderToString pattern: Sidebar.session.test.tsx (DOM-free, node env).
 */

function renderSidebar(path: string, collapsed: boolean, lang: "ru" | "en" = "ru") {
  return renderToString(
    <GatewayContext.Provider value={new BoardAdapter("/api")}>
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { enabled: false, retry: false } },
          })
        }
      >
        <I18nProvider initialLang={lang}>
          <MemoryRouter initialEntries={[path]}>
            <Sidebar collapsed={collapsed} onToggle={() => undefined} />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>
    </GatewayContext.Provider>,
  );
}

describe("Sidebar overflow hygiene (UI-19)", () => {
  it("expanded: labels truncate, no nowrap on label spans, nav clips overflow-x", () => {
    const html = renderSidebar("/docs/c/devices", false);
    expect(html).toContain("truncate");
    // Label spans must not force single-line overflow (the Button's own
    // whitespace-nowrap is irrelevant — it holds an icon only).
    expect(html.match(/<span class="[^"]*whitespace-nowrap/g)).toBeNull();
    expect(html).toContain("overflow-x-hidden");
    // The widened expanded slot (w-56 → w-64 for the long RU docs labels).
    expect(html).toContain("md:w-64");
  });

  it("every long label row keeps its FULL name as title AND aria-label", () => {
    const html = renderSidebar("/docs/c/devices", false);
    // The docs domain renders PROJECT GROUPS now (ADR 0016): its category
    // rows keep the same title/aria-label discipline as before.
    expect(html).toContain('title="Устройства и подключение"');
    expect(html).toContain('aria-label="Устройства и подключение"');
    expect(html).toContain('title="Безопасность и токены"');
    expect(html).toContain('title="vesmaro-eyes"'); // project group row
  });

  it("the same holds for the EN dictionary", () => {
    const html = renderSidebar("/docs/c/devices", false, "en");
    // & renders HTML-escaped in the SSR string.
    expect(html).toContain('title="Devices &amp; pairing"');
    expect(html).toContain('aria-label="Security &amp; tokens"');
  });

  it("icon-rail (collapsed): project groups keep their names, categories hide (spec §3.2)", () => {
    const html = renderSidebar("/docs/c/devices", true);
    // The domain and the three PROJECT rows stay accessible by name.
    expect(html).toContain('aria-label="Документация"');
    expect(html).toContain('aria-label="vesmaro-eyes"');
    expect(html).toContain('aria-label="Mnemos"');
    expect(html).toContain('aria-label="mnemos-mesh"');
    // Categories never render in the rail — no second icon column (UI-19).
    expect(html).not.toContain("Устройства и подключение");
    expect(html).toContain('<span class="hidden">vesmaro-eyes</span>');
    expect(html).toContain('<span class="hidden">Документация</span>');
  });
});

describe("Sidebar collapse control (UI-19)", () => {
  it("lives in the HEADER (before the nav), carries title + aria-expanded", () => {
    const html = renderSidebar("/docs/c/devices", false);
    const toggle = html.indexOf("aria-expanded");
    const nav = html.indexOf("<nav");
    expect(toggle).toBeGreaterThan(-1);
    expect(nav).toBeGreaterThan(-1);
    expect(toggle).toBeLessThan(nav); // header position, not the footer corner
    expect(html).toContain('aria-expanded="true"'); // expanded by default
    expect(html).toContain('title="Свернуть панель"'); // native tooltip
  });

  it("collapsed: the control flips to «Развернуть панель» + aria-expanded=false", () => {
    const html = renderSidebar("/docs/c/devices", true);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('title="Развернуть панель"');
  });
});
