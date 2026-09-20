import { useEffect, useRef, useState } from "react";
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
 * A11y: the ⋯ trigger is a plain labelled button (`aria-haspopup="menu"`,
 * `aria-expanded`); the popup is a `role="menu"` of real buttons — Tab/
 * Shift+Tab and Enter work natively, ArrowUp/Down rove focus, Esc closes
 * (from the submenu Esc steps back to the root first), and closing returns
 * focus to the trigger (WCAG 2.1.1 / 2.1.2 / 2.4.3). Outside pointer press
 * dismisses too.
 */

type MenuView = "root" | "move";

export function TaskRowMenu({ task }: { task: BoardTask }) {
  const t = useT();
  const { moveTask, archiveTask } = useTaskMutations();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<MenuView>("root");
  const [editOpen, setEditOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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
  }, [open]);

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
    setView("root");
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
          setView("root");
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
        onClick={(event) => {
          event.stopPropagation(); // the row itself navigates on click
          setOpen((current) => !current);
        }}
        className="size-7"
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </Button>

      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t("tasks.menu.label", { id: task.id })}
          onKeyDown={onKeyDown}
          className="absolute right-0 top-full z-30 mt-1 min-w-44 rounded-md border border-border-subtle bg-well p-1 shadow-modal"
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
