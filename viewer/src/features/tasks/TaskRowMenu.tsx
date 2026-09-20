import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  PencilLine,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BoardTask } from "@/gateway/boardTypes";
import { useT } from "@/i18n";
import { TASK_COLUMNS, columnLabelKey } from "./taskStatus";
import { EditTaskDialog } from "./EditTaskDialog";
import { useTaskMutations } from "./useTaskMutations";

/**
 * Row/card action menu (Ф3): «Изменить» / «Переместить…» / «Архивировать».
 * This is the CANONICAL keyboard move path (ARCHCOM-3 verdict §3 — the
 * pointer kanban DnD exists since CV-4, but keyboard sorting goes through
 * this explicit 7-column submenu; a dnd-kit KeyboardSensor is a later
 * enhancement). Without a ui token the move still leads to the login window
 * through the standard token gate (runAuthorized).
 *
 * Two mounting modes (fix/kanban-context-menu — the SAME menu everywhere):
 * - INLINE (list rows): renders its own ⋯ trigger, uncontrolled open state;
 * - CONTROLLED (kanban cards): the card owns `open`/`onOpenChange` so one
 *   popup serves two entries — the hover-revealed ⋯ trigger (anchored to
 *   the button) and the card right-click (`position` = viewport coords →
 *   `position: fixed` popup clamped into the viewport).
 *
 * Drag isolation: the ⋯ trigger AND the popup stop pointerdown propagation
 * — a press inside the menu never bubbles to the card's dnd-kit listeners,
 * so the 5px PointerSensor activation can never start from the menu (the
 * sensor additionally ignores non-primary buttons, which makes the
 * right-click entry safe by construction).
 *
 * A11y: the ⋯ trigger is a plain labelled button (`aria-haspopup="menu"`,
 * `aria-expanded`); the popup is a `role="menu"` of real buttons — Tab/
 * Shift+Tab and Enter work natively, ArrowUp/Down rove focus, Esc closes
 * (from the submenu Esc steps back to the root first), and closing returns
 * focus to the trigger (WCAG 2.1.1 / 2.1.2 / 2.4.3). Outside pointer press
 * dismisses too. The contextmenu entry is a pointer-only convenience — the
 * keyboard path is the tab-reachable ⋯ trigger in both modes.
 */

type MenuView = "root" | "move";

/** Cursor-anchored popup clamping: min-w-44 + a viewport safety margin. */
const CURSOR_MENU_WIDTH_PX = 192;
/** Tallest view (the 7-column move list) + margin, keeps it on screen. */
const CURSOR_MENU_HEIGHT_PX = 336;
const CURSOR_MENU_VIEWPORT_MARGIN_PX = 8;

