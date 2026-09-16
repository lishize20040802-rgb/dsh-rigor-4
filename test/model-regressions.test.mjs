import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  archiveRound, claimBrief, closeBriefConclusion, createRound, evaluateDone,
  linkEvidence, needsNewRound, openBrief, openRework, recordAttempt,
  recordEdit, recordPlan, recordReading, recordReport, recordRequest,
  recordReview, sameSnapshot, snapshotOf,
} from '../src/model.js'

const needs = [{ kind: 'stated', text: 'A stays readable', test: 'read A' }]
const reading = { literal: 'retain A', needs, unknowns: [], at: 1 }
const plan = { approach: 'retain A', steps: [{ text: 'keep A', serves: ['N1'], evidence: 'read A' }], risks: [], at: 2 }
const payload = {
  role: 'review', verdict: 'approve', readingOk: true,
  needs: [{ id: 'N1', status: 'met', how: 'read', evidence: 'A is readable' }],
  scriptOnly: ['one read does not prove future durability'], deviations: [], questions: [], rework: [], closedItems: [],
}
const report = { status: 'done', perNeed: [{ id: 'N1', status: 'met' }], gaps: [], limitations: [], readingConfirmed: 'no', at: 10 }
const opts = { perNeed: report.perNeed, readingConfirmed: 'no' }

function base() {
  let round = recordReading(createRound(0, 'round-under-test'), reading).round
  round = recordPlan(round, plan).round
  return linkEvidence(round, { need: 'N1', fact: { kind: 'artifact', ref: 'artifact:A', path: 'A', fingerprint: 'before', size: 1, mtimeMs: 1 }, note: 'read A', at: 3 })
}

function brief(round, child, role = 'review') {
  const opened = openBrief(round, { role, question: `${child}: Check that file A is readable and explain what the tests do not prove.`, serves: ['N1'], at: 4 })
  assert.ok(opened.round, JSON.stringify(opened))
  const claimed = claimBrief(opened.round, { briefId: opened.brief.id, childId: child, at: 5 })
  assert.ok(claimed.round)
  return { round: claimed.round, id: opened.brief.id }
}

function approve(round, child = 'reviewer') {
  const b = brief(round, child)
  const result = recordReview(b.round, { briefId: b.id, childId: child, payload, at: 6 })
  assert.ok(result.round, JSON.stringify(result))
  return result.round
}

test('late first readings recover through a recorded revision, while history survives', () => {
  let round = recordReading(createRound(), { ...reading, late: true }).round
  assert.equal(round.reading.late, true)
  round = recordReading(round, { ...reading, late: true }).round
  assert.equal(round.reading.late, false)
  assert.equal(round.reading.hadLateReading, true)
  assert.equal(round.reading.revisions[0].late, true)
  round = recordPlan(round, plan).round
  assert.ok(!evaluateDone(round, opts).refusals.some(item => item.code === 'late-reading'))
})

test('a normal reading revision after editing is never a late first reading', () => {
  let round = recordReading(createRound(), reading).round
  round = recordEdit(round, { target: 'A', tool: 'edit', at: 2 })
  round = recordReading(round, { ...reading, late: true }).round
  assert.equal(round.reading.late, false)
  assert.equal(round.reading.hadLateReading, false)
})

test('review identity, claim, role and snapshot must all agree', () => {
  const round = base()
  assert.equal(recordReview(round, { briefId: 'fake', childId: 'child', payload }).refusal.code, 'unknown-brief')
  const b = brief(round, 'child')
  assert.equal(recordReview(b.round, { briefId: b.id, childId: 'other', payload }).refusal.code, 'review-child-mismatch')
  assert.equal(recordReview(b.round, { briefId: b.id, childId: 'child', payload: { ...payload, role: 'rework-check' } }).refusal.code, 'review-role-mismatch')
  const changed = recordReading(b.round, { ...reading, literal: 'delete A', needs: [{ kind: 'stated', text: 'A absent', test: 'A missing' }] }).round
  assert.equal(recordReview(changed, { briefId: b.id, childId: 'child', payload }).refusal.code, 'stale-review-brief')
})

test('plan, file and possible partial mutations invalidate prior approvals', () => {
  const round = approve(base())
  assert.equal(evaluateDone(round, opts).ok, true)
  const replanned = recordPlan(round, plan).round
  const edited = recordEdit(round, { target: 'A', tool: 'edit', at: 7 })
  const attempted = recordAttempt(round, { tool: 'edit', target: 'A', outcome: 'failed', possibleMutation: true, at: 7 })
  for (const changed of [replanned, edited, attempted]) {
    assert.equal(evaluateDone(changed, opts).ok, false)
    assert.ok(evaluateDone(changed, opts).refusals.some(item => item.code === 'no-review'))
  }
  const denied = recordAttempt(round, { tool: 'edit', target: 'A', outcome: 'denied', possibleMutation: false, at: 7 })
  assert.equal(denied.facts.edits.length, 0)
  assert.equal(denied.workRevision, round.workRevision)
  assert.equal(evaluateDone(denied, opts).ok, true)
})

