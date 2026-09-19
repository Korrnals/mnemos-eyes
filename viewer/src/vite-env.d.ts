/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute base URL of the mnemos gateway. Defaults to "/api" (dev-proxy). */
  readonly VITE_MNEMOS_API_URL?: string;
  /** Legacy adapter knob (superseded by VITE_ADAPTER; mock keeps working). */
  readonly VITE_MNEMOS_ADAPTER?: "mock" | "http";
  /** Adapter selection (ADR 0011 Ф0): "mock" | "mnemos" | "board". Default "mnemos". */
  readonly VITE_ADAPTER?: "mock" | "mnemos" | "board";
  /** Board merge-API base URL. Defaults to "/api" (same-origin). */
  readonly VITE_BOARD_API_URL?: string;
  /**
   * Auth token mirror storage (ADR 0011 §7 audit point Ф0): "local"
   * (persist across reloads — mnemos dev default) | "session" (dropped when
   * the tab closes).
   */
  readonly VITE_AUTH_STORAGE?: "local" | "session";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
