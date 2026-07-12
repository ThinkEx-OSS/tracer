import type { OperationCheck } from "./shared/workspace";

const standardCheckPolicy = {
  currentWindowMinutes: 15,
  baselineWindowMinutes: 1_440,
  bucketMinutes: 1,
  minimumBucketAttempts: 1,
  minimumBreachedBuckets: 1,
  thresholds: {
    successRate: {
      absoluteDrop: 0.1,
      minimumFailureRate: 0.05,
      failureMultiplier: 2,
    },
  },
} satisfies Pick<
  OperationCheck,
  | "currentWindowMinutes"
  | "baselineWindowMinutes"
  | "bucketMinutes"
  | "minimumBucketAttempts"
  | "minimumBreachedBuckets"
  | "thresholds"
>;

export const workspaceConfig = {
  id: "thinkex-production",
  workerName: "thinkex",
  repositories: [
    {
      url: "https://github.com/ThinkEx-OSS/thinkex.git",
      role: "application source",
      baseBranch: "main",
    },
  ],
  checks: [
    {
      id: "workspace-file-extraction",
      name: "File extraction",
      outcome: {
        kind: "property",
        event: "workspace_file_extraction_completed",
        property: "outcome",
        success: ["success"],
        failure: ["error"],
      },
      durationProperty: "duration_ms",
      ...standardCheckPolicy,
      minimumCurrentAttempts: 1,
      minimumBaselineAttempts: 3,
    },
    {
      id: "workspace-ai-turns",
      name: "AI turns",
      outcome: {
        kind: "events",
        success: ["ai_turn_completed"],
        failure: ["ai_turn_failed"],
      },
      ...standardCheckPolicy,
      minimumCurrentAttempts: 2,
      minimumBaselineAttempts: 20,
    },
    {
      id: "workspace-file-intake",
      name: "File intake",
      outcome: {
        kind: "property",
        event: "workspace_file_intake_completed",
        property: "outcome",
        success: ["success"],
        failure: ["rejected", "error"],
      },
      durationProperty: "duration_ms",
      ...standardCheckPolicy,
      minimumCurrentAttempts: 1,
      minimumBaselineAttempts: 3,
    },
    {
      id: "workspace-ai-tools",
      name: "AI tools",
      outcome: {
        kind: "property",
        event: "ai_tool_invoked",
        property: "outcome",
        success: ["success"],
        failure: ["partial", "error"],
      },
      durationProperty: "duration_ms",
      ...standardCheckPolicy,
      minimumCurrentAttempts: 2,
      minimumBaselineAttempts: 20,
    },
  ] satisfies OperationCheck[],
  checkRunRetentionDays: 7,
  changeRetentionDays: 30,
  scheduleIntervalSeconds: 60,
} as const;
