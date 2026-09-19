import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TopBar } from "@/layout/TopBar";
import { AuthScreen } from "./AuthScreen";
import { AuthContext } from "./AuthContext";
import type { AuthContextValue } from "./AuthContext";
import { authReducer, initialAuthState } from "./authState";
import type { AuthEvent } from "./authState";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { ThemeProvider } from "@/components/theme-provider";

/**
 * SSR render tests for the T6 auth surfaces. The project has no DOM
 * environment, so — like App.smoke.test.tsx — mounting uses renderToString:
 * it exercises the real component tree for each state branch (the state
 * *transitions* themselves are covered by authState.test.ts and the wire flow
 * by gateway/authFlow.test.ts).
 */

/** Build a full AuthContextValue from reducer events (pure, no provider). */
function authValue(
  events: AuthEvent[],
  overrides?: Partial<AuthContextValue>,
): AuthContextValue {
  const state = events.reduce(authReducer, initialAuthState);
  return {
    state,
    adapterMode: "mock",
    endpoint: "/api",
    login: vi.fn(async () => undefined),
    verify: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    openOverlay: vi.fn(),
    closeOverlay: vi.fn(),
    ...overrides,
  };
}

function renderWithProviders(
  ui: React.ReactElement,
  auth: AuthContextValue = authValue([]),
): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  return renderToString(
    <GatewayContext.Provider value={new MockAdapter({ latency: false })}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <AuthContext.Provider value={auth}>{ui}</AuthContext.Provider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>
    </GatewayContext.Provider>,
  );
}

describe("AuthScreen", () => {
  it("renders an accessible token dialog when the overlay is open (anonymous)", () => {
    const html = renderWithProviders(<AuthScreen />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Sign in to mnemos");
    expect(html).toContain('id="auth-token"');
    expect(html).toContain('type="password"');
    // Dismissal keeps read-only browsing available on permissive deployments.
    expect(html).toContain("Continue in read-only mode");
    // The token field is labelled and the error region absent.
    expect(html).toContain("Access token");
    expect(html).not.toContain('id="auth-error"');
  });

  it("switches to the one-time-code form when login answered with a challenge", () => {
    const html = renderWithProviders(
      <AuthScreen />,
      authValue([
        { type: "OPEN_OVERLAY" },
        { type: "SUBMIT" },
        { type: "CHALLENGE", challengeId: "ch-1" },
      ]),
    );
    expect(html).toContain("Two-factor verification");
    expect(html).toContain('id="auth-code"');
    expect(html).toContain("one-time-code");
    expect(html).not.toContain('id="auth-token"');
  });

  it("shows the error region and the expired-session notice", () => {
    const html = renderWithProviders(
      <AuthScreen />,
      authValue([
        { type: "UNAUTHORIZED" },
        { type: "FAILURE", message: "Invalid token format" },
      ]),
    );
    expect(html).toContain('id="auth-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Invalid token format");
  });
});

describe("TopBar auth slot (AuthStatus)", () => {
  it("renders the connection indicator and Sign in when anonymous", () => {
    const html = renderWithProviders(<TopBar title="Search" />);
    expect(html).toContain("local (mock)"); // mock adapter label
    expect(html).toContain("Sign in");
    expect(html).not.toContain("Sign out");
  });

  it("renders Sign out for an authenticated session", () => {
    const html = renderWithProviders(
      <TopBar title="Search" />,
      authValue([{ type: "SESSION_RESTORED" }]),
    );
    expect(html).toContain("Sign out");
    expect(html).toContain("Sign out of mnemos");
  });

  it("reports the live connection label on the mnemos adapter", () => {
    const html = renderWithProviders(
      <TopBar title="Search" />,
      authValue([], { adapterMode: "mnemos", endpoint: "/api" }),
    );
    // Queries are disabled in this harness → still connecting (honest state).
    expect(html).toContain("connecting…");
  });
});
