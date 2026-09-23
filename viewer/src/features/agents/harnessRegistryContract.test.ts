import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The mirror-absence contract (wave 3C, design 2026-09-22 §C): the harness
 * dictionary is LIVE server data — `GET /api/harnesses` — and the former
 * `gateway/harnesses.ts` KNOWN_HARNESSES mirror is DELETED. Two layers:
 *
 * 1. no file under `src/` mentions KNOWN_HARNESSES at all (import or
 *    usage — a reintroduced mirror fails here first);
 * 2. the generated board-openapi snapshot declares the dictionary surface
 *    (HarnessOut + the three /harnesses operations) — the wire the hook
 *    consumes cannot silently vanish from the schema.
 */

const SRC_DIR = fileURLToPath(new URL("../..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const SCHEMA_PATH = fileURLToPath(
  new URL("../../types/board-openapi.d.ts", import.meta.url),
);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe("harness dictionary — mirror absence (wave 3C)", () => {
  it("no src file mentions KNOWN_HARNESSES — the mirror stays dead", () => {
    const offenders = walk(SRC_DIR).filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));
    const hits = offenders
      .filter((file) => file !== SELF) // this contract names the constant to ban it
      .filter((file) => readFileSync(file, "utf-8").includes("KNOWN_HARNESSES"));
    expect(hits, `reintroduced mirror in: ${hits.join(", ")}`).toEqual([]);
  });

  it("the generated schema declares the dictionary wire (HarnessOut + operations)", () => {
    const schema = readFileSync(SCHEMA_PATH, "utf-8");
    expect(schema).toContain("HarnessOut:");
    expect(schema).toContain('"/api/harnesses": {');
    expect(schema).toContain('"/api/harnesses/{name}": {');
    // The dictionary row carries NO secret material by construction; the
    // assertion keeps the exclusion explicit like agentsContract does.
    const block = schema.slice(
      schema.indexOf("HarnessOut: {"),
      schema.indexOf("HarnessListOut: {"),
    );
    expect(block).not.toContain("secret");
  });
});
