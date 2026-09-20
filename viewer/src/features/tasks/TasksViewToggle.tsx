import { Link, useLocation } from "react-router";
import { useT } from "@/i18n";
import { saveTaskView } from "./tasksViewPrefs";

/**
 * «Канбан | Список» — the Задачи-domain view switcher (Ф3, verdict §3:
 * kanban is view №1, the dense list stays for mass management). A segmented
 * control of two links: switching navigates (search params carry over —
 * both views speak the same ?project=&agent=&q= URL dialect) and persists
 * the choice under "vesmaro.tasksView" so the /tasks index route lands the
 * owner in their preferred projection next time.
 */
export function TasksViewToggle() {
  const t = useT();
  const { pathname, search } = useLocation();
  const onList = pathname.startsWith("/tasks/list");

  const target = (view: "kanban" | "list") => ({
    pathname: view === "list" ? "/tasks/list" : "/tasks",
    search,
  });

  return (
    <nav
      aria-label={t("tasks.view.toggleLabel")}
      className="inline-flex overflow-hidden rounded-md border border-border"
    >
      <Link
        to={target("kanban")}
        onClick={() => saveTaskView("kanban")}
        aria-current={onList ? undefined : "page"}
        className={
          "px-3 py-1.5 text-sm transition-colors duration-instant focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright " +
          (onList
            ? "text-foreground-secondary hover:text-foreground"
            : "bg-iris/15 text-iris-bright")
        }
      >
        {t("tasks.view.kanban")}
      </Link>
      <Link
        to={target("list")}
        onClick={() => saveTaskView("list")}
        aria-current={onList ? "page" : undefined}
        className={
          "border-l border-border px-3 py-1.5 text-sm transition-colors duration-instant focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright " +
          (onList
            ? "bg-iris/15 text-iris-bright"
            : "text-foreground-secondary hover:text-foreground")
        }
      >
        {t("tasks.view.list")}
      </Link>
    </nav>
  );
}
