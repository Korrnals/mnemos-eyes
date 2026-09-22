import type { LucideIcon } from "lucide-react";
import {
  Bot,
  HelpCircle,
  KanbanSquare,
  Rocket,
  ShieldCheck,
  Smartphone,
  Wrench,
  Workflow,
} from "lucide-react";
import type { TranslationKey } from "@/i18n";

/**
 * Docs categories (contract §5): the ONE static registry. Sidebar sections,
 * category pages and index cards all consume the same entries, so names can
 * never diverge (design spec §2 — секции сайдбара и страницы читают одни и
 * те же ключи `docs.cat.*`).
 */
export interface DocCategory {
  slug: string;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
  icon: LucideIcon;
  /** Display order (also the flatten order behind prev/next). */
  order: number;
}

export const DOC_CATEGORIES: readonly DocCategory[] = [
  {
    slug: "getting-started",
    titleKey: "docs.cat.gettingStarted",
    descriptionKey: "docs.catDesc.gettingStarted",
    icon: Rocket,
    order: 1,
  },
  {
    slug: "board",
    titleKey: "docs.cat.board",
    descriptionKey: "docs.catDesc.board",
    icon: KanbanSquare,
    order: 2,
  },
  {
    slug: "agents",
    titleKey: "docs.cat.agents",
    descriptionKey: "docs.catDesc.agents",
    icon: Bot,
    order: 3,
  },
  {
    slug: "automation",
    titleKey: "docs.cat.automation",
    descriptionKey: "docs.catDesc.automation",
    icon: Workflow,
    order: 4,
  },
  {
    slug: "devices",
    titleKey: "docs.cat.devices",
    descriptionKey: "docs.catDesc.devices",
    icon: Smartphone,
    order: 5,
  },
  {
    slug: "security",
    titleKey: "docs.cat.security",
    descriptionKey: "docs.catDesc.security",
    icon: ShieldCheck,
    order: 6,
  },
  {
    slug: "maintenance",
    titleKey: "docs.cat.maintenance",
    descriptionKey: "docs.catDesc.maintenance",
    icon: Wrench,
    order: 7,
  },
  {
    slug: "faq",
    titleKey: "docs.cat.faq",
    descriptionKey: "docs.catDesc.faq",
    icon: HelpCircle,
    order: 8,
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
