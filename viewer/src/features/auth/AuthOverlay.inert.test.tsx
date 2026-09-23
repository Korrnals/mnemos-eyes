// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import App from "@/App";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { ThemeProvider } from "@/components/theme-provider";
import { DensityProvider } from "@/components/density-provider";
import { HotkeysProvider } from "@/layout/Hotkeys";
import { I18nProvider } from "@/i18n";

/**
 * ME-002 (background inert) for the AUTH overlay: the sign-in dialog is a
 * route-level overlay — the read-only app stays MOUNTED underneath (T6), so
 * without treatment the covered pages remain reachable to screen readers and
 * the virtual cursor. The fix inerts the whole router tree from App while
 * `overlayOpen`; this file exercises the production-shaped tree (the real
 * App: its own data router, AuthProvider, RouterBackground wrapper) through
 * the real user path — TopBar «Sign in» → dialog → «Continue in read-only» —
 * and asserts the a11y tree contraction plus the focus return across the
 * formerly-inert subtree (the core regression: programmatic focus must land
 * back on the invoking control once the inert is lifted).
 */

const mountedRoots: Root[] = [];

async function mountApp() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      <GatewayContext.Provider value={new MockAdapter({ latency: false })}>
        <QueryClientProvider
          client={
            new QueryClient({
              defaultOptions: { queries: { enabled: false, retry: false } },
            })
          }
        >
          <ThemeProvider>
            {/* English copy — the selectors below pin it. */}
            <I18nProvider initialLang="en">
              <DensityProvider initialDensity="comfortable">
                <HotkeysProvider>
                  <App />
                </HotkeysProvider>
              </DensityProvider>
            </I18nProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
  return { container };
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).find((el) => el.textContent?.trim() === text);
  if (!button) throw new Error(`button "${text}" not found`);
  return button;
}

function click(element: HTMLElement) {
  act(() => {
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
}

beforeEach(() => {
  localStorage.clear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
});

describe("auth overlay inerts the app behind it (ME-002)", () => {
  it("while open the covered app is inert; on dismiss it is restored and focus returns to the invoker", async () => {
    const { container } = await mountApp();
    await act(async () => {});
    const main = container.querySelector("main");
    expect(main).not.toBeNull();
    expect(main!.closest("[inert]")).toBeNull();

    const signIn = buttonByText(container, "Sign in");
    signIn.focus(); // the keyboard user was on the invoker when they opened it
    click(signIn);

    const dialog = container.querySelector("[role='dialog']");
    expect(dialog).not.toBeNull();
    // The covered app (router tree incl. chrome) leaves the a11y tree…
    expect(main!.closest("[inert]")).not.toBeNull();
    expect(
      container.querySelector("a[href='#main']")?.closest("[inert]"),
    ).not.toBeNull();
    // …while the dialog surface stays live.
    expect(dialog!.closest("[inert]")).toBeNull();
    // Focus moved into the dialog (the autofocus token field).
    expect(dialog!.contains(document.activeElement)).toBe(true);

    click(buttonByText(container, "Continue in read-only mode"));
    expect(container.querySelector("[role='dialog']")).toBeNull();
    // The background returns to the tree…
    expect(main!.closest("[inert]")).toBeNull();
    expect(container.querySelector("a[href='#main']")?.closest("[inert]")).toBe(
      null,
    );
    // …and focus is back on the invoking control — the formerly-inert
    // subtree accepts programmatic focus again.
    expect(document.activeElement).toBe(signIn);
  });
});
