import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../src/index.js'

/**
 * A minimal host: a tool registry, a prompt registry, a service bag, events.
 * The fixture hands the plugin the shapes the real dispatcher does — including the
 * `{ isError, value, content }` envelope of `tools/post-execute` — because a fixture
 * that hands over something friendlier tests a build that does not exist.
 */
function host(services = {}) {
  const tools = []
  const listeners = new Map()
  const sections = []
  const promptRegistry = { section: section => sections.push(section) }
  const ctx = {
    tools: { register: tool => tools.push(tool) },
    get: key => (key === 'systemPrompt' ? promptRegistry : services[key]),
    on: (event, handler) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
  }
  return {
    ctx,
    tools,
    sections,
    has: event => (listeners.get(event) ?? []).length > 0,
    fire: async (event, payload, next = async () => ({ kind: 'enter', messages: [] }), result = { isError: false, value: { exitCode: 0 }, content: '' }) => {
      const list = listeners.get(event) ?? []
      let last
      for (const handler of list) {
        if (event === 'tools/post-execute') last = await handler(payload, result, next)
        else if (event === 'tools/result') last = await handler(payload, result)
        else last = await handler(payload, next)
      }
      return last
    },
  }
}

function memoryBackend(written = []) {
  return { read: () => written.at(-1), write: text => written.push(text), clear: () => { written.length = 0 } }
}

const agent = (id = 's1', header = {}) => ({ id, session: { header: { cwd: process.cwd(), ...header } }, steer: () => {} })
const SERVICES = { subagents: { listChildren: async () => [] }, sessionQuery: { readSession: async () => ({ session: { agentPreset: 'rigor-4' }, events: [] }) }, jobs: { list: () => [] } }
const subject = (id = 's1', header = {}) => {
  const steers = []
  return { agent: { ...agent(id, header), steer: message => steers.push(message) }, steers }
}

let callSequence = 0
async function dispatch(fire, exec, result = { isError: false, value: { exitCode: 0 }, content: '' }) {
  const payload = { ...exec, callId: `test-call-${++callSequence}` }
  const gate = await fire('tools/pre-execute', { ...payload }, async () => ({ kind: 'enter' }))
  if (gate.kind === 'deny') {
    await fire('tools/post-execute', { ...payload }, undefined, { isError: true, value: undefined, content: gate.reason })
    await fire('tools/result', { ...payload }, undefined, { isError: true, value: undefined, content: gate.reason })
    return gate
  }
  await fire('tools/execute', { ...payload }, async () => result)
  await fire('tools/post-execute', { ...payload }, undefined, result)
  await fire('tools/result', { ...payload }, undefined, result)
  return gate
}

const childEvents = payload => ([
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'My verdict:\n```json\n' + JSON.stringify(payload) + '\n```' }] } } },
  { type: 'turn/end' },
])

const APPROVE = {
  verdict: 'approve', role: 'review', reading_ok: true,
  needs: [{ id: 'N1', status: 'met', how: 'read', evidence: 'I read the artifact and the marker is there' }],
  script_only: ['the command proves exit 0, not that an old rotation survives'],
  deviations: [], rework: [], questions: [],
}

test('mounting registers six tools, one section, and the nine events it needs', () => {
  const { ctx, tools, sections, has } = host(SERVICES)
  apply(ctx, { backend: memoryBackend() })
  assert.deepEqual(tools.map(tool => tool.name), ['rigor_read', 'rigor_plan', 'rigor_brief', 'rigor_evidence', 'rigor_review', 'rigor_report'])
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'rigor4.discipline')
  for (const event of ['tools/post-execute', 'tools/pre-execute', 'tools/execute', 'tools/result', 'agent/turn-stopping', 'agent/pre-step', 'agent/inbox/claimed', 'agent/session-start', 'agent/disposed']) {
    assert.ok(has(event), `${event} is subscribed`)
  }
})

test('a session start records an empty round, a reload keeps the reading, and dispose deletes nothing', async () => {
  const written = []
  const backend = memoryBackend(written)
  const first = host()
  apply(first.ctx, { backend })
  await first.fire('agent/session-start', { agent: agent() })
  assert.equal(written.length, 1)
  await first.tools.find(tool => tool.name === 'rigor_read').execute({ literal: 'prune the logs', needs: 'implicit: old logs stay recoverable => a rotated file is still readable' }, { agent: agent() })
  assert.ok(JSON.parse(written[written.length - 1]).sessions.s1.reading.needs.length === 1)

  // A new process: the stored round comes back, and starting the session does not
  // rewrite it, because a reload is not an erasure and not a fresh round either.
  const before = written.length
  const second = host()
  apply(second.ctx, { backend })
  await second.fire('agent/session-start', { agent: agent() })
  assert.equal(written.length, before, 'a reload does not rewrite the record')
  await second.fire('agent/disposed', { agent: agent() })
  assert.equal(written.length, before, 'dispose does not rewrite or delete the record')
  const stored = JSON.parse(written[written.length - 1]).sessions.s1
  assert.equal(stored.reading.literal, 'prune the logs')
})

