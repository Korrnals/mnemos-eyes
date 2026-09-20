import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { CheckCircle2, CircleAlert, X } from "lucide-react";
import { useT } from "@/i18n";
import { ToastContext } from "./toastContext";
import type { ToastInput } from "./toastContext";

/**
 * Minimal toast layer (Ф3 mutation feedback). Success toasts announce
 * politely (`role="status"`), errors assertively (`role="alert"`) — the two
 * ARIA live semantics cover screen readers without a live-region orchestra.
 * An optional action (e.g. adopt → «открыть задачу») renders as an in-app
 * Link; the toast survives the navigation (the provider sits above routes).
 *
 * Auto-dismiss: 5 s for success, 8 s for errors; every toast also carries a
 * visible dismiss button (pointer + keyboard paths, WCAG 2.1.1). No portal —
 * the fixed region renders once at the app root.
 */

interface ToastEntry extends ToastInput {
  key: number;
}

const SUCCESS_MS = 5000;
const ERROR_MS = 8000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [entries, setEntries] = useState<ToastEntry[]>([]);
  const nextKey = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((key: number) => {
    const timer = timers.current.get(key);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(key);
    }
    setEntries((current) => current.filter((entry) => entry.key !== key));
  }, []);

  const push = useCallback(
    (input: ToastInput) => {
      const key = nextKey.current++;
      setEntries((current) => [...current, { ...input, key }]);
      const ms = input.kind === "error" ? ERROR_MS : SUCCESS_MS;
      timers.current.set(
        key,
        setTimeout(() => dismiss(key), ms),
      );
    },
    [dismiss],
  );

  // Clear every pending timer on teardown (StrictMode double-mount safe).
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <ToastRegion entries={entries} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastRegion({
  entries,
  onDismiss,
}: {
  entries: readonly ToastEntry[];
  onDismiss: (key: number) => void;
}) {
  const t = useT();
  if (entries.length === 0) return null;
  return (
    <div
      aria-label={t("toasts.regionLabel")}
      className="fixed bottom-3 right-3 z-40 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2"
    >
      {entries.map((entry) => (
        <ToastCard key={entry.key} entry={entry} onDismiss={onDismiss} />
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
        <CheckCircle2
          className="mt-0.5 size-4 shrink-0 text-success"
          aria-hidden="true"
        />
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
