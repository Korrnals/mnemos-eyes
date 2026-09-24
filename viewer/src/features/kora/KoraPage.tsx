import { Link } from "react-router";
import { Eye, EyeOff, Lightbulb, Radio, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { TableRowSkeleton } from "@/components/skeletons/Skeletons";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { useKoraSessions } from "./useKora";
import type { KoraCoverageHarness, KoraSession } from "./koraTypes";

/**
 * `/kora` — slice 1 screen «что происходит» (ADR 0019 rev.2).
 *
 * Week-0 UI MOCK: everything renders from the mock gateway (fixtures), no
 * backend exists — the demo plate says so honestly (project principle: no
 * silent degradations). The screen carries the three product surfaces the
 * ADR requires from slice 1: the session list, the coverage panel
 * «что вижу / чего нет» and the onboarding card (3 cases).
 */

const SUPPORT_ICON: Record<KoraCoverageHarness["support"], typeof Eye> = {
  full: Eye,
  "lists-only": Eye,
  "metadata-only": EyeOff,
  absent: EyeOff,
};

function CoveragePanel({
  harnesses,
  gaps,
}: {
  // The generated contract types are immutable — readonly arrays in, the
  // render only maps over them.
  harnesses: readonly KoraCoverageHarness[];
  gaps: readonly string[];
}) {
  const t = useT();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Eye aria-hidden className="size-4" />
          {t("kora.coverage.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-2">
          {harnesses.map((row) => {
            const Icon = SUPPORT_ICON[row.support];
            const tone =
              row.support === "full"
                ? "default"
                : row.support === "absent"
                  ? "error"
                  : "outline";
            return (
              <li
                key={row.harness}
                className="flex flex-wrap items-center gap-2 text-sm"
              >
                <Icon
                  aria-hidden
                  className="size-4 shrink-0 text-foreground-secondary"
                />
                <span className="font-mono">{row.harness}</span>
                <Badge variant={tone}>
                  {t(`kora.coverage.support.${row.support}`)}
                </Badge>
                {row.note ? (
                  <span className="basis-full text-foreground-secondary">
                    {row.note}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
        {gaps.length > 0 ? (
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground-secondary">
              {t("kora.coverage.gaps")}
            </p>
            <ul className="list-inside list-disc space-y-1 text-sm text-foreground-secondary">
              {gaps.map((gap) => (
                <li key={gap}>{gap}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Literal i18n keys (the generated types have no template-literal keys). */
const ONBOARDING_CASES = [
  { title: "kora.onboarding.case1.title", body: "kora.onboarding.case1.body" },
  { title: "kora.onboarding.case2.title", body: "kora.onboarding.case2.body" },
  { title: "kora.onboarding.case3.title", body: "kora.onboarding.case3.body" },
] as const;

function OnboardingCard() {
  const t = useT();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Lightbulb aria-hidden className="size-4" />
          {t("kora.onboarding.title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3 text-sm">
          {ONBOARDING_CASES.map((caseI18n, index) => (
            <li key={caseI18n.title} className="flex gap-3">
              <span
                aria-hidden
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-well text-xs font-semibold"
              >
                {index + 1}
              </span>
              <div>
                <p className="font-medium">{t(caseI18n.title)}</p>
                <p className="text-foreground-secondary">{t(caseI18n.body)}</p>
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function formatAge(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} м`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч ${minutes % 60} м`;
  return `${Math.floor(hours / 24)} сут ${hours % 24} ч`;
}

const STATE_TONE: Record<KoraSession["state"], string> = {
  live: "bg-success/15 text-success",
  idle: "bg-elevated text-foreground-secondary",
  dead: "bg-elevated text-foreground-muted",
};

function SessionRow({ session }: { session: KoraSession }) {
  const t = useT();
  return (
    <li>
      <Link
        to={`/kora/${encodeURIComponent(session.id)}`}
        className="flex flex-col gap-2 rounded-md border border-border-subtle p-4 transition-colors hover:bg-well focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span
            aria-hidden
            className={cn("size-2 shrink-0 rounded-full", STATE_TONE[session.state])}
          />
          <span className="font-mono text-sm">{session.harness}</span>
          <Badge variant="outline">{t(`kora.session.state.${session.state}`)}</Badge>
          <span className="min-w-0 truncate text-sm font-medium">
            {session.project ?? session.native_id}
          </span>
          <Badge variant="outline">{t(`kora.session.origin.${session.origin}`)}</Badge>
          {session.steerable ? (
            <Badge variant="outline" className="gap-1">
              <Radio aria-hidden className="size-3" />
              {t("kora.session.steerable")}
            </Badge>
          ) : null}
          <span className="ml-auto shrink-0 text-xs text-foreground-secondary">
            {t("kora.session.age", { age: formatAge(session.age_seconds) })}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-foreground-secondary">
          <span className="font-mono">{session.executor_id}</span>
          <span className="font-mono">{session.native_id}</span>
          {session.cwd ? <span className="truncate">{session.cwd}</span> : null}
        </div>
        {session.last_line_preview ? (
          <p className="line-clamp-2 text-sm text-foreground-secondary">
            {session.last_line_preview}
          </p>
        ) : (
          <p className="text-sm italic text-foreground-muted">
            {t("kora.session.noPreview")}
          </p>
        )}
      </Link>
    </li>
  );
}

export function KoraPage() {
  const t = useT();
  const sessions = useKoraSessions();

  return (
    <section aria-labelledby="kora-title" className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="kora-title" className="text-xl font-semibold">
          {t("kora.title")}
        </h1>
        <Badge variant="outline" className="gap-1">
          <ShieldCheck aria-hidden className="size-3" />
          {t("kora.week0Badge")}
        </Badge>
      </div>
      <p className="max-w-prose text-sm text-foreground-secondary">
        {t("kora.week0Note")}
      </p>

      <div className="grid gap-6 md:grid-cols-2">
        <CoveragePanel
          harnesses={sessions.data?.coverage.harnesses ?? []}
          gaps={sessions.data?.coverage.gaps ?? []}
        />
        <OnboardingCard />
      </div>

      <h2 className="text-lg font-semibold">{t("kora.list.title")}</h2>

      {sessions.isPending ? (
        <div role="status" aria-label={t("kora.list.loading")}>
          <TableRowSkeleton rows={4} columns={3} />
        </div>
      ) : sessions.isError ? (
        <EmptyState
          variant="error"
          title={t("kora.list.loadFailed")}
          message={sessions.error.message}
          action={
            <Button variant="outline" onClick={() => void sessions.refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : sessions.data.items.length === 0 ? (
        <EmptyState
          variant="empty"
          title={t("kora.list.empty")}
          message={t("kora.list.emptyMessage")}
        />
      ) : (
        <ul className="space-y-3">
          {sessions.data.items.map((session) => (
            <SessionRow key={session.id} session={session} />
          ))}
        </ul>
      )}
    </section>
  );
}
