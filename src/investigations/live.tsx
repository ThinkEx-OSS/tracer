import { useAgentChat } from "@cloudflare/think/react";
import { useAgent } from "agents/react";
import type { UIMessage } from "ai";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createFailure, type CommandResult, type UserFacingFailure } from "../../shared/failure";
import {
  buildInvestigationTimeline,
  countSteps,
  type InvestigationTimeline,
  type StepCounts,
} from "./model";

export interface InvestigationView {
  timeline: InvestigationTimeline;
  counts: StepCounts;
  busy: boolean;
  recovering: boolean;
  failure?: UserFacingFailure;
}

/** Live thread state for one investigation (agent messages + derived timeline). */
export function useInvestigationThread(threadId: string) {
  const agent = useAgent({ agent: "incident-thread", name: threadId });
  const { messages, isStreaming, isRecovering, error, connectionError } = useAgentChat({ agent });
  const timeline = useMemo(() => buildInvestigationTimeline(messages), [messages]);
  const counts = countSteps(timeline.entries);
  const failure = useMemo(() => {
    if (connectionError) {
      return createFailure({
        code: "container_unavailable",
        message: "The live investigation connection was interrupted.",
        action: "Tracer will try to reconnect. Reload the page if progress does not resume.",
        retryable: true,
        source: "client",
      });
    }
    if (error) {
      return createFailure({
        code: "investigation_execution_failed",
        message: "The live investigation stream encountered an error.",
        action: "Wait for the saved status to update, then retry the investigation if needed.",
        retryable: true,
        source: "investigation",
      });
    }
  }, [connectionError, error]);

  return {
    timeline,
    counts,
    busy: isStreaming || isRecovering,
    recovering: isRecovering,
    failure,
  };
}

export type TranscriptLoader = (threadId: string) => Promise<CommandResult<UIMessage[]>>;
const TranscriptLoaderContext = createContext<TranscriptLoader | undefined>(undefined);

export function InvestigationTranscriptProvider({
  children,
  load,
}: {
  children: ReactNode;
  load: TranscriptLoader;
}) {
  return <TranscriptLoaderContext value={load}>{children}</TranscriptLoaderContext>;
}

/** One-shot transcript reader for concluded cases; it deliberately avoids useAgentChat. */
export function useInvestigationSnapshot(threadId: string) {
  const load = useContext(TranscriptLoaderContext);
  const [messages, setMessages] = useState<UIMessage[]>();
  const [failure, setFailure] = useState<UserFacingFailure>();

  useEffect(() => {
    let active = true;
    if (!load) {
      setFailure(
        createFailure({
          code: "transcript_unavailable",
          message: "The transcript loader is unavailable.",
          action: "Reload the page and try again.",
          retryable: true,
          source: "client",
        }),
      );
      return;
    }
    void load(threadId)
      .then((result) => {
        if (!active) return;
        if (result.ok) setMessages(result.value);
        else setFailure(result.failure);
      })
      .catch(() => {
        if (active)
          setFailure(
            createFailure({
              code: "transcript_unavailable",
              message: "The saved transcript could not be loaded.",
              action: "Try again. If this persists, inspect the monitoring service logs.",
              retryable: true,
              source: "client",
            }),
          );
      });
    return () => {
      active = false;
    };
  }, [load, threadId]);

  const timeline = useMemo(() => buildInvestigationTimeline(messages ?? []), [messages]);
  return {
    timeline,
    counts: countSteps(timeline.entries),
    busy: !messages && !failure,
    recovering: false,
    failure,
  };
}