test('nothing is edited before the reading exists, and the denial names the exit', async () => {
  const { ctx, fire, tools } = host()
  apply(ctx, { backend: memoryBackend() })
  const { agent: who } = subject()
  let passedThrough = false
  const denied = await fire('tools/pre-execute', { name: 'edit', agent: who, arguments: { file_path: 'a.js' } }, async () => { passedThrough = true; return { kind: 'enter' } })
  assert.equal(passedThrough, false, 'the mutation never reached the pipeline')
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /rigor_read/)
  await tools.find(tool => tool.name === 'rigor_read').execute({ literal: 'x', needs: 'stated: y => y is visible in the output' }, { agent: who })
  const allowed = await fire('tools/pre-execute', { name: 'edit', agent: who, arguments: { file_path: 'a.js' } }, async () => { passedThrough = true; return { kind: 'enter' } })
  assert.equal(passedThrough, true)
  assert.equal(allowed.kind, 'enter')
})

test('a spawn without a brief is refused; a spawn that matches one claims it', async () => {
  const { ctx, fire, tools } = host(SERVICES)
  apply(ctx, { backend: memoryBackend() })
  const { agent: who } = subject()
  const denied = await fire('tools/pre-execute', { name: 'subagent', agent: who, arguments: { description: 'go and look at something' } })
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /no brief is open/)
  const question = 'Find what the person left unsaid about retention windows, especially anything about deletion.'
  const brief = await tools.find(tool => tool.name === 'rigor_brief').execute({ role: 'clarify', question, serves: 'N1' }, { agent: who })
  assert.equal(brief.opened, true, JSON.stringify(brief))
  assert.match(brief.brief, /CLARIFY child/)
  assert.match(brief.brief, /what did they mean/)
  let passedThrough = false
  const allowed = await fire('tools/pre-execute', { name: 'subagent', agent: who, arguments: { description: question } }, async () => { passedThrough = true; return { kind: 'enter' } })
  assert.equal(passedThrough, true)
  assert.equal(allowed.kind, 'enter')
  const mismatch = await fire('tools/pre-execute', { name: 'subagent', agent: who, arguments: { description: 'an entirely different question that was never briefed' } })
  assert.equal(mismatch.kind, 'deny', 'the brief was claimed, so a different spawn does not match it')
})

test('a turn that changes files and says nothing is held once; a partial report ends it', async () => {
  const { ctx, fire, tools } = host()
  apply(ctx, { backend: memoryBackend() })
  const { agent: who, steers } = subject()
  await fire('agent/session-start', { agent: who })
  await tools.find(tool => tool.name === 'rigor_read').execute({ literal: 'edit A', needs: 'stated: A changed => the edit is visible' }, { agent: who })
  assert.equal((await dispatch(fire, { name: 'edit', agent: who, arguments: { file_path: 'a.js' } })).kind, 'enter')
  await fire('agent/turn-stopping', { agent: who, turn: 1 })
  assert.equal(steers.length, 1)
  assert.match(steers[0].content[0].text, /recorded no account/)
  assert.match(steers[0].content[0].text, /rigor_report/)
  await tools.find(tool => tool.name === 'rigor_report').execute({ status: 'partial', gaps: 'the change is not verified yet' }, { agent: who })
  await fire('agent/turn-stopping', { agent: who, turn: 2 })
  assert.equal(steers.length, 1, 'an honest partial report ends the hold')
})

