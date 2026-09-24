import { useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, KeyRound, Lock, Send, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  useKoraEnableStepUp,
  useKoraSendMessage,
  useKoraSessions,
  useKoraStepUp,
  useKoraTranscript,
} from "./useKora";
import { KoraMockError } from "./KoraMockAdapter";

/**
 * `/kora/:sessionId` — slices 2 + 3 (ADR 0019 rev.2).
 *
 * Slice 2: the READ-ONLY transcript («что делалось»). Every entry rides the
 * one transcript-serving path; entries the redaction choke-point touched
 * carry the honest «маскировано» mark. A non-steerable session shows the
 * honest plate «чужая сессия — только чтение» — never a fake input.
 *
 * Slice 3: the chat panel («порулить») for steerable sessions — prompt →
 * relay → the transcript query re-reads the store tail (chat v1 = store-tail
 * re-read, ≤60s p95 target). Steering sits behind the step-up PIN (TTL
 * ≤15 мин); the mock pins the exact 403-flow the contract froze.
 */

const ROLE_TONE: Record<string, string> = {
  user: "bg-iris/15 text-iris-bright",
  assistant: "bg-elevated text-foreground-secondary",
  system: "bg-warning/15 text-warning",
  tool: "bg-confidence/15 text-confidence",
};

function ReadonlyPlate() {
  const t = useT();
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm"
    >
      <Lock aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
      <div>
        <p className="font-medium">{t("kora.session.readonlyPlate")}</p>
        <p className="text-foreground-secondary">
          {t("kora.session.readonlyPlateNote")}
        </p>
      </div>
    </div>
  );
}

