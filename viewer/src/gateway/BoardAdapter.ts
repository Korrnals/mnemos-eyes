import type { MemoryGateway } from "./MemoryGateway";
import { DEFAULT_TIMEOUT_MS, SEARCH_TIMEOUT_MS, buildUrl, requestJson } from "./http";
import type { RequestConfig } from "./http";
import { EventStream } from "./events";
import type { BoardEvent } from "./events";
import { ApiError } from "@/lib/errors";
import { getDeviceToken } from "./deviceToken";
import { getUiToken } from "./uiToken";
import type { UiTokenVerifyResult } from "./uiToken";
import type {
  ArchivePage,
  ArchiveParams,
  AssignmentCancelledResult,
  AssignmentCreateInput,
  AssignmentCreatedResult,
  AssignmentListParams,
  AssignmentsPage,
  AutomationStatus,
  BoardHealth,
  BoardHealthDetail,
  BoardHealthServer,
  BoardMemoryEnvelope,
  BoardSearchResponse,
  BoardSummary,
  BoardTask,
  ExecutionSettings,
  ExecutionSettingsInput,
  ExecutorPatchInput,
  ExecutorStateChangeResult,
  ExecutorsPage,
  EnrollmentCreateInput,
  EnrollmentCreatedResult,
  EnrollmentRevokeResult,
  EnrollmentsPage,
  HarnessCreateInput,
  HarnessesPage,
  HarnessStateResult,
  HookCreateInput,
  HookPatchInput,
  HookRule,
  HooksPage,
  InboxRefreshResult,
  LaunchesPage,
  LaunchesParams,
  DeviceRevokedResult,
  DevicesPage,
  MemoryPulse,
  MemoryPulseItem,
  MemoryPulseServerNote,
  MergedMemoriesPage,
  MergedMemoryListItem,
  MergedTags,
  PairingConfirmResult,
  PairingCreatedResult,
  PairingExchangeAwaiting,
  PairingExchangeInput,
  PairingIssuedResult,
  PairingStatus,
  PulseParams,
  RuleDeletedAck,
  ScheduleCreateInput,
  SchedulePatchInput,
  ScheduleRule,
  ScheduleRunResult,
  SchedulesPage,
  TagDrill,
  TagDrillMemory,
  TagDrillParams,
  TagDrillStoreError,
  TagDrillTask,
  TaskCreateInput,
  TaskHistory,
  TaskInbox,
  TaskMemories,
  TaskMutationAck,
  TaskPatchInput,
  TaskReports,
  TaskUnarchiveResult,
} from "./boardTypes";
import type {
  A2ASession,
  HealthStatus,
  ListMemoriesParams,
  Memory,
  Metrics,
  SearchParams,
  SearchResult,
  TagSummary,
  Trace,
} from "./types";

/**
 * Phase-0 convergence adapter (ADR 0011 §6): speaks the BOARD server's
 * merge-API, not the mnemos wire contract. Lives alongside HttpAdapter /
 * MockAdapter — the mnemos path stays untouched until the Ф1 auth rewrite.
 *
 * Base URL is same-origin "/api" (`VITE_BOARD_API_URL` overrides). Auth is
 * capability-scoped (see `identityTokenSource`): reads stay open through
 * Ф0–Ф2 (ADR 0011 §7) and ship bare unless a paired DEVICE attaches its
 * `mnd_…` identity (ADR 0012 §5); the ui token rides only `auth: true`
 * calls; the 401/unauthorized flag is never raised from this adapter.
 *
 * Wire contract (board-openapi-snapshot.json):
 * - search         GET /api/mnemos/search        ?q&limit&project&scope (proxied)
 * - listMemories   GET /api/memories             ?limit&cursor&scope&status&project&…
 * - getMemory      GET /api/memories/item/{id}   (first resolving server)
 * - listTags       GET /api/tags                 (aggregated, count DESC/name ASC)
 * - mergedTags     GET /api/tags                 (raw TagListOut: + errors[]/servers_scanned, UI-17 §6)
 * - drillTag       GET /api/tags/{tag}/drill     ?limit (tasks + memories subset, UI-17 §5)
 * - health         GET /api/health
 * - board          GET /api/board                ?status
 * - inbox          GET /api/tasks/inbox          ?scope&project&include_adopted
 * - reports        GET /api/tasks/{id}/reports   (chronological, Ф2)
 * - history        GET /api/tasks/{id}/history   (audit + memory timeline, Ф2)
 * - taskMemories   GET /api/tasks/{id}/memories  (resolved links, Ф2)
 * - archive        GET /api/archive              ?q&status&col&agent&project&limit&offset (Ф2)
 * - taskById       GET /api/board                (pick by id — no single GET exists)
 * - pulse          GET /api/memories/pulse       ?scope&project&limit (Ф1)
 * - boardHealth    GET /api/health               (per-store detail view, Ф1)
 * - events         GET /api/events               (SSE, see gateway/events.ts)
 *
 * Ф3 mutations (board-openapi-snapshot.json; all class-`ui` token-gated —
 * Bearer attached only when a ui token is stored, see gateway/uiToken.ts):
 * - createTask     POST   /api/tasks                        → 201 TaskOut
 * - patchTask      PATCH  /api/tasks/{id}                   → 200 TaskOut | 423
 * - moveTask       POST   /api/tasks/{id}/move              → 200 TaskOut
 * - archiveTask    POST   /api/tasks/{id}/archive           → 200 OkOut
 * - unarchiveTask  POST   /api/tasks/{id}/unarchive         → 200 UnarchiveOut
 * - adoptInboxItem POST   /api/tasks/inbox/{memory_id}/adopt → 201 TaskOut | 409
 * - refreshInbox   POST   /api/tasks/inbox/refresh          → 200 counters
 *
 * ADR 0014 owner session (one login per browser; cookie `vesmaro_ui` is
 * HttpOnly — set/reissued/cleared by the SERVER, never by this app):
 * - verifyUiToken  POST   /api/auth/ui-token → 200 {ok, token_class} | 401/429/503
 * - probeUiSession GET    /api/auth/ui-token → 204 live cookie | 401 none | 503
 * - logoutUiToken  DELETE /api/auth/ui-token → 204 (Set-Cookie Max-Age=0)
 *
 * AGW-1 agents domain (ARCH-9, ADR 0009 Amd 2 — reads open, writes ui-token):
 * - listAssignments      GET  /api/assignments                    ?state&task_id&executor_id
 * - createAssignment     POST /api/assignments                    → 201 | 404/422/409
 * - cancelAssignment     POST /api/assignments/{id}/cancel        → 200 | 409
 * - listExecutors        GET  /api/executors                      (meta: presence TTLs)
 * - patchExecutor        PATCH /api/executors/{id}                 → 200 | 404/409/422
 * - deleteExecutor       DELETE /api/executors/{id}                → 200 | 404
 * - getExecutionSettings GET  /api/settings/execution
 * - putExecutionSettings PUT  /api/settings/execution             → 200 | 422
 * SCHED-1 automation (ADR 0013 — hooks consume in a later wave):
 * - automationStatus     GET  /api/automation/status
 * - listSchedules        GET  /api/automation/schedules
 * - createSchedule       POST /api/automation/schedules           → 201 | 422
 * - patchSchedule        PATCH /api/automation/schedules/{id}     → 200 | 404/422
 * - deleteSchedule       DELETE /api/automation/schedules/{id}    → 200 (soft-disable)
 * - runScheduleNow       POST /api/automation/schedules/{id}/run  → 200 | 404/422/409
 * - listHooks / createHook / patchHook / deleteHook               (mirrors schedules)
 * - listLaunches         GET  /api/automation/launches            ?rule_id&kind&decision&limit&cursor
 *
 * CV-7 QR pairing + devices (ADR 0012; ui-token class EXCEPT the exchange leg):
 * - listDevices          GET    /api/devices                      (no token material)
 * - revokeDevice         DELETE /api/devices/{id}                 → 200 | 404
 * - createPairing        POST   /api/pairing                      → 201 code+verify | 429/503
 * - getPairing           GET    /api/pairing/{id}                 (trusted side; verify)
 * - confirmPairing       POST   /api/pairing/{id}/confirm {allow} → 200 idempotent | 409/410
 * - cancelPairing        DELETE /api/pairing/{id}                 → 200 | 409/410
 * - exchangePairing      POST   /api/pairing/exchange             NO auth (code = credential);
 *                                                                  202 awaiting | 200 issued (one-shot) |
 *                                                                  403 foreign IP | 404/410/429/503
 *
 * v0 honestly declares metrics / traces / sessions / agentRecall
 * unsupported (501) — they are mnemos-side views the merge API does not
 * expose yet; Ф1+ pages will consume board-native replacements.
 */

