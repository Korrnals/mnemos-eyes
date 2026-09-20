import { createContext, useContext } from "react";

/**
 * Toast types + context hook (split from ToastProvider.tsx so the provider
 * file stays component-only for react-refresh; the types are the toast API
 * contract shared by pages and tests).
 *
 * One hook, two consumers:
 * - `useToast` — pages/mutations: the push-only API (throws outside the
 *   provider — a pushed toast must never silently vanish).
 * - the viewport (ToastViewport, mounted INSIDE the router by the Shell)
 *   reads the context directly and renders nothing without a provider.
 *   The placement is load-bearing: toast cards render in-app `Link`s, and
 *   react-router `Link` throws outside a Router — the region must never be
 *   mounted above RouterProvider (App.tsx owns the order: ToastProvider
 *   above routes for context, ToastViewport in Shell).
 */

export type ToastKind = "ok" | "error";

export interface ToastAction {
  /** Action label (e.g. «Открыть задачу»). */
  label: string;
  /** In-app route — rendered as a Link (client-side navigation). */
  to: string;
}

export interface ToastInput {
  kind: ToastKind;
  /** One-line outcome (e.g. "TB-1: сохранено"). */
  title: string;
  /** Optional second line (e.g. "изменено принудительно (force)"). */
  detail?: string;
  /** Optional follow-up action link. */
  action?: ToastAction;
}

/** One live toast (input + the stable key the viewport dismisses by). */
export interface ToastEntry extends ToastInput {
  key: number;
}

export interface ToastApi {
  /** Show one toast; returns nothing (fire-and-forget feedback). */
  push(input: ToastInput): void;
}

/** The provider's full handle: the API plus the live list for the viewport. */
export interface ToastView extends ToastApi {
  /** Live entries, oldest first. */
  entries: readonly ToastEntry[];
  /** Dismiss one toast (close button / action click). */
  dismiss(key: number): void;
}

export const ToastContext = createContext<ToastView | null>(null);

/** Access the toast API. Throws when used outside the provider. */
export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) {
    throw new Error(
      "useToast: no toast context — wrap the tree in <ToastProvider> (see src/App.tsx).",
    );
  }
  return value;
}
