import { StatusBadge } from "./components/status-badge";
import { Separator } from "./components/ui/separator";
import { useAgent } from "agents/react";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createInitialWorkspaceState, type WorkspaceState } from "../shared/workspace";
import { workspaceConfig } from "../workspace.config";
import { CheckCard } from "./check-card";
import { Investigations, type PendingInvestigationAction } from "./investigations";
import "./styles.css";

function workspaceStatus(status: WorkspaceState["status"]) {
  if (status === "ready") return { label: "Monitoring", variant: "success" as const };
  if (status === "checking") return { label: "Checking now", variant: "neutral" as const };
  if (status === "partial") return { label: "Limited context", variant: "warning" as const };
  if (status === "failed") return { label: "Check failed", variant: "error" as const };
  return { label: "Connecting", variant: "neutral" as const };
}

function relativeDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function MonitorStatus({ workspace }: { workspace: WorkspaceState }) {
  const [now, setNow] = useState(() => Date.now());
  const status = workspaceStatus(workspace.status);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const lastCompletedAt = useMemo(() => {
    const completed = workspace.latestRuns.map((run) => new Date(run.completedAt).getTime());
    return completed.length > 0 ? Math.max(...completed) : undefined;
  }, [workspace.latestRuns]);
  const elapsedSeconds = lastCompletedAt
    ? Math.max(0, Math.floor((now - lastCompletedAt) / 1_000))
    : 0;

  return (
    <StatusBadge dot variant={status.variant}>
      <span className="inline-flex items-baseline gap-1">
        <span className="font-medium">{status.label}</span>
        {lastCompletedAt ? (
          <span className="text-[0.6875rem] font-normal text-current/70">
            · {relativeDuration(elapsedSeconds)} ago
          </span>
        ) : null}
      </span>
    </StatusBadge>
  );
}

function App() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(() =>
    createInitialWorkspaceState(workspaceConfig.checks),
  );
  const [checkError, setCheckError] = useState<string>();
  const [investigationError, setInvestigationError] = useState<string>();
  const [simulating, setSimulating] = useState(false);
  const [pendingInvestigationAction, setPendingInvestigationAction] =
    useState<PendingInvestigationAction>();
  const workspaceAgent = useAgent<WorkspaceState>({
    agent: "workspace-monitor",
    name: workspaceConfig.id,
    onStateUpdate: setWorkspace,
  });
  const workspaceAgentRef = useRef(workspaceAgent);
  useEffect(() => {
    workspaceAgentRef.current = workspaceAgent;
  }, [workspaceAgent]);
  const loadInvestigationTranscript = useCallback(
    (threadId: string) =>
      workspaceAgentRef.current.call<UIMessage[]>("getInvestigationTranscript", [threadId], {
        timeout: 30_000,
      }),
    [],
  );

  async function runCheck() {
    setCheckError(undefined);
    try {
      const nextState = await workspaceAgent.call<WorkspaceState>("reconcile", [], {
        timeout: 60_000,
      });
      setWorkspace(nextState);
    } catch {
      setCheckError("The check could not run. Verify provider access and try again.");
    }
  }

  async function simulateInvestigation() {
    setInvestigationError(undefined);
    setSimulating(true);
    try {
      const nextState = await workspaceAgent.call<WorkspaceState>("simulateInvestigation", [], {
        timeout: 60_000,
      });
      setWorkspace(nextState);
    } catch {
      setInvestigationError("The drill could not start. Verify provider access and try again.");
    } finally {
      setSimulating(false);
    }
  }

  async function retryInvestigation(threadId: string) {
    setInvestigationError(undefined);
    setPendingInvestigationAction({ kind: "retry", threadId });
    try {
      const nextState = await workspaceAgent.call<WorkspaceState>(
        "retryInvestigation",
        [threadId],
        { timeout: 60_000 },
      );
      setWorkspace(nextState);
    } catch {
      setInvestigationError("The investigation could not be retried. Run checks and try again.");
    } finally {
      setPendingInvestigationAction(undefined);
    }
  }

  async function deleteInvestigation(threadId: string) {
    if (!window.confirm("Delete this investigation? This cannot be undone.")) return;
    setInvestigationError(undefined);
    setPendingInvestigationAction({ kind: "delete", threadId });
    try {
      const nextState = await workspaceAgent.call<WorkspaceState>(
        "deleteInvestigation",
        [threadId],
        { timeout: 30_000 },
      );
      setWorkspace(nextState);
    } catch {
      setInvestigationError("The investigation could not be deleted. Try again.");
    } finally {
      setPendingInvestigationAction(undefined);
    }
  }

  return (
    <div className="h-screen w-full bg-[radial-gradient(circle_at_50%_-20%,rgb(255_255_255/0.04),transparent_35rem)] text-foreground">
      <header className="border-b bg-background/90 py-4 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <img
              alt=""
              className="-mr-1.5 size-6 -translate-y-px object-contain"
              src="/tracer-mark.svg"
            />
            <h1 className="text-base font-semibold tracking-tight">Tracer</h1>
            <span aria-hidden="true" className="text-border">
              /
            </span>
            <span className="text-sm text-muted-foreground">ThinkEx Production</span>
          </div>
          <MonitorStatus workspace={workspace} />
        </div>
      </header>

      <main className="h-[calc(100vh-3.5625rem)] overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col gap-10 px-6 py-10 pb-16">
          <CheckCard error={checkError} onRun={() => void runCheck()} workspace={workspace} />

          <Separator />

          <Investigations
            error={investigationError}
            investigations={workspace.investigations}
            loadTranscript={loadInvestigationTranscript}
            onDelete={(threadId) => void deleteInvestigation(threadId)}
            onRetry={(threadId) => void retryInvestigation(threadId)}
            onSimulate={() => void simulateInvestigation()}
            pendingAction={pendingInvestigationAction}
            simulating={simulating}
          />
        </div>
      </main>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");
const rootHost = root as HTMLElement & { __tracerRoot?: Root };
const appRoot = rootHost.__tracerRoot ?? createRoot(rootHost);
rootHost.__tracerRoot = appRoot;
appRoot.render(<App />);
