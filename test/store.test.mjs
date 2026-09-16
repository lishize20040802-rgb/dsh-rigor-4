import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFileBackend, createStore, decode, encode, resolveHome } from '../src/store.js'
import {
  archiveRound, claimBrief, createRound, linkEvidence, openBrief, recordAnswers,
  recordAttempt, recordCommand, recordEdit, recordPlan, recordQuestion,
  recordReadFact, recordReading, recordReport, recordRequest, recordReview,
} from '../src/model.js'

const project = fileURLToPath(new URL('../', import.meta.url))
function fixture(t) {
  const directory = mkdtempSync(join(project, '.store-test-'))
  t.after(() => {
    const absolute = resolve(directory)
    assert.ok(absolute.startsWith(resolve(project) + '\\') || absolute.startsWith(resolve(project) + '/'))
    assert.ok(absolute.split(/[\\/]/).at(-1).startsWith('.store-test-'))
    rmSync(absolute, { recursive: true, force: true })
  })
  return directory
}

test('home resolution defaults blank values and keeps the installer whitespace policy', () => {
  const home = join(project, 'example-user')
  for (const declared of [undefined, '', ' \t ']) {
    assert.equal(resolveHome({ DSH_HOME: declared }, home), resolve(home, '.dsh'))
  }
  assert.equal(resolveHome({ DSH_HOME: '  .custom-home  ' }, home), resolve('.custom-home'))
})

test('home resolution expands supported tilde prefixes without expanding named users', () => {
  const home = join(project, 'example-user')
  assert.equal(resolveHome({ DSH_HOME: '~' }, home), resolve(home))
  for (const declared of ['~/custom', '~\\custom']) {
    assert.equal(resolveHome({ DSH_HOME: declared }, home), resolve(home, 'custom'))
  }
  assert.equal(resolveHome({ DSH_HOME: '~other/custom' }, home), resolve('~other/custom'))
})

test('a default backend fixes relative DSH_HOME before the working directory changes', t => {
  const directory = fixture(t)
  const originalCwd = process.cwd()
  const originalHome = process.env.DSH_HOME
  const home = join(directory, 'custom-home')
  try {
    process.env.DSH_HOME = relative(originalCwd, home)
    const backend = createFileBackend()
    assert.equal(backend.sessionDirectory, join(home, '.rigor4', 'sessions'))
    process.chdir(directory)
    const store = createStore(backend)
    assert.equal(store.saveSession('home-check', createRound(0, 'home-round')).ok, true)
    assert.equal(readdirSync(join(home, '.rigor4', 'sessions')).filter(name => name.endsWith('.json')).length, 1)
    assert.equal(createStore(createFileBackend({ directory: join(home, '.rigor4') })).loadSession('home-check').roundId, 'home-round')
  } finally {
    process.chdir(originalCwd)
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
  }
})

function containsEveryField(actual, expected, location = 'round') {
  if (expected === null || typeof expected !== 'object') return assert.equal(actual, expected, location)
  assert.equal(Array.isArray(actual), Array.isArray(expected), location)
  if (Array.isArray(expected)) assert.equal(actual.length, expected.length, location)
  for (const key of Object.keys(expected)) {
    assert.ok(Object.hasOwn(actual, key), `${location}.${key} must survive`)
    containsEveryField(actual[key], expected[key], `${location}.${key}`)
  }
}

