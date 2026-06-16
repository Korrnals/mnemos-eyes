# mnemos-eyes — Frontend Architecture Spec

> Status: **Accepted** (P0.1 deliverable).
> Owner: `@GCW: Senior Frontend Developer`.
> Prerequisite reading: [CHARTER.md](CHARTER.md), [ADR 0001](decisions/0001-web-first-tauri-later.md), [ADR 0002](decisions/0002-data-layer-abstraction.md).

---

## 1. Gating dependency (CORS + Auth)

> ⚠️ The browser SPA cannot reach a production mnemos server until the backend ships:
>
> 1. **CORS** — configurable `Allow-Origin` list (tracked in `mnemos` repo).
> 2. **AuthN/AuthZ** — token-based; TOTP 2FA for remote access.
>
> During Phase 1 development, use a Vite dev-proxy (`vite.config.ts` → `server.proxy`) to forward `/api/*` → `http://127.0.0.1:8765`. No CORS headers required in that flow.
> The production deployment is blocked until the backend prerequisites land.

---

## 2. Folder / module structure

```
mnemos-eyes/
├── index.html
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── src/
│   ├── main.tsx                  # Bootstrap: create gateway, inject via context
│   ├── App.tsx                   # Router root, QueryClientProvider, ThemeProvider
│   │
│   ├── gateway/                  # MemoryGateway interface + adapters
│   │   ├── types.ts              # Re-exports from generated openapi types
│   │   ├── MemoryGateway.ts      # Interface definition (see §4)
│   │   ├── HttpAdapter.ts        # Phase 1: fetch → mnemos HTTP API
│   │   └── TauriAdapter.ts       # Phase 2: invoke() → Rust core (stub in Phase 1)
│   │
│   ├── lib/
│   │   ├── queryClient.ts        # TanStack QueryClient singleton + defaults
│   │   ├── queryKeys.ts          # Typed query key factories
│   │   └── errors.ts             # ApiError type + error normaliser
│   │
│   ├── hooks/                    # Data-fetching hooks (thin wrappers over TanStack Query)
│   │   ├── useMemories.ts
│   │   ├── useMemory.ts
│   │   ├── useSearch.ts
│   │   ├── useTags.ts
│   │   ├── useStatus.ts
│   │   ├── useClusters.ts
│   │   ├── useSessions.ts
│   │   └── useTraces.ts
│   │
│   ├── components/               # Shared UI primitives (design-system level)
│   │   ├── ui/                   # shadcn/ui wrappers + token-bound overrides
│   │   ├── IrisLogo/             # The animated iris hero element
│   │   ├── MemoryCard/
│   │   ├── SearchBar/
│   │   ├── TagBadge/
│   │   ├── StatusIndicator/
│   │   └── EmptyState/
│   │
│   ├── features/                 # Feature modules (one per route)
│   │   ├── search/
│   │   ├── memories/
│   │   ├── memory-detail/
│   │   ├── tags/
│   │   ├── status/
│   │   ├── clusters/
│   │   ├── sessions/
│   │   └── traces/
│   │
│   ├── layout/
│   │   ├── Shell.tsx             # App shell: sidebar + top bar + main slot
│   │   ├── Sidebar.tsx
│   │   └── TopBar.tsx
│   │
│   ├── styles/
│   │   ├── tokens.css            # CSS custom properties (design tokens)
│   │   └── global.css            # Tailwind base + resets
│   │
│   └── types/
│       └── openapi.d.ts          # Auto-generated from /openapi.json (DO NOT EDIT)
│
├── scripts/
│   └── codegen.sh                # openapi-typescript → src/types/openapi.d.ts
└── docs/
```

---

## 3. Routing map

Using **React Router v7** (file-based or manual config — to be decided in P1).

| Path | Feature module | Description |
| --- | --- | --- |
| `/` | `search` | Dashboard hero + unified search |
| `/memories` | `memories` | Paginated memory list |
| `/memories/:id` | `memory-detail` | Single memory scroll view |
| `/tags` | `tags` | Tag inspector + contract viewer |
| `/status` | `status` | Health, counts, pipeline status |
| `/clusters` | `clusters` | Cluster graph view |
| `/sessions` | `sessions` | A2A session list |
| `/sessions/:id` | `sessions` | A2A session detail |
| `/traces` | `traces` | Pipeline trace list |
| `*` | — | 404 / not-found empty state |

Routes are **lazy-loaded** (`React.lazy` + `Suspense`) — the search/dashboard view is the only eagerly loaded chunk.

---

## 4. `MemoryGateway` interface

All data access in components and hooks must go through this interface. No direct `fetch()` or Tauri `invoke()` calls outside `gateway/`.

```typescript
// src/gateway/MemoryGateway.ts

export interface SearchParams {
  query: string;
  tags?: string[];
  project?: string;
  limit?: number;
  include_raw?: boolean;
}

export interface SearchResult {
  id: string;
  title: string;
  content: string;
  tags: string[];
  score: number;
  search_type: "fts" | "semantic" | "hybrid";
}

export interface ListMemoriesParams {
  status?: string;
  project?: string;
  limit?: number;
  offset?: number;
}

export interface Memory {
  id: string;
  content: string;
  raw_content?: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  status: string;
  confidence?: number | null;
  source?: string | null;
  project?: string | null;
  agent?: string | null;
}

export interface HealthStatus {
  status: string;
  [key: string]: unknown;
}

export interface Metrics {
  [key: string]: unknown;
}

export interface Trace {
  id: string;
  task_label?: string | null;
  [key: string]: unknown;
}

export interface A2ASession {
  id: string;
  [key: string]: unknown;
}

export interface MemoryGateway {
  // Search
  search(params: SearchParams): Promise<SearchResult[]>;

  // Memories
  listMemories(params?: ListMemoriesParams): Promise<Memory[]>;
  getMemory(id: string, include_raw?: boolean): Promise<Memory>;

  // Agent recall
  agentRecall(agent: string, project?: string, query?: string, limit?: number): Promise<SearchResult[]>;

  // Status / health
  health(): Promise<HealthStatus>;
  metrics(): Promise<Metrics>;

  // Traces
  listTraces(task_label?: string, limit?: number): Promise<Trace[]>;

  // A2A Sessions (mounted under /v1)
  listSessions(): Promise<A2ASession[]>;
  getSession(id: string): Promise<A2ASession>;
}
```

