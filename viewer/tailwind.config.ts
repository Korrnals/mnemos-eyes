import type { Config } from "tailwindcss";

/**
 * Tailwind maps every colour/typography/spacing/radius utility to the semantic
 * design tokens from `src/styles/tokens.css` (docs/design-system.md).
 * Components must never use literal colours — only these token-bound names.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // Theme switching is attribute-driven ([data-theme="light"]); dark tokens
  // live on :root, so Tailwind's own dark: modifier is not needed.
  darkMode: ["selector", '[data-theme="light"]'],
  theme: {
    extend: {
      colors: {
        // Surfaces
        background: "var(--color-bg-base)",
        well: "var(--color-bg-well)",
        elevated: "var(--color-bg-elevated)",
        overlay: "var(--color-bg-overlay)",
        scroll: {
          bg: "var(--color-scroll-bg)",
          border: "var(--color-scroll-border)",
        },
        // Iris accent (teal — depth)
        iris: {
          dim: "var(--color-iris-dim)",
          DEFAULT: "var(--color-iris)",
          bright: "var(--color-iris-bright)",
          glow: "var(--color-iris-glow)",
        },
        // Confidence accent (gold — value signal)
        confidence: {
          dim: "var(--color-confidence-dim)",
          DEFAULT: "var(--color-confidence)",
        },
        // Semantic status
        success: "var(--color-success)",
        warning: "var(--color-warning)",
        error: "var(--color-error)",
        info: "var(--color-info)",
        // Text
        foreground: "var(--color-text-primary)",
        "foreground-secondary": "var(--color-text-secondary)",
        "foreground-muted": "var(--color-text-muted)",
        "foreground-inverse": "var(--color-text-inverse)",
        // Borders
        border: "var(--color-border)",
        "border-subtle": "var(--color-border-subtle)",
        "border-iris": "var(--color-border-iris)",
      },
      fontFamily: {
        ui: "var(--font-ui)",
        scroll: "var(--font-scroll)",
      },
      fontSize: {
        xs: "var(--text-xs)",
        sm: "var(--text-sm)",
        base: "var(--text-base)",
        md: "var(--text-md)",
        lg: "var(--text-lg)",
        xl: "var(--text-xl)",
        "2xl": "var(--text-2xl)",
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
        full: "var(--radius-full)",
      },
      boxShadow: {
        well: "var(--shadow-well)",
        raised: "var(--shadow-raised)",
        float: "var(--shadow-float)",
        modal: "var(--shadow-modal)",
        iris: "var(--shadow-iris)",
      },
      transitionDuration: {
        instant: "var(--duration-instant)",
        fast: "var(--duration-fast)",
        normal: "var(--duration-normal)",
        slow: "var(--duration-slow)",
        iris: "var(--duration-iris)",
      },
      transitionTimingFunction: {
        "in-out": "var(--ease-in-out)",
        out: "var(--ease-out)",
        spring: "var(--ease-spring)",
        breath: "var(--ease-breath)",
      },
    },
  },
  plugins: [],
} satisfies Config;
