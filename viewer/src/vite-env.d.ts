/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute base URL of the gateway. Defaults to "/api" (dev-proxy). */
  readonly VITE_MNEMOS_API_URL?: string;
  /** Gateway adapter selection: "mock" (in-memory fixtures) | "http". Defaults to "http". */
  readonly VITE_MNEMOS_ADAPTER?: "mock" | "http";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
