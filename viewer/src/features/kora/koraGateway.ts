/**
 * Kora gateway seam (ADR 0019 rev.2 — week-0 contract-first; slice 1 live).
 *
 * Same discipline as gateway/MemoryGateway.ts (architecture.md §4 — the
 * single data-access seam): every Kora component reads through this
 * interface. Week 0 shipped the mock; slice 1 added the HTTP adapter —
 * both implement the same contract and swap via the context provider.
 *
 * Every method takes an optional AbortSignal (TanStack Query cancellation).
 *
 * P4-4: the frozen error vocabulary (KoraErrorOut: code + message) lives
 * HERE, on the seam — the UI branches on `KoraError.code` (e.g. the
 * step_up_required chat plate and the PIN-failure message), so an adapter
 * that does not surface the code would silently degrade the screens.
 * Both adapters (mock + HTTP) throw subclasses of this type; consumers
 * must check `instanceof KoraError`, never a concrete adapter's class.
 */
import type {
  KoraErrorCode,
  KoraMessageAccepted,
  KoraSession,
  KoraSessionCreated,
  KoraSessionCreate,
  KoraSessionsList,
  KoraStepUpStatus,
  KoraTranscript,
  KoraTranscriptParams,
} from "./koraTypes";

/** Contract error: the frozen KoraErrorOut vocabulary on the seam. */
export class KoraError extends Error {
  constructor(
    readonly code: KoraErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KoraError";
  }
}

/**
 * Extract the frozen error code from ANY gateway failure (P4-4): the
 * mock's KoraError subclasses carry `.code`; the HTTP adapter's
 * KoraHttpError carries `.koraCode`; anything else (transport ApiError)
 * answers undefined. ONE extraction point — the UI never imports a
 * concrete adapter's error class.
 */
export function koraErrorCode(err: unknown): KoraErrorCode | undefined {
  if (err instanceof KoraError) return err.code;
  const code = (err as { koraCode?: KoraErrorCode } | null)?.koraCode;
  return typeof code === "string" ? code : undefined;
}

export interface KoraGateway {
  /** Slice 1 — GET /api/kora/sessions (list + coverage). */
  listSessions(signal?: AbortSignal): Promise<KoraSessionsList>;

  /** Slice 1 helper — one registry row (derived from the listing). */
  getSession(sessionId: string, signal?: AbortSignal): Promise<KoraSession | null>;

  /** Slice 2 — GET /api/kora/sessions/{id}/transcript (seq cursor tail). */
  getTranscript(
    sessionId: string,
    params?: KoraTranscriptParams,
    signal?: AbortSignal,
  ): Promise<KoraTranscript>;

  /** Slice 3 — POST /api/kora/sessions (new relay session from the phone). */
  createSession(
    body: KoraSessionCreate,
    signal?: AbortSignal,
  ): Promise<KoraSessionCreated>;

  /** Slice 3 — POST /api/kora/sessions/{id}/messages (prompt via relay). */
  sendMessage(
    sessionId: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<KoraMessageAccepted>;

  /** Slice 3 — GET /api/kora/steering/step-up (status). */
  stepUpStatus(signal?: AbortSignal): Promise<KoraStepUpStatus>;

  /** Slice 3 — POST /api/kora/steering/step-up (enable steering, TTL ≤15m). */
  enableStepUp(pin: string, signal?: AbortSignal): Promise<KoraStepUpStatus>;

  /** Slice 3 — DELETE /api/kora/steering/step-up (revoke now). */
  revokeStepUp(signal?: AbortSignal): Promise<void>;
}
