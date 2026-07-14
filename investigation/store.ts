import { createFailure, parseFailure, type UserFacingFailure } from "../shared/failure";
import type {
  CheckRun,
  InvestigationConfidence,
  InvestigationStatus,
  InvestigationSummary,
  InvestigationVerdict,
} from "../shared/workspace";

interface SqlProvider {
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
}

interface StoredInvestigation {
  check_id: string;
  check_run_id: string;
  submitted_at: string;
  thread_id: string;
  status: InvestigationStatus | null;
  verdict: InvestigationVerdict | null;
  confidence: InvestigationConfidence | null;
  error_message: string | null;
  failure_json: string | null;
  check_run_payload: string | null;
}

export interface RetryableInvestigation {
  check_id: string;
  check_run_id: string;
  status: InvestigationStatus;
}

export class InvestigationStore {
  constructor(private readonly database: SqlProvider) {}

  ensureSchema() {
    void this.database.sql`
      CREATE TABLE IF NOT EXISTS investigation_submissions (
        check_run_id TEXT PRIMARY KEY,
        check_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        evidence_key TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'investigating',
        verdict TEXT,
        confidence TEXT,
        error_message TEXT,
        failure_json TEXT,
        updated_at TEXT
      )
    `;
    const columns = this.database.sql<{
      name: string;
    }>`PRAGMA table_info(investigation_submissions)`.map((row) => row.name);
    if (!columns.includes("status")) {
      void this.database
        .sql`ALTER TABLE investigation_submissions ADD COLUMN status TEXT NOT NULL DEFAULT 'investigating'`;
    }
    if (!columns.includes("verdict"))
      void this.database.sql`ALTER TABLE investigation_submissions ADD COLUMN verdict TEXT`;
    if (!columns.includes("confidence"))
      void this.database.sql`ALTER TABLE investigation_submissions ADD COLUMN confidence TEXT`;
    if (!columns.includes("updated_at"))
      void this.database.sql`ALTER TABLE investigation_submissions ADD COLUMN updated_at TEXT`;
    if (!columns.includes("error_message"))
      void this.database.sql`ALTER TABLE investigation_submissions ADD COLUMN error_message TEXT`;
    if (!columns.includes("failure_json"))
      void this.database.sql`ALTER TABLE investigation_submissions ADD COLUMN failure_json TEXT`;
    if (!columns.includes("evidence_key"))
      void this.database.sql`ALTER TABLE investigation_submissions ADD COLUMN evidence_key TEXT`;
    void this.database
      .sql`CREATE INDEX IF NOT EXISTS investigation_submissions_submitted ON investigation_submissions(submitted_at DESC)`;
    void this.database
      .sql`CREATE INDEX IF NOT EXISTS investigation_submissions_thread_submitted ON investigation_submissions(thread_id, submitted_at DESC)`;
    void this.database
      .sql`CREATE UNIQUE INDEX IF NOT EXISTS investigation_submissions_evidence ON investigation_submissions(evidence_key) WHERE evidence_key IS NOT NULL`;
  }

