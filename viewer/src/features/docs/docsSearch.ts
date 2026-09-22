import type { Lang } from "@/i18n";
import { getManifest, stripLeadingH1, titleFor } from "./manifest";
import { loadMarkdown, type DocLocale } from "./markdownModules";

/**
 * Docs search v1 (contract §7): a client-side index over the ACTIVE locale,
 * built lazily on the first /docs open. Tokenization on non-letter bounds
 * (RU+EN), PREFIX matching («токен» finds «токена», «tokens»), ranking
 * title > h2/h3 > body. No external services.
 */

export interface SearchHit {
  slug: string;
  title: string;
  category: string;
  snippet: string;
  /** 3 = title match, 2 = heading match, 1 = body match. */
  score: number;
}

export interface DocsSearchIndex {
  lang: Lang;
  entries: SearchEntry[];
}

interface SearchEntry {
  slug: string;
  title: string;
  category: string;
  titleTokens: string[];
  headingTokens: string[];
  bodyText: string;
  bodyTokens: string[];
}

/** Split on every non letter/number bound (unicode-aware, RU+EN). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== "");
}

function matchesAll(haystack: string[], needles: string[]): boolean {
  return needles.every((needle) =>
    haystack.some((candidate) => candidate.startsWith(needle)),
  );
}

/** Plain-text projection of a page body (for snippets + body tokens). */
function bodyToText(body: string): string {
  return stripLeadingH1(body)
    .replace(/```[a-z]*\n?/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[|>`*_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const indexCache = new Map<Lang, Promise<DocsSearchIndex>>();

/** Lazy index for a UI locale: en reads the en corpus, ru the ru corpus. */
export function loadSearchIndex(lang: Lang): Promise<DocsSearchIndex> {
  const cached = indexCache.get(lang);
  if (cached) return cached;
  const building = (async (): Promise<DocsSearchIndex> => {
    const manifest = await getManifest();
    const entries = await Promise.all(
      manifest.pages
        .filter((page) => page.locales.includes(lang as DocLocale))
        .map(async (page) => {
          const raw = await loadMarkdown(page.slug, lang as DocLocale);
          if (raw === undefined) return null;
          const bodyText = bodyToText(
            stripLeadingH1(raw.replace(/^---[\s\S]*?\n---\n/, "")),
          );
          const headings = [...raw.matchAll(/^#{2,3}\s+(.+)$/gm)]
            .map((match) => match[1])
            .join(" ");
          return {
            slug: page.slug,
            title: titleFor(page, lang),
            category: page.category,
            titleTokens: tokenize(titleFor(page, lang)),
            headingTokens: tokenize(headings),
            bodyText,
            bodyTokens: tokenize(bodyText),
          } satisfies SearchEntry;
        }),
    );
    return { lang, entries: entries.filter((entry) => entry !== null) };
  })();
  indexCache.set(lang, building);
  return building;
}

/** Body window around the first token match — the result snippet. */
export function findSnippet(bodyText: string, tokens: string[], radius = 70): string {
  if (tokens.length === 0 || bodyText === "") return "";
  const words = [...bodyText.matchAll(/\S+/g)];
  for (const word of words) {
    const lower = word[0].toLowerCase();
    if (tokens.some((token) => lower.startsWith(token))) {
      const start = Math.max(0, word.index - radius);
      const end = Math.min(bodyText.length, word.index + word[0].length + radius);
      return `${start > 0 ? "…" : ""}${bodyText.slice(start, end).trim()}${
        end < bodyText.length ? "…" : ""
      }`;
    }
  }
  return bodyText.slice(0, radius * 2).trim();
}

/**
 * Ranked prefix search. A page matches when EVERY query token prefix-matches
 * inside ONE field; the deepest matching field sets the score (title beats
 * headings beats body — contract §7).
 */
export function searchDocs(
  index: DocsSearchIndex,
  query: string,
  limit = 8,
): SearchHit[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const entry of index.entries) {
    let score = 0;
    if (matchesAll(entry.titleTokens, tokens)) score = 3;
    else if (matchesAll(entry.headingTokens, tokens)) score = 2;
    else if (matchesAll(entry.bodyTokens, tokens)) score = 1;
    if (score === 0) continue;
    hits.push({
      slug: entry.slug,
      title: entry.title,
      category: entry.category,
      snippet: score === 1 ? findSnippet(entry.bodyText, tokens) : "",
      score,
    });
  }
  return hits
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.title.localeCompare(b.title, index.lang === "ru" ? "ru" : "en"),
    )
    .slice(0, limit);
}

/**
 * Split text into hit/miss segments for <mark> highlighting (spec §8):
 * a word is a hit when it starts with any query token (prefix rule).
 */
export interface HighlightSegment {
  text: string;
  hit: boolean;
}

export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [{ text, hit: false }];
  const segments: HighlightSegment[] = [];
  const words = [...text.matchAll(/\S+/g)];
  let cursor = 0;
  for (const word of words) {
    const start = word.index;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), hit: false });
    const hit = tokens.some((token) => word[0].toLowerCase().startsWith(token));
    segments.push({ text: text.slice(start, start + word[0].length), hit });
    cursor = start + word[0].length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments;
}

// --- zero-result log (contract §7: localStorage, last 50) ------------------------

export const ZERO_RESULTS_KEY = "docs.search.zeroResults";
const ZERO_RESULTS_LIMIT = 50;

/** Zero-result queries, oldest first (empty when storage is unavailable). */
export function readZeroResults(): string[] {
  try {
    const raw = localStorage.getItem(ZERO_RESULTS_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/** Append a zero-result query; storage failures are non-fatal. */
export function logZeroResult(query: string): void {
  try {
    const next = [...readZeroResults(), query].slice(-ZERO_RESULTS_LIMIT);
    localStorage.setItem(ZERO_RESULTS_KEY, JSON.stringify(next));
  } catch {
    // private mode / disabled storage — the UI never depends on the log
  }
}
