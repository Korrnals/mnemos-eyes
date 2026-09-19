import { useState } from "react";
import { useNavigate } from "react-router";
import { Keyboard, Moon, Rows2, Rows3, Search, Sun } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { useDensity } from "@/components/density-provider";
import { Button } from "@/components/ui/button";
import { AuthStatus } from "@/features/auth/AuthStatus";
import { useT } from "@/i18n";
import { useHotkeys } from "./Hotkeys";
import { GLOBAL_SEARCH_INPUT_ID } from "./hotkeyActions";
import { LanguageToggle } from "./LanguageToggle";

/**
 * Top bar (redesign concept §2.2): the GLOBAL search entry — the `/`-focusable
 * field that commits to `/memory/search?q=…` on Enter (unified entrance of the
 * memory domain) — plus the density toggle (§3.3), the RU|EN switcher, theme,
 * the `?` cheatsheet button and the T6 auth/connection slot. The route label
 * is a `<p>`, not a heading: each page owns the single h1 (WCAG 1.3.1/2.4.6).
 */
export interface TopBarProps {
  /** Current route label (already translated by the caller). */
  title: string;
}

export function TopBar({ title }: TopBarProps) {
  const { theme, toggleTheme } = useTheme();
  const { density, toggleDensity } = useDensity();
  const { openHelp } = useHotkeys();
  const navigate = useNavigate();
  const t = useT();
  const [query, setQuery] = useState("");
  const nextTheme = theme === "dark" ? "light" : "dark";
  const compact = density === "compact";

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    navigate(`/memory/search?q=${encodeURIComponent(trimmed)}`);
  };

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-3 sm:px-6">
      {/* Route label, not a heading — pages own the (single) h1. */}
      <p className="hidden min-w-0 truncate text-sm font-semibold text-foreground-secondary lg:block">
        {title}
      </p>
      <form
        role="search"
        onSubmit={submitSearch}
        className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-border-subtle bg-well px-3 sm:max-w-md lg:ml-auto"
      >
        <Search
          className="size-4 shrink-0 text-foreground-secondary"
          aria-hidden="true"
        />
        <input
          id={GLOBAL_SEARCH_INPUT_ID}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("topbar.searchPlaceholder")}
          aria-label={t("topbar.searchLabel")}
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-foreground-muted focus-visible:outline-none"
        />
        {/* The affordance mirroring the `/` hotkey (kbd semantics). */}
        <kbd className="hidden rounded border border-border-subtle px-1.5 font-mono text-xs text-foreground-muted sm:inline">
          /
        </kbd>
      </form>
      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        <AuthStatus />
        <Button
          variant="ghost"
          size="icon"
          onClick={openHelp}
          aria-label={t("hotkeys.openAria")}
          title={t("hotkeys.openAria")}
          className="hidden sm:inline-flex"
        >
          <Keyboard className="size-4" aria-hidden="true" />
        </Button>
        <LanguageToggle />
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleDensity}
          aria-label={t(
            compact ? "topbar.densityToComfortable" : "topbar.densityToCompact",
          )}
          title={t(compact ? "topbar.densityToComfortable" : "topbar.densityToCompact")}
        >
          {/* Compact packs MORE rows; comfortable keeps them roomy. */}
          {compact ? (
            <Rows3 className="size-4" aria-hidden="true" />
          ) : (
            <Rows2 className="size-4" aria-hidden="true" />
          )}
          <span className="sr-only">
            {t(compact ? "topbar.densityComfortable" : "topbar.densityCompact")}
          </span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleTheme}
          aria-label={t(
            nextTheme === "light" ? "topbar.themeToLight" : "topbar.themeToDark",
          )}
        >
          {theme === "dark" ? (
            <Sun className="size-4" aria-hidden="true" />
          ) : (
            <Moon className="size-4" aria-hidden="true" />
          )}
          {/* Label shortens below sm so the bar reflows at 320px (WCAG 1.4.10);
           * the aria-label carries the full wording for AT. */}
          <span className="hidden sm:inline">
            {t(nextTheme === "light" ? "topbar.themeLight" : "topbar.themeDark")}
          </span>
        </Button>
      </div>
    </header>
  );
}
