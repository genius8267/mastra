import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SOURCE_PIN = '8c7cca71ef34bc382a50a9c4a576e8d1625d1bca'
export const OWNER_FLAG = 'MASTRA_OWNER_DOCS_PROFILE'
export const STAND_INS = Object.freeze([
  {
    requested: '@mastra/docusaurus-plugin-algolia',
    owner: '@intunelabs/owner-docs-algolia',
    folder: 'algolia',
    disabled: 'Hosted site search UI',
  },
  {
    requested: '@mastra/docusaurus-plugin-kapa',
    owner: '@intunelabs/owner-docs-kapa',
    folder: 'kapa',
    disabled: 'Hosted site chat UI',
  },
  {
    requested: '@mastra/lint-docs',
    owner: '@intunelabs/owner-docs-lint',
    folder: 'lint',
    disabled: 'Upstream private docs lint',
  },
])
export const EXCLUDED_WORKSPACE_PATCHES = Object.freeze([
  'co-body@6.2.0',
  '@earendil-works/pi-tui@0.80.6',
  '@joshwooding/vite-plugin-react-docgen-typescript@0.7.0',
  'react-docgen-typescript@2.4.0',
  'zod-to-ts@2.1.0',
])
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PROFILE = fileURLToPath(new URL('.', import.meta.url))
const digest = value => createHash('sha256').update(value).digest('hex')

export function selectOwnerProfile(env) {
  if (env[OWNER_FLAG] !== '1') {
    throw new Error(
      'Set MASTRA_OWNER_DOCS_PROFILE=1 to select the owner docs profile. Default docs configuration is unchanged.',
    )
  }
  return STAND_INS
}

export function ownerWorkspace(upstream) {
  if (!upstream.startsWith('packages:\n') || upstream.split('\noverrides:\n').length !== 2) {
    throw new Error('The pinned workspace configuration does not have the expected package and override sections.')
  }
  if (/^verifyDepsBeforeRun:/m.test(upstream)) {
    throw new Error(
      'The pinned workspace already selects a dependency-status policy. Inspect it before changing the owner profile.',
    )
  }
  const settingsStart = upstream.indexOf('\nenableGlobalVirtualStore:')
  if (settingsStart < 0) throw new Error('The pinned workspace settings boundary is missing.')
  const patchStart = upstream.indexOf('\npatchedDependencies:\n')
  const patchEnd = upstream.indexOf('\npackageExtensions:', patchStart)
  if (patchStart < 0 || patchEnd < 0) throw new Error('The pinned patch configuration boundary is missing.')
  let selectedSettings = upstream.slice(settingsStart)
  const patchLines = upstream.slice(patchStart, patchEnd).split('\n')
  for (const name of EXCLUDED_WORKSPACE_PATCHES) {
    const matches = patchLines.filter(line => line.startsWith(`  '${name}': `) || line.startsWith(`  ${name}: `))
    if (matches.length !== 1) throw new Error(`Inspect the pinned patch registration for ${name}.`)
    selectedSettings = selectedSettings.replace(matches[0] + '\n', '')
  }
  const members = STAND_INS.map(item => `  - docs/owner-profile/standins/${item.folder}\n`).join('')
  // Scope the owner workspace itself. A filter alone still verifies the full upstream lock graph.
  return (
    `packages:\n  - docs\n${members}` +
    selectedSettings +
    '\n# Owner profile: preserve the dependency-status check and refuse automatic installation.\nverifyDepsBeforeRun: error\n'
  )
}

export function ownerDocsPackage(upstream) {
  if (upstream?.name !== 'mastra-docs' || upstream.version !== '0.0.92') {
    throw new Error('The docs package identity differs from the source pin.')
  }
  const result = {
    ...upstream,
    dependencies: { ...upstream.dependencies },
    devDependencies: { ...upstream.devDependencies },
  }
  const ranges = ['^1.1.3', '^1.2.1', '^1.1.3']
  for (const [index, item] of STAND_INS.entries()) {
    const group = index === 2 ? 'devDependencies' : 'dependencies'
    if (upstream[group]?.[item.requested] !== ranges[index])
      throw new Error(`Inspect the pinned docs dependency ${item.requested}.`)
    result[group][item.requested] = `link:owner-profile/standins/${item.folder}`
  }
  return result
}

