/**
 * Server `Store.KNOWN_HARNESSES` mirror (store.py — the create routes 422
 * unknown values with the authoritative list in the message, so drift
 * surfaces honestly). Shared by the AssignExecutorSheet and the automation
 * schedule form — ONE mirror, no second copy.
 */
export const KNOWN_HARNESSES = [
  "zcode",
  "hermes",
  "pi",
  "copilot",
  "claude-code",
  "cursor",
  "aider",
  "continue",
  "cline",
  "windsurf",
] as const;

/** Interval-trigger presets for the schedule form (ISO-8601 durations the
 * server validates; a curated closed set — no cron UI, no free text). */
export const INTERVAL_PRESETS = ["PT1H", "PT6H", "PT12H", "P1D"] as const;
