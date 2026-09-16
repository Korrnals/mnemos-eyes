import { Link, useParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatTimestamp } from "@/components/memory/memoryDisplay";
import { isApiError } from "@/lib/errors";
import { useSession } from "@/hooks/useSessions";

/**
 * `/sessions/:id` — full session inspection (component-inventory §9). The
 * mnemos 4.1 `SessionRead` shape carries counters + metadata only: turn
 * transcripts and linked memories are not exposed, and the page says so
 * instead of leaving empty sections.
 */
export function SessionDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const session = useSession(id);

  if (!id) {
    return <EmptyState variant="error" title="No session id in route" />;
  }

  if (session.isPending) {
    return (
      <div role="status" aria-label="Loading session" className="mx-auto max-w-3xl space-y-4">
        <p className="text-sm text-foreground-secondary" style={{ fontFamily: "var(--font-mono)" }}>
          {id}
        </p>
        <div className="h-40 animate-pulse rounded-md bg-elevated" />
      </div>
    );
  }

  if (session.isError) {
    const notFound = isApiError(session.error) && session.error.status === 404;
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <BackLink />
        {notFound ? (
          <EmptyState
            variant="not-found"
            title="No such session"
            message={`mnemos holds no session with id “${id}”.`}
          />
        ) : (
          <EmptyState
            variant="error"
            title="Could not load the session"
            message={session.error.message}
            action={
              <Button variant="outline" onClick={() => void session.refetch()}>
                Retry
              </Button>
            }
          />
        )}
      </div>
    );
  }

  const data = session.data;
  const metadata = data.metadata ?? {};

  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <BackLink />
      <header className="space-y-1">
        <h1
          className="text-xl font-semibold text-iris-bright"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {data.session_id}
        </h1>
        <p className="text-xs text-foreground-secondary">
          {data.user_id} · created{" "}
          <time dateTime={data.created_at}>{formatTimestamp(data.created_at)}</time> ·
          updated <time dateTime={data.updated_at}>{formatTimestamp(data.updated_at)}</time>
        </p>
        <div className="flex items-center gap-2 pt-1">
          <Badge variant="outline">{data.turns_count} turns</Badge>
          {typeof data.ttl_expires_at === "string" ? (
            <Badge variant="iris">ttl until {formatTimestamp(data.ttl_expires_at)}</Badge>
          ) : (
            <Badge variant="default">persistent</Badge>
          )}
        </div>
      </header>

      <section aria-labelledby="session-metadata">
        <h2 id="session-metadata" className="text-sm font-semibold text-foreground-secondary">
          Metadata
        </h2>
        <pre
          className="mt-2 overflow-x-auto rounded-md border border-border-subtle bg-well p-4 text-xs text-foreground"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {JSON.stringify(metadata, null, 2)}
        </pre>
      </section>

      <EmptyState
        variant="empty"
        title="Turn transcripts are not exposed"
        message="mnemos 4.1 returns session counters and metadata only — individual turns and linked memories have no read endpoint. The turn count above is the honest total."
      />
    </article>
  );
}

function BackLink() {
  return (
    <Link
      to="/sessions"
      className="inline-flex items-center gap-1 text-sm text-foreground-secondary hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
    >
      <ArrowLeft className="size-4" aria-hidden="true" /> All sessions
    </Link>
  );
}
