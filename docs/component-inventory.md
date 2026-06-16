# mnemos-eyes — Component Inventory (L1 Viewer)

> Status: **Accepted** (P0.1 deliverable).
> Owner: `@GCW: Senior Frontend Developer`.
> Scope: MVP = L1 read-only viewer. No edit/delete/create operations.
> All data access is through `MemoryGateway` (see [architecture.md](architecture.md) §4).

---

## Legend

- **Props** — key data props (not exhaustive; final props emerge during Phase 1 implementation).
- **Gateway calls** — methods on `MemoryGateway` this component or its hooks invoke.
- **Variants** — named state variants supported by the component.

---

## 1. Layout shell

### `Shell`

**Purpose:** App-level layout. Persistent sidebar + top bar + main content slot. Wraps every route.

| Prop | Type | Notes |
| --- | --- | --- |
| `children` | `ReactNode` | Main content slot |

**Gateway calls:** none (layout only).

**Notes:**
- Sidebar collapsible to icon-only on narrow viewports.
- Top bar contains current-route title + theme toggle.
- `Suspense` boundary wraps `children` with `<PageSkeleton />` fallback.
- `ErrorBoundary` wraps `children` with `<EmptyState variant="error" />` fallback.

---

### `Sidebar`

**Purpose:** Primary navigation: links to all L1 routes + brand mark.

| Prop | Type | Notes |
| --- | --- | --- |
| `collapsed` | `boolean` | Icon-only mode |
| `onToggle` | `() => void` | — |

**Nav items:**

| Icon | Label | Route |
| --- | --- | --- |
| iris | Search | `/` |
| grid | Memories | `/memories` |
| tag | Tags | `/tags` |
| activity | Status | `/status` |
| share-2 | Clusters | `/clusters` |
| users | Sessions | `/sessions` |
| layers | Traces | `/traces` |

---

### `TopBar`

**Purpose:** View title + theme toggle + (Phase 2) user auth indicator.

| Prop | Type | Notes |
| --- | --- | --- |
| `title` | `string` | Current route label |

**Gateway calls:** none.

---

## 2. Brand / hero element

### `IrisLogo`

**Purpose:** The animated iris — the visual heart of the lore. Used in the sidebar, dashboard hero, and empty states.

| Prop | Type | Notes |
| --- | --- | --- |
| `size` | `"sm" \| "md" \| "lg" \| "hero"` | `hero` = 160 px (dashboard); `sm` = 24 px (sidebar) |
| `breathing` | `boolean` | Enables the idle breathing animation |
| `focused` | `boolean` | Expands the iris glow (search-active state) |

**Gateway calls:** none.

**Variants:** `idle`, `focused`, `loading` (pupil pulses), `error` (iris dims to `--color-error`).

**Accessibility:** `role="img"`, `aria-label="Mnemos — memory engine"`. Animation pauses on `prefers-reduced-motion`.

---

## 3. Search experience — "pupil focus"

### `SearchBar`

**Purpose:** Unified search entry point. FTS + semantic via a single input; search type auto-detected or user-selectable.

| Prop | Type | Notes |
| --- | --- | --- |
| `value` | `string` | Controlled |
| `onChange` | `(v: string) => void` | — |
| `onSubmit` | `(v: string) => void` | Fires on Enter or button |
| `isSearching` | `boolean` | Shows iris-pulse in the search button |
| `searchType` | `"fts" \| "semantic" \| "auto"` | Displayed as a mini toggle |

**Gateway calls:** `gateway.search(...)` — called by the parent `SearchPage` hook via `useSearch`.

**Accessibility:** `role="search"`, `aria-label="Search memories"`, `aria-busy={isSearching}`.

---

### `SearchResultList`

**Purpose:** Staggered-entrance list of search results.

| Prop | Type | Notes |
| --- | --- | --- |
| `results` | `SearchResult[]` | From `useSearch` |
| `isLoading` | `boolean` | Shows skeleton cards |

**Gateway calls:** via `useSearch` hook.

---

### `SearchResultCard`

**Purpose:** Compact memory result row with title, snippet, score, tags, and search-type badge.

| Prop | Type | Notes |
| --- | --- | --- |
| `result` | `SearchResult` | — |
| `onClick` | `() => void` | Navigate to detail |

**Gateway calls:** none (display only).

