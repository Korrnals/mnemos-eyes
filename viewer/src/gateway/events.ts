import type { BoardTask } from "./boardTypes";

/**
 * SSE EventStream for the board `/api/events` endpoint (ADR 0011 §6: SSE is
 * a separate gateway capability; ui-contract §11 is the wire dictionary).
 *
 * Transport facts the wrapper relies on (server/app.py):
 * - one `data:`-frame per event, JSON object, `kind` is the mandatory
 *   discriminator; `event:`/`id:` fields are never used (no Last-Event-ID
 *   resumption — SSE is a notification, never the source of truth);
 * - the server sends `retry: 3000` on connect, so the native EventSource
 *   performs the auto-reconnect; this wrapper never closes on error;
 * - `hello` arrives on connect; `: keep-alive` comment frames keep proxies
 *   from idling out and never surface as messages.
 *
 * Dictionary evolution rules (ui-contract §11) that shaped this API:
 * additive-only — unknown `kind`s MUST be silently ignored by clients, so
 * `parseBoardEvent` classifies them as `ignored` instead of throwing.
 */
export type EventSourceFactory = (url: string) => EventSource;

export interface EventStreamOptions {
  /**
   * Same-origin board base ("/api" by default; `VITE_BOARD_API_URL`
   * overrides at bootstrap) — the stream URL becomes `${baseUrl}/events`.
   */
  baseUrl?: string;
  /** Full stream URL override (wins over `baseUrl`). */
  url?: string;
  /** Test/future-consumer seam — defaults to the global EventSource. */
  eventSourceFactory?: EventSourceFactory;
}

// --- Embedded payload objects (anonymous on the wire, ui-contract §11) -------

/** Notification object embedded in event payloads (`server/store.py`). */
export interface BoardNotification {
  readonly id: number;
  readonly category: "work" | "system";
  readonly title: string;
  readonly message: string;
  readonly task_id: string | null;
  readonly ts: number | string;
  readonly read: boolean;
  /** Anonymous on the wire — extra fields ride along (additive-only rules). */
  readonly [key: string]: unknown;
}

/**
 * Report object embedded in `report` events. Anonymous on the wire; `body`
 * is server-truncated to 200 chars — renderers must not assume more.
 */
export type BoardReport = Readonly<Record<string, unknown>> & {
  readonly body?: string;
};

/** Assignment states (ADR 0009; `assignment.*` emitters land in a later phase). */
export type AssignmentState =
  "queued" | "claimed" | "running" | "done" | "failed" | "cancelled" | "expired";

/**
 * Assignment object embedded in the reserved `assignment.*` payloads.
 * `claim_token` and `spec_snapshot` are contractually absent from SSE
 * payloads (secret / immutable execution view).
 */
export interface BoardAssignment {
  readonly id: string;
  readonly task_id: string;
  readonly state: AssignmentState;
  readonly [key: string]: unknown;
}

// --- Event dictionary (ui-contract §11 v1 + reserved assignment.*) -----------

export interface BoardEventMap {
  /** Service frame sent on connect; `last_event_id` is a sync hint only. */
  hello: { readonly kind: "hello"; readonly last_event_id: number };
  "task.created": {
    readonly kind: "task.created";
    readonly task: BoardTask;
    readonly notification?: BoardNotification;
  };
  "task.updated": {
    readonly kind: "task.updated";
    readonly task: BoardTask;
  };
  "task.moved": {
    readonly kind: "task.moved";
    readonly task: BoardTask;
    readonly notification?: BoardNotification;
  };
  "task.deleted": {
    readonly kind: "task.deleted";
    readonly task_id: string;
    readonly notification?: BoardNotification;
  };
  /** Known client gap of the frozen board (handled from Ф2 in this app). */
  "task.archived": {
    readonly kind: "task.archived";
    readonly task_id: string;
    readonly notification?: BoardNotification;
  };
  "task.unarchived": {
    readonly kind: "task.unarchived";
    readonly task_id: string;
    readonly notification?: BoardNotification;
  };
  /** `server` may be absent, a store name, or a `"group:{name}"` marker. */
  "server.changed": {
    readonly kind: "server.changed";
    readonly server?: string;
  };
  notification: {
    readonly kind: "notification";
    readonly notification: BoardNotification;
  };
  report: {
    readonly kind: "report";
    readonly task_id: string;
    readonly report: BoardReport;
  };
  // Reserved kinds (ADR 0009): emitters land with the assignment engine;
  // payload shape is fixed by contract so handlers can be typed already.
  "assignment.created": AssignmentEvent;
  "assignment.claimed": AssignmentEvent;
  "assignment.started": AssignmentEvent;
  "assignment.done": AssignmentEvent & { readonly notification?: BoardNotification };
  "assignment.failed": AssignmentEvent;
  "assignment.cancelled": AssignmentEvent;
  "assignment.expired": AssignmentEvent & { readonly notification?: BoardNotification };
}

