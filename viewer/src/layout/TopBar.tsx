import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { StatusIndicator } from "@/components/StatusIndicator/StatusIndicator";
import { deriveHealthStatus } from "@/components/StatusIndicator/deriveHealthStatus";
import { Button } from "@/components/ui/button";
import { useStatus } from "@/hooks/useStatus";

/**
 * Top bar (component-inventory §1): view title + theme toggle + backend
 * status indicator driven by `useStatus`. Auth indicator arrives with T6.
 */
export interface TopBarProps {
  /** Current route label. */
  title: string;
}

export function TopBar({ title }: TopBarProps) {
  const { theme, toggleTheme } = useTheme();
  // The top-bar status is best-effort: never block the shell on failure.
  const status = useStatus();
  const healthState = deriveHealthStatus(status.data, status.isPending, status.isError);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border-subtle px-6">
      <h2 className="text-sm font-semibold text-foreground-secondary">{title}</h2>
      <div className="flex items-center gap-4">
        <StatusIndicator
          status={healthState}
          className="text-sm text-foreground-secondary"
        />
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
