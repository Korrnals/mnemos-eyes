import type {
  ArchiveParams,
  AssignmentListParams,
  PulseParams,
} from "@/gateway/boardTypes";
import type { InboxParams } from "@/gateway/BoardAdapter";
import type { ListMemoriesParams, SearchParams } from "@/gateway/types";

/**
 * Typed TanStack Query key factories (architecture.md §6).
 * Always build keys through these factories — never hand-roll arrays in hooks —
 * so query invalidation stays consistent across the app.
 */
export const keys = {
  memories: {
    all: ["memories"] as const,
    list: (params: ListMemoriesParams = {}) => ["memories", "list", params] as const,
    detail: (id: string, includeRaw = false) =>
      ["memories", "detail", id, { includeRaw }] as const,
  },
  search: {
    results: (params: SearchParams) => ["search", params] as const,
  },
  tags: {
    all: ["tags"] as const,
    list: () => ["tags", "list"] as const,
    // UI-17 tags cloud: raw merged view (+errors/servers) and the per-tag
    // server drill — separate keys, both under the tags namespace.
    merged: () => ["tags", "merged"] as const,
    drill: (tag: string) => ["tags", "drill", tag] as const,
  },
  status: {
    health: () => ["status", "health"] as const,
    metrics: () => ["status", "metrics"] as const,
    // Ф1 Overview: per-store health detail (board-native).
    boardHealth: () => ["status", "board-health"] as const,
  },
  // Ф1 Pulse page: merged recency feed.
  pulse: {
    feed: (params: PulseParams = {}) => ["pulse", "feed", params] as const,
  },
  // Ф2 task domain. There is NO per-task detail key: the board API has no
  // single-task GET, so the detail page READS the shared board projection
  // through a `select` on the same `tasks.board` key — one wire call feeds
  // the list, the mini-stats and every open detail page, and SSE patches to
  // `tasks.board` reach both surfaces at once.
  tasks: {
    all: ["tasks"] as const,
    board: () => ["tasks", "board"] as const,
    reports: {
      all: ["tasks", "reports"] as const,
      detail: (taskId: string) => ["tasks", "reports", "detail", taskId] as const,
      /** Client-side per-task report count (SSE-fed; the board row has none). */
      count: (taskId: string) => ["tasks", "reports", "count", taskId] as const,
    },
    history: (taskId: string) => ["tasks", "history", taskId] as const,
    memories: (taskId: string) => ["tasks", "memories", taskId] as const,
    archive: (params: ArchiveParams = {}) => ["tasks", "archive", params] as const,
    archiveAll: ["tasks", "archive"] as const,
    inbox: (params: InboxParams = {}) => ["tasks", "inbox", params] as const,
    /** Prefix over every inbox query (adopt/refresh invalidation, Ф3). */
    inboxAll: ["tasks", "inbox"] as const,
  },
  traces: {
    all: ["traces"] as const,
    list: (params: { task_label?: string; limit?: number } = {}) =>
      ["traces", "list", params] as const,
  },
  sessions: {
    all: ["sessions"] as const,
    list: () => ["sessions", "list"] as const,
    detail: (id: string) => ["sessions", "detail", id] as const,
  },
  // L2 (D12): cluster graph is out of L1 scope; the key namespace stays
  // reserved so the hidden nav slot can be wired without a key migration.
  clusters: {
    all: ["clusters"] as const,
  },
  // AGW-1 agents domain (spec 2026-09-19): assignment queue + executor
  // registry + the default-executor settings pair. There is NO
  // per-assignment detail key: the queue IS the projection (the Ф3 drawer
  // reads a filtered list query) — the same single-projection decision as
  // tasks.board. Executor presence lives in the registry key; TTL constants
  // arrive in its meta and are cached WITH the page.
  agents: {
    all: ["agents"] as const,
    assignments: {
      all: ["agents", "assignments"] as const,
      list: (params: AssignmentListParams = {}) =>
        ["agents", "assignments", "list", params] as const,
    },
    executors: {
      all: ["agents", "executors"] as const,
      list: () => ["agents", "executors", "list"] as const,
    },
    // AGW-5 phase 2: enrollment tokens (mint/list/revoke, ui-token class).
    // SSE enrollment.* invalidates this family; `used` additionally
    // invalidates executors (a pending row was minted).
    enrollment: {
      all: ["agents", "enrollment"] as const,
      list: () => ["agents", "enrollment", "list"] as const,
    },
    // Wave 3C: the harness dictionary (open read) — the select options in
    // the assign/enrollment/automation forms. SSE harness.added/removed
    // invalidates this family.
    harnesses: {
      all: ["agents", "harnesses"] as const,
      list: () => ["agents", "harnesses", "list"] as const,
    },
    settings: {
      execution: () => ["agents", "settings", "execution"] as const,
    },
  },
  // SCHED-1-UI automation (ADR 0013): engine status (with the condition
  // meta-dictionary), the two rule lists, the launch journal. rule.* SSE
  // is a FAMILY-sync signal — one prefix covers both rule kinds.
  automation: {
    all: ["automation"] as const,
    status: () => ["automation", "status"] as const,
    settings: () => ["automation", "settings"] as const,
    schedules: () => ["automation", "schedules"] as const,
    hooks: () => ["automation", "hooks"] as const,
    launches: (params: { limit?: number; cursor?: string } = {}) =>
      ["automation", "launches", params] as const,
  },
  // CV-7 QR pairing (ADR 0012): device sessions (the owner panel list) and
  // the trusted-side pairing status per id (the dialog's verify/scan view).
  // pairing.* SSE invalidates both families; there is NO pairing LIST key —
  // pairings are single-flight, the dialog holds its own id.
  devices: {
    all: ["devices"] as const,
    list: () => ["devices", "list"] as const,
  },
  pairing: {
    all: ["pairing"] as const,
    status: (pairingId: string) => ["pairing", "status", pairingId] as const,
  },
} as const;

