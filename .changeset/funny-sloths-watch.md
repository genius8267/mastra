---
'@mastra/code-sdk': minor
---

Added an optional host-owned modelPolicy for main, subagent, observer, reflector, and title calls. It authorizes each actual generation or stream and accepts host-owned AI SDK V2, V3, or V4 models. Configured policies refuse native credential editing and ungoverned model overrides. Omitted policies preserve native defaults.

```ts
import { createMastraCodeAgentController } from '@mastra/code-sdk';
import type { MastraCodeModelPolicy } from '@mastra/code-sdk';

export const createCode = (modelPolicy: MastraCodeModelPolicy) => createMastraCodeAgentController({ modelPolicy });
```
