import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { scrapePublicWeb, searchPublicWeb } from "../providers/firecrawl";

const MAX_WEB_RESULT_CHARS = 100_000;

const webSearchInputSchema = z.object({
  query: z.string().trim().min(1).describe("Topic or question to search for."),
  limit: z.number().int().min(1).max(25).optional().describe("Maximum results to return."),
  include_domains: z
    .array(z.string().trim().min(1))
    .max(20)
    .optional()
    .describe("Optional hostnames to restrict results to."),
});

const webPageInputSchema = z.object({
  url: z.url().describe("Public HTTPS URL to retrieve."),
});

export function createInvestigationWebTools(env: Cloudflare.Env): ToolSet {
  return {
    web_search: tool({
      description: "Find relevant public web pages for a topic or question.",
      inputSchema: webSearchInputSchema,
      strict: true,
      execute: ({ query, limit, include_domains }) =>
        searchPublicWeb({
          env,
          query,
          limit: limit ?? 8,
          includeDomains: include_domains,
        }),
    }),
    web_markdown: tool({
      description: "Load a public webpage and return its rendered content as Markdown.",
      inputSchema: webPageInputSchema,
      strict: true,
      execute: async ({ url }) => {
        const page = await scrapePublicWeb({ env, url });
        return truncateMarkdown(page.markdown);
      },
    }),
    web_links: tool({
      description: "Load a public webpage and return its rendered links.",
      inputSchema: webPageInputSchema,
      strict: true,
      execute: async ({ url }) => {
        const page = await scrapePublicWeb({ env, url });
        return truncateLinks(page.links);
      },
    }),
  };
}

function truncateMarkdown(content: string) {
  return {
    content: content.slice(0, MAX_WEB_RESULT_CHARS),
    truncated: content.length > MAX_WEB_RESULT_CHARS,
  };
}

function truncateLinks(items: string[]) {
  const result: string[] = [];
  let size = 2;

  for (const item of items) {
    const itemSize = JSON.stringify(item).length + (result.length === 0 ? 0 : 1);
    if (size + itemSize > MAX_WEB_RESULT_CHARS) {
      return { items: result, truncated: true };
    }
    result.push(item);
    size += itemSize;
  }

  return { items, truncated: false };
}