/** Merged-list parameters (ADR 0011 §11 cursor contract + native filters). */
export interface BoardListParams {
  limit?: number;
  /** Opaque cursor from a previous page's `next_cursor`. */
  cursor?: string;
  /** `'all'` (default) or one ACTIVE server name; unknown names → 404. */
  scope?: string;
  /** Native mnemos listing filters — pass through verbatim. */
  status?: string;
  project?: string;
  agent?: string;
  tags?: string;
  since?: string;
  until?: string;
}

/** Inbox read parameters (AGG-1, mirrors the server query contract). */
export interface InboxParams {
  /** `'all'` or one source server name. */
  scope?: string;
  /** Exact project match. */
  project?: string;
  /** Re-include rows that already produced a native task. */
  include_adopted?: boolean;
}

/**
 * The board-facing gateway surface: the viewer's `MemoryGateway` plus the
 * board-native reads (board, inbox) and the SSE capability (ADR 0011 §6 —
 * "BoardAdapter implements MemoryGateway (+ расширения: SSE, tasks)").
 */
export interface BoardGateway extends MemoryGateway {
  /** Board projection (`GET /api/board`). */
  board(status?: string, signal?: AbortSignal): Promise<BoardSummary>;
  /** AGG-1 inbox read (`GET /api/tasks/inbox`). */
  inbox(params?: InboxParams, signal?: AbortSignal): Promise<TaskInbox>;
  /** Cursor-paginated merged memory list (`GET /api/memories`). */
  listMemoriesPage(
    params?: BoardListParams,
    signal?: AbortSignal,
  ): Promise<MergedMemoriesPage>;
  /**
   * Aggregated tag listing WITH store honesty (`GET /api/tags` raw shape):
   * the `TagSummary`-projecting `listTags` drops `errors[]`/`servers_scanned`;
   * the tags cloud needs both for the partial-data line (UI-17 spec §6).
   */
  mergedTags(signal?: AbortSignal): Promise<MergedTags>;
  /** SSE stream on `/api/events` (see gateway/events.ts). */
  events(): EventStream;
  /** Merged recency feed (`GET /api/memories/pulse`, Ф1). */
  pulse(params?: PulseParams, signal?: AbortSignal): Promise<MemoryPulse>;
  /** Per-store health detail (`GET /api/health`, Ф1 Overview). */
  boardHealth(signal?: AbortSignal): Promise<BoardHealthDetail>;
  /**
   * Chronological report history for one task, oldest first
   * (`GET /api/tasks/{id}/reports`, Ф2).
   */
  reports(taskId: string, signal?: AbortSignal): Promise<TaskReports>;
  /** Merged audit + memory timeline (`GET /api/tasks/{id}/history`, Ф2). */
  history(taskId: string, signal?: AbortSignal): Promise<TaskHistory>;
  /** Resolved memory links of a task (`GET /api/tasks/{id}/memories`, Ф2). */
  taskMemories(taskId: string, signal?: AbortSignal): Promise<TaskMemories>;
  /** Filtered + paginated archive page (`GET /api/archive`, Ф2). */
  archive(params?: ArchiveParams, signal?: AbortSignal): Promise<ArchivePage>;
  /**
   * Single task lookup. The board API has NO per-id GET, so this is a
   * board-projection pick (`GET /api/board` + find); callers that live in
   * React should cache it through the shared `tasks.board` query key (one
   * wire call feeds the list and every detail page — see hooks/useTasks.ts).
   * Throws 404 when the id is neither on the board.
   */
  taskById(taskId: string, signal?: AbortSignal): Promise<BoardTask>;

  // --- Ф3 mutations (ui-token gated; see the class docblock) ------------------

  /**
   * True when a ui token is stored OR a live `vesmaro_ui` session cookie
   * was seen by the latest boot probe (ADR 0014 Ф2 — one login per
   * browser: a new tab holds no sessionStorage token but rides the cookie).
   */
  hasUiToken(): boolean;
  /**
   * Verify a pasted token against the server (ADR 0014 Ф1,
   * `POST /api/auth/ui-token`) — the gate calls this BEFORE storing
   * anything; a 401 (wrong value / machine-class token) surfaces as a
   * threshold rejection and nothing is persisted.
   */
  verifyUiToken(token: string): Promise<UiTokenVerifyResult>;
  /**
   * Boot/session probe (`GET /api/auth/ui-token`): resolves true iff the
   * server answered 204 (a live `vesmaro_ui` cookie). Also refreshes the
   * adapter's cookie-live flag that `hasUiToken` answers from.
   */
  probeUiSession(): Promise<boolean>;
  /** Server-side logout (`DELETE /api/auth/ui-token`, 204): an HttpOnly
   * cookie cannot be cleared from JS — the server must do it. */
  logoutUiToken(): Promise<void>;
  /** Create a native task (`POST /api/tasks`, 201 → TaskOut). */
  createTask(payload: TaskCreateInput): Promise<BoardTask>;
  /**
   * Patch content fields (`PATCH /api/tasks/{id}`). 423 Locked when the task
   * is older than 24h and `force` is not true (BE-12).
   */
  patchTask(taskId: string, patch: TaskPatchInput): Promise<BoardTask>;
  /** Move to a column, optionally at a position (`POST /api/tasks/{id}/move`). */
  moveTask(taskId: string, col: string, position?: number): Promise<BoardTask>;
  /** Archive (`POST /api/tasks/{id}/archive`). */
  archiveTask(taskId: string): Promise<TaskMutationAck>;
  /** Restore from the archive (`POST /api/tasks/{id}/unarchive`). */
  unarchiveTask(taskId: string): Promise<TaskUnarchiveResult>;
  /**
   * Adopt an inbox mirror row as a native task
   * (`POST /api/tasks/inbox/{memory_id}/adopt`). 409 on double adoption —
   * the error body carries the existing `task_id`.
   */
  adoptInboxItem(memoryId: string): Promise<BoardTask>;
  /** Force one synchronous inbox scan (`POST /api/tasks/inbox/refresh`). */
  refreshInbox(): Promise<InboxRefreshResult>;