export interface AssignmentEvent {
  readonly kind:
    | "assignment.created"
    | "assignment.started"
    | "assignment.claimed"
    | "assignment.done"
    | "assignment.failed"
    | "assignment.cancelled"
    | "assignment.expired";
  readonly assignment: BoardAssignment;
  readonly task_id: string;
}

/** Every kind the dictionary names (known kinds). */
export type KnownEventKind = keyof BoardEventMap & string;

/** A parsed event with a known, minimally validated kind. */
export type BoardEvent = BoardEventMap[KnownEventKind];

// --- Pure parse function (unit-tested; no EventSource involved) --------------

export type IgnoredEventReason =
  /** The data frame was not JSON at all. */
  | "invalid-json"
  /** The JSON object lacked the mandatory `kind` discriminator. */
  | "missing-kind"
  /** Additive-only dictionary: an unknown kind must be silently ignored. */
  | "unknown-kind"
  /** Known kind whose payload failed minimal shape validation. */
  | "malformed-payload";

export type ParsedBoardEvent =
  | { status: "event"; event: BoardEvent }
  | { status: "ignored"; reason: IgnoredEventReason; kind?: string };

/**
 * Parse one SSE `data:` frame into a typed board event. Pure — the
 * EventStream wrapper feeds it `MessageEvent.data`; tests call it directly.
 *
 * Validation is intentionally minimal (discriminator + the one field each
 * payload cannot function without); extra fields ride along per the
 * additive-only evolution rules.
 */
export function parseBoardEvent(raw: string): ParsedBoardEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "ignored", reason: "invalid-json" };
  }
  if (!isRecord(parsed)) return { status: "ignored", reason: "invalid-json" };
  const kind = parsed.kind;
  if (typeof kind !== "string" || kind.length === 0) {
    return { status: "ignored", reason: "missing-kind" };
  }

  switch (kind) {
    case "hello":
      return typeof parsed.last_event_id === "number"
        ? { status: "event", event: { kind, last_event_id: parsed.last_event_id } }
        : ignored("malformed-payload", kind);
    case "task.created":
    case "task.moved":
      if (!isRecord(parsed.task)) return ignored("malformed-payload", kind);
      return {
        status: "event",
        event: withOptionalNotification(
          { kind, task: parsed.task as BoardTask },
          parsed,
        ),
      };
    case "task.updated":
      if (!isRecord(parsed.task)) return ignored("malformed-payload", kind);
      return { status: "event", event: { kind, task: parsed.task as BoardTask } };
    case "task.deleted":
    case "task.archived":
    case "task.unarchived":
      if (typeof parsed.task_id !== "string") return ignored("malformed-payload", kind);
      return {
        status: "event",
        event: withOptionalNotification({ kind, task_id: parsed.task_id }, parsed),
      };
    case "server.changed":
      return {
        status: "event",
        event: {
          kind,
          ...(typeof parsed.server === "string" ? { server: parsed.server } : {}),
        },
      };
    case "notification":
      if (!isRecord(parsed.notification)) return ignored("malformed-payload", kind);
      return {
        status: "event",
        event: { kind, notification: parsed.notification as BoardNotification },
      };
    case "report":
      if (typeof parsed.task_id !== "string" || !isRecord(parsed.report)) {
        return ignored("malformed-payload", kind);
      }
      return {
        status: "event",
        event: { kind, task_id: parsed.task_id, report: parsed.report as BoardReport },
      };
    case "assignment.created":
    case "assignment.claimed":
    case "assignment.started":
    case "assignment.done":
    case "assignment.failed":
    case "assignment.cancelled":
    case "assignment.expired":
      if (typeof parsed.task_id !== "string" || !isRecord(parsed.assignment)) {
        return ignored("malformed-payload", kind);
      }
      return {
        status: "event",
        event: withOptionalNotification(
          {
            kind,
            task_id: parsed.task_id,
            assignment: parsed.assignment as BoardAssignment,
          },
          parsed,
        ),
      };
    default:
      return ignored("unknown-kind", kind);
  }
}

