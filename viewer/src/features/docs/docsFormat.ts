import type { Lang, TranslateFn } from "@/i18n";

/**
 * Shared docs text formatters (hub covers + category rows — design spec §4.1).
 * Pure string shaping: no React, no manifest access.
 */

/**
 * Page count in words, ru pluralization (the i18n layer has no plural forms).
 * Lives here since the card-grid index is gone — both the hub rows and the
 * category rows consume the same «N страниц» phrase.
 */
export function pagesLabel(lang: Lang, count: number, t: TranslateFn): string {
  if (lang === "ru") {
    const ones = count % 10;
    const tens = count % 100;
    const key =
      ones === 1 && tens !== 11
        ? "docs.pages.one"
        : ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)
          ? "docs.pages.few"
          : "docs.pages.many";
    return t(key, { count });
  }
  return t(count === 1 ? "docs.pages.one" : "docs.pages.many", { count });
}
