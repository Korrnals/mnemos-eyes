import { describe, expect, it } from "vitest";
import { LANG_STORAGE_KEY } from "@/i18n";
import { DENSITY_STORAGE_KEY } from "@/components/density-provider";
import {
  LEGACY_THEME_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from "@/components/theme-provider";
import { MOTION_STORAGE_KEY } from "@/lib/motionStore";
import { BOARD_STYLE_STORAGE_KEY } from "@/features/tasks/tasksViewPrefs";
import { SIDEBAR_COLLAPSED_STORAGE_KEY } from "@/lib/sidebarState";
import {
  SETTINGS_REGISTRY,
  type SettingsRegistryEntry,
} from "@/lib/settingsRegistry";

/**
 * UI-23 registry contract (spec 2026-09-23 §1/§4.1): the registry is the
 * canonical description of the `vesmaro.*` preferences, while the owner
 * modules keep the storage logic. This test pins the rows to the owners'
 * exported constants so description and behaviour can never drift, and locks
 * the §4.2 theme migration shape (new key + read-only legacy fallback).
 */

/** The rows widened to the interface (the const keeps literal key types). */
const rows: readonly SettingsRegistryEntry[] = SETTINGS_REGISTRY;

function row(key: string): SettingsRegistryEntry {
  const entry = rows.find((candidate) => candidate.key === key);
  expect(entry, `registry row for ${key}`).toBeDefined();
  return entry!;
}

describe("settings registry shape (spec §4.1)", () => {
  it("keeps every active row inside the vesmaro.* namespace with a valid default", () => {
    for (const entry of rows) {
      if (entry.status === "deprecated") continue;
      expect(entry.key, entry.key).toMatch(/^vesmaro\./);
      expect(entry.default, `${entry.key} default`).toBeTruthy();
      if (entry.kind === "enum") {
        expect(
          entry.values,
          `${entry.key} must enumerate its values`,
        ).toBeDefined();
        expect(entry.values!).toContain(entry.default);
      }
      expect(["global", "domain", "component"]).toContain(entry.scope);
      expect(entry.owner).toMatch(/^src\//);
    }
  });

  it("documents the vesmaro.tasksView tombstone (route is the contract)", () => {
    const entry = row("vesmaro.tasksView");
    expect(entry.status).toBe("deprecated");
    expect(entry.note).toContain("route is the contract");
  });
});

describe("registry ↔ owner drift guards", () => {
  it("language matches src/i18n/index.ts", () => {
    expect(row("vesmaro.lang").key).toBe(LANG_STORAGE_KEY);
    expect(row("vesmaro.lang").values).toEqual(["ru", "en"]);
    expect(row("vesmaro.lang").default).toBe("ru");
  });

  it("density matches density-provider.tsx", () => {
    expect(row("vesmaro.density").key).toBe(DENSITY_STORAGE_KEY);
    expect(row("vesmaro.density").values).toEqual(["comfortable", "compact"]);
    expect(row("vesmaro.density").default).toBe("comfortable");
  });

  it("theme matches the migrated theme-provider.tsx (§4.2)", () => {
    const entry = row("vesmaro.theme");
    expect(entry.key).toBe(THEME_STORAGE_KEY);
    expect(entry.values).toEqual(["system", "light", "dark"]);
    expect(entry.default).toBe("system");
    expect(entry.note).toContain(LEGACY_THEME_STORAGE_KEY);
  });

  it("motion matches lib/motionStore.ts (NEW v2, §2.5)", () => {
    const entry = row("vesmaro.motion");
    expect(entry.key).toBe(MOTION_STORAGE_KEY);
    expect(entry.values).toEqual(["system", "reduced"]);
    expect(entry.default).toBe("system");
  });

  it("board style matches tasksViewPrefs.ts", () => {
    expect(row("vesmaro.boardStyle").key).toBe(BOARD_STYLE_STORAGE_KEY);
    expect(row("vesmaro.boardStyle").values).toEqual(["groups", "classic"]);
    expect(row("vesmaro.boardStyle").default).toBe("groups");
    expect(row("vesmaro.boardStyle").scope).toBe("domain");
  });

  it("sidebar matches lib/sidebarState.ts", () => {
    expect(row("vesmaro.sidebarCollapsed").key).toBe(SIDEBAR_COLLAPSED_STORAGE_KEY);
    expect(row("vesmaro.sidebarCollapsed").default).toBe("0");
    expect(row("vesmaro.sidebarCollapsed").scope).toBe("global");
  });

  it("pins the onboarding flag the executionPrefs module keeps private", () => {
    const entry = row("vesmaro.agents.onboardingDone");
    expect(entry.key).toBe("vesmaro.agents.onboardingDone");
    expect(entry.default).toBe("0");
    expect(entry.scope).toBe("component");
    expect(entry.note).toContain("показать подсказку снова");
  });
});
