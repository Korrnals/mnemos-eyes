import { cn } from "@/lib/utils";

/**
 * Segmented control of the settings hub (UI-23, spec §3.2): buttons with
 * `aria-pressed` inside a `role="group"` — exactly the BoardStyleToggle
 * pattern («buttons change a display state, they don't move the user»), no
 * new control library. Active option `bg-iris/15 text-iris-bright`, inactive
 * `text-foreground-secondary hover:text-foreground` — state is never carried
 * by colour alone (1.4.1), targets are ≥24px (2.5.8), focus ring is the
 * project token ring.
 */
export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  /** Visible label (also the group's accessible name via aria-labelledby). */
  label: string;
  /** DOM id of the visible label span. */
  labelId: string;
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (value: T) => void;
  /** Optional hint line, wired to the group via aria-describedby. */
  hint?: string;
  hintId?: string;
}

export function SegmentedControl<T extends string>({
  label,
  labelId,
  value,
  options,
  onChange,
  hint,
  hintId,
}: SegmentedControlProps<T>) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span id={labelId} className="text-sm font-medium">
          {label}
        </span>
        <div
          role="group"
          aria-labelledby={labelId}
          aria-describedby={hint ? hintId : undefined}
          className="inline-flex overflow-hidden rounded-md border border-border-subtle"
        >
          {options.map((option, index) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  if (!active) onChange(option.value);
                }}
                className={cn(
                  "px-3 py-1.5 text-sm transition-colors duration-instant",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright",
                  index > 0 && "border-l border-border-subtle",
                  active
                    ? "bg-iris/15 text-iris-bright"
                    : "text-foreground-secondary hover:bg-elevated hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
      {hint ? (
        <p id={hintId} className="text-xs text-foreground-secondary">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
