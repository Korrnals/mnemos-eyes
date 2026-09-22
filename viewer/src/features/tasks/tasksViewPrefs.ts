/**
 * Historical note (owner feedback 2026-09-22): the task VIEW preference
 * ("vesmaro.tasksView", kanban vs list) existed here and redirected /tasks
 * to /tasks/list when "list" was stored — overriding explicit navigation.
 * Removed: the route is the contract («Канбан» → kanban, «Список» → list);
 * a stale key in existing browsers is ignored harmlessly. This file keeps
 * only the kanban STYLE preference (CV-5 «Группы | Классика»), which is a
 * rendering variant INSIDE /tasks, not a route choice.
 */

// --- board style (CV-5 — «Группы | Классика») -------------------------------------
//
// The kanban board renders in two styles (owner feedback 1.10.2): "groups"
// (project accordions inside columns — the Ф3 default, EXACT current
// behaviour) and "classic" (flat card flow, the standard kanban canon —
// no accordions, priority→position order, roomier cards). Same route, same
// DnD, same filters — only the column's list rendering switches, so the
// choice persists locally under "vesmaro.boardStyle" instead of living in
// the URL like the kanban/list projection switch above.

export type BoardStyle = "groups" | "classic";

/** localStorage key for the board style (CV-5 owner feedback). */
export const BOARD_STYLE_STORAGE_KEY = "vesmaro.boardStyle";

/** The Ф3 default — the grouped board keeps its exact current behaviour. */
export const DEFAULT_BOARD_STYLE: BoardStyle = "groups";

export function isBoardStyle(value: unknown): value is BoardStyle {
  return value === "groups" || value === "classic";
}

/** Guarded localStorage handle — undefined outside a browser/test stub. */
function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined; // private mode / disabled storage
  }
}

/** Read the persisted board style; corrupt data falls back to "groups". */
export function loadBoardStyle(storage: Storage | undefined = safeStorage()): BoardStyle {
  if (!storage) return DEFAULT_BOARD_STYLE;
  try {
    const stored = storage.getItem(BOARD_STYLE_STORAGE_KEY);
    return isBoardStyle(stored) ? stored : DEFAULT_BOARD_STYLE;
  } catch {
    return DEFAULT_BOARD_STYLE;
  }
}

/** Persist the board style; storage failures are non-fatal. */
export function saveBoardStyle(
  style: BoardStyle,
  storage: Storage | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(BOARD_STYLE_STORAGE_KEY, style);
  } catch {
    // Swallow: the in-memory style still switches for this session.
  }
}
