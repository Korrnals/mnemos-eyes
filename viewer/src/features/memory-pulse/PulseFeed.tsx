import { Link } from "react-router";
import { TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TagBadge } from "@/components/TagBadge/TagBadge";
import { TextEngine } from "@/components/TextEngine";
import { formatTimestamp } from "@/components/memory/memoryDisplay";
import { statusBadgeVariant, statusLabelKey } from "@/components/memory/memoryBadges";
import type { MemoryPulseItem, MemoryPulseServerNote } from "@/gateway/boardTypes";
import { useT } from "@/i18n";
import { withReturn } from "@/lib/returnParams";
import { cn } from "@/lib/utils";

/**
 * Pulse feed rows (redesign concept §4.2 "Live-лента"): recency order, the
 * store badge first (provenance — a merge-feed row is meaningless without
 * its origin), status + tags inline, timestamp right. Airy by design
 * (§3.3): rows consume --row-h-airy and never shrink with the density
 * toggle — the pulse is a contemplative surface.
 *
 * When the server carries a content fragment, it renders under the title
 * through TextEngine (UI-27) — untrusted author text, never a raw
 * interpolation; absent fragment = honest absence (no placeholder). A row
 * with a fragment is a two-block row, so it top-aligns (badge/status/time
 * hang from the title line); fragment-less rows keep the centered single
 * line. Both keep the airy min height.
 */
export interface PulseFeedProps {
  items: readonly MemoryPulseItem[];
  perServer?: readonly MemoryPulseServerNote[];
  /** Compact cut for the Overview block (no tags, fewer hints). */
  compact?: boolean;
  className?: string;
  /**
   * UI-18 pair 10: source list location (pathname + search) for the
   * `return=` param on row links. Absent (the Overview block) — canonical
   * bare `/memory/:id` links, unchanged (spec §2.2 rule 6).
   */
  returnSource?: { pathname: string; search: string };
}

export function PulseFeed({
  items,
  perServer,
  compact = false,
  className,
  returnSource,
}: PulseFeedProps) {
  const t = useT();
  const degraded = (perServer ?? []).filter((note) => !note.ok);
  return (
    <div className={cn("space-y-2", className)}>
      {degraded.length > 0 ? (
        <p
          className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-xs text-foreground-secondary"
          role="status"
        >
          <TriangleAlert
            className="mt-0.5 size-3.5 shrink-0 text-warning"
            aria-hidden="true"
          />
          {t("pulse.degradedStores", {
            servers: degraded.map((note) => note.server).join(", "),
          })}
        </p>
      ) : null}
      <ul className="list-none space-y-list-gap" aria-label={t("pulse.feedLabel")}>
        {items.map((item, index) => {
          // A fragment turns the row into a title+body block: top-align the
          // chrome so the provenance badge hangs from the title line.
          const hasContent = typeof item.content === "string" && item.content.length > 0;
          return (
            <li
              key={`${item.server}:${item.id}:${index}`}
              className={cn(
                "flex min-h-row-airy gap-3 rounded-md border border-border-subtle bg-well px-4 py-2 shadow-well",
                hasContent ? "items-start" : "items-center",
              )}
            >
              {/* Provenance badge — mono, first class citizen (ADR 0004 D4). */}
              <Badge variant="outline" className="shrink-0 font-mono text-xs">
                {item.server}
              </Badge>
              <div className="min-w-0 flex-1">
                <Link
                  to={
                    returnSource
                      ? withReturn(
                          `/memory/${encodeURIComponent(item.id)}`,
                          returnSource.pathname,
                          returnSource.search,
                        )
                      : `/memory/${encodeURIComponent(item.id)}`
                  }
                  className="inline-flex min-h-6 items-center font-scroll text-sm font-semibold leading-snug hover:text-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
                >
                  {item.title || t("pulse.untitled")}
                </Link>
                {hasContent ? (
                  // UI-27: fragment renders through the TextEngine primitive
                  // (plain passthrough or lazy markdown chunk); `clamp` adds
                  // «показать полностью» only on real measured overflow.
                  <TextEngine
                    text={item.content}
                    variant="compact"
                    clamp
                    className="mt-1 font-scroll text-sm leading-relaxed text-foreground-secondary"
                  />
                ) : null}
                {!compact && item.tags.length > 0 ? (
                  <p className="mt-1 flex flex-wrap gap-1.5">
                    {item.tags.slice(0, 4).map((tag) => (
                      <TagBadge key={tag} tag={tag} />
                    ))}
                  </p>
                ) : null}
              </div>
              <Badge variant={statusBadgeVariant(item.status)} className="shrink-0">
                {t(statusLabelKey(item.status))}
              </Badge>
              <time
                dateTime={item.created_at || undefined}
                className="shrink-0 text-xs text-foreground-secondary"
              >
                {formatTimestamp(item.created_at || undefined)}
              </time>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Loading skeleton for the pulse surfaces (same airy row rhythm). */
export function PulseSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-list-gap" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex min-h-row-airy items-center gap-3 rounded-md border border-border-subtle bg-well px-4 py-2"
        >
          <Skeleton className="h-5 w-20 shrink-0" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-5 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}