  // --- AGW-1 agents domain (ARCH-9, ADR 0009 Amd 2; wire in the docblock) ------

  /**
   * Assignment queue (`GET /api/assignments`, open read). Every item carries
   * the computed `routing` annotation; `state` must be a dictionary value
   * (422 otherwise). `executor_id` is the presence piggyback, not a filter.
   */
  listAssignments(
    params?: AssignmentListParams,
    signal?: AbortSignal,
  ): Promise<AssignmentsPage>;
  /**
   * Queue an execution attempt (`POST /api/assignments`, ui-token, 201).
   * 404 unknown task; 422 archived/terminal task or unknown harness; 409
   * while another active assignment holds the task (≤1 invariant).
   */
  createAssignment(payload: AssignmentCreateInput): Promise<AssignmentCreatedResult>;
  /**
   * Cancel an assignment (`POST /api/assignments/{id}/cancel`, ui-token).
   * Legal from queued/claimed/running; `moved` reports the task column
   * return when the attempt had moved it to in-progress.
   */
  cancelAssignment(
    assignmentId: number,
    reason?: string,
  ): Promise<AssignmentCancelledResult>;
  /**
   * Executor registry (`GET /api/executors`, open read). Presence is
   * computed server-side per GET; the TTL constants and sweeper cadence
   * travel in `meta` — clients read them, never hardcode (spec §5.1).
   */
  listExecutors(signal?: AbortSignal): Promise<ExecutorsPage>;
  /**
   * Owner PATCH of one executor (`PATCH /api/executors/{id}`, ui-token;
   * AGW-4). approve (state=approved), revoke (TERMINAL kill-switch —
   * re-register instead; 409 on any attempt to leave revoked),
   * enable/disable (routing kill-switch), rename, owner-declared
   * capabilities. Idempotent: a no-op PATCH emits nothing server-side.
   */
  patchExecutor(
    executorId: string,
    patch: ExecutorPatchInput,
  ): Promise<ExecutorStateChangeResult>;
  /**
   * Remove the registry record (`DELETE /api/executors/{id}`, ui-token).
   * Hard delete: the executor's secret dies with the row (re-registration
   * mints a new one); active assignments deliberately keep their pins and
   * attribution strings (two-clock discipline, Amd 2 §3). 404 unknown id.
   */
  deleteExecutor(executorId: string): Promise<void>;
  /**
   * Mint a one-time enrollment token (`POST /api/executors/enrollment`,
   * ui-token; AGW-5 phase 2). 201 carries the `mne_…` plaintext EXACTLY
   * once (hash-only storage server-side); 409 live-token quota (≤3, no
   * auto-revoke — the owner chooses); 422 unknown harness_hint; 429 rate
   * 3/10 min per client; 503 fail-closed while the server has no ui token.
   */
  createEnrollment(payload: EnrollmentCreateInput): Promise<EnrollmentCreatedResult>;
  /**
   * Enrollment tokens for the owner panel (`GET /api/executors/enrollment`,
   * ui-token) — live tokens plus terminal history, no hash/token material.
   */
  listEnrollments(signal?: AbortSignal): Promise<EnrollmentsPage>;
  /**
   * Revoke a LIVE token (`DELETE /api/executors/enrollment/{id}`,
   * ui-token). created → revoked; ALREADY revoked → 200 idempotent;
   * used → 409 (the executor EXISTS — kill it via the executor registry,
   * never here); expired → 409; unknown → 404.
   */
  revokeEnrollment(enrollmentId: string): Promise<EnrollmentRevokeResult>;
  /** Default/fallback executor pair (`GET /api/settings/execution`, open read). */
  getExecutionSettings(signal?: AbortSignal): Promise<ExecutionSettings>;
  /**
   * Harness dictionary (`GET /api/harnesses`, open read; wave 3C). The
   * owner-managed nomination registry — meta.seed_min_count is the
   * guaranteed seed size, the set itself is data, never a UI constant.
   */
  listHarnesses(signal?: AbortSignal): Promise<HarnessesPage>;
  /**
   * Add a harness (`POST /api/harnesses`, ui-token; wave 3C). 201 row;
   * 422 bad name (server-side sanitization is authoritative) or
   * dictionary cap (≤64); 409 duplicate.
   */
  createHarness(payload: HarnessCreateInput): Promise<HarnessStateResult>;
  /**
   * Remove a harness (`DELETE /api/harnesses/{name}`, ui-token; wave 3C).
   * 404 unknown; 409 while the name is live in a registered executor, a
   * non-terminal assignment or an automation rule.
   */
  deleteHarness(name: string): Promise<void>;
  /**
   * Set the default/fallback pair (`PUT /api/settings/execution`,
   * ui-token). Amd 2 §5 gates answer 422: a default must exist, be
   * approved, enabled, currently online and travel local-poll.
   */
  putExecutionSettings(payload: ExecutionSettingsInput): Promise<ExecutionSettings>;

  // --- SCHED-1 automation (ADR 0013; no hooks this wave — adapter surface only) -

  /** Engine/caps/condition-meta projection (`GET /api/automation/status`). */
  automationStatus(signal?: AbortSignal): Promise<AutomationStatus>;
  /** Schedule rules incl. soft-deleted (`GET /api/automation/schedules`). */
  listSchedules(signal?: AbortSignal): Promise<SchedulesPage>;
  /** Create a schedule (`POST`, ui-token; created disabled — enable via PATCH). */
  createSchedule(payload: ScheduleCreateInput): Promise<ScheduleRule>;
  /** Patch a schedule (`PATCH`; server recomputes next_run_at from now). */
  patchSchedule(ruleId: number, patch: SchedulePatchInput): Promise<ScheduleRule>;
  /** Soft-disable retention DELETE (ADR 0013 §2 — the row is never destroyed). */
  deleteSchedule(ruleId: number): Promise<RuleDeletedAck>;
  /** «Запустить сейчас» — manual trigger (`POST …/run`, ui-token, sync). */
  runScheduleNow(ruleId: number): Promise<ScheduleRunResult>;
  /** Hook rules incl. soft-deleted (`GET /api/automation/hooks`). */
  listHooks(signal?: AbortSignal): Promise<HooksPage>;
  /** Create a hook (`POST`, ui-token; whitelist-validated server-side, 422). */
  createHook(payload: HookCreateInput): Promise<HookRule>;
  /** Patch a hook (`PATCH`; action change resets source_allowlist defaults). */
  patchHook(ruleId: number, patch: HookPatchInput): Promise<HookRule>;
  /** Soft-disable retention DELETE (same semantics as schedules). */
  deleteHook(ruleId: number): Promise<RuleDeletedAck>;
  /** Launch journal page (`GET /api/automation/launches`, cursor contract). */
  listLaunches(params?: LaunchesParams, signal?: AbortSignal): Promise<LaunchesPage>;

