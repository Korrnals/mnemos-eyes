import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearUiToken, hasUiToken, UI_TOKEN_STORAGE_KEY } from "@/gateway/uiToken";
import type { UiTokenVerifyResult } from "@/gateway/uiToken";
import { ApiError } from "@/lib/errors";
import { UiTokenGate } from "./uiTokenGate";

/**
 * Ф3 ui-token gate state machine (DOM-free — the React provider is a thin
 * wrapper). Flow contract:
 *
 *   openLogin          → window opens (manual), nothing queued
 *   run without token  → window opens (required), run queued, onDeferred fires
 *   submitToken        → token stored, window closes, queued run RE-RUNS
 *   dismiss            → window closes, queued run DROPPED
 *   run → 401          → token cleared, window reopens (rejected), run requeued
 *   logout             → token cleared, no window
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

/** Token source stub: true/false on demand, backed by the real storage. */
function gateWithToken(token: string | null): {
  gate: UiTokenGate;
  hasToken: ReturnType<typeof vi.fn>;
} {
  const hasToken = vi.fn(() => token !== null);
  return { gate: new UiTokenGate({ hasToken }), hasToken };
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", new MemoryStorage());
  clearUiToken();
});

describe("UiTokenGate", () => {
  it("boots closed; tokenPresent mirrors the injected source", () => {
    const withToken = gateWithToken("t").gate.getState();
    expect(withToken).toEqual({ open: false, reason: "manual", tokenPresent: true });
    const withoutToken = gateWithToken(null).gate.getState();
    expect(withoutToken.tokenPresent).toBe(false);
  });

  it("openLogin opens the window (manual) without queueing anything", async () => {
    // Storage-backed source: submitToken's setUiToken flips hasToken, like
    // the real adapter wiring.
    const gate = new UiTokenGate({ hasToken: () => hasUiToken() });
    gate.openLogin();
    expect(gate.getState()).toEqual({
      open: true,
      reason: "manual",
      tokenPresent: false,
    });
    // A manual sign-in never resurrects a run: nothing was queued, so the
    // submit must not execute anything (the run below was never registered).
    const run = vi.fn(async () => undefined);
    gate.submitToken("typed-token");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(run).not.toHaveBeenCalled();
    // The token is stored and the window closed — the TopBar flips to
    // «Выйти» reactively.
    expect(hasUiToken()).toBe(true);
    expect(gate.getState().open).toBe(false);
  });

  it("openLogin drops a previously queued run (manual entry is a fresh start)", async () => {
    const { gate } = gateWithToken(null);
    const run = vi.fn(async () => undefined);
    gate.runAuthorized(run); // queued, window up (required)
    await vi.waitFor(() => expect(gate.getState().open).toBe(true));
    gate.openLogin(); // user opens the window from the TopBar meanwhile
    gate.submitToken("fresh");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(run).not.toHaveBeenCalled();
  });

  it("run without a token opens the panel (required) and defers the run", async () => {
    const { gate } = gateWithToken(null);
    const run = vi.fn(async () => undefined);
    const onDeferred = vi.fn();
    gate.runAuthorized(run, onDeferred);
    await vi.waitFor(() => expect(onDeferred).toHaveBeenCalled());
    expect(run).not.toHaveBeenCalled();
    expect(gate.getState()).toEqual({
      open: true,
      reason: "required",
      tokenPresent: false,
    });
  });

  it("run with a token executes immediately and never opens the panel", async () => {
    const { gate } = gateWithToken("t");
    const run = vi.fn(async () => undefined);
    gate.runAuthorized(run);
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    expect(gate.getState().open).toBe(false);
  });

  it("submitToken persists the trimmed value and closes the panel", async () => {
    const gate = new UiTokenGate({ hasToken: () => hasUiToken() });
    const run = vi.fn(async () => undefined);
    gate.runAuthorized(run);
    await vi.waitFor(() => expect(gate.getState().open).toBe(true));

    gate.submitToken("  ui-fresh-token  ");
    // Trimmed, sessionStorage (never localStorage — machine is shared).
    expect(sessionStorage.getItem(UI_TOKEN_STORAGE_KEY)).toBe("ui-fresh-token");
    expect(gate.getState().open).toBe(false);
  });

  it("storage-backed gate: submitToken retries the queued run to completion", async () => {
    const gate = new UiTokenGate({ hasToken: () => hasUiToken() });
    const run = vi.fn(async () => undefined);
    const onDeferred = vi.fn();
    gate.runAuthorized(run, onDeferred);
    await vi.waitFor(() =>
      expect(gate.getState()).toMatchObject({ open: true, reason: "required" }),
    );
    expect(run).not.toHaveBeenCalled();

    gate.submitToken("ui-fresh-token");
    expect(gate.getState().open).toBe(false);
    expect(gate.getState().tokenPresent).toBe(true);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  it("dismiss drops the queued run — read-only continues, nothing re-runs", async () => {
    const { gate } = gateWithToken(null);
    const run = vi.fn(async () => undefined);
    gate.runAuthorized(run);
    await vi.waitFor(() => expect(gate.getState().open).toBe(true));
    gate.dismiss();
    expect(gate.getState().open).toBe(false);
    // Even after a token appears later, the dismissed run never re-runs.
    gate.submitToken("late-token");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(run).not.toHaveBeenCalled();
  });

  it("401 mid-flight clears the token, reopens as rejected, requeues the run", async () => {
    sessionStorage.setItem(UI_TOKEN_STORAGE_KEY, "stale-token");
    const gate = new UiTokenGate({ hasToken: () => hasUiToken() });
    let attempts = 0;
    const run = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new ApiError(401, "ui token rejected");
    });
    gate.runAuthorized(run);
    await vi.waitFor(() =>
      expect(gate.getState()).toMatchObject({ open: true, reason: "rejected" }),
    );
    expect(hasUiToken()).toBe(false); // stale token dropped
    expect(run).toHaveBeenCalledTimes(1);

    // Fresh value → the SAME run retries and succeeds → panel closes.
    gate.submitToken("fresh-token");
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(gate.getState().open).toBe(false);
  });

  it("non-401 failures stay the callback's business — no panel", async () => {
    const { gate } = gateWithToken("t");
    const run = vi.fn(async () => {
      throw new ApiError(423, "locked");
    });
    gate.runAuthorized(run);
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    expect(gate.getState().open).toBe(false);
    expect(gate.getState().tokenPresent).toBe(true);
  });

  it("logout clears the token (state sampled at construction, flipped by logout)", async () => {
    sessionStorage.setItem(UI_TOKEN_STORAGE_KEY, "t");
    const gate = new UiTokenGate({ hasToken: () => hasUiToken() });
    expect(gate.getState().tokenPresent).toBe(true);
    const run = vi.fn(async () => undefined);
    gate.runAuthorized(run); // token present → runs immediately
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    gate.logout();
    expect(hasUiToken()).toBe(false);
    expect(gate.getState().tokenPresent).toBe(false);
    expect(gate.getState().open).toBe(false);
  });

  it("notifies subscribers on every transition", async () => {
    const { gate } = gateWithToken(null);
    const states: boolean[] = [];
    gate.subscribe((state) => states.push(state.open));
    const run = vi.fn(async () => undefined);
    gate.runAuthorized(run);
    await vi.waitFor(() => expect(gate.getState().open).toBe(true));
    gate.dismiss();
    expect(states).toEqual([true, false]);
  });
});

