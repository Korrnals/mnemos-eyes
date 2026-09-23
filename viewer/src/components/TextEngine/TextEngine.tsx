import {
  Suspense,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { lazy } from "react";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { looksLikeMarkdown } from "./looksLikeMarkdown";

/**
 * Measurement effect: layout-timing on the client, silent no-op on the
 * server (React warns about useLayoutEffect in renderToString — the SSR
 * node-env tests must stay stderr-clean).
 */
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * TextEngine (UI-27) — THE text primitive for author content across the
 * whole interface. Standard contract for every surface, present and future:
 * any text a human or an agent authored (memory records, task specs,
 * reports, inbox bodies) renders through this component, never through a
 * raw `{text}` interpolation.
 *
 * Auto-detect: `looksLikeMarkdown` scans the text; no markdown syntax → the
 * PLAIN path (a pre-wrap div — the exact legacy output, zero parser cost,
 * zero distortion, and the markdown chunk is never even fetched). Markdown
 * syntax → the renderer from the lazy chunk (React.lazy — the chunk loads on
 * the first markdown render, preview lists of plain cards never pay).
 *
 * Props:
 * - `variant`: "compact" (card previews — small type, tight rhythm) |
 *   "full" (detail views, expanded bodies — base type, readable spacing).
 * - `clamp`: preview cut (max-height) with a «показать полностью» button
 *   that removes it. The button appears only when the content actually
 *   overflows (measured; ResizeObserver re-checks after the lazy renderer
 *   or fonts/images settle).
 * - `className`/`style`: container passthrough (surface font, spacing).
 *
 * SECURITY: untrusted author content is rendered by react-markdown (React
 * elements — no dangerouslySetInnerHTML, no rehype-raw); schemes are
 * whitelisted in MarkdownView. CSP untouched.
 */

const MarkdownView = lazy(() => import("./MarkdownView"));

export interface TextEngineProps {
  /** Author text — may be plain prose or markdown; detected, not assumed. */
  text: string | null | undefined;
  variant?: "compact" | "full";
  /** Max-height preview + «показать полностью» (one-way expand). */
  clamp?: boolean;
  className?: string;
  /** Container style passthrough (e.g. token-bound mono for rule memories). */
  style?: React.CSSProperties;
}

/** Legacy plain output — preserved verbatim for the no-markdown path. */
function PlainText({ text, className, style }: {
  text: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={cn("whitespace-pre-wrap [overflow-wrap:break-word]", className)} style={style}>
      {text}
    </div>
  );
}

/** Max preview height before «показать полностью» (≈9 lines at text-sm). */
const CLAMP_BOX_CLASS = "max-h-48 overflow-hidden";

function TextEngineImpl({
  text,
  variant = "full",
  clamp = false,
  className,
  style,
}: TextEngineProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    if (!clamp || expanded) return;
    const content = contentRef.current;
    const box = boxRef.current;
    if (!content || !box) return;
    // Natural content height vs the clamped box height (+1px rounding).
    setOverflowing(content.offsetHeight > box.clientHeight + 1);
  }, [clamp, expanded]);

  // Initial measure after every relevant commit (source/variant/expand).
  useIsomorphicLayoutEffect(measure, [measure]);

  // The content height can settle AFTER the commit that mounted it: the
  // lazy markdown chunk swaps the fallback for rendered elements, images
  // and web fonts land late. ResizeObserver re-checks without polling.
  useIsomorphicLayoutEffect(() => {
    const content = contentRef.current;
    if (!clamp || expanded || !content || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [clamp, expanded, measure]);

  if (text === null || text === undefined || text.length === 0) {
    return null;
  }

  const isMarkdown = looksLikeMarkdown(text);
  const clampedNow = clamp && !expanded;

  return (
    <div className={className} style={style}>
      <div ref={boxRef} className={clampedNow ? CLAMP_BOX_CLASS : undefined}>
        <div ref={contentRef}>
          {isMarkdown ? (
            // Fallback = the raw text itself (pre-wrap): the content is
            // readable the instant it mounts and upgrades to rendered
            // elements when the parser chunk arrives (once per session).
            <Suspense
              fallback={<PlainText text={text} className={variant === "compact" ? "text-sm" : undefined} />}
            >
              <MarkdownView source={text} variant={variant} />
            </Suspense>
          ) : (
            <PlainText text={text} />
          )}
        </div>
      </div>
      {clampedNow && overflowing ? (
        <button
          type="button"
          aria-expanded={false}
          onClick={() => setExpanded(true)}
          className="mt-1 text-xs text-iris-bright underline underline-offset-2 transition-colors duration-instant hover:decoration-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
        >
          {t("text.showFull")}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Memoized on props: long card lists re-render on parent state churn, but a
 * TextEngine re-parses ONLY when its own text/variant actually changed.
 * NOTE: keep `style` a stable reference (module constant) to preserve the memo.
 */
export const TextEngine = memo(TextEngineImpl);
