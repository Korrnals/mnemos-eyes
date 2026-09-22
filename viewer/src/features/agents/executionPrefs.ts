/**
 * Agents-domain persisted view preferences (AGW-3): the terminal-group
 * collapse of the assignment list and the UI-10 panel collapse — both
 * PERSISTENT per spec §1.1/§3.2, both under the `vesmaro.*` localStorage
 * namespace. Pure + guarded-storage helpers exactly like tasksViewPrefs.ts
 * (the node test environment has no DOM).
 */

const TERMINAL_COLLAPSED_KEY = "vesmaro.agents.terminalCollapsed";
const FEED_COLLAPSED_KEY = "vesmaro.agents.feedCollapsed";
/** AGW-4 onboarding: the «Как это работает» row auto-expands ONCE — the
 * first collapse writes the flag and it never auto-expands again. */
const ONBOARDING_DONE_KEY = "vesmaro.agents.onboardingDone";

/** Spec §1.1: the terminal group starts COLLAPSED (persistent from then on). */
export const DEFAULT_TERMINAL_COLLAPSED = true;
/** Spec §3.2: the UI-10 panel starts COLLAPSED (persistent from then on). */
export const DEFAULT_FEED_COLLAPSED = true;

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function readFlag(key: string, fallback: boolean): boolean {
  const storage = safeStorage();
  if (!storage) return fallback;
  try {
    const stored = storage.getItem(key);
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {
    // private mode — fall through to the default
  }
  return fallback;
}

function writeFlag(key: string, value: boolean): void {
  try {
    safeStorage()?.setItem(key, value ? "1" : "0");
  } catch {
    // Swallow: only the persistence is lost, the toggle still works.
  }
}

export function loadTerminalCollapsed(): boolean {
  return readFlag(TERMINAL_COLLAPSED_KEY, DEFAULT_TERMINAL_COLLAPSED);
}

export function saveTerminalCollapsed(collapsed: boolean): void {
  writeFlag(TERMINAL_COLLAPSED_KEY, collapsed);
}

export function loadFeedCollapsed(): boolean {
  return readFlag(FEED_COLLAPSED_KEY, DEFAULT_FEED_COLLAPSED);
}

export function saveFeedCollapsed(collapsed: boolean): void {
  writeFlag(FEED_COLLAPSED_KEY, collapsed);
}

/** The onboarding hint auto-expands until the owner collapses it once. */
export function loadOnboardingDone(): boolean {
  return readFlag(ONBOARDING_DONE_KEY, false);
}

export function saveOnboardingDone(): void {
  writeFlag(ONBOARDING_DONE_KEY, true);
}
