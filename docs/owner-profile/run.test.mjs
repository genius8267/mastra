import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  EXCLUDED_WORKSPACE_PATCHES,
  OWNER_FLAG,
  SOURCE_PIN,
  STAND_INS,
  ownerDocsPackage,
  ownerWorkspace,
  selectOwnerProfile,
} from './run.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const profile = fileURLToPath(new URL('.', import.meta.url))

test('the default profile cannot select owner substitutions or change default files', async () => {
  const files = ['pnpm-workspace.yaml', 'pnpm-lock.yaml', 'docs/docusaurus.config.ts', 'docs/package.json']
  const before = await Promise.all(files.map(name => readFile(path.join(root, name))))
  const result = spawnSync(process.execPath, [path.join(profile, 'run.mjs'), 'build'], {
    cwd: root,
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Set MASTRA_OWNER_DOCS_PROFILE=1/)
  for (const [index, name] of files.entries()) {
    assert.deepEqual(await readFile(path.join(root, name)), before[index])
    assert.deepEqual(
      before[index],
      execFileSync('git', ['show', `${SOURCE_PIN}:${name}`], { cwd: root, maxBuffer: 32 * 1024 * 1024 }),
    )
  }
})

test('only the explicit owner flag selects the three declared substitutions', () => {
  for (const value of [undefined, '', '0', 'true', '1 ']) {
    assert.throws(() => selectOwnerProfile({ [OWNER_FLAG]: value }), /Set MASTRA_OWNER_DOCS_PROFILE=1/)
  }
  assert.deepEqual(
    selectOwnerProfile({ [OWNER_FLAG]: '1' }).map(item => item.requested),
    ['@mastra/docusaurus-plugin-algolia', '@mastra/docusaurus-plugin-kapa', '@mastra/lint-docs'],
  )
})

test('the owner configuration preserves upstream policy and enables dependency-status refusal', async () => {
  const upstream = await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8')
  const owner = ownerWorkspace(upstream)
  let restored = owner.replace(
    '\n# Owner profile: preserve the dependency-status check and refuse automatic installation.\nverifyDepsBeforeRun: error\n',
    '',
  )
  for (const item of STAND_INS) {
    restored = restored.replace(`  '${item.requested}': link:./docs/owner-profile/standins/${item.folder}\n`, '')
  }
  let expectedSettings = upstream.slice(upstream.indexOf('\nenableGlobalVirtualStore:'))
  const originalPatchLines = upstream
    .slice(upstream.indexOf('\npatchedDependencies:\n'), upstream.indexOf('\npackageExtensions:'))
    .split('\n')
  for (const name of EXCLUDED_WORKSPACE_PATCHES) {
    const line = originalPatchLines.find(value => value.startsWith(`  '${name}': `) || value.startsWith(`  ${name}: `))
    assert.ok(line)
    expectedSettings = expectedSettings.replace(line + '\n', '')
  }
  assert.equal(restored.slice(restored.indexOf('\nenableGlobalVirtualStore:')), expectedSettings)
  for (const name of ['body-parser@2.4.0', '@changesets/get-dependents-graph@2.1.4', 'read-yaml-file@1.1.0']) {
    assert.ok(owner.includes(name), `The selected graph must retain the ${name} patch.`)
  }
  assert.equal((owner.match(/^  - /gm) ?? []).length >= 4, true)
  assert.equal(
    owner.slice(0, owner.indexOf('\nenableGlobalVirtualStore:')),
    'packages:\n  - docs\n' + STAND_INS.map(item => `  - docs/owner-profile/standins/${item.folder}\n`).join(''),
  )
  assert.match(owner, /^verifyDepsBeforeRun: error$/m)
})

test('the active package declarations match native link specifiers without changing default package metadata', async () => {
  const original = JSON.parse(await readFile(path.join(root, 'docs/package.json'), 'utf8'))
  const before = structuredClone(original)
  const active = ownerDocsPackage(original)
  for (const [index, item] of STAND_INS.entries()) {
    const group = index === 2 ? 'devDependencies' : 'dependencies'
    assert.equal(active[group][item.requested], `link:owner-profile/standins/${item.folder}`)
    active[group][item.requested] = original[group][item.requested]
  }
  assert.deepEqual(active, original)
  assert.deepEqual(original, before)
  assert.throws(() => ownerDocsPackage({ ...original, version: 'unexpected' }), /identity differs/)
})

test('an unexpected upstream configuration refuses instead of silently replacing policy', () => {
  assert.throws(() => ownerWorkspace('packages: []\n'), /expected package and override sections/)
  assert.throws(() => ownerWorkspace('packages:\noverrides:\nverifyDepsBeforeRun: install\n'), /already selects/)
})

for (const folder of ['algolia', 'kapa']) {
  test(`${folder} adds no Docusaurus hooks, UI, service or content producer`, async () => {
    const file = path.join(profile, 'standins', folder, 'index.cjs')
    const code = 'console.log(JSON.stringify(require(process.argv[1])({}, {})))'
    const inactive = spawnSync(process.execPath, ['-e', code, file], {
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    })
    assert.equal(inactive.status, 1)
    assert.match(inactive.stderr, /requires MASTRA_OWNER_DOCS_PROFILE=1/)
    const active = spawnSync(process.execPath, ['-e', code, file], {
      env: { PATH: process.env.PATH, MASTRA_OWNER_DOCS_PROFILE: '1' },
      encoding: 'utf8',
    })
    assert.equal(active.status, 0)
    const plugin = JSON.parse(active.stdout)
    assert.deepEqual(Object.keys(plugin), ['name'])
    assert.match(plugin.name, /^intunelabs-owner-docs-noop-/)
    const pkg = JSON.parse(await readFile(path.join(profile, 'standins', folder, 'package.json'), 'utf8'))
    assert.equal(pkg.name, `@intunelabs/owner-docs-${folder}`)
    assert.equal(pkg.private, true)
    assert.equal(pkg.dependencies, undefined)
  })
}

test('the lint compatibility command discloses its stand-in behavior', () => {
  const file = path.join(profile, 'standins/lint/cli.cjs')
  const inactive = spawnSync(process.execPath, [file], { env: { PATH: process.env.PATH }, encoding: 'utf8' })
  assert.equal(inactive.status, 1)
  assert.match(inactive.stderr, /requires MASTRA_OWNER_DOCS_PROFILE=1/)
  const result = spawnSync(process.execPath, [file], {
    env: { PATH: process.env.PATH, MASTRA_OWNER_DOCS_PROFILE: '1' },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /Owner stand-in/)
  assert.match(result.stdout, /No upstream lint ran/)
})
