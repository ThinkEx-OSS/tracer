import { Agent, callable, getAgentByName, type Schedule } from "agents";
import { evaluateOperationCheck } from "../../checks/operation";
import { configuredRepositoryPath } from "../../investigation/sandbox";
import { getCloudflareContext } from "../../providers/cloudflare";
import { providerErrorMessage } from "../../providers/http";
import { queryOperationEvidence } from "../../providers/posthog";
import {
  createInitialWorkspaceState,
  type Change,
  type CheckRun,
  type CheckRunSummary,
  type Deployment,
  type InvestigationConfidence,
  type InvestigationStatus,
  type InvestigationSummary,
  type InvestigationVerdict,
  type OperationCheck,
  SIMULATION_RUN_PREFIX,
  type WorkspaceState,
} from "../../shared/workspace";
import { workspaceConfig } from "../../workspace.config";

const STATE_HISTORY_LIMIT = 24;
const INVESTIGATION_COOLDOWN_MS = 30 * 60 * 1_000;

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

interface StoredInvestigationSubmission {
  check_id: string;
  check_run_id: string;
  submitted_at: string;
  thread_id: string;
  status: InvestigationStatus | null;
  verdict: InvestigationVerdict | null;
  confidence: InvestigationConfidence | null;
  error_message: string | null;
}

function checkTime(check: OperationCheck) {
  const bucketMs = check.bucketMinutes * 60 * 1_000;
  return new Date(Math.floor(Date.now() / bucketMs) * bucketMs);
}

