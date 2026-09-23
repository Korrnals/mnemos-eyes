import type { DocLocale } from "./markdownModules";

/**
 * The manifest SIDECAR (contract §4, wave W1a): sync_docs.py emits the
 * frontmatter of every imported page as static JSON — the manifest build
 * reads ONE small file instead of fetching every md chunk (the perf fix the
 * import exists to make). The JSON is lazily imported (its own chunk, fetched
 * only when the docs section opens — budget §10, same discipline as the md
 * chunks). Shape mirrors DocPage metadata plus per-page provenance; the
 * actual bodies stay lazy in markdownModules.
 */

export interface SidecarProvenance {
  repo: string;
  source_path: string;
  sha: string;
  commit_date: string;
}

export interface SidecarPage {
  slug: string;
  titles: Partial<Record<DocLocale, string>>;
  category: string;
  order: number;
  lastVerified: string;
  locales: DocLocale[];
  provenance?: SidecarProvenance;
}

export interface DocsSidecar {
  version: number;
  generated_by: string;
  source_shas: Record<string, string>;
  pages: SidecarPage[];
}

/** The one generated sidecar inside the corpus (GENERATED — never hand-edited). */
async function loadSidecarModule(): Promise<{ default: unknown }> {
  // LITERAL path on purpose: a variable import is opaque to Vite's static
  // analysis — it would build fine but 404 at runtime.
  return import("./content/upstream/manifest.sidecar.json");
}

/**
 * Load + validate the sidecar. Returns null when the file is missing or
 * malformed — the manifest build then reports and carries on with our own
 * content (docs render is content-tolerant by contract §3).
 */
export async function loadSidecar(): Promise<DocsSidecar | null> {
  let mod: { default: unknown };
  try {
    mod = await loadSidecarModule();
  } catch (error) {
    console.error("[docs] sidecar failed to load", error);
    return null;
  }
  const data = mod.default as Partial<DocsSidecar> | undefined;
  if (!data || !Array.isArray(data.pages)) {
    console.error("[docs] sidecar is malformed (no pages array), upstream metadata skipped");
    return null;
  }
  return data as DocsSidecar;
}

/**
 * Provenance dates ride ISO commit stamps; the badge shows them in the
 * reader's short calendar form (design spec §6.2: badge `dd.mm`, full form
 * `dd.mm.yyyy` in title/aria-label).
 */
export function formatSyncDate(iso: string, full = false): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const [, year, month, day] = match;
  return full ? `${day}.${month}.${year}` : `${day}.${month}`;
}
