// The model-facing tools: six, and each answers "what does it replace".
//
//   rigor_read      the reading: the literal request plus the needs nobody typed, each
//                   with the test that would show it is met or that the reading is wrong.
//                   No pipeline can observe this; it is the one thing only the model can say.
//   rigor_plan      what will be done, step by step, each step naming the needs it
//                   serves and the evidence it will produce.
//   rigor_brief     the question a child is opened to answer, rendered as the complete
//                   brief that child will read. A spawn without a brief is an opinion
//                   nobody asked for; the gate matches on this.
//   rigor_evidence  a fact this session actually recorded, tied to the need it speaks
//                   for. The plugin verifies the fact exists; whether it shows the need
//                   is met is the reviewer's judgement, never the author's.
//   rigor_review    link a finished child's verdict. The payload is read out of the
//                   CHILD's own session log — never from a field the reviewed session
//                   fills in — which is what makes the review independent in fact
//                   rather than in name.
//   rigor_report    the account: done / partial / blocked. `done` is gated; the other
//                   two are always recordable, because an honest gap is a complete answer.
//
// Deliberately absent: a tool to read the state. The gate says everything a claim needs
// at the moment it needs it; a state-printer is the cheapest way for a session to look
// busy, and the three earlier builds both grew one and both learned this the same way.

import {
  briefIsCurrent,
  evaluateDone,
  linkEvidence,
  normalizeTarget,
  openBrief,
  openRework,
  recordPlan,
  recordReading,
  recordReport,
  recordReview,
  sameSnapshot,
  snapshotOf,
  summarize,
} from './model.js'
import { renderBrief } from './briefs.js'
import { extractReviewPayload, validateReviewPayload } from './payload.js'
import { toolForRole } from './classify.js'
import { lastAssistantText, sessionTail } from './children.js'
import { parseStrategy } from './strategy.js'
import { STRATEGY_HELP } from './strategy-help.js'
import { checkTemplate, validateCheckReport, verifyArtifacts } from './validation.js'

