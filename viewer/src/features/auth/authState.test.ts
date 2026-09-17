import { describe, expect, it } from "vitest";
import {
  authReducer,
  initialAuthState,
} from "./authState";
import type { AuthEvent } from "./authState";

/** Drive the reducer from `initial` through a list of events. */
function run(...events: AuthEvent[]) {
  return events.reduce(authReducer, initialAuthState);
}

describe("auth state machine", () => {
  it("stays closed and anonymous initially", () => {
    expect(initialAuthState).toMatchObject({ phase: "anonymous", overlayOpen: false });
  });

  it("OPEN/CLOSE_OVERLAY toggles the overlay without touching the phase", () => {
    const opened = run({ type: "OPEN_OVERLAY" });
    expect(opened.overlayOpen).toBe(true);
    expect(opened.phase).toBe("anonymous");

    const closed = authReducer(opened, { type: "CLOSE_OVERLAY" });
    expect(closed.overlayOpen).toBe(false);
    expect(closed.phase).toBe("anonymous");
  });

  it("401 → auth screen: UNAUTHORIZED opens the overlay and flags the expired session", () => {
    const authenticated = run({ type: "SESSION_RESTORED" });
    expect(authenticated.phase).toBe("authenticated");

    const unauthorized = authReducer(authenticated, { type: "UNAUTHORIZED" });
    expect(unauthorized).toMatchObject({
      phase: "anonymous",
      overlayOpen: true,
      sessionExpired: true,
      challengeId: null,
    });
  });

  it("UNAUTHORIZED is suppressed while a login/verify round-trip is in flight", () => {
    const submitting = run({ type: "OPEN_OVERLAY" }, { type: "SUBMIT" });
    const unchanged = authReducer(submitting, { type: "UNAUTHORIZED" });
    expect(unchanged).toBe(submitting); // same object — no state stomp
  });

  it("successful login closes the overlay and clears expired/error flags", () => {
    const state = run(
      { type: "UNAUTHORIZED" },
      { type: "SUBMIT" },
      { type: "SUCCESS" },
    );
    expect(state).toMatchObject({
      phase: "authenticated",
      overlayOpen: false,
      sessionExpired: false,
      error: null,
    });
  });

  it("challenge phase stores the challenge id; FAILURE keeps the form on the code step", () => {
    const challenged = run({ type: "OPEN_OVERLAY" }, { type: "SUBMIT" }, {
      type: "CHALLENGE",
      challengeId: "ch-1",
    });
    expect(challenged).toMatchObject({ phase: "challenge", challengeId: "ch-1" });

    const failed = authReducer(challenged, { type: "FAILURE", message: "Bad code" });
    expect(failed).toMatchObject({ phase: "challenge", challengeId: "ch-1", error: "Bad code" });

    const recovered = authReducer(failed, { type: "SUBMIT" });
    expect(recovered.error).toBeNull();
    const done = authReducer(recovered, { type: "SUCCESS" });
    expect(done).toMatchObject({ phase: "authenticated", challengeId: null, overlayOpen: false });
  });

  it("FAILURE without a challenge returns to the token form with the error shown", () => {
    const failed = run(
      { type: "OPEN_OVERLAY" },
      { type: "SUBMIT" },
      { type: "FAILURE", message: "Invalid token format" },
    );
    expect(failed).toMatchObject({ phase: "anonymous", error: "Invalid token format" });
    expect(failed.overlayOpen).toBe(true); // the form stays up for a retry
  });

  it("LOGOUT resets to a pristine anonymous state", () => {
    const state = run(
      { type: "SESSION_RESTORED" },
      { type: "OPEN_OVERLAY" },
      { type: "LOGOUT" },
    );
    expect(state).toEqual({ ...initialAuthState, overlayOpen: false });
  });
});
