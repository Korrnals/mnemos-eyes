import { Suspense, useCallback, useEffect, useState } from "react";
import { Outlet, ScrollRestoration, useLocation } from "react-router";
import { RefreshCw } from "lucide-react";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { MemoryCardSkeleton } from "@/components/skeletons/Skeletons";
import { ToastViewport } from "@/components/Toast/ToastViewport";
import { Button } from "@/components/ui/button";
import { ErrorBoundary } from "./ErrorBoundary";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { UpdateBanner } from "./UpdateBanner";
import { Breadcrumbs } from "./Breadcrumbs";
import { crumbsFor, routeTitle } from "./navItems";
import { useDocsManifest } from "@/features/docs/manifest";
import { useT } from "@/i18n";

/**
 * App shell (redesign concept §2.2 / ADR 0011 Ф1): sticky domain sidebar +
 * sticky top bar + document-scrolled main slot, breadcrumbs on level 2–3.
 *
 * The page itself scrolls in the WINDOW (not an inner container) on purpose:
 * react-router `<ScrollRestoration/>` restores window scroll on POP
 * navigations — the master-detail BACK-restore of the QA verdict §3 — and it
 * cannot see inner containers. `FocusMain` moves focus to <main> on route
 * change so keyboard/SR users land at the new content (WCAG 2.4.3).
 *
 * Collapse state lives here so it survives route changes, and persists under
 * "vesmaro.sidebarCollapsed" (UI-19 owner feedback: the collapsed rail must
 * survive F5; the `vesmaro.*` namespace, guarded read/write exactly like
 * executionPrefs.ts — the node test environment has no DOM).
 */

/** localStorage key for the sidebar collapsed rail (UI-19 owner feedback). */
export const SIDEBAR_COLLAPSED_STORAGE_KEY = "vesmaro.sidebarCollapsed";

/** Guarded localStorage handle — undefined outside a browser/test stub. */
function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined; // private mode / disabled storage
  }
}

/** Read the persisted collapse flag; absent/corrupt data falls back to open. */
function loadSidebarCollapsed(storage: Storage | undefined = safeStorage()): boolean {
  if (!storage) return false;
  try {
    if (storage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1") return true;
  } catch {
    // private mode — fall through to the default
  }
  return false;
}

/** Persist the collapse flag; storage failures are non-fatal. */
function saveSidebarCollapsed(
  collapsed: boolean,
  storage: Storage | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    // Swallow: the in-memory state still switches for this session.
  }
}

export function Shell() {
  const [collapsed, setCollapsed] = useState(loadSidebarCollapsed);
  const toggle = useCallback(() => setCollapsed((value) => !value), []);
  // Persist on every change (SSR-safe: effects never run on the server; the
  // initial render also re-affirms the stored value — a no-op write).
  useEffect(() => saveSidebarCollapsed(collapsed), [collapsed]);
  const location = useLocation();
  const t = useT();
  // Content-derived docs titles ride crumbs; brand is the fallback.
  const title = routeTitle(location.pathname, t) ?? "mnemos-eyes";
  // Subscribe the chrome to the lazy docs manifest ONLY inside the section:
  // mounting the subscription kicks getManifest(), which fetches EVERY md
  // chunk — an unconditional call here would download the whole corpus on
  // the first paint of any route (laziness is the budget gate, contract §7
  // «индекс строится на первом открытии /docs», §10). A deep link straight
  // into /docs/* still hydrates: enabled flips on before the trail renders.
  useDocsManifest(
    location.pathname === "/docs" || location.pathname.startsWith("/docs/"),
  );
  // The root page carries no trail — render no bar at all (anti-noise).
  const hasCrumbs = crumbsFor(location.pathname).length > 0;

  return (
    <div className="flex min-h-dvh bg-background text-foreground">
      {/* Bypass the repeated nav (WCAG 2.4.1): visible only on keyboard focus. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-well focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-float"
      >
        {t("shell.skipToContent")}
      </a>
      <Sidebar collapsed={collapsed} onToggle={toggle} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title={title} />
        {/* Breadcrumb row: sticky under the top bar so the trail stays put
         * while the document scrolls (concept §2.2). */}
        {hasCrumbs ? (
          <div className="sticky top-14 z-20 border-b border-border-subtle bg-background/95 px-3 py-2 backdrop-blur-sm sm:px-6">
            <Breadcrumbs pathname={location.pathname} search={location.search} />
          </div>
        ) : null}
        <main id="main" tabIndex={-1} className="flex-1 p-6 focus:outline-none">
          <ErrorBoundary
            fallback={(error, reset) => (
              <EmptyState
                variant="error"
                title={t("shell.viewFell")}
                message={error.message}
                action={
                  <Button variant="outline" onClick={reset}>
                    <RefreshCw className="size-4" aria-hidden="true" />{" "}
                    {t("shell.tryAgain")}
                  </Button>
                }
              />
            )}
          >
            <Suspense
              fallback={<MemoryCardSkeleton count={3} className="mx-auto max-w-3xl" />}
            >
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
      {/* Restore window scroll on BACK/FORWARD (ARCHCOM-3 verdict §2: use the
       * router's ScrollRestoration, never a hand-rolled cache). */}
      <ScrollRestoration />
      <FocusMain pathname={location.pathname} />
      {/* Toast region — mounted INSIDE the router (toast actions are in-app
       * Links; a Link outside Router context throws). Shell is the persistent
       * root layout, so toasts survive every route change. */}
      <ToastViewport />
      {/* Stale-bundle self-healing (owner feedback 2026-09-22): a calm
       * «new version» banner with a one-click reload — never auto-reloads. */}
      <UpdateBanner />
    </div>
  );
}

/**
 * Focus <main> on route change so AT users are moved to the new content
 * instead of staying on the sidebar link (WCAG 2.4.3). preventScroll keeps
 * ScrollRestoration the single owner of the scroll position.
 */
function FocusMain({ pathname }: { pathname: string }) {
  useEffect(() => {
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [pathname]);
  return null;
}
