import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/i18n";
import { GLOBAL_SEARCH_INPUT_ID, resolveHotkey } from "./hotkeyActions";

/**
 * Global hotkeys (redesign concept §2.2-6, ARCHCOM-3 verdict §2 — the proven
 * ai-brain canon with the `inInput` guard). Phase-1 layer is intentionally
 * two keys: `/` focuses the top-bar global search, `?` opens this cheatsheet
 * (Esc closes — Radix). The list below never advertises keys that do not
 * exist yet (`g`-prefix, j/k, Ctrl+K arrive with their waves). Resolution
 * rules live in hotkeyActions.ts (pure, unit-tested).
 */

interface HotkeysContextValue {
  openHelp: () => void;
}

const HotkeysContext = createContext<HotkeysContextValue | null>(null);

export function HotkeysProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [helpOpen, setHelpOpen] = useState(false);
  const openHelp = useCallback(() => setHelpOpen(true), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = resolveHotkey(event);
      if (action === null) return;
      event.preventDefault();
      if (action === "open-help") {
        setHelpOpen(true);
        return;
      }
      const input = document.getElementById(GLOBAL_SEARCH_INPUT_ID);
      if (input instanceof HTMLInputElement) input.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const value = useMemo(() => ({ openHelp }), [openHelp]);

  return (
    <HotkeysContext.Provider value={value}>
      {children}
      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("hotkeys.title")}</DialogTitle>
            <DialogDescription>{t("hotkeys.subtitle")}</DialogDescription>
          </DialogHeader>
          <ul className="space-y-2">
            <HotkeyRow keys="/" label={t("hotkeys.focusSearch")} />
            <HotkeyRow keys="?" label={t("hotkeys.cheatsheet")} />
            <HotkeyRow keys={t("hotkeys.escKey")} label={t("hotkeys.closeDialog")} />
          </ul>
        </DialogContent>
      </Dialog>
    </HotkeysContext.Provider>
  );
}

function HotkeyRow({ keys, label }: { keys: string; label: string }) {
  return (
    <li className="flex items-center justify-between gap-4 text-sm">
      <span className="text-foreground-secondary">{label}</span>
      <kbd className="rounded-md border border-border bg-elevated px-2 py-1 font-mono text-xs text-foreground">
        {keys}
      </kbd>
    </li>
  );
}

/** Access the help-dialog opener (e.g. the TopBar "?" button). */
export function useHotkeys(): HotkeysContextValue {
  const ctx = useContext(HotkeysContext);
  if (!ctx) {
    throw new Error("useHotkeys: missing <HotkeysProvider> in the component tree.");
  }
  return ctx;
}
