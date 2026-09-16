import { Link } from "react-router";
import { TagBadge } from "@/components/TagBadge/TagBadge";
import {
  formatConfidence,
  formatTimestamp,
  memorySnippet,
  memoryTitle,
} from "@/components/memory/memoryDisplay";
import { statusBadgeVariant } from "@/components/memory/memoryBadges";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { Memory } from "@/gateway/types";

/**
 * List-view representation of one memory (component-inventory §4): auto-title,
 * 120-char snippet of the effective content, tags, confidence dot, timestamp.
 * The title is the link target (single accessible name per card).
 */
export interface MemoryCardProps {
  memory: Memory;
  className?: string;
}

export function MemoryCard({ memory, className }: MemoryCardProps) {
  return (
    <Card className={className}>
      <CardHeader className="gap-1">
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-scroll text-base font-semibold leading-tight">
            <Link
              to={`/memories/${memory.id}`}
              className="hover:text-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
            >
              {memoryTitle(memory)}
            </Link>
          </h3>
          <Badge variant={statusBadgeVariant(memory.status)}>{memory.status}</Badge>
        </div>
        <p className="text-xs text-foreground-secondary">
          {memory.agent || "unknown agent"} · {memory.project} ·{" "}
          <time dateTime={memory.created_at}>{formatTimestamp(memory.created_at)}</time>
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="line-clamp-3 font-scroll text-sm leading-relaxed text-foreground">
          {memorySnippet(memory)}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">{memory.memory_type}</Badge>
          {(memory.tags ?? []).map((tag) => (
            <TagBadge key={tag} tag={tag} />
          ))}
          {typeof memory.confidence === "number" ? (
            <span
              className="ml-auto text-xs text-confidence"
              title={`confidence ${memory.confidence}`}
            >
              {formatConfidence(memory.confidence)}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
