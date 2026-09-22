import { useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { Link } from "react-router";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { createHeadingSlugger } from "./headingSlug";

/**
 * The SINGLE react-markdown + remark-gfm point (contract §3, gate §9.4).
 * NO rehype-raw: raw HTML in markdown is never rendered, so the sanitization
 * story is the react-markdown default (URL scheme whitelist + HTML skip).
 * Element classes follow the design-spec token table (§6–§7) — no literal
 * colours anywhere.
 */

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

/** JetBrains Mono for ALL code (design spec §1: вес 400 — других нет). */
const MONO: React.CSSProperties = { fontFamily: "var(--font-mono)" };

/** Search-hit <mark> — shared styling (design spec §6). */
export const DOCS_MARK_CLASS = "rounded-sm bg-iris/15 px-0.5 text-foreground";

const LINK_CLASS =
  "text-iris-bright underline underline-offset-2 transition-colors duration-instant hover:decoration-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright";

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
  const className = codeNode?.properties?.className;
  const language = Array.isArray(className)
    ? (
        className.find(
          (name) => typeof name === "string" && name.startsWith("language-"),
        ) as string | undefined
      )?.slice("language-".length)
    : undefined;
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

function buildComponents(): Components {
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
    pre: ({ node }) => <CodeBlock node={node} />,
    // Everything reaching `code` is INLINE code (spec §7.1).
    code: ({ children }) => (
      <code
        style={MONO}
        className="rounded-sm border border-border-subtle bg-elevated px-1.5 py-px text-sm text-foreground [overflow-wrap:anywhere]"
      >
        {children}
      </code>
    ),
    table: ({ children }) => (
      <div className="mb-4 overflow-x-auto rounded-md border border-border-subtle">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border-b border-border px-3 py-2 text-left text-sm font-medium text-foreground-secondary">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="border-b border-border-subtle px-3 py-2 text-sm text-foreground [tr:last-child_&]:border-b-0">
        {children}
      </td>
    ),
    img: ({ src, alt, title }) => (
      <img
        src={typeof src === "string" ? src : undefined}
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
}

export function Markdown({ source, className }: MarkdownProps) {
  // Built per render: a fresh object of closures is cheap, and a fresh
  // slug counter per pass keeps h2/h3 anchors deterministic (same heading
  // order → same ids) while restarting per document by construction.
  const components = buildComponents();
  return (
    <div className={cn("text-base leading-relaxed text-foreground", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
