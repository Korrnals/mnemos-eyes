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
  ExecutionSettings,
  ExecutionSettingsInput,
  ExecutorsPage,
} from "./boardTypes";
import type { InboxParams } from "./BoardAdapter";

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
}

/** Gateway type that also serves the agents-domain reads. */
export type AgentsGateway = MemoryGateway & AgentsSource;

export function isAgentsSource(gateway: MemoryGateway): gateway is AgentsGateway {
  return (
    typeof (gateway as Partial<AgentsSource>).listAssignments === "function" &&
    typeof (gateway as Partial<AgentsSource>).listExecutors === "function" &&
    typeof (gateway as Partial<AgentsSource>).getExecutionSettings === "function"
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
      "function"
  );
}
