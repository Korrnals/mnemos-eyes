import type { ProvisionJobState } from "@/gateway/boardTypes";
import type { TranslationKey } from "@/i18n";

/**
 * Connect-card view-helpers (AGW-11, wave 4; design
 * docs/design/2026-09-23-connect-provisioning.md §A/§D). Pure + node-
 * testable, the enrollment.ts posture:
 *
 * - `PROVISION_ERROR_HINTS` — the ONE typed-code table the UI renders
 *   human explanations from (Архком-8: hints as TABLES, never raw codes
 *   in the owner's face). Extensible by design: a new code = one entry;
 *   unknown codes fall through to the generic branch WITHOUT inventing a
 *   translation (the server's own `detail` stays visible below the hint).
 * - `PROVISION_STAGES` — the install FUNNEL as data. The stage ids are
 *   the board's vocabulary (bootstrap_started → … → wg_handshake_ok);
 *   `wg_handshake_ok` is a RESERVED slot so the Ф2mesh transport lands as
 *   one more entry, not a redesign.
 * - fingerprint helpers — the canonical pin is ssh-keygen SHA256:base64;
 *   the paste-back verify compares the LAST 8 HEX chars of the sha256
 *   digest, which the owner reads on the TARGET (`ssh-keygen -lf` prints
 *   base64, so the helper block shows the sha256sum pipeline instead).
 */

// --------------------------------------------------------------------- hints

/** How one typed error code renders in the card's failure block. */
export interface ProvisionErrorHint {
  /** i18n key of the human explanation (the headline). */
  readonly titleKey: TranslationKey;
  /** True for host_key_mismatch ONLY: the expected-fingerprint block is
   * technical by design (Архком-8 — the one place a raw fingerprint is
   * the helpful answer). */
  readonly showExpectedFingerprint?: boolean;
}

/**
 * The typed-code table (Архком-8 UX requirement 3). Keys are the SERVER's
 * error_code values verbatim; `ssh.timeout` is mapped alongside
 * ssh.unreachable (the board's older drafts said timeout — one table, both
 * spellings, no second source of truth). The wg.* entries are PLACEHOLDER
 * texts for the future transport legs (they cannot fire yet — the codes
 * live here so the funnel extends without touching the renderer).
 */
export const PROVISION_ERROR_HINTS: Readonly<
  Record<string, ProvisionErrorHint>
> = {
  "ssh.unreachable": { titleKey: "agents.provision.hint.sshUnreachable" },
  "ssh.timeout": { titleKey: "agents.provision.hint.sshUnreachable" },
  "ssh.auth_failed": { titleKey: "agents.provision.hint.sshAuthFailed" },
  "ssh.sudo_required": { titleKey: "agents.provision.hint.sshSudoRequired" },
  "ca.unavailable": { titleKey: "agents.provision.hint.caUnavailable" },
  host_key_mismatch: {
    titleKey: "agents.provision.hint.hostKeyMismatch",
    showExpectedFingerprint: true,
  },
  // Reserved transport legs (Ф2mesh backlog) — placeholder texts.
  "wg.key_delivery_failed": { titleKey: "agents.provision.hint.wgKeyDelivery" },
  "wg.handshake_timeout": { titleKey: "agents.provision.hint.wgHandshake" },
  "bootstrap.timeout": { titleKey: "agents.provision.hint.bootstrapTimeout" },
  "register.timeout": { titleKey: "agents.provision.hint.registerTimeout" },
  "provisioner.restarted": { titleKey: "agents.provision.hint.restarted" },
  "pin.invalidated": { titleKey: "agents.provision.hint.pinInvalidated" },
  timeout: { titleKey: "agents.provision.hint.bootstrapTimeout" },
};

/** The hint for one code; unknown codes get the honest generic branch. */
export function provisionErrorHint(code: string): ProvisionErrorHint {
  if (code.startsWith("bootstrap.exit.")) {
    return { titleKey: "agents.provision.hint.bootstrapExit" };
  }
  return PROVISION_ERROR_HINTS[code] ?? {
    titleKey: "agents.provision.hint.generic",
  };
}

// --------------------------------------------------------------------- funnel

/**
 * The NORMALIZED job view the card renders: the wire row's `steps` is a
 * JSON string; parseSteps() flattens it to this shape once, at read time.
 */
export interface ProvisionJobView {
  readonly state: ProvisionJobState;
  readonly host_key_fingerprint: string;
  readonly steps: readonly string[];
}

/** The install funnel as ONE declarative structure (Архком-8 §4). */
export interface ProvisionStageDef {
  readonly id: string;
  readonly labelKey: TranslationKey;
  /**
   * Reached when the job's state/fingerprint says so — a pure predicate
   * over the view (the server states are the truth; the funnel is the
   * projection). `null` marks a RESERVED future stage (rendered as
   * «позже», never reached).
   */
  readonly reached: ((row: ProvisionJobView) => boolean) | null;
}

