import type { MemoryGateway } from "./MemoryGateway";
import type { InboxParams } from "./BoardAdapter";
import { ApiError } from "@/lib/errors";
import { MOCK_MEMORIES, MOCK_SESSIONS, MOCK_TRACES } from "./fixtures";
import {
  MOCK_ARCHIVED_TASK,
  MOCK_BOARD,
  MOCK_HISTORY,
  MOCK_INBOX,
  MOCK_REPORTS,
  MOCK_TASK_MEMORIES,
  MOCK_TASKS,
} from "./boardFixtures";
import type {
  ArchivePage,
  ArchiveParams,
  BoardHealthDetail,
  BoardSummary,
  InboxRefreshResult,
  MemoryPulse,
  MemoryPulseItem,
  PulseParams,
  TaskCreateInput,
  TaskHistory,
  TaskInbox,
  TaskInboxEntry,
  TaskMemories,
  TaskMutationAck,
  TaskPatchInput,
  TaskReports,
  TaskUnarchiveResult,
} from "./boardTypes";
import type { BoardTask } from "./boardTypes";
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

/** Default wire limit for search (mirrors mnemos `SearchQuery.limit`). */
const DEFAULT_SEARCH_LIMIT = 20;
/** Default wire limit for the traces list. */
const DEFAULT_TRACE_LIMIT = 50;
/** Default wire limit for agent recall. */
const DEFAULT_RECALL_LIMIT = 5;

/** BE-12 content window: tasks older than this are 423-locked without force. */
const LOCK_WINDOW_MS = 24 * 60 * 60 * 1000;

/** WF-1 wire mirror: column → workflow status (store.COLUMN_STATUS_MAP). */
const MOCK_COLUMN_STATUS_MAP: Readonly<Record<string, string>> = {
  backlog: "open",
  validating: "open",
  open: "open",
  "in-progress": "in-progress",
  blocked: "blocked",
  resolved: "resolved",
  done: "done",
};

export interface MockAdapterOptions {
  /**
   * Simulated network latency. Default 80–200 ms (drawn from a seeded PRNG,
   * so the sequence is deterministic). `false` disables delays entirely —
   * use in tests.
   */
  latency?: false | { minMs: number; maxMs: number };
  /**
   * Clock seam for the Ф3 mutation paths (BE-12 24h lock, updated_at bumps).
   * Defaults to real `Date.now`; tests inject a fixed epoch. Reads never
   * consult the clock, so untouched instances stay byte-identical.
   */
  now?: () => number;
}

/**
 * In-memory adapter for UI development without a live mnemos (task T2).
 * Full `MemoryGateway` implementation over the deterministic fixtures
 * (fixtures.ts): substring search with a surface-weighted rank that imitates
 * FTS+semantic behaviour, wire-compatible pagination and filters, and honest
 * 404s. Toggle via `VITE_MNEMOS_ADAPTER=mock`.
 */
export class MockAdapter implements MemoryGateway {
  private readonly latency: false | { minMs: number; maxMs: number };
  private readonly rand: () => number;
  private readonly now: () => number;

  // --- Ф3 mutable task state (cloned per instance; fixtures stay pristine) ----
  private tasks: BoardTask[];
  private archivedTasks: BoardTask[];
  private inboxItems: TaskInboxEntry[];
  private nextTaskNo = 1;

  constructor(options: MockAdapterOptions = {}) {
    this.latency = options.latency ?? { minMs: 80, maxMs: 200 };
    // Fixed seed → identical latency sequences across runs.
    this.rand = mulberry32(20260916);
    this.now = options.now ?? (() => Date.now());
    this.tasks = MOCK_TASKS.map((task) => ({ ...task }));
    this.archivedTasks = [{ ...MOCK_ARCHIVED_TASK }];
    this.inboxItems = MOCK_INBOX.items.map((item) => ({ ...item }));
  }

  async search(params: SearchParams, signal?: AbortSignal): Promise<SearchResult[]> {
    await this.delay(signal);
    const terms = tokenize(params.query);
    if (terms.length === 0) return [];

    const hits: SearchResult[] = [];
    for (const memory of MOCK_MEMORIES) {
      const match = scoreMemory(memory, terms, params.tags, params.project);
      if (!match) continue;
      hits.push({
        id: memory.id ?? `mem-${hits.length}`,
        title: memory.title ?? "",
        content: memory.content,
        tags: [...(memory.tags ?? [])],
        score: match.score,
        search_type: match.searchType,
      });
    }

    hits.sort(byScoreDesc);
    return hits.slice(0, params.limit ?? DEFAULT_SEARCH_LIMIT);
  }

