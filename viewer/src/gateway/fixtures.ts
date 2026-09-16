import type { Memory } from "./types";

/**
 * Deterministic mock dataset for the MockAdapter (task T2).
 *
 * Hand-written, realistic "scrolls" covering the mnemos tag-contract subtypes
 * (`mnemos:decision`, `mnemos:bug-pattern`, `mnemos:learning`, checkpoints /
 * session context), all five pipeline statuses, several projects and agents.
 * Everything — ids, dates, scores — is hardcoded: two MockAdapter instances
 * produce byte-identical responses. No `Date.now()` or `Math.random()` here.
 *
 * Shapes follow the generated `Memory` schema (src/types/openapi.d.ts), so
 * what the UI sees in mock mode matches the live wire format.
 */
export const MOCK_MEMORIES: Memory[] = [
  {
    id: "mem-0001",
    content:
      "Decision: the viewer talks to mnemos only through the same-origin /api prefix. " +
      "The Vite dev proxy strips the prefix and forwards to 127.0.0.1:8787; production " +
      "relies on the reverse proxy to do the same. No CORS, no absolute URLs in components.",
    title: "ADR: gateway via same-origin /api proxy",
    tags: ["project:mnemos-eyes", "agent:zed", "mnemos:decision", "topic:gateway"],
    source: "manual",
    memory_type: "note",
    project: "mnemos-eyes",
    agent: "zed",
    status: "published",
    quality_score: 0.94,
    confidence: 0.9,
    raw_content:
      "# ADR: gateway\n\nViewer -> /api -> proxy -> mnemos. No CORS. Keep components fetch-free.",
    clean_content:
      "Viewer talks to mnemos through the same-origin /api prefix; proxies strip it.",
    created_at: "2026-09-14T09:12:00Z",
    updated_at: "2026-09-14T09:12:00Z",
    marker_version: 1,
    metadata: { supersedes: null, decided_by: "gcw-architectural-committee" },
  },
  {
    id: "mem-0002",
    content:
      "Bug pattern: FTS5 external-content tables drift when rows are mutated with plain " +
      "UPDATE. Always route content writes through update_fields or rebuild the index — " +
      "symptom was search returning stale snippets after tag renames.",
    title: "FTS5 external-content drift after plain UPDATE",
    tags: ["project:mnemos", "agent:zed", "mnemos:bug-pattern", "topic:fts"],
    source: "mcp",
    memory_type: "fact",
    project: "mnemos",
    agent: "zed",
    status: "published",
    quality_score: 0.91,
    confidence: 0.88,
    raw_content:
      "tags/rename used to write straight UPDATEs; FTS5 shadow table went out of sync.",
    clean_content:
      "Plain UPDATE on external-content FTS5 tables desyncs the index; use update_fields.",
    created_at: "2026-09-09T14:40:00Z",
    updated_at: "2026-09-10T08:05:00Z",
    marker_version: 1,
  },
  {
    id: "mem-0003",
    content:
      "Learning: long-running readers starve SQLite WAL checkpoints; the -wal file grows " +
      "unbounded and reads slow down. Cap read transactions and run periodic " +
      "wal_checkpoint(TRUNCATE) from the daemon.",
    title: "WAL checkpoint starvation under long readers",
    tags: ["project:mnemos", "agent:claude", "mnemos:learning", "topic:sqlite"],
    source: "mcp",
    memory_type: "fact",
    project: "mnemos",
    agent: "claude",
    status: "published",
    quality_score: 0.87,
    confidence: 0.82,
    created_at: "2026-08-27T11:30:00Z",
    updated_at: "2026-08-27T11:30:00Z",
    marker_version: 1,
  },
  {
    id: "mem-0004",
    content:
      "Decision: all mnemos tags use namespaced prefixes — project:<slug>, agent:<slug>, " +
      "mnemos:<subtype>, topic:<slug>. Subtypes in use: decision, bug-pattern, learning, " +
      "checkpoint. Free-form tags are rejected by the tag contract.",
    title: "Tag contract: namespaced prefixes",
    tags: ["project:mnemos", "agent:user", "mnemos:decision", "topic:tags"],
    source: "manual",
    memory_type: "note",
    project: "mnemos",
    agent: "user",
    status: "published",
    quality_score: 0.96,
    confidence: 0.95,
    created_at: "2026-07-02T10:00:00Z",
    updated_at: "2026-08-15T16:20:00Z",
    marker_version: 1,
  },
  {
    id: "mem-0005",
    content:
      "Session checkpoint 2026-09-10: scaffolded mnemos-eyes viewer (T1), agreed on " +
      "TanStack Query conventions, deferred cluster graph to L2. Open: adapter wiring (T2).",
    title: "Checkpoint: L1 wave kickoff",
    tags: ["project:gcw", "agent:zed", "mnemos:checkpoint", "topic:planning"],
    source: "mcp",
    memory_type: "session_context",
    project: "gcw",
    agent: "zed",
    status: "published",
    quality_score: 0.78,
    confidence: 0.7,
    created_at: "2026-09-10T18:55:00Z",
    updated_at: "2026-09-10T18:55:00Z",
    marker_version: 1,
    metadata: { session: "conv-2026-09-10-4f7a21c9" },
  },
  {
    id: "mem-0006",
    content:
      "Bug pattern: AbortController created in useEffect but never aborted on cleanup — " +
      "in-flight fetches resolve after unmount and set state on dead components. Pair " +
      "every controller.abort() with the effect cleanup return.",
    title: "AbortController leak in effect cleanup",
    tags: ["project:mnemos-eyes", "agent:claude", "mnemos:bug-pattern", "topic:react"],
    source: "mcp",
    memory_type: "fact",
    project: "mnemos-eyes",
    agent: "claude",
    status: "published",
    quality_score: 0.89,
    confidence: 0.85,
    created_at: "2026-09-08T13:05:00Z",
    updated_at: "2026-09-08T13:05:00Z",
    marker_version: 1,
  },
  {
    id: "mem-0007",
    content:
      "Learning: semantic search on mnemos measures 4-7 s at p95. UI timeouts for search " +
      "must be generous (30 s) and requests cancellable — the default 10 s budget would " +
      "abort healthy semantic queries.",
    title: "Semantic search latency budget",
    tags: ["project:mnemos-eyes", "agent:zed", "mnemos:learning", "topic:performance"],
    source: "manual",
    memory_type: "note",
    project: "mnemos-eyes",
    agent: "zed",
    status: "published",
    quality_score: 0.92,
    confidence: 0.9,
    created_at: "2026-09-11T10:15:00Z",
    updated_at: "2026-09-11T10:15:00Z",
    marker_version: 1,
  },
  {
    id: "mem-0008",
    content:
      "Decision: TanStack Query retry policy — one retry for 5xx and network failures, " +
      "never for 4xx. 429 is treated as a client error on purpose: the viewer is " +
      "read-only and should surface rate limiting instead of hammering.",
    title: "Retry policy: 5xx once, 4xx never",
    tags: ["project:mnemos-eyes", "agent:zed", "mnemos:decision", "topic:errors"],
    source: "manual",
    memory_type: "note",
    project: "mnemos-eyes",
    agent: "zed",
    status: "published",
    quality_score: 0.95,
    confidence: 0.93,
    created_at: "2026-09-12T09:00:00Z",
    updated_at: "2026-09-12T09:00:00Z",
    marker_version: 1,
  },
  {
    id: "mem-0009",
    content:
      "Fact: the mnemos HTTP API serves routes from root (/search, /memories, /health); " +
      "there is no /api prefix on the server. The prefix belongs to the viewer's proxy " +
      "and is stripped before forwarding.",
    title: "mnemos routes live at root, not /api",
    tags: ["project:mnemos-eyes", "agent:user", "topic:gateway", "topic:proxy"],
    source: "manual",
    memory_type: "fact",
    project: "mnemos-eyes",
    agent: "user",
    status: "published",
    quality_score: 0.9,
    confidence: 0.88,
    created_at: "2026-09-13T12:45:00Z",
    updated_at: "2026-09-13T12:45:00Z",
    marker_version: 1,
  },
  {
    id: "mem-0010",
    content:
      "Snippet: FTS5 prefix query that powers the search page — SELECT id FROM memories_fts " +
      "WHERE memories_fts MATCH 'gate*' ORDER BY rank LIMIT 20. The trailing asterisk is " +
      "what makes partial-word matches work.",
    title: "FTS5 prefix-match snippet",
    tags: ["project:mnemos", "agent:gemini", "topic:fts", "mnemos:learning"],
    source: "cli",
    memory_type: "snippet",
    project: "mnemos",
    agent: "gemini",
    status: "published",
    quality_score: 0.83,
    confidence: 0.8,
    raw_content: "SELECT id FROM memories_fts WHERE memories_fts MATCH 'gate*' ORDER BY rank;",
    clean_content: "FTS5 prefix queries need the '*' token: MATCH 'gate*'.",
    created_at: "2026-08-30T15:22:00Z",
    updated_at: "2026-08-30T15:22:00Z",
    marker_version: 1,
  },
  {
    id: "mem-0011",
    content:
      "Note: vault watcher debounce is 750 ms with a 5 s max-wait; bursts of vault writes " +
      "collapse into a single ingest pass. Tuned after watching obsidian autosave storms.",
    title: "Vault watcher debounce tuning",
    tags: ["project:mnemos", "agent:user", "topic:watcher"],
    source: "obsidian",
    memory_type: "note",
    project: "mnemos",
    agent: "user",
    status: "processed",
    quality_score: 0.71,
    confidence: 0.65,
    created_at: "2026-09-04T17:10:00Z",
    updated_at: "2026-09-05T09:30:00Z",
    marker_version: 1,
  },
  {
    id: "mem-0012",
    content:
      "Learning: quarantine is terminal by design (ADR-0019) — the only way out is the " +
      "manual release endpoint, which returns the row to pipeline_state=failed, not to " +
      "the served projection. Plan review time accordingly.",
    title: "Quarantine is terminal; release returns to failed",
    tags: ["project:mnemos", "agent:claude", "mnemos:learning", "topic:pipeline"],
    source: "mcp",
    memory_type: "fact",
    project: "mnemos",
    agent: "claude",
    status: "published",
    quality_score: 0.88,
    confidence: 0.86,
    created_at: "2026-09-06T08:40:00Z",
    updated_at: "2026-09-06T08:40:00Z",
    marker_version: 1,
  },
  {
    id: "mem-0013",
    content:
      "Bug pattern: the first dev-proxy rewrite regex (/^\\/api/) was fine, but an " +
      "earlier greedy variant ate nested prefixes (/api/api/v1). Lesson: anchor rewrites " +
      "and test with nested paths.",
    title: "Greedy proxy rewrite ate nested prefixes",
    tags: ["project:mnemos-eyes", "agent:zed", "mnemos:bug-pattern", "topic:proxy"],
    source: "cli",
    memory_type: "note",
    project: "mnemos-eyes",
    agent: "zed",
    status: "archived",
    quality_score: 0.66,
    confidence: 0.6,
    created_at: "2026-08-20T19:00:00Z",
    updated_at: "2026-09-01T10:00:00Z",
    marker_version: 1,
  },
  {
    id: "mem-0014",
    content:
      "Fact: A2A session ids are formatted conv-YYYY-MM-DD-<8 hex chars>, minted by " +
      "POST /v1/sessions. There is no list endpoint — sessions are addressed by id.",
    title: "A2A session id format",
    tags: ["project:mnemos", "agent:user", "topic:a2a"],
    source: "manual",
    memory_type: "fact",
    project: "mnemos",
    agent: "user",
    status: "published",
    quality_score: 0.93,
    confidence: 0.91,
    created_at: "2026-09-07T11:11:00Z",
    updated_at: "2026-09-07T11:11:00Z",
    marker_version: 1,
  },
  {
    id: "mem-0015",
    content:
      "Checkpoint: L1 wave — T1 scaffold merged to feat/l1-t1-scaffold, T3 codegen done, " +
      "T2 gateway in progress. Next: T4 hooks wiring, T5 pages, T6 auth UI.",
    title: "Checkpoint: L1 wave status",
    tags: ["project:mnemos-eyes", "agent:zed", "mnemos:checkpoint"],
    source: "mcp",
    memory_type: "session_context",
    project: "mnemos-eyes",
    agent: "zed",
    status: "raw",
    created_at: "2026-09-15T21:30:00Z",
    updated_at: "2026-09-15T21:30:00Z",
    marker_version: 1,
    metadata: { session: "conv-2026-09-15-88c2f10b" },
  },
  {
    id: "mem-0016",
    content:
      "Notes from the federation sync: mediated pull stays ephemeral (ttl_class is a " +
      "policy hint), topics are hashed for the access log and never stored in plaintext.",
    title: "Federation pull — sync notes",
    tags: ["project:mnemos", "agent:claude", "topic:federation"],
    source: "mcp",
    memory_type: "note",
    project: "mnemos",
    agent: "claude",
    status: "processing",
    created_at: "2026-09-14T20:05:00Z",
    updated_at: "2026-09-14T20:05:00Z",
    marker_version: 1,
  },
  {
    id: "mem-0017",
    content:
      "Fact: Prometheus-format metrics live at /api/v1/metrics; the legacy /metrics " +
      "endpoint returns the stats() JSON object and exists for backward compatibility " +
      "only. Grafana should scrape the /api/v1 one.",
    title: "Metrics endpoints: legacy JSON vs Prometheus",
    tags: ["project:mnemos", "agent:gemini", "topic:observability"],
    source: "file",
    memory_type: "fact",
    project: "mnemos",
    agent: "gemini",
    status: "published",
    quality_score: 0.85,
    confidence: 0.83,
    created_at: "2026-08-25T07:50:00Z",
    updated_at: "2026-08-25T07:50:00Z",
    marker_version: 1,
  },
  {
    id: "mem-0018",
    content:
      "Learning: vitest's node environment has no localStorage — gateway code that " +
      "mirrors tokens to storage must guard with typeof checks and fall back to " +
      "memory-only mode. Tests stub a Map-backed storage when they need persistence.",
    title: "vitest node env lacks localStorage",
    tags: ["project:mnemos-eyes", "agent:claude", "mnemos:learning", "topic:testing"],
    source: "mcp",
    memory_type: "fact",
    project: "mnemos-eyes",
    agent: "claude",
    status: "published",
    quality_score: 0.87,
    confidence: 0.84,
    created_at: "2026-09-15T14:20:00Z",
    updated_at: "2026-09-15T14:20:00Z",
    marker_version: 1,
  },
];

