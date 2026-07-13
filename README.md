<p align="center">
  <img src="public/tracer-mark.svg" alt="Tracer logo" width="96" />
</p>

# Tracer

## How it works

- Monitors product health signals including user frustration, frontend reliability, web performance, file processing, AI turns, and tool usage.
- Opens a durable investigation when it detects a real failure or meaningful change from the baseline.
- Gives the investigator an isolated Linux sandbox with the ThinkEx repository, a full development toolchain, and bounded access to PostHog, Cloudflare, GitHub, and the web.
- Produces an evidence-backed incident report and can open a tested, narrowly scoped draft pull request when the cause is in the code.

## Cloudflare and agent stack

| Technology | Why Tracer uses it |
| --- | --- |
| [Cloudflare Workers](https://developers.cloudflare.com/workers/) | Runs the app and keeps models, telemetry, secrets, and privileged actions behind one trusted boundary. |
| [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) | Adds stateful agents, scheduled checks, RPC, and live client synchronization. |
| [Cloudflare Think](https://github.com/cloudflare/agents/tree/main/packages/think) | Provides the durable investigation loop: tools, memory, queued work, streaming, and recovery. |
| [Durable Objects](https://developers.cloudflare.com/durable-objects/) + SQLite | Persist each monitor and incident thread, including history, transcripts, and reports. |
| [Workers AI](https://developers.cloudflare.com/workers-ai/) | Runs the investigation model (`@cf/moonshotai/kimi-k2.6`) close to the Worker runtime. |
| [Sandbox SDK](https://developers.cloudflare.com/sandbox/) + [Cloudflare Containers](https://developers.cloudflare.com/containers/) | Gives every investigation an isolated Linux machine where it can inspect, edit, build, and test the real repository. |
| [Cloudflare Observability](https://developers.cloudflare.com/workers/observability/) | Records Tracer's own logs and traces for production debugging. |

The investigation container never receives PostHog, Cloudflare, or GitHub credentials. Those remain Worker secrets and are only used by narrow server-side tools and actions.

## Tools and integrations

| Integration | Why Tracer uses it |
| --- | --- |
| PostHog API | Supplies live product evidence through bounded, read-only HogQL queries. |
| Cloudflare REST + GraphQL APIs | Correlate runtime errors and traffic with versions and deployments. |
| Firecrawl | Adds current public documentation and external context to investigations. |
| ThinkEx repository | Lets the agent verify telemetry findings against the code and run real checks. |
| GitHub API | Publishes a tested fix as a guarded draft PR without granting merge or deploy access. |

## Application stack

| Technology | Why Tracer uses it |
| --- | --- |
| React, Base UI, Tailwind CSS, and Lucide | Build the monitoring and live-investigation interface. |
| Vite + Cloudflare Vite plugin | Build the frontend and Worker as one application. |
| AI SDK | Standardize model messages, streaming, and tool execution. |
| Zod | Validate every tool, action, and provider input at runtime. |
| TypeScript, Node.js, and pnpm | Provide one typed toolchain across the app and investigation container. |
| Vite+ | Run repository checks and production builds. |
