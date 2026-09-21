import { describe, expect, it } from "vitest";
import type { ExecutorListMeta } from "@/gateway/boardTypes";
import { formatPulseAge, lastSeenAgeS, presenceFromLastSeen } from "./presence";

/**
 * Presence classification STRICTLY by the server meta TTLs (spec §2.1/§5.1):
 * boundary arithmetic against online_max_age_s / stale_max_age_s — the
 * module must never encode 120/600 itself (unknown meta → null, honest).
 */

const META: ExecutorListMeta = {
  presence: { online_max_age_s: 120, stale_max_age_s: 600 },
  sweeper_interval_s: 60,
};

const NOW = Date.parse("2026-09-19T09:00:00+00:00");

describe("presenceFromLastSeen — meta TTL boundaries", () => {
  const at = (secondsAgo: number): string =>
    new Date(NOW - secondsAgo * 1000).toISOString();

  it("online up to online_max_age_s, stale up to stale_max_age_s, offline beyond", () => {
    expect(presenceFromLastSeen(at(30), META, NOW)).toBe("online");
    expect(presenceFromLastSeen(at(120), META, NOW)).toBe("online"); // boundary inclusive
    expect(presenceFromLastSeen(at(121), META, NOW)).toBe("stale");
    expect(presenceFromLastSeen(at(600), META, NOW)).toBe("stale"); // boundary inclusive
    expect(presenceFromLastSeen(at(601), META, NOW)).toBe("offline");
    expect(presenceFromLastSeen(at(3 * 3600), META, NOW)).toBe("offline");
  });

  it("honours DIFFERENT server TTLs — never its own constants", () => {
    const custom: ExecutorListMeta = {
      presence: { online_max_age_s: 30, stale_max_age_s: 90 },
      sweeper_interval_s: 15,
    };
    expect(presenceFromLastSeen(at(31), custom, NOW)).toBe("stale");
    expect(presenceFromLastSeen(at(31), META, NOW)).toBe("online"); // same stamp, other contract
  });

  it("no meta or garbage stamp → null (unknown, not a guess)", () => {
    expect(presenceFromLastSeen(at(10), undefined, NOW)).toBeNull();
    expect(presenceFromLastSeen("garbage", META, NOW)).toBeNull();
    expect(presenceFromLastSeen("", META, NOW)).toBeNull();
  });

  it("clock-skew (stamp in the future) reads online — the honest best case", () => {
    expect(presenceFromLastSeen(new Date(NOW + 5000).toISOString(), META, NOW)).toBe("online");
  });
});

describe("pulse age helpers", () => {
  it("lastSeenAgeS: whole seconds, null on garbage/future", () => {
    expect(lastSeenAgeS(new Date(NOW - 90_000).toISOString(), NOW)).toBe(90);
    expect(lastSeenAgeS("x", NOW)).toBeNull();
  });

  it("formatPulseAge: compact mono units, whole minutes", () => {
    const unit = { minutes: "м", hours: "ч", days: "д" };
    expect(formatPulseAge(45, unit)).toBe("0м");
    expect(formatPulseAge(90, unit)).toBe("1м"); // 1.5 min floors — a glance, not a stopwatch
    expect(formatPulseAge(3600, unit)).toBe("1ч");
    expect(formatPulseAge(9000, unit)).toBe("2ч 30м");
    expect(formatPulseAge(3 * 86400, unit)).toBe("3д");
  });
});
