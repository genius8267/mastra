import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@mastra/core/agent';
import { AGENT_CONTROLLER_SUBAGENT_CONTEXT_KEY } from '@mastra/core/agent-controller';
import type { GatewayLanguageModel } from '@mastra/core/llm';
import { RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import { Workspace } from '@mastra/core/workspace';
import { LibSQLStore } from '@mastra/libsql';
import { ObservationalMemory } from '@mastra/memory/processors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthStorage } from '../auth/storage.js';
import { createMastraCodeAgentController } from '../index.js';
import type { MastraCodeAgentController, MastraCodeConfig } from '../index.js';
import * as nativeGateway from './mastracode-gateway.js';
import { getDynamicMemory } from './memory.js';
import type { MastraCodeModelPolicy, MastraCodeModelRole } from './model-policy.js';
import { getDynamicModel, getGoalJudgeModel, resolveModel } from './model.js';

const binding = Object.freeze({
  workspaceId: 'workspace-a',
  actorId: 'actor-a',
  payerId: 'payer-a',
  factoryId: 'factory-a',
  sessionId: 'session-a',
  repository: 'synthetic/repository-a',
});
type RawModel = Extract<GatewayLanguageModel, { specificationVersion: 'v2' }>;

function textModel(text: string, calls: string[]): RawModel {
  return {
    specificationVersion: 'v2',
    provider: 'host-fixture',
    modelId: 'host-owned',
    supportedUrls: {},
    doGenerate: async options => {
      calls.push(JSON.stringify(options.prompt));
      return {
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        warnings: [],
      };
    },
    doStream: async options => {
      calls.push(JSON.stringify(options.prompt));
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'text' });
            controller.enqueue({ type: 'text-delta', id: 'text', delta: text });
            controller.enqueue({ type: 'text-end', id: 'text' });
            controller.enqueue({
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            });
            controller.close();
          },
        }),
      };
    },
  };
}

function context(state: Record<string, unknown> = {}) {
  const requestContext = new RequestContext();
  requestContext.set('hostBinding', binding);
  requestContext.set('controller', {
    threadId: 'thread-a',
    resourceId: 'resource-a',
    session: { modelId: 'host/requested', id: 'session-a' },
    getState: () => state,
    state,
  });
  return requestContext;
}

async function answer(model: ReturnType<typeof resolveModel>, requestContext: RequestContext, stream = false) {
  const agent = new Agent({ id: 'policy-test', name: 'Policy test', instructions: 'Answer.', model, maxRetries: 0 });
  if (stream) {
    const result = await agent.stream('Synthetic request', { requestContext });
    try {
      return await result.text;
    } finally {
      await result.consumeStream();
    }
  }
  return (await agent.generate('Synthetic request', { requestContext })).text;
}

let nativeReload: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // An accidental native route must fail before it can inspect a real credential file.
  nativeReload = vi.spyOn(nativeGateway, 'reloadAuthStorage').mockImplementation(() => {
    throw new Error('Native credential resolution is forbidden in policy tests.');
  });
});
afterEach(() => vi.restoreAllMocks());

