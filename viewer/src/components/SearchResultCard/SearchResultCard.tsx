import { Link } from "react-router";
import { TagBadge } from "@/components/TagBadge/TagBadge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useT } from "@/i18n";
import { withReturn } from "@/lib/returnParams";
import type { SearchResult } from "@/gateway/types";
import { highlight } from "./highlight";

/**
 * Compact memory result row (component-inventory §3): title, snippet with
 * query-term highlight, score, tags, and a search-type badge. The badge colour
 * reflects the hit type — `fts` / `semantic` / `hybrid`.
 *
 * UI-18 pair 9: `returnSource` makes the title link carry the search URL
 * (`?q=&type=` — the query restore is mandatory per spec §1) as its
 * `return=` context.
 */
export interface SearchResultCardProps {
  result: SearchResult;
  /** Query terms to highlight in title/snippet. */
  queryTerms?: string[];
  className?: string;
  /** Source search location (pathname + search) for the `return=` param. */
  returnSource?: { pathname: string; search: string };
}

const TYPE_VARIANT: Record<
  SearchResult["search_type"],
  "default" | "iris" | "confidence"
> = {
  fts: "default",
  semantic: "confidence",
  hybrid: "iris",
};

export function SearchResultCard({
  result,
  queryTerms = [],
  className,
  returnSource,
}: SearchResultCardProps) {
  const t = useT();
  const detailHref = returnSource
    ? withReturn(`/memory/${result.id}`, returnSource.pathname, returnSource.search)
    : `/memory/${result.id}`;
  return (
    <Card className={className}>
      <CardContent className="space-y-2 p-5">
        <div className="flex items-start justify-between gap-3">
          {/* h2: card headings sit one level under the page h1 (WCAG 1.3.1). */}
          <h2 className="font-scroll text-base font-semibold leading-tight">
            <Link
              to={detailHref}
              className="inline-flex min-h-6 items-center hover:text-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
            >
              {highlight(result.title || result.id, queryTerms)}
            </Link>
          </h2>
          <span className="flex shrink-0 items-center gap-1.5">
            <Badge variant={TYPE_VARIANT[result.search_type]}>
              {result.search_type}
            </Badge>
            <span
              className="rounded-sm bg-elevated px-2 py-0.5 text-xs font-medium text-iris-bright"
              title={t("search.relevanceTitle", { value: result.score })}
            >
              {result.score.toFixed(2)}
            </span>
          </span>
        </div>
        <p className="line-clamp-2 text-sm leading-relaxed text-foreground-secondary">
          {highlight(result.content, queryTerms)}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {result.tags.map((tag) => (
            <TagBadge key={tag} tag={tag} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