  async listMemories(
    params: ListMemoriesParams = {},
    signal?: AbortSignal,
  ): Promise<Memory[]> {
    await this.delay(signal);
    const filtered = MOCK_MEMORIES.filter(
      (memory) =>
        (params.status === undefined || memory.status === params.status) &&
        (params.project === undefined || memory.project === params.project),
    ).sort(byCreatedDesc);
    const offset = params.offset ?? 0;
    return filtered
      .slice(offset, params.limit === undefined ? undefined : offset + params.limit)
      .map((memory) => ({ ...memory }));
  }

  async getMemory(
    id: string,
    includeRaw = false,
    signal?: AbortSignal,
  ): Promise<Memory> {
    await this.delay(signal);
    const memory = MOCK_MEMORIES.find((candidate) => candidate.id === id);
    if (!memory) {
      throw new ApiError(404, `Memory "${id}" not found`, {
        url: `mock:/memories/${id}`,
      });
    }
    // Imitate the wire: raw_content is withheld unless explicitly requested.
    return includeRaw ? { ...memory } : { ...memory, raw_content: null };
  }

  async listTags(signal?: AbortSignal): Promise<TagSummary[]> {
    await this.delay(signal);
    const counts = new Map<string, number>();
    for (const memory of MOCK_MEMORIES) {
      for (const tag of memory.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  async agentRecall(
    agent: string,
    project?: string,
    query?: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    await this.delay(signal);
    const agentTag = `agent:${agent}`;
    const terms = tokenize(query ?? "");

    const candidates = MOCK_MEMORIES.filter(
      (memory) =>
        (memory.agent === agent || (memory.tags ?? []).includes(agentTag)) &&
        (project === undefined || memory.project === project) &&
        terms.every(
          (term) =>
            (memory.title ?? "").toLowerCase().includes(term) ||
            memory.content.toLowerCase().includes(term) ||
            (memory.tags ?? []).some((tag) => tag.toLowerCase().includes(term)),
        ),
    ).sort(byCreatedDesc);

    const total = Math.max(candidates.length, 1);
    return candidates.slice(0, limit ?? DEFAULT_RECALL_LIMIT).map((memory, index) => ({
      id: memory.id ?? `recall-${index}`,
      title: memory.title ?? "",
      content: memory.content,
      tags: [...(memory.tags ?? [])],
      // Recency-flavoured score: newest candidate scores 1.0.
      score: round((total - index) / total, 4),
      search_type: "hybrid",
    }));
  }

  async health(signal?: AbortSignal): Promise<HealthStatus> {
    await this.delay(signal);
    // HealthStatus is a string-valued map on the wire.
    return {
      status: "ok",
      version: "4.1.0-mock",
      project: "mnemos-eyes",
    };
  }

  /**
   * Board-native per-store health (Ф1 Overview). Mirrors the BoardAdapter
   * wire with the mock's honest truth: one live store holding the fixtures,
   * one paused store (the neutral "not probed" card branch — disabled stores
   * are skipped by the merge, so its ok flag is false without an error).
   */
  async boardHealth(signal?: AbortSignal): Promise<BoardHealthDetail> {
    await this.delay(signal);
    return {
      ok: true,
      service: "vesmaro-eyes",
      board_tasks: MOCK_TRACES.length,
      servers: [
        {
          name: "mock-store",
          group_name: "default",
          enabled: true,
          state: "idle",
          description: "in-memory fixtures",
          ok: true,
          latency_ms: 24,
          error: null,
          memories_total: MOCK_MEMORIES.length,
        },
        {
          name: "mock-store-paused",
          group_name: "default",
          enabled: false,
          state: "paused",
          description: "paused store (mock)",
          ok: false,
          latency_ms: null,
          error: null,
          memories_total: null,
        },
      ],
    };
  }

  /**
   * Board-native merged recency feed (Ф1 Pulse). The mock has a single
   * store, so every row carries the same provenance stamp; scope filtering
   * honours the board contract: unknown names fail honestly (404).
   */
  async pulse(params: PulseParams = {}, signal?: AbortSignal): Promise<MemoryPulse> {
    await this.delay(signal);
    const scope = params.scope && params.scope !== "all" ? params.scope : "";
    if (scope && scope !== "mock-store" && scope !== "mock-store-paused") {
      throw new ApiError(404, `no memory server or group named '${scope}'`, {
        url: "mock:/api/memories/pulse",
      });
    }
    const pool =
      scope === "mock-store-paused"
        ? []
        : MOCK_MEMORIES.filter(
            (memory) =>
              params.project === undefined || memory.project === params.project,
          ).sort(byCreatedDesc);
    const items: MemoryPulseItem[] = pool
      .slice(0, params.limit ?? 12)
      .map((memory) => ({
        id: memory.id ?? "mem-mock",
        title: memory.title ?? "",
        tags: [...(memory.tags ?? [])],
        status: memory.status,
        created_at: memory.created_at ?? "",
        server: scope || "mock-store",
      }));
    return {
      ok: scope !== "mock-store-paused",
      scope: scope || "all",
      kind: scope ? "server" : "all",
      items,
      per_server: [
        {
          server: scope || "mock-store",
          ok: scope !== "mock-store-paused",
          items: items.length,
          detail: null,
        },
      ],
    };
  }

  // --- Ф2 task domain reads (mutable state; corpus-shaped deterministic seed) ---

  /** Board projection with the server's optional ?status= filter semantics. */
  async board(status?: string, signal?: AbortSignal): Promise<BoardSummary> {
    await this.delay(signal);
    const tasks = status
      ? this.tasks.filter((task) => task.status === status)
      : this.tasks;
    return {
      columns: [...MOCK_BOARD.columns],
      tasks: tasks.map((task) => ({ ...task })),
      counts: countByColumn(this.tasks),
    };
  }

  /** Inbox read; the mock honours the wire's `include_adopted` switch. */
  async inbox(params: InboxParams = {}, signal?: AbortSignal): Promise<TaskInbox> {
    await this.delay(signal);
    const items = this.inboxItems
      .filter((item) => params.include_adopted || !item.adopted)
      .filter((item) => !params.project || item.project === params.project)
      .map((item) => ({ ...item }));
    return { ...MOCK_INBOX, items, count: items.length };
  }

  async reports(taskId: string, signal?: AbortSignal): Promise<TaskReports> {
    await this.delay(signal);
    requireMockTask(taskId, this.tasks, this.archivedTasks);
    if (taskId !== MOCK_REPORTS.task_id) {
      return { ok: true, task_id: taskId, count: 0, items: [] };
    }
    return { ...MOCK_REPORTS, items: MOCK_REPORTS.items.map((item) => ({ ...item })) };
  }

  async history(taskId: string, signal?: AbortSignal): Promise<TaskHistory> {
    await this.delay(signal);
    requireMockTask(taskId, this.tasks, this.archivedTasks);
    if (taskId !== MOCK_REPORTS.task_id) {
      return { events: [], memories: [] };
    }
    return {
      events: MOCK_HISTORY.events.map((event) => ({ ...event })),
      memories: MOCK_HISTORY.memories.map((memory) => ({ ...memory })),
    };
  }

  async taskMemories(taskId: string, signal?: AbortSignal): Promise<TaskMemories> {
    await this.delay(signal);
    requireMockTask(taskId, this.tasks, this.archivedTasks);
    if (taskId !== MOCK_REPORTS.task_id) {
      return { items: {}, unresolved: [], sources: {} };
    }
    return {
      items: { ...MOCK_TASK_MEMORIES.items },
      unresolved: MOCK_TASK_MEMORIES.unresolved.map((row) => ({ ...row })),
      sources: { ...MOCK_TASK_MEMORIES.sources },
    };
  }

  async archive(
    params: ArchiveParams = {},
    signal?: AbortSignal,
  ): Promise<ArchivePage> {
    await this.delay(signal);
    const q = (params.q ?? "").trim().toLowerCase();
    const rows = this.archivedTasks.filter((task) => {
      if (q && !`${task.title} ${task.summary}`.toLowerCase().includes(q)) return false;
      if (params.status && task.status !== params.status) return false;
      if (params.col && task.col !== params.col) return false;
      if (params.agent && !task.agents.includes(params.agent)) return false;
      if (params.project && task.project !== params.project) return false;
      return true;
    });
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 50;
    return {
      ok: true,
      count: rows.length,
      total: rows.length,
      limit,
      offset,
      items: rows.slice(offset, offset + limit).map((task) => ({ ...task })),
      projects: groupArchiveProjects(rows),
    };
  }

  async taskById(taskId: string, signal?: AbortSignal): Promise<BoardTask> {
    await this.delay(signal);
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new ApiError(404, `task '${taskId}' not found on the board`, {
        url: "mock:/api/board",
      });
    }
    return { ...task };
  }

  // --- Ф3 mutations (mirror the board wire contract, ui-token gate excluded) ---
  // The mock is the dev playground: hasUiToken() answers true and no auth
  // wall exists, so mutation flows are exercisable without a token panel.

  hasUiToken(): boolean {
    return true;
  }

  async createTask(payload: TaskCreateInput, signal?: AbortSignal): Promise<BoardTask> {
    await this.delay(signal);
    const title = (payload.title ?? "").trim();
    if (title.length === 0 || title.length > 200) {
      throw new ApiError(422, "title must be 1..200 characters", {
        url: "mock:/api/tasks",
      });
    }
    const col = payload.col || "open";
    const task: BoardTask = {
      id: `MB-${this.nextTaskNo++}`,
      col,
      position: 0,
      title,
      summary: payload.summary ?? "",
      spec: payload.spec ?? "",
      agents: [...(payload.agents ?? [])],
      specialists: [...(payload.specialists ?? [])],
      env: payload.env || "unknown",
      project: payload.project ?? "",
      memory_ids: [...(payload.memory_ids ?? [])],
      mnemos_tags: [...(payload.mnemos_tags ?? [])],
      created_at: this.stamp(),
      updated_at: this.stamp(),
      archived: 0,
      status: payload.status ?? MOCK_COLUMN_STATUS_MAP[col] ?? col,
      priority: payload.priority || "normal",
      archived_from: "",
      // WF-1: a task born in the validation lane starts its clock now.
      validating_since: col === "validating" ? this.stamp() : "",
    };
    this.tasks.push(task);
    return { ...task };
  }

  async patchTask(
    taskId: string,
    patch: TaskPatchInput,
    signal?: AbortSignal,
  ): Promise<BoardTask> {
    await this.delay(signal);
    const task = findMutableTask(taskId, this.tasks, this.archivedTasks);
    // BE-12 mirror: content edits on tasks older than 24h answer 423 unless
    // force; status transitions are never locked. Wire null = field absent.
    const present = (value: unknown): boolean => value !== undefined && value !== null;
    const touchesContent = CONTENT_FIELDS.some((field) =>
      present((patch as Record<string, unknown>)[field]),
    );
    const ageMs = this.now() - Date.parse(task.updated_at);
    if (touchesContent && patch.force !== true && ageMs > LOCK_WINDOW_MS) {
      throw new ApiError(
        423,
        `task '${taskId}' is older than 24h — edit with force=true`,
        {
          url: `mock:/api/tasks/${taskId}`,
        },
      );
    }
    const next: BoardTask = {
      ...task,
      ...(patch.title != null ? { title: patch.title } : {}),
      ...(patch.summary != null ? { summary: patch.summary } : {}),
      ...(patch.spec != null ? { spec: patch.spec } : {}),
      ...(patch.project != null ? { project: patch.project } : {}),
      ...(patch.env != null ? { env: patch.env } : {}),
      ...(patch.priority != null ? { priority: patch.priority } : {}),
      ...(patch.status != null ? { status: patch.status } : {}),
      ...(patch.agents != null ? { agents: [...patch.agents] } : {}),
      ...(patch.specialists != null ? { specialists: [...patch.specialists] } : {}),
      ...(patch.memory_ids != null ? { memory_ids: [...patch.memory_ids] } : {}),
      ...(patch.mnemos_tags != null ? { mnemos_tags: [...patch.mnemos_tags] } : {}),
      updated_at: this.stamp(),
    };
    replaceInPlace(this.tasks, next);
    if (this.archivedTasks.some((row) => row.id === taskId)) {
      replaceInPlace(this.archivedTasks, next);
    }
    return { ...next };
  }

  async moveTask(
    taskId: string,
    col: string,
    position?: number,
    signal?: AbortSignal,
  ): Promise<BoardTask> {
    await this.delay(signal);
    const task = findMutableTask(taskId, this.tasks, this.archivedTasks);
    // WF-1 v1 transition mirror (store.move_task): blocked → done/resolved
    // is rejected — the block lifts through in-progress first.
    if (task.col === "blocked" && (col === "done" || col === "resolved")) {
      throw new ApiError(
        422,
        `недопустимый переход: ${task.col} → ${col} — сначала in-progress (приёмка идёт через resolved)`,
        { url: `mock:/api/tasks/${taskId}/move` },
      );
    }
    // WF-1 clock: entering validating stamps it, leaving clears it, a
    // same-column reorder (position-only) keeps it untouched.
    const enteringValidating = col === "validating" && task.col !== "validating";
    const leavingValidating = col !== "validating" && task.col === "validating";
    const next: BoardTask = {
      ...task,
      col,
      ...(position !== undefined ? { position } : {}),
      status: MOCK_COLUMN_STATUS_MAP[col] ?? col, // COLUMN_STATUS_MAP mirror
      updated_at: this.stamp(),
      ...(enteringValidating ? { validating_since: this.stamp() } : {}),
      ...(leavingValidating ? { validating_since: "" } : {}),
    };
    replaceInPlace(this.tasks, next);
    return { ...next };
  }

  async archiveTask(taskId: string, signal?: AbortSignal): Promise<TaskMutationAck> {
    await this.delay(signal);
    const task = findMutableTask(taskId, this.tasks, this.archivedTasks);
    if (task.archived === 1) {
      throw new ApiError(409, `task '${taskId}' is already archived`, {
        url: `mock:/api/tasks/${taskId}/archive`,
      });
    }
    const archived: BoardTask = {
      ...task,
      archived: 1,
      archived_from: task.col,
      updated_at: this.stamp(),
    };
    this.tasks = this.tasks.filter((row) => row.id !== taskId);
    replaceInPlace(this.archivedTasks, archived, /* append */ true);
    return { ok: true };
  }

  async unarchiveTask(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<TaskUnarchiveResult> {
    await this.delay(signal);
    const task = findMutableTask(taskId, this.tasks, this.archivedTasks);
    if (task.archived !== 1) {
      throw new ApiError(409, `task '${taskId}' is not archived`, {
        url: `mock:/api/tasks/${taskId}/unarchive`,
      });
    }
    const restored: BoardTask = {
      ...task,
      col: task.archived_from || "open", // BE-11b fallback: open
      archived: 0,
      archived_from: "",
      updated_at: this.stamp(),
    };
    this.archivedTasks = this.archivedTasks.filter((row) => row.id !== taskId);
    replaceInPlace(this.tasks, restored, /* append */ true);
    return { ok: true, task: { ...restored } };
  }

  async adoptInboxItem(memoryId: string, signal?: AbortSignal): Promise<BoardTask> {
    await this.delay(signal);
    const item = this.inboxItems.find((row) => row.memory_id === memoryId);
    if (!item) {
      throw new ApiError(404, `inbox row '${memoryId}' not found`, {
        url: `mock:/api/tasks/inbox/${memoryId}/adopt`,
      });
    }
    if (item.adopted && item.adopted_task_id) {
      // Wire mirrors a double adoption with 409 + {task_id} in the body.
      throw new ApiError(409, `already adopted as ${item.adopted_task_id}`, {
        url: `mock:/api/tasks/inbox/${memoryId}/adopt`,
        body: JSON.stringify({ task_id: item.adopted_task_id }),
      });
    }
    const created = await this.createTask(
      {
        title: item.title,
        summary: item.excerpt,
        spec: "",
        col: "open",
        priority: item.priority || "normal",
        env: "unknown",
        agents: [],
        specialists: item.specialist ? [item.specialist] : [],
        project: item.project,
        memory_ids: [item.memory_id], // SEC-4: link, never copy content
        mnemos_tags: [...item.tags],
      },
      signal,
    );
    const index = this.inboxItems.findIndex((row) => row.memory_id === memoryId);
    this.inboxItems[index] = {
      ...item,
      adopted: true,
      adopted_task_id: created.id,
    };
    return created;
  }

  async refreshInbox(signal?: AbortSignal): Promise<InboxRefreshResult> {
    await this.delay(signal);
    // The mock re-sees its whole mirror set; nothing new appears because the
    // scan is over the same deterministic fixtures.
    return {
      scanned_servers: 2,
      found: this.inboxItems.length,
      new: 0,
      errors: [],
    };
  }

  /** Deterministic wire-format timestamp for mutation-created rows. */
  private stamp(): string {
    return new Date(this.now()).toISOString().replace("Z", "+00:00");
  }

  async metrics(signal?: AbortSignal): Promise<Metrics> {
    await this.delay(signal);
    const byStatus: Record<string, number> = {};
    for (const memory of MOCK_MEMORIES) {
      byStatus[memory.status] = (byStatus[memory.status] ?? 0) + 1;
    }
    const tags = new Set(MOCK_MEMORIES.flatMap((memory) => memory.tags ?? []));
    const scored = MOCK_MEMORIES.filter((m) => typeof m.quality_score === "number");
    const avgQuality =
      scored.reduce((sum, m) => sum + (m.quality_score ?? 0), 0) /
      Math.max(scored.length, 1);
    return {
      memories_total: MOCK_MEMORIES.length,
      memories_by_status: byStatus,
      tags_total: tags.size,
      sessions_total: MOCK_SESSIONS.length,
      traces_total: MOCK_TRACES.length,
      avg_quality_score: round(avgQuality, 4),
      adapter: "mock",
      generated_at: "2026-09-16T00:00:00Z",
    };
  }

  async listTraces(
    taskLabel?: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<Trace[]> {
    await this.delay(signal);
    const entries = [...MOCK_TRACES]
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .filter((trace) => taskLabel === undefined || trace.task_label === taskLabel)
      .slice(0, limit ?? DEFAULT_TRACE_LIMIT);
    return entries.map((trace) => ({ ...trace }));
  }

  async listSessions(signal?: AbortSignal): Promise<A2ASession[]> {
    await this.delay(signal);
    return [...MOCK_SESSIONS]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((session) => ({ ...session }));
  }

  async getSession(id: string, signal?: AbortSignal): Promise<A2ASession> {
    await this.delay(signal);
    const session = MOCK_SESSIONS.find((candidate) => candidate.session_id === id);
    if (!session) {
      throw new ApiError(404, `Session "${id}" not found`, {
        url: `mock:/v1/sessions/${id}`,
      });
    }
    return { ...session };
  }

  /** Simulated latency; honours external cancellation mid-delay. */
  private async delay(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.latency === false) return;
    const { minMs, maxMs } = this.latency;
    const ms = Math.round(minMs + this.rand() * (maxMs - minMs));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(abortError());
        },
        { once: true },
      );
    });
    throwIfAborted(signal);
  }
}

