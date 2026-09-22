// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { PairingDialog } from "./PairingDialog";
import {
  createPairingTestGateway,
  makeCreated,
  makeStatus,
} from "./testPairingGateway";
import type { PairingGatewayScript } from "./testPairingGateway";
import { GatewayContext } from "@/gateway/GatewayContext";
import type { MemoryGateway } from "@/gateway/MemoryGateway";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenContext } from "@/features/ui-token/UiTokenContext";

/**
 * The pairing-dialog interaction gate (CV-7, ADR 0012 §2): create → QR +
 * manual code (verify HIDDEN — §3.5 separation), the 10 s status poll
 * landing the scan → the decision panel (identity + IP + the four digits
 * big, code HIDDEN), confirm/deny/cancel wires, the local TTL honesty
 * (expires_at in the past flips to «истёк» with no SSE), and «Начать
 * заново» returning to a fresh QR. Fake gateway + fake timers: the SSE
 * bridge is deliberately absent here (no `events()` on the double), so the
 * POLL is what proves the scan lands.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flush = async (ms = 0): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const button = (text: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.includes(text),
  )!;

function mount(script: PairingGatewayScript = {}): {
  gateway: MemoryGateway;
  calls: ReturnType<typeof createPairingTestGateway>["calls"];
  root: Root;
} {
  const { gateway, calls } = createPairingTestGateway(script);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(document.body);
  act(() => {
    root.render(
      <GatewayContext.Provider value={gateway}>
        <QueryClientProvider client={client}>
          <ToastProvider>
            {/* The gate is pre-authorised: the pairing legs run without the
             * login window (the gate itself is uiTokenGate's tested unit). */}
            <UiTokenContext.Provider
              value={{
                tokenPresent: true,
                openLogin: () => undefined,
                runAuthorized: (run) => void run(),
                logout: () => undefined,
              }}
            >
              <I18nProvider initialLang="en">
                <PairingDialog open onOpenChange={() => undefined} />
              </I18nProvider>
            </UiTokenContext.Provider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
  return { gateway, calls, root };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("PairingDialog — created phase (QR + manual code)", () => {
  it("lands on the QR screen: code visible, verify digits hidden", async () => {
    const { calls } = mount();
    await flush();
    expect(calls.createPairing).toBe(1);
    const body = document.body.textContent ?? "";
    expect(body).toContain("CODE-1234");
    // §3.5: the digits meet the owner only at the decision panel.
    expect(body).not.toContain("3741");
    // The lazy QR chunk resolved and rendered an SVG.
    expect(document.body.querySelector("svg")).not.toBeNull();
    expect(document.body.textContent).toContain("Waiting for the scan");
  });

  it("a create failure lands in the honest failed state with the server text", async () => {
    mount({ createError: new Error("pairing disabled") });
    await flush();
    const body = document.body.textContent ?? "";
    expect(body).toContain("Pairing not created");
    expect(body).toContain("pairing disabled");
  });
});

describe("PairingDialog — scan → decision", () => {
  it("the 10 s poll picks up the scan: identity + IP + digits, code hidden", async () => {
    const { calls } = mount({ status: () => makeStatus("scanned") });
    await flush();
    await flush(10_000); // the poll fallback fires refreshStatus
    expect(calls.getPairing).toBeGreaterThanOrEqual(1);
    const body = document.body.textContent ?? "";
    expect(body).toContain("Гостевой планшет");
    expect(body).toContain("192.168.1.77");
    expect(body).toContain("unverified");
    // The four digits render; the code is gone from the screen (§3.5).
    expect(body).toContain("3741");
    expect(body).not.toContain("CODE-1234");
  });

  it("approve calls confirmPairing(allow=true) and shows the wait-for-token verdict", async () => {
    const { calls } = mount({ status: () => makeStatus("scanned") });
    await flush();
    await flush(10_000);
    await act(async () => {
      button("Confirm").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls.confirm[0]).toEqual({ id: "pr-1", allow: true });
    expect(document.body.textContent).toContain("Device confirmed");
  });

  it("deny calls confirmPairing(allow=false) and shows the honest refusal", async () => {
    const { calls } = mount({ status: () => makeStatus("scanned") });
    await flush();
    await flush(10_000);
    await act(async () => {
      button("Deny").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls.confirm[0]).toEqual({ id: "pr-1", allow: false });
    expect(document.body.textContent).toContain("Request denied");
  });
});

describe("PairingDialog — cancel / TTL / restart", () => {
  it("cancel from the QR phase hits DELETE and offers «Start over»", async () => {
    const { calls } = mount();
    await flush();
    await act(async () => {
      button("Cancel").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls.cancel).toBe(1);
    const body = document.body.textContent ?? "";
    expect(body).toContain("Pairing cancelled");
    // Restart → a fresh create → the QR screen again.
    const createCallsBefore = calls.createPairing;
    await act(async () => {
      button("Start over").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls.createPairing).toBe(createCallsBefore + 1);
    expect(document.body.textContent).toContain("CODE-1234");
  });

  it("a pairing past its expires_at reads expired with no SSE at all", async () => {
    mount({ created: () => makeCreated({ ttlMs: -5_000 }) });
    await flush(1_100); // one tick of the shared 1 Hz clock
    const body = document.body.textContent ?? "";
    expect(body).toContain("Pairing expired — start over");
  });
});
