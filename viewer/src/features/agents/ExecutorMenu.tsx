import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  Check,
  Copy,
  Link2,
  MoreHorizontal,
  Power,
  Settings,
  ShieldOff,
  Trash2,
} from "lucide-react";
import type { ExecutorItem } from "@/gateway/boardTypes";
import { useT } from "@/i18n";
import { useExecutorMutations } from "./useExecutorMutations";
import type { ExecutorMutations } from "./useExecutorMutations";
import { ExecutorLinkCheck } from "./ExecutorLinkCheck";
import { ExecutorSheet } from "./ExecutorSheet";

/**
 * Executor action menu (AGW-5 phase 2; the TaskRowMenu posture — #30): one
 * menu everywhere, two mounting modes —
 * - CONTROLLED: the owner (strip chip / registry row) holds `open` +
 *   `position` and feeds `onOpenAtPoint` from its `onContextMenu`; the
 *   popup becomes a viewport-clamped fixed popup at the pointer;
 * - the ⋯ trigger works in BOTH modes (the tab-reachable keyboard path —
 *   the contextmenu entry is a pointer-only convenience, WCAG 2.1.1).
 *
 * Actions come from the SAME useExecutorMutations gate as the registry
 * buttons (ui-token gate, server-text toasts, confirms for revoke/delete):
 * approve (pending only), enable/disable, revoke (TERMINAL — hidden on
 * revoked rows, where only Delete remains), delete, copy id, open registry
 * (strip only — the row already lives there). State-appropriate items are
 * rendered state-appropriately; there is no dead menu.
 *
 * A11y: labelled ⋯ trigger (`aria-haspopup="menu"`, `aria-expanded`), the
 * popup is a `role="menu"` of real buttons — Tab out and Esc close, focus
 * returns to the trigger, ArrowUp/Down rove (WCAG 2.1.1/2.1.2/2.4.3).
 */

const MENU_WIDTH_PX = 200;
// Generous estimate: with the link-check verdict open the popup grows
// past a bare items list (the clamp only positions, never scrolls).
const MENU_HEIGHT_PX = 360;
const VIEWPORT_MARGIN_PX = 8;

export function ExecutorMenu({
  executor,
  open: openProp,
  onOpenChange,
  position = null,
  revealOnParentHover = false,
  showOpenRegistry = false,
}: {
  executor: ExecutorItem;
  /** Controlled open (strip chip / row); omit for uncontrolled list use. */
  open?: boolean;
  /** Close/open reports the anchor reset (null = anchored to the trigger).
   * Right-click entry: the OWNER's contextmenu handler sets open+position
   * directly — the menu renders the popup wherever it is pointed. */
  onOpenChange?: (open: boolean, position: { x: number; y: number } | null) => void;
  /** Viewport coords for the contextmenu path; null anchors to the trigger. */
  position?: { x: number; y: number } | null;
  /** Strip affordance: ⋯ hidden until the parent `group/chip` hover/focus. */
  revealOnParentHover?: boolean;
  /** «Открыть реестр» — only from the strip (the row IS the registry). */
  showOpenRegistry?: boolean;
}) {
  const t = useT();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [uncontrolledPosition, setUncontrolledPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  // AGW-6 B: the settings card lives at THIS level (items unmount with the
  // popup — the drawer must survive the menu closing).
  const [cardOpen, setCardOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const menuPosition = (openProp === undefined ? uncontrolledPosition : position) ?? null;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const setOpen = useCallback(
    (next: boolean, nextPosition: { x: number; y: number } | null = null) => {
      setUncontrolledOpen(next);
      setUncontrolledPosition(nextPosition);
      onOpenChange?.(next, nextPosition);
    },
    [onOpenChange],
  );

  // Outside press dismisses; Esc is handled on the menu itself.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, setOpen]);

  // Focus the first item when the menu opens.
  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )
      ?.focus();
  }, [open]);

  const close = (refocus = true): void => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ];
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = items[(current + delta + items.length) % items.length];
    next.focus();
  };

  const copyId = (): void => {
    try {
      void navigator.clipboard?.writeText(executor.id);
    } catch {
      // Clipboard may be absent (tests/embedded) — the menu closes anyway.
    }
    close();
  };

  // Cursor placement: fixed coords clamped into the viewport; the anchored
  // mode keeps the list-proven absolute position under the trigger.
  const popupStyle: React.CSSProperties = menuPosition
    ? {
        left: Math.max(
          VIEWPORT_MARGIN_PX,
          Math.min(menuPosition.x, window.innerWidth - MENU_WIDTH_PX),
        ),
        top: Math.max(
          VIEWPORT_MARGIN_PX,
          Math.min(menuPosition.y, window.innerHeight - MENU_HEIGHT_PX),
        ),
      }
    : {};
  const popupPlacement = menuPosition
    ? "fixed z-30 "
    : "absolute right-0 top-full z-30 mt-1 ";

  return (
    <div
      ref={wrapperRef}
      className="relative"
      onBlur={(event) => {
        // Tab out dismisses (WCAG 2.1.2 — no orphan popup); focusout bubbles.
        const next = event.relatedTarget;
        if (!next || !wrapperRef.current?.contains(next as Node)) {
          setOpen(false);
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("agents.menu.triggerAria", { name: executor.name })}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open, null);
        }}
        className={
          "inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-foreground-secondary transition-colors duration-instant hover:bg-elevated hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright " +
          (revealOnParentHover
            ? "opacity-0 group-hover/chip:opacity-100 group-focus-within/chip:opacity-100 aria-expanded:opacity-100 "
            : "")
        }
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </button>

      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t("agents.menu.label", { name: executor.name })}
          style={popupStyle}
          onKeyDown={onKeyDown}
          className={
            popupPlacement +
            "min-w-44 rounded-md border border-border-subtle bg-well p-1 shadow-modal"
          }
        >
          {/* Mounted ONLY while open: the items pull the gated mutations
           * hook — closed chips/rows never touch contexts they do not use
           * (the strip renders in provider-less test harnesses too). */}
          <ExecutorMenuItems
            executor={executor}
            showOpenRegistry={showOpenRegistry}
            close={close}
            copyId={copyId}
            onOpenCard={() => {
              // The drawer takes focus (Radix); no refocus to the trigger.
              close(false);
              setCardOpen(true);
            }}
          />
        </div>
      ) : null}

      {/* AGW-6 B: the settings card, mounted on demand (any state —
       * revoked renders it read-only except Delete). */}
      {cardOpen ? (
        <ExecutorSheet executorId={executor.id} open onOpenChange={setCardOpen} />
      ) : null}
    </div>
  );
}


