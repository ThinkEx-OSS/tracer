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

export interface MonitorSummary {
  attempts: number;
  successes: number;
  failures: number;
  successRate: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  latestFailureAt: string | null;
}

export interface EvidenceWindow {
  from: string;
  to: string;
  summary: MonitorSummary;
}

type OperationOutcome =
  | {
      kind: "property";
      event: string;
      property: string;
      success: string[];
      failure: string[];
    }
  | {
      kind: "boolean_property";
      event: string;
      property: string;
    }
  | {
      kind: "events";
      success: string[];
      failure: string[];
    };

export interface NumericCondition {
  property: string;
  greaterThan: number;
}

export type MonitorSignal =
  | {
      kind: "operation";
      outcome: OperationOutcome;
      filters?: Record<string, string | string[]>;
      durationProperty?: string;
    }
  | {
      kind: "session_impact";
      populationEvent: string;
      affected:
        | { kind: "events"; events: string[] }
        | { kind: "numeric"; event: string; any: NumericCondition[] };
    };

export type MonitorDetector =
  | {
      kind: "failure_or_baseline_shift";
      minimumFailures: number;
      absoluteDrop: number;
      minimumFailureRate: number;
      failureMultiplier: number;
    }
  | {
      kind: "baseline_shift";
      absoluteDrop: number;
      minimumFailureRate: number;
      failureMultiplier: number;
    };

export interface MonitorDefinition {
  id: string;
  name: string;
  group: "experience" | "operation";
  signal: MonitorSignal;
  detector: MonitorDetector;
  currentWindowMinutes: number;
  baselineWindowMinutes: number;
  minimumCurrentAttempts: number;
  minimumBaselineAttempts: number;
}

export type CheckRunStatus = "healthy" | "insufficient_data" | "deviation" | "failed";
export type DeviationKind = "latency" | "success_rate";

interface CheckRunBase {
  id: string;
  checkId: string;
  startedAt: string;
  completedAt: string;
  reason: string;
}

interface CheckRunEvidence {
  current: EvidenceWindow;
  baseline: EvidenceWindow;
  cached: boolean;
}

export type CompletedCheckRun = CheckRunBase &
  CheckRunEvidence &
  (
    | { status: "healthy" | "insufficient_data" }
    | { status: "deviation"; deviation: DeviationKind; evidenceKey: string }
  );

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

export type InvestigationKind = "monitor" | "simulation";

/** Durable lifecycle of an investigation dispatched by the workspace monitor. */
export type InvestigationStatus = "investigating" | "reported" | "failed";
export type InvestigationVerdict = "incident" | "no_incident" | "inconclusive";
export type InvestigationConfidence = "low" | "medium" | "high";

/** Check-run ids for simulated investigations are prefixed so their origin is unambiguous. */
export const SIMULATION_RUN_PREFIX = "simulation:";

export interface InvestigationTrigger {
  reason: string;
  attempts?: number;
  failures?: number;
  successRate?: number | null;
  from?: string;
  to?: string;
}

export interface InvestigationSummary {
  kind: InvestigationKind;
  status: InvestigationStatus;
  checkId: string;
  checkRunId: string;
  submittedAt: string;
  threadId: string;
  trigger?: InvestigationTrigger;
  verdict?: InvestigationVerdict;
  confidence?: InvestigationConfidence;
  error?: string;
}

export interface WorkspaceState {
  status: "idle" | "checking" | "ready" | "partial" | "failed";
  checks: MonitorDefinition[];
  latestRuns: CheckRun[];
  history: CheckRunSummary[];
  resource?: Resource;
  deployments: Deployment[];
  changes: Change[];
  investigations: InvestigationSummary[];
  warning?: string;
}

export const createInitialWorkspaceState = (checks: MonitorDefinition[]): WorkspaceState => ({
  status: "idle",
  checks,
  latestRuns: [],
  history: [],
  deployments: [],
  changes: [],
  investigations: [],
});
