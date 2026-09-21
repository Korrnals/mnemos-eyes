import { useEffect, useState } from "react";
import { useT } from "@/i18n";
import type { AssignmentItem, ExecutorItem, ExecutorListMeta } from "@/gateway/boardTypes";
import { formatPulseAge, lastSeenAgeS, presenceFromLastSeen } from "./presence";
import { useValidationNow } from "@/features/tasks/useValidationClock";
import { ACTIVE_ASSIGNMENT_STATES } from "./assignmentStatus";

/**
 * Presence strip (spec §1.1 layer 1 — the ONLY bold element of the section,
 * the seed of the north-star «living office»): one chip per executor —
 * presence dot computed STRICTLY from the server meta TTLs (never
 * hardcoded), mono pulse age off the shared 1 Hz ticker, transport marker,
 * live-work counter, click = list filter (click again clears). The avatar
 * slot stays EMPTY (§4.4 — geometry reserved, no decorative blobs).
 * Presence and assignment life never collapse (§2.1 two-clock rule): an
 * offline chip may well sit above a running row.
 */

/** Semantic aliases only (§3.2 — no new colours): iris / warning / muted. */
const PRESENCE_DOT: Record<string, string> = {
  online: "bg-iris-bright",
  stale: "bg-warning",
  // Offline is a HOLLOW dot — shape carries the meaning with the colour.
  offline: "border border-border bg-transparent",
};

const PRESENCE_TEXT: Record<string, string> = {
  online: "text-foreground-secondary",
  stale: "text-foreground-secondary",
  offline: "text-foreground-muted",
};

export function ExecutorStrip({
  executors,
  meta,
  assignments,
  selectedId,
  onSelect,
}: {
  executors: readonly ExecutorItem[];
  meta: ExecutorListMeta | undefined;
  /** Active assignments feed the per-executor work counters. */
  assignments: readonly AssignmentItem[];
  selectedId: string | null;
  onSelect: (executorId: string | null) => void;
}) {
  const t = useT();
  const now = useValidationNow();
  // Entrance ≤3 chips staggered inside 200 ms (§3.2 Motion); reduced-motion
  // users see the strip appear with no transition (motion-safe gate).
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setEntered(true), 0);
    return () => clearTimeout(timer);
  }, []);

  if (executors.length === 0) {
    return (
      <div
        className="flex min-h-16 items-center gap-3 rounded-md border border-dashed border-border-subtle px-3 text-sm"
        aria-label={t("agents.strip.label")}
      >
        <span className="text-foreground-secondary">{t("agents.strip.empty")}</span>
        <span className="text-xs text-foreground-muted">
          {t("agents.strip.emptyHint")}
        </span>
      </div>
    );
  }

  return (
    <ul
      aria-label={t("agents.strip.label")}
      className="flex min-h-16 flex-wrap items-stretch gap-1.5"
    >
      {executors.map((executor, index) => {
        // TTL contract from meta — the ONLY threshold source (§5.1).
        const presence = presenceFromLastSeen(executor.last_seen, meta, now);
        const ageS = lastSeenAgeS(executor.last_seen, now);
        const selected = selectedId === executor.id;
        const activeWork = assignments.filter(
          (row) =>
            ACTIVE_ASSIGNMENT_STATES.includes(row.state) &&
            row.claimed_by_executor === executor.id,
        ).length;
        const transport =
          executor.transport === "mesh-r4"
            ? t("agents.strip.transportMesh")
            : t("agents.strip.transportLocal");
        const pulseAge =
          ageS !== null
            ? formatPulseAge(ageS, {
                minutes: t("agents.age.unitMinutes"),
                hours: t("agents.age.unitHours"),
                days: t("agents.age.unitDays"),
              })
            : "";
        return (
          <li key={executor.id}>
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(selected ? null : executor.id)}
              title={[
                executor.name,
                executor.harness,
                transport,
                `${t("agents.strip.lastSeen")}: ${pulseAge || t("agents.executor.neverSeen")}`,
                t("agents.identity.tooltip"),
              ].join(" · ")}
              className={
                "flex h-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm transition-colors duration-instant focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright " +
                (selected
                  ? "border-iris-bright/60 bg-iris/10 "
                  : "border-border-subtle bg-well hover:border-iris-bright/40 ") +
                // Entrance stagger: chips 0/70/140 ms, 200 ms each (≤3×200).
                ("motion-safe:transition-[opacity,border-color] motion-safe:duration-200 " +
                  (entered ? "opacity-100" : "opacity-0"))
              }
              style={{ transitionDelay: `${Math.min(index, 2) * 70}ms` }}
            >
              {/* Reserved avatar slot (§4.4): empty geometry, no blobs. */}
              <span aria-hidden="true" className="size-6 shrink-0 rounded-full border border-dashed border-border-subtle" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-1.5">
                  {/* Presence dot: colour + shape (hollow offline); the label
                   * below is the SR text (WCAG 1.4.1). */}
                  <span
                    aria-hidden="true"
                    className={
                      "size-2 shrink-0 rounded-full " +
                      (PRESENCE_DOT[presence ?? "offline"] ?? PRESENCE_DOT.offline)
                    }
                  />
                  <span className="max-w-40 truncate font-medium">{executor.name}</span>
                  <span className="font-mono text-xs text-foreground-muted">{transport}</span>
                  {activeWork > 0 ? (
                    <span className="rounded-sm bg-elevated px-1 font-mono text-xs">
                      {activeWork}
                    </span>
                  ) : null}
                </span>
                <span
                  className={
                    "font-mono text-xs " +
                    (PRESENCE_TEXT[presence ?? "offline"] ?? PRESENCE_TEXT.offline)
                  }
                >
                  <span className="sr-only">
                    {presence === "online"
                      ? t("agents.presence.online")
                      : presence === "stale"
                        ? t("agents.presence.stale")
                        : t("agents.presence.offline")}
                    {pulseAge ? ` · ${pulseAge}` : ""}
                  </span>
                  <span aria-hidden="true">{pulseAge}</span>
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
