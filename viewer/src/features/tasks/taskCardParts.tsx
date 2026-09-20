import { useT } from "@/i18n";
import {
  isValidationOverdue,
  validationElapsed,
} from "./taskStatus";
import { useValidationNow } from "./useValidationClock";

/**
 * Shared primitives of the board card (CV-5): the dense (grouped) and the
 * classic card SKINS of TaskBoardCard render the SAME validation clock and
 * title highlight — one implementation, no visual drift between the styles.
 */

/**
 * The WF-1 validation clock line: «в валидации Xч Yм». Reads the SHARED 1 Hz
 * ticker (useValidationClock) — no per-card interval; renders nothing while
 * the ticker is inactive (SSR) or the stamp is absent/unparsable. The caller
 * passes the skin's top margin through `className`; the element itself is the
 * line (a `p`), not a wrapper — one node in both card skins.
 */
export function ValidatingClock({
  since,
  className = "",
}: {
  since: string | null | undefined;
  /** Skin spacing (e.g. the classic/dense top margin), prepended verbatim. */
  className?: string;
}) {
  const t = useT();
  const now = useValidationNow();
  if (now === 0) return null;
  const elapsed = validationElapsed(since, now);
  if (!elapsed) return null;
  const overdue = isValidationOverdue(since, now);
  return (
    <p
      className={
        className +
        "font-mono text-xs " +
        (overdue ? "text-error" : "text-foreground-muted")
      }
      title={overdue ? t("tasks.board.validatingOverdueTitle") : undefined}
    >
      {t("tasks.board.validatingFor", {
        hours: elapsed.hours,
        minutes: elapsed.minutes,
      })}
    </p>
  );
}

/** Title with the active `q` match highlighted (`<mark>`, semantic boost). */
export function HighlightedTitle({ title, query }: { title: string; query: string }) {
  const needle = query.trim();
  if (needle.length === 0) return <>{title}</>;
  const index = title.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return <>{title}</>;
  return (
    <>
      {title.slice(0, index)}
      <mark className="rounded-sm bg-iris/20 px-0.5 text-foreground">
        {title.slice(index, index + needle.length)}
      </mark>
      {title.slice(index + needle.length)}
    </>
  );
}
