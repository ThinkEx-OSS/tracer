import { createFailure, type UserFacingFailure } from "../shared/failure";

export type InvestigationSubmissionStatus =
  | "pending"
  | "running"
  | "completed"
  | "aborted"
  | "skipped"
  | "error";

export interface InvestigationSubmissionState {
  status: InvestigationSubmissionStatus;
  error?: string;
}

export function submissionFailure(
  submission: InvestigationSubmissionState,
): UserFacingFailure | undefined {
  if (submission.status === "pending" || submission.status === "running") return;
  if (submission.status === "completed") {
    return createFailure({
      code: "investigation_missing_report",
      message: "The investigation finished without submitting a report.",
      action: "Retry the investigation. If it happens again, inspect the investigation transcript.",
      retryable: true,
      source: "investigation",
    });
  }
  if (submission.status === "aborted") {
    return createFailure({
      code: "investigation_submission_aborted",
      message: "The investigation was stopped before it could submit a report.",
      action: "Retry the investigation.",
      retryable: true,
      source: "investigation",
    });
  }
  if (submission.status === "skipped") {
    return createFailure({
      code: "investigation_submission_skipped",
      message: "The investigation could not start its report submission.",
      action: "Check the investigation configuration, then retry.",
      retryable: true,
      source: "investigation",
    });
  }
  return createFailure({
    code: "investigation_execution_failed",
    message: "The investigation failed before it could submit a report.",
    action: "Retry the investigation. If it fails again, use the reference to inspect logs.",
    retryable: true,
    source: "investigation",
  });
}
