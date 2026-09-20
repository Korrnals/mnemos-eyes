import { useT } from "@/i18n";
import { saveBoardStyle, type BoardStyle } from "./tasksViewPrefs";

/**
 * «Группы | Классика» — the kanban board style switcher (CV-5, owner
 * feedback 1.10.2): a segmented control of two stateful buttons sitting
 * next to the «Канбан | Список» projection toggle. Switching is pure state
 * + a localStorage write under "vesmaro.boardStyle" — no navigation, the
 * route and the URL filters stay untouched (both styles speak the SAME
 * board: columns, DnD, filters, counters). Rendered on the kanban page
 * only — the list projection has no board styles.
 *
 * Buttons (not links) with aria-pressed: the control changes an in-page
 * rendering mode, it does not move the user anywhere.
 */
export function BoardStyleToggle({
  style,
  onChange,
}: {
  style: BoardStyle;
  onChange: (style: BoardStyle) => void;
}) {
  const t = useT();

  const option = (value: BoardStyle, extra = "") => ({
    type: "button" as const,
    "aria-pressed": style === value,
    onClick: () => {
      if (value === style) return;
      onChange(value);
      saveBoardStyle(value);
    },
    className:
      "px-3 py-1.5 text-sm transition-colors duration-instant focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright " +
      extra +
      (style === value
        ? "bg-iris/15 text-iris-bright"
        : "text-foreground-secondary hover:text-foreground"),
  });

  return (
    <div
      role="group"
      aria-label={t("tasks.board.styleLabel")}
      className="inline-flex overflow-hidden rounded-md border border-border"
    >
      <button {...option("groups")}>{t("tasks.board.styleGroups")}</button>
      <button {...option("classic", "border-l border-border ")}>
        {t("tasks.board.styleClassic")}
      </button>
    </div>
  );
}
