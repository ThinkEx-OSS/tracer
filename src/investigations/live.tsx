import { useAgentChat } from "@cloudflare/think/react";
import { useAgent } from "agents/react";
import type { UIMessage } from "ai";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
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
}

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

type TranscriptLoader = (threadId: string) => Promise<UIMessage[]>;
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
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    if (!load) {
      setError("The transcript loader is unavailable.");
      return;
    }
    void load(threadId)
      .then((next) => {
        if (active) setMessages(next);
      })
      .catch(() => {
        if (active) setError("The saved transcript could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, [load, threadId]);

  const timeline = useMemo(() => buildInvestigationTimeline(messages ?? []), [messages]);
  return {
    timeline,
    counts: countSteps(timeline.entries),
    busy: !messages && !error,
    recovering: false,
    error,
  };
}
