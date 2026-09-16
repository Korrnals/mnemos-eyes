import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router";
import { Shell } from "@/layout/Shell";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";

import { SearchPage } from "@/features/search/SearchPage"; // eager — only eagerly loaded chunk (§3)

// Route-level code splitting (architecture.md §3: lazy-loaded routes).
const MemoriesPage = lazy(() =>
  import("@/features/memories/MemoriesPage").then((m) => ({
    default: m.MemoriesPage,
  })),
);
const MemoryDetailPage = lazy(() =>
  import("@/features/memory-detail/MemoryDetailPage").then((m) => ({
    default: m.MemoryDetailPage,
  })),
);
const TagsPage = lazy(() =>
  import("@/features/tags/TagsPage").then((m) => ({ default: m.TagsPage })),
);
const StatusPage = lazy(() =>
  import("@/features/status/StatusPage").then((m) => ({ default: m.StatusPage })),
);
const SessionsPage = lazy(() =>
  import("@/features/sessions/SessionsPage").then((m) => ({
    default: m.SessionsPage,
  })),
);
const SessionDetailPage = lazy(() =>
  import("@/features/sessions/SessionDetailPage").then((m) => ({
    default: m.SessionDetailPage,
  })),
);
const TracesPage = lazy(() =>
  import("@/features/traces/TracesPage").then((m) => ({ default: m.TracesPage })),
);

function RouteFallback() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

/**
 * Router root (architecture.md §3). The `/clusters` route from the spec is
 * intentionally NOT registered: cluster graph is deferred to L2 (ADR 0003
 * D12) and its nav slot stays hidden.
 */
export default function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<SearchPage />} />
        <Route
          path="memories"
          element={
            <Suspense fallback={<RouteFallback />}>
              <MemoriesPage />
            </Suspense>
          }
        />
        <Route
          path="memories/:id"
          element={
            <Suspense fallback={<RouteFallback />}>
              <MemoryDetailPage />
            </Suspense>
          }
        />
        <Route
          path="tags"
          element={
            <Suspense fallback={<RouteFallback />}>
              <TagsPage />
            </Suspense>
          }
        />
        <Route
          path="status"
          element={
            <Suspense fallback={<RouteFallback />}>
              <StatusPage />
            </Suspense>
          }
        />
        <Route
          path="sessions"
          element={
            <Suspense fallback={<RouteFallback />}>
              <SessionsPage />
            </Suspense>
          }
        />
        <Route
          path="sessions/:id"
          element={
            <Suspense fallback={<RouteFallback />}>
              <SessionDetailPage />
            </Suspense>
          }
        />
        <Route
          path="traces"
          element={
            <Suspense fallback={<RouteFallback />}>
              <TracesPage />
            </Suspense>
          }
        />
        <Route
          path="*"
          element={
            <EmptyState
              variant="error"
              title="404"
              message="This path does not exist in the well."
            />
          }
        />
      </Route>
    </Routes>
  );
}
