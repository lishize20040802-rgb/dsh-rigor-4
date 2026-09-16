import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTools, resolveRef } from '../src/tools.js'
import { claimBrief, createRound, recordEdit, recordReadFact } from '../src/model.js'

const PAYLOAD = {
  verdict: 'approve', role: 'review', reading_ok: true,
  needs: [{ id: 'N1', status: 'met', how: 'read', evidence: 'The fixture contains the expected value.' }],
  script_only: ['The fixture does not establish every environment assumption.'],
  deviations: [], rework: [], questions: [],
}
const finished = (payload = PAYLOAD) => ({ preset: 'rigor-4', events: [
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '```json\n' + JSON.stringify(payload) + '\n```' }] } } },
  { type: 'turn/end' },
] })

function world(options = {}) {
  const agent = { id: 'parent', cwd: 'C:/fixtures/project' }
  const holder = { round: createRound(0), children: options.children ?? [{ id: 'reviewer', status: 'done' }] }
  const deps = {
    sessionFor: () => holder.round,
    save: (_agent, round) => { holder.round = round },
    now: () => 100,
    capabilities: { children: true, person: true },
    stat: options.stat ?? (() => ({ exists: true, isFile: true, size: 12, mtimeMs: 1, path: 'C:/fixtures/project/out.txt', fingerprint: 'fixture-hash' })),
    listChildren: options.listChildren ?? (async () => holder.children),
    readSession: options.readSession ?? (async () => finished()),
  }
  const tools = Object.fromEntries(createTools(deps).map(tool => [tool.name, tool]))
  const execute = (name, args = {}) => tools[name].execute(args, { agent })
  execute('rigor_read', { literal: 'Inspect the fixture', needs: 'stated: preserve the expected value => the expected value appears in the fixture' })
  execute('rigor_plan', { approach: 'Read and verify the value', steps: 'Read fixture => serves N1 => the expected fixture value is found' })
  const brief = (child = 'reviewer', role = 'review', question = `Judge whether ${child} observes every requirement of the current fixture delivery.`) => {
    const opened = execute('rigor_brief', { role, question, serves: 'N1' })
    assert.equal(opened.opened, true, JSON.stringify(opened))
    holder.round = claimBrief(holder.round, { briefId: opened.brief_id, childId: child, at: 50, tool: role === 'review' ? 'subagent_review' : 'subagent_explore' }).round
    return opened.brief_id
  }
  return { agent, holder, deps, execute, brief }
}

test('an invented brief cannot import a child approval or make done pass', async () => {
  const w = world()
  w.execute('rigor_evidence', { needs: 'N1', ref: 'artifact:out.txt' })
  const review = await w.execute('rigor_review', { child: 'reviewer', brief: 'B-does-not-exist' })
  assert.equal(review.recorded, false)
  assert.equal(w.holder.round.reviews.length, 0)
  assert.equal(w.execute('rigor_report', { status: 'done', per_need: 'N1 met' }).recorded, false)
})

test('review linking requires a claimed brief bound to this direct child and role', async () => {
  const w = world({ children: [{ id: 'reviewer', status: 'done' }, { id: 'other', status: 'done' }] })
  const id = w.brief()
  assert.equal((await w.execute('rigor_review', { child: 'other', brief: id })).recorded, false)
  assert.equal((await w.execute('rigor_review', { child: 'reviewer', brief: id, role: 'rework-check' })).recorded, false)
  w.holder.round = { ...w.holder.round, briefs: w.holder.round.briefs.map(item => ({ ...item, state: 'open' })) }
  assert.equal((await w.execute('rigor_review', { child: 'reviewer', brief: id })).recorded, false)
  assert.equal(w.holder.round.reviews.length, 0)
})

test('empty, unavailable, throwing and foreign child registries fail closed', async () => {
  for (const listChildren of [async () => [], async () => null, async () => { throw new Error('offline') }, async () => [{ id: 'foreign', status: 'done' }]]) {
    let logsRead = 0
    const w = world({ listChildren, readSession: async () => { logsRead += 1; return finished() } })
    const id = w.brief()
    assert.equal((await w.execute('rigor_review', { child: 'reviewer', brief: id })).recorded, false)
    assert.equal(logsRead, 0, 'unverified identities must not query another session log')
    assert.equal(w.holder.round.reviews.length, 0)
  }
})

test('a valid review links once and cannot inflate the independent review count', async () => {
  const w = world()
  const id = w.brief()
  assert.equal((await w.execute('rigor_review', { child: 'reviewer', brief: id })).recorded, true)
  assert.equal((await w.execute('rigor_review', { child: 'reviewer', brief: id })).recorded, false)
  assert.equal(w.holder.round.reviews.length, 1)
})

test('reading, plan and delivery changes each invalidate an earlier review brief', async () => {
  for (const change of [
    w => w.execute('rigor_read', { literal: 'Inspect revised fixture', needs: 'stated: verify the revised value => the revised expected value appears' }),
    w => w.execute('rigor_plan', { approach: 'Inspect with a revised plan', steps: 'Inspect revised fixture => serves N1 => the expected value is still present' }),
    w => { w.holder.round = recordEdit(w.holder.round, { target: 'out.txt', tool: 'edit', detail: 'changed', at: 101 }) },
  ]) {
    const w = world()
    const id = w.brief()
    change(w)
    const result = await w.execute('rigor_review', { child: 'reviewer', brief: id })
    assert.equal(result.recorded, false)
    assert.match(result.refused, /stale/)
  }
})

test('automatic review selection skips newer running and non-review children', async () => {
  const w = world({ children: [{ id: 'finished', status: 'done' }, { id: 'running', status: 'running' }, { id: 'explorer', status: 'done' }] })
  w.brief('finished')
  w.brief('running')
  w.brief('explorer', 'diverge')
  assert.equal((await w.execute('rigor_review')).recorded, true)
  assert.equal(w.holder.round.reviews[0].childId, 'finished')
})

