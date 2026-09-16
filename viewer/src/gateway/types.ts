/**
 * Domain types for the gateway layer.
 *
 * TODO(T3): today these are hand-written mirrors of the mnemos API shapes
 * (transcribed from architecture.md §4). When `openapi-typescript` is wired
 * (scripts/codegen.sh → src/types/openapi.d.ts), re-home them onto the
 * generated `components["schemas"]` and re-export from here so hooks and
 * components consume a single source of truth.
 */

/** Unified search request (FTS + semantic via mnemos `/search`). */
export interface SearchParams {
  query: string;
  tags?: string[];
  project?: string;
  limit?: number;
  include_raw?: boolean;
}

/** A single ranked search hit. */
export interface SearchResult {
  id: string;
  title: string;
  content: string;
  tags: string[];
  score: number;
  search_type: "fts" | "semantic" | "hybrid";
}

/** Memory list filters (mnemos list endpoint). */
export interface ListMemoriesParams {
  status?: string;
  project?: string;
  limit?: number;
  offset?: number;
}

/** A stored memory ("scroll"). */
export interface Memory {
  id: string;
  content: string;
  raw_content?: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  status: string;
  confidence?: number | null;
  source?: string | null;
  project?: string | null;
  agent?: string | null;
}

/** Tag with usage count (mnemos `GET /tags`; client-side fallback per ADR 0003). */
export interface TagSummary {
  tag: string;
  count: number;
}

/** Liveness payload from mnemos `/health`. */
export interface HealthStatus {
  status: string;
  [key: string]: unknown;
}

/** Aggregate counters from mnemos `/metrics`. */
export interface Metrics {
  [key: string]: unknown;
}

/** Pipeline trace entry. */
export interface Trace {
  id: string;
  task_label?: string | null;
  [key: string]: unknown;
}

/** A2A session record (mounted under `/v1` on mnemos). */
export interface A2ASession {
  id: string;
  [key: string]: unknown;
}
