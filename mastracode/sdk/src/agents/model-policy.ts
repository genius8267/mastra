import { ModelRouterLanguageModel } from '@mastra/core/llm';
import type { GatewayLanguageModel } from '@mastra/core/llm';
import type { RequestContext } from '@mastra/core/request-context';

/** The native operation that requests a model. Goal judges use the main role. */
export type MastraCodeModelRole = 'main' | 'subagent' | 'observer' | 'reflector' | 'title';

/**
 * Resolves and authorizes one actual model call. Throw to refuse the call.
 * The host must derive authority from its trusted request binding, not the requested model ID.
 * Results are never reused to authorize another call. Return a host-owned AI SDK V2, V3, or V4 model.
 */
export type MastraCodeModelPolicy = (args: {
  modelId: string;
  role: MastraCodeModelRole;
  requestContext: RequestContext;
}) => GatewayLanguageModel | Promise<GatewayLanguageModel>;

const policyModels = new WeakMap<
  object,
  {
    policy: MastraCodeModelPolicy;
    role: MastraCodeModelRole;
    requestContext: RequestContext;
  }
>();

/** Identify a request-local governed model, not an earlier authorization decision. */
export function isPolicyModel(
  model: object,
  policy: MastraCodeModelPolicy,
  role: MastraCodeModelRole,
  requestContext: RequestContext,
): boolean {
  const binding = policyModels.get(model);
  return binding?.policy === policy && binding.role === role && binding.requestContext === requestContext;
}

/** Adapt a host-owned model without consulting native credentials or provider defaults. */
export function resolvePolicyModel(
  modelId: string,
  role: MastraCodeModelRole,
  requestContext: RequestContext | undefined,
  policy: MastraCodeModelPolicy,
): ModelRouterLanguageModel {
  if (typeof policy !== 'function') throw new Error('Model policy must be a function.');
  if (!['main', 'subagent', 'observer', 'reflector', 'title'].includes(role)) {
    throw new Error('Model policy requires a supported model role.');
  }
  if (typeof modelId !== 'string' || !modelId.trim()) {
    throw new Error('Model policy requires a nonempty model ID.');
  }
  if (!requestContext || typeof requestContext.get !== 'function' || typeof requestContext.entries !== 'function') {
    throw new Error('Model policy requires a request context.');
  }

  const createCallModel = () => {
    // Reuse core's public SDK-version adapters. This gateway resolves only in process.
    const model = new ModelRouterLanguageModel({ id: `mastracode-policy/${modelId}` }, [
      {
        id: 'mastracode-policy',
        name: 'Mastra Code model policy',
        fetchProviders: async () => ({}),
        buildUrl: () => undefined,
        getApiKey: async () => '',
        resolveAuth: () => ({ apiKey: 'host-model-policy' }),
        resolveLanguageModel: async () => {
          const resolved = await policy({ modelId, role, requestContext });
          if (
            !resolved ||
            !['v2', 'v3', 'v4'].includes(resolved.specificationVersion) ||
            typeof resolved.provider !== 'string' ||
            !resolved.provider.trim() ||
            typeof resolved.modelId !== 'string' ||
            !resolved.modelId.trim() ||
            typeof resolved.doGenerate !== 'function' ||
            typeof resolved.doStream !== 'function'
          ) {
            throw new Error('Model policy must return an AI SDK V2, V3, or V4 model implementation.');
          }
          return resolved;
        },
      },
    ]);
    model.id = modelId;
    return model;
  };

  const model = createCallModel();
  const guarded = new Proxy(model, {
    get(target, property) {
      // Resolve authority only for actual calls. Inline media avoids an earlier metadata lookup.
      if (property === 'supportedUrls') return {};
      if (property === 'resolveApiProviderId') return async () => undefined;
      if (property === 'doGenerate' || property === 'doStream') {
        return async (...args: unknown[]) => {
          const callModel = createCallModel();
          return Reflect.apply(Reflect.get(callModel, property), callModel, args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  policyModels.set(guarded, { policy, role, requestContext });
  return guarded;
}
