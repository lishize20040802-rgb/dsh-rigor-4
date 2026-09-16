import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyArtifacts } from '../src/validation.js'
import { adopt } from '../src/store.js'
import { createPlanTool } from '../src/tools.js'
import { createRound, evaluateDone, linkEvidence, recordPlan, recordReading, requiredRoles } from '../src/model.js'

const fingerprint = label => `sha256:${label}`
const artifact = (path, hash = path) => ({ kind: 'artifact', path, fingerprint: fingerprint(hash) })
const check = (id, report, subject, options = {}) => ({
  ...artifact(report), check: id, need: options.need ?? 'N1',
  validation: { status: options.status ?? 'passed', subject: { path: subject, fingerprint: fingerprint(options.subjectHash ?? subject) } },
})

function files(entries) {
  const calls = [], agent = { id: 'validation-fixture' }, available = new Map(entries)
  const deps = {
    stat(path, requestingAgent, options = {}) {
      assert.equal(requestingAgent, agent)
      calls.push({ path, options })
      const info = available.get(path)
      if (!info) return { exists: false }
      if (options.maxBytes !== undefined && info.size > options.maxBytes) return { exists: true, tooLarge: true, size: info.size }
      return { exists: true, isFile: true, size: 100, ...info }
    },
  }
  return { calls, agent, deps }
}

const present = (path, hash = path) => [path, { fingerprint: fingerprint(hash) }]

test('completion bounds a typed report before hashing even if ordinary evidence names it first', () => {
  const world = files([['report.json', { size: 262145, fingerprint: fingerprint('report.json') }], present('output.bin')])
  const result = verifyArtifacts([artifact('report.json'), check('C1', 'report.json', 'output.bin')], world.deps, world.agent)
  assert.deepEqual(result, { ok: false, path: 'report.json' })
  assert.deepEqual(world.calls, [{ path: 'report.json', options: { maxBytes: 262144 } }])
})

test('a report exactly at the limit remains valid and its larger subject is still verified', () => {
  const world = files([
    ['report.json', { size: 262144, fingerprint: fingerprint('report.json') }],
    ['output.bin', { size: 900000, fingerprint: fingerprint('output.bin') }],
  ])
  assert.deepEqual(verifyArtifacts([check('C1', 'report.json', 'output.bin')], world.deps, world.agent), { ok: true })
  assert.equal(world.calls.find(call => call.path === 'report.json').options.maxBytes, 262144)
  assert.equal(world.calls.find(call => call.path === 'output.bin').options.maxBytes, undefined)
})

test('a successful retry supersedes the failed report and subject that its runner cleaned up', () => {
  const world = files([present('passed.json'), present('current.bin')])
  const evidence = [
    check('C1', 'failed.json', 'obsolete.bin', { status: 'failed' }),
    check('C1', 'passed.json', 'current.bin'),
  ]
  assert.deepEqual(verifyArtifacts(evidence, world.deps, world.agent), { ok: true })
  assert.deepEqual(world.calls.map(call => call.path), ['passed.json', 'current.bin'])
})

test('selection follows the newest typed evidence rather than searching backward for a passing report', () => {
  const world = files([present('old-pass.json'), present('old.bin')])
  const evidence = [check('C1', 'old-pass.json', 'old.bin'), check('C1', 'latest-failure.json', 'new.bin', { status: 'failed' })]
  assert.deepEqual(verifyArtifacts(evidence, world.deps, world.agent), { ok: false, path: 'latest-failure.json' })
  assert.deepEqual(world.calls.map(call => call.path), ['latest-failure.json'])
})

test('supersession is scoped to both check and need, while ordinary evidence remains required', () => {
  const evidence = [
    check('C1', 'need-one.json', 'one.bin'),
    check('C1', 'need-two.json', 'two.bin', { need: 'N2' }),
    artifact('ordinary.txt'),
  ]
  const world = files([present('need-two.json'), present('two.bin'), present('ordinary.txt')])
  assert.deepEqual(verifyArtifacts(evidence, world.deps, world.agent), { ok: false, path: 'need-one.json' })
  const ordinary = files([present('need-one.json'), present('one.bin')])
  assert.deepEqual(verifyArtifacts([evidence[0], artifact('ordinary.txt')], ordinary.deps, ordinary.agent), { ok: false, path: 'ordinary.txt' })
})

test('a current subject changing after validation prevents completion even if the report is unchanged', () => {
  const world = files([present('report.json'), present('output.bin', 'changed-output')])
  assert.deepEqual(verifyArtifacts([check('C1', 'report.json', 'output.bin')], world.deps, world.agent), { ok: false, path: 'output.bin' })
  assert.ok(world.calls.some(call => call.path === 'output.bin'))
})

