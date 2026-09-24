import { describe, expect, it } from "vitest";
import type { components } from "./koraContract";
import { KORA_FIXTURE_SESSIONS, KORA_FIXTURE_TRANSCRIPT } from "./koraFixtures";

/**
 * Contract-mirror gate (week 0): the mock fixtures must satisfy the
 * GENERATED contract types koraContract.d.ts (openapi-typescript over the
 * frozen artifact docs/kora/openapi.yaml — regenerate via
 * `npm run codegen:kora`). Assignability itself is enforced at TYPECHECK
 * time by the `satisfies` annotations in koraFixtures.ts; this test adds
 * the runtime half: every artifact-required field is physically present on
 * the fixture objects and the frozen enum vocabulary matches the data.
 */

type SpecSession = components["schemas"]["KoraSessionOut"];

/** The artifact's required set for KoraSessionOut (frozen; mirrors the
 * Python gate tests/test_kora_contract_spec.py — if one changes, both must). */
const SESSION_REQUIRED = [
  "id",
  "executor_id",
  "native_id",
  "harness",
  "state",
  "origin",
  "steerable",
  "age_seconds",
] as const;

describe("kora fixtures vs frozen contract (generated types)", () => {
  it("every fixture session carries the artifact-required fields", () => {
    expect(KORA_FIXTURE_SESSIONS.length).toBeGreaterThan(0);
    for (const session of KORA_FIXTURE_SESSIONS as readonly SpecSession[]) {
      for (const key of SESSION_REQUIRED) {
        expect(session, `${session.id} missing ${key}`).toHaveProperty(key);
        expect(
          (session as Record<string, unknown>)[key],
          `${session.id}.${key} must not be undefined`,
        ).not.toBeUndefined();
      }
    }
  });

  it("fixture enums sit inside the frozen vocabulary", () => {
    const HARNESS = ["zcode", "vscode", "pi"];
    const STATE = ["live", "idle", "dead"];
    const ORIGIN = ["relay", "local"];
    for (const session of KORA_FIXTURE_SESSIONS as readonly SpecSession[]) {
      expect(HARNESS).toContain(session.harness);
      expect(STATE).toContain(session.state);
      expect(ORIGIN).toContain(session.origin);
    }
  });

  it("transcript fixtures carry seq/role/content and redaction marks", () => {
    const items = Object.values(KORA_FIXTURE_TRANSCRIPT).flat();
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.seq).toBeGreaterThan(0);
      expect(["user", "assistant", "system", "tool"]).toContain(item.role);
      expect(typeof item.content).toBe("string");
      expect(typeof item.redaction_applied).toBe("boolean");
    }
    // The redaction story is visible: at least one fixture entry was masked
    // by the choke-point (the honest «маскировано» mark renders from it).
    expect(items.some((item) => item.redaction_applied)).toBe(true);
  });

  it("every transcript fixture session id exists in the session fixtures", () => {
    const ids = new Set(KORA_FIXTURE_SESSIONS.map((s) => s.id));
    for (const id of Object.keys(KORA_FIXTURE_TRANSCRIPT)) {
      expect(ids, `transcript fixture for unknown session ${id}`).toContain(id);
    }
  });
});
