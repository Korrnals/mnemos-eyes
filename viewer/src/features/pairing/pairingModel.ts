import type { PairingCreatedResult } from "@/gateway/boardTypes";

/**
 * Pure model of the QR-pairing UI (CV-7, ADR 0012). Framework-free and
 * node-testable, per the tags/model.ts and agents/enrollment.ts canon:
 *
 * - `pairingDialogReducer` — the owner dialog's state machine
 *   (creating → created → requested → confirmed/… terminal). SSE frames and
 *   wire answers are EVENTS; every transition is explicit and honest.
 * - `effectivePairingState` — the VIEW state of a pairing: a live row past
 *   its expires_at reads «истёк» even before the TTL sweep / SSE frame
 *   arrives (the enrollment rule, mirrored).
 * - `formatPairingCountdown` / `pairingTtlFraction` — mm:ss + the 0..1 arc
 *   fraction off the shared 1 Hz ticker.
 * - `pairingUrl` / `mountPrefixFromPathname` / `readPairingCodeFromHash` —
 *   the device-URL contract: token in the FRAGMENT, never in a query string
 *   (§2.2/§9 — fragments do not reach server logs or referrers).
 * - `platformFromUserAgent` — the honest default for the device name field.
 */

// --- Lifecycle -----------------------------------------------------------------

/** Server pairing states (ADR 0012 §10.1) as the UI narrows them. */
export type PairingLifecycle =
  | "created"
  | "scanned"
  | "confirmed"
  | "issued"
  | "expired"
  | "revoked";

/**
 * View state: wire state wins, except a LIVE row (created/scanned/confirmed)
 * whose TTL has passed — the sweeper may not have fired yet, and showing a
 * scan-inviting QR over a dead code would be a lie.
 */
export function effectivePairingState(
  row: { state: string; expires_at: string },
  now: number,
): PairingLifecycle {
  const state = row.state as PairingLifecycle;
  if (state === "issued" || state === "expired" || state === "revoked") {
    return state;
  }
  const at = Date.parse(row.expires_at);
  if (!Number.isFinite(at)) return state;
  return now >= at ? "expired" : state;
}

