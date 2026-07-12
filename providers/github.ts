import { ProviderRequestError } from "./http";

const API_VERSION = "2026-03-10";
const API_BASE = "https://api.github.com";

interface GitHubRef {
  object: { sha: string };
}

interface GitHubCommit {
  sha: string;
  tree: { sha: string };
}

interface GitHubPullRequest {
  html_url: string;
  number: number;
  head: { ref: string };
}

interface GitHubSha {
  sha: string;
}

export interface GitHubRepository {
  owner: string;
  name: string;
}

export interface GitHubTreeEntry {
  path: string;
  mode: "100644" | "100755";
  type: "blob";
  sha: string | null;
}

function headers(token: string) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "Tracer",
  };
}

async function request<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<{ data?: T; status: number }> {
  const requestHeaders = new Headers(init.headers);
  for (const [name, value] of Object.entries(headers(token))) requestHeaders.set(name, value);
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: requestHeaders,
  });
  if (response.status === 404) return { status: 404 };

  const text = await response.text();
  if (!response.ok) {
    throw new ProviderRequestError(
      "GitHub",
      `GitHub request failed (${response.status}): ${text.slice(0, 500)}`,
    );
  }
  return { data: text ? (JSON.parse(text) as T) : undefined, status: response.status };
}

function repoPath(repository: GitHubRepository, suffix: string) {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}${suffix}`;
}

export function parseGitHubRepository(url: string): GitHubRepository {
  const parsed = new URL(url);
  if (parsed.hostname !== "github.com") throw new Error("Autofix requires a GitHub repository");
  const [owner, rawName] = parsed.pathname.replace(/^\//, "").split("/");
  const name = rawName?.replace(/\.git$/, "");
  if (!owner || !name) throw new Error("Invalid GitHub repository URL");
  return { owner, name };
}

export async function getBranchSha(token: string, repository: GitHubRepository, branch: string) {
  const result = await request<GitHubRef>(
    token,
    repoPath(repository, `/git/ref/heads/${encodeURIComponent(branch)}`),
  );
  return result.data?.object.sha;
}

export async function getCommit(token: string, repository: GitHubRepository, sha: string) {
  const result = await request<GitHubCommit>(
    token,
    repoPath(repository, `/git/commits/${encodeURIComponent(sha)}`),
  );
  if (!result.data) throw new Error(`GitHub commit ${sha} was not found`);
  return result.data;
}

export async function createBlob(token: string, repository: GitHubRepository, content: string) {
  const result = await request<GitHubSha>(token, repoPath(repository, "/git/blobs"), {
    method: "POST",
    body: JSON.stringify({ content, encoding: "utf-8" }),
  });
  if (!result.data) throw new Error("GitHub did not create the blob");
  return result.data.sha;
}

export async function createTree(
  token: string,
  repository: GitHubRepository,
  baseTree: string,
  tree: GitHubTreeEntry[],
) {
  const result = await request<GitHubSha>(token, repoPath(repository, "/git/trees"), {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTree, tree }),
  });
  if (!result.data) throw new Error("GitHub did not create the tree");
  return result.data.sha;
}

export async function createCommit(
  token: string,
  repository: GitHubRepository,
  input: { message: string; parent: string; tree: string },
) {
  const result = await request<GitHubSha>(token, repoPath(repository, "/git/commits"), {
    method: "POST",
    body: JSON.stringify({ message: input.message, parents: [input.parent], tree: input.tree }),
  });
  if (!result.data) throw new Error("GitHub did not create the commit");
  return result.data.sha;
}

export async function createBranch(
  token: string,
  repository: GitHubRepository,
  branch: string,
  sha: string,
) {
  await request(token, repoPath(repository, "/git/refs"), {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  });
}

export async function findOpenPullRequest(
  token: string,
  repository: GitHubRepository,
  branch: string,
) {
  const query = new URLSearchParams({ head: `${repository.owner}:${branch}`, state: "open" });
  const result = await request<GitHubPullRequest[]>(
    token,
    repoPath(repository, `/pulls?${query.toString()}`),
  );
  return result.data?.find((pullRequest) => pullRequest.head.ref === branch);
}

export async function createDraftPullRequest(
  token: string,
  repository: GitHubRepository,
  input: { base: string; body: string; branch: string; title: string },
) {
  const result = await request<GitHubPullRequest>(token, repoPath(repository, "/pulls"), {
    method: "POST",
    body: JSON.stringify({
      base: input.base,
      body: input.body,
      draft: true,
      head: input.branch,
      title: input.title,
    }),
  });
  if (!result.data) throw new Error("GitHub did not create the pull request");
  return result.data;
}