/** Honest 404 mirror of the board routes for unknown task ids. */
function requireMockTask(
  taskId: string,
  tasks: readonly BoardTask[],
  archivedTasks: readonly BoardTask[],
): void {
  const known =
    tasks.some((task) => task.id === taskId) ||
    archivedTasks.some((task) => task.id === taskId);
  if (!known) {
    throw new ApiError(404, `task '${taskId}' not found on the board`, {
      url: "mock:/api/tasks/" + encodeURIComponent(taskId),
    });
  }
}

/** BoardTask lookup across live + archived state (mutation paths). */
function findMutableTask(
  taskId: string,
  tasks: readonly BoardTask[],
  archivedTasks: readonly BoardTask[],
): BoardTask {
  const task =
    tasks.find((row) => row.id === taskId) ??
    archivedTasks.find((row) => row.id === taskId);
  if (!task) {
    throw new ApiError(404, `task '${taskId}' not found on the board`, {
      url: "mock:/api/tasks/" + encodeURIComponent(taskId),
    });
  }
  return { ...task };
}

/** Replace (or append) one row inside a mutable task list. */
function replaceInPlace(list: BoardTask[], task: BoardTask, append = false): void {
  const index = list.findIndex((row) => row.id === task.id);
  if (index >= 0) list[index] = task;
  else if (append) list.push(task);
}

