import type { MemoryGateway } from "./MemoryGateway";
import type { EventStream } from "./events";
import type {
  ArchivePage,
  ArchiveParams,
  BoardHealthDetail,
  BoardSummary,
  BoardTask,
  InboxRefreshResult,
  MemoryPulse,
  MergedTags,
  PulseParams,
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
  AssignmentCancelledResult,
  AssignmentCreateInput,
  AssignmentCreatedResult,
  AssignmentListParams,
  AssignmentsPage,
  AutomationSettings,
  AutomationSettingsInput,
  AutomationStatus,
  DeviceGrantsResult,
  DeviceRevokedResult,
  DevicesPage,
  ExecutionSettings,
  ExecutionSettingsInput,
  ExecutorPatchInput,
  ExecutorStateChangeResult,
  ExecutorsPage,
  HarnessCreateInput,
  HarnessesPage,
  HarnessStateResult,
  EnrollmentCreateInput,
  EnrollmentCreatedResult,
  EnrollmentRevokeResult,
  EnrollmentsPage,
  HookCreateInput,
  HookPatchInput,
  HookRule,
  HooksPage,
  LaunchesPage,
  LaunchesParams,
  PairingConfirmResult,
  PairingCreatedResult,
  PairingExchangeAwaiting,
  PairingExchangeInput,
  PairingIssuedResult,
  PairingStatus,
  RuleDeletedAck,
  ScheduleCreateInput,
  SchedulePatchInput,
  ScheduleRule,
  ScheduleRunResult,
  SchedulesPage,
} from "./boardTypes";
import type { InboxParams } from "./BoardAdapter";
import type { UiTokenVerifyResult } from "./uiToken";

/**
 * Board-native read capabilities (ADR 0011 Ф1). The three adapters share the
 * `MemoryGateway` surface, but only the board and mock adapters speak the
 * merge-API extras; the mnemos HttpAdapter legitimately does not. Pages probe
 * the gateway through these structural guards instead of branching on the
 * adapter-mode string — an adapter that grows the method lights the section
 * up with no page change (capability, not configuration).
 */

/** Merged recency feed (`GET /api/memories/pulse`). */
export interface PulseSource {
  pulse(params?: PulseParams, signal?: AbortSignal): Promise<MemoryPulse>;
}

/** Per-store health detail (`GET /api/health`, nested view). */
export interface BoardHealthSource {
  boardHealth(signal?: AbortSignal): Promise<BoardHealthDetail>;
}

/** Gateway type that also speaks the pulse wire. */
export type PulseGateway = MemoryGateway & PulseSource;

/** Gateway type that also serves the per-store health view. */
export type BoardHealthGateway = MemoryGateway & BoardHealthSource;

export function isPulseSource(gateway: MemoryGateway): gateway is PulseGateway {
  return typeof (gateway as Partial<PulseSource>).pulse === "function";
}

export function isBoardHealthSource(
  gateway: MemoryGateway,
): gateway is BoardHealthGateway {
  return typeof (gateway as Partial<BoardHealthSource>).boardHealth === "function";
}

/**
 * Ф2 task-domain read surface: board projection, inbox, reports, history,
 * memory links, archive and the SSE stream. Structural, like the Ф1 guards —
 * the mnemos HttpAdapter legitimately lacks every method and the pages render
 * their honest "unsupported in mnemos mode" states.
 */
export interface TaskSource {
  board(status?: string, signal?: AbortSignal): Promise<BoardSummary>;
  inbox(params?: InboxParams, signal?: AbortSignal): Promise<TaskInbox>;
  reports(taskId: string, signal?: AbortSignal): Promise<TaskReports>;
  history(taskId: string, signal?: AbortSignal): Promise<TaskHistory>;
  taskMemories(taskId: string, signal?: AbortSignal): Promise<TaskMemories>;
  archive(params?: ArchiveParams, signal?: AbortSignal): Promise<ArchivePage>;
  taskById(taskId: string, signal?: AbortSignal): Promise<BoardTask>;
}

/** Gateway type that also serves the whole Ф2 task domain. */
export type TaskGateway = MemoryGateway & TaskSource;

