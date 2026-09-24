/**
 * Device-class token storage (ADR 0012 §5 — the token LIVES ON THE DEVICE).
 *
 * The `/pair` exchange answers the one-shot `mnd_…` token; this module makes
 * the browser itself the token's home: localStorage (NOT sessionStorage —
 * the pairing must survive reloads and browser restarts, the owner never
 * re-pairs after closing a tab). The device identity rides board requests
 * as `Authorization: Bearer mnd_…` (see BoardAdapter
 * `identityTokenSource`) — scope v1 (ADR 0012 Amendment): `control`
 * devices mutate the board (tasks/reports/inbox/notifications), `read`
 * stays v0 read-only; closed-route mutations still answer 403 and that is
 * the honest verdict, not a bug.
 *
 * Keys mirror the board's `vesmaro.*` convention (uiToken.ts). Reads AND
 * writes are fail-soft: environments without localStorage (SSR passes,
 * hardened browsers, tests) answer "no identity" and never throw — the UI
 * degrades to the copy token affordance instead of breaking the flow.
 */

export const DEVICE_TOKEN_STORAGE_KEY = "vesmaro.deviceToken";
export const DEVICE_ID_STORAGE_KEY = "vesmaro.deviceId";
export const DEVICE_NAME_STORAGE_KEY = "vesmaro.deviceName";
export const DEVICE_SCOPE_STORAGE_KEY = "vesmaro.deviceScope";

/** Device scope v1 (ADR 0012 Amendment): `control` = board mutations,
 * `read` = the v0 read-only shape. */
export type DeviceScope = "control" | "read";

/** The device identity as issued by `POST /api/pairing/exchange` (200). */
export interface DeviceIdentity {
  /** The one-shot `mnd_…` bearer token. */
  token: string;
  /** Server-assigned device row id (`dev_…`). */
  deviceId: string;
  /** The self-asserted name the device presented at exchange. */
  deviceName: string;
  /** Scope v1: the exchange answers it. Optional for identities stored
   * BEFORE the field existed (a phone paired on 1.22.x) — the server-side
   * migration flipped every active session to `control`, so absence reads
   * as "control" (getDeviceScope does the normalization). */
  scope?: DeviceScope;
}

function readKey(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return ""; // storage unavailable — honest "no identity"
  }
}

function writeKey(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Quota/security errors never break the pairing flow — the token stays
    // on the issued screen where the copy affordance still works.
  }
}

/** The stored device token, or "" when absent/unavailable. */
export function getDeviceToken(): string {
  return readKey(DEVICE_TOKEN_STORAGE_KEY);
}

/** True when a non-empty device token is stored. */
export function hasDeviceToken(): boolean {
  return getDeviceToken().length > 0;
}

/**
 * The stored scope, normalized. Absent (a pre-scope-v1 identity) or
 * garbage → "control": the server migrates every ACTIVE session to
 * control on boot, so the permissive reading matches the server's truth;
 * a read-scope device is always stored WITH the explicit "read".
 */
export function getDeviceScope(): DeviceScope {
  const stored = readKey(DEVICE_SCOPE_STORAGE_KEY);
  return stored === "read" ? "read" : "control";
}

/** The full stored identity, or null when no token is stored. */
export function getDeviceIdentity(): DeviceIdentity | null {
  const token = getDeviceToken();
  if (!token) return null;
  return {
    token,
    deviceId: readKey(DEVICE_ID_STORAGE_KEY),
    deviceName: readKey(DEVICE_NAME_STORAGE_KEY),
    scope: getDeviceScope(),
  };
}

/** Persist the identity (trimmed token; every field fail-soft). */
export function saveDeviceIdentity(identity: DeviceIdentity): void {
  const token = identity.token.trim();
  if (!token) return; // never persist an empty identity
  writeKey(DEVICE_TOKEN_STORAGE_KEY, token);
  writeKey(DEVICE_ID_STORAGE_KEY, identity.deviceId.trim());
  writeKey(DEVICE_NAME_STORAGE_KEY, identity.deviceName.trim());
  // scope: store only when the exchange answered it — an absent field
  // keeps the pre-scope-v1 storage shape (reads back as "control")
  writeKey(DEVICE_SCOPE_STORAGE_KEY, identity.scope === "read" ? "read" : "");
}

/** Drop the stored identity (device revoked / explicit unpair). */
export function clearDeviceIdentity(): void {
  writeKey(DEVICE_TOKEN_STORAGE_KEY, "");
  writeKey(DEVICE_ID_STORAGE_KEY, "");
  writeKey(DEVICE_NAME_STORAGE_KEY, "");
  writeKey(DEVICE_SCOPE_STORAGE_KEY, "");
}