  // --- CV-7 QR pairing + devices (ADR 0012; wire in the class docblock) ----

  /** Device sessions (`GET /api/devices`, ui-token) — no token material. */
  listDevices(signal?: AbortSignal): Promise<DevicesPage>;
  /**
   * Revoke a device session (`DELETE /api/devices/{id}`, ui-token).
   * TERMINAL — only a fresh pairing restores access; SSE pairing.revoked
   * carries the device_id, the next token-bearing request gets 401.
   */
  revokeDevice(deviceId: string): Promise<DeviceRevokedResult>;
  /**
   * Start a pairing (`POST /api/pairing`, ui-token). 201 carries the
   * single-use code + the 4 verify digits EXACTLY once; 429 rate 3/10 min
   * per client; 503 fail-closed while the server has no ui token.
   */
  createPairing(): Promise<PairingCreatedResult>;
  /**
   * Trusted-side status (`GET /api/pairing/{id}`, ui-token) — the owner
   * panel's only source of the verify digits + scan metadata (§3.3: the
   * digits never ride SSE).
   */
  getPairing(pairingId: string, signal?: AbortSignal): Promise<PairingStatus>;
  /**
   * Owner decision (`POST /api/pairing/{id}/confirm {allow}`, ui-token).
   * allow=true → confirmed (SSE pairing.confirmed); false → revoked.
   * Repeat confirms answer 200 idempotently; confirm before scan → 409;
   * TTL-passed → 410; rate 3/10 min per client.
   */
  confirmPairing(pairingId: string, allow: boolean): Promise<PairingConfirmResult>;
  /**
   * Owner cancel before issued (`DELETE /api/pairing/{id}`, ui-token).
   * Idempotent on revoked (200); issued → 409 (revoke the DEVICE instead);
   * TTL-passed → 410.
   */
  cancelPairing(pairingId: string): Promise<PairingConfirmResult>;
  /**
   * The DEVICE leg (`POST /api/pairing/exchange`) — deliberately NO auth:
   * the single-use code IS the credential (ADR 0012 §2.3). Poll semantics:
   * 202 awaiting_confirmation (+verify) while unconfirmed/scanned, 200
   * one-shot issuance ({device_id, device_token: mnd_…}), 404 unknown code,
   * 410 expired/used/revoked, 403 foreign client IP, 429 rate, 503
   * fail-closed without a configured ui token.
   */
  exchangePairing(
    payload: PairingExchangeInput,
  ): Promise<PairingExchangeAwaiting | PairingIssuedResult>;
}

export interface BoardAdapterOptions {
  /** Board API base URL. Default "/api" (same-origin, `VITE_BOARD_API_URL`). */
  baseUrl?: string;
  /** Test seam — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Default per-request timeout; search gets a dedicated generous budget. */
  timeoutMs?: number;
  /**
   * Test seam for the ui-token source. Defaults to the sessionStorage-backed
   * `getUiToken` (gateway/uiToken.ts) — mutations attach `Authorization:
   * Bearer <token>` only when it answers non-empty.
   */
  getUiTokenFn?: () => string;
  /**
   * Test seam for the device-identity source. Defaults to the
   * localStorage-backed `getDeviceToken` (gateway/deviceToken.ts) — the
   * paired device's `mnd_…` fallback identity (ADR 0012 §5).
   */
  getDeviceTokenFn?: () => string;
}

export class BoardAdapter implements BoardGateway {
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;
  private readonly getUiTokenFn: () => string;
  private readonly getDeviceTokenFn: () => string;
  /**
   * ADR 0014 Ф2: the adapter's last knowledge of a live `vesmaro_ui`
   * session cookie. Set only by a 204 boot/re-401 probe (a strict status
   * check — never "any 2xx"), cleared by the server-side logout. This is
   * what lets `hasUiToken()` answer true in a freshly opened tab that
   * carries no sessionStorage token.
   */
  private cookieLive = false;

  constructor(options: BoardAdapterOptions | string = {}) {
    // Backwards-compatible string form: new BoardAdapter("/api").
    const opts = typeof options === "string" ? { baseUrl: options } : options;
    this.baseUrl = opts.baseUrl ?? "/api";
    this.fetchImpl = opts.fetchImpl;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.getUiTokenFn = opts.getUiTokenFn ?? getUiToken;
    this.getDeviceTokenFn = opts.getDeviceTokenFn ?? getDeviceToken;
  }

  async search(params: SearchParams, signal?: AbortSignal): Promise<SearchResult[]> {
    const response = await this.request<BoardSearchResponse>("/mnemos/search", {
      // The board proxy names the query `q`; tags/include_raw have no
      // wire counterpart on the merged search (documented, ignored).
      query: { q: params.query, limit: params.limit, project: params.project },
      signal,
      timeoutMs: SEARCH_TIMEOUT_MS,
    });
    const hits = Array.isArray(response?.results) ? response.results : [];
    return hits.map(normalizeSearchHit);
  }

  /**
   * Merged list, first page flattened for the `MemoryGateway` contract.
   * `status`/`project` filters pass through to the merged endpoint; the
   * mnemos `offset` has no wire counterpart (the cursor contract replaces
   * it, ADR 0011 §11) and is ignored — continuation goes through
   * `listMemoriesPage`. List rows carry an excerpt only (SEC-4), which
   * lands in `Memory.content`; the full card comes from `getMemory`.
   */
  async listMemories(
    params: ListMemoriesParams = {},
    signal?: AbortSignal,
  ): Promise<Memory[]> {
    const page = await this.listMemoriesPage(
      {
        limit: params.limit,
        status: params.status,
        project: params.project,
        // UI-17 §5.6: the «Открыть в Записях» path narrows the merged list
        // by tag — a native mnemos listing filter, pass-through verbatim.
        tags: params.tags,
      },
      signal,
    );
    return page.items.map(listItemToMemory);
  }

  async listMemoriesPage(
    params: BoardListParams = {},
    signal?: AbortSignal,
  ): Promise<MergedMemoriesPage> {
    return this.request<MergedMemoriesPage>("/memories", {
      query: {
        limit: params.limit,
        cursor: params.cursor,
        scope: params.scope,
        status: params.status,
        project: params.project,
        agent: params.agent,
        tags: params.tags,
        since: params.since,
        until: params.until,
      },
      signal,
    });
  }

  /**
   * Memory card from the first resolving server. The board endpoint always
   * reshapes the full card (raw_content included), so `includeRaw` is
   * accepted for interface parity and has no wire effect.
   */
  async getMemory(
    id: string,
    _includeRaw = false,
    signal?: AbortSignal,
  ): Promise<Memory> {
    const envelope = await this.request<BoardMemoryEnvelope>(
      `/memories/item/${encodeURIComponent(id)}`,
      { signal },
    );
    if (!envelope || envelope.ok !== true) {
      throw new ApiError(
        404,
        envelope && envelope.error ? envelope.error : `memory '${id}' not found`,
        { url: `${this.baseUrl}/memories/item/${id}` },
      );
    }
    return envelopeMemory(envelope);
  }

