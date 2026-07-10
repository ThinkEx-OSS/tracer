import type { OperationCheckConfig } from "./checks/operation";

export const workspaceConfig = {
  id: "thinkex-production",
  workerName: "thinkex",
  check: {
    id: "workspace-file-extraction",
    name: "Workspace file extraction",
    event: "workspace_file_extraction_completed",
    outcomeProperty: "outcome",
    durationProperty: "duration_ms",
    currentWindowMinutes: 5,
    baselineWindowMinutes: 15,
    bucketMinutes: 1,
    minimumCurrentAttempts: 2,
    minimumBaselineAttempts: 1,
    minimumBucketAttempts: 1,
    minimumBreachedBuckets: 2,
    thresholds: {
      successRate: {
        absoluteDrop: 0.1,
        minimumFailureRate: 0.05,
        failureMultiplier: 2,
      },
      p95Duration: {
        absoluteIncreaseMs: 500,
        multiplier: 2,
      },
    },
  } satisfies OperationCheckConfig,
  checkRunRetentionDays: 1,
  changeRetentionDays: 30,
  scheduleIntervalSeconds: 30,
} as const;
