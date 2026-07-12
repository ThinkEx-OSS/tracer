import type {
  EvidenceWindow,
  OperationBucket,
  OperationCheck,
  OperationSummary,
} from "../shared/workspace";
import { fetchProviderJson, ProviderRequestError } from "./http";

const MAX_BUCKETS = 500;

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

const PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

function parseBuckets(response: HogQlResponse, bucketMinutes: number): OperationBucket[] {
  return response.results.map((row) => {
    const bucketValue = row[0];
    if (typeof bucketValue !== "string") {
      throw new ProviderRequestError("PostHog", "PostHog returned an incompatible bucket");
    }

    const from = new Date(bucketValue);
    if (Number.isNaN(from.getTime())) {
      throw new ProviderRequestError("PostHog", "PostHog returned an invalid bucket time");
    }
    const attempts = numberAt(row, 1) ?? 0;
    const successes = numberAt(row, 2) ?? 0;

    return {
      from: from.toISOString(),
      to: new Date(from.getTime() + bucketMinutes * 60 * 1_000).toISOString(),
      summary: {
        attempts,
        successes,
        failures: numberAt(row, 3) ?? 0,
        successRate: attempts === 0 ? null : successes / attempts,
        p50DurationMs: numberAt(row, 4, true),
        p95DurationMs: numberAt(row, 5, true),
      },
    };
  });
}

function eventFilter(check: OperationCheck) {
  if (check.outcome.kind === "property") {
    return `event = ${sqlString(check.outcome.event)} AND ${property(check.outcome.property)} IN (${sqlList([...check.outcome.success, ...check.outcome.failure])})`;
  }
  return `event IN (${sqlList([...check.outcome.success, ...check.outcome.failure])})`;
}

function operationFilter(check: OperationCheck, from: string, to: string) {
  const configuredFilters = Object.entries(check.filters ?? {}).map(([name, value]) => {
    const values = Array.isArray(value) ? value : [value];
    return `${property(name)} IN (${sqlList(values)})`;
  });
  return [
    eventFilter(check),
    ...configuredFilters,
    `timestamp >= toDateTime(${sqlString(from)})`,
    `timestamp < toDateTime(${sqlString(to)})`,
  ].join(" AND ");
}

function aggregation(check: OperationCheck) {
  const outcomes =
    check.outcome.kind === "property"
      ? {
          success: `${property(check.outcome.property)} IN (${sqlList(check.outcome.success)})`,
          failure: `${property(check.outcome.property)} IN (${sqlList(check.outcome.failure)})`,
        }
      : {
          success: `event IN (${sqlList(check.outcome.success)})`,
          failure: `event IN (${sqlList(check.outcome.failure)})`,
        };
  const duration = check.durationProperty
    ? `quantile(0.5)(toFloat(${property(check.durationProperty)})), quantile(0.95)(toFloat(${property(check.durationProperty)}))`
    : "NULL, NULL";
  return `count(), countIf(${outcomes.success}), countIf(${outcomes.failure}), ${duration}`;
}

function bucketQuery(check: OperationCheck, from: string, to: string) {
  if (!Number.isInteger(check.bucketMinutes) || check.bucketMinutes < 1) {
    throw new Error("PostHog bucket size must be a positive whole number of minutes");
  }

  return `SELECT toStartOfInterval(timestamp, INTERVAL ${check.bucketMinutes} MINUTE) AS bucket, ${aggregation(check)} FROM events WHERE ${operationFilter(check, from, to)} GROUP BY bucket ORDER BY bucket ASC LIMIT ${MAX_BUCKETS}`;
}

function summaryQuery(check: OperationCheck, from: string, to: string) {
  return `SELECT ${aggregation(check)} FROM events WHERE ${operationFilter(check, from, to)}`;
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

function parseSummary(response: HogQlResponse): OperationSummary {
  const row = response.results[0];
  if (!row) {
    throw new ProviderRequestError("PostHog", "PostHog returned no operation summary");
  }
  const attempts = numberAt(row, 0) ?? 0;
  const successes = numberAt(row, 1) ?? 0;

  return {
    attempts,
    successes,
    failures: numberAt(row, 2) ?? 0,
    successRate: attempts === 0 ? null : successes / attempts,
    p50DurationMs: numberAt(row, 3, true),
    p95DurationMs: numberAt(row, 4, true),
  };
}

function window(
  from: Date,
  to: Date,
  summary: OperationSummary,
  buckets: OperationBucket[],
): EvidenceWindow {
  return { from: from.toISOString(), to: to.toISOString(), summary, buckets };
}

export async function queryOperationEvidence(
  config: PostHogConfig,
  check: OperationCheck,
  now: Date,
): Promise<OperationEvidence> {
  const currentFrom = new Date(now.getTime() - check.currentWindowMinutes * 60 * 1_000);
  const baselineFrom = new Date(currentFrom.getTime() - check.baselineWindowMinutes * 60 * 1_000);
  const currentFromIso = currentFrom.toISOString();
  const baselineFromIso = baselineFrom.toISOString();
  const nowIso = now.toISOString();
  const [bucketResponse, currentResponse, baselineResponse] = await Promise.all([
    runQuery(config, bucketQuery(check, currentFromIso, nowIso), `Tracer buckets: ${check.id}`),
    runQuery(
      config,
      summaryQuery(check, currentFromIso, nowIso),
      `Tracer current window: ${check.id}`,
    ),
    runQuery(
      config,
      summaryQuery(check, baselineFromIso, currentFromIso),
      `Tracer baseline window: ${check.id}`,
    ),
  ]);

  return {
    current: window(
      currentFrom,
      now,
      parseSummary(currentResponse),
      parseBuckets(bucketResponse, check.bucketMinutes),
    ),
    baseline: window(baselineFrom, currentFrom, parseSummary(baselineResponse), []),
    cached: Boolean(
      bucketResponse.is_cached || currentResponse.is_cached || baselineResponse.is_cached,
    ),
  };
}
