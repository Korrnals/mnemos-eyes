import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/i18n";
import { useBoardTasks } from "./useTasks";
import { useTaskMutations } from "./useTaskMutations";

/**
 * New-task dialog (Ф3). Owner decision: this app creates tasks DIRECTLY via
 * `POST /api/tasks` — the first line of the raw text becomes the title, the
 * rest the summary; project and mnemos_tags attach as metadata. The board's
 * draft-to-memory flow (UI-6) is a board-only affordance and is deliberately
 * NOT duplicated here (no /api/task-drafts call from the viewer).
 *
 * Validation mirrors the wire (TaskCreate): title 1..200 chars — enforced on
 * the first line BEFORE any request; empty text never leaves the dialog.
 *
 * Like EditTaskDialog, the form is a keyed inner component: mounting seeds
 * the state (no reset effect), unmounting on close resets it for free.
 */

const TITLE_MAX = 200;

export interface CreateTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateTaskDialog({ open, onOpenChange }: CreateTaskDialogProps) {
  const t = useT();
  if (!open) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <div className="flex items-center gap-2 text-iris">
            <Plus className="size-5" aria-hidden="true" />
            <DialogTitle>{t("tasks.create.title")}</DialogTitle>
          </div>
          <DialogDescription>{t("tasks.create.description")}</DialogDescription>
        </DialogHeader>
        <CreateTaskForm onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function CreateTaskForm({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { createTask } = useTaskMutations();
  const board = useBoardTasks();
  const [text, setText] = useState("");
  const [project, setProject] = useState("");
  const [tags, setTags] = useState("");
  const [textError, setTextError] = useState(false);

  const submit = () => {
    const lines = text.split("\n");
    const title = (lines[0] ?? "").trim();
    const summary = lines.slice(1).join("\n").trim();
    if (title.length === 0 || title.length > TITLE_MAX) {
      setTextError(true);
      return;
    }
    setTextError(false);
    createTask(
      {
        title,
        summary,
        spec: "",
        col: "open",
        priority: "normal",
        env: "unknown",
        agents: [],
        specialists: [],
        project: project.trim(),
        memory_ids: [],
        mnemos_tags: tags
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part.length > 0),
      },
      // Success (direct or after the token-panel retry) closes the dialog.
      () => onClose(),
    );
  };

  const projectChoices = [
    ...new Set((board.data?.tasks ?? []).map((row) => row.project).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      noValidate
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="create-text" className="text-xs text-foreground-secondary">
          {t("tasks.create.textLabel")}
        </label>
        <textarea
          id="create-text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={6}
          aria-invalid={textError}
          aria-describedby={textError ? "create-text-error" : "create-text-hint"}
          placeholder={t("tasks.create.textPlaceholder")}
          autoFocus
          className={
            "w-full rounded-md border bg-well px-2 py-1.5 text-sm text-foreground placeholder:text-foreground-muted focus-visible:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright " +
            (textError ? "border-error" : "border-border")
          }
        />
        {textError ? (
          <p id="create-text-error" role="alert" className="text-xs text-error">
            {t("tasks.create.textError")}
          </p>
        ) : (
          <p id="create-text-hint" className="text-xs text-foreground-muted">
            {t("tasks.create.textHint")}
          </p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="create-project" className="text-xs text-foreground-secondary">
            {t("tasks.create.projectLabel")}
          </label>
          <input
            id="create-project"
            value={project}
            onChange={(event) => setProject(event.target.value)}
            list="create-project-choices"
            className="h-9 w-full rounded-md border border-border bg-well px-2 text-sm text-foreground focus-visible:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
          />
          <datalist id="create-project-choices">
            {projectChoices.map((choice) => (
              <option key={choice} value={choice} />
            ))}
          </datalist>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="create-tags" className="text-xs text-foreground-secondary">
            {t("tasks.create.tagsLabel")}
          </label>
          <input
            id="create-tags"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder={t("tasks.edit.listPlaceholder")}
            className="h-9 w-full rounded-md border border-border bg-well px-2 text-sm text-foreground placeholder:text-foreground-muted focus-visible:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
          />
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => onClose()}>
          {t("tasks.edit.cancel")}
        </Button>
        <Button type="submit" size="sm">
          {t("tasks.create.submit")}
        </Button>
      </div>
    </form>
  );
}
