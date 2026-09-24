import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { KoraSessionPage } from "./KoraSessionPage";
import { KoraMockAdapter } from "./KoraMockAdapter";
import { KoraGatewayContext } from "./koraGatewayContext";
import { koraKeys } from "./useKora";
import {
  KORA_FIXTURE_COVERAGE,
  KORA_FIXTURE_SESSIONS,
  KORA_FIXTURE_TRANSCRIPT,
} from "./koraFixtures";
import { I18nProvider } from "@/i18n";

/**
 * Slice-2 + slice-3 UI mock snapshots (ADR 0019 rev.2, week 0): pin the
 * read-only transcript with the honest plate «чужая сессия — только чтение»
 * for a local session, and the chat panel (PIN step-up + send → store-tail)
 * for the steerable relay session. DOM-free per the project pattern.
 */

const RELAY = "exec-zcode-main:sess_7f3a91";
const LOCAL = "exec-vscode-lab:a83f1c22";

function renderKoraSessionPage(sessionId: string): string {
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
  queryClient.setQueryData(koraKeys.transcript(sessionId), {
    session_id: sessionId,
    items: KORA_FIXTURE_TRANSCRIPT[sessionId] ?? [],
    next_after_seq: KORA_FIXTURE_TRANSCRIPT[sessionId]?.at(-1)?.seq ?? 0,
    has_more: false,
  });
  return renderToString(
    <KoraGatewayContext.Provider value={new KoraMockAdapter({ latency: false })}>
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLang="ru">
          {/* useParams needs the real route pattern, not just the entry. */}
          <MemoryRouter initialEntries={[`/kora/${encodeURIComponent(sessionId)}`]}>
            <Routes>
              <Route path="/kora/:sessionId" element={<KoraSessionPage />} />
            </Routes>
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>
    </KoraGatewayContext.Provider>,
  );
}

describe("Kora slice-2/3 session screen snapshots", () => {
  it("pins the read-only transcript of a LOCAL session with the honest plate", () => {
    const html = renderKoraSessionPage(LOCAL);
    // The plate is the honesty contract: no fake input on a foreign session.
    expect(html).toContain("Чужая сессия — только чтение");
    expect(html).toContain("Руление недоступно");
    expect(html).toContain("Транскрипт (только чтение)");
    expect(html).toMatchSnapshot();
  });

  it("pins the relay session with the chat panel (step-up PIN + send)", () => {
    const html = renderKoraSessionPage(RELAY);
    expect(html).toContain("Чат (срез 3)");
    expect(html).toContain("PIN руления");
    expect(html).toContain("Включить руление");
    expect(html).toContain("Промпт в сессию");
    expect(html).not.toContain("Чужая сессия — только чтение");
    expect(html).toMatchSnapshot();
  });

  it("renders the redaction mark on the masked transcript entry", () => {
    const html = renderKoraSessionPage(RELAY);
    expect(html).toContain("маскировано");
    // JSX separates text nodes with <!-- --> — match around it.
    expect(html).toMatch(/seq\s*<!-- -->3/);
  });

  it("shows the honest not-found state for an unknown session", () => {
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
    const html = renderToString(
      <KoraGatewayContext.Provider value={new KoraMockAdapter({ latency: false })}>
        <QueryClientProvider client={queryClient}>
          <I18nProvider initialLang="ru">
            <MemoryRouter initialEntries={["/kora/nope:unknown"]}>
              <Routes>
                <Route path="/kora/:sessionId" element={<KoraSessionPage />} />
              </Routes>
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>
      </KoraGatewayContext.Provider>,
    );
    expect(html).toContain("Сессия не найдена");
  });
});
