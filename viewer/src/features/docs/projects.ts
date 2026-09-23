import type { LucideIcon } from "lucide-react";
import { Brain, KanbanSquare, Network } from "lucide-react";
import type { TranslationKey } from "@/i18n";

/**
 * Docs projects (contract §4, design spec §1.3/§2): the /docs section hosts
 * THREE project hubs. The project name is the first URL segment and the slug
 * prefix of every imported page — a brand string, deliberately untranslated
 * (spec §2). vesmaro-eyes is the DEFAULT project: its pages keep their
 * unprefixed slugs (`tokens`), its hub is the section root, and old
 * `/docs/<slug>` URLs redirect into it.
 */

export const DEFAULT_PROJECT = "vesmaro-eyes";

export interface DocProject {
  /** URL segment + slug prefix (brand, lowercase). */
  slug: string;
  /** Display name on hubs/groups/crumbs — brand spelling, no i18n. */
  name: string;
  icon: LucideIcon;
  /** true → imported corpus: provenance badges apply (contract §4). */
  upstream: boolean;
  /** Sidebar/hub/reading order (vesmaro-eyes first — the section root). */
  order: number;
  /** One-line hub intro — chrome copy owned here, NOT upstream content. */
  ledeKey: TranslationKey;
  /** Curated «с чего начать» slugs (L3 layer, contract §2 — survives re-syncs). */
  startSlugs: readonly string[];
}

export const DOC_PROJECTS: readonly DocProject[] = [
  {
    slug: "vesmaro-eyes",
    name: "vesmaro-eyes",
    icon: KanbanSquare,
    upstream: false,
    order: 0,
    ledeKey: "docs.hub.vesmaroEyes.lede",
    startSlugs: ["first-login", "groups-kanban", "faq"],
  },
  {
    slug: "mnemos",
    name: "Mnemos",
    icon: Brain,
    upstream: true,
    order: 1,
    ledeKey: "docs.hub.mnemos.lede",
    startSlugs: [
      "mnemos/user/getting-started",
      "mnemos/user/integration-guide",
      "mnemos/user/tag-contract",
    ],
  },
  {
    slug: "mnemos-mesh",
    name: "mnemos-mesh",
    icon: Network,
    upstream: true,
    order: 2,
    ledeKey: "docs.hub.mnemosMesh.lede",
    startSlugs: [
      "mnemos-mesh/user/getting-started",
      "mnemos-mesh/user/configuration",
    ],
  },
];

/** Static lookup; null for anything that is not a project segment. */
export function docProject(slug: string | undefined): DocProject | null {
  return DOC_PROJECTS.find((project) => project.slug === slug) ?? null;
}

/** Sorted by the declared display order. */
export function docProjectsSorted(): readonly DocProject[] {
  return [...DOC_PROJECTS].sort((a, b) => a.order - b.order);
}

/**
 * The project owning a page slug: the prefix before the first `/` when it
 * names a project, else the default (vesmaro-eyes pages have bare slugs).
 */
export function projectOfDocSlug(slug: string): string {
  const slash = slug.indexOf("/");
  if (slash > 0 && docProject(slug.slice(0, slash))) return slug.slice(0, slash);
  return DEFAULT_PROJECT;
}

/** App-relative URL of a page from its manifest slug (`tokens` → /docs/vesmaro-eyes/tokens). */
export function docUrl(slug: string): string {
  const project = projectOfDocSlug(slug);
  const rest = project === DEFAULT_PROJECT ? slug : slug.slice(project.length + 1);
  return `/docs/${project}/${rest}`;
}

/** Hub cover URL (`/docs/<project>`). */
export function hubUrl(project: string): string {
  return `/docs/${project}`;
}

/** Project-scoped category URL (`/docs/<project>/c/<category>`). */
export function categoryUrl(project: string, category: string): string {
  return `/docs/${project}/c/${category}`;
}
