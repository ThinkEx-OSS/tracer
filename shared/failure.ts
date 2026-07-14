const FAILURE_SOURCES = ["client", "container", "investigation", "monitor", "provider"] as const;

const FAILURE_CODES = [
  "container_unavailable",
  "investigation_active",
  "investigation_configuration_missing",
  "investigation_evidence_expired",
  "investigation_evidence_invalid",
  "investigation_execution_failed",
  "investigation_missing_report",
  "investigation_not_failed",
  "investigation_not_found",
  "investigation_submission_aborted",
  "investigation_submission_skipped",
  "provider_authentication",
  "provider_invalid_response",
  "provider_rate_limited",
  "provider_request_failed",
  "provider_response_too_large",
  "provider_timeout",
  "transcript_unavailable",
  "unexpected",
] as const;

export type FailureSource = (typeof FAILURE_SOURCES)[number];
export type FailureCode = (typeof FAILURE_CODES)[number];

export interface UserFacingFailure {
  code: FailureCode;
  message: string;
  action?: string;
  retryable: boolean;
  source: FailureSource;
  reference?: string;
}

export type CommandResult<T> = { ok: true; value: T } | { ok: false; failure: UserFacingFailure };

export function createFailure(input: UserFacingFailure): UserFacingFailure {
  return input;
}

export function commandSuccess<T>(value: T): CommandResult<T> {
  return { ok: true, value };
}

export function commandFailure<T>(failure: UserFacingFailure): CommandResult<T> {
  return { ok: false, failure };
}

export function parseFailure(value: string | null | undefined): UserFacingFailure | undefined {
  if (!value) return;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.code !== "string" ||
      !FAILURE_CODES.includes(record.code as FailureCode) ||
      typeof record.message !== "string" ||
      typeof record.retryable !== "boolean" ||
      typeof record.source !== "string" ||
      !FAILURE_SOURCES.includes(record.source as FailureSource) ||
      (record.action !== undefined && typeof record.action !== "string") ||
      (record.reference !== undefined && typeof record.reference !== "string")
    ) {
      return;
    }
    return record as unknown as UserFacingFailure;
  } catch {
    return;
  }
}
