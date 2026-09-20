// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";

import { ToastProvider } from "./ToastProvider";
import { ToastViewport } from "./ToastViewport";
import { useToast } from "./toastContext";
import { I18nProvider } from "@/i18n";

/**
 * fix/login-window regression (the «+ Задача» bug root cause): toast cards
 * render in-app `Link`s, and the region used to mount ABOVE RouterProvider
 * (ToastProvider level in App.tsx) — a Link without Router context throws,
 * the uncaught error unmounts the whole app right after the first
 * create-success toast. The region now lives inside the router (Shell);
 * this test pins that contract in a real DOM.
 */
function ToastPusher() {
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={() =>
        toast.push({
          kind: "ok",
          title: "Task TB-42 created",
          detail: "Repro",
          action: { label: "Open task", to: "/tasks/TB-42" },
        })
      }
    >
      push
    </button>
  );
}

describe("ToastViewport (inside the router)", () => {
  it("renders a toast with an in-app action link without crashing the tree", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider initialLang="en">
          <ToastProvider>
            <MemoryRouter>
              {/* Provider above the router (context) + viewport inside it —
               * the exact App.tsx / Shell arrangement. */}
              <p>app content</p>
              <ToastPusher />
              <ToastViewport />
            </MemoryRouter>
          </ToastProvider>
        </I18nProvider>,
      );
    });
    await act(async () => {
      container.querySelector("button")?.click();
    });

    // The tree is alive and the toast card rendered with its link.
    expect(container.textContent).toContain("app content");
    expect(container.textContent).toContain("Task TB-42 created");
    const link = container.querySelector('a[href="/tasks/TB-42"]');
    expect(link).toBeDefined();
    expect(link?.textContent).toContain("Open task");
  });
});
