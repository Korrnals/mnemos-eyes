import { Outlet } from "react-router";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

/**
 * App shell (architecture.md §2 layout/): sidebar + top bar + main slot.
 * Feature routes render into <Outlet/> inside a per-route Suspense boundary
 * provided by App.tsx.
 */
export function Shell() {
  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main id="main" className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
