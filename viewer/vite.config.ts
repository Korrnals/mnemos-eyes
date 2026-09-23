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

// Deterministic vendor pools for the docs-render budgets (ADR-0015 as
// amended by АРХКОМ-8): the markdown pipeline pool (≤150 KiB gzip) and the
// mermaid LAZY pool (≤450 KiB gzip) get stable chunk names so
// scripts/budget-docs-render.mjs can measure and CI-gate them. Returning
// undefined keeps vite's default placement for everything else (app code,
// react, per-file content chunks). mermaid stays lazy BECAUSE its only
// import site is the dynamic import in features/docs/Mermaid.tsx — the
// named pool must never become statically reachable (the budget script
// asserts that too).
const DOCS_RENDER_PACKAGE =
  /^(react-markdown|remark(-[a-z-]+)?|rehype(-[a-z-]+)?|micromark(-[a-z-]+)?|mdast(-util-[a-z-]+)?|unist-util-[a-z-]+|unified|vfile(-[a-z-]+)?|bail|trough|devlop|zwitch|is-plain-obj|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|character-entities(-[a-z-]+)?|trim-lines|html-url-attributes|html-void-elements|web-namespaces|ccount|escape-string-regexp|markdown-table|longest-streak|collapse-white-space|fault|direction|style-to-object|inline-style-parser)$/;

function docsVendorPool(id: string): "docs-render" | "preload-helper" | undefined {
  // vite's preload helper must NOT ride a vendor chunk: whatever chunk hosts
  // it becomes statically reachable from the entry (the entry imports
  // __vitePreload from it), which welds lazily-loaded vendor pools onto every
  // page (observed: mermaid's pool got modulepreloaded from index.html).
  if (id.includes("vite/preload-helper")) return "preload-helper";
  // NOTE: the mermaid library is deliberately NOT pinned to a named chunk.
  // Forcing its entry into a manual chunk changes rollup's placement of the
  // package's internal dynamic imports (per-diagram-type lazy chunks) and
  // merges them into one 735 KiB-gzip mega chunk (measured). Left alone, a
  // fence page downloads mermaid.core (~169 KiB gzip) + the diagram engines
  // chunk (~154 KiB gzip) + a tiny per-type shell — see
  // scripts/budget-docs-render.mjs for the CI gate and ADR-0017 numbers.
  const match = /[\\/]node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/]+)/.exec(id);
  if (match === null) return undefined;
  const name = match[1];
  if (DOCS_RENDER_PACKAGE.test(name)) return "docs-render";
  return undefined;
}

export default defineConfig(({ mode }) => ({
  // ADR 0011 (Consequences): production serves the app under /app — assets
  // and the module entry must be rooted there. Dev keeps "/" so the usual
  // `npm run dev` URLs and HMR stay unchanged.
  base: mode === "production" ? "/app/" : "/",
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: docsVendorPool,
      },
    },
  },
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
