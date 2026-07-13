import { getSandbox } from "@cloudflare/sandbox";
import { workspaceConfig } from "../workspace.config";
import { shellQuote } from "./shell";

const REPOSITORY_ROOT = "/workspace/repositories";

const DEPENDENCY_INSTALL_TIMEOUT_MS = 600_000;
const WARMUP_TIMEOUT_MS = 30_000;
const CONTAINER_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
const DEPENDENCY_MARKER = "node_modules/.modules.yaml";
const REPOSITORY_READY_MARKER = "/workspace/.tracer-repository-ready";
const DEPENDENCY_INPUTS = [
  ".node-version",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "patches",
];

function sandboxId(threadId: string) {
  const suffix = threadId
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(-49);
  if (!suffix) throw new Error("Investigation thread ID has no DNS-safe characters");
  return `investigation-${suffix}`;
}

export function getInvestigationSandbox(env: Cloudflare.Env, threadId: string) {
  return getSandbox(env.Sandbox, sandboxId(threadId), { sleepAfter: "20m" });
}

export function repositoryPath(repositoryUrl: string) {
  const name = new URL(repositoryUrl).pathname
    .split("/")
    .at(-1)
    ?.replace(/\.git$/, "");
  if (!name) throw new Error("Repository URL has no name");
  return `${REPOSITORY_ROOT}/${name}`;
}

/** Path where the workspace's primary configured repository is checked out. */
export function configuredRepositoryPath() {
  return repositoryPath(workspaceConfig.repositories[0].url);
}

function isContainerStarting(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /starting|unavailable|not ready|not available|container/i.test(message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry an operation while the container is still cold/booting. Only transient
 * "container is starting / unavailable" failures are retried; real errors
 * (e.g. a failed clone) propagate immediately.
 */
async function withContainerRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= CONTAINER_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isContainerStarting(error) || attempt === CONTAINER_RETRY_DELAYS_MS.length) throw error;
      await sleep(CONTAINER_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

/** Block until the container accepts commands, tolerating cold-start latency. */
async function ensureContainerReady(env: Cloudflare.Env, threadId: string) {
  const sandbox = getInvestigationSandbox(env, threadId);
  await withContainerRetry(async () => {
    const result = await sandbox.exec("true", { timeout: WARMUP_TIMEOUT_MS });
    if (result.exitCode !== 0) throw new Error("Container warmup failed");
  });
}

async function ensureDependenciesInstalled(
  sandbox: ReturnType<typeof getInvestigationSandbox>,
  directory: string,
  force = false,
) {
  if (!force && (await sandbox.exists(`${directory}/${DEPENDENCY_MARKER}`)).exists) return;

  const install = await sandbox.exec("CI=true pnpm install --frozen-lockfile", {
    cwd: directory,
    timeout: DEPENDENCY_INSTALL_TIMEOUT_MS,
  });
  if (install.exitCode !== 0) {
    throw new Error(
      `Repository dependency installation failed: ${install.stderr.trim() || install.stdout.trim()}`,
    );
  }

  if (!(await sandbox.exists(`${directory}/${DEPENDENCY_MARKER}`)).exists) {
    throw new Error("Repository dependency installation completed without a pnpm readiness marker");
  }
}

/**
 * Ensure the primary configured repository is ready for investigation at a
 * stable path. The image already contains a shallow checkout and its locked
 * dependencies, so a fresh sandbox only fetches the configured base branch.
 * Dependencies are reinstalled only when package inputs changed. A failed
 * sync/install leaves no marker, so the next turn retries it.
 */
export async function ensureRepositoryReady(env: Cloudflare.Env, threadId: string) {
  const repository = workspaceConfig.repositories[0];
  const directory = repositoryPath(repository.url);
  const sandbox = getInvestigationSandbox(env, threadId);

  await ensureContainerReady(env, threadId);

  if (!(await sandbox.exists(`${directory}/.git`)).exists) {
    throw new Error(`Investigation image is missing its prebuilt repository at ${directory}`);
  }

  const fetch = await sandbox.exec(
    `git fetch --depth 1 --no-tags origin ${shellQuote(repository.baseBranch)}`,
    { cwd: directory, timeout: WARMUP_TIMEOUT_MS },
  );
  if (fetch.exitCode !== 0) {
    throw new Error(`Repository refresh failed: ${fetch.stderr.trim() || fetch.stdout.trim()}`);
  }

  const currentCommit = await sandbox.exec("git rev-parse HEAD", {
    cwd: directory,
    timeout: WARMUP_TIMEOUT_MS,
  });
  const fetchedCommit = await sandbox.exec("git rev-parse FETCH_HEAD", {
    cwd: directory,
    timeout: WARMUP_TIMEOUT_MS,
  });
  if (currentCommit.exitCode !== 0 || fetchedCommit.exitCode !== 0) {
    throw new Error("Repository refresh did not produce a valid commit");
  }

  const preparedCommit = (await sandbox.exists(REPOSITORY_READY_MARKER)).exists
    ? await sandbox.readFile(REPOSITORY_READY_MARKER, { encoding: "utf-8" })
    : undefined;
  if (preparedCommit?.content.trim() === fetchedCommit.stdout.trim()) return directory;

  if (currentCommit.stdout.trim() !== fetchedCommit.stdout.trim()) {
    const dependencyDiff = await sandbox.exec(
      `git diff --quiet HEAD FETCH_HEAD -- ${DEPENDENCY_INPUTS.map(shellQuote).join(" ")}`,
      { cwd: directory, timeout: WARMUP_TIMEOUT_MS },
    );
    if (dependencyDiff.exitCode > 1) {
      throw new Error(`Repository dependency diff failed: ${dependencyDiff.stderr.trim()}`);
    }

    const reset = await sandbox.exec("git reset --hard FETCH_HEAD", {
      cwd: directory,
      timeout: WARMUP_TIMEOUT_MS,
    });
    if (reset.exitCode !== 0) {
      throw new Error(`Repository refresh failed: ${reset.stderr.trim() || reset.stdout.trim()}`);
    }

    const clean = await sandbox.exec("git clean -fd", {
      cwd: directory,
      timeout: WARMUP_TIMEOUT_MS,
    });
    if (clean.exitCode !== 0) {
      throw new Error(`Repository cleanup failed: ${clean.stderr.trim() || clean.stdout.trim()}`);
    }

    await ensureDependenciesInstalled(sandbox, directory, dependencyDiff.exitCode === 1);
  } else {
    await ensureDependenciesInstalled(sandbox, directory);
  }

  await sandbox.writeFile(REPOSITORY_READY_MARKER, fetchedCommit.stdout.trim(), {
    encoding: "utf-8",
  });
  return directory;
}