/** Ordered; the first not-reached stage is the current one. */
export const PROVISION_STAGES: readonly ProvisionStageDef[] = [
  {
    id: "bootstrap_started",
    labelKey: "agents.provision.stage.bootstrapStarted",
    reached: (row) => row.state !== "queued",
  },
  {
    id: "ca_pinned",
    labelKey: "agents.provision.stage.caPinned",
    // Strict mode seeds the fingerprint; TOFU fills it at first connect —
    // either way the trust anchor exists (the step text is the TOFU trace).
    reached: (row) =>
      row.host_key_fingerprint !== "" ||
      row.steps.some((step) => step.includes("host key pinned")),
  },
  {
    id: "poller_installed",
    labelKey: "agents.provision.stage.pollerInstalled",
    reached: (row) => row.state === "watching" || row.state === "done",
  },
  {
    id: "first_heartbeat",
    labelKey: "agents.provision.stage.firstHeartbeat",
    // done = the enrollment was consumed and the executor REGISTERED —
    // its registration poll IS the first heartbeat.
    reached: (row) => row.state === "done",
  },
  {
    // RESERVED (Ф2mesh): the wireguard handshake stage. Rendered as an
    // honest «позже» row; adding the transport = giving this a predicate.
    id: "wg_handshake_ok",
    labelKey: "agents.provision.stage.wgHandshake",
    reached: null,
  },
];

export type ProvisionStageStatus = "done" | "current" | "pending" | "reserved";

export interface ProvisionStageView {
  readonly def: ProvisionStageDef;
  readonly status: ProvisionStageStatus;
}

/**
 * Project one job view onto the funnel. A FAILED job keeps the stages it
 * reached — the current stage is where it died (the renderer overlays the
 * typed hint there); «тихий отказ» запрещён: every stage always renders.
 */
export function provisionFunnel(row: ProvisionJobView): readonly ProvisionStageView[] {
  let seenUnreached = false;
  return PROVISION_STAGES.map((def) => {
    if (def.reached === null) {
      return { def, status: "reserved" as ProvisionStageStatus };
    }
    if (!seenUnreached && def.reached(row)) {
      return { def, status: "done" as ProvisionStageStatus };
    }
    const status: ProvisionStageStatus = seenUnreached ? "pending" : "current";
    seenUnreached = true;
    return { def, status };
  });
}

// --------------------------------------------------------- connectivity slot

/**
 * Interim honesty (Архком-8 §5): until the Ф2mesh transport exists the
 * connectivity leg is a MANUAL tunnel, and the «connectivity profile» is
 * a RESERVED slot — the mesh profile lands as DATA here, not a redesign.
 */
export interface ProvisionConnectivity {
  /** "manual-tunnel" until Ф2mesh; "mesh" reserved for the future leg. */
  readonly kind: "manual-tunnel" | "mesh";
  /** RESERVED: the mesh profile payload (null until Ф2mesh). */
  readonly profile: null;
}

export const PROVISION_CONNECTIVITY_INTERIM: ProvisionConnectivity = {
  kind: "manual-tunnel",
  profile: null,
};

// -------------------------------------------------------------- fingerprints

/** Decode the canonical SHA256:base64 pin to its 64-char hex digest. */
export function fingerprintHex(fingerprint: string): string | null {
  const match = /^SHA256:([A-Za-z0-9+/]+)$/.exec(fingerprint.trim());
  if (!match) {
    const bare = /^([a-fA-F0-9]{64})$/.exec(fingerprint.trim());
    return bare ? bare[1].toLowerCase() : null;
  }
  try {
    const b64 = match[1];
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bytes = atob(padded);
    let out = "";
    for (let i = 0; i < bytes.length; i += 1) {
      out += bytes.charCodeAt(i).toString(16).padStart(2, "0");
    }
    return out.length === 64 ? out : null;
  } catch {
    return null;
  }
}

/**
 * The paste-back verify (Архком-8 §2): the owner types the LAST 8 HEX
 * chars of the fingerprint read ON THE TARGET; the pin matches when the
 * tail is equal (case-insensitive, whitespace-proof). True only on an
 * exact 8-hex-char match — partial input never approves.
 */
export function pasteBackMatches(fingerprint: string, input: string): boolean {
  const hex = fingerprintHex(fingerprint);
  if (hex === null) return false;
  const typed = input.trim().toLowerCase();
  if (!/^[a-f0-9]{8}$/.test(typed)) return false;
  return hex.slice(-8) === typed;
}

/** Was the pin minted by THIS job's TOFU (a NEW trust anchor to verify)? */
export function isTofuPin(row: ProvisionJobView): boolean {
  // TOFU wrote a step trace; strict-supplied/pin-enforced legs have the
  // fingerprint WITHOUT the trace (verified against an earlier trust act).
  return (
    row.host_key_fingerprint !== "" &&
    row.steps.some((step) => step.includes("host key pinned"))
  );
}

/** Parse the job's steps JSON (defensive — the column is a JSON string). */
export function parseSteps(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Live (non-terminal) job states — the card polls while true. */
export function isProvisionLive(state: ProvisionJobState): boolean {
  return state !== "done" && state !== "failed";
}
