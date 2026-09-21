import { useT } from "@/i18n";
import { EmptyState } from "@/components/EmptyState/EmptyState";

/** Honest mnemos-mode state: the agents domain is board-native (AGW-1). */
export function AgentsUnsupported() {
  const t = useT();
  return (
    <section aria-labelledby="agents-execution-title" className="mx-auto max-w-5xl space-y-4">
      <h1 id="agents-execution-title" className="text-xl font-semibold">
        {t("agents.execution.title")}
      </h1>
      <EmptyState
        variant="empty"
        title={t("agents.unavailableTitle")}
        message={t("agents.unavailableMessage")}
      />
    </section>
  );
}