/** SSE-capable gateway (the stream factory the events bridge needs). */
export interface TaskEventSource {
  events(): EventStream;
}

export function isTaskSource(gateway: MemoryGateway): gateway is TaskGateway {
  return (
    typeof (gateway as Partial<TaskSource>).board === "function" &&
    typeof (gateway as Partial<TaskSource>).inbox === "function" &&
    typeof (gateway as Partial<TaskSource>).reports === "function" &&
    typeof (gateway as Partial<TaskSource>).archive === "function"
  );
}

export function isTaskEventSource(
  gateway: MemoryGateway,
): gateway is MemoryGateway & TaskEventSource {
  return typeof (gateway as Partial<TaskEventSource>).events === "function";
}

/**
 * Ф3 mutation surface: the write side of the task domain. Every method is
 * ui-token gated on the wire (401 without one); pages probe through this
 * structural guard so an adapter that grows the methods lights the mutation
 * affordances up without a page change — same capability-not-configuration
 * rule as the read guards above. `hasUiToken` stays on the adapter (not the
 * provider) because the adapter owns the wire: it is the single source for
 * "would a mutation carry a token right now".
 */
export interface TaskMutationSource {
  hasUiToken(): boolean;
  createTask(payload: TaskCreateInput): Promise<BoardTask>;
  patchTask(taskId: string, patch: TaskPatchInput): Promise<BoardTask>;
  moveTask(taskId: string, col: string, position?: number): Promise<BoardTask>;
  archiveTask(taskId: string): Promise<TaskMutationAck>;
  unarchiveTask(taskId: string): Promise<TaskUnarchiveResult>;
  adoptInboxItem(memoryId: string): Promise<BoardTask>;
  refreshInbox(): Promise<InboxRefreshResult>;
}

/** Gateway type that also speaks the Ф3 mutation wire. */
export type TaskMutationGateway = MemoryGateway & TaskSource & TaskMutationSource;

export function isTaskMutationSource(
  gateway: MemoryGateway,
): gateway is TaskMutationGateway {
  return (
    typeof (gateway as Partial<TaskMutationSource>).patchTask === "function" &&
    typeof (gateway as Partial<TaskMutationSource>).moveTask === "function" &&
    typeof (gateway as Partial<TaskMutationSource>).archiveTask === "function" &&
    typeof (gateway as Partial<TaskMutationSource>).adoptInboxItem === "function" &&
    typeof (gateway as Partial<TaskMutationSource>).hasUiToken === "function"
  );
}

/**
 * ADR 0014 owner-session surface: server-verified login (verify at the
 * door), the boot/401 probe of the live `vesmaro_ui` cookie and the
 * server-side logout (an HttpOnly cookie cannot be cleared from JS).
 * Structural like every guard above: the BoardAdapter grows these methods
 * (real wire), the mock adapter deliberately does not (the dev playground
 * has no auth wall and keeps the paste-and-store legacy path).
 */
export interface UiTokenSessionSource {
  verifyUiToken(token: string): Promise<UiTokenVerifyResult>;
  probeUiSession(): Promise<boolean>;
  logoutUiToken(): Promise<void>;
}

/** Gateway type that also speaks the owner-session wire. */
export type UiTokenSessionGateway = TaskMutationGateway & UiTokenSessionSource;

export function isUiTokenSessionSource(
  gateway: MemoryGateway,
): gateway is UiTokenSessionGateway {
  return (
    typeof (gateway as Partial<UiTokenSessionSource>).verifyUiToken === "function" &&
    typeof (gateway as Partial<UiTokenSessionSource>).probeUiSession === "function" &&
    typeof (gateway as Partial<UiTokenSessionSource>).logoutUiToken === "function"
  );
}

/**
 * AGW-1 agents-domain read surface (spec 2026-09-19 §5): the assignment
 * queue, the executor registry and the default-executor settings. Structural,
 * like every guard above — the mnemos HttpAdapter legitimately lacks the
 * methods and agents pages render their honest unsupported states. The
 * SCHED-1 automation surface deliberately has NO guard: it is consumed by a
 * later wave, adapter methods suffice for now.
 */
