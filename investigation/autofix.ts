import {
  createBlob,
  createBranch,
  createCommit,
  createDraftPullRequest,
  createTree,
  findOpenPullRequest,
  getBranchSha,
  getCommit,
  parseGitHubRepository,
  type GitHubTreeEntry,
} from "../providers/github";
import { workspaceConfig } from "../workspace.config";
import { getInvestigationSandbox, repositoryPath } from "./sandbox";
import { shellQuote } from "./shell";

const MAX_CHANGED_FILES = 40;
const MAX_FILE_CHARACTERS = 500_000;
const MAX_TOTAL_CHARACTERS = 1_000_000;

function lines(output: string) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function branchName(threadId: string) {
  const suffix = threadId
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 80);
  return `tracer/${suffix || "autofix"}`;
}

async function command(
  sandbox: ReturnType<typeof getInvestigationSandbox>,
  cwd: string,
  value: string,
) {
  const result = await sandbox.exec(value, { cwd, timeout: 120_000 });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Repository command failed: ${value}`);
  }
  return result.stdout.trim();
}

function validatePath(path: string) {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("..") ||
    path.includes("\0") ||
    path === ".git" ||
    path.startsWith(".git/")
  ) {
    throw new Error(`Autofix contains an invalid path: ${path}`);
  }
  if (path === ".github/workflows" || path.startsWith(".github/workflows/")) {
    throw new Error("Autofix cannot modify GitHub Actions workflows");
  }
}

export async function publishAutofix(input: {
  body: string;
  env: Cloudflare.Env;
  threadId: string;
  title: string;
}) {
  const configuredRepository = workspaceConfig.repositories[0];
  const repository = parseGitHubRepository(configuredRepository.url);
  const baseBranch = configuredRepository.baseBranch;
  const branch = branchName(input.threadId);
  const existingPullRequest = await findOpenPullRequest(input.env.GITHUB_TOKEN, repository, branch);
  if (existingPullRequest) {
    return {
      branch,
      pullRequestNumber: existingPullRequest.number,
      status: "already_open" as const,
      url: existingPullRequest.html_url,
    };
  }

  const existingBranchSha = await getBranchSha(input.env.GITHUB_TOKEN, repository, branch);
  if (existingBranchSha) {
    const pullRequest = await createDraftPullRequest(input.env.GITHUB_TOKEN, repository, {
      base: baseBranch,
      body: input.body,
      branch,
      title: input.title,
    });
    return {
      branch,
      pullRequestNumber: pullRequest.number,
      status: "created" as const,
      url: pullRequest.html_url,
    };
  }

  const sandbox = getInvestigationSandbox(input.env, input.threadId);
  const cwd = repositoryPath(configuredRepository.url);
  const [remote, localBase, changedOutput, deletedOutput, untrackedOutput] = await Promise.all([
    command(sandbox, cwd, "git remote get-url origin"),
    command(sandbox, cwd, "git rev-parse HEAD"),
    command(sandbox, cwd, "git diff --no-renames --name-only --diff-filter=ACMRTUXB HEAD"),
    command(sandbox, cwd, "git diff --no-renames --name-only --diff-filter=D HEAD"),
    command(sandbox, cwd, "git ls-files --others --exclude-standard"),
  ]);
  if (remote.replace(/\.git$/, "") !== configuredRepository.url.replace(/\.git$/, "")) {
    throw new Error("Sandbox repository does not match the configured repository");
  }

  const remoteBase = await getBranchSha(input.env.GITHUB_TOKEN, repository, baseBranch);
  if (!remoteBase) throw new Error(`GitHub branch ${baseBranch} was not found`);
  if (localBase !== remoteBase) {
    throw new Error(
      `Sandbox must be rebased onto the latest ${baseBranch} commit before publishing`,
    );
  }

  await command(sandbox, cwd, "git diff --check HEAD");
  const changed = Array.from(new Set([...lines(changedOutput), ...lines(untrackedOutput)])).sort();
  const deleted = Array.from(new Set(lines(deletedOutput))).sort();
  const paths = [...changed, ...deleted];
  if (paths.length === 0) throw new Error("Autofix has no file changes to publish");
  if (paths.length > MAX_CHANGED_FILES) {
    throw new Error(`Autofix changes ${paths.length} files; the limit is ${MAX_CHANGED_FILES}`);
  }
  paths.forEach(validatePath);

  let totalCharacters = 0;
  const blobs = await Promise.all(
    changed.map(async (path) => {
      const mode = await command(
        sandbox,
        cwd,
        `if [ -L ${shellQuote(path)} ]; then exit 2; elif [ -x ${shellQuote(path)} ]; then printf 100755; else printf 100644; fi`,
      );
      const file = await sandbox.readFile(`${cwd}/${path}`, { encoding: "utf-8" });
      if (file.content.includes("\0"))
        throw new Error(`Autofix cannot publish binary file ${path}`);
      if (file.content.length > MAX_FILE_CHARACTERS) {
        throw new Error(`Autofix file ${path} exceeds the size limit`);
      }
      totalCharacters += file.content.length;
      return { path, content: file.content, mode: mode as "100644" | "100755" };
    }),
  );
  if (totalCharacters > MAX_TOTAL_CHARACTERS) {
    throw new Error("Autofix exceeds the total content size limit");
  }

  const baseCommit = await getCommit(input.env.GITHUB_TOKEN, repository, remoteBase);
  const changedEntries = await Promise.all(
    blobs.map(
      async ({ path, content, mode }): Promise<GitHubTreeEntry> => ({
        path,
        mode,
        type: "blob",
        sha: await createBlob(input.env.GITHUB_TOKEN, repository, content),
      }),
    ),
  );
  const deletedEntries: GitHubTreeEntry[] = deleted.map((path) => ({
    path,
    mode: "100644",
    type: "blob",
    sha: null,
  }));
  const tree = await createTree(input.env.GITHUB_TOKEN, repository, baseCommit.tree.sha, [
    ...changedEntries,
    ...deletedEntries,
  ]);
  const commit = await createCommit(input.env.GITHUB_TOKEN, repository, {
    message: `fix: ${input.title}`,
    parent: remoteBase,
    tree,
  });
  await createBranch(input.env.GITHUB_TOKEN, repository, branch, commit);
  const pullRequest = await createDraftPullRequest(input.env.GITHUB_TOKEN, repository, {
    base: baseBranch,
    body: input.body,
    branch,
    title: input.title,
  });
  return {
    branch,
    changedFiles: paths.length,
    commit,
    pullRequestNumber: pullRequest.number,
    status: "created" as const,
    url: pullRequest.html_url,
  };
}
