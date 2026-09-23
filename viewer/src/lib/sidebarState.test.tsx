// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  setSidebarCollapsed,
  toggleSidebarCollapsed,
  useSidebarCollapsed,
} from "./sidebarState";

/**
 * UI-23 «one state, two controls» (spec §2.1/§4.3, acceptance §8.6): the
 * sidebar button and the hub's «Сайдбар» control consume the same store —
 * a write from either side flips the other instantly and persists under
 * "vesmaro.sidebarCollapsed" (UI-19 semantics preserved verbatim).
 */

function Consumer({ id }: { id: string }) {
  const collapsed = useSidebarCollapsed();
  return (
    <button id={id} onClick={toggleSidebarCollapsed} aria-expanded={!collapsed}>
      {collapsed ? "collapsed" : "expanded"}
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
        <Consumer id="consumer-shell" />
        <Consumer id="consumer-hub" />
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

describe("sidebarState — one state, two controls", () => {
  it("toggle flips every consumer and persists «1»", async () => {
    const { root, container } = await mountTwo();
    // Deterministic start: explicit expand write (idempotent with UI-19).
    act(() => setSidebarCollapsed(false));
    act(() => toggleSidebarCollapsed());
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("1");
    expect(container.querySelector("#consumer-shell")!.textContent).toBe("collapsed");
    expect(container.querySelector("#consumer-hub")!.textContent).toBe("collapsed");
    root.unmount();
  });

  it("the hub's explicit set flips the shell consumer and writes «0»/«1»", async () => {
    const { root, container } = await mountTwo();
    act(() => setSidebarCollapsed(true));
    expect(container.querySelector("#consumer-shell")!.textContent).toBe("collapsed");
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("1");
    act(() => setSidebarCollapsed(false));
    expect(container.querySelector("#consumer-shell")!.textContent).toBe("expanded");
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("0");
    root.unmount();
  });

  it("the sidebar-side toggle reaches the hub consumer", async () => {
    const { root, container } = await mountTwo();
    act(() => setSidebarCollapsed(false));
    act(() => {
      container.querySelector<HTMLButtonElement>("#consumer-shell")!.click();
    });
    expect(container.querySelector("#consumer-hub")!.textContent).toBe("collapsed");
    root.unmount();
  });

  it("a stored «1» applies on a fresh module load; corrupt data opens", async () => {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "1");
    vi.resetModules();
    const fresh = await import("./sidebarState");
    expect(fresh.getSidebarCollapsed()).toBe(true);

    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "junk");
    vi.resetModules();
    const freshOpen = await import("./sidebarState");
    expect(freshOpen.getSidebarCollapsed()).toBe(false);
  });
});
