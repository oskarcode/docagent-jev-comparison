import { describe, expect, it, vi } from 'vitest';

import {
  classifyResearchQueryWithJev,
  unwrapJevResponse,
  unwrapLlmClassification,
} from '../src/tools/jev-research-router.ts';

describe('Jev response parsing', () => {
  it('unwraps Cloudflare API and nested universal endpoint envelopes', () => {
    const result = { model: 'typesafe/jev', answers: { route: { choice: 'research' } }, usage: {} };
    expect(unwrapJevResponse({ result })).toEqual(result);
    expect(unwrapJevResponse({ result: { result } })).toEqual(result);
  });

  it('rejects malformed responses before they reach the research model', () => {
    expect(() => unwrapJevResponse(null)).toThrow('non-object');
    expect(() => unwrapJevResponse({ result: { model: 'typesafe/jev' } })).toThrow('unexpected response shape');
  });

  it('runs Jev through the Workers AI binding and configured gateway', async () => {
    const result = { model: 'typesafe/jev', answers: { route: { choice: 'research' } } };
    const run = vi.fn().mockResolvedValue(result);
    const signal = new AbortController().signal;

    await expect(classifyResearchQueryWithJev('How do Workers bindings work?', signal, { run } as unknown as Ai, 'test-gateway')).resolves.toEqual(result);
    expect(run).toHaveBeenCalledWith(
      'typesafe/jev',
      expect.objectContaining({ state: 'How do Workers bindings work?' }),
      expect.objectContaining({
        signal,
        gateway: expect.objectContaining({
          id: 'test-gateway',
          skipCache: true,
          collectLog: true,
        }),
      }),
    );
  });
});

describe('LLM classification response parsing', () => {
  const answers = {
    route: { choice: 'research', confidence: 0.9 },
    vendor_scope: { choice: 'cloudflare', confidence: 0.95 },
    query_kind: { choice: 'how_to', confidence: 0.85 },
    is_specific_enough: { noul: 0.92 },
  };

  it('normalizes the OpenAI-compatible response to the Jev contract', () => {
    expect(unwrapLlmClassification({
      choices: [{ message: { content: JSON.stringify(answers) } }],
    }, '@cf/test/model')).toEqual({ model: '@cf/test/model', answers });
  });

  it('rejects malformed or incomplete classifications', () => {
    expect(() => unwrapLlmClassification({ choices: [] }, '@cf/test/model')).toThrow('unexpected response shape');
    expect(() => unwrapLlmClassification({
      choices: [{ message: { content: JSON.stringify({ route: answers.route }) } }],
    }, '@cf/test/model')).toThrow('omitted vendor_scope');
  });
});
