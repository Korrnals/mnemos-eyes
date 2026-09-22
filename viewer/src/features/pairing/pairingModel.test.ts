import { describe, expect, it } from "vitest";
import {
  effectivePairingState,
  formatPairingCountdown,
  initialPairingDialogState,
  locationWithoutHash,
  mountPrefixFromPathname,
  pairingDialogReducer,
  pairingTtlFraction,
  pairingUrl,
  platformFromUserAgent,
  readPairingCodeFromHash,
  verifyDigits,
} from "./pairingModel";
import type { PairingCreatedResult } from "@/gateway/boardTypes";

/**
 * Pure gates for the pairing UI model (CV-7, ADR 0012): the owner-dialog
 * state machine (legal + illegal transitions), the TTL honesty rules, the
 * fragment-only device-URL contract (§2.2/§9) and the device-side helpers.
 * Node env — no DOM, no React.
 */

const CREATED: PairingCreatedResult = {
  ok: true,
  pairing_id: "pr-1",
  code: "CODE",
  verify: "3741",
  expires_at: "2026-09-23T10:03:00Z",
  state: "created",
};

const NOW = Date.parse("2026-09-23T10:00:00Z");

function createdState(): ReturnType<typeof pairingDialogReducer> {
  return pairingDialogReducer(initialPairingDialogState, {
    type: "created",
    result: CREATED,
    nowMs: NOW,
  });
}

describe("pairingDialogReducer", () => {
  it("walks creating → created → scanned → confirmed", () => {
    let state = initialPairingDialogState;
    expect(state.phase).toBe("creating");
    state = pairingDialogReducer(state, { type: "created", result: CREATED, nowMs: NOW });
    expect(state.phase).toBe("created");
    state = pairingDialogReducer(state, {
      type: "scanned",
      deviceName: "Планшет",
      sourceIp: "10.0.0.9",
    });
    expect(state.phase).toBe("requested");
    expect(state.scannedDeviceName).toBe("Планшет");
    state = pairingDialogReducer(state, { type: "confirmSettled", outcome: "confirmed" });
    expect(state.phase).toBe("confirmed");
  });

  it("maps the deny outcome to the denied phase", () => {
    let state = createdState();
    state = pairingDialogReducer(state, { type: "scanned", deviceName: "x", sourceIp: "y" });
    state = pairingDialogReducer(state, { type: "confirmSettled", outcome: "denied" });
    expect(state.phase).toBe("denied");
  });

  it("keeps the phase on an idempotent confirm repeat", () => {
    let state = createdState();
    state = pairingDialogReducer(state, { type: "scanned", deviceName: "x", sourceIp: "y" });
    state = pairingDialogReducer(state, { type: "confirmSettled", outcome: "confirmed" });
    state = pairingDialogReducer(state, { type: "confirmSettled", outcome: "idempotent" });
    expect(state.phase).toBe("confirmed");
  });

  it("ignores scanned when not in created (the scan already happened)", () => {
    let state = createdState();
    state = pairingDialogReducer(state, { type: "scanned", deviceName: "a", sourceIp: "b" });
    state = pairingDialogReducer(state, { type: "scanned", deviceName: "c", sourceIp: "d" });
    // The second scan must not clobber the identity already on screen.
    expect(state.scannedDeviceName).toBe("a");
  });

  it("cancelSettled lands from created and requested, nowhere else", () => {
    let state = createdState();
    state = pairingDialogReducer(state, { type: "cancelSettled" });
    expect(state.phase).toBe("cancelled");

    state = pairingDialogReducer(state, { type: "restart" });
    state = pairingDialogReducer(state, {
      type: "created",
      result: CREATED,
      nowMs: NOW,
    });
    state = pairingDialogReducer(state, { type: "scanned", deviceName: "x", sourceIp: "y" });
    state = pairingDialogReducer(state, { type: "cancelSettled" });
    expect(state.phase).toBe("cancelled");

    state = pairingDialogReducer(state, { type: "cancelSettled" });
    expect(state.phase).toBe("cancelled"); // terminal never re-enters
  });

  it("expired/revoked land only on live phases (never resurrect a terminal)", () => {
    let state = createdState();
    state = pairingDialogReducer(state, { type: "expired" });
    expect(state.phase).toBe("expired");
    state = pairingDialogReducer(state, { type: "revoked" });
    expect(state.phase).toBe("expired"); // no terminal → terminal hop
    state = pairingDialogReducer(state, { type: "confirmSettled", outcome: "confirmed" });
    expect(state.phase).toBe("expired");
  });

  it("restart returns EVERY phase to a fresh creating", () => {
    let state = createdState();
    state = pairingDialogReducer(state, { type: "scanned", deviceName: "x", sourceIp: "y" });
    state = pairingDialogReducer(state, { type: "restart" });
    expect(state.phase).toBe("creating");
    expect(state.created).toBeUndefined();
  });

  it("failed carries the server detail and is sticky", () => {
    let state = pairingDialogReducer(initialPairingDialogState, {
      type: "failed",
      message: "rate limit",
    });
    expect(state.phase).toBe("failed");
    expect(state.errorMessage).toBe("rate limit");
    state = pairingDialogReducer(state, { type: "expired" });
    expect(state.phase).toBe("failed");
  });
});

