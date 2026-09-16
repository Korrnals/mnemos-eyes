import { Badge } from "@/components/ui/badge";

/**
 * Tag chip. TODO(T5): hover behaviour per motion budget, click-through to the
 * tags view; mono variant for rule/code memories (D11).
 */
export interface TagBadgeProps {
  tag: string;
  count?: number;
  className?: string;
}

export function TagBadge({ tag, count, className }: TagBadgeProps) {
  return (
    <Badge variant="default" className={className}>
      {tag}
      {typeof count === "number" ? (
        <span className="ml-1 text-foreground-muted">{count}</span>
      ) : null}
    </Badge>
  );
}
