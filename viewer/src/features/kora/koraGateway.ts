/**
 * Kora gateway seam (ADR 0019 rev.2 — week-0 contract-first).
 *
 * Same discipline as gateway/MemoryGateway.ts (architecture.md §4 — the
 * single data-access seam): every Kora component reads through this
 * interface. Week 0 ships EXACTLY ONE implementation — KoraMockAdapter
 * (fixtures; NO backend integration by contract). When slice 1 lands, a
 * KoraHttpAdapter implements the same interface against the frozen
 * docs/kora/openapi.yaml shapes and swaps in via the context provider.
 *
 * Every method takes an optional AbortSignal (TanStack Query cancellation).
 */
import type {
  KoraMessageAccepted,
  KoraSession,
  KoraSessionCreated,
  KoraSessionCreate,
  KoraSessionsList,
  KoraStepUpStatus,
  KoraTranscript,
  KoraTranscriptParams,
} from "./koraTypes";

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
