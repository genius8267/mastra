#!/usr/bin/env node
if (process.env.MASTRA_OWNER_DOCS_PROFILE !== '1') {
  console.error('This owner stand-in requires MASTRA_OWNER_DOCS_PROFILE=1. No upstream lint ran.')
  process.exitCode = 1
} else {
  console.log('Owner stand-in: upstream private docs lint is disabled. No upstream lint ran.')
}
