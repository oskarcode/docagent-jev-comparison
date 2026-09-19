import { env as workerEnv } from 'cloudflare:workers';
import { setProvider } from '@flue/runtime';
import { cloudflareBindingProvider } from '@flue/runtime/cloudflare/workers-ai';
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';

import { BaselineResearchAgent, JevResearchAgent } from './agents/research-agent.ts';
import { DEFAULT_MCP_SERVER_IDS, encodeMcpMask, isModelId } from './lib/registry.ts';

type Bindings = {
  AI: Ai;
  AI_GATEWAY_ID: string;
};

const bindings = workerEnv as unknown as Bindings;
setProvider(cloudflareBindingProvider({
  binding: bindings.AI,
  gateway: { id: bindings.AI_GATEWAY_ID || 'default' },
  streamIdleTimeoutMs: 5 * 60 * 1000,
}));

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
});

app.use('/api/agents/*', async (c, next) => {
  const contentLength = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > 20_000) {
    return c.json({ error: 'The request body is too large.' }, 413);
  }
  await next();
});

app.get('/api/health', (c) => c.json({
  ok: true,
  framework: 'flue',
  comparisonOnly: true,
}));

app.post('/api/comparisons', async (c) => {
  const body: { model?: unknown } = await c.req.json<{ model?: unknown }>().catch(() => ({}));
  if (!isModelId(body.model)) return c.json({ error: 'Select a supported model.' }, 400);

  const prefix = `${body.model}.${encodeMcpMask(DEFAULT_MCP_SERVER_IDS)}`;
  const baselineConversationId = `${prefix}.${crypto.randomUUID()}`;
  const jevConversationId = `${prefix}.${crypto.randomUUID()}`;

  return c.json({
    pairId: crypto.randomUUID(),
    model: body.model,
    baselineConversationId,
    jevConversationId,
  }, 201);
});

const baselinePrefix = '/api/agents/baseline';
const jevPrefix = '/api/agents/jev';
app.route(baselinePrefix, createAgentRouter(BaselineResearchAgent));
app.route(jevPrefix, createAgentRouter(JevResearchAgent));

export default app;
