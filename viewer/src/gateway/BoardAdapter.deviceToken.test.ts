import { describe, expect, it, vi } from "vitest";
import { BoardAdapter } from "./BoardAdapter";

/**
 * The device-identity leg (ADR 0012 §5): a paired browser stores
 * `vesmaro.deviceToken` (mnd_…) and the adapter attaches it as
 * `Authorization: Bearer mnd_…` — the device's IDENTITY on board requests.
 * Rules pinned here:
 * - ui token ALWAYS wins when present (both on mutations and by keeping
 *   open reads bare — the pinned "reads never carry Authorization");
 * - the device token is the fallback everywhere else on the board wire;
 * - `/pairing/exchange` NEVER carries either token (the code IS the
 *   credential, §2.3 — an existing pin, re-asserted with tokens present);
 * - `/auth/*` never claims device identity (the door speaks via body/cookie).
 */

const UI_TOKEN = "ui-owner-token";
const DEVICE_TOKEN = "mnd_device-identity";

interface RecordedCall {
  path: string;
  method: string;
  authorization: string | undefined;
}

function adapterWith(tokens: { ui?: string; device?: string }): {
  adapter: BoardAdapter;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+\/api/, "").replace(/^\/api/, "");
    calls.push({
      path,
      method: init?.method ?? "GET",
      authorization: (init?.headers as Record<string, string>)?.Authorization,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const adapter = new BoardAdapter({
    baseUrl: "/api",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    getUiTokenFn: () => tokens.ui ?? "",
    getDeviceTokenFn: () => tokens.device ?? "",
  });
  return { adapter, calls };
}

describe("BoardAdapter device identity (ADR 0012 §5)", () => {
  it("open reads carry Bearer mnd_ when ONLY the device token exists", async () => {
    const { adapter, calls } = adapterWith({ device: DEVICE_TOKEN });
    await adapter.board();
    expect(calls[0].path).toBe("/board");
    expect(calls[0].authorization).toBe(`Bearer ${DEVICE_TOKEN}`);
  });

  it("open reads stay bare when the ui token speaks for the browser (ui priority)", async () => {
    const { adapter, calls } = adapterWith({ ui: UI_TOKEN, device: DEVICE_TOKEN });
    await adapter.board();
    expect(calls[0].authorization).toBeUndefined();
  });

  it("no tokens at all → reads ship bare (the Ф0–Ф2 pin)", async () => {
    const { adapter, calls } = adapterWith({});
    await adapter.board();
    expect(calls[0].authorization).toBeUndefined();
  });

  it("mutations prefer the ui token when both identities exist", async () => {
    const { adapter, calls } = adapterWith({ ui: UI_TOKEN, device: DEVICE_TOKEN });
    await adapter.createTask({
      title: "t",
      summary: "",
      spec: "",
      col: "open",
      priority: "normal",
      env: "unknown",
      agents: [],
      specialists: [],
      project: "",
      memory_ids: [],
      mnemos_tags: [],
    });
    expect(calls[0].authorization).toBe(`Bearer ${UI_TOKEN}`);
  });

  it("mutations fall back to the device token when no ui token is stored", async () => {
    const { adapter, calls } = adapterWith({ device: DEVICE_TOKEN });
    await adapter.refreshInbox();
    expect(calls[0].authorization).toBe(`Bearer ${DEVICE_TOKEN}`);
  });

  it("ui-gated pairing/devices legs fall back to the device token too", async () => {
    const { adapter, calls } = adapterWith({ device: DEVICE_TOKEN });
    await adapter.listDevices();
    expect(calls[0].authorization).toBe(`Bearer ${DEVICE_TOKEN}`);
  });

  it("/pairing/exchange NEVER carries a token, even with both stored (§2.3)", async () => {
    const { adapter, calls } = adapterWith({ ui: UI_TOKEN, device: DEVICE_TOKEN });
    await adapter.exchangePairing({ code: "single-use-code" });
    expect(calls[0].path).toBe("/pairing/exchange");
    expect(calls[0].authorization).toBeUndefined();
  });

  it("/auth/ui-token verify ships bare regardless of the device token", async () => {
    const { adapter, calls } = adapterWith({ device: DEVICE_TOKEN });
    const verdict = await adapter.verifyUiToken("pasted-value");
    expect(verdict).toEqual({ ok: true, tokenClass: "ui" });
    const verify = calls.find((call) => call.path === "/auth/ui-token");
    expect(verify?.method).toBe("POST");
    expect(verify?.authorization).toBeUndefined();
  });
});
