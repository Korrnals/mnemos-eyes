import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Node-env test: read the sources straight from disk (Vitest stubs CSS
// imports, so `?raw` is unreliable for stylesheets here).
const tokensCss = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

/**
 * T4 drift guard: locks tokens.css to the inventory frozen by
 * docs/design-system.md (§2–§7) and ADR 0003, and keeps the index.html theme
 * bootstrap in sync with ThemeProvider (design-system.md §9).
 */

const COLOR_TOKENS = [
  "--color-bg-base",
  "--color-bg-well",
  "--color-bg-elevated",
  "--color-bg-overlay",
  "--color-iris-dim",
  "--color-iris",
  "--color-iris-bright",
  "--color-iris-glow",
  "--color-confidence",
  "--color-confidence-dim",
  "--color-success",
  "--color-warning",
  "--color-error",
  "--color-info",
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-muted",
  "--color-text-inverse",
  "--color-border-subtle",
  "--color-border",
  "--color-border-iris",
  "--color-scroll-bg",
  "--color-scroll-border",
];

const TYPE_TOKENS = [
  "--font-ui",
  "--font-scroll",
  "--font-mono", // D11: rule/code content
  "--text-xs",
  "--text-sm",
  "--text-base",
  "--text-md",
  "--text-lg",
  "--text-xl",
  "--text-2xl",
  "--leading-tight",
  "--leading-normal",
  "--leading-relaxed",
  "--weight-regular",
  "--weight-medium",
  "--weight-semibold",
];

const SPACE_TOKENS = [
  "--space-1",
  "--space-2",
  "--space-3",
  "--space-4",
  "--space-5",
  "--space-6",
  "--space-8",
  "--space-10",
  "--space-12",
  "--space-16",
  "--space-24",
];

const RADIUS_TOKENS = ["--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--radius-full"];

const SHADOW_TOKENS = ["--shadow-well", "--shadow-raised", "--shadow-float", "--shadow-modal", "--shadow-iris"];

const MOTION_TOKENS = [
  "--duration-instant",
  "--duration-fast",
  "--duration-normal",
  "--duration-slow",
  "--duration-iris",
  "--ease-in-out",
  "--ease-out",
  "--ease-spring",
  "--ease-breath",
];

/** Every custom property defined inside a CSS block. */
function blockProps(block: string): Set<string> {
  return new Set(block.match(/--[a-z0-9-]+(?=\s*:)/gi) ?? []);
}

const darkBlock = tokensCss.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
const lightBlock = tokensCss.match(/\[data-theme="light"\]\s*\{([^}]*)\}/)?.[1] ?? "";

describe("tokens.css inventory (design-system.md §2–§7)", () => {
  it("defines every color token in the dark theme (:root)", () => {
    const props = blockProps(darkBlock);
    for (const token of COLOR_TOKENS) {
      expect(props, `${token} missing from dark theme`).toContain(token);
    }
  });

  it("overrides every color token in the light theme", () => {
    const props = blockProps(lightBlock);
    for (const token of COLOR_TOKENS) {
      expect(props, `${token} missing from light theme`).toContain(token);
    }
  });

  it("defines typography, spacing, radius, shadow and motion tokens", () => {
    const props = blockProps(tokensCss);
    for (const token of [...TYPE_TOKENS, ...SPACE_TOKENS, ...RADIUS_TOKENS, ...SHADOW_TOKENS, ...MOTION_TOKENS]) {
      expect(props, `${token} missing`).toContain(token);
    }
  });

  it("keeps the frozen iris seed value in both themes (ADR 0003 / D10)", () => {
    const seeds = tokensCss.match(/--color-iris:\s*#1a8a96/g) ?? [];
    expect(seeds).toHaveLength(2); // dark + light
  });

  it("resolves shadows through the iris glow token", () => {
    expect(tokensCss).toMatch(/--shadow-iris:[^;]*var\(--color-iris-glow\)/);
  });
});

describe("reduced-motion overrides (design-system.md §7)", () => {
  it("zeroes ambient and long transitions while keeping instant feedback", () => {
    const mediaIndex = tokensCss.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(mediaIndex).toBeGreaterThan(-1);
    const media = tokensCss.slice(mediaIndex);
    expect(media).toContain("--duration-iris: 0ms");
    expect(media).toContain("--duration-slow: 0ms");
    expect(media).toContain("--duration-normal: 0ms");
    expect(media).toContain("--duration-fast: 80ms");
  });
});

describe("self-hosted fonts (T4)", () => {
  it("stacks the self-hosted variable families ahead of the static names", () => {
    expect(tokensCss).toMatch(/--font-ui:\s*"Inter Variable", "Inter"/);
    expect(tokensCss).toMatch(/--font-scroll:\s*"Lora Variable", "Lora"/);
    expect(tokensCss).toMatch(/--font-mono:[^;]*"JetBrains Mono"/);
  });

  it("serves fonts from the bundle, not Google Fonts", () => {
    expect(indexHtml).not.toContain("fonts.googleapis.com");
    expect(indexHtml).not.toContain("fonts.gstatic.com");
  });
});

describe("theme bootstrap (design-system.md §9)", () => {
  it("resolves the theme before first paint with the provider's contract", () => {
    expect(indexHtml).toContain("mnemos-eyes:theme"); // storage key
    expect(indexHtml).toContain("prefers-color-scheme"); // system default
    expect(indexHtml).toContain("dataset.theme"); // [data-theme] switching
  });
});
