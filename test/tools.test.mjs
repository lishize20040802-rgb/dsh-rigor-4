import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTools, parseNeeds, parsePerNeed, parseSteps, resolveRef, splitPipe } from '../src/tools.js'
import { claimBrief, createRound, openBrief, recordCommand, recordEdit, recordReadFact } from '../src/model.js'

const agent = { id: 's1' }

/** A world: one mutable round, the tools over it, and a fake filesystem answer. */
function world(options = {}) {
  const holder = { round: createRound(0) }
  const saved = []
  const deps = {
    sessionFor: () => holder.round,
    save: (_agent, next) => { holder.round = next; saved.push(next) },
    now: () => 1000,
    stat: path => (options.stat ? options.stat(path) : { exists: true, size: 12, mtimeMs: 5 }),
    capabilities: options.capabilities ?? { children: true, person: true },
    listChildren: async () => options.children ?? [],
    readSession: async id => {
      const events = options.sessions ? options.sessions[id] : undefined
      if (events === undefined || events === null) return null
      return { events, preset: (options.childPresets ?? {})[id] ?? 'rigor-4' }
    },
  }
  const tools = Object.fromEntries(createTools(deps).map(tool => [tool.name, tool]))
  return { tools, holder, saved, deps }
}

function childWith(payload) {
  return [
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Here is my verdict:\n```json\n' + JSON.stringify(payload) + '\n```' }] } } },
    { type: 'turn/end' },
  ]
}

test('the parsers refuse with the reason, not silently', () => {
  const needs = parseNeeds('implicit: old logs are recoverable => a rotated file is still readable | stated: prune them')
  assert.equal(needs.items.length, 1)
  assert.equal(needs.refused.length, 1)
  assert.match(needs.refused[0].why, /=> test/)
  const steps = parseSteps('rotate => => run it')
  assert.equal(steps.items.length, 0)
  assert.match(steps.refused[0].why, /no need is named/)
  const perNeed = parsePerNeed('N1 mostly')
  assert.equal(perNeed.refused.length, 1)
  assert.deepEqual(splitPipe('a\\|b | c'), ['a|b', 'c'])
})

test('rigor_read records a reading and keeps a normal later revision timely', () => {
  const { tools, holder } = world()
  const first = tools.rigor_read.execute({
    literal: 'prune the logs',
    needs: 'implicit: old logs stay recoverable => a rotated file is still readable',
  }, { agent })
  assert.equal(first.recorded, true)
  assert.equal(first.needs.length, 1)
  assert.equal(holder.round.reading.needs[0].kind, 'implicit')
  assert.equal(first.late, false)

  holder.round = recordEdit(holder.round, { target: 'a.js', tool: 'edit', detail: 'a.js', at: 1 })
  const late = tools.rigor_read.execute({ literal: 'prune the logs', needs: 'implicit: old logs stay recoverable => a rotated file is still readable' }, { agent })
  assert.equal(late.late, false)
  assert.equal(holder.round.reading.version, 2, 'revision is versioned, not a silent rewrite')
})

test('rigor_plan refuses a step serving a need that does not exist', () => {
  const { tools } = world()
  tools.rigor_read.execute({ literal: 'x', needs: 'stated: y => y is visible in the output' }, { agent })
  const refused = tools.rigor_plan.execute({ approach: 'do y', steps: 'do it => serves N9 => run the check' }, { agent })
  assert.equal(refused.recorded, false)
  assert.match(refused.refused, /not on the current reading/)
  const ok = tools.rigor_plan.execute({ approach: 'do y', steps: 'do it => serves N1 => run the check and read the output' }, { agent })
  assert.equal(ok.recorded, true)
  assert.deepEqual(ok.unserved_needs, [])
})

