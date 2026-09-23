import { describe, expect, it, vi } from "vitest";
import { BoardAdapter } from "./BoardAdapter";

/**
 * The per-device grants wire (ADR 0012 Amendment §A.7): PUT
 * /api/devices/{id}/grants carries the FULL replacement set as JSON and
 * rides the ui-token gate (a device mnd_ fallback must not widen its own
 * grants when a ui token exists — same class rule as every owner leg).
 */

const UI_TOKEN = "ui-owner-token";
const DEVICE_TOKEN = "mnd_device-identity";

interface RecordedCall {
  path: string;
  method: string;
  body: string | undefined;
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
      body: typeof init?.body === "string" ? init.body : undefined,
      authorization: (init?.headers as Record<string, string>)?.Authorization,
    });
    return new Response(
      JSON.stringify({ ok: true, device: { id: "dev-1", grants: [] } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  const adapter = new BoardAdapter({
    baseUrl: "/api",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    getUiTokenFn: () => tokens.ui ?? "",
    getDeviceTokenFn: () => tokens.device ?? "",
  });
  return { adapter, calls };
}

describe("BoardAdapter setDeviceGrants (§A.7)", () => {
  it("PUTs the full set to /devices/{id}/grants with the ui token", async () => {
    const { adapter, calls } = adapterWith({ ui: UI_TOKEN });
    await adapter.setDeviceGrants("dev-1", ["tasks", "reports"]);
    expect(calls[0].path).toBe("/devices/dev-1/grants");
    expect(calls[0].method).toBe("PUT");
    expect(JSON.parse(calls[0].body!)).toEqual({
      grants: ["tasks", "reports"],
    });
    expect(calls[0].authorization).toBe(`Bearer ${UI_TOKEN}`);
  });

  it("encodes the device id and prefers the ui token over the device token", async () => {
    const { adapter, calls } = adapterWith({ ui: UI_TOKEN, device: DEVICE_TOKEN });
    await adapter.setDeviceGrants("dev spaced/1", []);
    expect(calls[0].path).toBe("/devices/dev%20spaced%2F1/grants");
    expect(JSON.parse(calls[0].body!)).toEqual({ grants: [] });
    expect(calls[0].authorization).toBe(`Bearer ${UI_TOKEN}`);
  });

  it("falls back to the device token when no ui token exists (owner-leg class rule)", async () => {
    const { adapter, calls } = adapterWith({ device: DEVICE_TOKEN });
    await adapter.setDeviceGrants("dev-1", ["inbox"]);
    expect(calls[0].authorization).toBe(`Bearer ${DEVICE_TOKEN}`);
  });
});