function populated() {
  let round = recordRequest(createRound(1, 'round-trip'), { text: 'retain A', at: 1 })
  const reading = { literal: 'retain A', needs: [{ kind: 'stated', text: 'readable A', test: 'read A' }], unknowns: ['retention time'], at: 2 }
  round = recordReading(round, { ...reading, late: true }).round
  round = recordReading(round, reading).round
  round = recordPlan(round, { approach: 'keep A', steps: [{ text: 'keep it', serves: ['N1'], evidence: 'read A' }], risks: ['disk'], at: 3 }).round
  round = recordEdit(round, { target: 'A', tool: 'edit', detail: 'repair A', at: 4 })
  round = recordCommand(round, { cmd: 'check A', exit: 0, mutationHint: false, at: 5 })
  round = recordReadFact(round, { ref: 'A', at: 6 })
  round = recordQuestion(round, { questions: [{ id: 'lifetime', question: 'How long?' }], at: 7 })
  round = recordAnswers(round, { answers: [{ id: 'lifetime', selected: ['one month'], custom: '' }], at: 8 })
  round = recordAttempt(round, { tool: 'edit', target: 'B', outcome: 'denied', possibleMutation: false, at: 8 })
  round = linkEvidence(round, { need: 'N1', fact: { kind: 'artifact', ref: 'artifact:A', path: 'A', size: 12, mtimeMs: 1234, fingerprint: 'sha256-value', snapshot: round.facts.reads.at(-1).snapshot }, note: 'observed', at: 9 })
  const b = openBrief(round, { role: 'review', question: 'Check whether A is readable and identify what the evidence does not show.', serves: ['N1'], at: 10 })
  round = claimBrief(b.round, { briefId: b.brief.id, childId: 'child-1', tool: 'subagent_review', at: 11 }).round
  const payload = { role: 'review', verdict: 'rework', readingOk: true, needs: [{ id: 'N1', status: 'not-met', how: 'read', evidence: 'A has a gap' }], scriptOnly: ['a read cannot prove durability'], deviations: ['missing data'], questions: ['recover source?'], closedItems: [], rework: ['restore bytes'] }
  round = recordReview(round, { briefId: b.brief.id, childId: 'child-1', payload, childPreset: 'test-preset', childTool: 'subagent_review', at: 12 }).round
  round = recordReport(round, { status: 'partial', perNeed: [{ id: 'N1', status: 'not-met' }], gaps: ['missing bytes'], limitations: ['no production environment'], readingConfirmed: 'yes', at: 13 }).round
  round.findings = [{ seq: 99, at: 14, childId: 'child-1', role: 'monitor', preset: 'test', delivered: true, text: 'A changed' }]
  round.history = archiveRound(round, { at: 15 }).history
  round.briefedAs = 'review'
  round.briefedTool = 'subagent_review'
  return round
}

test('every persisted domain field survives round-trip, including limits and version provenance', () => {
  const round = populated()
  const restored = decode(encode(new Map([['session', round]]))).get('session')
  containsEveryField(restored, round)
  assert.equal(restored.reports[0].limitations[0], 'no production environment')
  assert.equal(restored.reading.hadLateReading, true)
  assert.equal(restored.briefs[0].claimedAt, 11)
  assert.equal(restored.history[0].steps, 1)
  assert.equal(restored.history[0].edits, 1)
})

test('adoption preserves all open briefs and demanded fixes above history limits', () => {
  const round = populated()
  round.briefs = Array.from({ length: 85 }, (_, index) => ({ ...round.briefs[0], id: `B${index + 1}`, state: 'claimed' }))
  round.rework = Array.from({ length: 65 }, (_, index) => ({ ...round.rework[0], id: `R${index + 1}`, status: 'open' }))
  const restored = decode(encode(new Map([['session', round]]))).get('session')
  assert.equal(restored.briefs.length, 85)
  assert.equal(restored.rework.length, 65)
})

test('file migration keeps legacy bytes unchanged and writes only the changed session sidecar', t => {
  const directory = fixture(t)
  const oldRound = populated()
  const legacy = JSON.stringify({ format: 1, sessions: { A: oldRound, B: createRound(1, 'round-B') } })
  const path = join(directory, 'sessions.json')
  writeFileSync(path, legacy)
  const store = createStore(createFileBackend({ directory }))
  const loaded = store.load()
  assert.deepEqual([...loaded.keys()], ['A', 'B'])
  const changed = recordRequest(loaded.get('A'), { text: 'continue', at: 20 })
  assert.equal(store.saveSession('A', changed).ok, true)
  assert.equal(readFileSync(path, 'utf8'), legacy)
  assert.equal(readdirSync(join(directory, 'sessions')).filter(name => name.endsWith('.json')).length, 1)
  const reopened = createStore(createFileBackend({ directory })).load()
  assert.equal(reopened.get('A').requests.at(-1).text, 'continue')
  assert.equal(reopened.get('B').roundId, 'round-B')
})

test('separate file-backed instances cannot erase each other\'s sessions', t => {
  const directory = fixture(t)
  const a = createStore(createFileBackend({ directory }))
  const b = createStore(createFileBackend({ directory }))
  const aMap = a.load(), bMap = b.load()
  aMap.set('A', createRound(1, 'round-A'))
  bMap.set('B', createRound(1, 'round-B'))
  assert.equal(a.save(aMap).ok, true)
  assert.equal(b.save(bMap).ok, true)
  assert.deepEqual([...createStore(createFileBackend({ directory })).load().keys()].sort(), ['A', 'B'])
})

