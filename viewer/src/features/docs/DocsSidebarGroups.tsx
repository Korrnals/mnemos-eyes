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
 * active project), no JS state. Icon-rail degradation (spec §3.2): the
 * groups stay as three icon rows (aria-label carries the project name),
 * categories disappear — the rail never pulls a second icon column.
 */

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright";

export interface DocsSidebarGroupsProps {
  /** Icon-rail mode (manual collapse): groups stay, categories vanish. */
  collapsed: boolean;
  /** Visibility classes for label spans — derived from `collapsed` upstream. */
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
        // Icon rail (manual collapse or < md): shallow indent, no border —
        // same geometry as the other domains' section lists.
        "ml-4 md:ml-7 md:border-l md:border-border-subtle md:pl-2",
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
              // Rail degradation (spec §3.2): manual collapse drops the
              // category rows entirely; the forced < md rail hides them via
              // CSS (hidden md:block) — no second icon column either way.
              <ul className="mt-1 hidden space-y-1 border-l border-border-subtle pl-2 md:block">
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
