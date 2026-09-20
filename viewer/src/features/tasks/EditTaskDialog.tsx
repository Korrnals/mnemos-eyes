import { useState } from "react";
import { PencilLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { BoardTask, TaskPatchInput } from "@/gateway/boardTypes";
import { useT } from "@/i18n";
import { TASK_PRIORITIES, priorityLabelKey } from "./taskStatus";
import { useBoardTasks } from "./useTasks";
import { useTaskMutations } from "./useTaskMutations";

/**
 * Content-field edit dialog (Ф3, UI-15 semantics of the board): title /
 * summary / spec / project / env / priority / mnemos_tags / specialists —
 * workflow fields (col/status) are deliberately absent (they move via the
 * row «Переместить…» action and UI-8 respectively).
 *
 * BE-12 age lock: a 423 from the first submit flips the dialog into its
 * lock state — the copy explains the 24h window and the only way through is
 * «Изменить принудительно» behind a native confirm (force=true).
 *
 * The form is a keyed inner component: opening the dialog mounts it fresh
 * (state seeded from the task via useState initializers — no reset effect),
 * and a different task id remounts it.
 */

const TITLE_MAX = 200;

/** Env dictionary (board ui-contract: cluster/laptop/local/cloud/unknown). */
const TASK_ENVS = ["cluster", "laptop", "local", "cloud", "unknown"] as const;

export interface EditTaskDialogProps {
  task: BoardTask;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditTaskDialog({ task, open, onOpenChange }: EditTaskDialogProps) {
  const t = useT();
  if (!open) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <div className="flex items-center gap-2 text-iris">
            <PencilLine className="size-5" aria-hidden="true" />
            <DialogTitle>{t("tasks.edit.title")}</DialogTitle>
          </div>
          <DialogDescription>
            {t("tasks.edit.description", { id: task.id })}
          </DialogDescription>
        </DialogHeader>
        <EditTaskForm key={task.id} task={task} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function EditTaskForm({ task, onDone }: { task: BoardTask; onDone: () => void }) {
  const t = useT();
  const { patchTask } = useTaskMutations();
  const board = useBoardTasks();
  const [title, setTitle] = useState(task.title ?? "");
  const [summary, setSummary] = useState(task.summary ?? "");
  const [spec, setSpec] = useState(task.spec ?? "");
  const [project, setProject] = useState(task.project ?? "");
  const [env, setEnv] = useState(task.env || "unknown");
  const [priority, setPriority] = useState(task.priority || "normal");
  const [tags, setTags] = useState((task.mnemos_tags ?? []).join(", "));
  const [specialists, setSpecialists] = useState((task.specialists ?? []).join(", "));
  const [titleError, setTitleError] = useState(false);
  const [locked, setLocked] = useState(false);

  const splitList = (value: string): string[] =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

  const buildPatch = (force: boolean): TaskPatchInput => ({
    force,
    title: title.trim(),
    summary: summary.trim(),
    spec: spec.trim(),
    project: project.trim(),
    env,
    priority,
    mnemos_tags: splitList(tags),
    specialists: splitList(specialists),
  });

  const submit = (force: boolean) => {
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0 || trimmedTitle.length > TITLE_MAX) {
      setTitleError(true);
      return;
    }
    setTitleError(false);
    patchTask(
      task,
      buildPatch(force),
      // 423 (BE-12): the dialog switches to its lock state — no error toast.
      { onLocked: () => setLocked(true), onSaved: () => onDone() },
    );
  };

  const forceEdit = () => {
    if (!window.confirm(t("tasks.edit.forceConfirm"))) return;
    submit(true);
  };

  const projectChoices = [
    ...new Set((board.data?.tasks ?? []).map((row) => row.project).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit(false);
      }}
      noValidate
    >
      <Field label={t("tasks.edit.titleLabel")} htmlFor="edit-title">
        <input
          id="edit-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          aria-invalid={titleError}
          aria-describedby={titleError ? "edit-title-error" : undefined}
          maxLength={TITLE_MAX}
          autoFocus
          className={FIELD_CLASS + (titleError ? " border-error" : "")}
        />
        {titleError ? (
          <p id="edit-title-error" role="alert" className="text-xs text-error">
            {t("tasks.edit.titleError")}
          </p>
        ) : null}
      </Field>

      <Field label={t("tasks.edit.summaryLabel")} htmlFor="edit-summary">
        <textarea
          id="edit-summary"
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          rows={3}
          className={AREA_CLASS}
        />
      </Field>

      <Field label={t("tasks.edit.specLabel")} htmlFor="edit-spec">
        <textarea
          id="edit-spec"
          value={spec}
          onChange={(event) => setSpec(event.target.value)}
          rows={5}
          className={AREA_CLASS + " font-mono text-xs"}
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("tasks.edit.projectLabel")} htmlFor="edit-project">
          <input
            id="edit-project"
            value={project}
            onChange={(event) => setProject(event.target.value)}
            list="edit-project-choices"
            className={FIELD_CLASS}
          />
          <datalist id="edit-project-choices">
            {projectChoices.map((choice) => (
              <option key={choice} value={choice} />
            ))}
          </datalist>
        </Field>
        <Field label={t("tasks.edit.envLabel")} htmlFor="edit-env">
          <select
            id="edit-env"
            value={env}
            onChange={(event) => setEnv(event.target.value)}
            className={FIELD_CLASS}
          >
            {TASK_ENVS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("tasks.edit.priorityLabel")} htmlFor="edit-priority">
          <select
            id="edit-priority"
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
            className={FIELD_CLASS}
          >
            {TASK_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {t(priorityLabelKey(value))}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("tasks.edit.specialistsLabel")} htmlFor="edit-specialists">
          <input
            id="edit-specialists"
            value={specialists}
            onChange={(event) => setSpecialists(event.target.value)}
            placeholder={t("tasks.edit.listPlaceholder")}
            className={FIELD_CLASS}
          />
        </Field>
      </div>

      <Field label={t("tasks.edit.tagsLabel")} htmlFor="edit-tags">
        <input
          id="edit-tags"
          value={tags}
          onChange={(event) => setTags(event.target.value)}
          placeholder={t("tasks.edit.listPlaceholder")}
          className={FIELD_CLASS}
        />
      </Field>

      {locked ? (
        <div
          role="alert"
          className="rounded-md border border-warning/50 bg-elevated p-3 text-sm"
        >
          <p className="font-medium">{t("tasks.edit.lockedTitle")}</p>
          <p className="mt-1 text-xs text-foreground-secondary">
            {t("tasks.edit.lockedDetail")}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={forceEdit}
          >
            {t("tasks.edit.forceLabel")}
          </Button>
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          {t("tasks.edit.cancel")}
        </Button>
        <Button type="submit" size="sm">
          {t("tasks.edit.submit")}
        </Button>
      </div>
    </form>
  );
}

const FIELD_CLASS =
  "h-9 w-full rounded-md border border-border bg-well px-2 text-sm text-foreground placeholder:text-foreground-muted focus-visible:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright";
const AREA_CLASS =
  "w-full rounded-md border border-border bg-well px-2 py-1.5 text-sm text-foreground placeholder:text-foreground-muted focus-visible:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright";

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-xs text-foreground-secondary">
        {label}
      </label>
      {children}
    </div>
  );
}
