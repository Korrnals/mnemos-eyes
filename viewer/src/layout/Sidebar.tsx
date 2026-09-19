import { NavLink } from "react-router";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { IrisLogo } from "@/components/IrisLogo/IrisLogo";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { NAV_ITEMS } from "./navItems";
import { cn } from "@/lib/utils";

/**
 * Primary navigation: links to all L1 routes + brand mark
 * (component-inventory §1). `collapsed` switches to icon-only mode; on narrow
 * viewports (< md) icon-only is also forced via CSS so no JS media query is
 * needed. The cluster slot stays hidden in L1 (ADR 0003 / D12). Labels are
 * translated via useT(); the "mnemos-eyes" brand is language-independent.
 */
export interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const t = useT();
  const hideLabels = collapsed ? undefined : "md:inline";
  return (
    <aside
      className={cn(
        "flex h-dvh shrink-0 flex-col border-r border-border-subtle bg-well",
        // Icon-only under md; manual collapse wins from md up.
        collapsed ? "w-14" : "w-14 md:w-56",
        "transition-[width] duration-fast ease-out",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-4 md:px-4">
        <IrisLogo size={collapsed ? 24 : 28} className="mx-auto md:mx-0" />
        <span
          className={cn(
            "hidden whitespace-nowrap text-sm font-semibold tracking-wide",
            hideLabels,
          )}
        >
          mnemos-eyes
        </span>
      </div>

      <nav aria-label={t("nav.primary")} className="flex-1 px-2">
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const label = t(item.key);
            return (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={"end" in item ? item.end : false}
                  title={label}
                  className={({ isActive }) =>
                    cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors duration-instant",
                      "hover:bg-elevated hover:text-foreground",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright",
                      isActive
                        ? "bg-elevated font-medium text-iris-bright"
                        : "text-foreground-secondary",
                    )
                  }
                >
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  <span className={cn("hidden whitespace-nowrap", hideLabels)}>
                    {label}
                  </span>
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="flex items-center justify-center px-2 pb-3 md:justify-start md:px-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggle}
          aria-label={t(collapsed ? "nav.expand" : "nav.collapse")}
          aria-expanded={!collapsed}
          className="hidden md:inline-flex"
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4" aria-hidden="true" />
          ) : (
            <PanelLeftClose className="size-4" aria-hidden="true" />
          )}
        </Button>
        <p
          className={cn(
            "hidden px-2 py-2 text-xs text-foreground-muted",
            collapsed ? undefined : "md:inline",
          )}
        >
          {t("nav.footerReadOnly")}
        </p>
      </div>
    </aside>
  );
}
