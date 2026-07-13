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

export function submissionFailure(submission: InvestigationSubmissionState): string | undefined {
  if (submission.status === "pending" || submission.status === "running") return;
  if (submission.status === "completed") {
    return "Investigation completed without submitting a report.";
  }
  return submission.error ?? `Investigation submission ${submission.status}.`;
}
