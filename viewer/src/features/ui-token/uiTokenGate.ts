import { clearUiToken, setUiToken } from "@/gateway/uiToken";
import type { UiTokenVerifyResult } from "@/gateway/uiToken";
import { isApiError } from "@/lib/errors";

/**
 * Framework-free state machine of the Ф3 ui-token gate (the provider is a
 * thin React wrapper around it — this class is what unit tests drive).
 *
 *   closed ──openLogin───────────────────────▶ open(manual, no run queued)
 *   closed ──run without token───────────────▶ open(required, run queued)
 *   closed ──run, 401 mid-flight─────────────▶ probe; dead → open(rejected,
 *                                              run queued); live → replay
 *   open   ──submitToken(server 200)─────────▶ closed → queued run re-runs
 *   open   ──submitToken(server 401/429/503)─▶ open(rejected at the door,
 *                                              NOTHING stored)
 *   open   ──dismiss─────────────────────────▶ closed → queued run dropped
 *
 * One window, three reasons: `manual` is the TopBar «Войти» (no action
 * pending — plain sign-in), `required` is a deferred mutation (the window
 * shows the "your action will continue" line), `rejected` is a server-side
 * refusal — either at the door (verify 401, ADR 0014 Ф1) or mid-flight
 * (a stale stored token, the «сессия истекла» case; `rejectKind` tells the
 * dialog which text to show).
 *
 * Token presence is INJECTED (`hasToken`) so the adapter owns the policy:
 * BoardAdapter answers from sessionStorage OR a live `vesmaro_ui` cookie
 * (boot probe, ADR 0014 Ф2); MockAdapter answers true (the dev playground
 * has no auth wall — mutations run without the window).
 *
 * Server verification is INJECTED too (`verifyToken`): when present, a
 * submit goes over the wire BEFORE anything is stored — the false-success
 * login (paste → stored → boom on first mutation) is gone. Without the
 * injection (mock adapter, SSR harnesses, legacy tests) the gate keeps the
 * historical paste-and-store behavior. The re-probe (`probe`) fires in the
 * 401 branch BEFORE the window opens: a stale header token beside a live
 * cookie must replay on the cookie leg, not re-prompt (the incident's
 * mid-flight beat).
 */

export type UiTokenWindowReason = "manual" | "required" | "rejected";

/** Which refusal text the dialog shows (two distinct beats, ADR 0014). */
export type UiTokenRejectKind = "verify" | "session";

/**
 * Session-feedback events (fix/login-feedback): the machine announces the two
 * transitions a human wants CONFIRMED — a submitted token actually landed in
 * storage (`loginStored`, with the server's honest class verdict) and the
 * server refused it mid-flight (`tokenRejected`). Consumers subscribe via
 * `listen()` (the provider translates these into toasts); the machine itself
 * stays UI-free.
 */
export type UiTokenGateEvent =
  | { type: "loginStored"; tokenClass: "ui" | "legacy" }
  | { type: "tokenRejected" };

export interface UiTokenGateState {
  /** Login-window visibility. */
  open: boolean;
  /** Why the window is up — drives the contextual line and inline error. */
  reason: UiTokenWindowReason;
  /** Mirrors the injected hasToken() after every transition. */
  tokenPresent: boolean;
  /**
   * Server verify in flight (ADR 0014 Ф1) — the dialog disables the submit
   * for its duration. Present only between submitToken and the verdict.
   */
  verifyPending?: boolean;
  /** Which inline refusal text applies ("verify" = refused at the door,
   * "session" = the mid-flight «сессия истекла»). */
  rejectKind?: UiTokenRejectKind;
  /** Server-provided detail for the rejected case (owner feedback
   * 2026-09-22: «the bearer is a machine-class token — this action
   * requires VESMARO_UI_TOKEN» beats a generic "not accepted"). */
  rejectDetail?: string;
}

type Listener = (state: UiTokenGateState) => void;
type EventListener = (event: UiTokenGateEvent) => void;

interface QueuedRun {
  run: () => Promise<void>;
  onDeferred?: () => void;
}

export interface UiTokenGateOptions {
  /** "Is a ui token available right now?" — adapter policy, injected. */
  hasToken: () => boolean;
  /** ADR 0014 Ф1: server verify at the door. Absent → legacy
   * paste-and-store (mock adapter / SSR harnesses). */
  verifyToken?: (value: string) => Promise<UiTokenVerifyResult>;
  /** ADR 0014 Ф2: probe of the live `vesmaro_ui` cookie — used once per
   * 401 mid-flight, before the window may open. Absent → the window
   * opens immediately (the historical behavior). */
  probe?: () => Promise<boolean>;
}

export class UiTokenGate {
  private readonly hasToken: () => boolean;
  private readonly verifyToken?: (value: string) => Promise<UiTokenVerifyResult>;
  private readonly probe?: () => Promise<boolean>;
  private readonly listeners = new Set<Listener>();
  private readonly eventListeners = new Set<EventListener>();
  private state: UiTokenGateState;
  private pending: QueuedRun | null = null;

  constructor(options: UiTokenGateOptions) {
    this.hasToken = options.hasToken;
    this.verifyToken = options.verifyToken;
    this.probe = options.probe;
    this.state = {
      open: false,
      reason: "manual",
      tokenPresent: options.hasToken(),
    };
  }

