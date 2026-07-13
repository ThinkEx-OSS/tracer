import type { MonitorDefinition } from "./shared/workspace";

const operationDetector = (minimumFailures: number) =>
  ({
    kind: "failure_or_baseline_shift",
    minimumFailures,
    absoluteDrop: 0.1,
    minimumFailureRate: 0.05,
    failureMultiplier: 2,
  }) as const;

const experienceDetector = {
  kind: "baseline_shift",
  absoluteDrop: 0.1,
  minimumFailureRate: 0.1,
  failureMultiplier: 1.5,
} as const;

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
      id: "experience-user-frustration",
      name: "User frustration",
      group: "experience",
      signal: {
        kind: "session_impact",
        populationEvent: "$pageview",
        affected: { kind: "events", events: ["$rageclick", "$dead_click"] },
      },
      detector: experienceDetector,
      currentWindowMinutes: 1_440,
      baselineWindowMinutes: 20_160,
      minimumCurrentAttempts: 5,
      minimumBaselineAttempts: 30,
    },
    {
      id: "experience-frontend-reliability",
      name: "Frontend reliability",
      group: "experience",
      signal: {
        kind: "session_impact",
        populationEvent: "$pageview",
        affected: { kind: "events", events: ["$exception", "$csp_violation"] },
      },
      detector: experienceDetector,
      currentWindowMinutes: 1_440,
      baselineWindowMinutes: 20_160,
      minimumCurrentAttempts: 5,
      minimumBaselineAttempts: 30,
    },
    {
      id: "experience-web-performance",
      name: "Web performance",
      group: "experience",
      signal: {
        kind: "session_impact",
        populationEvent: "$pageview",
        affected: {
          kind: "numeric",
          event: "$web_vitals",
          any: [
            { property: "$web_vitals_LCP_value", greaterThan: 4_000 },
            { property: "$web_vitals_INP_value", greaterThan: 500 },
            { property: "$web_vitals_CLS_value", greaterThan: 0.25 },
          ],
        },
      },
      detector: experienceDetector,
      currentWindowMinutes: 1_440,
      baselineWindowMinutes: 20_160,
      minimumCurrentAttempts: 5,
      minimumBaselineAttempts: 30,
    },
    {
      id: "workspace-file-extraction",
      name: "File extraction",
      group: "operation",
      signal: {
        kind: "operation",
        outcome: {
          kind: "property",
          event: "workspace_file_extraction_completed",
          property: "outcome",
          success: ["success"],
          failure: ["partial", "error"],
        },
        durationProperty: "duration_ms",
      },
      detector: operationDetector(1),
      currentWindowMinutes: 4_320,
      baselineWindowMinutes: 40_320,
      minimumCurrentAttempts: 1,
      minimumBaselineAttempts: 3,
    },
    {
      id: "workspace-ai-turns",
      name: "AI turns",
      group: "operation",
      signal: {
        kind: "operation",
        outcome: {
          kind: "events",
          success: ["ai_turn_completed"],
          failure: ["ai_turn_failed"],
        },
      },
      detector: operationDetector(1),
      currentWindowMinutes: 360,
      baselineWindowMinutes: 10_080,
      minimumCurrentAttempts: 1,
      minimumBaselineAttempts: 20,
    },
    {
      id: "workspace-file-intake",
      name: "File intake",
      group: "operation",
      signal: {
        kind: "operation",
        outcome: {
          kind: "property",
          event: "workspace_file_intake_completed",
          property: "outcome",
          success: ["success"],
          failure: ["error"],
        },
        durationProperty: "duration_ms",
      },
      detector: operationDetector(1),
      currentWindowMinutes: 1_440,
      baselineWindowMinutes: 20_160,
      minimumCurrentAttempts: 1,
      minimumBaselineAttempts: 3,
    },
    {
      id: "workspace-ai-tools",
      name: "AI tools",
      group: "operation",
      signal: {
        kind: "operation",
        outcome: {
          kind: "boolean_property",
          event: "ai_tool_invoked",
          property: "success",
        },
        durationProperty: "duration_ms",
      },
      detector: operationDetector(2),
      currentWindowMinutes: 1_440,
      baselineWindowMinutes: 20_160,
      minimumCurrentAttempts: 1,
      minimumBaselineAttempts: 20,
    },
  ] satisfies MonitorDefinition[],
  checkRunRetentionDays: 7,
  changeRetentionDays: 30,
  scheduleIntervalSeconds: 60,
} as const;
