import { Link } from "react-router";
import { CheckCircle2, CircleAlert, X } from "lucide-react";
import { useContext } from "react";
import { useT } from "@/i18n";
import { useSidebarOverlayOpen } from "@/lib/sidebarOverlayState";
import { ToastContext } from "./toastContext";
import type { ToastEntry } from "./toastContext";

/**
 * The visible toast region (Ф3 mutation feedback). Success toasts announce
 * politely (`role="status"`), errors assertively (`role="alert"`) — the two
 * ARIA live semantics cover screen readers without a live-region orchestra.
 * An optional action (e.g. create → «открыть задачу») renders as an in-app
 * Link — which is exactly why this component MUST be mounted inside the
 * router (the Shell mounts it once, so toasts survive navigation).
 *
 * Fail-soft outside a ToastProvider (SSR harnesses mount the Shell bare):
 * no provider means no toasts were pushed either — render nothing.
 *
 * Auto-dismiss timing lives in the provider; every toast also carries a
 * visible dismiss button (pointer + keyboard paths, WCAG 2.1.1).
 *
 * ME-002: while the mobile sidebar overlay dialog covers the page, the
 * region is `inert` (toast actions are background chrome of a modal state —
 * they must not stay in the a11y tree or the tab order). The auth overlay
 * needs no such wiring here: it inerts the whole router tree from App.
 */
export function ToastViewport() {
  const view = useContext(ToastContext);
  const t = useT();
  const sidebarOverlayOpen = useSidebarOverlayOpen();
  if (!view) return null;
  const { entries, dismiss } = view;
  if (entries.length === 0) return null;
  return (
    <div
      aria-label={t("toasts.regionLabel")}
      inert={sidebarOverlayOpen ? "" : undefined}
      className="fixed bottom-3 right-3 z-40 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2"
    >
      {entries.map((entry) => (
        <ToastCard key={entry.key} entry={entry} onDismiss={dismiss} />
      ))}
    </div>
  );
}

function ToastCard({
  entry,
  onDismiss,
}: {
  entry: ToastEntry;
  onDismiss: (key: number) => void;
}) {
  const t = useT();
  const isError = entry.kind === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      className={
        "flex items-start gap-2 rounded-md border px-3 py-2 text-sm shadow-modal " +
        (isError
          ? "border-error/40 bg-well text-foreground"
          : "border-border-subtle bg-well text-foreground")
      }
    >
      {isError ? (
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-error" aria-hidden="true" />
      ) : (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <p className="break-words font-medium">{entry.title}</p>
        {entry.detail ? (
          <p className="mt-0.5 break-words text-xs text-foreground-secondary">
            {entry.detail}
          </p>
        ) : null}
        {entry.action ? (
          <Link
            to={entry.action.to}
            onClick={() => onDismiss(entry.key)}
            className="mt-1 inline-block text-xs font-medium text-iris-bright underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
          >
            {entry.action.label}
          </Link>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(entry.key)}
        aria-label={t("toasts.dismissAria")}
        className="rounded-sm p-0.5 text-foreground-secondary transition-colors duration-instant hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
