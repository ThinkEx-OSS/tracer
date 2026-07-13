import type {
  CheckRunStatus,
  DeviationKind,
  MonitorDefinition,
  MonitorSummary,
} from "../shared/workspace";

export type CheckEvaluation =
  | {
      status: Exclude<CheckRunStatus, "deviation" | "failed">;
      reason: string;
    }
  | {
      status: "deviation";
      reason: string;
      deviation: DeviationKind;
      evidenceKey: string;
    };

function rateDeviation(
  monitor: MonitorDefinition,
  current: MonitorSummary,
  baseline: MonitorSummary,
) {
  if (current.successRate === null || baseline.successRate === null) return false;

  const failureRate = 1 - current.successRate;
  const baselineFailureRate = 1 - baseline.successRate;
  const failureMultiplier = baselineFailureRate > 0 ? failureRate / baselineFailureRate : Infinity;
  const detector = monitor.detector;

  return (
    baseline.successRate - current.successRate >= detector.absoluteDrop &&
    failureRate >= detector.minimumFailureRate &&
    failureMultiplier >= detector.failureMultiplier
  );
}

function evidenceKey(monitor: MonitorDefinition, current: MonitorSummary) {
  if (!current.latestFailureAt) {
    throw new Error(`Monitor ${monitor.id} reported impact without an event timestamp`);
  }
  return `${monitor.id}:impact:${current.latestFailureAt}`;
}

function impactLabel(monitor: MonitorDefinition) {
  return monitor.signal.kind === "session_impact" ? "affected sessions" : "failures";
}

export function evaluateMonitor(
  monitor: MonitorDefinition,
  current: MonitorSummary,
  baseline: MonitorSummary,
): CheckEvaluation {
  const immediateFailureThreshold =
    monitor.detector.kind === "failure_or_baseline_shift"
      ? monitor.detector.minimumFailures
      : undefined;

  if (immediateFailureThreshold !== undefined && current.failures >= immediateFailureThreshold) {
    return {
      status: "deviation",
      deviation: "success_rate",
      evidenceKey: evidenceKey(monitor, current),
      reason: `Observed ${current.failures} ${impactLabel(monitor)} in the current window.`,
    };
  }

  if (current.attempts < monitor.minimumCurrentAttempts) {
    return {
      status: "insufficient_data",
      reason: `Waiting for activity (${current.attempts} of ${monitor.minimumCurrentAttempts} observed).`,
    };
  }

  if (baseline.attempts < monitor.minimumBaselineAttempts) {
    return {
      status: "insufficient_data",
      reason: `Building a baseline (${baseline.attempts} of ${monitor.minimumBaselineAttempts} observed).`,
    };
  }

  if (rateDeviation(monitor, current, baseline)) {
    return {
      status: "deviation",
      deviation: "success_rate",
      evidenceKey: evidenceKey(monitor, current),
      reason:
        monitor.signal.kind === "session_impact"
          ? "A materially larger share of sessions was affected."
          : "Success rate was materially lower than the previous window.",
    };
  }

  return {
    status: "healthy",
    reason:
      monitor.signal.kind === "session_impact"
        ? "User impact remains within its previous range."
        : "The operation remains within its previous range.",
  };
}
