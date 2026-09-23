import { useSyncExternalStore } from "react";

/**
 * Session-only signal «the mobile sidebar OVERLAY is open right now» (ME-002).
 * The overlay state itself lives in the Sidebar (never persisted — see the
 * Sidebar docblock); this store is the read-only mirror the page chrome
 * consumes to leave the accessibility tree while the dialog covers the page:
 * Shell inerts the skip link + the content column, the toast region and the
 * update banner inert their own roots. One state, many consumers — the same
 * «one state, two controls» shape as sidebarState.ts, minus the storage.
 *
 * Semantics: boolean flag, idempotent writes (no redundant notifications),
 * the server snapshot is always false (effects never run on the server, so
 * SSR harnesses never see a phantom overlay).
 */

let overlayOpen = false;
const listeners = new Set<() => void>();

/** Current flag — the non-reactive read (tests, non-React code). */
export function getSidebarOverlayOpen(): boolean {
  return overlayOpen;
}

export function subscribeSidebarOverlayOpen(notify: () => void): () => void {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

/** Publish the Sidebar's overlay state. Idempotent: no-op on no change. */
export function setSidebarOverlayOpen(open: boolean): void {
  if (overlayOpen === open) return;
  overlayOpen = open;
  listeners.forEach((notify) => notify());
}

/** Reactive flag — what Shell and the chrome surfaces subscribe to. */
export function useSidebarOverlayOpen(): boolean {
  return useSyncExternalStore(
    subscribeSidebarOverlayOpen,
    getSidebarOverlayOpen,
    () => false,
  );
}