describe("effectivePairingState (TTL honesty)", () => {
  const expires = "2026-09-23T10:03:00Z";
  it("keeps the wire state while live", () => {
    expect(
      effectivePairingState({ state: "created", expires_at: expires }, NOW),
    ).toBe("created");
    expect(
      effectivePairingState({ state: "scanned", expires_at: expires }, NOW),
    ).toBe("scanned");
  });
  it("reads expired once the clock passes expires_at (no SSE needed)", () => {
    expect(
      effectivePairingState(
        { state: "created", expires_at: expires },
        NOW + 3 * 60_000,
      ),
    ).toBe("expired");
  });
  it("terminal wire states win regardless of the clock", () => {
    expect(
      effectivePairingState({ state: "issued", expires_at: expires }, NOW),
    ).toBe("issued");
    expect(
      effectivePairingState({ state: "revoked", expires_at: expires }, NOW),
    ).toBe("revoked");
  });
});

describe("countdown + arc", () => {
  const expires = "2026-09-23T10:03:00Z";
  it("formats mm:ss and stops at zero", () => {
    expect(formatPairingCountdown(expires, NOW)).toBe("03:00");
    expect(formatPairingCountdown(expires, NOW + 90_000)).toBe("01:30");
    expect(formatPairingCountdown(expires, NOW + 200_000)).toBeNull();
  });
  it("arc fraction spans 1 → 0 and clamps", () => {
    const startedAt = NOW;
    expect(pairingTtlFraction(startedAt, expires, NOW)).toBe(1);
    expect(pairingTtlFraction(startedAt, expires, NOW + 90_000)).toBeCloseTo(0.5);
    expect(pairingTtlFraction(startedAt, expires, NOW + 300_000)).toBe(0);
    expect(pairingTtlFraction(0, expires, NOW)).toBe(0); // no origin yet
  });
});

describe("device-URL contract (fragment, never query)", () => {
  it("builds <origin><prefix>/pair#t=<code>", () => {
    expect(pairingUrl("https://vesmaro.abyss.lab", "a b+c")).toBe(
      "https://vesmaro.abyss.lab/pair#t=a%20b%2Bc",
    );
    expect(pairingUrl("https://vesmaro.abyss.lab", "abc", "/app")).toBe(
      "https://vesmaro.abyss.lab/app/pair#t=abc",
    );
  });
  it("mount prefix mirrors the router basename rule", () => {
    expect(mountPrefixFromPathname("/app/whatever")).toBe("/app");
    expect(mountPrefixFromPathname("/system/devices")).toBe("");
    expect(mountPrefixFromPathname("/")).toBe("");
  });
  it("never puts the code in a query string", () => {
    expect(pairingUrl("https://x", "c")).not.toContain("?");
  });
});

describe("readPairingCodeFromHash", () => {
  it("reads the shipped shape #t=<code>", () => {
    expect(readPairingCodeFromHash("#t=abc")).toBe("abc");
    expect(readPairingCodeFromHash("#t=")).toBeNull();
  });
  it("reads the ADR §2.2 draft shape #/pair?t=<code>", () => {
    expect(readPairingCodeFromHash("#/pair?t=xyz")).toBe("xyz");
    expect(readPairingCodeFromHash("#/pair/extra?t=xyz")).toBe("xyz");
    expect(readPairingCodeFromHash("#/pair")).toBeNull();
  });
  it("tolerates a bare hash and returns null without a code", () => {
    expect(readPairingCodeFromHash("")).toBeNull();
    expect(readPairingCodeFromHash("#")).toBeNull();
    expect(readPairingCodeFromHash("#anchor")).toBeNull();
  });
});

describe("device-side helpers", () => {
  it("locationWithoutHash strips the fragment, keeps search", () => {
    expect(locationWithoutHash("/pair", "")).toBe("/pair");
    expect(locationWithoutHash("/pair", "?x=1")).toBe("/pair?x=1");
  });
  it("platformFromUserAgent maps the common families", () => {
    expect(platformFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toBe("iOS");
    expect(platformFromUserAgent("Mozilla/5.0 (Android 14; Mobile)")).toBe("Android");
    expect(platformFromUserAgent("Mozilla/5.0 (Windows NT 10.0)")).toBe("Windows");
    expect(platformFromUserAgent("Mozilla/5.0 (Macintosh)")).toBe("macOS");
    expect(platformFromUserAgent("Mozilla/5.0 (X11; Linux)")).toBe("Linux");
    expect(platformFromUserAgent("curl/8.0")).toBe("");
  });
  it("verifyDigits splits the four digits", () => {
    expect(verifyDigits("3741")).toEqual(["3", "7", "4", "1"]);
  });
});