test('end to end: reading, plan, evidence, a briefed child, its own log read back, then done', async () => {
  const services = {
    subagents: { listChildren: async () => [{ id: 'child-1', activity: 'done' }] },
    sessionQuery: { readSession: async id => ({ session: { agentPreset: 'rigor-4', origin: 'subagent', parentSession: 's1' }, events: id === 'child-1' ? childEvents(APPROVE) : [] }) },
    jobs: { list: () => [] },
  }
  const { ctx, tools, fire } = host(services)
  const written = []
  apply(ctx, { backend: memoryBackend(written) })
  const { agent: who, steers } = subject()
  await fire('agent/session-start', { agent: who })
  const call = (name, args) => tools.find(tool => tool.name === name).execute(args, { agent: who })

  const read = await call('rigor_read', { literal: 'prune the logs', needs: 'implicit: old logs stay recoverable => a rotated file is still readable' })
  assert.equal(read.recorded, true)
  assert.equal(read.capabilities.children, true)
  const plan = await call('rigor_plan', { approach: 'rotate instead of delete', steps: 'rotate the logs => serves N1 => run the script and read the newest rotation' })
  assert.equal(plan.recorded, true)
  const evidence = await call('rigor_evidence', { needs: 'N1', ref: 'artifact:package.json', note: 'present after the run' })
  assert.equal(evidence.recorded, true, JSON.stringify(evidence))
  const brief = await call('rigor_brief', { role: 'review', question: 'Judge whether the rotated log stays readable after the prune script runs, against the person\'s need.', serves: 'N1' })
  assert.equal(brief.opened, true, JSON.stringify(brief))
  assert.equal(brief.spawn_with, 'subagent_review', 'a review brief names the tool that carries a reviewer profile')

  const spawn = await dispatch(fire, { name: 'subagent_review', agent: who, arguments: { description: brief.brief } }, { isError: false, value: { subagentId: 'child-1' }, content: '' })
  assert.equal(spawn.kind, 'enter')
  await fire('agent/turn-stopping', { agent: who, turn: 1 })
  const linked = await call('rigor_review', { child: 'child-1' })
  assert.equal(linked.recorded, true, JSON.stringify(linked))
  assert.equal(linked.verdict, 'approve')
  assert.equal(linked.child_preset, 'rigor-4', "the preset is read from the child's own header")
  assert.equal(linked.child_tool, 'subagent_review', 'the tool that opened the child is recorded')
  assert.deepEqual(linked.script_only, APPROVE.script_only)
  const done = await call('rigor_report', { status: 'done', per_need: 'N1 met', reading_confirmed: 'no' })
  assert.equal(done.recorded, true, JSON.stringify(done))
  const stored = JSON.parse(written[written.length - 1]).sessions.s1
  assert.equal(stored.reports[0].status, 'done')
  assert.equal(stored.reviews[0].verdict, 'approve')
  assert.equal(steers.length, 0, 'nothing held a turn that always reported')
})

test('a brief can only be answered by the tool built for its job', async () => {
  const { ctx, tools, fire } = host(SERVICES)
  apply(ctx, { backend: memoryBackend() })
  const { agent: who } = subject()
  const clarifyQuestion = 'Find what the person left unsaid about the retention window, especially anything they assume is obvious.'
  const brief = await tools.find(tool => tool.name === 'rigor_brief').execute({ role: 'clarify', question: clarifyQuestion, serves: 'N1' }, { agent: who })
  assert.equal(brief.opened, true, JSON.stringify(brief))
  assert.equal(brief.spawn_with, 'subagent_explore')

  const wrongTool = await fire('tools/pre-execute', { name: 'subagent_review', agent: who, arguments: { description: brief.brief } })
  assert.equal(wrongTool.kind, 'deny')
  assert.match(wrongTool.reason, /different capability profile/)
  assert.match(wrongTool.reason, /subagent_explore/)

  const rightTool = await fire('tools/pre-execute', { name: 'subagent_explore', agent: who, arguments: { description: brief.brief } }, async () => ({ kind: 'enter' }))
  assert.equal(rightTool.kind, 'enter')

  await tools.find(tool => tool.name === 'rigor_read').execute({ literal: 'prune the logs', needs: 'implicit: old logs stay recoverable => a rotated file is still readable' }, { agent: who })
  await tools.find(tool => tool.name === 'rigor_plan').execute({ approach: 'rotate instead of delete', steps: 'rotate the logs => serves N1 => read the newest rotation' }, { agent: who })
  const review = await tools.find(tool => tool.name === 'rigor_brief').execute({ role: 'review', question: 'Judge whether the rotated log stays readable after the prune script runs, against the person\'s need.', serves: 'N1' }, { agent: who })
  assert.equal(review.spawn_with, 'subagent_review')
  const refused = await fire('tools/pre-execute', { name: 'subagent_explore', agent: who, arguments: { description: review.brief } })
  assert.equal(refused.kind, 'deny')
  assert.match(refused.reason, /subagent_review/)
})

