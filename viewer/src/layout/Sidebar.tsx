import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Link, useLocation } from "react-router";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { IrisLogo } from "@/components/IrisLogo/IrisLogo";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { useTaskInbox } from "@/features/tasks/useTasks";
import {
  sessionModeI18nKey,
  useSessionMode,
} from "@/features/ui-token/useSessionControl";
import { useBoardHealth } from "@/hooks/usePulse";
import { DocsSidebarGroups } from "@/features/docs/DocsSidebarGroups";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { setSidebarOverlayOpen } from "@/lib/sidebarOverlayState";
import { NAV_DOMAINS, activeDomain, isPathActive } from "./navItems";
import type { NavDomain, NavSection } from "./navItems";
import { cn } from "@/lib/utils";

/**
 * The md breakpoint of the sidebar (Tailwind md = 768px). Kept in ONE place:
 * the expansion mode is state-driven (not CSS-forced), so the JS query and
 * any future Tailwind class must agree.
 */
const DESKTOP_QUERY = "(min-width: 768px)";

function subscribeDesktop(onChange: () => void): () => void {
  const mql = window.matchMedia(DESKTOP_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/**
 * Viewport seam for the sidebar expansion mode (UI-22 owner feedback). This
 * is a client-only SPA: matchMedia is available on the FIRST client render,
 * so the phone never sees a wrong-viewport frame; the SSR/test snapshot
 * renders the desktop chrome (the historical renderToString behaviour).
 */
function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  );
}

