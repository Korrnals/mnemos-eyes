import { describe, expect, it } from "vitest";
import {
  EXECUTOR_CAPABILITIES_MAX,
  addCapability,
  executorPatchDiff,
  normalizeExecutorName,
} from "./executorForm";

/**
 * The settings-card PATCH diff rules (AGW-6 B), verified against the wire:
 * the route does model_dump(exclude_none=True) over {name, state,
 * capabilities, enabled} — the diff carries ONLY genuinely changed fields,
 * unchanged ones stay ABSENT, and capabilities:[] is a VALID (wipe) diff.
 * harness/transport/host/version have no diff representation at all.
 */

const LOADED = {
  name: "zcode@laptop",
  capabilities: ["researcher", "reviewer"],
};

describe("executorPatchDiff — only real changes travel", () => {
  it("no change → empty diff (the card must not send a request)", () => {
    expect(executorPatchDiff(LOADED, { name: "zcode@laptop", capabilities: ["researcher", "reviewer"] })).toEqual({});
  });

  it("a rename does NOT touch capabilities", () => {
    const diff = executorPatchDiff(LOADED, { name: "zcode@laptop-2", capabilities: LOADED.capabilities });
    expect(diff).toEqual({ name: "zcode@laptop-2" });
    expect("capabilities" in diff).toBe(false);
  });

  it("a capability edit does NOT touch the name", () => {
    const diff = executorPatchDiff(LOADED, { name: LOADED.name, capabilities: ["researcher"] });
    expect(diff).toEqual({ capabilities: ["researcher"] });
  });

  it("clearing the list is an EXPLICIT empty-array diff (the server wipe)", () => {
    expect(executorPatchDiff(LOADED, { name: LOADED.name, capabilities: [] })).toEqual({
      capabilities: [],
    });
  });

  it("name is trimmed and clamped to 120 (the server's own rules)", () => {
    const diff = executorPatchDiff(LOADED, { name: "  padded  ", capabilities: LOADED.capabilities });
    expect(diff).toEqual({ name: "padded" });
    expect(normalizeExecutorName("x".repeat(200))).toHaveLength(120);
  });

  it("a whitespace-only name NEVER travels (empty → 422 on the wire)", () => {
    expect(executorPatchDiff(LOADED, { name: "   ", capabilities: LOADED.capabilities })).toEqual({});
  });

  it("both fields changed → both travel, together", () => {
    const diff = executorPatchDiff(LOADED, { name: "renamed", capabilities: ["a"] });
    expect(diff).toEqual({ name: "renamed", capabilities: ["a"] });
  });
});

describe("capability editor rules (the store's mirror)", () => {
  it("adds trimmed values, dedups, drops empties", () => {
    expect(addCapability(["a"], "  b  ")).toEqual(["a", "b"]);
    expect(addCapability(["a"], "a")).toBeNull();
    expect(addCapability(["a"], "   ")).toBeNull();
  });

  it("caps the list at 64 — the server's hard limit", () => {
    const full = Array.from({ length: EXECUTOR_CAPABILITIES_MAX }, (_, i) => `c${i}`);
    expect(addCapability(full, "one-more")).toBeNull();
    expect(addCapability(full.slice(0, 63), "one-more")).toHaveLength(64);
  });
});
