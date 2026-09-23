import { useSyncExternalStore } from "react";
import { DOC_CATEGORIES, docCategory } from "./categories";
import { docProjectsSorted, projectOfDocSlug } from "./projects";
import { loadSidecar, type SidecarPage } from "./sidecar";
import {
  docModuleEntries,
  hasMarkdown,
  loadMarkdown,
  parseDocPath,
  type DocLocale,
} from "./markdownModules";
import type { Lang } from "@/i18n";

/**
 * Docs manifest (contract §3/§4): metadata of every page, WITHOUT loading
 * the md bodies. Imported pages come from the generated sidecar (ONE lazy
 * JSON — the perf fix: the first /docs open no longer fetches every chunk);
 * our own pages still read their frontmatter chunks (15 files — the sidecar
 * covers the upstream corpus only, W1a scope). Body loading stays LAZY per
 * slug+locale (budget §10). Broken metadata is reported via console.error
 * and the page is excluded — the app never falls over on content.
 */

export interface DocProvenance {
  repo: string;
  /** Path inside the upstream repository. */
  path: string;
  sha: string;
  /** ISO commit date the corpus was synced at. */
  syncedAt: string;
}

export interface DocPage {
  slug: string;
  /** Owning hub project (`vesmaro-eyes` for our own pages). */
  project: string;
  /** Per-locale titles; the fallback chain lives in `titleFor`. */
  titles: Partial<Record<DocLocale, string>>;
  category: string;
  order: number;
  lastVerified: string;
  /** Locales this page is published in (contract §6). */
  locales: DocLocale[];
  /**
   * The locale the content ORIGINATES in — the fallback target when the UI
   * language is not published (design spec §7.1: «язык оригинала»).
   */
  originalLocale: DocLocale;
  /** Present for imported pages only (sidecar provenance, contract §4). */
  provenance?: DocProvenance;
}

export interface DocsManifest {
  /** Valid pages sorted by project → category → page order. */
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
 * md-тела»), so the body's own h1 is stripped before rendering — one h1 per
 * page (WCAG 1.3.1). Our corpus opens with the h1; imported bodies carry it
 * AFTER the GENERATED comment + curator preamble — so the FIRST ATX h1
 * before any code fence goes (fence-aware: `#` lines inside code are code,
 * never headings).
 */