/** BE-12 EDITABLE_FIELDS mirror — the fields behind the 24h lock. */
const CONTENT_FIELDS = [
  "title",
  "summary",
  "spec",
  "project",
  "env",
  "priority",
  "agents",
  "specialists",
  "memory_ids",
  "mnemos_tags",
] as const;

/** Recompute the per-column counts (board-projection `counts`). */
function countByColumn(tasks: readonly BoardTask[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const column of MOCK_BOARD.columns) counts[column] = 0;
  for (const task of tasks) counts[task.col] = (counts[task.col] ?? 0) + 1;
  return counts;
}

/** Archive teaser grouping over the FULL matching set (BE-11b wire shape). */
function groupArchiveProjects(rows: readonly BoardTask[]): ArchivePage["projects"] {
  const projects: Record<
    string,
    {
      id: string;
      title: string;
      col: string;
      agents: string[];
      env: string;
      updated_at: string;
    }[]
  > = {};
  for (const task of rows) {
    const key = task.project || "";
    const teaser = {
      id: task.id,
      title: task.title,
      col: task.col,
      agents: [...task.agents],
      env: task.env,
      updated_at: task.updated_at,
    };
    projects[key] = [...(projects[key] ?? []), teaser];
  }
  return projects;
}

// --- Search heuristics (FTS/semantic imitation) ------------------------------
interface MemoryMatch {
  score: number;
  searchType: SearchResult["search_type"];
}

