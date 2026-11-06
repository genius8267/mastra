# Owner docs build profile

This opt-in profile builds the real docs site without three unavailable Mastra-published, non-content packages.
It uses owner-authored stand-ins, not recovered upstream implementations.

| Requested package                   | Local owner package              | Disabled functionality     |
| ----------------------------------- | -------------------------------- | -------------------------- |
| `@mastra/docusaurus-plugin-algolia` | `@intunelabs/owner-docs-algolia` | Hosted search UI           |
| `@mastra/docusaurus-plugin-kapa`    | `@intunelabs/owner-docs-kapa`    | Hosted chat UI             |
| `@mastra/lint-docs`                 | `@intunelabs/owner-docs-lint`    | Upstream private docs lint |

The plugin factories expose only Docusaurus-required names. They add no hooks, routes, themes, scripts, styles, services or content.
The lint command prints its owner-stand-in behavior. Exit 0 means that compatibility command completed, not that upstream private lint ran.
All stand-ins refuse execution without `MASTRA_OWNER_DOCS_PROFILE=1`.

## Source and configuration

Use a fresh isolated checkout from `8c7cca71ef34bc382a50a9c4a576e8d1625d1bca` and the fork's pinned pnpm 11.21.0.
Use a Node version accepted by the root `engines` declaration.
The profile refuses existing root pnpmfiles or changed upstream docs/workspace configuration instead of replacing them.

The selected workspace contains docs and the three local stand-ins. A filter alone still validates the full upstream lock graph.
The profile retains the upstream package extensions, security overrides, trust policy, release-age policy and build approvals.
Five patch registrations belong to excluded workspace dependencies. The profile omits those registrations, not their checks.
The locked docs graph must contain none of those exact package versions. Patches that apply to the selected graph remain unchanged.
`verifyDepsBeforeRun: error` preserves dependency-status refusal for native build commands and their children.
No frozen install, checksum check or supply-chain check is disabled.

## Build the site

Run these commands from the repository root:

```sh
MASTRA_OWNER_DOCS_PROFILE=1 node docs/owner-profile/run.mjs lock
MASTRA_OWNER_DOCS_PROFILE=1 node docs/owner-profile/run.mjs install
MASTRA_OWNER_DOCS_PROFILE=1 node docs/owner-profile/run.mjs build
```

The lock action resolves a new profile graph. Inspect that graph before installation and retain its lockfile hash.
The install action requires the profile lock and uses `--frozen-lockfile`.
The build action runs the native `mastra-docs` build with dependency-status refusal enabled.

The unmodified docs configuration still registers the native llms plugin.
Docusaurus renders HTML before that plugin generates `docs/build/llms-manifest.json` and the individual llms files.
No hosted docs, release docs, hand-written manifest or raw-MDX replacement supplies those outputs.

The runner temporarily maps the three dependency declarations to local links in `docs/package.json`.
This keeps native pnpm 11 manifest checks consistent with the locked link specifiers.
It restores that package file, the upstream workspace, root lock and docs configuration after each command.
It retains before-state and command receipts under `.state/`.
It archives previous HTML, Docusaurus output and llms cache before a new build.
Installed modules belong to the selected owner graph. Use a separate checkout or a normal default install before testing the upstream profile.
Without the opt-in flag, this runner changes nothing. The upstream configuration and dependency declarations remain unchanged.

## Embed generated docs

The native `packages/mcp-docs-server/scripts/prepare-docs.ts` consumes the generated manifest.
It clears its `.docs` destination, so archive that destination before execution.
The supported `scripts/generate-package-docs.ts` route embeds package-specific generated docs under `dist/docs`.
Editor already includes `dist` in its native package files list.

Verify the emitted HTML, manifest, copied llms files and final archive contents before claiming embedded-docs coverage.
Keep archive hashes, source pins, the owner-profile commit and tool versions in the producer's additive manifest.
Do not relabel earlier runtime-only archives or change the shared package manifest.
This profile performs no publication, deployment, model call or license activation.
