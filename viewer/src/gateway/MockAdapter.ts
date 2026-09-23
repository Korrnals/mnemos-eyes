import type { MemoryGateway } from "./MemoryGateway";
import type { InboxParams } from "./BoardAdapter";
import { resolveRoutingAnnotation } from "./routing";
import { ApiError } from "@/lib/errors";
import { MOCK_INBOX_MEMORY, MOCK_MEMORIES, MOCK_SESSIONS, MOCK_TRACES } from "./fixtures";
import {
  MOCK_ARCHIVED_TASK,
  MOCK_ASSIGNMENTS,
  MOCK_AUTOMATION_SETTINGS,
  MOCK_AUTOMATION_STATUS,
  MOCK_BOARD,
  MOCK_EXECUTORS,
  MOCK_EXECUTORS_META,
  MOCK_EXECUTION_SETTINGS,
  MOCK_HARNESSES,
  MOCK_HISTORY,
  MOCK_HOOKS,
  MOCK_INBOX,
  MOCK_LAUNCHES,
  MOCK_REPORTS,
  MOCK_SCHEDULES,
  MOCK_TASK_MEMORIES,
  MOCK_TASKS,
} from "./boardFixtures";
import type {
  ArchivePage,
  ArchiveParams,
  AssignmentCancelledResult,
  AssignmentCreateInput,
  AssignmentCreatedResult,
  AssignmentItem,
  AssignmentLifecycleState,
  AssignmentListParams,
  AssignmentsPage,
  AutomationSettings,
  AutomationSettingsInput,
  AutomationStatus,
  BoardHealthDetail,
  BoardSummary,
  ExecutionSettings,
  ExecutionSettingsInput,
  ExecutorItem,
  ExecutorPatchInput,
  ExecutorRegistryState,
  ExecutorStateChangeResult,
  ExecutorsPage,
  EnrollmentCreateInput,
  EnrollmentCreatedResult,
  EnrollmentItem,
  EnrollmentRevokeResult,
  EnrollmentsPage,
  HarnessCreateInput,
  HarnessesPage,
  HarnessItem,
  HarnessStateResult,
  HookCreateInput,
  HookPatchInput,
  HookRule,
  HooksPage,
  InboxEditInput,
  InboxRefreshResult,
  LaunchRow,
  LaunchesPage,
  LaunchesParams,
  MemoryPulse,
  MemoryPulseItem,
  PulseParams,
  RoutingAnnotation,
  RuleDeletedAck,
  ScheduleCreateInput,
  SchedulePatchInput,
  ScheduleRule,
  ScheduleRunResult,
  SchedulesPage,
  TagDrill,
  TagDrillMemory,
  TagDrillParams,
  TagDrillTask,
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
import type { BoardTask, MergedTags } from "./boardTypes";
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
/** Default wire page size for the automation launch journal (server mirror). */
const DEFAULT_LAUNCH_LIMIT = 50;
/** Launch journal page cap (server `_AUTOMATION_PAGE_CAP` mirror). */
const LAUNCH_PAGE_CAP = 200;

/**
 * Pulse preview overrides (mock-only). The shared corpus stays plain prose
 * so every index/count assertion keeps holding; the pulse mapping decorates
 * two rows instead, to exercise every TextEngine path in dev and dev-test:
 * mem-0004 carries a small markdown fragment (heading + list → lazy
 * renderer chunk), mem-0005 carries no fragment at all (honest absence).
 */
const MOCK_PULSE_CONTENT_OVERRIDES: Readonly<Record<string, string | null>> = {
  "mem-0004": "# Decision log\n\n- namespaced tags only\n- `topic:` slugs reviewed weekly",
  "mem-0005": null,
};

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
  /**
   * Tag corpus override (UI-17 spec §10.5): a deterministic ~610-tag dataset
   * with the Zipf-like live distribution, so band sections / caps / the DOM
   * budget are tested at true scale instead of the ~30 fixture tags. When
   * absent, `listTags`/`mergedTags` keep deriving counts from MOCK_MEMORIES.
   */
  tagCorpus?: readonly TagSummary[];
  /**
   * Simulated unreachable stores for `mergedTags` (UI-17 spec §6 partial
   * state: `errors[]` ≠ ∅ → the ◐ marker + tooltip; the cloud still renders
   * from the answering corpus).
   */
  tagStoreErrors?: readonly { readonly server?: string; readonly status?: number }[];
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
  private readonly tagCorpus: readonly TagSummary[] | undefined;
  private readonly tagStoreErrors: readonly {
    readonly server?: string;
    readonly status?: number;
  }[];

  // --- Ф3 mutable task state (cloned per instance; fixtures stay pristine) ----
  private tasks: BoardTask[];
  private archivedTasks: BoardTask[];
  private inboxItems: TaskInboxEntry[];
  private nextTaskNo = 1;

  // --- AGW-1 mutable agents state (same clone-per-instance discipline) --------
  private assignments: AssignmentItem[];
  private executors: ExecutorItem[];
  /** Harness dictionary (wave 3C): live playground state seeded from the
   * fixture corpus; the nomination gates read THIS, like the server. */
  private harnesses: HarnessItem[];
  private executionSettings: ExecutionSettings;
  /** Per-project defaults (board_meta `default_executor:project:<slug>`
   * mirror) — modelled through PUT /settings/execution with a project scope. */
  private executionProjectDefaults: Record<string, string> = {};
  private schedules: ScheduleRule[];
  private hooks: HookRule[];
  private launches: LaunchRow[];
  /** UI-21 settings hub: the live kill-switch/cap pair (store.py defaults). */
  private automationSettings: {
    enabled: boolean;
    cap_global_per_day: number;
  };
  /** AGW-5 phase 2: enrollment tokens minted at RUNTIME (playground starts
   * clean — the fixtures carry none, minting is an owner action). */
  private enrollments: EnrollmentItem[];
  private nextEnrollmentNo = 1;
  private nextAssignmentNo = 1;
  private nextRuleNo = 1;
  private nextLaunchNo = 1;

  constructor(options: MockAdapterOptions = {}) {
    this.latency = options.latency ?? { minMs: 80, maxMs: 200 };
    // Fixed seed → identical latency sequences across runs.
    this.rand = mulberry32(20260916);
    this.now = options.now ?? (() => Date.now());
    this.tagCorpus = options.tagCorpus;
    this.tagStoreErrors = options.tagStoreErrors ?? [];
    this.tasks = MOCK_TASKS.map((task) => ({ ...task }));
    this.archivedTasks = [{ ...MOCK_ARCHIVED_TASK }];
    this.inboxItems = MOCK_INBOX.items.map((item) => ({ ...item }));
    this.assignments = MOCK_ASSIGNMENTS.map((assignment) => ({ ...assignment }));
    this.executors = MOCK_EXECUTORS.map((executor) => ({ ...executor }));
    this.harnesses = MOCK_HARNESSES.map((harness) => ({ ...harness }));
    this.executionSettings = { ...MOCK_EXECUTION_SETTINGS };
    this.schedules = MOCK_SCHEDULES.map((rule) => ({ ...rule }));
    this.hooks = MOCK_HOOKS.map((rule) => ({ ...rule }));
    this.launches = MOCK_LAUNCHES.map((row) => ({ ...row }));
    this.automationSettings = {
      enabled: MOCK_AUTOMATION_SETTINGS.enabled,
      cap_global_per_day: MOCK_AUTOMATION_SETTINGS.cap_global_per_day,
    };
    this.enrollments = [];
    // Fresh ids never collide with the corpus rows.
    this.nextAssignmentNo =
      Math.max(0, ...MOCK_ASSIGNMENTS.map((assignment) => assignment.id)) + 1;
    this.nextRuleNo =
      Math.max(0, ...MOCK_SCHEDULES.map((r) => r.id), ...MOCK_HOOKS.map((r) => r.id)) +
      1;
    this.nextLaunchNo = Math.max(0, ...MOCK_LAUNCHES.map((r) => r.id)) + 1;
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
    // `tags` is a comma-separated native listing filter (UI-17 §5.6) — the
    // mock intersects every requested tag, mirroring the wire semantics.
    const wantedTags = (params.tags ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    const filtered = MOCK_MEMORIES.filter(
      (memory) =>
        (params.status === undefined || memory.status === params.status) &&
        (params.project === undefined || memory.project === params.project) &&
        wantedTags.every((tag) => (memory.tags ?? []).includes(tag)),
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
    const memory =
      (id === MOCK_INBOX_MEMORY.id ? MOCK_INBOX_MEMORY : undefined) ??
      MOCK_MEMORIES.find((candidate) => candidate.id === id);
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
    return this.listTagsInner();
  }

  /** Sort rule shared by every tag listing (count DESC, name ASC — deterministic). */
  private static sortTags(tags: readonly TagSummary[]): TagSummary[] {
    return [...tags].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  private listTagsInner(): TagSummary[] {
    if (this.tagCorpus) {
      return MockAdapter.sortTags(this.tagCorpus);
    }
    const counts = new Map<string, number>();
    for (const memory of MOCK_MEMORIES) {
      for (const tag of memory.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return MockAdapter.sortTags(
      [...counts.entries()].map(([tag, count]) => ({ tag, count })),
    );
  }

  /**
   * Raw aggregated tag view (UI-17 spec §6): corpus + per-store honesty.
   * Serves `servers_scanned` as `1 + errors` (one answering mock store) and
   * passes the injected store failures through verbatim — the tags cloud
   * renders its ◐ partial marker from exactly this shape.
   */
  async mergedTags(signal?: AbortSignal): Promise<MergedTags> {
    await this.delay(signal);
    const tags = await this.listTagsInner();
    return {
      tags: tags.map((tag) => ({ name: tag.tag, count: tag.count })),
      servers_scanned: this.tagStoreErrors.length + 1,
      errors: this.tagStoreErrors.map((error) => ({ ...error })),
    };
  }

  /**
   * Tag drill over the mock corpus (UI-17 §5): board tasks matching via
   * mnemos_tags/specialists/agents (the server rule), memories via the
   * fixture tags — recency order, `limit`-sliced like the wire.
   */
  async drillTag(
    tag: string,
    params: TagDrillParams = {},
    signal?: AbortSignal,
  ): Promise<TagDrill> {
    await this.delay(signal);
    const limit = params.limit ?? 12;
    const tasks: TagDrillTask[] = this.tasks
      .filter(
        (task) =>
          (task.mnemos_tags ?? []).includes(tag) ||
          (task.specialists ?? []).includes(tag) ||
          (task.agents ?? []).includes(tag),
      )
      // Wire fidelity: the server limits only memories (app.py drill),
      // tasks come back whole.
      .map((task) => ({
        id: task.id,
        title: task.title,
        col: task.col,
        agents: [...(task.agents ?? [])],
        env: task.env,
      }));
    const memories: TagDrillMemory[] = MOCK_MEMORIES.filter((memory) =>
      (memory.tags ?? []).includes(tag),
    )
      .sort(byCreatedDesc)
      .slice(0, limit)
      .map((memory) => ({
        id: memory.id ?? "",
        title: memory.title ?? "",
        tags: [...(memory.tags ?? [])],
        server: "mock-store",
        created_at: memory.created_at ?? null,
        status: memory.status ?? null,
        excerpt: memory.content.slice(0, 180),
      }));
    return { ok: true, tag, tasks, memories, errors: [] };
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
      // The mock gateway serves no live server: honest absence — the Sidebar
      // version label hides when the field is absent.
      app_version: null,
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
        // Server-contract mirror: ≤400-char fragment (plain corpus prose or
        // a documented mock override — see MOCK_PULSE_CONTENT_OVERRIDES).
        content:
          memory.id !== undefined && memory.id in MOCK_PULSE_CONTENT_OVERRIDES
            ? MOCK_PULSE_CONTENT_OVERRIDES[memory.id]
            : pulseContentFragment(memory.content),
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

  /**
   * UI-25 pre-adoption edit. The mock mirrors the wire semantics: the patch
   * merges into the row's `edits` overlay and the row fields shown here ARE
   * the effective projection (the playground keeps a single flat copy — the
   * server keeps base + overlay separately; documented divergence).
   */
  async patchInboxItem(
    memoryId: string,
    patch: InboxEditInput,
    signal?: AbortSignal,
  ): Promise<TaskInboxEntry> {
    await this.delay(signal);
    const index = this.inboxItems.findIndex((row) => row.memory_id === memoryId);
    if (index === -1) {
      throw new ApiError(404, `inbox row '${memoryId}' not found`, {
        url: `mock:/api/tasks/inbox/${memoryId}`,
      });
    }
    const item = this.inboxItems[index];
    if (item.adopted) {
      throw new ApiError(409, "inbox record already adopted", {
        url: `mock:/api/tasks/inbox/${memoryId}`,
      });
    }
    if (patch.title != null && patch.title.trim().length === 0) {
      // Wire parity: TaskInboxEditSpec.title is min_length=1 server-side.
      throw new ApiError(422, "title must be 1..200 characters", {
        url: `mock:/api/tasks/inbox/${memoryId}`,
      });
    }
    const overlay: Record<string, string> = { ...(item.edits ?? {}) };
    const next = { ...item };
    if (patch.title != null && patch.title !== "") {
      overlay.title = patch.title;
      next.title = patch.title;
    }
    if (patch.summary != null) {
      overlay.summary = patch.summary;
      next.excerpt = patch.summary;
    }
    if (patch.priority != null) {
      overlay.priority = patch.priority;
      next.priority = patch.priority;
    }
    if (patch.project != null) {
      overlay.project = patch.project;
      next.project = patch.project;
    }
    const updated: TaskInboxEntry = { ...next, edits: overlay };
    this.inboxItems[index] = updated;
    return { ...updated };
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

  // --- AGW-1 agents domain (wire mirrors of the board routes; no auth wall) ----
  // The mock is the dev playground, so the ui-token gate is absent — but the
  // CREATE/CANCEL gates answer honestly (404/422/409) so the Ф3 UI error
  // branches are exercisable. Presence stays a static corpus snapshot: the
  // mock never recomputes it (the real server computes per GET).

  /**
   * Assignment queue. Wire parity: state/task_id filter server-side,
   * executor_id does NOT filter (presence piggyback only) — executor
   * filtering is the client's job over the full projection.
   */
  async listAssignments(
    params: AssignmentListParams = {},
    signal?: AbortSignal,
  ): Promise<AssignmentsPage> {
    await this.delay(signal);
    const items = this.assignments
      .filter((row) => !params.state || row.state === params.state)
      .filter((row) => !params.task_id || row.task_id === params.task_id)
      .map((row) => ({ ...row }));
    return { ok: true, count: items.length, items };
  }

  async createAssignment(
    payload: AssignmentCreateInput,
    signal?: AbortSignal,
  ): Promise<AssignmentCreatedResult> {
    await this.delay(signal);
    // Server mirror (assignment create gate, wave 3C): an unknown harness
    // can never launch — refuse early against the live dictionary.
    if (!this.harnessNames().includes(payload.harness)) {
      throw new ApiError(
        422,
        `unknown harness: ${payload.harness}; known: ${this.harnessNames().join(", ")}`,
        { url: "mock:/api/assignments" },
      );
    }
    const assignment = this.createAssignmentRow(
      payload.task_id,
      payload.specialist,
      payload.harness,
      payload.executor_id ?? "",
      "owner",
    );
    return { ok: true, assignment: { ...assignment } };
  }

  async cancelAssignment(
    assignmentId: number,
    reason = "",
    signal?: AbortSignal,
  ): Promise<AssignmentCancelledResult> {
    await this.delay(signal);
    const index = this.assignments.findIndex((row) => row.id === assignmentId);
    if (index < 0) {
      throw new ApiError(404, `assignment ${assignmentId} not found`, {
        url: `mock:/api/assignments/${assignmentId}/cancel`,
      });
    }
    const current = this.assignments[index];
    if (!ACTIVE_ASSIGNMENT_STATES.includes(current.state)) {
      throw new ApiError(
        409,
        `assignment ${assignmentId} is ${current.state} — only queued/claimed/running can be cancelled`,
        { url: `mock:/api/assignments/${assignmentId}/cancel` },
      );
    }
    const cancelled: AssignmentItem = {
      ...current,
      state: "cancelled",
      claimed_by: "owner",
      note: reason,
      finished_at: this.stamp(),
    };
    this.assignments[index] = cancelled;
    // The task column returns to open when the attempt had moved it
    // (mirrors finish_assignment's in-progress → open return).
    const task = this.tasks.find((row) => row.id === cancelled.task_id);
    let moved: string[] = [];
    if (task && task.col === "in-progress") {
      moved = ["in-progress", "open"];
      const restored: BoardTask = {
        ...task,
        col: "open",
        status: "open",
        updated_at: this.stamp(),
      };
      replaceInPlace(this.tasks, restored);
      return {
        ok: true,
        assignment: { ...cancelled },
        task: { ...restored },
        moved,
        report: null,
      };
    }
    return {
      ok: true,
      assignment: { ...cancelled },
      task: task ? { ...task } : null,
      moved,
      report: null,
    };
  }

  /** Registry projection with the server-owned presence TTL meta. */
  async listExecutors(signal?: AbortSignal): Promise<ExecutorsPage> {
    await this.delay(signal);
    return {
      ok: true,
      count: this.executors.length,
      items: this.executors.map((executor) => ({ ...executor })),
      meta: MOCK_EXECUTORS_META,
    };
  }

  // --- harness dictionary (wave 3C, design 2026-09-22 §C) ---------------------
  // Server mirrors: name rule and dictionary ceiling (store.py HARNESS_*),
  // in-use delete gates (executor / non-terminal assignment / schedule /
  // hook condition). The playground dictionary state is what its OWN
  // nomination gates read — same as the server.

  /** Live dictionary snapshot — the mock's nomination gates use it. */
  private harnessNames(): string[] {
    return this.harnesses.map((harness) => harness.name);
  }

  async listHarnesses(signal?: AbortSignal): Promise<HarnessesPage> {
    await this.delay(signal);
    return {
      ok: true,
      count: this.harnesses.length,
      items: [...this.harnesses].sort((a, b) => a.name.localeCompare(b.name)),
      meta: { seed_min_count: 10 },
    };
  }

  async createHarness(
    payload: HarnessCreateInput,
    signal?: AbortSignal,
  ): Promise<HarnessStateResult> {
    await this.delay(signal);
    const name = payload.name.trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,59}$/.test(name)) {
      throw new ApiError(
        422,
        `invalid harness name: '${name}' (lowercase latin/digits first, then [a-z0-9._-], max 60 chars)`,
        { url: "mock:/api/harnesses" },
      );
    }
    if (this.harnesses.length >= 64) {
      throw new ApiError(
        422,
        "the harness dictionary is capped at 64 — remove unused entries before adding more",
        { url: "mock:/api/harnesses" },
      );
    }
    if (this.harnessNames().includes(name)) {
      throw new ApiError(409, `harness '${name}' is already registered`, {
        url: "mock:/api/harnesses",
      });
    }
    const row: HarnessItem = {
      name,
      added_at: new Date(this.now()).toISOString(),
      added_via: "owner",
      note: (payload.note ?? "").trim().slice(0, 200),
    };
    this.harnesses.push(row);
    return { ok: true, harness: { ...row } };
  }

  async deleteHarness(name: string, signal?: AbortSignal): Promise<void> {
    await this.delay(signal);
    const index = this.harnesses.findIndex((harness) => harness.name === name);
    if (index === -1) {
      throw new ApiError(404, `harness '${name}' is not registered`, {
        url: "mock:/api/harnesses",
      });
    }
    if (this.executors.some((executor) => executor.harness === name)) {
      throw new ApiError(
        409,
        `harness '${name}' is used by a registered executor — delete that executor first (revoked executors keep blocking — server parity)`,
        { url: "mock:/api/harnesses" },
      );
    }
    if (
      this.assignments.some(
        (assignment) =>
          assignment.harness === name &&
          ACTIVE_ASSIGNMENT_STATES.includes(assignment.state),
      )
    ) {
      throw new ApiError(
        409,
        `harness '${name}' has active assignments — cancel or finish them first`,
        { url: "mock:/api/harnesses" },
      );
    }
    // Only ENABLED rules block: rules are soft-deleted (the row survives
    // retention), a disabled rule cannot fire — counting it would make a
    // harness undeletable forever (server parity, wave 3C review fix).
    if (this.schedules.some((rule) => rule.harness === name && rule.enabled)) {
      throw new ApiError(
        409,
        `harness '${name}' is referenced by an automation schedule — delete the schedule first`,
        { url: "mock:/api/harnesses" },
      );
    }
    for (const hook of this.hooks) {
      if (!hook.enabled) continue;
      // HookRule.condition arrives PARSED (ConditionItem[]) — no JSON decode.
      const hit = hook.condition.some(
        (clause) => clause.field === "harness" && String(clause.value) === name,
      );
      if (hit) {
        throw new ApiError(
          409,
          `harness '${name}' is referenced by automation hook '${hook.name}' — delete the hook first`,
          { url: "mock:/api/harnesses" },
        );
      }
    }
    this.harnesses.splice(index, 1);
  }

  async getExecutionSettings(signal?: AbortSignal): Promise<ExecutionSettings> {
    await this.delay(signal);
    return { ...this.executionSettings };
  }

  /**
   * Amd 2 §5 gates, mock-honest subset: a default must be a KNOWN,
   * approved, enabled executor. The live-heartbeat (online) and
   * local-poll gates are relaxed — mock presence is a static corpus
   * snapshot, so requiring "online now" would freeze the playground.
   * Scope mirror (server `_execution_settings_keys`): '' is the global
   * pair; 'project:<slug>' writes ONLY the project default (fallback is
   * global-scope — 422 when combined), and the project default joins the
   * routing chain one tier above the global one.
   */
  async putExecutionSettings(
    payload: ExecutionSettingsInput,
    signal?: AbortSignal,
  ): Promise<ExecutionSettings> {
    await this.delay(signal);
    const scope = (payload.scope ?? "").trim();
    if (payload.fallback_executor && scope) {
      throw new ApiError(422, "fallback executor is global-scope only", {
        url: "mock:/api/settings/execution",
      });
    }
    for (const executorId of [payload.default_executor, payload.fallback_executor]) {
      if (!executorId) continue; // '' clears the slot
      const row = this.executors.find((executor) => executor.id === executorId);
      if (!row) {
        throw new ApiError(422, `unknown executor: ${executorId}`, {
          url: "mock:/api/settings/execution",
        });
      }
      if (row.state !== "approved" || !row.enabled) {
        throw new ApiError(
          422,
          `executor ${executorId} is ${row.state}${row.enabled ? "" : ", disabled"} — a default must be approved and enabled`,
          { url: "mock:/api/settings/execution" },
        );
      }
    }
    if (scope) {
      // Project scope: the default slot only — the global pair is untouched.
      if (payload.default_executor) {
        this.executionProjectDefaults[scope] = payload.default_executor;
      } else {
        delete this.executionProjectDefaults[scope];
      }
    } else {
      this.executionSettings = {
        ok: true,
        default_executor: payload.default_executor,
        fallback_executor: payload.fallback_executor,
        scope,
      };
    }
    return {
      ok: true,
      default_executor: payload.default_executor,
      fallback_executor: payload.fallback_executor,
      scope,
    };
  }

  /**
   * Server-state-machine mirror (AGW-4; store.update_executor): pending is
   * NOT a patchable target, revoked is TERMINAL but a revoked→revoked PATCH
   * is an idempotent no-op 200 (AGW-5 P3 — store.py:2600), unknown id →
   * 404, a rename onto an existing name → 409 duplicate. Presence
   * recomputes from last_seen against the meta TTLs so a freshly approved
   * row does not keep a stale verdict. Idempotent no-ops echo the row
   * unchanged.
   */
  async patchExecutor(
    executorId: string,
    patch: ExecutorPatchInput,
    signal?: AbortSignal,
  ): Promise<ExecutorStateChangeResult> {
    await this.delay(signal);
    const index = this.executors.findIndex((executor) => executor.id === executorId);
    if (index === -1) {
      throw new ApiError(404, `executor ${executorId} not found`, {
        url: "mock:/api/executors",
      });
    }
    const row = this.executors[index];
    if (patch.state !== undefined) {
      // Runtime mirror of the wire narrowing (the TYPE already forbids
      // pending — a JS caller gets the same 422 the server would answer).
      if ((patch.state as ExecutorRegistryState) === "pending") {
        throw new ApiError(
          422,
          "invalid executor state target: pending (patchable targets: approved, revoked)",
          { url: "mock:/api/executors" },
        );
      }
      // Leaving revoked is the forbidden transition; revoked→revoked is the
      // idempotent no-op the server answers 200 (no SSE, no changes).
      if (row.state === "revoked" && patch.state !== "revoked") {
        throw new ApiError(
          409,
          "executor is revoked — terminal state; re-register a new executor instead",
          { url: "mock:/api/executors" },
        );
      }
    }
    // Rename guard (AGW-4 P3): pydantic bounds (1..120) + the duplicate
    // check of update_executor. Computed UP FRONT — a local `name` would
    // silently collide with the DOM `window.name` global in the spread.
    const nextName = patch.name !== undefined ? patch.name.trim() : undefined;
    if (nextName !== undefined && (nextName.length === 0 || nextName.length > 120)) {
      throw new ApiError(422, "invalid executor name", {
        url: "mock:/api/executors",
      });
    }
    if (
      nextName !== undefined &&
      this.executors.some((other) => other.id !== executorId && other.name === nextName)
    ) {
      throw new ApiError(409, `duplicate executor name: ${nextName}`, {
        url: "mock:/api/executors",
      });
    }
    // ExecutorItem fields are readonly — the patch REPLACES the row (the
    // UI never holds registry identity objects it could alias).
    const merged = {
      ...row,
      ...(nextName !== undefined ? { name: nextName } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.capabilities !== undefined
        ? { capabilities: [...patch.capabilities] }
        : {}),
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      updated_at: new Date().toISOString(),
    };
    const updated: ExecutorItem = { ...merged, presence: mockPresenceOf(merged) };
    this.executors[index] = updated;
    return { ok: true, executor: { ...updated } };
  }

  /** Hard delete (store.delete_executor): the token dies with the row. */
  async deleteExecutor(executorId: string, signal?: AbortSignal): Promise<void> {
    await this.delay(signal);
    const index = this.executors.findIndex((executor) => executor.id === executorId);
    if (index === -1) {
      throw new ApiError(404, `executor ${executorId} not found`, {
        url: "mock:/api/executors",
      });
    }
    this.executors.splice(index, 1);
  }

  // --- executor enrollment (AGW-5 phase 2; Amd 2 §4 supplement) ---------------

  /**
   * Mint a one-time mne_ token (store.create_enrollment mirror): 422
   * unknown harness_hint (the hint gate reads the live dictionary state,
   * wave 3C), 409 at ENROLLMENT_MAX_LIVE = 3 live tokens with NO auto-revoke
   * (device-quota principle — the owner revokes by hand). TTL 15 min,
   * server constant. The plaintext token exists ONLY in this answer.
   */
  async createEnrollment(
    payload: EnrollmentCreateInput,
    signal?: AbortSignal,
  ): Promise<EnrollmentCreatedResult> {
    await this.delay(signal);
    if (
      payload.harness_hint !== undefined &&
      payload.harness_hint !== "" &&
      !this.harnessNames().includes(payload.harness_hint)
    ) {
      throw new ApiError(
        422,
        `unknown harness_hint: ${payload.harness_hint}; known: ${this.harnessNames().join(", ")}`,
        { url: "mock:/api/executors/enrollment" },
      );
    }
    const live = this.enrollments.filter((row) => row.state === "created");
    if (live.length >= 3) {
      throw new ApiError(
        409,
        "enrollment quota exceeded: at most 3 live tokens (revoke one to mint a new)",
        { url: "mock:/api/executors/enrollment" },
      );
    }
    const nowMs = this.now();
    const row: EnrollmentItem = {
      enrollment_id: `enr-mock-${String(this.nextEnrollmentNo).padStart(4, "0")}`,
      label: payload.label ?? "",
      harness_hint: payload.harness_hint ?? "",
      name_hint: payload.name_hint ?? "",
      state: "created",
      created_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + ENROLLMENT_TTL_MS).toISOString(),
      used_at: "",
      used_ip: "",
      executor_id: "",
    };
    this.nextEnrollmentNo += 1;
    this.enrollments.push(row);
    // token_urlsafe(24) shape mirror: `mne_` + 32 urlsafe chars.
    const token = `mne_${mockTokenMaterial()}`;
    return { ok: true, enrollment: { ...row }, token };
  }

  /** Live tokens plus terminal history, no hash/token material. */
  async listEnrollments(signal?: AbortSignal): Promise<EnrollmentsPage> {
    await this.delay(signal);
    return {
      ok: true,
      count: this.enrollments.length,
      items: this.enrollments.map((row) => ({ ...row })),
    };
  }

  /**
   * Revoke a LIVE token (store.revoke_enrollment mirror): created →
   * revoked; already revoked → 200 idempotent; used → 409 (the executor
   * exists — kill it via the registry); expired → 409; unknown → 404.
   */
  async revokeEnrollment(
    enrollmentId: string,
    signal?: AbortSignal,
  ): Promise<EnrollmentRevokeResult> {
    await this.delay(signal);
    const index = this.enrollments.findIndex(
      (row) => row.enrollment_id === enrollmentId,
    );
    if (index === -1) {
      throw new ApiError(404, `enrollment ${enrollmentId} not found`, {
        url: "mock:/api/executors/enrollment",
      });
    }
    const row = this.enrollments[index];
    if (row.state === "revoked") {
      return { ok: true, enrollment: { ...row } };
    }
    if (row.state !== "created") {
      throw new ApiError(
        409,
        `enrollment is ${row.state} — terminal; only a live (created) token can be revoked`,
        { url: "mock:/api/executors/enrollment" },
      );
    }
    const updated: EnrollmentItem = { ...row, state: "revoked" };
    this.enrollments[index] = updated;
    return { ok: true, enrollment: { ...updated } };
  }

  // --- SCHED-1 automation (ADR 0013 S1: CRUD + journal + manual run-now) -------

  async automationStatus(signal?: AbortSignal): Promise<AutomationStatus> {
    await this.delay(signal);
    // Derived from live rule state like the server; engine stays the honest
    // S1 constant (no loop exists to report live). The harness values_hint
    // joins through the LIVE dictionary state (wave 3C — server parity),
    // never a static fixture list; the kill-switch/cap pair projects from
    // the SAME live settings the settings form reads/writes (UI-21 —
    // server parity: app.py automation_status reads
    // store.automation_settings).
    const schedulesEnabled = this.schedules.filter((rule) => rule.enabled).length;
    const hooksEnabled = this.hooks.filter((rule) => rule.enabled).length;
    return {
      ...MOCK_AUTOMATION_STATUS,
      condition_meta: {
        ...MOCK_AUTOMATION_STATUS.condition_meta,
        values_hint: {
          // The generated schema types values_hint as `unknown` (anonymous
          // dict on the wire); the mock owns the fixture shape.
          ...(MOCK_AUTOMATION_STATUS.condition_meta.values_hint as Record<
            string,
            unknown
          >),
          harness: this.harnessNames(),
        },
      },
      global_kill_switch: this.automationSettings.enabled,
      daily_cap: this.automationSettings.cap_global_per_day,
      rules: {
        schedules: { total: this.schedules.length, enabled: schedulesEnabled },
        hooks: { total: this.hooks.length, enabled: hooksEnabled },
      },
    };
  }

  /** Kill-switch + daily cap (`GET /api/automation/settings` mirror). */
  async getAutomationSettings(signal?: AbortSignal): Promise<AutomationSettings> {
    await this.delay(signal);
    return { ok: true, ...this.automationSettings };
  }

  /**
   * Set the kill-switch / daily cap (`PUT /api/automation/settings`
   * mirror): `None` fields are ignored, an out-of-range cap answers the
   * SAME 422 text as `store.AutomationValidationError`, effective changes
   * land in the live pair (the audit log itself is server-side only).
   */
  async putAutomationSettings(
    payload: AutomationSettingsInput,
    signal?: AbortSignal,
  ): Promise<AutomationSettings> {
    await this.delay(signal);
    if (
      payload.cap_global_per_day !== null &&
      payload.cap_global_per_day !== undefined &&
      (!Number.isInteger(payload.cap_global_per_day) ||
        payload.cap_global_per_day < 1 ||
        payload.cap_global_per_day > 1000)
    ) {
      throw new ApiError(422, "cap_global_per_day must be an int in 1..1000", {
        url: "mock:/api/automation/settings",
      });
    }
    if (payload.enabled !== null && payload.enabled !== undefined) {
      this.automationSettings.enabled = payload.enabled;
    }
    if (
      payload.cap_global_per_day !== null &&
      payload.cap_global_per_day !== undefined
    ) {
      this.automationSettings.cap_global_per_day = payload.cap_global_per_day;
    }
    return { ok: true, ...this.automationSettings };
  }

  async listSchedules(signal?: AbortSignal): Promise<SchedulesPage> {
    await this.delay(signal);
    return {
      ok: true,
      count: this.schedules.length,
      items: this.schedules.map((rule) => ({ ...rule })),
    };
  }

  async createSchedule(
    payload: ScheduleCreateInput,
    signal?: AbortSignal,
  ): Promise<ScheduleRule> {
    await this.delay(signal);
    // Server mirror (store.py SCHEDULE_TRIGGER_KINDS validation): unknown
    // trigger kinds are a 422 with the allowed list — the mock must not
    // hide wire drift (review SCHED-1-UI P1).
    if (!SCHEDULE_TRIGGER_KINDS.includes(payload.trigger_kind)) {
      throw new ApiError(
        422,
        `unknown trigger_kind: '${payload.trigger_kind}'; allowed: ${SCHEDULE_TRIGGER_KINDS.slice().sort()}`,
        { url: "mock:/api/automation/schedules" },
      );
    }
    assertUniqueRuleName(
      payload.name,
      this.schedules,
      this.hooks,
      "mock:/api/automation/schedules",
    );
    const rule: ScheduleRule = {
      ...payload,
      id: this.nextRuleNo++,
      // Creation is DISABLED — enablement is a separate audited PATCH.
      enabled: false,
      window_from: payload.window_from ?? null,
      window_to: payload.window_to ?? null,
      next_run_at: this.stamp(), // computed server-side from now
      last_run_at: null,
      created_by: "owner",
      created_at: this.stamp(),
      updated_at: this.stamp(),
    };
    this.schedules.push(rule);
    return { ...rule };
  }

  async patchSchedule(
    ruleId: number,
    patch: SchedulePatchInput,
    signal?: AbortSignal,
  ): Promise<ScheduleRule> {
    await this.delay(signal);
    const index = this.schedules.findIndex((rule) => rule.id === ruleId);
    if (index < 0) {
      throw notFoundRule(ruleId, "schedule", "mock:/api/automation/schedules");
    }
    const current = this.schedules[index];
    const next: ScheduleRule = {
      ...current,
      ...(patch.name != null ? { name: patch.name } : {}),
      ...(patch.target_kind != null ? { target_kind: patch.target_kind } : {}),
      ...(patch.task_id != null ? { task_id: patch.task_id } : {}),
      ...(patch.specialist != null ? { specialist: patch.specialist } : {}),
      ...(patch.harness != null ? { harness: patch.harness } : {}),
      ...(patch.executor_id != null ? { executor_id: patch.executor_id } : {}),
      ...(patch.trigger_kind != null ? { trigger_kind: patch.trigger_kind } : {}),
      ...(patch.trigger_value != null ? { trigger_value: patch.trigger_value } : {}),
      ...(patch.window_from !== undefined
        ? { window_from: patch.window_from ?? null }
        : {}),
      ...(patch.window_to !== undefined ? { window_to: patch.window_to ?? null } : {}),
      ...(patch.max_runs_per_day != null
        ? { max_runs_per_day: patch.max_runs_per_day }
        : {}),
      ...(patch.cooldown_s != null ? { cooldown_s: patch.cooldown_s } : {}),
      ...(patch.enabled != null ? { enabled: patch.enabled } : {}),
      // Every effective patch recomputes the schedule clock from now.
      next_run_at: patch.enabled === true ? this.stamp() : current.next_run_at,
      updated_at: this.stamp(),
    };
    this.schedules[index] = next;
    return { ...next };
  }

  async deleteSchedule(ruleId: number, signal?: AbortSignal): Promise<RuleDeletedAck> {
    await this.delay(signal);
    const index = this.schedules.findIndex((rule) => rule.id === ruleId);
    if (index < 0) {
      throw notFoundRule(ruleId, "schedule", "mock:/api/automation/schedules");
    }
    // Soft-disable retention (ADR 0013 §2): the row stays, the name holds.
    this.schedules[index] = {
      ...this.schedules[index],
      enabled: false,
      next_run_at: null,
      updated_at: this.stamp(),
    };
    return { ok: true, note: "soft-disabled and retained (retention)" };
  }

  async runScheduleNow(
    ruleId: number,
    signal?: AbortSignal,
  ): Promise<ScheduleRunResult> {
    await this.delay(signal);
    const rule = this.schedules.find((row) => row.id === ruleId);
    if (!rule) {
      throw notFoundRule(
        ruleId,
        "schedule",
        `mock:/api/automation/schedules/${ruleId}/run`,
      );
    }
    const runAt = this.stamp();
    try {
      // Manual run-now goes through the same create path as POST
      // /api/assignments with created_by='owner' (ADR 0013 §2).
      const assignment = this.createAssignmentRow(
        rule.task_id,
        rule.specialist,
        rule.harness,
        rule.executor_id,
        "owner",
      );
      const launchId = this.appendLaunch(rule, runAt, "launched", "", assignment.id);
      this.schedules = this.schedules.map((row) =>
        row.id === rule.id
          ? { ...row, last_run_at: runAt, updated_at: this.stamp() }
          : row,
      );
      return {
        ok: true,
        decision: "launched",
        reason: "",
        assignment_id: assignment.id,
        launch_id: launchId,
        run_at: runAt,
      };
    } catch (error) {
      // Refused attempts still journal a skipped row (gate honesty).
      if (error instanceof ApiError) {
        this.appendLaunch(
          rule,
          runAt,
          "skipped",
          `${error.status}: ${error.message}`,
          null,
        );
      }
      throw error;
    }
  }

  async listHooks(signal?: AbortSignal): Promise<HooksPage> {
    await this.delay(signal);
    return {
      ok: true,
      count: this.hooks.length,
      items: this.hooks.map((rule) => ({ ...rule })),
    };
  }

  async createHook(payload: HookCreateInput, signal?: AbortSignal): Promise<HookRule> {
    await this.delay(signal);
    assertUniqueRuleName(
      payload.name,
      this.schedules,
      this.hooks,
      "mock:/api/automation/hooks",
    );
    const rule: HookRule = {
      ...payload,
      id: this.nextRuleNo++,
      enabled: false, // creation is disabled; enablement is a PATCH
      condition: [...(payload.condition ?? [])],
      source_allowlist: [...(payload.source_allowlist ?? [])],
      action_payload: { ...(payload.action_payload ?? {}) },
      created_by: "owner",
      created_at: this.stamp(),
      updated_at: this.stamp(),
    };
    this.hooks.push(rule);
    return { ...rule };
  }

  async patchHook(
    ruleId: number,
    patch: HookPatchInput,
    signal?: AbortSignal,
  ): Promise<HookRule> {
    await this.delay(signal);
    const index = this.hooks.findIndex((rule) => rule.id === ruleId);
    if (index < 0) {
      throw notFoundRule(ruleId, "hook", "mock:/api/automation/hooks");
    }
    const current = this.hooks[index];
    const next: HookRule = {
      ...current,
      ...(patch.name != null ? { name: patch.name } : {}),
      ...(patch.on != null ? { on: patch.on } : {}),
      ...(patch.condition != null ? { condition: [...patch.condition] } : {}),
      ...(patch.source_allowlist != null
        ? { source_allowlist: [...patch.source_allowlist] }
        : {}),
      ...(patch.action != null ? { action: patch.action } : {}),
      ...(patch.action_payload != null
        ? { action_payload: { ...patch.action_payload } }
        : {}),
      ...(patch.cooldown_s != null ? { cooldown_s: patch.cooldown_s } : {}),
      ...(patch.budget != null ? { budget: patch.budget } : {}),
      ...(patch.enabled != null ? { enabled: patch.enabled } : {}),
      updated_at: this.stamp(),
    };
    this.hooks[index] = next;
    return { ...next };
  }

  async deleteHook(ruleId: number, signal?: AbortSignal): Promise<RuleDeletedAck> {
    await this.delay(signal);
    const index = this.hooks.findIndex((rule) => rule.id === ruleId);
    if (index < 0) {
      throw notFoundRule(ruleId, "hook", "mock:/api/automation/hooks");
    }
    this.hooks[index] = {
      ...this.hooks[index],
      enabled: false,
      updated_at: this.stamp(),
    };
    return { ok: true, note: "soft-disabled and retained (retention)" };
  }

  /** Launch journal page: filters + the uniform cursor contract (ADR 0011 §11). */
  async listLaunches(
    params: LaunchesParams = {},
    signal?: AbortSignal,
  ): Promise<LaunchesPage> {
    await this.delay(signal);
    if (params.kind && params.kind !== "schedule" && params.kind !== "hook") {
      throw new ApiError(422, `invalid kind: ${params.kind}`, {
        url: "mock:/api/automation/launches",
      });
    }
    if (
      params.decision &&
      !["launched", "skipped", "missed"].includes(params.decision)
    ) {
      throw new ApiError(422, `invalid decision: ${params.decision}`, {
        url: "mock:/api/automation/launches",
      });
    }
    const rows = this.launches
      .filter((row) => !params.rule_id || row.rule_id === params.rule_id)
      .filter((row) => !params.kind || row.rule_kind === params.kind)
      .filter((row) => !params.decision || row.decision === params.decision)
      // attempted_at DESC with the unique id tiebreak (wire contract).
      .sort((a, b) => b.attempted_at.localeCompare(a.attempted_at) || b.id - a.id);
    const requested = params.limit ?? DEFAULT_LAUNCH_LIMIT;
    const truncated = requested > LAUNCH_PAGE_CAP;
    const limit = Math.min(requested, LAUNCH_PAGE_CAP);
    const offset = decodeLaunchCursor(params.cursor);
    const page = rows.slice(offset, offset + limit);
    const total = rows.length;
    return {
      ok: true,
      count: page.length,
      total,
      items: page.map((row) => ({ ...row })),
      next_cursor:
        offset + page.length < total ? encodeLaunchCursor(offset + page.length) : null,
      truncated,
    };
  }

  /**
   * Shared creation path (POST /api/assignments + run-now): validates the
   * create gates (404 unknown / 422 archived-terminal / 409 ≤1-active),
   * then queues the row with a freshly computed routing annotation.
   */
  private createAssignmentRow(
    taskId: string,
    specialist: string,
    harness: string,
    executorId: string,
    createdBy: string,
  ): AssignmentItem {
    const task =
      this.tasks.find((row) => row.id === taskId) ??
      this.archivedTasks.find((row) => row.id === taskId);
    if (!task) {
      throw new ApiError(404, `task '${taskId}' not found`, {
        url: "mock:/api/assignments",
      });
    }
    if (task.archived === 1 || task.col === "done" || task.col === "resolved") {
      throw new ApiError(
        422,
        `task '${taskId}' is ${task.archived === 1 ? "archived" : "terminal"} — assignments need an active task`,
        { url: "mock:/api/assignments" },
      );
    }
    const activeHolds = this.assignments.some(
      (row) => row.task_id === taskId && ACTIVE_ASSIGNMENT_STATES.includes(row.state),
    );
    if (activeHolds) {
      throw new ApiError(
        409,
        `task '${taskId}' already holds an active assignment (≤1 invariant)`,
        { url: "mock:/api/assignments" },
      );
    }
    const id = this.nextAssignmentNo++;
    const assignment: AssignmentItem = {
      id,
      task_id: taskId,
      specialist,
      harness,
      state: "queued",
      created_by: createdBy,
      claimed_by: null,
      note: "",
      // Fingerprint only — the spec snapshot itself never leaves the server.
      spec_hash: `m${id.toString(16).padStart(4, "0")}c0rp5`,
      executor_id: executorId,
      claimed_by_executor: "",
      created_at: this.stamp(),
      claimed_at: null,
      started_at: null,
      heartbeat_at: null,
      finished_at: null,
      topics: [...task.mnemos_tags],
      routing: this.resolveRouting(
        executorId,
        specialist,
        task.specialists,
        task.project,
      ),
    };
    this.assignments.push(assignment);
    return { ...assignment };
  }

  /**
   * Routing mirror (Amd 2 §5 tier chain): delegated to the shared pure
   * resolver (gateway/routing.ts) over the mock's live registry + settings —
   * the same implementation the AssignExecutorSheet preview uses, so dev
   * mode and the preview can never drift apart. The project-default tier
   * reads the mock's per-project settings (PUT with a project scope).
   */
  private resolveRouting(
    pin: string,
    specialist: string,
    taskSpecialists: readonly string[],
    project: string,
  ): RoutingAnnotation {
    return resolveRoutingAnnotation({
      pin,
      specialist,
      taskSpecialists,
      executors: this.executors,
      projectDefault: this.executionProjectDefaults[`project:${project}`] ?? "",
      globalDefault: this.executionSettings.default_executor,
    });
  }

  /** Append one journal row for a manual trigger (the only S1 origin). */
  private appendLaunch(
    rule: ScheduleRule,
    runAt: string,
    decision: "launched" | "skipped",
    reason: string,
    assignmentId: number | null,
  ): number {
    const launchId = this.nextLaunchNo++;
    this.launches.push({
      id: launchId,
      rule_id: rule.id,
      rule_kind: "schedule",
      rule_name: rule.name,
      run_at: runAt,
      event_id: null,
      trigger: "manual",
      origin: "ui",
      decision,
      reason,
      assignment_id: assignmentId,
      attempted_at: this.stamp(),
    });
    return launchId;
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

// --- AGW-1 wire mirrors (server constants; the mock never invents them) --------

/** ADR 0009 states that hold the ≤1-active invariant (store mirror). */
const ACTIVE_ASSIGNMENT_STATES: readonly AssignmentLifecycleState[] = [
  "queued",
  "claimed",
  "running",
];

/** SCHED-1 S1 AC: rule names are unique across BOTH rule kinds (422 mirror). */
function assertUniqueRuleName(
  name: string,
  schedules: readonly ScheduleRule[],
  hooks: readonly HookRule[],
  url: string,
): void {
  const taken =
    schedules.some((rule) => rule.name === name) ||
    hooks.some((rule) => rule.name === name);
  if (taken) {
    throw new ApiError(422, `rule name '${name}' is already taken`, { url });
  }
}

/** Server `SCHEDULE_TRIGGER_KINDS` mirror (store.py — {interval, time-of-day}). */
const SCHEDULE_TRIGGER_KINDS: readonly string[] = ["interval", "time-of-day"];

/** Honest 404 for unknown automation rule ids. */
function notFoundRule(ruleId: number, kind: string, url: string): ApiError {
  return new ApiError(404, `${kind} rule ${ruleId} not found`, { url });
}

/** Opaque launch-cursor scheme (server `_encode_launch_cursor` mirror). */
function encodeLaunchCursor(offset: number): string {
  return btoa(JSON.stringify({ v: 1, offset }));
}

/** Decode a cursor this mock issued; anything else is a 422 (wire mirror). */
function decodeLaunchCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const data: unknown = JSON.parse(atob(cursor));
    if (
      typeof data === "object" &&
      data !== null &&
      (data as { v?: unknown }).v === 1 &&
      typeof (data as { offset?: unknown }).offset === "number" &&
      (data as { offset: number }).offset >= 0
    ) {
      return (data as { offset: number }).offset;
    }
  } catch {
    // fall through to the 422 below
  }
  throw new ApiError(422, "invalid cursor", { url: "mock:/api/automation/launches" });
}

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

/** Pulse fragment cap (server `content_fragment` mirror): ≤400 chars. */
const PULSE_FRAGMENT_MAX = 400;

/**
 * Mock mirror of the server's `content_fragment()`: the pulse row preview is
 * a ≤400-char cut at a whitespace boundary (hard cut only when the window
 * holds no whitespace); blank or absent content maps to null — the UI shows
 * honest absence, never an empty shell.
 */
function pulseContentFragment(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= PULSE_FRAGMENT_MAX) return trimmed;
  const window = trimmed.slice(0, PULSE_FRAGMENT_MAX);
  const boundary = window.lastIndexOf(" ");
  return (boundary > 0 ? window.slice(0, boundary) : window).trimEnd();
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

/** Enrollment TTL mirror — the server constant is 15 min (design §Solution). */
const ENROLLMENT_TTL_MS = 15 * 60 * 1000;

/** urlsafe token material stand-in (NOT random-secret grade — a playground). */
function mockTokenMaterial(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < 32; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/**
 * Recompute the presence verdict from last_seen against the SERVER-owned
 * meta TTLs (spec §5.1 — the mock mirrors the server computation instead
 * of leaving a stale fixture verdict behind a mutation).
 */
function mockPresenceOf(executor: ExecutorItem): ExecutorItem["presence"] {
  const at = Date.parse(executor.last_seen);
  if (!Number.isFinite(at)) return "offline";
  const ageS = (Date.now() - at) / 1000;
  const { online_max_age_s: online, stale_max_age_s: stale } =
    MOCK_EXECUTORS_META.presence;
  if (ageS <= online) return "online";
  if (ageS <= stale) return "stale";
  return "offline";
}
