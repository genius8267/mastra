---
'@mastra/core': minor
---

Added an optional title-model resolver that applies before default or explicit title models execute. Added the exported subagent request-context key and type for forked and non-forked execution. Set `allowInputProcessorOverrides: false` to prevent call options from removing configured input processors. Omitted options preserve existing behavior.

```ts
import { Agent } from '@mastra/core/agent';
import type { AgentConfig } from '@mastra/core/agent';

export const createAgent = (config: AgentConfig, resolveTitleModel: NonNullable<AgentConfig['resolveTitleModel']>) =>
  new Agent({ ...config, resolveTitleModel, allowInputProcessorOverrides: false });
```
