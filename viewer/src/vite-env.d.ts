/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute base URL of the gateway. Defaults to "/api" (dev-proxy). */
  readonly VITE_MNEMOS_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
