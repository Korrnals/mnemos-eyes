import { describe, expect, it } from "vitest";
import { defaultSchema } from "hast-util-sanitize";
import { sanitizeSchema } from "./sanitizeSchema";

/**
 * Schema regression gate (АРХКОМ-8, governance): the sanitize schema is a
 * SECURITY CONFIG — its shape is snapshotted, and the targeted asserts pin
 * the exact subtraction contract (defaultSchema minus, never a hand-rolled
 * allowlist). ANY diff here must arrive as a separate governance PR with a
 * fresh hostile-fixture run (see sanitizeSchema.ts header).
 */

describe("sanitizeSchema (defaultSchema minus — АРХКОМ-8)", () => {
  it("is a snapshot-stable configuration", () => {
    expect(sanitizeSchema).toMatchSnapshot();
  });

  it("stays a superset of defaultSchema's tagNames (no hand-rolled list)", () => {
    for (const tag of defaultSchema.tagNames ?? []) {
      expect(sanitizeSchema.tagNames).toContain(tag);
    }
    // GitHub-parity tags the committee named explicitly.
    for (const tag of ["details", "summary", "kbd", "sub", "sup"]) {
      expect(sanitizeSchema.tagNames).toContain(tag);
    }
  });

  it("never grants the forbidden embedding/styling namespaces", () => {
    for (const tag of [
      "svg",
      "math",
      "style",
      "iframe",
      "object",
      "embed",
      "form",
    ]) {
      expect(sanitizeSchema.tagNames, tag).not.toContain(tag);
    }
  });

  it("narrows protocols to the corpus schemes (+ relative passthrough)", () => {
    const href = sanitizeSchema.protocols?.href ?? [];
    const src = sanitizeSchema.protocols?.src ?? [];
    expect(href).toEqual(["http", "https", "mailto"]);
    expect(src).toEqual(["http", "https"]);
    // defaultSchema's irc/ircs/xmpp are subtracted, not inherited; data: is
    // deliberately absent — the pipeline vendors images.
    for (const scheme of ["irc", "ircs", "xmpp", "data"]) {
      expect(href, scheme).not.toContain(scheme);
      expect(src, scheme).not.toContain(scheme);
    }
  });

  it("keeps class only on code, narrowed to the language-token shape", () => {
    const pattern = sanitizeSchema.attributes?.code?.find(
      (entry) => Array.isArray(entry) && entry[0] === "className",
    )?.[1];
    expect(pattern).toBeInstanceOf(RegExp);
    const re = pattern as RegExp;
    expect(re.test("language-python")).toBe(true);
    expect(re.test("language-mermaid")).toBe(true);
    expect(re.test("language-ru-RU")).toBe(true);
    expect(re.test("evil")).toBe(false);
    expect(re.test("language-evil token")).toBe(false);
    expect(re.test("language-")).toBe(false);
    // No other element carries a free-form class (fixed-value entries in
    // defaultSchema — task-list-item et al. — are the allowed exceptions).
    for (const [tag, entries] of Object.entries(
      sanitizeSchema.attributes ?? {},
    )) {
      if (tag === "code") continue;
      for (const entry of entries ?? []) {
        if (entry === "className" || entry === "class") {
          throw new Error(`free-form className allowed on ${tag}`);
        }
      }
    }
  });

  it("forbids id/name (and documents the style/target absence)", () => {
    const star = sanitizeSchema.attributes?.["*"] ?? [];
    for (const banned of ["id", "name", "style", "target"]) {
      expect(star, banned).not.toContain(banned);
    }
  });

  it("keeps the GFM task-list checkbox coercions from defaultSchema", () => {
    expect(sanitizeSchema.required?.input).toEqual(
      defaultSchema.required?.input,
    );
    expect(sanitizeSchema.required?.input).toEqual({
      disabled: true,
      type: "checkbox",
    });
  });

  it("keeps the default clobber prefix (user-content-)", () => {
    expect(sanitizeSchema.clobberPrefix).toBe("user-content-");
  });

  it("drops script subtrees entirely (no source-as-text leak)", () => {
    expect(sanitizeSchema.strip).toEqual(["script", "style", "iframe"]);
  });

  it("removes srcset (source) from the attribute map", () => {
    expect(sanitizeSchema.attributes?.source).toBeUndefined();
  });
});