> **Note:** The concrete types in the interface above are illustrative sketches.
> Final signatures are **auto-generated** from `/openapi.json` via
> `openapi-typescript` and live in `src/types/openapi.d.ts`. The interface wraps
> those generated types.

### `HttpAdapter` (Phase 1)

```typescript
// src/gateway/HttpAdapter.ts  (sketch)

export class HttpAdapter implements MemoryGateway {
  constructor(private readonly baseUrl: string) {}

  async search(params: SearchParams): Promise<SearchResult[]> {
    const res = await fetch(`${this.baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!res.ok) throw new ApiError(res.status, await res.text());
    return res.json();
  }

  // … other methods follow the same pattern
}
```

### `TauriAdapter` (Phase 2 — stub now)

```typescript
// src/gateway/TauriAdapter.ts  (Phase 2 stub)
// import { invoke } from "@tauri-apps/api/core";

export class TauriAdapter implements MemoryGateway {
  // Each method calls invoke("plugin:mnemos|search", { ... })
  // No network; Rust reads SQLite in-process.
  search(_params: SearchParams): Promise<SearchResult[]> {
    throw new Error("TauriAdapter not yet implemented");
  }
  // …
}
```

---

## 5. App bootstrap / dependency injection

```typescript
// src/main.tsx

import { createRoot } from "react-dom/client";
import { HttpAdapter } from "./gateway/HttpAdapter";
import { GatewayContext } from "./gateway/GatewayContext";
import App from "./App";

const BASE_URL = import.meta.env.VITE_MNEMOS_API_URL ?? "http://127.0.0.1:8765";
const gateway = new HttpAdapter(BASE_URL);

createRoot(document.getElementById("root")!).render(
  <GatewayContext.Provider value={gateway}>
    <App />
  </GatewayContext.Provider>
);
```

- The adapter is created **once** at bootstrap.
- In Phase 2 (Tauri), swap `new HttpAdapter(...)` → `new TauriAdapter()` — zero component changes.
- `VITE_MNEMOS_API_URL` controls the target; the Vite dev-proxy overrides it to loopback in development.

---

## 6. State / data-fetching strategy (TanStack Query)

| Concern | Approach |
| --- | --- |
| Server state | **TanStack Query v5** — `useQuery` / `useSuspenseQuery` everywhere |
| Local UI state | `useState` / `useReducer` scoped to the component tree that owns it |
| Global UI state | Minimal: `ThemeContext` (dark/light), `GatewayContext` (injected gateway) |
| URL state | Search query & filters stored in URL params via `useSearchParams` |
| Forms | Uncontrolled via React Hook Form (Phase 1 has no forms; placeholder for L2) |

### Query key factory (example)

```typescript
// src/lib/queryKeys.ts

export const keys = {
  memories: {
    all: ["memories"] as const,
    list: (params: ListMemoriesParams) => ["memories", "list", params] as const,
    detail: (id: string) => ["memories", "detail", id] as const,
  },
  search: {
    results: (params: SearchParams) => ["search", params] as const,
  },
  status: ["status"] as const,
  traces: (params?: { task_label?: string }) => ["traces", params] as const,
  sessions: {
    all: ["sessions"] as const,
    detail: (id: string) => ["sessions", "detail", id] as const,
  },
} as const;
```

### Stale times

| Query | `staleTime` | `gcTime` |
| --- | --- | --- |
| `health` / `metrics` | 10 s | 30 s |
| `memories list` | 30 s | 5 min |
| `memory detail` | 60 s | 10 min |
| `search results` | 0 (always fresh) | 2 min |
| `traces` | 15 s | 5 min |
| `sessions` | 15 s | 5 min |

---

## 7. Error / loading conventions

- **Loading:** `useSuspenseQuery` with a `<Suspense fallback={<Skeleton />}>` boundary per feature route. No local `isLoading` booleans in components.
- **Errors:** `<ErrorBoundary>` per feature route catches render errors and query errors. On error, renders `<EmptyState variant="error" message={...} />`.
- **Network errors:** `HttpAdapter` throws `ApiError(status, message)`. TanStack Query retries once on 5xx; does not retry on 4xx.
- **Empty data:** Components receive a non-null array / object; empty state rendering is a prop variant on `EmptyState`.

---

## 8. Types codegen

```bash
# scripts/codegen.sh
npx openapi-typescript http://127.0.0.1:8765/openapi.json \
  --output src/types/openapi.d.ts \
  --immutable-types
```

Run on every mnemos API change. The file is committed. CI runs the script and fails if the output differs (schema drift guard).

---

## 9. Phase 2 — Tauri swap

When Phase 2 is greenlit:

1. Add `@tauri-apps/api` + `@tauri-apps/cli` to dev dependencies.
2. Implement `TauriAdapter` backed by Rust commands in a `src-tauri/` crate.
3. In `src/main.tsx`, detect `window.__TAURI__` to pick the adapter at runtime.
4. The Rust crate reads the SQLite store directly — no mnemos HTTP server needed on the device.
5. Auth flow changes: no TOTP for local desktop (OS protection); TOTP retained for remote/mobile.

No component or hook changes are required in the common 90% path.
