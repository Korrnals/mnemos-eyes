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

const RADIUS_TOKENS = [
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
  "--radius-xl",
  "--radius-full",
];

// Density pair (redesign concept §3.3 / ARCHCOM-3 verdict §2 — additive).
const DENSITY_TOKENS = [
  "--row-h-dense",
  "--row-h-airy",
  "--row-h",
  "--list-gap",
  "--measure-scroll",
];

const SHADOW_TOKENS = [
  "--shadow-well",
  "--shadow-raised",
  "--shadow-float",
  "--shadow-modal",
  "--shadow-iris",
];

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
    for (const token of [
      ...TYPE_TOKENS,
      ...SPACE_TOKENS,
      ...RADIUS_TOKENS,
      ...SHADOW_TOKENS,
      ...MOTION_TOKENS,
    ]) {
      expect(props, `${token} missing`).toContain(token);
    }
  });

  it("keeps the frozen iris seed value in both themes (ADR 0003 / D10)", () => {
    const seeds = tokensCss.match(/--color-iris:\s*#1a8a96/g) ?? [];
    expect(seeds).toHaveLength(2); // dark + light
  });

  it("defines the density regime pair and the user-driven operational tokens", () => {
    const props = blockProps(tokensCss);
    for (const token of DENSITY_TOKENS) {
      expect(props, `${token} missing`).toContain(token);
    }
  });

  it("drives [data-density]: compact maps the operational row onto dense", () => {
    const compact =
      tokensCss.match(/\[data-density="compact"\]\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(compact).toContain("--row-h: var(--row-h-dense)");
    // Comfortable is the default (:root block), compact is the override.
    const rootBlocks =
      tokensCss.match(/:root,\s*\[data-density="comfortable"\]\s*\{([^}]*)\}/)?.[1] ??
      "";
    expect(rootBlocks).toContain("--row-h:");
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

// --- badge-tint contrast (WCAG 1.4.3; AGW-2 review P2-1) -----------------------
//
// The semantic badges render `bg-<token>/15 text-<token>` over the theme's
// WELL surface (cards/rows). Terminal assignment badges must clear 4.5:1
// (spec §3.1), so the warning pair is regression-locked with the real WCAG
// arithmetic — tint = 15% token over the well background, alpha-composited.

/** Parse one hex color out of a theme block. */
function tokenHex(block: string, token: string): [number, number, number] {
  const match = block.match(new RegExp(`${token}:\\s*#([0-9a-f]{6})`, "i"));
  expect(match, `${token} present in the block`).not.toBeNull();
  const hex = match![1];
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

/** WCAG relative luminance. */
function luminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number): number => {
    const srgb = value / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Alpha-composite a 15% token tint over an opaque surface. */
function tint15(fg: [number, number, number], bg: [number, number, number]) {
  return fg.map((value, index) => 0.15 * value + 0.85 * bg[index]) as [
    number,
    number,
    number,
  ];
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("warning badge contrast — /15 tint over the theme well (spec §3.1 ≥4.5)", () => {
  it("light: #8a5a17 on the tint clears AA (the P2-1 regression lock)", () => {
    const well = tokenHex(lightBlock, "--color-bg-well");
    const warning = tokenHex(lightBlock, "--color-warning");
    // The fix itself: one step darker than the failing #946018 (4.34).
    expect(warning).toEqual([0x8a, 0x5a, 0x17]);
    expect(contrast(warning, tint15(warning, well))).toBeGreaterThanOrEqual(4.5);
    // Pure surfaces must not degrade either (both improved vs #946018).
    const elevated = tokenHex(lightBlock, "--color-bg-elevated");
    expect(contrast(warning, well)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(warning, elevated)).toBeGreaterThanOrEqual(4.5);
  });

  it("dark: #b8852a on the tint stays AA (unchanged by the fix)", () => {
    const well = tokenHex(darkBlock, "--color-bg-well");
    const warning = tokenHex(darkBlock, "--color-warning");
    expect(warning).toEqual([0xb8, 0x85, 0x2a]);
    expect(contrast(warning, tint15(warning, well))).toBeGreaterThanOrEqual(4.5);
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
    // UI-23 migration: the new registry key first, the legacy fallback second.
    expect(indexHtml).toContain("vesmaro.theme");
    expect(indexHtml).toContain("mnemos-eyes:theme");
    expect(
      indexHtml.indexOf("vesmaro.theme"),
      "the new key must be consulted before the legacy one",
    ).toBeLessThan(indexHtml.indexOf("mnemos-eyes:theme"));
    expect(indexHtml).toContain("prefers-color-scheme"); // system default
    expect(indexHtml).toContain("dataset.theme"); // [data-theme] switching
  });
});

describe("motion attribute (UI-23, vesmaro.motion reduced branches)", () => {
  it("mirrors the reduced-motion durations for the forced regime", () => {
    expect(tokensCss).toContain('[data-motion="reduced"]');
    // The forced block must carry the same zeroed durations as the OS block.
    const forced = tokensCss.match(/\[data-motion="reduced"\]\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(forced).toContain("--duration-iris: 0ms");
    expect(forced).toContain("--duration-slow: 0ms");
    expect(forced).toContain("--duration-normal: 0ms");
    expect(forced).toContain("--duration-fast: 80ms");
  });
});

describe("density bootstrap (Ф1, concept §3.3)", () => {
  it("applies the stored density before first paint with the provider's contract", () => {
    expect(indexHtml).toContain("vesmaro.density"); // storage key
    expect(indexHtml).toContain("dataset.density"); // [data-density] switching
    // Only compact is an override; anything else falls back to comfortable.
    expect(indexHtml).toMatch(/density === "compact" \? "compact" : "comfortable"/);
  });
});
