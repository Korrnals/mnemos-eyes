import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Sidebar } from "./Sidebar";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import { BoardAdapter } from "@/gateway/BoardAdapter";
import { HttpAdapter } from "@/gateway/HttpAdapter";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { I18nProvider } from "@/i18n";
import { clearUiToken, UI_TOKEN_STORAGE_KEY } from "@/gateway/uiToken";

/**
 * Session-aware footer mode line (fix/login-feedback): the bottom-left
 * sidebar line must state the LIVE contract — «read-only» without a ui
 * token, «session active» with one — per adapter, instead of the static
 * «L1 read-only» that kept lying after login. The reactive flip (login
 * without reload) lives in LoginDialog.flow.test.tsx under happy-dom;
 * these renderToString cases pin the four static states.
 */

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", new MemoryStorage());
  clearUiToken();
});

/** Any of the three adapters — the footer derivation must hold for each. */
type AnyGateway =
  | InstanceType<typeof BoardAdapter>
  | InstanceType<typeof HttpAdapter>
  | InstanceType<typeof MockAdapter>;

function renderSidebar(gateway: AnyGateway, withGate: boolean): string {
  const sidebar = <Sidebar collapsed={false} onToggle={() => undefined} />;
  // The real tree always mounts the gate (App.tsx); the bare variant covers
  // SSR harnesses that mount the chrome without it — the footer then falls
  // back to the adapter's own hasUiToken() read.
  const inner = withGate ? (
    <ToastProvider>
      <UiTokenProvider>
        <MemoryRouter>{sidebar}</MemoryRouter>
      </UiTokenProvider>
    </ToastProvider>
  ) : (
    <MemoryRouter>{sidebar}</MemoryRouter>
  );
  return renderToString(
    <GatewayContext.Provider value={gateway}>
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { enabled: false, retry: false } },
          })
        }
      >
        <I18nProvider initialLang="en">{inner}</I18nProvider>
      </QueryClientProvider>
    </GatewayContext.Provider>,
  );
}

describe("Sidebar footer mode line (session-aware)", () => {
  it("board adapter without a token: read-only", () => {
    const html = renderSidebar(new BoardAdapter("/api"), true);
    expect(html).toContain("read-only");
    expect(html).not.toContain("session active");
  });

  it("board adapter with a stored token: session active", () => {
    sessionStorage.setItem(UI_TOKEN_STORAGE_KEY, "ui-live");
    const html = renderSidebar(new BoardAdapter("/api"), true);
    expect(html).toContain("session active");
    expect(html).not.toContain("read-only");
  });

  it("mnemos adapter: read-only even with the gate mounted (no mutation surface)", () => {
    const html = renderSidebar(new HttpAdapter("/api"), true);
    expect(html).toContain("read-only");
    expect(html).not.toContain("session active");
  });

  it("mock adapter, bare harness (no gate): session active via the fail-soft fallback", () => {
    const html = renderSidebar(new MockAdapter({ latency: false }), false);
    // The dev playground has no auth wall — control is genuinely available.
    expect(html).toContain("session active");
    expect(html).not.toContain("read-only");
  });
});
