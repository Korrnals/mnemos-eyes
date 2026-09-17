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
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border-subtle px-6">
      <h2 className="text-sm font-semibold text-foreground-secondary">{title}</h2>
      <div className="flex items-center gap-4">
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
          {theme === "dark" ? "Light" : "Dark"} theme
        </Button>
      </div>
    </header>
  );
}
