import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Text } from "@cloudflare/kumo/components/text";
import type { CheckRunStatus, WorkspaceState } from "../shared/workspace";
import { workspaceConfig } from "../workspace.config";

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

export function CheckCard({
  workspace,
  error,
  onRun,
}: {
  workspace: WorkspaceState;
  error?: string;
  onRun: () => void;
}) {
  const run = workspace.latestRun;
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
          {
            label: "P95 duration",
            current: duration(run.current.summary.p95DurationMs),
            baseline: duration(run.baseline.summary.p95DurationMs),
          },
          {
            label: "Completed operations",
            current: run.current.summary.attempts.toLocaleString(),
            baseline: run.baseline.summary.attempts.toLocaleString(),
          },
        ];

  return (
    <section aria-labelledby="check-title" className="check-card border-kumo-hairline bg-kumo-base">
      <div className="check-heading">
        <div>
          <Text as="h2" id="check-title" variant="heading2">
            {workspace.check.name}
          </Text>
          <Text variant="secondary">
            Live user-impact telemetry from PostHog with Cloudflare deployment context.
          </Text>
        </div>
        <Button loading={workspace.status === "checking"} onClick={onRun} variant="secondary">
          Run check
        </Button>
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
              <Text variant="secondary">Previous window {metric.baseline}</Text>
            </div>
          ))}
        </div>
      ) : null}

      {run && run.status !== "failed" ? (
        <Text variant="secondary">
          Updated {new Date(run.completedAt).toLocaleString()} · last{" "}
          {workspaceConfig.check.currentWindowMinutes} min compared with the previous{" "}
          {workspaceConfig.check.baselineWindowMinutes} min
        </Text>
      ) : null}
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
