import { createContext, useContext } from "react";

/**
 * Toast types + context hook (split from ToastProvider.tsx so the provider
 * file stays component-only for react-refresh; the types are the toast API
 * contract shared by pages and tests).
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

export interface ToastApi {
  /** Show one toast; returns nothing (fire-and-forget feedback). */
  push(input: ToastInput): void;
}

export const ToastContext = createContext<ToastApi | null>(null);

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
