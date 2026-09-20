import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { UiTokenProvider } from "./UiTokenProvider";
import { UiTokenSlot } from "./UiTokenSlot";
import { UiTokenContext } from "./UiTokenContext";
import { GatewayContext } from "@/gateway/GatewayContext";
import { HttpAdapter } from "@/gateway/HttpAdapter";
import { I18nProvider } from "@/i18n";

/**
 * Provider SSR smoke (the behavioural flow — defer/retry/401/logout — lives
 * in uiTokenGate.test.ts; the open dialog itself needs a real DOM, which the
 * node-environment runner does not provide — Radix portals into document.body,
 * so only the closed state is asserted here. The full interactive login flow
 * — window + queue resume + create-button regression — lives in
 * LoginDialog.flow.test.tsx under the happy-dom environment).
 */

describe("UiTokenProvider (SSR smoke)", () => {
  it("renders children with the login window closed (gate boots closed)", () => {
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
    expect(html).not.toContain("Sign in with a ui token");
  });
});

describe("UiTokenSlot (TopBar board-mode sign-in pair)", () => {
  const contextBase = {
    openLogin: () => undefined,
    runAuthorized: () => undefined,
    logout: () => undefined,
  };

  it("renders the ACCENT Sign in button while no token is stored", () => {
    const html = renderToString(
      <I18nProvider initialLang="en">
        <UiTokenContext.Provider value={{ ...contextBase, tokenPresent: false }}>
          <UiTokenSlot />
        </UiTokenContext.Provider>
      </I18nProvider>,
    );
    expect(html).toContain("Sign in");
    // Accent (default) variant — the entry must be findable in the bar.
    expect(html).toContain("bg-iris-strong");
  });

  it("renders Sign out while a token is stored (shared-machine scrub)", () => {
    const html = renderToString(
      <I18nProvider initialLang="en">
        <UiTokenContext.Provider value={{ ...contextBase, tokenPresent: true }}>
          <UiTokenSlot />
        </UiTokenContext.Provider>
      </I18nProvider>,
    );
    expect(html).toContain("Sign out");
    expect(html).toContain('aria-label="Remove the ui token from this tab"');
    expect(html).not.toContain("bg-iris-strong");
  });
});
