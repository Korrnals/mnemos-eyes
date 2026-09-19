import { Suspense } from "react";
import { Navigate, useLocation, useParams } from "react-router";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/i18n";

/**
 * Small route-level components (Ф1) kept apart from the pure route table in
 * routes.tsx — this file exports ONLY components so the react-refresh lint
 * rule stays meaningful everywhere else.
 */

function RouteFallback() {
  const t = useT();
  return (
    <div
      role="status"
      aria-label={t("app.loadingView")}
      aria-busy="true"
      className="space-y-4"
    >
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

/** Suspend a lazy page with the shared route skeleton. */
export function Page({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

export function NotFound() {
  const t = useT();
  return <EmptyState variant="error" title="404" message={t("app.notFoundMessage")} />;
}

/**
 * Replace-redirect for one legacy route; mounts as its route element. Fills
 * `:id`-style segments from the matched params and re-attaches the query
 * string so `/search?q=x` lands on `/memory/search?q=x`.
 */
export function LegacyRedirect({ to }: { to: string }) {
  const location = useLocation();
  const params = useParams();
  const target = to.replace(/:([^/]+)/g, (_, name: string) => params[name] ?? "");
  return <Navigate to={`${target}${location.search}`} replace />;
}
