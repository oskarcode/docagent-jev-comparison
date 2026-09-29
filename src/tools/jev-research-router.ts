const QUESTIONS = {
  route: {
    type: 'choice',
    instructions: 'What should this multi-vendor documentation assistant do with the user question?',
    criteria: {
      research: 'Search official documentation before answering.',
      clarification: 'Ask one focused clarification because essential context is missing.',
      out_of_scope: 'The request is unrelated to Cloudflare, AWS, or technical documentation.',
    },
  },
  vendor_scope: {
    type: 'choice',
    instructions: 'Which official documentation source is needed?',
    criteria: {
      cloudflare: 'Only Cloudflare documentation is needed.',
      aws: 'Only AWS documentation is needed.',
      cross_vendor: 'Both Cloudflare and AWS documentation are needed.',
      ambiguous: 'The vendor cannot be determined reliably from the question.',
    },
  },
  query_kind: {
    type: 'choice',
    instructions: 'Which documentation research style best matches the question?',
    criteria: {
      conceptual: 'Explain a product, feature, concept, or behavior.',
      how_to: 'Provide implementation, configuration, migration, or setup steps.',
      reference: 'Find exact API, CLI, parameter, limit, or schema details.',
      troubleshooting: 'Diagnose an error, failure, unexpected behavior, or performance problem.',
      current_awareness: 'Find recent releases, changes, deprecations, or availability.',
      comparison: 'Compare Cloudflare and AWS products or architectures.',
    },
  },
  is_specific_enough: {
    type: 'noul',
    instructions: 'Is the request specific enough to perform useful documentation research now?',
    criteria: {
      true: 'The product, task, symptom, or desired outcome is sufficiently clear.',
      false: 'Essential context is missing and research would likely answer the wrong question.',
    },
  },
} as const;

const LLM_CLASSIFICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    route: {
      type: 'object',
      additionalProperties: false,
      properties: {
        choice: { type: 'string', enum: ['research', 'clarification', 'out_of_scope'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['choice', 'confidence'],
    },
    vendor_scope: {
      type: 'object',
      additionalProperties: false,
      properties: {
        choice: { type: 'string', enum: ['cloudflare', 'aws', 'cross_vendor', 'ambiguous'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['choice', 'confidence'],
    },
    query_kind: {
      type: 'object',
      additionalProperties: false,
      properties: {
        choice: { type: 'string', enum: ['conceptual', 'how_to', 'reference', 'troubleshooting', 'current_awareness', 'comparison'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['choice', 'confidence'],
    },
    is_specific_enough: {
      type: 'object',
      additionalProperties: false,
      properties: { noul: { type: 'number', minimum: 0, maximum: 1 } },
      required: ['noul'],
    },
  },
  required: ['route', 'vendor_scope', 'query_kind', 'is_specific_enough'],
} as const;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function unwrapJevResponse(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new Error('Jev returned a non-object response.');
  const envelope = isRecord(value.result) ? value.result : value;
  const result = isRecord(envelope.result) ? envelope.result : envelope;
  if (typeof result.model !== 'string' || !isRecord(result.answers)) {
    throw new Error('Jev returned an unexpected response shape.');
  }
  return result;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Jev routing is not configured. Set ${name}.`);
  return value;
}

function parseLlmContent(value: unknown): JsonRecord {
  if (!isRecord(value) || !Array.isArray(value.choices)) throw new Error('LLM classifier returned an unexpected response shape.');
  const first = value.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) throw new Error('LLM classifier returned an unexpected response shape.');
  const content = first.message.content;
  if (isRecord(content)) return content;
  if (typeof content !== 'string') throw new Error('LLM classifier returned no JSON content.');
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new Error('LLM classifier returned invalid JSON content.');
  }
}

export function unwrapLlmClassification(value: unknown, model: string): JsonRecord {
  const answers = parseLlmContent(value);
  for (const key of Object.keys(QUESTIONS)) {
    if (!isRecord(answers[key])) throw new Error(`LLM classifier omitted ${key}.`);
  }
  return { model, answers };
}

export async function classifyResearchQueryWithLlm(state: string, modelSpecifier: string, signal: AbortSignal): Promise<JsonRecord> {
  const accountId = requiredEnv('CLOUDFLARE_ACCOUNT_ID');
  const apiToken = requiredEnv('CLOUDFLARE_API_TOKEN');
  const gatewayId = process.env.JEV_AI_GATEWAY_ID?.trim() || requiredEnv('AI_GATEWAY_ID');
  const model = modelSpecifier.replace(/^cloudflare\//, '');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      'cf-aig-gateway-id': gatewayId,
      'cf-aig-skip-cache': 'true',
      'cf-aig-collect-log': 'true',
      'cf-aig-metadata': JSON.stringify({ application: 'docagent-jev-comparison', component: 'llm-query-router' }),
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `Classify one technical documentation question. Return only JSON matching the supplied schema. Apply these criteria exactly: ${JSON.stringify(QUESTIONS)}`,
        },
        { role: 'user', content: state },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: LLM_CLASSIFICATION_SCHEMA,
      },
    }),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1_000);
    throw new Error(`Cloudflare LLM classification request failed (${response.status}): ${detail}`);
  }

  return unwrapLlmClassification(await response.json(), model);
}

export async function classifyResearchQueryWithJev(
  state: string,
  signal: AbortSignal,
  ai: Ai,
  configuredGatewayId: string,
): Promise<JsonRecord> {
  const gatewayId = process.env.JEV_AI_GATEWAY_ID?.trim() || configuredGatewayId.trim();
  if (!gatewayId) throw new Error('Jev routing is not configured. Set AI_GATEWAY_ID.');

  const response = await ai.run(
    process.env.JEV_MODEL?.trim() || 'typesafe/jev',
    { state, questions: QUESTIONS },
    {
      signal,
      gateway: {
        id: gatewayId,
        skipCache: process.env.JEV_SKIP_CACHE?.trim() !== 'false',
        collectLog: true,
        metadata: { application: 'docagent-jev-comparison', component: 'query-router' },
      },
    },
  );

  return unwrapJevResponse(response);
}
