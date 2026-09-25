/**
 * Kora mock adapter — the ONLY KoraGateway implementation of week 0
 * (ADR 0019 rev.2 «Неделя 0 — контракт-first»: UI mocks, NO backend).
 *
 * Beyond serving fixtures it models the two behaviours the ADR pins, so the
 * UI mocks exercise the real interaction contract:
 *
 * - STORE-TAIL semantics (§3): sendMessage appends to an in-memory per-
 *   session store and bumps the seq cursor — the transcript is then re-read
 *   via getTranscript(after_seq), exactly how chat v1 works against the
 *   future backend («перечитывание хвоста стора»).
 * - STEP-UP PIN (§4 / gate 7): steering calls throw KoraStepUpRequired
 *   while the PIN is inactive; enableStepUp opens a TTL window (~15 min).
 */
import { KoraError, type KoraGateway } from "./koraGateway";
import {
  KORA_FIXTURE_SESSIONS,
  KORA_FIXTURE_TRANSCRIPT,
  KORA_FIXTURE_COVERAGE,
} from "./koraFixtures";
import type {
  KoraMessageAccepted,
  KoraSession,
  KoraSessionCreate,
  KoraSessionCreated,
  KoraSessionsList,
  KoraStepUpStatus,
  KoraTranscript,
  KoraTranscriptItem,
} from "./koraTypes";

/**
 * Typed error carrying the frozen KoraErrorCode vocabulary (KoraErrorOut).
 * P4-4: extends the SEAM's KoraError (koraGateway.ts) so the UI branches
 * on the contract class, never on the concrete adapter — the HTTP swap
 * keeps the PIN/step-up screens intact.
 */
export class KoraMockError extends KoraError {
  constructor(
    code:
      | "unauthorized"
      | "metadata_only"
      | "step_up_required"
      | "step_up_denied"
      | "session_not_found"
      | "host_conflict"
      | "validation",
    message: string,
  ) {
    super(code, message);
    this.name = "KoraMockError";
  }
}

/** Step-up window length in the mock (the contract caps TTL at 900s). */
const STEP_UP_TTL_SECONDS = 900;

export interface KoraMockAdapterOptions {
  /** Disable the artificial latency for snapshot/renderToString tests. */
  latency?: boolean;
  /** Start with steering already unlocked (status-page mock). */
  stepUpActive?: boolean;
}

export class KoraMockAdapter implements KoraGateway {
  private readonly latency: boolean;
  /** The mock "store tail": per-session transcript + seq cursor. */
  private readonly store: Map<string, KoraTranscriptItem[]>;
  private readonly sessions: Map<string, KoraSession>;
  private stepUpUntil: number | null;

  constructor(options: KoraMockAdapterOptions = {}) {
    this.latency = options.latency ?? true;
    this.store = new Map(
      Object.entries(KORA_FIXTURE_TRANSCRIPT).map(([id, items]) => [id, [...items]]),
    );
    this.sessions = new Map(KORA_FIXTURE_SESSIONS.map((s) => [s.id, { ...s }]));
    this.stepUpUntil = options.stepUpActive
      ? Date.now() + STEP_UP_TTL_SECONDS * 1000
      : null;
  }

  private delay(): Promise<void> {
    return this.latency
      ? new Promise((resolve) => setTimeout(resolve, 120))
      : Promise.resolve();
  }

  private requireStepUp(): void {
    if (this.stepUpUntil === null || this.stepUpUntil <= Date.now()) {
      this.stepUpUntil = null;
      throw new KoraMockError(
        "step_up_required",
        "Руление заблокировано: введите PIN, чтобы включить руление (TTL ≤ 15 минут).",
      );
    }
  }

  listSessions(): Promise<KoraSessionsList> {
    return this.delay().then(() => ({
      ok: true as const,
      count: this.sessions.size,
      items: [...this.sessions.values()],
      coverage: structuredClone(KORA_FIXTURE_COVERAGE),
      meta: { generated_at: "2026-09-24T11:45:00Z" },
    }));
  }

  async getSession(sessionId: string): Promise<KoraSession | null> {
    await this.delay();
    return this.sessions.get(sessionId) ?? null;
  }

  async getTranscript(
    sessionId: string,
    params?: { after_seq?: number; limit?: number },
  ): Promise<KoraTranscript> {
    await this.delay();
    const items = this.store.get(sessionId);
    if (items === undefined) {
      // Unknown session resolves as 404-shaped (provenance-safe absence).
      throw new KoraMockError(
        "session_not_found",
        `Сессия ${sessionId} не найдена в реестре.`,
      );
    }
    const afterSeq = params?.after_seq ?? 0;
    const limit = Math.min(Math.max(params?.limit ?? 50, 1), 200);
    const tail = items.filter((item) => item.seq > afterSeq);
    const page = tail.slice(0, limit);
    return {
      session_id: sessionId,
      items: page,
      next_after_seq: page.length > 0 ? page[page.length - 1].seq : afterSeq,
      has_more: tail.length > page.length,
    };
  }

