import type { ReactNode } from "react";
import { createBrowserRouter, RouterProvider } from "react-router";
import { AuthScreen } from "@/features/auth/AuthScreen";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { useAuth } from "@/features/auth/AuthContext";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { ADAPTER, adapterEndpointLabel, routerBasename } from "@/gateway/adapterConfig";
import { buildRoutes } from "@/app/routes";

/**
 * Router root (architecture.md §3, ADR 0011 Ф1). The app runs on a DATA
 * router (createBrowserRouter): `<ScrollRestoration/>` in the Shell — the
 * ARCHCOM-3-mandated scroll-restore path — only works inside one. The route
 * table itself lives in app/routes.tsx (buildRoutes) so tests mount the very
 * same tree through createMemoryRouter.
 *
 * The router mounts under the Vite base ("/app" in production, root in dev)
 * so deployed `/app` deep links resolve client-side (Ф0a history-fallback).
 *
 * T6: the whole tree sits under AuthProvider; the sign-in overlay renders on
 * top of (not instead of) the read-only pages, so a permissive loopback
 * deployment stays browsable after dismissing it.
 */
const router = createBrowserRouter(buildRoutes(), {
  basename: routerBasename(import.meta.env.BASE_URL),
});

export default function App() {
  return (
    <AuthProvider adapterMode={ADAPTER} endpoint={adapterEndpointLabel()}>
      {/* Ф3 mutation feedback: one toast region above every route. */}
      <ToastProvider>
        {/* Ф3 ui-token gate: one login window for all mutations, queued retries. */}
        <UiTokenProvider>
          <RouterBackground>
            <RouterProvider router={router} />
          </RouterBackground>
          <AuthOverlay />
        </UiTokenProvider>
      </ToastProvider>
    </AuthProvider>
  );
}

/**
 * ME-002: while the auth overlay is open, the whole app it covers (the
 * router tree, including the Shell chrome and toasts) leaves the
 * accessibility tree — `inert` blocks SR reach, focus and pointer in one
 * attribute. AuthScreen is a route-level dialog: the read-only app stays
 * MOUNTED underneath (permissive deployments let the user dismiss it), so
 * without this the covered pages remain reachable to a virtual cursor.
 *
 * `display: contents` keeps the wrapper layout-invisible (the Shell owns
 * every layout decision). Focus return stays intact: React removes the
 * `inert` attribute in the same commit that unmounts AuthScreen, and the
 * screen's cleanup focuses the invoking control only after that commit —
 * the return target is focusable again by the time it receives focus.
 */
function RouterBackground({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  return (
    <div className="contents" inert={state.overlayOpen ? "" : undefined}>
      {children}
    </div>
  );
}

/** Renders the sign-in overlay whenever the auth state machine opens it. */
function AuthOverlay() {
  const { state } = useAuth();
  if (!state.overlayOpen) return null;
  return <AuthScreen />;
}
