import { describe, expect, it } from "vitest";
import { looksLikeMarkdown } from "./looksLikeMarkdown";

/**
 * UI-27 auto-detect gates: markdown syntax flips the TextEngine to the
 * renderer; plain prose (including the false-positive traps) stays on the
 * zero-cost plain path.
 */
describe("looksLikeMarkdown", () => {
  it("detects headings, fences, lists, tables, links, emphasis, quotes", () => {
    expect(looksLikeMarkdown("## Заголовок секции")).toBe(true);
    expect(looksLikeMarkdown("some text\n```js\nconst a = 1;\n```")).toBe(true);
    expect(looksLikeMarkdown("- первый пункт\n- второй пункт")).toBe(true);
    expect(looksLikeMarkdown("1. сделать шаг\n2. повторить")).toBe(true);
    expect(looksLikeMarkdown("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(true);
    expect(looksLikeMarkdown("см. [док](https://example.com)")).toBe(true);
    expect(looksLikeMarkdown("это **важно** для сборки")).toBe(true);
    expect(looksLikeMarkdown("термин ~~удалён~~ из схемы")).toBe(true);
    expect(looksLikeMarkdown("> цитата из отчёта")).toBe(true);
    expect(looksLikeMarkdown("выше\n---\nниже")).toBe(true);
    expect(looksLikeMarkdown("инлайн `npm run build` команда")).toBe(true);
  });

  it("keeps plain prose and common false-positive traps on the plain path", () => {
    expect(looksLikeMarkdown("Простая запись памяти без разметки.")).toBe(false);
    expect(looksLikeMarkdown("Строка с #тегом посередине текста")).toBe(false);
    expect(looksLikeMarkdown("считаем 2*3*4 в уме")).toBe(false);
    expect(looksLikeMarkdown("дата 2026-09-23 в тексте")).toBe(false);
    expect(looksLikeMarkdown("снапшот corpus — снят с борда")).toBe(false);
    expect(looksLikeMarkdown("а также — тире в начале строки тоже текст")).toBe(false);
    expect(looksLikeMarkdown("")).toBe(false);
    expect(looksLikeMarkdown(null)).toBe(false);
    expect(looksLikeMarkdown(undefined)).toBe(false);
  });
});
