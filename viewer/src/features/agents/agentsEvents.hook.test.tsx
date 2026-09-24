// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { EventStream } from "@/gateway/events";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import {
  MOCK_ASSIGNMENTS_PAGE,
  MOCK_BOARD,
  MOCK_EXECUTORS_PAGE,
} from "@/gateway/boardFixtures";
import { useAgentsEvents } from "./agentsEvents";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Reconnect anti-spam regression (review P3-3): the HOOK itself — not just
 * the pure functions — must refetch both agents keys only on a RECOVERY
 * (open → connecting → open). The INITIAL connect must not invalidate:
 * queries mounted fresh would refetch pointlessly on every page load. The
 * stream is the REAL EventStream over a stub EventSource (the
 * eventSourceFactory seam events.test.ts uses); the gateway answers the
 * capability guard with that one stream.
 */

/** EventSource double driven by the test through the factory seam. */
function stubSource() {
  const listeners: {
    open: (() => void)[];
    error: (() => void)[];
    message: ((event: { data: string }) => void)[];
  } = { open: [], error: [], message: [] };
  return {
    url: "",
    set onopen(handler: () => void) {
      listeners.open.push(handler);
    },
    set onerror(handler: () => void) {
      listeners.error.push(handler);
    },
    set onmessage(handler: (event: { data: string }) => void) {
      listeners.message.push(handler);
    },
    open() {
      for (const handler of listeners.open) handler();
    },
    drop() {
      for (const handler of listeners.error) handler();
    },
    emit(data: string) {
      for (const handler of listeners.message) handler({ data });
    },
    close: () => undefined,
  };
}

function seededClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(keys.agents.assignments.list({}), MOCK_ASSIGNMENTS_PAGE);
  client.setQueryData(keys.agents.executors.list(), MOCK_EXECUTORS_PAGE);
  client.setQueryData(keys.tasks.board(), MOCK_BOARD);
  return client;
}

function isKeyInvalidated(client: QueryClient, prefix: readonly unknown[]): boolean {
  return client
    .getQueryCache()
    .getAll()
    .some((query) => {
      const key = query.queryKey as readonly unknown[];
      return (
        key.length >= prefix.length &&
        JSON.stringify(key.slice(0, prefix.length)) === JSON.stringify(prefix) &&
        query.state.isInvalidated
      );
    });
}

/** Mount the hook against the stub-backed stream; returns cleanup handles. */
function mountHook(client: QueryClient, source: ReturnType<typeof stubSource>) {
  const gateway = {
    events: () =>
      new EventStream({
        baseUrl: "/api",
        eventSourceFactory: (url: string) => {
          source.url = url;
          return source as unknown as EventSource;
        },
      }),
  };
  function Probe() {
    useAgentsEvents();
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(
      <GatewayContext.Provider value={gateway as never}>
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
  return () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };
}

describe("useAgentsEvents — §5.9 reconnect refetch (hook-level regression)", () => {
  it("the INITIAL open does not invalidate anything (no refetch spam)", () => {
    const client = seededClient();
    const source = stubSource();
    const unmount = mountHook(client, source);

    act(() => {
      source.open(); // first connect
    });

    expect(isKeyInvalidated(client, keys.agents.assignments.all)).toBe(false);
    expect(isKeyInvalidated(client, keys.agents.executors.all)).toBe(false);
    expect(isKeyInvalidated(client, keys.tasks.all)).toBe(false);
    unmount();
  });

  it("open → connecting → open invalidates BOTH agents keys, task keys stay", () => {
    const client = seededClient();
    const source = stubSource();
    const unmount = mountHook(client, source);

    act(() => {
      source.open(); // initial connect — no refetch
      source.drop(); // native reconnect wait ("connecting")
      source.open(); // recovery — §5.9 refetch
    });

    expect(isKeyInvalidated(client, keys.agents.assignments.all)).toBe(true);
    expect(isKeyInvalidated(client, keys.agents.executors.all)).toBe(true);
    expect(isKeyInvalidated(client, keys.tasks.all)).toBe(false);
    unmount();
  });

  it("a drop WITHOUT recovery invalidates nothing (the refetch waits for open)", () => {
    const client = seededClient();
    const source = stubSource();
    const unmount = mountHook(client, source);

    act(() => {
      source.open();
      source.drop(); // socket lies down — no reconnect yet
    });

    expect(isKeyInvalidated(client, keys.agents.assignments.all)).toBe(false);
    expect(isKeyInvalidated(client, keys.agents.executors.all)).toBe(false);
    unmount();
  });
});
