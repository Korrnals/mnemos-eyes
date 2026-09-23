import { useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { Check, Copy } from "lucide-react";
import { Link } from "react-router";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { createHeadingSlugger } from "./headingSlug";
import { resolveDocImageUrl } from "./docsAssets";
import { resolveDocLink } from "./docsLinks";
import { sanitizeSchema } from "./sanitizeSchema";
import { MermaidDiagram } from "./Mermaid";

/**
 * The SINGLE react-markdown + remark-gfm point (contract §3, gate §9.4; raw
 * HTML pipeline per АРХКОМ-8): raw HTML IS rendered, but only after
 * `rehype-raw` → `rehype-sanitize(sanitizeSchema)` IN THAT ORDER — the
 * defaultSchema-minus schema is the security boundary, this file is its only
 * call site (ESLint enforces; dangerouslySetInnerHTML stays banned). GitHub
 * parity: GFM tables, details/summary, kbd/sub/sup, task lists; hostile
 * content dies in the schema, not in the DOM. Element classes follow the
 * design-spec token table (§6–§7) — no literal colours anywhere. In-body
 * images resolve through docsAssets.ts (the one asset glob); absolute
 * http(s) srcs and unknown paths render as-is (CSP bounds the rest).
 * Links: /docs* stay SPA Links, anchors stay plain, and corpus-internal
 * references (our `slug.md`, upstream board slugs like `mnemos/user/sync`)
 * resolve through the manifest into project-scoped URLs (W1c — дефект из W2).
 */

/**
 * Leading provenance banners (GENERATED/curated comments) are presentation
 * noise — the sidecar badge carries provenance already (АРХКОМ-8 verdict 1):
 * whole-line `<!-- ... -->` comments at the very top of the body are cut
 * BEFORE the pipeline. Line-based by design: a comment embedded in content
 * is NOT stripped here (the sanitizer drops it instead).
 */
function stripLeadingBanners(source: string): string {  const lines = source.split("\n");
  let index = 0;
  while (index < lines.length && /^\s*<!--.*-->\s*$/.test(lines[index])) index += 1;
  return index === 0 ? source : lines.slice(index).join("\n").replace(/^\s+/, "");
}

/**
 * script/style/iframe subtrees are removed WHOLE, not schema-disallowed:
 * hast-util-sanitize replaces disallowed elements with their CHILDREN, so a
 * schema-only ban would leak the JS/CSS/frame source as visible text.
 * GitHub hides that content — so do we (АРХКОМ-8 hostile gate).
 */
const DROPPED_SUBTREES = new Set(["script", "style", "iframe"]);

function rehypeDropSubtrees() {
  return (tree: HastishNode) => {
    const walk = (node: HastishNode) => {
      const children = node.children;
      if (children === undefined) return;
      const kept: HastishNode[] = [];
      for (const child of children) {
        if (isElement(child) && DROPPED_SUBTREES.has(child.tagName ?? "")) continue;
        walk(child);
        kept.push(child);
      }
      (node as { children?: HastishNode[] }).children = kept;
    };
    walk(tree);
  };
}

// Minimal structural hast shape (avoids importing transitive type packages
// while staying assignable from the real @types/hast elements).
interface HastishNode {
  type: string;
  value?: unknown;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: readonly HastishNode[];
}

function isElement(node: HastishNode | undefined): boolean {
  return node !== undefined && node.type === "element";
}

function nodeText(node: HastishNode | undefined): string {
  if (node === undefined) return "";
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(nodeText).join("");
}

/** `language-*` token of a code element (undefined when absent/unmatched). */
function languageOf(node: HastishNode | undefined): string | undefined {
  const className = node?.properties?.className;
  if (!Array.isArray(className)) return undefined;
  const token = className.find(
    (name) => typeof name === "string" && name.startsWith("language-"),
  ) as string | undefined;
  return token?.slice("language-".length);
}

/** JetBrains Mono for ALL code (design spec §1: вес 400 — других нет). */
const MONO: React.CSSProperties = { fontFamily: "var(--font-mono)" };

/** Search-hit <mark> — shared styling (design spec §6). */
export const DOCS_MARK_CLASS = "rounded-sm bg-iris/15 px-0.5 text-foreground";

const LINK_CLASS =
  "text-iris-bright underline underline-offset-2 transition-colors duration-instant hover:decoration-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright";

/** Unresolvable .md reference — visibly broken, never a crash (W1c gate). */
const BROKEN_LINK_CLASS =
  "text-foreground-muted underline decoration-dashed underline-offset-2";

function CopyButton({ code }: { code: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    // Clipboard can be absent (permissions, offline webview) — stay silent.
    void navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => undefined,
    );
  };
  return (
    <>
      <button
        type="button"
        onClick={copy}
        disabled={copied}
        aria-disabled={copied}
        aria-label={t("docs.copy.code")}
        className={cn(
          "absolute right-2 top-2 z-10 inline-flex size-8 items-center justify-center rounded-sm",
          "border border-border-subtle bg-elevated text-foreground-secondary",
          "transition-colors duration-instant hover:text-foreground",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright",
          copied && "cursor-default",
        )}
      >
        {/* Confirmation is the SHAPE (Copy → Check), not a colour — spec §7.2. */}
        {copied ? (
          <Check className="size-4" aria-hidden="true" />
        ) : (
          <Copy className="size-4" aria-hidden="true" />
        )}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? t("docs.copy.done") : ""}
      </span>
    </>
  );
}

