import { describe, expect, it } from "vitest";
import type { EnrollmentState } from "@/gateway/boardTypes";
import {
  buildBootstrapScript,
  buildBootstrapSteps,
  effectiveEnrollmentState,
  formatTtlCountdown,
} from "./enrollment";

/**
 * AGW-5 phase 2 view-helpers (pure): the view state never lies about a
 * passed TTL (the sweeper frame may not have arrived), the countdown never
 * reads negative, and the bootstrap commands stay a faithful projection of
 * REMOTE-EXECUTOR.md §4б/§4в — not an invented second runbook.
 */

const NOW = Date.parse("2026-09-22T12:00:00Z");
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

const row = (state: EnrollmentState, expiresAt: string) => ({
  state,
  expires_at: expiresAt,
});

describe("effectiveEnrollmentState", () => {
  it("created + future expiry → created (the wire state wins)", () => {
    expect(effectiveEnrollmentState(row("created", at(60_000)), NOW)).toBe("created");
  });

  it("created + PASSED expiry → expired BEFORE the sweeper frame arrives", () => {
    expect(effectiveEnrollmentState(row("created", at(-1_000)), NOW)).toBe("expired");
  });

  it("terminal wire states are final regardless of clocks", () => {
    expect(effectiveEnrollmentState(row("used", at(-60_000)), NOW)).toBe("used");
    expect(effectiveEnrollmentState(row("revoked", at(-60_000)), NOW)).toBe("revoked");
  });

  it("an unparsable expiry stays honest (created, not a guessed verdict)", () => {
    expect(effectiveEnrollmentState(row("created", "not-a-date"), NOW)).toBe("created");
  });
});

describe("formatTtlCountdown", () => {
  it("renders mono mm:ss; never negative", () => {
    expect(formatTtlCountdown(row("created", at(14 * 60_000 + 3_000)), NOW)).toBe("14:03");
    expect(formatTtlCountdown(row("created", at(-5_000)), NOW)).toBeNull();
    expect(formatTtlCountdown(row("created", at(500)), NOW)).toBe("00:00");
  });

  it("dead tokens have no countdown", () => {
    expect(formatTtlCountdown(row("used", at(60_000)), NOW)).toBeNull();
    expect(formatTtlCountdown(row("revoked", at(60_000)), NOW)).toBeNull();
    expect(formatTtlCountdown(row("expired", at(60_000)), NOW)).toBeNull();
  });
});

describe("buildBootstrapSteps (REMOTE-EXECUTOR.md §4б/§4в projection)", () => {
  const steps = buildBootstrapSteps({
    token: "mne_token123",
    name: "vps-1",
    harness: "zcode",
  });

  it("four steps: register → env secret → poller.yaml → dry-run/unit", () => {
    expect(steps).toHaveLength(4);
    // Step 1 — the registration curl with the ONE-TIME token in the header.
    expect(steps[0]).toContain('$BOARD_URL/api/executors');
    expect(steps[0]).toContain("Bearer mne_token123");
    expect(steps[0]).toContain('"name":"vps-1"');
    expect(steps[0]).toContain('"harness":"zcode"');
    // Step 2 — the executor_secret to a 0600 env file, never config/prompts.
    expect(steps[1]).toContain("0600");
    expect(steps[1]).toContain("VESMARO_BOARD_TOKEN=<executor_secret>");
    // Step 3 — the yaml keys; executor_id is the presence piggyback gate.
    expect(steps[2]).toContain("executor_id");
    expect(steps[2]).toContain("ca_bundle");
    // Step 4 — the dry-run before the unit.
    expect(steps[3]).toContain("--once");
  });

  it("copy-all joins the steps paste-ready", () => {
    const script = buildBootstrapScript(steps);
    expect(script).toContain(steps[0]);
    expect(script.endsWith("\n")).toBe(true);
  });
});