test('a briefed child enforces its own role in its own gate', async () => {
  const { ctx, fire } = host(SERVICES)
  apply(ctx, { backend: memoryBackend() })
  const review = subject('child-review', { origin: 'subagent', parentSession: 's1' })
  const reviewBrief = ['# Brief: review', '', 'Judge the delivery against the reading.', 'Start this child with the subagent_review tool.'].join('\n')
  await fire('agent/inbox/claimed', { agent: review.agent, message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: reviewBrief }] } })
  const edit = await fire('tools/pre-execute', { name: 'edit', agent: review.agent, arguments: { file_path: 'a.js' } })
  assert.equal(edit.kind, 'deny')
  assert.match(edit.reason, /read-only/)
  const shell = await fire('tools/pre-execute', { name: 'pwsh', agent: review.agent, arguments: { command: 'node --test' } }, async () => ({ kind: 'enter' }))
  assert.equal(shell.kind, 'enter', 'a reviewer may run the checks')
  const delegate = await fire('tools/pre-execute', { name: 'subagent_review', agent: review.agent, arguments: { description: 'another review' } })
  assert.equal(delegate.kind, 'deny')
  const ask = await fire('tools/pre-execute', { name: 'ask_user_question', agent: review.agent, arguments: {} })
  assert.equal(ask.kind, 'deny')

  const explore = subject('child-explore', { origin: 'subagent', parentSession: 's1' })
  const exploreBrief = ['# Brief: plan-review', '', 'Attack the plan.', 'Start this child with the subagent_explore tool.'].join('\n')
  await fire('agent/inbox/claimed', { agent: explore.agent, message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: exploreBrief }] } })
  const noShell = await fire('tools/pre-execute', { name: 'pwsh', agent: explore.agent, arguments: { command: 'ls' } })
  assert.equal(noShell.kind, 'deny')
  assert.match(noShell.reason, /no shell/)
})

test('when the preset carries role children, the generic spawn cannot answer a brief', async () => {
  const { ctx, tools, fire } = host(SERVICES)
  apply(ctx, { backend: memoryBackend(), capabilities: { children: true, person: true, profiles: true } })
  const { agent: who } = subject()
  const brief = await tools.find(tool => tool.name === 'rigor_brief').execute({ role: 'clarify', question: 'Find what the person left unsaid about the retention window, especially anything they assume is obvious.' }, { agent: who })
  assert.equal(brief.opened, true, JSON.stringify(brief))
  const generic = await fire('tools/pre-execute', { name: 'subagent', agent: who, arguments: { description: brief.brief } })
  assert.equal(generic.kind, 'deny')
  assert.match(generic.reason, /subagent_explore/)
  const role = await fire('tools/pre-execute', { name: 'subagent_explore', agent: who, arguments: { description: brief.brief } }, async () => ({ kind: 'enter' }))
  assert.equal(role.kind, 'enter')
})

test('the free channel says it once, and a batch arrives as one message', async () => {
  const jobs = { list: () => [{ id: 'pwsh-1', status: 'running' }] }
  const { ctx, fire } = host({ ...SERVICES, jobs })
  apply(ctx, { backend: memoryBackend() })
  const { agent: who } = subject()
  await fire('agent/session-start', { agent: who })

  await fire('agent/turn-stopping', { agent: who, turn: 1 })
  const first = await fire('agent/pre-step', { agent: who })
  assert.equal(first.messages.length, 1, 'a batch of advisories is one message')
  assert.match(first.messages[0].content[0].text, /1 background job/)

  await fire('agent/turn-stopping', { agent: who, turn: 2 })
  const second = await fire('agent/pre-step', { agent: who })
  assert.equal(second.messages.length, 0, 'the same sentence is never said twice')

  await fire('agent/inbox/claimed', { agent: who, message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } })
  await fire('agent/turn-stopping', { agent: who, turn: 3 })
  const third = await fire('agent/pre-step', { agent: who })
  assert.equal(third.messages.length, 0, 'a new user message does not replay it either')

  jobs.list = () => [{ id: 'pwsh-1', status: 'running' }, { id: 'pwsh-2', status: 'running' }]
  await fire('agent/turn-stopping', { agent: who, turn: 4 })
  const fourth = await fire('agent/pre-step', { agent: who })
  assert.equal(fourth.messages.length, 1, 'changed content is new information')
  assert.match(fourth.messages[0].content[0].text, /2 background job/)
})

test('a preset with no child channel registers no tool that can only refuse', async () => {
  const { ctx, tools } = host()
  apply(ctx, { backend: memoryBackend(), capabilities: { children: false, person: false } })
  assert.deepEqual(tools.map(tool => tool.name), ['rigor_read', 'rigor_plan', 'rigor_evidence', 'rigor_report'],
    'the two tools that cannot succeed here are not registered at all')
})