test('review log reads preserve intervening facts and reject an intervening delivery change', async () => {
  for (const mutate of [false, true]) {
    let w
    w = world({ readSession: async () => {
      w.holder.round = mutate
        ? recordEdit(w.holder.round, { target: 'out.txt', tool: 'edit', detail: 'changed during query', at: 102 })
        : recordReadFact(w.holder.round, { ref: 'during-query.txt', at: 102 })
      return finished()
    } })
    w.brief()
    assert.equal((await w.execute('rigor_review', { child: 'reviewer' })).recorded, !mutate)
    assert.equal(mutate ? w.holder.round.facts.edits.length : w.holder.round.facts.reads.length, 1)
  }
})

test('normal reading revisions after editing do not become a late first reading', () => {
  const w = world()
  w.holder.round = recordEdit(w.holder.round, { target: 'out.txt', tool: 'edit', detail: 'changed', at: 101 })
  const revised = w.execute('rigor_read', { literal: 'Updated request', needs: 'stated: preserve the revised value => the revised expected value appears' })
  assert.equal(revised.recorded, true)
  assert.equal(revised.late, false)
  assert.equal(w.holder.round.reading.late, false)
})

test('read evidence rejects empty paths, partial basenames and ambiguous paths', () => {
  const w = world()
  w.holder.round = recordReadFact(w.holder.round, { ref: 'one/notreport.txt', at: 1 })
  assert.ok(resolveRef(w.holder.round, 'read:', w.deps).refusal)
  assert.ok(resolveRef(w.holder.round, 'read:report.txt', w.deps).refusal)
  assert.equal(resolveRef(w.holder.round, 'read:notreport.txt', w.deps).fact.kind, 'read')
  w.holder.round = recordReadFact(w.holder.round, { ref: 'two/notreport.txt', at: 2 })
  assert.match(resolveRef(w.holder.round, 'read:notreport.txt', w.deps).refusal, /multiple/)
  assert.equal(resolveRef(w.holder.round, 'read:two/notreport.txt', w.deps).fact.kind, 'read')
})

test('old observations cannot be relinked as evidence after the delivery changes', () => {
  const w = world()
  w.holder.round = recordReadFact(w.holder.round, { ref: 'out.txt', at: 1 })
  assert.equal(w.execute('rigor_evidence', { needs: 'N1', ref: 'read:out.txt' }).recorded, true)
  w.holder.round = recordEdit(w.holder.round, { target: 'out.txt', tool: 'edit', detail: 'changed', at: 2 })
  assert.equal(w.execute('rigor_evidence', { needs: 'N1', ref: 'read:out.txt' }).recorded, false)
  w.holder.round = recordReadFact(w.holder.round, { ref: 'out.txt', at: 3 })
  assert.equal(w.execute('rigor_evidence', { needs: 'N1', ref: 'read:out.txt' }).recorded, true)
})

test('artifact lookup gets the agent workspace and preserves the observed fingerprint', () => {
  let observedAgent
  const w = world({ stat: (path, agent) => {
    assert.equal(path, 'out.txt')
    observedAgent = agent
    return { exists: true, isFile: true, path: 'C:/different-project/out.txt', size: 42, mtimeMs: 10, fingerprint: 'sha256-fixture' }
  } })
  assert.equal(w.execute('rigor_evidence', { needs: 'N1', ref: 'artifact:out.txt' }).recorded, true)
  assert.equal(observedAgent, w.agent)
  const evidence = w.holder.round.evidence[0]
  assert.equal(evidence.path, 'C:/different-project/out.txt')
  assert.equal(evidence.size, 42)
  assert.equal(evidence.fingerprint, 'sha256-fixture')
  assert.ok(resolveRef(w.holder.round, 'artifact:', w.deps, w.agent).refusal)
  assert.ok(resolveRef(w.holder.round, 'artifact:folder', { stat: () => ({ exists: true, isFile: false, size: 42 }) }, w.agent).refusal)
})

test('done rechecks artifact fingerprints and relinking changed content invalidates approval', async () => {
  let fingerprint = 'before'
  const w = world({ stat: () => ({ exists: true, isFile: true, path: 'C:/fixtures/project/out.txt', size: 12, mtimeMs: 1, fingerprint }) })
  w.execute('rigor_evidence', { needs: 'N1', ref: 'artifact:out.txt' })
  w.brief()
  assert.equal((await w.execute('rigor_review', { child: 'reviewer' })).recorded, true)
  assert.equal(w.execute('rigor_report', { status: 'done', per_need: 'N1 met' }).recorded, true)
  fingerprint = 'after'
  const stale = w.execute('rigor_report', { status: 'done', per_need: 'N1 met' })
  assert.equal(stale.recorded, false)
  assert.equal(stale.code, 'stale-artifact')
  const previousRevision = w.holder.round.workRevision
  assert.equal(w.execute('rigor_evidence', { needs: 'N1', ref: 'artifact:out.txt' }).recorded, true)
  assert.ok(w.holder.round.workRevision > previousRevision)
  assert.equal(w.execute('rigor_report', { status: 'done', per_need: 'N1 met' }).recorded, false, 'relinking a new hash must not preserve the old approval')
})

test('an artifact that changes while being inspected is never accepted as evidence', () => {
  const w = world({ stat: () => ({ exists: true, isFile: true, size: 12, changedDuringRead: true }) })
  const result = w.execute('rigor_evidence', { needs: 'N1', ref: 'artifact:out.txt' })
  assert.equal(result.recorded, false)
  assert.match(result.refused, /changed during inspection/)
})
