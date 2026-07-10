export interface Resource {
  id: string;
  provider: "cloudflare";
  kind: "worker";
  name: string;
  environment: "production";
  observedAt: string;
  observabilityEnabled: boolean;
}

export interface Deployment {
  id: string;
  resourceId: string;
  observedAt: string;
  source: string;
  versionIds: string[];
}

export interface OperationSummary {
  attempts: number;
  successes: number;
  failures: number;
  successRate: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
}

export interface OperationBucket {
  from: string;
  to: string;
  summary: OperationSummary;
}

export interface EvidenceWindow {
  from: string;
  to: string;
  summary: OperationSummary;
  buckets: OperationBucket[];
}

export interface OperationCheck {
  id: string;
  name: string;
  outcome:
    | {
        kind: "property";
        event: string;
        property: string;
        success: string;
        failure: string;
      }
    | {
        kind: "events";
        success: string;
        failure: string;
      };
  durationProperty?: string;
  currentWindowMinutes: number;
  baselineWindowMinutes: number;
  bucketMinutes: number;
  minimumCurrentAttempts: number;
  minimumBaselineAttempts: number;
  minimumBucketAttempts: number;
  minimumBreachedBuckets: number;
  thresholds: {
    successRate: {
      absoluteDrop: number;
      minimumFailureRate: number;
      failureMultiplier: number;
    };
    p95Duration?: {
      absoluteIncreaseMs: number;
      multiplier: number;
    };
  };
}

export type CheckRunStatus = "healthy" | "insufficient_data" | "deviation" | "failed";

interface CheckRunBase {
  id: string;
  checkId: string;
  startedAt: string;
  completedAt: string;
  reason: string;
}

export interface CompletedCheckRun extends CheckRunBase {
  status: Exclude<CheckRunStatus, "failed">;
  current: EvidenceWindow;
  baseline: EvidenceWindow;
  cached: boolean;
}

export interface FailedCheckRun extends CheckRunBase {
  status: "failed";
}

export type CheckRun = CompletedCheckRun | FailedCheckRun;

export interface CheckRunSummary {
  id: string;
  status: CheckRunStatus;
  completedAt: string;
  reason: string;
}

export interface Change {
  id: string;
  resourceId: string;
  kind: "deployment";
  observedAt: string;
  summary: string;
}

export interface WorkspaceState {
  status: "idle" | "checking" | "ready" | "partial" | "failed";
  checks: OperationCheck[];
  latestRuns: CheckRun[];
  history: CheckRunSummary[];
  resource?: Resource;
  deployments: Deployment[];
  changes: Change[];
  warning?: string;
}

export const createInitialWorkspaceState = (checks: OperationCheck[]): WorkspaceState => ({
  status: "idle",
  checks,
  latestRuns: [],
  history: [],
  deployments: [],
  changes: [],
});