export interface AgentsSource {
  /** Assignment queue (`GET /api/assignments`) — items carry routing. */
  listAssignments(
    params?: AssignmentListParams,
    signal?: AbortSignal,
  ): Promise<AssignmentsPage>;
  /** Executor registry (`GET /api/executors`) — meta carries presence TTLs. */
  listExecutors(signal?: AbortSignal): Promise<ExecutorsPage>;
  /** Default/fallback executor pair (`GET /api/settings/execution`). */
  getExecutionSettings(signal?: AbortSignal): Promise<ExecutionSettings>;
  /** Harness dictionary (`GET /api/harnesses`, open read; wave 3C). */
  listHarnesses(signal?: AbortSignal): Promise<HarnessesPage>;
}

/** Gateway type that also serves the agents-domain reads. */
export type AgentsGateway = MemoryGateway & AgentsSource;

export function isAgentsSource(gateway: MemoryGateway): gateway is AgentsGateway {
  return (
    typeof (gateway as Partial<AgentsSource>).listAssignments === "function" &&
    typeof (gateway as Partial<AgentsSource>).listExecutors === "function" &&
    typeof (gateway as Partial<AgentsSource>).getExecutionSettings === "function" &&
    typeof (gateway as Partial<AgentsSource>).listHarnesses === "function"
  );
}

/**
 * AGW-1 agents-domain mutations — all ui-token class on the wire: queue an
 * attempt, cancel one, set the default-executor pair. `hasUiToken` is NOT
 * repeated here: the Ф3 mutation surface reuses the task guard's answer
 * (one token class, one panel).
 */
export interface AgentsMutationSource {
  /** Queue an execution attempt (`POST /api/assignments`, 201). */
  createAssignment(payload: AssignmentCreateInput): Promise<AssignmentCreatedResult>;
  /** Cancel (`POST /api/assignments/{id}/cancel`; queued/claimed/running). */
  cancelAssignment(
    assignmentId: number,
    reason?: string,
  ): Promise<AssignmentCancelledResult>;
  /** Set default/fallback (`PUT /api/settings/execution`; Amd 2 §5 gates). */
  putExecutionSettings(payload: ExecutionSettingsInput): Promise<ExecutionSettings>;
  /**
   * Owner PATCH of one executor (`PATCH /api/executors/{id}`, ui-token;
   * AGW-4): approve (pending→approved), enable/disable (routing
   * kill-switch), revoke (TERMINAL — the row never leaves revoked).
   */
  patchExecutor(
    executorId: string,
    patch: ExecutorPatchInput,
  ): Promise<ExecutorStateChangeResult>;
  /**
   * Remove the registry record (`DELETE /api/executors/{id}`, ui-token).
   * Hard delete — the executor's token dies with the row; active
   * assignments keep their pins/attribution verbatim (two-clock rule).
   */
  deleteExecutor(executorId: string): Promise<void>;
  /**
   * Mint a one-time enrollment token (`POST /api/executors/enrollment`,
   * ui-token; AGW-5 phase 2). The mne_ plaintext rides the 201 answer
   * only; 409 live-quota (≤3), 422 unknown harness_hint.
   */
  createEnrollment(payload: EnrollmentCreateInput): Promise<EnrollmentCreatedResult>;
  /** Token list for the owner panel (ui-token; live + terminal history). */
  listEnrollments(signal?: AbortSignal): Promise<EnrollmentsPage>;
  /** Revoke a LIVE token (idempotent on revoked; used/expired → 409). */
  revokeEnrollment(enrollmentId: string): Promise<EnrollmentRevokeResult>;
  /**
   * Add a harness to the dictionary (`POST /api/harnesses`, ui-token;
   * wave 3C). 201 row; 422 bad name or dictionary cap; 409 duplicate.
   */
  createHarness(payload: HarnessCreateInput): Promise<HarnessStateResult>;
  /**
   * Remove a harness (`DELETE /api/harnesses/{name}`, ui-token; wave 3C).
   * 404 unknown; 409 while live in an executor/assignment/rule.
   */
  deleteHarness(name: string): Promise<void>;
}

/** Gateway type that also speaks the agents-domain mutation wire. */
export type AgentsMutationGateway = MemoryGateway & AgentsSource & AgentsMutationSource;

