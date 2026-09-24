/**
 * Kora week-0 contract types (ADR 0019 rev.2 — «Неделя 0 — контракт-first»).
 *
 * Re-exported from the GENERATED src/features/kora/koraContract.d.ts
 * (openapi-typescript over the frozen artifact docs/kora/openapi.yaml —
 * `npm run codegen:kora`). The generated file is the single source of truth,
 * same discipline as gateway/types.ts; these aliases keep the feature code
 * readable and give the mock/HTTP adapters one import surface. When slice 1
 * lands, the board's own /openapi.json takes over via codegen:board.
 */
import type { components } from "./koraContract";

type Schemas = components["schemas"];

/** KoraHarness — harness families wired in phase 1 (hermes → T004 is a gap). */
export type KoraHarness = Schemas["KoraHarness"];

/**
 * KoraSessionState — session liveness (presence ≠ liveness). `dead` keeps
 * the session in the registry (recovery semantics, ADR 0019 §2).
 */
export type KoraSessionState = Schemas["KoraSessionState"];

/** KoraOrigin — relay sessions are steerable from birth; local are not. */
export type KoraOrigin = Schemas["KoraOrigin"];

/** KoraSessionOut — one derived-registry row (PK: executor_id + native_id). */
export type KoraSession = Schemas["KoraSessionOut"];

/** KoraCoverageHarness — one row of the «что вижу / чего нет» screen data. */
export type KoraCoverageHarness = Schemas["KoraCoverageHarness"];

/** KoraCoverageOut — honest per-harness visibility + explicit gaps. */
export type KoraCoverage = Schemas["KoraCoverageOut"];

/** KoraSessionsOut — GET /api/kora/sessions response body. */
export type KoraSessionsList = Schemas["KoraSessionsOut"];

/** KoraTranscriptItemOut — one redacted transcript entry. */
export type KoraTranscriptItem = Schemas["KoraTranscriptItemOut"];

/** KoraTranscriptOut — cursor page of the ONE transcript-serving path. */
export type KoraTranscript = Schemas["KoraTranscriptOut"];

/** Transcript cursor params (GET ?after_seq=&limit=). */
export interface KoraTranscriptParams {
  after_seq?: number;
  limit?: number;
}

/** KoraDeliveryOut — honest relay queue state («не доставлено — повторите»). */
export type KoraDelivery = Schemas["KoraDeliveryOut"];

/** KoraSessionCreate — POST /api/kora/sessions body (executor+project+prompt). */
export type KoraSessionCreate = Schemas["KoraSessionCreate"];

/** KoraSessionCreatedOut — POST /api/kora/sessions 201 body. */
export type KoraSessionCreated = Schemas["KoraSessionCreatedOut"];

/** KoraMessageAcceptedOut — POST .../messages 202 body. */
export type KoraMessageAccepted = Schemas["KoraMessageAcceptedOut"];

/** KoraStepUpStatusOut — GET /api/kora/steering/step-up body. */
export type KoraStepUpStatus = Schemas["KoraStepUpStatusOut"];

/** KoraErrorOut codes — the frozen error vocabulary. */
export type KoraErrorCode = NonNullable<Schemas["KoraErrorOut"]["code"]>;
