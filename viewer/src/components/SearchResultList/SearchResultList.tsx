import { SearchResultCard } from "@/components/SearchResultCard/SearchResultCard";
import { MemoryCardSkeleton } from "@/components/skeletons/Skeletons";
import type { SearchResult } from "@/gateway/types";
import "./SearchResultList.css";

/**
 * Staggered-entrance list of search results (component-inventory §3,
 * design-system.md §8.2): at most `STAGGER_SLOTS` items animate with a per-index
 * delay; the rest appear instantly. Loading shows skeleton cards.
 */
export interface SearchResultListProps {
  results: SearchResult[];
  isLoading?: boolean;
  queryTerms?: string[];
  className?: string;
}

/** Only the first five results get a stagger delay (motion budget §7). */
const STAGGER_SLOTS = 5;

export function SearchResultList({
  results,
  isLoading = false,
  queryTerms = [],
  className,
}: SearchResultListProps) {
  if (isLoading) {
    return <MemoryCardSkeleton count={3} className={className} />;
  }
  return (
    <ul className={`space-y-4${className ? ` ${className}` : ""}`}>
      {results.map((result, index) => (
        <li
          key={result.id}
          className="search-result-enter"
          style={{ animationDelay: index < STAGGER_SLOTS ? `calc(var(--duration-stagger) * ${index})` : undefined }}
        >
          <SearchResultCard result={result} queryTerms={queryTerms} />
        </li>
      ))}
    </ul>
  );
}
