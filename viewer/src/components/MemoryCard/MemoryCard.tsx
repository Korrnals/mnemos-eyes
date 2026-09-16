import { Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TagBadge } from "@/components/TagBadge/TagBadge";
import type { Memory } from "@/gateway/types";

/**
 * Memory list item card.
 * TODO(T5): confidence dot (gold), staggered entrance per motion budget,
 * scroll typography for the excerpt.
 */
export interface MemoryCardProps {
  memory: Memory;
  className?: string;
}

export function MemoryCard({ memory, className }: MemoryCardProps) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="font-scroll text-base">
          <Link
            to={`/memories/${memory.id}`}
            className="hover:text-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
          >
            {memory.id}
          </Link>
        </CardTitle>
        <p className="text-xs text-foreground-secondary">
          {memory.agent ?? "unknown agent"} · {memory.created_at}
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="line-clamp-3 font-scroll text-sm leading-relaxed text-foreground">
          {memory.content}
        </p>
        <div className="flex flex-wrap gap-1" aria-label="tags">
          {memory.tags.map((tag) => (
            <TagBadge key={tag} tag={tag} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
