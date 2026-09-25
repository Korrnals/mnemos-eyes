import type { components } from "./koraContract";

type SpecSession = components["schemas"]["KoraSessionOut"];
type SpecTranscriptItem = components["schemas"]["KoraTranscriptItemOut"];

/**
 * Kora week-0 fixtures (ADR 0019 rev.2).
 *
 * Mock data for the slice 1–3 UI mocks. The objects are TYPED BY THE
 * GENERATED CONTRACT TYPES (satisfies against koraContract.d.ts, generated
 * from the frozen docs/kora/openapi.yaml) — if the artifact and the
 * fixtures drift apart in either direction, typecheck fails. The fixtures
 * tell the three product stories of the section: a live zcode relay session
 * (steerable), an idle vscode session (lists-only coverage, known gap), and
 * a dead pi session (recovery semantics — dead process, session stays in
 * the registry).
 */

export const KORA_FIXTURE_COVERAGE: components["schemas"]["KoraCoverageOut"] = {
  harnesses: [
    {
      harness: "zcode",
      support: "lists-only",
      note: "Списки сессий с превью (read-only сканер); полные транскрипты — срез 2",
    },
    {
      harness: "vscode",
      support: "lists-only",
      note: "Списки и превью; полный транскрипт — известный пробел (kind:1)",
    },
    { harness: "pi", support: "lists-only", note: "Списки по parentId" },
    { harness: "hermes", support: "absent", note: "Не сканируется до T004" },
  ],
  gaps: [
    "Удалённые хосты ждут расписания W4 loopback-ingress",
    "hermes-сессии не видны до T004",
    "Полные транскрипты vscode — известный пробел среза 2 (kind:1)",
  ],
};

export const KORA_FIXTURE_SESSIONS: readonly SpecSession[] = [
  {
    id: "exec-zcode-main:sess_7f3a91",
    executor_id: "exec-zcode-main",
    native_id: "sess_7f3a91",
    harness: "zcode",
    project: "mnemos-mesh",
    cwd: "/var/home/abyss/LABs/Projects/Project-Mnemos/mnemos-mesh",
    state: "live",
    origin: "relay",
    steerable: true,
    started_at: "2026-09-24T09:12:00Z",
    last_activity_at: "2026-09-24T11:41:00Z",
    age_seconds: 8940,
    last_line_preview:
      "Тесты транскрипта зелёные, осталось добавить anti-write кейс для ридера zcode…",
  },
  {
    id: "exec-vscode-lab:a83f1c22",
    executor_id: "exec-vscode-lab",
    native_id: "a83f1c22",
    harness: "vscode",
    project: "sealbox-ui",
    cwd: "/var/home/abyss/LABs/Projects/sealbox/ui",
    state: "idle",
    origin: "local",
    steerable: false,
    started_at: "2026-09-23T16:05:00Z",
    last_activity_at: "2026-09-23T19:47:00Z",
    age_seconds: 64920,
    last_line_preview: "Refactor settings hub: v2 grid layout, spacing tokens…",
  },
  {
    id: "exec-pi-edge:pi-2209-04",
    executor_id: "exec-pi-edge",
    native_id: "pi-2209-04",
    harness: "pi",
    project: null,
    cwd: null,
    state: "dead",
    origin: "local",
    steerable: false,
    started_at: "2026-09-22T07:30:00Z",
    last_activity_at: "2026-09-22T21:02:00Z",
    age_seconds: 169200,
    last_line_preview: null,
  },
] as const satisfies readonly SpecSession[];

export const KORA_FIXTURE_TRANSCRIPT: Record<string, readonly SpecTranscriptItem[]> = {
  "exec-zcode-main:sess_7f3a91": [
    {
      seq: 1,
      role: "user",
      kind: null,
      ts: "2026-09-24T09:12:20Z",
      content:
        "Разведай структуру ридера zcode-стора: что нужно для чтения mode=ro и WAL-snapshot-fallback.",
      redaction_applied: false,
    },
    {
      seq: 2,
      role: "assistant",
      kind: null,
      ts: "2026-09-24T09:13:02Z",
      content:
        "Стор — db.sqlite в ~/.local/share/zcode/sessions; ридеру достаточно mode=ro; на холодном старте открываем через снапшот. Анти-write-тест закрывает rollback/model-io.",
      redaction_applied: false,
    },
    {
      seq: 3,
      role: "tool",
      kind: "file_read",
      ts: "2026-09-24T09:13:40Z",
      content:
        "read server/kora/zcode_reader.py (128 lines) — [redacted: path inside ~/private]",
      redaction_applied: true,
    },
    {
      seq: 4,
      role: "user",
      kind: null,
      ts: "2026-09-24T11:40:10Z",
      content: "Тесты транскрипта зелёные? Добавь anti-write кейс.",
      redaction_applied: false,
    },
    {
      seq: 5,
      role: "assistant",
      kind: null,
      ts: "2026-09-24T11:41:00Z",
      content:
        "Да, 12 passed. Anti-write кейс добавил: попытка записи через ридер падает с ошибкой «database is opened read-only».",
      redaction_applied: false,
    },
  ],
  "exec-vscode-lab:a83f1c22": [
    {
      seq: 1,
      role: "user",
      kind: null,
      ts: "2026-09-23T16:05:00Z",
      content: "Refactor settings hub: v2 grid layout, spacing tokens…",
      redaction_applied: false,
    },
  ],
  "exec-pi-edge:pi-2209-04": [],
};
