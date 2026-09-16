import { EmptyState } from "@/components/EmptyState/EmptyState";
import { SessionListItem } from "@/components/SessionListItem/SessionListItem";
import { TableRowSkeleton } from "@/components/skeletons/Skeletons";
import { Button } from "@/components/ui/button";
import { isApiError } from "@/lib/errors";
import { useSessions } from "@/hooks/useSessions";

/**
 * `/sessions` — A2A session list (component-inventory §9). Honesty note: on
 * mnemos 4.1 there is no `GET /v1/sessions` list endpoint — HttpAdapter fails
 * with 501 by design, so in http mode this page shows the explicit
 * "unavailable" state below instead of pretending.
 */
export function SessionsPage() {
  const sessions = useSessions();

  return (
    <section aria-labelledby="sessions-title" className="mx-auto max-w-3xl space-y-4">
      <h1 id="sessions-title" className="text-xl font-semibold">
        A2A sessions
      </h1>

      {sessions.isPending ? (
        <div role="status" aria-label="Loading sessions">
          <TableRowSkeleton rows={4} columns={3} />
        </div>
      ) : sessions.isError ? (
        isApiError(sessions.error) && sessions.error.status === 501 ? (
          <EmptyState
            variant="empty"
            title="Session list is unavailable in mnemos 4.1"
            message="mnemos exposes no session-list endpoint — only POST /v1/sessions (create) and GET /v1/sessions/{id}. Open a session by id once you know it."
            detail={sessions.error.message}
          />
        ) : (
          <EmptyState
            variant="error"
            title="Could not load sessions"
            message={sessions.error.message}
            action={
              <Button variant="outline" onClick={() => void sessions.refetch()}>
                Retry
              </Button>
            }
          />
        )
      ) : sessions.data.length === 0 ? (
        <EmptyState
          variant="empty"
          title="No A2A sessions yet"
          message="Sessions appear once agents talk through mnemos."
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
