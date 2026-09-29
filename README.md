# DocAgent Compare

## Start Here (Python/Django Mental Model)

| This project | Django/Python equivalent |
| --- | --- |
| `src/app.ts` Hono Worker | `urls.py` plus middleware and small API views |
| `src/agents/research-agent.ts` | Durable async service/task orchestration |
| `frontend/src/App.tsx` | Django template plus a browser-side controller and state |
| `src/lib/registry.ts` | Typed settings and allowlists |
| `wrangler.jsonc` | `settings.py` plus hosting and migration manifest |

## What You Actually Maintain

1. `frontend/src/App.tsx` for comparison lifecycle, UI state, and timing.
2. `src/agents/research-agent.ts` for shared agent behavior and lane fairness.
3. `src/tools/jev-research-router.ts` for both classifier contracts and integrations.
4. `src/lib/registry.ts` for supported answer models and documentation MCPs.

## What This Project Does

DocAgent Compare is a side-by-side comparison surface for two Flue documentation-research strategies:

| Lane | Routing behavior |
| --- | --- |
| LLM routing | A separate call to the selected Workers AI model classifies route, vendor, query kind, and specificity before research. |
| Jev routing | The Workers AI binding runs `typesafe/jev` to produce the same classification contract before research. |

Both lanes use the same visible question, non-reasoning answer model, MCP connections, classification contract, retrieval rules, call budget, and answer rules. The experimental variable is the classification engine: LLM or Jev.

## Architecture At A Glance

```text
React browser UI
  -> Hono Worker API
  -> baseline and Jev Flue Durable Objects
  -> AI Gateway / Workers AI classification and answer models
  -> Cloudflare Docs and AWS Knowledge MCP servers
  -> streamed answers, activity, and timing comparison
```

## Traffic Flow (Input -> Output)

1. The browser requests fresh baseline and Jev IDs from `POST /api/comparisons`.
2. The browser sends the exact prompt to both Flue agents.
3. Follow-up questions reuse the same paired agent IDs. Each lane retains its own context, which may diverge after the first answer.
4. Flue streams answer and tool events while the browser computes elapsed time and call counts.
5. The latest completed result and model preference are stored in browser local storage.
6. The comparison shows classification, documentation-tool, derived model-response, and total timing for both lanes.

Flue Durable Objects retain each paired conversation for reliable execution and streaming. Routing and documentation-call budgets are agent instructions rather than runtime-enforced capabilities.

## Hosting and Deployment

- Runtime: Cloudflare Worker, Workers Assets, and two Flue Durable Object classes.
- Deploy command: `npm run deploy`.
- Environments: local Wrangler/Vite development and the configured Cloudflare account.
- Generated deployment inputs: `dist/`, `dist-web/`, and the patched generated Wrangler file.

Configure `CLOUDFLARE_ACCOUNT_ID` and the `CLOUDFLARE_API_TOKEN` Wrangler secret for the LLM classifier before deployment. The Jev classifier uses the Workers AI binding. This project has separate Worker and Durable Object names from the production DocAgent.

Before exposing it publicly, place the Worker behind Cloudflare Access or another authentication boundary. The intentionally simple comparison API does not implement user accounts or application-level rate limiting.

## Quick Start

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
# In a second terminal for React HMR:
npm run dev:web
```

Required `.dev.vars` values for the LLM classifier lane:

```text
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
```

The token requires **Account > Workers AI > Read**. Optional MCP bearer-token fields are documented in `.dev.vars.example`.

Validation:

```bash
npm run check
```

## Security Model

- Auth boundary: not implemented in application code; use Cloudflare Access before public exposure.
- Secrets: `CLOUDFLARE_API_TOKEN` and optional MCP bearer tokens remain server-side.
- Network safety: MCP endpoint overrides must use HTTPS.
- UI diagnostics: raw MCP output is excluded from the rendered event trace.

## APIs and Interfaces

- `GET /api/health`: basic Worker health response.
- `POST /api/comparisons`: validates a model ID and returns fresh baseline/Jev conversation IDs.
- `/api/agents/baseline/:conversationId`: Flue control-lane conversation routes.
- `/api/agents/jev/:conversationId`: Flue treatment-lane conversation routes.

## Troubleshooting Jump Table

- If classification fails, check the LLM credentials, Workers AI binding, AI Gateway configuration, and `src/tools/jev-research-router.ts`.
- If the UI cannot reach the API locally, run both `npm run dev` and `npm run dev:web`.
- If the wrong documentation source is called, inspect the lane event stream and the routing signal.
- If deployment misses the SPA, inspect `scripts/prepare-deploy.mjs` and the generated Wrangler config.