  async createSession(body: KoraSessionCreate): Promise<KoraSessionCreated> {
    await this.delay();
    this.requireStepUp();
    if (!body.executor_id || !body.project || !body.prompt) {
      throw new KoraMockError("validation", "Нужны executor, проект и первый промпт.");
    }
    const now = new Date().toISOString();
    const nativeId = `sess_${Math.random().toString(16).slice(2, 9)}`;
    const id = `${body.executor_id}:${nativeId}`;
    const session: KoraSession = {
      id,
      executor_id: body.executor_id,
      native_id: nativeId,
      harness: "zcode",
      project: body.project,
      cwd: null,
      state: "live",
      origin: "relay", // new-from-phone = relay origin by construction
      steerable: true,
      started_at: now,
      last_activity_at: now,
      age_seconds: 0,
      last_line_preview: body.prompt.slice(0, 160),
    };
    this.sessions.set(id, session);
    this.store.set(id, [
      {
        seq: 1,
        role: "user",
        kind: null,
        ts: now,
        content: body.prompt,
        redaction_applied: false,
      },
    ]);
    return {
      ok: true,
      session,
      delivery: {
        status: "delivered",
        queued_at: now,
        delivered_at: now,
        retryable: false,
        error: null,
      },
    };
  }

  async sendMessage(sessionId: string, text: string): Promise<KoraMessageAccepted> {
    await this.delay();
    this.requireStepUp();
    const session = this.sessions.get(sessionId);
    const items = this.store.get(sessionId);
    if (!session || !items) {
      // Foreign triple → 404, server-side honesty (ADR gate 1).
      throw new KoraMockError(
        "session_not_found",
        `Сессия ${sessionId} не найдена в реестре.`,
      );
    }
    if (!session.steerable) {
      throw new KoraMockError(
        "session_not_found",
        `Сессия ${sessionId} не доступна для руления.`,
      );
    }
    // STORE-TAIL: the harness (mocked) appends; the UI re-reads the tail.
    const now = new Date().toISOString();
    const seq = (items.at(-1)?.seq ?? 0) + 1;
    items.push({
      seq,
      role: "user",
      kind: null,
      ts: now,
      content: text,
      redaction_applied: false,
    });
    // The generated contract types are immutable (--immutable codegen), so
    // the row update is a replace, not a property mutation.
    this.sessions.set(sessionId, {
      ...session,
      last_activity_at: now,
      last_line_preview: text.slice(0, 160),
    });
    // Simulated harness turn — the tail grows again after the prompt.
    items.push({
      seq: seq + 1,
      role: "assistant",
      kind: null,
      ts: now,
      content: "Промпт принят релеем: продолжаю в headless-сессии (мок недели 0).",
      redaction_applied: false,
    });
    return {
      ok: true,
      session_id: sessionId,
      delivery: {
        status: "delivered",
        queued_at: now,
        delivered_at: now,
        retryable: false,
        error: null,
      },
      confirm_required: true, // confirm-mode is the default
    };
  }

  async stepUpStatus(): Promise<KoraStepUpStatus> {
    await this.delay();
    const remaining = this.stepUpRemainingSeconds();
    return {
      active: remaining !== null,
      granted_until:
        remaining !== null
          ? new Date(Date.now() + remaining * 1000).toISOString()
          : null,
      ttl_remaining_seconds: remaining,
    };
  }

  async enableStepUp(pin: string): Promise<KoraStepUpStatus> {
    await this.delay();
    if (pin !== "4321") {
      throw new KoraMockError("step_up_denied", "Неверный PIN.");
    }
    this.stepUpUntil = Date.now() + STEP_UP_TTL_SECONDS * 1000;
    return this.stepUpStatus();
  }

  async revokeStepUp(): Promise<void> {
    await this.delay();
    this.stepUpUntil = null;
  }

  private stepUpRemainingSeconds(): number | null {
    if (this.stepUpUntil === null) return null;
    const remaining = Math.ceil((this.stepUpUntil - Date.now()) / 1000);
    if (remaining <= 0) {
      this.stepUpUntil = null;
      return null;
    }
    return Math.min(remaining, STEP_UP_TTL_SECONDS);
  }
}
