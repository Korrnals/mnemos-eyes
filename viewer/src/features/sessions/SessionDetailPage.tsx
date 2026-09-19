import { Link, useParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatTimestamp } from "@/components/memory/memoryDisplay";
import { isApiError } from "@/lib/errors";
import { useSession } from "@/hooks/useSessions";
import { useT } from "@/i18n";

/**
 * `/sessions/:id` — full session inspection (component-inventory §9). The
 * mnemos 4.1 `SessionRead` shape carries counters + metadata only: turn
 * transcripts and linked memories are not exposed, and the page says so
 * instead of leaving empty sections.
 */
export function SessionDetailPage() {
  const t = useT();
  const { id = "" } = useParams<{ id: string }>();
  const session = useSession(id);

  if (!id) {
    return <EmptyState variant="error" title={t("sessions.noId")} />;
  }

  if (session.isPending) {
    return (
      <div
        role="status"
        aria-label={t("sessions.loadingOne")}
        className="mx-auto max-w-3xl space-y-4"
      >
        <p
          className="text-sm text-foreground-secondary"
          style={{ fontFamily: "var(--font-mono)" }}
        >
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
        <BackLink>{t("sessions.all")}</BackLink>
        {notFound ? (
          <EmptyState
            variant="not-found"
            title={t("sessions.notFound")}
            message={t("sessions.notFoundMessage", { id })}
          />
        ) : (
          <EmptyState
            variant="error"
            title={t("sessions.loadOneFailed")}
            message={session.error.message}
            action={
              <Button variant="outline" onClick={() => void session.refetch()}>
                {t("common.retry")}
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
      <BackLink>{t("sessions.all")}</BackLink>
      <header className="space-y-1">
        <h1
          className="text-xl font-semibold text-iris-bright"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {data.session_id}
        </h1>
        <p className="text-xs text-foreground-secondary">
          {data.user_id} · {t("sessions.created")}{" "}
          <time dateTime={data.created_at}>{formatTimestamp(data.created_at)}</time> ·
          {t("sessions.updated")}{" "}
          <time dateTime={data.updated_at}>{formatTimestamp(data.updated_at)}</time>
        </p>
        <div className="flex items-center gap-2 pt-1">
          <Badge variant="outline">
            {t("sessions.turns", { count: data.turns_count })}
          </Badge>
          {typeof data.ttl_expires_at === "string" ? (
            <Badge variant="iris">
              {t("sessions.ttlUntil", { time: formatTimestamp(data.ttl_expires_at) })}
            </Badge>
          ) : (
            <Badge variant="default">{t("sessions.persistent")}</Badge>
          )}
        </div>
      </header>

      <section aria-labelledby="session-metadata">
        <h2
          id="session-metadata"
          className="text-sm font-semibold text-foreground-secondary"
        >
          {t("sessions.metadata")}
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
        title={t("sessions.transcriptsHidden")}
        message={t("sessions.transcriptsHiddenMessage")}
      />
    </article>
  );
}

function BackLink({ children }: { children: React.ReactNode }) {
  return (
    <Link
      to="/system/sessions"
      className="inline-flex min-h-6 items-center gap-1 text-sm text-foreground-secondary hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
    >
      <ArrowLeft className="size-4" aria-hidden="true" /> {children}
    </Link>
  );
}
