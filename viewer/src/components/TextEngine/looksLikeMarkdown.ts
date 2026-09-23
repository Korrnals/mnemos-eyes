/**
 * Markdown-syntax heuristic for the TextEngine auto-detect (UI-27).
 *
 * The engine's contract: author text that carries NO markdown syntax takes
 * the plain path — zero render cost, zero distortion (the exact legacy
 * pre-wrap output). Only text that LOOKS like markdown pays for the parser.
 * So the heuristic must be cheap (linear regex scan) and biased against
 * false positives that would mangle plain prose.
 *
 * Deliberate traps avoided:
 * - `#tag` hashtags: an ATX heading REQUIRES a space after the run of `#`.
 * - `2*3*4` arithmetic: `**strong**` requires a non-`*` run between the
 *   markers; single `*em*` is NOT detected at all (too ambiguous in prose).
 * - `2026-09-23` dates: an ordered list requires digit + `.`/`)` + space.
 * - `–`/`—` prose dashes: a bullet requires `-`/`*`/`+` + space, so em-dash
 *   lines never match.
 *
 * False-negative cost is the status quo (raw text shown); false-positive
 * cost is a slightly reformatted paragraph — both acceptable, detection
 * may stay aggressive but never ambiguous.
 */
const MARKDOWN_PATTERNS: readonly RegExp[] = [
  /```/, // fenced code block (``` or ~~~ not distinguished — fences win)
  /^[ \t]{0,3}#{1,6}\s+\S/m, // ATX heading — space after the hashes is mandatory
  /^[ \t]{0,3}[-*+]\s+\S/m, // bullet list item
  /^[ \t]{0,3}\d+[.)]\s+\S/m, // ordered list item
  /\*\*[^*\n]+\*\*/, // **strong**
  /(^|\s)__[^_\n]+__(\s|$|[.,;:!?)])/m, // __strong__ (word-bounded)
  /`[^`\n]+`/, // `inline code`
  /^[ \t]{0,3}>[ \t]\S/m, // blockquote
  /^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/m, // thematic break (---)
  /^[ \t]{0,3}\|.+\|[ \t]*$/m, // table row — a line that starts AND ends with |
  /\[[^\]\n]+\]\([^)\n]+\)/, // [link](url)
  /~~[^~\n]+~~/, // ~~strikethrough~~
];

/** True when `text` carries at least one markdown-syntax signature. */
export function looksLikeMarkdown(text: string | null | undefined): boolean {
  if (!text || text.length === 0) return false;
  return MARKDOWN_PATTERNS.some((pattern) => pattern.test(text));
}
