import type {
  CheckRunStatus,
  DeviationKind,
  OperationBucket,
  OperationCheck,
  OperationSummary,
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
    };

function deviation(
  check: OperationCheck,
  current: OperationSummary,
  baseline: OperationSummary,
): DeviationKind | undefined {
  if (current.successRate !== null && baseline.successRate !== null) {
    const failureRate = 1 - current.successRate;
    const baselineFailureRate = 1 - baseline.successRate;
    const failureMultiplier =
      baselineFailureRate > 0 ? failureRate / baselineFailureRate : Infinity;

    if (
      baseline.successRate - current.successRate >= check.thresholds.successRate.absoluteDrop &&
      failureRate >= check.thresholds.successRate.minimumFailureRate &&
      failureMultiplier >= check.thresholds.successRate.failureMultiplier
    ) {
      return "success_rate";
    }
  }

  if (
    check.thresholds.p95Duration &&
    current.p95DurationMs !== null &&
    baseline.p95DurationMs !== null
  ) {
    if (
      current.p95DurationMs - baseline.p95DurationMs >=
        check.thresholds.p95Duration.absoluteIncreaseMs &&
      current.p95DurationMs >= baseline.p95DurationMs * check.thresholds.p95Duration.multiplier
    ) {
      return "latency";
    }
  }
}

function longestPersistentDeviation(
  check: OperationCheck,
  buckets: OperationBucket[],
  baseline: OperationSummary,
  kind: DeviationKind,
) {
  let longest = 0;
  let current = 0;
  let previousTo: string | undefined;

  for (const bucket of buckets) {
    const adjacent = previousTo === bucket.from;
    const breached =
      bucket.summary.attempts >= check.minimumBucketAttempts &&
      deviation(check, bucket.summary, baseline) === kind;
    current = breached ? (adjacent ? current + 1 : 1) : 0;
    longest = Math.max(longest, current);
    previousTo = bucket.to;
  }

  return longest;
}

export function evaluateOperationCheck(
  check: OperationCheck,
  current: OperationSummary,
  baseline: OperationSummary,
  currentBuckets: OperationBucket[],
): CheckEvaluation {
  if (current.attempts < check.minimumCurrentAttempts) {
    return {
      status: "insufficient_data",
      reason: `The last ${check.currentWindowMinutes} minutes include ${current.attempts} completed operations; ${check.minimumCurrentAttempts} are required.`,
    };
  }

  if (baseline.attempts < check.minimumBaselineAttempts) {
    return {
      status: "insufficient_data",
      reason: `The previous ${check.baselineWindowMinutes} minutes include ${baseline.attempts} completed operations; ${check.minimumBaselineAttempts} are required.`,
    };
  }

  const successRateBuckets = longestPersistentDeviation(
    check,
    currentBuckets,
    baseline,
    "success_rate",
  );
  const latencyBuckets = longestPersistentDeviation(check, currentBuckets, baseline, "latency");
  const kind = successRateBuckets >= latencyBuckets ? "success_rate" : "latency";
  const persistentBuckets = Math.max(successRateBuckets, latencyBuckets);
  if (persistentBuckets < check.minimumBreachedBuckets) {
    return {
      status: "healthy",
      reason:
        persistentBuckets === 0
          ? "The operation remains within its previous range."
          : `The deviation persisted for ${persistentBuckets} of ${check.minimumBreachedBuckets} required buckets.`,
    };
  }

  if (kind === "success_rate") {
    return {
      status: "deviation",
      deviation: kind,
      reason: `Success rate was materially lower than the previous window for ${persistentBuckets} consecutive ${check.bucketMinutes}-minute periods.`,
    };
  }

  return {
    status: "deviation",
    deviation: kind,
    reason: `P95 duration was materially higher than the previous window for ${persistentBuckets} consecutive ${check.bucketMinutes}-minute periods.`,
  };
}
