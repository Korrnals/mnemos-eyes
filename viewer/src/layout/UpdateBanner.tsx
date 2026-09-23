import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/i18n";
import { useSidebarOverlayOpen } from "@/lib/sidebarOverlayState";
import { cn } from "@/lib/utils";

/**
 * Self-healing staleness guard (owner feedback 2026-09-22: «хорошо бы,
 * чтобы таких остываний не было, либо оно чинилось само» — a long-lived
 * tab keeps the bundle it booted with; assets are immutable and no service
 * worker exists by design, so only a reload picks up a new deploy).
 *
 * Mechanism: re-fetch `/` with `cache: "no-store"` on tab focus and on a
 * slow interval, extract the hashed main-script name from the fresh HTML
 * and compare it with the one THIS page booted with. A mismatch means a
 * newer deploy shipped → show a calm banner with a one-click reload.
 * Nothing ever reloads on its own — the owner's in-flight work is never
 * interrupted, the banner just makes the stale state visible and curable
 * in one click.
 *
 * Hash-extraction note: the served HTML's first `/assets/…index-<hash>.js`
 * match is the entry chunk (vite names it index-*.js; cross-checks with
 * the live document use the same pattern, so the comparison is
 * shape-identical on both sides). No hash on either side (dev server,
 * mocks) → the banner stays silent.
 */

const BOOT_SCRIPT_RE = /assets\/index-[^"']+\.js/g;
const CHECK_INTERVAL_MS = 5 * 60_000;

/** Compare by the file NAME — the boot side carries a base prefix
 * ("/app/assets/index-x.js"), the served-HTML side matches a relative
 * pattern ("assets/index-x.js"); basename is the shape-identical form. */
function chunkName(reference: string): string | null {
  return reference.split("/").pop() ?? null;
}

function bootEntryChunk(): string | null {
  const found = [...document.scripts]
    .map((script) => script.getAttribute("src") ?? "")
    .filter((src) => /assets\/index-[^/]+\.js/.test(src));
  return found[0] ? chunkName(found[0]) : null;
}

async function servedEntryChunk(signal: AbortSignal): Promise<string | null> {
  const response = await fetch("/", { cache: "no-store", signal });
  if (!response.ok) return null;
  const html = await response.text();
  const match = html.match(BOOT_SCRIPT_RE)?.[0];
  return match ? chunkName(match) : null;
}

export function UpdateBanner() {
  const t = useT();
  const [stale, setStale] = useState(false);
  const bootedWith = useRef<string | null>(null);
  // ME-002: the banner's reload button is background chrome while the mobile
  // sidebar overlay dialog is open — go inert with the rest of the page.
  // (The auth overlay inerts the whole router tree from App; no wiring here.)
  const sidebarOverlayOpen = useSidebarOverlayOpen();

  const check = useCallback(async (signal: AbortSignal) => {
    try {
      const current = bootedWith.current ?? bootEntryChunk();
      bootedWith.current = current;
      if (!current) return; // no hashed entry (dev/mock) — nothing to compare
      const served = await servedEntryChunk(signal);
      if (served && served !== current) setStale(true);
    } catch {
      // Network hiccups / aborted checks are non-events — stay quiet.
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // Deferred a tick: check() flips state only after its fetches resolve,
    // but the effect body must not even call it synchronously
    // (react-hooks/set-state-in-effect, plugin v7).
    queueMicrotask(() => void check(controller.signal));
    const onVisible = () => {
      if (document.visibilityState === "visible") void check(controller.signal);
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(onVisible, CHECK_INTERVAL_MS);
    return () => {
      controller.abort();
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [check]);

  if (!stale) return null;
  return (
    <div
      role="status"
      inert={sidebarOverlayOpen ? "" : undefined}
      className={cn(
        "fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-md",
        "border border-border bg-well px-3 py-2 shadow-float",
      )}
    >
      <span className="text-xs text-foreground-secondary">
        {t("shell.updateAvailable")}
      </span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className={cn(
          "rounded-md border border-border-subtle px-2 py-1 text-xs font-medium",
          "text-foreground hover:bg-elevated focus-visible:outline",
          "focus-visible:outline-2 focus-visible:outline-offset-2",
          "focus-visible:outline-iris-bright",
        )}
      >
        {t("shell.updateReload")}
      </button>
    </div>
  );
}
