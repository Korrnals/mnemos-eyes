import type { ExecutorListMeta, ExecutorPresence } from "@/gateway/boardTypes";
import type { TranslationKey } from "@/i18n";

/**
 * Presence computation from the server-owned TTL contract (spec §2.1/§5.1):
 * the thresholds ALWAYS come from the registry `meta` (`useExecutors`) —
 * this module never hardcodes 120/600; when meta is absent (query pending)
 * the honest answer is `null` ("unknown"), never a guess. The two-clock
 * rule (§2.1): executor presence and assignment life are independent facts
 * — the UI shows both, never collapses one into the other.
 */

/**
 * Classify one last_seen stamp against the meta TTLs.
 * online: age ≤ online_max_age_s; stale: ≤ stale_max_age_s; offline beyond.
 */
export function presenceFromLastSeen(
  lastSeen: string,
  meta: ExecutorListMeta | undefined,
  now: number,
): ExecutorPresence | null {
  if (!meta) return null; // no server contract yet — unknown, not guessed
  const at = Date.parse(lastSeen);
  if (!Number.isFinite(at)) return null;
  if (now < at) return "online"; // clock skew — honest best case
  const ageS = (now - at) / 1000;
  if (ageS <= meta.presence.online_max_age_s) return "online";
  if (ageS <= meta.presence.stale_max_age_s) return "stale";
  return "offline";
}

/** Age of a last_seen stamp in whole seconds (null when unparsable/meta-less). */
export function lastSeenAgeS(
  lastSeen: string,
  now: number,
): number | null {
  const at = Date.parse(lastSeen);
  if (!Number.isFinite(at) || now < at) return null;
  return Math.floor((now - at) / 1000);
}

/** Mono age string for the strip ("4м"/"2ч 05м"/"3д") — compact, whole
 * units only (90 s reads "1м"; the strip is a glance, not a stopwatch). */
export function formatPulseAge(ageS: number, unit: {
  readonly minutes: string;
  readonly hours: string;
  readonly days: string;
}): string {
  const minutes = Math.floor(ageS / 60);
  if (minutes < 60) return `${minutes}${unit.minutes}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const restMinutes = minutes % 60;
    return restMinutes > 0
      ? `${hours}${unit.hours} ${String(restMinutes).padStart(2, "0")}${unit.minutes}`
      : `${hours}${unit.hours}`;
  }
  return `${Math.floor(hours / 24)}${unit.days}`;
}

// --- presence visuals (shared by the strip AND the registry rows, AGW-4) ---------

/**
 * Presence dot classes (spec §3.2 — semantic aliases only, NO new colours:
 * iris / warning / muted). Offline is a HOLLOW dot — shape carries the
 * meaning with the colour; unknown is the same hollow shape with a muted
 * ring, visibly NOT a verdict.
 */
export const PRESENCE_DOT: Readonly<Record<string, string>> = {
  online: "bg-iris-bright",
  stale: "bg-warning",
  offline: "border border-border bg-transparent",
  unknown: "border border-border-subtle bg-transparent",
};

/** Presence age text tone next to the dot (secondary while alive, muted dead). */
export const PRESENCE_TEXT: Readonly<Record<string, string>> = {
  online: "text-foreground-secondary",
  stale: "text-foreground-secondary",
  offline: "text-foreground-muted",
  unknown: "text-foreground-muted",
};

/** SR label key for a presence verdict (including the unknown non-verdict). */
export function presenceLabelKey(presence: string): TranslationKey {
  switch (presence) {
    case "online":
      return "agents.presence.online";
    case "stale":
      return "agents.presence.stale";
    case "offline":
      return "agents.presence.offline";
    default:
      return "agents.presence.unknown";
  }
}
