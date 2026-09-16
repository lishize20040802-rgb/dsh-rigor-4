import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  archiveRound,
  claimBrief,
  createRound,
  evaluateDone,
  latestReview,
  linkEvidence,
  openBrief,
  openRework,
  recordEdit,
  recordPlan,
  recordReading,
  recordReview,
  requiredRoles,
  scaleOf,
} from '../src/model.js'

const QUESTION = 'Is the rotated log still readable after the prune script runs, and does anything get deleted that the person still needs?'

/** A round that satisfies every `done` requirement for one small need. */
function prepared(overrides = {}) {
  let round = createRound(0)
  round = recordReading(round, {
    literal: 'prune the logs',
    needs: overrides.needs ?? [{ kind: 'implicit', text: 'old logs stay recoverable', test: 'a rotated file is still readable after a run' }],
    unknowns: [],
    at: 1,
    late: false,
  }).round
  round = recordPlan(round, {
    approach: 'rotate instead of delete, and keep the last rotation readable',
    steps: [{ text: 'rotate the logs', serves: overrides.serves ?? ['N1'], evidence: 'run the prune script and read the newest rotated file' }],
    risks: [],
    at: 2,
  }).round
  for (const need of overrides.evidenceFor ?? ['N1']) {
    round = linkEvidence(round, { need, fact: { kind: 'artifact', ref: 'artifact:logs/app.log.1', path: 'logs/app.log.1' }, note: 'seen on disk', at: 3 })
  }
  const opened = openBrief(round, { role: 'review', question: QUESTION, serves: ['N1'], at: 4 })
  round = opened.round
  round = claimBrief(round, { briefId: opened.brief.id, childId: 'child-1', at: 5 }).round
  const payload = {
    role: 'review',
    verdict: 'approve',
    readingOk: true,
    needs: overrides.reviewNeeds ?? [{ id: 'N1', status: 'met', how: 'read', evidence: 'I read logs/app.log.1 and the rotation marker is there' }],
    scriptOnly: ['the test proves the script exited 0, not that an old log survives a rotation'],
    deviations: overrides.deviations ?? [],
    rework: overrides.rework ?? [],
    questions: [],
    closedItems: [],
  }
  round = recordReview(round, { briefId: opened.brief.id, childId: 'child-1', payload, at: 6 }).round
  return round
}

const doneOptions = (extra = {}) => ({ perNeed: [{ id: 'N1', status: 'met' }], readingConfirmed: 'no', limitations: [], ...extra })

test('a prepared small round may claim done', () => {
  const round = prepared()
  const verdict = evaluateDone(round, doneOptions())
  assert.equal(verdict.ok, true, JSON.stringify(verdict.refusals))
  assert.equal(verdict.refusals.length, 0)
})

test('every refusal names one call and one code', () => {
  const cases = []
  // No reading at all.
  cases.push([createRound(0), 'no-reading'])
  // Reading, no plan.
  let bare = createRound(0)
  bare = recordReading(bare, { literal: 'x', needs: [{ kind: 'stated', text: 'do the thing', test: 'the thing is done' }], unknowns: [], at: 1 }).round
  cases.push([bare, 'no-plan'])
  // A plan that serves a different need id than the reading has.
  let unserved = recordReading(createRound(0), { literal: 'x', needs: [{ kind: 'stated', text: 'a', test: 'a is there' }, { kind: 'stated', text: 'b', test: 'b is there' }], unknowns: [], at: 1 }).round
  unserved = recordPlan(unserved, { approach: 'y', steps: [{ text: 's', serves: ['N1'], evidence: 'run a check' }], risks: [], at: 2 }).round
  cases.push([unserved, 'unserved-need'])
  // Prepared, but the reviewer demanded rework.
  const rework = prepared({ reviewNeeds: [{ id: 'N1', status: 'not-met', how: 'read', evidence: 'the rotated file was deleted by the script' }] })
  const reworkVerdict = evaluateDone(rework, doneOptions({ perNeed: [{ id: 'N1', status: 'met' }] }))
  assert.ok(reworkVerdict.refusals.some(item => ['review-not-approving', 'unmet-need'].includes(item.code)), JSON.stringify(reworkVerdict.refusals))
  // Prepared, but the demanded rework is not closed.
  const demanded = prepared({ reviewNeeds: [{ id: 'N1', status: 'met', how: 'read', evidence: 'the marker is there' }], rework: ['keep the third rotation as well'] })
  const demandedVerdict = evaluateDone(demanded, doneOptions())
  assert.ok(demandedVerdict.refusals.some(item => item.code === 'open-rework'), JSON.stringify(demandedVerdict.refusals))
  // Prepared, but the report leaves the need unnamed.
  const unnamed = evaluateDone(prepared(), { perNeed: [{ id: 'N1', status: 'not-checked' }], readingConfirmed: 'no', limitations: [] })
  assert.ok(unnamed.refusals.some(item => item.code === 'report-not-met'))
  // Prepared, but no fact is linked to the need.
  const noEvidence = prepared({ evidenceFor: [] })
  const noEvidenceVerdict = evaluateDone(noEvidence, doneOptions())
  assert.ok(noEvidenceVerdict.refusals.some(item => item.code === 'no-evidence'), JSON.stringify(noEvidenceVerdict.refusals))
  // Prepared, but the reading was revised after the plan and review were built.
  let revised = prepared()
  revised = recordReading(revised, { literal: 'prune the logs', needs: [{ kind: 'implicit', text: 'old logs stay recoverable', test: 'a rotated file is still readable' }], unknowns: [], at: 7 }).round
  const stale = evaluateDone(revised, doneOptions())
  assert.ok(stale.refusals.some(item => item.code === 'stale-plan'), JSON.stringify(stale.refusals))

  for (const [round, code] of cases) {
    const verdict = evaluateDone(round, doneOptions())
    assert.ok(verdict.refusals.some(item => item.code === code), `${code} expected, got ${JSON.stringify(verdict.refusals.map(item => item.code))}`)
    for (const item of verdict.refusals) {
      assert.ok(String(item.detail).length > 20, `${item.code} has a real detail`)
      assert.ok(String(item.exit).length > 10, `${item.code} names an exit`)
    }
  }
})

