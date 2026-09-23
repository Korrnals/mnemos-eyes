/**
 * The provision→approve context bridge (AGW-11, Архком-8 §2).
 *
 * The paste-back verify (approve of a NEW TOFU pin needs the owner to
 * type the fingerprint tail read ON THE TARGET) requires two facts the
 * executor registry row does NOT carry: the pinned host-key fingerprint
 * and whether THIS job minted it (TOFU) or merely enforced an earlier
 * pin. They live on the provision JOB — and the board exposes job reads
 * by id only (no executor→job backlink; a server-side projection would
 * be a backend slice).
 *
 * So the connect card PUBLISHES its job verdict into sessionStorage
 * keyed by the minted executor id: the registry sheet (possibly a
 * different surface, possibly after a reload) reads it when rendering a
 * pending row. Honest scope: the context exists only in the browser
 * session that ran the job — a pending row without context (the manual
 * mint path, another device) renders the plain approve; the fingerprint
 * itself is PUBLIC material (a host public key pin), never a secret.
 */

export interface ProvisionApproveContext {
  /** The pinned host-key fingerprint (canonical SHA256:base64). */
  readonly fingerprint: string;
  /** True = minted by THIS job's TOFU (paste-back applies). */
  readonly tofu: boolean;
  /** The job id (diagnostics/copy material). */
  readonly jobId: string;
}

const STORAGE_PREFIX = "vesmaro.provision-approve.";

/**
 * Same-tab publish signal (PR #99 review P3-1): the `storage` event never
 * fires in the tab that WROTE, and a no-change refetch re-renders nothing
 * (React Query structural sharing) — so the connect card dispatches this
 * CustomEvent when a job verdict lands, and an already-open registry
 * sheet picks the paste-back up live instead of waiting for a remount.
 */
export const PROVISION_APPROVE_PUBLISHED = "vesmaro:provision-approve";

function keyOf(executorId: string): string {
  return `${STORAGE_PREFIX}${executorId}`;
}

/** Publish one job verdict for the pending executor it minted. */
export function rememberProvisionApprove(
  executorId: string,
  context: ProvisionApproveContext,
): void {
  try {
    window.sessionStorage.setItem(
      keyOf(executorId),
      JSON.stringify(context),
    );
  } catch {
    // Private mode / quota — no storage, no signal: the sheet keeps the
    // plain approve (the honest fallback).
    return;
  }
  window.dispatchEvent(
    new CustomEvent(PROVISION_APPROVE_PUBLISHED, { detail: { executorId } }),
  );
}

/** Peek WITHOUT consuming (rendering may happen before the click). */
export function peekProvisionApprove(
  executorId: string,
): ProvisionApproveContext | null {
  try {
    const raw = window.sessionStorage.getItem(keyOf(executorId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as ProvisionApproveContext).fingerprint !== "string" ||
      typeof (parsed as ProvisionApproveContext).tofu !== "boolean"
    ) {
      return null;
    }
    return parsed as ProvisionApproveContext;
  } catch {
    return null;
  }
}

/** Drop the context (the verify is one-shot — the approve click consumes it). */
export function clearProvisionApprove(executorId: string): void {
  try {
    window.sessionStorage.removeItem(keyOf(executorId));
  } catch {
    // Nothing to do — a stuck context only means an extra paste-back.
  }
}