function withOptionalNotification<T extends object>(
  event: T,
  source: Record<string, unknown>,
): T {
  const notification = source.notification;
  return notification === undefined ? event : { ...event, notification };
}

function ignored(reason: IgnoredEventReason, kind: string): ParsedBoardEvent {
  return { status: "ignored", reason, kind };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// --- EventStream wrapper ------------------------------------------------------

export type EventStreamState = "connecting" | "open" | "closed";

/**
 * Typed subscription surface over one EventSource connection.
 *
 * Reconnect policy is delegated to the native EventSource (the server sends
 * `retry: 3000`); consumers observe lifecycle via `onStateChange` and treat
 * events as invalidation hints — after a reconnect the data must be
 * re-fetched, because the transport is at-most-once without resumption.
 */
export class EventStream {
  private readonly url: string;
  private readonly factory: EventSourceFactory;
  private readonly kindHandlers = new Map<
    KnownEventKind,
    Set<(event: never) => void>
  >();
  private readonly anyHandlers = new Set<(event: BoardEvent) => void>();
  private readonly stateHandlers = new Set<(state: EventStreamState) => void>();
  private source: EventSource | null = null;
  private state: EventStreamState = "connecting";

  constructor(options: EventStreamOptions = {}) {
    const baseUrl = (options.baseUrl ?? "/api").replace(/\/+$/, "");
    this.url = options.url ?? `${baseUrl}/events`;
    this.factory = options.eventSourceFactory ?? ((url) => new EventSource(url));
  }

  /** Current lifecycle state ("connecting" covers native reconnect waits). */
  get currentState(): EventStreamState {
    return this.state;
  }

  /** Subscribe to one dictionary kind. Returns an unsubscribe function. */
  on<K extends KnownEventKind>(
    kind: K,
    handler: (event: BoardEventMap[K]) => void,
  ): () => void {
    let handlers = this.kindHandlers.get(kind);
    if (!handlers) {
      handlers = new Set();
      this.kindHandlers.set(kind, handlers);
    }
    handlers.add(handler as (event: never) => void);
    this.ensureOpen();
    return () => {
      handlers.delete(handler as (event: never) => void);
    };
  }

  /** Subscribe to every parsed (known-kind) event. Returns an unsubscribe function. */
  onAny(handler: (event: BoardEvent) => void): () => void {
    this.anyHandlers.add(handler);
    this.ensureOpen();
    return () => {
      this.anyHandlers.delete(handler);
    };
  }

  /** Observe connection lifecycle (open / native reconnect / closed). */
  onStateChange(handler: (state: EventStreamState) => void): () => void {
    this.stateHandlers.add(handler);
    this.ensureOpen();
    handler(this.state);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  /** Tear the connection down. Idempotent; no further reconnects happen. */
  close(): void {
    this.source?.close();
    this.source = null;
    this.setState("closed");
  }

  private ensureOpen(): void {
    if (this.source) return;
    const source = this.factory(this.url);
    source.onopen = () => this.setState("open");
    // The native EventSource retries on its own (server `retry:` hint);
    // "connecting" is the honest state while a reconnect is pending.
    source.onerror = () => this.setState("connecting");
    source.onmessage = (message: MessageEvent<string>) => {
      const parsed = parseBoardEvent(message.data);
      if (parsed.status === "ignored") return; // silently, per ui-contract §11
      this.dispatch(parsed.event);
    };
    this.source = source;
  }

  private dispatch(event: BoardEvent): void {
    const handlers = this.kindHandlers.get(event.kind as KnownEventKind);
    if (handlers) {
      for (const handler of [...handlers])
        (handler as (event: BoardEvent) => void)(event);
    }
    for (const handler of [...this.anyHandlers]) handler(event);
  }

  private setState(state: EventStreamState): void {
    if (this.state === state) return;
    this.state = state;
    for (const handler of [...this.stateHandlers]) handler(state);
  }
}
