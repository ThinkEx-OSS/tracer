import { Badge } from "@cloudflare/kumo/components/badge";
import { Text } from "@cloudflare/kumo/components/text";
import { Markdown } from "./markdown";
import { type InvestigationLive, useInvestigationThread } from "./live";
import { type BadgeVariant, type StepEntry } from "./model";

const STEP_STATUS: Record<StepEntry["status"], { label: string; variant: BadgeVariant }> = {
  running: { label: "Running", variant: "neutral" },
  done: { label: "Done", variant: "success" },
  error: { label: "Failed", variant: "error" },
};

function IoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="step-io">
      <Text as="strong" bold size="xs">
        {label}
      </Text>
      <pre className="step-io-body border-kumo-hairline">{value}</pre>
    </div>
  );
}

function StepDisclosure({ step, open }: { step: StepEntry; open: boolean }) {
  const presentation = STEP_STATUS[step.status];
  const hasDetail = Boolean(step.input || step.output || step.errorText);
  return (
    <details className="entry-step border-kumo-hairline" open={open}>
      <summary className="entry-step-head">
        <Badge appearance="dot" variant={presentation.variant}>
          {presentation.label}
        </Badge>
        <Text as="strong" bold size="sm">
          {step.tool}
        </Text>
      </summary>
      {hasDetail ? (
        <div className="entry-step-body">
          {step.input ? <IoBlock label="Input" value={step.input} /> : null}
          {step.output ? <IoBlock label="Output" value={step.output} /> : null}
          {step.errorText ? <IoBlock label="Error" value={step.errorText} /> : null}
        </div>
      ) : (
        <div className="entry-step-body">
          <Text variant="secondary">No input or output was captured for this step.</Text>
        </div>
      )}
    </details>
  );
}

function InvestigationBody({ live }: { live: InvestigationLive }) {
  const { timeline, busy, recovering } = live;
  const report = timeline.report;
  const feed = [...timeline.entries].reverse();
  const lastRunningId = feed.find(
    (entry): entry is StepEntry => entry.kind === "step" && entry.status !== "done",
  )?.id;

  return (
    <div className="case">
      {report ? (
        <div className="case-report border-kumo-hairline">
          <Text size="xs" variant="secondary">
            {report.confidence} confidence
          </Text>
          <Markdown>{report.summary}</Markdown>
        </div>
      ) : null}

      {timeline.pullRequestUrl ? (
        <a
          className="case-pr border-kumo-hairline"
          href={timeline.pullRequestUrl}
          rel="noreferrer"
          target="_blank"
        >
          <Badge appearance="dot" variant="success">
            Draft PR
          </Badge>
          View pull request
        </a>
      ) : null}

      {feed.length > 0 ? (
        <div className="case-feed">
          {feed.map((entry) =>
            entry.kind === "note" ? (
              <div className="entry-note" key={entry.id}>
                <Markdown>{entry.text}</Markdown>
              </div>
            ) : (
              <StepDisclosure key={entry.id} open={entry.id === lastRunningId} step={entry} />
            ),
          )}
        </div>
      ) : busy ? (
        <Text variant="secondary">
          {recovering ? "Resuming investigation…" : "Starting investigation…"}
        </Text>
      ) : report ? null : (
        <Text variant="secondary">Waiting for the investigator to respond.</Text>
      )}
    </div>
  );
}

/** Expanded detail when the parent already holds the live connection. */
export function InvestigationDetail({ live }: { live: InvestigationLive }) {
  return <InvestigationBody live={live} />;
}

/** Expanded detail for static rows (reported, was collapsed) — opens its own connection. */
export function InvestigationDetailByThread({ threadId }: { threadId: string }) {
  const live = useInvestigationThread(threadId);
  return <InvestigationBody live={live} />;
}
