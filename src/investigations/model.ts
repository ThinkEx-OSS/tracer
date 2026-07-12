import type { UIMessage } from "ai";
import type {
  InvestigationConfidence,
  InvestigationSummary,
  InvestigationVerdict,
} from "../../shared/workspace";
import { workspaceConfig } from "../../workspace.config";

export type BadgeVariant = "success" | "error" | "warning" | "neutral";

export type StepStatus = "running" | "done" | "error";

/** The agent's own narration between tool calls. */
export interface NoteEntry {
  kind: "note";
  id: string;
  text: string;
}

/** A single tool invocation, with its raw input and result preserved for inspection. */
export interface StepEntry {
  kind: "step";
  id: string;
  tool: string;
  status: StepStatus;
  input?: string;
  output?: string;
  errorText?: string;
}

export type TimelineEntry = NoteEntry | StepEntry;

export type ReportVerdict = InvestigationVerdict;
export type ReportConfidence = InvestigationConfidence;

/** Shared verdict → badge mapping used by both the row summary and the detail view. */
export const VERDICT_PRESENTATION: Record<ReportVerdict, { label: string; variant: BadgeVariant }> =
  {
    incident: { label: "Incident", variant: "error" },
    no_incident: { label: "No incident", variant: "success" },
    inconclusive: { label: "Inconclusive", variant: "warning" },
  };

/**
 * At-a-glance status for a collapsed investigation row. Shows the reported
 * verdict once the thread concludes, otherwise the in-progress state.
 */
export function investigationStatusBadge(summary: InvestigationSummary): {
  label: string;
  variant: BadgeVariant;
} {
  if (summary.status === "failed") return { label: "Failed", variant: "error" };
  if (summary.status === "reported" && summary.verdict) {
    return VERDICT_PRESENTATION[summary.verdict];
  }
  return { label: "Investigating", variant: "neutral" };
}

/** The typed conclusion emitted by the agent's `submit_report` action. */
export interface InvestigationReport {
  verdict: ReportVerdict;
  confidence: ReportConfidence;
  summary: string;
  pullRequestUrl?: string;
}

/** A chronological, render-ready projection of an incident thread's raw message stream. */
export interface InvestigationTimeline {
  entries: TimelineEntry[];
  report?: InvestigationReport;
  pullRequestUrl?: string;
}

const REPORT_TOOL = "submit_report";

function parseReport(input: unknown): InvestigationReport | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const summary = typeof record.summary === "string" ? record.summary : "";
  if (!summary) return undefined;
  const verdict = record.verdict;
  const confidence = record.confidence;
  return {
    verdict:
      verdict === "incident" || verdict === "no_incident" || verdict === "inconclusive"
        ? verdict
        : "inconclusive",
    confidence: confidence === "low" || confidence === "high" ? confidence : "medium",
    summary,
    pullRequestUrl: typeof record.pullRequestUrl === "string" ? record.pullRequestUrl : undefined,
  };
}

const BRIEFING_MARKERS = ["[TRACER_MONITOR_BRIEFING]", "[TRACER_SIMULATION_BRIEFING]"];
const PULL_REQUEST_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
const MAX_IO_CHARS = 20_000;

type MessagePart = UIMessage["parts"][number];

function isBriefing(text: string) {
  return BRIEFING_MARKERS.some((marker) => text.startsWith(marker));
}

function partStatus(part: MessagePart): StepStatus {
  const state = "state" in part ? part.state : undefined;
  if (state === "output-error") return "error";
  if (state === "output-available") return "done";
  return "running";
}

function stepTool(part: MessagePart): string | undefined {
  if (part.type === "dynamic-tool") return part.toolName;
  if (part.type.startsWith("tool-")) return part.type.slice("tool-".length);
  return undefined;
}

function display(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = typeof value === "string" ? value : safeStringify(value);
  return text.length > MAX_IO_CHARS ? `${text.slice(0, MAX_IO_CHARS)}\n… (truncated)` : text;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function readField(part: MessagePart, key: "input" | "output" | "errorText"): unknown {
  return key in part ? (part as Record<string, unknown>)[key] : undefined;
}

export function buildInvestigationTimeline(messages: UIMessage[]): InvestigationTimeline {
  const entries: TimelineEntry[] = [];
  const noteText: string[] = [];
  let report: InvestigationReport | undefined;
  let note = "";
  let noteId = "";

  const flushNote = () => {
    const text = note.trim();
    note = "";
    if (!text || isBriefing(text)) return;
    noteText.push(text);
    entries.push({ kind: "note", id: noteId, text });
  };

  for (const message of messages) {
    message.parts.forEach((part, index) => {
      if (part.type === "text") {
        if (!note) noteId = `${message.id}:${index}`;
        note += part.text;
        return;
      }
      const tool = stepTool(part);
      if (!tool) return;
      flushNote();
      // The report is a typed conclusion, not a step in the trace.
      if (tool === REPORT_TOOL) {
        if (partStatus(part) === "done") {
          report = parseReport(readField(part, "output")) ?? report;
        }
        return;
      }
      entries.push({
        kind: "step",
        id: `${message.id}:${index}`,
        tool,
        status: partStatus(part),
        input: display(readField(part, "input")),
        output: display(readField(part, "output")),
        errorText: display(readField(part, "errorText")),
      });
    });
    flushNote();
  }

  return {
    entries,
    report,
    pullRequestUrl: report?.pullRequestUrl ?? noteText.join("\n").match(PULL_REQUEST_URL)?.[0],
  };
}

export function countSteps(entries: TimelineEntry[]) {
  const steps = entries.filter((entry): entry is StepEntry => entry.kind === "step");
  return {
    total: steps.length,
    running: steps.filter((step) => step.status === "running").length,
    failed: steps.filter((step) => step.status === "error").length,
  };
}

export type StepCounts = ReturnType<typeof countSteps>;

/** Compact step summary for row headers, e.g. "18 steps · 1 running". */
export function formatActivityBrief(counts: StepCounts): string | undefined {
  if (counts.total === 0) return undefined;
  const parts = [`${counts.total} ${counts.total === 1 ? "step" : "steps"}`];
  if (counts.running > 0) parts.push(`${counts.running} running`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  return parts.join(" · ");
}

export interface InvestigationDescriptor {
  title: string;
  origin: { label: string; variant: BadgeVariant };
}

export function describeInvestigation(summary: InvestigationSummary): InvestigationDescriptor {
  if (summary.kind === "simulation") {
    return { title: "Simulation drill", origin: { label: "Drill", variant: "neutral" } };
  }
  const check = workspaceConfig.checks.find((candidate) => candidate.id === summary.checkId);
  return {
    title: check?.name ?? summary.checkId,
    origin: { label: "Monitor", variant: "warning" },
  };
}

const RELATIVE_TIME = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function formatOpenedAt(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((then - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return RELATIVE_TIME.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return RELATIVE_TIME.format(hours, "hour");
  return new Date(then).toLocaleString();
}