/** Deterministic A2A session fixtures (`SessionRead` shape). */
export const MOCK_SESSIONS = [
  {
    session_id: "conv-2026-09-15-88c2f10b",
    user_id: "agent:zed",
    created_at: "2026-09-15T18:02:00Z",
    updated_at: "2026-09-15T21:30:00Z",
    turns_count: 14,
    metadata: { project: "mnemos-eyes", lane: "l1-scaffold" },
    ttl_expires_at: null,
  },
  {
    session_id: "conv-2026-09-12-4f7a21c9",
    user_id: "agent:claude",
    created_at: "2026-09-12T08:40:00Z",
    updated_at: "2026-09-12T12:15:00Z",
    turns_count: 6,
    metadata: { project: "mnemos", lane: "fts-investigation" },
    ttl_expires_at: "2026-09-19T12:15:00Z",
  },
  {
    session_id: "conv-2026-09-08-77c3aa01",
    user_id: "agent:gemini",
    created_at: "2026-09-08T10:00:00Z",
    updated_at: "2026-09-10T19:45:00Z",
    turns_count: 41,
    metadata: { project: "mnemos", lane: "federation-sync" },
    ttl_expires_at: null,
  },
] as const;

/** Deterministic pipeline-trace fixtures (anonymous wire shape, pinned fields). */
export const MOCK_TRACES = [
  {
    id: "trace-0187",
    task_label: "l1-t1-scaffold",
    status: "ok",
    started_at: "2026-09-14T08:00:00Z",
    finished_at: "2026-09-14T08:04:12Z",
    duration_ms: 252_000,
    steps: [
      { stage: "scaffold", ok: true, ms: 61_000 },
      { stage: "lint", ok: true, ms: 88_000 },
      { stage: "test", ok: true, ms: 103_000 },
    ],
  },
  {
    id: "trace-0186",
    task_label: "l1-t3-codegen",
    status: "ok",
    started_at: "2026-09-14T09:30:00Z",
    finished_at: "2026-09-14T09:31:41Z",
    duration_ms: 101_000,
    steps: [
      { stage: "fetch-openapi", ok: true, ms: 12_000 },
      { stage: "openapi-typescript", ok: true, ms: 89_000 },
    ],
  },
  {
    id: "trace-0185",
    task_label: "ingest-rules",
    status: "ok",
    started_at: "2026-09-13T16:12:00Z",
    finished_at: "2026-09-13T16:13:03Z",
    duration_ms: 63_000,
    steps: [
      { stage: "scan", ok: true, ms: 9_000 },
      { stage: "save", ok: true, ms: 54_000 },
    ],
  },
  {
    id: "trace-0184",
    task_label: "l1-t2-gateway",
    status: "running",
    started_at: "2026-09-16T07:55:00Z",
    finished_at: null,
    duration_ms: null,
    steps: [{ stage: "implement", ok: true, ms: 0 }],
  },
  {
    id: "trace-0183",
    task_label: "quality-gate",
    status: "failed",
    started_at: "2026-09-12T22:10:00Z",
    finished_at: "2026-09-12T22:11:02Z",
    duration_ms: 52_000,
    steps: [
      { stage: "cluster", ok: true, ms: 20_000 },
      { stage: "quality_gate", ok: false, ms: 32_000 },
    ],
  },
  {
    id: "trace-0182",
    task_label: "l1-t1-scaffold",
    status: "ok",
    started_at: "2026-09-12T14:00:00Z",
    finished_at: "2026-09-12T14:02:30Z",
    duration_ms: 150_000,
    steps: [{ stage: "scaffold", ok: true, ms: 150_000 }],
  },
] as const;
