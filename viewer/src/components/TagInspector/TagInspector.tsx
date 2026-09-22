import { Input } from "@/components/ui/input";
import { useT } from "@/i18n";

/** Text input narrowing the tags search/filter list client-side (UI-17:
 * the search box of the tags page; the old flat TagInspector list around
 * it was the killed «простыня» — removed with the tags-cloud wave). */
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