function StepUpPanel() {
  const t = useT();
  const stepUp = useKoraStepUp();
  const enable = useKoraEnableStepUp();
  const [pin, setPin] = useState("");

  if (stepUp.data?.active) {
    return (
      <div
        role="status"
        className="flex items-center gap-2 rounded-md border border-success/30 bg-success/10 p-3 text-sm"
      >
        <ShieldCheck aria-hidden className="size-4 shrink-0 text-success" />
        <span>{t("kora.chat.stepUp.active")}</span>
      </div>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2 rounded-md border border-border-subtle p-3"
      onSubmit={(event) => {
        event.preventDefault();
        enable.mutate(pin, { onSettled: () => setPin("") });
      }}
    >
      <KeyRound aria-hidden className="size-4 shrink-0 text-foreground-secondary" />
      <label className="text-sm" htmlFor="kora-step-up-pin">
        {t("kora.chat.stepUp.label")}
      </label>
      <Input
        id="kora-step-up-pin"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        className="w-28"
        value={pin}
        placeholder="PIN"
        onChange={(event) => setPin(event.target.value)}
      />
      <Button type="submit" size="sm" disabled={pin.length < 4 || enable.isPending}>
        {t("kora.chat.stepUp.enable")}
      </Button>
      {enable.isError ? (
        <p role="alert" className="basis-full text-sm text-error">
          {enable.error instanceof KoraMockError
            ? enable.error.message
            : t("kora.chat.stepUp.failed")}
        </p>
      ) : null}
      <p className="basis-full text-xs text-foreground-secondary">
        {t("kora.chat.stepUp.note")}
      </p>
    </form>
  );
}

function ChatPanel({ sessionId }: { sessionId: string }) {
  const t = useT();
  const send = useKoraSendMessage(sessionId);
  const [text, setText] = useState("");

  const blocked =
    send.error instanceof KoraMockError && send.error.code === "step_up_required";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("kora.chat.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <StepUpPanel />
        <form
          className="flex items-start gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!text.trim()) return;
            send.mutate(text.trim(), { onSettled: () => setText("") });
          }}
        >
          <label className="sr-only" htmlFor="kora-chat-input">
            {t("kora.chat.placeholder")}
          </label>
          <Input
            id="kora-chat-input"
            value={text}
            placeholder={t("kora.chat.placeholder")}
            onChange={(event) => setText(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={!text.trim() || send.isPending}>
            <Send aria-hidden className="size-4" />
            <span className="sr-only">{t("kora.chat.send")}</span>
          </Button>
        </form>
        {send.data ? (
          <p className="text-xs text-foreground-secondary">
            {send.data.delivery.status === "failed"
              ? t("kora.chat.delivery.failed")
              : send.data.confirm_required
                ? t("kora.chat.confirmMode")
                : t("kora.chat.delivery.ok")}
          </p>
        ) : null}
        {blocked ? (
          <p role="alert" className="text-sm text-warning">
            {t("kora.chat.stepUp.required")}
          </p>
        ) : send.isError && !blocked ? (
          <p role="alert" className="text-sm text-error">
            {send.error instanceof KoraMockError
              ? send.error.message
              : t("kora.chat.delivery.failed")}
          </p>
        ) : null}
        <p className="text-xs text-foreground-muted">{t("kora.chat.freshness")}</p>
      </CardContent>
    </Card>
  );
}

export function KoraSessionPage() {
  const t = useT();
  const { sessionId } = useParams<{ sessionId: string }>();
  const decoded = sessionId ? decodeURIComponent(sessionId) : undefined;
  const sessions = useKoraSessions();
  const transcript = useKoraTranscript(decoded);
  const session = sessions.data?.items.find((item) => item.id === decoded);

  if (!decoded) {
    return <EmptyState variant="not-found" title={t("kora.session.noId")} />;
  }

  if (sessions.data && !session) {
    return (
      <section className="mx-auto max-w-3xl space-y-4">
        <EmptyState
          variant="not-found"
          title={t("kora.session.notFound")}
          message={t("kora.session.notFoundMessage", { id: decoded })}
          action={
            <Button variant="outline" asChild>
              <Link to="/kora">{t("kora.session.backToList")}</Link>
            </Button>
          }
        />
      </section>
    );
  }

  return (
    <section
      aria-labelledby="kora-session-title"
      className="mx-auto grid max-w-4xl gap-6 lg:grid-cols-[1fr_20rem]"
    >
      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/kora">
              <ArrowLeft aria-hidden className="size-4" />
              {t("kora.session.backToList")}
            </Link>
          </Button>
          <h1
            id="kora-session-title"
            className="min-w-0 truncate text-lg font-semibold"
          >
            {session?.project ?? decoded}
          </h1>
          {session ? (
            <>
              <span
                aria-hidden
                className={cn(
                  "size-2 rounded-full",
                  session.state === "live" ? "bg-success" : "bg-elevated",
                )}
              />
              <Badge variant="outline">
                {t(`kora.session.state.${session.state}`)}
              </Badge>
              <Badge variant="outline">
                {t(`kora.session.origin.${session.origin}`)}
              </Badge>
              <span className="font-mono text-xs text-foreground-secondary">
                {session.harness} · {session.executor_id}
              </span>
            </>
          ) : null}
        </div>

        {session && !session.steerable ? <ReadonlyPlate /> : null}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("kora.transcript.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            {transcript.isPending ? (
              <p role="status" className="text-sm text-foreground-secondary">
                {t("kora.transcript.loading")}
              </p>
            ) : transcript.isError ? (
              <EmptyState
                variant="error"
                title={t("kora.transcript.loadFailed")}
                message={transcript.error.message}
              />
            ) : transcript.data.items.length === 0 ? (
              <EmptyState
                variant="empty"
                title={t("kora.transcript.empty")}
                message={t("kora.transcript.emptyMessage")}
              />
            ) : (
              <ol className="space-y-3">
                {transcript.data.items.map((item) => (
                  <li key={item.seq} className="flex gap-3 text-sm">
                    <span
                      aria-hidden
                      className={cn(
                        "mt-0.5 h-fit shrink-0 rounded-sm px-1.5 py-0.5 text-xs font-medium",
                        ROLE_TONE[item.role] ?? ROLE_TONE.system,
                      )}
                    >
                      {item.role}
                    </span>
                    <div className="min-w-0">
                      <p className="whitespace-pre-wrap break-words">{item.content}</p>
                      <p className="mt-0.5 flex flex-wrap gap-2 text-xs text-foreground-muted">
                        <span className="font-mono">seq {item.seq}</span>
                        {item.ts ? <span>{item.ts}</span> : null}
                        {item.redaction_applied ? (
                          <span title={t("kora.transcript.redactedNote")}>
                            {t("kora.transcript.redacted")}
                          </span>
                        ) : null}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>

      <aside className="space-y-4">
        {session?.steerable ? (
          <ChatPanel sessionId={decoded} />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("kora.chat.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-foreground-secondary">
                {t("kora.chat.unavailable")}
              </p>
            </CardContent>
          </Card>
        )}
      </aside>
    </section>
  );
}
