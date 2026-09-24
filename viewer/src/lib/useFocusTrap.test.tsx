// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useRef } from "react";

import { useFocusTrap } from "./useFocusTrap";

/**
 * useFocusTrap contract (the shared trap behind the Sidebar mobile overlay
 * and AuthScreen): Tab/Shift+Tab cycle within the container, first↔last,
 * skipping disabled content and everything hidden from the tab order —
 * `[hidden]`, `aria-hidden="true"`, and the Tailwind `hidden` class;
 * focus that leaks outside is pulled back on the next Tab; Ctrl/Alt/Meta+Tab
 * pass through untouched (browser/OS keep them); INACTIVE the hook is a
 * no-op. The list is attribute-driven, not layout-driven — jsdom/happy-dom
 * have no layout engine, so geometry checks would silently empty it under
 * test.
 */

function TrapHarness({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, active);
  return (
    <div ref={ref} id="trap" tabIndex={-1}>
      <button type="button" id="first">
        first
      </button>
      <button type="button" id="disabled-mid" disabled>
        disabled
      </button>
      <span hidden>
        <button type="button" id="hidden-btn">
          hidden
        </button>
      </span>
      <div className="hidden">
        <button type="button" id="css-hidden-nested">
          css-hidden via ancestor
        </button>
      </div>
      <button type="button" id="css-hidden-self" className="hidden">
        css-hidden itself
      </button>
      <a href="#somewhere" id="last">
        last
      </a>
    </div>
  );
}

const mountedRoots: Root[] = [];

async function mountTrap(active: boolean) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(<TrapHarness active={active} />);
  });
  return container;
}

function pressTab(
  shift = false,
  modifiers: { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
    shiftKey: shift,
    ctrlKey: modifiers.ctrlKey ?? false,
    altKey: modifiers.altKey ?? false,
    metaKey: modifiers.metaKey ?? false,
  });
  act(() => {
    document.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
});

describe("useFocusTrap (active)", () => {
  it("cycles Tab within the container: container → first, last → first, first ⇧ → last", async () => {
    const container = await mountTrap(true);
    const trap = container.querySelector<HTMLDivElement>("#trap");
    const first = container.querySelector<HTMLButtonElement>("#first");
    const last = container.querySelector<HTMLAnchorElement>("#last");
    expect(trap && first && last).toBeTruthy();

    // Focus starts on the container (mirrors the overlay's focus-in).
    trap!.focus();
    const forward = pressTab();
    expect(document.activeElement).toBe(first);
    expect(forward.defaultPrevented).toBe(true);

    last!.focus();
    pressTab();
    expect(document.activeElement).toBe(first);

    first!.focus();
    const backward = pressTab(true);
    expect(document.activeElement).toBe(last);
    expect(backward.defaultPrevented).toBe(true);
  });

  it("skips disabled and [hidden] content (attribute-driven, no layout lies)", async () => {
    const container = await mountTrap(true);
    const trap = container.querySelector<HTMLDivElement>("#trap");
    const first = container.querySelector<HTMLButtonElement>("#first");
    const last = container.querySelector<HTMLAnchorElement>("#last");
    trap!.focus();
    pressTab();
    expect(document.activeElement).toBe(first);
    // The backward edge from #first must land on the LAST focusable —
    // #last, not the disabled button or the [hidden] one that follow it
    // in DOM order.
    pressTab(true);
    expect(document.activeElement).toBe(last);
    expect(document.activeElement!.id).not.toBe("disabled-mid");
    expect(document.activeElement!.id).not.toBe("hidden-btn");
  });

  it("skips content hidden by the Tailwind hidden class (self and ancestor)", async () => {
    const container = await mountTrap(true);
    const trap = container.querySelector<HTMLDivElement>("#trap");
    const first = container.querySelector<HTMLButtonElement>("#first");
    const last = container.querySelector<HTMLAnchorElement>("#last");
    trap!.focus();
    pressTab();
    expect(document.activeElement).toBe(first);
    // The backward edge from #first must land on #last — the `.hidden`
    // buttons sitting before it in DOM order never join the cycle.
    pressTab(true);
    expect(document.activeElement).toBe(last);
    // Forward edge from #last wraps to #first, never into a `.hidden` button.
    pressTab();
    expect(document.activeElement).toBe(first);
    expect(document.activeElement!.id).not.toBe("css-hidden-nested");
    expect(document.activeElement!.id).not.toBe("css-hidden-self");
  });

  it("passes Ctrl/Alt/Meta+Tab through: no interception, no focus moves", async () => {
    const container = await mountTrap(true);
    const trap = container.querySelector<HTMLDivElement>("#trap");
    const last = container.querySelector<HTMLAnchorElement>("#last");
    trap!.focus();
    for (const modifiers of [
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
    ]) {
      const event = pressTab(false, modifiers);
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(trap);
    }
    // Even from a cycle edge the modifier Tab is left to the browser/OS.
    last!.focus();
    const edgeEvent = pressTab(false, { ctrlKey: true });
    expect(edgeEvent.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(last);
  });

  it("pulls leaked focus back inside on the next Tab", async () => {
    const container = await mountTrap(true);
    const first = container.querySelector<HTMLButtonElement>("#first");
    const outside = document.createElement("button");
    outside.id = "outside";
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);
    pressTab();
    expect(document.activeElement).toBe(first);
    expect(document.activeElement).not.toBe(outside);
  });
});

describe("useFocusTrap (inactive / degenerate)", () => {
  it("is a no-op when inactive: Tab neither moves focus nor prevents default", async () => {
    const container = await mountTrap(false);
    const last = container.querySelector<HTMLAnchorElement>("#last");
    last!.focus();
    const event = pressTab();
    expect(document.activeElement).toBe(last);
    expect(event.defaultPrevented).toBe(false);
  });

  it("does not throw and stays inert when the container ref is empty", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    function EmptyHarness() {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref, true);
      return null;
    }
    await act(async () => {
      root.render(<EmptyHarness />);
    });
    const event = pressTab();
    expect(event.defaultPrevented).toBe(false); // no listener — a clean no-op
  });
});
