import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { childRestriction, toolForRole, rolesForTool, MUTATION_TOOLS, SHELL_TOOLS, SPAWN_TOOLS } from '../src/classify.js'
import { renderBrief } from '../src/briefs.js'
import { DISCIPLINE_SECTION } from '../src/prompt.js'
import { createRound, recordReading, recordPlan, linkEvidence, evaluateDone, requiredRoles, snapshotOf } from '../src/model.js'

function prepared(strategy) {
  let round = recordReading(createRound(0, 'exploration-test'), {
    literal: 'Reduce response latency while preserving the existing API.',
    needs: [{ kind: 'stated', text: 'Lower latency without changing the API.', test: 'Measure the delivered API with representative requests.' }],
    unknowns: [], at: 1,
  }).round
  round = recordPlan(round, {
    approach: 'Adapt the existing service.',
    steps: [{ text: 'Implement the chosen route.', serves: ['N1'], evidence: 'Inspect the delivered artifact and measure representative requests.' }],
    risks: [], at: 2,
  }).round
  // Brief rendering consumes persisted context, independently of strategy input
  // normalization. These fixtures deliberately include future/oversized values.
  if (strategy !== undefined) round.plan = { ...round.plan, strategy }
  return round
}

function strategy() {
  return {
    risk: { impact: 'medium', uncertainty: 'high', reason: 'Deployment compatibility is unknown.' },
    options: [{ id: 'reuse', title: 'Reuse the service', tradeoffs: 'Preserves deployment shape.', probe: 'ROUTE_PROBE_ONLY' }, { id: 'replace', title: 'Replace the service', tradeoffs: 'Migration cost.', probe: 'Compare the same workload.' }],
    selected: 'reuse',
    decision: 'Avoid an unnecessary migration while meeting the latency target.',
    technology: [{ id: 'runtime', name: 'Example Runtime', version: '1.2.3', source: 'Official versioned API documentation.', probe: 'VERSION_PROBE_ONLY' }],
    execution: [{ step: 'S1', dependsOn: [], doneWhen: 'The shipped API passes contract and latency checks.', replanWhen: 'The API contract cannot be preserved.' }],
    checks: [{ id: 'C1', need: 'N1', kind: 'performance', criterion: 'PERF_THRESHOLD_ONLY', metric: { name: 'p95_ms', operator: '<=', target: 120 } }],
    questions: [{ id: 'Q1', question: 'Which deployment constraint remains unresolved?', blocking: true }],
  }
}

const brief = (role, round) => renderBrief({ role, question: 'Assess the recorded approach against the goal and available evidence.', serves: ['N1'], round })

test('explore and technical bind to the explorer profile and cannot mutate, run shell, delegate or ask the person', () => {
  for (const role of ['explore', 'technical']) {
    assert.equal(toolForRole(role), 'subagent_explore')
    assert.ok(rolesForTool('subagent_explore').includes(role))
    for (const tool of MUTATION_TOOLS) assert.match(childRestriction(role, tool), /read-only/, role + '/' + tool)
    for (const tool of SHELL_TOOLS) assert.match(childRestriction(role, tool), /no shell/, role + '/' + tool)
    for (const tool of [...SPAWN_TOOLS, 'rigor_brief']) assert.match(childRestriction(role, tool), /do not delegate/, role + '/' + tool)
    assert.match(childRestriction(role, 'ask_user_question'), /does not question/)
    assert.equal(childRestriction(role, 'read'), '')
    assert.ok(!rolesForTool('subagent_review').includes(role))
  }
})

test('optional investigation briefs preserve boundaries and hand experiments to the parent executor', () => {
  const round = prepared(strategy())
  const explore = brief('explore', round), technical = brief('technical', round)
  assert.match(explore, /2–4 materially different/)
  assert.match(explore, /without widening its scope/)
  assert.match(explore, /smallest discriminating test/)
  assert.match(explore, /optional and risk-driven/)
  assert.match(explore, /parent executor/)
  assert.match(explore, /ROUTE_PROBE_ONLY/)
  assert.doesNotMatch(explore, /VERSION_PROBE_ONLY|PERF_THRESHOLD_ONLY/)
  assert.match(technical, /official documentation for the corresponding versions/)
  assert.match(technical, /parent executor/)
  assert.match(technical, /VERSION_PROBE_ONLY/)
  assert.match(technical, /PERF_THRESHOLD_ONLY/)
  for (const text of [explore, technical]) {
    assert.match(text, /Start this child with the subagent_explore tool/)
    assert.match(text, /Lower latency without changing the API/)
    assert.doesNotMatch(text, /"verdict": "approve"/)
  }
})

