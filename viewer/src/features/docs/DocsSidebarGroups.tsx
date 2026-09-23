import { Link, useLocation } from "react-router";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { docCategoriesForProject } from "./categories";
import { docsLocationFor } from "./docsNav";
import { categoryUrl, docProjectsSorted, hubUrl } from "./projects";

/**
 * The docs domain's third sidebar layer (design spec §3): three PROJECT
 * groups, each a link to its hub, with the active project's categories
 * nested as text rows (no icons — hierarchy reads from indent, not glyphs).
 * Everything derives from the pathname: exactly ONE group is expanded (the
 * active project), no JS state.
 *
 * Geometry and category visibility derive from the PANEL expansion state —
 * never from breakpoints (the Sidebar owns the viewport seam, UI-22): the
 * expanded panel — the desktop inline panel OR the mobile OVERLAY — shows
 * the deeper indented group rail with the hairline border and the active
 * project's category rows (the overlay is a real panel: the phone gets the
 * full three-layer nav). Icon-rail degradation (spec §3.2): the groups stay
 * as three icon rows (aria-label carries the project name), categories
 * disappear — the rail never pulls a second icon column.
 */

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright";

export interface DocsSidebarGroupsProps {
  /** Icon-rail mode (no panel expansion): groups stay, categories vanish.
   * Passed as `!expanded` from Sidebar — false for BOTH the desktop inline
   * panel and the mobile overlay. */
  collapsed: boolean;
  /** Visibility classes for label spans — derived from the panel mode. */
  hideLabels: string;
}

export function DocsSidebarGroups({ collapsed, hideLabels }: DocsSidebarGroupsProps) {
  const t = useT();
  const { pathname } = useLocation();
  const location = docsLocationFor(pathname);
  return (
    <ul
      className={cn(
        "mt-1 space-y-1",
        // Icon rail: shallow indent, no border — the second icon column must
        // fit w-14. Expanded (inline OR overlay): the deeper indented rail
        // with the hairline border — same state-driven geometry as the other
        // domains' section lists in Sidebar.tsx.
        collapsed ? "ml-4" : "ml-7 border-l border-border-subtle pl-2",
      )}
    >
      {docProjectsSorted().map((project) => {
        const Icon = project.icon;
        const hub = hubUrl(project.slug);
        const isHub = pathname === hub;
        // Group states (spec §3.2): the hub page = current (iris +
        // aria-current), an article/category of the project = highlighted
        // parent (foreground, medium — no aria-current), else quiet.
        const groupClass = isHub
          ? "bg-elevated font-medium text-iris-bright"
          : location.project === project.slug
            ? "font-medium text-foreground"
            : "text-foreground-secondary";
        return (
          <li key={project.slug}>
            <Link
              to={hub}
              title={project.name}
              aria-label={project.name}
              aria-current={isHub ? "page" : undefined}
              className={cn(
                "flex min-h-6 min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors duration-instant",
                "hover:bg-elevated hover:text-foreground",
                FOCUS_RING,
                groupClass,
              )}
            >
              <Icon className="size-3.5 shrink-0" aria-hidden="true" />
              <span className={hideLabels}>{project.name}</span>
            </Link>
            {!collapsed && location.project === project.slug ? (
              // Rail degradation (spec §3.2): without a panel expansion the
              // category rows do not render at all — the rail never pulls a
              // second icon column. The rows render wherever the gate lets
              // them (no CSS display toggling): the expanded mobile overlay
              // shows them too, the phone gets the full three-layer nav.
              <ul className="mt-1 space-y-1 border-l border-border-subtle pl-2">
                {docCategoriesForProject(project.slug).map((category) => {
                  const label = t(category.titleKey);
                  const to = categoryUrl(project.slug, category.slug);
                  const active = location.category === category.slug;
                  return (
                    <li key={category.slug}>
                      <Link
                        to={to}
                        title={label}
                        aria-label={label}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "block min-h-6 min-w-0 truncate rounded-md px-2 py-1.5 text-sm transition-colors duration-instant",
                          "hover:bg-elevated hover:text-foreground",
                          FOCUS_RING,
                          active
                            ? "font-medium text-iris-bright"
                            : "text-foreground-secondary",
                        )}
                      >
                        {label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
