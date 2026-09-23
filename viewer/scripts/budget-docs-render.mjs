#!/usr/bin/env node
/**
 * Docs-render budget gate (ADR-0015 as amended by АРХКОМ-8, verdict on
 * SysEng Q2): run AFTER `npm run build`, exits non-zero on any breach.
 *
 *   pipeline pool   dist/assets/docs-render-*.js        ≤ 150 KiB gzip
 *   mermaid pool    mermaid.core chunk + the heaviest    ≤ 450 KiB gzip
 *                   single on-demand branch (diagram
 *                   engines for ONE diagram type)
 *
 * The mermaid library is lazy: its entry must never be statically reachable
 * from index.html or any eagerly-loaded chunk. "Fence-page pool" accounting:
 * a page with diagrams downloads the core chunk (always) plus the diagram
 * engines for ONE diagram type (mermaid lazy-loads per type; no corpus page
 * uses more than one or two). The full on-demand closure (every diagram type
 * at once) is reported as info for ADR-0017.
 *
 * Usage: node scripts/budget-docs-render.mjs [--max-pipeline 150] [--max-mermaid 450]
 */

import { readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = join(root, "dist", "assets");

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index !== -1 ? Number(args[index + 1]) : fallback;
}
const MAX_PIPELINE_KIB = argValue("--max-pipeline", 150);
const MAX_MERMAID_KIB = argValue("--max-mermaid", 450);

const KIB = 1024;
const round1 = (value) => Math.round(value * 10) / 10;

// --- chunk graph ------------------------------------------------------------------
const jsFiles = readdirSync(assetsDir).filter((name) => name.endsWith(".js"));
const chunks = new Map(); // name -> { gzip, raw, static: [], dynamic: [] }
for (const name of jsFiles) {
  const buffer = readFileSync(join(assetsDir, name));
  const source = buffer.toString("utf8");
  const refs = [...source.matchAll(/(?:from|import)\s*\(?\s*["']\.\/([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((target) => jsFiles.includes(target));
  const dynamic = [
    ...source.matchAll(/import\s*\(\s*["']\.\/([^"']+)["']\s*\)/g),
  ].map((match) => match[1]);
  chunks.set(name, {
    gzip: gzipSync(buffer).length / KIB,
    raw: buffer.length / KIB,
    static: refs.filter((target) => !dynamic.includes(target)),
    dynamic: [...new Set(dynamic.filter((target) => jsFiles.includes(target)))],
  });
}
const chunkOf = (name) =>
  chunks.get(name) ?? { gzip: 0, raw: 0, static: [], dynamic: [] };
const sumGzip = (names) =>
  [...names].reduce((sum, name) => sum + chunkOf(name).gzip, 0);

function closure(startNames, includeDynamic) {
  const seen = new Set(startNames);
  const queue = [...startNames];
  while (queue.length > 0) {
    const name = queue.pop();
    const nexts = includeDynamic
      ? [...chunkOf(name).dynamic, ...chunkOf(name).static]
      : chunkOf(name).static;
    for (const next of nexts) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

const report = [];
let failed = false;

// --- eager base set (index.html scripts/preloads + static closure) ----------------
const html = readFileSync(join(root, "dist", "index.html"), "utf8");
const eagerFromHtml = [
  ...html.matchAll(/(?:src|href)="[^"]*assets\/([^"/]+\.js)"/g),
]
  .map((match) => decodeURIComponent(match[1]))
  .filter((name) => jsFiles.includes(name));
const baseSet = closure(eagerFromHtml, false);

// --- pipeline pool ----------------------------------------------------------------
const pipelineChunks = jsFiles.filter((name) => name.startsWith("docs-render-"));
if (pipelineChunks.length === 0) {
  report.push("FAIL docs-render: no chunk found — named pool missing from the build");
  failed = true;
} else {
  const gzip = sumGzip(pipelineChunks);
  const ok = gzip <= MAX_PIPELINE_KIB;
  if (!ok) failed = true;
  report.push(
    `${ok ? "ok  " : "FAIL"} docs-render (render pipeline): ${round1(gzip)} KiB gzip ` +
      `(budget ≤${MAX_PIPELINE_KIB}; ${pipelineChunks.join(", ")})`,
  );
}

// --- mermaid pool -----------------------------------------------------------------
// The mermaid entry keeps its natural chunk name (derived from
// mermaid.core.mjs) — pinning it to a manual chunk merges mermaid's internal
// per-diagram lazy chunks into one mega chunk (measured 735 KiB gzip).
const mermaidEntries = jsFiles.filter((name) => /^mermaid\.core-/.test(name));
if (mermaidEntries.length === 0) {
  report.push("FAIL mermaid: no mermaid.core-* chunk found in dist/assets");
  failed = true;
} else {
  const inBase = mermaidEntries.filter((name) => baseSet.has(name));
  const staticOffenders = [];
  for (const [name, chunk] of chunks) {
    if (mermaidEntries.includes(name) || !baseSet.has(name)) continue;
    if (chunk.static.some((target) => mermaidEntries.includes(target))) {
      staticOffenders.push(name);
    }
  }
  if (html.includes("mermaid")) {
    failed = true;
    report.push("FAIL mermaid chunk is referenced from index.html — it would load eagerly");
  } else if (inBase.length > 0 || staticOffenders.length > 0) {
    failed = true;
    report.push(
      `FAIL mermaid is statically reachable (in base closure: ${inBase.join(", ") || "—"}; ` +
        `static importers: ${staticOffenders.join(", ") || "—"})`,
    );
  } else {
    // Fence-page accounting: core closure (static deps only reachable from
    // it) + the HEAVIEST single on-demand branch = worst realistic page.
    const corePool = closure(mermaidEntries, false);
    for (const name of [...corePool]) {
      if (mermaidEntries.includes(name)) continue; // the entry IS the pool
      if (baseSet.has(name)) corePool.delete(name); // already eager on the page
    }
    const onDemand = new Set([...closure(corePool, true)].filter(
      (name) => !corePool.has(name) && !baseSet.has(name),
    ));
    const coreGzip = sumGzip(corePool);
    const heaviest = [...onDemand].reduce(
      (max, name) => Math.max(max, chunkOf(name).gzip),
      0,
    );
    const pageGzip = coreGzip + heaviest;
    const ok = pageGzip <= MAX_MERMAID_KIB;
    if (!ok) failed = true;
    report.push(
      `${ok ? "ok  " : "FAIL"} docs-mermaid (fence-page pool: core ${round1(coreGzip)} ` +
        `+ heaviest diagram branch ${round1(heaviest)}): ${round1(pageGzip)} KiB gzip ` +
        `(budget ≤${MAX_MERMAID_KIB})`,
    );
    const fullGzip = coreGzip + sumGzip(onDemand);
    const perDiagram = [...onDemand]
      .filter((name) => /Diagram/i.test(name))
      .map((name) => `${name.replace(/-[A-Za-z0-9_-]+\.js$/, "")}=${round1(chunkOf(name).gzip)}`);
    report.push(
      `info mermaid full on-demand closure (all diagram types at once): ${round1(fullGzip)} KiB gzip ` +
        `across ${onDemand.size + corePool.size} chunks; per-diagram: ${perDiagram.slice(0, 12).join(", ")}${perDiagram.length > 12 ? ", …" : ""}`,
    );
  }
}

console.log("docs-render budget (ADR-0015/АРХКОМ-8):");
for (const line of report) console.log("  " + line);
process.exit(failed ? 1 : 0);
