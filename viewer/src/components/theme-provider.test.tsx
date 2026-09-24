// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  LEGACY_THEME_STORAGE_KEY,
  THEME_STORAGE_KEY,
  ThemeProvider,
  useTheme,
} from "./theme-provider";
import { actUnmount } from "@/test/actTools";

/**
 * UI-23 theme contract (spec §2.1/§4.2, acceptance §8.2/8.3): three-state
 * preference (system is the DEFAULT and follows the OS live), migration
 * read `vesmaro.theme` → legacy `mnemos-eyes:theme` → system, writes go to
 * the new key only, and «Системная» removes BOTH records (otherwise the
 * legacy fallback would resurrect the pre-migration choice).
 */

type MediaListener = (event: { matches: boolean }) => void;

let lightMatches = false;
let mediaListeners: MediaListener[] = [];

function stubMatchMedia(): void {
  mediaListeners = [];
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("light") ? lightMatches : false,
      addEventListener: (_type: string, listener: MediaListener) => {
        mediaListeners.push(listener);
      },
      removeEventListener: (_type: string, listener: MediaListener) => {
        mediaListeners = mediaListeners.filter((item) => item !== listener);
      },
    })),
  );
}

function emitMediaChange(matches: boolean): void {
  lightMatches = matches;
  for (const listener of [...mediaListeners]) listener({ matches });
}

function Probe() {
  const { theme, themePreference, setTheme, toggleTheme } = useTheme();
  return (
    <div>
      <output id="probe-theme" data-theme={theme} data-preference={themePreference} />
      <button id="set-system" onClick={() => setTheme("system")}>
        system
      </button>
      <button id="set-light" onClick={() => setTheme("light")}>
        light
      </button>
      <button id="set-dark" onClick={() => setTheme("dark")}>
        dark
      </button>
      <button id="toggle" onClick={toggleTheme}>
        toggle
      </button>
    </div>
  );
}

async function mountTheme(): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
  });
  return { root, container };
}

function probe(container: HTMLElement): HTMLOutputElement {
  return container.querySelector<HTMLOutputElement>("#probe-theme")!;
}

function click(container: HTMLElement, id: string): void {
  act(() => {
    container.querySelector<HTMLButtonElement>(`#${id}`)!.click();
  });
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  lightMatches = false;
  stubMatchMedia();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("theme provider — three-state preference (UI-23)", () => {
  it("defaults to system and resolves it against the OS preference", async () => {
    const { root, container } = await mountTheme();
    expect(probe(container).dataset.preference).toBe("system");
    expect(probe(container).dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    await actUnmount(root);
  });

  it("an explicit choice writes ONLY the new registry key", async () => {
    localStorage.setItem(LEGACY_THEME_STORAGE_KEY, "light"); // pre-migration pick
    const { root, container } = await mountTheme();
    click(container, "set-dark");
    expect(probe(container).dataset.preference).toBe("dark");
    expect(probe(container).dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    // The legacy record is never written (an old-version tab keeps its pick).
    expect(localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBe("light");
    await actUnmount(root);
  });

  it("«system» removes BOTH records, then follows the OS live (§8.2)", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    localStorage.setItem(LEGACY_THEME_STORAGE_KEY, "light");
    const { root, container } = await mountTheme();
    expect(probe(container).dataset.theme).toBe("light");

    click(container, "set-system");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBeNull();
    expect(probe(container).dataset.preference).toBe("system");

    // The unit on the media event: the resolved theme flips with the OS.
    act(() => emitMediaChange(true));
    expect(probe(container).dataset.theme).toBe("light");
    act(() => emitMediaChange(false));
    expect(probe(container).dataset.theme).toBe("dark");
    await actUnmount(root);
  });

  it("the two-position toggle writes the explicit opposite of the resolved theme", async () => {
    const { root, container } = await mountTheme();
    click(container, "toggle"); // system/dark → explicit light
    expect(probe(container).dataset.preference).toBe("light");
    expect(probe(container).dataset.theme).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    click(container, "toggle"); // light → dark
    expect(probe(container).dataset.preference).toBe("dark");
    await actUnmount(root);
  });
});

describe("theme migration (spec §4.2 / acceptance §8.3)", () => {
  it("reads the legacy key when the new one is absent", async () => {
    localStorage.setItem(LEGACY_THEME_STORAGE_KEY, "light");
    const { root, container } = await mountTheme();
    expect(probe(container).dataset.preference).toBe("light");
    expect(probe(container).dataset.theme).toBe("light");
    await actUnmount(root);
  });

  it("the new key wins over the legacy one", async () => {
    localStorage.setItem(LEGACY_THEME_STORAGE_KEY, "light");
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const { root, container } = await mountTheme();
    expect(probe(container).dataset.preference).toBe("dark");
    expect(probe(container).dataset.theme).toBe("dark");
    await actUnmount(root);
  });

  it("a corrupt legacy value falls back to system (no complaints)", async () => {
    localStorage.setItem(LEGACY_THEME_STORAGE_KEY, "sepia");
    const { root, container } = await mountTheme();
    expect(probe(container).dataset.preference).toBe("system");
    await actUnmount(root);
  });
});
