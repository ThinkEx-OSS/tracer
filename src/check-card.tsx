import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Text } from "@cloudflare/kumo/components/text";
import type { CheckRunStatus, OperationCheck, WorkspaceState } from "../shared/workspace";

function runPresentation(status: CheckRunStatus) {
  if (status === "healthy") return { label: "Healthy", variant: "success" as const };
  if (status === "deviation") return { label: "Change detected", variant: "error" as const };
  if (status === "insufficient_data") {
    return { label: "Not enough data", variant: "warning" as const };
  }
  return { label: "Check failed", variant: "error" as const };
}

function percent(value: number | null) {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function duration(value: number | null) {
  return value === null ? "—" : `${Math.round(value).toLocaleString()}ms`;
}

function windowLabel(minutes: number) {
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function OperationCard({ check, workspace }: { check: OperationCheck; workspace: WorkspaceState }) {
  const run = workspace.latestRuns.find((candidate) => candidate.checkId === check.id);
  const presentation = runPresentation(run?.status ?? "failed");
  const metrics =
    !run || run.status === "failed"
      ? []
      : [
          {
            label: "Success rate",
            current: percent(run.current.summary.successRate),
            baseline: percent(run.baseline.summary.successRate),
          },
          ...(run.current.summary.p95DurationMs !== null ||
          run.baseline.summary.p95DurationMs !== null
            ? [
                {
                  label: "P95 duration",
                  current: duration(run.current.summary.p95DurationMs),
                  baseline: duration(run.baseline.summary.p95DurationMs),
                },
              ]
            : []),
          {
            label: "Completed operations",
            current: run.current.summary.attempts.toLocaleString(),
            baseline: run.baseline.summary.attempts.toLocaleString(),
          },
        ];

  return (
    <div className="operation-check border-kumo-hairline">
      <div className="check-heading">
        <Text as="h2" variant="heading2">
          {check.name}
        </Text>
      </div>
      {!run ? (
        <Text variant="secondary">No data checked yet.</Text>
      ) : (
        <div className="check-summary">
          <Badge appearance="dot" variant={presentation.variant}>
            {presentation.label}
          </Badge>
          <Text>{run.reason}</Text>
        </div>
      )}
      {metrics.length > 0 ? (
        <div className="metrics">
          {metrics.map((metric) => (
            <div className="metric" key={metric.label}>
              <Text variant="secondary">{metric.label}</Text>
              <Text as="strong" variant="heading2">
                {metric.current}
              </Text>
              <Text variant="secondary">Baseline {metric.baseline}</Text>
            </div>
          ))}
        </div>
      ) : null}
      {run && run.status !== "failed" ? (
        <Text variant="secondary">
          Updated {new Date(run.completedAt).toLocaleString()} · current{" "}
          {windowLabel(check.currentWindowMinutes)} · baseline{" "}
          {windowLabel(check.baselineWindowMinutes)}
        </Text>
      ) : null}
    </div>
  );
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
  return (
    <section aria-labelledby="check-title" className="check-card border-kumo-hairline bg-kumo-base">
      <div className="check-heading">
        <div>
          <Text as="h2" id="check-title" variant="heading2">
            Production monitors
          </Text>
          <Text variant="secondary">
            Live user-impact telemetry from PostHog with Cloudflare deployment context.
          </Text>
        </div>
        <Button loading={workspace.status === "checking"} onClick={onRun} variant="secondary">
          Run check
        </Button>
      </div>

      {workspace.checks.map((check) => (
        <OperationCard check={check} key={check.id} workspace={workspace} />
      ))}
      {workspace.resource ? (
        <Text variant="secondary">
          Cloudflare · {workspace.resource.name} · {workspace.deployments.length} deployments synced
        </Text>
      ) : null}
      {workspace.warning ? <Text variant="secondary">{workspace.warning}</Text> : null}
      {error ? <Text variant="secondary">{error}</Text> : null}
    </section>
  );
}
