import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Text } from "@cloudflare/kumo/components/text";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { InvestigationSummary } from "../../shared/workspace";
import { InvestigationDetail, InvestigationDetailByThread } from "./detail";
import { useInvestigationThread } from "./live";
import {
  describeInvestigation,
  formatActivityBrief,
  formatOpenedAt,
  investigationStatusBadge,
  VERDICT_PRESENTATION,
} from "./model";

function CaseRowHead({
  title,
  origin,
  meta,
  expanded,
  bodyId,
  onToggle,
}: {
  title: string;
  origin: { label: string; variant: "success" | "error" | "warning" | "neutral" };
  meta: ReactNode;
  expanded: boolean;
  bodyId: string;
  onToggle: () => void;
}) {
  return (
    <button
      aria-controls={bodyId}
      aria-expanded={expanded}
      className="case-item-head"
      onClick={onToggle}
      type="button"
    >
      <span aria-hidden="true" className="case-item-caret">
        ▸
      </span>
      <span className="case-item-title">
        <Text as="strong" bold size="sm">
          {title}
        </Text>
        <Badge variant={origin.variant}>{origin.label}</Badge>
      </span>
      <span className="case-item-meta">{meta}</span>
    </button>
  );
}

/** Reported and collapsed — no live connection needed. */
function StaticInvestigationItem({
  investigation,
  expanded,
  onToggle,
}: {
  investigation: InvestigationSummary;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { title, origin } = describeInvestigation(investigation);
  const status = investigationStatusBadge(investigation);
  const bodyId = `case-body-${investigation.threadId}`;

  return (
    <li className="case-item border-kumo-hairline">
      <CaseRowHead
        bodyId={bodyId}
        expanded={expanded}
        meta={
          <>
            <Badge variant={status.variant}>{status.label}</Badge>
            {investigation.error ? <Text variant="secondary">{investigation.error}</Text> : null}
            <Text variant="secondary">{formatOpenedAt(investigation.submittedAt)}</Text>
          </>
        }
        onToggle={onToggle}
        origin={origin}
        title={title}
      />
      {expanded ? (
        <div className="case-item-body border-kumo-hairline" id={bodyId}>
          <InvestigationDetailByThread threadId={investigation.threadId} />
        </div>
      ) : null}
    </li>
  );
}

/** Investigating or expanded — one live connection drives header + body. */
function LiveInvestigationItem({
  investigation,
  expanded,
  onToggle,
}: {
  investigation: InvestigationSummary;
  expanded: boolean;
  onToggle: () => void;
}) {
  const live = useInvestigationThread(investigation.threadId);
  const { title, origin } = describeInvestigation(investigation);
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
        <Badge variant={status.variant}>{status.label}</Badge>
        {investigation.error ? <Text variant="secondary">{investigation.error}</Text> : null}
        {activity ? <Text variant="secondary">{activity}</Text> : null}
        <Text variant="secondary">{formatOpenedAt(investigation.submittedAt)}</Text>
      </>
    );
  } else if (!expanded) {
    meta = (
      <>
        <Badge appearance="dot" variant="neutral">
          Investigating
        </Badge>
        {activity ? <Text variant="secondary">{activity}</Text> : null}
        <Text variant="secondary">{formatOpenedAt(investigation.submittedAt)}</Text>
      </>
    );
  } else {
    meta = (
      <>
        <Text variant="secondary">
          {activity ??
            (live.busy
              ? live.recovering
                ? "Resuming…"
                : "Starting…"
              : "Waiting for investigator…")}
        </Text>
        <Text variant="secondary">{formatOpenedAt(investigation.submittedAt)}</Text>
      </>
    );
  }

  return (
    <li className="case-item border-kumo-hairline">
      <CaseRowHead
        bodyId={bodyId}
        expanded={expanded}
        meta={meta}
        onToggle={onToggle}
        origin={origin}
        title={title}
      />
      {expanded ? (
        <div className="case-item-body border-kumo-hairline" id={bodyId}>
          <InvestigationDetail live={live} />
        </div>
      ) : null}
    </li>
  );
}

function InvestigationItem({
  investigation,
  expanded,
  onToggle,
}: {
  investigation: InvestigationSummary;
  expanded: boolean;
  onToggle: () => void;
}) {
  const needsLive = expanded || investigation.status === "investigating";

  if (!needsLive) {
    return (
      <StaticInvestigationItem
        expanded={expanded}
        investigation={investigation}
        onToggle={onToggle}
      />
    );
  }

  return (
    <LiveInvestigationItem expanded={expanded} investigation={investigation} onToggle={onToggle} />
  );
}

export function Investigations({
  investigations,
  onSimulate,
  simulating,
  error,
}: {
  error?: string;
  investigations: InvestigationSummary[];
  onSimulate: () => void;
  simulating: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const interacted = useRef(false);
  const newestId = investigations[0]?.threadId;

  useEffect(() => {
    if (!interacted.current && newestId) setExpanded(new Set([newestId]));
  }, [newestId]);

  const toggle = (threadId: string) => {
    interacted.current = true;
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(threadId)) next.add(threadId);
      return next;
    });
  };

  return (
    <section aria-labelledby="investigation-title" className="investigations">
      <div className="investigations-head">
        <div className="section-heading">
          <Text as="h2" id="investigation-title" variant="heading3">
            Investigations
          </Text>
          <Text variant="secondary">Evidence, agent activity, and concluded reports</Text>
        </div>
        <div className="investigations-actions">
          <Button loading={simulating} onClick={onSimulate} variant="secondary">
            Run drill
          </Button>
        </div>
      </div>

      {error ? <Text variant="secondary">{error}</Text> : null}

      {investigations.length === 0 ? (
        <div className="empty-state border-kumo-hairline bg-kumo-base">
          <Text variant="secondary">
            Nothing needs investigation. Monitoring continues in the background.
          </Text>
        </div>
      ) : (
        <ul aria-label="Investigations" className="case-list">
          {investigations.map((investigation) => (
            <InvestigationItem
              expanded={expanded.has(investigation.threadId)}
              investigation={investigation}
              key={investigation.threadId}
              onToggle={() => toggle(investigation.threadId)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
