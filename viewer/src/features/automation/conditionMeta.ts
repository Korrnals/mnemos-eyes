import type { ConditionItem } from "@/gateway/boardTypes";

/**
 * Condition meta-dictionary (SCHED-1, ADR 0013 §8): the server ships the
 * CLOSED allowlists (`GET /api/automation/status` → condition_meta) — the
 * editor is a triple of DEPENDENT SELECTS over them. A free-text condition
 * control does not exist in the DOM, by contract and by regression test.
 * Field ids (col/status/state/env/priority/transport/project/specialist/
 * executor_id/harness) render VERBATIM — server ids are the UI vocabulary
 * (review SCHED-1-UI P3-3 removed the phantom-label mapping: no UI-side
 * renaming layer exists, none is needed).
 */
export interface ConditionMeta {
  /** Closed field allowlist (sorted server-side). */
  readonly fields: readonly string[];
  /** Closed operator allowlist (one set for every field). */
  readonly ops: readonly string[];
  /** field → closed value enum, or null where no closed set exists. */
  readonly valuesHint: Readonly<Record<string, readonly string[] | null>>;
  /** Hook-event whitelist (hook editor's `on` select). */
  readonly events: readonly string[];
  /** Hook action whitelist. */
  readonly actions: readonly string[];
  /** Hook source-origin whitelist. */
  readonly sourceOrigins: readonly string[];
}

/** Narrow the anonymous status dict onto the honest view fields. */
export function parseConditionMeta(raw: unknown): ConditionMeta | null {
  if (typeof raw !== "object" || raw === null) return null;
  const source = raw as Record<string, unknown>;
  const strings = (value: unknown): readonly string[] | null =>
    Array.isArray(value) && value.every((item) => typeof item === "string")
      ? (value as string[])
      : null;
  const fields = strings(source.fields);
  const ops = strings(source.ops);
  if (!fields || !ops) return null;
  const hint: Record<string, readonly string[] | null> = {};
  if (typeof source.values_hint === "object" && source.values_hint !== null) {
    for (const [field, value] of Object.entries(
      source.values_hint as Record<string, unknown>,
    )) {
      hint[field] = strings(value);
    }
  }
  return {
    fields,
    ops,
    valuesHint: hint,
    events: strings(source.events) ?? [],
    actions: strings(source.actions) ?? [],
    sourceOrigins: strings(source.source_origins) ?? [],
  };
}

/** Human-readable clause line: «field op value» over the wire triple. */
export function describeClause(clause: ConditionItem): string {
  return `${clause.field} ${clause.op} ${String(clause.value)}`;
}
