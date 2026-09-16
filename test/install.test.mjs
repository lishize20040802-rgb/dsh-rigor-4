import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { buildPlan, applyPlan, preview, parseArgs } from '../scripts/install.mjs'

const NAME = 'dsh-rigor-4'
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n')
async function exists(file) { try { await fs.lstat(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
async function tree(root) {
  const out = []
  for (const name of (await fs.readdir(root)).sort()) {
    const full = path.join(root, name), stat = await fs.lstat(full)
    out.push(stat.isDirectory() ? [name, await tree(full)] : stat.isSymbolicLink() ? [name, 'link', await fs.readlink(full)] : [name, (await fs.readFile(full)).toString('base64')])
  }
  return out
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rigor-native-install-'))
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('rigor-native-install-')); await fs.rm(root, { recursive: true, force: true }) })
  const dshHome = path.join(root, 'home with spaces'), source = path.join(root, 'source'), profile = path.join(dshHome, 'profiles', 'web'), host = path.join(root, 'official-host')
  await fs.mkdir(profile, { recursive: true })
  await fs.mkdir(path.join(source, 'src'), { recursive: true })
  await fs.mkdir(path.join(host, 'lib'), { recursive: true })
  await writeJson(path.join(host, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' })
  await fs.writeFile(path.join(host, 'lib', 'bin.js'), '// not executed by fixture runner\n')
  const manifest = { name: NAME, version: '0.1.2', type: 'module', main: 'src/index.js', files: ['src', 'preset'], testedDSHVersions: ['0.1.5-rc.2'], scripts: { prepack: 'node -e "process.exit(99)"' } }
  await writeJson(path.join(source, 'package.json'), manifest)
  await fs.writeFile(path.join(source, 'src', 'index.js'), 'export const name = "rigor-4"\n')
  await writeJson(path.join(profile, 'package.json'), { name: 'test-web', private: true, dependencies: { untouched: '1.2.3' }, dsh: { profile: { bundles: ['official-bundle'] } }, custom: { keep: true } })
  await fs.writeFile(path.join(profile, 'pnpm-lock.yaml'), 'native lock bytes before\n')
  await fs.writeFile(path.join(profile, 'pnpm-workspace.yaml'), 'nodeLinker: hoisted\nautoInstallPeers: false\n')
  for (const variant of ['standard', 'ptc', 'cordis', 'minimal']) {
    await fs.mkdir(path.join(source, 'preset', variant), { recursive: true })
    await fs.writeFile(path.join(source, 'preset', variant, 'preset.yml'), `name: ${variant}\n`)
    await fs.writeFile(path.join(source, 'preset', variant, 'agent.cordis.yml'), '- id: rigor-4\n  name: dsh-rigor-4\n')
  }
  return { root, dshHome, source, profile, manifest, options: { dshHome, packageRoot: source, dshPackage: host } }
}
function nativeRunner(f, calls, failLabel) {
  return async command => {
    calls.push(command)
    assert.equal(command.env.DSH_HOME, f.dshHome)
    assert.equal(command.env.COREPACK_ENABLE_NETWORK, '0')
    if (command.label === failLabel) throw new Error('native fixture failure; profile may contain changes')
    if (command.label === 'npm pack') {
      assert.ok(command.args.includes('--ignore-scripts'))
      const destination = command.args[command.args.indexOf('--pack-destination') + 1]
      const filename = `${NAME}-0.1.2.tgz`
      await fs.writeFile(path.join(destination, filename), 'stable fake tarball')
      return { stdout: JSON.stringify([{ filename }]) }
    }
    assert.ok(command.args.includes('--offline'))
    assert.ok(command.args.includes('--ignore-scripts'))
    assert.ok(command.args.includes('--ignore-pnpmfile'))
    assert.equal(command.cwd, f.profile)
    const manifestFile = path.join(f.profile, 'package.json')
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
    if (command.label === 'dsh plugin add') {
      manifest.dependencies[NAME] = 'file:absolute-from-native'
      await writeJson(manifestFile, manifest)
      const installed = path.join(f.profile, 'node_modules', NAME)
      await fs.mkdir(path.join(installed, 'src'), { recursive: true })
      await writeJson(path.join(installed, 'package.json'), f.manifest)
      await fs.copyFile(path.join(f.source, 'src', 'index.js'), path.join(installed, 'src', 'index.js'))
    } else {
      assert.equal(command.label, 'dsh plugin install --lockfile-only')
      assert.equal(manifest.dependencies[NAME], 'file:../../plugin-packages/dsh-rigor-4-0.1.2.tgz')
      await fs.writeFile(path.join(f.profile, 'pnpm-lock.yaml'), 'opaque native-generated lock\n')
    }
    return { stdout: '' }
  }
}

test('default mode previews and accepts explicit native paths', () => {
  assert.equal(parseArgs([]).apply, false)
  assert.deepEqual(parseArgs(['--profile', 'web-test', '--store-dir', 'cache', '--apply']), { apply: true, profile: 'web-test', storeDir: 'cache' })
  assert.throws(() => parseArgs(['--unknown']), /Unknown option/)
  assert.throws(() => parseArgs(['--dsh-home']), /Missing value/)
})
test('preview is read-only and names native operations, archive and presets', async t => {
  const f = await fixture(t), before = await tree(f.root)
  const plan = await buildPlan(f.options), shown = preview(plan)
  assert.equal(plan.dependency, 'file:../../plugin-packages/dsh-rigor-4-0.1.2.tgz')
  assert.equal(shown.presets.filter(item => item.action === 'create').length, 8)
  assert.equal(shown.commands.length, 3)
  assert.deepEqual(await tree(f.root), before)
})
test('forwards operations; only native runner owns modules and lock bytes', async t => {
  const f = await fixture(t), calls = [], beforeWorkspace = await fs.readFile(path.join(f.profile, 'pnpm-workspace.yaml'), 'utf8')
  assert.equal((await applyPlan(await buildPlan(f.options), { run: nativeRunner(f, calls) })).verified, true)
  assert.deepEqual(calls.map(call => call.label), ['npm pack', 'dsh plugin add', 'dsh plugin install --lockfile-only'])
  const manifest = JSON.parse(await fs.readFile(path.join(f.profile, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies.untouched, '1.2.3')
  assert.deepEqual(manifest.dsh.profile.bundles, ['official-bundle'])
  assert.deepEqual(manifest.custom, { keep: true })
  assert.equal(await fs.readFile(path.join(f.profile, 'pnpm-lock.yaml'), 'utf8'), 'opaque native-generated lock\n')
  assert.equal(await fs.readFile(path.join(f.profile, 'pnpm-workspace.yaml'), 'utf8'), beforeWorkspace)
  assert.equal(await exists(path.join(f.dshHome, 'local-plugins')), false)
  assert.equal(await exists(path.join(f.dshHome, 'profiles', 'node_modules')), false)
  assert.deepEqual((await fs.readdir(path.join(f.dshHome, 'plugin-packages'))), [`${NAME}-0.1.2.tgz`])
})
test('preserves custom presets unless replacement was explicit', async t => {
  const f = await fixture(t), target = path.join(f.dshHome, '.agent-presets', 'rigor-4', 'preset.yml')
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, 'custom: true\n')
  const plan = await buildPlan(f.options)
  assert.equal(plan.presets.find(item => item.target === target).action, 'preserve')
  await applyPlan(plan, { run: nativeRunner(f, []) })
  assert.equal(await fs.readFile(target, 'utf8'), 'custom: true\n')
  await applyPlan(await buildPlan({ ...f.options, replacePresets: true }), { run: nativeRunner(f, []) })
  assert.equal(await fs.readFile(target, 'utf8'), 'name: standard\n')
})
test('repeat installation reuses immutable archive and leaves presets unchanged', async t => {
  const f = await fixture(t)
  await applyPlan(await buildPlan(f.options), { run: nativeRunner(f, []) })
  const second = await buildPlan(f.options)
  assert.ok(second.presets.every(item => item.action === 'unchanged'))
  assert.equal((await applyPlan(second, { run: nativeRunner(f, []) })).verified, true)
})
test('different bytes under an existing release version fail before native add', async t => {
  const f = await fixture(t), plan = await buildPlan(f.options), calls = []
  await fs.mkdir(plan.archiveDir); await fs.writeFile(plan.archive, 'different archive')
  await assert.rejects(applyPlan(plan, { run: nativeRunner(f, calls) }), /different contents/)
  assert.deepEqual(calls.map(call => call.label), ['npm pack'])
  assert.equal(await fs.readFile(plan.archive, 'utf8'), 'different archive')
})
test('native add or lock failure does not install presets or claim rollback', async t => {
  for (const label of ['dsh plugin add', 'dsh plugin install --lockfile-only']) {
    const f = await fixture(t), calls = []
    await assert.rejects(applyPlan(await buildPlan(f.options), { run: nativeRunner(f, calls, label) }), /native fixture failure/)
    assert.equal(await exists(path.join(f.dshHome, '.agent-presets')), false)
    assert.ok((await fs.readdir(path.join(f.dshHome, 'plugin-packages'))).every(name => !name.startsWith('.rigor-pack-')))
  }
})
test('preset change during native install is detected before any preset copy', async t => {
  const f = await fixture(t), plan = await buildPlan(f.options), runner = nativeRunner(f, [])
  const target = plan.presets[0].target
  await assert.rejects(applyPlan(plan, { run: async command => {
    const result = await runner(command)
    if (command.label === 'dsh plugin install --lockfile-only') { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, 'concurrent edit') }
    return result
  } }), /Preset changed after preview/)
  assert.equal(await fs.readFile(target, 'utf8'), 'concurrent edit')
  assert.equal(await exists(plan.presets[1].target), false)
})
test('invalid profile and missing release files fail during preview', async t => {
  const f = await fixture(t)
  await assert.rejects(buildPlan({ ...f.options, profile: '../elsewhere' }), /plain directory name/)
  await fs.unlink(path.join(f.source, 'preset', 'minimal', 'preset.yml'))
  await assert.rejects(buildPlan(f.options), /ENOENT/)
})
