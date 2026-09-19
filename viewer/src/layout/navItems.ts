import type { LucideIcon } from "lucide-react";
import {
  Activity,
  LayoutGrid,
  Layers,
  Search,
  Tag,
  Users,
} from "lucide-react";
import type { TranslationKey } from "@/i18n";

/**
 * Primary navigation items (component-inventory §1 Sidebar). Icons follow the
 * doc's lucide names; the Search entry is the iris route. Labels are i18n
 * keys (owner feedback 1.4.0) — Sidebar/TopBar translate them via useT().
 */
export interface NavItem {
  to: string;
  key: TranslationKey;
  icon: LucideIcon;
  /** Use exact matching for the index route. */
  end?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: "/", key: "nav.search", icon: Search, end: true },
  { to: "/memories", key: "nav.memories", icon: LayoutGrid },
  { to: "/tags", key: "nav.tags", icon: Tag },
  { to: "/status", key: "nav.status", icon: Activity },
  // L2 slot (ADR 0003 / D12): { to: "/clusters", ... } — hidden in L1.
  { to: "/sessions", key: "nav.sessions", icon: Users },
  { to: "/traces", key: "nav.traces", icon: Layers },
];

/**
 * Route title key for the TopBar (component-inventory §1 TopBar). Returns
 * null for unknown paths — the brand name is the caller's fallback and is
 * language-independent, so it stays out of the dictionaries.
 */
export function routeTitleKey(pathname: string): TranslationKey | null {
  if (pathname === "/") return NAV_ITEMS[0].key;
  if (pathname.startsWith("/memories/")) return "nav.memory";
  if (pathname.startsWith("/sessions/")) return "nav.session";
  const match = NAV_ITEMS.find((item) => !item.end && pathname.startsWith(item.to));
  return match?.key ?? null;
}