function CodeBlock({ node }: { node?: HastishNode }) {
  const codeNode = (node?.children ?? []).find((child) => isElement(child));
  const code = nodeText(codeNode);
  const language = languageOf(codeNode);
  return (
    <div className="relative my-4">
      {language ? (
        <span
          style={MONO}
          className="absolute left-3 top-2 text-xs text-foreground-muted"
          aria-hidden="true"
        >
          {language}
        </span>
      ) : null}
      <CopyButton code={code} />
      {/* Horizontal scroll, NEVER wrapping (copy must stay exact — spec §7.2). */}
      <pre
        style={MONO}
        className="overflow-x-auto rounded-md border border-border-subtle bg-elevated p-4 pt-8 text-sm leading-normal text-foreground"
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}

function buildComponents(pageSlug: string | undefined): Components {
  const slug = createHeadingSlugger();
  return {
    h1: ({ node, children }) => (
      // The page h1 renders outside the md body; a body h1 is a content bug
      // the integrity test catches — render it, styled, at least honestly.
      <h1
        id={slug(nodeText(node))}
        className="mb-4 scroll-mt-24 text-xl font-semibold text-foreground"
      >
        {children}
      </h1>
    ),
    h2: ({ node, children }) => (
      <h2
        id={slug(nodeText(node))}
        className="mb-4 mt-10 scroll-mt-24 text-lg font-semibold text-foreground"
      >
        {children}
      </h2>
    ),
    h3: ({ node, children }) => (
      <h3
        id={slug(nodeText(node))}
        className="mb-3 mt-8 scroll-mt-24 text-base font-semibold text-foreground"
      >
        {children}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 className="text-base font-medium text-foreground">{children}</h4>
    ),
    // Upstream typography (design spec §9.2): h5–h6 share one honest look —
    // text-sm/medium. Order stays visible; TOC remains h2/h3 only.
    h5: ({ children }) => (
      <h5 className="text-sm font-medium text-foreground">{children}</h5>
    ),
    h6: ({ children }) => (
      <h6 className="text-sm font-medium text-foreground-secondary">{children}</h6>
    ),
    p: ({ children }) => (
      <p className="mb-4 text-base leading-relaxed text-foreground">{children}</p>
    ),
    ul: ({ children }) => (
      <ul className="mb-4 list-disc space-y-2 pl-6 marker:text-foreground-muted">
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="mb-4 list-decimal space-y-2 pl-6 marker:text-foreground-muted">
        {children}
      </ol>
    ),
    li: ({ children }) => (
      <li className="text-base leading-relaxed text-foreground">{children}</li>
    ),
    a: ({ href, children }) => {
      if (!href) return <a className={LINK_CLASS}>{children}</a>;
      // Internal docs links stay in-app (no full reload); anchors are plain.
      if (href.startsWith("/docs")) {
        return (
          <Link to={href} className={LINK_CLASS}>
            {children}
          </Link>
        );
      }
      if (href.startsWith("#"))
        return (
          <a href={href} className={LINK_CLASS}>
            {children}
          </a>
        );
      // Corpus-internal references (slug.md / board slugs) → SPA links;
      // unresolvable .md refs render visibly broken — never a crash.
      const resolution = resolveDocLink(href, pageSlug);
      if (resolution.kind === "internal") {
        return (
          <Link to={resolution.to} className={LINK_CLASS}>
            {children}
          </Link>
        );
      }
      if (resolution.kind === "broken") {
        // A content bug the integrity gates should catch — signal it here
        // without crashing the page (W1c gate) and leave a console trace.
        console.warn(
          `[docs] unresolved markdown link "${href}" on page "${pageSlug ?? "?"}"`,
        );
        return (
          <a href={href} className={BROKEN_LINK_CLASS}>
            {children}
          </a>
        );
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
          {children}
        </a>
      );
    },
    blockquote: ({ children }) => (
      <blockquote className="mb-4 border-l-2 border-iris-dim pl-4 text-foreground-secondary">
        {children}
      </blockquote>
    ),
    // Block code short-circuits here (the inner `code` never renders).
    // mermaid fences are intercepted FIRST (АРХКОМ-8): they become
    // diagrams, not code blocks — the pre wrapper is skipped entirely.
    pre: ({ node }) => {
      const codeNode = (node?.children ?? []).find((child) => isElement(child));
      if (languageOf(codeNode) === "mermaid") {
        return <MermaidDiagram code={nodeText(codeNode)} />;
      }
      return <CodeBlock node={node} />;
    },
    // Everything reaching `code` is INLINE code (spec §7.1) — except a
    // mermaid fence arriving without a pre parent (raw-HTML edge): it goes
    // to the diagram component as well, never through the inline styling.
    code: ({ node, children }) => {
      if (languageOf(node) === "mermaid") {
        return <MermaidDiagram code={nodeText(node)} />;
      }
      return (
        <code
          style={MONO}
          className="rounded-sm border border-border-subtle bg-elevated px-1.5 py-px text-sm text-foreground [overflow-wrap:anywhere]"
        >
          {children}
        </code>
      );
    },
    table: ({ children }) => (
      <div className="mb-4 overflow-x-auto rounded-md border border-border-subtle">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="[overflow-wrap:anywhere] border-b border-border px-3 py-2 text-left text-sm font-medium text-foreground-secondary">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="[overflow-wrap:anywhere] border-b border-border-subtle px-3 py-2 text-sm text-foreground [tr:last-child_&]:border-b-0">
        {children}
      </td>
    ),
    img: ({ src, alt, title }) => (
      <img
        src={resolveDocImageUrl(typeof src === "string" ? src : undefined)}
        alt={alt ?? ""}
        title={title}
        loading="lazy"
        className="mb-4 max-w-full rounded-md border border-border-subtle"
      />
    ),
    hr: () => <hr className="my-8 border-border-subtle" />,
    mark: ({ children }) => <mark className={DOCS_MARK_CLASS}>{children}</mark>,
  };
}

export interface MarkdownProps {
  source: string;
  className?: string;
  /**
   * Slug of the page being rendered — the base for resolving corpus-relative
   * links (`slug.md`, `../x.md`) through the manifest. Undefined in tests
   * and previews: relative refs then resolve from the corpus root.
   */
  pageSlug?: string;
}

export function Markdown({ source, className, pageSlug }: MarkdownProps) {
  // Built per render: a fresh object of closures is cheap, and a fresh
  // slug counter per pass keeps h2/h3 anchors deterministic (same heading
  // order → same ids) while restarting per document by construction.
  const components = buildComponents(pageSlug);
  return (
    <div className={cn("text-base leading-relaxed text-foreground", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Order IS the security model (АРХКОМ-8): raw HTML must exist as
        // nodes BEFORE the sanitizer prunes them — sanitize-first would
        // sanitize nothing (raw text nodes are inert), raw-without-sanitize
        // is the hole the first wave's gate existed to prevent. The
        // subtree-drop runs between them: script/style/iframe vanish whole.
        rehypePlugins={[
          rehypeRaw,
          rehypeDropSubtrees,
          [rehypeSanitize, sanitizeSchema],
        ]}
        components={components}
      >
        {stripLeadingBanners(source)}
      </ReactMarkdown>
    </div>
  );
}