/**
 * Primary navigation (redesign concept §2.2): domain sidebar — «Обзор» root +
 * 5 domains. Sections render under their domain only while it is active
 * (two-layer sidebar: domain → section, never three). Phase-2+ domains are
 * honest disabled slots: a disabled button carrying a "soon" badge and a
 * tooltip, never a dead link.
 *
 * Expansion modes (UI-22 owner feedback — the phone could not expand the
 * panel at all: the toggle was md-only and <md forced icon-only CSS):
 * - >= md (desktop): inline sticky panel, `collapsed` flips the rail and
 *   persists under vesmaro.sidebarCollapsed (Shell) — unchanged.
 * - < md (mobile): the toggle is VISIBLE on the rail header; expanding opens
 *   an OVERLAY — the panel floats fixed over the content with a translucent
 *   backdrop (click / Esc closes), focus moves into the panel and returns to
 *   the toggle on close, the body scroll locks while it is open, Tab
 *   cycles inside the panel (useFocusTrap — a modal dialog must not leak
 *   keyboard focus into the covered page), and the covered page leaves the
 *   accessibility tree (ME-002: Shell + chrome surfaces apply `inert` off
 *   the shared sidebarOverlayState store). The mobile
 *   overlay state is SESSION-ONLY: every entry/reload starts collapsed
 *   regardless of the stored flag, and a mobile toggle click never touches
 *   the persisted desktop intent.
 *
 * Labels are translated via useT(); the "mnemos-eyes" brand is
 * language-independent.
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
  const sessionMode = useSessionMode();
  const openDomain = activeDomain(pathname);
  const isDesktop = useIsDesktop();
  // Mobile expansion is session-only state (see the docblock): it starts
  // closed on every mount and never reaches Shell's persisted flag.
  const [mobileOpen, setMobileOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  const expanded = isDesktop ? !collapsed : mobileOpen;
  // The overlay exists only on mobile: a resize across the breakpoint while
  // the overlay is open degrades back to the inline panel.
  const overlay = expanded && !isDesktop;

  /** Close the overlay; `refocus` returns focus to the toggle (Esc/backdrop —
   * the open affordance). A toggle-click close keeps focus where it already
   * is; a nav-link close hands focus to the routed content (FocusMain). */
  const closeOverlay = useCallback((refocus: boolean) => {
    setMobileOpen(false);
    if (refocus) toggleRef.current?.focus();
  }, []);

  // One toggle, two policies: desktop flips the PERSISTED intent (Shell),
  // mobile flips the session-only overlay.
  const handleToggle = useCallback(() => {
    if (isDesktop) onToggle();
    else setMobileOpen((value) => !value);
  }, [isDesktop, onToggle]);

  // Crossing to desktop while the overlay is open needs no reset: `expanded`
  // ignores mobileOpen above, and returning to mobile reopens the panel the
  // user explicitly expanded — one less effect, one consistent story.

  // Overlay a11y mechanics: focus moves into the panel on open, Esc closes
  // (focus back to the toggle), the document scroll locks while the overlay
  // covers it, and the covered page leaves the accessibility tree — the
  // overlay flag rides the shared store (ME-002), whose consumers (Shell's
  // skip link + content column, the toast region, the update banner) apply
  // `inert` to themselves. The dialog subtree — this aside, the toggle
  // INCLUDED — never goes inert, so the focus return to the toggle below
  // keeps working (programmatic focus cannot cross an inert ancestor).
  // Effects never run on the server — SSR harnesses are safe.
  useEffect(() => {
    setSidebarOverlayOpen(overlay);
    if (!overlay) return;
    panelRef.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeOverlay(true);
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      setSidebarOverlayOpen(false);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [overlay, closeOverlay]);

  // Modal keyboard containment (a dialog without a trap leaks Tab into the
  // covered page): cycles only while the OVERLAY is the active panel. The
  // desktop inline panel and the icon rail stay untrapped — they are page
  // chrome, not a dialog.
  useFocusTrap(panelRef, overlay);

  // Label visibility (UI-19 root cause): derived from the expansion mode in
  // one place and passed down — the icon rail hides them, the expanded panel
  // (inline OR overlay) shows them.
  const hideLabels = expanded ? "min-w-0 truncate" : "hidden";

  return (
    <>
      {/* Translucent backdrop (mobile overlay only): click closes with the
       * focus return; it is aria-hidden decoration — Esc is the keyboard
       * path. Same overlay token as the Radix dialogs. */}
      {overlay ? (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-40 bg-overlay/80"
          onClick={() => closeOverlay(true)}
        />
      ) : null}
      <aside
        id="app-sidebar"
        ref={panelRef}
        tabIndex={-1}
        role={overlay ? "dialog" : undefined}
        aria-modal={overlay ? true : undefined}
        aria-label={overlay ? t("nav.primary") : undefined}
        className={cn(
          "flex h-dvh shrink-0 flex-col border-r border-border-subtle bg-well",
          "transition-[width] duration-fast ease-out",
          expanded ? "w-64" : "w-14",
          // Overlay box on mobile; the inline panel is sticky on desktop.
          overlay
            ? "fixed inset-y-0 left-0 z-50 shadow-float"
            : "sticky top-0 z-30",
        )}
      >
        {/* The ONE collapse control rides the header (UI-19 owner feedback —
         * the old footer corner went unnoticed; UI-22: visible at EVERY
         * width, so the phone can expand the panel too). Expanded =
         * right-aligned «close» icon; collapsed = the solo header control,
         * centered, «open» icon. Collapsed inner width is w-14 minus px-2 —
         * exactly one icon button. */}
        <div
          className={cn(
            "flex items-center gap-2 py-4",
            expanded ? "px-3 md:px-4" : "justify-center px-2",
          )}
        >
          {expanded && <IrisLogo size={28} />}
          <span
            className={cn(
              "min-w-0 truncate text-sm font-semibold tracking-wide",
              hideLabels,
            )}
          >
            mnemos-eyes
          </span>
          <Button
            ref={toggleRef}
            variant="ghost"
            size="icon"
            onClick={handleToggle}
            title={t(expanded ? "nav.collapse" : "nav.expand")}
            aria-label={t(expanded ? "nav.collapse" : "nav.expand")}
            aria-expanded={expanded}
            aria-controls="app-sidebar"
            className={expanded ? "ml-auto" : undefined}
          >
            {expanded ? (
              <PanelLeftClose className="size-4" aria-hidden="true" />
            ) : (
              <PanelLeftOpen className="size-4" aria-hidden="true" />
            )}
          </Button>
        </div>

        {/* overflow-x-hidden closes the horizontal-scroll class entirely: with
         * `overflow-y-auto` alone the implicit visible-x computes to auto and
         * any stray wide child would surface a scrollbar. On the mobile
         * overlay ANY click inside the nav is a navigation (or a no-op) — the
         * overlay closes so the content is never left covered. */}
        <nav
          aria-label={t("nav.primary")}
          onClick={() => {
            if (overlay) setMobileOpen(false);
          }}
          className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-2"
        >
          <ul className="space-y-1">
            {NAV_DOMAINS.map((domain) => (
              <li key={domain.to}>
                <DomainLink
                  domain={domain}
                  expanded={openDomain?.to === domain.to}
                  hideLabels={hideLabels}
                  panelExpanded={expanded}
                />
                {openDomain?.to === domain.to && domain.sections ? (
                  <ul
                    className={cn(
                      "mt-1 space-y-1",
                      // Icon rail: shallow indent, no border — the second icon
                      // column must fit w-14. Expanded: the deeper indented
                      // rail with the hairline border (inline or overlay).
                      expanded
                        ? "ml-7 border-l border-border-subtle pl-2"
                        : "ml-4",
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
                {openDomain?.to === domain.to && domain.to === "/docs" ? (
                  // The docs domain's THIRD layer (ADR 0016 / design spec §3):
                  // project groups with nested categories, expanded from the
                  // pathname alone. Owns its rail geometry + icon-rail fallback.
                  <DocsSidebarGroups
                    collapsed={!expanded}
                    hideLabels={hideLabels}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </nav>

        <div className={cn("min-w-0 pb-3", expanded ? "px-3 md:px-4" : "px-2")}>
          {/* Session-aware mode line (fix/login-feedback): the old static
           * «L1 · только чтение» kept claiming read-only AFTER a login. The
           * line states the live contract — three honest states (UI-22):
           * a ui token = active session; no ui token but a paired device
           * identity = «устройство подключено» (read-only by DEVICE scope,
           * ADR 0012 §5); neither = read-only. Owner feedback: the live
           * server version rides the same footer line («какая версия перед
           * глазами») — hidden when the gateway does not expose it
           * (mock/legacy). One cached boardHealth read, no new polling. */}
          <p
            className={cn(
              "min-w-0 truncate px-2 py-2 text-xs text-foreground-muted",
              expanded ? "block" : "hidden",
            )}
          >
            {t(sessionModeI18nKey(sessionMode))}
            <VersionLabel />
          </p>
        </div>
      </aside>
    </>
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
  panelExpanded,
}: {
  domain: NavDomain;
  expanded: boolean;
  /** Visibility classes for the label span — derived from the panel mode. */
  hideLabels: string;
  /** The PANEL expansion (distinct from the domain-open `expanded`): the
   * "soon" badge rides it — the label spans carry truncate, which a badge
   * must not, so its display is derived here directly. */
  panelExpanded: boolean;
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
            "shrink-0 rounded-full border border-border-subtle px-1.5 text-xs text-foreground-muted",
            panelExpanded ? "inline-block" : "hidden",
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
  /** Visibility classes for the label span — derived from the panel mode. */
  hideLabels: string;
}) {
  const t = useT();
  const Icon = section.icon;
  const label = t(section.key);
  // Records ("/memory") must highlight on its detail route too
  // ("/memory/:id") — the list is the master of the master-detail pair.
  // The task list ("/tasks") likewise owns its detail route ("/tasks/:id").
  // (Docs sections moved to DocsSidebarGroups — projects → categories.)
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
