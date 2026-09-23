import { useSyncExternalStore } from "react";
import {
  loadBoardStyle,
  saveBoardStyle,
  type BoardStyle,
} from "@/features/tasks/tasksViewPrefs";

/**
 * Shared board-style state (UI-23, spec 2026-09-23 §4.3): «one state, two
 * controls» — the kanban's «Группы | Классика» toggle and the settings-hub
 * control both consume `useBoardStyle()`. The preference itself stays
 * `vesmaro.boardStyle` with its original owner module (tasksViewPrefs.ts,
 * the guarded read/write helpers are reused verbatim); v2 only lifts the
 * React state that used to be a `useState` inside TaskBoardView into this
 * tiny external store, so the hub can reflect and change it from any page.
 *
 * localStorage is persistence, not a sync bus (spec §4.3): no storage-event
 * listeners; within a tab this store is the single source of truth.
 */

let current: BoardStyle | null = null; // lazy: first snapshot reads storage

/**
 * Read-through snapshot: storage stays the persisted truth and every mount
 * re-reads it (tests seed between mounts; within a render pass the string is
 * stable, so useSyncExternalStore stays correct). In-tab changes always go
 * through setBoardStyle, which notifies the subscribers.
 */
function snapshot(): BoardStyle {
  current = loadBoardStyle();
  return current;
}

const listeners = new Set<() => void>();

/** Set the style: one write path — persist + notify every consumer. */
export function setBoardStyle(style: BoardStyle): void {
  current = style;
  saveBoardStyle(style);
  listeners.forEach((notify) => notify());
}

export function subscribeBoardStyle(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

/** Current style — the non-reactive read (tests, non-React code). */
export function getBoardStyle(): BoardStyle {
  return snapshot();
}

/** `[style, setStyle]` — the one hook the kanban page and the hub share. */
export function useBoardStyle(): [BoardStyle, (style: BoardStyle) => void] {
  const style = useSyncExternalStore(subscribeBoardStyle, snapshot, snapshot);
  return [style, setBoardStyle];
}
