import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { adopt, createFileBackend, createStore, decode, encode, FORMAT } from '../src/store.js'
import { createRound, recordPlan, recordReading, recordRequest, ROLES, SHAPE } from '../src/model.js'

function fixture(t) {
  const temporaryRoot = realpathSync(tmpdir())
  const directory = mkdtempSync(join(temporaryRoot, 'rigor-store-strategy-'))
  t.after(() => {
    assert.equal(dirname(directory), temporaryRoot)
    assert.ok(basename(directory).startsWith('rigor-store-strategy-'))
    rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

function roundWithPlan() {
  let round = recordRequest(createRound(1, 'strategy-round'), { text: 'Preserve the original task across reloads', at: 1 })
  round = recordReading(round, {
    literal: 'Preserve the original task across reloads',
    needs: [{ kind: 'stated', text: 'Keep the existing session', test: 'Reopen the same round with its recorded evidence' }],
    unknowns: [], at: 2,
  }).round
  return recordPlan(round, {
    approach: 'Extend the existing state without resetting the session',
    steps: [{ text: 'Reload the extended record', serves: ['N1'], evidence: 'Inspect the reopened session' }],
    risks: ['dropping optional metadata'], at: 3,
  }).round
}

// Synthetic JSON records exercise persistence, not strategy business validation.
function extendedRound() {
  const round = roundWithPlan()
  round.plan.strategy = {
    risk: { impact: 'medium', uncertainty: 'low', reason: 'An incomplete hydrate can discard recorded metadata' },
    options: [{ id: 'O1', approach: 'Keep optional fields in the existing state format' }],
    selected: 'O1', decision: 'Preserve the current session and its metadata',
    technology: [{ name: 'Node.js', purpose: 'Use the existing storage runtime' }],
    execution: [{ owner: 'root', task: 'Verify saved records' }],
    checks: [{ id: 'C1', targets: ['storage'], required: true }], questions: [],
  }
  round.evidence = [{
    seq: 4, at: 4, need: 'N1', kind: 'command', ref: 'command:4', seqOfFact: 4,
    check: 'C1',
    validation: {
      status: 'passed', observed: 'The same round was reloaded', environment: 'synthetic fixture', commandSeq: 4,
      subject: { path: 'fixture.json', fingerprint: 'synthetic-sha256' }, measured: 1, baseline: 1, errors: [],
    },
  }]
  return round
}

test('optional strategy and evidence records survive encode/decode without sharing mutable objects', () => {
  const original = extendedRound()
  const restored = decode(encode(new Map([['session', original]]))).get('session')
  assert.deepEqual(restored.plan.strategy, original.plan.strategy)
  assert.deepEqual(restored.evidence[0].check, original.evidence[0].check)
  assert.deepEqual(restored.evidence[0].validation, original.evidence[0].validation)
  const adopted = adopt(original)
  adopted.plan.strategy.checks[0].targets.push('another target')
  adopted.evidence[0].check = 'C2'
  adopted.evidence[0].validation.subject.fingerprint = 'changed fingerprint'
  adopted.evidence[0].validation.errors.push('another observation')
  assert.deepEqual(original.plan.strategy.checks[0].targets, ['storage'])
  assert.equal(original.evidence[0].check, 'C1')
  assert.equal(original.evidence[0].validation.subject.fingerprint, 'synthetic-sha256')
  assert.deepEqual(original.evidence[0].validation.errors, [])
})

test('legacy shape-2 records remain present and do not receive invented strategy or validation', t => {
  const directory = fixture(t), oldRound = roundWithPlan()
  oldRound.evidence = [{ seq: 4, at: 4, need: 'N1', kind: 'read', ref: 'read:4', note: 'older evidence remains' }]
  const legacy = JSON.stringify({ format: 2, sessions: { old: oldRound, unrelated: createRound(0, 'another-round') } })
  const legacyPath = join(directory, 'sessions.json')
  writeFileSync(legacyPath, legacy)
  const store = createStore(createFileBackend({ directory })), loaded = store.load()
  assert.equal(FORMAT, 2)
  assert.equal(SHAPE, 2)
  assert.deepEqual([...loaded.keys()], ['old', 'unrelated'])
  assert.equal(loaded.get('old').roundId, oldRound.roundId)
  assert.equal(loaded.get('old').reading.literal, oldRound.reading.literal)
  assert.equal(loaded.get('old').evidence[0].note, 'older evidence remains')
  assert.equal(Object.hasOwn(loaded.get('old').plan, 'strategy'), false)
  assert.equal(Object.hasOwn(loaded.get('old').evidence[0], 'check'), false)
  assert.equal(Object.hasOwn(loaded.get('old').evidence[0], 'validation'), false)
  assert.equal(store.saveSession('old', recordRequest(loaded.get('old'), { text: 'continue', at: 5 })).ok, true)
  assert.equal(readFileSync(legacyPath, 'utf8'), legacy)
  assert.equal(createStore(createFileBackend({ directory })).loadSession('old').roundId, oldRound.roundId)
  assert.equal(createStore(createFileBackend({ directory })).loadSession('unrelated').roundId, 'another-round')
})

test('a file-backed reload preserves optional records and subsequent metadata-only saves', t => {
  const directory = fixture(t), backend = createFileBackend({ directory }), original = extendedRound()
  assert.equal(createStore(backend).saveSession('session', original).ok, true)
  const reopened = createStore(createFileBackend({ directory })), sessions = reopened.load()
  assert.deepEqual(sessions.get('session').plan.strategy, original.plan.strategy)
  assert.deepEqual(sessions.get('session').evidence[0].validation, original.evidence[0].validation)
  sessions.get('session').plan.strategy.decision = 'Preserve prior records during reload'
  sessions.get('session').evidence[0].validation.observed = 'The synthetic round and its evidence were rechecked'
  assert.equal(reopened.save(sessions).ok, true)
  const final = createStore(createFileBackend({ directory })).loadSession('session')
  assert.equal(final.plan.strategy.decision, 'Preserve prior records during reload')
  assert.equal(final.evidence[0].validation.observed, 'The synthetic round and its evidence were rechecked')
  const filename = readdirSync(backend.sessionDirectory).find(name => name.endsWith('.json'))
  assert.equal(JSON.parse(readFileSync(join(backend.sessionDirectory, filename), 'utf8')).revision, 2)
})

test('legacy backend conflict detection includes each optional metadata field', () => {
  for (const change of [
    round => { round.plan.strategy.checks[0].required = false },
    round => { round.evidence[0].check = 'C2' },
    round => { round.evidence[0].validation.status = 'failed' },
  ]) {
    let text = encode(new Map([['session', extendedRound()]]))
    const backend = { read: () => text, write: value => { text = value } }
    const first = createStore(backend), second = createStore(backend)
    const current = first.loadSession('session'), stale = second.loadSession('session')
    change(current)
    assert.equal(first.save(new Map([['session', current]])).ok, true)
    const afterFirst = text
    assert.equal(second.saveSession('session', recordRequest(stale, { text: 'stale update', at: 5 })).code, 'CONFLICT')
    assert.equal(text, afterFirst)
  }
})

test('optional non-object metadata cannot become an empty successful record or clear its round', () => {
  for (const invalid of [null, [], false, 1, 'passed']) {
    const original = extendedRound()
    original.plan.strategy = invalid
    original.evidence[0].check = typeof invalid === 'string' ? { id: invalid } : invalid
    original.evidence[0].validation = invalid
    const restored = decode(encode(new Map([['session', original]]))).get('session')
    assert.equal(restored.roundId, original.roundId)
    assert.equal(restored.reading.literal, original.reading.literal)
    assert.equal(restored.evidence.length, 1)
    assert.equal(Object.hasOwn(restored.plan, 'strategy'), false)
    assert.equal(Object.hasOwn(restored.evidence[0], 'check'), false)
    assert.equal(Object.hasOwn(restored.evidence[0], 'validation'), false)
  }
})

test('every declared child role survives stored open and claimed briefs', () => {
  const original = roundWithPlan()
  original.briefs = ROLES.map((role, index) => ({
    id: `B${index + 1}`, role, question: 'Inspect the relevant task concern', serves: ['N1'],
    state: index % 2 ? 'claimed' : 'open', childId: index % 2 ? `child-${index}` : '',
  }))
  const restored = decode(encode(new Map([['session', original]]))).get('session')
  assert.deepEqual(restored.briefs.map(brief => brief.role), ROLES)
  assert.deepEqual(restored.briefs.map(brief => brief.state), original.briefs.map(brief => brief.state))
  assert.deepEqual(restored.briefs.map(brief => brief.childId), original.briefs.map(brief => brief.childId))
})
