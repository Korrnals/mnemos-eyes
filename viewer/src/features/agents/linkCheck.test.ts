import { describe, expect, it } from "vitest";
import type { ExecutorItem, ExecutorListMeta } from "@/gateway/boardTypes";
import { linkVerdict, linkVerdictAge } from "./linkCheck";

/**
 * The link-check automaton (AGW-6 A): EVERY branch and BOTH thresholds,
 * driven by NON-default meta values (90/300 instead of the server's 120/600)
 * — proves the verdict reads the server-owned contract, never hardcodes
 * (spec §5.1). now is injected; no Date.now anywhere in the module.
 */

const NOW = Date.parse("2026-09-19T09:00:00+00:00");

/** Deliberately NOT the server defaults — threshold drift must show. */
const META: ExecutorListMeta = {
  presence: { online_max_age_s: 90, stale_max_age_s: 300 },
  sweeper_interval_s: 60,
};

const BASE: ExecutorItem = {
  id: "exec-x",
  name: "x@host",
  harness: "zcode",
  host: "host",
  transport: "local-poll",
  capabilities: [],
  version: "",
  enabled: true,
  state: "approved",
  last_seen: "",
  presence: "offline",
  registered_via: "",
  registered_at: "2026-09-19T08:00:00+00:00",
  updated_at: "2026-09-19T08:00:00+00:00",
};

const seen = (secondsAgo: number): string =>
  new Date(NOW - secondsAgo * 1000).toISOString();

describe("linkVerdict — the outbound-only automaton", () => {
  it("revoked wins FIRST: presence is gone even with a fresh last_seen", () => {
    expect(linkVerdict({ ...BASE, state: "revoked", last_seen: seen(1) }, META, NOW)).toEqual({
      kind: "revoked",
      ageS: null,
    });
  });

  it("empty last_seen → never answered a poll", () => {
    expect(linkVerdict(BASE, META, NOW)).toEqual({ kind: "never", ageS: null });
  });

  it("no meta yet → unknown (honest, not a guess)", () => {
    expect(linkVerdict({ ...BASE, last_seen: seen(5) }, undefined, NOW)).toEqual({
      kind: "unknown",
      ageS: null,
    });
  });

  it("unparsable stamp → never (no fabricated age)", () => {
    expect(linkVerdict({ ...BASE, last_seen: "not-a-stamp" }, META, NOW)).toEqual({
      kind: "never",
      ageS: null,
    });
  });

  it("clock skew (stamp in the future) is the honest best case: online, age 0", () => {
    const verdict = linkVerdict({ ...BASE, last_seen: seen(-30) }, META, NOW);
    expect(verdict).toEqual({ kind: "online", ageS: 0 });
  });

  it("the ONLINE tier and its INCLUSIVE boundary (age == online_max_age_s)", () => {
    expect(linkVerdict({ ...BASE, last_seen: seen(0) }, META, NOW)).toEqual({
      kind: "online",
      ageS: 0,
    });
    expect(linkVerdict({ ...BASE, last_seen: seen(89) }, META, NOW)?.kind).toBe("online");
    expect(linkVerdict({ ...BASE, last_seen: seen(90) }, META, NOW)?.kind).toBe("online");
  });

  it("the STALE corridor and its boundary", () => {
    expect(linkVerdict({ ...BASE, last_seen: seen(91) }, META, NOW)?.kind).toBe("stale");
    expect(linkVerdict({ ...BASE, last_seen: seen(300) }, META, NOW)?.kind).toBe("stale");
  });

  it("beyond stale_max_age_s → offline", () => {
    const verdict = linkVerdict({ ...BASE, last_seen: seen(301) }, META, NOW);
    expect(verdict).toEqual({ kind: "offline", ageS: 301 });
  });
});

describe("linkVerdictAge — verdict age units", () => {
  const units = { seconds: "с", minutes: "мин", hours: "ч", days: "д" };
  it("whole seconds while fresh, then compact min/h/d", () => {
    expect(linkVerdictAge(45, units)).toBe("45 с");
    expect(linkVerdictAge(60, units)).toBe("1 мин");
    expect(linkVerdictAge(3600, units)).toBe("1 ч");
    expect(linkVerdictAge(3661, units)).toBe("1 ч 1 мин");
    expect(linkVerdictAge(90 * 60, units)).toBe("1 ч 30 мин");
    expect(linkVerdictAge(26 * 3600, units)).toBe("1 д");
  });
});
