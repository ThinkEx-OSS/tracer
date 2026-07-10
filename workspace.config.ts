import type { OperationCheck } from "./shared/workspace";

export const workspaceConfig = {
  id: "thinkex-production",
  workerName: "thinkex",
  checks: [
    {
      id: "workspace-file-extraction",
      name: "Workspace file extraction",
      outcome: {
        kind: "property",
        event: "workspace_file_extraction_completed",
        property: "outcome",
        success: "success",
        failure: "error",
      },
      durationProperty: "duration_ms",
      currentWindowMinutes: 15,
      baselineWindowMinutes: 1_440,
      bucketMinutes: 1,
      minimumCurrentAttempts: 1,
      minimumBaselineAttempts: 3,
      minimumBucketAttempts: 1,
      minimumBreachedBuckets: 1,
      thresholds: {
        successRate: {
          absoluteDrop: 0.1,
          minimumFailureRate: 0.05,
          failureMultiplier: 2,
        },
      },
    },
    {
      id: "workspace-ai-turns",
      name: "Workspace AI turns",
      outcome: {
        kind: "events",
        success: "ai_turn_completed",
        failure: "ai_turn_failed",
      },
      currentWindowMinutes: 15,
      baselineWindowMinutes: 1_440,
      bucketMinutes: 1,
      minimumCurrentAttempts: 2,
      minimumBaselineAttempts: 20,
      minimumBucketAttempts: 1,
      minimumBreachedBuckets: 1,
      thresholds: {
        successRate: {
          absoluteDrop: 0.1,
          minimumFailureRate: 0.05,
          failureMultiplier: 2,
        },
      },
    },
  ] satisfies OperationCheck[],
  checkRunRetentionDays: 7,
  changeRetentionDays: 30,
  scheduleIntervalSeconds: 30,
} as const;
