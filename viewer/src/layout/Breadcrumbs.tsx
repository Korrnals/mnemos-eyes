import { Link } from "react-router";
import { ChevronRight } from "lucide-react";
import { useT } from "@/i18n";
import { crumbsFor } from "./navItems";

/**
 * Breadcrumbs (redesign concept §2.2 / §3.4-3 — the proven ai-brain pattern):
 * the trail for level 2–3 pages; the LAST crumb is plain text with
 * aria-current="page", every crumb above it is a link — a cheap way "up one
 * level" without a back button. The root page («Обзор») has no trail.
 */
export function Breadcrumbs({ pathname }: { pathname: string }) {
  const t = useT();
  const crumbs = crumbsFor(pathname);
  if (crumbs.length === 0) return null;

  return (
    <nav aria-label={t("breadcrumbs.label")} className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1 text-sm">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <li
              key={`${crumb.key ?? crumb.label}-${index}`}
              className="flex min-w-0 items-center gap-1"
            >
              {index > 0 ? (
                <ChevronRight
                  className="size-3.5 shrink-0 text-foreground-muted"
                  aria-hidden="true"
                />
              ) : null}
              {crumb.to && crumb.key && !last ? (
                <Link
                  to={crumb.to}
                  className="inline-flex min-h-6 items-center rounded-sm text-foreground-secondary transition-colors duration-instant hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
                >
                  {t(crumb.key)}
                </Link>
              ) : (
                <span
                  aria-current="page"
                  className="inline-flex min-h-6 items-center truncate font-medium text-foreground"
                >
                  {crumb.label ?? (crumb.key ? t(crumb.key) : "")}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
