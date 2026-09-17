/**
 * Pure auth state machine for the T6 auth flow (no React, no fetch — the
 * AuthProvider drives it with AuthClient results and 401 events). Kept pure
 * so the login→challenge→verify and 401→screen transitions are unit-testable
 * without a DOM.
 *
 * Phases:
 * - `anonymous`      no session (or a stale one was rejected)
 * - `authenticating` a login/verify round-trip is in flight
 * - `challenge`      mnemos answered phase 1 with a TOTP `challenge_id`
 * - `authenticated`  a session token is stored
 */

export type AuthPhase = "anonymous" | "authenticating" | "challenge" | "authenticated";

export interface AuthState {
  phase: AuthPhase;
  /** TOTP challenge id while in the `challenge` phase. */
  challengeId: string | null;
  /** Human-readable error for the last failed attempt (cleared on retry). */
  error: string | null;
  /** Whether the sign-in overlay is on screen. */
  overlayOpen: boolean;
  /** True right after a 401 invalidated a previously stored session. */
  sessionExpired: boolean;
}

export type AuthEvent =
  | { type: "OPEN_OVERLAY" }
  | { type: "CLOSE_OVERLAY" }
  | { type: "SUBMIT" }
  | { type: "CHALLENGE"; challengeId: string }
  | { type: "SUCCESS" }
  | { type: "FAILURE"; message: string }
  | { type: "SESSION_RESTORED" }
  | { type: "UNAUTHORIZED" }
  | { type: "LOGOUT" };

export const initialAuthState: AuthState = {
  phase: "anonymous",
  challengeId: null,
  error: null,
  overlayOpen: false,
  sessionExpired: false,
};

export function authReducer(state: AuthState, event: AuthEvent): AuthState {
  switch (event.type) {
    case "OPEN_OVERLAY":
      return { ...state, overlayOpen: true, error: null };
    case "CLOSE_OVERLAY":
      return { ...state, overlayOpen: false, error: null };
    case "SUBMIT":
      return { ...state, phase: "authenticating", error: null };
    case "CHALLENGE":
      return { ...state, phase: "challenge", challengeId: event.challengeId, error: null };
    case "SUCCESS":
      return {
        ...state,
        phase: "authenticated",
        challengeId: null,
        error: null,
        overlayOpen: false,
        sessionExpired: false,
      };
    case "FAILURE":
      // A failed attempt lands back on the form (not "anonymous") so the
      // user can correct the input without the overlay closing.
      return {
        ...state,
        phase: state.challengeId ? "challenge" : "anonymous",
        error: event.message,
      };
    case "SESSION_RESTORED":
      return { ...state, phase: "authenticated", sessionExpired: false };
    case "UNAUTHORIZED":
      // Any 401 (data query, /auth/me) re-opens the sign-in overlay;
      // read-only pages stay rendered underneath so loopback browsing
      // without a session keeps working after dismissal. Suppressed while a
      // login/verify round-trip is in flight — its FAILURE event already
      // surfaces the error on the form (a rejected login also 401s).
      if (state.phase === "authenticating") return state;
      return {
        ...state,
        phase: "anonymous",
        challengeId: null,
        overlayOpen: true,
        sessionExpired: true,
      };
    case "LOGOUT":
      return { ...initialAuthState, overlayOpen: false };
  }
}
