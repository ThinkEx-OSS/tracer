import { Agent, callable, type Schedule } from "agents";
import { evaluateOperationCheck } from "../../checks/operation";
import { getCloudflareContext } from "../../providers/cloudflare";
import { providerErrorMessage } from "../../providers/http";
import { queryOperationEvidence } from "../../providers/posthog";
import {
  createInitialWorkspaceState,
  type Change,
  type CheckRun,
  type CheckRunSummary,
  type Deployment,
  type OperationCheck,
  type WorkspaceState,
} from "../../shared/workspace";
import { workspaceConfig } from "../../workspace.config";

const STATE_HISTORY_LIMIT = 24;

interface StoredCheckRun {
  payload: string;
  status: CheckRun["status"];
}

interface StoredChange {
  id: string;
  resource_id: string;
  observed_at: string;
  summary: string;
}

function checkTime(check: OperationCheck) {
  const bucketMs = check.bucketMinutes * 60 * 1_000;
  return new Date(Math.floor(Date.now() / bucketMs) * bucketMs);
}

function parseCheckRun(payload: string): CheckRun {
  const parsed: unknown = JSON.parse(payload);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("id" in parsed) ||
    typeof parsed.id !== "string" ||
    !("status" in parsed) ||
    !["healthy", "insufficient_data", "deviation", "failed"].includes(String(parsed.status))
  ) {
    throw new Error("Stored Check Run is incompatible");
  }
  return parsed as CheckRun;
}

function summarizeRun(run: CheckRun): CheckRunSummary {
  return {
    id: run.id,
    status: run.status,
    completedAt: run.completedAt,
    reason: run.reason,
  };
}

/** Owns reconciliation and durable operational history for one Workspace. */
export class WorkspaceMonitor extends Agent<Cloudflare.Env, WorkspaceState> {
  initialState = createInitialWorkspaceState(workspaceConfig.checks);
  private activeReconciliation?: Promise<WorkspaceState>;

  async onStart() {
    this.ensureSchema();
    this.normalizeState();
    const schedules = await this.listSchedules({ type: "interval" });
    const reconciliationSchedules = schedules.filter(
      (schedule): schedule is Extract<Schedule<unknown>, { type: "interval" }> =>
        schedule.type === "interval" && schedule.callback === "reconcile",
    );
    const currentSchedule = reconciliationSchedules.find(
      (schedule) => schedule.intervalSeconds === workspaceConfig.scheduleIntervalSeconds,
    );
    await Promise.all(
      reconciliationSchedules
        .filter((schedule) => schedule.id !== currentSchedule?.id)
        .map((schedule) => this.cancelSchedule(schedule.id)),
    );
    if (!currentSchedule) {
      await this.scheduleEvery(workspaceConfig.scheduleIntervalSeconds, "reconcile", undefined, {
        retry: { maxAttempts: 2 },
      });
    }
  }

  private normalizeState() {
    const previous = this.state as WorkspaceState & { latestRun?: CheckRun };
    this.setState({
      status: previous.status ?? "idle",
      checks: workspaceConfig.checks,
      latestRuns: Array.isArray(previous.latestRuns)
        ? previous.latestRuns
        : previous.latestRun
          ? [previous.latestRun]
          : [],
      history: Array.isArray(previous.history) ? previous.history : [],
      resource: previous.resource,
      deployments: Array.isArray(previous.deployments) ? previous.deployments : [],
      changes: Array.isArray(previous.changes) ? previous.changes : [],
      warning: previous.warning,
    });
  }

  private ensureSchema() {
    void this.sql`
      CREATE TABLE IF NOT EXISTS check_runs (
        id TEXT PRIMARY KEY,
        check_id TEXT NOT NULL,
        status TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        payload TEXT NOT NULL
      )
    `;
    void this.sql`CREATE INDEX IF NOT EXISTS check_runs_completed ON check_runs(completed_at DESC)`;
    void this.sql`
      CREATE TABLE IF NOT EXISTS workspace_changes (
        id TEXT PRIMARY KEY,
        resource_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        summary TEXT NOT NULL
      )
    `;
    void this
      .sql`CREATE INDEX IF NOT EXISTS workspace_changes_observed ON workspace_changes(observed_at DESC)`;
  }

  private findRun(id: string) {
    return this.sql<StoredCheckRun>`
      SELECT payload, status FROM check_runs WHERE id = ${id} LIMIT 1
    `[0];
  }

  private persistRun(run: CheckRun) {
    void this.sql`
      INSERT INTO check_runs (id, check_id, status, completed_at, payload)
      VALUES (${run.id}, ${run.checkId}, ${run.status}, ${run.completedAt}, ${JSON.stringify(run)})
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        completed_at = excluded.completed_at,
        payload = excluded.payload
    `;
    const cutoff = new Date(
      Date.now() - workspaceConfig.checkRunRetentionDays * 24 * 60 * 60 * 1_000,
    );
    void this.sql`DELETE FROM check_runs WHERE completed_at < ${cutoff.toISOString()}`;
  }

