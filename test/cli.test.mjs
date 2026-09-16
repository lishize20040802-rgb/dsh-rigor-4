import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { main, parseCliArgs } from '../scripts/cli.mjs'

test('release setup and uninstall apply by default while preview never applies', async () => {
  for (const command of ['setup', 'uninstall']) for (const mode of [[], ['--preview'], ['--dry-run']]) {
    const calls = [], outputs = [], plan = { name: 'synthetic plan' }
    const build = async options => { calls.push(['build', options]); return plan }
    const apply = async input => { assert.equal(input, plan); calls.push(['apply']); return { verified: true } }
    await main([command, ...mode, '--profile', 'alternate', '--dsh-home', 'chosen-home'], {
      buildPlan: build, buildUninstallPlan: build, applyPlan: apply, applyUninstallPlan: apply,
      preview: input => input, previewUninstall: input => input, log: value => outputs.push(value),
    })
    assert.equal(calls.length, mode.length ? 1 : 2)
    assert.equal(outputs.length, mode.length ? 1 : 2)
    assert.equal(calls[0][1].profile, 'alternate')
    assert.equal(calls[0][1].dshHome, 'chosen-home')
    assert.equal(calls[0][1].apply, !mode.length)
  }
})

test('CLI routes each operation to its matching native installer', async () => {
  const calls = [], runtime = {
    buildPlan: async () => { calls.push('setup plan'); return {} },
    applyPlan: async () => { calls.push('setup apply'); return {} },
    buildUninstallPlan: async () => { calls.push('uninstall plan'); return {} },
    applyUninstallPlan: async () => { calls.push('uninstall apply'); return {} },
    preview: () => ({}), previewUninstall: () => ({}), log: () => {},
  }
  await main(['setup'], runtime)
  await main(['uninstall'], runtime)
  assert.deepEqual(calls, ['setup plan', 'setup apply', 'uninstall plan', 'uninstall apply'])
})

test('CLI help and argument errors run no plan or package commands', async () => {
  const lines = [], never = () => assert.fail('help must be read-only')
  await main(['setup', '--help'], { buildPlan: never, applyPlan: never, log: line => lines.push(line) })
  assert.match(lines[0], /setup and uninstall apply by default/)
  assert.deepEqual(parseCliArgs([]), { help: true })
  assert.throws(() => parseCliArgs(['remove']), /setup or uninstall/)
  assert.throws(() => parseCliArgs(['setup', '--preview', '--apply']), /not both/)
  assert.throws(() => parseCliArgs(['setup', '--dsh-home']), /Missing value/)
  assert.throws(() => parseCliArgs(['setup', '--unknown']), /Unknown option/)
})

test('packaged executable also starts through a linked bin directory', async t => {
  const temporaryRoot = await fs.realpath(os.tmpdir())
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'rigor-cli-bin-'))
  t.after(async () => {
    assert.equal(path.dirname(root), temporaryRoot)
    assert.ok(path.basename(root).startsWith('rigor-cli-bin-'))
    await fs.rm(root, { recursive: true, force: true })
  })
  const source = fileURLToPath(new URL('../scripts', import.meta.url)), alias = path.join(root, 'bin')
  await fs.symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const result = spawnSync(process.execPath, [path.join(alias, 'cli.mjs'), '--help'], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /dsh-rigor-4 setup\|uninstall/)
})
