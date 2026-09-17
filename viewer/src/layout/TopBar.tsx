import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { AuthStatus } from "@/features/auth/AuthStatus";

/**
 * Top bar (component-inventory §1): view title + theme toggle + the T6
 * auth/connection slot (mnemos connection indicator, sign in / sign out).
 */
export interface TopBarProps {
  /** Current route label. */
  title: string;
}

export function TopBar({ title }: TopBarProps) {
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-3 sm:px-6">
      {/* Route label, not a heading — each page owns the (single) h1, so the
       * document outline never jumps backwards (WCAG 1.3.1 / 2.4.6). */}
      <p className="min-w-0 truncate text-sm font-semibold text-foreground-secondary">
        {title}
      </p>
      <div className="flex shrink-0 items-center gap-3 sm:gap-4">
        <AuthStatus />
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        >
          {theme === "dark" ? (
            <Sun className="size-4" aria-hidden="true" />
          ) : (
            <Moon className="size-4" aria-hidden="true" />
          )}
          {/* Label shortens below sm so the bar reflows at 320px (WCAG 1.4.10);
           * the aria-label carries the full wording for AT. */}
          <span className="hidden sm:inline">
            {theme === "dark" ? "Light" : "Dark"} theme
          </span>
        </Button>
      </div>
    </header>
  );
}
