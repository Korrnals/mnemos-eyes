import { useId } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Unified search entry point — the "pupil" (component-inventory §3,
 * design-system.md §8.2). Controlled input + optional FTS/semantic/auto
 * mini-toggle; the oval radius and iris focus glow are token-bound.
 */
export type SearchTypeSetting = "fts" | "semantic" | "auto";

export interface SearchBarProps {
  value: string;
  onChange: (v: string) => void;
  /** Fires on Enter or button submit with the current value. */
  onSubmit: (v: string) => void;
  /** Shows the iris-pulse state on the search button. */
  isSearching?: boolean;
  /** Displayed as a mini toggle; `auto` = the server decides per hit. */
  searchType?: SearchTypeSetting;
  onSearchTypeChange?: (t: SearchTypeSetting) => void;
  className?: string;
}

const SEARCH_TYPES: { value: SearchTypeSetting; label: string; title: string }[] = [
  { value: "auto", label: "Auto", title: "Server-decided ranking per hit" },
  { value: "fts", label: "FTS", title: "Show full-text hits only (client-side filter)" },
  { value: "semantic", label: "Semantic", title: "Show semantic hits only (client-side filter)" },
];

export function SearchBar({
  value,
  onChange,
  onSubmit,
  isSearching = false,
  searchType = "auto",
  onSearchTypeChange,
  className,
}: SearchBarProps) {
  const inputId = useId();
  const typeName = `search-type-${inputId}`;

  return (
    <form
      role="search"
      aria-label="Search memories"
      aria-busy={isSearching}
      className={cn("w-full", className)}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(value);
      }}
    >
      <div
        className={cn(
          "flex items-center gap-2 rounded-xl border border-border bg-well py-1.5 pl-5 pr-1.5",
          "transition-[box-shadow,border-color] duration-normal ease-out",
          "focus-within:border-iris-bright focus-within:shadow-iris",
        )}
      >
        <label htmlFor={inputId} className="sr-only">
          Search memory
        </label>
        <input
          id={inputId}
          name="query"
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Search the well…"
          autoComplete="off"
          spellCheck={false}
          className={cn(
            "min-w-0 flex-1 bg-transparent text-base text-foreground",
            "placeholder:text-foreground-muted focus:outline-none",
          )}
        />
        <button
          type="submit"
          disabled={isSearching}
          aria-label={isSearching ? "Searching" : "Search"}
          className={cn(
            "inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-iris text-foreground-inverse",
            "transition-colors duration-instant hover:bg-iris-bright",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright",
            "disabled:pointer-events-none disabled:opacity-60",
            isSearching && "animate-pulse",
          )}
        >
          <Search className="size-4" aria-hidden="true" />
        </button>
      </div>

      {onSearchTypeChange ? (
        <fieldset className="mt-3 flex items-center justify-center gap-1">
          <legend className="sr-only">Search type</legend>
          {SEARCH_TYPES.map((option) => (
            <label
              key={option.value}
              title={option.title}
              className={cn(
                "cursor-pointer rounded-full border px-3 py-1 text-xs transition-colors duration-instant",
                "has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-iris-bright",
                searchType === option.value
                  ? "border-iris bg-iris/15 text-iris-bright" // AA in both themes
                  : "border-border-subtle text-foreground-secondary hover:bg-elevated",
              )}
            >
              <input
                type="radio"
                name={typeName}
                value={option.value}
                checked={searchType === option.value}
                onChange={() => onSearchTypeChange(option.value)}
                className="sr-only"
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      ) : null}
    </form>
  );
}
