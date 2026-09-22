import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { ChevronDown, ChevronUp, Radio } from "lucide-react";
import { useI18n, useT } from "@/i18n";
import { formatTaskDate } from "@/features/tasks/taskStatus";
import {
  loadFeedCollapsed,
  saveFeedCollapsed,
} from "./executionPrefs";
import {
  readFeed,
  sortFeed,
  subscribeFeed,
} from "./executionFeedStore";
import type { FeedItem } from "./executionFeedStore";

/**
 * UI-10 execution feed panel (spec §1.1 layer 3 / §3.2 / §4.2): the
 * cross-cutting execution narrative — assignment.* transitions and reports,
 * interleaved by time, actor-signed, NEVER aggregated into counters.
 * Collapsed by default (persistent); new events flash-fade 2 s WITHOUT
 * moving rows (§3.2 — highlight only, no layout motion); aria-live=off on
 * the list — only TERMINAL transitions go aloud through a separate
 * visually-hidden polite region. The data comes from the ring-buffer store
 * the SSE bridge fills (one stream for the whole domain — this panel never
 * opens an EventSource of its own).
 */

/** Highlight lifetime — 2 s fade, then the row settles (no row motion). */
const FRESH_MS = 2000;

export function ExecutionFeedPanel() {
  const t = useT();
  const { lang } = useI18n();
  const [collapsed, setCollapsed] = useState(loadFeedCollapsed);
  const [snapshot, setSnapshot] = useState(readFeed);
  // Which row ids are still inside the fresh window (flash-fade driver).
  const [freshIds, setFreshIds] = useState<readonly string[]>([]);
  const [lastTerminal, setLastTerminal] = useState<string | null>(null);
  // AGW-3 review P2-2: freshness is detected by the numeric receipt SEQ,
  // never by buffer length — once the ring saturates (FEED_CAP) the length
  // stops growing, but seq keeps climbing and new rows still flash/speak.
  const seenSeqRef = useRef(0);

  useEffect(() => {
    return subscribeFeed(() => setSnapshot(readFeed()));
  }, []);

  // Rows with seq ABOVE the last seen one are new (visual tint only, rows
  // never move, §3.2); terminal newcomers also go aloud.
  useEffect(() => {
    const newest = snapshot.items.filter((item) => item.seq > seenSeqRef.current);
    if (newest.length === 0) return;
    seenSeqRef.current = snapshot.items.reduce((max, item) => Math.max(max, item.seq), 0);
    setFreshIds(newest.map((item) => item.id));
    const terminal = newest.find((item) => item.terminal);
    if (terminal) setLastTerminal(feedLine(terminal, t, lang));
    const timer = setTimeout(() => setFreshIds([]), FRESH_MS);
    return () => clearTimeout(timer);
  }, [snapshot, t, lang]);

  const rows = useMemo(() => sortFeed(snapshot.items), [snapshot.items]);

  return (
    <section
      aria-label={t("agents.feed.label")}
      className="rounded-md border border-border-subtle bg-well shadow-well"
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => {
            setCollapsed((value) => {
              saveFeedCollapsed(!value);
              return !value;
            });
          }}
          className="flex items-center gap-1.5 rounded-sm text-sm font-medium text-foreground-secondary transition-colors duration-instant hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
        >
          {collapsed ? (
            <ChevronDown className="size-4" aria-hidden="true" />
          ) : (
            <ChevronUp className="size-4" aria-hidden="true" />
          )}
          <Radio className="size-4" aria-hidden="true" />
          {t("agents.feed.label")}
          <span className="font-mono text-xs text-foreground-muted">{rows.length}</span>
        </button>
        {/* Only terminal transitions go aloud (§3.2): the list itself is
         * aria-live=off; this visually-hidden polite region speaks them. */}
        <p aria-live="polite" className="sr-only">
          {lastTerminal ?? ""}
        </p>
        <span className="ml-auto text-xs text-foreground-muted">
          {t("agents.feed.hint")}
        </span>
      </div>
      {collapsed ? null : rows.length === 0 ? (
        <div className="border-t border-border-subtle px-3 py-4 text-sm text-foreground-muted">
          {t("agents.feed.empty")}{" "}
          {/* AGW-4: the empty feed is an action too — the same way in as
           * the list's empty state (empty states with actions, §3.2). */}
          <Link
            to="/tasks"
            className="text-iris-bright underline underline-offset-2 transition-colors duration-instant hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
          >
            {t("agents.execution.openTasks")}
          </Link>
        </div>
      ) : (
        <ul
          aria-live="off"
          aria-label={t("agents.feed.listLabel")}
          className="max-h-64 space-y-0.5 overflow-y-auto border-t border-border-subtle px-2 py-1.5"
        >
          {rows.map((item) => (
            <FeedRow
              key={item.id}
              item={item}
              fresh={freshIds.includes(item.id)}
              lang={lang}
              t={t}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function FeedRow({
  item,
  fresh,
  lang,
  t,
}: {
  item: FeedItem;
  fresh: boolean;
  lang: "ru" | "en";
  t: ReturnType<typeof useT>;
}) {
  // Flash-fade: a background tint that clears after 2 s — colour only, the
  // row never moves (§3.2 Motion; nothing animates, reduced-motion safe).
  return (
    <li
      className={
        "flex flex-wrap items-baseline gap-x-2 rounded-sm px-1 py-0.5 text-sm transition-colors duration-500 " +
        (fresh ? "bg-iris/10" : "")
      }
    >
      <span className="font-mono text-xs text-foreground-muted">
        {formatTaskDate(item.ts, lang)}
      </span>
      <span className="text-xs text-foreground-secondary">
        {t(feedKindKey(item.kind))}
      </span>
      <Link
        to={`/tasks/${encodeURIComponent(item.taskId)}?tab=execution`}
        className="font-mono text-xs text-foreground underline-offset-2 hover:text-iris-bright hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
      >
        {item.taskId}
      </Link>
      {item.actor ? (
        <span className="text-xs text-foreground-muted" title={t("agents.identity.tooltip")}>
          {t("agents.feed.actor", { who: item.actor })}
        </span>
      ) : null}
      {item.kind === "report" && item.body ? (
        <span className="min-w-0 flex-1 truncate text-xs text-foreground-muted">
          {item.body}
        </span>
      ) : null}
    </li>
  );
}

function feedKindKey(kind: FeedItem["kind"]) {
  switch (kind) {
    case "assignment.created":
      return "agents.feed.created" as const;
    case "assignment.claimed":
      return "agents.feed.claimed" as const;
    case "assignment.started":
      return "agents.feed.started" as const;
    case "assignment.done":
      return "agents.feed.done" as const;
    case "assignment.failed":
      return "agents.feed.failed" as const;
    case "assignment.cancelled":
      return "agents.feed.cancelled" as const;
    case "assignment.expired":
      return "agents.feed.expired" as const;
    default:
      return "agents.feed.report" as const;
  }
}

/** One-line narration for the aloud region (terminal transitions only). */
function feedLine(item: FeedItem, t: ReturnType<typeof useT>, lang: "ru" | "en"): string {
  return `${formatTaskDate(item.ts, lang)} · ${t(feedKindKey(item.kind))} · ${item.taskId}`;
}
