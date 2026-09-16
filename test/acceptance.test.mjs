import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createTools } from '../src/tools.js'
import { claimBrief, createRound, recordCommand, requiredRoles } from '../src/model.js'
import { createFileBackend, createStore } from '../src/store.js'

const risk = { impact: 'low', uncertainty: 'low', reason: 'A bounded synthetic change with an isolated subject' }
const functional = { risk, checks: [{ id: 'C1', need: 'N1', kind: 'functional', criterion: 'The subject preserves the expected value' }] }
const metric = { unit: 'ms', statistic: 'p95', operator: 'lte', threshold: 20, minSamples: 3, workload: 'fixed-fixture-v1', environment: 'node24-fixture' }
const performance = { risk, checks: [{ id: 'C1', need: 'N1', kind: 'performance', criterion: 'p95 stays within the stated latency budget', metric }] }
const fingerprint = data => 'sha256:' + createHash('sha256').update(data).digest('hex')
const accepted = result => assert.equal(result.recorded, true, JSON.stringify(result))

/** Real public tool execution over synthetic host observations, with optional disk state. */
function world(options = {}) {
  const agent = { id: 'acceptance-parent', cwd: resolve('fixtures', 'acceptance') }
  const state = options.backend ? createStore(options.backend) : null
  const holder = { round: state?.loadSession(agent.id) ?? createRound(0, 'acceptance-round'), saves: 0 }
  const files = options.files ?? new Map(), children = [], stats = []
  const filePath = name => resolve(agent.cwd, name)
  const put = (name, data) => files.set(filePath(name), typeof data === 'string' ? data : JSON.stringify(data))
  if (!files.has(filePath('subject.bin'))) put('subject.bin', 'the expected delivered value')
  const commit = round => {
    if (state) assert.equal(state.saveSession(agent.id, round).ok, true)
    holder.round = round
    holder.saves++
  }
  const deps = {
    sessionFor: () => holder.round, save: (_agent, round) => commit(round), now: () => 1000,
    capabilities: options.capabilities ?? { children: false, person: false },
    stat(name, requestingAgent) {
      assert.equal(requestingAgent, agent)
      const path = filePath(name), data = files.get(path)
      stats.push(path)
      return data === undefined ? { exists: false, path } : { exists: true, isFile: true, path, size: Buffer.byteLength(data), mtimeMs: 1, fingerprint: fingerprint(data) }
    },
    readArtifact(name, requestingAgent) {
      assert.equal(requestingAgent, agent)
      const data = files.get(filePath(name))
      return { data: JSON.parse(data), fingerprint: fingerprint(data) }
    },
    listChildren: async () => children,
    readSession: async () => ({ preset: 'rigor-4', events: [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: JSON.stringify({
        role: 'review', verdict: 'approve', reading_ok: true,
        needs: holder.round.reading.needs.map(need => ({ id: need.id, status: 'met', how: 'read', evidence: 'The synthetic report and its subject agree with this requirement.' })),
        script_only: ['This synthetic host does not prove behavior in an untested live environment.'], deviations: [], rework: [], questions: [],
      }) }] } } }, { type: 'turn/end' },
    ] }),
  }
  const tools = Object.fromEntries(createTools(deps).map(tool => [tool.name, tool]))
  const execute = (name, args = {}) => tools[name].execute(args, { agent })
  if (holder.round.reading === null && options.initialize !== false) accepted(execute('rigor_read', {
    literal: 'Deliver the expected fixture value with declared acceptance evidence',
    needs: Array.from({ length: options.needs ?? 1 }, (_, index) => `stated: preserve value ${index + 1} => the inspected subject contains value ${index + 1}`).join(' | '),
  }))
  const plan = (strategy, extra = {}) => execute('rigor_plan', {
    approach: 'Keep the expected value and verify the actual delivered subject',
    steps: holder.round.reading.needs.map(need => `Verify ${need.id} => serves ${need.id} => the subject and report agree`).join(' | '),
    ...(strategy === undefined ? {} : { strategy: JSON.stringify(strategy) }), ...extra,
  })
  const run = (exit = 0, cmd = 'node verify-fixture.mjs') => {
    commit(recordCommand(holder.round, { cmd, exit, mutationHint: false, at: 1001 }))
    return holder.round.facts.commands.at(-1)
  }
  const report = (changes = {}, filename = 'report.json') => {
    const data = {
      check: 'C1', status: 'passed', observed: 'The subject contains the expected value', environment: metric.environment,
      subject: { path: 'subject.bin', sha256: fingerprint(files.get(filePath('subject.bin'))).slice('sha256:'.length) }, ...changes,
    }
    put(filename, data)
    return data
  }
  const evidence = (args = {}) => execute('rigor_evidence', { needs: 'N1', check: 'C1', ref: 'artifact:report.json', run: 'cmd:verify-fixture', ...args })
  const done = () => execute('rigor_report', {
    status: 'done', per_need: holder.round.reading.needs.map(need => `${need.id} met`).join(' | '),
    ...(deps.capabilities.children === false ? { limitations: 'This preset has no independent review channel.' } : {}),
  })
  const briefReview = (child = 'reviewer') => {
    children.push({ id: child, status: 'done' })
    const brief = execute('rigor_brief', { role: 'review', serves: holder.round.reading.needs.map(need => need.id).join(','), question: `${child}: inspect whether the actual subject and its validation evidence establish every requirement.` })
    assert.equal(brief.opened, true, JSON.stringify(brief))
    const claimed = claimBrief(holder.round, { briefId: brief.brief_id, childId: child, tool: 'subagent_review', at: 1002 })
    assert.equal(claimed.refusal, undefined)
    commit(claimed.round)
    return brief.brief_id
  }
  const approve = async (child = 'reviewer') => {
    const brief = briefReview(child)
    const result = await execute('rigor_review', { child, brief })
    accepted(result)
    return result
  }
  return { agent, holder, tools, execute, plan, run, report, evidence, done, briefReview, approve, put, files, filePath, stats, deps }
}

