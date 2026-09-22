import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOARD_STYLE,
  BOARD_STYLE_STORAGE_KEY,
  loadBoardStyle,
  saveBoardStyle,
} from "./tasksViewPrefs";

/** In-memory Storage double (the node test env has none). */
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

/** A storage whose accessors throw — private mode / disabled storage. */
class ThrowingStorage implements Storage {
  readonly length = 0;
  clear(): void {
    throw new Error("blocked");
  }
  key(): string | null {
    throw new Error("blocked");
  }
  getItem(): string | null {
    throw new Error("blocked");
  }
  setItem(): void {
    throw new Error("blocked");
  }
  removeItem(): void {
    throw new Error("blocked");
  }
}

describe("tasksViewPrefs (CV-5 — persisted «Группы | Классика» board style)", () => {
  it("defaults to the grouped board (Ф3) with no storage at all", () => {
    expect(loadBoardStyle(undefined)).toBe(DEFAULT_BOARD_STYLE);
    expect(DEFAULT_BOARD_STYLE).toBe("groups");
  });

  it("round-trips the stored choice under vesmaro.boardStyle", () => {
    const storage = new MemoryStorage();
    saveBoardStyle("classic", storage);
    expect(storage.getItem(BOARD_STYLE_STORAGE_KEY)).toBe("classic");
    expect(loadBoardStyle(storage)).toBe("classic");
  });

  it("falls back to groups on corrupt values (never crashes, never 'classic')", () => {
    const storage = new MemoryStorage();
    storage.setItem(BOARD_STYLE_STORAGE_KEY, "flat");
    expect(loadBoardStyle(storage)).toBe("groups");
    storage.setItem(BOARD_STYLE_STORAGE_KEY, "");
    expect(loadBoardStyle(storage)).toBe("groups");
  });

  it("survives throwing storage (private mode): read → default, write → no-op", () => {
    const storage = new ThrowingStorage();
    expect(loadBoardStyle(storage)).toBe("groups");
    expect(() => saveBoardStyle("classic", storage)).not.toThrow();
  });

  it("the task-VIEW key stays a tombstone (route is the contract, 2026-09-22)", () => {
    // vesmaro.tasksView is no longer read or written anywhere; boardStyle
    // keeps its own namespace. Older browsers may carry the stale key.
    const storage = new MemoryStorage();
    storage.setItem("vesmaro.tasksView", "list");
    expect(loadBoardStyle(storage)).toBe("groups");
    saveBoardStyle("classic", storage);
    expect(storage.getItem("vesmaro.tasksView")).toBe("list");
    expect(storage.getItem(BOARD_STYLE_STORAGE_KEY)).toBe("classic");
  });
});
