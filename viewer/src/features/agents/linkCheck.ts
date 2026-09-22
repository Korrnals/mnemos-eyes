import type { ExecutorItem, ExecutorListMeta } from "@/gateway/boardTypes";
import type { TranslationKey } from "@/i18n";

/**
 * Link-check verdict automaton (AGW-6 A — «Проверка связи», ADR 0009 §9):
 * the board CANNOT ping agents (outbound-only poller), so the ONLY honest
 * liveness is the age of the executor's last poller answer. The verdict is
 * a pure function of (last_seen, state, meta thresholds, now) — thresholds
 * ALWAYS come from the executors `meta` (server-owned data, §5.1, same
 * contract as presence.ts); when meta has not loaded yet the honest answer
 * is `unknown`, never a guess. No React here — the check component and the
 * tests drive this module directly.
 *
 * The re-check affordance is deliberately a cache invalidation
 * (keys.agents.executors), NOT a "ping": there is no ping to be had.
 */

/** The closed verdict set. `unknown` = no meta yet (thresholds unloaded). */
export type LinkVerdictKind =
  | "revoked"
  | "never"
  | "online"
  | "stale"
  | "offline"
  | "unknown";

export interface LinkVerdict {
  readonly kind: LinkVerdictKind;
  /** Age of the last answer in whole seconds; null for never/revoked/unknown. */
  readonly ageS: number | null;
}

/**
 * The automaton. Order is semantic: revoked first (a revoked row's presence
 * is GONE by contract — the kill-switch forbids ticking, so its last_seen
 * age means nothing), then never-answered, then the meta TTL ladder
 * (online ≤ online_max_age_s, stale ≤ stale_max_age_s, offline beyond).
 */
export function linkVerdict(
  executor: Pick<ExecutorItem, "last_seen" | "state">,
  meta: ExecutorListMeta | undefined,
  now: number,
): LinkVerdict {
  if (executor.state === "revoked") return { kind: "revoked", ageS: null };
  if (executor.last_seen === "") return { kind: "never", ageS: null };
  if (!meta) return { kind: "unknown", ageS: null };
  const at = Date.parse(executor.last_seen);
  if (!Number.isFinite(at)) return { kind: "never", ageS: null };
  // Clock skew (stamp in the future): the honest best case is "online now".
  const ageS = now < at ? 0 : Math.floor((now - at) / 1000);
  if (ageS <= meta.presence.online_max_age_s) return { kind: "online", ageS };
  if (ageS <= meta.presence.stale_max_age_s) return { kind: "stale", ageS };
  return { kind: "offline", ageS };
}

/** Verdict copy key (the age interpolates separately via verdictAge). */
export function linkVerdictKey(kind: LinkVerdictKind): TranslationKey {
  switch (kind) {
    case "revoked":
      return "agents.linkcheck.verdict.revoked";
    case "never":
      return "agents.linkcheck.verdict.never";
    case "online":
      return "agents.linkcheck.verdict.online";
    case "stale":
      return "agents.linkcheck.verdict.stale";
    case "offline":
      return "agents.linkcheck.verdict.offline";
    default:
      return "agents.linkcheck.verdict.unknown";
  }
}

/**
 * Verdict age text: whole seconds while fresh («45 с»), then the same
 * compact mono units the strip uses (min/h/d). Seconds need their own unit
 * — formatPulseAge starts at minutes.
 */
export function linkVerdictAge(
  ageS: number,
  units: { readonly seconds: string; readonly minutes: string; readonly hours: string; readonly days: string },
): string {
  if (ageS < 60) return `${ageS} ${units.seconds}`;
  const minutes = Math.floor(ageS / 60);
  if (minutes < 60) return `${minutes} ${units.minutes}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const restMinutes = minutes % 60;
    return restMinutes > 0
      ? `${hours} ${units.hours} ${restMinutes} ${units.minutes}`
      : `${hours} ${units.hours}`;
  }
  return `${Math.floor(hours / 24)} ${units.days}`;
}
