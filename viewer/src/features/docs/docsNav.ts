import { BookOpen } from "lucide-react";
import type { Crumb, NavDomain } from "@/layout/navItems";
import type { Lang } from "@/i18n";
import { docCategory } from "./categories";
import {
  DEFAULT_PROJECT,
  docProject,
  hubUrl,
  categoryUrl,
} from "./projects";
import { getManifestSync, localeForPage, titleFor } from "./manifest";

/**
 * Docs navigation (contract §4, design spec §3/§5): the sidebar domain
 * «Документация» opens into THREE project groups (categories inside), plus
 * the special-case crumbs for `/docs/*`. Pure data over the (possibly not
 * yet hydrated) manifest — `navItems.ts` imports from here, so this file
 * must never import layout components back (no cycle).
 */

export const DOCS_DOMAIN: NavDomain = {
  to: "/docs",
  // /docs is a redirect to the default hub (spec §2) — the domain link goes
  // straight to the section root, like /agents and /system.
  linkTo: hubUrl(DEFAULT_PROJECT),
  key: "nav.docs",
  icon: BookOpen,
  // Sections are RENDERED by DocsSidebarGroups (projects → categories): a
  // third layer specific to this domain, not expressible as NavSection[].
};

const DOCS_CRUMB: Crumb = { to: hubUrl(DEFAULT_PROJECT), key: "nav.docs" };

/** Where a /docs pathname sits, derived from the (hydrated) manifest. */
export interface DocsLocation {
  /** Active project (default when the pathname carries none or a legacy one). */
  project: string;
  /** Category slug when the pathname is a category page or an article of one. */
  category: string | null;
  /** Page slug when the pathname resolves to a manifest page. */
  slug: string | null;
}

/** The project segment of a /docs pathname (default for legacy/short paths). */
export function docsActiveProject(pathname: string): string {
  return parseDocsPath(pathname).project;
}

/** Article slug for a project-scoped pathname (ours stay single-segment). */
export function docSlugForPath(project: string, rest: string): string | null {
  if (!docProject(project)) return null;
  return project === DEFAULT_PROJECT ? rest : `${project}/${rest}`;
}

/**
 * Split a /docs pathname into hub project + remaining path. The FIRST
 * segment is the project only when it names one; a legacy single-segment URL
 * (`/docs/upgrade`) therefore lands whole in `rest` — of the DEFAULT
 * project's namespace, where the redirect map expects it (spec §8).
 */
function parseDocsPath(pathname: string): { project: string; rest: string } {
  const segments = /^\/docs\/?(.*)$/.exec(pathname)?.[1]?.split("/") ?? [];
  const first = segments[0];
  if (first !== undefined && docProject(first)) {
    return { project: first, rest: segments.slice(1).join("/") };
  }
  return { project: DEFAULT_PROJECT, rest: segments.join("/") };
}

/**
 * Sidebar/crumb context for a /docs pathname. Everything derives from the
 * pathname + manifest — no JS state (design spec §3.2). Before hydration
 * only the exact hub/category shapes resolve; articles resolve once the
 * manifest lands.
 */
export function docsLocationFor(pathname: string): DocsLocation {
  const { project, rest } = parseDocsPath(pathname);
  const categoryMatch = /^c\/([^/]+)$/.exec(rest);
  if (categoryMatch) {
    return { project, category: categoryMatch[1], slug: null };
  }
  if (rest !== "") {
    const slug = docSlugForPath(project, rest);
    const page =
      slug !== null
        ? getManifestSync()?.pages.find((candidate) => candidate.slug === slug)
        : undefined;
    if (page) return { project, category: page.category, slug: page.slug };
  }
  return { project, category: null, slug: null };
}

/**
 * Breadcrumbs for /docs/* (design spec §5): imported article = 4 levels
 * (Документация → Проект → Категория → страница); vesmaro-eyes = 3 (the
 * default project is eliminated — «Документация» already points at its hub).
 * Hubs: vesmaro-eyes has NO trail (section root), other projects get
 * Документация → Проект. Unknown slugs keep a trail (the not-found page).
 */
export function docsCrumbsFor(pathname: string): Crumb[] {
  // The section root is trail-free — and /docs itself redirects there.
  if (pathname === "/docs" || pathname === hubUrl(DEFAULT_PROJECT)) return [];

  const { project, rest } = parseDocsPath(pathname);
  const projectMeta = docProject(project);

  // Hub covers: known project → Документация → Проект (default: no trail).
  if (rest === "") {
    if (project === DEFAULT_PROJECT) return [];
    return [DOCS_CRUMB, { to: hubUrl(project), label: projectMeta?.name ?? project }];
  }

  const projectCrumb: Crumb[] =
    projectMeta && project !== DEFAULT_PROJECT
      ? [{ to: hubUrl(project), label: projectMeta.name }]
      : [];

  // Category page (project-scoped; `/docs/c/<cat>` rides the same shape).
  const categoryMatch = /^c\/([^/]+)$/.exec(rest);
  if (categoryMatch) {
    const category = docCategory(categoryMatch[1]);
    return [
      DOCS_CRUMB,
      ...projectCrumb,
      category ? { key: category.titleKey } : { label: categoryMatch[1] },
    ];
  }

  // Article: slug → manifest → category crumb + content title.
  const slug = docSlugForPath(project, rest);
  const page =
    slug !== null
      ? getManifestSync()?.pages.find((candidate) => candidate.slug === slug)
      : undefined;
  if (page) {
    const category = docCategory(page.category);
    return [
      DOCS_CRUMB,
      ...projectCrumb,
      category
        ? { to: categoryUrl(project, category.slug), key: category.titleKey }
        : DOCS_CRUMB,
      { label: titleFor(page, localeForPage(page, "ru" satisfies Lang)) },
    ];
  }
  // Unknown slug (legacy miss frame): keep the trail honest.
  return [DOCS_CRUMB, ...projectCrumb, { label: rest }];
}

/** Flattened reading order behind prev/next (project → category → page). */
export function docsReadingOrderSlugs(): string[] {
  return (getManifestSync()?.pages ?? []).map((page) => page.slug);
}
