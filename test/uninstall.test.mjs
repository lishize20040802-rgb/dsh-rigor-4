import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildUninstallPlan, applyUninstallPlan, previewUninstall } from '../scripts/uninstall.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rigor-uninstall-'))
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('rigor-uninstall-')); await fs.rm(root, { recursive: true, force: true }) })
  const profile = path.join(root, 'profiles', 'web'), host = path.join(root, 'host')
  await fs.mkdir(profile, { recursive: true }); await fs.mkdir(path.join(host, 'lib'), { recursive: true })
  await fs.writeFile(path.join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' }))
  await fs.writeFile(path.join(host, 'lib', 'bin.js'), '// fixture')
  const manifestFile = path.join(profile, 'package.json')
  await fs.writeFile(manifestFile, JSON.stringify({ dependencies: { 'dsh-rigor-4': 'file:release.tgz', untouched: '1.0.0' }, dsh: { profile: { bundles: ['official'] } } }))
  const options = { dshHome: root, dshPackage: host, packageRoot: fileURLToPath(new URL('../', import.meta.url)) }
  for (const item of (await buildUninstallPlan(options)).presets) { await fs.mkdir(path.dirname(item.target), { recursive: true }); await fs.writeFile(item.target, item.bytes) }
  const state = path.join(root, '.rigor4', 'sessions', 'fixture.json')
  await fs.mkdir(path.dirname(state), { recursive: true }); await fs.writeFile(state, 'retained state')
  let calls = 0
  const run = async command => {
    calls++
    assert.equal(command.label, 'dsh plugin remove')
    assert.ok(command.args.includes('--ignore-scripts'))
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
    delete manifest.dependencies['dsh-rigor-4']
    await fs.writeFile(manifestFile, JSON.stringify(manifest))
  }
  return { root, options, state, manifestFile, run, calls: () => calls }
}

test('uninstall previews then removes only package-owned presets, preserving state and other dependencies', async t => {
  const f = await fixture(t), plan = await buildUninstallPlan(f.options)
  assert.equal(previewUninstall(plan).presets.filter(item => item.action === 'remove').length, 8)
  assert.equal(f.calls(), 0)
  const result = await applyUninstallPlan(plan, { run: f.run })
  assert.equal(result.presetsRemoved, 8)
  assert.equal(await fs.readFile(f.state, 'utf8'), 'retained state')
  const manifest = JSON.parse(await fs.readFile(f.manifestFile, 'utf8'))
  assert.equal(manifest.dependencies.untouched, '1.0.0')
  assert.deepEqual(manifest.dsh.profile.bundles, ['official'])
  const again = await applyUninstallPlan(await buildUninstallPlan(f.options), { run: f.run })
  assert.equal(again.removed, false)
  assert.equal(f.calls(), 1)
})

test('customized presets block all removal before the package manager runs', async t => {
  const f = await fixture(t), target = (await buildUninstallPlan(f.options)).presets[0].target
  await fs.writeFile(target, 'custom definition')
  await assert.rejects(applyUninstallPlan(await buildUninstallPlan(f.options), { run: f.run }), /Customized/)
  assert.equal(f.calls(), 0)
  assert.equal(await fs.readFile(target, 'utf8'), 'custom definition')
})

test('presets stay available when another profile still uses Rigor', async t => {
  const f = await fixture(t), other = path.join(f.root, 'profiles', 'another')
  await fs.mkdir(other)
  await fs.writeFile(path.join(other, 'package.json'), JSON.stringify({ dependencies: { 'dsh-rigor-4': 'file:another.tgz' } }))
  const plan = await buildUninstallPlan(f.options)
  assert.equal(plan.otherProfiles[0], 'another')
  assert.equal((await applyUninstallPlan(plan, { run: f.run })).presetsRemoved, 0)
  assert.ok((await fs.readFile(plan.presets[0].target)).length > 0)
})

test('native removal failure preserves every preset and user state', async t => {
  const f = await fixture(t), plan = await buildUninstallPlan(f.options)
  await assert.rejects(applyUninstallPlan(plan, { run: async () => { throw new Error('native failure') } }), /native failure/)
  for (const item of plan.presets) assert.deepEqual(await fs.readFile(item.target), item.bytes)
  assert.equal(await fs.readFile(f.state, 'utf8'), 'retained state')
})
