const DEFAULT_FIRECRAWL_API_URL = "https://api.firecrawl.dev";
const MAX_WEB_SEARCH_SNIPPET_CHARS = 600;

export async function scrapePublicWeb(input: { env: Cloudflare.Env; url: string }) {
  const url = new URL(input.url);
  if (url.protocol !== "https:") throw new Error("Web pages must use HTTPS");

  const response = await firecrawlJsonRequest({
    env: input.env,
    path: "/v2/scrape",
    operation: "Web page retrieval",
    body: JSON.stringify({
      url: url.toString(),
      formats: ["markdown", "links"],
      onlyMainContent: true,
    }),
  });
  const data = getRecordValue(response, "data");
  return {
    markdown: getStringValue(data, "markdown") ?? "",
    links: getStringArrayValue(data, "links"),
  };
}

export async function searchPublicWeb(input: {
  env: Cloudflare.Env;
  query: string;
  limit: number;
  includeDomains?: string[];
}) {
  const response = await firecrawlJsonRequest({
    env: input.env,
    path: "/v2/search",
    operation: "Web search",
    body: JSON.stringify({
      query: input.query,
      limit: input.limit,
      sources: [{ type: "web" }],
      ignoreInvalidURLs: true,
      includeDomains: normalizeHostnameList(input.includeDomains),
    }),
  });
  const data = getRecordValue(response, "data");
  const webResults = getRecordArrayValue(data, "web");

  return {
    results: webResults
      .map((item) => ({
        title:
          getStringValue(item, "title") ??
          getStringValue(getRecordValue(item, "metadata"), "title"),
        url:
          getStringValue(item, "url") ??
          getStringValue(getRecordValue(item, "metadata"), "sourceURL") ??
          getStringValue(getRecordValue(item, "metadata"), "url"),
        snippet: truncateText(
          getStringValue(item, "description") ??
            getStringValue(item, "snippet") ??
            getStringValue(getRecordValue(item, "metadata"), "description"),
          MAX_WEB_SEARCH_SNIPPET_CHARS,
        ),
      }))
      .filter((item) => item.title && item.url),
  };
}

async function firecrawlJsonRequest(input: {
  env: Cloudflare.Env;
  path: string;
  operation: string;
  body: string;
}) {
  const baseUrl = `${input.env.FIRECRAWL_API_URL || DEFAULT_FIRECRAWL_API_URL}/`;
  const response = await fetch(new URL(input.path.replace(/^\/+/, ""), baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.env.FIRECRAWL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: input.body,
  });
  const responseJson = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    throw new Error(
      `${input.operation} failed (${response.status}): ${getFirecrawlErrorMessage(responseJson)}`,
    );
  }

  return responseJson;
}

function getFirecrawlErrorMessage(value: unknown) {
  const error = getRecordValue(value, "error");
  const message = getRecordValue(value, "message");
  if (typeof error === "string") return error;
  if (typeof message === "string") return message;
  return "unknown error";
}

function getRecordValue(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return (value as Record<string, unknown>)[key] ?? null;
}

function getRecordArrayValue(value: unknown, key: string) {
  const field = getRecordValue(value, key);
  return Array.isArray(field) ? field : [];
}

function getStringArrayValue(value: unknown, key: string) {
  return getRecordArrayValue(value, key).filter((item): item is string => typeof item === "string");
}

function getStringValue(value: unknown, key: string) {
  const field = getRecordValue(value, key);
  return typeof field === "string" && field.trim().length > 0 ? field : null;
}

function truncateText(value: string | null, maxLength: number) {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

function normalizeHostnameList(value: string[] | undefined) {
  if (!value || value.length === 0) return undefined;

  const normalized = Array.from(
    new Set(
      value.map((item) => {
        const hostname = item.trim().toLowerCase().replace(/\.$/, "");
        if (!hostname) throw new Error("Domain filters must be non-empty hostnames.");
        if (
          hostname.includes("://") ||
          hostname.includes("/") ||
          hostname.includes("?") ||
          hostname.includes("#")
        ) {
          throw new Error("Domain filters must be hostnames only.");
        }

        new URL(`https://${hostname}`);
        return hostname;
      }),
    ),
  );

  return normalized.length > 0 ? normalized : undefined;
}
