import { createContext, useContext } from "react";
import type { AuthState } from "./authState";

/**
 * DI context for the auth flow. `AuthProvider` owns the state machine and the
 * AuthClient; the overlay (AuthScreen) and the TopBar widget (AuthStatus)
 * consume it via `useAuth`.
 */
export interface AuthContextValue {
  state: AuthState;
  /** Present an `mnk_` token (wire phase 1; may answer with a TOTP challenge). */
  login: (token: string) => Promise<void>;
  /** Complete a TOTP challenge (wire phase 2). */
  verify: (code: string) => Promise<void>;
  /** Invalidate the session server-side and reset to anonymous. */
  logout: () => Promise<void>;
  openOverlay: () => void;
  closeOverlay: () => void;
  /** Which gateway is active — drives the TopBar "local (mock)" label. */
  adapterMode: "mock" | "http";
  /** Backend endpoint label for the connection indicator. */
  endpoint: string;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

/** Access the auth context. Throws when used outside the provider. */
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error(
      "useAuth: no auth context — wrap the tree in <AuthProvider> (see src/App.tsx).",
    );
  }
  return value;
}
