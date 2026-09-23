/**
 * TextEngine — the single author-text primitive (UI-27).
 * Public surface for every surface that renders human/agent text:
 *
 *   import { TextEngine } from "@/components/TextEngine";
 *   <TextEngine text={record.content} variant="compact" clamp />
 *
 * Standard for new surfaces: ANY author content (memory records, task
 * specs, agent reports) goes through TextEngine; only interface chrome
 * (labels, i18n strings, navigation) stays plain JSX.
 *
 * CHUNKING CONTRACT: this barrel deliberately does NOT re-export
 * MarkdownView — the renderer (react-markdown, ~48 KB gzip vendor) must
 * stay reachable ONLY through TextEngine's dynamic import(). A static
 * re-export here would chain the parser into every route chunk and make
 * plain-text previews pay for it. Import MarkdownView directly from
 * "./MarkdownView" in tests only.
 */
export { TextEngine } from "./TextEngine";
export type { TextEngineProps } from "./TextEngine";
export { looksLikeMarkdown } from "./looksLikeMarkdown";
