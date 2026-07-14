import { Agent, callable, getAgentByName, type Schedule } from "agents";
import type { UIMessage } from "ai";
import { evaluateMonitor } from "../../checks/monitor";
import { configuredRepositoryPath } from "../../investigation/sandbox";
import { InvestigationStore } from "../../investigation/store";
import { submissionFailure } from "../../investigation/submission";
import { getCloudflareContext } from "../../providers/cloudflare";
import { providerFailure } from "../../providers/http";
import { queryMonitorEvidence } from "../../providers/posthog";
import {
  commandFailure,
  commandSuccess,
  createFailure,
  type CommandResult,
  type FailureSource,
  type UserFacingFailure,
} from "../../shared/failure";
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
  type MonitorDefinition,
  SIMULATION_RUN_PREFIX,
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

function checkTime() {
  const intervalMs = workspaceConfig.scheduleIntervalSeconds * 1_000;
  return new Date(Math.floor(Date.now() / intervalMs) * intervalMs);
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
  private readonly investigations = new InvestigationStore(this);

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
      warning?: string;
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
      warnings: Array.isArray(previous.warnings)
        ? previous.warnings
        : previous.warning
          ? [
              createFailure({
                code: "unexpected",
                message: previous.warning,
                action: "Run the checks again. If this persists, inspect the service logs.",
                retryable: true,
                source: "monitor",
              }),
            ]
          : [],
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
    this.investigations.ensureSchema();
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
    return this.investigations.load(STATE_HISTORY_LIMIT, parseCheckRun);
  }

  private updateInvestigationStatus(input: {
    threadId: string;
    status: InvestigationStatus;
    verdict?: InvestigationVerdict;
    confidence?: InvestigationConfidence;
    failure?: UserFacingFailure;
  }) {
    this.investigations.update(input);
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

  async recordInvestigationFailure(input: {
    threadId: string;
    failure: UserFacingFailure;
  }): Promise<void> {
    if (this.investigations.failActive(input.threadId, input.failure)) {
      this.setState({ ...this.state, investigations: this.loadInvestigations() });
    }
  }

  @callable()
  async getInvestigationTranscript(threadId: string): Promise<CommandResult<UIMessage[]>> {
    try {
      if (!this.investigations.hasThread(threadId)) {
        return commandFailure(this.investigationNotFoundFailure());
      }
      const incident = await getAgentByName(this.env.ThinkAgent_IncidentThread, threadId);
      return commandSuccess(await Promise.resolve(incident.getTranscript()));
    } catch (error) {
      return commandFailure(this.unexpectedFailure("load_transcript", error, "investigation"));
    }
  }

  @callable()
  async retryInvestigation(threadId: string): Promise<CommandResult<WorkspaceState>> {
    try {
      return await this.retryInvestigationCommand(threadId);
    } catch (error) {
      return commandFailure(this.unexpectedFailure("retry_investigation", error, "investigation"));
    }
  }

  private async retryInvestigationCommand(
    threadId: string,
  ): Promise<CommandResult<WorkspaceState>> {
    if (this.hasActiveInvestigation()) {
      return commandFailure(this.activeInvestigationFailure());
    }
    const investigation = this.investigations.findByThread(threadId);
    if (!investigation) return commandFailure(this.investigationNotFoundFailure());
    if (investigation.status !== "failed") {
      return commandFailure(
        createFailure({
          code: "investigation_not_failed",
          message: "Only failed investigations can be retried.",
          action: "Wait for the active investigation to finish.",
          retryable: false,
          source: "investigation",
        }),
      );
    }

    const storedRun = this.findRun(investigation.check_run_id);
    if (!storedRun) {
      return commandFailure(
        createFailure({
          code: "investigation_evidence_expired",
          message: "The evidence for this investigation has expired.",
          action: "Run the checks again to collect fresh evidence.",
          retryable: false,
          source: "investigation",
        }),
      );
    }
    let run: CheckRun;
    try {
      run = parseCheckRun(storedRun.payload);
    } catch (error) {
      return commandFailure(this.unexpectedFailure("parse_retry_evidence", error, "investigation"));
    }
    if (run.status !== "deviation") {
      return commandFailure(
        createFailure({
          code: "investigation_evidence_invalid",
          message: "The stored evidence is no longer a deviation.",
          action: "Run the checks again before starting another investigation.",
          retryable: false,
          source: "investigation",
        }),
      );
    }
    const check = workspaceConfig.checks.find(
      (candidate) => candidate.id === investigation.check_id,
    );
    if (!check) {
      return commandFailure(
        createFailure({
          code: "investigation_configuration_missing",
          message: "The monitor configuration used by this investigation is missing.",
          action: "Restore the monitor configuration, then run the checks again.",
          retryable: false,
          source: "investigation",
        }),
      );
    }

    try {
      await this.scheduleInvestigationThreadDestroy(threadId);
    } catch (error) {
      return commandFailure(this.unexpectedFailure("destroy_retry_thread", error, "container"));
    }

    const retryThreadId = investigationThreadId();
    this.investigations.retry(investigation.check_run_id, retryThreadId);
    this.setState({ ...this.state, investigations: this.loadInvestigations() });
    this.ctx.waitUntil(
      this.runInvestigation({
        checkRunId: investigation.check_run_id,
        prompt: buildInvestigationBriefing(check.name, run, this.loadChanges()),
        threadId: retryThreadId,
      }),
    );
    return commandSuccess(this.state);
  }

  @callable()
  async deleteInvestigation(threadId: string): Promise<CommandResult<WorkspaceState>> {
    try {
      return await this.deleteInvestigationCommand(threadId);
    } catch (error) {
      return commandFailure(this.unexpectedFailure("delete_investigation", error, "investigation"));
    }
  }

  private async deleteInvestigationCommand(
    threadId: string,
  ): Promise<CommandResult<WorkspaceState>> {
    const investigation = this.investigations.findByThread(threadId);
    if (!investigation) return commandFailure(this.investigationNotFoundFailure());
    if (investigation.status === "investigating") {
      return commandFailure(
        this.activeInvestigationFailure("An active investigation cannot be deleted."),
      );
    }

    try {
      await this.scheduleInvestigationThreadDestroy(threadId);
    } catch (error) {
      return commandFailure(this.unexpectedFailure("destroy_deleted_thread", error, "container"));
    }

    if (!this.investigations.delete(threadId))
      return commandFailure(this.investigationNotFoundFailure());
    this.setState({ ...this.state, investigations: this.loadInvestigations() });
    return commandSuccess(this.state);
  }

  private async scheduleInvestigationThreadDestroy(threadId: string): Promise<void> {
    const incident = await getAgentByName(this.env.ThinkAgent_IncidentThread, threadId);
    await incident.scheduleDestroy();
  }

  private investigationNotFoundFailure() {
    return createFailure({
      code: "investigation_not_found",
      message: "This investigation no longer exists.",
      action: "Return to the investigation list and choose another investigation.",
      retryable: false,
      source: "investigation",
    });
  }

  private activeInvestigationFailure(message = "Another investigation is already running.") {
    return createFailure({
      code: "investigation_active",
      message,
      action: "Wait for the active investigation to finish, then try again.",
      retryable: true,
      source: "investigation",
    });
  }

  private unexpectedFailure(
    operation: string,
    error: unknown,
    source: FailureSource,
  ): UserFacingFailure {
    const reference = crypto.randomUUID();
    console.error(
      JSON.stringify({
        message: "workspace.command.failed",
        operation,
        reference,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return createFailure({
      code: "unexpected",
      message: "Tracer could not complete the request.",
      action: "Try again. If it keeps failing, use the reference to inspect logs.",
      retryable: true,
      source,
      reference,
    });
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

  @callable()
  async runChecks(): Promise<CommandResult<WorkspaceState>> {
    try {
      return commandSuccess(await this.reconcile());
    } catch (error) {
      return commandFailure(this.unexpectedFailure("run_checks", error, "monitor"));
    }
  }

  /**
   * Starts a synthetic investigation to exercise the full pipeline end to end
   * (clone repo, investigate, write a report, open a draft PR) without waiting
   * for a real deviation. For testing the investigation path only.
   */
  @callable()
  async simulateInvestigation(): Promise<CommandResult<WorkspaceState>> {
    try {
      return this.simulateInvestigationCommand();
    } catch (error) {
      return commandFailure(
        this.unexpectedFailure("simulate_investigation", error, "investigation"),
      );
    }
  }

  private simulateInvestigationCommand(): CommandResult<WorkspaceState> {
    if (this.hasActiveInvestigation()) {
      return commandFailure(this.activeInvestigationFailure());
    }
    const runId = `${SIMULATION_RUN_PREFIX}${new Date().toISOString()}`;
    const checkId = workspaceConfig.checks[0]?.id ?? "simulation";

    this.dispatchInvestigation({
      checkId,
      checkRunId: runId,
      evidenceKey: runId,
      prompt: buildSimulationBriefing(),
      threadId: investigationThreadId(),
    });
    return commandSuccess(this.state);
  }

  private async performReconciliation(): Promise<WorkspaceState> {
    const startedAt = new Date().toISOString();
    this.setState({
      ...this.state,
      status: "checking",
      checks: workspaceConfig.checks,
      warnings: [],
    });

    const [warnings, latestRuns, cloudflareResult] = await Promise.all([
      this.reconcileInvestigationStatuses(),
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

    if (cloudflareResult.status === "rejected") {
      warnings.push(providerFailure(cloudflareResult.reason, "Cloudflare context refresh failed"));
    }
    const failedChecks = latestRuns.filter((run) => run.status === "failed").length;
    const changes = this.loadChanges();
    for (const run of latestRuns) {
      try {
        const failure = this.submitInvestigation(run, changes);
        if (failure) warnings.push(failure);
      } catch (error) {
        warnings.push(this.unexpectedFailure("submit_investigation", error, "investigation"));
      }
    }
    const nextState: WorkspaceState = {
      status:
        failedChecks === latestRuns.length
          ? "failed"
          : failedChecks > 0 || warnings.length > 0
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
      warnings,
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

  private async reconcileInvestigationStatuses(): Promise<UserFacingFailure[]> {
    const warnings: UserFacingFailure[] = [];
    const investigating = this.investigations.active(STATE_HISTORY_LIMIT);
    await Promise.all(
      investigating.map(async (row) => {
        try {
          const incident = await getAgentByName(this.env.ThinkAgent_IncidentThread, row.thread_id);
          const submission = await incident.getMonitorSubmission(row.check_run_id);
          const failure = submission ? submissionFailure(submission) : undefined;
          if (failure) {
            await this.recordInvestigationFailure({
              threadId: row.thread_id,
              failure,
            });
          }
        } catch (error) {
          const failure = this.unexpectedFailure(
            "reconcile_investigation_status",
            error,
            "investigation",
          );
          warnings.push(failure);
        }
      }),
    );
    return warnings;
  }

  private async runCheck(check: MonitorDefinition): Promise<CheckRun> {
    const now = checkTime();
    const runId = `${check.id}:${now.toISOString()}`;
    const existingRun = this.findRun(runId);
    if (existingRun && existingRun.status !== "failed") {
      return parseCheckRun(existingRun.payload);
    }

    const startedAt = new Date().toISOString();
    let run: CheckRun;
    try {
      const evidence = await queryMonitorEvidence(
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
        ...evaluateMonitor(check, evidence.current.summary, evidence.baseline.summary),
        startedAt,
        completedAt: new Date().toISOString(),
        current: evidence.current,
        baseline: evidence.baseline,
        cached: evidence.cached,
      };
    } catch (error) {
      const failure = providerFailure(error, `PostHog check ${check.name} failed`);
      run = {
        id: runId,
        checkId: check.id,
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        reason: failure.message,
        failure,
      };
    }

    this.persistRun(run);
    return run;
  }

  private submitInvestigation(run: CheckRun, changes: Change[]): UserFacingFailure | undefined {
    if (
      run.status !== "deviation" ||
      !("deviation" in run) ||
      !["latency", "success_rate"].includes(run.deviation)
    ) {
      return;
    }

    if (this.investigations.hasEvidence(run.id, run.evidenceKey) || this.hasActiveInvestigation())
      return;

    const check = workspaceConfig.checks.find((candidate) => candidate.id === run.checkId);
    if (!check) {
      return createFailure({
        code: "investigation_configuration_missing",
        message:
          "Tracer could not start an investigation because its monitor configuration is missing.",
        action: "Restore the monitor configuration, then run the checks again.",
        retryable: false,
        source: "investigation",
      });
    }

    this.dispatchInvestigation({
      checkId: run.checkId,
      checkRunId: run.id,
      evidenceKey: run.evidenceKey,
      prompt: buildInvestigationBriefing(check.name, run, changes),
      threadId: investigationThreadId(),
    });
  }

  private hasActiveInvestigation(): boolean {
    return this.investigations.hasActive();
  }

  private dispatchInvestigation(input: {
    checkId: string;
    checkRunId: string;
    evidenceKey: string;
    prompt: string;
    threadId: string;
  }): void {
    this.investigations.insert(input);
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
      const failure = this.unexpectedFailure("run_investigation", error, "investigation");
      this.updateInvestigationStatus({
        threadId: input.threadId,
        status: "failed",
        failure,
      });
      console.log(
        JSON.stringify({
          message: "investigation.run.failed",
          threadId: input.threadId,
          checkRunId: input.checkRunId,
          reference: failure.reference,
          error: error instanceof Error ? error.message : String(error),
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
