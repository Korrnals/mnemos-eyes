import { useSyncExternalStore } from "react";

/**
 * Shared 1 Hz validation clock (ARCHCOM-3 verdict §3: "один общий тикер 1 Hz"
 * — never a setInterval per card). Module-level singleton: the FIRST
 * subscribing validating card starts ONE interval; the last unsubscriber
 * stops it. Cards read the timestamp through useSyncExternalStore, so each
 * tick re-renders ONLY the mounted validating cards — the board page, the
 * columns and every other card stay untouched. Offscreen cards are further
 * cheapened by `content-visibility: auto` on the card itself (paint skipped,
 * verdict §3), and collapsed groups do not render their cards at all, so
 * they never subscribe.
 *
 * The snapshot is 0 until the first subscribe — SSR/renderToString renders
 * no clock label (deterministic output), the browser fills it on mount.
 */

const TICK_MS = 1000;

const listeners = new Set<() => void>();
let interval: ReturnType<typeof setInterval> | null = null;
/** Current shared timestamp; 0 = inactive (no subscribers yet). */
let snapshot = 0;

function start(): void {
  if (interval !== null) return;
  snapshot = Date.now();
  interval = setInterval(() => {
    snapshot = Date.now();
    for (const listener of listeners) listener();
  }, TICK_MS);
}

function stop(): void {
  if (interval === null) return;
  clearInterval(interval);
  interval = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

function getSnapshot(): number {
  return snapshot;
}

/** SSR snapshot: 0 keeps server output deterministic (no clock label). */
function getServerSnapshot(): number {
  return 0;
}

/** The shared "now" for validating cards; ticks 1 Hz while any is visible. */
export function useValidationNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Test seam: force-stop the singleton (vitest isolated-module caveats). */
export function resetValidationClock(): void {
  listeners.clear();
  stop();
  snapshot = 0;
}
