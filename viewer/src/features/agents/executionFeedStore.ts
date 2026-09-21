import type { BoardEvent } from "@/gateway/events";

/**
 * UI-10 execution feed store (AGW-3, spec §1.1 layer 3 / §4.2): a
 * module-level RING BUFFER of execution events — `assignment.*` (7 kinds)
 * and `report`, interleaved by time. Events are NARRATIVES, never
 * aggregates (§4.2): each row keeps who · action · object · time.
 *
 * Split brain by design:
 * - the PURE half (pushFeedItem/sortFeed) is unit-testable directly;
 * - the SINGLETON half is the app's one live buffer. The SSE bridge
 *   (agentsEvents.ts) is the only WRITER — the stream it already owns
 *   feeds both the cache invalidation and this store, so the page never
 *   opens a second EventSource. Readers subscribe; SSE has no history, so
 *   a fresh page starts empty (the honest empty state) and the buffer
 *   fills as transitions arrive. `streamState`/`lastDataAt` mirror the
 *   bridge's connection so the amber «данные на HH:MM» marker has one
 *   source of truth.
 *
 * Timestamps: `assignment.*` frames carry no wire time — the feed stamps
 * them at RECEIPT (honest: the feed is a live observation log; phase
 * timestamps live in the drawer). `report` frames keep report.created_at
 * when present.
 */

/** Hard buffer cap (~200 per spec §1.1; oldest evicted, never aggregated). */
export const FEED_CAP = 200;

/** One narrative row of the execution feed. */
export interface FeedItem {
  /** Stable id (kind + subject + receipt seq). */
  readonly id: string;
  /** Numeric receipt sequence — the freshness/tie-break key (AGW-3 P2-2). */
  readonly seq: number;
  readonly kind:
    | "assignment.created"
    | "assignment.claimed"
    | "assignment.started"
    | "assignment.done"
    | "assignment.failed"
    | "assignment.cancelled"
    | "assignment.expired"
    | "report";
  /** Sort/label time (ISO string; receipt-stamped for assignment frames). */
  readonly ts: string;
  /** The task the event belongs to. */
  readonly taskId: string;
  /** Assignment id when the row is an assignment transition. */
  readonly assignmentId: string | null;
  /** Declared identity (claimed_by / created_by / report agent) — unverified. */
  readonly actor: string | null;
  /** Assignment state after the transition (null for reports). */
  readonly state: string | null;
  /** Terminal transitions get the aloud treatment (spec §3.2). */
  readonly terminal: boolean;
  /** Report body excerpt (reports only). */
  readonly body: string | null;
}

/** Pure ring-buffer push: append, cap, return the new array. */
export function pushFeedItem(
  items: readonly FeedItem[],
  item: FeedItem,
  cap: number = FEED_CAP,
): FeedItem[] {
  const next = [...items, item];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Newest-first presentation order (numeric receipt seq breaks ties —
 * string ids would order "10" before "9"). */
export function sortFeed(items: readonly FeedItem[]): FeedItem[] {
  return [...items].sort((a, b) => b.ts.localeCompare(a.ts) || b.seq - a.seq);
}

type Listener = () => void;

interface FeedState {
  items: FeedItem[];
  seq: number;
  streamState: "connecting" | "open" | "closed" | "none";
  lastDataAt: number;
  listeners: Set<Listener>;
}

const state: FeedState = {
  items: [],
  seq: 0,
  streamState: "none",
  lastDataAt: 0,
  listeners: new Set(),
};

function emit(): void {
  for (const listener of [...state.listeners]) listener();
}

/**
 * Translate one parsed board event into a feed row (null when the event is
 * not an execution narrative — task, hello and friends stay out of UI-10).
 * the caller owns the receipt sequence.
 */
export function feedItemFromEvent(
  event: BoardEvent,
  receivedAt: number,
  seq: number,
): FeedItem | null {
  if (event.kind === "report") {
    const report = event.report as Readonly<Record<string, unknown>>;
    const ts =
      typeof report.created_at === "string"
        ? report.created_at
        : new Date(receivedAt).toISOString();
    const agent = typeof report.agent === "string" ? report.agent : null;
    const body = typeof report.body === "string" ? report.body : null;
    const kind = typeof report.kind === "string" ? report.kind : "intermediate";
    return {
      id: `report-${event.task_id}-${ts}-${seq}`,
      seq,
      kind: "report",
      ts,
      taskId: event.task_id,
      assignmentId: null,
      actor: agent,
      state: kind,
      terminal: false,
      body,
    };
  }
  // Structural narrowing: every assignment member carries the embedded row
  // (kind.startsWith would not narrow the union).
  if (!("assignment" in event)) return null;
  const assignment = event.assignment as Readonly<Record<string, unknown>>;
  const assignmentId = String(assignment.id ?? "");
  const claimedBy = typeof assignment.claimed_by === "string" ? assignment.claimed_by : null;
  const createdBy = typeof assignment.created_by === "string" ? assignment.created_by : null;
  const assignmentState = typeof assignment.state === "string" ? assignment.state : "";
  return {
    id: `${event.kind}-${assignmentId}-${seq}`,
    seq,
    kind: event.kind,
    ts: new Date(receivedAt).toISOString(),
    taskId: event.task_id,
    assignmentId: assignmentId || null,
    actor: claimedBy ?? createdBy,
    state: assignmentState,
    terminal:
      event.kind === "assignment.done" ||
      event.kind === "assignment.failed" ||
      event.kind === "assignment.cancelled" ||
      event.kind === "assignment.expired",
    body: null,
  };
}

/** Bridge write port: fold one event into the buffer (non-feed events ignored). */
export function pushExecutionEvent(event: BoardEvent, receivedAt = Date.now()): void {
  state.seq += 1;
  const item = feedItemFromEvent(event, receivedAt, state.seq);
  if (!item) return;
  state.items = pushFeedItem(state.items, item);
  state.lastDataAt = receivedAt;
  emit();
}

/** Bridge write port: mirror the SSE connection state for the amber marker. */
export function setFeedStreamState(
  streamState: FeedState["streamState"],
  at = Date.now(),
): void {
  state.streamState = streamState;
  if (streamState === "open") state.lastDataAt = at;
  emit();
}

/** Read the live snapshot (render input; sortFeed orders it for display). */
export function readFeed(): {
  items: readonly FeedItem[];
  streamState: FeedState["streamState"];
  lastDataAt: number;
} {
  return { items: state.items, streamState: state.streamState, lastDataAt: state.lastDataAt };
}

/** Subscribe to buffer/stream changes; returns the unsubscribe. */
export function subscribeFeed(listener: Listener): () => void {
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

/** Test seam: wipe the singleton between tests. */
export function resetFeedStore(): void {
  state.items = [];
  state.seq = 0;
  state.streamState = "none";
  state.lastDataAt = 0;
  state.listeners.clear();
}
