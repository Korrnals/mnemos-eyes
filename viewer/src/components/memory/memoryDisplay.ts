import type { Memory } from "@/gateway/types";

/**
 * Shared display helpers for memory surfaces (list card, search hit, scroll).
 * Pure functions — unit-testable without a DOM.
 */

/** Effective content = refined text when present, otherwise the raw content. */
export function memoryEffectiveContent(memory: Memory): string {
  return memory.clean_content ?? memory.content;
}

/**
 * Auto-title per component-inventory §4: the stored title, or the head of the
 * effective content when the memory has none.
 */
export function memoryTitle(memory: Memory): string {
  const title = memory.title?.trim();
  if (title) return title;
  const content = memoryEffectiveContent(memory).trim();
  return content.length > 60 ? `${content.slice(0, 60).trimEnd()}…` : content;
}

/**
 * Rule/code memories render in mono (D11: frozen — Lora for everything else).
 * The tag contract spells these `type:rule` / `mnemos:rule` / `*:code`; any
 * namespaced tag ending in `:rule` / `:code` qualifies.
 */
export function isMonoMemory(memory: Memory): boolean {
  return (memory.tags ?? []).some((tag) => /:(rule|code)$/i.test(tag));
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Deterministic `14 Sep 2026` formatting (locale-independent for tests/SSR). */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = MONTHS[date.getUTCMonth()];
  return `${day} ${month} ${date.getUTCFullYear()}`;
}

/** Compact human duration for trace timings: `4m 12s`, `1.4s`, `620ms`. */
export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || Number.isNaN(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Score chip text: two decimals, e.g. `0.92`. */
export function formatScore(score: number): string {
  return Number.isFinite(score) ? score.toFixed(2) : "—";
}

/** Confidence label: amber dot + numeric score (inventory §5). */
export function formatConfidence(confidence: number | null | undefined): string {
  return typeof confidence === "number" && Number.isFinite(confidence)
    ? `● ${confidence.toFixed(2)}`
    : "● —";
}

/**
 * Defensive numeric read from the free-form `/metrics` JSON object: tries the
 * candidate keys in order and returns the first finite number.
 */
export function metricNumber(
  metrics: Record<string, unknown> | null | undefined,
  keys: string[],
): number | null {
  if (!metrics) return null;
  for (const key of keys) {
    const value = metrics[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}