test('review sees every strategy field and mandatory check result beyond the recent-evidence window', () => {
  const planStrategy = strategy()
  planStrategy.checks = Array.from({ length: 18 }, (_, i) => ({ id: 'C' + i, need: 'N1', kind: 'performance', criterion: 'p95 must remain below the limit', metric: { operator: '<=', target: 120 } }))
  planStrategy.recovery = { policy: 'Restore the previous release if its contract changes.' }
  const round = prepared(planStrategy)
  round.evidence = planStrategy.checks.map((check, i) => ({
    seq: i + 3, need: 'N1', kind: 'command', ref: 'cmd:benchmark-' + i, note: '', check: check.id, snapshot: snapshotOf(round),
    validation: { status: 'passed', observed: 'observed-' + check.id, environment: 'Linux runtime 1.2.3', commandSeq: i + 3, subject: { path: 'release/server.js', fingerprint: 'fingerprint-' + check.id }, measured: 110, baseline: 170 },
  }))
  round.evidence.push(...Array.from({ length: 25 }, (_, i) => ({ seq: i + 30, need: 'N1', kind: 'read', ref: 'read:other-' + i, note: '' })))
  const text = brief('review', round)
  for (const field of Object.keys(planStrategy)) assert.ok(text.includes(field + ':'), 'strategy field ' + field)
  for (const check of planStrategy.checks) {
    assert.ok(text.includes('observed-' + check.id), check.id + ' observation is retained')
    assert.ok(text.includes('fingerprint-' + check.id), check.id + ' subject is retained')
  }
  assert.match(text, /"target"=120/)
  assert.match(text, /"measured"=110/)
  assert.match(text, /"baseline"=170/)
  assert.match(text, /final runnable, installed, loaded, or delivered artifact/)
  assert.match(text, /neither automatically understands semantic correctness/)
})

test('review distinguishes a missing result and the latest failed validation from an older pass', () => {
  const planStrategy = strategy()
  planStrategy.checks.push({ id: 'C2', need: 'N1', kind: 'functional', criterion: 'The actual installed API preserves behavior.' })
  const round = prepared(planStrategy)
  round.evidence = [
    { seq: 3, need: 'N1', kind: 'command', ref: 'cmd:old-pass', note: '', check: 'C1', snapshot: snapshotOf(round), validation: { status: 'passed', observed: 'older pass' } },
    { seq: 4, need: 'N1', kind: 'command', ref: 'cmd:new-failure', note: '', check: 'C1', snapshot: snapshotOf(round), validation: { status: 'failed', observed: 'latest regression', measured: 180 } },
  ]
  const text = brief('review', round)
  const table = text.slice(text.indexOf('Declared checks and latest recorded validation'))
  assert.match(table, /latest regression/)
  assert.doesNotMatch(table, /older pass/)
  assert.match(table, /validation: not recorded/)
  assert.match(table, /"measured"=180/)
})

