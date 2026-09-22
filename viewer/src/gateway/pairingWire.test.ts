import { describe, expect, it, vi } from "vitest";
import { BoardAdapter } from "@/gateway/BoardAdapter";
import { parseBoardEvent } from "@/gateway/events";

/**
 * Wire gate for the CV-7 pairing surface (ADR 0012 §10.2/§10.3): the
 * adapter speaks the exact pairing routes (auth ONLY on the owner legs —
 * the exchange leg must stay bare) and the SSE parser accepts the four
 * pairing.* kinds with their payload-audit shapes (no code/verify/token —
 * revoked carries pairing_id XOR device_id).
 */

const TOKEN = "mnu_owner-token";
const okResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function makeAdapter() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const adapter = new BoardAdapter({
    baseUrl: "/api",
    getUiTokenFn: () => TOKEN,
    fetchImpl: (async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return okResponse({ ok: true });
    }) as typeof fetch,
  });
  return { adapter, calls };
}

describe("BoardAdapter pairing wire", () => {
  it("createPairing POSTs /api/pairing WITH the bearer (owner leg)", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.createPairing();
    expect(calls[0].url).toBe("/api/pairing");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ device_name: "" });
  });

  it("exchangePairing POSTs /api/pairing/exchange WITHOUT any bearer (device leg)", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.exchangePairing({ code: "abc", device_name: "Тест" });
    expect(calls[0].url).toBe("/api/pairing/exchange");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    // The single-use code IS the credential; a leaked owner bearer here
    // would hand the owner token to an unauthenticated route (§2.3).
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      code: "abc",
      device_name: "Тест",
    });
  });

  it("getPairing/confirmPairing/cancelPairing hit the id-scoped owner routes", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.getPairing("pr-1");
    await adapter.confirmPairing("pr-1", true);
    await adapter.cancelPairing("pr-1");
    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      "GET /api/pairing/pr-1",
      "POST /api/pairing/pr-1/confirm",
      "DELETE /api/pairing/pr-1",
    ]);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ allow: true });
  });

  it("listDevices/revokeDevice hit the device routes", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.listDevices();
    await adapter.revokeDevice("dev-1");
    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      "GET /api/devices",
      "DELETE /api/devices/dev-1",
    ]);
  });
});

describe("parseBoardEvent pairing.* (ADR 0012 §10.3)", () => {
  it("parses requested/confirmed with the optional self-asserted name", () => {
    expect(parseBoardEvent('{"kind":"pairing.requested","pairing_id":"p1"}')).toEqual({
      status: "event",
      event: { kind: "pairing.requested", pairing_id: "p1" },
    });
    expect(
      parseBoardEvent(
        '{"kind":"pairing.requested","pairing_id":"p1","device_name":"Планшет"}',
      ),
    ).toEqual({
      status: "event",
      event: { kind: "pairing.requested", pairing_id: "p1", device_name: "Планшет" },
    });
    expect(
      parseBoardEvent('{"kind":"pairing.confirmed","pairing_id":"p1"}'),
    ).toEqual({
      status: "event",
      event: { kind: "pairing.confirmed", pairing_id: "p1" },
    });
  });

  it("parses expired and both revoked shapes (pairing_id XOR device_id)", () => {
    expect(parseBoardEvent('{"kind":"pairing.expired","pairing_id":"p1"}')).toEqual({
      status: "event",
      event: { kind: "pairing.expired", pairing_id: "p1" },
    });
    expect(parseBoardEvent('{"kind":"pairing.revoked","pairing_id":"p1"}')).toEqual({
      status: "event",
      event: { kind: "pairing.revoked", pairing_id: "p1" },
    });
    // The DEVICE revoke emitter (DELETE /api/devices/{id}) speaks about the
    // session — pairing_id is legitimately absent.
    expect(parseBoardEvent('{"kind":"pairing.revoked","device_id":"d1"}')).toEqual({
      status: "event",
      event: { kind: "pairing.revoked", device_id: "d1" },
    });
  });

  it("rejects malformed frames (missing ids) and audit-violating payload stays absent", () => {
    expect(parseBoardEvent('{"kind":"pairing.requested"}')).toEqual({
      status: "ignored",
      reason: "malformed-payload",
      kind: "pairing.requested",
    });
    expect(parseBoardEvent('{"kind":"pairing.revoked"}')).toEqual({
      status: "ignored",
      reason: "malformed-payload",
      kind: "pairing.revoked",
    });
    // Payload-audit §3.3: the dictionary never carries the digits — a frame
    // with extra junk still parses, but only the audited fields surface.
    const parsed = parseBoardEvent(
      '{"kind":"pairing.expired","pairing_id":"p1","verify":"9999"}',
    );
    expect(parsed).toEqual({
      status: "event",
      event: { kind: "pairing.expired", pairing_id: "p1" },
    });
    expect(JSON.stringify(parsed)).not.toContain("9999");
  });

  it("ignores unknown pairing-ish kinds (additive-only dictionary)", () => {
    expect(parseBoardEvent('{"kind":"pairing.issued","pairing_id":"p1"}')).toEqual({
      status: "ignored",
      reason: "unknown-kind",
      kind: "pairing.issued",
    });
  });
});

describe("EventStream dispatches pairing kinds", () => {
  it("routes a pairing.requested frame to its kind handler", async () => {
    const { EventStream } = await import("@/gateway/events");
    const frames: string[] = [
      '{"kind":"pairing.requested","pairing_id":"p1","device_name":"x"}',
    ];
    interface FakeEventSource {
      onopen: (() => void) | null;
      onerror: (() => void) | null;
      onmessage: ((message: { data: string }) => void) | null;
      close: () => void;
    }
    const stream = new EventStream({
      url: "test://events",
      eventSourceFactory: () => {
        const source: FakeEventSource = {
          onopen: null,
          onerror: null,
          onmessage: null,
          close: vi.fn(),
        };
        queueMicrotask(() => {
          for (const frame of frames) {
            source.onmessage?.({ data: frame });
          }
        });
        return source as unknown as EventSource;
      },
    });
    const seen: string[] = [];
    stream.on("pairing.requested", (event) => seen.push(event.pairing_id));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual(["p1"]);
    stream.close();
  });
});
