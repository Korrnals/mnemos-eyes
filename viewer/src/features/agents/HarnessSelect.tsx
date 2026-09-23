import { useState } from "react";
import { isApiError } from "@/lib/errors";
import { useUiToken } from "@/features/ui-token/UiTokenContext";
import { useT } from "@/i18n";
import { useAddHarness, useHarnessNames } from "./useHarnesses";

/**
 * Harness select with free entry (wave 3C, design 2026-09-22 §C): the
 * options come from the LIVE dictionary (`GET /api/harnesses` via
 * useHarnesses — no UI constant), plus one «Добавить харнес…» option that
 * swaps the control into an inline add form (client pre-validation, server
 * POST under the ui-token gate, server text rendered INLINE next to the
 * field — a toast would be invisible while the owner is typing). On success
 * the new name is selected; SSE harness.* keeps other surfaces in sync.
 *
 * Same combobox everywhere a harness is nominated: AssignExecutorSheet,
 * EnrollmentDialog, the automation schedule form.
 */

/** Server's name rule, mirrored client-side for instant feedback only —
 * the POST result remains authoritative (422 text renders verbatim). */
const HARNESS_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,59}$/;

const ADD_SENTINEL = "__add_harness__";

export function HarnessSelect({
  id,
  value,
  onChange,
  className,
}: {
  id: string;
  value: string;
  onChange: (name: string) => void;
  /** Style passthrough — the three host forms use different densities. */
  className?: string;
}) {
  const t = useT();
  const uiToken = useUiToken();
  const names = useHarnessNames();
  const add = useAddHarness();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const finish = (name: string) => {
    setAdding(false);
    setDraft("");
    setError(null);
    onChange(name);
  };

  const submit = () => {
    const name = draft.trim().toLowerCase();
    if (!HARNESS_NAME_RE.test(name)) {
      setError(t("agents.harness.invalid"));
      return;
    }
    if (names?.includes(name)) {
      onChange(name);
      finish(name);
      return;
    }
    uiToken.runAuthorized(async () => {
      try {
        await add.mutateAsync({ name });
        finish(name);
      } catch (err) {
        // 401 escalates to the token gate (drop token → dialog → retry).
        if (isApiError(err) && err.status === 401) throw err;
        setError(err instanceof Error ? err.message : t("agents.harness.addFailed"));
      }
    });
  };

  if (adding) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex gap-1">
          <input
            id={id}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setAdding(false);
                setError(null);
              }
            }}
            placeholder="my-agent"
            maxLength={60}
            autoFocus
            aria-label={t("agents.harness.addOption")}
            className={
              className ??
              "h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
            }
          />
          <button
            type="button"
            onClick={submit}
            disabled={add.isPending}
            className="h-9 shrink-0 rounded-md border border-border bg-elevated px-2 text-xs font-medium hover:bg-background"
          >
            {add.isPending ? t("agents.harness.adding") : t("agents.harness.add")}
          </button>
          <button
            type="button"
            onClick={() => {
              setAdding(false);
              setError(null);
            }}
            className="h-9 shrink-0 rounded-md border border-border px-2 text-xs font-medium hover:bg-elevated"
          >
            {t("agents.sheet.cancel")}
          </button>
        </div>
        {error !== null && (
          <p role="alert" className="text-xs text-error">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <select
      id={id}
      value={value}
      onChange={(event) => {
        if (event.target.value === ADD_SENTINEL) {
          setDraft("");
          setError(null);
          setAdding(true);
          return;
        }
        onChange(event.target.value);
      }}
      className={
        className ??
        "h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
      }
    >
      {names === undefined ? (
        <option value={value}>{value}</option>
      ) : (
        <>
          {names.includes(value) || value === ""
            ? null
            : // The current value is NOT in the dictionary anymore (deleted
              // elsewhere, a stale prefill) — keep it selectable and visible
              // so the owner sees what would travel, no silent substitution.
              (
                <option key={value} value={value}>
                  {value}
                </option>
              )}
          {names.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          <option value={ADD_SENTINEL}>{t("agents.harness.addOption")}</option>
        </>
      )}
    </select>
  );
}
