---
'@mastra/factory': minor
---

Added optional Factory modelPolicy configuration and exported policy types. Coding, memory, and automatic or explicit title calls use the host-owned policy. Omitted policies preserve native routing and the disabled-subagent default.

```ts
import { MastraFactory } from '@mastra/factory';
import type { MastraCodeModelPolicy, MastraFactoryConfig } from '@mastra/factory';

export const createFactory = (storage: MastraFactoryConfig['storage'], modelPolicy: MastraCodeModelPolicy) =>
  new MastraFactory({ storage, modelPolicy });
```
