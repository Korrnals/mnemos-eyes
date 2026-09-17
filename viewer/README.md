# mnemos-eyes — L1 viewer

Read-only SPA for browsing mnemos memory. Part of the two-frontend repo
(ADR 0006): the operational board lives in `../web`, this viewer in `viewer/`.

Stack: Vite + React 18 + TypeScript (strict) + Tailwind + shadcn/ui +
TanStack Query v5 + React Router v7. Architecture:
[`../docs/architecture.md`](../docs/architecture.md), tokens:
[`../docs/design-system.md`](../docs/design-system.md).

## Run locally

Requires Node >= 22.12. A local mnemos on `127.0.0.1:8787` is **optional**:
development defaults to the in-memory MockAdapter (`.env.development`), so the
UI runs with fixture data out of the box.

```bash
cd viewer
npm install
npm run dev        # http://localhost:5173 — mock adapter (fixtures)
```

### Connect a live mnemos (3 steps)

1. Start the dev server against the live adapter (process env beats
   `.env.development`):
   ```bash
   VITE_MNEMOS_ADAPTER=http npm run dev
   ```
   The Vite dev-proxy forwards same-origin `/api/*` to
   `http://127.0.0.1:8787` (override the target with `MNEMOS_URL=...`).
2. Mint a token if you don't have one:
   `mnemos auth token create --name <label> --no-totp`
   (or leave TOTP enrolled — the login form will then ask for the 6-digit
   code). The token prints once; never commit or share it.
3. Open the app and press **Sign in** in the top bar, paste the `mnk_` token
   (plus the TOTP code when asked). The top bar shows
   `connected to mnemos: /api`; **Sign out** invalidates the session.
   On a permissive loopback deployment you can also keep browsing read-only
   without signing in.

To make `npm run dev` use the live adapter permanently, set
`VITE_MNEMOS_ADAPTER=http` in `.env.development.local` (gitignored). Never put
tokens in any `.env` file — authentication happens in the UI.

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
| `npm run codegen`   | Fetch mnemos `/openapi.json` into the committed `openapi-snapshot.json` and regenerate `src/types/openapi.d.ts` from it |
| `npm run codegen:offline` | Regenerate `src/types/openapi.d.ts` from the committed snapshot — no live mnemos needed |

## Status

L1 viewer: gateway (HTTP + mock), design system, pages, and the T6 auth flow
(`mnk_` token + optional TOTP, session in `mnemos-eyes:auth` localStorage) —
see [`../docs/sessions/SESSION-01-l1-viewer.md`](../docs/sessions/SESSION-01-l1-viewer.md).
