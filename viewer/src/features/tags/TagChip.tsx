import { Badge } from "@/components/ui/badge";
import { tagVariant } from "@/components/memory/memoryBadges";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { highlightMatch } from "./model";

/**
 * Cloud chip (UI-17 spec §4.1): size = frequency band, stepped — NOT a
 * continuous scale (inside a band all chips are equal; lying with size for
 * 340 vs 419 is forbidden). Colour = the existing `tagVariant` prefix map
 * (ADR 0003: no new colours — the family already reads from the tag text).
 * Touch target ≥ 24px (WCAG 2.5.8); the full name travels in the aria-label
 * with its count; the match substring gets weight-medium under an active
 * filter (§4.3).
 */

export type TagChipSize = "core" | "frequent" | "middle" | "rare" | "flat";

/** §4.1 type-step table (tokens only). */
const SIZE_TEXT: Record<TagChipSize, string> = {
  core: "text-base font-medium",
  frequent: "text-sm font-medium",
  middle: "text-sm",
  rare: "text-xs",
  flat: "text-sm",
};

export interface TagChipProps {
  tag: string;
  count: number;
  /** Visual step; «flat» = filter result list (no band semantics). */
  size?: TagChipSize;
  /** Active filter — highlights the matched substring (weight-medium). */
  query?: string;
  onClick?: () => void;
  /** Render as a link target instead of a button (e.g. stay-in-context nav). */
  className?: string;
}

export function TagChip({
  tag,
  count,
  size = "middle",
  query,
  onClick,
  className,
}: TagChipProps) {
  const t = useT();
  const highlight = query ? highlightMatch(tag, query) : null;
  return (
    <li className={cn("flex max-w-full min-w-0", className)}>
      <button
        type="button"
        onClick={onClick}
        aria-label={`${tag}, ${t("tags.memoriesCount", { count })}`}
        className={cn(
          "flex min-h-6 max-w-full min-w-0 items-center rounded-sm border border-border-subtle bg-well px-2 py-0.5 text-left transition-colors duration-instant hover:bg-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright",
        )}
      >
        <Badge
          variant={tagVariant(tag)}
          className={cn(
            "max-w-full min-w-0 justify-start rounded-sm px-2 py-0.5",
            SIZE_TEXT[size],
          )}
        >
          <span className="truncate">
            {highlight ? (
              <>
                {highlight.before}
                <span className="font-medium text-foreground">{highlight.match}</span>
                {highlight.after}
              </>
            ) : (
              tag
            )}
          </span>
          <span
            aria-hidden="true"
            className="ml-1 shrink-0 font-ui text-xs text-foreground-secondary"
          >
            {count}
          </span>
        </Badge>
      </button>
    </li>
  );
}