test('relinking externally changed artifact content advances the reviewed work revision', () => {
  const round = approve(base())
  const changed = linkEvidence(round, { need: 'N1', fact: { kind: 'artifact', ref: 'artifact:A', path: 'A', fingerprint: 'after' }, at: 8 })
  assert.equal(changed.workRevision, round.workRevision + 1)
  assert.equal(evaluateDone(changed, opts).ok, false)
  assert.equal(changed.evidence.at(-1).fingerprint, 'after')
  assert.ok(sameSnapshot(changed.evidence.at(-1).snapshot, snapshotOf(changed)))
})

test('independent review counts only approvals of the current snapshot', () => {
  let round = approve(base(), 'old-child')
  round = recordReading(round, reading).round
  round = recordPlan(round, { ...plan, steps: [1, 2, 3, 4].map(n => ({ text: `step ${n}`, serves: ['N1'], evidence: 'read A' })) }).round
  round = linkEvidence(round, { need: 'N1', fact: { kind: 'artifact', path: 'A', ref: 'artifact:A', fingerprint: 'before' }, at: 8 })
  round = approve(round, 'current-child')
  const outcome = evaluateDone(round, { ...opts, capabilities: { children: true, person: false }, limitations: ['question channel unavailable'] })
  assert.ok(outcome.refusals.some(item => item.code === 'no-review'))
  const b = brief(round, 'current-child')
  assert.equal(recordReview(b.round, { briefId: b.id, childId: 'current-child', payload }).refusal.code, 'duplicate-reviewer')
})

test('preparation roles can cause the reading they are required to help form', () => {
  let round = recordRequest(createRound(0, 'roles-round'), { text: 'retain A with careful validation', at: 0 })
  for (const role of ['clarify', 'diverge']) {
    const b = brief(round, role, role)
    round = closeBriefConclusion(b.round, { briefId: b.id, conclusion: 'retain A; clarify its lifetime', at: 1 })
  }
  round = recordReading(round, reading).round
  round = recordPlan(round, { ...plan, steps: [1, 2, 3, 4].map(n => ({ text: `step ${n}`, serves: ['N1'], evidence: 'read A' })) }).round
  const outcome = evaluateDone(round, opts)
  assert.ok(!outcome.refusals.some(item => ['no-clarify', 'no-diverge'].includes(item.code)))
  const newRequest = recordRequest(round, { text: 'actually remove A', at: 9 })
  assert.ok(evaluateDone(newRequest, opts).refusals.some(item => item.code === 'no-clarify'))
})

test('partial and blocked reports preserve the round on continuation; done and explicit new tasks archive', () => {
  for (const status of ['partial', 'blocked']) {
    const round = recordReport(base(), { ...report, status, gaps: ['A still needs review'] }).round
    assert.equal(needsNewRound(round), false)
    assert.equal(needsNewRound(round, { newTask: true }), true)
  }
  const round = recordReport(approve(base()), report).round
  assert.equal(needsNewRound(round), true)
  const next = archiveRound(round, { at: 20 })
  assert.notEqual(next.roundId, round.roundId)
  assert.equal(next.seq, round.seq)
  assert.equal(next.startedAt, 20)
})

test('bounded histories never reuse identifiers or discard open brief and rework obligations', () => {
  let round = base()
  for (let n = 0; n < 85; n++) {
    const b = brief(round, `open-child-${n}`)
    round = b.round
  }
  assert.equal(round.briefs.length, 85)
  assert.equal(new Set(round.briefs.map(item => item.id)).size, 85)
  assert.equal(round.briefs[0].id, 'B1')
  for (let n = 0; n < 65; n++) {
    const b = brief(round, `rework-child-${n}`)
    const result = recordReview(b.round, { briefId: b.id, childId: `rework-child-${n}`, payload: { ...payload, verdict: 'rework', rework: [`fix ${n}`] }, at: 20 + n })
    assert.ok(result.round, JSON.stringify(result))
    round = result.round
  }
  assert.equal(openRework(round).length, 65)
  assert.equal(new Set(round.reviews.map(item => item.id)).size, round.reviews.length)
  assert.equal(new Set(round.rework.map(item => item.id)).size, 65)
  assert.equal(round.rework[0].text, 'fix 0')
  assert.equal(round.rework.at(-1).id, 'R65')
})

test('a stale review brief does not block reopening its question for the new delivery', () => {
  const first = brief(base(), 'reviewer')
  const changed = recordEdit(first.round, { target: 'A', tool: 'edit', at: 10 })
  const question = first.round.briefs.find(item => item.id === first.id).question
  const reopened = openBrief(changed, { role: 'review', question, serves: ['N1'], at: 11 })
  assert.ok(reopened.round, JSON.stringify(reopened))
  assert.notEqual(reopened.brief.id, first.id)
  assert.equal(reopened.round.briefs.find(item => item.id === first.id).state, 'claimed')
  const duplicate = openBrief(reopened.round, { role: 'review', question, serves: ['N1'], at: 12 })
  assert.equal(duplicate.refusal.code, 'duplicate-brief')
})
