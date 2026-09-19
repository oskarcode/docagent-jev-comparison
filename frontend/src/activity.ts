// Flue supplies the persisted message-part shape rendered by the frontend.
import type { FlueConversationMessage } from '@flue/react';

// Registry labels turn internal MCP tool prefixes into readable vendor names.
import { MCP_REGISTRY } from '../../src/lib/registry.ts';

// A trace item is the safe, display-only projection of reasoning or tool activity.
export type ResearchTraceItem = {
  id: string;
  kind: 'reasoning' | 'tool';
  label: string;
  detail: string;
  state: 'running' | 'complete' | 'error';
  durationMs?: number;
};

/**
 * Input:
 * - Untrusted tool-call input from a persisted Flue message part.
 *
 * Output:
 * - One short, safe detail string or an empty string.
 *
 * What this function does:
 * - Extracts only useful request fields and never exposes raw tool output in the UI.
 */
function detailFromInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of ['query', 'search_phrase', 'keywords', 'url', 'name', 'path', 'resource', 'task']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 180);
  }
  return '';
}

/**
 * Input:
 * - Flue's internal tool name.
 *
 * Output:
 * - A readable activity label.
 *
 * What this function does:
 * - Names skill operations directly and maps MCP prefixes to approved registry labels.
 */
function describeTool(toolName: string): string {
  if (toolName === 'classify_research_query') return 'Jev routing decision';
  if (toolName === 'classify_research_query_with_llm') return 'LLM routing decision';
  if (toolName === 'read_skill_resource') return 'Read skill resource';
  const match = /^mcp__([^_]+)__(.+)$/.exec(toolName);
  if (!match) return toolName.replaceAll('_', ' ');
  const server = MCP_REGISTRY.find((candidate) => candidate.id === match[1]);
  const operation = match[2].replaceAll('_', ' ');
  return `${server?.name ?? match[1]}: ${operation}`;
}

function readJevValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of ['choice', 'answer', 'value', 'noul']) {
    const candidate = record[key];
    if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') {
      return String(candidate);
    }
  }
  return '';
}

/** Returns only allowlisted classification fields; probabilities and raw provider output stay private. */
export function jevDecisionSummary(output: unknown): string {
  let parsed = output;
  if (typeof output === 'string') {
    try {
      parsed = JSON.parse(output) as unknown;
    } catch {
      return 'Classification completed';
    }
  }
  if (!parsed || typeof parsed !== 'object') return 'Classification completed';
  const root = parsed as Record<string, unknown>;
  const answers = root.answers && typeof root.answers === 'object'
    ? root.answers as Record<string, unknown>
    : null;
  if (!answers) return 'Classification completed';

  const fields = [
    ['route', 'Route'],
    ['vendor_scope', 'Vendor'],
    ['query_kind', 'Kind'],
    ['is_specific_enough', 'Specific'],
  ] as const;
  const summary = fields.flatMap(([key, label]) => {
    const value = readJevValue(answers[key]);
    return value ? [`${label}: ${value}`] : [];
  });
  return summary.join(' / ') || 'Classification completed';
}

/**
 * Input:
 * - Reasoning text that may include provider-specific think tags.
 *
 * Output:
 * - Clean reasoning text for the expandable Events panel.
 *
 * What this function does:
 * - Removes transport markers without hiding the model's reasoning body.
 */
function reasoningDetail(text: string): string {
  return text.replace(/<\/?think>/gi, '').trim();
}

/**
 * Input:
 * - One Kimi text part containing explicit complete or open think tags.
 *
 * Output:
 * - Separate answer and reasoning strings.
 *
 * What this function does:
 * - Keeps explicit reasoning in Events while leaving user-visible text in the answer lane.
 */
function splitThinking(text: string): { answer: string; reasoning: string } {
  const complete = /^\s*<think>([\s\S]*?)<\/think>/i.exec(text);
  if (complete) return { answer: text.slice(complete[0].length), reasoning: complete[1].trim() };

  const open = /^\s*<think>([\s\S]*)$/i.exec(text);
  if (open) return { answer: '', reasoning: open[1].trim() };

  // Tags inside an answer or code example are user-visible content, not provider transport markers.
  return { answer: text, reasoning: '' };
}