/** Mono countdown for a live pairing ("02:31"); null when not live. */
export function formatPairingCountdown(expiresAt: string, now: number): string | null {
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return null;
  const totalS = Math.floor((at - now) / 1000);
  if (totalS <= 0) return null;
  const minutes = Math.floor(totalS / 60);
  const seconds = totalS % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Remaining-TTL fraction (0..1) for the countdown arc. `startedAtMs` is the
 * client clock reading taken when the 201 landed — the server does not send
 * created_at on the create answer, and the TTL arc needs an honest origin
 * (the pairing's OWN window, not a hardcoded 3 minutes).
 */
export function pairingTtlFraction(
  startedAtMs: number,
  expiresAt: string,
  now: number,
): number {
  const at = Date.parse(expiresAt);
  // startedAtMs <= 0 is the "no origin recorded yet" sentinel (SSR/first
  // render) — an arc without its start is zero, never a wrong fraction.
  if (!Number.isFinite(at) || startedAtMs <= 0 || at <= startedAtMs) {
    return 0;
  }
  const fraction = (at - now) / (at - startedAtMs);
  if (!Number.isFinite(fraction)) return 0;
  return Math.min(1, Math.max(0, fraction));
}

// --- Dialog state machine -------------------------------------------------------

/**
 * The owner-dialog phases. Terminal phases (denied / cancelled / expired /
 * revoked / failed) render their honest «начните заново» copy; only
 * `restart` leaves them.
 */
export type PairingDialogPhase =
  | "creating"
  | "created"
  | "requested"
  | "confirmed"
  | "denied"
  | "cancelled"
  | "expired"
  | "revoked"
  | "failed";

export interface PairingDialogState {
  readonly phase: PairingDialogPhase;
  /** The 201 answer — code/verify live HERE only (owner leg, §2.1). */
  readonly created?: PairingCreatedResult;
  /** The trusted-side status view (device_name, source_ip) once scanned. */
  readonly scannedDeviceName?: string;
  readonly scannedSourceIp?: string;
  /** Client clock at the 201 — the TTL arc's origin. */
  readonly startedAtMs?: number;
  /** Server-provided detail for the failed phase (toasts carry the title). */
  readonly errorMessage?: string;
  /** True while a confirm/cancel decision POST is in flight. */
  readonly deciding?: boolean;
}

export const initialPairingDialogState: PairingDialogState = {
  phase: "creating",
};

export type PairingDialogEvent =
  | { type: "restart" }
  | { type: "created"; result: PairingCreatedResult; nowMs: number }
  | { type: "scanned"; deviceName: string; sourceIp: string }
  | { type: "confirmSettled"; outcome: string }
  | { type: "cancelSettled" }
  | { type: "deciding"; deciding: boolean }
  | { type: "expired" }
  | { type: "revoked" }
  | { type: "failed"; message?: string };

const TERMINAL: readonly PairingDialogPhase[] = [
  "denied",
  "cancelled",
  "expired",
  "revoked",
  "failed",
];

/** Live phases where external transitions (SSE / TTL) still apply. */
const LIVE: readonly PairingDialogPhase[] = ["created", "requested"];

/**
 * The reducer. Rules (ADR 0012 §10.1):
 * - `restart` works from EVERY phase — the owner never gets trapped;
 * - `expired`/`revoked` land only on live phases (a terminal dialog never
 *   resurrects into another terminal);
 * - `confirmSettled` maps the server's outcome word: confirmed → the wait
 *   screen, denied → the honest refusal state; an `idempotent` repeat keeps
 *   the current phase (the wire answered, nothing changed);
 * - `scanned` upgrades created → requested and carries the SELF-ASSERTED
 *   identity + source IP the owner actually decides on (§3.6).
 */
export function pairingDialogReducer(
  state: PairingDialogState,
  event: PairingDialogEvent,
): PairingDialogState {
  switch (event.type) {
    case "restart":
      return { ...initialPairingDialogState, phase: "creating" };
    case "created":
      return {
        phase: "created",
        created: event.result,
        startedAtMs: event.nowMs,
      };
    case "scanned":
      if (state.phase !== "created") return state;
      return {
        ...state,
        phase: "requested",
        scannedDeviceName: event.deviceName,
        scannedSourceIp: event.sourceIp,
      };
    case "confirmSettled":
      if (state.phase !== "requested") return state;
      if (event.outcome === "confirmed") return { ...state, phase: "confirmed" };
      if (event.outcome === "denied") return { ...state, phase: "denied" };
      return state;
    case "cancelSettled":
      if (state.phase !== "created" && state.phase !== "requested") return state;
      return { ...state, phase: "cancelled" };
    case "deciding":
      return { ...state, deciding: event.deciding };
    case "expired":
      if (!LIVE.includes(state.phase) && state.phase !== "creating") return state;
      return { ...state, phase: "expired" };
    case "revoked":
      if (!LIVE.includes(state.phase)) return state;
      return { ...state, phase: "revoked" };
    case "failed":
      if (TERMINAL.includes(state.phase)) return state;
      return {
        ...state,
        phase: "failed",
        errorMessage: event.message,
      };
  }
}

// --- Device-URL contract (§2.2/§9: token in the FRAGMENT) ------------------------

/**
 * The URL the QR encodes: `<origin><prefix>/pair#t=<code>`. `mountPrefix`
 * comes from `mountPrefixFromPathname` (the same rule the router basename
 * uses) so the link works both at the root (Ф4 flip) and under /app.
 */
export function pairingUrl(origin: string, code: string, mountPrefix = ""): string {
  return `${origin}${mountPrefix}/pair#t=${encodeURIComponent(code)}`;
}

/**
 * Where the SPA is mounted, mirroring `routerBasename` (adapterConfig.ts):
 * a page opened under /app keeps the /app prefix, anything else mounts at
 * the root. Pure over the pathname so tests drive it directly.
 */
export function mountPrefixFromPathname(pathname: string): string {
  return pathname.startsWith("/app") ? "/app" : "";
}

/**
 * Read the single-use code from a /pair URL's fragment. Accepts both the
 * shipped shape (`#t=<code>`) and the ADR §2.2 draft shape
 * (`#/pair?t=<code>`) — same param, same fragment rules. Returns null when
 * no code is present (the manual-entry form takes over).
 */
export function readPairingCodeFromHash(hash: string): string | null {
  if (hash.length <= 1) return null;
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw.startsWith("/")) {
    // Draft shape: /pair?t=<code> (possibly with more path segments).
    const queryStart = raw.indexOf("?");
    if (queryStart === -1) return null;
    return codeFromQuery(raw.slice(queryStart + 1));
  }
  return codeFromQuery(raw);
}

function codeFromQuery(query: string): string | null {
  const params = new URLSearchParams(query);
  const code = params.get("t");
  return code && code.length > 0 ? code : null;
}

/**
 * The cleaned location URL after the first exchange (ADR §2.2): the code
 * leaves the history the moment it has been PRESENTED — back-button must
 * never re-offer a spent code. Pure over the location parts.
 */
export function locationWithoutHash(pathname: string, search: string): string {
  return `${pathname}${search}`;
}

// --- Device-side helpers ---------------------------------------------------------

/**
 * Coarse platform label from the UA string — the DEFAULT for the
 * self-asserted device name, honest about being a guess. Returns "" when
 * nothing matches (the field stays empty and the server stores «без имени»).
 */
export function platformFromUserAgent(userAgent: string): string {
  const ua = userAgent;
  if (/iphone|ipad|ipod/i.test(ua)) return "iOS";
  if (/android/i.test(ua)) return "Android";
  if (/windows/i.test(ua)) return "Windows";
  if (/mac os x|macintosh/i.test(ua)) return "macOS";
  if (/linux/i.test(ua)) return "Linux";
  return "";
}

/**
 * The verify digits as an array (["3","7","4","1"]) — the dialog renders
 * them with visible separators and one aria-label per digit group, so the
 * «сверь четыре цифры» beat works spoken as well as seen.
 */
export function verifyDigits(verify: string): string[] {
  return verify.split("").filter((char) => char.trim().length > 0);
}
