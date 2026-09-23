import { defaultSchema } from "hast-util-sanitize";
import type { Schema } from "hast-util-sanitize";

/**
 * Sanitize schema for the docs pipeline (АРХКОМ-8 2026-09-23, Security
 * position): raw HTML IS allowed, but only through `rehype-raw` followed by
 * `rehype-sanitize` with THIS schema — in that order, at the single site
 * (Markdown.tsx).
 *
 * Construction is DEFAULTSCHEMA MINUS SUBTRACTIONS — deliberately NOT a
 * hand-rolled allowlist: a manual mini-list silently drops markdown-native
 * elements (p/tables/headings) the moment upstream tightens the default
 * schema, while the minus-form keeps GitHub parity (GFM tables, details/
 * summary, kbd/sub/sup, task lists, footnotes) by construction.
 *
 * GOVERNANCE (allowlist, deny-by-default): any EXTENSION of this schema is a
 * separate PR carrying its justification + a green hostile fixture set + an
 * updated schema snapshot (sanitizeSchema.test.ts). No exceptions — a schema
 * widened in a drive-by commit is a security regression, not a style issue.
 *
 * Each subtraction below is commented with its reason. Anything not listed
 * here is inherited from defaultSchema untouched (clobberPrefix stays the
 * default "user-content-", so a raw id/name can never collide with OUR
 * element ids even if we re-allowed them later).
 */

const schema: Schema = structuredClone(defaultSchema);

// --- protocols -------------------------------------------------------------------
// href: defaultSchema also allows irc/ircs/xmpp. The corpus has no such
// links, and every scheme we do not name is a future vector — subtract down
// to the three the corpus actually uses. Relative hrefs pass (no scheme).
// src: already http/https in defaultSchema; pinned here explicitly so the
// guarantee survives a defaultSchema loosening. Relative srcs pass.
// data: is deliberately ABSENT — our pipeline vendors every in-body image
// through docsAssets.ts, so a data: URI has no legitimate use.
schema.protocols = {
  ...schema.protocols,
  href: ["http", "https", "mailto"],
  src: ["http", "https"],
};

// --- attributes -------------------------------------------------------------------
// Free-form class lives ONLY on `code`, narrowed from defaultSchema's
// /^language-./ (a prefix match admits "language-x y z"-style token games) to
// an exact token shape. Without `language-*` on code our CodeBlock loses the
// language label and mermaid fences stop being recognizable — the one class
// we cannot drop. `pre` never needed a class in this schema version (the
// label is read from the inner code element).
const attributes = (schema.attributes ??= {});
attributes.code = [["className", /^language-[\w-]+$/]];

// Fixed-value classes from defaultSchema (li "task-list-item", ul/ol
// "contains-task-list", a "data-footnote-backref", h2 "sr-only", section
// "footnotes") stay: they are GFM/footnote parity constants, not attacker
// controlled — a hostile class="" can never produce them.

// srcset: defaultSchema allows it on <source> (picture). Unneeded by the
// corpus, unneeded by us, and a classic smuggling attribute — subtract.
delete attributes.source;

// id/name: forbidden (АРХКОМ-8). defaultSchema allows them broadly and only
// defuses collisions via the clobber prefix; we do not host foreign anchors
// at all, and clobbered ids invite DOM-clobbering tricks. Note: defaultSchema
// never had style/target — recorded here so the INTENT ("no style/target/
// id/name") survives even if upstream adds them back.
const star = (attributes["*"] ??= []);
for (const banned of ["id", "name"]) {
  const index = star.indexOf(banned);
  if (index !== -1) star.splice(index, 1);
}

// Raw <input> from hostile HTML is forced into a DISABLED CHECKBOX by
// defaultSchema's `required` + attribute constraints — kept as-is: that is
// exactly the GFM task-list checkbox, and nothing else can render.

// --- strip → drop -----------------------------------------------------------------
// In hast-util-sanitize@6 an element LISTED in `strip` has its whole subtree
// removed, while an unlisted voided element is UNWRAPPED (children kept as
// text). The drop-subtrees plugin between rehype-raw and sanitize already
// removes script/style/iframe content; listing them here keeps that guarantee
// as a second line of defence even if the plugin is ever reordered/removed.
schema.strip = ["script", "style", "iframe"];

// --- tagNames ---------------------------------------------------------------------
// Inherited UNTOUCHED from defaultSchema: details/summary/kbd/sub/sup and
// friends stay (GitHub parity); svg/math/style/iframe/object/embed/form are
// NOT added — they are not in the default schema and we do not grant them.

export const sanitizeSchema = schema;
