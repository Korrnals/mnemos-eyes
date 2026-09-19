import type { MemoryGateway } from "./MemoryGateway";
import type { EventStream } from "./events";
import type {
  ArchivePage,
  ArchiveParams,
  BoardHealthDetail,
  BoardSummary,
  MemoryPulse,
  PulseParams,
  TaskHistory,
  TaskInbox,
  TaskMemories,
  TaskReports,
} from "./boardTypes";
import type { BoardTask } from "./boardTypes";
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
