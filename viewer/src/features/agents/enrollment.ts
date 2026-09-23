import type { EnrollmentItem, EnrollmentState } from "@/gateway/boardTypes";

/**
 * Enrollment token view-helpers (AGW-5 phase 2). Pure + node-testable:
 *
 * - `effectiveEnrollmentState` — the VIEW state of a row. The server's TTL
 *   sweeper (60 s pairing-sweeper cycle) flips created → expired and the
 *   SSE `enrollment.expired` frame carries it; between frames the honest
 *   client answer for a row past its `expires_at` is «истёк» already —
 *   a live countdown never reads negative (the wire state stays the
 *   source of truth for used/revoked, which only transitions server-side).
 * - `formatTtlCountdown` — mono mm:ss off the shared 1 Hz ticker.
 * - `buildBootstrapSteps` — the VPS command block of the token screen.
 *   The WORDING is copied from deploy/poller/REMOTE-EXECUTOR.md (§4б/§4в)
 *   — this module must not invent a second runbook; the runbook stays the
 *   source of truth, these strings are its copy-paste projection.
 */

/** TTL mirror of the server constant (design §Solution: 15 min). */
export const ENROLLMENT_TTL_MS = 15 * 60 * 1000;

/**
 * The on-screen mask of an mne_ token (AGW-11): the prefix stays readable
 * (it identifies the CLASS), the material never renders. The clipboard
 * copy is the only place the plaintext goes — the mask is display-only.
 */
export function maskEnrollmentToken(token: string): string {
  return `${token.slice(0, 4)}${"•".repeat(12)}`;
}

/**
 * View state: wire state wins, except a `created` row whose TTL has passed
 * — the sweeper may not have fired/SSE may not have arrived yet, and
 * showing «ждёт подключения» over a dead token would be a lie.
 */
export function effectiveEnrollmentState(
  row: Pick<EnrollmentItem, "state" | "expires_at">,
  now: number,
): EnrollmentState {
  if (row.state !== "created") return row.state;
  const at = Date.parse(row.expires_at);
  if (!Number.isFinite(at)) return row.state;
  return now >= at ? "expired" : "created";
}

/** Mono countdown for a live token ("14:03"); null when not live. */
export function formatTtlCountdown(
  row: Pick<EnrollmentItem, "state" | "expires_at">,
  now: number,
): string | null {
  if (effectiveEnrollmentState(row, now) !== "created") return null;
  const at = Date.parse(row.expires_at);
  if (!Number.isFinite(at)) return null;
  const totalS = Math.max(0, Math.floor((at - now) / 1000));
  const minutes = Math.floor(totalS / 60);
  const seconds = totalS % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export interface BootstrapContext {
  /** The freshly minted mne_… token (rides the commands, once). */
  readonly token: string;
  /** executor_name for the registration body (hint → label → "executor"). */
  readonly name: string;
  /** harness for the registration body (the form's allowlist select). */
  readonly harness: string;
}

/**
 * The VPS bootstrap steps, verbatim from REMOTE-EXECUTOR.md §4б/§4в:
 * register → secret to env (0600, never config/prompts) → poller.yaml
 * keys (board_url / executor_id / executor_name / ca_bundle / allowlist)
 * → dry-run once, then the unit (README). `BOARD_URL` stays a placeholder —
 * the address that RESOLVES from the VPS is the owner's fact (§2), not the
 * UI's guess.
 */
export function buildBootstrapSteps(ctx: BootstrapContext): readonly string[] {
  return [
    // 4б — registration with the one-time token. The export line leads the
    // step (REMOTE-EXECUTOR.md §4б): without it $BOARD_URL is an unbound
    // variable on a fresh shell — paste-as-is must actually paste.
    "# 1. регистрация (одноразовый enrollment-токен, TTL 15 мин):\n" +
      'export BOARD_URL="https://<board-через-оверлей>"\n' +
      'curl -sS -X POST "$BOARD_URL/api/executors" \\\n' +
      '  -H "Authorization: Bearer ' +
      ctx.token +
      '" \\\n' +
      '  -H "Content-Type: application/json" \\\n' +
      "  -d '{\"name\":\"" +
      ctx.name +
      '","harness":"' +
      ctx.harness +
      '","host":"' +
      ctx.name +
      '","transport":"local-poll"}\'',
    // 4в п.1 — the executor_secret to env, NEVER config/prompts.
    "# 2. секрет из ответа → env-файл 0600 (не в конфиг и не в промпты):\n" +
      "sudo install -m 0600 -o root -g root /dev/null /etc/vesmaro/poller.env\n" +
      "echo 'VESMARO_BOARD_TOKEN=<executor_secret>' | " +
      "sudo tee /etc/vesmaro/poller.env >/dev/null",
    // 4в п.2 — the yaml keys; executor_id is the presence piggyback gate.
    "# 3. ~/.config/mnemos-eyes/poller.yaml (chmod 0600): board_url — адрес, " +
      "резолвящийся с VPS; executor_id — id из ответа шага 1 (пустое = вечно " +
      "offline); executor_name = " +
      ctx.name +
      "; ca_bundle — лабораторный CA; allowlist — см. README §5",
    // 4в п.3 — dry-run, then the unit (README owns the install).
    "# 4. проверка и запуск: VESMARO_BOARD_TOKEN=<executor_secret> python3 " +
      "scripts/assignment_poller.py --once (dry-run; 403 на machine-операциях " +
      "до approve — ожидаемо), затем systemd unit — deploy/poller/README.md",
  ];
}

/** Copy-all payload: the steps joined the way a shell pastes them. */
export function buildBootstrapScript(steps: readonly string[]): string {
  return `${steps.join("\n\n")}\n`;
}
