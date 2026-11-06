export default function ownerDocsLint() {
  if (process.env.MASTRA_OWNER_DOCS_PROFILE !== '1')
    throw new Error('This owner stand-in requires MASTRA_OWNER_DOCS_PROFILE=1.')
  console.warn('Owner stand-in: upstream private docs lint is disabled. No upstream lint ran.')
}
