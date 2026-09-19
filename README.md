# DocAgent Compare

DocAgent Compare is a stateless comparison surface for two Flue documentation-research strategies:

| Lane | Routing behavior |
| --- | --- |
| LLM routing | A separate call to the selected Workers AI model classifies route, vendor, query kind, and specificity before research. |
| Jev routing | A separate call to `typesafe/jev` produces the same classification contract before research. |

Both lanes use the same visible question, non-reasoning answer model, MCP connections, classification contract, retrieval rules, call budget, and answer rules. The experimental variable is the classification engine: LLM or Jev.

## Runtime

1. The browser requests fresh baseline and Jev IDs from `POST /api/comparisons`.
2. The browser sends the exact prompt to both Flue agents.
3. Follow-up questions reuse the same paired agent IDs so both lanes retain equivalent conversation context.
4. Flue streams answer and tool events while the browser computes elapsed time and call counts.
5. The latest completed result and model preference are stored in browser local storage.
6. The comparison supports a human verdict and JSON export.

Flue Durable Objects retain each paired conversation for reliable execution and streaming. The UI marks either lane invalid when its matching classifier was not the first successful tool call.

## Development

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Required `.dev.vars` values for the Jev lane:

```text
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
```

The token requires **Account > Workers AI > Read**. Optional MCP bearer-token fields are documented in `.dev.vars.example`.

Validation:

```bash
npm run check
```

## Deployment

Set `CLOUDFLARE_ACCOUNT_ID` as a Worker variable and `CLOUDFLARE_API_TOKEN` as a Wrangler secret. Then run:

```bash
npm run deploy
```

This project has separate Worker and Durable Object names from the production DocAgent.

Before exposing it publicly, place the Worker behind Cloudflare Access or another authentication boundary. The intentionally simple comparison API does not implement user accounts or application-level rate limiting.
