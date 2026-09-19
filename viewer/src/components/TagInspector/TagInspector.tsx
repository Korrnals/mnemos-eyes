import { Input } from "@/components/ui/input";
import { TagBadge } from "@/components/TagBadge/TagBadge";
import { useT } from "@/i18n";

/**
 * Sorted, filterable tag list with counts (component-inventory §6). The shape
 * mirrors the inventory prop (`tags: Record<string, number>`); contract
 * prefixes are highlighted through TagBadge's prefix→variant mapping.
 */
export interface TagInspectorProps {
  tags: Record<string, number>;
  onTagClick: (tag: string) => void;
  className?: string;
}

export function TagInspector({ tags, onTagClick, className }: TagInspectorProps) {
  const t = useT();
  // Sorted by count desc, then name (deterministic order for tests/SSR).
  const entries = Object.entries(tags).sort(([tagA, countA], [tagB, countB]) => {
    if (countB !== countA) return countB - countA;
    return tagA.localeCompare(tagB);
  });
  const max = entries.reduce((acc, [, count]) => Math.max(acc, count), 1);

  if (entries.length === 0) {
    return <p className={className}>{t("tags.noneInWell")}</p>;
  }

  return (
    <ul className={className}>
      {entries.map(([tag, count]) => (
        <li key={tag} className="flex items-center gap-3 py-1">
          <TagBadge tag={tag} size="md" count={count} onClick={() => onTagClick(tag)} />
          <span
            aria-hidden="true"
            className="h-1 rounded-full bg-iris-dim"
            style={{ width: `${Math.max((count / max) * 100, 4)}%` }}
          />
          <span className="sr-only">{t("tags.memoriesCount", { count })}</span>
        </li>
      ))}
    </ul>
  );
}

/** Text input narrowing the inspector list client-side. */
export function TagFilterInput({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  id: string;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-foreground-secondary">
        {t("tags.filterLabel")}
      </label>
      <Input
        id={id}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t("tags.filterPlaceholder")}
        className="max-w-xs"
      />
    </div>
  );
}