  load(limit: number, parseRun: (payload: string) => CheckRun): InvestigationSummary[] {
    const rows = this.database.sql<StoredInvestigation>`
      SELECT submissions.check_run_id, submissions.check_id, submissions.thread_id,
             submissions.submitted_at, submissions.status, submissions.verdict,
             submissions.confidence, submissions.error_message, submissions.failure_json,
             runs.payload AS check_run_payload
      FROM investigation_submissions AS submissions
      LEFT JOIN check_runs AS runs ON runs.id = submissions.check_run_id
      ORDER BY submissions.submitted_at DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => {
      const simulation = row.check_run_id.startsWith("simulation:");
      let trigger: InvestigationSummary["trigger"] = simulation
        ? { reason: "Manually started end-to-end pipeline drill." }
        : undefined;
      if (row.check_run_payload) {
        try {
          const run = parseRun(row.check_run_payload);
          trigger = {
            reason: run.reason,
            ...(run.status === "failed"
              ? {}
              : {
                  attempts: run.current.summary.attempts,
                  failures: run.current.summary.failures,
                  successRate: run.current.summary.successRate,
                  from: run.current.from,
                  to: run.current.to,
                }),
          };
        } catch {
          // Preserve legacy investigations even when their check payload is obsolete.
        }
      }
      return {
        kind: simulation ? "simulation" : "monitor",
        status: row.status ?? "investigating",
        checkId: row.check_id,
        checkRunId: row.check_run_id,
        submittedAt: row.submitted_at,
        threadId: row.thread_id,
        trigger,
        verdict: row.verdict ?? undefined,
        confidence: row.confidence ?? undefined,
        failure:
          parseFailure(row.failure_json) ??
          (row.error_message
            ? createFailure({
                code: "investigation_execution_failed",
                message: row.error_message,
                action: "Retry the investigation. If it fails again, check the provider setup.",
                retryable: true,
                source: "investigation",
              })
            : undefined),
      };
    });
  }

  update(input: {
    threadId: string;
    status: InvestigationStatus;
    verdict?: InvestigationVerdict;
    confidence?: InvestigationConfidence;
    failure?: UserFacingFailure;
  }) {
    const updated = this.database.sql<{ thread_id: string }>`
      UPDATE investigation_submissions
      SET status = ${input.status}, verdict = ${input.verdict ?? null},
          confidence = ${input.confidence ?? null},
          error_message = ${input.failure?.message ?? null},
          failure_json = ${input.failure ? JSON.stringify(input.failure) : null},
          updated_at = ${new Date().toISOString()}
      WHERE thread_id = ${input.threadId}
      RETURNING thread_id
    `;
    if (updated.length === 0) throw new Error(`Investigation ${input.threadId} was not found`);
  }

  failActive(threadId: string, failure: UserFacingFailure) {
    return (
      this.database.sql<{ thread_id: string }>`
      UPDATE investigation_submissions
      SET status = 'failed', error_message = ${failure.message},
          failure_json = ${JSON.stringify(failure)}, updated_at = ${new Date().toISOString()}
      WHERE thread_id = ${threadId} AND status = 'investigating'
      RETURNING thread_id
    `.length > 0
    );
  }

  findByThread(threadId: string): RetryableInvestigation | undefined {
    return this.database.sql<RetryableInvestigation>`
      SELECT check_id, check_run_id, status FROM investigation_submissions
      WHERE thread_id = ${threadId} LIMIT 1
    `[0];
  }

  hasThread(threadId: string) {
    return Boolean(
      this.database
        .sql`SELECT thread_id FROM investigation_submissions WHERE thread_id = ${threadId} LIMIT 1`[0],
    );
  }

  hasActive() {
    return Boolean(
      this.database
        .sql`SELECT thread_id FROM investigation_submissions WHERE status = 'investigating' LIMIT 1`[0],
    );
  }

  hasEvidence(checkRunId: string, evidenceKey: string) {
    return Boolean(
      this.database.sql`
        SELECT check_run_id FROM investigation_submissions
        WHERE check_run_id = ${checkRunId} OR evidence_key = ${evidenceKey} LIMIT 1
      `[0],
    );
  }

  active(limit: number) {
    return this.database.sql<{ check_run_id: string; thread_id: string }>`
      SELECT check_run_id, thread_id FROM investigation_submissions
      WHERE status = 'investigating' ORDER BY submitted_at DESC LIMIT ${limit}
    `;
  }

  insert(input: { checkRunId: string; checkId: string; threadId: string; evidenceKey: string }) {
    const submittedAt = new Date().toISOString();
    void this.database.sql`
      INSERT INTO investigation_submissions (check_run_id, check_id, thread_id, evidence_key, submitted_at)
      VALUES (${input.checkRunId}, ${input.checkId}, ${input.threadId}, ${input.evidenceKey}, ${submittedAt})
    `;
  }

  retry(checkRunId: string, threadId: string) {
    const submittedAt = new Date().toISOString();
    void this.database.sql`
      UPDATE investigation_submissions
      SET thread_id = ${threadId}, submitted_at = ${submittedAt}, status = 'investigating',
          verdict = NULL, confidence = NULL, error_message = NULL, failure_json = NULL,
          updated_at = ${submittedAt}
      WHERE check_run_id = ${checkRunId}
    `;
  }

  delete(threadId: string) {
    return (
      this.database.sql<{ thread_id: string }>`
      DELETE FROM investigation_submissions WHERE thread_id = ${threadId} RETURNING thread_id
    `.length > 0
    );
  }
}
