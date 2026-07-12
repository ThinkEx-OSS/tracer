import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { queryCloudflareApi, queryCloudflareGraphql } from "../providers/cloudflare";
import { queryPostHog } from "../providers/posthog";
import { configuredRepositoryPath, getInvestigationSandbox } from "./sandbox";

const SHELL_TIMEOUT_DEFAULT_MS = 120_000;
const SHELL_TIMEOUT_MAX_MS = 600_000;

const MAX_TOOL_OUTPUT_CHARS = 40_000;

function bounded(value: unknown) {
  const json = JSON.stringify(value);
  if (json.length <= MAX_TOOL_OUTPUT_CHARS) return value;
  return {
    truncated: true,
    originalCharacters: json.length,
    content: json.slice(0, MAX_TOOL_OUTPUT_CHARS),
  };
}

export function createInvestigationTools(env: Cloudflare.Env, threadId: string): ToolSet {
  const sandbox = () => getInvestigationSandbox(env, threadId);
  const repositoryPath = configuredRepositoryPath();

  return {
    posthog_query: tool({
      description:
        "Run one read-only HogQL query against the configured PostHog project. Use it to inspect events, properties, cohorts, sessions, errors, and user-impact patterns. Return only the fields needed as evidence and add a LIMIT.",
      inputSchema: z.object({
        query: z.string().min(1),
        purpose: z.string().min(1).max(200),
      }),
      execute: async ({ query, purpose }) =>
        bounded(
          await queryPostHog(
            {
              host: env.POSTHOG_HOST,
              projectId: env.POSTHOG_PROJECT_ID,
              personalApiKey: env.POSTHOG_PERSONAL_API_KEY,
            },
            query,
            purpose,
          ),
        ),
    }),
    cloudflare_api_get: tool({
      description:
        "GET an account-scoped Cloudflare v4 API path. The path begins after /accounts/{account_id}, for example /workers/scripts or /workers/scripts/{name}/deployments. Use for resources, settings, versions, deployments, and other account metadata.",
      inputSchema: z.object({ path: z.string().min(1).max(2_000) }),
      execute: async ({ path }) =>
        bounded(
          await queryCloudflareApi(
            { accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN },
            path,
          ),
        ),
    }),
    cloudflare_graphql: tool({
      description:
        "Run a read-only Cloudflare Analytics GraphQL query. Use accountTag variables for Workers invocations, errors, latency, HTTP traffic, and other analytics datasets. Keep time ranges and selected fields narrow.",
      inputSchema: z.object({
        query: z.string().min(1),
        variables: z.record(z.string(), z.unknown()).default({}),
      }),
      execute: async ({ query, variables }) =>
        bounded(
          await queryCloudflareGraphql(
            { accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN },
            query,
            variables,
          ),
        ),
    }),
    shell: tool({
      description: `Run a shell command in the investigation container — a warm Linux box with a real toolchain, outbound internet, and the configured repository already cloned at ${repositoryPath} (this is the default working directory). Use it to inspect history and dependencies, edit files, and run builds or tests, with generous time budgets for long operations. No PostHog, Cloudflare, or GitHub credentials are present. Never push, deploy, or merge from the container; use the publish_autofix action when a tested fix is ready.`,
      inputSchema: z.object({
        command: z.string().min(1).max(16_000),
        cwd: z.string().default(repositoryPath),
        timeoutMs: z
          .number()
          .int()
          .min(1_000)
          .max(SHELL_TIMEOUT_MAX_MS)
          .default(SHELL_TIMEOUT_DEFAULT_MS),
      }),
      execute: async ({ command, cwd, timeoutMs }) => {
        const result = await sandbox().exec(command, { cwd, timeout: timeoutMs });
        return bounded({
          command,
          cwd,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      },
    }),
  };
}