test('a preset that declares no child channel says so instead of demanding one', async () => {
  const { ctx, tools } = host()
  apply(ctx, { backend: memoryBackend(), capabilities: { children: false, person: false } })
  const who = agent()
  await tools.find(tool => tool.name === 'rigor_read').execute({ literal: 'x', needs: 'stated: y => y is visible in the output' }, { agent: who })
  await tools.find(tool => tool.name === 'rigor_plan').execute({ approach: 'do y', steps: 'do it => serves N1 => run the check and read the output' }, { agent: who })
  await tools.find(tool => tool.name === 'rigor_evidence').execute({ needs: 'N1', ref: 'artifact:package.json' }, { agent: who })
  const refused = await tools.find(tool => tool.name === 'rigor_report').execute({ status: 'done', per_need: 'N1 met' }, { agent: who })
  assert.equal(refused.recorded, false)
  assert.ok(refused.items.some(item => item.code === 'undeclared-limitation'))
  const accepted = await tools.find(tool => tool.name === 'rigor_report').execute({ status: 'done', per_need: 'N1 met', limitations: 'no subagent channel: no independent review happened' }, { agent: who })
  assert.equal(accepted.recorded, true, JSON.stringify(accepted))
})

test('a spawn that labels itself and hands the brief over in `prompt` still answers its brief', async () => {
  // The shape a real caller sends: a short `description` label plus the brief text in
  // `prompt`. Reading only the first non-empty field made the gate refuse exactly this
  // spawn in a live PTC session — the reviewer never started, and the session reported the
  // missing review as a harness fault.
  const { ctx, fire, tools } = host(SERVICES)
  apply(ctx, { backend: memoryBackend() })
  const { agent: who } = subject()
  await fire('agent/session-start', { agent: who })
  await tools.find(tool => tool.name === 'rigor_read').execute({ literal: 'x', needs: 'stated: y => y is visible in the output' }, { agent: who })
  await tools.find(tool => tool.name === 'rigor_plan').execute({ approach: 'do y', steps: 'do it => serves N1 => run the check and read the output' }, { agent: who })
  const question = 'Check whether the rewritten backend still keeps every recognition request on this machine.'
  const brief = await tools.find(tool => tool.name === 'rigor_brief').execute({ role: 'monitor', question, serves: 'N1' }, { agent: who })
  assert.equal(brief.opened, true, JSON.stringify(brief))
  let passedThrough = false
  const allowed = await fire('tools/pre-execute', {
    name: 'subagent_monitor',
    agent: who,
    arguments: { description: 'Watch the rewrite for drift', prompt: brief.brief },
  }, async () => { passedThrough = true; return { kind: 'enter' } })
  assert.equal(passedThrough, true, 'the spawn that carried the brief reached the pipeline')
  assert.equal(allowed.kind, 'enter')
})

test('a finished non-review child is closed when the parent turn stops, and it must not kill the turn', async () => {
  // collectConclusions() skips review and rework-check briefs, which is why the end-to-end
  // test above never enters its body. A monitor child that has finished is the shape that
  // does — and the body used to read an undeclared `last`, throw "last is not defined",
  // and turn every turn of a live session into an error.
  const services = {
    subagents: { listChildren: async () => [{ id: 'child-mon', activity: 'done' }] },
    sessionQuery: {
      readSession: async () => ({
        session: { agentPreset: 'rigor-4', origin: 'subagent', parentSession: 's1' },
        events: [
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'nothing drifted: every command was read-only' }] } } },
          { type: 'turn/end' },
        ],
      }),
    },
    jobs: { list: () => [] },
  }
  const { ctx, tools, fire } = host(services)
  const written = []
  apply(ctx, { backend: memoryBackend(written) })
  const { agent: who } = subject()
  await fire('agent/session-start', { agent: who })
  const call = (name, args) => tools.find(tool => tool.name === name).execute(args, { agent: who })
  await call('rigor_read', { literal: 'scan the system drive and report what can be cleaned', needs: 'stated: scan only, never delete => no delete or move command appears in the log' })
  const brief = await call('rigor_brief', { role: 'monitor', question: 'Watch the scan for drift while it runs, and report what you saw with its evidence.', serves: 'N1' })
  assert.equal(brief.opened, true, JSON.stringify(brief))
  const spawn = await dispatch(fire, { name: 'subagent_monitor', agent: who, arguments: { description: brief.brief } }, { isError: false, value: { subagentId: 'child-mon' }, content: '' })
  assert.equal(spawn.kind, 'enter')
  await assert.doesNotReject(() => fire('agent/turn-stopping', { agent: who, turn: 1 }), 'a finished child must not turn the parent turn into an error')
  const stored = JSON.parse(written[written.length - 1]).sessions.s1
  const monitor = stored.briefs.filter(item => item.role === 'monitor')
  assert.equal(monitor.length, 1)
  assert.equal(monitor[0].childId, 'child-mon', 'the child id comes from this spawn call\'s successful result')
  assert.equal(monitor[0].state, 'closed')
  assert.match(monitor[0].conclusion, /nothing drifted/)
  assert.match(stored.findings.slice(-1)[0].text, /nothing drifted/, 'the conclusion is held as a finding for the parent')
})

