import { useEffect, type RefObject } from "react";

/**
 * Focusable candidates inside a trapped container. Attribute-driven only —
 * NO layout checks (getClientRects/offsetParent): the test environments
 * (jsdom, happy-dom) have no layout engine, so a geometry-based filter
 * would silently empty the list under test and the trap would "pass" while
 * being unable to cycle. The DOM-attribute checks below cover the states
 * this app actually hides: `[hidden]` label spans (icon rail) and
 * `aria-hidden="true"` decoration.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  '[tabindex]:not([tabindex="-1"]):not([disabled])',
].join(", ");

/** A focusable element: not disabled, not inside a `[hidden]` or
 * `aria-hidden="true"]` subtree (the DOM states that remove an element from
 * the tab order / accessibility tree). */
function isTrappable(element: HTMLElement): boolean {
  return element.closest('[hidden], [aria-hidden="true"]') === null;
}

/**
 * Keyboard focus trap for hand-rolled overlays (WCAG 2.2 AA, dialogs):
 * while `active`, Tab and Shift+Tab CYCLE within the container — from the
 * last focusable to the first and back; if focus somehow lands outside the
 * container, the next Tab pulls it back inside. Nothing is trap-shaped when
 * `active` is false and no `window`/`document` access happens outside the
 * effect — SSR/node paths (renderToString harnesses) are untouched and the
 * stderr stays clean.
 *
 * Pairs with, not replaces, the open/close mechanics: the owner (e.g. the
 * Sidebar mobile overlay) moves focus in on open and back on close; this
 * hook only keeps keyboard focus from escaping while the dialog is open.
 * Radix dialogs trap on their own — do NOT attach this to them.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      // Re-read per keypress: the DOM inside an open dialog can change.
      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter(isTrappable);
      if (focusables.length === 0) {
        // Nothing focusable inside: swallow Tab so it cannot escape.
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const current = document.activeElement;
      if (current === container || !container.contains(current)) {
        // Focus sits on the container itself or leaked outside: the next
        // Tab lands on the cycle edge (first forward, last backward).
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, containerRef]);
}