const JSON_OUTPUT = {
  schema: { type: 'object', additionalProperties: true, properties: {} },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

/**
 * The words the four always-registered tools use, chosen by what this preset can do.
 *
 * A preset with no child channel does not register rigor_brief or rigor_review — the
 * index filters them out — so it must not keep talking about children either: every
 * mention of a reviewer or a brief is attention spent on a door that is not there. The
 * solo wording also tells the truth about the gate, which for this preset drops the
 * child requirements and demands a declared limitation instead.
 */
function toolText(deps) {
  const solo = deps !== null && deps !== undefined && deps.capabilities !== undefined && deps.capabilities.children === false
  return {
    solo,
    reportDescription: solo
      ? 'Record done/partial/blocked. Done requires current needs, plan, evidence, declared acceptance checks and capability limitations. This preset has no independent-review channel. Partial/blocked must name remaining gaps.'
      : 'Record done/partial/blocked. Done requires current needs, plan, evidence, passing declared checks, risk-appropriate independent review and closed rework. Partial/blocked must name gaps. Task size alone never requires another user confirmation.',
    evidenceDescription: solo
      ? 'Link an observed command/read/file to needs. Every need requires current evidence; a passing command alone does not prove acceptance. For a declared check, link its JSON report and actual run.'
      : 'Link an observed command/read/file to needs. Every need requires current evidence; the independent reviewer judges relevance. For a declared check, link its JSON report and actual run.',
    readNext: solo
      ? 'Plan against these needs (rigor_plan), then link what you actually find to them (rigor_evidence) and report honestly (rigor_report).'
      : 'Plan against these needs (rigor_plan), then give the work voices (rigor_brief).',
    planNext: solo
      ? 'Work the plan, link each fact to the need it speaks for (rigor_evidence), then report — partial is a complete answer while the work is unfinished.'
      : 'Brief the work: rigor_brief(role="clarify"|"diverge"|"plan-review"|"monitor"|"review"), hand the returned brief to a NEW subagent.',
    evidenceNoteHint: solo
      ? 'What this fact shows, in one sentence. Write what was observed, not what you hope it means.'
      : 'What this fact shows, in one sentence. The reviewer reads it; keep it to what was observed, not what you hope it means.',
    evidenceNote: solo
      ? 'The fact is on record. "Tests pass" is evidence about a test, not proof that the need is met — say in your report what it does not cover.'
      : 'The reviewer decides whether this fact shows the need is met. "Tests pass" is evidence about a test; say what it does not cover in its script_only answer.',
    reportDoneNote: solo
      ? 'The claim is on record with its reading, its evidence and its declared limitation. Say the same thing to the person — the unstated needs and how each was met — rather than only "done".'
      : 'The claim is on record with its reading, its reviews and its evidence. Say the same thing to the person — the unstated needs and how each was met — rather than only "done".',
  }
}

/** Split the " | " separated fields, honouring a backslash-escaped pipe. */
export function splitPipe(value) {
  if (typeof value !== 'string') return []
  const marked = value.split('\\|').join('\u0001')
  return marked
    .split('|')
    .map(part => part.split('\u0001').join('|').trim())
    .filter(part => part !== '')
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Parse the needs field: `kind: text => test`, one per item.
 *
 * The test is required and is the whole difference between a reading and a hunch: it
 * says what the session would SEE if the need is met, or if the reading is wrong.
 * A need without one is refused at the door with the reason, so the model can fix it
 * in the same call instead of discovering at the end that nobody can check it.
 */
export function parseNeeds(value) {
  const items = []
  const refused = []
  for (const chunk of splitPipe(value)) {
    const arrow = chunk.indexOf('=>')
    if (arrow < 0) {
      refused.push({ item: chunk.slice(0, 70), why: 'no "=> test". Say what you would SEE if this need is met, or if the reading is wrong.' })
      continue
    }
    const head = chunk.slice(0, arrow).trim()
    const test = chunk.slice(arrow + 2).trim()
    const separator = head.indexOf(':')
    if (separator <= 0) {
      refused.push({ item: head.slice(0, 70), why: 'start with the kind: "stated:" for what they actually said, "implicit:" for what they left unsaid but expect.' })
      continue
    }
    const kind = head.slice(0, separator).trim().toLowerCase()
    const need = head.slice(separator + 1).trim()
    if (kind !== 'stated' && kind !== 'implicit') {
      refused.push({ item: head.slice(0, 70), why: `"${kind}" is not a kind — use "stated" or "implicit".` })
      continue
    }
    if (need === '') {
      refused.push({ item: chunk.slice(0, 70), why: 'the need text is empty — what has to be true?' })
      continue
    }
    if (test.length < 6) {
      refused.push({ item: need.slice(0, 70), why: 'the test is too short to check anything. Say what you would see — a line of output, a value in a file, an artifact.' })
      continue
    }
    items.push({ kind, text: need, test })
  }
  return { items, refused }
}

/** Parse the steps field: `text => serves N1,N2 => evidence`. */
export function parseSteps(value) {
  const items = []
  const refused = []
  for (const chunk of splitPipe(value)) {
    const first = chunk.indexOf('=>')
    const second = first < 0 ? -1 : chunk.indexOf('=>', first + 2)
    if (first < 0 || second < 0) {
      refused.push({ item: chunk.slice(0, 70), why: 'a step is "text => serves N1,N2 => evidence": what it does, which needs it serves, and what will show it worked.' })
      continue
    }
    const step = chunk.slice(0, first).trim()
    const serves = chunk.slice(first + 2, second).replace(/^\s*serves\s*:?\s*/i, '').split(/[,\s]+/).map(part => part.trim()).filter(part => part !== '')
    const evidence = chunk.slice(second + 2).trim()
    if (step === '') { refused.push({ item: chunk.slice(0, 70), why: 'the step text is empty.' }); continue }
    if (serves.length === 0) { refused.push({ item: step.slice(0, 70), why: 'no need is named after the first "=>" — a step serving nothing is work nobody asked for.' }); continue }
    if (evidence.length < 6) { refused.push({ item: step.slice(0, 70), why: 'the evidence is missing or too short to mean anything.' }); continue }
    items.push({ text: step, serves, evidence })
  }
  return { items, refused }
}

/** Parse the per-need field of a report: `N1 met | N2 not-checked`. */
export function parsePerNeed(value) {
  const items = []
  const refused = []
  for (const chunk of splitPipe(value)) {
    const parts = chunk.trim().split(/\s+/)
    if (parts.length < 2) { refused.push({ item: chunk.slice(0, 60), why: 'write "N1 met", "N2 not-met" or "N3 not-checked".' }); continue }
    const id = parts[0].toUpperCase()
    const status = parts[1].toLowerCase()
    if (!['met', 'not-met', 'not-checked'].includes(status)) { refused.push({ item: chunk.slice(0, 60), why: `"${status}" is not a status — use met, not-met or not-checked.` }); continue }
    items.push({ id, status })
  }
  return { items, refused }
}

export function createReadTool(deps) {
  const T = toolText(deps)
  return {
    name: 'rigor_read',
    description: 'Record the request and observable acceptance needs before editing. Distinguish stated requirements from justified implicit expectations; keep scope and existing authorization. Calling again versions the reading and invalidates its old plan/reviews.',
    parameters: {
      literal: { type: 'string', required: true, description: 'What was asked for, in one sentence, in their words.' },
      needs: { type: 'string', required: true, description: 'Needs as "stated: ... => ... | implicit: ... => ...". At least one; a real request usually carries at least one implicit one.' },
      unknowns: { type: 'string', description: 'What you do not know and the person owns, separated by " | ". These become the questions worth asking.' },
    },
    output: JSON_OUTPUT,
    execute(args, exec) {
      const literal = text(args.literal)
      if (literal === '') return { recorded: false, refused: '`literal` is required: what did they ask for, in their own words?' }
      const parsed = parseNeeds(args.needs)
      if (parsed.items.length === 0) {
        return { recorded: false, refused: `no usable need was recorded. ${parsed.refused.map(item => `"${item.item}": ${item.why}`).join(' ')}` }
      }
      const round = deps.sessionFor(exec.agent)
      // Work already visible means this reading is a description of what happened, not a
      // reading of what was asked. It is recorded (with `late`) rather than refused,
      // because the honest version of a late reading is still worth more than none —
      // but a `done` claim will have to carry it as a limitation.
      const late = round.reading === null && ((round.facts?.edits ?? []).length > 0 || (round.facts?.commands ?? []).some(item => item.mutationHint === true && item.exit === 0))
      const outcome = recordReading(round, {
        literal,
        needs: parsed.items,
        unknowns: splitPipe(args.unknowns),
        at: deps.now(),
        late,
      })
      deps.save(exec.agent, outcome.round)
      return {
        recorded: true,
        reading_version: outcome.reading.version,
        needs: outcome.reading.needs.map(item => `${item.id} [${item.kind}] ${item.text}`),
        unknowns: outcome.reading.unknowns.map(item => `${item.id} ${item.text}`),
        late,
        late_note: late
          ? 'work had already started when this reading was recorded, so it cannot be treated as having guided the work. A done claim will have to carry that limitation.'
          : '',
        capabilities: deps.capabilities,
        next: T.readNext,
        refused: parsed.refused,
      }
    },
  }
}

export function createPlanTool(deps) {
  const T = toolText(deps)
  return {
    name: 'rigor_plan',
    description: 'Plan steps against needs and evidence. Use optional strategy for consequential or uncertain work: risk, alternatives, technology, dependencies and acceptance checks. strategy="help" returns details without changing state. Replanning invalidates old reviews.',
    parameters: {
      approach: { type: 'string', description: 'Required except for help: how the approach meets the needs.' },
      steps: { type: 'string', description: 'Required except for help: "text => serves N1,N2 => evidence", separated by " | ". IDs are S1, S2, etc.' },
      risks: { type: 'string', description: 'What could make this approach wrong or incomplete, separated by " | ".' },
      strategy: { type: 'string', maxLength: 40000, description: 'Optional JSON; "help" gives its schema and examples. Omission preserves an existing strategy when replanning.' },
    },
    output: JSON_OUTPUT,
    execute(args, exec) {
      if (text(args.strategy) === 'help') return { recorded: false, help: STRATEGY_HELP }
      const round = deps.sessionFor(exec.agent)
      if (round.reading === null) return { recorded: false, refused: 'record the reading first (rigor_read): a plan that does not know the needs cannot show it serves them.' }
      const parsed = parseSteps(args.steps)
      if (parsed.items.length === 0) {
        return { recorded: false, refused: `no usable step was recorded. ${parsed.refused.map(item => `"${item.item}": ${item.why}`).join(' ')}` }
      }
      const needIds = new Set(round.reading.needs.map(item => item.id))
      const unknown = [...new Set(parsed.items.flatMap(item => item.serves).filter(id => !needIds.has(id)))]
      if (unknown.length > 0) {
        return { recorded: false, refused: `these needs are not on the current reading (v${round.reading.version}): ${unknown.join(', ')}. Available: ${[...needIds].join(', ')}. Revise the reading first if a need is missing.` }
      }
      const approach = text(args.approach)
      if (approach === '') return { recorded: false, refused: '`approach` is required: one sentence on how the needs will be met.' }
      const strategy = parseStrategy(text(args.strategy) === '' ? round.plan?.strategy : args.strategy, {
        needIds: [...needIds], stepIds: parsed.items.map((_item, index) => `S${index + 1}`),
      })
      if (strategy.errors.length > 0) return { recorded: false, refused: 'Invalid strategy; nothing changed.', errors: strategy.errors }
      const outcome = recordPlan(round, {
        approach,
        steps: parsed.items,
        risks: splitPipe(args.risks),
        strategy: strategy.value,
        at: deps.now(),
      })
      deps.save(exec.agent, outcome.round)
      const served = new Set(outcome.plan.steps.flatMap(step => step.serves))
      const unserved = round.reading.needs.filter(need => !served.has(need.id)).map(need => need.id)
      return {
        recorded: true,
        plan_steps: outcome.plan.steps.map(step => `${step.id} ${step.text} [serves ${step.serves.join(',')}]`),
        reading_version: outcome.plan.readingVersion,
        unserved_needs: unserved,
        unserved_note: unserved.length === 0 ? '' : `these needs are served by no step: ${unserved.join(', ')} — a done claim will be refused until they are, or until the reading says they are out of scope.`,
        refused: parsed.refused,
        ...(strategy.value === null ? {} : {
          risk: strategy.value.risk,
          checks: strategy.value.checks.map(item => ({ id: item.id, need: item.need, criterion: item.criterion, ...(item.metric ? { metric: item.metric } : {}) })),
          validation_report: strategy.value.checks.length ? checkTemplate(strategy.value.checks[0]) : undefined,
        }),
        next: T.planNext,
      }
    },
  }
}

export function createBriefTool(deps) {
  return {
    name: 'rigor_brief',
    description: 'Generate a focused child brief. clarify/diverge examine intent; explore compares solutions; technical investigates versioned capabilities; plan-review checks feasibility; monitor watches execution; review/rework-check judge delivery. Dispatch using the returned tool; detailed instructions are loaded only for that role.',
    parameters: {
      role: { type: 'string', required: true, enum: ['clarify', 'diverge', 'explore', 'technical', 'plan-review', 'monitor', 'review', 'rework-check'], description: 'Choose the role needed for this question. Risk selects required reviews; exploration is optional.' },
      question: { type: 'string', required: true, description: 'The one question this child must answer, in at least 40 characters. It is what the spawn gate matches against, and what a duplicate is detected by.' },
      serves: { type: 'string', description: 'Which need (N1) or plan step (S1) this child serves, comma separated. A brief that serves nothing is a spawn nobody can hold to anything.' },
    },
    output: JSON_OUTPUT,
    execute(args, exec) {
      if (deps.capabilities.children === false) {
        return { opened: false, refused: 'this preset has no subagent channel, so no child can be briefed. Continue without children — the reading, the plan, the evidence and an honest report are still required, and a done claim must carry the limitation that no independent review was possible.' }
      }
      const round = deps.sessionFor(exec.agent)
      const outcome = openBrief(round, {
        role: args.role,
        question: args.question,
        serves: splitPipe(args.serves).flatMap(part => part.split(/[,\s]+/)).filter(part => part !== ''),
        at: deps.now(),
      })
      if (outcome.refusal !== undefined) return { opened: false, refused: outcome.refusal.detail, exit: outcome.refusal.exit }
      const openItems = openRework(round)
      const previousReview = (round.reviews ?? []).filter(item => item.role === 'review' || item.role === 'rework-check').slice(-1)[0] ?? null
      const briefText = renderBrief({
        role: outcome.brief.role,
        question: outcome.brief.question,
        serves: outcome.brief.serves,
        round,
        openItems,
        previousReview: outcome.brief.role === 'rework-check' ? previousReview : null,
      })
      deps.save(exec.agent, outcome.round)
      return {
        opened: true,
        brief_id: outcome.brief.id,
        role: outcome.brief.role,
        // Which tool carries this role's capability profile. The spawn gate refuses a
        // brief answered by a tool built for another job, so this is what to call.
        spawn_with: toolForRole(outcome.brief.role),
        brief: briefText,
        next: 'Hand this ENTIRE text to a new subagent (the subagent tool). Then, when it finishes: for review/rework-check call rigor_review(child=<id>) — its JSON verdict is read from its own session log; for the text roles its answer arrives as an advisory, or read it from the child id the spawn returned.',
      }
    },
  }
}

export function createEvidenceTool(deps) {
  const T = toolText(deps)
  return {
    name: 'rigor_evidence',
    description: T.evidenceDescription,
    parameters: {
      needs: { type: 'string', required: true, description: 'One or more need ids: "N1" or "N1,N2".' },
      ref: { type: 'string', required: true, description: '"#<seq>", "cmd:<fragment>", "read:<path>" or "artifact:<path>".' },
      note: { type: 'string', description: T.evidenceNoteHint },
      check: { type: 'string', description: 'Optional declared check ID. Requires artifact:<JSON report> and run.' },
      run: { type: 'string', description: 'For a check: #seq or cmd:fragment identifying its actual validation command, run after the plan.' },
    },
    output: JSON_OUTPUT,
    execute(args, exec) {
      const round = deps.sessionFor(exec.agent)
      if (round.reading === null) return { recorded: false, refused: 'there is no reading yet, so there is no need to link evidence to. Call rigor_read first.' }
      const ids = splitPipe(args.needs).flatMap(part => part.split(/[,\s]+/)).map(part => part.trim().toUpperCase()).filter(part => part !== '')
      const known = new Set(round.reading.needs.map(item => item.id))
      const unknown = ids.filter(id => !known.has(id))
      if (ids.length === 0) return { recorded: false, refused: '`needs` is required: which need does this fact speak for?' }
      if (unknown.length > 0) return { recorded: false, refused: `no such need: ${unknown.join(', ')}. This reading has ${[...known].join(', ')}.` }
      const checkId = text(args.check)
      const resolved = resolveRef(round, String(args.ref ?? '').trim(), deps, exec.agent, checkId === '' ? {} : { maxBytes: 262144 })
      if (resolved.refusal !== undefined) return { recorded: false, refused: resolved.refusal }
      let validation = null
      if (checkId !== '') {
        const check = (round.plan?.strategy?.checks ?? []).find(item => item.id === checkId)
        if (!check) return { recorded: false, refused: `Check ${checkId} is not declared in the current plan.` }
        if (ids.length !== 1 || ids[0] !== check.need) return { recorded: false, refused: `Check ${checkId} belongs to ${check.need}; link that need only.` }
        const run = resolveRef(round, text(args.run), deps, exec.agent)
        if (run.refusal) return { recorded: false, refused: run.refusal, template: checkTemplate(check) }
        const checked = validateCheckReport({ check, fact: resolved.fact, runFact: run.fact, round, deps, agent: exec.agent })
        if (checked.refusal) return { recorded: false, refused: checked.refusal, template: checkTemplate(check) }
        validation = checked.validation
      } else if (text(args.run) !== '') {
        return { recorded: false, refused: 'run is used with a declared check; otherwise link the command directly as ref.' }
      }
      let next = round
      for (const id of ids) next = linkEvidence(next, { need: id, fact: resolved.fact, note: text(args.note), check: checkId, validation, at: deps.now() })
      deps.save(exec.agent, next)
      return {
        recorded: true,
        linked: ids.map(id => `${id} ← ${resolved.fact.kind}:${resolved.fact.ref}`),
        note: T.evidenceNote,
        ...(validation === null ? {} : { check: checkId, validation }),
      }
    },
  }
}

/**
 * Resolve an evidence reference against the round's own facts.
 *
 * Only facts the pipeline recorded resolve. That is the difference between evidence
 * and assertion, and it is also why the error message names what IS available: a
 * refusal a caller cannot act on is a wall, not a gate.
 */
export function resolveRef(round, ref, deps, agent, options = {}) {
  if (ref === '') return { refusal: '`ref` is required: "#<seq>", "cmd:<fragment>", "read:<path>" or "artifact:<path>".' }
  const facts = round.facts ?? { edits: [], commands: [], reads: [] }
  const current = snapshotOf(round)
  const fromRecorded = (hit, kind) => {
    if (hit.snapshot?.roundId !== current.roundId || hit.snapshot?.workRevision !== current.workRevision) {
      return { refusal: `"${ref}" was recorded before the current delivery revision, or has no version identity. Run or read it again before linking it as current evidence.` }
    }
    return { fact: { kind, ref, seqOfFact: hit.seq, snapshot: hit.snapshot } }
  }
  if (ref.startsWith('#')) {
    const seq = Number(ref.slice(1))
    const streams = ['edits', 'commands', 'reads', 'questions', 'answers']
    for (const key of streams) {
      const hit = (facts[key] ?? []).find(item => item.seq === seq)
      if (hit !== undefined) return fromRecorded(hit, key === 'edits' ? 'edit' : key.replace(/s$/, ''))
    }
    const all = streams.flatMap(key => (facts[key] ?? []).map(item => item.seq)).sort((a, b) => a - b)
    const tail = all.slice(-6)
    return { refusal: `#${seq} is not a fact of this session. Recorded sequences are ${tail.join(', ')}${all.length > tail.length ? ' …' : ''}. Use cmd:/read:/artifact: to name one that has not been recorded yet.` }
  }
  const separator = ref.indexOf(':')
  const kind = separator <= 0 ? '' : ref.slice(0, separator).toLowerCase()
  const rest = separator <= 0 ? '' : ref.slice(separator + 1).trim()
  if (kind === 'cmd') {
    if (rest === '') return { refusal: 'cmd: needs a fragment of the command, e.g. cmd:node --test.' }
    const hit = [...(facts.commands ?? [])].reverse().find(item => String(item.cmd).toLowerCase().includes(rest.toLowerCase()))
    if (hit === undefined) {
      const recent = [...(facts.commands ?? [])].slice(-4).map(item => `#${item.seq} ${String(item.cmd).replace(/\s+/g, ' ').slice(0, 60)}`)
      return { refusal: `no recorded command contains "${rest}". Recent commands: ${recent.length === 0 ? '(none recorded yet)' : recent.join(' ; ')}.` }
    }
    return fromRecorded(hit, 'command')
  }
  if (kind === 'read') {
    const wanted = normalizeTarget(rest)
    if (wanted === '') return { refusal: 'read: needs a non-empty file path.' }
    const matches = [...(facts.reads ?? [])].reverse().filter(item => {
      const observed = normalizeTarget(item.ref)
      return observed === wanted || observed.endsWith(`/${wanted}`)
    })
    if (matches.length === 0) return { refusal: `"${rest}" has not been read in this session. Use read:<path> only for a file this session actually read, or artifact:<path> for one that exists now.` }
    if (new Set(matches.map(item => normalizeTarget(item.ref))).size > 1) return { refusal: `"${rest}" matches multiple recorded paths. Use the full path or the exact #seq.` }
    return fromRecorded(matches[0], 'read')
  }
  if (kind === 'artifact') {
    if (rest === '') return { refusal: 'artifact: needs a non-empty file path.' }
    let info
    try { info = deps.stat(rest, agent, options) } catch { return { refusal: `the artifact "${rest}" could not be inspected. Retry its verification before linking it.` } }
    if (info?.tooLarge === true) return { refusal: `the validation report exceeds ${options.maxBytes} bytes; keep large logs outside the report.` }
    if (info?.changedDuringRead === true) return { refusal: `the artifact "${rest}" changed during inspection. Wait for its writer to finish and verify it again.` }
    if (info == null || info.exists !== true) return { refusal: `the artifact "${rest}" does not exist. An artifact link is a fact about the tree; name a path that is actually there.` }
    if (info.isFile === false) return { refusal: `the artifact "${rest}" is not a regular file. Name the actual file to be checked.` }
    if (Number(info.size ?? 0) <= 0) return { refusal: `the artifact "${rest}" is empty. An empty file proves nothing about a need.` }
    return { fact: { kind: 'artifact', ref, path: String(info.path ?? rest), size: Number(info.size), mtimeMs: Number(info.mtimeMs ?? 0), fingerprint: String(info.fingerprint ?? ''), snapshot: current } }
  }
  return { refusal: `"${ref}" is not a form this can check. Use "#<seq>", "cmd:<fragment>", "read:<path>" or "artifact:<path>".` }
}

export function createReviewTool(deps) {
  return {
    name: 'rigor_review',
    description: 'Import the final verdict from a finished direct child\'s own log. Its claimed review/rework-check brief must match this delivery. Approval requires all needs met and explains evidence limits; rework opens tracked fixes.',
    parameters: {
      child: { type: 'string', description: 'The child session id the spawn returned. Leave empty to use the newest finished child this session has not reviewed yet.' },
      brief: { type: 'string', description: 'An existing claimed brief id bound to this child, when disambiguation is needed. It cannot override the child, role or version binding.' },
      role: { type: 'string', enum: ['review', 'rework-check'], description: 'Defaults to review; use rework-check when the child was opened to verify fixes.' },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      if (deps.capabilities.children === false) {
        return { recorded: false, refused: 'this preset has no subagent channel, so no child review can exist. Report as partial, or claim done with the limitation declared.' }
      }
      let round = deps.sessionFor(exec.agent)
      if (round.reading === null) return { recorded: false, refused: 'no reading is recorded, so a reviewer has nothing to judge against. Call rigor_read first.' }
      const role = args.role === 'rework-check' ? 'rework-check' : 'review'
      const selected = await selectReviewChild(round, args, role, exec, deps)
      if (selected.refusal !== undefined) return { recorded: false, refused: selected.refusal }
      const { child, snapshot, briefId } = selected
      // Native tools are exclusive today, but a service query is still an await
      // boundary: never replace newer state or attach a verdict to a new snapshot.
      round = deps.sessionFor(exec.agent)
      const registered = (round.briefs ?? []).find(item => item.id === briefId)
      const invalid = reviewBriefProblem(round, registered, child, role)
      if (invalid !== '') return { recorded: false, refused: invalid }
      if (exec.signal?.aborted) return { recorded: false, refused: 'the review link was cancelled; no review was recorded.' }
      const events = snapshot.events
      const childPreset = String(snapshot.preset ?? '')
      const finished = isFinished(events)
      if (!finished.ok) return { recorded: false, refused: finished.why }
      const finalText = lastAssistantText(events)
      const extracted = extractReviewPayload(finalText)
      if (!extracted.ok) {
        return {
          recorded: false,
          refused: `${extracted.why}. The brief requires the JSON block as the last fenced block of the final message.`,
          child_final_message: finalText.slice(0, 600),
          exit: 're-brief the child with the exact payload shape (rigor_brief returns it), or open a fresh review brief and hand it to a new child.',
        }
      }
      const validation = validateReviewPayload(extracted.payload, {
        needIds: round.reading.needs.map(item => item.id),
        openItems: openRework(round).map(item => item.id),
        role,
      })
      if (!validation.ok) {
        return {
          recorded: false,
          refused: `the child's verdict block is not usable: ${validation.problems.join('; ')}.`,
          child_final_message: finalText.slice(0, 600),
          exit: 'hand the child the brief again with the payload shape it asks for, or open a new review brief — an unreadable review is the absence of one.',
        }
      }
      const outcome = recordReview(round, {
        briefId,
        childId: child,
        payload: validation.normalized,
        at: deps.now(),
        // Read from the CHILD's own session header, never supplied by this session.
        childPreset,
        childTool: String(registered.tool ?? ''),
      })
      if (outcome.refusal !== undefined) return { recorded: false, refused: outcome.refusal.detail ?? String(outcome.refusal) }
      deps.save(exec.agent, outcome.round)
      return {
        recorded: true,
        review: outcome.review.id,
        verdict: outcome.review.verdict,
        reading_ok: outcome.review.readingOk,
        child_preset: outcome.review.childPreset,
        child_tool: outcome.review.childTool,
        needs: outcome.review.needs.map(item => `${item.id} ${item.status} (${item.how}) ${item.evidence.slice(0, 120)}`),
        script_only: outcome.review.scriptOnly,
        deviations: outcome.review.deviations,
        questions: outcome.review.questions,
        opened_rework: outcome.opened,
        closed_rework: outcome.closed,
        next: outcome.review.verdict === 'approve'
          ? 'The review approved. If every need also has evidence and the report names them all met, rigor_report(status="done") can be recorded.'
          : 'The review demands rework. Do it, then open a rework-check brief and link its verdict the same way.',
      }
    },
  }
}

function reviewBriefProblem(round, brief, child, role) {
  if (brief === undefined) return 'no existing brief matches this review. Open and dispatch a review brief before linking a child.'
  if (brief.state !== 'claimed') return `brief ${brief.id} is not awaiting a claimed child's review; it cannot be linked again.`
  if (brief.childId === '' || String(brief.childId) !== child) return `brief ${brief.id} is not bound to child ${child}. Wait for a successful spawn to bind its actual child id.`
  if (brief.role !== role) return `brief ${brief.id} has role ${brief.role}, not ${role}. Link it with its actual role.`
  if (!briefIsCurrent(round, brief)) return `brief ${brief.id} is stale: the reading, plan, delivery or acceptance evidence changed. Open a fresh review brief for the current version.`
  if ((round.reviews ?? []).some(item => String(item.childId) === child && sameSnapshot(item.snapshot, brief.snapshot))) return `child ${child} already has a review for this version. Independent reviews require a different child.`
  return ''
}

async function selectReviewChild(round, args, role, exec, deps) {
  let listed
  try { listed = await deps.listChildren(exec.agent) } catch { listed = null }
  if (!Array.isArray(listed)) return { refusal: 'the child registry could not be read, so parent-child identity cannot be verified. Retry the link when the registry is available.' }
  if (listed.length === 0) return { refusal: 'this session has no registered direct children. Dispatch a review brief before linking a review.' }
  if (exec.signal?.aborted) return { refusal: 'the review link was cancelled; no review was recorded.' }
  round = deps.sessionFor(exec.agent)
  const wanted = String(args.child ?? '').trim()
  const wantedBrief = String(args.brief ?? '').trim()
  const direct = new Map(listed.filter(item => item !== null && typeof item === 'object').map(item => [String(item.id), item]))
  if (wanted !== '' && (!direct.has(wanted) || wanted === String(exec.agent.id))) return { refusal: `child ${wanted} is not a registered direct child of this session.` }
  const explicit = wanted !== '' || wantedBrief !== ''
  let candidates = [...(round.briefs ?? [])].reverse()
  if (wantedBrief !== '') candidates = candidates.filter(item => item.id === wantedBrief)
  if (wanted !== '') candidates = candidates.filter(item => String(item.childId) === wanted)
  if (explicit && candidates.length === 0) return { refusal: 'no existing brief matches the requested child and brief id. An arbitrary brief id cannot establish a delegation.' }
  const childOrder = new Map([...direct.keys()].map((id, index) => [id, index]))
  candidates.sort((a, b) => (childOrder.get(String(b.childId)) ?? -1) - (childOrder.get(String(a.childId)) ?? -1))
  let lastProblem = ''
  for (const brief of candidates) {
    const child = String(brief.childId ?? '')
    const invalid = reviewBriefProblem(round, brief, child, role)
    if (invalid !== '') { lastProblem = invalid; continue }
    if (!direct.has(child) || child === String(exec.agent.id)) { lastProblem = `child ${child} is not a registered direct child of this session.`; continue }
    if (direct.get(child).status === 'running') { lastProblem = `child ${child} is still running. Wait for its final verdict.`; continue }
    let snapshot
    try { snapshot = await deps.readSession(child) } catch { snapshot = null }
    if (snapshot === null || snapshot === undefined) { lastProblem = `could not read child ${child}'s own session log. Retry when its log is available.`; continue }
    const finished = isFinished(snapshot.events)
    if (!finished.ok) { lastProblem = finished.why; continue }
    return { child, briefId: brief.id, snapshot }
  }
  return { refusal: explicit && lastProblem !== '' ? lastProblem : 'no finished, unreviewed child with a current matching role brief is available. Open and dispatch a fresh review brief, or wait for its child to finish.' }
}

function isFinished(events) {
  const { empty, type, finished } = sessionTail(events)
  if (empty) return { ok: false, why: 'the child session log is empty, so there is no verdict to read yet.' }
  if (!finished) {
    return { ok: false, why: `the child is still running (last event: ${type === '' ? 'unknown' : type}). Wait for it to finish, then link its review.` }
  }
  return { ok: true }
}


export function createReportTool(deps) {
  const T = toolText(deps)
  return {
    name: 'rigor_report',
    description: T.reportDescription,
    parameters: {
      status: { type: 'string', required: true, enum: ['done', 'partial', 'blocked'], description: 'done = the needs are met (gated); partial = some are not, name them; blocked = cannot proceed, name why.' },
      per_need: { type: 'string', description: '"N1 met | N2 not-checked" — one entry per need of the reading. Required for done; expected for partial/blocked too.' },
      gaps: { type: 'string', description: 'What is not done, separated by " | ". Required for partial and blocked: a partial with nothing named reads as "the rest is fine".' },
      limitations: { type: 'string', description: 'What this preset could not do (e.g. no independent review was possible), separated by " | ". Required when the preset lacks a channel the discipline normally uses.' },
      reading_confirmed: { type: 'string', enum: ['yes', 'no'], description: 'Whether the person confirmed this reading after it was recorded. "yes" is checked against the recorded question and answer.' },
    },
    output: JSON_OUTPUT,
    execute(args, exec) {
      const round = deps.sessionFor(exec.agent)
      const status = args.status === 'partial' ? 'partial' : args.status === 'blocked' ? 'blocked' : 'done'
      const parsed = parsePerNeed(args.per_need)
      const gaps = splitPipe(args.gaps)
      const limitations = splitPipe(args.limitations)
      const readingConfirmed = args.reading_confirmed === 'yes' ? 'yes' : 'no'
      if (parsed.refused.length > 0 && status === 'done') {
        return { recorded: false, refused: `\`per_need\` is not usable: ${parsed.refused.map(item => `"${item.item}": ${item.why}`).join(' ')}` }
      }
      if (status !== 'done' && gaps.length === 0) {
        return { recorded: false, refused: `a ${status} report must name what is missing (gaps="..."): "${status}" with nothing named reads as "the rest is fine", which is the sentence this mode exists to refuse.` }
      }
      if (status === 'done') {
        const verdict = evaluateDone(round, {
          perNeed: parsed.items,
          readingConfirmed,
          limitations,
          capabilities: deps.capabilities,
        })
        if (!verdict.ok) {
          return {
            recorded: false,
            refused: 'this claim is not ready to be recorded as done. Nothing was written; fix these and call again, or report partial naming them — partial is always available.',
            items: verdict.refusals.map(item => ({ code: item.code, detail: item.detail, exit: item.exit })),
            scale: verdict.roles.scale,
            owes: verdict.roles,
          }
        }
        // A file can change outside the observed tool stream. Check the actual
        // artifact just before accepting a completion claim, not only at linking.
        const artifacts = verifyArtifacts((round.evidence ?? []).filter(item => sameSnapshot(item.snapshot, snapshotOf(round))), deps, exec.agent)
        if (!artifacts.ok) {
          return {
            recorded: false,
            refused: `artifact "${artifacts.path}" changed, disappeared or could not be verified since its evidence was linked. Inspect and relink it, then obtain a review of the current delivery.`,
            code: 'stale-artifact',
          }
        }
      }
      const outcome = recordReport(round, {
        status,
        perNeed: parsed.items,
        gaps,
        limitations,
        readingConfirmed,
        at: deps.now(),
      })
      deps.save(exec.agent, outcome.round)
      return {
        recorded: true,
        status: outcome.report.status,
        per_need: outcome.report.perNeed.map(item => `${item.id} ${item.status}`),
        gaps: outcome.report.gaps,
        limitations: outcome.report.limitations,
        reading_confirmed: outcome.report.readingConfirmed,
        summary: summarize(outcome.round, deps.capabilities),
        note: status === 'done'
          ? T.reportDoneNote
          : 'The gap is on record. Say the same thing to the person; do not let the prose promise more than the report does.',
      }
    },
  }
}

export function createTools(deps) {
  return [
    createReadTool(deps),
    createPlanTool(deps),
    createBriefTool(deps),
    createEvidenceTool(deps),
    createReviewTool(deps),
    createReportTool(deps),
  ]
}
