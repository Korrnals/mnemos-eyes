/**
 * The animated iris hero element (design-system.md §8.1, §8.4).
 *
 * TODO(T4): breathing `breathe` keyframes, glow shadow, pause-on-interaction,
 * reduced-motion handling. This scaffold ships the static SVG so layout has a
 * brand mark; it uses tokens only.
 */
export interface IrisLogoProps {
  /** Rendered diameter in px. */
  size?: number;
  /** Enable the breathing animation once implemented (T4). */
  breathing?: boolean;
  className?: string;
}

export function IrisLogo({ size = 32, breathing = false, className }: IrisLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="mnemos-eyes iris"
      className={[breathing ? "iris-breathing" : "", className ?? ""].join(" ")}
    >
      {/* Sclera / well ring */}
      <circle cx="32" cy="32" r="30" fill="var(--color-bg-well)" />
      <circle
        cx="32"
        cy="32"
        r="30"
        fill="none"
        stroke="var(--color-iris)"
        strokeWidth="2"
      />
      {/* Iris */}
      <circle cx="32" cy="32" r="18" fill="var(--color-iris-dim)" />
      <circle
        cx="32"
        cy="32"
        r="18"
        fill="none"
        stroke="var(--color-iris)"
        strokeWidth="2"
      />
      {/* Pupil */}
      <circle cx="32" cy="32" r="7" fill="var(--color-iris-bright)" />
    </svg>
  );
}
