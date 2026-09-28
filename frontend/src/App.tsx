import { useEffect, useEffectEvent, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useFlueAgent, type FlueConversationMessage } from '@flue/react';
import { createFlueClient } from '@flue/sdk';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  DEFAULT_MCP_SERVER_IDS,
  DEFAULT_MODEL_ID,
  decodeConfiguredPrompt,
  encodeConfiguredPrompt,
  isModelId,
  MODEL_REGISTRY,
  modelById,
  type ModelId,
} from '../../src/lib/registry.ts';
import { messageText, messageTrace } from './activity.ts';

type RunPhase = 'ready' | 'running' | 'complete';

type ComparisonRun = {
  pairId: string;
  prompt: string;
  prompts: string[];
  turnId: string;
  model: ModelId;
  baselineConversationId: string;
  jevConversationId: string;
  phase: RunPhase;
  error?: string;
};

type ComparisonResponse = {
  pairId?: string;
  baselineConversationId?: string;
  jevConversationId?: string;
  error?: string;
};

const MODEL_KEY = 'docagent_comparison_model';
const LAST_RESULT_KEY = 'docagent_comparison_last_result';

const STARTER_PROMPTS = [
  {
    label: 'Cloudflare design',
    prompt: 'How should I design a production Worker with Durable Objects?',
  },
  {
    label: 'AWS security',
    prompt: 'What is the current AWS guidance for securing an S3 bucket?',
  },
  {
    label: 'Cross-vendor',
    prompt: 'Compare Cloudflare Workers and AWS Lambda for an API backend.',
  },
  {
    label: 'Troubleshooting',
    prompt: 'How do I troubleshoot Cloudflare Workers error 1101: Worker threw exception?',
  },
  {
    label: 'Needs clarification',
    prompt: 'How should I configure it for production?',
  },
  {
    label: 'Out of scope',
    prompt: 'Write a short poem about autumn.',
  },
] as const;

function storedModel(): ModelId {
  const value = localStorage.getItem(MODEL_KEY);
  return isModelId(value) ? value : DEFAULT_MODEL_ID;
}

function visibleMessages(messages: FlueConversationMessage[]) {
  return messages.filter((message) => message.display === 'visible' && message.role === 'assistant');
}

function visibleUserPrompt(message: FlueConversationMessage): string {
  const body = messageText(message);
  return decodeConfiguredPrompt(body)?.prompt ?? body;
}

function latestAnswer(messages: FlueConversationMessage[]) {
  return visibleMessages(messages).findLast((message) => messageText(message).trim() || messageTrace(message).length > 0);
}

function laneResult(message: FlueConversationMessage | undefined) {
  if (!message) return null;
  const toolParts = message.parts.filter((part) => part.type === 'dynamic-tool');
  const sourceParts = toolParts.filter((part) => part.type === 'dynamic-tool' && part.toolName.startsWith('mcp__'));
  const metadata = message.metadata ?? {};
  const classifierPart = message.parts.find((part) => part.type === 'data-routing-classification');
  const classifierData = classifierPart?.type === 'data-routing-classification' && classifierPart.data && typeof classifierPart.data === 'object'
    ? classifierPart.data as Record<string, unknown>
    : null;
  const elapsedMs = typeof metadata.elapsedMs === 'number' ? metadata.elapsedMs : null;
  const classificationMs = typeof classifierData?.durationMs === 'number' ? classifierData.durationMs : 0;
  const toolsMs = toolParts.reduce((total, part) => total + (typeof part.durationMs === 'number' ? part.durationMs : 0), 0);
  return {
    answer: messageText(message),
    elapsedMs,
    classificationMs,
    toolsMs,
    modelMs: elapsedMs === null ? null : Math.max(0, elapsedMs - classificationMs - toolsMs),
    toolCalls: toolParts.length + (classifierData ? 1 : 0),
    sourceCalls: sourceParts.length,
    usage: metadata.usage ?? null,
  };
}

type LaneResult = NonNullable<ReturnType<typeof laneResult>>;

