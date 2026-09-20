import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearUiToken, hasUiToken, UI_TOKEN_STORAGE_KEY } from "@/gateway/uiToken";
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
