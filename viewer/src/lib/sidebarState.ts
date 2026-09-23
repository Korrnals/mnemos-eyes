import { useSyncExternalStore } from "react";

/**
 * Shared sidebar collapse state (UI-23, spec 2026-09-23 §2.1/§4.3): the
 * sidebar button and the settings-hub «Сайдбар» control both consume this
 * store — one state, two controls, no storage-event listeners. The key
 * `vesmaro.sidebarCollapsed` and the guarded read/write semantics move here
 * verbatim from Shell.tsx (UI-19): «1» collapsed, anything else open, writes
 * are non-fatal, and Shell re-affirms the stored value on every mount.
 *
 * UI-22 semantics (merged from Shell.tsx): the flag is the DESKTOP intent
 * only — the Sidebar's mobile (<md) overlay state is session-only and its
 * toggle never reaches this store, so a phone can never corrupt the
 * desktop's remembered panel width.
 */

export const SIDEBAR_COLLAPSED_STORAGE_KEY = "vesmaro.sidebarCollapsed";

/** Guarded localStorage handle — undefined outside a browser/test stub. */
function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined; // private mode / disabled storage
  }
}

/** Read the persisted collapse flag; absent/corrupt data falls back to open. */
function loadSidebarCollapsed(storage: Storage | undefined = safeStorage()): boolean {
  if (!storage) return false;
  try {
    if (storage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1") return true;
  } catch {
    // private mode — fall through to the default
  }
  return false;
}

/** Persist the collapse flag; storage failures are non-fatal. */
export function saveSidebarCollapsed(
  collapsed: boolean,
  storage: Storage | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    // Swallow: the in-memory state still switches for this session.
  }
}

let current: boolean | null = null; // lazy: first snapshot reads storage

/**
 * Read-through snapshot: storage stays the persisted truth and every mount
 * re-reads it (tests seed between mounts; within a render pass the boolean
 * is stable, so useSyncExternalStore stays correct). In-tab changes always
 * go through the setters below, which notify the subscribers.
 */
function snapshot(): boolean {
  current = loadSidebarCollapsed();
  return current;
}

const listeners = new Set<() => void>();

function setCollapsed(collapsed: boolean): void {
  current = collapsed;
  saveSidebarCollapsed(collapsed);
  listeners.forEach((notify) => notify());
}

/** Flip the rail — the single toggle the sidebar button (and tests) call. */
export function toggleSidebarCollapsed(): void {
  setCollapsed(!snapshot());
}

/** Set the rail explicitly — the settings-hub segmented control uses this. */
export function setSidebarCollapsed(collapsed: boolean): void {
  setCollapsed(collapsed);
}

export function subscribeSidebarCollapsed(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

/** Current flag — the non-reactive read (tests, non-React code). */
export function getSidebarCollapsed(): boolean {
  return snapshot();
}

/** Reactive collapse flag — the one hook Shell and the hub share. */
export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(subscribeSidebarCollapsed, snapshot, snapshot);
}