export function isAgentsMutationSource(
  gateway: MemoryGateway,
): gateway is AgentsMutationGateway {
  return (
    typeof (gateway as Partial<AgentsMutationSource>).createAssignment === "function" &&
    typeof (gateway as Partial<AgentsMutationSource>).cancelAssignment === "function" &&
    typeof (gateway as Partial<AgentsMutationSource>).putExecutionSettings ===
      "function" &&
    typeof (gateway as Partial<AgentsMutationSource>).patchExecutor === "function" &&
    typeof (gateway as Partial<AgentsMutationSource>).deleteExecutor === "function" &&
    typeof (gateway as Partial<AgentsMutationSource>).createEnrollment === "function" &&
    typeof (gateway as Partial<AgentsMutationSource>).listEnrollments === "function" &&
    typeof (gateway as Partial<AgentsMutationSource>).revokeEnrollment === "function" &&
    typeof (gateway as Partial<AgentsMutationSource>).createHarness === "function" &&
    typeof (gateway as Partial<AgentsMutationSource>).deleteHarness === "function"
  );
}

/**
 * SCHED-1 automation read surface (ADR 0013 §8 — capability-gated on the
 * S1 API): status (with the condition meta-dictionary), both rule lists
 * and the launch journal. Structural like every guard — mnemos mode has
 * none of it and the section renders its honest unsupported state.
 */
export interface AutomationSource {
  automationStatus(signal?: AbortSignal): Promise<AutomationStatus>;
  /** Kill-switch + daily cap (`GET /api/automation/settings`, OPEN read). */
  getAutomationSettings(signal?: AbortSignal): Promise<AutomationSettings>;
  listSchedules(signal?: AbortSignal): Promise<SchedulesPage>;
  listHooks(signal?: AbortSignal): Promise<HooksPage>;
  listLaunches(params?: LaunchesParams, signal?: AbortSignal): Promise<LaunchesPage>;
}

export type AutomationGateway = MemoryGateway & AutomationSource;

export function isAutomationSource(
  gateway: MemoryGateway,
): gateway is AutomationGateway {
  return (
    typeof (gateway as Partial<AutomationSource>).automationStatus === "function" &&
    typeof (gateway as Partial<AutomationSource>).getAutomationSettings === "function" &&
    typeof (gateway as Partial<AutomationSource>).listSchedules === "function" &&
    typeof (gateway as Partial<AutomationSource>).listHooks === "function" &&
    typeof (gateway as Partial<AutomationSource>).listLaunches === "function"
  );
}

/**
 * SCHED-1 automation MUTATION surface (ADR 0013 §8): all ui-token class on
 * the wire; without a token the section stays visible with DISABLED
 * mutations and one honest explanation line.
 */
export interface AutomationMutationSource {
  createSchedule(payload: ScheduleCreateInput): Promise<ScheduleRule>;
  patchSchedule(ruleId: number, patch: SchedulePatchInput): Promise<ScheduleRule>;
  deleteSchedule(ruleId: number): Promise<RuleDeletedAck>;
  /** «Запустить сейчас» — the manual trigger (ADR 0013 §2: the owner's hand). */
  runScheduleNow(ruleId: number): Promise<ScheduleRunResult>;
  createHook(payload: HookCreateInput): Promise<HookRule>;
  patchHook(ruleId: number, patch: HookPatchInput): Promise<HookRule>;
  deleteHook(ruleId: number): Promise<RuleDeletedAck>;
  /**
   * Kill-switch + daily cap (`PUT /api/automation/settings`, ui-token;
   * audited automation.settings.changed old→new). UI-21 settings hub.
   */
  putAutomationSettings(payload: AutomationSettingsInput): Promise<AutomationSettings>;
}

export type AutomationMutationGateway = MemoryGateway &
  AutomationSource &
  AutomationMutationSource;

