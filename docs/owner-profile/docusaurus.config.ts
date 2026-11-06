import type { Config } from '@docusaurus/types'
import upstream from '../docusaurus.config'
import ownerDocsCompatibility from './compatibility.mjs'

if (process.env.MASTRA_OWNER_DOCS_PROFILE !== '1') {
  throw new Error('The owner docs configuration requires MASTRA_OWNER_DOCS_PROFILE=1.')
}

export default {
  ...upstream,
  plugins: [...(upstream.plugins ?? []), ownerDocsCompatibility],
} satisfies Config
