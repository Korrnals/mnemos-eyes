/**
 * Kora HTTP adapter — slice 1 backend integration (ADR 0019 rev.2).
 *
 * Implements the SAME KoraGateway interface the week-0 mock served, now
 * against the frozen docs/kora/openapi.yaml shapes over the board API:
 *
 * - listSessions      GET    /api/kora/sessions                 (slice 1 — LIVE)
 * - getSession        derived from the listing (contract helper)
 * - getTranscript     GET    /api/kora/sessions/{id}/transcript (slice 2 — the
 *                      board does not serve it yet; the call fails loud
 *                      with the server's honest verdict, never a mock body)
 * - createSession / sendMessage / step-up     (slice 3 — same honest 501
 *                      discipline while the relay is unbuilt)
 *
 * Auth discipline mirrors BoardAdapter (gateway/BoardAdapter.ts): reads
 * ride the same-origin cookie leg by default — GET /api/kora/sessions
 * accepts the owner session; mutations attach the ui bearer when the
 * token panel holds one. Non-2xx maps to ApiError with the Kora error
 * vocabulary in `body.code` when present (`metadata_only`,
 * `step_up_required`, `session_not_found`, …).
 */
import type { KoraGateway } from "./koraGateway";
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
import type { KoraErrorCode } from "./koraTypes";
import { ApiError } from "@/lib/errors";
import { DEFAULT_TIMEOUT_MS, buildUrl } from "@/gateway/http";
import { getUiToken } from "@/gateway/uiToken";

export interface KoraHttpAdapterOptions {
  /** Board API base URL. Default "/api" (same-origin; Vite dev-proxy). */
  baseUrl?: string;
  /** Test seam — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Default per-request timeout. */
  timeoutMs?: number;
  /** Test seam for the ui-token source (BoardAdapter parity). */
  getUiTokenFn?: () => string;
}

interface KoraWireError {
  ok?: boolean;
  code?: string;
  message?: string;
}

export class KoraHttpAdapter implements KoraGateway {
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;
  private readonly getUiTokenFn: () => string;

  constructor(options: KoraHttpAdapterOptions = {}) {
    this.baseUrl = options.baseUrl ?? "/api";
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.getUiTokenFn = options.getUiTokenFn ?? getUiToken;
  }

  async listSessions(signal?: AbortSignal): Promise<KoraSessionsList> {
    return this.request<KoraSessionsList>("/kora/sessions", { signal });
  }

  async getSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<KoraSession | null> {
    // Registry-row helper derived from the listing (the week-0 mock kept
    // a map; the HTTP contract has no single-session GET in slice 1).
    const list = await this.listSessions(signal);
    return list.items.find((s) => s.id === sessionId) ?? null;
  }

  async getTranscript(
    sessionId: string,
    params?: KoraTranscriptParams,
    signal?: AbortSignal,
  ): Promise<KoraTranscript> {
    const query: Record<string, number> = {};
    if (params?.after_seq !== undefined) query.after_seq = params.after_seq;
    if (params?.limit !== undefined) query.limit = params.limit;
    return this.request<KoraTranscript>(
      `/kora/sessions/${encodeURIComponent(sessionId)}/transcript`,
      { query, signal, timeoutMs: this.timeoutMs },
    );
  }

  async createSession(
    body: KoraSessionCreate,
    signal?: AbortSignal,
  ): Promise<KoraSessionCreated> {
    return this.request<KoraSessionCreated>("/kora/sessions", {
      method: "POST",
      body,
      auth: true,
      signal,
    });
  }

  async sendMessage(
    sessionId: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<KoraMessageAccepted> {
    return this.request<KoraMessageAccepted>(
      `/kora/sessions/${encodeURIComponent(sessionId)}/messages`,
      { method: "POST", body: { text }, auth: true, signal },
    );
  }

  async stepUpStatus(signal?: AbortSignal): Promise<KoraStepUpStatus> {
    return this.request<KoraStepUpStatus>("/kora/steering/step-up", {
      auth: true,
      signal,
    });
  }

  async enableStepUp(pin: string, signal?: AbortSignal): Promise<KoraStepUpStatus> {
    return this.request<KoraStepUpStatus>("/kora/steering/step-up", {
      method: "POST",
      body: { pin },
      auth: true,
      signal,
    });
  }

  async revokeStepUp(signal?: AbortSignal): Promise<void> {
    await this.request<unknown>("/kora/steering/step-up", {
      method: "DELETE",
      auth: true,
      signal,
    });
  }

  /**
   * One JSON request: timeout composition, ui-bearer on mutations, and
   * non-2xx → ApiError carrying the Kora error code (the frozen
   * vocabulary) when the body speaks it.
   */
  private async request<T>(
    path: string,
    config: {
      method?: string;
      query?: Record<string, number | string>;
      body?: unknown;
      auth?: boolean;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const url = buildUrl(this.baseUrl, path, config.query);
    const headers: Record<string, string> = {};
    if (config.auth) {
      const token = this.getUiTokenFn();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    if (config.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs ?? this.timeoutMs);
    if (config.signal) {
      if (config.signal.aborted) controller.abort();
      else config.signal.addEventListener("abort", () => controller.abort());
    }

    let resp: Response;
    try {
      resp = await (this.fetchImpl ?? fetch)(url, {
        method: config.method ?? "GET",
        headers,
        body: config.body !== undefined ? JSON.stringify(config.body) : undefined,
        signal: controller.signal,
        credentials: "same-origin",
      });
    } catch (err) {
      if (timedOut) {
        throw new ApiError(0, `Kora request timed out: ${path}`, { url });
      }
      if (config.signal?.aborted) throw err;
      throw new ApiError(0, `Kora request failed: ${path}`, { url });
    } finally {
      clearTimeout(timer);
    }

    if (resp.status === 204) return undefined as T;
    let wire: unknown = null;
    try {
      wire = await resp.json();
    } catch {
      // non-JSON body — fall through to the status verdict
    }
    if (!resp.ok) {
      const errBody = (wire ?? {}) as KoraWireError;
      const message =
        errBody.message ?? `Kora ${path} failed: ${resp.status}`;
      throw new KoraHttpError(
        resp.status,
        message,
        errBody.code as KoraErrorCode | undefined,
        url,
      );
    }
    return wire as T;
  }
}

/**
 * ApiError + the frozen Kora error code when the server sent one. The UI
 * reads the code through the seam helper `koraErrorCode(err)` (single
 * instanceof-free extraction point) — never a concrete adapter class.
 * A transport-level failure (no code from the server) answers undefined:
 * honest absence, not a fake code.
 */
export class KoraHttpError extends ApiError {
  constructor(
    status: number,
    message: string,
    readonly koraCode?: KoraErrorCode,
    url?: string,
  ) {
    super(status, message, url ? { url } : undefined);
    this.name = "KoraHttpError";
  }
}