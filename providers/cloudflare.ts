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

export async function getCloudflareContext(
  config: CloudflareConfig,
  workerName: string,
): Promise<CloudflareContext> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}`;
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