  /** Subscribe to session-feedback events; returns the unsubscribe. */
  listen(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  getState(): UiTokenGateState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Run a mutation callback under the gate. The callback owns its success
   * and non-401 failure handling; it MUST rethrow ApiError 401 so the gate
   * can take over. `onDeferred` fires when the run is QUEUED (window opens)
   * instead of executed — spinner owners reset there.
   */
  runAuthorized(run: () => Promise<void>, onDeferred?: () => void): void {
    void this.guard(run, onDeferred);
  }

  /** TopBar «Войти»: open the window WITHOUT queueing anything. */
  openLogin(): void {
    this.pending = null; // a manual sign-in never resurrects a dropped run
    this.setState({ open: true, reason: "manual" });
  }

  /**
   * Handle a pasted token. With `verifyToken` injected (ADR 0014 Ф1) the
   * value goes to the server FIRST: success stores it and retries any
   * queued run; a refusal keeps the window open with NOTHING stored and
   * no `loginStored` emitted — the false-success login is gone. Without
   * the injection the historical paste-and-store path applies.
   */
  submitToken(value: string): void {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    if (this.state.verifyPending) return; // one verify in flight at a time
    if (!this.verifyToken) {
      this.storeTokenAndClose(trimmed, "ui");
      return;
    }
    this.setState({
      verifyPending: true,
      rejectKind: undefined,
      rejectDetail: undefined,
    });
    void this.verifyAndApply(trimmed);
  }

  /** Esc / «continue read-only»: drop the queued run, close the window. */
  dismiss(): void {
    this.pending = null;
    this.setState({ open: false });
  }

  /** TopBar logout: drop token + any queued run, flip to read-only. The
   * SERVER-side cookie teardown is the provider's job (it owns the wire —
   * DELETE /api/auth/ui-token — and reports its failures). */
  logout(): void {
    clearUiToken();
    this.pending = null;
    this.setState({ tokenPresent: this.hasToken() });
  }

  /**
   * Boot hydration (ADR 0014 Ф2): re-sample the injected hasToken() after
   * the adapter's cookie probe resolved — a live `vesmaro_ui` cookie flips
   * tokenPresent (and keeps the login window closed) with no user action.
   */
  refreshPresence(): void {
    this.setState({ tokenPresent: this.hasToken() });
  }

  private async verifyAndApply(value: string): Promise<void> {
    let result: UiTokenVerifyResult;
    try {
      result = await this.verifyToken!(value);
    } catch (error) {
      // Refused at the door: the window STAYS OPEN, nothing is stored,
      // no loginStored — the rejection is the verdict (class-aware detail
      // from the server when it is a real 401).
      this.setState({
        verifyPending: false,
        open: true,
        reason: "rejected",
        rejectKind: "verify",
        rejectDetail:
          isApiError(error) && !error.message.startsWith("401")
            ? error.message
            : undefined,
      });
      return;
    }
    this.setState({ verifyPending: false });
    this.storeTokenAndClose(value, result.tokenClass);
  }

  private storeTokenAndClose(
    value: string,
    tokenClass: "ui" | "legacy",
  ): void {
    setUiToken(value);
    this.setState({
      open: false,
      tokenPresent: this.hasToken(),
      rejectKind: undefined,
      rejectDetail: undefined,
    });
    // Storage may be unavailable (fail-soft) — only a token that actually
    // landed counts as a login for feedback purposes.
    if (this.state.tokenPresent) this.emit({ type: "loginStored", tokenClass });
    const queued = this.pending;
    this.pending = null;
    if (queued) void this.guard(queued.run, queued.onDeferred);
  }

  private async guard(
    run: () => Promise<void>,
    onDeferred?: () => void,
    isReplay = false,
  ): Promise<void> {
    if (!this.hasToken()) {
      this.pending = onDeferred ? { run, onDeferred } : { run };
      this.setState({ open: true, reason: "required", tokenPresent: false });
      onDeferred?.();
      return;
    }
    try {
      await run();
    } catch (error) {
      if (!isApiError(error) || error.status !== 401) return; // callback's business
      // Stale/rejected credential: queue the same run for a retry behind a
      // fresh value. ADR 0014 Ф2 re-probe FIRST (never on a replay — that
      // cannot loop): a live cookie beside the stale header token means
      // the run replays on the cookie leg and the window must NOT open
      // (the second-login-elsewhere rotation case, the incident's
      // mid-flight beat).
      if (!isReplay && this.probe && (await this.probe())) {
        clearUiToken(); // the stored header value is stale by definition
        this.pending = null;
        this.setState({
          open: false,
          reason: "rejected",
          tokenPresent: this.hasToken(),
          rejectKind: undefined,
          rejectDetail: undefined,
        });
        void this.guard(run, onDeferred, true);
        return;
      }
      clearUiToken();
      this.pending = onDeferred ? { run, onDeferred } : { run };
      this.setState({
        open: true,
        reason: "rejected",
        tokenPresent: false,
        rejectKind: "session",
        // The FastAPI detail rides error.message (http.extractErrorMessage);
        // the generic "401 Unauthorized" fallback stays hidden — the dialog
        // already says (401) in the localized line.
        rejectDetail:
          isApiError(error) && !error.message.startsWith("401")
            ? error.message
            : undefined,
      });
      this.emit({ type: "tokenRejected" });
      onDeferred?.();
    }
  }

  private setState(patch: Partial<UiTokenGateState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener(this.state);
  }

  /** Session-feedback sink — failures must never break the gate itself. */
  private emit(event: UiTokenGateEvent): void {
    for (const listener of [...this.eventListeners]) {
      try {
        listener(event);
      } catch {
        // A throwing feedback handler (e.g. a test double) stays the
        // handler's business; the state machine continues regardless.
      }
    }
  }
}
