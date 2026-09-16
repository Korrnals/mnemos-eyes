import { cn } from "@/lib/utils";
import { useReducedMotion } from "@/lib/useReducedMotion";
import "./IrisLogo.css";

export interface IrisLogoProps {
  /** Rendered diameter in px. */
  size?: number;
  /**
   * Enable the ambient "breathing iris" (design-system.md §8.4). This is the
   * page's single allowed ambient animation (§7 motion budget) — never enable
   * it on more than one instance per view. Ignored under
   * `prefers-reduced-motion: reduce`.
   */
  breathing?: boolean;
  /** Hero treatment: iris halo glow around the disc (§8.1). */
  glow?: boolean;
  /** Hide from assistive tech when a labelled sibling makes it decorative. */
  decorative?: boolean;
  className?: string;
}

/**
 * The animated iris — mnemos-eyes' hero element (design-system.md §8.1, §8.4).
 * Pure SVG + CSS animation (no rAF loops); every fill/stroke reads design
 * tokens, so the mark re-themes with `[data-theme]`.
 */
export function IrisLogo({
  size = 32,
  breathing = false,
  glow = false,
  decorative = false,
  className,
}: IrisLogoProps) {
  // The CSS media query in IrisLogo.css is the hard stop; the hook lets us
  // not mount the animation at all and is reusable for JS-driven motion.
  const reducedMotion = useReducedMotion();
  const breathe = breathing && !reducedMotion;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : "mnemos-eyes iris"}
      aria-hidden={decorative || undefined}
      className={cn(
        "iris-logo",
        glow && "iris-logo-glow",
        breathe && "iris-breathing",
        className,
      )}
    >
      {/* Well: deepest surface the gaze looks into */}
      <circle cx="32" cy="32" r="30" fill="var(--color-bg-well)" />
      <circle
        cx="32"
        cy="32"
        r="30"
        fill="none"
        stroke="var(--color-border)"
        strokeWidth="2"
      />
      {/* Iris: teal depth */}
      <circle cx="32" cy="32" r="18" fill="var(--color-iris-dim)" />
      <circle
        cx="32"
        cy="32"
        r="18"
        fill="none"
        stroke="var(--color-iris)"
        strokeWidth="2"
      />
      <circle
        cx="32"
        cy="32"
        r="13"
        fill="none"
        stroke="var(--color-iris)"
        strokeWidth="1"
        opacity="0.35"
      />
      {/* Pupil: the focal point that breathes */}
      <g className="iris-pupil">
        <circle cx="32" cy="32" r="10" fill="var(--color-iris-glow)" />
        <circle cx="32" cy="32" r="6.5" fill="var(--color-iris-bright)" />
      </g>
    </svg>
  );
}