  async listTags(signal?: AbortSignal): Promise<TagSummary[]> {
    const response = await this.request<MergedTags>("/tags", { signal });
    return (response?.tags ?? []).map((tag) => ({
      tag: tag.name,
      count: tag.count,
    }));
  }

  async mergedTags(signal?: AbortSignal): Promise<MergedTags> {
    return this.request<MergedTags>("/tags", { signal });
  }

  /**
   * Everything tied to one tag (`GET /api/tags/{tag}/drill`, UI-17 §5).
   * The board answers an anonymous dict — normalised defensively with the
   * same honest-defaults policy as pulse/boardHealth.
   */
  async drillTag(
    tag: string,
    params: TagDrillParams = {},
    signal?: AbortSignal,
  ): Promise<TagDrill> {
    const payload = await this.request<Record<string, unknown>>(
      `/tags/${encodeURIComponent(tag)}/drill`,
      { query: { limit: params.limit }, signal },
    );
    return normalizeTagDrill(payload, tag);
  }

  async health(signal?: AbortSignal): Promise<HealthStatus> {
    const payload = await this.request<BoardHealth>("/health", { signal });
    // Project the board payload onto the viewer's string-map health shape:
    // `status` drives deriveHealthStatus; nested arrays (servers/groups)
    // have no place in it and are dropped (Ф1 status page goes board-native).
    return {
      status: payload?.ok === true ? "ok" : "degraded",
      service: String(payload?.service ?? "vesmaro-eyes"),
      board_tasks: String(payload?.board_tasks ?? 0),
    };
  }

  async board(status?: string, signal?: AbortSignal): Promise<BoardSummary> {
    return this.request<BoardSummary>("/board", { query: { status }, signal });
  }

  async inbox(params: InboxParams = {}, signal?: AbortSignal): Promise<TaskInbox> {
    return this.request<TaskInbox>("/tasks/inbox", {
      query: {
        scope: params.scope,
        project: params.project,
        include_adopted: params.include_adopted,
      },
      signal,
    });
  }

  events(): EventStream {
    return new EventStream({ baseUrl: this.baseUrl });
  }

  /**
   * Merged recency feed across scope. The wire shape is captured in
   * boardTypes (live corpus, board `memory_pulse_all`); this normalises the
   * anonymous dict defensively — per-row unknowns get honest defaults instead
   * of pretending the field was there.
   */
  async pulse(params: PulseParams = {}, signal?: AbortSignal): Promise<MemoryPulse> {
    const payload = await this.request<Record<string, unknown>>("/memories/pulse", {
      query: { scope: params.scope, project: params.project, limit: params.limit },
      signal,
    });
    return normalizePulse(payload);
  }

  /**
   * Per-store health detail for the Overview cards. `health()` keeps serving
   * the projected string map for the legacy Status page; this is the Ф1
   * board-native view (`servers[].ok/latency_ms/memories_total`).
   */
  async boardHealth(signal?: AbortSignal): Promise<BoardHealthDetail> {
    const payload = await this.request<Record<string, unknown>>("/health", { signal });
    return normalizeBoardHealth(payload);
  }

  // --- Ф2 task-domain reads ------------------------------------------------------

  async reports(taskId: string, signal?: AbortSignal): Promise<TaskReports> {
    return this.request<TaskReports>(`/tasks/${encodeURIComponent(taskId)}/reports`, {
      signal,
    });
  }

  async history(taskId: string, signal?: AbortSignal): Promise<TaskHistory> {
    return this.request<TaskHistory>(`/tasks/${encodeURIComponent(taskId)}/history`, {
      signal,
    });
  }

  async taskMemories(taskId: string, signal?: AbortSignal): Promise<TaskMemories> {
    return this.request<TaskMemories>(`/tasks/${encodeURIComponent(taskId)}/memories`, {
      signal,
    });
  }

  async archive(
    params: ArchiveParams = {},
    signal?: AbortSignal,
  ): Promise<ArchivePage> {
    return this.request<ArchivePage>("/archive", {
      query: {
        q: params.q,
        status: params.status,
        col: params.col,
        agent: params.agent,
        project: params.project,
        limit: params.limit,
        offset: params.offset,
      },
      signal,
    });
  }

