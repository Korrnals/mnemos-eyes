# mnemos-eyes — L1 viewer

Read-only SPA for browsing mnemos memory. Part of the two-frontend repo
(ADR 0006): the operational board lives in `../web`, this viewer in `viewer/`.

Stack: Vite + React 18 + TypeScript (strict) + Tailwind + shadcn/ui +
TanStack Query v5 + React Router v7. Architecture:
[`../docs/architecture.md`](../docs/architecture.md), tokens:
[`../docs/design-system.md`](../docs/design-system.md).

## Run locally

Requires Node >= 22.12 and a local mnemos on `127.0.0.1:8787` for live data
(the UI itself starts fine without it — gateway calls fail gracefully).

```bash
cd viewer
npm install
npm run dev        # http://localhost:5173
```

Dev requests go to same-origin `/api/*`; the Vite dev-proxy forwards them to
`http://127.0.0.1:8787` (override target with `MNEMOS_URL=...`).

## Scripts

| Command             | What it does                                                    |
| ------------------- | --------------------------------------------------------------- |
| `npm run dev`       | Vite dev server with `/api` proxy to mnemos                     |
| `npm run build`     | Type-check (`tsc -b`) + production bundle                       |
| `npm run preview`   | Serve the production build locally                              |
| `npm run lint`      | ESLint (typescript-eslint, react-hooks)                         |
| `npm run typecheck` | `tsc -b` over app + node configs                                |
| `npm run test`      | Vitest (smoke + lib foundation tests)                           |
| `npm run format`    | Prettier write                                                  |
| `npm run codegen`   | Regenerate `src/types/openapi.d.ts` from mnemos `/openapi.json` |

## Status

Scaffold (task T1). Gateway adapters, design-system polish, and the actual
pages land in T2/T4/T5 — see
[`../docs/sessions/SESSION-01-l1-viewer.md`](../docs/sessions/SESSION-01-l1-viewer.md).
