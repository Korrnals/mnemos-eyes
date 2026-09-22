import { describe, expect, it } from "vitest";
import type { ExecutorItem } from "@/gateway/boardTypes";
import { orderRegistry } from "./registryOrder";

/**
 * AGW-4 registry ordering (pure): the pending approval queue leads FIFO
 * (oldest registration first — the owner works the queue top-down);
 * connected rows put ENABLED ahead of disabled (the actionable ones lead)
 * and sort newest-first inside each group; revoked rows sink to the tail
 * newest-first (dead identities stay visible but never lead).
 */

const row = (overrides: Partial<ExecutorItem>): ExecutorItem => ({
  id: "exec",
  name: "x@host",
  harness: "zcode",
  host: "host",
  transport: "local-poll",
  capabilities: [],
  version: "",
  enabled: true,
  state: "approved",
  last_seen: "2026-09-19T08:00:00+00:00",
  presence: "offline",
  registered_at: "2026-09-18T00:00:00+00:00",
  updated_at: "",
  ...overrides,
});

describe("orderRegistry (AGW-4)", () => {
  it("pending rows come FIRST, oldest registration first (FIFO queue)", () => {
    const bands = orderRegistry([
      row({ id: "old-pending", state: "pending", registered_at: "2026-09-10T00:00:00+00:00" }),
      row({ id: "approved" }),
      row({ id: "new-pending", state: "pending", registered_at: "2026-09-15T00:00:00+00:00" }),
    ]);
    expect(bands.pending.map((r) => r.id)).toEqual(["old-pending", "new-pending"]);
    expect(bands.active.map((r) => r.id)).toEqual(["approved"]);
    expect(bands.revoked).toEqual([]);
  });

  it("connected rows: enabled ahead of disabled, newest first inside", () => {
    const bands = orderRegistry([
      row({ id: "disabled-old", enabled: false, registered_at: "2026-09-12T00:00:00+00:00" }),
      row({ id: "enabled-old", registered_at: "2026-09-11T00:00:00+00:00" }),
      row({ id: "enabled-newer", registered_at: "2026-09-14T00:00:00+00:00" }),
    ]);
    expect(bands.active.map((r) => r.id)).toEqual([
      "enabled-newer",
      "enabled-old",
      "disabled-old",
    ]);
  });

  it("revoked rows sink LAST, newest first; every state lands in a band", () => {
    const bands = orderRegistry([
      row({ id: "revoked-old", state: "revoked", registered_at: "2026-09-10T00:00:00+00:00" }),
      row({ id: "revoked-new", state: "revoked", registered_at: "2026-09-16T00:00:00+00:00" }),
      row({ id: "pending", state: "pending", registered_at: "2026-09-15T00:00:00+00:00" }),
      row({ id: "approved" }),
    ]);
    expect(bands.pending.map((r) => r.id)).toEqual(["pending"]);
    expect(bands.active.map((r) => r.id)).toEqual(["approved"]);
    expect(bands.revoked.map((r) => r.id)).toEqual(["revoked-new", "revoked-old"]);
  });

  it("an empty registry yields three empty bands (the page hides them)", () => {
    expect(orderRegistry([])).toEqual({ pending: [], active: [], revoked: [] });
  });
});
