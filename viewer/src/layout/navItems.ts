import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Database,
  Files,
  HeartPulse,
  Home,
  KanbanSquare,
  LayoutGrid,
  Search,
  ServerCog,
  Tag,
  Users,
  Layers,
  Bot,
} from "lucide-react";
import type { TranslationKey } from "@/i18n";

/**
 * Domain navigation (redesign concept §2.1–§2.2, ADR 0011 Ф1). The sidebar is
 * two-layered: domain → section. Phase-2+ domains render as HONEST disabled
 * slots (a disabled button + "soon" badge + tooltip), never as dead links —
 * the IA map is visible ahead of the content waves.
 */
export interface NavSection {
  to: string;
  key: TranslationKey;
  icon: LucideIcon;
  /** Exact-path match (section roots). */
  end?: boolean;
}

export interface NavDomain {
  /** Domain match prefix (also the canonical domain root path). */
  to: string;
  /**
   * Link target when the domain root itself has no index route yet (System
   * until its Ф2+ pages land) — the domain still matches on `to`.
   */
  linkTo?: string;
  key: TranslationKey;
  icon: LucideIcon;
  /** Exact matching for the app root. */
  end?: boolean;
  /** Honest "coming in phase N" tooltip key for not-yet-shipped domains. */
  soonKey?: TranslationKey;
  sections?: readonly NavSection[];
}

export const NAV_DOMAINS: readonly NavDomain[] = [
  { to: "/", key: "nav.overview", icon: Home, end: true },
  {
    to: "/memory",
    key: "nav.memory",
    icon: LayoutGrid,
    sections: [
      { to: "/memory/search", key: "nav.search", icon: Search, end: true },
      { to: "/memory/pulse", key: "nav.pulse", icon: HeartPulse, end: true },
      { to: "/memory", key: "nav.records", icon: Files, end: true },
      { to: "/memory/tags", key: "nav.tags", icon: Tag, end: true },
    ],
  },
  // Phase-2 slot (task domain — board pages land with Ф2, DnD with Ф3).
  { to: "/tasks", key: "nav.tasks", icon: KanbanSquare, soonKey: "nav.soonTasks" },
  // Phase-4 slots (agents / stores — ARCH-2 Ф4 and the registry wave).
  { to: "/agents", key: "nav.agents", icon: Bot, soonKey: "nav.soonAgents" },
  { to: "/stores", key: "nav.stores", icon: Database, soonKey: "nav.soonStores" },
  {
    to: "/system",
    // No /system index route in Ф1 — the domain link goes to its first
    // live section instead of a dead /system target.
    linkTo: "/system/status",
    key: "nav.system",
    icon: ServerCog,
    sections: [
      { to: "/system/status", key: "nav.status", icon: Activity, end: true },
      { to: "/system/sessions", key: "nav.sessions", icon: Users },
      { to: "/system/traces", key: "nav.traces", icon: Layers, end: true },
    ],
  },
];

/** Prefix-match helper for domain/section highlighting (`/memory/x` ⊂ `/memory`). */
export function isPathActive(pathname: string, to: string, end = false): boolean {
  if (to === "/") return pathname === "/";
  if (end) return pathname === to;
  return pathname === to || pathname.startsWith(`${to}/`);
}

/** Domain whose subtree the pathname sits in (for section expansion). */
export function activeDomain(pathname: string): NavDomain | null {
  return (
    NAV_DOMAINS.find(
      (domain) =>
        domain.soonKey === undefined && isPathActive(pathname, domain.to, domain.end),
    ) ?? null
  );
}

// --- breadcrumbs (concept §2.2: last crumb is never a link) -------------------

export interface Crumb {
  /** Present ⇒ a link; the last crumb has none. */
  to?: string;
  key: TranslationKey;
}

const MEMORY_CRUMB: Crumb = { to: "/memory", key: "nav.memory" };
const SYSTEM_CRUMB: Crumb = { to: "/system", key: "nav.system" };

/**
 * Breadcrumb trail for a pathname (level 2–3 pages; the root has none).
 * Pure + pathname-only so the mapping stays exhaustively testable.
 */
export function crumbsFor(pathname: string): Crumb[] {
  if (pathname === "/") return [];
  switch (pathname) {
    case "/memory":
      return [MEMORY_CRUMB, { key: "nav.records" }];
    case "/memory/search":
      return [MEMORY_CRUMB, { key: "nav.search" }];
    case "/memory/pulse":
      return [MEMORY_CRUMB, { key: "nav.pulse" }];
    case "/memory/tags":
      return [MEMORY_CRUMB, { key: "nav.tags" }];
    case "/system/status":
      return [SYSTEM_CRUMB, { key: "nav.status" }];
    case "/system/sessions":
      return [SYSTEM_CRUMB, { key: "nav.sessions" }];
    case "/system/traces":
      return [SYSTEM_CRUMB, { key: "nav.traces" }];
  }
  if (pathname.startsWith("/memory/")) {
    // Detail scroll (`/memory/:id`) sits under the records list.
    return [MEMORY_CRUMB, { to: "/memory", key: "nav.records" }, { key: "nav.record" }];
  }
  if (pathname.startsWith("/system/sessions/")) {
    return [
      SYSTEM_CRUMB,
      { to: "/system/sessions", key: "nav.sessions" },
      { key: "nav.session" },
    ];
  }
  return [];
}

/**
 * Route title key for the TopBar label: the last crumb (deepest level).
 * Returns null for unknown paths — the brand name is the caller's fallback
 * and is language-independent, so it stays out of the dictionaries.
 */
export function routeTitleKey(pathname: string): TranslationKey | null {
  if (pathname === "/") return "nav.overview";
  const crumbs = crumbsFor(pathname);
  return crumbs.length > 0 ? crumbs[crumbs.length - 1].key : null;
}
