import { Badge } from "@cloudflare/kumo/components/badge";
import { Text } from "@cloudflare/kumo/components/text";
import { useAgent } from "agents/react";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createInitialWorkspaceState, type WorkspaceState } from "../shared/workspace";
import { workspaceConfig } from "../workspace.config";
import { CheckCard } from "./check-card";
import { Investigations } from "./investigations";
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
    <Badge appearance="dot" variant={status.variant}>
      <span className="monitor-status">
        <span className="monitor-status-label">{status.label}</span>
        {lastCompletedAt ? (
          <span className="monitor-status-time">· {relativeDuration(elapsedSeconds)} ago</span>
        ) : null}
      </span>
    </Badge>
  );
}

function App() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(() =>
    createInitialWorkspaceState(workspaceConfig.checks),
  );
  const [checkError, setCheckError] = useState<string>();
  const [simulationError, setSimulationError] = useState<string>();
  const [simulating, setSimulating] = useState(false);
  const workspaceAgent = useAgent<WorkspaceState>({
    agent: "workspace-monitor",
    name: workspaceConfig.id,
    onStateUpdate: setWorkspace,
  });

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
    setSimulationError(undefined);
    setSimulating(true);
    try {
      const nextState = await workspaceAgent.call<WorkspaceState>("simulateInvestigation", [], {
        timeout: 60_000,
      });
      setWorkspace(nextState);
    } catch {
      setSimulationError("The drill could not start. Verify provider access and try again.");
    } finally {
      setSimulating(false);
    }
  }

  return (
    <div className="app-shell bg-kumo-canvas text-kumo-default">
      <header className="topbar border-kumo-hairline">
        <div className="content-width topbar-content">
          <div className="brand-path">
            <img alt="" className="brand-mark" src="/tracer-mark.svg" />
            <Text variant="heading3" as="h1">
              Tracer
            </Text>
            <span aria-hidden="true">/</span>
            <Text variant="secondary">ThinkEx Production</Text>
          </div>
          <MonitorStatus workspace={workspace} />
        </div>
      </header>

      <main className="transcript">
        <div className="content-width workspace-content">
          <CheckCard error={checkError} onRun={() => void runCheck()} workspace={workspace} />

          <Investigations
            error={simulationError}
            investigations={workspace.investigations}
            onSimulate={() => void simulateInvestigation()}
            simulating={simulating}
          />
        </div>
      </main>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");
const appRoot = createRoot(root);
appRoot.render(<App />);

if (import.meta.hot) {
  import.meta.hot.dispose(() => appRoot.unmount());
}
