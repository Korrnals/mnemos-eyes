/**
 * Pure hotkey resolution (Ф1, ARCHCOM-3 verdict §2 — the proven ai-brain
 * canon with the `inInput` guard). Kept DOM-free and React-free so the guard
 * rules are exhaustively unit-testable; the provider wiring lives in
 * Hotkeys.tsx.
 */
export type HotkeyAction = "focus-search" | "open-help";

/** Minimal event shape resolveHotkey needs (pure, DOM-free — unit-testable). */
export interface HotkeyEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  target?: EventTarget | null;
}

/** True when focus sits in an editable surface — hotkeys must stay quiet. */
export function isEditableTarget(target: EventTarget | null | undefined): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== "string") return false;
  const element = target as HTMLElement;
  const tag = element.tagName.toUpperCase();
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    element.isContentEditable === true
  );
}

/**
 * Map a keydown to a hotkey action, or null. Guards: no modifier combos
 * (those belong to the browser/OS), and the inInput rule above.
 */
export function resolveHotkey(event: HotkeyEvent): HotkeyAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (isEditableTarget(event.target)) return null;
  if (event.key === "/") return "focus-search";
  if (event.key === "?") return "open-help";
  return null;
}

/** DOM id of the top-bar search input (see TopBar) — the `/` target. */
export const GLOBAL_SEARCH_INPUT_ID = "topbar-global-search";
