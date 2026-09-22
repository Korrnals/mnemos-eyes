import { useMemo } from "react";
import { Link } from "react-router";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { useT } from "@/i18n";
import { resolveReturnTarget } from "@/lib/returnParams";
import { crumbsFor, routeTitle, type Crumb } from "./navItems";

/**
 * Breadcrumbs (redesign concept §2.2 / §3.4-3 — the proven ai-brain pattern):
 * the trail for level 2–3 pages; the LAST crumb is plain text with
 * aria-current="page", every crumb above it is a link — a cheap way "up one
 * level" without a back button. The root page («Обзор») has no trail.
 *
 * UI-18 (context back-nav spec §3): on DETAIL pages the trail is led by the
 * back control — a context link to the `?return=` source (or the master list
 * on direct open), labelled with the target's route title. The trail itself
 * shrinks to «домен › сущность»: the middle section crumb («Список» → /tasks
 * — the confirmed lie, spec §0) loses its job to the control and is dropped
 * here at the render point — navItems.ts owns the list-level mapping and
 * stays untouched (routeTitleKey keeps reading the full crumbsFor trail, and
 * detail trails end in the same entity crumb either way).
 *
 * Detail discriminator: a level-3 detail page is the only shape whose
 * crumbsFor trail is 3 crumbs deep (domain › section › entity) — list pages
 * sit at 2, and `/memory/search|pulse|tags`, `/tasks/list|inbox|archive`
 * must never read as details. Docs are excluded: they carry their own
 * prev/next affordance and are out of the spec's scope (§6).
 */

/** A detail page = a 3-crumb trail; docs trails never qualify. */
function isDetailTrail(pathname: string, crumbs: Crumb[]): boolean {
  return crumbs.length >= 3 && !pathname.startsWith("/docs");
}

/** Trail shortened to «domain › entity» on detail pages (spec §3.1). */
function detailTrail(crumbs: Crumb[]): Crumb[] {
  return crumbs.length >= 3 ? [crumbs[0], crumbs[crumbs.length - 1]] : crumbs;
}

export function Breadcrumbs({ pathname, search }: { pathname: string; search: string }) {
  const t = useT();
  const full = crumbsFor(pathname);
  if (full.length === 0) return null;
  const detail = isDetailTrail(pathname, full);
  const crumbs = detail ? detailTrail(full) : full;
  // Direct-open fallback (spec §3.1: /tasks · /memory · /system/sessions):
  // the dropped middle crumb's target IS the master list — the address the
  // control inherits when `return` is absent or invalid.
  const fallback = full[1]?.to ?? full[0]?.to ?? "/";

  return (
    <div className="flex min-w-0 items-center gap-3">
      {detail ? <BackControl pathname={pathname} search={search} fallback={fallback} /> : null}
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
    </div>
  );
}

/**
 * The back control (UI-18 spec §3): ALWAYS rendered on detail pages — a Link
 * (never a button) whose target is the validated `?return=` source, else the
 * master list (direct open / bookmark / invalid param — spec §2.3). The
 * accessible name carries the destination («Назад: {place}», WCAG 2.4.4),
 * the visible label hides on narrow screens while the ≥24px icon target
 * stays (2.5.8). Ghost styling = the existing TagDrillView pattern — zero
 * new tokens.
 */
function BackControl({
  pathname,
  search,
  fallback,
}: {
  pathname: string;
  search: string;
  fallback: string;
}) {
  const t = useT();
  const searchParams = useMemo(() => new URLSearchParams(search), [search]);
  const target =
    resolveReturnTarget({
      searchParams,
      currentPathname: pathname,
      currentSearch: search,
    }) ?? fallback;
  const queryStart = target.indexOf("?");
  const targetPathname = queryStart === -1 ? target : target.slice(0, queryStart);
  const place = routeTitle(targetPathname, t) ?? t("nav.backFallback");
  return (
    <Link
      to={target}
      aria-label={t("nav.backTo", { place })}
      className="inline-flex min-h-6 min-w-6 shrink-0 items-center gap-1 rounded-sm text-sm text-foreground-secondary transition-colors duration-instant hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
    >
      <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
      <span className="hidden sm:inline">{place}</span>
    </Link>
  );
}
