import { createContext, useContext } from "react";
import type { MemoryGateway } from "./MemoryGateway";

/**
 * Dependency-injection context for the gateway (architecture.md §5).
 * The concrete adapter is created once at bootstrap in `main.tsx` and
 * provided here; components/hooks consume it via `useGateway`.
 */
export const GatewayContext = createContext<MemoryGateway | null>(null);

/** Access the injected gateway. Throws when used outside the provider. */
export function useGateway(): MemoryGateway {
  const gateway = useContext(GatewayContext);
  if (!gateway) {
    throw new Error(
      "useGateway: no MemoryGateway provided — wrap the tree in <GatewayContext.Provider> (see src/main.tsx).",
    );
  }
  return gateway;
}
