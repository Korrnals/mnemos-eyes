/**
 * Reaper & staleness thresholds the server does NOT ship in meta (ADR 0009
 * §10 — the ARCH-7 assignment reaper; values mirror server/store.py):
 *
 * | constant                    | server                    | meaning |
 * |-----------------------------|---------------------------|---------|
 * | CLAIM_NO_START_AFTER_S      | REAP_CLAIM_AFTER_S = 600  | claimed without a start for 10 min is reaped |
 * | HEARTBEAT_REAP_AFTER_S      | REAP_HEARTBEAT_AFTER_S = 1800 | running without a pulse for 30 min is reaped |
 * | QUEUED_REAP_AFTER_S         | REAP_QUEUED_AFTER_S = 1800   | queued unseen for 30 min → NOTIFICATION ONLY (store.py:2182-2199 — "state stays queued"; expiry exists for claimed/running alone) |
 * | PULSE_STALE_AFTER_S         | — (spec §3.1: >2 мин)     | a running pulse older than 2 min is AMBER |
 *
 * These are the ONLY place these numbers live in the UI (AGW-3 review
 * contract). PRESENCE thresholds are different: they ARE server data —
 * always read them from the executors `meta` (useExecutors), never here.
 *
 * Follow-up: a `/api/assignments/meta` endpoint should ship the reaper
 * constants the way `/api/executors` ships presence TTLs (spec §5.6) —
 * until then this mirror is the single source, greppable against store.py.
 */

/** Claimed without start → reaped (server REAP_CLAIM_AFTER_S). */
export const CLAIM_NO_START_AFTER_S = 600;

/** Running without pulse → reaped (server REAP_HEARTBEAT_AFTER_S). */
export const HEARTBEAT_REAP_AFTER_S = 1800;

/** Queued unseen 30 min → the owner gets a NOTIFICATION; the row NEVER
 * expires on its own (store.py — "state stays queued"). */
export const QUEUED_REAP_AFTER_S = 1800;

/** Running pulse older than this is amber (spec §3.1; 2 мин). */
export const PULSE_STALE_AFTER_S = 120;

/** Seconds left at which the reaper countdown becomes urgent (spec §3.1). */
export const REAP_URGENT_WITHIN_S = 300;

/** Minutes formatting helper for countdowns ("~M мин" strings). */
export function secondsToMinutes(seconds: number): number {
  return Math.max(0, Math.ceil(seconds / 60));
}