test('a late reading is a refusal that says what to do instead', () => {
  let round = prepared()
  round = { ...round, reading: { ...round.reading, late: true } }
  const verdict = evaluateDone(round, doneOptions())
  assert.ok(verdict.refusals.some(item => item.code === 'late-reading'))
})

test('step and file counts do not turn routine work into extra review rounds', () => {
  let round = prepared()
  assert.deepEqual({ scale: scaleOf(round), roles: requiredRoles(round) }, { scale: 2, roles: { scale: 2, reviews: 1, clarify: false, diverge: false, planReview: false, monitor: false } })
  // More targets are informational; they do not establish technical risk.
  for (const target of ['a.js', 'b.js', 'c.js']) round = recordEdit(round, { target, tool: 'edit', detail: target, at: 8 })
  const ladder = requiredRoles(round)
  assert.equal(ladder.scale, 5)
  assert.equal(ladder.clarify, false)
  assert.equal(ladder.diverge, false)
  assert.equal(ladder.planReview, false)
  assert.equal(ladder.reviews, 1)
  round = recordPlan(round, { ...round.plan, strategy: { risk: { impact: 'high', uncertainty: 'medium', reason: 'An external interface is changing.' } }, at: 9 }).round
  assert.equal(requiredRoles(round).reviews, 2)
  assert.equal(requiredRoles(round).planReview, true)
  assert.equal(requiredRoles(round).diverge, true)
})

test('a preset without a child channel is not asked to use one, but must say so', () => {
  const round = prepared()
  const withoutChildren = evaluateDone(round, doneOptions({ capabilities: { children: false, person: true } }))
  assert.equal(withoutChildren.ok, false)
  assert.deepEqual(withoutChildren.refusals.map(item => item.code), ['undeclared-limitation'])
  const declared = evaluateDone(round, doneOptions({ limitations: ['no subagent channel on this preset: no independent review was possible'], capabilities: { children: false, person: true } }))
  assert.equal(declared.ok, true, JSON.stringify(declared.refusals))
})

test('a preset without a question channel is not asked to ask, but must say so', () => {
  let round = prepared()
  round = recordEdit(round, { target: 'a.js', tool: 'edit', detail: 'a.js', at: 8 })
  round = recordEdit(round, { target: 'b.js', tool: 'edit', detail: 'b.js', at: 8 })
  round = recordEdit(round, { target: 'c.js', tool: 'edit', detail: 'c.js', at: 8 })
  round = { ...round, facts: { ...round.facts, sawJob: false } }
  const verdict = evaluateDone(round, { perNeed: [{ id: 'N1', status: 'met' }], readingConfirmed: 'no', limitations: [], capabilities: { children: true, person: false } })
  assert.ok(verdict.refusals.some(item => item.code === 'undeclared-limitation'))
  assert.ok(!verdict.refusals.some(item => item.code === 'unconfirmed-reading'))
})