  async taskById(taskId: string, signal?: AbortSignal): Promise<BoardTask> {
    const board = await this.board(undefined, signal);
    const task = board.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new ApiError(404, `task '${taskId}' not found on the board`, {
        url: `${this.baseUrl}/board`,
      });
    }
    return task;
  }

  // --- Ф3 mutations (ui-token gated; wire contract in the class docblock) ----

  hasUiToken(): boolean {
    return this.getUiTokenFn().length > 0 || this.cookieLive;
  }

  async verifyUiToken(token: string): Promise<UiTokenVerifyResult> {
    const out = await this.request<{ ok: boolean; token_class: "ui" | "legacy" }>(
      "/auth/ui-token",
      { method: "POST", body: { token } },
    );
    // Normalize defensively: the server pins the enum ("ui"|"legacy"), a
    // legacy proxy that drops the field must not widen the type.
    return {
      ok: out.ok === true,
      tokenClass: out.token_class === "legacy" ? "legacy" : "ui",
    };
  }

  async probeUiSession(): Promise<boolean> {
    // Raw fetch on purpose: 204 is the ONLY live answer (a stubbed/proxied
    // 200-with-JSON must not read as a session); requestJson hides statuses.
    const url = buildUrl(this.baseUrl, "/auth/ui-token");
    try {
      // A hung server must not hang boot hydration (review P3): the probe
      // races a 10s abort — a timeout lands in the catch → "no session".
      const response = await (this.fetchImpl ?? fetch)(url, {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
      });
      this.cookieLive = response.status === 204;
    } catch {
      this.cookieLive = false; // network down / aborted — fail to "no session"
    }
    return this.cookieLive;
  }

  async logoutUiToken(): Promise<void> {
    await this.request<void>("/auth/ui-token", { method: "DELETE" });
    this.cookieLive = false;
  }

  async createTask(payload: TaskCreateInput): Promise<BoardTask> {
    return this.request<BoardTask>("/tasks", {
      method: "POST",
      body: payload,
      auth: true,
    });
  }

  async patchTask(taskId: string, patch: TaskPatchInput): Promise<BoardTask> {
    return this.request<BoardTask>(`/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      body: patch,
      auth: true,
    });
  }

  async moveTask(taskId: string, col: string, position?: number): Promise<BoardTask> {
    return this.request<BoardTask>(`/tasks/${encodeURIComponent(taskId)}/move`, {
      method: "POST",
      // position null is a legal "append to the end" on the wire.
      body: { col, position: position ?? null },
      auth: true,
    });
  }

  async archiveTask(taskId: string): Promise<TaskMutationAck> {
    return this.request<TaskMutationAck>(
      `/tasks/${encodeURIComponent(taskId)}/archive`,
      {
        method: "POST",
        auth: true,
      },
    );
  }

  async unarchiveTask(taskId: string): Promise<TaskUnarchiveResult> {
    return this.request<TaskUnarchiveResult>(
      `/tasks/${encodeURIComponent(taskId)}/unarchive`,
      { method: "POST", auth: true },
    );
  }

  async adoptInboxItem(memoryId: string): Promise<BoardTask> {
    return this.request<BoardTask>(
      `/tasks/inbox/${encodeURIComponent(memoryId)}/adopt`,
      { method: "POST", auth: true },
    );
  }

  async refreshInbox(): Promise<InboxRefreshResult> {
    return this.request<InboxRefreshResult>("/tasks/inbox/refresh", {
      method: "POST",
      auth: true,
      // The server scans every store synchronously — seconds are accepted
      // for an explicit refresh (board-openapi-snapshot description).
      timeoutMs: SEARCH_TIMEOUT_MS,
    });
  }

  // --- AGW-1 agents domain (ARCH-9, ADR 0009 Amd 2; ui-token writes) -----------

  async listAssignments(
    params: AssignmentListParams = {},
    signal?: AbortSignal,
  ): Promise<AssignmentsPage> {
    // Wire parity: executor_id rides along (presence piggyback), but the
    // server does NOT filter the list by it — executor filtering is the
    // client's job over the full projection.
    return this.request<AssignmentsPage>("/assignments", {
      query: {
        state: params.state,
        task_id: params.task_id,
        executor_id: params.executor_id,
      },
      signal,
    });
  }

  async createAssignment(
    payload: AssignmentCreateInput,
  ): Promise<AssignmentCreatedResult> {
    return this.request<AssignmentCreatedResult>("/assignments", {
      method: "POST",
      // Wire shape: executor_id is a plain string with a server default —
      // the pin travels as "" when the owner chose chain resolution.
      body: {
        task_id: payload.task_id,
        specialist: payload.specialist,
        harness: payload.harness,
        executor_id: payload.executor_id ?? "",
      },
      auth: true,
    });
  }

  async cancelAssignment(
    assignmentId: number,
    reason = "",
  ): Promise<AssignmentCancelledResult> {
    return this.request<AssignmentCancelledResult>(
      `/assignments/${assignmentId}/cancel`,
      { method: "POST", body: { reason }, auth: true },
    );
  }

  async listExecutors(signal?: AbortSignal): Promise<ExecutorsPage> {
    return this.request<ExecutorsPage>("/executors", { signal });
  }

  async patchExecutor(
    executorId: string,
    patch: ExecutorPatchInput,
  ): Promise<ExecutorStateChangeResult> {
    return this.request<ExecutorStateChangeResult>(
      `/executors/${encodeURIComponent(executorId)}`,
      // Wire shape: the schema's fields are nullable/optional — omitted keys
      // stay untouched server-side (model_dump(exclude_none=True)).
      {
        method: "PATCH",
        body: {
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.state === undefined ? {} : { state: patch.state }),
          ...(patch.capabilities === undefined
            ? {}
            : { capabilities: [...patch.capabilities] }),
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        },
        auth: true,
      },
    );
  }

  async deleteExecutor(executorId: string): Promise<void> {
    await this.request<{ ok: boolean }>(
      `/executors/${encodeURIComponent(executorId)}`,
      { method: "DELETE", auth: true },
    );
  }

  async createEnrollment(
    payload: EnrollmentCreateInput,
  ): Promise<EnrollmentCreatedResult> {
    return this.request<EnrollmentCreatedResult>("/executors/enrollment", {
      method: "POST",
      // Omitted keys stay at the server defaults (label/hints are optional
      // strings; empty string = not provided).
      body: {
        ...(payload.label ? { label: payload.label } : {}),
        ...(payload.harness_hint ? { harness_hint: payload.harness_hint } : {}),
        ...(payload.name_hint ? { name_hint: payload.name_hint } : {}),
      },
      auth: true,
    });
  }

  async listEnrollments(signal?: AbortSignal): Promise<EnrollmentsPage> {
    return this.request<EnrollmentsPage>("/executors/enrollment", {
      signal,
      auth: true,
    });
  }

  async revokeEnrollment(enrollmentId: string): Promise<EnrollmentRevokeResult> {
    return this.request<EnrollmentCreatedResult>(
      `/executors/enrollment/${encodeURIComponent(enrollmentId)}`,
      { method: "DELETE", auth: true },
    );
  }

  async listHarnesses(signal?: AbortSignal): Promise<HarnessesPage> {
    return this.request<HarnessesPage>("/harnesses", { signal });
  }

  async createHarness(payload: HarnessCreateInput): Promise<HarnessStateResult> {
    return this.request<HarnessStateResult>("/harnesses", {
      method: "POST",
      // Omitted note stays at the server default (empty string).
      body: {
        name: payload.name,
        ...(payload.note ? { note: payload.note } : {}),
      },
      auth: true,
    });
  }

  async deleteHarness(name: string): Promise<void> {
    await this.request<{ ok: boolean }>(`/harnesses/${encodeURIComponent(name)}`, {
      method: "DELETE",
      auth: true,
    });
  }

  async getExecutionSettings(signal?: AbortSignal): Promise<ExecutionSettings> {
    return this.request<ExecutionSettings>("/settings/execution", { signal });
  }

  async putExecutionSettings(
    payload: ExecutionSettingsInput,
  ): Promise<ExecutionSettings> {
    return this.request<ExecutionSettings>("/settings/execution", {
      method: "PUT",
      // Wire shape: scope is a required string ('' = global default).
      body: {
        default_executor: payload.default_executor,
        fallback_executor: payload.fallback_executor,
        scope: payload.scope ?? "",
      },
      auth: true,
    });
  }

  // --- SCHED-1 automation (ADR 0013; ui-token mutations) ------------------------

  async automationStatus(signal?: AbortSignal): Promise<AutomationStatus> {
    return this.request<AutomationStatus>("/automation/status", { signal });
  }

  async listSchedules(signal?: AbortSignal): Promise<SchedulesPage> {
    return this.request<SchedulesPage>("/automation/schedules", { signal });
  }

  async createSchedule(payload: ScheduleCreateInput): Promise<ScheduleRule> {
    return this.request<ScheduleRule>("/automation/schedules", {
      method: "POST",
      body: payload,
      auth: true,
    });
  }

  async patchSchedule(
    ruleId: number,
    patch: SchedulePatchInput,
  ): Promise<ScheduleRule> {
    return this.request<ScheduleRule>(`/automation/schedules/${ruleId}`, {
      method: "PATCH",
      body: patch,
      auth: true,
    });
  }

  async deleteSchedule(ruleId: number): Promise<RuleDeletedAck> {
    return this.request<RuleDeletedAck>(`/automation/schedules/${ruleId}`, {
      method: "DELETE",
      auth: true,
    });
  }

  async runScheduleNow(ruleId: number): Promise<ScheduleRunResult> {
    return this.request<ScheduleRunResult>(`/automation/schedules/${ruleId}/run`, {
      method: "POST",
      auth: true,
    });
  }

  async listHooks(signal?: AbortSignal): Promise<HooksPage> {
    return this.request<HooksPage>("/automation/hooks", { signal });
  }

  async createHook(payload: HookCreateInput): Promise<HookRule> {
    return this.request<HookRule>("/automation/hooks", {
      method: "POST",
      body: payload,
      auth: true,
    });
  }

  async patchHook(ruleId: number, patch: HookPatchInput): Promise<HookRule> {
    return this.request<HookRule>(`/automation/hooks/${ruleId}`, {
      method: "PATCH",
      body: patch,
      auth: true,
    });
  }

  async deleteHook(ruleId: number): Promise<RuleDeletedAck> {
    return this.request<RuleDeletedAck>(`/automation/hooks/${ruleId}`, {
      method: "DELETE",
      auth: true,
    });
  }

  async listLaunches(
    params: LaunchesParams = {},
    signal?: AbortSignal,
  ): Promise<LaunchesPage> {
    return this.request<LaunchesPage>("/automation/launches", {
      query: {
        rule_id: params.rule_id,
        kind: params.kind,
        decision: params.decision,
        limit: params.limit,
        cursor: params.cursor,
      },
      signal,
    });
  }

  // --- CV-7 QR pairing + devices (ADR 0012) ----------------------------------

  async listDevices(signal?: AbortSignal): Promise<DevicesPage> {
    return this.request<DevicesPage>("/devices", { signal, auth: true });
  }

  async revokeDevice(deviceId: string): Promise<DeviceRevokedResult> {
    return this.request<DeviceRevokedResult>(
      `/devices/${encodeURIComponent(deviceId)}`,
      { method: "DELETE", auth: true },
    );
  }

  async createPairing(): Promise<PairingCreatedResult> {
    // Wire shape: the optional owner label (device_name) stays unset — the
    // device's self-asserted name at exchange is what the owner confirms.
    return this.request<PairingCreatedResult>("/pairing", {
      method: "POST",
      body: { device_name: "" },
      auth: true,
    });
  }

  async getPairing(pairingId: string, signal?: AbortSignal): Promise<PairingStatus> {
    return this.request<PairingStatus>(`/pairing/${encodeURIComponent(pairingId)}`, {
      signal,
      auth: true,
    });
  }

  async confirmPairing(
    pairingId: string,
    allow: boolean,
  ): Promise<PairingConfirmResult> {
    return this.request<PairingConfirmResult>(
      `/pairing/${encodeURIComponent(pairingId)}/confirm`,
      { method: "POST", body: { allow }, auth: true },
    );
  }

  async cancelPairing(pairingId: string): Promise<PairingConfirmResult> {
    return this.request<PairingConfirmResult>(
      `/pairing/${encodeURIComponent(pairingId)}`,
      { method: "DELETE", auth: true },
    );
  }

  async exchangePairing(
    payload: PairingExchangeInput,
  ): Promise<PairingExchangeAwaiting | PairingIssuedResult> {
    // NO `auth: true` on purpose: the exchange leg answers an unauthenticated
    // device; a Bearer header here would only leak the owner token to a
    // route that never asked for it (ADR 0012 §2.3, contract audit point).
    return this.request<PairingExchangeAwaiting | PairingIssuedResult>(
      "/pairing/exchange",
      {
        method: "POST",
        body: { code: payload.code, device_name: payload.device_name ?? "" },
      },
    );
  }

  // --- v0-unsupported mnemos-side views (fail loud, never pretend) ----------

  async agentRecall(
    _agent: string,
    _project?: string,
    _query?: string,
    _limit?: number,
    _signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    throw unsupported("agentRecall", "/recall/agent/{name}");
  }

  async metrics(_signal?: AbortSignal): Promise<Metrics> {
    throw unsupported("metrics", "/metrics");
  }

  async listTraces(
    _taskLabel?: string,
    _limit?: number,
    _signal?: AbortSignal,
  ): Promise<Trace[]> {
    throw unsupported("listTraces", "/traces");
  }

  async listSessions(_signal?: AbortSignal): Promise<A2ASession[]> {
    throw unsupported("listSessions", "/v1/sessions");
  }

  async getSession(_id: string, _signal?: AbortSignal): Promise<A2ASession> {
    throw unsupported("getSession", "/v1/sessions/{id}");
  }

  /**
   * Resolve the Authorization source for one request (ADR 0012 §5 device
   * identity layered over the ADR 0011/0014 ui-token rules):
   *
   * - `/pairing/exchange` — NEVER authenticated: the single-use code IS the
   *   credential (§2.3); neither the ui nor the device token may leak there.
   * - `/auth/*` — the door speaks for itself (ui token rides the BODY of
   *   verify, the cookie carries the session): a device `mnd_…` must not
   *   claim identity at the login endpoints. `auth: true` here keeps the
   *   plain ui-token source for any future authenticated auth-route call.
   * - `auth: true` (Ф3 mutations, devices, owner pairing legs) — the ui
   *   token when present, else the device token; without either the request
   *   ships bare and the server answers 401 → the token panel.
   * - Open reads — bare while an owner session speaks for this browser (the
   *   pinned "reads never carry Authorization"), else the paired device's
   *   `mnd_…` identity. v0 is read-only for devices (ADR 0012 §5): the
   *   server answers 403 to device mutations that bypass `auth: true` — the
   *   honest verdict, not an error to mask.
   *
   * requestJson maps every non-2xx to `ApiError` and composes timeouts with
   * external aborts; an empty-token source simply sends no header.
   */
  private identityTokenSource(
    path: string,
    auth: boolean | undefined,
  ): (() => string) | undefined {
    if (path === "/pairing/exchange") return undefined;
    if (path.startsWith("/auth/")) {
      return auth ? this.getUiTokenFn : undefined;
    }
    if (auth) {
      return () => this.getUiTokenFn() || this.getDeviceTokenFn();
    }
    return () => (this.getUiTokenFn().length > 0 ? "" : this.getDeviceTokenFn());
  }

  private request<T>(
    path: string,
    config: RequestConfig & { auth?: boolean },
  ): Promise<T> {
    const { auth, ...rest } = config;
    const getToken = this.identityTokenSource(path, auth);
    return requestJson<T>(
      {
        baseUrl: this.baseUrl,
        fetchImpl: this.fetchImpl,
        defaultTimeoutMs: this.timeoutMs,
        ...(getToken ? { getToken } : {}),
      },
      path,
      rest,
    );
  }
}

function unsupported(method: string, mnemosPath: string): ApiError {
  return new ApiError(
    501,
    `BoardAdapter.${method}: the board merge-API does not expose the mnemos ` +
      `${mnemosPath} view (ADR 0011 §6 — v0 declares it unsupported until the ` +
      `convergence phases replace the page with a board-native read).`,
  );
}

/**
 * Normalise an anonymous proxied mnemos search hit into the pinned UI shape
 * (same honest-defaults policy as the HttpAdapter mapping; the board-added
 * `server` provenance field is not part of the viewer SearchResult yet).
 */
function normalizeSearchHit(hit: unknown, index: number): SearchResult {
  const source = (hit ?? {}) as Record<string, unknown>;
  const searchType = source.search_type;
  return {
    id: typeof source.id === "string" ? source.id : `hit-${index}`,
    title: typeof source.title === "string" ? source.title : "",
    content: typeof source.content === "string" ? source.content : "",
    tags: Array.isArray(source.tags) ? source.tags.map(String) : [],
    score: typeof source.score === "number" ? source.score : 0,
    search_type:
      searchType === "fts" || searchType === "semantic" || searchType === "hybrid"
        ? searchType
        : "fts",
  };
}

/**
 * Map a merged-list row onto the viewer's `Memory` view. The wire row is
 * excerpt-only (SEC-4) and carries no agent/memory_type/source — those get
 * honest defaults; the detail card (getMemory) fills the real values.
 */
function listItemToMemory(item: MergedMemoryListItem): Memory {
  return {
    id: item.id,
    title: item.title,
    content: item.excerpt,
    tags: [...item.tags],
    status: oneOf(item.status, MEMORY_STATUSES),
    project: item.project,
    agent: agentFromTags(item.tags),
    memory_type: "note",
    source: "manual",
    created_at: item.created_at,
    updated_at: item.updated_at,
    marker_version: DEFAULT_MARKER_VERSION,
  };
}

/** Map the `GET /api/memories/item/{id}` envelope onto the viewer `Memory`. */
function envelopeMemory(envelope: Extract<BoardMemoryEnvelope, { ok: true }>): Memory {
  const card = envelope.memory;
  return {
    id: card.id ?? "",
    title: card.title ?? "",
    content: card.content ?? "",
    raw_content: card.raw_content ?? null,
    tags: Array.isArray(card.tags) ? [...card.tags] : [],
    status: oneOf(card.status, MEMORY_STATUSES),
    memory_type: oneOf(card.memory_type, MEMORY_TYPES),
    source: oneOf(card.source, MEMORY_SOURCES),
    source_url: card.source_url ?? null,
    project: card.project ?? "",
    agent: card.agent ?? "",
    created_at: card.created_at ?? "",
    updated_at: card.updated_at ?? "",
    marker_version: DEFAULT_MARKER_VERSION,
  };
}

/** Recover the agent slug from an `agent:` tag when the row omits the field. */
function agentFromTags(tags: readonly string[]): string {
  const tagged = tags.find((tag) => tag.startsWith("agent:"));
  return tagged ? tagged.slice("agent:".length) : "";
}

/** Narrow a wire string onto a literal union with an honest fallback. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : allowed[0];
}

/** mnemos `Memory` enum mirrors (gateway/types.ts is the single source). */
const MEMORY_STATUSES = [
  "raw",
  "processing",
  "processed",
  "published",
  "archived",
] as const;
const MEMORY_TYPES = [
  "note",
  "fact",
  "snippet",
  "bookmark",
  "conversation",
  "session_context",
] as const;
const MEMORY_SOURCES = [
  "manual",
  "web",
  "file",
  "mcp",
  "obsidian",
  "cli",
  "rule",
  "synthesized",
] as const;

/** mnemos `Memory.marker_version` schema default (not carried by the board wire). */
const DEFAULT_MARKER_VERSION = 1;

// --- Ф1 normalizers (anonymous dicts → honest view models) ---------------------

/** String-tunnel with an honest fallback (never pretend a field existed). */
function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/**
 * `GET /api/memories/pulse` anonymous dict → `MemoryPulse`. Rows missing the
 * server stamp (should not happen — the server assigns it) fall back to "?"
 * so provenance never silently disappears from the feed.
 */
export function normalizePulse(payload: unknown): MemoryPulse {
  const source = (payload ?? {}) as Record<string, unknown>;
  const items = Array.isArray(source.items) ? source.items : [];
  const perServer = Array.isArray(source.per_server) ? source.per_server : [];
  return {
    ok: source.ok === true,
    scope: str(source.scope, "all"),
    kind: str(source.kind, "all"),
    items: items.map((row): MemoryPulseItem => {
      const item = (row ?? {}) as Record<string, unknown>;
      return {
        id: str(item.id),
        title: str(item.title),
        tags: strArray(item.tags),
        status: str(item.status),
        created_at: str(item.created_at),
        server: str(item.server, "?"),
      };
    }),
    per_server: perServer.map((row): MemoryPulseServerNote => {
      const note = (row ?? {}) as Record<string, unknown>;
      return {
        server: str(note.server, "?"),
        ok: note.ok === true,
        items: num(note.items),
        detail: note.detail ?? null,
      };
    }),
    store_stats: Array.isArray(source.store_stats) ? source.store_stats : undefined,
  };
}

/**
 * `GET /api/tags/{tag}/drill` anonymous dict → `TagDrill` (UI-17 §5).
 * Rows missing fields get honest defaults; `ok` mirrors the server flag
 * (`true` unless every store failed with an empty memory set).
 */
export function normalizeTagDrill(payload: unknown, tag: string): TagDrill {
  const source = (payload ?? {}) as Record<string, unknown>;
  const tasks = Array.isArray(source.tasks) ? source.tasks : [];
  const memories = Array.isArray(source.memories) ? source.memories : [];
  const errors = Array.isArray(source.errors) ? source.errors : [];
  return {
    ok: source.ok === true || (errors.length === 0 && source.ok !== false),
    tag: str(source.tag, tag),
    tasks: tasks.map((row): TagDrillTask => {
      const task = (row ?? {}) as Record<string, unknown>;
      return {
        id: str(task.id),
        title: str(task.title),
        col: str(task.col),
        agents: strArray(task.agents),
        env: str(task.env),
      };
    }),
    memories: memories.map((row): TagDrillMemory => {
      const memory = (row ?? {}) as Record<string, unknown>;
      return {
        id: str(memory.id),
        title: str(memory.title),
        tags: strArray(memory.tags),
        server: typeof memory.server === "string" ? memory.server : null,
        created_at: typeof memory.created_at === "string" ? memory.created_at : null,
        status: typeof memory.status === "string" ? memory.status : null,
        excerpt: str(memory.excerpt),
      };
    }),
    errors: errors.map((row): TagDrillStoreError => {
      const error = (row ?? {}) as Record<string, unknown>;
      return {
        server: typeof error.server === "string" ? error.server : undefined,
        status: typeof error.status === "number" ? error.status : undefined,
      };
    }),
  };
}

/** `GET /api/health` anonymous dict → `BoardHealthDetail` (per-store rows). */
export function normalizeBoardHealth(payload: unknown): BoardHealthDetail {
  const source = (payload ?? {}) as Record<string, unknown>;
  const servers = Array.isArray(source.servers) ? source.servers : [];
  return {
    ok: source.ok === true,
    service: str(source.service, "vesmaro-eyes"),
    board_tasks: num(source.board_tasks),
    app_version: typeof source.app_version === "string" ? source.app_version : null,
    servers: servers.map((row): BoardHealthServer => {
      const server = (row ?? {}) as Record<string, unknown>;
      return {
        name: str(server.name, "?"),
        group_name: str(server.group_name, "default"),
        enabled: server.enabled !== false,
        state: str(server.state, "idle"),
        description: typeof server.description === "string" ? server.description : null,
        ok: server.ok === true,
        latency_ms: typeof server.latency_ms === "number" ? server.latency_ms : null,
        error: typeof server.error === "string" ? server.error : null,
        memories_total:
          typeof server.memories_total === "number" ? server.memories_total : null,
      };
    }),
  };
}

// Re-export for consumers that subscribe through the adapter (typed handler
// wiring lives in gateway/events.ts).
export type { BoardEvent };
