import { EmptyState } from "@/components/EmptyState/EmptyState";
import { SessionListItem } from "@/components/SessionListItem/SessionListItem";
import { TableRowSkeleton } from "@/components/skeletons/Skeletons";
import { Button } from "@/components/ui/button";
import { isApiError } from "@/lib/errors";
import { useSessions } from "@/hooks/useSessions";
import { useAuth } from "@/features/auth/AuthContext";
import { useT } from "@/i18n";

/**
 * `/sessions` — A2A session list (component-inventory §9). Honesty note: the
 * 501 "unavailable" state is adapter-aware — mnemos 4.1 has no list endpoint,
 * and the board merge-API (the production default) declares the whole
 * mnemos-side view unsupported. Both render the explicit empty state below
 * instead of pretending or looking like a failure.
 */
export function SessionsPage() {
  const t = useT();
  const { adapterMode } = useAuth();
  const sessions = useSessions();

  return (
    <section aria-labelledby="sessions-title" className="mx-auto max-w-3xl space-y-4">
      <h1 id="sessions-title" className="text-xl font-semibold">
        {t("sessions.title")}
      </h1>

      {sessions.isPending ? (
        <div role="status" aria-label={t("sessions.loading")}>
          <TableRowSkeleton rows={4} columns={3} />
        </div>
      ) : sessions.isError ? (
        isApiError(sessions.error) && sessions.error.status === 501 ? (
          <EmptyState
            variant="empty"
            title={t(
              adapterMode === "board"
                ? "sessions.unavailableBoard"
                : "sessions.unavailableMnemos",
            )}
            message={
              adapterMode === "board"
                ? t("sessions.unavailableBoardMessage")
                : t("sessions.unavailableMnemosMessage")
            }
            detail={sessions.error.message}
          />
        ) : (
          <EmptyState
            variant="error"
            title={t("sessions.loadFailed")}
            message={sessions.error.message}
            action={
              <Button variant="outline" onClick={() => void sessions.refetch()}>
                {t("common.retry")}
              </Button>
            }
          />
        )
      ) : sessions.data.length === 0 ? (
        <EmptyState
          variant="empty"
          title={t("sessions.empty")}
          message={t("sessions.emptyMessage")}
        />
      ) : (
        <ul className="space-y-3">
          {sessions.data.map((session) => (
            <SessionListItem key={session.session_id} session={session} />
          ))}
        </ul>
      )}
    </section>
  );
}
