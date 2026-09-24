import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { FileText, Search } from "lucide-react";
import { useI18n, useT, type Lang } from "@/i18n";
import { docCategory } from "./categories";
import {
  highlightSegments,
  loadSearchIndex,
  logZeroResult,
  searchDocs,
  type DocsSearchIndex,
  type SearchHit,
} from "./docsSearch";
import { useDocsManifest } from "./manifest";
import { docUrl } from "./projects";
import { DOCS_MARK_CLASS } from "./Markdown";
import { cn } from "@/lib/utils";

/**
 * Docs search UI (design spec §8): a combobox field in the section header on
 * every /docs page. ARIA 1.2 combobox/listbox pattern — ↓/↑ move the active
 * option (aria-activedescendant), Enter opens it, Esc closes and restores
 * focus, Tab closes. Zero-result queries land in localStorage (contract §7)
 * with no UI footprint.
 */

const RESULT_LIMIT = 8;

function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightSegments(text, query).map((segment, index) =>
        segment.hit ? (
          <mark key={index} className={DOCS_MARK_CLASS}>
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

export interface DocsSearchProps {
  className?: string;
}

export function DocsSearch({ className }: DocsSearchProps) {
  const t = useT();
  const { lang } = useI18n();
  const navigate = useNavigate();
  // Manifest read for the locale-coverage hint (spec §7.3): the search only
  // mounts inside /docs, where the manifest builds anyway — no extra fetch.
  const manifest = useDocsManifest();
  const inputId = useId();
  const listId = `${inputId}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [rawActiveIndex, setActiveIndex] = useState(0);
  const [indexByLang, setIndexByLang] = useState<
    Partial<Record<Lang, DocsSearchIndex>>
  >({});

  // Lazy index build on the first /docs mount (contract §7); cached per UI
  // language (the en corpus may cover fewer pages). The effect only writes
  // async — no synchronous state resets (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (indexByLang[lang] !== undefined) return undefined;
    let mounted = true;
    void loadSearchIndex(lang).then((built) => {
      if (mounted) setIndexByLang((previous) => ({ ...previous, [lang]: built }));
    });
    return () => {
      mounted = false;
    };
  }, [lang, indexByLang]);

  const index = indexByLang[lang] ?? null;
  const trimmed = query.trim();
  const results = useMemo(
    () => (index && trimmed !== "" ? searchDocs(index, trimmed, RESULT_LIMIT) : []),
    [index, trimmed],
  );
  // Clamp instead of effect-resetting: the raw index resets to 0 in the
  // input's change handler, and stays in range as results shrink.
  const activeIndex = Math.min(rawActiveIndex, Math.max(results.length - 1, 0));

  // Zero-result queries feed the content backlog — silently (spec §8).
  useEffect(() => {
    if (index !== null && trimmed !== "" && results.length === 0) {
      logZeroResult(trimmed);
    }
  }, [index, trimmed, results.length]);

  const close = () => setOpen(false);

  const updateQuery = (value: string) => {
    setQuery(value);
    setActiveIndex(0); // a fresh draft starts at the top hit (spec §8)
    setOpen(true);
  };

  const openHit = (hit: SearchHit) => {
    close();
    setQuery(""); // selection resets the draft (spec §8)
    navigate(docUrl(hit.slug));
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      close(); // focus stays in the field (spec §8)
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    if (results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => Math.min(current + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const hit = results[open ? activeIndex : 0];
      if (hit) openHit(hit);
    }
  };

  const ready = index !== null;
  const showResults = open && ready && trimmed !== "" && results.length > 0;
  const showEmpty = open && ready && trimmed !== "" && results.length === 0;

  return (
    <div
      className={cn("relative", className)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
    >
      <div
        className={cn(
          "flex h-9 items-center gap-2 rounded-md border border-border-subtle bg-well px-3",
          "transition-colors duration-instant focus-within:border-iris-bright",
        )}
      >
        <Search
          className="size-4 shrink-0 text-foreground-secondary"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          id={inputId}
          type="search"
          role="combobox"
          value={query}
          onChange={(event) => updateQuery(event.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={t("docs.search.placeholder")}
          aria-label={t("docs.search.ariaLabel")}
          aria-expanded={showResults || showEmpty}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            showResults ? `${listId}-opt-${activeIndex}` : undefined
          }
          autoComplete="off"
          spellCheck={false}
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-foreground-muted focus-visible:outline-none"
        />
      </div>

      {showResults ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={t("docs.search.resultsLabel")}
          className={cn(
            "docs-pop absolute inset-x-0 top-full z-30 mt-1 max-h-[60vh] overflow-y-auto",
            "rounded-md border border-border bg-elevated py-1 shadow-float",
          )}
        >
          {results.map((hit, position) => {
            const category = docCategory(hit.category);
            const active = position === activeIndex;
            return (
              <li
                key={hit.slug}
                id={`${listId}-opt-${position}`}
                role="option"
                aria-selected={active}
                onMouseDown={(event) => {
                  // mousedown: act before the field blur closes the list
                  event.preventDefault();
                  openHit(hit);
                }}
                onMouseMove={() => setActiveIndex(position)}
                className={cn(
                  "flex cursor-pointer items-start gap-2 border-l-2 px-3 py-3",
                  active
                    ? "border-iris bg-overlay"
                    : "border-transparent hover:bg-overlay",
                )}
              >
                <FileText
                  className="mt-0.5 size-4 shrink-0 text-foreground-muted"
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">
                    <Highlighted text={hit.title} query={trimmed} />
                  </span>
                  <span className="block text-xs text-foreground-muted">
                    {category ? t(category.titleKey) : hit.category}
                  </span>
                  {hit.snippet !== "" ? (
                    <span className="mt-0.5 block line-clamp-2 text-xs text-foreground-secondary">
                      <Highlighted text={hit.snippet} query={trimmed} />
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      {showEmpty ? (
        <div
          role="status"
          className={cn(
            "absolute inset-x-0 top-full z-30 mt-1 rounded-md border border-border",
            "bg-elevated px-3 py-3 shadow-float",
          )}
        >
          <p className="text-sm text-foreground-secondary">
            {t("docs.search.noResults", { query: trimmed })}
          </p>
          <p className="mt-1 text-sm text-foreground-muted">
            {t("docs.search.noResultsHint")}
          </p>
          {/* Honest gap naming (spec §7.3): when the corpus holds pages the
           * active locale does not cover, say so instead of staying silent. */}
          {manifest?.pages.some((page) => !page.locales.includes(lang)) ? (
            <p className="mt-1 text-sm text-foreground-secondary">
              {t("docs.search.localeHint")}
            </p>
          ) : null}
        </div>
      ) : null}

      {!ready && trimmed !== "" ? (
        <div
          role="status"
          className="absolute inset-x-0 top-full z-30 mt-1 rounded-md border border-border bg-elevated px-3 py-3 text-sm text-foreground-muted shadow-float"
        >
          {t("docs.search.indexing")}
        </div>
      ) : null}
    </div>
  );
}