/**
 * The menu ITEMS — the only part that needs the gated write path, so they
 * mount lazily (open only). Approve (pending only) / enable | disable /
 * revoke (approved only — terminal honesty: revoked rows offer nothing
 * state-changing but Delete) / copy id / open registry / delete.
 */
function ExecutorMenuItems({
  executor,
  showOpenRegistry,
  close,
  copyId,
  onOpenCard,
}: {
  executor: ExecutorItem;
  showOpenRegistry: boolean;
  close: () => void;
  copyId: () => void;
  onOpenCard: () => void;
}) {
  const t = useT();
  const mutations: ExecutorMutations = useExecutorMutations();
  return (
    <>
      {/* AGW-6 A: «Проверить связь» — every state EXCEPT revoked (a
       * revoked token cannot answer anything; the verdict component
       * renders the honest goned-presence line in the card instead). The
       * trigger stays OPEN inside the popup — the verdict appears below
       * it; the cache invalidation is the check, never a fake ping. */}
      {executor.state !== "revoked" ? (
        <ExecutorLinkCheck executor={executor} variant="menu-item" />
      ) : null}
      {/* AGW-6 B: the settings card — ALL states (revoked opens it too:
       * read-only tombstone + Delete). */}
      <MenuButton
        icon={<Settings className="size-3.5" aria-hidden="true" />}
        onClick={onOpenCard}
      >
        {t("agents.card.menuOpen")}
      </MenuButton>
      {executor.state === "pending" ? (
        <MenuButton
          icon={<Check className="size-3.5" aria-hidden="true" />}
          onClick={() => {
            close();
            mutations.approveExecutor(executor);
          }}
        >
          {t("agents.registry.approve")}
        </MenuButton>
      ) : null}
      {executor.state === "approved" ? (
        <MenuButton
          icon={<Power className="size-3.5" aria-hidden="true" />}
          onClick={() => {
            close();
            mutations.setExecutorEnabled(executor, !executor.enabled);
          }}
        >
          {executor.enabled ? t("agents.registry.disable") : t("agents.registry.enable")}
        </MenuButton>
      ) : null}
      {executor.state === "approved" ? (
        <MenuButton
          icon={<ShieldOff className="size-3.5" aria-hidden="true" />}
          destructive
          onClick={() => {
            close();
            mutations.revokeExecutor(executor);
          }}
        >
          {t("agents.registry.revoke")}
        </MenuButton>
      ) : null}
      <MenuButton icon={<Copy className="size-3.5" aria-hidden="true" />} onClick={copyId}>
        {t("agents.menu.copyId", { id: executor.id })}
      </MenuButton>
      {showOpenRegistry ? (
        <MenuButton
          icon={<Link2 className="size-3.5" aria-hidden="true" />}
          href="/agents/harnesses"
          onClick={() => close()}
        >
          {t("agents.menu.openRegistry")}
        </MenuButton>
      ) : null}
      <MenuButton
        icon={<Trash2 className="size-3.5" aria-hidden="true" />}
        destructive={executor.state !== "revoked"}
        onClick={() => {
          close();
          mutations.removeExecutor(executor);
        }}
      >
        {t("agents.registry.remove")}
      </MenuButton>
    </>
  );
}

/** One menu item: a real button (or a Link for in-app navigation). */
function MenuButton({
  icon,
  destructive = false,
  href,
  onClick,
  children,
}: {
  icon?: React.ReactNode;
  destructive?: boolean;
  /** Present ⇒ an in-app Link (e.g. «Открыть реестр»). */
  href?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const className =
    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors duration-instant focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright " +
    (destructive
      ? "text-error hover:bg-elevated"
      : "text-foreground hover:bg-elevated");
  if (href) {
    return (
      <Link role="menuitem" to={href} className={className} onClick={onClick}>
        {icon}
        <span className="flex-1">{children}</span>
      </Link>
    );
  }
  return (
    <button
      type="button"
      role="menuitem"
      className={className}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {icon}
      <span className="flex-1">{children}</span>
    </button>
  );
}
