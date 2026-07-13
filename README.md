# Tracer

Tracer is ThinkEx's production monitoring and automated investigation service. It evaluates product and infrastructure signals, opens durable incident threads, gathers bounded evidence from PostHog, Cloudflare, GitHub, and the public web, and can publish narrowly scoped fixes as draft pull requests.

The current workspace configuration targets ThinkEx production. Forks and self-hosted deployments should replace the repository, Worker, telemetry, and monitor definitions in `workspace.config.ts` before deployment.

## Architecture

- `agents/workspace-monitor` schedules telemetry checks and owns durable monitor history.
- `agents/incident-thread` runs evidence-backed investigations with durable transcripts.
- `investigation/` contains the sandbox, research tools, persistence, and guarded autofix publisher.
- `providers/` contains bounded provider integrations.
- `src/` contains the monitoring dashboard.

Investigations run inside a Cloudflare Container. Production state is stored in Durable Objects, while privileged provider credentials remain Worker secrets and are never placed in the investigation container.

## Development

Requirements:

- Node.js 24
- pnpm 11
- a Cloudflare account with Workers, Containers, Durable Objects, and Workers AI access

Install dependencies and create local secrets:

```bash
pnpm install
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars`, then run the standard checks:

```bash
pnpm exec vp check
pnpm exec vp build
```

`.dev.vars` and other local environment files are ignored by Git. Never commit provider tokens or production identifiers that are not intended to be public.

## Deployment

Review `workspace.config.ts` and `wrangler.jsonc`, provision every required Worker secret, and deploy with:

```bash
pnpm run deploy
```

The dashboard currently has no application-level authentication. Put it behind an appropriate access-control layer before exposing a deployment that should not be publicly reachable.

## Security

Please follow [SECURITY.md](SECURITY.md) when reporting a vulnerability. Do not include credentials, private telemetry, or customer data in a public issue.
