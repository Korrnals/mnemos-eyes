import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Architecture gates (contract §9.4/§9.5), enforced mechanically:
 * 1. `features/docs` never imports `gateway/*` — the docs domain is a
 *    pure-frontend surface, backend-independent by design.
 * 2. react-markdown has ONE import site — `Markdown.tsx` (the single
 *    sanitization story lives there, not scattered across the feature).
 */

const DOCS_DIR = join(import.meta.dirname);

function listSources(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__fixtures__") continue; // content, not code
      files.push(...listSources(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

describe("docs feature architecture gates", () => {
  const sources = listSources(DOCS_DIR);

  it("imports nothing from gateway/*", () => {
    expect(sources.length, "sanity: real code scanned").toBeGreaterThan(5);
    const offenders = sources.filter((file) =>
      /from\s+["'][^"']*gateway\//.test(readFileSync(file, "utf8")),
    );
    expect(
      offenders.map((file) => file.replace(`${DOCS_DIR}/`, "")),
      "gateway/* imports found in features/docs",
    ).toEqual([]);
  });

  it("keeps react-markdown in exactly one module (Markdown.tsx)", () => {
    const offenders = sources.filter(
      (file) =>
        !file.endsWith("Markdown.tsx") &&
        /from\s+["']react-markdown["']/.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((file) => file.replace(`${DOCS_DIR}/`, ""))).toEqual([]);
  });
});
