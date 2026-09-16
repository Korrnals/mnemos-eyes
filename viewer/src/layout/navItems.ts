import type { LucideIcon } from "lucide-react";
import {
  Activity,
  LayoutGrid,
  Layers,
  Search,
  Tag,
  Users,
} from "lucide-react";

/**
 * Primary navigation items (component-inventory §1 Sidebar). Icons follow the
 * doc's lucide names; the Search entry is the iris route.
 */
export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Use exact matching for the index route. */
  end?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Search", icon: Search, end: true },
  { to: "/memories", label: "Memories", icon: LayoutGrid },
  { to: "/tags", label: "Tags", icon: Tag },
  { to: "/status", label: "Status", icon: Activity },
  // L2 slot (ADR 0003 / D12): { to: "/clusters", label: "Clusters", icon: Share2 } — hidden in L1.
  { to: "/sessions", label: "Sessions", icon: Users },
  { to: "/traces", label: "Traces", icon: Layers },
];

/** Route label for the TopBar title (component-inventory §1 TopBar). */
export function routeTitle(pathname: string): string {
  if (pathname === "/") return NAV_ITEMS[0].label;
  if (pathname.startsWith("/memories/")) return "Memory";
  if (pathname.startsWith("/sessions/")) return "Session";
  const match = NAV_ITEMS.find((item) => !item.end && pathname.startsWith(item.to));
  return match?.label ?? "mnemos-eyes";
}
