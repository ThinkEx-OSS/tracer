import { StatusBadge } from "../components/status-badge";
import { FailureNotice } from "../components/failure-notice";
import { buttonVariants } from "../components/ui/button";
import { Card, CardContent, CardHeader } from "../components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { cn } from "../lib/utils";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Markdown } from "./markdown";
import { type InvestigationView, useInvestigationSnapshot } from "./live";
import { type BadgeVariant, type StepEntry } from "./model";

const STEP_STATUS: Record<StepEntry["status"], { label: string; variant: BadgeVariant }> = {
  running: { label: "Running", variant: "neutral" },
  done: { label: "Done", variant: "success" },
  error: { label: "Failed", variant: "error" },
};

function IoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1.5">
      <strong className="text-xs font-medium">{label}</strong>
      <pre className="m-0 max-h-88 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-background p-3 font-mono text-xs leading-6 text-foreground/85">
        {value}
      </pre>
    </div>
  );
}

function StepDisclosure({ step }: { step: StepEntry }) {
  const [open, setOpen] = useState(false);
  const presentation = STEP_STATUS[step.status];
  const hasDetail = Boolean(step.input || step.output || step.errorText);
  return (
    <Collapsible
      className="overflow-hidden rounded-lg border bg-card/60"
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left">
        <StatusBadge dot variant={presentation.variant}>
          {presentation.label}
        </StatusBadge>
        <strong className="text-sm font-medium">{step.tool}</strong>
        <span
          aria-hidden="true"
          className={cn(
            "ml-auto text-xs text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        >
          ▸
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-3 border-t px-3.5 py-3">
        {hasDetail ? (
          <>
            {step.input ? <IoBlock label="Input" value={step.input} /> : null}
            {step.output ? <IoBlock label="Output" value={step.output} /> : null}
            {step.errorText ? <IoBlock label="Error" value={step.errorText} /> : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No input or output was captured for this step.
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function InvestigationBody({ live }: { live: InvestigationView }) {
  const { timeline, busy, recovering } = live;
  const report = timeline.report;
  const feed = [...timeline.entries].reverse();

  return (
    <div className="grid gap-5 p-5">
      {live.failure ? <FailureNotice failure={live.failure} /> : null}
      {report ? (
        <Card className="gap-2 bg-card/70 py-4 shadow-none">
          <CardHeader>
            <span className="text-xs capitalize text-muted-foreground">
              {report.confidence} confidence
            </span>
          </CardHeader>
          <CardContent>
            <Markdown>{report.summary}</Markdown>
          </CardContent>
        </Card>
      ) : null}

      {timeline.pullRequestUrl ? (
        <a
          className={cn(buttonVariants({ variant: "outline" }), "w-fit")}
          href={timeline.pullRequestUrl}
          rel="noreferrer"
          target="_blank"
        >
          <StatusBadge dot variant="success">
            Draft PR
          </StatusBadge>
          View pull request
          <ExternalLink aria-hidden="true" />
        </a>
      ) : null}

      {feed.length > 0 ? (
        <div className="grid gap-2.5">
          {feed.map((entry) =>
            entry.kind === "note" ? (
              <div className="max-w-4xl" key={entry.id}>
                <Markdown>{entry.text}</Markdown>
              </div>
            ) : (
              <StepDisclosure key={entry.id} step={entry} />
            ),
          )}
        </div>
      ) : busy ? (
        <p className="text-sm text-muted-foreground">
          {recovering ? "Resuming investigation…" : "Starting investigation…"}
        </p>
      ) : report ? null : (
        <p className="text-sm text-muted-foreground">Waiting for the investigator to respond.</p>
      )}
    </div>
  );
}

export function InvestigationDetail({ live }: { live: InvestigationView }) {
  return <InvestigationBody live={live} />;
}

export function InvestigationDetailByThread({ threadId }: { threadId: string }) {
  const live = useInvestigationSnapshot(threadId);
  return <InvestigationBody live={live} />;
}
