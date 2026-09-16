import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractReviewPayload, validateReviewPayload } from '../src/payload.js'

const approved = {
  verdict: 'approve', role: 'review', reading_ok: true,
  needs: [{ id: 'N1', status: 'met', how: 'read', evidence: 'The observed value matches.' }],
  script_only: ['The observed fixture does not cover every environment.'],
  deviations: [], rework: [], questions: [],
}
const block = payload => '```json\n' + JSON.stringify(payload) + '\n```'

test('a malformed final verdict never resurrects an earlier approval', () => {
  for (const tail of ['```json\n{"verdict":"rework",}\n```', '```json\n{"verdict":"rework"', '```json\n{"unrelated":true}\n```']) {
    const result = extractReviewPayload(block(approved) + '\nCorrection follows:\n' + tail)
    assert.equal(result.ok, false, JSON.stringify(result))
  }
})

test('the complete final candidate wins and plain JSON remains supported', () => {
  const rework = { ...approved, verdict: 'rework', rework: ['Recheck the changed fixture.'] }
  assert.equal(extractReviewPayload(block(approved) + '\n' + block(rework)).payload.verdict, 'rework')
  assert.equal(extractReviewPayload(JSON.stringify(approved)).ok, true)
})

test('a payload cannot change the role chosen by its bound brief', () => {
  const result = validateReviewPayload({ ...approved, role: 'rework-check', closed_items: [] }, { needIds: ['N1'], role: 'review' })
  assert.equal(result.ok, false)
  assert.ok(result.problems.some(problem => /match the brief/.test(problem)))
})

test('only a rework-check may close existing open rework items', () => {
  assert.equal(validateReviewPayload({ ...approved, closed_items: ['R1'] }, { needIds: ['N1'], openItems: ['R1'], role: 'review' }).ok, false)
  assert.equal(validateReviewPayload({ ...approved, role: 'rework-check', closed_items: ['R1', 'invented'] }, { needIds: ['N1'], openItems: ['R1'], role: 'rework-check' }).ok, false)
  assert.equal(validateReviewPayload({ ...approved, role: 'rework-check', closed_items: ['R1'] }, { needIds: ['N1'], openItems: ['R1'], role: 'rework-check' }).ok, true)
})
