// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  getBoardStyle,
  setBoardStyle,
  useBoardStyle,
} from "./boardStyleStore";
import { BOARD_STYLE_STORAGE_KEY } from "@/features/tasks/tasksViewPrefs";

/**
 * UI-23 «one state, two controls» (spec §0/§4.3, acceptance §8.5): the hub
 * and the kanban's BoardStyleToggle consume `useBoardStyle()` — a write from
 * either side is instantly visible to the other, and the choice persists
 * under "vesmaro.boardStyle". Absolute initial-state reads use a fresh
 * module import (the store caches its snapshot across tests by design).
 */

function Consumer({ id }: { id: string }) {
  const [style, setStyle] = useBoardStyle();
  return (
    <button id={id} onClick={() => setStyle("classic")}>
      {style}
    </button>
  );
}

async function mountTwo(): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <>
        <Consumer id="consumer-hub" />
        <Consumer id="consumer-board" />
      </>,
    );
  });
  return { root, container };
}

beforeEach(() => {
  localStorage.clear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("boardStyleStore — one state, two controls", () => {
  it("a store write persists and reaches every consumer", async () => {
    const { root, container } = await mountTwo();
    expect(container.querySelector("#consumer-hub")!.textContent).toBe("groups");
    act(() => setBoardStyle("classic"));
    expect(localStorage.getItem(BOARD_STYLE_STORAGE_KEY)).toBe("classic");
    expect(container.querySelector("#consumer-hub")!.textContent).toBe("classic");
    expect(container.querySelector("#consumer-board")!.textContent).toBe("classic");
    root.unmount();
  });

  it("a consumer write is seen by the other consumer (hub ↔ toggle)", async () => {
    const { root, container } = await mountTwo();
    act(() => setBoardStyle("groups")); // deterministic start
    act(() => {
      container.querySelector<HTMLButtonElement>("#consumer-board")!.click();
    });
    expect(container.querySelector("#consumer-hub")!.textContent).toBe("classic");
    expect(getBoardStyle()).toBe("classic");
    root.unmount();
  });

  it("a stored choice applies on a fresh module load (F5 survival)", async () => {
    localStorage.setItem(BOARD_STYLE_STORAGE_KEY, "classic");
    vi.resetModules();
    const fresh = await import("./boardStyleStore");
    expect(fresh.getBoardStyle()).toBe("classic");
  });

  it("a corrupt stored value falls back to «groups» (honest default)", async () => {
    localStorage.setItem(BOARD_STYLE_STORAGE_KEY, "junk");
    vi.resetModules();
    const fresh = await import("./boardStyleStore");
    expect(fresh.getBoardStyle()).toBe("groups");
  });
});