export function isAutomationMutationSource(
  gateway: MemoryGateway,
): gateway is AutomationMutationGateway {
  return (
    typeof (gateway as Partial<AutomationMutationSource>).createSchedule ===
      "function" &&
    typeof (gateway as Partial<AutomationMutationSource>).runScheduleNow ===
      "function" &&
    typeof (gateway as Partial<AutomationMutationSource>).createHook === "function" &&
    typeof (gateway as Partial<AutomationMutationSource>).deleteHook === "function" &&
    typeof (gateway as Partial<AutomationMutationSource>).putAutomationSettings === "function"
  );
}

/**
 * UI-17 tags cloud (spec 2026-09-21 §6): raw aggregated tag view with
 * per-store honesty (`errors[]` + `servers_scanned` on the board
 * `TagListOut`). Structural like every guard — the mnemos HttpAdapter
 * legitimately has no store-failure concept (single store) and the page
 * falls back to the plain `listTags` projection without the partial marker.
 */
export interface TagMergeSource {
  mergedTags(signal?: AbortSignal): Promise<MergedTags>;
}

export type TagMergeGateway = MemoryGateway & TagMergeSource;

export function isTagMergeSource(gateway: MemoryGateway): gateway is TagMergeGateway {
  return typeof (gateway as Partial<TagMergeSource>).mergedTags === "function";
}

/**
 * CV-7 pairing/devices owner surface (ADR 0012 §10.2): the device list plus
 * the trusted-side pairing legs (create / status / confirm / cancel — all
 * ui-token class on the wire; the UNauthenticated exchange leg is the
 * DEVICE's business and lives on the /pair page, never behind this guard).
 * Structural like every guard above: the mock dev playground has no pairing
 * and the section renders its honest unsupported state.
 */
export interface PairingSource {
  /** Device sessions (`GET /api/devices`, ui-token; no token material). */
  listDevices(signal?: AbortSignal): Promise<DevicesPage>;
  /** Revoke one device (`DELETE /api/devices/{id}`, ui-token; terminal). */
  revokeDevice(deviceId: string): Promise<DeviceRevokedResult>;
  /**
   * Set the per-device granule set (`PUT /api/devices/{id}/grants`,
   * ui-token; Amendment §A.7) — FULL replacement, live on the next
   * device request.
   */
  setDeviceGrants(
    deviceId: string,
    grants: readonly string[],
  ): Promise<DeviceGrantsResult>;
  /** Start a pairing (`POST /api/pairing`, ui-token; 201 = code + verify). */
  createPairing(): Promise<PairingCreatedResult>;
  /** Trusted-side status (`GET /api/pairing/{id}`, ui-token; verify source). */
  getPairing(pairingId: string, signal?: AbortSignal): Promise<PairingStatus>;
  /** Owner decision (`POST /api/pairing/{id}/confirm {allow}`, ui-token). */
  confirmPairing(pairingId: string, allow: boolean): Promise<PairingConfirmResult>;
  /** Cancel before issued (`DELETE /api/pairing/{id}`, ui-token). */
  cancelPairing(pairingId: string): Promise<PairingConfirmResult>;
}

export type PairingGateway = MemoryGateway & PairingSource;

export function isPairingSource(gateway: MemoryGateway): gateway is PairingGateway {
  return (
    typeof (gateway as Partial<PairingSource>).listDevices === "function" &&
    typeof (gateway as Partial<PairingSource>).revokeDevice === "function" &&
    typeof (gateway as Partial<PairingSource>).setDeviceGrants === "function" &&
    typeof (gateway as Partial<PairingSource>).createPairing === "function" &&
    typeof (gateway as Partial<PairingSource>).confirmPairing === "function" &&
    typeof (gateway as Partial<PairingSource>).cancelPairing === "function"
  );
}

/**
 * The DEVICE leg of the pairing protocol (`POST /api/pairing/exchange`,
 * NO auth — the single-use code IS the credential, ADR 0012 §2.3). Kept a
 * separate guard: the /pair page must work without ANY session surface.
 */
export interface PairingExchangeSource {
  exchangePairing(
    payload: PairingExchangeInput,
  ): Promise<PairingExchangeAwaiting | PairingIssuedResult>;
}

export function isPairingExchangeSource(
  gateway: MemoryGateway,
): gateway is MemoryGateway & PairingExchangeSource {
  return (
    typeof (gateway as Partial<PairingExchangeSource>).exchangePairing === "function"
  );
}
