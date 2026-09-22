import type { ListMemoriesParams } from "@/gateway/types";

/**
 * URL-param contract for `/memories` (component-inventory §4):
 * `?status=&project=&limit=&page=`. Pure parse/serialize helpers — unit
 * testable, and shared by the filter controls and the pagination footer.
 */

export const MEMORY_STATUSES = [
  "raw",
  "processing",
  "processed",
  "published",
  "archived",
] as const;

export const PAGE_SIZES = [10, 20, 50] as const;
export const DEFAULT_PAGE_SIZE = 20;

export interface MemoryListUrlState {
  status?: string;
  project?: string;
  /** Tag filter (UI-17 §5.6 — «Открыть в Записях» deep-link `/memory?tag=`). */
  tag?: string;
  limit: number;
  page: number;
}

export function parseMemoryListParams(params: URLSearchParams): MemoryListUrlState {
  const rawLimit = Number.parseInt(params.get("limit") ?? "", 10);
  const rawPage = Number.parseInt(params.get("page") ?? "", 10);
  const status = params.get("status") ?? undefined;
  return {
    status:
      status && (MEMORY_STATUSES as readonly string[]).includes(status) ? status : undefined,
    project: params.get("project") ?? undefined,
    tag: params.get("tag") ?? undefined,
    limit: PAGE_SIZES.includes(rawLimit as (typeof PAGE_SIZES)[number])
      ? rawLimit
      : DEFAULT_PAGE_SIZE,
    page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1,
  };
}

/** Gateway params for one page of the list. */
export function toListParams(state: MemoryListUrlState): ListMemoriesParams {
  return {
    status: state.status,
    project: state.project,
    tags: state.tag,
    limit: state.limit,
    offset: (state.page - 1) * state.limit,
  };
}

/** True when any filter narrows the list (drives the empty-state copy). */
export function hasActiveFilters(state: MemoryListUrlState): boolean {
  return Boolean(state.status || state.project || state.tag);
}