/**
 * Input:
 * - The owning message and one of its text parts.
 *
 * Output:
 * - Stable answer/reasoning ownership for that part.
 *
 * What this function does:
 * - Trusts Flue's structured part types and applies tag parsing only to unstructured Kimi fallback text.
 */
function textProjection(
  message: FlueConversationMessage,
  part: Extract<FlueConversationMessage['parts'][number], { type: 'text' }>,
): { answer: string; reasoning: string } {
  const model = typeof message.metadata?.model === 'string' ? message.metadata.model : '';
  const isKimi = model.startsWith('kimi-');
  const hasStructuredReasoning = message.parts.some((candidate) => candidate.type === 'reasoning');

  // Flue part types are authoritative. Parse only explicit Kimi fallback markers; guessing from
  // lifecycle state or an orphan closing marker can move content between Events and the answer.
  if (message.role === 'assistant' && isKimi && !hasStructuredReasoning) return splitThinking(part.text);
  return { answer: part.text, reasoning: '' };
}

/**
 * Input:
 * - One persisted Flue conversation message.
 *
 * Output:
 * - Sanitized reasoning and tool steps for the collapsible activity panel.
 *
 * What this function does:
 * - Projects only display-safe fields while preserving running, complete, and error states.
 * - Keeps model reasoning inside this explicit diagnostic projection and removes provider markers.
 */
export function messageTrace(message: FlueConversationMessage): ResearchTraceItem[] {
  /**
   * Input:
   * - One message part and its stable position.
   *
   * Output:
   * - Zero or one safe trace rows.
   *
   * What this function does:
   * - Converts only reasoning and dynamic-tool parts while discarding all other part types.
   */
  return message.parts.flatMap<ResearchTraceItem>((part, index) => {
    if (part.type === 'reasoning' && reasoningDetail(part.text)) {
      return [{
        id: `${message.id}:reasoning:${index}`,
        kind: 'reasoning' as const,
        label: 'Reasoning',
        detail: reasoningDetail(part.text),
        state: part.state === 'streaming' ? 'running' as const : 'complete' as const,
      }];
    }
    if (part.type === 'text') {
      const reasoning = textProjection(message, part).reasoning;
      if (!reasoning) return [];
      return [{
        id: `${message.id}:text-reasoning:${index}`,
        kind: 'reasoning' as const,
        label: 'Reasoning',
        detail: reasoning,
        state: part.state === 'streaming' ? 'running' as const : 'complete' as const,
      }];
    }
    if (part.type === 'data-routing-classification') {
      const data = part.data && typeof part.data === 'object' ? part.data as Record<string, unknown> : {};
      const engine = data.engine === 'jev' ? 'Jev' : 'LLM';
      const state = data.state === 'running' ? 'running' : data.state === 'complete' ? 'complete' : 'error';
      return [{
        id: `${message.id}:routing-classification`,
        kind: 'tool' as const,
        label: `${engine} routing decision`,
        detail: state === 'complete' ? jevDecisionSummary(data.output) : 'Classifying the question',
        state,
        durationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined,
      }];
    }
    if (part.type === 'dynamic-tool') {
      const isClassifier = part.toolName === 'classify_research_query'
        || part.toolName === 'classify_research_query_with_llm';
      const detail = isClassifier && part.state === 'output-available'
        ? jevDecisionSummary(part.output)
        : detailFromInput(part.input);
      return [{
        id: part.toolCallId,
        kind: 'tool' as const,
        label: describeTool(part.toolName),
        detail,
        state: part.state === 'input-available'
          ? 'running' as const
          : part.state === 'output-error'
            ? 'error' as const
            : 'complete' as const,
        durationMs: part.state === 'input-available' ? undefined : part.durationMs,
      }];
    }
    return [];
  });
}

/**
 * Input:
 * - One persisted Flue conversation message.
 *
 * Output:
 * - Its visible text parts joined in stream order.
 *
 * What this function does:
 * - Keeps only text emitted after the final tool boundary, preventing pre-tool narration from entering the answer.
 * - Preserves every text part when the response used no tools.
 */
export function messageText(message: FlueConversationMessage): string {
  const lastToolIndex = message.parts.findLastIndex((part) => part.type === 'dynamic-tool');
  return message.parts
    .flatMap((part, index) => part.type === 'text' && index > lastToolIndex ? [part] : [])
    .map((part) => textProjection(message, part).answer)
    .join('');
}
