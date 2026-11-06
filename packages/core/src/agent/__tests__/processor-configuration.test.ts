import { MockLanguageModelV2, convertArrayToReadableStream } from '@internal/ai-sdk-v5/test';
import { describe, expect, it } from 'vitest';
import type { Processor } from '../../processors/index';
import { isProcessorWorkflow } from '../../processors/index';
import { isProcessor } from '../../workflows';
import { Agent } from '../index';

/**
 * Story: tooling (Studio, the server, durable agents) lists an agent's configured processors to
 * show them, look them up by id, and build the provider-request lane. These listings never call
 * the model, so the agent uses a model id string that is never resolved.
 */

const makeAgent = (config: Record<string, unknown>) =>
  new Agent({
    id: 'processor-configuration-agent',
    name: 'Processor Configuration Agent',
    instructions: 'test',
    model: 'openai/gpt-4o-mini',
    ...config,
  });

const passThroughInput = (id: string): Processor => ({ id, processInput: async ({ messages }: any) => messages });

describe('listConfiguredInputProcessors and listConfiguredOutputProcessors', () => {
  it('returns the configured input processors one by one, not a combined workflow', async () => {
    const agent = makeAgent({ inputProcessors: [passThroughInput('input-proc-1'), passThroughInput('input-proc-2')] });

    const configured = await agent.listConfiguredInputProcessors();

    expect(configured.map(p => p.id)).toEqual(['input-proc-1', 'input-proc-2']);
    expect(configured.map(p => isProcessor(p))).toEqual([true, true]);
    expect(configured.map(p => isProcessorWorkflow(p))).toEqual([false, false]);
  });

  it('returns the configured output processors one by one, not a combined workflow', async () => {
    const output = (id: string): Processor => ({ id, processOutputResult: async ({ messages }: any) => messages });
    const agent = makeAgent({ outputProcessors: [output('output-proc-1'), output('output-proc-2')] });

    const configured = await agent.listConfiguredOutputProcessors();

    expect(configured.map(p => p.id)).toEqual(['output-proc-1', 'output-proc-2']);
    expect(configured.map(p => isProcessor(p))).toEqual([true, true]);
  });

  for (const [label, stateProcessor] of [
    [
      'a state signal processor',
      {
        id: 'state-proc',
        processInput: async ({ messages }: any) => messages,
        computeStateSignal: () => ({ cacheKey: 'state-proc-cache', contents: 'state' }),
      },
    ],
    [
      'a state-signal-only processor',
      { id: 'state-only-proc', computeStateSignal: () => ({ cacheKey: 'state-only-cache', contents: 'state' }) },
    ],
  ] as const) {
    it(`keeps ${label} on the combined input workflow`, async () => {
      const agent = makeAgent({ inputProcessors: [stateProcessor, passThroughInput('input-proc')] });

      const resolved = await agent.listInputProcessors();

      expect(resolved).toHaveLength(1);
      const [workflow] = resolved;
      if (!isProcessorWorkflow(workflow)) throw new Error('expected a combined input processor workflow');
      expect(workflow.__stateSignalProcessors).toEqual([stateProcessor]);
    });
  }

  it('lets resolveProcessorById find a configured input processor', async () => {
    const agent = makeAgent({ inputProcessors: [passThroughInput('findable-processor')] });

    expect((await agent.listConfiguredInputProcessors()).map(p => p.id)).toEqual(['findable-processor']);
    expect((await agent.resolveProcessorById('findable-processor'))?.id).toBe('findable-processor');
  });
});

describe('LLM request lane listing', () => {
  const requestProcessor = (): Processor => ({
    id: 'request-processor',
    processLLMRequest: () => undefined,
    processAPIError: async () => undefined,
  });

  it('lists a processor once when it is both an input and an error processor', async () => {
    const processor = requestProcessor();
    const agent = makeAgent({ inputProcessors: [processor], errorProcessors: [processor] });

    const laneIds = (await agent.__listLLMRequestProcessors()).filter(p => !isProcessorWorkflow(p)).map(p => p.id);

    expect(laneIds.filter(id => id === 'request-processor')).toHaveLength(1);
  });

  it('keeps an error-lane processor out of the input lane', async () => {
    const processor = requestProcessor();
    const agent = makeAgent({ errorProcessors: [processor] });

    expect(await agent.listInputProcessors()).not.toContain(processor);
    expect((await agent.__listLLMRequestProcessors()).map(p => p.id)).toContain('request-processor');
  });

  it('adds the error-phase defaults to the request lane without touching the input lane', async () => {
    const agent = makeAgent({});

    const laneIds = (await agent.__listLLMRequestProcessors()).filter(p => !isProcessorWorkflow(p)).map(p => p.id);
    const inputIds = (await agent.listInputProcessors()).filter(p => !isProcessorWorkflow(p)).map(p => p.id);

    expect(laneIds).toContain('provider-history-compat');
    expect(laneIds).toEqual([...new Set(laneIds)]);
    expect(inputIds).not.toContain('provider-history-compat');
  });
});

describe('input processor override policy', () => {
  it.each([null, 0, 'false'])('refuses a malformed processor-override setting', value => {
    expect(() => makeAgent({ allowInputProcessorOverrides: value })).toThrow(
      'The input processor override setting must be a boolean.',
    );
  });

  it.each([null, false, 'native'])('refuses a malformed title-model resolver', value => {
    expect(() => makeAgent({ resolveTitleModel: value })).toThrow('The title model resolver must be a function.');
  });

  it.each([
    { stream: false, locked: true, replace: true },
    { stream: true, locked: true, replace: true },
    { stream: false, locked: false, replace: true },
    { stream: true, locked: false, replace: true },
    { stream: false, locked: true, replace: false },
    { stream: true, locked: true, replace: false },
  ])(
    'keeps configured input processors when replacements are disabled (stream=$stream, locked=$locked, replace=$replace)',
    async ({ stream, locked, replace }) => {
      let providerCalls = 0;
      const text = 'Processor override reached the model';
      const model = new MockLanguageModelV2({
        doGenerate: async () => {
          providerCalls++;
          return {
            content: [{ type: 'text', text }],
            finishReason: 'stop',
            warnings: [],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
        doStream: async () => {
          providerCalls++;
          return {
            stream: convertArrayToReadableStream([
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text' },
              { type: 'text-delta', id: 'text', delta: text },
              { type: 'text-end', id: 'text' },
              { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
            ]),
          };
        },
      });
      const agent = new Agent({
        id: 'processor-policy-agent',
        name: 'Processor policy agent',
        instructions: 'Answer.',
        model,
        inputProcessors: [
          {
            id: 'configured-policy',
            processLLMRequest: () => {
              throw new Error('Configured input policy ran');
            },
          },
        ],
        ...(locked ? { allowInputProcessorOverrides: false } : {}),
      });
      const options = replace ? { inputProcessors: [] } : undefined;
      const operation = stream
        ? agent.stream('Synthetic request', options).then(result => result.text)
        : agent.generate('Synthetic request', options).then(result => result.text);
      if (locked) {
        await expect(operation).rejects.toThrow(
          replace ? 'Input processor overrides are disabled for this agent.' : 'Configured input policy ran',
        );
        expect(providerCalls).toBe(0);
      } else {
        expect(await operation).toBe(text);
        expect(providerCalls).toBe(1);
      }
    },
  );
});
