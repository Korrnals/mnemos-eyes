import { useId } from "react";
import { Input } from "@/components/ui/input";

/**
 * Unified search input — the "pupil" (design-system.md §8.2).
 * TODO(T5): radius-xl oval, iris focus glow, FTS/semantic/hybrid switch,
 * URL-param binding via useSearchParams.
 */
export interface SearchBarProps {
  value?: string;
  placeholder?: string;
  onValueChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  className?: string;
}

export function SearchBar({
  value,
  placeholder = "Search the well…",
  onValueChange,
  onSubmit,
  className,
}: SearchBarProps) {
  const inputId = useId();
  return (
    <form
      role="search"
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        onSubmit?.(String(form.get("query") ?? ""));
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        Search memory
      </label>
      <Input
        id={inputId}
        name="query"
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onValueChange?.(event.target.value)}
      />
    </form>
  );
}