test('a denied edit followed by the native error post event still permits a timely first reading', async () => {
  const written = []
  const mounted = host()
  apply(mounted.ctx, { backend: memoryBackend(written) })
  const who = agent()
  await mounted.fire('agent/session-start', { agent: who })
  const denied = await dispatch(mounted.fire, { name: 'edit', agent: who, arguments: { file_path: 'A' } })
  assert.equal(denied.kind, 'deny')
  const reading = await mounted.tools.find(tool => tool.name === 'rigor_read').execute({ literal: 'retain A', needs: 'stated: A remains readable => read A' }, { agent: who })
  assert.equal(reading.recorded, true)
  assert.equal(reading.late, false)
  const round = JSON.parse(written.at(-1)).sessions.s1
  assert.equal(round.facts.edits.length, 0)
  assert.equal(round.workRevision, 0)
  assert.equal(round.facts.attempts.length, 1)
  assert.equal(round.facts.attempts[0].outcome, 'denied')
  assert.equal(round.facts.attempts[0].possibleMutation, false)
})

test('an entered edit body that fails records uncertain effects, never a successful edit', async () => {
  const written = []
  const mounted = host()
  apply(mounted.ctx, { backend: memoryBackend(written) })
  const who = agent()
  await mounted.tools.find(tool => tool.name === 'rigor_read').execute({ literal: 'retain A', needs: 'stated: A remains readable => read A' }, { agent: who })
  const gate = await dispatch(mounted.fire, { name: 'edit', agent: who, arguments: { file_path: 'A' } }, { isError: true, value: undefined, content: 'write failed after entering the body' })
  assert.equal(gate.kind, 'enter')
  const round = JSON.parse(written.at(-1)).sessions.s1
  assert.equal(round.facts.edits.length, 0)
  assert.equal(round.facts.attempts[0].outcome, 'failed')
  assert.equal(round.facts.attempts[0].possibleMutation, true)
  assert.equal(round.workRevision, 1)
  assert.equal(round.reading.late, false)
})

test('partial and blocked continuation retain the same round and outstanding reviewer fixes', async () => {
  for (const status of ['partial', 'blocked']) {
    const written = []
    const demanded = { ...APPROVE, verdict: 'rework', needs: [{ ...APPROVE.needs[0], status: 'not-met' }], rework: ['restore the missing rotation'] }
    const mounted = host({ ...SERVICES,
      subagents: { listChildren: async () => [{ id: 'child-fix', activity: 'done' }] },
      sessionQuery: { readSession: async () => ({ session: { agentPreset: 'rigor-4', origin: 'subagent', parentSession: 's1' }, events: childEvents(demanded) }) },
    })
    apply(mounted.ctx, { backend: memoryBackend(written) })
    const who = agent()
    const call = (name, args) => mounted.tools.find(tool => tool.name === name).execute(args, { agent: who })
    await call('rigor_read', { literal: 'retain A', needs: 'stated: A remains readable => read A' })
    await call('rigor_plan', { approach: 'retain A', steps: 'keep A => serves N1 => read A' })
    const brief = await call('rigor_brief', { role: 'review', question: 'Check whether the rotation is readable and demand a fix for anything missing.', serves: 'N1' })
    await dispatch(mounted.fire, { name: 'subagent_review', agent: who, arguments: { prompt: brief.brief } }, { isError: false, value: { subagentId: 'child-fix' }, content: '' })
    assert.equal((await call('rigor_review', { child: 'child-fix' })).recorded, true)
    assert.equal((await call('rigor_report', { status, gaps: 'rotation still missing', per_need: 'N1 not-met' })).recorded, true)
    const before = JSON.parse(written.at(-1)).sessions.s1
    await mounted.fire('agent/inbox/claimed', { agent: who, message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } })
    const after = JSON.parse(written.at(-1)).sessions.s1
    assert.equal(after.roundId, before.roundId, status)
    assert.deepEqual(after.reading, before.reading)
    assert.deepEqual(after.plan, before.plan)
    assert.deepEqual(after.rework, before.rework)
    assert.equal(after.rework[0].status, 'open')
    assert.deepEqual(after.reviews, before.reviews)
    assert.deepEqual(after.briefs, before.briefs)
    assert.equal(after.reports.at(-1).status, status)
    assert.equal(after.history.length, 0)
  }
})

