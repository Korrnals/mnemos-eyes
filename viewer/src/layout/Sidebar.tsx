import { Link, useLocation } from "react-router";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { IrisLogo } from "@/components/IrisLogo/IrisLogo";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { useTaskInbox } from "@/features/tasks/useTasks";
import { useSessionControl } from "@/features/ui-token/useSessionControl";
import { useBoardHealth } from "@/hooks/usePulse";
import { NAV_DOMAINS, activeDomain, isPathActive } from "./navItems";
import { isDocsSectionActive } from "@/features/docs/docsNav";
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
 *
 * Horizontal-overflow hygiene (UI-19 owner feedback): labels never force the
 * panel wider than its fixed slot. Every label span is `min-w-0 truncate`
 * inside a `min-w-0` flex row, every row keeps the FULL name as its `title`
 * hover hint AND its `aria-label` (the SR name survives icon-only mode), and
 * the nav hard-clips horizontal overflow — however long a translation gets,
 * no horizontal scrollbar can appear. The expanded slot is w-64: wide enough
 * for every label but the longest RU docs category («Устройства и
 * подключение»), which ellipsizes its tail under the title tooltip instead
 * of pushing the layout.
 */
export interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const t = useT();
  const { pathname } = useLocation();
  const sessionControl = useSessionControl();
  const openDomain = activeDomain(pathname);
  // Label visibility (UI-19 root cause): the row components used to hardcode
  // `md:inline`, so manual collapse kept the labels VISIBLE inside the w-14
  // rail — the exact overflow the owner screenshotted. Visibility is now
  // derived from `collapsed` in one place and passed down.
  const hideLabels = collapsed
    ? "hidden"
    : "hidden min-w-0 truncate md:inline";

  return (
    <aside
      className={cn(
        "sticky top-0 z-30 flex h-dvh shrink-0 flex-col border-r border-border-subtle bg-well",
        // Icon-only under md; manual collapse wins from md up.
        collapsed ? "w-14" : "w-14 md:w-64",
        "transition-[width] duration-fast ease-out",
      )}
    >
      {/* Collapse control rides the header (UI-19 owner feedback — the old
       * footer corner went unnoticed): expanded = right-aligned «close»
       * icon; collapsed = the solo header control, centered, «open» icon.
       * Collapsed inner width is w-14 minus px-2 — exactly one icon button. */}
      <div
        className={cn(
          "flex items-center gap-2 py-4",
          collapsed ? "justify-center px-2" : "px-3 md:px-4",
        )}
      >
        {!collapsed && <IrisLogo size={28} className="mx-auto md:mx-0" />}
        <span
          className={cn(
            "hidden min-w-0 truncate text-sm font-semibold tracking-wide",
            hideLabels,
          )}
        >
          mnemos-eyes
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggle}
          title={t(collapsed ? "nav.expand" : "nav.collapse")}
          aria-label={t(collapsed ? "nav.expand" : "nav.collapse")}
          aria-expanded={!collapsed}
          className={cn("hidden md:inline-flex", !collapsed && "ml-auto")}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4" aria-hidden="true" />
          ) : (
            <PanelLeftClose className="size-4" aria-hidden="true" />
          )}
        </Button>
      </div>

      {/* overflow-x-hidden closes the horizontal-scroll class entirely: with
       * `overflow-y-auto` alone the implicit visible-x computes to auto and
       * any stray wide child would surface a scrollbar. */}
      <nav
        aria-label={t("nav.primary")}
        className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-2"
      >
        <ul className="space-y-1">
          {NAV_DOMAINS.map((domain) => (
            <li key={domain.to}>
              <DomainLink
                domain={domain}
                expanded={openDomain?.to === domain.to}
                hideLabels={hideLabels}
              />
              {openDomain?.to === domain.to && domain.sections ? (
                <ul
                  className={cn(
                    "mt-1 space-y-1",
                    // Icon rail (manual collapse or < md): shallow indent, no
                    // border — the second icon column must fit w-14.
                    collapsed
                      ? "ml-4"
                      : "ml-4 md:ml-7 md:border-l md:border-border-subtle md:pl-2",
                  )}
                >
                  {domain.sections.map((section) => (
                    <li key={section.to}>
                      <SectionLink
                        section={section}
                        pathname={pathname}
                        hideLabels={hideLabels}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </nav>

      <div className="min-w-0 px-2 pb-3 md:px-3">
        {/* Session-aware mode line (fix/login-feedback): the old static
         * «L1 · только чтение» kept claiming read-only AFTER a login. The
         * line now states the live contract — read-only without a ui token,
         * active session with one — flipping reactively with the gate.
         * Owner feedback: the live server version rides the same footer
         * line («какая версия перед глазами») — hidden when the gateway
         * does not expose it (mock/legacy). One cached boardHealth read,
         * no new polling. */}
        <p
          className={cn(
            "min-w-0 truncate px-2 py-2 text-xs text-foreground-muted",
            collapsed ? "hidden" : "hidden md:block",
          )}
        >
          {t(sessionControl ? "nav.modeActive" : "nav.modeReadOnly")}
          <VersionLabel />
        </p>
      </div>
    </aside>
  );
}

/**
 * Live server version (owner feedback): rides the mode line — «сессия
 * активна · 1.12.1». One cached boardHealth read (the Overview shares the
 * same key — no extra traffic); hidden while loading, on error, or when
 * the gateway serves no version (mock/legacy board).
 */
function VersionLabel() {
  const t = useT();
  const health = useBoardHealth();
  const version = health.data?.app_version;
  if (!version) return null;
  return (
    <span
      title={t("nav.versionAria", { version })}
      className="ml-1 shrink-0 font-mono text-[10px] text-foreground-muted/70"
    >
      {" · "}
      {version}
    </span>
  );
}

function DomainLink({
  domain,
  expanded,
  hideLabels,
}: {
  domain: NavDomain;
  expanded: boolean;
  /** Visibility classes for the label span — derived from `collapsed` up top. */
  hideLabels: string;
}) {
  const t = useT();
  const { pathname } = useLocation();
  const Icon = domain.icon;
  const label = t(domain.key);

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
          "flex w-full min-w-0 cursor-not-allowed items-center gap-3 rounded-md px-3 py-2 text-sm",
          "text-foreground-muted opacity-70",
        )}
      >
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        <span className={hideLabels}>{label}</span>
        <span
          className={cn(
            "hidden shrink-0 rounded-full border border-border-subtle px-1.5 text-xs text-foreground-muted",
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
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors duration-instant",
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

function SectionLink({
  section,
  pathname,
  hideLabels,
}: {
  section: NavSection;
  pathname: string;
  /** Visibility classes for the label span — derived from `collapsed` up top. */
  hideLabels: string;
}) {
  const t = useT();
  const Icon = section.icon;
  const label = t(section.key);
  // Records ("/memory") must highlight on its detail route too
  // ("/memory/:id") — the list is the master of the master-detail pair.
  // The task list ("/tasks") likewise owns its detail route ("/tasks/:id").
  // Docs sections light up on their ARTICLES too: slug → category goes
  // through the docs manifest (design spec §2 — базовый isPathActive не
  // знает про slug→category).
  const active =
    section.to === "/memory"
      ? pathname === "/memory" || /^\/memory\/[^/]+$/.test(pathname)
      : section.to === "/tasks"
        ? pathname === "/tasks" || /^\/tasks\/[^/]+$/.test(pathname)
        : section.to.startsWith("/docs/c/")
          ? isDocsSectionActive(pathname, section.to)
          : isPathActive(pathname, section.to, section.end);
  return (
    <Link
      to={section.to}
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors duration-instant",
        "hover:bg-elevated hover:text-foreground",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright",
        active ? "font-medium text-iris-bright" : "text-foreground-secondary",
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {/* UI-19: truncate under the full-name title — the longest RU docs
       * category («Устройства и подключение») may ellipsize its tail at
       * w-64 but can never push the panel into a horizontal scroll. */}
      <span className={hideLabels}>{label}</span>
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
      className="ml-auto inline-flex shrink-0 items-center rounded-full bg-iris/15 px-1.5 font-mono text-xs text-iris-bright"
    >
      {count}
    </span>
  );
}
