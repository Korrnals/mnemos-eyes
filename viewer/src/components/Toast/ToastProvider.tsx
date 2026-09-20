import { useCallback, useEffect, useRef, useState } from "react";
import { ToastContext } from "./toastContext";
import type { ToastEntry, ToastInput } from "./toastContext";

/**
 * Minimal toast layer (Ф3 mutation feedback): state + context ONLY. The
 * visible region lives in <ToastViewport/> (see ToastViewport.tsx), mounted
 * INSIDE the router by the Shell — toast cards render in-app Links, which
 * throw outside a Router context (fix/login-window: the create-success toast
 * used to render above RouterProvider and unmount the whole app). The
 * provider deliberately stays above the routes so toasts survive navigation
 * and mutations anywhere in the tree can push.
 */

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
    <ToastContext.Provider value={{ push, entries, dismiss }}>
      {children}
    </ToastContext.Provider>
  );
}
