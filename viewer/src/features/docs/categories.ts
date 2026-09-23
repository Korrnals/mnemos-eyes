import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Boxes,
  HelpCircle,
  KanbanSquare,
  Lightbulb,
  Rocket,
  ServerCog,
  Share2,
  ShieldCheck,
  Smartphone,
  User,
  Wrench,
  Workflow,
} from "lucide-react";
import type { TranslationKey } from "@/i18n";
import { DEFAULT_PROJECT } from "./projects";

/**
 * Docs categories (contract §5/§4): the ONE static registry. Sidebar groups,
 * hub rows, category pages and search all consume the same entries, so names
 * can never diverge (design spec §3.1 — единый источник ключей `docs.cat.*`).
 * Every category belongs to ONE project hub (contract §4: категории импорта
 * носят префикс-слаги — no collisions with the nine vesmaro-eyes ones).
 */
export interface DocCategory {
  slug: string;
  /** Owning hub project. */
  project: string;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
  icon: LucideIcon;
  /** Display order (global; reading order groups by project first). */
  order: number;
}

export const DOC_CATEGORIES: readonly DocCategory[] = [
  // --- vesmaro-eyes (the 9 existing — migrate into the default hub) ---------
  {
    slug: "product",
    project: DEFAULT_PROJECT,
    titleKey: "docs.cat.product",
    descriptionKey: "docs.catDesc.product",
    icon: Lightbulb,
    order: 0,
  },
  {
    slug: "getting-started",
    project: DEFAULT_PROJECT,
    titleKey: "docs.cat.gettingStarted",
    descriptionKey: "docs.catDesc.gettingStarted",
    icon: Rocket,
    order: 1,
  },
  {
    slug: "board",
    project: DEFAULT_PROJECT,
    titleKey: "docs.cat.board",
    descriptionKey: "docs.catDesc.board",
    icon: KanbanSquare,
    order: 2,
  },
  {
    slug: "agents",
    project: DEFAULT_PROJECT,
    titleKey: "docs.cat.agents",
    descriptionKey: "docs.catDesc.agents",
    icon: Bot,
    order: 3,
  },
  {
    slug: "automation",
    project: DEFAULT_PROJECT,
    titleKey: "docs.cat.automation",
    descriptionKey: "docs.catDesc.automation",
    icon: Workflow,
    order: 4,
  },
  {
    slug: "devices",
    project: DEFAULT_PROJECT,
    titleKey: "docs.cat.devices",
    descriptionKey: "docs.catDesc.devices",
    icon: Smartphone,
    order: 5,
  },
  {
    slug: "security",
    project: DEFAULT_PROJECT,
    titleKey: "docs.cat.security",
    descriptionKey: "docs.catDesc.security",
    icon: ShieldCheck,
    order: 6,
  },
  {
    slug: "maintenance",
    project: DEFAULT_PROJECT,
    titleKey: "docs.cat.maintenance",
    descriptionKey: "docs.catDesc.maintenance",
    icon: Wrench,
    order: 7,
  },
  {
    slug: "faq",
    project: DEFAULT_PROJECT,
    titleKey: "docs.cat.faq",
    descriptionKey: "docs.catDesc.faq",
    icon: HelpCircle,
    order: 8,
  },
  // --- imported hubs (contract §4: префикс-слаги, no vesmaro-eyes clashes) --
  {
    slug: "mnemos-user",
    project: "mnemos",
    titleKey: "docs.cat.mnemosUser",
    descriptionKey: "docs.catDesc.mnemosUser",
    icon: User,
    order: 9,
  },
  {
    slug: "mnemos-admin",
    project: "mnemos",
    titleKey: "docs.cat.mnemosAdmin",
    descriptionKey: "docs.catDesc.mnemosAdmin",
    icon: ShieldCheck,
    order: 10,
  },
  {
    slug: "mnemos-architecture",
    project: "mnemos",
    titleKey: "docs.cat.mnemosArchitecture",
    descriptionKey: "docs.catDesc.mnemosArchitecture",
    icon: Boxes,
    order: 11,
  },
  {
    slug: "mesh-user",
    project: "mnemos-mesh",
    titleKey: "docs.cat.meshUser",
    descriptionKey: "docs.catDesc.meshUser",
    icon: Share2,
    order: 12,
  },
  {
    slug: "mesh-admin",
    project: "mnemos-mesh",
    titleKey: "docs.cat.meshAdmin",
    descriptionKey: "docs.catDesc.meshAdmin",
    icon: ServerCog,
    order: 13,
  },
];

/** Static lookup; null for unknown category slugs (content-side typo). */
export function docCategory(slug: string | undefined): DocCategory | null {
  return DOC_CATEGORIES.find((category) => category.slug === slug) ?? null;
}

/** Sorted by the declared display order (contract §5 table order). */
export function docCategoriesSorted(): readonly DocCategory[] {
  return [...DOC_CATEGORIES].sort((a, b) => a.order - b.order);
}

/** The categories of ONE project hub, in display order. */
export function docCategoriesForProject(project: string): readonly DocCategory[] {
  return docCategoriesSorted().filter((category) => category.project === project);
}
