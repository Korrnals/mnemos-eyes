import { useState } from "react";
import { Activity } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import type { ExecutorItem } from "@/gateway/boardTypes";
import { useT } from "@/i18n";
import { keys } from "@/lib/queryKeys";
import { useValidationNow } from "@/features/tasks/useValidationClock";
import { useExecutors } from "./useAgents";
import {
  linkVerdict,
  linkVerdictAge,
  linkVerdictKey,
} from "./linkCheck";
import { ExecutorTestTaskDialog } from "./ExecutorTestTaskDialog";

/**
 * The reusable link-check verdict (AGW-6 A): a «Проверить связь» trigger +
 * the age automaton + the permanent outbound-only disclaimer. Two mounting
 * surfaces —
 * - MENU (`variant="menu-item"`): the trigger renders as a role=menuitem
 *   button that does NOT close the popup; the verdict appears below it,
 *   width-constrained to the popup;
 * - CARD (`variant="card"`, `autoCheck`): a normal button; the verdict is
 *   already shown on mount (the card IS the check surface) and the trigger
 *   re-checks.
 *
 * ARCHITECTURAL HONESTY (ADR 0009 §9): the trigger is a cache
 * INVALIDATION (executors react-query family refetch), never a "ping" —
 * the board cannot ping agents, the poller is outbound-only. The verdict
 * is the age of the executor's last poller answer against the SERVER's
 * meta thresholds (never hardcoded), re-rendered by the shared 1 Hz
 * ticker; revoked rows show the goned-presence verdict with no trigger
 * (the poller refuses revoked tokens — there is nothing to check).
 */
export function ExecutorLinkCheck({
  executor,
  variant,
  autoCheck = false,
}: {
  executor: ExecutorItem;
  /** menu-item: trigger is a non-closing menu entry, verdict inside the popup. */
  variant: "menu-item" | "card";
  /** Card mode: show the verdict on mount (the trigger only re-checks). */
  autoCheck?: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const now = useValidationNow();
  const meta = useExecutors().data?.meta;
  // autoCheck seeds the shown-verdict state at mount (the card IS the
  // check surface); a re-check afterwards is always EXPLICIT (the
  // trigger), never a timer pretending to be one.
  const [checked, setChecked] = useState(autoCheck);
  const [testOpen, setTestOpen] = useState(false);
  const verdict = linkVerdict(executor, meta, now);

  const check = (): void => {
    // The honest "check": refetch the registry, then let the automaton
    // speak from the fresh last_seen + the live ticker.
    void queryClient.invalidateQueries({ queryKey: keys.agents.executors.all });
    setChecked(true);
  };

  const revoked = executor.state === "revoked";
  const showVerdict = checked || revoked;
  const ageText =
    verdict.ageS !== null
      ? linkVerdictAge(verdict.ageS, {
          seconds: t("agents.linkcheck.unitSeconds"),
          minutes: t("agents.age.unitMinutes"),
          hours: t("agents.age.unitHours"),
          days: t("agents.age.unitDays"),
        })
      : null;

  return (
    <>
      {!revoked ? (
        variant === "menu-item" ? (
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground transition-colors duration-instant hover:bg-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
            onClick={(event) => {
              event.stopPropagation();
              check();
            }}
          >
            <Activity className="size-3.5" aria-hidden="true" />
            <span className="flex-1">{t("agents.linkcheck.trigger")}</span>
          </button>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={check}>
            <Activity className="size-3.5" aria-hidden="true" />
            {t("agents.linkcheck.trigger")}
          </Button>
        )
      ) : null}

      {showVerdict ? (
        <div
          data-testid={`link-verdict-${executor.id}`}
          className={
            variant === "menu-item"
              ? "max-w-60 rounded-sm bg-elevated p-2"
              : "rounded-md border border-border-subtle bg-elevated p-3"
          }
        >
          {/* The verdict, in words (WCAG 1.4.1) + live age (1 Hz ticker;
           * deliberately NOT a live region — a per-second announcement
           * would be SR noise, the verdict is read on demand). */}
          <p className="text-sm text-foreground">
            {t(linkVerdictKey(verdict.kind), ageText !== null ? { age: ageText } : undefined)}
          </p>
          {/* The permanent honesty clause — under EVERY verdict. */}
          <p className="mt-1 text-xs text-foreground-muted">
            {t("agents.linkcheck.disclaimer")}
          </p>
          {/* Second stage — the real probe is a real assignment (A.3). */}
          {!revoked ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-1 h-7 px-2 text-xs"
              onClick={() => setTestOpen(true)}
            >
              {t("agents.linkcheck.checkForReal")}
            </Button>
          ) : null}
        </div>
      ) : null}

      <ExecutorTestTaskDialog
        executor={executor}
        open={testOpen}
        onOpenChange={setTestOpen}
      />
    </>
  );
}
