import { useSyncExternalStore } from "react";

/**
 * `vesmaro.motion` (UI-23, spec 2026-09-23 §2.5): the user-level animation
 * regime — `system` (follow the OS `prefers-reduced-motion`, today's exact
 * behaviour, the default) or `reduced` (force the reduced-motion branches
 * regardless of the OS — for owners who never find the OS switch).
 *
 * ONE state, TWO controls (spec §0/§4.3): the hub's segmented control and
 * `useReducedMotion()` consumers both go through this external store — no
 * second source of truth, no storage-event listeners. Storage/DOM access is
 * guarded (node vitest, private mode); a corrupt value means the default.
 *
 * The attribute `[data-motion="reduced"]` on <html> is the CSS side of the
 * discipline: tokens.css, global.css and skeletons.css mirror their existing
 * `prefers-reduced-motion` branches with it. initMotion() runs at module
 * load (before the first React render — the import graph reaches this module
 * from Sidebar→IrisLogo) so a stored «reduced» never flashes full motion.
 */
export type Motion = "system" | "reduced";

export const MOTION_STORAGE_KEY = "vesmaro.motion";
export const DEFAULT_MOTION: Motion = "system";

/** Segmented-control options, in display order. */
export const MOTIONS = ["system", "reduced"] as const satisfies readonly Motion[];

export function isMotion(value: unknown): value is Motion {
  return value === "system" || value === "reduced";
}

/** Guarded localStorage handle — undefined outside a browser/test stub. */
function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined; // private mode / disabled storage
  }
}

/** Read the persisted regime; null when absent, invalid or unavailable. */
export function readStoredMotion(
  storage: Storage | undefined = safeStorage(),
): Motion | null {
  if (!storage) return null;
  try {
    const stored = storage.getItem(MOTION_STORAGE_KEY);
    return isMotion(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Persist the regime; storage failures are non-fatal. */
export function persistMotion(
  motion: Motion,
  storage: Storage | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(MOTION_STORAGE_KEY, motion);
  } catch {
    // Swallow: the in-memory regime still switches for this session.
  }
}

/** Mirror the regime onto <html data-motion> (CSS reduced branches key on it). */
export function applyMotion(motion: Motion): void {
  if (typeof document === "undefined") return;
  if (motion === "reduced") {
    document.documentElement.dataset.motion = "reduced";
  } else {
    // system = the OS media query owns the branches; no attribute.
    delete document.documentElement.dataset.motion;
  }
}

// --- the one store -----------------------------------------------------------------

let current: Motion | null = null; // last known value (cache only)

/**
 * Read-through snapshot: storage stays the persisted truth and every mount
 * re-reads it (within a render pass the string is stable, so
 * useSyncExternalStore stays correct). In-tab changes always go through
 * setMotion, which notifies the subscribers.
 */
function snapshot(): Motion {
  current = readStoredMotion() ?? DEFAULT_MOTION;
  return current;
}

const listeners = new Set<() => void>();

/** Set the regime: one write path — persist, apply, notify every consumer. */
export function setMotion(motion: Motion): void {
  current = motion;
  persistMotion(motion);
  applyMotion(motion);
  listeners.forEach((notify) => notify());
}

/** Re-read storage and re-apply (idempotent; runs once at module load). */
export function initMotion(): void {
  applyMotion(snapshot());
}

export function subscribeMotion(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

/** Current regime — the non-reactive read (tests, non-React code). */
export function getMotion(): Motion {
  return snapshot();
}

/** Reactive regime — the single hook the hub and tests consume. */
export function useMotion(): Motion {
  return useSyncExternalStore(subscribeMotion, snapshot, getServerMotion);
}

function getServerMotion(): Motion {
  return snapshot();
}

// Pre-paint application: imports of this module resolve before the first
// React render (see module doc), so a stored «reduced» is on <html> by then.
initMotion();
