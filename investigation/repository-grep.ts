import { tool } from "ai";
import { z } from "zod";
import { shellQuote } from "./shell";

const MAX_OUTPUT_LINES = 600;
const SEARCH_TIMEOUT_MS = 45_000;
const TRUNCATION_MARKER = "__TRACER_SEARCH_TRUNCATED__";

interface SearchExecutor {
  exec(
    command: string,
    options: { cwd: string; timeout: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * Search the repository in the container where it already lives. Unlike the
 * generic Think workspace grep, this does not enumerate and RPC-read every
 * matching file before searching it.
 */
export function createRepositoryGrepTool(input: {
  executor: () => SearchExecutor;
  repositoryPath: string;
}) {
  return tool({
    description:
      "Search repository file contents with ripgrep. By default this respects ignore files, so dependencies and generated output are skipped. Set includeIgnored only when you intentionally need ignored paths such as node_modules, and narrow include to that subtree.",
    inputSchema: z
      .object({
        query: z.string().min(1).max(4_000).describe("Search pattern (regex by default)"),
        include: z
          .string()
          .min(1)
          .max(2_000)
          .optional()
          .describe('Optional glob such as "src/**/*.ts" or "node_modules/pkg/**/*.js"'),
        fixedString: z.boolean().default(false),
        caseSensitive: z.boolean().default(false),
        contextLines: z.number().int().min(0).max(10).default(0),
        includeIgnored: z
          .boolean()
          .default(false)
          .describe("Include gitignored files. Requires a narrow include glob."),
      })
      .refine((value) => !value.includeIgnored || value.include !== undefined, {
        message: "includeIgnored requires an include glob that scopes the ignored tree",
        path: ["include"],
      }),
    execute: async ({
      query,
      include,
      fixedString,
      caseSensitive,
      contextLines,
      includeIgnored,
    }) => {
      const flags = [
        "--line-number",
        "--with-filename",
        "--color=never",
        "--hidden",
        `--context=${contextLines}`,
        fixedString ? "--fixed-strings" : "",
        caseSensitive ? "--case-sensitive" : "--ignore-case",
        includeIgnored ? "--no-ignore" : "",
        include ? `--glob=${shellQuote(include)}` : "",
      ].filter(Boolean);
      const command = [
        `set -o pipefail; rg ${flags.join(" ")} -- ${shellQuote(query)} .`,
        // Stop returning output once the model has enough evidence. Exiting awk
        // closes the pipe, so ripgrep also stops instead of scanning pointlessly.
        `awk 'NR <= ${MAX_OUTPUT_LINES} { print } NR == ${MAX_OUTPUT_LINES + 1} { print "${TRUNCATION_MARKER}"; exit }'`,
      ].join(" | ");
      const result = await input.executor().exec(command, {
        cwd: input.repositoryPath,
        timeout: SEARCH_TIMEOUT_MS,
      });
      const lines = result.stdout.trimEnd().split("\n");
      const truncated = lines.at(-1) === TRUNCATION_MARKER;
      const output = (truncated ? lines.slice(0, -1) : lines).join("\n");

      // rg uses 1 for no matches. A closed output pipe may also surface as 141
      // after our deliberate result cap; neither is a tool failure.
      const successful = [0, 1, 141].includes(result.exitCode);
      return {
        query,
        include,
        includeIgnored,
        output,
        truncated,
        ...(successful
          ? {}
          : { error: result.stderr.trim() || `ripgrep exited ${result.exitCode}` }),
      };
    },
  });
}
