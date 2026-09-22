/**
 * Device-class token storage (ADR 0012 §5 — the token LIVES ON THE DEVICE).
 *
 * The `/pair` exchange answers the one-shot `mnd_…` token; this module makes
 * the browser itself the token's home: localStorage (NOT sessionStorage —
 * the pairing must survive reloads and browser restarts, the owner never
 * re-pairs after closing a tab). The device identity rides every board
 * request as `Authorization: Bearer mnd_…` (see BoardAdapter
 * `identityTokenSource`) — v0 is read-only per ADR §5, so mutations answer
 * 403 and that is the honest verdict, not a bug.
 *
 * Keys mirror the board's `vesmaro.*` convention (uiToken.ts). Reads AND
 * writes are fail-soft: environments without localStorage (SSR passes,
 * hardened browsers, tests) answer "no identity" and never throw — the UI
 * degrades to the copy token affordance instead of breaking the flow.
 */

export const DEVICE_TOKEN_STORAGE_KEY = "vesmaro.deviceToken";
export const DEVICE_ID_STORAGE_KEY = "vesmaro.deviceId";
export const DEVICE_NAME_STORAGE_KEY = "vesmaro.deviceName";

/** The device identity as issued by `POST /api/pairing/exchange` (200). */
export interface DeviceIdentity {
  /** The one-shot `mnd_…` bearer token. */
  token: string;
  /** Server-assigned device row id (`dev_…`). */
  deviceId: string;
  /** The self-asserted name the device presented at exchange. */
  deviceName: string;
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

/** The full stored identity, or null when no token is stored. */
export function getDeviceIdentity(): DeviceIdentity | null {
  const token = getDeviceToken();
  if (!token) return null;
  return {
    token,
    deviceId: readKey(DEVICE_ID_STORAGE_KEY),
    deviceName: readKey(DEVICE_NAME_STORAGE_KEY),
  };
}

/** Persist the identity (trimmed token; every field fail-soft). */
export function saveDeviceIdentity(identity: DeviceIdentity): void {
  const token = identity.token.trim();
  if (!token) return; // never persist an empty identity
  writeKey(DEVICE_TOKEN_STORAGE_KEY, token);
  writeKey(DEVICE_ID_STORAGE_KEY, identity.deviceId.trim());
  writeKey(DEVICE_NAME_STORAGE_KEY, identity.deviceName.trim());
}

/** Drop the stored identity (device revoked / explicit unpair). */
export function clearDeviceIdentity(): void {
  writeKey(DEVICE_TOKEN_STORAGE_KEY, "");
  writeKey(DEVICE_ID_STORAGE_KEY, "");
  writeKey(DEVICE_NAME_STORAGE_KEY, "");
}
