import type { ExecutorItem } from "@/gateway/boardTypes";

/**
 * Registry ordering for `/agents/harnesses` (AGW-4): pending FIRST — the
 * approval queue is the page's main answer (FIFO: oldest registration
 * first); then approved rows with ENABLED ahead of disabled (the
 * actionable ones lead); revoked LAST (dead identities stay visible but
 * sink). Newest-first inside the settled bands, plain and testable —
 * the page renders the three bands as-is and hides empty ones.
 */
export interface RegistryBands {
  /** The approval queue, oldest first. */
  readonly pending: readonly ExecutorItem[];
  /** Approved rows: enabled before disabled, newest first inside. */
  readonly active: readonly ExecutorItem[];
  /** Terminal kill-switched rows, newest first. */
  readonly revoked: readonly ExecutorItem[];
}

export function orderRegistry(items: readonly ExecutorItem[]): RegistryBands {
  const pending: ExecutorItem[] = [];
  const active: ExecutorItem[] = [];
  const revoked: ExecutorItem[] = [];
  for (const row of items) {
    if (row.state === "pending") pending.push(row);
    else if (row.state === "revoked") revoked.push(row);
    else active.push(row);
  }
  const byNewest = (a: ExecutorItem, b: ExecutorItem): number =>
    b.registered_at.localeCompare(a.registered_at);
  const byOldest = (a: ExecutorItem, b: ExecutorItem): number =>
    a.registered_at.localeCompare(b.registered_at);
  return {
    pending: [...pending].sort(byOldest), // FIFO queue
    active: [...active].sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return byNewest(a, b);
    }),
    revoked: [...revoked].sort(byNewest),
  };
}
