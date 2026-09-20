import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { UiTokenProvider } from "./UiTokenProvider";
import { UiTokenStatus } from "./UiTokenStatus";
import { UiTokenContext } from "./UiTokenContext";
import { GatewayContext } from "@/gateway/GatewayContext";
import { HttpAdapter } from "@/gateway/HttpAdapter";
import { I18nProvider } from "@/i18n";

/**
 * Provider SSR smoke (the behavioural flow — defer/retry/401/logout — lives
 * in uiTokenGate.test.ts; dialog content itself needs a real DOM, which this
 * project's DOM-free runner does not provide — Radix portals into
 * document.body, so only the closed state is asserted here).
 */

describe("UiTokenProvider (SSR smoke)", () => {
  it("renders children with the panel closed (gate boots closed)", () => {
    const html = renderToString(
      <GatewayContext.Provider value={new HttpAdapter("/api")}>
        <QueryClientProvider client={new QueryClient()}>
          <I18nProvider initialLang="en">
            <UiTokenProvider>
              <p>read-only content stays browsable</p>
            </UiTokenProvider>
          </I18nProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
    expect(html).toContain("read-only content stays browsable");
    expect(html).not.toContain("Mutations are protected by a ui token");
  });
});

describe("UiTokenStatus (TopBar board-mode slot)", () => {
  it("renders the sign-out button while a token is present", () => {
    const html = renderToString(
      <I18nProvider initialLang="en">
        <UiTokenContext.Provider
          value={{
            tokenPresent: true,
            runAuthorized: () => undefined,
            logout: () => undefined,
          }}
        >
          <UiTokenStatus />
        </UiTokenContext.Provider>
      </I18nProvider>,
    );
    expect(html).toContain("Sign out");
    expect(html).toContain('aria-label="Remove the ui token from this tab"');
  });

  it("renders nothing without a token (read-only viewer, nothing to sign out of)", () => {
    const html = renderToString(
      <I18nProvider initialLang="en">
        <UiTokenContext.Provider
          value={{
            tokenPresent: false,
            runAuthorized: () => undefined,
            logout: () => undefined,
          }}
        >
          <UiTokenStatus />
        </UiTokenContext.Provider>
      </I18nProvider>,
    );
    expect(html).toBe("");
  });
});