/**
 * Score one memory against the tokenised query. All terms must match
 * somewhere (AND). Weights: title/tag hit 3, content hit 1, normalised to
 * 0..1 (per-term max 3+1=4). `search_type` imitates the pipeline:
 * title/tag-only → "fts", content-only → "semantic", both → "hybrid".
 */
function scoreMemory(
  memory: Memory,
  terms: string[],
  tagsFilter?: string[],
  project?: string,
): MemoryMatch | null {
  if (project !== undefined && memory.project !== project) return null;
  if (tagsFilter && tagsFilter.length > 0) {
    const memoryTags = memory.tags ?? [];
    if (!tagsFilter.every((tag) => memoryTags.includes(tag))) return null;
  }

  const title = (memory.title ?? "").toLowerCase();
  const content = memory.content.toLowerCase();
  const tags = (memory.tags ?? []).map((tag) => tag.toLowerCase());

  let sum = 0;
  let sawTitleOrTag = false;
  let sawContent = false;
  for (const term of terms) {
    const inTitle = title.includes(term);
    const inTag = tags.some((tag) => tag.includes(term));
    const inContent = content.includes(term);
    if (!inTitle && !inTag && !inContent) return null; // AND semantics
    if (inTitle || inTag) {
      sum += 3;
      sawTitleOrTag = true;
    }
    if (inContent) {
      sum += 1;
      sawContent = true;
    }
  }

  const score = round(sum / (terms.length * 4), 4);
  const searchType: SearchResult["search_type"] =
    sawTitleOrTag && sawContent ? "hybrid" : sawTitleOrTag ? "fts" : "semantic";
  return { score, searchType };
}

/** Lowercase, split on whitespace, drop empties. */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

// --- Deterministic helpers ----------------------------------------------------

/** Sort by score desc; created_at desc then id as deterministic tiebreaks. */
function byScoreDesc(a: SearchResult, b: SearchResult): number {
  const memoryA = MOCK_MEMORIES.find((m) => m.id === a.id);
  const memoryB = MOCK_MEMORIES.find((m) => m.id === b.id);
  if (b.score !== a.score) return b.score - a.score;
  const byDate = compareCreated(memoryA, memoryB);
  if (byDate !== 0) return byDate;
  return a.id.localeCompare(b.id);
}

/** Sort by created_at desc with an id tiebreak (fixture dates are unique). */
function byCreatedDesc(a: Memory, b: Memory): number {
  return compareCreated(a, b) || (a.id ?? "").localeCompare(b.id ?? "");
}

function compareCreated(a?: Memory, b?: Memory): number {
  return (b?.created_at ?? "").localeCompare(a?.created_at ?? "");
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Deterministic PRNG (mulberry32) — no Math.random anywhere in the mock. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}
