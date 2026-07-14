import type { Deployment, Resource } from "../shared/workspace";
import { fetchProviderJson, ProviderRequestError } from "./http";

const MAX_DEPLOYMENTS = 10;

interface CloudflareConfig {
  accountId: string;
  apiToken: string;
}

interface CloudflareEnvelope<T> {
  result: T;
}

interface CloudflareGraphqlEnvelope {
  data?: unknown;
  errors?: Array<{ message?: string }>;
}

export interface CloudflareApiResult {
  path: string;
  data: unknown;
}

interface WorkerScript {
  id: string;
  tag: string;
  modified_on: string;
  observability?: { enabled?: boolean };
}

interface WorkerDeployment {
  id: string;
  source: string;
  created_on: string;
  versions: Array<{ version_id?: string }>;
}

interface DeploymentResult {
  deployments: WorkerDeployment[];
}

export interface CloudflareContext {
  resource: Resource;
  deployments: Deployment[];
}

function headers(config: CloudflareConfig) {
  return { Authorization: `Bearer ${config.apiToken}` };
}

function accountApiBase(config: CloudflareConfig) {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}`;
}

/** Read an account-scoped Cloudflare API endpoint without exposing the token to the model. */
export async function queryCloudflareApi(
  config: CloudflareConfig,
  path: string,
): Promise<CloudflareApiResult> {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("..")) {
    throw new Error("Cloudflare API path must be an account-relative path");
  }

  const accountBase = new URL(`${accountApiBase(config)}/`);
  const url = new URL(path.slice(1), accountBase);
  if (url.origin !== accountBase.origin || !url.pathname.startsWith(accountBase.pathname)) {
    throw new Error("Cloudflare API path must remain within the configured account");
  }
  const data = await fetchProviderJson<unknown>("Cloudflare", url.toString(), {
    headers: headers(config),
  });
  return { path: `${url.pathname}${url.search}`, data };
}

/** Query Cloudflare's read-only Analytics GraphQL API. */
export async function queryCloudflareGraphql(
  config: CloudflareConfig,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  if (query.length > 12_000) throw new Error("Cloudflare GraphQL query is too long");
  if (!/^\s*(query\b|\{)/i.test(query) || /\bmutation\b/i.test(query)) {
    throw new Error("Cloudflare investigations only support read-only GraphQL queries");
  }

  const response = await fetchProviderJson<CloudflareGraphqlEnvelope>(
    "Cloudflare",
    "https://api.cloudflare.com/client/v4/graphql",
    {
      method: "POST",
      headers: { ...headers(config), "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    },
  );
  if (response.errors?.length) {
    const graphqlError = response.errors.find((error) => error.message)?.message ?? "unknown error";
    throw new ProviderRequestError("Cloudflare", `Cloudflare GraphQL failed: ${graphqlError}`);
  }
  return response;
}

export async function getCloudflareContext(
  config: CloudflareConfig,
  workerName: string,
): Promise<CloudflareContext> {
  const base = accountApiBase(config);
  const scripts = await fetchProviderJson<CloudflareEnvelope<WorkerScript[]>>(
    "Cloudflare",
    `${base}/workers/scripts`,
    { headers: headers(config) },
  );
  const worker = scripts.result.find((candidate) => candidate.id === workerName);
  if (!worker) {
    throw new ProviderRequestError("Cloudflare", `Cloudflare Worker ${workerName} was not found`);
  }

  const resourceId = `cloudflare:worker:${worker.tag}`;
  const history = await fetchProviderJson<CloudflareEnvelope<DeploymentResult>>(
    "Cloudflare",
    `${base}/workers/scripts/${encodeURIComponent(worker.id)}/deployments`,
    { headers: headers(config) },
  );

  return {
    resource: {
      id: resourceId,
      provider: "cloudflare",
      kind: "worker",
      name: worker.id,
      environment: "production",
      observedAt: worker.modified_on,
      observabilityEnabled: worker.observability?.enabled ?? false,
    },
    deployments: history.result.deployments.slice(0, MAX_DEPLOYMENTS).map((deployment) => ({
      id: `cloudflare:deployment:${deployment.id}`,
      resourceId,
      observedAt: deployment.created_on,
      source: deployment.source,
      versionIds: deployment.versions.flatMap((version) =>
        version.version_id ? [version.version_id] : [],
      ),
    })),
  };
}
