import type {
  CheckRun,
  CheckRunStatus,
  MonitorDefinition,
  WorkspaceState,
} from "../shared/workspace";
import { StatusBadge, type StatusBadgeVariant } from "./components/status-badge";
import { Button } from "./components/ui/button";
import { Card, CardContent } from "./components/ui/card";
import { Spinner } from "./components/ui/spinner";

function runPresentation(status: CheckRunStatus) {
  if (status === "healthy") return { label: "Healthy", variant: "success" as const };
  if (status === "deviation") return { label: "Change detected", variant: "error" as const };
  if (status === "insufficient_data") {
    return { label: "Waiting for data", variant: "warning" as const };
  }
  return { label: "Check failed", variant: "error" as const };
}

function percent(value: number | null) {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function windowLabel(minutes: number) {
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function impactRate(run?: CheckRun) {
  if (!run || run.status === "failed" || run.current.summary.successRate === null) return null;
  return 1 - run.current.summary.successRate;
}

function baselineImpactRate(run?: CheckRun) {
  if (!run || run.status === "failed" || run.baseline.summary.successRate === null) return null;
  return 1 - run.baseline.summary.successRate;
}

function barWidth(value: number | null) {
  if (value === null || value <= 0) return "0%";
  return `${Math.max(value * 100, 2)}%`;
}

function impactNoun(check: MonitorDefinition) {
  return check.signal.kind === "session_impact" ? "affected sessions" : "failed runs";
}

function currentBarClass(variant: StatusBadgeVariant) {
  if (variant === "error") return "bg-red-400";
  if (variant === "warning") return "bg-amber-400";
  return "bg-emerald-400";
}

function ImpactComparison({
  check,
  run,
  variant,
}: {
  check: MonitorDefinition;
  run?: CheckRun;
  variant: StatusBadgeVariant;
}) {
  const current = impactRate(run);
  const baseline = baselineImpactRate(run);
  const noun = impactNoun(check);

  if (current === null) {
    return <span className="text-xs text-muted-foreground">Impact rate unavailable</span>;
  }

  return (
    <div
      aria-label={`Impact rate: ${percent(current)} ${noun} in the current window.${baseline === null ? " Baseline unavailable." : ` ${percent(baseline)} in the baseline window.`}`}
      className="grid min-w-44 gap-1.5"
    >
      <div className="flex items-center justify-between gap-3 text-xs tabular-nums">
        <span className="text-muted-foreground">Current window</span>
        <strong>{percent(current)}</strong>
      </div>
      <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${currentBarClass(variant)}`}
          style={{ width: barWidth(current) }}
        />
      </div>
      {baseline === null ? (
        <span className="text-xs text-muted-foreground">Baseline unavailable</span>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 text-xs tabular-nums text-muted-foreground">
            <span>Baseline window</span>
            <span>{percent(baseline)}</span>
          </div>
          <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-muted-foreground/60"
              style={{ width: barWidth(baseline) }}
            />
          </div>
        </>
      )}
    </div>
  );
}

function MonitorRow({ check, workspace }: { check: MonitorDefinition; workspace: WorkspaceState }) {
  const run = workspace.latestRuns.find((candidate) => candidate.checkId === check.id);
  const presentation = run
    ? runPresentation(run.status)
    : { label: "Waiting for data", variant: "warning" as const };
  const detail = run?.status === "failed" ? "This check did not complete." : run?.reason;
  const updated =
    run && run.status !== "failed" ? new Date(run.completedAt).toLocaleString() : undefined;

  return (
    <li className="grid gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_11rem] lg:items-center">
      <div className="grid min-w-0 gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <strong className="text-sm font-medium">{check.name}</strong>
          <StatusBadge variant={presentation.variant}>{presentation.label}</StatusBadge>
        </div>
        <span className="text-xs leading-5 text-muted-foreground">
          {detail ?? "Waiting for the first check."}
        </span>
        {updated ? (
          <span className="text-xs text-muted-foreground">
            Updated {updated} · {windowLabel(check.currentWindowMinutes)} vs{" "}
            {windowLabel(check.baselineWindowMinutes)}
          </span>
        ) : null}
      </div>
      <ImpactComparison check={check} run={run} variant={presentation.variant} />
    </li>
  );
}

function monitorSummary(workspace: WorkspaceState) {
  const latestRuns = workspace.checks.map((check) =>
    workspace.latestRuns.find((candidate) => candidate.checkId === check.id),
  );
  const attention = latestRuns.filter(
    (run) => run?.status === "deviation" || run?.status === "failed",
  ).length;
  const waiting = latestRuns.filter((run) => !run || run.status === "insufficient_data").length;
  return { attention, waiting };
}

export function CheckCard({
  workspace,
  error,
  onRun,
}: {
  workspace: WorkspaceState;
  error?: string;
  onRun: () => void;
}) {
  const checking = workspace.status === "checking";
  const summary = monitorSummary(workspace);

  return (
    <section aria-label="Production monitors" className="grid gap-4">
      <div className="flex items-center justify-between gap-4 max-sm:flex-col max-sm:items-start">
        <div className="grid min-w-0 gap-1">
          <h2 className="text-base font-semibold tracking-tight">Monitors</h2>
          <p className="text-sm text-muted-foreground">
            {summary.attention > 0
              ? `${summary.attention} signal${summary.attention === 1 ? "" : "s"} needs attention`
              : "No monitor needs attention"}
            {summary.waiting > 0 ? ` · ${summary.waiting} waiting for data` : ""}
          </p>
        </div>
        <Button className="max-sm:w-full" disabled={checking} onClick={onRun} variant="outline">
          {checking ? <Spinner data-icon="inline-start" /> : null}
          {checking ? "Running checks" : "Run checks"}
        </Button>
      </div>

      <Card className="gap-0 bg-card/60 py-0 shadow-none">
        <CardContent className="p-0">
          <ul className="divide-y" aria-label="Monitor status and impact">
            {workspace.checks.map((check) => (
              <MonitorRow check={check} key={check.id} workspace={workspace} />
            ))}
          </ul>
        </CardContent>
      </Card>
      {workspace.warning ? <p className="text-sm text-amber-400">{workspace.warning}</p> : null}
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
    </section>
  );
}