  private loadHistory() {
    return this.sql<StoredCheckRun>`
      SELECT payload, status
      FROM check_runs
      ORDER BY completed_at DESC
      LIMIT ${STATE_HISTORY_LIMIT}
    `.map((row) => summarizeRun(parseCheckRun(row.payload)));
  }

  private recordDeploymentChanges(deployments: Deployment[]) {
    for (const deployment of deployments) {
      void this.sql`
        INSERT OR IGNORE INTO workspace_changes (id, resource_id, kind, observed_at, summary)
        VALUES (
          ${deployment.id},
          ${deployment.resourceId},
          ${"deployment"},
          ${deployment.observedAt},
          ${`Deployment ${deployment.versionIds.join(", ") || deployment.id}`}
        )
      `;
    }
    const cutoff = new Date(
      Date.now() - workspaceConfig.changeRetentionDays * 24 * 60 * 60 * 1_000,
    );
    void this.sql`DELETE FROM workspace_changes WHERE observed_at < ${cutoff.toISOString()}`;
  }

  private loadChanges(): Change[] {
    return this.sql<StoredChange>`
      SELECT id, resource_id, observed_at, summary
      FROM workspace_changes
      ORDER BY observed_at DESC
      LIMIT ${STATE_HISTORY_LIMIT}
    `.map((row) => ({
      id: row.id,
      resourceId: row.resource_id,
      kind: "deployment",
      observedAt: row.observed_at,
      summary: row.summary,
    }));
  }

  @callable()
  async reconcile(): Promise<WorkspaceState> {
    if (this.activeReconciliation) return this.activeReconciliation;

    this.activeReconciliation = this.performReconciliation();
    try {
      return await this.activeReconciliation;
    } finally {
      this.activeReconciliation = undefined;
    }
  }

  private async performReconciliation(): Promise<WorkspaceState> {
    const startedAt = new Date().toISOString();
    this.setState({
      ...this.state,
      status: "checking",
      checks: workspaceConfig.checks,
      warning: undefined,
    });

    const [latestRuns, cloudflareResult] = await Promise.all([
      Promise.all(workspaceConfig.checks.map((check) => this.runCheck(check))),
      getCloudflareContext(
        {
          accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
          apiToken: this.env.CLOUDFLARE_API_TOKEN,
        },
        workspaceConfig.workerName,
      ).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ),
    ]);

    if (cloudflareResult.status === "fulfilled") {
      this.recordDeploymentChanges(cloudflareResult.value.deployments);
    }

    const warning =
      cloudflareResult.status === "rejected"
        ? providerErrorMessage(cloudflareResult.reason, "Cloudflare context refresh failed")
        : undefined;
    const failedChecks = latestRuns.filter((run) => run.status === "failed").length;
    const nextState: WorkspaceState = {
      status:
        failedChecks === latestRuns.length
          ? "failed"
          : failedChecks > 0 || warning
            ? "partial"
            : "ready",
      checks: workspaceConfig.checks,
      latestRuns,
      history: this.loadHistory(),
      resource:
        cloudflareResult.status === "fulfilled"
          ? cloudflareResult.value.resource
          : this.state.resource,
      deployments:
        cloudflareResult.status === "fulfilled"
          ? cloudflareResult.value.deployments
          : this.state.deployments,
      changes: this.loadChanges(),
      warning,
    };

    this.setState(nextState);
    console.log(
      JSON.stringify({
        message: "workspace.reconciliation.completed",
        status: nextState.status,
        durationMs: Date.now() - Date.parse(startedAt),
        checkCount: latestRuns.length,
        failedCheckCount: failedChecks,
        findingCount: latestRuns.filter((run) => run.status === "deviation").length,
        historyCount: nextState.history.length,
        changeCount: nextState.changes.length,
      }),
    );

    return nextState;
  }

  private async runCheck(check: OperationCheck): Promise<CheckRun> {
    const now = checkTime(check);
    const runId = `${check.id}:${now.toISOString()}`;
    const existingRun = this.findRun(runId);
    if (existingRun && existingRun.status !== "failed") {
      return parseCheckRun(existingRun.payload);
    }

    const startedAt = new Date().toISOString();
    let run: CheckRun;
    try {
      const evidence = await queryOperationEvidence(
        {
          host: this.env.POSTHOG_HOST,
          projectId: this.env.POSTHOG_PROJECT_ID,
          personalApiKey: this.env.POSTHOG_PERSONAL_API_KEY,
        },
        check,
        now,
      );
      run = {
        id: runId,
        checkId: check.id,
        ...evaluateOperationCheck(
          check,
          evidence.current.summary,
          evidence.baseline.summary,
          evidence.current.buckets,
        ),
        startedAt,
        completedAt: new Date().toISOString(),
        current: evidence.current,
        baseline: evidence.baseline,
        cached: evidence.cached,
      };
    } catch (error) {
      run = {
        id: runId,
        checkId: check.id,
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        reason: providerErrorMessage(error, `PostHog check ${check.name} failed`),
      };
    }

    this.persistRun(run);
    return run;
  }
}
