import { useT } from "@/i18n";
import { EmptyState } from "@/components/EmptyState/EmptyState";

/** Honest mnemos-mode state: the task domain is a board-native view (Ф2). */
export function TasksUnsupported() {
  const t = useT();
  return (
    <section aria-labelledby="tasks-title" className="mx-auto max-w-5xl space-y-4">
      <h1 id="tasks-title" className="text-xl font-semibold">
        {t("tasks.title")}
      </h1>
      <EmptyState
        variant="empty"
        title={t("tasks.unavailableTitle")}
        message={t("tasks.unavailableMessage")}
      />
    </section>
  );
}
