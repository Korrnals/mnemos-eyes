import { BookOpen } from "lucide-react";
import type { Crumb, NavDomain } from "@/layout/navItems";
import type { Lang } from "@/i18n";
import { docCategoriesSorted, docCategory } from "./categories";
import { getManifestSync, titleFor } from "./manifest";

/**
 * Docs navigation (contract §4): the sidebar domain «Документация» with one
 * section per category, plus the special-case crumbs / section-matching for
 * `/docs/*`. Pure data over the (possibly not yet hydrated) manifest —
 * `navItems.ts` imports from here, so this file must never import layout
 * components back (no cycle).
 */

export const DOCS_DOMAIN: NavDomain = {
  to: "/docs",
  key: "nav.docs",
  icon: BookOpen,
  sections: docCategoriesSorted().map((category) => ({
    to: `/docs/c/${category.slug}`,
    key: category.titleKey,
    icon: category.icon,
    end: true,
  })),
};

const DOCS_CRUMB: Crumb = { to: "/docs", key: "nav.docs" };

/**
 * Breadcrumbs for /docs/*. The /docs index intentionally has NO trail
 * (design spec §3 — section root, like «Обзор»). Article titles are content
 * (not dictionary keys), so they ride the crumb `label` channel; v1 corpus
 * is ru-only, which keeps the label language-neutral in practice.
 */
export function docsCrumbsFor(pathname: string): Crumb[] {
  // The index is a section root — no trail (design spec §3, like «Обзор»).
  if (pathname === "/docs") return [];
  const categoryMatch = /^\/docs\/c\/([^/]+)$/.exec(pathname);
  if (categoryMatch) {
    const category = docCategory(categoryMatch[1]);
    return [
      DOCS_CRUMB,
      category ? { key: category.titleKey } : { label: categoryMatch[1] },
    ];
  }
  const articleMatch = /^\/docs\/([^/]+)$/.exec(pathname);
  if (articleMatch) {
    const page = getManifestSync()?.pages.find(
      (candidate) => candidate.slug === articleMatch[1],
    );
    if (!page) {
      // Unknown slug (the not-found page keeps its trail — spec §10).
      return [DOCS_CRUMB, { label: articleMatch[1] }];
    }
    const category = docCategory(page.category);
    return [
      DOCS_CRUMB,
      category
        ? { to: `/docs/c/${category.slug}`, key: category.titleKey }
        : DOCS_CRUMB,
      { label: titleFor(page, "ru" satisfies Lang) },
    ];
  }
  return [DOCS_CRUMB];
}

/**
 * Sidebar section activity for the docs domain (design spec §2): the BASE
 * prefix match cannot know that an article belongs to a category, so
 * `/docs/<slug>` must light the section of ITS category (via the manifest;
 * unhydrated manifest = no false positives, only the exact path matches).
 */
export function isDocsSectionActive(pathname: string, sectionTo: string): boolean {
  if (pathname === sectionTo) return true;
  if (!/^\/docs\/[^/]+$/.test(pathname)) return false;
  const slug = pathname.slice("/docs/".length);
  const page = getManifestSync()?.pages.find((candidate) => candidate.slug === slug);
  return page !== undefined && sectionTo === `/docs/c/${page.category}`;
}

/** Flattened reading order behind prev/next (categories, then pages). */
export function docsReadingOrderSlugs(): string[] {
  return (getManifestSync()?.pages ?? []).map((page) => page.slug);
}
