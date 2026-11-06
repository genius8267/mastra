import type { MastraCodeModelPolicy } from '@mastra/code-sdk';
import { getDynamicMemory } from '@mastra/code-sdk/agents/memory';
import { AuthStorage } from '@mastra/code-sdk/auth/storage';
import { stateSchema } from '@mastra/code-sdk/schema';
import type { MastraCodeState } from '@mastra/code-sdk/schema';
import { Agent } from '@mastra/core/agent';
import { AgentController } from '@mastra/core/agent-controller';
import type { GatewayLanguageModel } from '@mastra/core/llm';
import { RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MastraFactory } from '../factory.js';
import type { GithubIntegration } from '../integrations/github/integration.js';
import { buildGithubRoutes } from '../integrations/github/routes.js';
import { createStateSigner } from '../state-signing.js';
import { createFactoryStorageForTests } from '../storage/test-utils.js';
import { buildSourceControlSessionRoutes } from './source-control-sessions.js';
import { fakeRouteAuth, mountApiRoutes } from './test-utils.js';

afterEach(() => vi.restoreAllMocks());

describe('Factory explicit title model policy', () => {
  it.each([null, false, 'native'])('refuses malformed policy configuration before preparation', async policy => {
    const seed = await createFactoryStorageForTests();
    const nativeReload = vi.spyOn(AuthStorage.prototype, 'reload').mockImplementation(() => {
      throw new Error('Native credential files must not be opened');
    });
    expect(
      () => new MastraFactory({ storage: seed.storage, modelPolicy: policy as unknown as MastraCodeModelPolicy }),
    ).toThrow('Model policy must be a function.');
    expect(nativeReload).not.toHaveBeenCalled();
  });

  it.each(['source-control', 'github'] as const)(
    'authorizes every %s title call and refuses revoked authority',
    async route => {
      const nativeReload = vi.spyOn(AuthStorage.prototype, 'reload').mockImplementation(() => {
        throw new Error('Native credential files must not be opened');
      });
      const seed = await createFactoryStorageForTests();
      const sourceControl = seed.sourceControl.forIntegration(route === 'github' ? 'github' : 'gitlab');
      const project = await seed.projects.create({
        orgId: 'org-a',
        userId: 'actor-a',
        input: { name: 'Synthetic policy project' },
      });
      const installation = await sourceControl.installations.upsert({
        orgId: 'org-a',
        connectedByUserId: 'actor-a',
        externalId: 'synthetic-installation',
      });
      const repository = await sourceControl.repositories.upsert({
        orgId: 'org-a',
        input: {
          installationId: installation.id,
          externalId: 'synthetic-repository',
          slug: 'synthetic/repository',
          defaultBranch: 'main',
        },
      });
      const connection = await sourceControl.connections.create({
        orgId: 'org-a',
        factoryProjectId: project.id,
        installationId: installation.id,
        createdByUserId: 'actor-a',
      });
      const projectRepository = await sourceControl.projectRepositories.link({
        orgId: 'org-a',
        connectionId: connection.id,
        repositoryId: repository.id,
        createdByUserId: 'actor-a',
        sandboxProvider: 'local',
        sandboxWorkdir: '/synthetic-workspace',
      });
      const sessionId = 'policy-title-session';
      await sourceControl.sessions.create({
        sessionId,
        projectRepositoryId: projectRepository.id,
        orgId: 'org-a',
        userId: 'actor-a',
        branch: 'user/session-policy',
        baseBranch: 'main',
        visibility: 'org',
      });
      await seed.memorySettings.patch({ orgId: 'org-a', userId: 'actor-a', patch: { observerModelId: 'host/title' } });
      const storage = new InMemoryStore({ id: `policy-title-${route}` });
      let providerCalls = 0;
      const model: Extract<GatewayLanguageModel, { specificationVersion: 'v2' }> = {
        specificationVersion: 'v2',
        provider: 'synthetic',
        modelId: 'host-owned',
        supportedUrls: {},
        doGenerate: async () => {
          providerCalls++;
          return {
            content: [{ type: 'text', text: 'Authorized title' }],
            finishReason: 'stop',
            warnings: [],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
        doStream: async () => {
          throw new Error('This title fixture must generate, not stream');
        },
      };
      let revoked = false;
      const decisions: string[] = [];
      const modelPolicy: MastraCodeModelPolicy = ({ modelId, role, requestContext }) => {
        expect(requestContext.get('user')).toEqual({ workosId: 'actor-a', organizationId: 'org-a' });
        decisions.push(`${role}:${modelId}`);
        if (revoked) throw new Error('Host title authorization was revoked');
        return model;
      };
      const memoryContext = new RequestContext();
      memoryContext.set('controller', { session: { modelId: 'host/main' }, getState: () => ({ omScope: 'thread' }) });
      const memoryFactory = getDynamicMemory(storage, undefined, undefined, {
        disableSettingsOmSeed: true,
        modelPolicy,
      });
      const memory = memoryFactory({ requestContext: memoryContext });
      const controller = new AgentController<MastraCodeState>({
        id: `policy-title-${route}`,
        storage,
        stateSchema,
        agent: new Agent({
          id: 'title-agent',
          name: 'Title agent',
          instructions: 'Name the conversation.',
          model,
          memory,
        }),
        modes: [{ id: 'build', defaultModelId: 'host/main' }],
      });
      await controller.init();
      await controller.createSession({
        id: sessionId,
        ownerId: 'actor-a',
        resourceId: sessionId,
        threadId: 'policy-conversation',
      });
      await memory.saveMessages({
        messages: [
          {
            id: 'policy-title-message',
            threadId: 'policy-conversation',
            resourceId: sessionId,
            role: 'user',
            type: 'text',
            content: { format: 2, parts: [{ type: 'text', text: 'A synthetic conversation to name.' }] },
            createdAt: new Date(),
          },
        ],
      });
      const auth = fakeRouteAuth();
      const app = new Hono();
      app.use('*', async (context, next) => {
        context.set('factoryAuthUser' as never, { workosId: 'actor-a', organizationId: 'org-a' } as never);
        await next();
      });
      const routes =
        route === 'source-control'
          ? buildSourceControlSessionRoutes({
              auth,
              sourceControls: [sourceControl],
              projects: seed.projects,
              memorySettings: seed.memorySettings,
              controller,
              modelPolicy,
            })
          : buildGithubRoutes({
              auth,
              github: { sourceControlStorage: sourceControl } as GithubIntegration,
              stateSigner: createStateSigner(),
              memorySettings: seed.memorySettings,
              controller,
              modelPolicy,
            });
      mountApiRoutes(app as never, routes);
      try {
        const first = await app.request(`/web/user-sessions/${sessionId}/title`, { method: 'POST' });
        expect(first.status).toBe(200);
        expect(await first.json()).toEqual({ title: 'Authorized title' });
        revoked = true;
        const denied = await app.request(`/web/user-sessions/${sessionId}/title`, { method: 'POST' });
        expect(denied.status).toBe(500);
        expect(await denied.json()).toEqual({ error: 'Host title authorization was revoked' });
        expect(decisions).toEqual(['title:host/title', 'title:host/title']);
        expect(providerCalls).toBe(1);
        expect((await sourceControl.sessions.getBySessionId(sessionId))?.title).toBe('Authorized title');
        expect(nativeReload).not.toHaveBeenCalled();
      } finally {
        await controller.deleteSession({ sessionId });
        controller.stopIntervals();
        await memory.settled();
        await storage.close();
      }
    },
  );
});
