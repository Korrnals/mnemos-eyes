/**
 * Kora data hooks (week 0 — mock-backed).
 *
 * TanStack Query wrappers over the KoraGateway seam; the query keys are
 * stable so the slice-1 HTTP adapter swap changes nothing above this file.
 * The transcript hook mirrors chat v1 (ADR 0019 §3): after a send the
 * caller invalidates the transcript tail and the SAME cursor GET re-reads
 * the store — there is no second content channel.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useKoraGateway } from "./koraGatewayContext";

export const koraKeys = {
  all: ["kora"] as const,
  sessions: () => [...koraKeys.all, "sessions"] as const,
  session: (sessionId: string) => [...koraKeys.all, "session", sessionId] as const,
  transcript: (sessionId: string) =>
    [...koraKeys.all, "transcript", sessionId] as const,
  stepUp: () => [...koraKeys.all, "steering", "step-up"] as const,
};

/** Slice 1 — session list + coverage. */
export function useKoraSessions() {
  const gateway = useKoraGateway();
  return useQuery({
    queryKey: koraKeys.sessions(),
    queryFn: ({ signal }) => gateway.listSessions(signal),
  });
}

/** Slice 2 — transcript cursor page (tail). */
export function useKoraTranscript(sessionId: string | undefined) {
  const gateway = useKoraGateway();
  return useQuery({
    queryKey: koraKeys.transcript(sessionId ?? "none"),
    queryFn: ({ signal }) =>
      gateway.getTranscript(sessionId as string, { after_seq: 0 }, signal),
    enabled: sessionId !== undefined,
  });
}

/** Slice 3 — prompt send; success invalidates the store tail (chat v1). */
export function useKoraSendMessage(sessionId: string | undefined) {
  const gateway = useKoraGateway();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => gateway.sendMessage(sessionId as string, text),
    onSuccess: () => {
      // Chat v1 = store-tail re-read: the transcript query refetches the
      // SAME authenticated cursor path — no event content, no second buffer.
      if (sessionId !== undefined) {
        void queryClient.invalidateQueries({
          queryKey: koraKeys.transcript(sessionId),
        });
        void queryClient.invalidateQueries({ queryKey: koraKeys.sessions() });
      }
    },
  });
}

/** Slice 3 — step-up PIN status. */
export function useKoraStepUp() {
  const gateway = useKoraGateway();
  return useQuery({
    queryKey: koraKeys.stepUp(),
    queryFn: ({ signal }) => gateway.stepUpStatus(signal),
  });
}

/** Slice 3 — enable steering (PIN), then refresh the status. */
export function useKoraEnableStepUp() {
  const gateway = useKoraGateway();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pin: string) => gateway.enableStepUp(pin),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: koraKeys.stepUp() });
    },
  });
}
