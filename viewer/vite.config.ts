/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Dev proxy target: live local mnemos (adaptation of architecture.md §1 — the
// doc's port 8765 predates the current deployment on 8787).
const MNEMOS_DEV_TARGET = process.env.MNEMOS_URL ?? "http://127.0.0.1:8787";
// Dev proxy target for the board adapter (ADR 0011 Ф0): the board server
// serves its API under "/api" natively, so the proxy must NOT strip the
// prefix (unlike the mnemos proxy below).
const BOARD_DEV_TARGET = process.env.VITE_BOARD_DEV_TARGET ?? "http://127.0.0.1:8140";
// Adapter the dev server proxies for — read from the real process env (shell
// or `VITE_ADAPTER=board npm run dev`), since .env files only reach the
// client bundle via import.meta.env.
const DEV_ADAPTER = process.env.VITE_ADAPTER ?? "";

export default defineConfig(({ mode }) => ({
  // ADR 0011 (Consequences): production serves the app under /app — assets
  // and the module entry must be rooted there. Dev keeps "/" so the usual
  // `npm run dev` URLs and HMR stay unchanged.
  base: mode === "production" ? "/app/" : "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    proxy: DEV_ADAPTER.includes("board")
      ? {
          // Board adapter: same-origin "/api/..." stays "/api/..." on the
          // board server (it mounts its routes under the prefix itself).
          "/api": {
            target: BOARD_DEV_TARGET,
            changeOrigin: true,
          },
        }
      : {
          // Mnemos adapter: client code talks to same-origin "/api/..." and
          // Vite forwards to mnemos, stripping the prefix, since the mnemos
          // HTTP API serves routes from root ("/search", "/memories", ...).
          "/api": {
            target: MNEMOS_DEV_TARGET,
            changeOrigin: true,
            rewrite: (p) => p.replace(/^\/api/, ""),
          },
        },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
}));
