import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOARD_STYLE,
  DEFAULT_TASK_VIEW,
  BOARD_STYLE_STORAGE_KEY,
  TASK_VIEW_STORAGE_KEY,
  loadBoardStyle,
  loadTaskView,
  saveBoardStyle,
  saveTaskView,
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

describe("tasksViewPrefs (CV-4 §1 — persisted «Канбан | Список» choice)", () => {
  it("defaults to the kanban (view №1) with no storage at all", () => {
    expect(loadTaskView(undefined)).toBe(DEFAULT_TASK_VIEW);
    expect(DEFAULT_TASK_VIEW).toBe("kanban");
  });

  it("round-trips the stored choice under vesmaro.tasksView", () => {
    const storage = new MemoryStorage();
    saveTaskView("list", storage);
    expect(storage.getItem(TASK_VIEW_STORAGE_KEY)).toBe("list");
    expect(loadTaskView(storage)).toBe("list");
  });

  it("falls back to kanban on corrupt values (never crashes, never 'list')", () => {
    const storage = new MemoryStorage();
    storage.setItem(TASK_VIEW_STORAGE_KEY, "table");
    expect(loadTaskView(storage)).toBe("kanban");
    storage.setItem(TASK_VIEW_STORAGE_KEY, "");
    expect(loadTaskView(storage)).toBe("kanban");
  });

  it("survives throwing storage (private mode): read → default, write → no-op", () => {
    const storage = new ThrowingStorage();
    expect(loadTaskView(storage)).toBe("kanban");
    expect(() => saveTaskView("list", storage)).not.toThrow();
  });
});

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

  it("keeps the two preference namespaces apart (tasksView ≠ boardStyle)", () => {
    const storage = new MemoryStorage();
    saveTaskView("list", storage);
    expect(loadBoardStyle(storage)).toBe("groups");
    saveBoardStyle("classic", storage);
    expect(loadTaskView(storage)).toBe("list");
  });
});