test('larger work does not require another user confirmation solely because of its size', () => {
  let round = prepared()
  for (const target of ['a.js', 'b.js', 'c.js']) round = recordEdit(round, { target, tool: 'edit', detail: target, at: 8 })
  const verdict = evaluateDone(round, { perNeed: [{ id: 'N1', status: 'met' }], readingConfirmed: 'no', limitations: [], capabilities: { children: true, person: true } })
  assert.ok(!verdict.refusals.some(item => item.code === 'unconfirmed-reading'), JSON.stringify(verdict.refusals.map(item => item.code)))
})

test('saying the person confirmed it is checked against the recorded question and answer', () => {
  const round = prepared()
  const lying = evaluateDone(round, { perNeed: [{ id: 'N1', status: 'met' }], readingConfirmed: 'yes', limitations: [] })
  assert.ok(lying.refusals.some(item => item.code === 'unconfirmed-claim'))
})

test('a brief needs a real question, a reading, and no duplicate', () => {
  const bare = createRound(0)
  const noReading = openBrief(bare, { role: 'review', question: QUESTION, serves: ['N1'], at: 1 })
  assert.equal(noReading.refusal.code, 'no-reading')
  const noPlan = openBrief(recordReading(bare, { literal: 'x', needs: [{ kind: 'stated', text: 'a', test: 'a exists' }], unknowns: [], at: 1 }).round, { role: 'plan-review', question: QUESTION, serves: ['N1'], at: 2 })
  assert.equal(noPlan.refusal.code, 'no-plan')
  let round = recordReading(bare, { literal: 'x', needs: [{ kind: 'stated', text: 'a', test: 'a exists' }], unknowns: [], at: 1 }).round
  round = recordPlan(round, { approach: 'y', steps: [{ text: 's', serves: ['N1'], evidence: 'run a check and read it' }], risks: [], at: 2 }).round
  const short = openBrief(round, { role: 'review', question: 'review it', serves: ['N1'], at: 3 })
  assert.equal(short.refusal.code, 'brief-too-short')
  const first = openBrief(round, { role: 'review', question: QUESTION, serves: ['N1'], at: 3 })
  const second = openBrief(first.round, { role: 'review', question: QUESTION, serves: ['N1'], at: 4 })
  assert.equal(second.refusal.code, 'duplicate-brief')
  assert.equal(openRework(first.round).length, 0)
})

test('a rework-check brief without open rework is refused', () => {
  const round = prepared()
  const outcome = openBrief(round, { role: 'rework-check', question: QUESTION, serves: ['N1'], at: 9 })
  assert.equal(outcome.refusal.code, 'no-rework')
})

test('recording a review opens demanded rework, and a later review closes it', () => {
  const round = prepared({ reviewNeeds: [{ id: 'N1', status: 'met', how: 'read', evidence: 'the marker is there' }], rework: ['keep the third rotation as well'] })
  const open = openRework(round)
  assert.equal(open.length, 1)
  assert.equal(open[0].id, 'R1')
  const opened = openBrief(round, { role: 'rework-check', question: 'Verify the third rotation is kept after the fix, and that the old file is still readable.', serves: ['N1'], at: 10 })
  assert.ok(opened.brief !== undefined, JSON.stringify(opened))
  const withClaim = claimBrief(opened.round, { briefId: opened.brief.id, childId: 'child-2', at: 11 }).round
  const closed = recordReview(withClaim, {
    briefId: opened.brief.id,
    childId: 'child-2',
    payload: {
      role: 'rework-check', verdict: 'approve', readingOk: true,
      needs: [{ id: 'N1', status: 'met', how: 'read', evidence: 'I read the third rotation and the old log' }],
      scriptOnly: ['the script does not prove the retention window the person wanted'],
      deviations: [], rework: [], questions: [], closedItems: ['R1'],
    },
    at: 12,
  })
  assert.deepEqual(closed.closed, ['R1'])
  assert.equal(openRework(closed.round).length, 0)
  assert.equal(latestReview(closed.round).verdict, 'approve')
})

test('a new request after a report archives the round without deleting it', () => {
  let round = prepared()
  round = { ...round, reports: [{ seq: 99, at: 1, status: 'done', readingConfirmed: 'no', perNeed: [], gaps: [], limitations: [] }] }
  const fresh = archiveRound(round, { at: 100, reason: 'new request' })
  assert.equal(fresh.reading, null)
  assert.equal(fresh.plan, null)
  assert.equal(fresh.reports.length, 0)
  assert.equal(fresh.history.length, 1)
  assert.equal(fresh.history[0].needs, 1)
  assert.ok(fresh.seq >= round.seq, 'sequence numbers are not reused')
})