/** Convenience key types for hook signatures. */
export type MemoriesListKey = ReturnType<typeof keys.memories.list>;
export type MemoryDetailKey = ReturnType<typeof keys.memories.detail>;
export type SearchResultsKey = ReturnType<typeof keys.search.results>;
export type TagsListKey = ReturnType<typeof keys.tags.list>;
export type HealthKey = ReturnType<typeof keys.status.health>;
export type MetricsKey = ReturnType<typeof keys.status.metrics>;
export type BoardHealthKey = ReturnType<typeof keys.status.boardHealth>;
export type PulseFeedKey = ReturnType<typeof keys.pulse.feed>;
export type TaskBoardKey = ReturnType<typeof keys.tasks.board>;
export type TaskReportsKey = ReturnType<typeof keys.tasks.reports.detail>;
export type TaskHistoryKey = ReturnType<typeof keys.tasks.history>;
export type TaskMemoriesKey = ReturnType<typeof keys.tasks.memories>;
export type TaskArchiveKey = ReturnType<typeof keys.tasks.archive>;
export type TaskInboxKey = ReturnType<typeof keys.tasks.inbox>;
export type TracesListKey = ReturnType<typeof keys.traces.list>;
export type SessionsListKey = ReturnType<typeof keys.sessions.list>;
export type SessionDetailKey = ReturnType<typeof keys.sessions.detail>;
export type AgentsAssignmentsKey = ReturnType<typeof keys.agents.assignments.list>;
export type ExecutorsListKey = ReturnType<typeof keys.agents.executors.list>;
export type ExecutionSettingsKey = ReturnType<typeof keys.agents.settings.execution>;
export type AutomationStatusKey = ReturnType<typeof keys.automation.status>;
export type AutomationSettingsKey = ReturnType<typeof keys.automation.settings>;
export type AutomationSchedulesKey = ReturnType<typeof keys.automation.schedules>;
export type AutomationHooksKey = ReturnType<typeof keys.automation.hooks>;
export type AutomationLaunchesKey = ReturnType<typeof keys.automation.launches>;
