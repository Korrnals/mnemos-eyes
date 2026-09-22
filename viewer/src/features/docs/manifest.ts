import { useSyncExternalStore } from "react";
import { DOC_CATEGORIES, docCategory } from "./categories";
import {
  docModuleEntries,
  loadMarkdown,
  parseDocPath,
  type DocLocale,
} from "./markdownModules";
import type { Lang } from "@/i18n";

/**
 * Docs manifest (contract §3): frontmatter of every content file, parsed on
 * first request. Loading stays LAZY (the glob is not eager — budget §10):
 * the first /docs mount kicks one round of dynamic md-chunk fetches, then
 * everything is cached. Broken or incomplete frontmatter is reported via
 * console.error and the page is excluded — the app never falls over on
 * content (contract §3).
 */

export interface DocPage {
  slug: string;
  /** Per-locale titles; the fallback chain lives in `titleFor`. */
  titles: Partial<Record<DocLocale, string>>;
  category: string;
  order: number;
  lastVerified: string;
  /** Locales this page is published in (contract §6 — from day one). */
  locales: DocLocale[];
}

export interface DocsManifest {
  /** Valid pages sorted by category order → page order. */
  pages: DocPage[];
}

export interface ParsedDoc {
  fields: Record<string, string>;
  body: string;
}

const REQUIRED_FIELDS = [
  "title",
  "slug",
  "category",
  "order",
  "last_verified",
] as const;

/**
 * Minimal frontmatter reader (no gray-matter dependency — contract): a
 * leading `---` block of simple `key: value` lines. Returns null when the
 * delimiters or the shape are wrong; values keep quotes stripped.
 */
export function parseFrontmatter(raw: string): ParsedDoc | null {
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return null;
  const block = raw.slice(3, end).trim();
  const fields: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const sep = trimmed.indexOf(":");
    if (sep <= 0) return null; // not a `key: value` line — malformed
    const key = trimmed.slice(0, sep).trim();
    const value = trimmed.slice(sep + 1).trim();
    if (!key || value === "") return null;
    fields[key] = value.replace(/^["']|["']$/g, "");
  }
  return { fields, body: raw.slice(raw.indexOf("\n", end + 1) + 1) };
}

/**
 * The page h1 is rendered from frontmatter (design spec §6: «h1 … вне
 * md-тела»), so the corpus convention of starting the body with `# Title`
 * is stripped before rendering — one h1 per page (WCAG 1.3.1).
 */
export function stripLeadingH1(body: string): string {
  return body.replace(/^\s*#\s+[^\n]*\n+/, "").trimStart();
}

/** First non-empty paragraph of a body — the category-row description. */
export function firstParagraph(body: string): string {
  const plain = stripLeadingH1(body)
    // Fence contents are code, not prose — drop whole fenced blocks.
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/```[\s\S]*$/g, " ");
  for (const block of plain.split(/\n\s*\n/)) {
    const text = block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .join(" ")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[`*_]/g, "")
      .trim();
    if (text !== "") return text;
  }
  return "";
}

/** Title in the UI language, falling back to ru, then to any locale. */
export function titleFor(page: DocPage, lang: Lang): string {
  return (
    page.titles[lang] ?? page.titles.ru ?? Object.values(page.titles)[0] ?? page.slug
  );
}

/**
 * Locale policy (contract §6): UI=ru always reads the ru file; UI=en reads
 * the en file when published, else falls back to ru (the UI shows the
 * locale badge — DocsPage owns that).
 */
export function localeForPage(page: DocPage, lang: Lang): DocLocale {
  return page.locales.includes(lang) ? (lang as DocLocale) : "ru";
}

function requireNumber(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  return Number(value);
}

/**
 * Build the manifest from every content file. Invalid files are announced
 * and skipped (never thrown): docs render is content-tolerant by contract.
 */