**Variants:** `fts`, `semantic`, `hybrid` — affects the `TagBadge` colour on the score chip.

---

## 4. Memory list

### `MemoryListPage` (feature container)

**Purpose:** Paginated, filterable list of all memories.

**Gateway calls:** `gateway.listMemories({ status, project, limit, offset })` via `useMemories`.

**Filters (URL params):** `?project=`, `?status=`, `?limit=`.

---

### `MemoryCard`

**Purpose:** List-view representation of one memory item.

| Prop | Type | Notes |
| --- | --- | --- |
| `memory` | `Memory` | — |
| `onClick` | `() => void` | Navigate to `/memories/:id` |

**Displays:** auto-title, snippet (first 120 chars of effective content), tags, confidence dot, timestamp.

**Gateway calls:** none (display only).

---

## 5. Memory detail — "the scroll"

### `MemoryDetailPage` (feature container)

**Purpose:** Full detail view of one memory — the "scroll" experience.

**Gateway calls:** `gateway.getMemory(id, include_raw)` via `useMemory(id)`.

---

### `MemoryScroll`

**Purpose:** The scroll surface: full content in `--font-scroll`, provenance bar, tags, confidence.

| Prop | Type | Notes |
| --- | --- | --- |
| `memory` | `Memory` | — |
| `showRaw` | `boolean` | Toggle between effective and raw content |
| `onToggleRaw` | `() => void` | — |

**Sections:**

1. **Provenance bar** — `agent:`, `project:`, `created_at`, `status` badge.
2. **Content area** — `--font-scroll`, `--text-md`, `--leading-relaxed`.
3. **Raw content toggle** — only if `raw_content` ≠ `null` and differs.
4. **Tags row** — `TagBadge` list.
5. **Confidence indicator** — amber dot + numeric score (e.g. `● 0.92`).
6. **Metadata footer** — `id`, `updated_at`, `source`.

---

## 6. Tag inspector

### `TagsPage` (feature container)

**Purpose:** Browse all known tags, their frequency, and the tag contract schema.

**Gateway calls:** `gateway.listMemories({ limit: 500 })` + client-side aggregation (no dedicated `/tags` endpoint yet — open question §9).

---

### `TagInspector`

**Purpose:** Sorted, filterable tag list with counts and contract-defined prefixes highlighted.

| Prop | Type | Notes |
| --- | --- | --- |
| `tags` | `Record<string, number>` | tag → count |
| `onTagClick` | `(tag: string) => void` | Navigate to filtered memory list |

---

### `TagBadge`

**Purpose:** Inline tag chip used across list/detail/search surfaces.

| Prop | Type | Notes |
| --- | --- | --- |
| `tag` | `string` | e.g. `"type:rule"`, `"project:gcw"` |
| `size` | `"sm" \| "md"` | — |
| `onClick` | `() => void \| undefined` | Makes badge interactive |
| `variant` | `"default" \| "iris" \| "confidence" \| "error"` | Colour mapping |

**Colour mapping by prefix:**

| Prefix | Variant |
| --- | --- |
| `type:` | `iris` |
| `agent:` | `default` |
| `project:` | `default` |
| `confidence:high` | `confidence` |
| `status:error` | `error` |
| (other) | `default` |

---

## 7. Status panel

### `StatusPage` (feature container)

**Purpose:** System health at a glance: API status, memory counts, pipeline state.

**Gateway calls:**
- `gateway.health()` → `useStatus` (polling every 10 s)
- `gateway.metrics()` → `useMetrics` (polling every 15 s)

---

### `StatusPanel`

**Purpose:** Displays health indicators, counts, and pipeline metrics in a scannable grid.

| Prop | Type | Notes |
| --- | --- | --- |
| `health` | `HealthStatus` | From `useStatus` |
| `metrics` | `Metrics` | From `useMetrics` |

**Displays:** API status dot (green/red), memory count, published count, DLQ depth, model pipeline status.

---

### `StatusIndicator`

**Purpose:** Reusable semantic dot + label: `ok`, `degraded`, `error`, `unknown`.

| Prop | Type | Notes |
| --- | --- | --- |
| `status` | `"ok" \| "degraded" \| "error" \| "unknown"` | — |
| `label` | `string` | — |

---

## 8. Cluster graph

### `ClustersPage` (feature container)

**Purpose:** Visual graph of related memory clusters.