const TIMING_PHASES = [
  { key: 'classificationMs', label: 'Classification', className: 'classification' },
  { key: 'toolsMs', label: 'Tools', className: 'tools' },
  { key: 'modelMs', label: 'Model response', className: 'model' },
] as const;

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return '-';
  return durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(2)}s`;
}

function TimingComparison({ baseline, jev }: { baseline: LaneResult; jev: LaneResult }) {
  const maxTotal = Math.max(baseline.elapsedMs ?? 0, jev.elapsedMs ?? 0, 1);
  const totalDifference = baseline.elapsedMs !== null && jev.elapsedMs !== null
    ? baseline.elapsedMs - jev.elapsedMs
    : null;

  function timingRow(lane: 'baseline' | 'jev', result: LaneResult) {
    return (
      <div className="timing-lane">
        <strong><i className={lane} />{lane === 'baseline' ? 'LLM routing' : 'Jev routing'}</strong>
        <div className="timing-track" aria-label={`${lane === 'baseline' ? 'LLM' : 'Jev'} timing breakdown`}>
          {TIMING_PHASES.map((phase) => {
            const duration = result[phase.key] ?? 0;
            return duration > 0 && (
              <span
                className={phase.className}
                style={{ width: `${(duration / maxTotal) * 100}%` }}
                title={`${phase.label}: ${formatDuration(duration)}`}
                key={phase.key}
              />
            );
          })}
        </div>
        <b>{formatDuration(result.elapsedMs)}</b>
      </div>
    );
  }

  return (
    <section className="timing-comparison">
      <header>
        <div><strong>Step timing</strong><span>Latest response, measured end to end</span></div>
        {totalDifference !== null && (
          <p><strong>{totalDifference === 0 ? 'Tie' : totalDifference > 0 ? 'Jev faster' : 'LLM faster'}</strong><span>{totalDifference === 0 ? 'Same total time' : `${formatDuration(Math.abs(totalDifference))} overall`}</span></p>
        )}
      </header>
      <div className="timing-bars">
        {timingRow('baseline', baseline)}
        {timingRow('jev', jev)}
      </div>
      <div className="timing-phases">
        {TIMING_PHASES.map((phase) => (
          <div key={phase.key}>
            <strong><i className={phase.className} />{phase.label}</strong>
            <span><small>LLM</small>{formatDuration(baseline[phase.key])}</span>
            <span><small>Jev</small>{formatDuration(jev[phase.key])}</span>
          </div>
        ))}
      </div>
      <small className="timing-note">Model response is derived from total elapsed time minus recorded classification and tool durations.</small>
    </section>
  );
}

function TurnEvents({ message }: { message: FlueConversationMessage }) {
  const trace = messageTrace(message);
  if (trace.length === 0) return null;

  return (
    <details className="turn-events">
      <summary>Event stream <span>{trace.length}</span></summary>
      <div>
        {trace.map((item) => (
          <section key={item.id} className={item.state}>
            <i />
            <p><strong>{item.label}</strong>{item.detail && <span>{item.detail}</span>}</p>
            {item.durationMs !== undefined && <small>{(item.durationMs / 1000).toFixed(1)}s</small>}
          </section>
        ))}
      </div>
    </details>
  );
}

function LaneCard({
  lane,
  messages,
  status,
  error,
  active,
}: {
  lane: 'baseline' | 'jev';
  messages: FlueConversationMessage[];
  status: string;
  error?: Error | null;
  active: boolean;
}) {
  const message = latestAnswer(messages);
  const turns = visibleMessages(messages).filter((item) => messageText(item).trim() || messageTrace(item).length > 0);
  const turnNumbers = new Map(turns.map((turn, index) => [turn.id, index + 1]));
  const conversation = messages.filter((item) => item.display === 'visible' && (
    (item.role === 'user' && visibleUserPrompt(item).trim())
    || (item.role === 'assistant' && turnNumbers.has(item.id))
  ));
  const result = laneResult(message);
  const running = active || status === 'connecting' || status === 'submitted' || status === 'streaming';
  const title = lane === 'baseline' ? 'LLM routing' : 'Jev routing';

  return (
    <article className={`lane-card ${lane}`}>
      <header className="lane-header">
        <div>
          <span>{lane === 'baseline' ? 'A' : 'B'}</span>
          <div><p>{lane === 'baseline' ? 'Control' : 'Treatment'}</p><h2>{title}</h2></div>
        </div>
        <strong className={running ? 'running' : ''}>{running ? 'Running' : result ? 'Complete' : 'Waiting'}</strong>
      </header>

      {result && (
        <div className="metric-strip">
          <span><small>Time</small>{result.elapsedMs === null ? '-' : `${(result.elapsedMs / 1000).toFixed(1)}s`}</span>
          <span><small>Tools</small>{result.toolCalls}</span>
          <span><small>Docs calls</small>{result.sourceCalls}</span>
        </div>
      )}

      <section className="lane-output" aria-live="polite">
        {error ? (
          <p className="lane-error">{error.message}</p>
        ) : conversation.length > 0 ? (
          <div className="answer-history">
            {conversation.map((item) => item.role === 'user' ? (
              <section className="user-turn" key={item.id}>
                <small>You</small>
                <p>{visibleUserPrompt(item)}</p>
              </section>
            ) : (
              <section className="answer-turn" key={item.id}>
                <small>Response {turnNumbers.get(item.id)}</small>
                {messageText(item).trim() && <ReactMarkdown remarkPlugins={[remarkGfm]}>{messageText(item)}</ReactMarkdown>}
                <TurnEvents message={item} />
              </section>
            ))}
            {running && <div className="lane-loading"><i /><i /><i /><span>Research in progress</span></div>}
          </div>
        ) : running ? (
          <div className="lane-loading"><i /><i /><i /><span>Research in progress</span></div>
        ) : (
          <p className="lane-empty">Submit a question to start a fresh run.</p>
        )}
      </section>

    </article>
  );
}

export function App() {
  const [model, setModel] = useState<ModelId>(storedModel);
  const [input, setInput] = useState('');
  const [run, setRun] = useState<ComparisonRun | null>(null);
  const [creating, setCreating] = useState(false);
  const [uiError, setUiError] = useState('');
  const startedRun = useRef('');

  const baselineUrl = run ? `/api/agents/baseline/${run.baselineConversationId}` : undefined;
  const jevUrl = run ? `/api/agents/jev/${run.jevConversationId}` : undefined;
  const baselineAgent = useFlueAgent({ url: baselineUrl });
  const jevAgent = useFlueAgent({ url: jevUrl });
  const baselineMessage = latestAnswer(baselineAgent.messages);
  const jevMessage = latestAnswer(jevAgent.messages);
  const busy = creating || run?.phase === 'ready' || run?.phase === 'running';
  const selectedModel = modelById(model);

  const executeRun = useEffectEvent(async (current: ComparisonRun) => {
    setRun((value) => value?.pairId === current.pairId ? { ...value, phase: 'running' } : value);
    const messageBody = encodeConfiguredPrompt(current.prompt, current.model, DEFAULT_MCP_SERVER_IDS);

    async function send(url: string, refresh: () => void, lane: 'baseline' | 'jev') {
      const client = createFlueClient({ url });
      const admission = await client.send({
        message: { kind: 'user', body: messageBody },
        idempotencyKey: `${current.pairId}:${current.turnId}:${lane}`,
      });
      refresh();
      await client.wait(admission);
      refresh();
    }

    const outcomes = await Promise.allSettled([
      send(`/api/agents/baseline/${current.baselineConversationId}`, baselineAgent.refresh, 'baseline'),
      send(`/api/agents/jev/${current.jevConversationId}`, jevAgent.refresh, 'jev'),
    ]);
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    const error = failures.length > 0
      ? failures.map((failure) => failure.reason instanceof Error ? failure.reason.message : 'A lane failed.').join(' ')
      : undefined;
    setRun((value) => value?.pairId === current.pairId ? { ...value, phase: 'complete', error } : value);
  });

  useEffect(() => {
    if (!run || run.phase !== 'ready' || startedRun.current === run.turnId) return;
    startedRun.current = run.turnId;
    void executeRun(run);
  }, [run]);

  useEffect(() => {
    if (!run || run.phase !== 'complete') return;
    const baseline = laneResult(baselineMessage);
    const jev = laneResult(jevMessage);
    if (!baseline || !jev) return;
    localStorage.setItem(LAST_RESULT_KEY, JSON.stringify({
      pairId: run.pairId,
      prompts: run.prompts,
      model: run.model,
      completedAt: new Date().toISOString(),
      baseline,
      jev,
    }));
  }, [run, baselineMessage, jevMessage]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const prompt = input.trim();
    if (!prompt || busy) return;
    setCreating(true);
    setUiError('');
    try {
      if (run?.phase === 'complete' && run.model === model) {
        setRun({
          ...run,
          prompt,
          prompts: [...run.prompts, prompt],
          turnId: crypto.randomUUID(),
          phase: 'ready',
          error: undefined,
        });
        setInput('');
        return;
      }

      const response = await fetch('/api/comparisons', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      const body = await response.json() as ComparisonResponse;
      if (!response.ok || !body.pairId || !body.baselineConversationId || !body.jevConversationId) {
        throw new Error(body.error || 'Could not create a fresh comparison run.');
      }
      setRun({
        pairId: body.pairId,
        prompt,
        prompts: [prompt],
        turnId: crypto.randomUUID(),
        model,
        baselineConversationId: body.baselineConversationId,
        jevConversationId: body.jevConversationId,
        phase: 'ready',
      });
      setInput('');
    } catch (error) {
      setUiError(error instanceof Error ? error.message : 'Could not start the comparison.');
    } finally {
      setCreating(false);
    }
  }

  async function stop() {
    const urls = [baselineUrl, jevUrl].filter((value): value is string => Boolean(value));
    const outcomes = await Promise.allSettled(urls.map((url) => createFlueClient({ url }).abort()));
    const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (failure) setUiError(failure.reason instanceof Error ? failure.reason.message : 'Could not stop every lane.');
  }

  function changeModel(next: ModelId) {
    if (busy) return;
    setModel(next);
    localStorage.setItem(MODEL_KEY, next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  const baselineResult = laneResult(baselineMessage);
  const jevResult = laneResult(jevMessage);
  const comparisonComplete = run?.phase === 'complete' && baselineResult && jevResult;
  const continuingConversation = run?.phase === 'complete' && run.model === model;

  return (
    <main className="lab-shell">
      <header className="lab-header">
        <div className="identity"><span>R/02</span><div><p>Routing experiment</p><h1>DocAgent Compare</h1></div></div>
        <div className="source-lock"><i />Cloudflare Docs + AWS Knowledge</div>
      </header>

      <section className="control-board">
        <div className="model-control">
          <label htmlFor="model">Shared model</label>
          <select id="model" value={model} disabled={busy} onChange={(event) => changeModel(event.target.value as ModelId)}>
            {MODEL_REGISTRY.map((option) => <option value={option.id} key={option.id}>{option.name} / {option.provider}</option>)}
          </select>
          <small>{selectedModel.description}</small>
        </div>
        <div className="fairness-note"><strong>Controlled variables</strong><span>Same prompt, reasoning-off answer model, MCPs, retrieval rules, and call budget. Only the classifier differs.</span></div>
      </section>

      <section className="result-grid">
        <LaneCard lane="baseline" messages={baselineAgent.messages} status={baselineAgent.status} error={baselineAgent.error} active={run?.phase === 'running'} />
        <LaneCard lane="jev" messages={jevAgent.messages} status={jevAgent.status} error={jevAgent.error} active={run?.phase === 'running'} />
      </section>

      {comparisonComplete && (
        <TimingComparison baseline={baselineResult} jev={jevResult} />
      )}

      <footer className="prompt-dock">
        {(uiError || run?.error) && <p className="error-banner">{uiError || run?.error}</p>}
        {!run && !input && (
          <section className="starter-prompts" aria-labelledby="starter-prompts-title">
            <div><strong id="starter-prompts-title">Try a scenario</strong><span>Choose a prompt to test a routing situation.</span></div>
            <div>
              {STARTER_PROMPTS.map((starter) => (
                <button type="button" onClick={() => setInput(starter.prompt)} key={starter.label}>
                  <strong>{starter.label}</strong>
                  <span>{starter.prompt}</span>
                </button>
              ))}
            </div>
          </section>
        )}
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="question">{continuingConversation ? 'Follow-up question' : 'New documentation question'}</label>
          <textarea
            id="question"
            value={input}
            rows={3}
            disabled={busy}
            placeholder="Ask about Cloudflare, AWS, or compare both..."
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div>
            <span>{continuingConversation ? 'Continues the current paired conversations.' : 'Starts a fresh paired conversation.'}</span>
            {busy
              ? <button className="stop-button" type="button" onClick={() => void stop()}>Stop run</button>
              : <button className="run-button" type="submit" disabled={!input.trim()}>{continuingConversation ? 'Send follow-up' : 'Run comparison'}</button>}
          </div>
        </form>
      </footer>
    </main>
  );
}
