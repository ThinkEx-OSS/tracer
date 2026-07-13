import type {
  EvidenceWindow,
  MonitorDefinition,
  MonitorSignal,
  MonitorSummary,
} from "../shared/workspace";
import { fetchProviderJson, ProviderRequestError } from "./http";

interface PostHogConfig {
  host: string;
  projectId: string;
  personalApiKey: string;
}

interface HogQlResponse {
  results: unknown[][];
  columns?: string[];
  is_cached?: boolean;
}

export interface PostHogQueryResult {
  columns: string[];
  results: unknown[][];
  cached: boolean;
}

export interface OperationEvidence {
  current: EvidenceWindow;
  baseline: EvidenceWindow;
  cached: boolean;
}

const PROPERTY_NAME = /^\$?[A-Za-z_][A-Za-z0-9_]*$/;

function sqlString(value: string) {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function property(name: string) {
  if (!PROPERTY_NAME.test(name)) throw new Error(`Invalid PostHog property name: ${name}`);
  return `properties.${name}`;
}

function sqlList(values: string[]) {
  if (values.length === 0) throw new Error("PostHog outcome lists cannot be empty");
  return values.map(sqlString).join(", ");
}

function numberAt(row: unknown[], index: number, nullable = false): number | null {
  const value = row[index];
  if (nullable && value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProviderRequestError("PostHog", "PostHog returned an incompatible query result");
  }
  return value;
}

type OperationSignal = Extract<MonitorSignal, { kind: "operation" }>;
type SessionImpactSignal = Extract<MonitorSignal, { kind: "session_impact" }>;

function eventFilter(signal: OperationSignal) {
  if (signal.outcome.kind === "property") {
    return `event = ${sqlString(signal.outcome.event)} AND ${property(signal.outcome.property)} IN (${sqlList([...signal.outcome.success, ...signal.outcome.failure])})`;
  }
  if (signal.outcome.kind === "boolean_property") {
    return `event = ${sqlString(signal.outcome.event)} AND ${property(signal.outcome.property)} IN (true, false)`;
  }
  return `event IN (${sqlList([...signal.outcome.success, ...signal.outcome.failure])})`;
}

function operationFilter(signal: OperationSignal, from: string, to: string) {
  const configuredFilters = Object.entries(signal.filters ?? {}).map(([name, value]) => {
    const values = Array.isArray(value) ? value : [value];
    return `${property(name)} IN (${sqlList(values)})`;
  });
  return [
    eventFilter(signal),
    ...configuredFilters,
    `timestamp >= toDateTime(${sqlString(from)})`,
    `timestamp < toDateTime(${sqlString(to)})`,
  ].join(" AND ");
}

function aggregation(signal: OperationSignal) {
  const outcomes =
    signal.outcome.kind === "property"
      ? {
          success: `${property(signal.outcome.property)} IN (${sqlList(signal.outcome.success)})`,
          failure: `${property(signal.outcome.property)} IN (${sqlList(signal.outcome.failure)})`,
        }
      : signal.outcome.kind === "boolean_property"
        ? {
            success: `${property(signal.outcome.property)} = true`,
            failure: `${property(signal.outcome.property)} = false`,
          }
        : {
            success: `event IN (${sqlList(signal.outcome.success)})`,
            failure: `event IN (${sqlList(signal.outcome.failure)})`,
          };
  const duration = signal.durationProperty
    ? `quantile(0.5)(toFloat(${property(signal.durationProperty)})), quantile(0.95)(toFloat(${property(signal.durationProperty)}))`
    : "NULL, NULL";
  return `count(), countIf(${outcomes.success}), countIf(${outcomes.failure}), ${duration}, maxIf(timestamp, ${outcomes.failure})`;
}

function affectedPredicate(signal: SessionImpactSignal) {
  if (signal.affected.kind === "events") {
    return `event IN (${sqlList(signal.affected.events)})`;
  }
  if (signal.affected.any.length === 0) {
    throw new Error("Session impact numeric conditions cannot be empty");
  }
  const conditions = signal.affected.any
    .map((condition) => `toFloatOrZero(${property(condition.property)}) > ${condition.greaterThan}`)
    .join(" OR ");
  return `event = ${sqlString(signal.affected.event)} AND (${conditions})`;
}

function sessionImpactQuery(signal: SessionImpactSignal, from: string, to: string) {
  const affected = affectedPredicate(signal);
  const relevantEvents =
    signal.affected.kind === "events"
      ? [signal.populationEvent, ...signal.affected.events]
      : [signal.populationEvent, signal.affected.event];
  const window = `timestamp >= toDateTime(${sqlString(from)}) AND timestamp < toDateTime(${sqlString(to)})`;
  return `SELECT count(), countIf(affected = 0), countIf(affected = 1), NULL, NULL, maxIf(latest_failure, affected = 1) FROM (SELECT toString(${property("$session_id")}) AS session_id, countIf(event = ${sqlString(signal.populationEvent)}) > 0 AS population, countIf(${affected}) > 0 AS affected, maxIf(timestamp, ${affected}) AS latest_failure FROM events WHERE ${window} AND event IN (${sqlList(relevantEvents)}) GROUP BY session_id HAVING population AND notEmpty(session_id)) LIMIT 1`;
}

function summaryQuery(monitor: MonitorDefinition, from: string, to: string) {
  return monitor.signal.kind === "operation"
    ? `SELECT ${aggregation(monitor.signal)} FROM events WHERE ${operationFilter(monitor.signal, from, to)}`
    : sessionImpactQuery(monitor.signal, from, to);
}

async function runQuery(config: PostHogConfig, query: string, name: string) {
  const origin = new URL(config.host);
  if (origin.protocol !== "https:") throw new Error("PostHog host must use HTTPS");

  return fetchProviderJson<HogQlResponse>(
    "PostHog",
    `${origin.origin}/api/projects/${encodeURIComponent(config.projectId)}/query/`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.personalApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: { kind: "HogQLQuery", query },
        name,
      }),
    },
  );
}

