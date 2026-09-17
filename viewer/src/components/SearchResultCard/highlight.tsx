import type { ReactNode } from "react";

/**
 * Split `text` into parts, wrapping every case-insensitive occurrence of a
 * query term in a marker object. Pure — the card maps marked parts to
 * `<mark>` elements. Longest-term-first so overlapping terms highlight whole.
 */
export type HighlightPart = { text: string; highlighted: boolean };

export function splitHighlight(text: string, terms: string[]): HighlightPart[] {
  const needles = [...new Set(terms.map((t) => t.trim().toLowerCase()))]
    .filter((t) => t.length > 0)
    .sort((a, b) => b.length - a.length);
  if (needles.length === 0 || !text) return [{ text, highlighted: false }];

  const lower = text.toLowerCase();
  const parts: HighlightPart[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    let nextHit = -1;
    let nextHitLength = 0;
    for (const needle of needles) {
      const at = lower.indexOf(needle, cursor);
      if (at !== -1 && (nextHit === -1 || at < nextHit)) {
        nextHit = at;
        nextHitLength = needle.length;
      }
    }
    if (nextHit === -1) break;
    if (nextHit > cursor) parts.push({ text: text.slice(cursor, nextHit), highlighted: false });
    parts.push({ text: text.slice(nextHit, nextHit + nextHitLength), highlighted: true });
    cursor = nextHit + nextHitLength;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), highlighted: false });
  return parts;
}

/** Render helper mapping the split parts onto plain/mark spans. */
export function highlight(text: string, terms: string[]): ReactNode {
  return splitHighlight(text, terms).map((part, index) =>
    part.highlighted ? (
      <mark key={index} className="rounded-sm bg-iris/15 text-iris-bright">
        {part.text}
      </mark>
    ) : (
      <span key={index}>{part.text}</span>
    ),
  );
}
