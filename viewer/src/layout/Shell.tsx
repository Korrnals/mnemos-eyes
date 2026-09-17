import { Suspense, useCallback, useState } from "react";
import { Outlet, useLocation } from "react-router";
import { RefreshCw } from "lucide-react";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { MemoryCardSkeleton } from "@/components/skeletons/Skeletons";
import { Button } from "@/components/ui/button";
import { ErrorBoundary } from "./ErrorBoundary";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { routeTitle } from "./navItems";

/**
 * App shell (component-inventory §1): persistent sidebar + top bar + main
 * slot. Wraps the outlet in a Suspense boundary (page skeleton fallback) and
 * an ErrorBoundary (EmptyState error fallback). Collapse state lives here so
 * it survives route changes.
 */
export function Shell() {
  const [collapsed, setCollapsed] = useState(false);
  const toggle = useCallback(() => setCollapsed((value) => !value), []);
  const location = useLocation();
  const title = routeTitle(location.pathname);

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      {/* Bypass the repeated nav (WCAG 2.4.1): visible only on keyboard focus. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-well focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-float"
      >
        Skip to content
      </a>
      <Sidebar collapsed={collapsed} onToggle={toggle} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title={title} />
        <main id="main" tabIndex={-1} className="flex-1 overflow-y-auto p-6">
          <ErrorBoundary
            fallback={(error, reset) => (
              <EmptyState
                variant="error"
                title="This view fell into the well"
                message={error.message}
                action={
                  <Button variant="outline" onClick={reset}>
                    <RefreshCw className="size-4" aria-hidden="true" /> Try again
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
    </div>
  );
}
