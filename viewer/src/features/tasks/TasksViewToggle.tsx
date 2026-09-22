import { Link, useLocation } from "react-router";
import { useT } from "@/i18n";

/**
 * «Канбан | Список» — the Задачи-domain view switcher (Ф3, verdict §3:
 * kanban is view №1, the dense list stays for mass management). A segmented
 * control of two LINKS — pure navigation (search params carry over — both
 * views speak the same ?project=&agent=&q= URL dialect). Owner feedback
 * 2026-09-22: the route is the contract — «Канбан» shows the kanban, «Список»
 * the list; no persisted preference may override an explicit navigation, so
 * the old vesmaro.tasksView write is gone.
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
