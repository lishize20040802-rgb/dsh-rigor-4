import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { globalDshPackage, profileStoreDir } from '../scripts/native-tools.mjs'

async function fixture(t) {
  const temporaryRoot = await fs.realpath(os.tmpdir())
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'rigor-native-tools-'))
  t.after(async () => {
    assert.equal(path.dirname(root), temporaryRoot)
    assert.ok(path.basename(root).startsWith('rigor-native-tools-'))
    await fs.rm(root, { recursive: true, force: true })
  })
  const profile = path.join(root, 'profile'), host = path.join(root, 'host')
  await fs.mkdir(path.join(profile, 'node_modules'), { recursive: true })
  await fs.mkdir(host)
  await fs.writeFile(path.join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
  return { root, profile, host, metadata: path.join(profile, 'node_modules', '.modules.yaml') }
}

test('missing store metadata leaves the package-manager defaults available', async t => {
  const f = await fixture(t)
  assert.equal(await profileStoreDir(f.profile, f.host), undefined)
  await fs.writeFile(f.metadata, '{}')
  assert.equal(await profileStoreDir(f.profile, f.host), undefined)
})

test('store metadata handles versioned and unversioned absolute paths', async t => {
  const f = await fixture(t), store = path.join(f.root, 'store with spaces')
  for (const recorded of [store, path.join(store, 'v10'), path.join(store, 'v11') + path.sep]) {
    await fs.writeFile(f.metadata, JSON.stringify({ storeDir: recorded }))
    assert.equal(await profileStoreDir(f.profile, f.host), store)
  }
})

test('YAML parsing uses the selected official host dependency', async t => {
  const f = await fixture(t), parser = path.join(f.host, 'node_modules', 'js-yaml'), store = path.join(f.root, 'original store')
  await fs.mkdir(parser, { recursive: true })
  await fs.writeFile(path.join(parser, 'package.json'), JSON.stringify({ name: 'js-yaml', main: 'index.cjs' }))
  // A host-owned parser substitute verifies resolution and the complete input.
  await fs.writeFile(path.join(parser, 'index.cjs'), `exports.load = text => { if (text !== 'storeDir: fixture-store\\n') throw new Error('unexpected input'); return ${JSON.stringify({ storeDir: path.join(store, 'v11') })} }`)
  await fs.writeFile(f.metadata, 'storeDir: fixture-store\n')
  assert.equal(await profileStoreDir(f.profile, f.host), store)
})

test('unusable store metadata stops before package changes and explains the override', async t => {
  const f = await fixture(t)
  await fs.writeFile(f.metadata, 'storeDir: [')
  await assert.rejects(profileStoreDir(f.profile, f.host), /Pass --store-dir explicitly/)
  await assert.rejects(profileStoreDir(f.profile, f.host, { loadYaml: () => { throw new Error('bad yaml') } }), /metadata is invalid/)
  for (const value of [null, [], 'scalar']) {
    await fs.writeFile(f.metadata, JSON.stringify(value))
    await assert.rejects(profileStoreDir(f.profile, f.host), /must be a mapping/)
  }
  for (const storeDir of ['relative/store', 42, path.join(f.root, 'store') + '\n']) {
    await fs.writeFile(f.metadata, JSON.stringify({ storeDir }))
    await assert.rejects(profileStoreDir(f.profile, f.host), /absolute path/)
  }
})

test('global DSH probing rejects a missing or mismatched installation', async t => {
  const f = await fixture(t), npm = { executable: 'fixture-npm', prefix: [] }
  const probe = async stdout => globalDshPackage(npm, async () => ({ stdout }))
  await assert.rejects(probe('relative/path'), /valid global package directory/)
  await assert.rejects(probe(f.root + '\nextra'), /valid global package directory/)
  await assert.rejects(probe(f.root), /global @deepseek-ai\/dsh installation was not found/)
  const impostor = path.join(f.root, '@deepseek-ai', 'dsh')
  await fs.mkdir(impostor, { recursive: true })
  await fs.writeFile(path.join(impostor, 'package.json'), '{"name":"unrelated-package"}')
  await assert.rejects(probe(f.root), /identity does not match/)
})
