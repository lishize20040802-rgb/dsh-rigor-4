// Cordis wiring. This module assembles; it decides nothing.
//
// The judgement lives in model.js (pure), the reviewer's payload in payload.js, the
// briefs in briefs.js. What is left here is the imperative shell: read the host's
// services, register the six tools and one prompt section, subscribe to the pipeline,
// and keep every decision on the record.
//
// Four rules that are structural rather than stylistic, each learned from a failure
// in the three generations before this one:
//
//   1. The facts come from tools/post-execute, never from the model's account. A claim
//      about what ran is only ever as good as the pipeline that saw it run.
//   2. The gate holds at most `maxHolds` times per user turn, only when a turn changed
//      files and reported nothing, and every hold names its own exit. A gate that can
//      trap a session is worse than no gate, because the session then optimises for
//      escaping it instead of for the person.
//   3. A review is read out of the REVIEWER's session log. Nothing the reviewed
//      session says about a child is evidence about that child.
//   4. State is written only under <DSH_HOME>/.rigor4/, never shared with another
//      generation, and never deleted on dispose. Restarting is not an exit and not an
//      erasure: a reading, a plan and a review all survive it on purpose.

import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import { registerableTool } from './registration.js'

import {
  archiveRound,
  briefIsCurrent,
  closeBriefConclusion,
  createRound,
  needsNewRound,
  openBriefs,
  openRework,
  recordAnswers,
  recordAttempt,
  recordCommand,
  recordEdit,
  recordQuestion,
  recordReadFact,
  recordRequest,
  recordSawJob,
  claimBrief,
  fingerprintOf,
  sameSnapshot,
  snapshotOf,
  ROLES,
} from './model.js'
import { lastAssistantText, sessionTail } from './children.js'
import { DISCIPLINE_SECTION } from './prompt.js'
import { createStore, createFileBackend } from './store.js'
import {
  READ_TOOLS,
  SPAWN_TOOLS,
  commandOf,
  describeSpawn,
  childRestriction,
  isMutationTool,
  isShellTool,
  mutationHint,
  rolesForTool,
  targetOf,
  toolForRole,
} from './classify.js'
import { createTools } from './tools.js'

export const name = 'rigor-4'
export const inject = ['tools']

/** How long without a person, or a report, before one progress note is due. */
const NOTE_AFTER_MS = 300_000
const NOTE_AFTER_CALLS = 25

/** How many distinct advisories one code may deliver between two user messages. */
const ADVISORY_LIMIT = 3

/** How many progress notes this round may send in total. */
const NOTE_LIMIT = 3

/** The envelope shape of the dispatch layer. Documented here because it is easy to get wrong. */
function readExitCode(result) {
  const envelope = result !== null && typeof result === 'object' ? result : {}
  const inner = envelope.value !== null && typeof envelope.value === 'object' ? envelope.value : {}
  if (Number.isFinite(inner.exitCode)) return inner.exitCode
  if (Number.isFinite(envelope.exitCode)) return envelope.exitCode
  return null
}

/** The answers an ask_user_question call came back with, or null when there are none. */
export function parseAnswers(result) {
  const found = []
  const visit = (value, depth) => {
    if (value === null || value === undefined || depth > 4) return
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try { visit(JSON.parse(trimmed), depth + 1) } catch { /* not JSON; nothing to read */ }
      }
      return
    }
    if (Array.isArray(value)) {
      const isAnswers = value.length > 0 && value.every(item => item !== null && typeof item === 'object' && ('selected' in item || 'custom' in item || 'answer' in item))
      if (isAnswers) found.push(value)
      else for (const item of value) visit(item, depth + 1)
      return
    }
    if (typeof value === 'object') {
      if (Array.isArray(value.answers)) visit(value.answers, depth + 1)
      else for (const item of Object.values(value)) visit(item, depth + 1)
    }
  }
  visit(result, 0)
  if (found.length === 0) return null
  return found[found.length - 1].map(item => ({
    id: String(item.id ?? ''),
    selected: Array.isArray(item.selected) ? item.selected.map(String) : (item.selected === undefined ? [] : [String(item.selected)]),
    custom: item.custom === undefined ? (item.answer === undefined ? '' : String(item.answer)) : String(item.custom),
  }))
}

