/**
 * Legacy-path redirect map (ADR 0011 Ф1, QA verdict §3 "роуты не
 * переименовывать между волнами + редиректы протестированы"): every
 * pre-convergence bookmark keeps working — the L1 flat routes move into
 * their domains with a replace-redirect, never a rename. Pure data + pure
 * resolver (exhaustively testable); the component lives in routeElements.
 */
export interface LegacyRoute {
  from: string;
  to: string;
}

export const LEGACY_ROUTES: readonly LegacyRoute[] = [
  { from: "/search", to: "/memory/search" },
  { from: "/memories", to: "/memory" },
  { from: "/memories/:id", to: "/memory/:id" },
  { from: "/tags", to: "/memory/tags" },
  { from: "/status", to: "/system/status" },
  { from: "/sessions", to: "/system/sessions" },
  { from: "/sessions/:id", to: "/system/sessions/:id" },
  { from: "/traces", to: "/system/traces" },
];

/**
 * Resolve a legacy pathname onto its new home, filling `:param` segments.
 * Returns null when the pathname is not a legacy route (or a legacy route
 * whose param shape does not match, e.g. `/memories/:id/extra`).
 */
export function redirectTarget(pathname: string): string | null {
  for (const { from, to } of LEGACY_ROUTES) {
    if (!from.includes(":")) {
      if (pathname === from) return to;
      continue;
    }
    const pattern = new RegExp(`^${from.replace(/:[^/]+/g, "([^/]+)")}$`);
    const match = pattern.exec(pathname);
    if (!match) continue;
    let target = to;
    const params = from.match(/:[^/]+/g) ?? [];
    params.forEach((param, index) => {
      target = target.replace(param, decodeURIComponent(match[index + 1]));
    });
    return target;
  }
  return null;
}
