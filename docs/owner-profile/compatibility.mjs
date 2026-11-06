import { fileURLToPath } from 'node:url'

/** @returns {import('@docusaurus/types').Plugin} */
export default function ownerDocsCompatibility() {
  const disabledSearch = fileURLToPath(new URL('./null-search.mjs', import.meta.url))
  return {
    name: 'intunelabs-owner-docs-build-compatibility',
    configureWebpack(config) {
      const current = config.resolve?.alias ?? {}
      if (Array.isArray(current))
        throw new Error('Inspect the owner docs alias configuration before replacing array aliases.')
      const unrelated = Object.fromEntries(
        Object.entries(current).filter(
          ([name]) =>
            name !== '@theme/SearchBar' && name !== '@theme/SearchBar$' && !name.startsWith('@theme/SearchBar/'),
        ),
      )
      return {
        mergeStrategy: { 'resolve.alias': 'replace' },
        resolve: {
          alias: {
            '@theme/SearchBar$': disabledSearch,
            '@theme/SearchBar/custom-search$': disabledSearch,
            ...unrelated,
          },
        },
      }
    },
  }
}
