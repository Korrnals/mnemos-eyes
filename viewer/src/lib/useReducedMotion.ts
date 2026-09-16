import { useEffect, useState } from "react";

/**
 * Media query for the user's reduced-motion preference (WCAG 2.2 AA /
 * design-system.md §7). Exported so non-hook code and tests share the string.
 */
export const PREFERS_REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function readPreference(): boolean {
  if (typeof window === "undefined") return false; // SSR / node: assume full motion
  return window.matchMedia(PREFERS_REDUCED_MOTION_QUERY).matches;
}

/**
 * Reactive `prefers-reduced-motion: reduce` flag.
 *
 * Use it to skip JS-driven motion (and to avoid mounting animation classes).
 * CSS-only animations must additionally stop via the global tokens.css
 * reduced-motion overrides — this hook is the JS counterpart, not a replacement.
 */
export function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(readPreference);

  useEffect(() => {
    const media = window.matchMedia(PREFERS_REDUCED_MOTION_QUERY);
    const onChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return reducedMotion;
}
