// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/i18n";
import { UpdateBanner } from "./UpdateBanner";

/**
 * Stale-bundle self-healing (owner feedback 2026-09-22): when the served
 * index.html carries a DIFFERENT entry chunk than the one this page booted
 * with, a banner with an explicit reload button appears. Pins the contract:
 * - same hash  → no banner;
 * - new hash   → banner (role=status) + a reload button;
 * - fetch failure / no hash → silent (never noisy, never auto-reloads).
 */

function bootScript(): void {
  const script = document.createElement("script");
  script.setAttribute("src", "/app/assets/index-bootedHash.js");
  document.body.appendChild(script);
}

function serveIndex(entry: string | null): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(
          entry
            ? `<html><script src="/app/assets/${entry}"></script></html>`
            : "<html></html>",
          { status: 200 },
        ),
      ),
    ),
  );
}

beforeEach(() => {
  bootScript();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
  container = null;
  root = null;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider initialLang="ru">
        <UpdateBanner />
      </I18nProvider>,
    );
  });
}

describe("UpdateBanner (stale-bundle self-healing)", () => {
  it("same entry hash → silent", async () => {
    serveIndex("index-bootedHash.js");
    await mount();
    expect(container!.querySelector('[role="status"]')).toBeNull();
  });

  it("new entry hash → banner with a reload button", async () => {
    serveIndex("index-freshHash.js");
    await mount();
    const banner = container!.querySelector('[role="status"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("Вышло обновление приложения");
    const reload = [...(banner!.querySelectorAll("button"))].find((button) =>
      button.textContent?.includes("Обновить"),
    );
    expect(reload).toBeDefined();
    const spy = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    await act(async () => reload!.click());
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("fetch failure → silent (never noisy)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    await mount();
    expect(container!.querySelector('[role="status"]')).toBeNull();
  });

  it("no hashed entry served → silent (dev/mock shape)", async () => {
    serveIndex(null);
    await mount();
    expect(container!.querySelector('[role="status"]')).toBeNull();
  });
});