function directoryFixture(t) {
  const temporaryRoot = realpathSync(tmpdir()), directory = mkdtempSync(join(temporaryRoot, 'rigor-acceptance-'))
  t.after(() => {
    assert.equal(dirname(directory), temporaryRoot)
    assert.ok(basename(directory).startsWith('rigor-acceptance-'))
    rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

test('strategy help is available without required plan arguments and never records a plan', () => {
  const w = world({ initialize: false }), before = JSON.stringify(w.holder.round)
  const help = w.execute('rigor_plan', { strategy: 'help' })
  assert.match(JSON.stringify(help), /risk/)
  assert.match(JSON.stringify(help), /checks/)
  assert.equal(JSON.stringify(w.holder.round), before)
  assert.equal(w.holder.saves, 0)
  assert.notEqual(w.tools.rigor_plan.parameters.approach.required, true)
  assert.notEqual(w.tools.rigor_plan.parameters.steps.required, true)
  assert.equal(w.execute('rigor_plan', {}).recorded, false)
})

test('a legacy task keeps the short path even when its requirement count is large', async () => {
  const w = world({ needs: 6, capabilities: { children: true, person: true } })
  accepted(w.plan())
  const roles = requiredRoles(w.holder.round)
  assert.ok(roles.scale >= 10)
  assert.equal(roles.reviews, 1)
  assert.equal(roles.clarify, false)
  assert.equal(roles.diverge, false)
  assert.equal(roles.planReview, false)
  accepted(w.execute('rigor_evidence', { needs: 'N1,N2,N3,N4,N5,N6', ref: 'artifact:subject.bin' }))
  await w.approve()
  accepted(w.done())
  assert.equal(w.holder.round.facts.questions.length, 0)
  assert.equal(w.holder.round.reviews.length, 1)
})

test('a minimal task binds its check to the declared need while sharing report evidence across needs', () => {
  const w = world({ needs: 2 })
  accepted(w.plan(functional))
  assert.equal(w.done().recorded, false)
  w.run(); w.report()
  accepted(w.evidence())
  accepted(w.execute('rigor_evidence', { needs: 'N1,N2', ref: 'artifact:report.json' }))
  assert.deepEqual(w.holder.round.evidence.map(item => item.need), ['N1', 'N1', 'N2'])
  assert.equal(w.holder.round.evidence[0].check, 'C1')
  assert.equal(w.holder.round.evidence[0].validation.status, 'passed')
  w.stats.length = 0
  accepted(w.done())
  assert.equal(w.stats.filter(path => path === w.filePath('report.json')).length, 1)
  assert.equal(w.stats.filter(path => path === w.filePath('subject.bin')).length, 1)
})

test('a performance plan needs numeric acceptance criteria and a report needs actual samples', () => {
  const w = world(), incomplete = structuredClone(performance), before = JSON.stringify(w.holder.round)
  delete incomplete.checks[0].metric.threshold
  assert.equal(w.plan(incomplete).recorded, false)
  assert.equal(JSON.stringify(w.holder.round), before)
  accepted(w.plan(performance))
  w.run(); w.report()
  accepted(w.evidence())
  assert.equal(w.holder.round.evidence.at(-1).validation.status, 'failed')
  assert.ok(w.holder.round.evidence.at(-1).validation.errors.length > 0)
  assert.equal(w.done().recorded, false)
})

test('better numbers than a baseline still fail an absolute budget; a compliant rerun passes', () => {
  const w = world()
  accepted(w.plan(performance))
  w.run(); w.report({ measurement: { unit: metric.unit, workload: metric.workload, environment: metric.environment, samples: [21, 21, 21], baselineSamples: [100, 100, 100] } })
  accepted(w.evidence())
  const failed = w.holder.round.evidence.at(-1).validation
  assert.equal(failed.status, 'failed')
  assert.equal(failed.measured, 21)
  assert.equal(failed.baseline, 100)
  assert.equal(w.done().recorded, false)
  w.run(0, 'node verify-fixture-retry.mjs')
  w.report({ measurement: { unit: metric.unit, workload: metric.workload, environment: metric.environment, samples: [10, 12, 15], baselineSamples: [100, 100, 100] } }, 'retry-report.json')
  accepted(w.evidence({ ref: 'artifact:retry-report.json', run: 'cmd:verify-fixture-retry' }))
  assert.equal(w.holder.round.evidence.at(-1).validation.status, 'passed')
  assert.equal(w.holder.round.evidence.at(-1).validation.measured, 15)
  accepted(w.done())
})

test('unknown checks, malformed reports, mismatched subjects and pre-plan runs are refused without recording evidence', () => {
  for (const kind of ['unknown-check', 'invalid-json', 'subject-mismatch', 'pre-plan-run', 'wrong-report-reference']) {
    const w = world()
    if (kind === 'pre-plan-run') w.run()
    accepted(w.plan(functional))
    if (kind !== 'pre-plan-run') w.run()
    const data = w.report()
    if (kind === 'invalid-json') w.put('report.json', '{broken')
    if (kind === 'subject-mismatch') w.put('report.json', { ...data, subject: { ...data.subject, sha256: '0'.repeat(64) } })
    const before = JSON.stringify(w.holder.round), saves = w.holder.saves
    const args = kind === 'unknown-check' ? { check: 'C404' } : kind === 'wrong-report-reference' ? { ref: 'cmd:verify-fixture' } : {}
    assert.equal(w.evidence(args).recorded, false, kind)
    assert.equal(JSON.stringify(w.holder.round), before, kind)
    assert.equal(w.holder.saves, saves, kind)
  }
})

test('a failed host command records failure despite a passed report and the latest run determines readiness', () => {
  const w = world()
  accepted(w.plan(functional))
  w.run(1); w.report()
  accepted(w.evidence())
  assert.equal(w.holder.round.evidence.at(-1).validation.status, 'failed')
  assert.equal(w.done().recorded, false)
  w.run(0, 'node verify-fixture-success.mjs')
  accepted(w.evidence({ run: 'cmd:verify-fixture-success' }))
  assert.equal(w.holder.round.evidence.at(-1).validation.status, 'passed')
  w.run(1, 'node verify-fixture-latest.mjs')
  accepted(w.evidence({ run: 'cmd:verify-fixture-latest' }))
  assert.equal(w.holder.round.evidence.at(-1).validation.status, 'failed')
  assert.equal(w.done().recorded, false)
})

test('replanning retains the strategy across a file-backed restart and requires fresh check execution', t => {
  const directory = directoryFixture(t), w = world({ backend: createFileBackend({ directory }) })
  accepted(w.plan(functional))
  w.run(); w.report(); accepted(w.evidence())
  const strategy = structuredClone(w.holder.round.plan.strategy), validation = structuredClone(w.holder.round.evidence[0].validation)
  const reloaded = world({ backend: createFileBackend({ directory }), files: w.files })
  assert.equal(reloaded.holder.round.roundId, w.holder.round.roundId)
  assert.deepEqual(reloaded.holder.round.plan.strategy, strategy)
  assert.equal(reloaded.holder.round.evidence[0].check, 'C1')
  assert.deepEqual(reloaded.holder.round.evidence[0].validation, validation)
  accepted(reloaded.plan(undefined, { approach: 'Retain the acceptance criteria while changing the execution approach' }))
  assert.deepEqual(reloaded.holder.round.plan.strategy, strategy)
  assert.equal(reloaded.done().recorded, false)
  assert.equal(reloaded.evidence().recorded, false, 'a command from before the revised plan cannot revalidate it')
  reloaded.run(0, 'node verify-fixture-replanned.mjs')
  accepted(reloaded.evidence({ run: 'cmd:verify-fixture-replanned' }))
  accepted(reloaded.done())
})

test('an approval recorded before acceptance evidence cannot be reused to declare completion', async () => {
  const w = world({ capabilities: { children: true, person: true } })
  accepted(w.plan(functional))
  await w.approve('early-reviewer')
  w.run(); w.report(); accepted(w.evidence())
  const refused = w.done()
  assert.equal(refused.recorded, false)
  assert.match(JSON.stringify(refused), /review/i)
  assert.ok(w.holder.round.reviews[0].seq < w.holder.round.evidence[0].seq)
  await w.approve('current-reviewer')
  assert.ok(w.holder.round.reviews.at(-1).seq > w.holder.round.evidence.at(-1).seq)
  accepted(w.done())
})

test('late import of a completed reviewer cannot make its pre-check brief current', async () => {
  const w = world({ capabilities: { children: true, person: true } })
  accepted(w.plan(functional))
  // The synthetic child is already done, but its parent has not imported the log.
  const earlyBrief = w.briefReview('completed-before-checks')
  const briefSeq = w.holder.round.briefs.find(brief => brief.id === earlyBrief).seq
  w.run(); w.report(); accepted(w.evidence())
  assert.ok(briefSeq < w.holder.round.evidence.at(-1).seq)
  const before = JSON.stringify(w.holder.round)
  const refused = await w.execute('rigor_review', { child: 'completed-before-checks', brief: earlyBrief })
  assert.equal(refused.recorded, false, JSON.stringify(refused))
  assert.match(JSON.stringify(refused), /check|acceptance|validation|stale|brief/i)
  assert.equal(JSON.stringify(w.holder.round), before, 'an old approval must not be newly recorded by importing it late')
  assert.equal(w.done().recorded, false)
  await w.approve('briefed-after-checks')
  accepted(w.done())
})

test('a legal environment description longer than 500 characters survives acceptance and reporting', () => {
  const w = world(), environment = 'node24-fixture with reproducible runtime details: ' + 'x'.repeat(700)
  assert.ok(environment.length > 500 && environment.length <= 1000)
  const strategy = structuredClone(performance)
  strategy.checks[0].metric.environment = environment
  accepted(w.plan(strategy))
  w.run(); w.report({ environment, measurement: { unit: metric.unit, workload: metric.workload, environment, samples: [10, 12, 15] } })
  accepted(w.evidence())
  const validation = w.holder.round.evidence.at(-1).validation
  assert.equal(validation.status, 'passed')
  assert.equal(validation.environment, environment)
  assert.equal(validation.measured, 15)
  accepted(w.done())
})

test('external subject changes prevent completion even when the report itself stays unchanged', () => {
  const w = world()
  accepted(w.plan(functional))
  w.run(); w.report(); accepted(w.evidence())
  const reportBytes = w.files.get(w.filePath('report.json')), originalSubject = w.files.get(w.filePath('subject.bin'))
  w.put('subject.bin', 'an externally replaced artifact that the command never verified')
  const refused = w.done()
  assert.equal(refused.recorded, false)
  assert.equal(refused.code, 'stale-artifact')
  assert.equal(w.files.get(w.filePath('report.json')), reportBytes)
  w.put('subject.bin', originalSubject)
  accepted(w.done())
})
