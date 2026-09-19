import { Link, useLocation } from "react-router";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { IrisLogo } from "@/components/IrisLogo/IrisLogo";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { useTaskInbox } from "@/features/tasks/useTasks";
import { NAV_DOMAINS, activeDomain, isPathActive } from "./navItems";
import type { NavDomain, NavSection } from "./navItems";
import { cn } from "@/lib/utils";

/**
 * Primary navigation (redesign concept §2.2): domain sidebar — «Обзор» root +
 * 5 domains. Sections render under their domain only while it is active
 * (two-layer sidebar: domain → section, never three). Phase-2+ domains are
 * honest disabled slots: a disabled button carrying a "soon" badge and a
 * tooltip, never a dead link. `collapsed` switches to icon-only mode; on
 * narrow viewports (< md = 768px) icon-only is forced via CSS so no JS media
 * query is needed. Labels are translated via useT(); the "mnemos-eyes" brand
 * is language-independent.
 */
export interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const t = useT();
  const { pathname } = useLocation();
  const openDomain = activeDomain(pathname);
  const hideLabels = collapsed ? undefined : "md:inline";

  return (
    <aside
      className={cn(
        "sticky top-0 z-30 flex h-dvh shrink-0 flex-col border-r border-border-subtle bg-well",
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

      <nav aria-label={t("nav.primary")} className="flex-1 overflow-y-auto px-2">
        <ul className="space-y-1">
          {NAV_DOMAINS.map((domain) => (
            <li key={domain.to}>
              <DomainLink domain={domain} expanded={openDomain?.to === domain.to} />
              {openDomain?.to === domain.to && domain.sections ? (
                <ul className="mt-1 ml-7 space-y-1 border-l border-border-subtle pl-2 md:ml-8">
                  {domain.sections.map((section) => (
                    <li key={section.to}>
                      <SectionLink section={section} pathname={pathname} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
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

function DomainLink({ domain, expanded }: { domain: NavDomain; expanded: boolean }) {
  const t = useT();
  const { pathname } = useLocation();
  const Icon = domain.icon;
  const label = t(domain.key);
  const hideLabels = "hidden whitespace-nowrap md:inline";

  // Honest disabled slot (Phase 2+): visible, explained, inert — a disabled
  // button with a "soon" badge; the tooltip (title) carries the phase hint
  // for pointer users, the badge text for everyone else.
  if (domain.soonKey) {
    const hint = t(domain.soonKey);
    return (
      <button
        type="button"
        disabled
        title={`${label} — ${hint}`}
        className={cn(
          "flex w-full cursor-not-allowed items-center gap-3 rounded-md px-3 py-2 text-sm",
          "text-foreground-muted opacity-70",
        )}
      >
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        <span className={hideLabels}>{label}</span>
        <span
          className={cn(
            "hidden rounded-full border border-border-subtle px-1.5 text-xs text-foreground-muted",
            hideLabels,
          )}
        >
          {t("nav.soon")}
        </span>
      </button>
    );
  }

  const active = isPathActive(pathname, domain.to, domain.end);
  return (
    <Link
      to={domain.linkTo ?? domain.to}
      title={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors duration-instant",
        "hover:bg-elevated hover:text-foreground",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright",
        active
          ? "bg-elevated font-medium text-iris-bright"
          : "text-foreground-secondary",
        expanded && !active && "text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className={hideLabels}>{label}</span>
    </Link>
  );
}

function SectionLink({ section, pathname }: { section: NavSection; pathname: string }) {
  const t = useT();
  const Icon = section.icon;
  const label = t(section.key);
  // Records ("/memory") must highlight on its detail route too
  // ("/memory/:id") — the list is the master of the master-detail pair.
  // The task list ("/tasks") likewise owns its detail route ("/tasks/:id").
  const active =
    section.to === "/memory"
      ? pathname === "/memory" || /^\/memory\/[^/]+$/.test(pathname)
      : section.to === "/tasks"
        ? pathname === "/tasks" || /^\/tasks\/[^/]+$/.test(pathname)
        : isPathActive(pathname, section.to, section.end);
  return (
    <Link
      to={section.to}
      title={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors duration-instant",
        "hover:bg-elevated hover:text-foreground",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright",
        active ? "font-medium text-iris-bright" : "text-foreground-secondary",
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="hidden whitespace-nowrap md:inline">{label}</span>
      {section.counter === "inbox" ? <InboxCount /> : null}
    </Link>
  );
}

/**
 * Live inbox counter (Ф2): the count of NOT-yet-adopted queue records. One
 * cached read (no polling — the mirror changes via the server scanner);
 * hidden while unknown, zero or on incapable gateways (honest absence
 * instead of a dead "0").
 */
function InboxCount() {
  const t = useT();
  const inbox = useTaskInbox();
  const count = inbox.data?.count ?? 0;
  if (inbox.isPending || inbox.isError || count === 0) return null;
  return (
    <span
      title={t("tasks.inboxCount", { count })}
      aria-label={t("tasks.inboxCount", { count })}
      className="ml-auto inline-flex items-center rounded-full bg-iris/15 px-1.5 font-mono text-xs text-iris-bright"
    >
      {count}
    </span>
  );
}
