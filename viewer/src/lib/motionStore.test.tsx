// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  DEFAULT_MOTION,
  MOTION_STORAGE_KEY,
  getMotion,
  isMotion,
  setMotion,
  useMotion,
} from "./motionStore";
import { useReducedMotion } from "./useReducedMotion";
import { actUnmount } from "@/test/actTools";

/**
 * UI-23 motion regime (spec §2.5): `vesmaro.motion` is system | reduced,
 * default system. «reduced» FORCES the reduced-motion branches regardless of
 * the OS («Минимум» for owners who never find the OS switch); «system» keeps
 * today's exact OS-following behaviour. One external store feeds both the
 * hub control and the JS consumers (useReducedMotion) — no second source.
 */

type MediaListener = (event: { matches: boolean }) => void;

let osReduced = false;
let mediaListeners: MediaListener[] = [];

function stubMatchMedia(): void {
  mediaListeners = [];
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("reduce") ? osReduced : false,
      addEventListener: (_type: string, listener: MediaListener) => {
        mediaListeners.push(listener);
      },
      removeEventListener: (_type: string, listener: MediaListener) => {
        mediaListeners = mediaListeners.filter((item) => item !== listener);
      },
    })),
  );
}

function Probe() {
  const motion = useMotion();
  const reduced = useReducedMotion();
  return <output id="probe" data-motion={motion} data-reduced={String(reduced)} />;
}

async function mountProbe(): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Probe />);
  });
  return { root, container };
}

function probe(container: HTMLElement): HTMLOutputElement {
  return container.querySelector<HTMLOutputElement>("#probe")!;
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.motion;
  delete document.documentElement.dataset.theme;
  osReduced = false;
  stubMatchMedia();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("motionStore — guards and defaults", () => {
  it("defaults to system; only system|reduced are valid", () => {
    expect(DEFAULT_MOTION).toBe("system");
    expect(isMotion("system")).toBe(true);
    expect(isMotion("reduced")).toBe(true);
    expect(isMotion("off")).toBe(false);
    expect(getMotion()).toBe("system");
  });

  it("setMotion persists and mirrors onto <html data-motion>", () => {
    setMotion("reduced");
    expect(localStorage.getItem(MOTION_STORAGE_KEY)).toBe("reduced");
    expect(document.documentElement.dataset.motion).toBe("reduced");

    setMotion("system");
    expect(localStorage.getItem(MOTION_STORAGE_KEY)).toBe("system");
    // system = no attribute: the OS media query owns the branches again.
    expect(document.documentElement.dataset.motion).toBeUndefined();
  });

  it("a persisted «reduced» is picked up by a fresh module (F5 survival)", async () => {
    localStorage.setItem(MOTION_STORAGE_KEY, "reduced");
    vi.resetModules();
    const fresh = await import("./motionStore");
    expect(fresh.getMotion()).toBe("reduced");
    expect(document.documentElement.dataset.motion).toBe("reduced");
  });
});

describe("useReducedMotion — OS ∨ forced regime (acceptance §8.7)", () => {
  it("system: follows the OS media query exactly as before", async () => {
    const { root, container } = await mountProbe();
    expect(probe(container).dataset.reduced).toBe("false");
    act(() => {
      osReduced = true;
      for (const listener of [...mediaListeners]) listener({ matches: true });
    });
    expect(probe(container).dataset.reduced).toBe("true");
    await actUnmount(root);
  });

  it("reduced: forces the flag even when the OS prefers motion", async () => {
    const { root, container } = await mountProbe();
    act(() => setMotion("reduced"));
    expect(probe(container).dataset.reduced).toBe("true");
    // And an OS change cannot un-force it.
    act(() => {
      osReduced = false;
      for (const listener of [...mediaListeners]) listener({ matches: false });
    });
    expect(probe(container).dataset.reduced).toBe("true");
    await actUnmount(root);
  });

  it("back to system returns the OS behaviour", async () => {
    const { root, container } = await mountProbe();
    act(() => setMotion("reduced"));
    act(() => setMotion("system"));
    expect(probe(container).dataset.reduced).toBe("false");
    await actUnmount(root);
  });
});
