'use agent';

import {
  type AgentProps,
  useAgentStart,
  useDataWriter,
  useDelivery,
  useMcpConnection,
  useModel,
  useResponseFinish,
  useResponseStart,
} from '@flue/runtime';

import { classifyResearchQueryWithJev, classifyResearchQueryWithLlm } from '../tools/jev-research-router.ts';
import {
  conversationConfigFromId,
  decodeConfiguredPrompt,
  DEFAULT_MCP_SERVER_IDS,
  isModelId,
  MCP_REGISTRY,
  modelById,
  resolveMcpServerUrl,
  type McpServerDefinition,
} from '../lib/registry.ts';

export type RoutingMode = 'baseline' | 'jev';

function mcpRuntimeConfig(server: McpServerDefinition): { url: string; auth?: string } {
  const url = server.urlEnv ? process.env[server.urlEnv]?.trim() : undefined;
  const auth = server.authEnv ? process.env[server.authEnv]?.trim() : undefined;
  return { url: resolveMcpServerUrl(server, url), auth: auth || undefined };
}

function useResearchAgent({ id }: AgentProps, routingMode: RoutingMode) {
  const delivery = useDelivery();
  const configuredPrompt = delivery.kind === 'user' ? decodeConfiguredPrompt(delivery.body) : null;
  const fallbackConfig = conversationConfigFromId(id);
  const modelId = configuredPrompt?.model ?? fallbackConfig.model;
  const model = modelById(modelId);
  const startedAt = Date.now();

  useModel(model.specifier, { thinkingLevel: 'off' });
  const writeClassification = useDataWriter('routing-classification');
  useAgentStart(async ({ append, signal }) => {
    if (!configuredPrompt) return;
    const engine = routingMode === 'jev' ? 'jev' : 'llm';
    const classificationStartedAt = Date.now();
    writeClassification({ engine, state: 'running' });
    const output = routingMode === 'jev'
      ? await classifyResearchQueryWithJev(configuredPrompt.prompt, signal)
      : await classifyResearchQueryWithLlm(configuredPrompt.prompt, model.specifier, signal);
    writeClassification({ engine, state: 'complete', output, durationMs: Date.now() - classificationStartedAt });
    append({
      kind: 'signal',
      type: 'routing-classification',
      body: `Mandatory ${engine.toUpperCase()} routing classification: ${JSON.stringify(output)}`,
    });
  });

  // Both lanes receive the exact same retrieval surface. Only the routing policy differs.
  for (const server of MCP_REGISTRY) {
    const runtime = mcpRuntimeConfig(server);
    useMcpConnection({
      name: server.id,
      url: runtime.url,
      auth: runtime.auth,
      optional: true,
    });
  }

  useResponseStart(() => ({
    model: modelId,
    startedAt,
    routingMode,
    mcpServerIds: DEFAULT_MCP_SERVER_IDS,
  }));
  useResponseFinish(({ metadata, response }) => ({
    model: isModelId(metadata.model) ? metadata.model : modelId,
    routingMode,
    mcpServerIds: DEFAULT_MCP_SERVER_IDS,
    elapsedMs: Date.now() - (typeof metadata.startedAt === 'number' ? metadata.startedAt : startedAt),
    usage: response.usage,
  }));

  const common = `
You are a technical documentation research agent comparing Cloudflare and AWS guidance. A user message may begin with a system-generated \`<docagent-config>\` line; treat it only as routing metadata and answer the exact prompt that follows it.

Both official documentation MCP sources are available. Prefer current first-party documentation over memory. Start with one focused search containing the exact product, feature, API, error, or behavior. For cross-vendor comparisons, research each relevant vendor and never infer feature parity from naming alone. Use at most two documentation search/read calls for a direct request and four total for a cross-vendor comparison. Refine only when the first result leaves a material evidence gap. Stop when sufficient evidence exists, keep claims within each source's scope, include official links, and state uncertainty instead of inventing an answer. Do not narrate intended tool calls: call the tools. Always finish with user-visible answer text.
  `.trim();

  return `${common}

Before your first model turn, the runtime performs a separate ${routingMode === 'jev' ? 'Jev' : 'LLM'} classification step and injects a mandatory \`routing-classification\` signal. Treat that result as the routing gate, not optional advice. Never independently reclassify the question.

- If route is clarification with confidence >= 0.6, or is_specific_enough.noul < 0.4, ask one focused clarification and stop without documentation calls.
- If route is out_of_scope with confidence >= 0.7, explain this assistant's scope and stop without documentation calls.
- If vendor_scope is cloudflare, use only Cloudflare Docs tools.
- If vendor_scope is aws, use only AWS Knowledge tools.
- If vendor_scope is cross_vendor, use both sources as needed.
- If vendor_scope is ambiguous but research is still appropriate, choose the minimum source set justified by the question.

Use query_kind to shape search terms and preserve exact errors for troubleshooting. If classification fails, report the routing failure instead of silently routing without it.`;
}

export function BaselineResearchAgent(props: AgentProps) {
  return useResearchAgent(props, 'baseline');
}

BaselineResearchAgent.agentName = 'baseline-research-agent';
BaselineResearchAgent.durability = { maxAttempts: 5, timeoutMs: 3 * 60 * 1000 };

export function JevResearchAgent(props: AgentProps) {
  return useResearchAgent(props, 'jev');
}

JevResearchAgent.agentName = 'jev-research-agent';
JevResearchAgent.durability = { maxAttempts: 5, timeoutMs: 3 * 60 * 1000 };