test('rigor_evidence verifies the fact exists, and says what is available when it does not', () => {
  const { tools, holder } = world()
  tools.rigor_read.execute({ literal: 'x', needs: 'stated: y => y is visible in the output' }, { agent })
  holder.round = recordCommand(holder.round, { cmd: 'node prune.test.js', exit: 0, at: 2 })
  holder.round = recordReadFact(holder.round, { ref: 'logs/app.log.1', at: 3 })
  const byCmd = tools.rigor_evidence.execute({ needs: 'N1', ref: 'cmd:prune.test.js', note: 'ran clean' }, { agent })
  assert.equal(byCmd.recorded, true)
  const byRead = tools.rigor_evidence.execute({ needs: 'N1', ref: 'read:app.log.1' }, { agent })
  assert.equal(byRead.recorded, true)
  const byArtifact = tools.rigor_evidence.execute({ needs: 'N1', ref: 'artifact:logs/app.log.1' }, { agent })
  assert.equal(byArtifact.recorded, true)
  const missing = tools.rigor_evidence.execute({ needs: 'N1', ref: 'cmd:never-ran' }, { agent })
  assert.equal(missing.recorded, false)
  assert.match(missing.refused, /Recent commands/)
  const unknown = tools.rigor_evidence.execute({ needs: 'N7', ref: 'artifact:logs/app.log.1' }, { agent })
  assert.equal(unknown.recorded, false)
})

test('resolveRef refuses an artifact that is not there, and an empty one', () => {
  const round = createRound(0)
  const missing = resolveRef(round, 'artifact:gone.log', { stat: () => ({ exists: false, size: 0, mtimeMs: 0 }) })
  assert.match(missing.refusal, /does not exist/)
  const empty = resolveRef(round, 'artifact:empty.log', { stat: () => ({ exists: true, size: 0, mtimeMs: 0 }) })
  assert.match(empty.refusal, /empty/)
})

test('rigor_report always records an honest partial, and refuses one with nothing named', () => {
  const { tools, holder } = world()
  const refused = tools.rigor_report.execute({ status: 'partial' }, { agent })
  assert.equal(refused.recorded, false)
  const ok = tools.rigor_report.execute({ status: 'partial', gaps: 'the prune script is not written yet' }, { agent })
  assert.equal(ok.recorded, true)
  assert.equal(holder.round.reports.length, 1)
})

test('rigor_report(done) is refused before it is recorded, with every missing piece named', () => {
  const { tools } = world()
  const refused = tools.rigor_report.execute({ status: 'done', per_need: 'N1 met' }, { agent })
  assert.equal(refused.recorded, false)
  const codes = refused.items.map(item => item.code)
  assert.ok(codes.includes('no-reading'))
  for (const item of refused.items) {
    assert.ok(item.exit.length > 10, `${item.code} names an exit`)
  }
  assert.equal(refused.recorded === false, true)
})

test('a round can reach done through the tools, with the review read from the child log', async () => {
  const payload = {
    verdict: 'approve',
    role: 'review',
    reading_ok: true,
    needs: [{ id: 'N1', status: 'met', how: 'read', evidence: 'I read logs/app.log.1 and the rotation marker is there' }],
    script_only: ['the test proves exit 0, not that an old rotation survives'],
    deviations: [],
    rework: [],
    questions: [],
  }
  const { tools, holder } = world({ children: [{ id: 'child-1', status: 'done' }], sessions: { 'child-1': childWith(payload) } })
  tools.rigor_read.execute({ literal: 'prune the logs', needs: 'implicit: old logs stay recoverable => a rotated file is still readable' }, { agent })
  tools.rigor_plan.execute({ approach: 'rotate instead of delete', steps: 'rotate the logs => serves N1 => run the script and read the newest rotation' }, { agent })
  tools.rigor_evidence.execute({ needs: 'N1', ref: 'artifact:logs/app.log.1', note: 'on disk after the run' }, { agent })
  const brief = tools.rigor_brief.execute({ role: 'review', question: 'Judge whether the rotated log stays readable after the prune script runs.', serves: 'N1' }, { agent })
  assert.equal(brief.opened, true)
  holder.round = claimBrief(holder.round, { briefId: brief.brief_id, childId: 'child-1', at: 7 }).round
  const review = await tools.rigor_review.execute({ child: 'child-1' }, { agent })
  assert.equal(review.recorded, true, JSON.stringify(review))
  assert.equal(review.verdict, 'approve')
  assert.equal(review.child_preset, 'rigor-4', 'the child preset is read from the child, not assumed')
  const done = tools.rigor_report.execute({ status: 'done', per_need: 'N1 met', reading_confirmed: 'no' }, { agent })
  assert.equal(done.recorded, true, JSON.stringify(done))
  assert.equal(holder.round.reports[0].status, 'done')
})

