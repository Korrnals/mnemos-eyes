import { Outlet } from "react-router";
import { useAgentsEvents } from "./agentsEvents";

/**
 * `/agents/*` layout (AGW-3): the DOMAIN OWNER of the agents SSE bridge —
 * entering the subtree opens ONE EventStream (cache invalidation + the
 * UI-10 feed buffer), leaving tears it down, so the rest of the app never
 * pays for a subscription it does not consume (the TasksLayout pattern;
 * this move retired the AGW-1 P3-1 double-connection cost on /tasks).
 * The /agents root itself is an alias: routes.tsx replace-redirects it to
 * /agents/execution (spec §1 — «кто чем занят прямо сейчас», no overview
 * dashboard).
 */
export function AgentsLayout() {
  useAgentsEvents();
  return <Outlet />;
}
