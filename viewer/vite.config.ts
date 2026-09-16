/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Dev proxy target: live local mnemos (adaptation of architecture.md §1 — the
// doc's port 8765 predates the current deployment on 8787).
const MNEMOS_DEV_TARGET = process.env.MNEMOS_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    proxy: {
      // Client code always talks to same-origin "/api/..." (HttpAdapter base
      // URL "/api"); Vite forwards to mnemos, stripping the prefix, since the
      // mnemos HTTP API serves routes from root ("/search", "/memories", ...).
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
});
