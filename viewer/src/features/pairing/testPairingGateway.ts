import type { MemoryGateway } from "@/gateway/MemoryGateway";
import type { PairingGateway } from "@/gateway/capabilities";
import type {
  DeviceGrantsResult,
  DeviceRevokedResult,
  DeviceSession,
  DevicesPage,
  PairingConfirmResult,
  PairingCreatedResult,
  PairingStatus,
} from "@/gateway/boardTypes";

/**
 * Test double for the pairing/devices owner surface (the pairingWave's
 * interaction tests). Deliberately NOT a MockAdapter extension: the mock
 * dev playground has no pairing (capability guard off — the honest
 * unsupported state), while these tests need the capability ON with
 * scripted wire answers. Only the methods the pairing pages actually call
 * are implemented; the cast keeps the MemoryGateway ballast out.
 */

export const FIXTURE_DEVICE: DeviceSession = {
  id: "dev-1",
  name: "Телефон",
  scope: "read",
  grants: ["tasks", "reports", "inbox", "notifications"],
  state: "active",
  created_at: "2026-09-23T10:00:00Z",
  last_seen_at: "2026-09-23T10:05:00Z",
  last_seen: "",
  expires_at: "2026-10-23T10:00:00Z",
  hard_expires_at: "2026-12-22T10:00:00Z",
  ua: "Mozilla/5.0 (iPhone)",
  ip: "192.168.1.42",
};

export const FIXTURE_CREATED: PairingCreatedResult = {
  ok: true,
  pairing_id: "pr-1",
  code: "CODE-1234",
  verify: "3741",
  expires_at: "2026-09-23T10:03:00Z",
  state: "created",
};

export const FIXTURE_STATUS_CREATED: PairingStatus = {
  ok: true,
  pairing_id: "pr-1",
  state: "created",
  verify: "3741",
  device_name: "",
  source_ip: "",
  scope: "read",
  created_at: "2026-09-23T10:00:00Z",
  scanned_at: "",
  confirmed_at: "",
  expires_at: "2026-09-23T10:03:00Z",
};

export const FIXTURE_STATUS_SCANNED: PairingStatus = {
  ...FIXTURE_STATUS_CREATED,
  state: "scanned",
  device_name: "Планшет гостя",
  source_ip: "192.168.1.77",
  scanned_at: "2026-09-23T10:01:00Z",
};

/**
 * Live-TTL makers: the fixtures above carry a FIXED timestamp (good for
 * pure model tests), but dialog tests run under fake timers whose `now`
 * drifts from the wall clock — a created pairing must be alive RELATIVE to
 * the faked now (or already expired, for the TTL test).
 */
export function makeCreated(options?: {
  code?: string;
  ttlMs?: number;
}): PairingCreatedResult {
  return {
    ...FIXTURE_CREATED,
    ...(options?.code ? { code: options.code } : {}),
    expires_at: new Date(Date.now() + (options?.ttlMs ?? 3 * 60_000)).toISOString(),
  };
}

export function makeStatus(state: string): PairingStatus {
  return {
    ...FIXTURE_STATUS_CREATED,
    state,
    ...(state === "scanned"
      ? { device_name: "Гостевой планшет", source_ip: "192.168.1.77" }
      : {}),
  };
}

export interface PairingGatewayScript {
  created?: PairingCreatedResult | (() => PairingCreatedResult);
  status?: PairingStatus | (() => PairingStatus);
  devices?: DevicesPage;
  confirmOutcome?: string;
  createError?: Error;
  statusError?: Error;
  /** Grants: scripted answer (default echoes the sent set) or a failure. */
  grantsResult?: (deviceId: string, grants: readonly string[]) => DeviceGrantsResult;
  grantsError?: Error;
}

export function createPairingTestGateway(script: PairingGatewayScript = {}) {
  const calls = {
    createPairing: 0,
    getPairing: 0,
    confirm: [] as Array<{ id: string; allow: boolean }>,
    cancel: 0,
    revoke: [] as string[],
    listDevices: 0,
    setGrants: [] as Array<{ id: string; grants: string[] }>,
  };
  const gateway = {
    createPairing: async (): Promise<PairingCreatedResult> => {
      calls.createPairing += 1;
      if (script.createError) throw script.createError;
      return typeof script.created === "function"
        ? script.created()
        : (script.created ?? makeCreated());
    },
    getPairing: async (): Promise<PairingStatus> => {
      calls.getPairing += 1;
      if (script.statusError) throw script.statusError;
      return typeof script.status === "function"
        ? script.status()
        : (script.status ?? makeStatus("created"));
    },
    confirmPairing: async (
      id: string,
      allow: boolean,
    ): Promise<PairingConfirmResult> => {
      calls.confirm.push({ id, allow });
      return {
        ok: true,
        pairing_id: id,
        state: allow ? "confirmed" : "revoked",
        outcome: script.confirmOutcome ?? (allow ? "confirmed" : "denied"),
      };
    },
    cancelPairing: async (id: string): Promise<PairingConfirmResult> => {
      calls.cancel += 1;
      return { ok: true, pairing_id: id, state: "revoked", outcome: "revoked" };
    },
    listDevices: async (): Promise<DevicesPage> => {
      calls.listDevices += 1;
      return script.devices ?? { ok: true, count: 0, items: [] };
    },
    revokeDevice: async (deviceId: string): Promise<DeviceRevokedResult> => {
      calls.revoke.push(deviceId);
      const item =
        script.devices?.items.find((device) => device.id === deviceId) ??
        FIXTURE_DEVICE;
      return {
        ok: true,
        device: { ...item, state: "revoked" },
      };
    },
    setDeviceGrants: async (
      deviceId: string,
      grants: readonly string[],
    ): Promise<DeviceGrantsResult> => {
      calls.setGrants.push({ id: deviceId, grants: [...grants] });
      if (script.grantsError) throw script.grantsError;
      if (script.grantsResult) return script.grantsResult(deviceId, grants);
      const item =
        script.devices?.items.find((device) => device.id === deviceId) ??
        FIXTURE_DEVICE;
      return {
        ok: true,
        device: { ...item, grants: [...grants] },
      };
    },
  };
  return {
    gateway: gateway as unknown as MemoryGateway & PairingGateway,
    calls,
  };
}