async function buildManifest(): Promise<DocsManifest> {
  const bySlug = new Map<string, { page: DocPage; path: string }>();

  await Promise.all(
    docModuleEntries().map(async ([path, load]) => {
      const parsedPath = parseDocPath(path);
      if (!parsedPath) {
        console.error(`[docs] ${path}: file outside content/<locale>/ layout, skipped`);
        return;
      }
      const { slug, locale } = parsedPath;
      let raw: string;
      try {
        raw = await load();
      } catch (error) {
        console.error(`[docs] ${path}: failed to load chunk`, error);
        return;
      }
      const parsed = parseFrontmatter(raw);
      if (!parsed) {
        console.error(`[docs] ${path}: malformed frontmatter, page excluded`);
        return;
      }
      const { fields } = parsed;
      const missing = REQUIRED_FIELDS.filter((key) => !fields[key]);
      if (missing.length > 0) {
        console.error(
          `[docs] ${path}: missing fields ${missing.join(", ")}, page excluded`,
        );
        return;
      }
      if (fields.slug !== slug) {
        console.error(
          `[docs] ${path}: frontmatter slug "${fields.slug}" != file name "${slug}", page excluded`,
        );
        return;
      }
      if (!docCategory(fields.category)) {
        console.error(
          `[docs] ${path}: unknown category "${fields.category}", page excluded`,
        );
        return;
      }
      const order = requireNumber(fields.order);
      if (order === null) {
        console.error(`[docs] ${path}: order must be an integer, page excluded`);
        return;
      }
      const existing = bySlug.get(slug);
      if (existing) {
        existing.page.titles[locale] = fields.title;
        existing.page.locales.push(locale);
        return;
      }
      bySlug.set(slug, {
        path,
        page: {
          slug,
          titles: { [locale]: fields.title },
          category: fields.category,
          order,
          lastVerified: fields.last_verified,
          locales: [locale],
        },
      });
    }),
  );

  const categoryOrder = new Map(
    DOC_CATEGORIES.map((category) => [category.slug, category.order]),
  );
  const pages = [...bySlug.values()]
    .map(({ page }) => page)
    .sort((a, b) => {
      const catDelta =
        (categoryOrder.get(a.category) ?? Number.MAX_SAFE_INTEGER) -
        (categoryOrder.get(b.category) ?? Number.MAX_SAFE_INTEGER);
      return catDelta !== 0
        ? catDelta
        : a.order - b.order || a.slug.localeCompare(b.slug);
    });
  return { pages };
}

// --- lazy singleton + subscription (crumbs react to hydration) -------------------

let manifestPromise: Promise<DocsManifest> | null = null;
let manifestSync: DocsManifest | null = null;
const listeners = new Set<() => void>();

/** Kick (once) and await the manifest build. */
export function getManifest(): Promise<DocsManifest> {
  manifestPromise ??= buildManifest().then((manifest) => {
    manifestSync = manifest;
    for (const notify of listeners) notify();
    return manifest;
  });
  return manifestPromise;
}

/**
 * Synchronous access for pure helpers (crumbsFor, sidebar section match).
 * null until the first getManifest() resolves — the /docs pages hydrate it
 * on mount, so pre-hydration trails simply carry less detail.
 */
export function getManifestSync(): DocsManifest | null {
  return manifestSync;
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

/**
 * React binding over the lazy manifest: null while loading, the manifest
 * once hydrated. Mounting this hook kicks the build ONLY when `enabled`
 * (the /docs pages and the Shell crumb subscription pass their pathname
 * gate) — subscribing from anywhere else must not download the corpus
 * (budget §10: the md chunks stay lazy until the docs section opens).
 */
export function useDocsManifest(enabled = true): DocsManifest | null {
  // Same snapshot on the server: renderToString has no store subscriptions.
  useSyncExternalStore(subscribe, getManifestSync, getManifestSync);
  if (enabled) void getManifest();
  return manifestSync;
}

/** Find one page by slug (route param → manifest). */
export function findDocPage(slug: string | undefined): DocPage | null {
  if (!slug) return null;
  return getManifestSync()?.pages.find((page) => page.slug === slug) ?? null;
}

/** Load the renderable body of a page in its effective locale. */
export async function loadDocBody(
  slug: string,
  lang: Lang,
): Promise<{ page: DocPage; body: string } | null> {
  const manifest = await getManifest();
  const page = manifest.pages.find((candidate) => candidate.slug === slug);
  if (!page) return null;
  const raw = await loadMarkdown(slug, localeForPage(page, lang));
  if (raw === undefined) return null;
  const parsed = parseFrontmatter(raw);
  if (!parsed) return null; // excluded upstream as well — stay consistent
  return { page, body: stripLeadingH1(parsed.body) };
}
