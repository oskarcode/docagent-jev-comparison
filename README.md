# DocAgent Compare

DocAgent Compare tests whether Jev or an LLM produces better routing decisions for technical documentation research. It sends the same question through two isolated Flue conversations, gives both lanes the same answer model and official documentation tools, and displays their answers, tool activity, and timing side by side.

## What It Does

- Compares LLM-based routing with `typesafe/jev` classification under controlled conditions.
- Researches current Cloudflare and AWS documentation through MCP servers.
- Preserves independent conversation history for follow-up questions in both lanes.
- Shows classification, documentation-tool, derived model-response, and total timing.

## How It Works

1. The React UI requests paired conversation IDs from `POST /api/comparisons`.
2. It sends the same configured prompt to the LLM and Jev Flue agents concurrently.
3. Each classifier returns the same routing contract: route, vendor scope, query kind, and specificity.
4. Both agents use the same answer model, MCP connections, retrieval rules, and call budget.
5. Flue streams each answer and trace to the UI, which derives the comparison metrics.

## Technology Stack

| Technology | Role |
| --- | --- |
| Cloudflare Workers | Hosts the API, agent routers, and static React application. |
| Flue | Runs durable agent conversations and streams messages and tool events. |
| Workers AI and AI Gateway | Run the answer model plus LLM and Jev classification requests. |
| Hono | Defines health checks, comparison creation, middleware, and agent mounts. |
| React and Vite | Build the comparison interface and local development experience. |
| Cloudflare Docs and AWS Knowledge MCPs | Provide current first-party documentation. |

## Project Structure

| Path | Purpose |
| --- | --- |
| `frontend/src/App.tsx` | Comparison lifecycle, Flue clients, UI state, timing, and rendering. |
| `frontend/src/activity.ts` | Converts Flue message parts into safe answer and trace projections. |
| `src/app.ts` | Worker entrypoint, middleware, pair creation, and agent routers. |
| `src/agents/research-agent.ts` | Shared research behavior and lane-specific classifier selection. |
| `src/tools/jev-research-router.ts` | Matching LLM and Jev classification contracts and API calls. |
| `src/lib/registry.ts` | Approved answer models, MCP servers, and prompt configuration encoding. |
| `test/` | Unit tests for activity projection, classifiers, and registries. |
| `wrangler.jsonc` | Worker, assets, AI, Durable Object, migration, and observability configuration. |

## APIs and Interfaces

| Interface | Purpose |
| --- | --- |
| `GET /api/health` | Returns basic Worker and framework health metadata. |
| `POST /api/comparisons` | Validates a model and returns a pair ID plus two fresh conversation IDs. |
| `/api/agents/baseline/:conversationId` | Flue protocol routes for the LLM-routing control lane. |
| `/api/agents/jev/:conversationId` | Flue protocol routes for the Jev-routing treatment lane. |

## Run It Locally

Prerequisites: Node.js 22 or newer, npm, a Cloudflare account, an AI Gateway, and a token with **Account > Workers AI > Read**.

```bash
npm install
cp .dev.vars.example .dev.vars
```

Set these values in the untracked `.dev.vars` file:

```text
CLOUDFLARE_ACCOUNT_ID=<YOUR_ACCOUNT_ID>
CLOUDFLARE_API_TOKEN=<YOUR_WORKERS_AI_TOKEN>
```

Start the Worker and, optionally, the separate React HMR server:

```bash
npm run dev
npm run dev:web
```

Validate the project with:

```bash
npm run check
```

## Deploy Your Own Copy

1. Replace `AI_GATEWAY_ID` in `wrangler.jsonc` with your AI Gateway ID.
2. Add production values without committing them:

```bash
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put CLOUDFLARE_API_TOKEN
```

3. Deploy the Worker, assets, and generated Flue Durable Objects:

```bash
npm run deploy
```

## Security Notes

- The application does not implement user authentication or application-level rate limiting. Put public deployments behind Cloudflare Access or another authentication boundary.
- API tokens and optional MCP bearer tokens are server-side secrets and must never be committed.
- MCP endpoint overrides must use HTTPS before credentials are attached.
- The comparison creation endpoint accepts only models from the registry allowlist and limits agent request bodies to 20 KB.
- Routing and documentation-call budgets are agent instructions rather than runtime-enforced capabilities.

## Customize It

| Goal | File |
| --- | --- |
| Add or remove an answer model | `src/lib/registry.ts` |
| Change classifier questions or schema | `src/tools/jev-research-router.ts` |
| Change shared research instructions | `src/agents/research-agent.ts` |
| Add a metric or change comparison behavior | `frontend/src/App.tsx` |
| Change event labels or trace projection | `frontend/src/activity.ts` |
| Change Worker bindings or deployment settings | `wrangler.jsonc` |

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Classification request fails | Confirm `.dev.vars`, token permissions, and AI Gateway configuration, then inspect `src/tools/jev-research-router.ts`. |
| Browser cannot reach the local API | Run `npm run dev`; when using React HMR, also run `npm run dev:web`. |
| Wrong documentation source is called | Inspect the routing signal and MCP events produced by `src/agents/research-agent.ts`. |
| SPA is missing after deployment | Run `npm run check` and inspect `scripts/prepare-deploy.mjs` plus the generated Wrangler config. |
| Type or test validation fails | Run `npm run check:types` and `npm test` separately for focused output. |

## Official References

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)
- [Cloudflare Workers AI models](https://developers.cloudflare.com/workers-ai/models/)
- [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)

## License

No license is currently included. All rights are reserved unless a license is added later.
