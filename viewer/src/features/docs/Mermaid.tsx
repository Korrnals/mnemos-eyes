import { useEffect, useRef, useState } from "react";
import type { Mermaid } from "mermaid";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * Mermaid fences (АРХКОМ-8): `language-mermaid` code blocks render as
 * diagrams — ONLY through this module. The library arrives via a LAZY
 * dynamic import that first fires when a fence actually mounts on the page
 * (vite splits it into its own chunk; the budget gate
 * scripts/budget-docs-render.mjs holds that pool ≤450 KiB gzip and asserts
 * it is never statically reachable), so pages without diagrams never pay
 * for it.
 *
 * Security posture (committee, Security position): `securityLevel: "strict"`
 * is set EXPLICITLY, no CDN, and click-links are neutralized by unwrapping
 * <a> from the produced SVG — a diagram must never navigate. Errors fall
 * back to the source code block + a warning; a broken diagram is a content
 * bug, never a crash (W1c spirit). While the chunk loads, the source stays
 * visible (loader fallback — the page never jumps empty).
 */

/** Fixed by committee protocol — NOT tuning knobs (ADR 0017 records them). */
const MERMAID_MAX_TEXT_SIZE = 20_000;
const MERMAID_MAX_EDGES = 200;

/** Type-only import: erased at build time, the chunk stays dynamic-only. */
let mermaidModulePromise: Promise<Mermaid> | null = null;

function mermaidModule(): Promise<Mermaid> {
  mermaidModulePromise ??= import("mermaid").then((module) => module.default);
  return mermaidModulePromise;
}

/** [data-theme] contract (theme-provider): "light" set, dark = absence. */
function rootThemeIsLight(): boolean {
  return document.documentElement.getAttribute("data-theme") === "light";
}

function diagramWarning(message: string): string {
  return `[docs] mermaid render failed: ${message}`;
}

export function MermaidDiagram({ code }: { code: string }) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    let tempId: string | null = null;

    const renderDiagram = async () => {
      setStatus("loading");
      try {
        const mermaid = await mermaidModule();
        if (cancelled) return;
        // Re-initialized per pass: the single shared instance follows the
        // current theme (MutationObserver below re-runs this on switch).
        mermaid.initialize({
          securityLevel: "strict",
          startOnLoad: false,
          maxTextSize: MERMAID_MAX_TEXT_SIZE,
          maxEdges: MERMAID_MAX_EDGES,
          theme: rootThemeIsLight() ? "default" : "dark",
        });
        tempId = `docs-mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const { svg } = await mermaid.render(tempId, code);
        if (cancelled) return;
        // Parse, DON'T innerHTML: the SVG is inspected node-by-node before
        // it may enter our DOM (no dangerouslySetInnerHTML — gate §9).
        const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
        const svgNode = parsed.documentElement;
        if (
          svgNode === null ||
          svgNode.nodeName === "parsererror" ||
          svgNode.tagName.toLowerCase() !== "svg"
        ) {
          throw new Error("mermaid produced an unparsable svg");
        }
        // Neutralize click-links: unwrap <a> so labels survive, navigation
        // does not (committee verdict on Security Q2).
        for (const anchor of [...svgNode.querySelectorAll("a")]) {
          anchor.replaceWith(...anchor.childNodes);
        }
        const host = containerRef.current;
        if (host === null || cancelled) return;
        host.replaceChildren(document.importNode(svgNode, true));
        setStatus("ok");
      } catch (error) {
        // mermaid leaves a temp mount node behind on failure — clean it.
        if (tempId !== null) document.getElementById(`d${tempId}`)?.remove();
        if (!cancelled) {
          console.warn(diagramWarning(error instanceof Error ? error.message : String(error)));
          setStatus("error");
        }
      }
    };

    void renderDiagram();
    // On-line re-theming (committee verdict on SysEng Q1): cheap at the
    // corpus scale (a dozen blocks per page at most).
    const observer = new MutationObserver(() => void renderDiagram());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [code]);

  return (
    <figure
      className="relative my-4 rounded-md border border-border-subtle bg-elevated p-4"
      aria-busy={status !== "ok"}
    >
      {status === "error" ? (
        <p
          role="status"
          className="mb-3 text-sm text-foreground-secondary"
        >
          {t("docs.mermaid.renderFailed")}
        </p>
      ) : null}
      {/* Loading + error keep the SOURCE visible: nothing to measure layout
          on until the diagram exists, and a broken diagram stays auditable. */}
      {status !== "ok" ? (
        <pre
          style={{ fontFamily: "var(--font-mono)" }}
          className="overflow-x-auto text-sm leading-normal text-foreground"
        >
          <code>{code}</code>
        </pre>
      ) : null}
      <div
        ref={containerRef}
        className={cn(
          "mermaid-diagram text-foreground",
          "[&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full",
          status === "ok" ? "block" : "hidden",
        )}
      />
    </figure>
  );
}
