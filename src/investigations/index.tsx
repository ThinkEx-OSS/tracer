import { StatusBadge } from "../components/status-badge";
import { FailureNotice } from "../components/failure-notice";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Empty, EmptyDescription, EmptyHeader } from "../components/ui/empty";
import { Spinner } from "../components/ui/spinner";
import { ChevronRight, Ellipsis, RotateCcw, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { InvestigationSummary } from "../../shared/workspace";
import type { UserFacingFailure } from "../../shared/failure";
import { InvestigationDetail, InvestigationDetailByThread } from "./detail";
import {
  InvestigationTranscriptProvider,
  type TranscriptLoader,
  useInvestigationThread,
} from "./live";
import {
  describeInvestigation,
  describeInvestigationTrigger,
  formatActivityBrief,
  formatOpenedAt,
  investigationStatusBadge,
  VERDICT_PRESENTATION,
  type BadgeVariant,
} from "./model";

export interface PendingInvestigationAction {
  kind: "delete" | "retry";
  threadId: string;
}

function CaseRowHead({
  title,
  trigger,
  status,
  meta,
  expanded,
  bodyId,
  onToggle,
}: {
  title: string;
  trigger: string;
  status: { label: string; variant: BadgeVariant };
  meta: ReactNode;
  expanded: boolean;
  bodyId: string;
  onToggle: () => void;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 max-sm:grid-cols-1 max-sm:items-start">
      <button
        aria-controls={bodyId}
        aria-expanded={expanded}
        className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5 text-left"
        onClick={onToggle}
        type="button"
      >
        <ChevronRight
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform data-[expanded=true]:rotate-90"
          data-expanded={expanded}
        />
        <span className="grid min-w-0 gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <strong className="truncate text-sm font-medium">{title}</strong>
            <StatusBadge variant={status.variant}>{status.label}</StatusBadge>
          </span>
          <span className="w-full truncate text-xs leading-snug text-muted-foreground">
            {trigger}
          </span>
        </span>
      </button>
      <span className="flex min-w-0 items-center justify-end gap-x-3 gap-y-2 max-sm:flex-wrap max-sm:justify-start">
        {meta}
      </span>
    </div>
  );
}

function InvestigationActions({
  investigation,
  onDelete,
  onRetry,
  pendingAction,
}: {
  investigation: InvestigationSummary;
  onDelete: () => void;
  onRetry: () => void;
  pendingAction?: PendingInvestigationAction["kind"];
}) {
  const busy = pendingAction !== undefined;
  const itemClass =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-40";

  return (
    <details
      className="group relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.currentTarget.open = false;
        event.currentTarget.querySelector("summary")?.focus();
      }}
    >
      <summary
        aria-label="Investigation actions"
        aria-disabled={busy}
        aria-haspopup="menu"
        className="inline-flex size-7 list-none items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 group-open:bg-muted [&::-webkit-details-marker]:hidden"
        onClick={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        {busy ? <Spinner /> : <Ellipsis aria-hidden="true" className="size-4" />}
      </summary>
      <div
        className="absolute right-0 z-50 mt-1 min-w-36 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
        role="menu"
      >
        <button
          className={itemClass}
          disabled={investigation.status !== "failed"}
          onClick={(event) => {
            event.currentTarget.closest("details")?.removeAttribute("open");
            onRetry();
          }}
          role="menuitem"
          type="button"
        >
          <RotateCcw aria-hidden="true" className="size-3.5" />
          Retry
        </button>
        <button
          className={`${itemClass} text-red-400 hover:bg-red-500/10 focus-visible:bg-red-500/10`}
          disabled={investigation.status === "investigating"}
          onClick={(event) => {
            event.currentTarget.closest("details")?.removeAttribute("open");
            onDelete();
          }}
          role="menuitem"
          type="button"
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
          Delete
        </button>
      </div>
    </details>
  );
}

function InvestigationError({ failure }: { failure?: UserFacingFailure }) {
  return failure ? <FailureNotice compact failure={failure} /> : null;
}

