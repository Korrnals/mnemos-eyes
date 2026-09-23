import { lazy } from "react";
import { Navigate } from "react-router";
import type { RouteObject } from "react-router";
import { Shell } from "@/layout/Shell";
import { SearchPage } from "@/features/search/SearchPage"; // eager — only eagerly loaded chunk (§3)
import { LEGACY_ROUTES } from "./legacyRedirects";
import { LegacyRedirect, NotFound, Page } from "./routeElements";

// Route-level code splitting (architecture.md §3: lazy-loaded routes).
const OverviewPage = lazy(() =>
  import("@/features/overview/OverviewPage").then((m) => ({
    default: m.OverviewPage,
  })),
);
const MemoriesPage = lazy(() =>
  import("@/features/memories/MemoriesPage").then((m) => ({
    default: m.MemoriesPage,
  })),
);
const MemoryDetailPage = lazy(() =>
  import("@/features/memory-detail/MemoryDetailPage").then((m) => ({
    default: m.MemoryDetailPage,
  })),
);
const PulsePage = lazy(() =>
  import("@/features/memory-pulse/PulsePage").then((m) => ({ default: m.PulsePage })),
);
const TagsPage = lazy(() =>
  import("@/features/tags/TagsPage").then((m) => ({ default: m.TagsPage })),
);
const StatusPage = lazy(() =>
  import("@/features/status/StatusPage").then((m) => ({ default: m.StatusPage })),
);
const SessionsPage = lazy(() =>
  import("@/features/sessions/SessionsPage").then((m) => ({
    default: m.SessionsPage,
  })),
);
const SessionDetailPage = lazy(() =>
  import("@/features/sessions/SessionDetailPage").then((m) => ({
    default: m.SessionDetailPage,
  })),
);
const TracesPage = lazy(() =>
  import("@/features/traces/TracesPage").then((m) => ({ default: m.TracesPage })),
);
const TaskListPage = lazy(() =>
  import("@/features/tasks/TaskListPage").then((m) => ({ default: m.TaskListPage })),
);
const TasksIndex = lazy(() =>
  import("@/features/tasks/TaskBoardPage").then((m) => ({ default: m.TasksIndex })),
);
const TaskDetailPage = lazy(() =>
  import("@/features/tasks/TaskDetailPage").then((m) => ({
    default: m.TaskDetailPage,
  })),
);
const TaskInboxPage = lazy(() =>
  import("@/features/tasks/TaskInboxPage").then((m) => ({ default: m.TaskInboxPage })),
);
const TaskArchivePage = lazy(() =>
  import("@/features/tasks/TaskArchivePage").then((m) => ({
    default: m.TaskArchivePage,
  })),
);
const TasksLayout = lazy(() =>
  import("@/features/tasks/TasksLayout").then((m) => ({ default: m.TasksLayout })),
);
const AgentsLayout = lazy(() =>
  import("@/features/agents/AgentsLayout").then((m) => ({ default: m.AgentsLayout })),
);
const AgentsExecutionPage = lazy(() =>
  import("@/features/agents/ExecutionPage").then((m) => ({ default: m.ExecutionPage })),
);
const AgentsHarnessesPage = lazy(() =>
  import("@/features/agents/ExecutorRegistryPage").then((m) => ({
    default: m.ExecutorRegistryPage,
  })),
);
// Settings hub (UI-21): the /system/settings route composes «Исполнение»
// (the AGW-3 section, reused verbatim) + «Автоматизация» + «Интерфейс»
// cross-links. The legacy single-section shell (ExecutionSettingsPage)
// stays in features/agents for composition + parity tests.
const SettingsHubPage = lazy(() =>
  import("@/features/settings/SettingsHubPage").then((m) => ({
    default: m.SettingsHubPage,
  })),
);
const AutomationPage = lazy(() =>
  import("@/features/automation/AutomationPage").then((m) => ({
    default: m.AutomationPage,
  })),
);
const DevicesPage = lazy(() =>
  import("@/features/pairing/DevicesPage").then((m) => ({ default: m.DevicesPage })),
);
// The DEVICE pairing leg lives OUTSIDE the Shell: /pair is the
// unauthenticated public surface (ADR 0012 §2.3) — no sidebar, no session
// chrome, minimal layout (PairPage renders its own centered shell).
const PairPage = lazy(() =>
  import("@/features/pairing/PairPage").then((m) => ({ default: m.PairPage })),
);
const DocsHubPage = lazy(() =>
  import("@/features/docs/DocsHubPage").then((m) => ({ default: m.DocsHubPage })),
);
const DocsCategoryPage = lazy(() =>
  import("@/features/docs/DocsCategoryPage").then((m) => ({
    default: m.DocsCategoryPage,
  })),
);
const DocsPage = lazy(() =>
  import("@/features/docs/DocsPage").then((m) => ({ default: m.DocsPage })),
);
const DocsCategoryLegacyRedirect = lazy(() =>
  import("@/features/docs/DocsRedirects").then((m) => ({
    default: m.DocsCategoryLegacyRedirect,
  })),
);