**Gateway calls:** `gateway.metrics()` for cluster data (metrics includes cluster info from `mgr.stats()`). Details TBD on exact cluster-list API endpoint — see open questions §9.

---

### `ClusterGraph`

**Purpose:** Force-directed or layout graph of memory clusters and their members.

| Prop | Type | Notes |
| --- | --- | --- |
| `clusters` | `ClusterNode[]` | Nodes: cluster + member memories |
| `onNodeClick` | `(id: string, type: "cluster" \| "memory") => void` | — |

**Library:** `@xyflow/react` (React Flow) — recommended (see §9 for rationale + open question).

**Accessibility:** keyboard-navigable nodes, `aria-label` per node, reduced-motion disables force animation.

---

## 9. A2A session views

### `SessionsPage` (feature container)

**Purpose:** List of agent-to-agent sessions.

**Gateway calls:** `gateway.listSessions()` via `useSessions`.

---

### `SessionListItem`

**Purpose:** Compact session row: session ID, participants, status, timestamp.

| Prop | Type | Notes |
| --- | --- | --- |
| `session` | `A2ASession` | — |
| `onClick` | `() => void` | Navigate to detail |

---

### `SessionDetailPage` (feature container)

**Purpose:** Full session inspection: turns, messages, associated memories.

**Gateway calls:** `gateway.getSession(id)` via `useSession(id)`.

---

## 10. Traces view

### `TracesPage` (feature container)

**Purpose:** Pipeline trace list — task labels, timestamps, statuses.

**Gateway calls:** `gateway.listTraces(task_label, limit)` via `useTraces`.

---

### `TraceRow`

**Purpose:** One trace record in a compact table row.

| Prop | Type | Notes |
| --- | --- | --- |
| `trace` | `Trace` | — |
| `onExpand` | `() => void` | Show raw JSON details inline |

---

## 11. Empty / loading / error states

### `EmptyState`

**Purpose:** Unified no-data, error, and not-found visual. Used by all route-level error boundaries and empty results.

| Prop | Type | Notes |
| --- | --- | --- |
| `variant` | `"empty" \| "error" \| "not-found" \| "offline"` | — |
| `message` | `string` | Primary message |
| `detail` | `string \| undefined` | Secondary line |
| `action` | `ReactNode \| undefined` | CTA button (e.g. "Retry") |

**Visual:** `IrisLogo size="md"` dimmed/tinted per variant. Iris is `--color-text-muted` on `empty`, `--color-error` on `error`.

**`offline` variant** — shown when `health()` returns non-ok or network is unreachable. Includes a note about CORS gating during development.

---

### `Skeleton` variants

| Variant | Used by |
| --- | --- |
| `MemoryCardSkeleton` | `MemoryListPage`, `SearchResultList` |
| `MemoryScrollSkeleton` | `MemoryDetailPage` |
| `StatGridSkeleton` | `StatusPage` |
| `GraphSkeleton` | `ClustersPage` |
| `TableRowSkeleton` | `TracesPage`, `SessionsPage` |

All skeletons use `--color-bg-elevated` with a subtle `shimmer` keyframe animation (disabled at `prefers-reduced-motion`).

---

## 12. Open questions for Tech Lead / user

1. **Dedicated `/tags` endpoint:** The current mnemos API has no `GET /tags` endpoint. The `TagsPage` aggregates tags client-side from `listMemories`. A backend `/tags` endpoint would be cleaner — should this be requested as a mnemos prereq?
2. **Cluster API surface:** `metrics()` returns `mgr.stats()` which may include cluster data, but there is no dedicated `GET /clusters` endpoint. Confirm whether cluster visualization is feasible in L1 or deferred to L2.
3. **Graph library:** `@xyflow/react` (React Flow v12, ~26 KB gz) vs `d3-force` (~8 KB gz, more animation control). React Flow recommendation: better a11y, built-in zoom/pan, labeled nodes. Needs Tech Lead sign-off on the bundle addition (>10 KB threshold from hard rules).
4. **A2A session routes:** The sessions API is mounted under `/v1/` in mnemos. Confirm the exact session list and detail endpoint shapes before implementing `HttpAdapter` session methods.
5. **Memory scroll font:** Lora (serif) vs JetBrains Mono (mono) — see [design-system.md](design-system.md) §10.