test('a reviewer whose payload is unusable is refused, and the child message comes back', async () => {
  const { tools, holder } = world({ children: [{ id: 'child-1', status: 'done' }], sessions: { 'child-1': [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'I looked at it and it seems fine.' }] } } }, { type: 'turn/end' }] } })
  tools.rigor_read.execute({ literal: 'x', needs: 'stated: y => y is visible in the output' }, { agent })
  tools.rigor_plan.execute({ approach: 'do y', steps: 'do it => serves N1 => run the check and read the output' }, { agent })
  const brief = tools.rigor_brief.execute({ role: 'review', question: 'Judge whether the delivered thing meets the need the person actually stated.' }, { agent })
  assert.equal(brief.opened, true, JSON.stringify(brief))
  const claimed = claimBrief(holder.round, { briefId: brief.brief_id, childId: 'child-1', at: 7 })
  assert.ok(claimed.round !== undefined, JSON.stringify(claimed))
  holder.round = claimed.round
  const review = await tools.rigor_review.execute({ child: 'child-1' }, { agent })
  assert.equal(review.recorded, false)
  assert.match(review.refused, /no JSON block/)
  assert.match(review.child_final_message, /seems fine/)
})

test('a preset with no child channel does not spend attention on doors that are not there', () => {
  const solo = world({ capabilities: { children: false, person: false, profiles: false } })
  const kept = ['rigor_read', 'rigor_plan', 'rigor_evidence', 'rigor_report']
  const text = kept.map(name => `${solo.tools[name].description} ${JSON.stringify(solo.tools[name].parameters)}`).join(' ')
  for (const word of ['subagent', 'reviewer', 'rigor_brief', 'rigor_review', 'child']) {
    assert.ok(!new RegExp(word, 'i').test(text), `the solo wording does not mention ${word}`)
  }
  assert.match(solo.tools.rigor_report.description, /independent-review channel/, 'it still says what the report has to declare')
  const capable = world({ capabilities: { children: true, person: true, profiles: true } })
  assert.match(capable.tools.rigor_report.description, /review/, 'the capable wording still talks about the reviews it has')
})

test('a preset without children can still reach done, by declaring what it could not do', () => {
  const { tools } = world({ capabilities: { children: false, person: false } })
  const brief = tools.rigor_brief.execute({ role: 'review', question: 'Judge whether the delivered thing meets the need the person actually stated.' }, { agent })
  assert.equal(brief.opened, false)
  assert.match(brief.refused, /no subagent channel/)
  tools.rigor_read.execute({ literal: 'x', needs: 'stated: y => y is visible in the output' }, { agent })
  tools.rigor_plan.execute({ approach: 'do y', steps: 'do it => serves N1 => run the check and read the output' }, { agent })
  tools.rigor_evidence.execute({ needs: 'N1', ref: 'artifact:out.txt' }, { agent })
  const refused = tools.rigor_report.execute({ status: 'done', per_need: 'N1 met' }, { agent })
  assert.equal(refused.recorded, false)
  assert.ok(refused.items.some(item => item.code === 'undeclared-limitation'))
  const ok = tools.rigor_report.execute({ status: 'done', per_need: 'N1 met', limitations: 'this preset has no subagent channel: no independent review happened' }, { agent })
  assert.equal(ok.recorded, true, JSON.stringify(ok))
})
