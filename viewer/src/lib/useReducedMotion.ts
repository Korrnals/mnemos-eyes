import { useEffect, useState } from "react";
import { useMotion } from "@/lib/motionStore";

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
 * Reactive «should this UI move?» flag = OS `prefers-reduced-motion` OR the
 * explicit `vesmaro.motion="reduced"` setting (UI-23, spec §2.5). «Минимум»
 * in the settings hub forces the reduced branches for owners who never find
 * the OS switch; the default `system` keeps today's exact OS-following
 * behaviour. Use it to skip JS-driven motion (and to avoid mounting
 * animation classes); CSS-only animations stop via the tokens.css /
 * skeletons.css reduced branches plus their `[data-motion="reduced"]`
 * mirrors — this hook is the JS counterpart, not a replacement.
 */
export function useReducedMotion(): boolean {
  const motion = useMotion();
  const [osReduced, setOsReduced] = useState(readPreference);

  useEffect(() => {
    const media = window.matchMedia(PREFERS_REDUCED_MOTION_QUERY);
    const onChange = (event: MediaQueryListEvent) => setOsReduced(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return motion === "reduced" ? true : osReduced;
}