test('different checks sharing a subject hash it once without skipping either report', () => {
  const world = files([present('functional.json'), present('performance.json'), present('shared.bin')])
  const evidence = [check('C1', 'functional.json', 'shared.bin'), check('C2', 'performance.json', 'shared.bin')]
  assert.deepEqual(verifyArtifacts(evidence, world.deps, world.agent), { ok: true })
  assert.equal(world.calls.filter(call => call.path === 'shared.bin').length, 1)
  assert.equal(world.calls.filter(call => call.path.endsWith('.json')).length, 2)
})

test('cached verification still rejects contradictory hashes for a shared subject', () => {
  const world = files([present('first.json'), present('second.json'), present('shared.bin')])
  const evidence = [check('C1', 'first.json', 'shared.bin'), check('C2', 'second.json', 'shared.bin', { subjectHash: 'different-version' })]
  assert.deepEqual(verifyArtifacts(evidence, world.deps, world.agent), { ok: false, path: 'shared.bin' })
  assert.equal(world.calls.filter(call => call.path === 'shared.bin').length, 1)
})

test('report paths shared by different checks use one bounded read and retain hash conflict checks', () => {
  const evidence = [check('C1', 'shared.json', 'one.bin'), check('C2', 'shared.json', 'two.bin')]
  const world = files([present('shared.json'), present('one.bin'), present('two.bin')])
  assert.deepEqual(verifyArtifacts(evidence, world.deps, world.agent), { ok: true })
  assert.deepEqual(world.calls.filter(call => call.path === 'shared.json'), [{ path: 'shared.json', options: { maxBytes: 262144 } }])
  const conflict = files([present('shared.json'), present('one.bin'), present('two.bin')])
  evidence[1].fingerprint = fingerprint('different-report')
  assert.deepEqual(verifyArtifacts(evidence, conflict.deps, conflict.agent), { ok: false, path: 'shared.json' })
  assert.equal(conflict.calls.filter(call => call.path === 'shared.json').length, 1)
})

test('unreadable, non-file, changing and oversized artifacts fail closed', () => {
  for (const info of [{ exists: false }, { isFile: false }, { changedDuringRead: true }, { tooLarge: true }]) {
    const world = files([['report.json', { fingerprint: fingerprint('report.json'), ...info }]])
    assert.equal(verifyArtifacts([check('C1', 'report.json', 'out.bin')], world.deps, world.agent).ok, false)
  }
  assert.deepEqual(verifyArtifacts([artifact('report.json')], { stat() { throw new Error('unreadable fixture') } }), { ok: false, path: 'report.json' })
})

const risk = { impact: 'low', uncertainty: 'low', reason: 'A bounded reversible fixture' }
function prepared() {
  let round = recordReading(createRound(0, 'strategy-recovery'), {
    literal: 'Preserve the expected delivered value',
    needs: [{ kind: 'stated', text: 'The output keeps its expected value', test: 'Inspect the delivered output value' }], at: 1,
  }).round
  return recordPlan(round, { approach: 'Inspect the delivered output', steps: [{ text: 'Inspect output', serves: ['N1'], evidence: 'The inspected value is correct' }], strategy: { risk }, at: 2 }).round
}

test('malformed persisted strategy yields a repairable refusal rather than throwing or assuming low risk', () => {
  const invalid = [{}, { risk: null }, { risk: { ...risk, impact: 'invalid' } }, { risk, checks: 'invalid-list' }, { risk, questions: {} }]
  for (const strategy of invalid) {
    const initial = prepared(), round = adopt({ ...initial, plan: { ...initial.plan, strategy } })
    if (!strategy.risk || strategy.risk.impact === 'invalid') assert.equal(requiredRoles(round).reviews, 2)
    const result = evaluateDone(round, { capabilities: { children: false, person: false }, limitations: ['No independent review channel'], perNeed: [{ id: 'N1', status: 'met' }] })
    assert.equal(result.ok, false)
    assert.ok(result.refusals.some(item => item.code === 'invalid-strategy'), JSON.stringify(result.refusals))
  }
})

test('a valid explicit plan repairs malformed persisted strategy without discarding the reading', () => {
  const initial = prepared(), agent = { id: 'recovery-fixture' }
  let round = adopt({ ...initial, plan: { ...initial.plan, strategy: {} } })
  const tool = createPlanTool({
    sessionFor: () => round, save: (_agent, updated) => { round = updated }, now: () => 3,
    capabilities: { children: false, person: false },
  })
  const result = tool.execute({
    approach: 'Inspect the final delivered value',
    steps: 'Inspect final output => serves N1 => the observed output matches the requirement',
    strategy: JSON.stringify({ risk }),
  }, { agent })
  assert.equal(result.recorded, true, JSON.stringify(result))
  assert.equal(round.reading.version, initial.reading.version)
  assert.equal(requiredRoles(round).reviews, 1)
  round = linkEvidence(round, { need: 'N1', fact: artifact('current.bin'), at: 4 })
  const done = evaluateDone(round, { capabilities: { children: false, person: false }, limitations: ['No independent review or user question channel'], perNeed: [{ id: 'N1', status: 'met' }] })
  assert.equal(done.ok, true, JSON.stringify(done.refusals))
})
