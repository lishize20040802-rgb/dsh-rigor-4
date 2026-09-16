import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync, openSync, ftruncateSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { apply } from '../src/index.js'

async function fixture(t) {
  const temporaryRoot = realpathSync(tmpdir())
  const root = mkdtempSync(join(temporaryRoot, 'rigor-report-'))
  t.after(() => {
    assert.equal(dirname(root), temporaryRoot)
    assert.ok(basename(root).startsWith('rigor-report-'))
    rmSync(root, { recursive: true, force: true })
  })
  const tools = new Map(), events = new Map()
  let state
  apply({
    tools: { register: tool => tools.set(tool.name, tool) },
    get: () => undefined,
    on: (event, callback) => events.set(event, callback),
  }, { capabilities: { children: false, person: false }, backend: { read: () => state, write: text => { state = text } } })
  const agent = { id: 'real-report-fixture', session: { header: { cwd: root } } }
  const execute = (name, args) => tools.get(name).execute(args, { agent })
  await execute('rigor_read', { literal: 'deliver a working module', needs: 'stated: module works => imported function returns the expected result' })
  const strategy = { risk: { impact: 'low', uncertainty: 'low', reason: 'A reversible fixture module.' },
    checks: [{ id: 'C1', need: 'N1', kind: 'delivery', criterion: 'Import the actual module and verify its result.' }] }
  await execute('rigor_plan', { approach: 'Import the final file and check its result.', steps: 'verify => serves N1 => import the module and assert its result', strategy: JSON.stringify(strategy) })
  writeFileSync(join(root, 'subject.mjs'), 'export const result = 42\n')
  writeFileSync(join(root, 'verify.mjs'), `
    import { result } from './subject.mjs';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    if (result !== 42) throw new Error('wrong result');
    writeFileSync('report.json', JSON.stringify({ check:'C1', status:'passed',
      observed:'Imported subject.mjs and verified result=42.', environment:process.version,
      subject:{ path:'subject.mjs', sha256:createHash('sha256').update(readFileSync('subject.mjs')).digest('hex') } }));
  `)
  const run = spawnSync(process.execPath, ['verify.mjs'], { cwd: root, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const call = { agent, name: 'pwsh', arguments: { command: 'node verify.mjs' }, callId: 'real-run' }
  const result = { isError: false, value: { exitCode: run.status }, content: run.stdout }
  await events.get('tools/execute')(call, async () => result)
  await events.get('tools/post-execute')(call, result, async () => {})
  const link = () => execute('rigor_evidence', { needs: 'N1', check: 'C1', ref: 'artifact:report.json', run: 'cmd:node verify.mjs' })
  const done = () => execute('rigor_report', { status: 'done', per_need: 'N1 met', limitations: 'This fixture has no independent review or user question channel.' })
  return { root, execute, link, done }
}

test('native adapter reads a real subprocess report, resolves relative subjects and detects later changes', async t => {
  const f = await fixture(t)
  const linked = await f.link()
  assert.equal(linked.recorded, true, JSON.stringify(linked))
  assert.equal(linked.validation.status, 'passed')
  assert.equal(linked.validation.subject.path, realpathSync(join(f.root, 'subject.mjs')))
  assert.equal((await f.done()).recorded, true)
  writeFileSync(join(f.root, 'subject.mjs'), 'export const result = 99\n')
  const changed = await f.done()
  assert.equal(changed.recorded, false)
  assert.equal(changed.code, 'stale-artifact')
})

test('real report limits apply before initial hashing and again at completion', async t => {
  const f = await fixture(t)
  assert.equal((await f.link()).recorded, true)
  const fd = openSync(join(f.root, 'report.json'), 'r+')
  try { ftruncateSync(fd, 8 * 1024 * 1024) } finally { closeSync(fd) }
  const relinked = await f.link()
  assert.equal(relinked.recorded, false)
  assert.match(relinked.refused, /exceeds 262144/)
  const completed = await f.done()
  assert.equal(completed.recorded, false)
  assert.equal(completed.code, 'stale-artifact')
})
