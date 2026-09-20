// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

import { TaskBoardCard } from "@/features/tasks/TaskBoardCard";
import { resetValidationClock } from "@/features/tasks/useValidationClock";
import { I18nProvider } from "@/i18n";
import type { BoardTask } from "@/gateway/boardTypes";

/**
 * WF-1 validation clock (CV-4 §2): the label under a validating card title
 * renders «в валидации Xч Yм» from the SHARED 1 Hz ticker — ONE interval for
 * the whole board however many validating cards are mounted, stopped when
 * the last one unmounts. Frozen system clock + fake timers keep the elapsed
 * arithmetic deterministic.
 */

const NOW = Date.parse("2026-09-19T10:00:00+00:00");

function validatingTask(validatingSince: string): BoardTask {
  return {
    id: "V-1",
    col: "validating",
    position: 0,
    title: "Валидация чего-то",
    summary: "",
    spec: "",
    agents: [],
    specialists: [],
    env: "local",
    project: "mnemos",
    memory_ids: [],
    mnemos_tags: [],
    created_at: "2026-09-19T00:00:00+00:00",
    updated_at: "2026-09-19T00:00:00+00:00",
    archived: 0,
    status: "open",
    priority: "normal",
    archived_from: "",
    validating_since: validatingSince,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mountCards(tasks: BoardTask[]): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider initialLang="ru">
        <MemoryRouter>
          {tasks.map((task) => (
            <TaskBoardCard key={task.id} task={task} canDrag={false} showMenu={false} />
          ))}
        </MemoryRouter>
      </I18nProvider>,
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  resetValidationClock();
});

describe("validation clock (shared 1 Hz ticker)", () => {
  it("renders «в валидации Xч Yм» for a stamp 6h05m in the past", () => {
    mountCards([validatingTask("2026-09-19T03:55:00+00:00")]);
    // The subscription effect runs synchronously under act; the first
    // snapshot is stamped at mount, so the label is already there.
    expect(container!.textContent).toContain("в валидации 6ч 5м");
  });

  it("ticks exactly one interval for MANY validating cards and updates them all", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    mountCards([
      validatingTask("2026-09-19T03:55:00+00:00"),
      { ...validatingTask("2026-09-18T09:30:00+00:00"), id: "V-2" },
    ]);
    const intervalsStarted = setIntervalSpy.mock.calls.length;
    // +70 minutes of wall clock: both labels advance by 1ч 10м.
    act(() => {
      vi.advanceTimersByTime(70 * 60 * 1000);
    });
    expect(container!.textContent).toContain("в валидации 7ч 15м");
    expect(container!.textContent).toContain("в валидации 25ч 40м");
    // No card added its own interval — the singleton owns the only one.
    expect(setIntervalSpy.mock.calls.length).toBe(intervalsStarted);
    setIntervalSpy.mockRestore();
  });

  it("marks a >24h stamp with the overdue styling (WF-1 window)", () => {
    mountCards([validatingTask("2026-09-18T09:30:00+00:00")]);
    const clockLine = Array.from(container!.querySelectorAll("p")).find((node) =>
      node.textContent?.includes("в валидации"),
    );
    expect(clockLine).toBeDefined();
    expect(clockLine!.className).toContain("text-error");
    expect(clockLine!.getAttribute("title")).toBe(
      "в валидации дольше 24 часов — требуется решение владельца",
    );
  });

  it("renders no clock for non-validating cards or absent stamps", () => {
    mountCards([
      { ...validatingTask(""), id: "V-3" },
      { ...validatingTask("2026-09-19T03:55:00+00:00"), id: "O-9", col: "open" },
    ]);
    expect(container!.textContent).not.toContain("в валидации");
  });
});