describe('host model policy', () => {
  it.each([false, true])(
    'governs a selected goal judge without enabling an omitted judge (selected=%s)',
    async configured => {
      const directory = mkdtempSync(join(tmpdir(), 'mastracode-policy-judge-'));
      const settingsPath = join(directory, 'settings.json');
      writeFileSync(
        settingsPath,
        JSON.stringify({ models: { goalJudgeModel: configured ? 'host/judge' : undefined } }),
      );
      const requestContext = context();
      const calls: string[] = [];
      const decisions: string[] = [];
      try {
        const selected = getGoalJudgeModel({ requestContext }, settingsPath, args => {
          expect(args.requestContext.get('hostBinding')).toBe(binding);
          decisions.push(`${args.role}:${args.modelId}`);
          return textModel('Host judgment', calls);
        });
        if (configured) {
          if (!selected) throw new Error('The configured judge was not selected');
          expect(await answer(selected, requestContext)).toBe('Host judgment');
          expect(decisions).toEqual(['main:host/judge']);
          expect(calls).toHaveLength(1);
        } else {
          expect(selected).toBeUndefined();
          expect(decisions).toEqual([]);
          expect(calls).toEqual([]);
        }
        expect(nativeReload).not.toHaveBeenCalled();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])('authorizes each actual main call, including a reused model (stream=%s)', async stream => {
    const calls: string[] = [];
    const decisions: string[] = [];
    let allowed = true;
    const requestContext = context();
    const modelPolicy: MastraCodeModelPolicy = args => {
      expect(args.requestContext.get('hostBinding')).toBe(binding);
      decisions.push(`${args.role}:${args.modelId}`);
      if (!allowed) throw new Error('Host authorization expired');
      return textModel('Host answer', calls);
    };
    const selected = getDynamicModel({ requestContext }, undefined, { modelPolicy });
    expect(Array.isArray(selected)).toBe(false);
    const model = resolveModel('host/requested', { requestContext, modelPolicy });
    expect(await answer(model, requestContext, stream)).toBe('Host answer');
    allowed = false;
    await expect(answer(model, requestContext, stream)).rejects.toThrow(/Host authorization expired/);
    expect(decisions).toEqual(['main:host/requested', 'main:host/requested']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('Synthetic request');
    expect(nativeReload).not.toHaveBeenCalled();
  });

  it('uses the subagent role for a fork that reuses the parent dynamic model', async () => {
    const calls: string[] = [];
    const roles: MastraCodeModelRole[] = [];
    const requestContext = context();
    requestContext.set(AGENT_CONTROLLER_SUBAGENT_CONTEXT_KEY, { agentType: 'explore', forked: true });
    const selected = getDynamicModel({ requestContext }, undefined, {
      modelPolicy: ({ role }) => {
        roles.push(role);
        return textModel('Fork answer', calls);
      },
    });
    const agent = new Agent({ id: 'fork', name: 'Fork', instructions: 'Answer.', model: selected });
    expect((await agent.generate('Forked request', { requestContext })).text).toBe('Fork answer');
    expect(roles).toEqual(['subagent']);
    expect(calls[0]).toContain('Forked request');
    expect(nativeReload).not.toHaveBeenCalled();
  });

  it.each(['v2', 'v3', 'v4'] as const)(
    'reaches a host-owned %s implementation without a native provider',
    async version => {
      const requestContext = context();
      const edge = vi.fn(async () => {
        throw new Error('Synthetic provider boundary reached');
      });
      const model = resolveModel('host/requested', {
        requestContext,
        modelPolicy: () =>
          ({
            specificationVersion: version,
            provider: 'synthetic',
            modelId: 'owned',
            supportedUrls: {},
            doGenerate: edge,
            doStream: edge,
          }) as GatewayLanguageModel,
      });
      await expect(answer(model, requestContext)).rejects.toThrow(/Synthetic provider boundary reached/);
      expect(edge).toHaveBeenCalledOnce();
      expect(nativeReload).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, {}])('refuses a missing or invalid request context', requestContext => {
    const modelPolicy = vi.fn();
    expect(() =>
      resolveModel('host/requested', { modelPolicy, requestContext: requestContext as RequestContext }),
    ).toThrow('Model policy requires a request context.');
    expect(modelPolicy).not.toHaveBeenCalled();
    expect(nativeReload).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    'native/model',
    {},
    { specificationVersion: 'v1' },
    { ...textModel('Invalid provider metadata reached the model', []), provider: '' },
    { ...textModel('Invalid model metadata reached the model', []), modelId: '' },
  ])('refuses an invalid policy result', async result => {
    const requestContext = context();
    const model = resolveModel('host/requested', {
      requestContext,
      modelPolicy: (() => result) as MastraCodeModelPolicy,
    });
    await expect(answer(model, requestContext)).rejects.toThrow(/must return an AI SDK/);
    expect(nativeReload).not.toHaveBeenCalled();
  });

  it('lets the host refuse a context without its execution binding', async () => {
    const requestContext = context();
    requestContext.delete('hostBinding');
    const calls: string[] = [];
    const model = resolveModel('host/requested', {
      requestContext,
      modelPolicy: ({ requestContext }) => {
        if (requestContext.get('hostBinding') !== binding) throw new Error('Missing host execution binding');
        return textModel('Never called', calls);
      },
    });
    await expect(answer(model, requestContext)).rejects.toThrow(/Missing host execution binding/);
    expect(calls).toEqual([]);
    expect(nativeReload).not.toHaveBeenCalled();
  });

  it.each([null, false, 'native'])('refuses an invalid configured policy instead of native routing', async policy => {
    const modelPolicy = policy as unknown as MastraCodeModelPolicy;
    expect(() => resolveModel('host/requested', { requestContext: context(), modelPolicy })).toThrow(
      'Model policy must be a function.',
    );
    expect(nativeReload).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('refuses an empty model selection', modelId => {
    expect(() =>
      resolveModel(modelId, { requestContext: context(), modelPolicy: () => textModel('Unused', []) }),
    ).toThrow('Model policy requires a nonempty model ID.');
    expect(nativeReload).not.toHaveBeenCalled();
  });

  it('refuses an invalid model role', () => {
    expect(() =>
      resolveModel('host/requested', {
        requestContext: context(),
        modelPolicy: () => textModel('Unused', []),
        role: 'foreign' as MastraCodeModelRole,
      }),
    ).toThrow('Model policy requires a supported model role.');
    expect(nativeReload).not.toHaveBeenCalled();
  });

  it('preserves the native resolver when no policy is configured', () => {
    expect(() => resolveModel('host/requested', { requestContext: context() })).toThrow(
      'Native credential resolution is forbidden in policy tests.',
    );
    expect(nativeReload).toHaveBeenCalledOnce();
  });

  it('does not cross bindings when two requests run concurrently', async () => {
    const callsA: string[] = [];
    const callsB: string[] = [];
    const a = context();
    const b = context();
    b.set('hostBinding', Object.freeze({ ...binding, workspaceId: 'workspace-b', payerId: 'payer-b' }));
    const modelPolicy: MastraCodeModelPolicy = async ({ requestContext }) => {
      await Promise.resolve();
      return requestContext.get('hostBinding') === binding ? textModel('A', callsA) : textModel('B', callsB);
    };
    const results = await Promise.all(
      [a, b].map(requestContext =>
        answer(resolveModel('host/requested', { requestContext, modelPolicy }), requestContext),
      ),
    );
    expect(results).toEqual(['A', 'B']);
    expect(callsA).toHaveLength(1);
    expect(callsB).toHaveLength(1);
    expect(nativeReload).not.toHaveBeenCalled();
  });
});

describe('SDK controller policy', () => {
  let directory: string;
  let base: MastraCodeAgentController | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mastracode-model-policy-'));
    vi.stubEnv('MASTRA_APP_DATA_DIR', directory);
    vi.stubEnv('MASTRACODE_DISABLE_UNIX_SOCKET_PUBSUB', '1');
    vi.stubEnv('MASTRACODE_DISABLE_TITLE_GENERATION', '1');
  });
  afterEach(async () => {
    if (base) {
      base.releaseThreadClaims();
      base.controller.stopIntervals();
      base.threadScheduler.stop();
      base.stopPluginSignalProviders();
      await base.stopNotificationDispatch();
      await base.controller.deleteSession({ sessionId: 'session-a' });
      await base.storage.close();
      base = undefined;
    }
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each([null, false, 'native'])(
    'refuses malformed policy configuration before constructing credential storage',
    async policy => {
      const storageReload = vi.spyOn(AuthStorage.prototype, 'reload').mockImplementation(() => {
        throw new Error('Credential storage was constructed before policy validation');
      });
      await expect(
        createMastraCodeAgentController({ modelPolicy: policy as unknown as MastraCodeModelPolicy }),
      ).rejects.toThrow('Model policy must be a function.');
      expect(storageReload).not.toHaveBeenCalled();
      expect(nativeReload).not.toHaveBeenCalled();
    },
  );

  async function start(modelPolicy: MastraCodeModelPolicy, overrides: Partial<MastraCodeConfig> = {}) {
    base = await createMastraCodeAgentController({
      cwd: directory,
      homeDir: directory,
      settingsPath: join(directory, 'settings.json'),
      storage: new LibSQLStore({ id: 'sdk-policy', url: ':memory:' }),
      workspace: new Workspace({ id: 'policy-workspace', name: 'Policy workspace', skills: [directory] }),
      disableMcp: true,
      disableHooks: true,
      disablePlugins: true,
      disableGithubSignals: true,
      disableEnvFile: true,
      createInitialThread: false,
      intervalHandlers: [],
      modes: [{ id: 'build', defaultModelId: 'host/main' }],
      initialState: { omScope: 'thread', observationThreshold: 50_000, reflectionThreshold: 50_000 },
      modelPolicy,
      ...overrides,
    });
    await base.controller.init();
    const requestContext = new RequestContext();
    requestContext.set('hostBinding', binding);
    const session = await base.controller.createSession({
      id: 'session-a',
      ownerId: 'actor-a',
      resourceId: 'resource-a',
      requestContext,
    });
    session.model.set({ modelId: 'host/main' });
    return { ...base, session, requestContext };
  }

  it.each([
    { forked: false, denied: false },
    { forked: true, denied: false },
    { forked: false, denied: true },
    { forked: true, denied: true },
  ])(
    'preserves or refuses host authority in a real subagent execution (forked=$forked, denied=$denied)',
    async ({ forked, denied }) => {
      const calls: string[] = [];
      const subagentEdges: string[] = [];
      const requests: Array<{ role: MastraCodeModelRole; modelId: string; marker: unknown; binding: unknown }> = [];
      let mainCalls = 0;
      const modelPolicy: MastraCodeModelPolicy = ({ role, modelId, requestContext }) => {
        requests.push({
          role,
          modelId,
          marker: requestContext.get(AGENT_CONTROLLER_SUBAGENT_CONTEXT_KEY),
          binding: requestContext.get('hostBinding'),
        });
        if (role === 'subagent' && denied) throw new Error('Subagent authority revoked');
        if (role === 'main' && mainCalls++ === 0) {
          return {
            ...textModel('Unused', calls),
            doStream: async options => {
              calls.push(JSON.stringify(options.prompt));
              return {
                stream: new ReadableStream({
                  start(controller) {
                    controller.enqueue({ type: 'stream-start', warnings: [] });
                    controller.enqueue({
                      type: 'tool-call',
                      toolCallId: 'delegate',
                      toolName: 'subagent',
                      input: JSON.stringify({
                        agentType: 'helper',
                        task: 'Return a synthetic answer.',
                        forked,
                        modelId: 'host/guest-override',
                      }),
                    });
                    controller.enqueue({
                      type: 'finish',
                      finishReason: 'tool-calls',
                      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
                    });
                    controller.close();
                  },
                }),
              };
            },
          };
        }
        return textModel(
          role === 'subagent' ? 'Subagent completed' : 'Main completed',
          role === 'subagent' ? subagentEdges : calls,
        );
      };
      const { session, requestContext, controller } = await start(modelPolicy, {
        subagents: [
          {
            id: 'helper',
            name: 'Helper',
            description: 'Answers a synthetic task.',
            instructions: 'Answer.',
            defaultModelId: 'host/subagent',
          },
        ],
      });
      await session.sendMessage({ content: 'Delegate this synthetic request.', requestContext, untilIdle: true });
      const subagent = requests.filter(request => request.role === 'subagent');
      expect(subagent.length).toBeGreaterThanOrEqual(1);
      expect(subagentEdges).toHaveLength(denied ? 0 : 1);
      expect(subagent[0]?.marker).toEqual({ agentType: 'helper', forked });
      expect(subagent[0]?.modelId).toBe(forked ? 'host/main' : 'host/guest-override');
      expect(subagent[0]?.binding).toBe(binding);
      expect(requestContext.get(AGENT_CONTROLLER_SUBAGENT_CONTEXT_KEY)).toBeUndefined();
      const messages = await controller.queryThreadMessages({
        threadId: session.thread.getId()!,
        perPage: 50,
        page: 0,
      });
      expect(JSON.stringify(messages)).toContain(denied ? 'Subagent authority revoked' : 'Subagent completed');
      expect(JSON.stringify(messages)).toContain('Main completed');
      expect(nativeReload).not.toHaveBeenCalled();
    },
  );

  it('replaces a caller-supplied title model before that model can execute', async () => {
    const foreignCalls: string[] = [];
    const calls: string[] = [];
    const roles: MastraCodeModelRole[] = [];
    const { codeAgent, requestContext, session } = await start(({ role }) => {
      roles.push(role);
      return textModel('Host title', calls);
    });
    requestContext.set('controller', { session: { modelId: session.model.get() }, getState: () => ({}) });
    const foreign = textModel('Foreign title', foreignCalls);
    const title = await codeAgent.generateTitleFromUserMessage({
      message: 'Synthetic request',
      model: foreign,
      requestContext,
    });
    expect(title).toBe('Host title');
    expect(foreignCalls).toEqual([]);
    expect(roles).toEqual(['title']);
    expect(nativeReload).not.toHaveBeenCalled();
  });

  it.each([null, {}, () => undefined])(
    'refuses an unidentifiable explicit title model without main-model fallback',
    async model => {
      const calls: string[] = [];
      const policy = vi.fn(() => textModel('Unexpected fallback', calls));
      const { codeAgent, requestContext, session } = await start(policy);
      requestContext.set('controller', { session: { modelId: session.model.get() }, getState: () => ({}) });
      await expect(
        codeAgent.generateTitleFromUserMessage({ message: 'Synthetic request', model: model as never, requestContext }),
      ).rejects.toThrow('Model policy requires an identifiable title model.');
      expect(policy).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
      expect(nativeReload).not.toHaveBeenCalled();
    },
  );

  it.each(['memory', 'mode-agent', 'experimental'] as const)(
    'refuses an incompatible %s configuration',
    async source => {
      const policy = vi.fn(() => textModel('Unused', []));
      const customMemory = vi.fn(() => {
        throw new Error('Custom memory must not execute');
      });
      const overrides: Partial<MastraCodeConfig> =
        source === 'memory'
          ? { memory: customMemory }
          : source === 'mode-agent'
            ? {
                modes: [
                  {
                    id: 'build',
                    agent: new Agent({
                      id: 'foreign',
                      name: 'Foreign',
                      instructions: 'Answer.',
                      model: textModel('Unused', []),
                    }),
                  },
                ],
              }
            : {};
      if (source === 'experimental') vi.stubEnv('MASTRACODE_EXPERIMENTAL_AGENT', 'durable');
      await expect(start(policy, overrides)).rejects.toThrow(
        source === 'memory'
          ? 'Model policy does not support custom memory.'
          : source === 'mode-agent'
            ? 'Model policy does not support custom mode agents.'
            : 'Model policy does not support experimental agents.',
      );
      expect(policy).not.toHaveBeenCalled();
      expect(customMemory).not.toHaveBeenCalled();
      expect(nativeReload).not.toHaveBeenCalled();
    },
  );

  it.each([
    { source: 'model', stream: false },
    { source: 'model', stream: true },
    { source: 'prepareStep', stream: false },
    { source: 'prepareStep', stream: true },
    { source: 'inputProcessors', stream: false },
    { source: 'inputProcessors', stream: true },
  ])('refuses an ungoverned $source override (stream=$stream)', async ({ source, stream }) => {
    const foreignCalls: string[] = [];
    const { codeAgent, requestContext, session } = await start(() => textModel('Host answer', []));
    const state = session.state.get();
    const threadId = session.thread.getId()!;
    const resourceId = session.identity.getResourceId();
    requestContext.set('controller', {
      session: { id: session.identity.getId(), modelId: session.model.get(), modeId: 'build' },
      getState: () => state,
      state,
      threadId,
      resourceId,
    });
    const foreign = textModel('Foreign answer', foreignCalls);
    const options = {
      requestContext,
      memory: { thread: threadId, resource: resourceId },
      ...(source === 'model'
        ? { model: foreign }
        : source === 'inputProcessors'
          ? { model: foreign, inputProcessors: [] }
          : { prepareStep: () => ({ model: foreign }) }),
    };
    const operation = stream
      ? codeAgent.stream('Synthetic request', options).then(async result => {
          try {
            return await result.text;
          } finally {
            await result.consumeStream();
          }
        })
      : codeAgent.generate('Synthetic request', options);
    await expect(operation).rejects.toThrow(
      source === 'inputProcessors' ? /Input processor overrides are disabled/ : /ungoverned model override/,
    );
    expect(foreignCalls).toEqual([]);
    expect(nativeReload).not.toHaveBeenCalled();
  });

  it('keeps the returned resolver bound to its configured policy', async () => {
    const calls: string[] = [];
    const { resolveModel: resolve, requestContext } = await start(() => textModel('Host answer', calls));
    const substitutedPolicy = vi.fn(() => textModel('Foreign answer', []));
    expect(
      await answer(resolve('host/requested', { requestContext, modelPolicy: substitutedPolicy }), requestContext),
    ).toBe('Host answer');
    expect(substitutedPolicy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(nativeReload).not.toHaveBeenCalled();
  });
});

async function createMemoryFixture(
  selection: 'auto' | 'explicit',
  modelPolicy: MastraCodeModelPolicy,
  isFactory = false,
) {
  const storage = new InMemoryStore({ id: `policy-memory-${selection}` });
  await storage.init();
  const requestContext = context({
    omScope: 'thread',
    observerModelSelection: selection === 'auto' ? 'auto' : 'host/observer',
    reflectorModelSelection: selection === 'auto' ? 'auto' : 'host/reflector',
    ...(isFactory ? { factoryProjectId: binding.factoryId } : {}),
  });
  const factory = getDynamicMemory(storage, undefined, undefined, { disableSettingsOmSeed: true, modelPolicy });
  const configuration = factory({ requestContext }).getMergedThreadConfig();
  const memoryStore = (await storage.getStore('memory'))!;
  await memoryStore.saveThread({
    thread: {
      id: 'thread-a',
      resourceId: 'resource-a',
      title: '',
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  const omOptions = configuration.observationalMemory;
  if (!omOptions || typeof omOptions !== 'object') throw new Error('Observational memory is not configured');
  const reflectionErrors: Error[] = [];
  const om = new ObservationalMemory({
    ...omOptions,
    hooks: {
      onReflectionEnd: ({ error }) => {
        if (error) reflectionErrors.push(error);
      },
    },
    storage: memoryStore,
    observation: { ...omOptions.observation, bufferTokens: false },
    reflection: { ...omOptions.reflection, bufferActivation: undefined },
  });
  const observe = () =>
    om.observe({
      threadId: 'thread-a',
      resourceId: 'resource-a',
      requestContext,
      force: true,
      messages: [
        {
          id: 'synthetic-message',
          role: 'user',
          threadId: 'thread-a',
          resourceId: 'resource-a',
          content: { format: 2, parts: [{ type: 'text', text: 'Remember this synthetic request.' }] },
          type: 'text',
          createdAt: new Date(),
        },
      ],
    });
  const reflect = () => om.reflect('thread-a', 'resource-a', undefined, requestContext);
  const titleConfig = configuration.generateTitle;
  if (!titleConfig || typeof titleConfig !== 'object') throw new Error('Title model is not configured');
  const titleAgent = new Agent({
    id: 'memory-title',
    name: 'Memory title',
    instructions: 'Answer.',
    model: 'unused/model',
  });
  const title = () =>
    titleAgent.generateTitleFromUserMessage({ message: 'Synthetic request', model: titleConfig.model, requestContext });
  return {
    requestContext,
    observe,
    reflect,
    title,
    reflectionErrors,
    close: async () => {
      await factory.settled();
      await storage.close();
    },
  };
}

describe('independent memory model calls', () => {
  it.each([undefined, null, { status: 'unavailable', reason: 'synthetic settings failure' }])(
    'keeps missing or unavailable Factory memory settings inside host policy',
    async settings => {
      const requests: Array<{ role: MastraCodeModelRole; modelId: string }> = [];
      const fixture = await createMemoryFixture(
        'auto',
        ({ role, modelId }) => {
          requests.push({ role, modelId });
          return textModel(
            role === 'title' ? 'Policy title' : '<observations>\n* Synthetic policy observation\n</observations>',
            [],
          );
        },
        true,
      );
      if (settings !== undefined) fixture.requestContext.set('mastra__factoryMemorySettings', settings);
      try {
        await fixture.observe();
        await fixture.reflect();
        expect(await fixture.title()).toBe('Policy title');
        expect(requests.map(request => request.role)).toEqual(
          expect.arrayContaining(['observer', 'reflector', 'title']),
        );
        expect(requests.every(request => request.modelId === 'host/requested')).toBe(true);
        expect(nativeReload).not.toHaveBeenCalled();
      } finally {
        await fixture.close();
      }
    },
  );

  it.each(['auto', 'explicit'] as const)(
    'uses the policy for observer, reflector, and automatic title (%s)',
    async selection => {
      const roles: MastraCodeModelRole[] = [];
      const calls: string[] = [];
      const fixture = await createMemoryFixture(selection, ({ role, requestContext }) => {
        expect(requestContext.get('hostBinding')).toBe(binding);
        roles.push(role);
        return textModel(
          role === 'title' ? 'Policy title' : '<observations>\n* Synthetic policy observation\n</observations>',
          calls,
        );
      });
      try {
        expect((await fixture.observe()).record.activeObservations).toContain('Synthetic policy observation');
        await fixture.reflect();
        expect(await fixture.title()).toBe('Policy title');
        expect(roles).toContain('observer');
        expect(roles).toContain('reflector');
        expect(roles).toContain('title');
        expect(calls.length).toBeGreaterThanOrEqual(3);
        expect(nativeReload).not.toHaveBeenCalled();
      } finally {
        await fixture.close();
      }
    },
  );

  it.each(['observer', 'reflector', 'title'] as const)(
    'refuses a policy error for %s without native fallback',
    async deniedRole => {
      const calls: string[] = [];
      const attempts: MastraCodeModelRole[] = [];
      const fixture = await createMemoryFixture('auto', ({ role }) => {
        attempts.push(role);
        if (role === deniedRole) throw new Error(`Host refused ${role}`);
        return textModel('<observations>\n* Synthetic policy observation\n</observations>', calls);
      });
      try {
        if (deniedRole === 'reflector') {
          const observations = (await fixture.observe()).record.activeObservations;
          // Native reflect() reports failures through its result and lifecycle hook, not rejection.
          const result = await fixture.reflect();
          expect(result.reflected).toBe(false);
          expect(result.record.activeObservations).toBe(observations);
          expect(fixture.reflectionErrors.map(error => error.message)).toEqual(['Host refused reflector']);
        } else {
          await expect(deniedRole === 'observer' ? fixture.observe() : fixture.title()).rejects.toThrow(
            `Host refused ${deniedRole}`,
          );
        }
        expect(attempts).toContain(deniedRole);
        expect(calls).toHaveLength(deniedRole === 'reflector' ? 1 : 0);
        expect(nativeReload).not.toHaveBeenCalled();
      } finally {
        await fixture.close();
      }
    },
  );
});
