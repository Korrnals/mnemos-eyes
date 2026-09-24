import { Link } from "react-router";
import { TagBadge } from "@/components/TagBadge/TagBadge";
import { TextEngine } from "@/components/TextEngine";
import {
  formatConfidence,
  formatTimestamp,
  memoryEffectiveContent,
  memoryTitle,
} from "@/components/memory/memoryDisplay";
import { statusBadgeVariant, statusLabelKey } from "@/components/memory/memoryBadges";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useT } from "@/i18n";
import { withReturn } from "@/lib/returnParams";
import type { Memory } from "@/gateway/types";

/**
 * List-view representation of one memory (component-inventory §4): auto-title,
 * 120-char snippet of the effective content, tags, confidence dot, timestamp.
 * The title is the link target (single accessible name per card).
 *
 * UI-18: `returnSource` (optional) makes the title link carry
 * `?return=<source>` so the detail page's back control leads back into the
 * exact list/drill the click came from. Absent (default) — the canonical
 * bare `/memory/:id` link, unchanged (spec §2.2 rule 6).
 */
export interface MemoryCardProps {
  memory: Memory;
  className?: string;
  /** Source list location (pathname + search) for the `return=` param. */
  returnSource?: { pathname: string; search: string };
}

export function MemoryCard({ memory, className, returnSource }: MemoryCardProps) {
  const t = useT();
  const detailHref = returnSource
    ? withReturn(`/memory/${memory.id}`, returnSource.pathname, returnSource.search)
    : `/memory/${memory.id}`;
  return (
    <Card className={className}>
      <CardHeader className="gap-1">
        <div className="flex items-start justify-between gap-3">
          {/* h2: card headings sit one level under the page h1 (WCAG 1.3.1). */}
          <h2 className="font-scroll text-base font-semibold leading-tight">
            <Link
              to={detailHref}
              className="inline-flex min-h-6 items-center hover:text-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
            >
              {memoryTitle(memory)}
            </Link>
          </h2>
          <Badge variant={statusBadgeVariant(memory.status)}>
            {t(statusLabelKey(memory.status))}
          </Badge>
        </div>
        <p className="text-xs text-foreground-secondary">
          {memory.agent || t("memory.agentUnknown")} · {memory.project} ·{" "}
          <time dateTime={memory.created_at}>{formatTimestamp(memory.created_at)}</time>
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* UI-27: the snippet goes through the TextEngine primitive — plain
         * prose renders exactly as before (pre-wrap), markdown-carrying
         * memories render formatted (compact) and CSS-clamp to the same
         * 3-line card rhythm. Full content instead of the 120-char cut:
         * the line clamp owns the preview height, the title link opens the
         * detail scroll (no in-card expand button — one link action per
         * card, component-inventory §4). */}
        <TextEngine
          text={memoryEffectiveContent(memory)}
          variant="compact"
          className="line-clamp-3 font-scroll text-sm leading-relaxed text-foreground"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">{memory.memory_type}</Badge>
          {(memory.tags ?? []).map((tag) => (
            <TagBadge key={tag} tag={tag} />
          ))}
          {typeof memory.confidence === "number" ? (
            <span
              className="ml-auto text-xs text-confidence"
              title={t("memory.confidenceTitle", { value: memory.confidence })}
            >
              {formatConfidence(memory.confidence)}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