/**
 * The route table as data (redesign concept §2.1 / ADR 0011 Ф1) — consumed by
 * createBrowserRouter (App.tsx) and createMemoryRouter (tests). The flat L1
 * routes are re-parented: memory pages under `/memory/*` (Search, Pulse,
 * Records master-detail, Tags), operational views under `/system/*` (Status,
 * Sessions, Traces — a temporary honest home inside the System domain until
 * the Ф2+ system pages arrive). Routes are FINAL for the convergence waves
 * (QA verdict §3): old paths answer with replace redirects so bookmarks
 * survive. `/clusters` stays unregistered (ADR 0003 D12 — L2); `/tasks`
 * lands its Ф2 reading pages below; `/agents`, `/stores` are sidebar slots
 * only until their phases land.
 */
export function buildRoutes(): RouteObject[] {
  return [
    // /pair sits OUTSIDE the Shell (ADR 0012 §2.3): the device leg must
    // work with no session and no owner chrome — it is registered BEFORE
    // the Shell route, so it never inherits the sidebar layout.
    {
      path: "/pair",
      element: (
        <Page>
          <PairPage />
        </Page>
      ),
    },
    {
      element: <Shell />,
      children: [
        // Обзор — the app root (concept §2.4, honest Ф1 cut).
        {
          index: true,
          element: (
            <Page>
              <OverviewPage />
            </Page>
          ),
        },

        // Память domain. Static siblings outrank the :id route by ranking.
        {
          path: "/memory",
          element: (
            <Page>
              <MemoriesPage />
            </Page>
          ),
        },
        {
          path: "/memory/search",
          element: (
            <Page>
              <SearchPage />
            </Page>
          ),
        },
        {
          path: "/memory/pulse",
          element: (
            <Page>
              <PulsePage />
            </Page>
          ),
        },
        {
          path: "/memory/tags",
          element: (
            <Page>
              <TagsPage />
            </Page>
          ),
        },
        {
          path: "/memory/:id",
          element: (
            <Page>
              <MemoryDetailPage />
            </Page>
          ),
        },

        // Задачи domain (Ф2–Ф3, ADR 0011): the KANBAN is view №1 at the
        // domain root (CV-4 — the index honours the persisted view choice,
        // see TasksIndex), the dense list lives at /tasks/list, then the
        // task page (tabs), the inbox mirror and the archive. The layout
        // route owns the domain SSE bridge (taskEvents.ts).
        {
          path: "/tasks",
          element: (
            <Page>
              <TasksLayout />
            </Page>
          ),
          children: [
            { index: true, element: <TasksIndex /> },
            { path: "list", element: <TaskListPage /> },
            { path: "inbox", element: <TaskInboxPage /> },
            { path: "archive", element: <TaskArchivePage /> },
            // Static siblings rank above :id (react-router ranking).
            { path: ":id", element: <TaskDetailPage /> },
          ],
        },

        // Агенты domain (AGW-3, spec 2026-09-19 §1): the root is an ALIAS —
        // replace-redirect to the execution view (no overview dashboard:
        // «кто чем занят прямо сейчас»). ONE route object (review P3-7 —
        // the former duplicate path is gone): the layout owns the domain
        // SSE bridge, the index child redirects to the execution view, and
        // /agents/specialists + /agents/harnesses slot in as sibling
        // children when their waves land (nothing here excludes them).
        {
          path: "/agents",
          element: (
            <Page>
              <AgentsLayout />
            </Page>
          ),
          children: [
            { index: true, element: <Navigate to="/agents/execution" replace /> },
            { path: "execution", element: <AgentsExecutionPage /> },
            // AGW-4: the executor registry — connection guide + approve /
            // enable / revoke / delete management (spec §1, wave 2).
            { path: "harnesses", element: <AgentsHarnessesPage /> },
          ],
        },

        // Документация domain (ADR 0015 + ADR 0016): three project hubs.
        // /docs answers with an instant replace-redirect into the default
        // hub (design spec §2/§8 — the section root is /docs/vesmaro-eyes);
        // legacy single-segment URLs resolve through the redirect map in
        // DocsHubPage (hit → replace, miss → not-found). Static segments
        // (`c`) outrank the dynamic ones, so /docs/:project/c/:category and
        // the splat article route rank correctly against each other.
        {
          path: "/docs",
          element: (
            <Page>
              <Navigate to="/docs/vesmaro-eyes" replace />
            </Page>
          ),
        },
        {
          path: "/docs/c/:category",
          element: (
            <Page>
              <DocsCategoryLegacyRedirect />
            </Page>
          ),
        },
        {
          path: "/docs/:project",
          element: (
            <Page>
              <DocsHubPage />
            </Page>
          ),
        },
        {
          path: "/docs/:project/c/:category",
          element: (
            <Page>
              <DocsCategoryPage />
            </Page>
          ),
        },
        {
          path: "/docs/:project/*",
          element: (
            <Page>
              <DocsPage />
            </Page>
          ),
        },

        // Система domain (temporary honest home for the legacy views).
        {
          path: "/system/status",
          element: (
            <Page>
              <StatusPage />
            </Page>
          ),
        },
        // Owner settings (UI-21 hub over the AGW-3 shell): one h1 +
        // sibling sections «Исполнение» | «Автоматизация» | «Интерфейс»,
        // deep-linkable via #execution/#automation/#interface.
        {
          path: "/system/settings",
          element: (
            <Page>
              <SettingsHubPage />
            </Page>
          ),
        },
        // Automation (SCHED-1-UI, ADR 0013 §8): rules + journal + manual
        // run-now; engine honestly off in S1.
        {
          path: "/system/automation",
          element: (
            <Page>
              <AutomationPage />
            </Page>
          ),
        },
        // Устройства (CV-7, ADR 0012 Consequences): the paired-device list
        // + the QR-pairing flow («Подключить → QR → сверка → список»).
        {
          path: "/system/devices",
          element: (
            <Page>
              <DevicesPage />
            </Page>
          ),
        },
        {
          path: "/system/sessions",
          element: (
            <Page>
              <SessionsPage />
            </Page>
          ),
        },
        {
          path: "/system/sessions/:id",
          element: (
            <Page>
              <SessionDetailPage />
            </Page>
          ),
        },
        {
          path: "/system/traces",
          element: (
            <Page>
              <TracesPage />
            </Page>
          ),
        },

        // Legacy flat routes → replace redirects (bookmarks survive Ф1).
        ...LEGACY_ROUTES.map(({ from, to }) => ({
          path: from,
          element: <LegacyRedirect to={to} />,
        })),

        { path: "*", element: <NotFound /> },
      ],
    },
  ];
}
