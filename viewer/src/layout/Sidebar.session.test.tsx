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
import {
  clearDeviceIdentity,
  DEVICE_ID_STORAGE_KEY,
  DEVICE_NAME_STORAGE_KEY,
  DEVICE_TOKEN_STORAGE_KEY,
  saveDeviceIdentity,
} from "@/gateway/deviceToken";

/**
 * Session-aware footer mode line (fix/login-feedback + UI-22 owner
 * feedback): the bottom-left sidebar line must state the LIVE contract —
 * «read-only» without any identity, «device connected» with a paired device
 * (ADR 0012 §5, v0 read-only scope) and «session active» with a ui token —
 * per adapter, instead of the static «L1 read-only» that kept lying after
 * login. The reactive flip (login without reload) lives in
 * LoginDialog.flow.test.tsx under happy-dom; these renderToString cases pin
 * the static states (SSR viewport = desktop, so the footer line renders).
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
  vi.stubGlobal("localStorage", new MemoryStorage());
  clearUiToken();
  clearDeviceIdentity();
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

/**
 * UI-22 owner feedback («подключился телефоном — но не авторизованным»):
 * a paired device is an IDENTITY, not an absent one — the footer must say
 * «device connected», not «read-only». Scope v1 (ADR 0012 Amendment): the
 * line splits by the device's scope — `control` (the default; absent scope
 * field = the pre-v1 migrated phone) reads «full access», an explicit
 * `read` pairing stays the plain «device connected».
 */
describe("Sidebar footer mode line (device state, UI-22 + scope v1)", () => {
  it("board adapter, control device, no ui token: device connected · full access", () => {
    saveDeviceIdentity({
      token: "mnd_paired-device",
      deviceId: "dev_1",
      deviceName: "phone",
      scope: "control",
    });
    expect(localStorage.getItem(DEVICE_TOKEN_STORAGE_KEY)).toBe("mnd_paired-device");
    const html = renderSidebar(new BoardAdapter("/api"), true);
    expect(html).toContain("device connected · full access");
    expect(html).not.toContain("read-only");
    expect(html).not.toContain("session active");
  });

  it("a pre-scope-v1 identity (no scope field) reads as control — migration semantics", () => {
    localStorage.setItem(DEVICE_TOKEN_STORAGE_KEY, "mnd_legacy-phone");
    localStorage.setItem(DEVICE_ID_STORAGE_KEY, "dev_old");
    localStorage.setItem(DEVICE_NAME_STORAGE_KEY, "Pixel");
    const html = renderSidebar(new BoardAdapter("/api"), true);
    expect(html).toContain("device connected · full access");
  });

  it("board adapter, read-scope device, no ui token: device connected (read-only)", () => {
    saveDeviceIdentity({
      token: "mnd_paired-device",
      deviceId: "dev_1",
      deviceName: "phone",
      scope: "read",
    });
    const html = renderSidebar(new BoardAdapter("/api"), true);
    expect(html).toContain("device connected");
    expect(html).not.toContain("full access");
    expect(html).not.toContain("session active");
  });

  it("device identity beside a ui token: session active wins (the owner controls)", () => {
    saveDeviceIdentity({
      token: "mnd_paired-device",
      deviceId: "dev_1",
      deviceName: "phone",
      scope: "control",
    });
    sessionStorage.setItem(UI_TOKEN_STORAGE_KEY, "ui-live");
    const html = renderSidebar(new BoardAdapter("/api"), true);
    expect(html).toContain("session active");
    expect(html).not.toContain("device connected");
  });

  it("mnemos adapter with a device identity: still read-only (no device wire in L1)", () => {
    saveDeviceIdentity({
      token: "mnd_paired-device",
      deviceId: "dev_1",
      deviceName: "phone",
      scope: "control",
    });
    const html = renderSidebar(new HttpAdapter("/api"), true);
    expect(html).toContain("read-only");
    expect(html).not.toContain("device connected");
  });
});