async function exists(target) {
  try {
    await access(target)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function archiveOutput(target, state, name) {
  if (await exists(target)) await rename(target, path.join(state, name))
}

function execute(argv, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: 'inherit', detached: true })
    const stop = signal => {
      try {
        process.kill(-child.pid, signal)
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    const onInterrupt = () => stop('SIGTERM')
    process.once('SIGINT', onInterrupt)
    process.once('SIGTERM', onInterrupt)
    const timer = setTimeout(() => stop('SIGTERM'), 30 * 60 * 1000)
    child.once('error', error => {
      clearTimeout(timer)
      process.removeListener('SIGINT', onInterrupt)
      process.removeListener('SIGTERM', onInterrupt)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      process.removeListener('SIGINT', onInterrupt)
      process.removeListener('SIGTERM', onInterrupt)
      resolve({ code: code ?? 128, signal })
    })
  })
}

export async function runOwnerDocs(action, inherited = process.env) {
  selectOwnerProfile(inherited)
  if (!['lock', 'install', 'build'].includes(action))
    throw new Error('Use one owner docs action: lock, install, or build.')
  const workspacePath = path.join(ROOT, 'pnpm-workspace.yaml')
  const lockPath = path.join(ROOT, 'pnpm-lock.yaml')
  const profileLock = path.join(PROFILE, 'pnpm-lock.yaml')
  const docsPackagePath = path.join(ROOT, 'docs/package.json')
  const originalWorkspace = await readFile(workspacePath)
  const originalLock = await readFile(lockPath)
  const originalDocsPackage = await readFile(docsPackagePath)
  const pinnedDocsPackage = execFileSync('git', ['show', `${SOURCE_PIN}:docs/package.json`], { cwd: ROOT })
  if (!originalDocsPackage.equals(pinnedDocsPackage))
    throw new Error('The default docs dependency declarations differ from the source pin.')
  const selectedDocsPackage = JSON.stringify(ownerDocsPackage(JSON.parse(originalDocsPackage)), null, 2) + '\n'
  const pinnedWorkspace = execFileSync('git', ['show', `${SOURCE_PIN}:pnpm-workspace.yaml`], { cwd: ROOT })
  const pinnedConfig = execFileSync('git', ['show', `${SOURCE_PIN}:docs/docusaurus.config.ts`], { cwd: ROOT })
  if (
    !originalWorkspace.equals(pinnedWorkspace) ||
    !(await readFile(path.join(ROOT, 'docs/docusaurus.config.ts'))).equals(pinnedConfig)
  ) {
    throw new Error(
      'Default docs or workspace configuration differs from the source pin. Preserve it and inspect the difference.',
    )
  }
  if ((await exists(path.join(ROOT, '.pnpmfile.mjs'))) || (await exists(path.join(ROOT, '.pnpmfile.cjs')))) {
    throw new Error('An existing root pnpmfile needs inspection. The owner profile does not replace it.')
  }
  if (action !== 'lock' && !(await exists(profileLock)))
    throw new Error('Generate and inspect the owner profile lock before installation or build.')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const state = path.join(PROFILE, '.state', `${stamp}-${action}`)
  await mkdir(state, { recursive: true, mode: 0o700 })
  await copyFile(workspacePath, path.join(state, 'upstream-pnpm-workspace.yaml'), constants.COPYFILE_EXCL)
  await copyFile(lockPath, path.join(state, 'upstream-pnpm-lock.yaml'), constants.COPYFILE_EXCL)
  await copyFile(docsPackagePath, path.join(state, 'upstream-docs-package.json'), constants.COPYFILE_EXCL)
  if (await exists(profileLock))
    await copyFile(profileLock, path.join(state, 'owner-pnpm-lock-before.yaml'), constants.COPYFILE_EXCL)
  const home = path.join(PROFILE, '.state', 'home')
  const toolbin = path.join(PROFILE, '.state', 'toolbin')
  await mkdir(home, { recursive: true, mode: 0o700 })
  await mkdir(toolbin, { recursive: true, mode: 0o700 })
  const userConfig = path.join(state, 'empty-user.npmrc')
  const globalConfig = path.join(state, 'empty-global.npmrc')
  await writeFile(userConfig, '', { flag: 'wx' })
  await writeFile(globalConfig, '', { flag: 'wx' })
  const env = {}
  for (const key of [
    'PATH',
    'TMPDIR',
    'TMP',
    'TEMP',
    'COREPACK_HOME',
    'XDG_CACHE_HOME',
    'PNPM_HOME',
    'npm_config_store_dir',
    'npm_config_cache_dir',
  ]) {
    if (inherited[key]) env[key] = inherited[key]
  }
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    CI: '1',
    MASTRA_OWNER_DOCS_PROFILE: '1',
    MASTRA_TELEMETRY_DISABLED: '1',
    MASTRA_OFFLINE: '1',
    DO_NOT_TRACK: '1',
    DOTENV_CONFIG_PATH: '/dev/null',
    TURBO_TELEMETRY_DISABLED: '1',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    PUPPETEER_SKIP_DOWNLOAD: '1',
  })
  const report = {
    profile: 'owner-embedded-docs',
    sourcePin: SOURCE_PIN,
    featureHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    action,
    disabled: STAND_INS.map(item => ({
      package: item.requested,
      ownerStandIn: item.owner,
      functionality: item.disabled,
    })),
    excludedUnusedWorkspacePatches: EXCLUDED_WORKSPACE_PATCHES,
    upstreamWorkspaceSha256: digest(originalWorkspace),
    upstreamLockSha256: digest(originalLock),
    upstreamDocsConfigSha256: digest(pinnedConfig),
    upstreamDocsPackageSha256: digest(originalDocsPackage),
    selectedDocsPackageSha256: digest(selectedDocsPackage),
    defaultRestored: false,
    state,
  }
  let changed = false
  try {
    await writeFile(workspacePath, ownerWorkspace(originalWorkspace.toString('utf8')))
    changed = true
    await writeFile(docsPackagePath, selectedDocsPackage)
    if (await exists(profileLock)) await copyFile(profileLock, lockPath)
    else await rename(lockPath, path.join(state, 'upstream-lock-before-new-profile.yaml'))
    const enabled = await execute(['corepack', 'enable', 'pnpm', '--install-directory', toolbin], env, ROOT)
    if (enabled.code !== 0) throw new Error('Corepack could not create the task-local pnpm command.')
    env.PATH = toolbin + path.delimiter + (env.PATH ?? '')
    const common = ['corepack', 'pnpm', '--filter', 'mastra-turbo', '--filter', 'mastra-docs...']
    const argv =
      action === 'lock'
        ? [
            ...common,
            'install',
            '--lockfile-only',
            '--ignore-scripts',
            '--no-frozen-lockfile',
            '--network-concurrency=8',
          ]
        : action === 'install'
          ? [...common, 'install', '--frozen-lockfile', '--prefer-offline', '--network-concurrency=8']
          : [
              'corepack',
              'pnpm',
              '--filter',
              'mastra-docs',
              'run',
              'build',
              '--config',
              'owner-profile/docusaurus.config.ts',
            ]
    if (action === 'build') {
      await archiveOutput(path.join(ROOT, 'docs/build'), state, 'previous-docs-build')
      await archiveOutput(path.join(ROOT, 'docs/.docusaurus'), state, 'previous-docusaurus')
      await archiveOutput(path.join(ROOT, 'docs/node_modules/.cache/llms-txt'), state, 'previous-llms-cache')
    }
    report.command = argv
    report.result = await execute(argv, env, ROOT)
    if (await exists(lockPath)) {
      await copyFile(lockPath, path.join(state, 'resolved-pnpm-lock.yaml'), constants.COPYFILE_EXCL)
      report.ownerLockSha256 = digest(await readFile(lockPath))
    }
    if (report.result.code === 0 && action === 'lock') await copyFile(lockPath, profileLock)
    return report.result.code
  } finally {
    if (changed) {
      await writeFile(workspacePath, originalWorkspace)
      await writeFile(lockPath, originalLock)
      await writeFile(docsPackagePath, originalDocsPackage)
    }
    report.defaultRestored =
      (await readFile(workspacePath)).equals(originalWorkspace) &&
      (await readFile(lockPath)).equals(originalLock) &&
      (await readFile(docsPackagePath)).equals(originalDocsPackage) &&
      (await readFile(path.join(ROOT, 'docs/docusaurus.config.ts'))).equals(pinnedConfig)
    await writeFile(path.join(state, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    console.log(
      JSON.stringify({
        ownerDocsProfile: action,
        result: report.result,
        defaultRestored: report.defaultRestored,
        receipt: path.join(state, 'result.json'),
      }),
    )
    if (!report.defaultRestored)
      throw new Error('The default configuration did not restore. Use the retained before-state to recover it.')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runOwnerDocs(process.argv[2])
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
