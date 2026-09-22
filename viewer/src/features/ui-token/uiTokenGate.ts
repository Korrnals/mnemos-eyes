import { clearUiToken, setUiToken } from "@/gateway/uiToken";
import { isApiError } from "@/lib/errors";

/**
 * Framework-free state machine of the Ф3 ui-token gate (the provider is a
 * thin React wrapper around it — this class is what unit tests drive).
 *
 *   closed ──openLogin───────────────────────▶ open(manual, no run queued)
 *   closed ──run without token───────────────▶ open(required, run queued)
 *   closed ──run, 401 mid-flight─────────────▶ open(rejected, run queued)
 *   open   ──submitToken(valid)──────────────▶ closed → queued run re-runs
 *   open   ──dismiss─────────────────────────▶ closed → queued run dropped
 *
 * One window, three reasons: `manual` is the TopBar «Войти» (no action
 * pending — plain sign-in), `required` is a deferred mutation (the window
 * shows the "your action will continue" line), `rejected` is a server-side
 * 401 on a stored token (inline error + the same queued retry).
 *
 * Token presence is INJECTED (`hasToken`) so the adapter owns the policy:
 * BoardAdapter answers from sessionStorage; MockAdapter answers true (the
 * dev playground has no auth wall — mutations run without the window).
 */

export type UiTokenWindowReason = "manual" | "required" | "rejected";

/**
 * Session-feedback events (fix/login-feedback): the machine announces the two
 * transitions a human wants CONFIRMED — a submitted token actually landed in
 * storage (`loginStored`), and the server refused it mid-flight (`tokenRejected`).
 * Consumers subscribe via `listen()` (the provider translates these into
 * toasts); the machine itself stays UI-free.
 */
export type UiTokenGateEvent = { type: "loginStored" } | { type: "tokenRejected" };

export interface UiTokenGateState {
  /** Login-window visibility. */
  open: boolean;
  /** Why the window is up — drives the contextual line and inline error. */
  reason: UiTokenWindowReason;
  /** Mirrors the injected hasToken() after every transition. */
  tokenPresent: boolean;
  /** Server-provided 401 detail for the rejected case (owner feedback
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
}

export class UiTokenGate {
  private readonly hasToken: () => boolean;
  private readonly listeners = new Set<Listener>();
  private readonly eventListeners = new Set<EventListener>();
  private state: UiTokenGateState;
  private pending: QueuedRun | null = null;

  constructor(options: UiTokenGateOptions) {
    this.hasToken = options.hasToken;
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

  /** Store the pasted token, close the window, retry the queued run. */
  submitToken(value: string): void {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    setUiToken(trimmed);
    this.setState({ open: false, tokenPresent: this.hasToken() });
    // Storage may be unavailable (fail-soft) — only a token that actually
    // landed counts as a login for feedback purposes.
    if (this.state.tokenPresent) this.emit({ type: "loginStored" });
    const queued = this.pending;
    this.pending = null;
    if (queued) void this.guard(queued.run, queued.onDeferred);
  }

  /** Esc / «continue read-only»: drop the queued run, close the window. */
  dismiss(): void {
    this.pending = null;
    this.setState({ open: false });
  }

  /** TopBar logout: drop token + any queued run, flip to read-only. */
  logout(): void {
    clearUiToken();
    this.pending = null;
    this.setState({ tokenPresent: this.hasToken() });
  }

  private async guard(
    run: () => Promise<void>,
    onDeferred?: () => void,
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
      // Stale/rejected token: drop it and queue the same run for a retry
      // behind a fresh value.
      clearUiToken();
      this.pending = onDeferred ? { run, onDeferred } : { run };
      this.setState({ open: true, reason: "rejected", tokenPresent: false,
                      rejectDetail: error.detail });
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
