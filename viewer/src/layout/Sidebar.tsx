import { NavLink } from "react-router";
import { IrisLogo } from "@/components/IrisLogo/IrisLogo";
import { cn } from "@/lib/utils";

/**
 * App navigation. The cluster slot is intentionally absent per ADR 0003/D12 —
 * it returns in L2 together with the `clusters` feature module.
 */
const NAV_ITEMS = [
  { to: "/", label: "Search", end: true },
  { to: "/memories", label: "Memories" },
  { to: "/tags", label: "Tags" },
  { to: "/status", label: "Status" },
  { to: "/sessions", label: "Sessions" },
  { to: "/traces", label: "Traces" },
] as const;

// L2 slot (D12): { to: "/clusters", label: "Clusters" } — hidden in L1.
const L2_CLUSTER_SLOT = { to: "/clusters", label: "Clusters" } as const;
void L2_CLUSTER_SLOT;

export function Sidebar() {
  return (
    <aside className="flex h-dvh w-56 shrink-0 flex-col border-r border-border-subtle bg-well">
      <div className="flex items-center gap-3 px-4 py-5">
        <IrisLogo size={28} />
        <span className="text-sm font-semibold tracking-wide">mnemos-eyes</span>
      </div>
      <nav aria-label="Primary" className="flex-1 px-2">
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={"end" in item ? item.end : false}
                className={({ isActive }) =>
                  cn(
                    "block rounded-md px-3 py-2 text-sm transition-colors duration-instant",
                    "hover:bg-elevated hover:text-foreground",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright",
                    isActive
                      ? "bg-elevated font-medium text-iris-bright"
                      : "text-foreground-secondary",
                  )
                }
              >
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <p className="px-4 py-4 text-xs text-foreground-muted">L1 read-only viewer</p>
    </aside>
  );
}
