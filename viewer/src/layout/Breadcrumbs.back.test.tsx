// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

import { Breadcrumbs } from "./Breadcrumbs";
import { I18nProvider } from "@/i18n";

/**
 * UI-18 spec §3.2 state matrix + §3.1 trail shrink, pinned at the render
 * point (navItems.ts stays untouched — the control reads `?return=` from the
 * props Shell passes):
 *   default      — ghost link «{place}», target = validated return;
 *   invalid      — silent fallback to the domain root (no error state);
 *   direct open  — fallback target, honest route-title label;
 *   trails       — detail pages render «домен › сущность» (the lying middle
 *                  «Список»→/tasks crumb is gone), list pages unchanged.
 * A11y contract (§3.3): the accessible name carries the destination
 * («Назад: …» / «Back: …»), the visible label is the bare place name.
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(path: string, pathname: string, search: string): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider initialLang="en">
        <MemoryRouter initialEntries={[path]}>
          <Breadcrumbs pathname={pathname} search={search} />
        </MemoryRouter>
      </I18nProvider>,
    );
  });
}

function backControl(): HTMLAnchorElement | null {
  return container!.querySelector<HTMLAnchorElement>("a[aria-label^='Back:']");
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("BackControl (UI-18 §3.2 state matrix)", () => {
  it("renders on a detail page with a valid return: target = the source URL", async () => {
    await mount(
      "/tasks/TB-1?return=%2Ftasks%3Fstatus%3Dopen",
      "/tasks/TB-1",
      "?return=%2Ftasks%3Fstatus%3Dopen",
    );
    const control = backControl();
    expect(control).toBeDefined();
    expect(control!.getAttribute("href")).toBe("/tasks?status=open");
    // Label = routeTitle of the source (board root) — «Kanban», not «List».
    expect(control!.getAttribute("aria-label")).toBe("Back: Kanban");
    expect(control!.textContent).toContain("Kanban");
  });

  it("silently falls back to the domain root on an invalid return", async () => {
    await mount(
      "/tasks/TB-1?return=%2F%2Fevil.example",
      "/tasks/TB-1",
      "?return=%2F%2Fevil.example",
    );
    const control = backControl();
    expect(control!.getAttribute("href")).toBe("/tasks");
    expect(control!.getAttribute("aria-label")).toBe("Back: Kanban");
  });

  it("direct open (no return) still renders the control with the fallback", async () => {
    await mount("/memory/m-1", "/memory/m-1", "");
    const control = backControl();
    expect(control!.getAttribute("href")).toBe("/memory");
    expect(control!.getAttribute("aria-label")).toBe("Back: Records");
  });

  it("cross-domain source: the tag drill is a valid return target", async () => {
    await mount(
      "/tasks/TB-1?return=%2Fmemory%2Ftags%3Ftag%3Dproject%3Agcw",
      "/tasks/TB-1",
      "?return=%2Fmemory%2Ftags%3Ftag%3Dproject%3Agcw",
    );
    expect(backControl()!.getAttribute("href")).toBe("/memory/tags?tag=project:gcw");
    expect(backControl()!.getAttribute("aria-label")).toBe("Back: Tags");
  });

  it("session detail falls back to the sessions list (root, no wiring needed)", async () => {
    await mount("/system/sessions/s-1", "/system/sessions/s-1", "");
    expect(backControl()!.getAttribute("href")).toBe("/system/sessions");
    expect(backControl()!.getAttribute("aria-label")).toBe("Back: Sessions");
  });

  it("list pages have NO back control", async () => {
    await mount("/tasks?status=open", "/tasks", "?status=open");
    expect(backControl()).toBeNull();
  });
});

describe("detail trail shrink (UI-18 §3.1: домен › сущность)", () => {
  it("task detail trail drops the lying middle «List» crumb", async () => {
    await mount("/tasks/TB-1", "/tasks/TB-1", "");
    const links = [...container!.querySelectorAll("a")].map((a) => a.textContent);
    expect(links).toContain("Tasks");
    expect(links).not.toContain("List"); // nav.taskList → /tasks — gone
    const current = container!.querySelector("[aria-current='page']");
    expect(current?.textContent).toBe("Task");
  });

  it("memory detail trail shrinks to «Memory › Record»", async () => {
    await mount("/memory/m-1", "/memory/m-1", "");
    // Anchors: the back control («Records» — the visible fallback label,
    // href /memory) + the domain crumb; the middle «Records→/memory» trail
    // crumb is dropped.
    const links = [...container!.querySelectorAll("a")].map((a) => a.textContent);
    expect(links).toEqual(["Records", "Memory"]);
    expect(container!.querySelector("[aria-current='page']")?.textContent).toBe(
      "Record",
    );
  });

  it("list pages keep the full two-crumb trail", async () => {
    await mount("/tasks/list", "/tasks/list", "");
    const current = container!.querySelector("[aria-current='page']");
    expect(current?.textContent).toBe("List");
    expect(container!.querySelectorAll("a").length).toBe(1); // domain crumb only
  });
});
