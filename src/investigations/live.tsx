import { useAgentChat } from "@cloudflare/think/react";
import { useAgent } from "agents/react";
import { useMemo } from "react";
import { buildInvestigationTimeline, countSteps } from "./model";

/** Live thread state for one investigation (agent messages + derived timeline). */
export function useInvestigationThread(threadId: string) {
  const agent = useAgent({ agent: "incident-thread", name: threadId });
  const { messages, isStreaming, isRecovering } = useAgentChat({ agent });
  const timeline = useMemo(() => buildInvestigationTimeline(messages), [messages]);
  const counts = countSteps(timeline.entries);

  return {
    timeline,
    counts,
    busy: isStreaming || isRecovering,
    recovering: isRecovering,
  };
}

export type InvestigationLive = ReturnType<typeof useInvestigationThread>;