export function TaskRowMenu({
  task,
  open: openProp,
  onOpenChange,
  position = null,
  revealOnParentHover = false,
}: {
  task: BoardTask;
  /** Controlled open (kanban card); omit for the uncontrolled list rows. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Viewport coords for the contextmenu path; null anchors to the trigger. */
  position?: { x: number; y: number } | null;
  /** Kanban affordance: ⋯ hidden until the parent `group/card` hover/focus. */
  revealOnParentHover?: boolean;
}) {
  const t = useT();
  const { moveTask, archiveTask } = useTaskMutations();
  // Controlled mirror: in controlled mode `openProp` wins in render, in
  // uncontrolled (list) mode onOpenChange is absent and the local state is
  // the single source — one setter serves both.
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const [view, setView] = useState<MenuView>("root");
  const [editOpen, setEditOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const setOpen = useCallback(
    (next: boolean) => {
      if (!next) setView("root");
      setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  // Outside press dismisses; Esc handled on the menu itself.
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

  // Focus the first item when the (sub)menu opens.
  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )
      ?.focus();
  }, [open, view]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (view === "move")
        setView("root"); // Esc in submenu → root view
      else close();
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

  const onArchive = () => {
    close();
    if (!window.confirm(t("tasks.menu.archiveConfirm", { id: task.id }))) {
      triggerRef.current?.focus();
      return;
    }
    archiveTask(task);
  };

  // Cursor placement: fixed coords clamped so the popup never leaves the
  // viewport (bottom/right flips to fit); the anchored mode keeps the
  // list-proven absolute position under the trigger.
  const popupStyle: React.CSSProperties = position
    ? {
        left: Math.max(
          CURSOR_MENU_VIEWPORT_MARGIN_PX,
          Math.min(position.x, window.innerWidth - CURSOR_MENU_WIDTH_PX),
        ),
        top: Math.max(
          CURSOR_MENU_VIEWPORT_MARGIN_PX,
          Math.min(position.y, window.innerHeight - CURSOR_MENU_HEIGHT_PX),
        ),
      }
    : {};
  const popupPlacement = position
    ? "fixed z-30 "
    : "absolute right-0 top-full z-30 mt-1 ";

  return (
    <div
      ref={wrapperRef}
      className="relative"
      onBlur={(event) => {
        // Tab out of the menu dismisses it (WCAG 2.1.2 — no orphan popup
        // left behind when the focus moves on); focusout bubbles, so one
        // handler covers the trigger and every item.
        const next = event.relatedTarget;
        if (!next || !wrapperRef.current?.contains(next as Node)) {
          setOpen(false);
        }
      }}
    >
      <Button
        ref={triggerRef}
        variant="ghost"
        size="icon"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("tasks.menu.triggerAria", { id: task.id })}
        // Never feed the kanban drag sensor: without this the pointerdown
        // bubbles to the card root and a 5px travel becomes a drag.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation(); // the row/card surface must not react
          setOpen(!open);
        }}
        className={
          "size-7 " +
          (revealOnParentHover
            ? "opacity-0 transition-opacity duration-instant group-hover/card:opacity-100 group-focus-within/card:opacity-100 aria-expanded:opacity-100 "
            : "")
        }
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </Button>

      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t("tasks.menu.label", { id: task.id })}
          style={popupStyle}
          onKeyDown={onKeyDown}
          // Same drag-isolation as the trigger: presses inside the popup
          // must not reach the card's dnd-kit listeners either.
          onPointerDown={(event) => event.stopPropagation()}
          className={
            popupPlacement +
            "min-w-44 rounded-md border border-border-subtle bg-well p-1 shadow-modal"
          }
        >
          {view === "root" ? (
            <>
              <MenuButton
                icon={<PencilLine className="size-3.5" aria-hidden="true" />}
                onClick={() => {
                  setOpen(false);
                  setEditOpen(true);
                }}
              >
                {t("tasks.menu.edit")}
              </MenuButton>
              <MenuButton
                icon={<ChevronRight className="size-3.5" aria-hidden="true" />}
                iconAfter
                ariaHasPopup="menu"
                ariaExpanded={false}
                onClick={() => setView("move")}
              >
                {t("tasks.menu.move")}
              </MenuButton>
              <MenuButton
                icon={<Archive className="size-3.5" aria-hidden="true" />}
                destructive
                onClick={onArchive}
              >
                {t("tasks.menu.archive")}
              </MenuButton>
            </>
          ) : (
            <>
              <MenuButton
                icon={<ChevronLeft className="size-3.5" aria-hidden="true" />}
                onClick={() => setView("root")}
              >
                {t("tasks.menu.back")}
              </MenuButton>
              <div role="separator" className="my-1 border-t border-border-subtle" />
              {TASK_COLUMNS.map((col) => (
                <MenuButton
                  key={col}
                  disabled={col === task.col}
                  onClick={() => {
                    close();
                    moveTask(task, col);
                  }}
                >
                  {t(columnLabelKey(col))}
                </MenuButton>
              ))}
            </>
          )}
        </div>
      ) : null}

      {/* The edit dialog renders outside the menu lifecycle (focus moves in). */}
      <EditTaskDialog task={task} open={editOpen} onOpenChange={setEditOpen} />
    </div>
  );
}

function MenuButton({
  icon,
  iconAfter = false,
  destructive = false,
  ariaHasPopup,
  ariaExpanded,
  disabled = false,
  onClick,
  children,
}: {
  icon?: React.ReactNode;
  iconAfter?: boolean;
  destructive?: boolean;
  ariaHasPopup?: "menu";
  ariaExpanded?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors duration-instant focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright disabled:opacity-40 " +
        (destructive
          ? "text-error hover:bg-elevated"
          : "text-foreground hover:bg-elevated")
      }
    >
      {icon && !iconAfter ? icon : null}
      <span className="flex-1">{children}</span>
      {icon && iconAfter ? icon : null}
    </button>
  );
}