function StaticInvestigationItem({
  investigation,
  expanded,
  onToggle,
  onDelete,
  onRetry,
  pendingAction,
}: {
  investigation: InvestigationSummary;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onRetry: () => void;
  pendingAction?: PendingInvestigationAction["kind"];
}) {
  const { title } = describeInvestigation(investigation);
  const status = investigationStatusBadge(investigation);
  const bodyId = `case-body-${investigation.threadId}`;

  return (
    <li>
      <div className="overflow-hidden">
        <CaseRowHead
          bodyId={bodyId}
          expanded={expanded}
          meta={
            <>
              <InvestigationError failure={investigation.failure} />
              <span className="text-xs text-muted-foreground">
                {formatOpenedAt(investigation.submittedAt)}
              </span>
              <InvestigationActions
                investigation={investigation}
                onDelete={onDelete}
                onRetry={onRetry}
                pendingAction={pendingAction}
              />
            </>
          }
          onToggle={onToggle}
          status={status}
          title={title}
          trigger={describeInvestigationTrigger(investigation)}
        />
        {expanded ? (
          <div className="border-t bg-background/40" id={bodyId}>
            <InvestigationDetailByThread threadId={investigation.threadId} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

function LiveInvestigationItem({
  investigation,
  expanded,
  onToggle,
  onDelete,
  onRetry,
  pendingAction,
}: {
  investigation: InvestigationSummary;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onRetry: () => void;
  pendingAction?: PendingInvestigationAction["kind"];
}) {
  const live = useInvestigationThread(investigation.threadId);
  const { title } = describeInvestigation(investigation);
  const bodyId = `case-body-${investigation.threadId}`;
  const report = live.timeline.report;
  const activity = formatActivityBrief(live.counts);
  const concluded = Boolean(report) || investigation.status !== "investigating";
  const status = report
    ? VERDICT_PRESENTATION[report.verdict]
    : investigationStatusBadge(investigation);

  let meta: ReactNode;
  if (concluded) {
    meta = (
      <>
        <InvestigationError failure={investigation.failure} />
        {activity ? <span className="text-xs text-muted-foreground">{activity}</span> : null}
        <span className="text-xs text-muted-foreground">
          {formatOpenedAt(investigation.submittedAt)}
        </span>
      </>
    );
  } else if (!expanded) {
    meta = (
      <>
        {activity ? <span className="text-xs text-muted-foreground">{activity}</span> : null}
        <span className="text-xs text-muted-foreground">
          {formatOpenedAt(investigation.submittedAt)}
        </span>
      </>
    );
  } else {
    meta = (
      <>
        <span className="text-xs text-muted-foreground">
          {activity ??
            (live.busy
              ? live.recovering
                ? "Resuming…"
                : "Starting…"
              : "Waiting for investigator…")}
        </span>
        <span className="text-xs text-muted-foreground">
          {formatOpenedAt(investigation.submittedAt)}
        </span>
      </>
    );
  }

  meta = (
    <>
      {meta}
      <InvestigationActions
        investigation={investigation}
        onDelete={onDelete}
        onRetry={onRetry}
        pendingAction={pendingAction}
      />
    </>
  );

  return (
    <li>
      <div className="overflow-hidden">
        <CaseRowHead
          bodyId={bodyId}
          expanded={expanded}
          meta={meta}
          onToggle={onToggle}
          status={concluded ? status : { label: "Investigating", variant: "neutral" }}
          title={title}
          trigger={describeInvestigationTrigger(investigation)}
        />
        {expanded ? (
          <div className="border-t bg-background/40" id={bodyId}>
            <InvestigationDetail live={live} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

function InvestigationItem({
  investigation,
  expanded,
  onToggle,
  onDelete,
  onRetry,
  pendingAction,
}: {
  investigation: InvestigationSummary;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onRetry: () => void;
  pendingAction?: PendingInvestigationAction["kind"];
}) {
  if (investigation.status !== "investigating") {
    return (
      <StaticInvestigationItem
        expanded={expanded}
        investigation={investigation}
        onDelete={onDelete}
        onToggle={onToggle}
        onRetry={onRetry}
        pendingAction={pendingAction}
      />
    );
  }

  return (
    <LiveInvestigationItem
      expanded={expanded}
      investigation={investigation}
      onDelete={onDelete}
      onRetry={onRetry}
      onToggle={onToggle}
      pendingAction={pendingAction}
    />
  );
}

export function Investigations({
  investigations,
  onSimulate,
  simulating,
  error,
  onDelete,
  onRetry,
  pendingAction,
  loadTranscript,
}: {
  error?: UserFacingFailure;
  investigations: InvestigationSummary[];
  loadTranscript: TranscriptLoader;
  onDelete: (threadId: string) => void;
  onRetry: (threadId: string) => void;
  onSimulate: () => void;
  pendingAction?: PendingInvestigationAction;
  simulating: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (threadId: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(threadId)) next.add(threadId);
      return next;
    });
  };

  return (
    <InvestigationTranscriptProvider load={loadTranscript}>
      <section
        aria-labelledby="investigation-title"
        className="flex min-h-64 flex-1 flex-col gap-5"
      >
        <div className="flex items-center justify-between gap-4 max-sm:flex-col max-sm:items-start">
          <div className="grid min-w-0 gap-1">
            <h2 className="text-base font-semibold tracking-tight" id="investigation-title">
              Automated investigations
            </h2>
          </div>
          <Button disabled={simulating} onClick={onSimulate} variant="outline">
            {simulating ? <Spinner data-icon="inline-start" /> : null}
            {simulating ? "Starting drill" : "Run drill"}
          </Button>
        </div>

        {error ? <FailureNotice failure={error} /> : null}

        {investigations.length === 0 ? (
          <Empty className="min-h-40 border bg-card/40">
            <EmptyHeader>
              <EmptyDescription>
                Nothing needs investigation. Monitoring continues in the background.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Card className="gap-0 bg-card/60 py-0 shadow-none">
            <ul aria-label="Investigations" className="divide-y">
              {investigations.map((investigation) => (
                <InvestigationItem
                  expanded={expanded.has(investigation.threadId)}
                  investigation={investigation}
                  key={investigation.threadId}
                  onDelete={() => onDelete(investigation.threadId)}
                  onToggle={() => toggle(investigation.threadId)}
                  onRetry={() => onRetry(investigation.threadId)}
                  pendingAction={
                    pendingAction?.threadId === investigation.threadId
                      ? pendingAction.kind
                      : undefined
                  }
                />
              ))}
            </ul>
          </Card>
        )}
      </section>
    </InvestigationTranscriptProvider>
  );
}
