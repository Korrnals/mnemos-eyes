/**
 * The settings-card form logic (AGW-6 B) — pure, React-free, unit-testable.
 *
 * PATCH diff rule (verified against server/app.py PATCH route + store
 * .update_executor): the route does ``body.model_dump(exclude_none=True)``
 * and the model holds ONLY {name, state, capabilities, enabled} — so the
 * client sends ONLY the fields the owner actually changed; an unchanged
 * field must stay ABSENT, never null (null would be dropped anyway, but
 * absence is the honest wire), and harness/transport/host/version have no
 * place in the model at all (they are the machine's declared identity —
 * unpatchable by design).
 *
 * ``capabilities: []`` is a VALID diff (the server treats an empty list as
 * a deliberate wipe), so emptiness of the array never means "skip the
 * field" — only absence from the diff does.
 */

import type { ExecutorItem } from "@/gateway/boardTypes";

/** Strip + clamp to the server's rules (store: strip()[:120], empty → 422). */
export function normalizeExecutorName(raw: string): string {
  return raw.trim().slice(0, 120);
}

/**
 * The name/capabilities diff of the form against the loaded row.
 * Empty name (after trim) is NEVER sent — the server 422s it; the card
 * disables Save instead. capabilities compares by exact string lists.
 */
export function executorPatchDiff(
  loaded: Pick<ExecutorItem, "name" | "capabilities">,
  form: { readonly name: string; readonly capabilities: readonly string[] },
): { name?: string; capabilities?: string[] } {
  const diff: { name?: string; capabilities?: string[] } = {};
  const name = normalizeExecutorName(form.name);
  if (name !== "" && name !== loaded.name) diff.name = name;
  const caps = [...form.capabilities];
  if (caps.join("\u0000") !== loaded.capabilities.join("\u0000")) {
    diff.capabilities = caps;
  }
  return diff;
}

/** Server mirror (store.update_executor): trim, drop empties, dedup, ≤64. */
export const EXECUTOR_CAPABILITIES_MAX = 64;

/** Normalize one capability the way the store will (trim, clamp 120). */
export function normalizeCapability(raw: string): string {
  return raw.trim().slice(0, 120);
}

/** Add a capability: trimmed, de-duplicated, capped at 64. null = rejected. */
export function addCapability(
  list: readonly string[],
  raw: string,
): string[] | null {
  const value = normalizeCapability(raw);
  if (value === "" || list.includes(value) || list.length >= EXECUTOR_CAPABILITIES_MAX) {
    return null;
  }
  return [...list, value];
}
