import { useTheme } from "@/components/theme-provider";
import { StatusIndicator } from "@/components/StatusIndicator/StatusIndicator";
import { Button } from "@/components/ui/button";
import { useStatus } from "@/hooks/useStatus";

/**
 * Top bar: status indicator + theme toggle.
 * TODO(T6): auth state / login entry once HttpAdapter auth lands.
 */
export function TopBar() {
  const { theme, toggleTheme } = useTheme();
  // The top-bar status is best-effort: never block the shell on failure.
  const status = useStatus();

  return (
    <header className="flex h-14 items-center justify-between border-b border-border-subtle px-6">
      <StatusIndicator
        health={status.data}
        className="text-sm text-foreground-secondary"
      />
      <Button
        variant="ghost"
        size="sm"
        onClick={toggleTheme}
        aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      >
        {theme === "dark" ? "Light" : "Dark"} theme
      </Button>
    </header>
  );
}
