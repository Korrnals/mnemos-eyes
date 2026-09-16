import { useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { IrisLogo } from "@/components/IrisLogo/IrisLogo";
import { SearchBar, type SearchTypeSetting } from "@/components/SearchBar/SearchBar";
import { SearchResultList } from "@/components/SearchResultList/SearchResultList";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { Button } from "@/components/ui/button";
import { useSearch } from "@/hooks/useSearch";

/**
 * `/` — the well: dashboard hero + unified search (component-inventory §3,
 * design-system.md §8.1–8.2). The query lives in the `?q=` URL param; typing
 * holds a local draft that a timer commits into the URL (debounced, replace).
 * No sync effects: URL is the committed source of truth, the draft only
 * bridges keystroke → commit, so external navigation shows through instantly.
 *
 * `auto` passes hits through untouched; `fts`/`semantic` are honest
 * client-side filters over the server-decided per-hit types (mnemos 4.1 has
 * no client-selectable mode param).
 */
const DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 20;

export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery = searchParams.get("q") ?? "";
  const type = parseType(searchParams.get("type"));

  const [draft, setDraft] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const value = draft ?? urlQuery;

  const commit = (next: string) => {
    setSearchParams(
      (prev) => {
        const nextParams = new URLSearchParams(prev);
        if (next) nextParams.set("q", next);
        else nextParams.delete("q");
        return nextParams;
      },
      { replace: true },
    );
  };

  const onChange = (next: string) => {
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setDraft(null);
      commit(next);
    }, DEBOUNCE_MS);
  };

  const onSubmit = (next: string) => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setDraft(null);
    commit(next);
  };

  const setType = (next: SearchTypeSetting) => {
    setSearchParams(
      (prev) => {
        const nextParams = new URLSearchParams(prev);
        if (next === "auto") nextParams.delete("type");
        else nextParams.set("type", next);
        return nextParams;
      },
      { replace: true },
    );
  };

  const hasQuery = urlQuery.trim().length > 0;
  const searchBar = (
    <SearchBar
      value={value}
      onChange={onChange}
      onSubmit={onSubmit}
      isSearching={hasQuery && draft !== null}
      searchType={type}
      onSearchTypeChange={setType}
    />
  );

  if (!hasQuery) {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-3xl flex-col items-center justify-center gap-8">
        {/* §8.1 hero: single breathing iris, glow on (motion budget). */}
        <div className="flex flex-col items-center gap-6 text-center">
          <IrisLogo size={160} glow breathing />
          <p className="text-xl text-foreground-secondary">a gaze into oneself</p>
        </div>
        <div className="w-full max-w-xl">{searchBar}</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>{searchBar}</div>
      <SearchResults query={urlQuery} type={type} />
    </div>
  );
}

/** Mounted only for non-empty queries so the search query never fires idle. */
function SearchResults({ query, type }: { query: string; type: SearchTypeSetting }) {
  const search = useSearch({ query, limit: SEARCH_LIMIT });
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  if (search.isPending) {
    return <SearchResultList results={[]} isLoading queryTerms={terms} />;
  }
  if (search.isError) {
    return (
      <EmptyState
        variant="error"
        title="Search failed"
        message={search.error.message}
        action={
          <Button variant="outline" onClick={() => void search.refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  const all = search.data;
  const results = type === "auto" ? all : all.filter((hit) => hit.search_type === type);

  if (results.length === 0) {
    return (
      <EmptyState
        variant="empty"
        title="Nothing surfaced"
        message={
          type === "auto"
            ? `No memories matched “${query}”.`
            : `No ${type} hits for “${query}”. The pipeline may rank this query differently.`
        }
        detail={
          type === "auto"
            ? "Try fewer or different words — the well is deep but literal."
            : undefined
        }
      />
    );
  }

  return (
    <section aria-label="Search results" aria-busy={search.isFetching}>
      <p className="text-xs text-foreground-muted" role="status">
        {results.length}
        {type === "auto" ? "" : ` ${type}`} hit{results.length === 1 ? "" : "s"} for “{query}”
        {type !== "auto" ? " (client-side filter of server-ranked hits)" : ""}
      </p>
      <SearchResultList results={results} queryTerms={terms} className="mt-3" />
    </section>
  );
}

// --- URL param helpers --------------------------------------------------------

function parseType(value: string | null): SearchTypeSetting {
  return value === "fts" || value === "semantic" ? value : "auto";
}
