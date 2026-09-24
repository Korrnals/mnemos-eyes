// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MermaidDiagram } from "./Mermaid";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * MermaidDiagram gates (АРХКОМ-8): the library is initialized EXPLICITLY
 * (strict security, no onLoad, size/edge caps), diagrams render through
 * DOMParser + replaceChildren (never dangerouslySetInnerHTML), click-links
 * are unwrapped from the SVG, theme switches redraw on-line, and ANY
 * failure falls back to the source code block + warning — never a crash.
 * mermaid is MOCKED here; a real-render smoke lives in
 * mermaid.render.smoke.test.tsx.
 */

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}));

const mermaidMock = (await import("mermaid")).default as unknown as {
  initialize: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
};

const SVG_WITH_LINK =
  '<svg viewBox="0 0 4 4" width="40" height="40">' +
  '<a href="https://evil.example/"><text x="1" y="1">click</text></a>' +
  '<text x="2" y="2">ok</text></svg>';

interface Mounted {
  container: HTMLElement;
  root: Root;
}

const mounted: Mounted[] = [];

async function mountDiagram(code: string): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<MermaidDiagram code={code} />);
  });
  mounted.push({ container, root });
  return container;
}

beforeEach(() => {
  mermaidMock.initialize.mockClear();
  mermaidMock.render.mockReset();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(async () => {
  while (mounted.length > 0) {
    const { root } = mounted.pop()!;
    await act(async () => root.unmount());
  }
  document.body.textContent = "";
});

describe("MermaidDiagram", () => {
  it("initializes mermaid EXPLICITLY: strict, no onLoad, caps (АРХКОМ-8)", async () => {
    mermaidMock.render.mockResolvedValue({ svg: SVG_WITH_LINK });
    await mountDiagram("graph TD;A-->B;");
    expect(mermaidMock.initialize).toHaveBeenCalledWith({
      securityLevel: "strict",
      startOnLoad: false,
      maxTextSize: 20_000,
      maxEdges: 200,
      theme: "dark", // no [data-theme] attribute = dark (theme contract)
    });
  });

  it("renders through replaceChildren and UNWRAPS click-links from the SVG", async () => {
    mermaidMock.render.mockResolvedValue({ svg: SVG_WITH_LINK });
    const container = await mountDiagram("graph TD;A-->B;");
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    // No <a> survived post-processing…
    expect(container.querySelector("svg a")).toBeNull();
    // …but the link LABEL did (unwrapped, not deleted).
    expect(svg?.textContent).toContain("click");
    expect(svg?.textContent).toContain("ok");
    // No raw-HTML escape hatch was involved.
    expect(container.innerHTML).not.toContain("dangerouslySetInnerHTML");
  });

  it("keeps the source visible while the chunk loads (loader fallback)", async () => {
    let resolveRender: (value: { svg: string }) => void = () => undefined;
    mermaidMock.render.mockReturnValue(
      new Promise((resolve) => {
        resolveRender = resolve;
      }),
    );
    const container = await mountDiagram("graph TD;A-->B;");
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("A-->B");
    expect(container.querySelector("figure")?.getAttribute("aria-busy")).toBe(
      "true",
    );
    await act(async () => resolveRender({ svg: SVG_WITH_LINK }));
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("pre")).toBeNull();
  });

  it("falls back to source + warning on parse/render errors (no crash)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mermaidMock.render.mockRejectedValue(new Error("Diagram too large"));
    const container = await mountDiagram("graph TD;A-->B;");
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toContain("исходный код"); // warning (ru default)
    expect(container.querySelector("pre")?.textContent).toContain("A-->B");
    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("mermaid"))).toBe(
      true,
    );
    warnSpy.mockRestore();
  });

  it("redraws on-line when the root data-theme flips", async () => {
    mermaidMock.render.mockResolvedValue({ svg: SVG_WITH_LINK });
    document.documentElement.setAttribute("data-theme", "light");
    await mountDiagram("graph TD;A-->B;");
    const firstThemes = mermaidMock.initialize.mock.calls.map(
      (call) => (call[0] as { theme: string }).theme,
    );
    expect(firstThemes[0]).toBe("default"); // light
    await act(async () => {
      document.documentElement.setAttribute("data-theme", "dark");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const themes = mermaidMock.initialize.mock.calls.map(
      (call) => (call[0] as { theme: string }).theme,
    );
    expect(themes).toContain("dark"); // observer-triggered re-initialize
    expect(mermaidMock.render.mock.calls.length).toBeGreaterThan(1);
  });
});
