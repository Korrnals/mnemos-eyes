import { useEffect, useState } from "react";
import { useT } from "@/i18n";
import type { AssignmentItem, ExecutorItem, ExecutorListMeta } from "@/gateway/boardTypes";
import {
  PRESENCE_DOT,
  PRESENCE_TEXT,
  formatPulseAge,
  lastSeenAgeS,
  presenceFromLastSeen,
  presenceLabelKey,
} from "./presence";
import { useValidationNow } from "@/features/tasks/useValidationClock";
import { ACTIVE_ASSIGNMENT_STATES } from "./assignmentStatus";
import { ExecutorMenu } from "./ExecutorMenu";

/**
 * Presence strip (spec §1.1 layer 1 — the ONLY bold element of the section,
 * the seed of the north-star «living office»): one chip per executor —
 * presence dot computed STRICTLY from the server meta TTLs (never
 * hardcoded), mono pulse age off the shared 1 Hz ticker, transport marker,
 * live-work counter, click = list filter (click again clears). The avatar
 * slot stays EMPTY (§4.4 — geometry reserved, no decorative blobs).
 * Presence and assignment life never collapse (§2.1 two-clock rule): an
 * offline chip may well sit above a running row.
 *
 * UNKNOWN ≠ offline (AGW-3 review P3-1): without the meta contract the
 * presence is null — the chip renders NEUTRAL (hollow dot, «присутствие
 * неизвестно»), never a guessed state. The dot/text maps live in presence.ts
 * (AGW-4: the registry rows render the same language).
 *
 * Entrance timing (§3.2 «entrance полосы ≤3 чипов, 200ms», AGW-3 review
 * P3-9 reading): 200 ms PER CHIP (fade duration), staggered 0/70/140 ms —
 * three chips complete inside ~340 ms wall-clock (delay + duration);
 * reduced motion users get no transition at all (motion-safe).
 */

export function ExecutorStrip({
  executors,
  meta,
  assignments,
  selectedId,
  onSelect,
  loading = false,
  error = false,
}: {
  executors: readonly ExecutorItem[];
  meta: ExecutorListMeta | undefined;
  /** Active assignments feed the per-executor work counters. */
  assignments: readonly AssignmentItem[];
  selectedId: string | null;
  onSelect: (executorId: string | null) => void;
  /** Registry loading — a skeleton, NOT the poller empty state. */
  loading?: boolean;
  /** Registry failed — an error line, NOT the poller empty state. */
  error?: boolean;
}) {
  const t = useT();
  const now = useValidationNow();
  // Entrance stagger (see the docblock timing note).
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setEntered(true), 0);
    return () => clearTimeout(timer);
  }, []);

  if (loading) {
    // Static placeholders — NO ambient pulse (§3.2 Motion forbids ambient
    // animation; skeletons here are geometry, not motion).
    return (
      <div
        role="status"
        aria-label={t("agents.strip.label")}
        className="flex min-h-16 items-center gap-1.5 rounded-md border border-border-subtle px-3"
      >
        <span className="h-8 w-40 rounded-md bg-elevated/60" />
        <span className="h-8 w-40 rounded-md bg-elevated/60" />
        <span className="h-8 w-40 rounded-md bg-elevated/60" />
      </div>
    );
  }
  if (error) {
    return (
      <p role="alert" className="min-h-16 py-3 text-sm text-error">
        {t("agents.strip.error")}
      </p>
    );
  }
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
      {executors.map((executor, index) => (
        <StripChip
          key={executor.id}
          executor={executor}
          assignments={assignments}
          meta={meta}
          now={now}
          entered={entered}
          index={index}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

/**
 * One strip chip (AGW-5 phase 2): the EXISTING presence chip (filter on
 * click) + the executor context menu — right-click on the chip opens it at
 * the pointer, the hover-revealed ⋯ is the tab-reachable path
 * (TaskRowMenu posture; the pointer menu never blocks the keyboard one).
 * The chip's own title-tooltip (capabilities/transport/last seen) stays.
 */
function StripChip({
  executor,
  assignments,
  meta,
  now,
  entered,
  index,
  selectedId,
  onSelect,
}: {
  executor: ExecutorItem;
  assignments: readonly AssignmentItem[];
  meta: ExecutorListMeta | undefined;
  now: number;
  entered: boolean;
  index: number;
  selectedId: string | null;
  onSelect: (executorId: string | null) => void;
}) {
  const t = useT();
  const [menu, setMenu] = useState<{
    open: boolean;
    position: { x: number; y: number } | null;
  }>({ open: false, position: null });
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
  const presence = presenceFromLastSeen(executor.last_seen, meta, now);
  const ageS = lastSeenAgeS(executor.last_seen, now);
  const pulseAge =
    ageS !== null && presence !== null
      ? formatPulseAge(ageS, {
          minutes: t("agents.age.unitMinutes"),
          hours: t("agents.age.unitHours"),
          days: t("agents.age.unitDays"),
        })
      : "";
  const presenceKey = presence ?? "unknown";
  const capabilities =
    executor.capabilities.length > 0
      ? executor.capabilities.join(", ")
      : t("agents.executor.noCapabilities");
  void index; // entrance stagger lives below (kept literal for tests)

  return (
    <li>
      <div className="group/chip relative flex items-stretch gap-0.5">
        <button
          type="button"
          aria-pressed={selected}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ open: true, position: { x: event.clientX, y: event.clientY } });
          }}
          onClick={() => onSelect(selected ? null : executor.id)}
          title={[
            executor.name,
            executor.harness,
            capabilities,
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
              {/* Presence dot: colour + shape (hollow offline/unknown);
               * the label below is the SR text (WCAG 1.4.1). */}
              <span
                aria-hidden="true"
                className={
                  "size-2 shrink-0 rounded-full " +
                  (PRESENCE_DOT[presenceKey] ?? PRESENCE_DOT.unknown)
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
                (PRESENCE_TEXT[presenceKey] ?? PRESENCE_TEXT.unknown)
              }
            >
              <span className="sr-only">
                {t(presenceLabelKey(presenceKey))}
                {pulseAge ? ` · ${pulseAge}` : ""}
              </span>
              <span aria-hidden="true">{pulseAge}</span>
            </span>
          </span>
        </button>
        <span className="flex items-center">
          <ExecutorMenu
            executor={executor}
            revealOnParentHover
            showOpenRegistry
            open={menu.open}
            position={menu.position}
            onOpenChange={(open, position) => setMenu({ open, position })}
          />
        </span>
      </div>
    </li>
  );
}
