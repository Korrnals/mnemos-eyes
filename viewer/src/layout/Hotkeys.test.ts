import { describe, expect, it } from "vitest";
import { isEditableTarget, resolveHotkey } from "./hotkeyActions";

/**
 * Ф1 hotkey layer (ARCHCOM-3 verdict §2): the ai-brain canon — `/` focuses
 * search, `?` opens the cheatsheet, and BOTH stay quiet inside editable
 * surfaces (the `inInput` guard) and under modifier combos.
 */
function target(tag: string, editable = false): HTMLElement {
  return { tagName: tag, isContentEditable: editable } as unknown as HTMLElement;
}

describe("resolveHotkey", () => {
  it("maps / to focus-search and ? to open-help", () => {
    expect(resolveHotkey({ key: "/" })).toBe("focus-search");
    expect(resolveHotkey({ key: "?" })).toBe("open-help");
  });

  it("ignores every other bare key", () => {
    expect(resolveHotkey({ key: "a" })).toBeNull();
    expect(resolveHotkey({ key: "Escape" })).toBeNull();
    expect(resolveHotkey({ key: "k" })).toBeNull(); // Ctrl+K is a future wave
    expect(resolveHotkey({ key: "g" })).toBeNull(); // g-prefix likewise
  });

  it("ignores modifier combos (browser/OS owns those)", () => {
    expect(resolveHotkey({ key: "/", metaKey: true })).toBeNull();
    expect(resolveHotkey({ key: "/", ctrlKey: true })).toBeNull();
    expect(resolveHotkey({ key: "?", altKey: true })).toBeNull();
  });

  it("applies the inInput guard: quiet inside form fields", () => {
    for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(resolveHotkey({ key: "/", target: target(tag) })).toBeNull();
      expect(resolveHotkey({ key: "?", target: target(tag) })).toBeNull();
    }
    expect(resolveHotkey({ key: "/", target: target("DIV") })).toBe("focus-search");
  });

  it("applies the inInput guard to contentEditable surfaces", () => {
    expect(isEditableTarget(target("DIV", true))).toBe(true);
    expect(resolveHotkey({ key: "?", target: target("DIV", true) })).toBeNull();
  });

  it("tolerates non-element targets (window itself)", () => {
    expect(resolveHotkey({ key: "/", target: null })).toBe("focus-search");
    expect(isEditableTarget(null)).toBe(false);
  });
});
