import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ConditionItem } from "@/gateway/boardTypes";
import { useT } from "@/i18n";
import { describeClause, type ConditionMeta } from "./conditionMeta";

/**
 * The condition editor (ADR 0013 §8): a triple of DEPENDENT selects —
 * field → operator → value. The value select's options come from the
 * SERVER meta dictionary for the chosen field (`valuesHint[field]`); when
 * the field has no closed enum the clause cannot be completed in v1 (the
 * add stays disabled with an explanation — no free-text escape hatch
 * exists in the DOM, by contract). Adding a clause appends it to the
 * list; each clause has a visible remove button.
 */
export function ConditionEditor({
  meta,
  clauses,
  onChange,
  idPrefix,
}: {
  meta: ConditionMeta | null;
  clauses: readonly ConditionItem[];
  onChange: (clauses: readonly ConditionItem[]) => void;
  /** Unique id prefix so two forms on one page never collide. */
  idPrefix: string;
}) {
  const t = useT();
  const [field, setField] = useState("");
  const [op, setOp] = useState("");
  const [value, setValue] = useState("");

  const values = field ? (meta?.valuesHint[field] ?? null) : null;
  const completable =
    field.length > 0 &&
    op.length > 0 &&
    values !== null &&
    values.includes(value) &&
    value.length > 0;

  const add = (): void => {
    if (!completable) return;
    onChange([...clauses, { field, op, value }]);
    setField("");
    setOp("");
    setValue("");
  };

  return (
    <div className="space-y-2">
      <ul className="space-y-1" aria-label={t("automation.form.clausesLabel")}>
        {clauses.map((clause, index) => (
          <li
            key={`${describeClause(clause)}-${index}`}
            className="flex items-center gap-2 rounded-sm border border-border-subtle px-2 py-1 text-sm"
          >
            <span className="font-mono text-xs">{describeClause(clause)}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="ml-auto size-6"
              aria-label={t("automation.form.removeClause", { clause: describeClause(clause) })}
              onClick={() => onChange(clauses.filter((_, i) => i !== index))}
            >
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
          {t("automation.form.fieldLabel")}
          <select
            id={`${idPrefix}-condition-field`}
            value={field}
            onChange={(event) => {
              setField(event.target.value);
              setOp("");
              setValue("");
            }}
            className="h-8 w-40 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
          >
            <option value="">—</option>
            {(meta?.fields ?? []).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
          {t("automation.form.opLabel")}
          <select
            id={`${idPrefix}-condition-op`}
            value={op}
            disabled={field.length === 0}
            onChange={(event) => setOp(event.target.value)}
            className="h-8 w-28 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
          >
            <option value="">—</option>
            {(meta?.ops ?? []).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground-secondary">
          {t("automation.form.valueLabel")}
          <select
            id={`${idPrefix}-condition-value`}
            value={value}
            disabled={field.length === 0 || values === null}
            onChange={(event) => setValue(event.target.value)}
            className="h-8 w-44 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
          >
            <option value="">—</option>
            {(values ?? []).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!completable}
          title={
            field && values === null
              ? t("automation.form.noValueEnum")
              : t("automation.form.addClauseTitle")
          }
          onClick={add}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          {t("automation.form.addClause")}
        </Button>
      </div>
      {field && values === null ? (
        <p className="text-xs text-foreground-muted">{t("automation.form.noValueEnum")}</p>
      ) : null}
    </div>
  );
}