test('a changed plan marks old passes and failures stale and requires validation of the current snapshot', () => {
  const round = prepared(strategy()), previous = snapshotOf(round)
  round.evidence = [
    { seq: 3, need: 'N1', kind: 'command', ref: 'cmd:old-failure', note: '', check: 'C1', snapshot: previous, validation: { status: 'failed', observed: 'historical regression' } },
    { seq: 4, need: 'N1', kind: 'command', ref: 'cmd:old-pass', note: '', check: 'C1', snapshot: previous, validation: { status: 'passed', observed: 'historical pass' } },
  ]
  round.planVersion += 1
  let table = brief('review', round).split('Declared checks and latest recorded validation')[1]
  assert.match(table, /current validation: not recorded for current snapshot/)
  assert.match(table, /#4 \[stale snapshot\]/)
  assert.match(table, /stale validation \(latest failure\): #3 \[stale snapshot\]/)
  assert.match(table, /historical regression/)
  assert.doesNotMatch(table, /\[current snapshot\]/)
  round.evidence.push({ seq: 5, need: 'N1', kind: 'command', ref: 'cmd:current', note: '', check: 'C1', snapshot: snapshotOf(round), validation: { status: 'passed', observed: 'current measured result' } })
  table = brief('review', round).split('Declared checks and latest recorded validation')[1]
  assert.match(table, /current validation: #5 \[current snapshot\]/)
  assert.match(table, /current measured result/)
  assert.match(table, /historical regression/)
})

test('long artifact paths or metric labels do not hide fingerprints and performance thresholds', () => {
  const planStrategy = strategy()
  planStrategy.checks[0].metric = { name: 'x'.repeat(1000), operator: '<=', target: 120 }
  const round = prepared(planStrategy)
  round.evidence = [{ seq: 3, need: 'N1', kind: 'command', ref: 'cmd:benchmark', note: '', check: 'C1', snapshot: snapshotOf(round), validation: {
    status: 'passed', observed: 'A representative workload was measured.', subject: { path: 'x'.repeat(1000), fingerprint: 'sha256:final-artifact' }, measured: 110,
  } }]
  const text = brief('review', round)
  assert.match(text, /"target"=120/)
  assert.match(text, /sha256:final-artifact/)
  assert.match(text, /"measured"=110/)
  assert.match(text, /truncated; inspect full record/)
})

test('large strategy prose is bounded without hiding the selected route or later fields', () => {
  const planStrategy = strategy()
  planStrategy.decision = 'x'.repeat(50000)
  planStrategy.options = Array.from({ length: 40 }, (_, i) => ({ id: 'route-' + i, title: 'Option ' + i, probe: 'Probe ' + i }))
  planStrategy.selected = 'route-39'
  const text = brief('plan-review', prepared(planStrategy))
  assert.match(text, /route-39/)
  assert.match(text, /truncated; inspect full record/)
  assert.match(text, /more options entries/)
  assert.match(text, /PERF_THRESHOLD_ONLY/)
  assert.match(text, /replanning triggers/)
  assert.ok(text.length < 18000)
})

test('old role profiles, generic tools and the solo preset retain their capability boundaries', () => {
  for (const role of ['clarify', 'diverge', 'plan-review']) assert.equal(toolForRole(role), 'subagent_explore')
  for (const role of ['review', 'rework-check']) assert.equal(toolForRole(role), 'subagent_review')
  assert.equal(toolForRole('monitor'), 'subagent_monitor')
  assert.equal(rolesForTool('subagent'), null)
  assert.equal(childRestriction('', 'edit'), '')
  assert.equal(childRestriction('review', 'pwsh'), '')
  const preset = readFileSync(new URL('../preset/minimal/agent.cordis.yml', import.meta.url), 'utf8')
  assert.match(preset, /children: false/)
  assert.match(preset, /person: false/)
  let round = prepared()
  round = linkEvidence(round, { need: 'N1', fact: { kind: 'artifact', ref: 'artifact:release/server.js', path: 'release/server.js' }, note: 'inspected', at: 3 })
  const outcome = evaluateDone(round, { perNeed: [{ id: 'N1', status: 'met' }], readingConfirmed: 'no', limitations: ['No subagent channel: no independent review was possible.', 'No question channel on this preset.'], capabilities: { children: false, person: false } })
  assert.equal(outcome.ok, true, JSON.stringify(outcome.refusals))
  assert.notEqual(requiredRoles(round).explore, true)
  assert.notEqual(requiredRoles(round).technical, true)
  assert.doesNotMatch(brief('review', round), /Strategy context for this role/)
})

test('resident instructions stay light and fetch detailed strategy guidance on demand', () => {
  const text = DISCIPLINE_SECTION.text
  assert.ok(text.trim().split(/\s+/).length <= 350)
  assert.ok(Buffer.byteLength(text) <= Math.floor(3230 * 0.7), 'at least 30% shorter than the previous resident section')
  assert.match(text, /rigor_plan\(strategy="help"\)/)
  assert.doesNotMatch(text, /"technology"\s*:|"execution"\s*:/)
  assert.match(text, /do not ask again because the task is large/)
  assert.match(text, /not permission to stop/)
})
