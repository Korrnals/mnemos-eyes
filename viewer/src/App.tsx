import { createBrowserRouter, RouterProvider } from "react-router";
import { AuthScreen } from "@/features/auth/AuthScreen";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { useAuth } from "@/features/auth/AuthContext";
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
      <RouterProvider router={router} />
      <AuthOverlay />
    </AuthProvider>
  );
}

/** Renders the sign-in overlay whenever the auth state machine opens it. */
function AuthOverlay() {
  const { state } = useAuth();
  if (!state.overlayOpen) return null;
  return <AuthScreen />;
}
