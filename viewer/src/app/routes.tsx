import { lazy } from "react";
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

/**
 * The route table as data (redesign concept §2.1 / ADR 0011 Ф1) — consumed by
 * createBrowserRouter (App.tsx) and createMemoryRouter (tests). The flat L1
 * routes are re-parented: memory pages under `/memory/*` (Search, Pulse,
 * Records master-detail, Tags), operational views under `/system/*` (Status,
 * Sessions, Traces — a temporary honest home inside the System domain until
 * the Ф2+ system pages arrive). Routes are FINAL for the convergence waves
 * (QA verdict §3): old paths answer with replace redirects so bookmarks
 * survive. `/clusters` stays unregistered (ADR 0003 D12 — L2); `/tasks`,
 * `/agents`, `/stores` are sidebar slots only until their phases land.
 */
export function buildRoutes(): RouteObject[] {
  return [
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

        // Система domain (temporary honest home for the legacy views).
        {
          path: "/system/status",
          element: (
            <Page>
              <StatusPage />
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
