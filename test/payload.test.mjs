import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractReviewPayload, validateReviewPayload } from '../src/payload.js'

const FULL = {
  verdict: 'approve',
  role: 'review',
  reading_ok: true,
  needs: [{ id: 'N1', status: 'met', how: 'read', evidence: 'I read logs/app.log.1 and saw the rotation marker' }],
  script_only: ['the test proves exit code 0, not that an old log survives'],
  deviations: [],
  rework: [],
  questions: [],
}

test('the last fenced json block wins, whatever else the message says', () => {
  const text = [
    'I looked at the work and first wrote this:',
    '```json',
    '{"verdict":"rework","needs":[{"id":"N1","status":"not-met","how":"read","evidence":"the file was deleted"}],"script_only":["x"],"reading_ok":false}',
    '```',
    'After more reading, here is my actual verdict:',
    '```json',
    JSON.stringify(FULL),
    '```',
  ].join('\n')
  const extracted = extractReviewPayload(text)
  assert.equal(extracted.ok, true)
  assert.equal(extracted.payload.verdict, 'approve')
})

test('a message with no verdict block is not a review', () => {
  const extracted = extractReviewPayload('I reviewed it and it looks good to me. VERIFIED.')
  assert.equal(extracted.ok, false)
  assert.match(extracted.why, /no JSON block/)
})

test('a valid payload passes, and is normalised', () => {
  const validated = validateReviewPayload(FULL, { needIds: ['N1'] })
  assert.equal(validated.ok, true, validated.problems.join('; '))
  assert.deepEqual(validated.normalized.needs, [{ id: 'N1', status: 'met', how: 'read', evidence: 'I read logs/app.log.1 and saw the rotation marker' }])
  assert.deepEqual(validated.normalized.scriptOnly, ['the test proves exit code 0, not that an old log survives'])
})

test('every need has to be judged', () => {
  const missing = validateReviewPayload({ ...FULL, needs: [] }, { needIds: ['N1', 'N2'] })
  assert.equal(missing.ok, false)
  assert.ok(missing.problems.some(problem => /non-empty/.test(problem)))
  const incomplete = validateReviewPayload(FULL, { needIds: ['N1', 'N2'] })
  assert.equal(incomplete.ok, false)
  assert.ok(incomplete.problems.some(problem => problem.includes('missing N2')))
})

test('an approval cannot carry an unmet need, a rejected reading, or open rework', () => {
  const unmet = validateReviewPayload({ ...FULL, needs: [{ id: 'N1', status: 'not-checked', how: 'read', evidence: '' }] }, { needIds: ['N1'] })
  assert.equal(unmet.ok, false)
  assert.ok(unmet.problems.some(problem => problem.includes('cannot carry needs that are not met')))
  const reading = validateReviewPayload({ ...FULL, reading_ok: false }, { needIds: ['N1'] })
  assert.equal(reading.ok, false)
  const rework = validateReviewPayload({ ...FULL, rework: ['fix it'] }, { needIds: ['N1'] })
  assert.equal(rework.ok, false)
  assert.ok(rework.problems.some(problem => problem.includes('lists rework')))
})

test('script_only is mandatory: the sentence three generations would not write', () => {
  const empty = validateReviewPayload({ ...FULL, script_only: [] }, { needIds: ['N1'] })
  assert.equal(empty.ok, false)
  assert.ok(empty.problems.some(problem => problem.includes('script_only')))
  const blank = validateReviewPayload({ ...FULL, script_only: ['  '] }, { needIds: ['N1'] })
  assert.equal(blank.ok, false)
})

test('a met need carries the concrete thing that was seen, and how it was seen', () => {
  const noEvidence = validateReviewPayload({ ...FULL, needs: [{ id: 'N1', status: 'met', how: 'read', evidence: '' }] }, { needIds: ['N1'] })
  assert.equal(noEvidence.ok, false)
  const noHow = validateReviewPayload({ ...FULL, needs: [{ id: 'N1', status: 'met', how: 'believed', evidence: 'it looked fine' }] }, { needIds: ['N1'] })
  assert.equal(noHow.ok, false)
})

test('a rework-check has to say what happened to every open item', () => {
  const nothing = validateReviewPayload({ ...FULL, role: 'rework-check', closed_items: [] }, { needIds: ['N1'], openItems: ['R1', 'R2'], role: 'rework-check' })
  assert.equal(nothing.ok, false)
  assert.ok(nothing.problems.some(problem => problem.includes('R1')))
  const both = validateReviewPayload({ ...FULL, role: 'rework-check', verdict: 'rework', closed_items: ['R1'], rework: ['R2 still missing'] }, { needIds: ['N1'], openItems: ['R1', 'R2'], role: 'rework-check' })
  assert.equal(both.ok, true, both.problems.join('; '))
})