const READ_ONLY_QUERY = /^\s*(SELECT|WITH)\b/i;
const MUTATING_QUERY = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|ATTACH|DETACH)\b/i;

/** Run a bounded, read-only HogQL query for an investigation. */
export async function queryPostHog(
  config: PostHogConfig,
  query: string,
  purpose: string,
): Promise<PostHogQueryResult> {
  if (query.length > 12_000) throw new Error("PostHog query is too long");
  if (!READ_ONLY_QUERY.test(query) || MUTATING_QUERY.test(query) || query.includes(";")) {
    throw new Error("PostHog investigations only support one read-only SELECT or WITH query");
  }
  if (!/\bLIMIT\s+\d+\b/i.test(query)) {
    throw new Error("PostHog investigation queries must include a LIMIT");
  }

  const response = await runQuery(config, query, `Tracer investigation: ${purpose.slice(0, 120)}`);
  return {
    columns: response.columns ?? [],
    results: response.results.slice(0, 500),
    cached: Boolean(response.is_cached),
  };
}

function parseSummary(response: HogQlResponse): MonitorSummary {
  const row = response.results[0];
  if (!row) {
    throw new ProviderRequestError("PostHog", "PostHog returned no operation summary");
  }
  const attempts = numberAt(row, 0) ?? 0;
  const successes = numberAt(row, 1) ?? 0;
  const failures = numberAt(row, 2) ?? 0;
  const latestFailureValue = row[5];
  const latestFailure =
    failures === 0
      ? null
      : typeof latestFailureValue === "string"
        ? new Date(latestFailureValue)
        : undefined;
  if (latestFailure === undefined || (latestFailure && Number.isNaN(latestFailure.getTime()))) {
    throw new ProviderRequestError("PostHog", "PostHog returned an invalid failure time");
  }

  return {
    attempts,
    successes,
    failures,
    successRate: attempts === 0 ? null : successes / attempts,
    p50DurationMs: numberAt(row, 3, true),
    p95DurationMs: numberAt(row, 4, true),
    latestFailureAt: latestFailure?.toISOString() ?? null,
  };
}

function window(from: Date, to: Date, summary: MonitorSummary): EvidenceWindow {
  return { from: from.toISOString(), to: to.toISOString(), summary };
}

export async function queryMonitorEvidence(
  config: PostHogConfig,
  monitor: MonitorDefinition,
  now: Date,
): Promise<OperationEvidence> {
  const currentFrom = new Date(now.getTime() - monitor.currentWindowMinutes * 60 * 1_000);
  const baselineFrom = new Date(currentFrom.getTime() - monitor.baselineWindowMinutes * 60 * 1_000);
  const currentFromIso = currentFrom.toISOString();
  const baselineFromIso = baselineFrom.toISOString();
  const nowIso = now.toISOString();
  const [currentResponse, baselineResponse] = await Promise.all([
    runQuery(
      config,
      summaryQuery(monitor, currentFromIso, nowIso),
      `Tracer current window: ${monitor.id}`,
    ),
    runQuery(
      config,
      summaryQuery(monitor, baselineFromIso, currentFromIso),
      `Tracer baseline window: ${monitor.id}`,
    ),
  ]);

  return {
    current: window(currentFrom, now, parseSummary(currentResponse)),
    baseline: window(baselineFrom, currentFrom, parseSummary(baselineResponse)),
    cached: Boolean(currentResponse.is_cached || baselineResponse.is_cached),
  };
}
