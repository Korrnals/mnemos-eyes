import { Badge } from "@/components/ui/badge";
import { tagVariant } from "@/components/memory/memoryBadges";
import { cn } from "@/lib/utils";

/**
 * Inline tag chip used across list/detail/search surfaces
 * (component-inventory §6). Colour variant is derived from the tag-contract
 * prefix; an optional `onClick` makes the badge interactive (renders as a
 * real button so keyboard + screen-reader paths work).
 */
export interface TagBadgeProps {
  tag: string;
  size?: "sm" | "md";
  count?: number;
  /** Makes the badge a button (keyboard-activatable). */
  onClick?: () => void;
  /** Force a variant; otherwise derived from the prefix map in memoryBadges. */
  variant?: "default" | "iris" | "confidence" | "error";
  className?: string;
}

export function TagBadge({
  tag,
  size = "sm",
  count,
  onClick,
  variant,
  className,
}: TagBadgeProps) {
  const resolved = variant ?? tagVariant(tag);
  const sizeClass = size === "md" ? "px-3 py-1 text-sm" : undefined;
  const content = (
    <>
      {tag}
      {typeof count === "number" ? (
        <span className="ml-1 font-ui text-foreground-muted">{count}</span>
      ) : null}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "rounded-sm transition-colors duration-instant focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright",
          className,
        )}
        aria-label={`Filter by tag ${tag}`}
      >
        <Badge variant={resolved} className={cn("cursor-pointer hover:brightness-125", sizeClass)}>
          {content}
        </Badge>
      </button>
    );
  }

  return (
    <Badge variant={resolved} className={cn(sizeClass, className)}>
      {content}
    </Badge>
  );
}
