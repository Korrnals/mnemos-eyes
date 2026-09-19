import { Link } from "react-router";
import { Badge } from "@/components/ui/badge";
import { formatTimestamp } from "@/components/memory/memoryDisplay";
import { useT } from "@/i18n";
import type { A2ASession } from "@/gateway/types";

/**
 * Compact session row (component-inventory §9): session id, participant,
 * status (TTL), turns, timestamp. The id is the link target.
 */
export interface SessionListItemProps {
  session: A2ASession;
  className?: string;
}

export function SessionListItem({ session, className }: SessionListItemProps) {
  const t = useT();
  const ttlLive = typeof session.ttl_expires_at === "string";
  return (
    <li className={className}>
      <Link
        to={`/system/sessions/${session.session_id}`}
        className="block rounded-md border border-border-subtle bg-well p-5 shadow-well transition-colors duration-instant hover:bg-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
      >
        <div className="flex items-start justify-between gap-3">
          <span
            className="text-sm font-medium text-iris-bright"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {session.session_id}
          </span>
          <Badge variant={ttlLive ? "iris" : "outline"}>
            {ttlLive ? "ttl" : t("sessions.persistent")}
          </Badge>
        </div>
        <p className="mt-2 text-xs text-foreground-secondary">
          {session.user_id} · {t("sessions.turns", { count: session.turns_count })} ·{" "}
          <time dateTime={session.created_at}>
            {formatTimestamp(session.created_at)}
          </time>
        </p>
      </Link>
    </li>
  );
}