describe("UiTokenGate session events (fix/login-feedback toast source)", () => {
  /** Gate + collected event log, storage-backed (like the adapter wiring). */
  function gateWithEvents(): { gate: UiTokenGate; events: string[] } {
    const events: string[] = [];
    const gate = new UiTokenGate({ hasToken: () => hasUiToken() });
    gate.listen((event) => events.push(event.type));
    return { gate, events };
  }

  it("submitToken emits loginStored exactly once the token lands in storage", async () => {
    const { gate, events } = gateWithEvents();
    gate.openLogin();
    gate.submitToken("typed-token");
    expect(events).toEqual(["loginStored"]);
    // Not a login: dismissal and logout never announce one.
    gate.openLogin();
    gate.dismiss();
    gate.submitToken("second-token");
    expect(events).toEqual(["loginStored", "loginStored"]);
    gate.logout();
    expect(events).toEqual(["loginStored", "loginStored"]);
  });

  it("a 401 mid-flight emits tokenRejected (the toast beside the inline line)", async () => {
    sessionStorage.setItem(UI_TOKEN_STORAGE_KEY, "stale-token");
    const { gate, events } = gateWithEvents();
    let attempts = 0;
    gate.runAuthorized(async () => {
      attempts += 1;
      if (attempts === 1) throw new ApiError(401, "ui token rejected");
    });
    await vi.waitFor(() =>
      expect(gate.getState()).toMatchObject({ open: true, reason: "rejected" }),
    );
    expect(events).toEqual(["tokenRejected"]);
    // The retry with a fresh value succeeds → the stored event, no rejection.
    gate.submitToken("fresh-token");
    await vi.waitFor(() => expect(attempts).toBe(2));
    expect(events).toEqual(["tokenRejected", "loginStored"]);
  });

  it("non-401 failures stay silent — the callback owns that feedback", async () => {
    const { gate, events } = gateWithEvents();
    sessionStorage.setItem(UI_TOKEN_STORAGE_KEY, "t");
    gate.runAuthorized(async () => {
      throw new ApiError(423, "locked");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual([]);
  });

  it("listen unsubscribes — a detached feedback sink hears nothing", async () => {
    const events: string[] = [];
    const gate = new UiTokenGate({ hasToken: () => hasUiToken() });
    const detach = gate.listen((event) => events.push(event.type));
    detach();
    gate.submitToken("typed-token");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual([]);
  });
});

/**
 * ADR 0014 owner session: server verify at the door, the boot/401 probe of
 * the live `vesmaro_ui` cookie, and the honest legacy verdict. The gate
 * keeps the paste-and-store path ONLY when no verify is injected (mock
 * adapter / SSR harnesses) — covered by the suites above.
 */
describe("UiTokenGate server verify (ADR 0014)", () => {
  /** Storage-backed gate with the session wire injected. */
  function verifiedGate(overrides?: {
    hasToken?: () => boolean;
    verify?: (value: string) => Promise<UiTokenVerifyResult>;
    probe?: () => Promise<boolean>;
  }): {
    gate: UiTokenGate;
    events: { type: string; tokenClass?: string }[];
  } {
    const events: { type: string; tokenClass?: string }[] = [];
    const gate = new UiTokenGate({
      hasToken: overrides?.hasToken ?? (() => hasUiToken()),
      verifyToken: overrides?.verify ?? (async (value) => {
        // Default double: the real server contract — 401 for anything but
        // the one "valid" value.
        if (value !== "valid-ui-token") {
          throw new ApiError(
            401,
            "the pasted token is a machine-class token (VESMARO_BOARD_TOKEN) — this login requires VESMARO_UI_TOKEN",
          );
        }
        return { ok: true, tokenClass: "ui" };
      }),
      probe: overrides?.probe,
    });
    gate.listen((event) =>
      events.push(
        event.type === "loginStored"
          ? { type: event.type, tokenClass: event.tokenClass }
          : { type: event.type },
      ),
    );
    return { gate, events };
  }

  it("verify success stores the token, closes the panel and replays the queued run", async () => {
    const { gate, events } = verifiedGate();
    const run = vi.fn(async () => undefined);
    gate.runAuthorized(run);
    await vi.waitFor(() =>
      expect(gate.getState()).toMatchObject({ open: true, reason: "required" }),
    );
    gate.submitToken("valid-ui-token");
    // Synchronously: the verify is in flight, NOTHING stored yet.
    expect(hasUiToken()).toBe(false);
    expect(gate.getState().verifyPending).toBe(true);
    expect(gate.getState().open).toBe(true);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(hasUiToken()).toBe(true);
    expect(gate.getState()).toMatchObject({ open: false, tokenPresent: true });
    expect(gate.getState().verifyPending).toBe(false);
    expect(events).toEqual([{ type: "loginStored", tokenClass: "ui" }]);
  });

  it("verify refusal at the door: window stays open, NOTHING stored, no loginStored", async () => {
    const { gate, events } = verifiedGate();
    const run = vi.fn(async () => undefined);
    gate.runAuthorized(run);
    await vi.waitFor(() => expect(gate.getState().open).toBe(true));
    gate.submitToken("board-token-by-mistake");
    await vi.waitFor(() =>
      expect(gate.getState()).toMatchObject({
        open: true,
        reason: "rejected",
        verifyPending: false,
      }),
    );
    // The false-success login is gone: no storage write, no queued retry.
    expect(hasUiToken()).toBe(false);
    expect(run).not.toHaveBeenCalled();
    // The at-the-door beat + the class-aware server detail ride the state.
    expect(gate.getState().rejectKind).toBe("verify");
    expect(gate.getState().rejectDetail).toContain("machine-class token");
    expect(events).toEqual([]);
    // A corrected value still completes the flow.
    gate.submitToken("valid-ui-token");
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(gate.getState().open).toBe(false);
  });

  it("a verify in flight swallows further submits (one at a time)", async () => {
    let release!: (result: UiTokenVerifyResult) => void;
    const verify = vi.fn(
      (value: string) =>
        new Promise<UiTokenVerifyResult>((resolve) => {
          release = resolve;
          void value;
        }),
    );
    const { gate } = verifiedGate({ verify });
    gate.openLogin();
    gate.submitToken("first");
    expect(verify).toHaveBeenCalledTimes(1);
    gate.submitToken("second"); // ignored — verifyPending
    expect(verify).toHaveBeenCalledTimes(1);
    release({ ok: true, tokenClass: "ui" });
    await vi.waitFor(() =>
      expect(gate.getState()).toMatchObject({ open: false, tokenPresent: true }),
    );
    expect(hasUiToken()).toBe(true);
  });

  it("legacy verdict: tokenClass=legacy rides loginStored (the provider toasts the note)", async () => {
    const { gate, events } = verifiedGate({
      verify: async () => ({ ok: true, tokenClass: "legacy" }),
    });
    gate.openLogin();
    gate.submitToken("the-board-token");
    await vi.waitFor(() =>
      expect(events).toEqual([{ type: "loginStored", tokenClass: "legacy" }]),
    );
    expect(gate.getState().open).toBe(false);
  });

  it("401 mid-flight + LIVE cookie: re-probe replays on the cookie leg, window never opens", async () => {
    // The adapter policy after a cookie probe: no stored token, live cookie.
    sessionStorage.removeItem(UI_TOKEN_STORAGE_KEY);
    let cookieLive = true;
    const { gate } = verifiedGate({
      // Mirror the BoardAdapter policy: hasToken = stored || cookieLive.
      hasToken: () => hasUiToken() || cookieLive,
      probe: async () => cookieLive,
    });
    let attempts = 0;
    const run = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new ApiError(401, "ui token rejected");
    });
    gate.runAuthorized(run);
    await vi.waitFor(() => expect(attempts).toBe(2));
    // The window NEVER opened; the stale header value was dropped; the
    // replay went out on the cookie leg (hasToken still true).
    expect(gate.getState().open).toBe(false);
    expect(gate.getState().rejectKind).toBeUndefined();
    expect(hasUiToken()).toBe(false);
    expect(gate.getState().tokenPresent).toBe(true);
  });

  it("401 mid-flight + DEAD cookie: the window opens with the session-expired beat", async () => {
    sessionStorage.setItem(UI_TOKEN_STORAGE_KEY, "stale-header-token");
    const { gate, events } = verifiedGate({ probe: async () => false });
    let attempts = 0;
    const run = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new ApiError(401, "ui session missing or expired");
    });
    gate.runAuthorized(run);
    await vi.waitFor(() =>
      expect(gate.getState()).toMatchObject({
        open: true,
        reason: "rejected",
        rejectKind: "session",
      }),
    );
    expect(attempts).toBe(1);
    expect(hasUiToken()).toBe(false);
    expect(events).toEqual([{ type: "tokenRejected" }]);
  });

  it("refreshPresence re-samples the injected hasToken (boot hydration after the probe)", () => {
    let present = false;
    const gate = new UiTokenGate({ hasToken: () => present });
    expect(gate.getState().tokenPresent).toBe(false);
    present = true; // the adapter's probe came back 204
    gate.refreshPresence();
    expect(gate.getState().tokenPresent).toBe(true);
    expect(gate.getState().open).toBe(false);
  });
});
