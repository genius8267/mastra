// This owner stand-in adds no chat UI, scripts, styles, routes, or content.
module.exports = function ownerDocsKapa() {
  if (process.env.MASTRA_OWNER_DOCS_PROFILE !== '1')
    throw new Error('This owner stand-in requires MASTRA_OWNER_DOCS_PROFILE=1.')
  return { name: 'intunelabs-owner-docs-noop-kapa' }
}