test('a root quoting a child brief does not acquire child role restrictions', async () => {
  const written = []
  const mounted = host(SERVICES)
  apply(mounted.ctx, { backend: memoryBackend(written) })
  const who = agent('root', { origin: 'cli' })
  await mounted.fire('agent/inbox/claimed', { agent: who, message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Please explain this template:\n# Brief: review\nStart this child with the subagent_review tool.' }] } })
  await mounted.tools.find(tool => tool.name === 'rigor_read').execute({ literal: 'explain template', needs: 'stated: template understood => explain the role' }, { agent: who })
  const allowed = await mounted.fire('tools/pre-execute', { name: 'edit', callId: 'root-edit', agent: who, arguments: { file_path: 'notes.md' } }, async () => ({ kind: 'enter' }))
  assert.equal(allowed.kind, 'enter')
  assert.equal(JSON.parse(written.at(-1)).sessions.root.briefedAs, '')
})

test('a storage failure returns recorded false instead of a false successful tool record', async () => {
  const written = []
  let fail = false
  const backend = { read: () => written.at(-1), write: text => { if (fail) throw new Error('simulated storage failure'); written.push(text) } }
  const mounted = host()
  apply(mounted.ctx, { backend })
  const who = agent()
  await mounted.fire('agent/session-start', { agent: who })
  const before = written.at(-1)
  fail = true
  const result = await mounted.tools.find(tool => tool.name === 'rigor_read').execute({ literal: 'retain A', needs: 'stated: A remains readable => read A' }, { agent: who })
  assert.equal(result.recorded, false)
  assert.equal(result.code, 'IO_ERROR')
  assert.match(result.refused, /storage failure/)
  assert.equal(written.at(-1), before)
})

test('separate plugin instances preserve unrelated sessions on a shared backend', async () => {
  const written = []
  const backend = memoryBackend(written)
  const first = host(), second = host()
  apply(first.ctx, { backend }); apply(second.ctx, { backend })
  const a = agent('A'), b = agent('B')
  await first.fire('agent/session-start', { agent: a })
  await second.fire('agent/session-start', { agent: b })
  assert.equal((await first.tools.find(tool => tool.name === 'rigor_read').execute({ literal: 'retain A', needs: 'stated: A remains readable => read A' }, { agent: a })).recorded, true)
  assert.equal((await second.tools.find(tool => tool.name === 'rigor_read').execute({ literal: 'retain B', needs: 'stated: B remains readable => read B' }, { agent: b })).recorded, true)
  const sessions = JSON.parse(written.at(-1)).sessions
  assert.deepEqual(Object.keys(sessions).sort(), ['A', 'B'])
  assert.equal(sessions.A.reading.literal, 'retain A')
  assert.equal(sessions.B.reading.literal, 'retain B')
})

test('an in-flight spawn reserves its brief and failure releases it for retry', async () => {
  const mounted = host(SERVICES)
  const written = []
  apply(mounted.ctx, { backend: memoryBackend(written) })
  const who = agent()
  const brief = await mounted.tools.find(tool => tool.name === 'rigor_brief').execute({ role: 'clarify', question: 'Find the implicit retention requirements and explain what would prove them wrong.', serves: 'N1' }, { agent: who })
  const first = { name: 'subagent_explore', agent: who, callId: 'spawn-first', arguments: { prompt: brief.brief } }
  const second = { ...first, callId: 'spawn-second' }
  assert.equal((await mounted.fire('tools/pre-execute', first)).kind, 'enter')
  const rejected = await mounted.fire('tools/pre-execute', second)
  assert.equal(rejected.kind, 'deny')
  assert.match(rejected.reason, /in progress/)
  await mounted.fire('tools/post-execute', second, undefined, { isError: true, value: undefined, content: rejected.reason })
  await mounted.fire('tools/execute', first)
  await mounted.fire('tools/post-execute', first, undefined, { isError: true, value: undefined, content: 'spawn failed' })
  const retried = await dispatch(mounted.fire, { ...first, callId: undefined }, { isError: false, value: { subagentId: 'child-retry' }, content: '' })
  assert.equal(retried.kind, 'enter')
  const saved = JSON.parse(written.at(-1)).sessions.s1.briefs[0]
  assert.equal(saved.childId, 'child-retry')
})

test('foreground runId binds only when that exact child belongs to this parent', async () => {
  for (const direct of [true, false]) {
    const written = []
    const mounted = host({ ...SERVICES, subagents: { listChildren: async () => [{ id: direct ? 'child-foreground' : 'unrelated', activity: 'done' }] } })
    apply(mounted.ctx, { backend: memoryBackend(written) })
    const who = agent()
    const brief = await mounted.tools.find(tool => tool.name === 'rigor_brief').execute({ role: 'clarify', question: 'Find the implicit retention requirements and explain what would prove them wrong.', serves: 'N1' }, { agent: who })
    const result = await dispatch(mounted.fire, { name: 'subagent_explore', agent: who, arguments: { prompt: brief.brief } }, { isError: false, value: { kind: 'foreground', runId: 'child-foreground' }, content: '' })
    assert.equal(result.kind, 'enter')
    const saved = JSON.parse(written.at(-1)).sessions.s1.briefs[0]
    assert.equal(saved.childId, direct ? 'child-foreground' : '')
    await mounted.fire('agent/turn-stopping', { agent: who, turn: 1 })
    if (!direct) assert.equal(JSON.parse(written.at(-1)).sessions.s1.briefs[0].childId, '', 'registry order cannot assign an unrelated child')
  }
})

test('the final result observer releases a spawn reservation when post-execute was skipped', async () => {
  const written = []
  const mounted = host(SERVICES)
  apply(mounted.ctx, { backend: memoryBackend(written) })
  const who = agent()
  const brief = await mounted.tools.find(tool => tool.name === 'rigor_brief').execute({ role: 'clarify', question: 'Find the implicit retention requirements and explain what would prove them wrong.', serves: 'N1' }, { agent: who })
  const first = { name: 'subagent_explore', agent: who, callId: 'throwing-spawn', arguments: { prompt: brief.brief } }
  assert.equal((await mounted.fire('tools/pre-execute', first)).kind, 'enter')
  await mounted.fire('tools/execute', first)
  await mounted.fire('tools/result', first, undefined, { isError: true, value: undefined, content: 'pipeline threw before post-execute' })
  const retry = await dispatch(mounted.fire, { name: first.name, agent: who, arguments: first.arguments }, { isError: false, value: { subagentId: 'child-retry' }, content: '' })
  assert.equal(retry.kind, 'enter')
  const saved = JSON.parse(written.at(-1)).sessions.s1
  assert.equal(saved.briefs[0].childId, 'child-retry')
  assert.equal(saved.facts.attempts.length, 1)
})

test('ABORTED_BEFORE_DISPATCH never implies partial file effects even after the execute observer ran', async () => {
  for (const skipPost of [false, true]) {
    const written = []
    const mounted = host()
    apply(mounted.ctx, { backend: memoryBackend(written) })
    const who = agent()
    await mounted.tools.find(tool => tool.name === 'rigor_read').execute({ literal: 'retain A', needs: 'stated: A remains readable => read A' }, { agent: who })
    const exec = { name: 'edit', agent: who, callId: `aborted-${skipPost}`, arguments: { file_path: 'A' } }
    const aborted = { isError: true, error: { info: { code: 'ABORTED_BEFORE_DISPATCH' } }, content: 'aborted before body' }
    assert.equal((await mounted.fire('tools/pre-execute', exec)).kind, 'enter')
    await mounted.fire('tools/execute', exec)
    if (!skipPost) await mounted.fire('tools/post-execute', exec, undefined, aborted)
    await mounted.fire('tools/result', exec, undefined, aborted)
    const saved = JSON.parse(written.at(-1)).sessions.s1
    assert.equal(saved.facts.attempts.length, 1)
    assert.equal(saved.facts.attempts[0].outcome, 'denied')
    assert.equal(saved.facts.attempts[0].possibleMutation, false)
    assert.equal(saved.facts.edits.length, 0)
    assert.equal(saved.workRevision, 0)
  }
})

test('failed dispatched commands remain evidence with their exit code and advance work only once', async () => {
  const written = []
  const mounted = host()
  apply(mounted.ctx, { backend: memoryBackend(written) })
  const who = agent()
  const gate = await dispatch(mounted.fire, { name: 'pwsh', agent: who, arguments: { command: 'Set-Content -LiteralPath A -Value changed; exit 1' } }, { isError: false, value: { exitCode: 1 }, content: 'expected failing reproduction' })
  assert.equal(gate.kind, 'enter')
  const call = (name, args) => mounted.tools.find(tool => tool.name === name).execute(args, { agent: who })
  const reading = await call('rigor_read', { literal: 'investigate A', needs: 'stated: failure reproduced => command exits 1' })
  assert.equal(reading.late, false, 'uncertain failed effects are not a confirmed early edit')
  const saved = JSON.parse(written.at(-1)).sessions.s1
  assert.equal(saved.facts.commands.length, 1)
  assert.equal(saved.facts.commands[0].exit, 1)
  assert.equal(saved.facts.attempts[0].possibleMutation, true)
  assert.equal(saved.workRevision, 1)
  assert.equal(saved.facts.commands[0].snapshot.workRevision, 1)
  const evidence = await call('rigor_evidence', { needs: 'N1', ref: 'cmd:Set-Content', note: 'the failing exit is the expected reproduction' })
  assert.equal(evidence.recorded, true, JSON.stringify(evidence))
})
