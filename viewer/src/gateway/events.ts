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
 *
 * AGW-1 addition (ARCH-9, ADR 0009 Amendment 2): the executor-registry
 * family `executor.online/offline/registered/updated/deleted`. Presence
 * events fire on TRANSITION only (per-heartbeat events are forbidden §11);
 * `stale` deliberately has no kind — clients render ages from GET + a local
 * ticker, SSE is only the change notification.
 *
 * SCHED-1-UI addition (ADR 0013 §4): the automation-rule family
 * `automation.rule.created/updated/toggled/deleted` — one event per rule
 * mutation, a single list-sync signal for both rule families.
 *
 * Wave 3C addition: the harness-dictionary family
 * `harness.added/removed` — one frame per dictionary mutation; `added`
 * carries the full row, `removed` the deleted name.
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

/**
 * Executor object embedded in the `executor.*` payloads — the public
 * registry shape (server `_executor_public`): id/name/harness/transport/
 * capabilities/presence/… Anonymous on the wire, extra fields ride along.
 * Secret material (`secret_hash`, the plaintext `executor_secret`) is
 * contractually absent — it exists exactly once, in the register response.
 * The declared identity (name/host) is executor-claimed, server-unverified.
 */
export interface BoardExecutor {
  readonly id: string;
  readonly name: string;
  readonly harness: string;
  /** Computed presence: online | stale | offline (TTLs live in list meta). */
  readonly presence: string;
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
  // Executor-registry kinds (ARCH-9, ADR 0009 Amendment 2 — AGW-1): the
  // presence pair fires on TRANSITION only (a 60 s sweeper diffs last_seen
  // TTLs; `stale` is a silent hysteresis corridor with NO kind of its own);
  // the registry trio mirrors the register / PATCH / DELETE routes.
  // registered/deleted travel through `_notify_and_broadcast` (the owner
  // notification rides ALONGSIDE — same passthrough as assignment.expired).
  // Each member carries its LITERAL kind, so narrowing the parsed union
  // picks the exact payload shape (per-kind optionals included).
  "executor.online": ExecutorEvent & {
    readonly kind: "executor.online";
    readonly last_seen_at: string;
  };
  "executor.offline": ExecutorEvent & {
    readonly kind: "executor.offline";
    readonly last_seen_at: string;
  };
  "executor.registered": ExecutorEvent & {
    readonly kind: "executor.registered";
    readonly notification?: BoardNotification;
  };
  "executor.updated": ExecutorEvent & { readonly kind: "executor.updated" };
  "executor.deleted": ExecutorEvent & {
    readonly kind: "executor.deleted";
    readonly notification?: BoardNotification;
  };
  // Automation-rule kinds (SCHED-1, ADR 0013 §4 — the ui-contract §11
  // reserve, emitters live in the CRUD routes via `_broadcast_rule_event`):
  // one event per mutation; `toggled` is the pure {enabled} kill-switch
  // flip, `updated` anything else, `changes` carries the old→new audit.
  "automation.rule.created": AutomationRuleEvent & {
    readonly kind: "automation.rule.created";
  };
  "automation.rule.updated": AutomationRuleEvent & {
    readonly kind: "automation.rule.updated";
  };
  "automation.rule.toggled": AutomationRuleEvent & {
    readonly kind: "automation.rule.toggled";
  };
  "automation.rule.deleted": AutomationRuleEvent & {
    readonly kind: "automation.rule.deleted";
  };
  // Enrollment-token kinds (AGW-5 phase 2, ui-contract §11 дополнение
  // 2026-09-22): mint / registration leg / revoke / TTL-sweep. `used` rides
  // WITHOUT a duplicate notification — `executor.registered` already carries
  // one (spam-guard per host).
  "enrollment.created": EnrollmentEvent & { readonly kind: "enrollment.created" };
  "enrollment.used": EnrollmentEvent & {
    readonly kind: "enrollment.used";
    readonly executor_id: string;
    readonly executor_name: string;
    readonly used_ip: string;
  };
  "enrollment.revoked": EnrollmentEvent & { readonly kind: "enrollment.revoked" };
  "enrollment.expired": EnrollmentEvent & { readonly kind: "enrollment.expired" };
  // Harness-dictionary kinds (wave 3C, ui-contract §11 дополнение): one
  // frame per dictionary mutation (add/remove). `added` carries the full
  // row, `removed` only the name — consumers treat the pair as a single
  // list-sync signal over the harnesses key.
  "harness.added": HarnessEvent & { readonly kind: "harness.added" };
  "harness.removed": HarnessEvent & { readonly kind: "harness.removed" };
  // Pairing kinds (CV-7, ADR 0012 §10.3 — ui-contract §11 дополнение):
  // requested (exchange created→scanned), confirmed (owner allow=true),
  // revoked (owner deny / cancel / device revoke — pairing_id XOR device_id
  // depending on WHAT died), expired (TTL sweep). Payload audit rule §3.3:
  // NEVER code/verify/device_token in any payload — these frames are the
  // owner panel's change HINTS only (the digits come from
  // GET /api/pairing/{id} under ui-token, never from the LAN stream).
  "pairing.requested": PairingEvent & {
    readonly kind: "pairing.requested";
    readonly device_name?: string;
  };
  "pairing.confirmed": PairingEvent & {
    readonly kind: "pairing.confirmed";
    readonly device_name?: string;
  };
  "pairing.revoked": {
    readonly kind: "pairing.revoked";
    readonly pairing_id?: string;
    readonly device_id?: string;
  };
  "pairing.expired": PairingEvent & { readonly kind: "pairing.expired" };
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

/**
 * Executor-registry event payload (ARCH-9), fixed by the server emitters:
 * `_presence_sweep_once` (online/offline carry the transition timestamp),
 * the register route (prev_state is null — no prior registry state), the
 * owner PATCH (updated) and DELETE (deleted; prev_state === state — the
 * removed row's terminal snapshot). The literal `kind` lives on the MAP
 * MEMBERS (one per kind), so each member is the exact wire shape.
 */
export interface ExecutorEvent {
  /** Public executor row (`_executor_public`; no secret material). */
  readonly executor: BoardExecutor;
  /** Registry/presence state before the transition; null on registration. */
  readonly prev_state: string | null;
  readonly state: string;
  /** Presence-transition timestamp — present on online/offline only. */
  readonly last_seen_at?: string;
}

/**
 * Automation-rule event payload (SCHED-1, ADR 0013 §4): `{kind, rule_kind,
 * rule, changes?}` — one event per mutation. `rule_kind` is "schedule" or
 * "hook"; `rule` is the full post-mutation row; `changes` (updated/
 * deleted only) maps field → [old, new]. Clients treat the FAMILY as a
 * single list-sync signal (АРХКОМ-5 FE verdict): invalidate, don't diff.
 */
export interface AutomationRuleEvent {
  /** Which rule family mutated: "schedule" | "hook". */
  readonly rule_kind: string;
  /** The rule row after the mutation (post-delete: its final snapshot). */
  readonly rule: Readonly<Record<string, unknown>>;
  /** old→new audit pairs (updated/toggled/deleted; absent on created). */
  readonly changes?: Readonly<Record<string, unknown>>;
}

/**
 * Enrollment-token event payload (ADR 0009 Amd 2 §4 supplement, ui-contract
 * §11 — AGW-5 phase 2): `{kind, enrollment_id, …}`. The `used` member
 * carries the minted executor link (id/name) plus the presenting IP — the
 * owner's origin cross-check at approve time; the audit rule (ADR 0012
 * §3.3 pattern) forbids token material in ANY payload, so there is no
 * token fragment here either.
 */
export interface EnrollmentEvent {
  readonly enrollment_id: string;
  /** used only: the pending executor this token minted. */
  readonly executor_id?: string;
  readonly executor_name?: string;
  readonly used_ip?: string;
}

/**
 * Harness-dictionary event payload (wave 3C, ui-contract §11 дополнение):
 * `{kind, harness|name}` — one frame per dictionary mutation. `added`
 * carries the full row; `removed` only the name (the row is gone). A pure
 * list-sync signal: consumers invalidate the harnesses key and refetch.
 */
export interface HarnessEvent {
  /** added only: the full dictionary row. */
  readonly harness?: Readonly<Record<string, unknown>>;
  /** removed only: the deleted name. */
  readonly name?: string;
}

/**
 * Pairing event payload base (ADR 0012 §10.3): `{kind, pairing_id}`.
 * Optional `device_name` rides on requested/confirmed (the self-asserted
 * label — rendered as text, unverified by definition §3.6). The `revoked`
 * member deliberately does NOT extend this base: the device-revoke emitter
 * (DELETE /api/devices/{id}) speaks about the SESSION, not the pairing, so
 * it carries `device_id` instead — the parser demands at least ONE of the
 * two identifiers on that kind.
 */
export interface PairingEvent {
  readonly pairing_id: string;
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
    case "executor.online":
    case "executor.offline":
    case "executor.registered":
    case "executor.updated":
    case "executor.deleted":
      return parseExecutorEvent(parsed, kind);
    case "automation.rule.created":
    case "automation.rule.updated":
    case "automation.rule.toggled":
    case "automation.rule.deleted":
      // Wire shape fixed by `_broadcast_rule_event`: the family + the row
      // are mandatory; the audit `changes` rides along when present.
      if (typeof parsed.rule_kind !== "string" || !isRecord(parsed.rule)) {
        return ignored("malformed-payload", kind);
      }
      return {
        status: "event",
        event: {
          kind,
          rule_kind: parsed.rule_kind,
          rule: parsed.rule,
          ...(isRecord(parsed.changes) ? { changes: parsed.changes } : {}),
        },
      };
    case "enrollment.created":
    case "enrollment.revoked":
    case "enrollment.expired":
      if (typeof parsed.enrollment_id !== "string") {
        return ignored("malformed-payload", kind);
      }
      return {
        status: "event",
        event: { kind, enrollment_id: parsed.enrollment_id },
      };
    case "enrollment.used":
      // The registration leg IS the point of this event: without the
      // executor link + presenting IP it is malformed, not merely thin.
      if (
        typeof parsed.enrollment_id !== "string" ||
        typeof parsed.executor_id !== "string" ||
        typeof parsed.executor_name !== "string" ||
        typeof parsed.used_ip !== "string"
      ) {
        return ignored("malformed-payload", kind);
      }
      return {
        status: "event",
        event: {
          kind,
          enrollment_id: parsed.enrollment_id,
          executor_id: parsed.executor_id,
          executor_name: parsed.executor_name,
          used_ip: parsed.used_ip,
        },
      };
    case "harness.added":
      // The full row is the point of `added` — without it the frame is
      // malformed (consumers could not render the new entry).
      if (!isRecord(parsed.harness)) {
        return ignored("malformed-payload", kind);
      }
      return {
        status: "event",
        event: { kind, harness: parsed.harness },
      };
    case "harness.removed":
      // Only the deleted name travels; it is mandatory.
      if (typeof parsed.name !== "string") {
        return ignored("malformed-payload", kind);
      }
      return {
        status: "event",
        event: { kind, name: parsed.name },
      };
    case "pairing.requested":
    case "pairing.confirmed":
    case "pairing.expired":
      return parsePairingEvent(parsed, kind);
    case "pairing.revoked": {
      // §10.3: owner deny/cancel speak pairing_id, the DEVICE revoke speaks
      // device_id — a frame without either identifier is malformed (the
      // consumers could not tell what died).
      if (
        typeof parsed.pairing_id !== "string" &&
        typeof parsed.device_id !== "string"
      ) {
        return ignored("malformed-payload", kind);
      }
      return {
        status: "event",
        event: {
          kind,
          ...(typeof parsed.pairing_id === "string"
            ? { pairing_id: parsed.pairing_id }
            : {}),
          ...(typeof parsed.device_id === "string"
            ? { device_id: parsed.device_id }
            : {}),
        },
      };
    }
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

/**
 * Executor-registry frames: the embedded executor row and the target state
 * are mandatory; the presence pair additionally refuses to parse without
 * its transition timestamp (§5.2 fixes that payload), so a truncated
 * online/offline frame is malformed rather than silently mistimed.
 * registered/deleted may carry the owner notification inline
 * (`_notify_and_broadcast` embeds it) — the same optional passthrough the
 * assignment family uses; online/offline/updated never do (bare `_broadcast`).
 */
function parseExecutorEvent(
  parsed: Record<string, unknown>,
  kind:
    | "executor.online"
    | "executor.offline"
    | "executor.registered"
    | "executor.updated"
    | "executor.deleted",
): ParsedBoardEvent {
  if (!isRecord(parsed.executor) || typeof parsed.state !== "string") {
    return ignored("malformed-payload", kind);
  }
  const base = {
    executor: parsed.executor as BoardExecutor,
    // Registered carries an explicit null; anything non-string reads as null.
    prev_state: typeof parsed.prev_state === "string" ? parsed.prev_state : null,
    state: parsed.state,
  };
  if (kind === "executor.online" || kind === "executor.offline") {
    if (typeof parsed.last_seen_at !== "string") {
      return ignored("malformed-payload", kind);
    }
    return {
      status: "event",
      event: { ...base, kind, last_seen_at: parsed.last_seen_at },
    };
  }
  if (kind === "executor.registered" || kind === "executor.deleted") {
    return {
      status: "event",
      event: withOptionalNotification({ ...base, kind }, parsed),
    };
  }
  return { status: "event", event: { ...base, kind } };
}

function ignored(reason: IgnoredEventReason, kind: string): ParsedBoardEvent {
  return { status: "ignored", reason, kind };
}

/**
 * Pairing frames (ADR 0012 §10.3): the pairing_id is the one mandatory
 * field on requested/confirmed/expired; the self-asserted device_name is an
 * optional passthrough on the first two (rendered as text — §3.6) and
 * contractually absent on expired (the TTL sweep knows no name).
 */
function parsePairingEvent(
  parsed: Record<string, unknown>,
  kind: "pairing.requested" | "pairing.confirmed" | "pairing.expired",
): ParsedBoardEvent {
  if (typeof parsed.pairing_id !== "string") {
    return ignored("malformed-payload", kind);
  }
  if (kind === "pairing.expired") {
    return {
      status: "event",
      event: { kind, pairing_id: parsed.pairing_id },
    };
  }
  return {
    status: "event",
    event: {
      kind,
      pairing_id: parsed.pairing_id,
      ...(typeof parsed.device_name === "string"
        ? { device_name: parsed.device_name }
        : {}),
    },
  };
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
