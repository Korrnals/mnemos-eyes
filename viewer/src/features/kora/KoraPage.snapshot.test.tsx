import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { KoraPage } from "./KoraPage";
import { KoraMockAdapter } from "./KoraMockAdapter";
import { KoraGatewayContext } from "./koraGatewayContext";
import { koraKeys } from "./useKora";
import { KORA_FIXTURE_COVERAGE, KORA_FIXTURE_SESSIONS } from "./koraFixtures";
import { I18nProvider, type Lang } from "@/i18n";

/**
 * Slice-1 UI mock snapshots (ADR 0019 rev.2, week 0): pin the «Кора» list
 * screen — week-0 demo plate, coverage panel «что вижу / чего нет»,
 * onboarding card (3 cases) and the session rows (state dot, origin badge,
 * steerable badge, clamped preview). DOM-free per the project pattern
 * (renderToString); the query cache is prefilled from the fixtures so the
 * data branch renders synchronously and byte-deterministically.
 */

function renderKoraPage(lang: Lang, path = "/kora"): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(koraKeys.sessions(), {
    ok: true as const,
    count: KORA_FIXTURE_SESSIONS.length,
    items: KORA_FIXTURE_SESSIONS,
    coverage: KORA_FIXTURE_COVERAGE,
    meta: { generated_at: "2026-09-24T11:45:00Z" },
  });
  return renderToString(
    <KoraGatewayContext.Provider value={new KoraMockAdapter({ latency: false })}>
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLang={lang}>
          <MemoryRouter initialEntries={[path]}>
            <KoraPage />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>
    </KoraGatewayContext.Provider>,
  );
}

describe("Kora slice-1 list screen snapshots", () => {
  it("pins the Russian screen (coverage + onboarding + rows)", () => {
    const html = renderKoraPage("ru");
    // The honest week-0 plate is part of the contract.
    expect(html).toContain("Кора · срез 1");
    expect(html).toContain("Что вижу / чего нет");
    expect(html).toContain("Зачем Кора");
    expect(html).toMatchSnapshot();
  });

  it("pins the English screen", () => {
    const html = renderKoraPage("en");
    expect(html).toContain("Kora · slice 1");
    expect(html).toMatchSnapshot();
  });

  it("marks the relay row steerable and the local rows read-only", () => {
    const html = renderKoraPage("ru");
    expect(html).toContain("можно рулить"); // relay-origin row badge
    expect(html).toContain("реле");
    expect(html).toContain("локальная");
    expect(html).toContain("процесс мёртв"); // dead pi row, honest state
  });

  it("links each row into the transcript mock route", () => {
    const html = renderKoraPage("ru");
    expect(html).toContain('href="/kora/exec-zcode-main%3Asess_7f3a91"');
  });
});
