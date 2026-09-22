// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import { DevicesPage } from "./DevicesPage";
import { createPairingTestGateway } from "./testPairingGateway";
import { FIXTURE_DEVICE } from "./testPairingGateway";
import type { PairingGatewayScript } from "./testPairingGateway";
import { GatewayContext } from "@/gateway/GatewayContext";
import { I18nProvider } from "@/i18n";
import { crumbsFor, NAV_DOMAINS } from "@/layout/navItems";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { ToastViewport } from "@/components/Toast/ToastViewport";
import { UiTokenContext } from "@/features/ui-token/UiTokenContext";

/**
 * The devices-page interaction gate (CV-7, ADR 0012 §10.2): the list
 * renders name/state/IP/expiries, the ui-gated read shows the honest login
 * hint WITHOUT a session (the query idles — no wire call), the empty state
 * renders, and the REVOKE is terminal-behind-confirm: no wire call until
 * the owner accepts the irreversible warning, then DELETE + toast + list
 * refetch.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(
  script: PairingGatewayScript = {},
  options: { tokenPresent?: boolean; confirmAnswer?: boolean } = {},
): {
  calls: ReturnType<typeof createPairingTestGateway>["calls"];
  root: Root;
  client: QueryClient;
} {
  const { gateway, calls } = createPairingTestGateway(script);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(document.body);
  const tokenPresent = options.tokenPresent ?? true;
  act(() => {
    root.render(
      <GatewayContext.Provider value={gateway}>
        <QueryClientProvider client={client}>
          <ToastProvider>
            <UiTokenContext.Provider
              value={{
                tokenPresent,
                openLogin: () => undefined,
                runAuthorized: (run) => void run(),
                logout: () => undefined,
              }}
            >
              <I18nProvider initialLang="en">
                <MemoryRouter initialEntries={["/system/devices"]}>
                  <DevicesPage />
                  <ToastViewport />
                </MemoryRouter>
              </I18nProvider>
            </UiTokenContext.Provider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
  return { calls, root, client };
}

const button = (text: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.includes(text),
  )!;

const devicesScript = (): PairingGatewayScript => ({
  devices: {
    ok: true,
    count: 2,
    items: [
      FIXTURE_DEVICE,
      {
        ...FIXTURE_DEVICE,
        id: "dev-2",
        name: "Планшет",
        state: "revoked",
        ip: "192.168.1.50",
      },
    ],
  },
});

beforeEach(() => {
  vi.stubGlobal("confirm", vi.fn(() => true));
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DevicesPage — list", () => {
  it("renders device rows: name, state badge, IP, sliding+hard expiry", async () => {
    mount(devicesScript());
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Телефон");
    });
    const body = document.body.textContent ?? "";
    expect(body).toContain("Планшет");
    expect(body).toContain("active");
    expect(body).toContain("revoked");
    expect(body).toContain("192.168.1.42");
    // Sliding + hard TTL columns render as dates (formatTaskDate, en-GB).
    expect(body).toContain("23/10/2026");
    expect(body).toContain("22/12/2026");
    // The revoked row hides its revoke button (nothing left to revoke).
    const revokeButtons = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].filter((candidate) => candidate.textContent?.includes("Revoke"));
    expect(revokeButtons).toHaveLength(1);
  });

  it("shows the login hint and never calls the wire without a session", async () => {
    const { calls } = mount(devicesScript(), { tokenPresent: false });
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("owner session");
    });
    expect(calls.listDevices).toBe(0);
  });

  it("shows the honest empty state for a deviceless board", async () => {
    mount({});
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("No paired devices yet");
    });
  });
});

describe("DevicesPage — IA wiring (nav + breadcrumbs)", () => {
  it("sits in the Система domain: section entry + crumb trail", () => {
    const system = NAV_DOMAINS.find((domain) => domain.to === "/system");
    expect(system?.sections?.map((section) => section.to)).toContain(
      "/system/devices",
    );
    expect(crumbsFor("/system/devices")).toEqual([
      { to: "/system", key: "nav.system" },
      { key: "nav.devices" },
    ]);
  });
});

describe("DevicesPage — revoke (terminal, behind confirm)", () => {
  it("confirm=false: the confirm dialog fires, the wire does not", async () => {
    const { calls } = mount(devicesScript());
    vi.stubGlobal("confirm", vi.fn(() => false));
    await vi.waitFor(() => {
      expect(button("Revoke")).toBeDefined();
    });
    await act(async () => {
      button("Revoke").click();
      await Promise.resolve();
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("irreversible"),
    );
    expect(calls.revoke).toEqual([]);
  });

  it("confirm=true: DELETE fires, the toast lands, the list refetches", async () => {
    const { calls } = mount(devicesScript());
    await vi.waitFor(() => {
      expect(button("Revoke")).toBeDefined();
    });
    const listCallsBefore = calls.listDevices;
    await act(async () => {
      button("Revoke").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(calls.revoke).toEqual(["dev-1"]);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Телефон"));
    expect(document.body.textContent).toContain("Device revoked");
    // The invalidation refetched the list (the row flips to revoked).
    expect(calls.listDevices).toBeGreaterThan(listCallsBefore);
  });
});