function investigationThreadId() {
  return `${workspaceConfig.id}--investigation--${crypto.randomUUID()}`;
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
    const previous = this.state as WorkspaceState & {
      latestRun?: CheckRun;
      activeInvestigation?: InvestigationSummary;
    };
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
      investigations: Array.isArray(previous.investigations)
        ? previous.investigations
        : previous.activeInvestigation
          ? [previous.activeInvestigation]
          : [],
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
    void this.sql`
      CREATE TABLE IF NOT EXISTS investigation_submissions (
        check_run_id TEXT PRIMARY KEY,
        check_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'investigating',
        verdict TEXT,
        confidence TEXT,
        error_message TEXT,
        updated_at TEXT
      )
    `;
    // Backfill status columns for databases created before status tracking.
    const columns = this.sql<{
      name: string;
    }>`PRAGMA table_info(investigation_submissions)`.map((row) => row.name);
    if (!columns.includes("status")) {
      void this
        .sql`ALTER TABLE investigation_submissions ADD COLUMN status TEXT NOT NULL DEFAULT 'investigating'`;
    }
    if (!columns.includes("verdict")) {
      void this.sql`ALTER TABLE investigation_submissions ADD COLUMN verdict TEXT`;
    }
    if (!columns.includes("confidence")) {
      void this.sql`ALTER TABLE investigation_submissions ADD COLUMN confidence TEXT`;
    }
    if (!columns.includes("updated_at")) {
      void this.sql`ALTER TABLE investigation_submissions ADD COLUMN updated_at TEXT`;
    }
    if (!columns.includes("error_message")) {
      void this.sql`ALTER TABLE investigation_submissions ADD COLUMN error_message TEXT`;
    }
    void this
      .sql`CREATE INDEX IF NOT EXISTS investigation_submissions_submitted ON investigation_submissions(submitted_at DESC)`;
    void this
      .sql`CREATE INDEX IF NOT EXISTS investigation_submissions_thread_submitted ON investigation_submissions(thread_id, submitted_at DESC)`;
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
    void this
      .sql`DELETE FROM investigation_submissions WHERE submitted_at < ${cutoff.toISOString()}`;
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

  private loadInvestigations(): InvestigationSummary[] {
    const rows = this.sql<StoredInvestigationSubmission>`
      SELECT check_run_id, check_id, thread_id, submitted_at, status, verdict, confidence, error_message
      FROM investigation_submissions
      ORDER BY submitted_at DESC
      LIMIT ${STATE_HISTORY_LIMIT}
    `;
    return rows.map((row) => ({
      kind: row.check_run_id.startsWith(SIMULATION_RUN_PREFIX) ? "simulation" : "monitor",
      status: row.status ?? "investigating",
      checkId: row.check_id,
      checkRunId: row.check_run_id,
      submittedAt: row.submitted_at,
      threadId: row.thread_id,
      verdict: row.verdict ?? undefined,
      confidence: row.confidence ?? undefined,
      error: row.error_message ?? undefined,
    }));
  }

  private updateInvestigationStatus(input: {
    threadId: string;
    status: InvestigationStatus;
    verdict?: InvestigationVerdict;
    confidence?: InvestigationConfidence;
    error?: string;
  }) {
    const updated = this.sql<{ thread_id: string }>`
      UPDATE investigation_submissions
      SET status = ${input.status},
          verdict = ${input.verdict ?? null},
          confidence = ${input.confidence ?? null},
          error_message = ${input.error ?? null},
          updated_at = ${new Date().toISOString()}
      WHERE thread_id = ${input.threadId}
      RETURNING thread_id
    `;
    if (updated.length === 0) {
      throw new Error(`Investigation ${input.threadId} was not found`);
    }
    this.setState({ ...this.state, investigations: this.loadInvestigations() });
  }

  /**
   * Called back by an Incident Thread when it submits its report, so a
   * collapsed investigation row can show its verdict without opening a live
   * connection to the thread.
   */
  async recordInvestigationStatus(input: {
    threadId: string;
    status: InvestigationStatus;
    verdict?: InvestigationVerdict;
    confidence?: InvestigationConfidence;
  }): Promise<void> {
    this.updateInvestigationStatus(input);
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

  /**
   * Starts a synthetic investigation to exercise the full pipeline end to end
   * (clone repo, investigate, write a report, open a draft PR) without waiting
   * for a real deviation. For testing the investigation path only.
   */
  @callable()
  async simulateInvestigation(): Promise<WorkspaceState> {
    const runId = `${SIMULATION_RUN_PREFIX}${new Date().toISOString()}`;
    const checkId = workspaceConfig.checks[0]?.id ?? "simulation";

    this.dispatchInvestigation({
      checkId,
      checkRunId: runId,
      prompt: buildSimulationBriefing(),
      threadId: investigationThreadId(),
    });
    return this.state;
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

    const cloudflareWarning =
      cloudflareResult.status === "rejected"
        ? providerErrorMessage(cloudflareResult.reason, "Cloudflare context refresh failed")
        : undefined;
    const failedChecks = latestRuns.filter((run) => run.status === "failed").length;
    const changes = this.loadChanges();
    let investigationWarning: string | undefined;
    for (const run of latestRuns) {
      try {
        this.submitInvestigation(run, changes);
      } catch (error) {
        investigationWarning = providerErrorMessage(error, "Investigation handoff failed");
      }
    }
    const warning =
      [cloudflareWarning, investigationWarning].filter(Boolean).join(" ") || undefined;
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
      changes,
      investigations: this.loadInvestigations(),
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

  private submitInvestigation(run: CheckRun, changes: Change[]): void {
    if (
      run.status !== "deviation" ||
      !("deviation" in run) ||
      !["latency", "success_rate"].includes(run.deviation)
    ) {
      return;
    }

    const existing = this.sql`
      SELECT check_run_id FROM investigation_submissions WHERE check_run_id = ${run.id} LIMIT 1
    `[0];
    if (existing) return;

    const check = workspaceConfig.checks.find((candidate) => candidate.id === run.checkId);
    if (!check) throw new Error(`Missing check configuration for ${run.checkId}`);

    const cooldownStartedAt = new Date(Date.now() - INVESTIGATION_COOLDOWN_MS).toISOString();
    const recentThreadSubmission = this.sql`
      SELECT check_run_id
      FROM investigation_submissions
      WHERE check_id = ${run.checkId}
        AND status != 'failed'
        AND submitted_at >= ${cooldownStartedAt}
      LIMIT 1
    `[0];
    if (recentThreadSubmission) return;

    this.dispatchInvestigation({
      checkId: run.checkId,
      checkRunId: run.id,
      prompt: buildInvestigationBriefing(check.name, run, changes),
      threadId: investigationThreadId(),
    });
  }

  private dispatchInvestigation(input: {
    checkId: string;
    checkRunId: string;
    prompt: string;
    threadId: string;
  }): void {
    const submittedAt = new Date().toISOString();
    void this.sql`
      INSERT INTO investigation_submissions (check_run_id, check_id, thread_id, submitted_at)
      VALUES (${input.checkRunId}, ${input.checkId}, ${input.threadId}, ${submittedAt})
    `;
    this.setState({ ...this.state, investigations: this.loadInvestigations() });
    this.ctx.waitUntil(this.runInvestigation(input));
  }

  private async runInvestigation(input: { checkRunId: string; prompt: string; threadId: string }) {
    try {
      const incident = await getAgentByName(this.env.ThinkAgent_IncidentThread, input.threadId);
      await incident.submitMonitorBriefing({
        idempotencyKey: input.checkRunId,
        prompt: input.prompt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Investigation failed";
      this.updateInvestigationStatus({
        threadId: input.threadId,
        status: "failed",
        error: message,
      });
      console.log(
        JSON.stringify({
          message: "investigation.run.failed",
          threadId: input.threadId,
          checkRunId: input.checkRunId,
          error: message,
        }),
      );
    }
  }
}

function buildInvestigationBriefing(checkName: string, run: CheckRun, changes: Change[]) {
  if (run.status !== "deviation") throw new Error("Only deviations can start investigations");

  return [
    "[TRACER_MONITOR_BRIEFING]",
    `Investigate this candidate deviation in ${checkName}.`,
    "",
    "Check Run:",
    JSON.stringify(run, null, 2),
    "",
    "Recent Cloudflare changes:",
    JSON.stringify(changes.slice(0, 10), null, 2),
    "",
    "Relevant source repositories:",
    JSON.stringify(workspaceConfig.repositories, null, 2),
    "",
    "Follow your operating instructions and return an evidence-backed report.",
  ].join("\n");
}

function buildSimulationBriefing() {
  return [
    "[TRACER_SIMULATION_BRIEFING]",
    "This is a Tracer end-to-end self-test (a drill), not a real production incident.",
    "The goal is to exercise the full investigation pipeline: inspect the repository, produce a report, and open a draft pull request. Do not fabricate telemetry findings or claim a real incident.",
    "",
    `The configured repository is already cloned in your container at ${configuredRepositoryPath()}.`,
    "",
    "Do the following:",
    "1. Inspect the repository's structure, dependencies, and recent history.",
    "2. Write a concise report on the repository: what it does, its main components, and one small, safe, genuinely correct improvement you can make (for example a documentation fix, a comment, or an obvious typo). Do not make risky or behavioral changes.",
    "3. Apply that small improvement and run any quick build or checks available to confirm it does not break anything.",
    "4. Use publish_autofix to open a DRAFT pull request. In the PR title and body, clearly state that this is a Tracer end-to-end test drill and not a response to a real incident.",
    "",
    "Relevant source repositories:",
    JSON.stringify(workspaceConfig.repositories, null, 2),
    "",
    "Finish with a short report describing each step you completed and the resulting draft pull request.",
  ].join("\n");
}
