import { memo } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * The markdown renderer behind TextEngine (UI-27) — ONE react-markdown +
 * remark-gfm point for ALL author-content surfaces (memory records, task
 * specs, agent reports). Lives in its own lazy chunk: it is loaded ONLY when
 * a text actually auto-detects as markdown (TextEngine's plain path never
 * renders this module, so preview cards made of plain prose never pay for
 * the parser).
 *
 * SECURITY (SEC-4 — memory content is untrusted, never instructions):
 * - NO rehype-raw, NO dangerouslySetInnerHTML: raw HTML in the source is
 *   skipped by react-markdown's default (script/iframe/style/on*)
 *   attributes never reach the DOM.
 * - Link hrefs are whitelisted to http(s)/mailto; every other scheme
 *   (javascript:, data:, vbscript:, …) is stripped — the anchor renders
 *   as inert text, not as a link. External links get target=_blank +
 *   rel=noopener noreferrer nofollow.
 * - Image srcs are whitelisted to http(s); anything else renders nothing
 *   (no data:/relative tracking pixels or protocol tricks).
 * - CSP stays intact: script-src 'self' is never touched.
 *
 * Typography is design-token only (no literal colours/spacings): headings
 * scale just above body size (hierarchy, not billboards), code is JetBrains
 * Mono on the elevated surface, tables use border-subtle, links iris.
 * Both themes are served by the same tokens — nothing theme-specific here.
 */

/** JetBrains Mono via token (the code font everywhere — docs precedent). */
const MONO: React.CSSProperties = { fontFamily: "var(--font-mono)" };

const LINK_CLASS =
  "text-iris-bright underline underline-offset-2 transition-colors duration-instant hover:decoration-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright";

/** Only these URL schemes may become live links (memory content is untrusted). */
function isAllowedHref(href: string | undefined): boolean {
  return typeof href === "string" && /^(https?:\/\/|mailto:)/i.test(href);
}

/** Images: http(s) absolute only — no data:, no protocol-relative tricks. */
function isAllowedImageSrc(src: string | undefined): boolean {
  return typeof src === "string" && /^https?:\/\//i.test(src);
}

// Minimal structural hast shape (same approach as features/docs/Markdown.tsx —
// avoids transitive type packages while covering node text extraction).
interface HastishNode {
  type: string;
  value?: unknown;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: readonly HastishNode[];
}

function nodeText(node: HastishNode | undefined): string {
  if (node === undefined) return "";
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(nodeText).join("");
}

/**
 * Element class map per variant. `compact` — card previews (no giant
 * headings, tight rhythm); `full` — detail views and expanded bodies
 * (base-size body, readable spacing). Tokens only.
 */
function variantClasses(variant: "compact" | "full"): Components {
  const compact = variant === "compact";
  return {
    h1: ({ children }) => (
      <h1 className={cn(compact ? "mb-1 mt-2 text-sm font-semibold" : "mb-2 mt-4 text-lg font-semibold", "text-foreground")}>
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 className={cn(compact ? "mb-1 mt-2 text-sm font-semibold" : "mb-2 mt-4 text-md font-semibold", "text-foreground")}>
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className={cn(compact ? "mb-1 mt-2 text-sm font-medium" : "mb-1.5 mt-3 text-base font-semibold", "text-foreground")}>
        {children}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 className={cn(compact ? "mb-1 mt-2 text-sm font-medium" : "mb-1.5 mt-3 text-sm font-semibold", "text-foreground")}>
        {children}
      </h4>
    ),
    h5: ({ children }) => (
      <h5 className="mb-1 mt-2 text-sm font-medium text-foreground">{children}</h5>
    ),
    h6: ({ children }) => (
      <h6 className="mb-1 mt-2 text-sm font-medium text-foreground-secondary">{children}</h6>
    ),
    p: ({ children }) => (
      <p className={compact ? "my-1 leading-snug" : "my-2 leading-relaxed"}>{children}</p>
    ),
    ul: ({ children }) => (
      <ul className="my-2 list-disc space-y-1 pl-5 marker:text-foreground-muted">
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-foreground-muted">
        {children}
      </ol>
    ),
    li: ({ children }) => (
      <li className={compact ? "leading-snug" : "leading-relaxed"}>{children}</li>
    ),
    strong: ({ children }) => (
      <strong className="font-semibold text-foreground">{children}</strong>
    ),
    a: ({ href, children }) => {
      if (!isAllowedHref(href)) {
        // Stripped scheme (javascript:, data:, …) or empty — inert text.
        return <span>{children}</span>;
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className={LINK_CLASS}
        >
          {children}
        </a>
      );
    },
    blockquote: ({ children }) => (
      <blockquote className="my-2 border-l-2 border-iris-dim pl-3 text-foreground-secondary">
        {children}
      </blockquote>
    ),
    // Block code short-circuits here — the inner `code` never renders
    // (extraction keeps the text exact, like the docs renderer).
    pre: ({ node }) => {
      const hast = node as unknown as HastishNode | undefined;
      return (
        <pre
          style={MONO}
          className="my-2 overflow-x-auto rounded-md border border-border-subtle bg-elevated p-3 text-xs leading-relaxed text-foreground"
        >
          <code>{nodeText(hast)}</code>
        </pre>
      );
    },
    // Only INLINE code reaches `code` (block was short-circuited by pre).
    code: ({ children }) => (
      <code
        style={MONO}
        className="rounded-sm border border-border-subtle bg-elevated px-1 py-px text-[0.875em] text-foreground [overflow-wrap:anywhere]"
      >
        {children}
      </code>
    ),
    table: ({ children }) => (
      <div className="my-2 overflow-x-auto rounded-md border border-border-subtle">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border-b border-border px-2.5 py-1.5 text-left text-xs font-medium text-foreground-secondary">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="border-b border-border-subtle px-2.5 py-1.5 text-sm [tr:last-child_&]:border-b-0">
        {children}
      </td>
    ),
    img: ({ src, alt, title }) => {
      if (!isAllowedImageSrc(typeof src === "string" ? src : undefined)) {
        return null; // untrusted or relative src — no image, no broken icon
      }
      return (
        <img
          src={src}
          alt={alt ?? ""}
          title={title}
          loading="lazy"
          className="my-2 max-w-full rounded-md border border-border-subtle"
        />
      );
    },
    hr: () => <hr className="my-3 border-border-subtle" />,
    // GFM task-list checkboxes render disabled, never interactive (the
    // memory text is a document, not a form) — iris token accent.
    input: ({ node: _node, ...props }) => (
      <input
        {...props}
        disabled
        className="mr-1.5 size-3.5 align-middle accent-[var(--color-iris-bright)]"
      />
    ),
  };
}

export interface MarkdownViewProps {
  source: string;
  /** compact — card previews; full — details and expanded bodies. */
  variant?: "compact" | "full";
  className?: string;
  /** Font passthrough (mono memories keep --font-mono via the caller). */
  style?: React.CSSProperties;
}

/**
 * Stable identity matters: TextEngine memoizes on props, and the components
 * map is rebuilt only when the variant actually changes.
 */
function MarkdownViewImpl({ source, variant = "full", className, style }: MarkdownViewProps) {
  const components = variantClasses(variant);
  return (
    <div
      className={cn(
        // First/last block margins collapse into the container rhythm.
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        variant === "compact" ? "text-sm" : "text-base",
        className,
      )}
      style={style}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Default-exported for the lazy chunk boundary: TextEngine loads this module
 * via React.lazy(() => import("./MarkdownView")) — plain texts never fetch it.
 */
export const MarkdownView = memo(MarkdownViewImpl);
export default MarkdownView;
