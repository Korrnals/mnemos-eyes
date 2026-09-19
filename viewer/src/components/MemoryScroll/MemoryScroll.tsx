import { Link } from "react-router";
import { TagBadge } from "@/components/TagBadge/TagBadge";
import {
  formatConfidence,
  formatTimestamp,
  isMonoMemory,
} from "@/components/memory/memoryDisplay";
import { statusBadgeVariant, statusLabelKey } from "@/components/memory/memoryBadges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import type { Memory } from "@/gateway/types";

/**
 * The scroll surface (component-inventory §5, design-system.md §8.3): full
 * content in --font-scroll (mono for rule/code memories per D11), provenance
 * bar, raw toggle, tags row, confidence indicator, metadata footer.
 */
export interface MemoryScrollProps {
  memory: Memory;
  /** Show raw content instead of the effective content. */
  showRaw: boolean;
  onToggleRaw: () => void;
  className?: string;
}

export function MemoryScroll({
  memory,
  showRaw,
  onToggleRaw,
  className,
}: MemoryScrollProps) {
  const t = useT();
  const raw = memory.raw_content ?? null;
  const effective = memory.clean_content ?? memory.content;
  // Inventory §5.3: the toggle exists only when raw differs from effective.
  const rawDiffers = typeof raw === "string" && raw.length > 0 && raw !== effective;
  const shown = showRaw && rawDiffers ? raw : effective;
  const mono = isMonoMemory(memory);
  const related = (memory.derived_from ?? []).filter((id) => id.length > 0);

  return (
    <article className={className}>
      {/* 1. Provenance bar */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-foreground-secondary">
        <span>
          {t("memory.agentLabel")}{" "}
          <span className="text-foreground">
            {memory.agent || t("memory.agentUnknownShort")}
          </span>
        </span>
        <span>
          {t("memory.projectLabel")}{" "}
          <span className="text-foreground">{memory.project}</span>
        </span>
        <span>
          {t("memory.createdLabel")}{" "}
          <time dateTime={memory.created_at}>{formatTimestamp(memory.created_at)}</time>
        </span>
        <Badge variant={statusBadgeVariant(memory.status)}>
          {t(statusLabelKey(memory.status))}
        </Badge>
        {typeof memory.confidence === "number" ? (
          <span
            className="text-confidence"
            title={t("memory.confidenceTitle", { value: memory.confidence })}
          >
            {formatConfidence(memory.confidence)}
          </span>
        ) : null}
      </div>

      {/* 2. Content area — the scroll itself */}
      <div className="mt-4 rounded-lg border border-scroll-border bg-scroll-bg p-8 shadow-well">
        <h1
          className="font-scroll text-xl font-semibold leading-tight"
          style={mono ? { fontFamily: "var(--font-mono)" } : undefined}
        >
          {memory.title ?? memory.id}
        </h1>
        <p
          className="mt-6 whitespace-pre-wrap text-md leading-relaxed text-foreground"
          style={{ fontFamily: mono ? "var(--font-mono)" : "var(--font-scroll)" }}
        >
          {shown}
        </p>
      </div>

      {/* 3. Raw content toggle */}
      {rawDiffers ? (
        <div className="mt-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onToggleRaw}
            aria-pressed={showRaw}
          >
            {showRaw ? t("memory.showingRaw") : t("memory.showingEffective")} —{" "}
            {t("memory.rawSwitch")}
          </Button>
        </div>
      ) : null}

      {/* 4. Tags row */}
      {(memory.tags ?? []).length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-1.5">
          <Badge variant="outline">{memory.memory_type}</Badge>
          {memory.tags?.map((tag) => (
            <TagBadge key={tag} tag={tag} size="md" />
          ))}
        </div>
      ) : null}

      {/* Related memories (derived_from) — only rendered when the fixture carries links */}
      {related.length > 0 ? (
        <section aria-labelledby="related-memories" className="mt-6">
          <h2
            id="related-memories"
            className="text-sm font-semibold text-foreground-secondary"
          >
            {t("memory.related")}
          </h2>
          <ul className="mt-2 space-y-1">
            {related.map((id) => (
              <li key={id}>
                <Link
                  to={`/memories/${id}`}
                  className="inline-flex min-h-6 items-center font-mono text-sm text-iris-bright underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
                >
                  {id}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 6. Metadata footer */}
      <footer className="mt-6 border-t border-border-subtle pt-3 text-xs text-foreground-muted">
        <dl className="flex flex-wrap gap-x-6 gap-y-1">
          <div className="flex gap-1">
            <dt>{t("memory.idLabel")}</dt>
            <dd>{memory.id}</dd>
          </div>
          <div className="flex gap-1">
            <dt>{t("memory.updatedLabel")}</dt>
            <dd>
              <time dateTime={memory.updated_at}>
                {formatTimestamp(memory.updated_at)}
              </time>
            </dd>
          </div>
          <div className="flex gap-1">
            <dt>{t("memory.sourceLabel")}</dt>
            <dd>{memory.source}</dd>
          </div>
        </dl>
      </footer>
    </article>
  );
}
