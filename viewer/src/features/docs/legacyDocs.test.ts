import { describe, expect, it } from "vitest";
import { legacyDocsTarget, isLegacyDocsSlug } from "./legacyDocs";
import {
  docModulePaths,
  parseDocPath,
  type ParsedDocPath,
} from "./markdownModules";

/**
 * Legacy /docs URL map (design spec §8, W1c gate): every pre-hub bookmark
 * resolves into the default hub SYNCHRONOUSLY (glob keys — no fetches); a
 * miss returns null (the not-found page, never a blind redirect). Deep links
 * into imported projects are NOT legacy and must never be touched.
 */

describe("legacy docs redirect map (spec §8)", () => {
  it("sends /docs and legacy category URLs into the default hub", () => {
    expect(legacyDocsTarget("/docs")).toBe("/docs/vesmaro-eyes");
    expect(legacyDocsTarget("/docs/c/maintenance")).toBe(
      "/docs/vesmaro-eyes/c/maintenance",
    );
    expect(legacyDocsTarget("/docs/c/unknown-cat")).toBe(
      "/docs/vesmaro-eyes/c/unknown-cat",
    );
  });

  it("maps every one of our slugs to its project-scoped URL", () => {
    const ourSlugs = docModulePaths()
      .map((path) => parseDocPath(path))
      .filter(
        (parsed): parsed is ParsedDocPath =>
          parsed !== null && parsed.project === undefined,
      )
      .map((parsed) => parsed.slug);
    expect(ourSlugs.length, "sanity: our corpus exists").toBeGreaterThanOrEqual(15);
    for (const slug of ourSlugs) {
      expect(legacyDocsTarget(`/docs/${slug}`)).toBe(`/docs/vesmaro-eyes/${slug}`);
      expect(isLegacyDocsSlug(slug)).toBe(true);
    }
  });

  it("never touches deep links into imported projects", () => {
    expect(legacyDocsTarget("/docs/mnemos")).toBeNull();
    expect(legacyDocsTarget("/docs/mnemos/user/getting-started")).toBeNull();
    expect(legacyDocsTarget("/docs/mnemos-mesh/admin/security")).toBeNull();
  });

  it("answers unknown single-segment slugs with a miss (not-found, not redirect)", () => {
    expect(legacyDocsTarget("/docs/ghost")).toBeNull();
    expect(isLegacyDocsSlug("ghost")).toBe(false);
    expect(legacyDocsTarget("/docs/tokens/extra")).toBeNull();
  });
});