test('same-session conflicts fail without overwriting; explicit reload permits retry', t => {
  const directory = fixture(t)
  const a = createStore(createFileBackend({ directory }))
  assert.equal(a.saveSession('A', createRound(1, 'round-A')).ok, true)
  const b = createStore(createFileBackend({ directory }))
  const aRound = a.loadSession('A'), bRound = b.loadSession('A')
  assert.equal(a.saveSession('A', recordRequest(aRound, { text: 'first writer', at: 2 })).ok, true)
  const stale = recordRequest(bRound, { text: 'stale writer', at: 3 })
  assert.equal(b.saveSession('A', stale).code, 'CONFLICT')
  assert.equal(a.loadSession('A').requests.at(-1).text, 'first writer')
  const refreshed = b.loadSession('A')
  // A fresh read must not magically rebase an old derived round.
  assert.equal(b.saveSession('A', stale).code, 'CONFLICT')
  assert.equal(b.saveSession('A', recordRequest(refreshed, { text: 'fresh retry', at: 4 })).ok, true)
  assert.equal(a.loadSession('A').requests.at(-1).text, 'fresh retry')
})

test('legacy injectable backends merge different sessions and reject stale same-session saves', () => {
  let text
  const backend = { read: () => text, write: value => { text = value }, clear: () => { text = undefined } }
  const a = createStore(backend), b = createStore(backend)
  const aMap = a.load(), bMap = b.load()
  aMap.set('A', populated()); bMap.set('B', createRound(1, 'round-B'))
  assert.equal(a.save(aMap).ok, true)
  assert.equal(b.save(bMap).ok, true)
  assert.deepEqual([...decode(text).keys()].sort(), ['A', 'B'])
  const old = b.loadSession('A')
  assert.equal(a.saveSession('A', recordRequest(a.loadSession('A'), { text: 'new', at: 20 })).ok, true)
  assert.equal(b.saveSession('A', recordRequest(old, { text: 'stale', at: 21 })).code, 'CONFLICT')
  assert.equal(decode(text).get('A').requests.at(-1).text, 'new')
})

test('malformed and future-format state is explicit and never overwritten', t => {
  for (const text of ['{ malformed', '', JSON.stringify({ format: 9000, sessions: {} })]) {
    assert.throws(() => decode(text), error => error.code === 'CORRUPT_STATE')
  }
  const directory = fixture(t)
  const path = join(directory, 'sessions.json')
  const original = '{ malformed'
  writeFileSync(path, original)
  const store = createStore(createFileBackend({ directory }))
  assert.equal(store.load().size, 0)
  assert.equal(store.mode, 'memory')
  assert.match(store.reason, /valid JSON/)
  assert.equal(store.saveSession('new', createRound()).ok, false)
  assert.equal(readFileSync(path, 'utf8'), original)
  assert.throws(() => store.loadSession('new'), error => error.code === 'CORRUPT_STATE')
})

test('corrupt sidecars and busy writer locks fail without touching saved session bytes', t => {
  const directory = fixture(t)
  const backend = createFileBackend({ directory })
  const store = createStore(backend)
  assert.equal(store.saveSession('A', createRound(0, 'round-A')).ok, true)
  const name = readdirSync(backend.sessionDirectory).find(name => name.endsWith('.json'))
  const path = join(backend.sessionDirectory, name)
  const original = readFileSync(path, 'utf8')
  writeFileSync(`${path}.lock`, 'busy', { flag: 'wx' })
  assert.equal(store.saveSession('A', recordRequest(store.loadSession('A'), { text: 'blocked writer', at: 2 })).code, 'CONFLICT')
  assert.equal(readFileSync(path, 'utf8'), original)
  rmSync(`${path}.lock`)
  writeFileSync(path, '{ broken')
  assert.throws(() => store.loadSession('A'), error => error.code === 'CORRUPT_STATE')
  assert.equal(store.saveSession('A', createRound()).ok, false)
  assert.equal(readFileSync(path, 'utf8'), '{ broken')
})

test('a failed backend write is reported explicitly and never becomes a recorded success', () => {
  const original = encode(new Map([['A', createRound(0, 'round-A')]]))
  let writes = 0
  const store = createStore({
    read: () => original,
    write() { writes += 1; throw new Error('simulated disk failure') },
  })
  const changed = recordRequest(store.loadSession('A'), { text: 'must not claim saved', at: 2 })
  const result = store.saveSession('A', changed)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'IO_ERROR')
  assert.match(result.reason, /simulated disk failure/)
  assert.equal(store.saveSession('A', changed).code, 'READ_ONLY')
  assert.equal(writes, 1)
  assert.equal(decode(original).get('A').requests.length, 0)
})