export function stripLeadingH1(body: string): string {
  const fenceAt = body.search(/^\s*```/m);
  const head = fenceAt === -1 ? body : body.slice(0, fenceAt);
  const headStripped = head.replace(/^#\s+[^\n]*\n+/m, "");
  const stripped =
    fenceAt === -1 ? headStripped : headStripped + body.slice(fenceAt);
  return stripped.trimStart();
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

/** Title in the UI language, falling back to the original, then to any. */
export function titleFor(page: DocPage, lang: Lang): string {
  return (
    page.titles[lang] ??
    page.titles[page.originalLocale] ??
    Object.values(page.titles)[0] ??
    page.slug
  );
}

/**
 * Effective locale of a page under a UI language (contract §6, spec §7.1):
 * the UI language when published, else the page's ORIGINAL language — the
 * badge «на языке оригинала» replaces the old «always ru» fallback.
 */
export function localeForPage(page: DocPage, lang: Lang): DocLocale {
  return page.locales.includes(lang) ? (lang as DocLocale) : page.originalLocale;
}

function requireNumber(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  return Number(value);
}

/** Shape sidecar provenance into the DocPage form; undefined when partial. */
function provenanceOf(entry: SidecarPage): DocProvenance | undefined {
  const raw = entry.provenance;
  if (
    !raw ||
    typeof raw.repo !== "string" ||
    typeof raw.source_path !== "string" ||
    typeof raw.sha !== "string" ||
    typeof raw.commit_date !== "string" ||
    raw.repo === "" ||
    raw.source_path === "" ||
    raw.sha === "" ||
    raw.commit_date === ""
  ) {
    return undefined;
  }
  return {
    repo: raw.repo,
    path: raw.source_path,
    sha: raw.sha,
    syncedAt: raw.commit_date,
  };
}

/**
 * Imported pages from the sidecar (no body fetches). Invalid entries are
 * announced and skipped; a page whose chunk is missing for ANY declared
 * locale is excluded whole — the manifest never promises what cannot load.
 */
function pagesFromSidecar(sidecar: Awaited<ReturnType<typeof loadSidecar>>): Map<string, DocPage> {
  const bySlug = new Map<string, DocPage>();
  if (!sidecar) return bySlug;
  for (const entry of sidecar.pages) {
    if (typeof entry.slug !== "string" || entry.slug === "") {
      console.error("[docs] sidecar entry without a slug, skipped");
      continue;
    }
    const project = projectOfDocSlug(entry.slug);
    if (project === "vesmaro-eyes") {
      console.error(
        `[docs] sidecar slug "${entry.slug}" collides with the default project namespace, skipped`,
      );
      continue;
    }
    const category = docCategory(entry.category);
    if (!category) {
      console.error(
        `[docs] sidecar ${entry.slug}: unknown category "${entry.category}", page excluded`,
      );
      continue;
    }
    const locales = (Array.isArray(entry.locales) ? entry.locales : []).filter(
      (locale): locale is DocLocale => locale === "ru" || locale === "en",
    );
    if (locales.length === 0 || locales.some((locale) => !hasMarkdown(entry.slug, locale))) {
      console.error(
        `[docs] sidecar ${entry.slug}: declared locale without a content file, page excluded`,
      );
      continue;
    }
    const provenance = provenanceOf(entry);
    if (provenance === undefined) {
      // Gate §6.5 (spec §6.2): an imported page without full provenance is a
      // broken import, not a style issue — exclude and say so.
      console.error(
        `[docs] sidecar ${entry.slug}: incomplete provenance, page excluded`,
      );
      continue;
    }
    if (typeof entry.order !== "number") {
      console.error(`[docs] sidecar ${entry.slug}: order must be a number, page excluded`);
      continue;
    }
    bySlug.set(entry.slug, {
      slug: entry.slug,
      project,
      titles: entry.titles ?? {},
      category: category.slug,
      order: entry.order,
      lastVerified: String(entry.lastVerified ?? ""),
      locales,
      originalLocale: locales[0],
      provenance,
    });
  }
  return bySlug;
}

/**
 * Build the manifest: sidecar pages first, then our own pages from their
 * frontmatter chunks. Invalid files are announced and skipped (never
 * thrown): docs render is content-tolerant by contract.
 */
async function buildManifest(): Promise<DocsManifest> {
  const bySlug = pagesFromSidecar(await loadSidecar());

  await Promise.all(
    docModuleEntries().map(async ([path, load]) => {
      const parsedPath = parseDocPath(path);
      if (!parsedPath) {
        console.error(`[docs] ${path}: file outside content/<locale>/ layout, skipped`);
        return;
      }
      // Imported pages take their metadata from the sidecar above — no
      // chunk fetch for them here (the perf fix, contract §4).
      if (parsedPath.project !== undefined) return;
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
        existing.titles[locale] = fields.title;
        existing.locales.push(locale);
        return;
      }
      bySlug.set(slug, {
        slug,
        project: "vesmaro-eyes",
        titles: { [locale]: fields.title },
        category: fields.category,
        order,
        lastVerified: fields.last_verified,
        locales: [locale],
        originalLocale: locale,
      });
    }),
  );

  const projectOrder = new Map(docProjectsSorted().map((p) => [p.slug, p.order]));
  const categoryOrder = new Map(
    DOC_CATEGORIES.map((category) => [category.slug, category.order]),
  );
  const pages = [...bySlug.values()].sort((a, b) => {
    const projectDelta =
      (projectOrder.get(a.project) ?? Number.MAX_SAFE_INTEGER) -
      (projectOrder.get(b.project) ?? Number.MAX_SAFE_INTEGER);
    if (projectDelta !== 0) return projectDelta;
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
 * Synchronous access for pure helpers (crumbsFor, sidebar group matching).
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
