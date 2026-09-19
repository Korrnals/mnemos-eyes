import { Outlet } from "react-router";
import { useTaskEvents } from "./taskEvents";

/**
 * `/tasks/*` layout (Ф2): the single mount point of the domain SSE bridge.
 * Entering the task domain opens ONE EventStream; every parsed `task.*` /
 * `report` event is routed into the surgical cache patcher (taskEvents.ts —
 * no refreshBoard refetch). Leaving the domain tears the stream down, so
 * the other domains never pay for a subscription they do not consume.
 */
export function TasksLayout() {
  useTaskEvents();
  return <Outlet />;
}