export function apply(ctx, options) {
  const config = options ?? {}
  const store = createStore(config.backend ?? createFileBackend())
  const sessionQuery = ctx.get('sessionQuery')
  const subagents = ctx.get('subagents')
  const declared = config.capabilities ?? {}

  // What this preset can actually do. The discipline must never demand a channel the
  // base does not provide: a rule nobody can satisfy is a deadlock, and deadlocks are
  // exactly what the earlier generations died of. `children` needs the host registry
  // AND a reviewer's log to read; `person` is the ask-user channel, which cannot be
  // detected from here and so is declared by the preset that mounts this plugin.
  const capabilities = {
    children: declared.children !== false && subagents !== undefined && sessionQuery !== undefined,
    person: declared.person !== false,
    // Whether this preset carries the role-profile child tools (subagent_explore /
    // _review / _monitor). When it does, a brief must be answered by the tool built for
    // its role: a generic spawn would hand a reviewer the whole tool set, which is the
    // shape the role rows exist to prevent. Default false, so a preset that has not
    // declared profiles is never refused a generic spawn for a brief.
    profiles: declared.profiles === true,
  }

  let sessions = null
  const dirty = new Set()
  const loaded = () => {
    if (sessions === null) sessions = store.load()
    return sessions
  }
  const storageFailure = (id, result) => {
    const reason = result?.reason ?? 'Rigor state could not be persisted.'
    runtimeFor(id).storageIssue = reason
    dirty.delete(String(id))
    loaded().delete(String(id))
    const error = new Error(`${reason} No successful record was reported. Retry after resolving the storage error.`)
    error.code = result?.code ?? 'IO_ERROR'
    error.rigorStorage = true
    return error
  }
  const persist = (id, round) => {
    const result = store.saveSession(String(id), round)
    if (result?.ok !== true) throw storageFailure(id, result)
    loaded().set(String(id), round)
    dirty.delete(String(id))
    runtimeFor(id).storageIssue = ''
  }
  const flush = () => {
    for (const id of [...dirty]) {
      try { persist(id, loaded().get(id)) } catch (error) {
        if (error.rigorStorage !== true) throw error
        // Event observers keep the host usable; the next step carries the error.
        // A tool write, in contrast, returns an explicit refusal to its caller.
      }
    }
  }
  const commit = (agent, round) => {
    loaded().set(String(agent.id), round)
    dirty.add(String(agent.id))
  }

  const runtime = new Map()
  const runtimeFor = id => {
    const key = String(id)
    let state = runtime.get(key)
    if (state === undefined) {
      state = {
        turnStartSeq: 0,
        reportThisTurn: false,
        holdsSpent: 0,
        advisories: [],
        // Advisory deliveries by code: the exact texts already said, and how many
        // distinct texts have been said. Identical text is never said twice, and one
        // code is said at most ADVISORY_LIMIT times per user message. Measured live: one
        // session repeated "1 background job(s) running" eleven times and "the person has
        // said something since this reading" six times — 41% of everything this channel
        // injected was a sentence the model had already read.
        announced: new Map(),
        toolCalls: 0,
        lastReportAt: Date.now(),
        notesSent: 0,
        storageIssue: '',
        executions: new Map(),
      }
      runtime.set(key, state)
    }
    return state
  }

  const sessionFor = agent => {
    const id = String(agent.id)
    if (dirty.has(id)) return loaded().get(id)
    loaded()
    try {
      const fresh = store.loadSession(id)
      if (fresh !== undefined) { loaded().set(id, fresh); return fresh }
    } catch (error) {
      runtimeFor(id).storageIssue = error instanceof Error ? error.message : String(error)
    }
    return loaded().get(id) ?? createRound(Date.now())
  }
  const stat = (path, agent, options = {}) => {
    let fd
    try {
      const cwd = agent?.session?.header?.cwd ?? process.cwd()
      const absolute = realpathSync(resolve(cwd, String(path)))
      const info = statSync(absolute)
      if (!info.isFile()) return { exists: true, path: absolute, isFile: false, size: info.size, mtimeMs: info.mtimeMs }
      if (Number.isFinite(options.maxBytes) && info.size > options.maxBytes) return { exists: true, path: absolute, isFile: true, size: info.size, tooLarge: true }
      const hash = createHash('sha256')
      const buffer = Buffer.allocUnsafe(64 * 1024)
      fd = openSync(absolute, 'r')
      const opened = fstatSync(fd)
      if (!opened.isFile()) return { exists: true, path: absolute, isFile: false }
      if (Number.isFinite(options.maxBytes) && opened.size > options.maxBytes) return { exists: true, path: absolute, isFile: true, size: opened.size, tooLarge: true }
      let count
      let bytesRead = 0
      while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        bytesRead += count
        if (Number.isFinite(options.maxBytes) && bytesRead > options.maxBytes) return { exists: true, path: absolute, isFile: true, size: bytesRead, tooLarge: true }
        hash.update(buffer.subarray(0, count))
      }
      const after = statSync(absolute)
      if (info.size !== after.size || info.mtimeMs !== after.mtimeMs) return { exists: false, path: absolute, changedDuringRead: true }
      return { exists: true, path: absolute, isFile: true, size: info.size, mtimeMs: info.mtimeMs, fingerprint: `sha256:${hash.digest('hex')}` }
    } catch {
      return { exists: false, size: 0, mtimeMs: 0 }
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }

  const readArtifact = (path, agent) => {
    const cwd = agent?.session?.header?.cwd ?? process.cwd()
    const absolute = realpathSync(resolve(cwd, String(path)))
    const fd = openSync(absolute, 'r')
    try {
      const before = fstatSync(fd)
      const limit = 256 * 1024
      if (!before.isFile() || before.size > limit) throw new Error('Validation report is not a bounded regular file.')
      const buffer = Buffer.allocUnsafe(limit + 1)
      let size = 0
      let count
      while (size <= limit && (count = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += count
      const after = fstatSync(fd)
      if (size > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Validation report changed during reading.')
      const bytes = buffer.subarray(0, size)
      return { data: JSON.parse(bytes.toString('utf8')), fingerprint: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
    } finally { closeSync(fd) }
  }

  const listChildrenOf = async agent => {
    if (subagents === undefined || typeof subagents.listChildren !== 'function') return null
    try {
      const listed = await subagents.listChildren(String(agent.id), undefined)
      if (!Array.isArray(listed)) return null
      return listed
        .filter(entry => entry !== null && typeof entry === 'object' && entry.kind !== 'diagnostic')
        .map(entry => ({ id: String(entry.id), status: entry.activity === 'running' ? 'running' : 'done' }))
    } catch {
      return null
    }
  }

  const listJobs = agent => {
    const registry = ctx.get('jobs')
    if (registry === undefined || typeof registry.list !== 'function') return []
    try {
      const listed = registry.list(agent)
      return Array.isArray(listed) ? listed : []
    } catch {
      return []
    }
  }

  /**
   * One child's own log, with the header it ran under.
   *
   * The header carries `agentPreset` and `delegationDepth`: facts about the child that
   * this session cannot author. Today the host composes every child under its parent's
   * preset, so the preset is recorded rather than chosen — but it is read from the
   * child, and the day the host grows a per-child preset the record already shows it.
   */
  const readSession = async id => {
    if (sessionQuery === undefined || typeof sessionQuery.readSession !== 'function') return null
    try {
      const snapshot = await sessionQuery.readSession(String(id))
      if (snapshot === null || typeof snapshot !== 'object') return null
      const events = Array.isArray(snapshot.events) ? snapshot.events : null
      if (events === null) return null
      const header = snapshot.session !== null && typeof snapshot.session === 'object' ? snapshot.session : {}
      return { events, preset: String(header.agentPreset ?? '') }
    } catch {
      return null
    }
  }

  const deps = {
    sessionFor,
    // A tool's write is durable immediately: a reading, a review or a report that only
    // reaches disk at the next turn boundary is one a crash can take with it, and the
    // point of the record is that it outlives the thing that wrote it.
    save: (agent, round) => persist(agent.id, round),
    now: () => Date.now(),
    stat,
    readArtifact,
    capabilities,
    listChildren: agent => listChildrenOf(agent),
    readSession,
  }

  // A tool that can only refuse is not a tool, it is a tax on every request. On a
  // preset with no child channel, `rigor_brief` and `rigor_review` can never succeed:
  // the brief has no child to hand it to and a review has no log to read. Measured:
  // their schemas are 2,349 characters of the 6,934 this plugin would otherwise put in
  // front of the model on every request. They are registered only where they can do
  // what they say.
  const registered = createTools(deps).filter(tool => (
    capabilities.children !== false || (tool.name !== 'rigor_brief' && tool.name !== 'rigor_review')
  ))
  for (const tool of registered) {
    ctx.tools.register(registerableTool(tool))
  }

  const prompt = ctx.get('systemPrompt')
  if (prompt !== undefined && prompt !== null && typeof prompt.section === 'function') prompt.section(DISCIPLINE_SECTION)

  // ── the record: fed from the pipeline ─────────────────────────────────────

  const executionKey = exec => exec.token ?? exec.callId ?? exec
  const executionState = exec => {
    const executions = runtimeFor(exec.agent.id).executions
    const key = executionKey(exec)
    if (!executions.has(key)) executions.set(key, { dispatched: false, briefId: '' })
    return executions.get(key)
  }

  // Reaching dispatch means a failed call may have partial effects. The host's
  // explicit ABORTED_BEFORE_DISPATCH outcome overrides that conservative assumption.
  ctx.on('tools/execute', async (exec, next) => {
    if (exec?.agent) executionState(exec).dispatched = true
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const agent = exec?.agent
    if (agent !== undefined && agent !== null) {
      const state = runtimeFor(agent.id)
      state.toolCalls += 1
      const tool = String(exec.name ?? '')
      const args = exec.arguments ?? {}
      const at = deps.now()
      let round = sessionFor(agent)
      const before = round
      const execution = state.executions.get(executionKey(exec)) ?? { dispatched: false, briefId: '' }
      const dispatched = execution.dispatched && result?.error?.info?.code !== 'ABORTED_BEFORE_DISPATCH'
      const exitCode = readExitCode(result)
      const failed = result?.isError === true || (isShellTool(tool) && exitCode !== null && exitCode !== 0)
      if (failed) {
        round = recordAttempt(round, {
          tool, target: targetOf(tool, args), at,
          outcome: dispatched ? 'failed' : 'denied',
          possibleMutation: dispatched && (isMutationTool(tool) || (isShellTool(tool) && mutationHint(commandOf(args)))),
        })
        if (dispatched && isShellTool(tool) && exitCode !== null) {
          const cmd = commandOf(args)
          // A nonzero exit is still an observed command (and may be the expected
          // outcome of a negative test). The attempt already advanced work if needed.
          round = recordCommand(round, { cmd, exit: exitCode, mutationHint: mutationHint(cmd), advanceWork: false, at })
        }
      } else if (isMutationTool(tool)) {
        round = recordEdit(round, { target: targetOf(tool, args), tool, detail: args.file_path ?? args.path ?? '', at })
      } else if (isShellTool(tool)) {
        const cmd = commandOf(args)
        round = recordCommand(round, { cmd, exit: readExitCode(result), mutationHint: mutationHint(cmd), at })
      } else if (READ_TOOLS.includes(tool)) {
        const raw = args.file_path ?? args.filePath ?? args.path ?? args.ref ?? ''
        const ref = raw === '' ? '' : resolve(agent.session?.header?.cwd ?? process.cwd(), String(raw))
        round = recordReadFact(round, { ref, at })
      }
      if (!failed && SPAWN_TOOLS.includes(tool) && execution.briefId !== '') {
        let childId = result?.value?.subagentId ?? result?.subagentId
        // The official in-process foreground driver returns its child session id as
        // runId. Verify it against this parent's registry; never infer from ordering.
        if (!childId && result?.value?.kind === 'foreground' && typeof result.value.runId === 'string') {
          const children = await listChildrenOf(agent)
          if (children?.some(child => child.id === result.value.runId)) childId = result.value.runId
          round = sessionFor(agent)
        }
        if (typeof childId === 'string' && childId !== '') {
          const claimed = claimBrief(round, { briefId: execution.briefId, childId, at, tool })
          if (claimed.refusal === undefined) round = claimed.round
        }
      }
      if (!failed && tool === 'ask_user_question') {
        const questions = Array.isArray(args.questions) ? args.questions : []
        round = recordQuestion(round, { questions, at })
        const answers = parseAnswers(result)
        if (answers !== null && answers.length > 0) round = recordAnswers(round, { answers, at })
      }
      if (!failed && tool === 'rigor_report') {
        // Recorded as this turn's account only when the tool actually recorded one; a
        // refused `done` is not a report, and counting it as one would silence the
        // turn-stopping gate for a turn that said nothing true about itself.
        const recorded = resultSaysRecorded(result)
        if (recorded) {
          state.reportThisTurn = true
          state.lastReportAt = at
        }
      }
      state.executions.delete(executionKey(exec))
      if (round !== before) commit(agent, round)
      flush()
    }
    return next()
  })

  // Pipeline exceptions can skip post-execute. The final observer always runs:
  // release reservations and preserve uncertain failure facts without double-counting.
  ctx.on('tools/result', (exec, result) => {
    if (!exec?.agent) return
    const state = runtimeFor(exec.agent.id)
    const key = executionKey(exec)
    const execution = state.executions.get(key)
    state.executions.delete(key)
    if (!execution || result?.isError !== true) return
    const tool = String(exec.name ?? '')
    const dispatched = execution.dispatched && result?.error?.info?.code !== 'ABORTED_BEFORE_DISPATCH'
    commit(exec.agent, recordAttempt(sessionFor(exec.agent), {
      tool, target: targetOf(tool, exec.arguments ?? {}), at: deps.now(),
      outcome: dispatched ? 'failed' : 'denied',
      possibleMutation: dispatched && (isMutationTool(tool) || (isShellTool(tool) && mutationHint(commandOf(exec.arguments)))),
    }))
    flush()
  })

  /** Whether a tool result is the JSON our own tools render, with recorded: true. */
  function resultSaysRecorded(result) {
    if (result?.isError === true) return false
    if (result?.value?.recorded === true || result?.recorded === true) return true
    const blocks = typeof result?.content === 'string' ? [result.content]
      : Array.isArray(result?.content) ? result.content.filter(item => item?.type === 'text').map(item => item.text) : []
    return blocks.some(text => { try { return JSON.parse(text)?.recorded === true } catch { return false } })
  }

  // ── the two tool gates ────────────────────────────────────────────────────

  ctx.on('tools/pre-execute', async (exec, next) => {
    const agent = exec?.agent
    if (agent === undefined || agent === null) return next()
    const tool = String(exec?.name ?? '')
    const execution = executionState(exec)
    const round = sessionFor(agent)

    // Gate 0: a child enforces its own brief before anything else. The host's toolFilter
    // cannot: tools.restrict() accepts only restrictable GLOBAL names, so a preset-local
    // tool (the subagent rows themselves) can never be named there, and an unknown name
    // throws — which is how a role row took the whole spawn down in a live session.
    if (round.briefedAs !== '') {
      const restricted = childRestriction(round.briefedAs, tool)
      if (restricted !== '') return { kind: 'deny', reason: restricted }
    }

    // Gate 1: nothing gets edited before the reading exists. File-mutation tools are
    // unambiguous, so denying them is safe; shell is not denied because "does this
    // command write?" cannot be answered for every shell, and a wrong denial costs a
    // turn. A shell write before the reading is caught as a LATE reading instead.
    if (isMutationTool(tool) && round.reading === null) {
      return {
        kind: 'deny',
        reason: 'no reading is recorded yet, so anything edited now would be built on an unstated guess about what the person wants. Call rigor_read first — the literal request plus the needs they never typed, each with what would show it is met — then make the change.',
      }
    }

    // Gate 2: a child must answer a brief. A spawn that matches no open brief is an
    // opinion nobody asked for, and it also means no reviewer will ever be able to
    // trace what that child was for.
    if (SPAWN_TOOLS.includes(tool)) {
      if (capabilities.children === false) {
        return { kind: 'deny', reason: 'this preset has no subagent channel, so nothing can be spawned. Continue in this session; a done claim will have to carry that limitation.' }
      }
      const described = describeSpawn(exec.arguments)
      const fingerprint = fingerprintOf(described)
      // A brief that already has a child is spoken for; one claimed but never given a
      // child id may be retried — a spawn can fail for reasons unrelated to the question.
      const waiting = openBriefs(round).filter(item => (item.state === 'open' || item.childId === '') && briefIsCurrent(round, item))
      // Two ways a spawn matches: the question itself (fingerprint), or the whole
      // rendered brief, which is what the tool tells the parent to hand over.
      const match = waiting.find(item => item.fingerprint !== '' && item.fingerprint === fingerprint)
        ?? waiting.find(item => item.question !== '' && described.includes(item.question))
        ?? waiting.find(item => item.fingerprint !== '' && described.includes(item.fingerprint))
      if (match === undefined) {
        // What the gate actually read out of the spawn. A mismatch that names the text it
        // saw diagnoses itself; without it the caller re-sends the same spawn in circles.
        const carries = described.replace(/\s+/g, ' ').trim()
        const seen = carries === '' ? '' : ` This spawn carries: "${carries.slice(0, 120)}". Hand the brief over verbatim, in the spawn's prompt.`

        return {
          kind: 'deny',
          reason: waiting.length === 0
            ? 'no brief is open for this spawn. Open one first (rigor_brief(role=...)); the brief is what says which question this child answers and which need it serves, and without it nothing can be traced back to the person.'
            : `this spawn matches no open brief. Open briefs: ${waiting.map(item => `${item.id} ${item.role}: ${item.question.slice(0, 60)}`).join(' | ')}. Open a brief whose question matches what you are about to ask, or reuse one of these.${seen}`,
        }
      }
      // A role-specific tool carries a capability profile; a brief opened for another
      // role must not be answered by it. This is the binding half of the role rows: a
      // reviewer that can edit what it reviews, or an explorer with a shell, is not the
      // child the discipline asked for.
      const allowed = rolesForTool(tool)
      const wanted = toolForRole(match.role)
      if ([...runtimeFor(agent.id).executions.values()].some(other => other !== execution && other.briefId === match.id)) {
        return { kind: 'deny', reason: `brief ${match.id} already has a spawn in progress. Wait for that call to finish; retry only if it fails.` }
      }
      if ((match.role === 'review' || match.role === 'rework-check') && !sameSnapshot(match.snapshot, snapshotOf(round))) {
        return { kind: 'deny', reason: `brief ${match.id} describes an older delivery. Open a new ${match.role} brief for the current reading, plan and work, then spawn its reviewer.` }
      }
      if (allowed !== null && !allowed.includes(match.role)) {
        return {
          kind: 'deny',
          reason: `brief ${match.id} is a ${match.role} brief, and ${tool} carries a different capability profile. Start it with ${wanted} (${allowed.join(' / ')} roles answer to ${tool}).`,
        }
      }
      if (allowed === null && capabilities.profiles === true) {
        return {
          kind: 'deny',
          reason: `this preset carries a child built for the ${match.role} job: start brief ${match.id} with ${wanted}. A generic ${tool} would hand the child the full tool set, and the role exists precisely so a reviewer cannot edit what it reviews and an explorer carries no shell.`,
        }
      }
      const outcome = claimBrief(round, { briefId: match.id, childId: '', at: deps.now(), tool })
      if (outcome.refusal !== undefined) return { kind: 'deny', reason: outcome.refusal.detail }
      try { persist(agent.id, outcome.round) } catch (error) {
        if (error.rigorStorage === true) return { kind: 'deny', reason: error.message }
        throw error
      }
      execution.briefId = match.id
    }
    return next()
  })

  // ── children: identity, conclusions, and what the parent is shown ─────────

  // Child identity comes exclusively from the successful spawn result above.
  // Historical registry ordering cannot prove which brief created a child.
  async function reconcile(round) { return round }

  /**
   * Close the text-role briefs whose children finished, and hold their answer as a
   * finding so the parent is shown it on the free channel. `review` and `rework-check`
   * are not closed here: their verdict is linked explicitly with rigor_review, which is
   * what makes it leave the child's own log.
   */
  async function collectConclusions(round, agent) {
    let next = round
    const findings = []
    for (const brief of openBriefs(next)) {
      if (brief.childId === '' || brief.role === 'review' || brief.role === 'rework-check') continue
      const snapshot = await readSession(brief.childId)
      if (snapshot === null || snapshot.events.length === 0) continue
      const events = snapshot.events
      if (!sessionTail(events).finished) continue
      const conclusion = lastAssistantText(events)
      next = closeBriefConclusion(next, { briefId: brief.id, conclusion, at: deps.now() })
      findings.push({ role: brief.role, childId: brief.childId, preset: snapshot.preset, text: conclusion })
    }
    if (findings.length === 0) return next
    const existing = next.findings ?? []
    const recorded = findings.map(item => ({ seq: Number(next.seq ?? 0), at: deps.now(), childId: item.childId, role: item.role, preset: item.preset ?? '', delivered: false, text: String(item.text ?? '').slice(0, 1600) }))
    return { ...next, findings: [...existing, ...recorded].slice(-60) }
  }


  // ── the gate: a bounded hold, on the channel that costs a round trip ──────

  ctx.on('agent/turn-stopping', async payload => {
    const agent = payload?.agent
    if (agent === undefined || agent === null) return
    const id = String(agent.id)
    const state = runtimeFor(id)
    const now = deps.now()
    let round = sessionFor(agent)
    round = await reconcile(round, agent)
    round = await collectConclusions(round, agent)
    const jobs = listJobs(agent)
    if (jobs.some(job => job !== null && typeof job === 'object' && job.status === 'running')) round = recordSawJob(round)
    commit(agent, round)

    const changedTargets = new Set((round.facts?.edits ?? []).filter(item => item.seq > state.turnStartSeq).map(item => item.target)).size
    const hinted = (round.facts?.commands ?? []).some(item => item.seq > state.turnStartSeq && item.mutationHint === true)
    const changed = changedTargets > 0 || hinted
    const maxHolds = Number.isFinite(config.maxHolds) ? config.maxHolds : 2

    if (changed && state.reportThisTurn !== true && state.holdsSpent < maxHolds) {
      state.holdsSpent += 1
      const body = [
        '[rigor] This turn changed the tree and recorded no account of it.',
        changedTargets > 0 ? `- ${changedTargets} target(s) changed.` : '- A command that persists something ran.',
        'Exit: call rigor_report(status="partial" | "blocked") naming what is done and what is not — partial is always recordable and is a complete answer when the work is unfinished — or status="done" once the reading, the reviews and the evidence support it.',
        `This session can be held ${maxHolds} time(s) per user turn; everything else this mode notices rides along for free and cannot hold anything.`,
      ].join('\n')
      agent.steer({ id: `rigor4-${payload.turn ?? 0}-${state.holdsSpent}`, role: 'user', content: [{ type: 'text', text: body }], source: { kind: 'plugin', plugin: name, form: 'notice', summary: 'delivery gate objection' } })
    } else {
      state.advisories = buildAdvisories(round, agent, jobs)
    }

    state.turnStartSeq = Number(round.seq ?? 0)
    state.reportThisTurn = false
    flush()
  })

  /** Everything worth saying that cannot hold anything, as { code, detail }. */
  function buildAdvisories(round, agent, jobs = []) {
    const advisories = []
    const issue = runtimeFor(agent.id).storageIssue
    if (issue !== '') advisories.push({ code: 'storage-error', detail: `Rigor could not persist or restore its record: ${issue}. No successful write is implied; retry the failed record after resolving the storage problem.` })
    const lastReviewSeq = Math.max(0, ...(round.reviews ?? []).map(item => item.seq ?? 0))
    const uncertain = (round.facts?.attempts ?? []).filter(item => item.possibleMutation === true && item.seq > lastReviewSeq)
    if (uncertain.length > 0) advisories.push({ code: 'uncertain-effects', detail: `${uncertain.length} failed dispatched operation(s) may have left partial changes. Inspect the affected output before providing fresh evidence and a review.` })
    const open = openRework(round)
    if (open.length > 0) {
      advisories.push({
        code: 'open-rework',
        detail: `rework still open: ${open.map(item => `${item.id} ${item.text}`).join(' | ')} — close each with a rework-check review, or report partial naming them.`,
      })
    }
    const reading = round.reading
    if (reading !== null) {
      const newest = (round.requests ?? []).slice(-1)[0]
      if (newest !== undefined && newest.seq > reading.requestSeq) {
        advisories.push({
          code: 'stale-reading',
          detail: `the person has said something since this reading was recorded (#${newest.seq}): "${String(newest.text).slice(0, 120)}". Check whether it changes the reading; if it does, call rigor_read again (a revision is recorded, not hidden).`,
        })
      }
    }
    const running = jobs.filter(job => job !== null && typeof job === 'object' && job.status === 'running')
    if (running.length > 0) {
      advisories.push({
        code: 'running-job',
        detail: `${running.length} background job(s) running: ${running.map(job => String(job.id)).join(', ')} — say whether you are waiting on them, or stop them. A monitor child is owed when a job runs (rigor_brief(role="monitor")).`,
      })
    }
    const unreviewed = (round.briefs ?? []).filter(item => item.state === 'claimed' && item.childId !== '' && (item.role === 'review' || item.role === 'rework-check') && !(round.reviews ?? []).some(review => review.childId === item.childId))
    for (const brief of unreviewed) {
      advisories.push({
        code: `unlinked-review:${brief.id}`,
        detail: `child ${brief.childId} was briefed to answer ${brief.id} (${brief.role}) and is not linked yet: call rigor_review(child="${brief.childId}") — its verdict is read from its own log, not from anything you write.`,
      })
    }
    for (const finding of (round.findings ?? []).filter(item => item.delivered !== true)) {
      advisories.push({
        code: `finding:${finding.childId}`,
        detail: `child ${finding.childId} (${finding.role}) answered: ${String(finding.text).slice(0, 600)}`,
        findingSeq: finding.seq,
      })
    }
    return advisories
  }

  // ── the free channel ──────────────────────────────────────────────────────

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision === null || decision === undefined || decision.kind !== 'enter') return decision
    const agent = payload?.agent
    if (agent === undefined || agent === null) return decision
    const id = String(agent.id)
    const state = runtimeFor(id)
    const now = deps.now()
    const messages = []
    let round = sessionFor(agent)
    round = await reconcile(round, agent)
    round = await collectConclusions(round, agent)
    commit(agent, round)

    const carried = state.advisories.length > 0 ? state.advisories : buildAdvisories(round, agent, listJobs(agent))
    const said = []
    const proven = []
    for (const advisory of carried) {
      const record = state.announced.get(advisory.code) ?? { texts: new Set(), count: 0 }
      if (record.texts.has(advisory.detail)) continue
      const isFinding = advisory.code.startsWith('finding:')
      if (!isFinding && record.count >= ADVISORY_LIMIT) continue
      record.texts.add(advisory.detail)
      record.count += 1
      state.announced.set(advisory.code, record)
      said.push(advisory.detail)
      if (advisory.findingSeq !== undefined) proven.push(advisory.findingSeq)
    }
    state.advisories = []
    // One message for the whole batch: N separate user messages cost N framings and N
    // breaks in the prompt prefix, for one thing worth saying.
    if (said.length > 0) messages.push(notice(`[rigor]\n- ${said.join('\n- ')}`))
    if (proven.length > 0) {
      // The finding is marked on the record, not in this process's memory: a restart must
      // not re-deliver a child's answer the person has already been shown.
      round = { ...round, findings: (round.findings ?? []).map(item => (proven.includes(item.seq) ? { ...item, delivered: true } : item)) }
      commit(agent, round)
    }

    if (state.toolCalls >= (Number.isFinite(config.noteAfterCalls) ? config.noteAfterCalls : NOTE_AFTER_CALLS)
      && now - state.lastReportAt >= (Number.isFinite(config.noteAfterMs) ? config.noteAfterMs : NOTE_AFTER_MS)
      && state.notesSent < (Number.isFinite(config.maxNotes) ? config.maxNotes : NOTE_LIMIT)) {
      messages.push(notice(`[rigor] ${state.toolCalls} tool calls and ${Math.max(1, Math.round((now - state.lastReportAt) / 60000))} minute(s) since anything was reported. No judgement here — but if the person is waiting, a one-line partial account now is worth more than a perfect one later.`))
      state.notesSent += 1
      state.toolCalls = 0
      state.lastReportAt = now
    }

    flush()
    if (messages.length === 0) return decision
    const existing = Array.isArray(decision.messages) ? decision.messages : []
    return { ...decision, messages: [...existing, ...messages] }
  })

  function notice(text) {
    return {
      id: `rigor4-note-${Math.round(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: name, form: 'notice' },
    }
  }

  // ── request boundaries, and the loop bound on waking ──────────────────────

  ctx.on('agent/inbox/claimed', payload => {
    const agent = payload?.agent
    if (agent === undefined || agent === null) return
    const source = payload.message !== null && typeof payload.message === 'object' ? payload.message.source : null
    const kind = source !== null && typeof source === 'object' ? source.kind : undefined
    const id = String(agent.id)
    if (kind !== undefined && kind !== 'user') return
    const state = runtimeFor(id)
    state.holdsSpent = 0
    state.toolCalls = 0
    state.lastReportAt = deps.now()
    // A new message from the person re-opens the per-code COUNT — but not the memory of
    // exact texts: a sentence already read in this round is not worth reading again just
    // because the person said "continue". Changed content is new information either way.
    for (const record of state.announced.values()) record.count = 0
    state.notesSent = 0
    const text = messageText(payload.message)
    let round = sessionFor(agent)
    // A briefed child announces itself in its first message. Recording the role here is
    // what lets the CHILD enforce its own mandate: the host's filter cannot name
    // preset-local tools, and this session's own gate can.
    const childSession = agent.session?.header?.origin === 'subagent' || Boolean(agent.session?.header?.parentSession)
    if (text !== '' && childSession && round.briefedAs === '') {
      const briefed = parseBriefRole(text)
      if (briefed !== null) round = { ...round, briefedAs: briefed.role, briefedTool: briefed.tool }
    }
    // Only a completed current delivery starts a new round. Partial/blocked work
    // keeps its reading, evidence and unresolved rework when the person continues.
    if (text !== '' && needsNewRound(round)) {
      const role = { briefedAs: round.briefedAs, briefedTool: round.briefedTool }
      round = archiveRound(round, { at: deps.now() })
      if (childSession) round = { ...round, ...role }
      state.announced = new Map()
    }
    if (text !== '') round = recordRequest(round, { text, at: deps.now() })
    if (round !== sessionFor(agent)) commit(agent, round)
    flush()
  })

  /** The role a brief opens with, and the tool it says to start with. Null when this is not a brief. */
  function parseBriefRole(text) {
    const source = String(text ?? '').slice(0, 600)
    const found = /#\s*Brief:\s*([a-z-]+)/i.exec(source)
    if (found === null) return null
    const role = found[1].toLowerCase()
    if (!ROLES.includes(role)) return null
    const tool = /Start this child with the ([a-z_]+)/i.exec(source)
    return { role, tool: tool === null ? '' : tool[1] }
  }

  function messageText(message) {
    if (message === null || typeof message !== 'object') return ''
    const content = message.content
    if (!Array.isArray(content)) return ''
    return content
      .filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
      .trim()
  }

  ctx.on('agent/session-start', payload => {
    const agent = payload?.agent
    if (agent === undefined || agent === null) return
    const id = String(agent.id)
    const state = runtimeFor(id)
    state.turnStartSeq = Number(sessionFor(agent).seq ?? 0)
    state.lastReportAt = deps.now()
    if (loaded().get(id) === undefined) {
      commit(agent, createRound(deps.now()))
      flush()
    }
  })

  ctx.on('agent/disposed', payload => {
    const agent = payload?.agent
    if (agent === undefined || agent === null) return
    // The record is NOT deleted here. A restart is not an exit from the discipline —
    // a reading, a plan, a review and an honest partial all survive it on purpose —
    // and a dispose that erased the file would make every one of them a memory.
    flush()
    runtime.delete(String(agent.id))
  })
}
