import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { IrisLogo } from "./IrisLogo";

/**
 * Static-render contract tests (vitest runs in the node environment, so
 * renderToString keeps these deterministic; the reduced-motion hook resolves
 * to `false` without `window`, meaning `breathing` renders its class).
 * Visual/animation behaviour itself is covered by the T5 browser smoke.
 */
describe("IrisLogo", () => {
  it("is defined and is a function component", () => {
    expect(IrisLogo).toBeDefined();
    expect(typeof IrisLogo).toBe("function");
  });

  it("is static and announced by default", () => {
    const html = renderToString(<IrisLogo />);
    expect(html).toContain('role="img"');
    expect(html).toContain("mnemos-eyes iris");
    expect(html).not.toContain("iris-breathing");
    expect(html).not.toContain("iris-logo-glow");
  });

  it("mounts the breathing class only when enabled", () => {
    expect(renderToString(<IrisLogo breathing />)).toContain("iris-breathing");
  });

  it("offers the hero glow treatment (design-system.md §8.1)", () => {
    expect(renderToString(<IrisLogo glow />)).toContain("iris-logo-glow");
  });

  it("renders through design tokens only — no literal colours", () => {
    const html = renderToString(<IrisLogo size={160} glow breathing />);
    expect(html).not.toMatch(/(fill|stroke)="#/i);
    expect(html).toContain("var(--color-iris");
    expect(html).toContain("var(--color-bg-well)");
  });

  it("can be hidden from assistive tech when decorative", () => {
    const html = renderToString(<IrisLogo decorative />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
  });
});
