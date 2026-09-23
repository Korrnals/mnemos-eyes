// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

/**
 * Package-integrity smoke for the PINNED mermaid build (АРХКОМ-8).
 *
 * DEVIATION from the protocol's «реальный рендер — смоук», recorded
 * deliberately: happy-dom has no SVG layout engine (getBBox/getCTM), and a
 * probe against the real package returns an EMPTY svg string — mermaid's
 * render path needs a real layout engine, so a true render smoke is not
 * stable inside vitest. What IS verifiable here: the pinned package imports
 * cleanly in a DOM-like environment and accepts the committee's explicit
 * initialize() config. The pixel-level render check belongs to the browser
 * e2e surface (Playwright), not unit CI.
 */

describe("pinned mermaid integrity", () => {
  it("imports and accepts the АРХКОМ-8 initialize config (real package)", async () => {
    const mermaid = (await import("mermaid")).default;
    expect(typeof mermaid.initialize).toBe("function");
    expect(typeof mermaid.render).toBe("function");
    expect(() =>
      mermaid.initialize({
        securityLevel: "strict",
        startOnLoad: false,
        maxTextSize: 20_000,
        maxEdges: 200,
        theme: "dark",
      }),
    ).not.toThrow();
  });
});
