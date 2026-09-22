import { describe, expect, it } from "vitest";
import { MockAdapter } from "@/gateway/MockAdapter";
import type { EnrollmentItem } from "@/gateway/boardTypes";

/**
 * AGW-5 phase 2 — the MockAdapter enrollment mirror + the AGW-4 review P3
 * state-machine fixes. The mock must answer EXACTLY like store.py, because
 * the tests above the gateway assert on its error TEXT (toasts carry the
 * server's message verbatim).
 *
 * P3 fixes covered here:
 * - no-op revoke: PATCH revoked→revoked is an IDEMPOTENT 200 (the server's
 *   update_executor answers 200 with no changes; the old mock 409'd) —
 *   while LEAVING revoked stays a 409;
 * - rename: a duplicate name is a 409; a valid rename applies.
 */

const NOW = Date.parse("2026-09-22T12:00:00Z");

const makeAdapter = (): MockAdapter =>
  new MockAdapter({ latency: false, now: () => NOW });

/** The runtime-minted first token (mne_ + the created row). */
async function mint(adapter: MockAdapter, label = "vps-1") {
  return adapter.createEnrollment({ label, harness_hint: "zcode" });
}

/** The mock's enrollment rows (private by design; tests peer with a cast). */
const rows = (adapter: MockAdapter): EnrollmentItem[] =>
  (adapter as unknown as { enrollments: EnrollmentItem[] }).enrollments;

describe("createEnrollment (mint mirror)", () => {
  it("returns the mne_ plaintext EXACTLY here + a 15-min TTL row", async () => {
    const a = makeAdapter();
    const created = await mint(a);
    expect(created.ok).toBe(true);
    expect(created.token.startsWith("mne_")).toBe(true);
    expect(created.token).not.toContain(" ");
    expect(created.enrollment.state).toBe("created");
    expect(created.enrollment.label).toBe("vps-1");
    expect(Date.parse(created.enrollment.expires_at) - NOW).toBe(15 * 60 * 1000);
    // The list carries the row but NEVER the token material.
    const list = await a.listEnrollments();
    expect(list.items).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(created.token);
  });

  it("422 with the authoritative allowlist text on an unknown harness_hint", async () => {
    const a = makeAdapter();
    await expect(
      a.createEnrollment({ label: "x", harness_hint: "skynet" }),
    ).rejects.toThrow("known:");
  });

  it("409 at the live-token quota of 3, with NO auto-revoke", async () => {
    const a = makeAdapter();
    await mint(a, "vps-1");
    await mint(a, "vps-2");
    await mint(a, "vps-3");
    await expect(mint(a, "vps-4")).rejects.toThrow(
      "at most 3 live tokens",
    );
    // The quota counts LIVE tokens: a revoked one frees the slot.
    await a.revokeEnrollment((await a.listEnrollments()).items[0].enrollment_id);
    const fourth = await mint(a, "vps-4");
    expect(fourth.enrollment.state).toBe("created");
  });
});

describe("revokeEnrollment (idempotency + terminal states)", () => {
  it("created → revoked; a SECOND revoke is an idempotent 200", async () => {
    const a = makeAdapter();
    const { enrollment } = await mint(a);
    const first = await a.revokeEnrollment(enrollment.enrollment_id);
    expect(first.enrollment.state).toBe("revoked");
    const second = await a.revokeEnrollment(enrollment.enrollment_id);
    expect(second.ok).toBe(true);
    expect(second.enrollment.state).toBe("revoked");
  });

  it("used → 409 (kill the EXECUTOR via the registry, never the token)", async () => {
    const a = makeAdapter();
    const { enrollment } = await mint(a);
    rows(a)[0] = { ...rows(a)[0], state: "used" };
    await expect(a.revokeEnrollment(enrollment.enrollment_id)).rejects.toThrow(
      "only a live (created) token",
    );
  });

  it("expired → 409; unknown → 404", async () => {
    const a = makeAdapter();
    const { enrollment } = await mint(a);
    rows(a)[0] = { ...rows(a)[0], state: "expired" };
    await expect(a.revokeEnrollment(enrollment.enrollment_id)).rejects.toThrow(
      "terminal",
    );
    await expect(a.revokeEnrollment("enr-ghost")).rejects.toThrow("not found");
  });
});

describe("P3 fixes: patchExecutor no-op revoke + rename duplicate", () => {
  it("revoked→revoked is an idempotent 200; leaving revoked stays 409", async () => {
    const a = makeAdapter();
    const revoked = (await a.listExecutors()).items.find(
      (row) => row.state === "revoked",
    )!;
    // No-op: 200, the row echoes unchanged (store.py:2600 mirror).
    const noop = await a.patchExecutor(revoked.id, { state: "revoked" });
    expect(noop.executor.state).toBe("revoked");
    expect(noop.executor.id).toBe(revoked.id);
    // Leaving the terminal state is still refused.
    await expect(
      a.patchExecutor(revoked.id, { state: "approved" }),
    ).rejects.toThrow("terminal state");
  });

  it("rename onto an existing name → 409; a free name applies", async () => {
    const a = makeAdapter();
    const zcode = (await a.listExecutors()).items.find(
      (row) => row.name === "zcode@laptop",
    )!;
    await expect(a.patchExecutor(zcode.id, { name: "hermes@laptop" })).rejects.toThrow(
      "duplicate executor name: hermes@laptop",
    );
    const renamed = await a.patchExecutor(zcode.id, { name: "zcode@laptop-2" });
    expect(renamed.executor.name).toBe("zcode@laptop-2");
  });
});
