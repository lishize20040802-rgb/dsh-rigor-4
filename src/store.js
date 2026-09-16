// Per-session records under `<DSH_HOME>/.rigor4/sessions/`.
//
// Deliberately its own directory and its own format. Each earlier generation kept its
// own state somewhere else; this one reads and writes none of it, so nothing a
// previous build left behind can arm, disarm or confuse this gate, and nothing here
// can damage what they recorded.
//
// Legacy sessions.json remains a read-only migration source. New records use
// atomic rename plus a per-session lock and revision check; stale writers fail.

import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { bounded, createRound, LIMITS, ROLES, SHAPE } from './model.js'

/** Bump when the on-disk shape changes. */
export const FORMAT = 2

export function resolveHome(env = process.env, home = homedir()) {
  const declared = env.DSH_HOME
  const named = typeof declared === 'string' && declared.trim() !== '' ? declared.trim() : join(home, '.dsh')
  const expanded = named === '~' ? home : /^~[/\\]/.test(named) ? join(home, named.slice(2)) : named
  return resolve(expanded)
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function num(value, fallback = 0) {
  return Number.isFinite(value) ? Number(value) : fallback
}

function list(value) {
  return Array.isArray(value) ? value : []
}

function bool(value) {
  return value === true
}

function readSnapshot(value) {
  if (!plain(value) || str(value.roundId) === '') return null
  return { roundId: value.roundId, readingVersion: num(value.readingVersion), planVersion: num(value.planVersion), workRevision: num(value.workRevision) }
}

function keepOpen(items, limit, predicate) {
  const open = items.filter(predicate)
  const closed = items.filter(item => !predicate(item))
  const retained = new Set(open.length >= limit ? [] : closed.slice(-(limit - open.length)))
  return items.filter(item => predicate(item) || retained.has(item))
}


function readReading(value) {
  if (!plain(value)) return null
  const needs = list(value.needs).filter(plain).map((item, index) => ({
    id: str(item.id, `N${index + 1}`),
    kind: item.kind === 'stated' ? 'stated' : 'implicit',
    text: str(item.text),
    test: str(item.test),
  }))
  const unknowns = list(value.unknowns).filter(plain).map((item, index) => ({ id: str(item.id, `U${index + 1}`), text: str(item.text) }))
  return {
    version: Math.max(1, Math.round(num(value.version, 1))),
    seq: num(value.seq),
    at: num(value.at),
    late: bool(value.late),
    hadLateReading: bool(value.hadLateReading) || bool(value.late),
    literal: str(value.literal),
    requestSeq: num(value.requestSeq),
    needs,
    unknowns,
    revisions: bounded(list(value.revisions).filter(plain).map(item => ({
      at: num(item.at),
      version: num(item.version),
      late: bool(item.late),
      literal: str(item.literal),
      needs: list(item.needs).filter(plain).map(need => ({ id: str(need.id), kind: need.kind === 'stated' ? 'stated' : 'implicit', text: str(need.text), test: str(need.test) })),
    })), 6),
  }
}

function readPlan(value) {
  if (!plain(value)) return null
  return {
    version: num(value.version),
    seq: num(value.seq),
    at: num(value.at),
    readingVersion: num(value.readingVersion),
    approach: str(value.approach),
    steps: list(value.steps).filter(plain).map((item, index) => ({
      id: str(item.id, `S${index + 1}`),
      text: str(item.text),
      serves: list(item.serves).map(part => str(part)).filter(part => part !== ''),
      evidence: str(item.evidence),
    })),
    risks: list(value.risks).map(item => str(item)).filter(item => item !== ''),
  }
}

function readFacts(value) {
  const facts = plain(value) ? value : {}
  return {
    edits: bounded(list(facts.edits).filter(plain).map(item => ({ seq: num(item.seq), at: num(item.at), snapshot: readSnapshot(item.snapshot), target: str(item.target), tool: str(item.tool), detail: str(item.detail) })), LIMITS.edits),
    commands: bounded(list(facts.commands).filter(plain).map(item => ({ seq: num(item.seq), at: num(item.at), snapshot: readSnapshot(item.snapshot), cmd: str(item.cmd), exit: Number.isFinite(item.exit) ? item.exit : null, mutationHint: bool(item.mutationHint) })), LIMITS.commands),
    reads: bounded(list(facts.reads).filter(plain).map(item => ({ seq: num(item.seq), at: num(item.at), snapshot: readSnapshot(item.snapshot), ref: str(item.ref) })), LIMITS.reads),
    questions: bounded(list(facts.questions).filter(plain).map(item => ({ seq: num(item.seq), at: num(item.at), snapshot: readSnapshot(item.snapshot), ids: list(item.ids).map(part => str(part)), texts: list(item.texts).map(part => str(part)) })), LIMITS.questions),
    answers: bounded(list(facts.answers).filter(plain).map(item => ({ seq: num(item.seq), at: num(item.at), snapshot: readSnapshot(item.snapshot), texts: list(item.texts).map(part => str(part)) })), LIMITS.answers),
    attempts: bounded(list(facts.attempts).filter(plain).map(item => ({ seq: num(item.seq), at: num(item.at), snapshot: readSnapshot(item.snapshot), tool: str(item.tool), target: str(item.target), outcome: item.outcome === 'denied' ? 'denied' : 'failed', possibleMutation: bool(item.possibleMutation) })), LIMITS.attempts),
    sawJob: bool(facts.sawJob),
  }
}

function readReview(value) {
  return {
    id: str(value.id),
    seq: num(value.seq),
    at: num(value.at),
    briefId: str(value.briefId),
    childId: str(value.childId),
    role: value.role === 'rework-check' ? 'rework-check' : 'review',
    childPreset: str(value.childPreset),
    childTool: str(value.childTool),
    readingVersion: num(value.readingVersion),
    snapshot: readSnapshot(value.snapshot),
    verdict: value.verdict === 'approve' ? 'approve' : 'rework',
    readingOk: bool(value.readingOk),
    needs: list(value.needs).filter(plain).map(item => ({ id: str(item.id), status: ['met', 'not-met', 'not-checked'].includes(item.status) ? item.status : 'not-checked', how: str(item.how), evidence: str(item.evidence) })),
    scriptOnly: list(value.scriptOnly).map(item => str(item)),
    deviations: list(value.deviations).map(item => str(item)),
    questions: list(value.questions).map(item => str(item)),
    closedItems: list(value.closedItems).map(item => str(item)),
  }
}

/** Merge a stored record onto a fresh round, keeping only the fields this build judges. */
export function adopt(value, { sessionId = '' } = {}) {
  const fresh = createRound()
  if (!plain(value)) return fresh
  const reading = readReading(value.reading)
  const plan = readPlan(value.plan)
  return {
    shape: SHAPE,
    roundId: str(value.roundId) || (sessionId === '' ? fresh.roundId : `legacy:${sessionId}:${num(value.startedAt)}`),
    planVersion: num(value.planVersion, plan?.version ?? 0),
    workRevision: num(value.workRevision),
    briefSeq: num(value.briefSeq),
    reviewSeq: num(value.reviewSeq),
    reworkSeq: num(value.reworkSeq),
    seq: num(value.seq),
    startedAt: num(value.startedAt),
    briefedAs: str(value.briefedAs),
    briefedTool: str(value.briefedTool),
    requests: bounded(list(value.requests).filter(plain).map(item => ({ seq: num(item.seq), at: num(item.at), text: str(item.text) })), LIMITS.requests),
    reading,
    plan,
    briefs: keepOpen(list(value.briefs).filter(plain).map((item, index) => ({
      id: str(item.id, `B${index + 1}`),
      seq: num(item.seq),
      at: num(item.at),
      role: ROLES.includes(item.role) ? item.role : 'review',
      question: str(item.question),
      serves: list(item.serves).map(part => str(part)),
      fingerprint: str(item.fingerprint),
      tool: str(item.tool),
      readingVersion: num(item.readingVersion),
      snapshot: readSnapshot(item.snapshot),
      requestSeq: num(item.requestSeq),
      childId: str(item.childId),
      state: item.state === 'closed' ? 'closed' : item.state === 'claimed' ? 'claimed' : 'open',
      conclusion: str(item.conclusion),
      closedAt: num(item.closedAt),
      claimedAt: num(item.claimedAt),
    })), LIMITS.briefs, item => item.state !== 'closed'),
    evidence: bounded(list(value.evidence).filter(plain).map(item => ({
      seq: num(item.seq), at: num(item.at), need: str(item.need), kind: str(item.kind), ref: str(item.ref), seqOfFact: num(item.seqOfFact), path: str(item.path), note: str(item.note),
      size: Number.isFinite(item.size) ? item.size : null, mtimeMs: Number.isFinite(item.mtimeMs) ? item.mtimeMs : null, fingerprint: str(item.fingerprint),
      snapshot: readSnapshot(item.snapshot), factSnapshot: readSnapshot(item.factSnapshot),
    })), LIMITS.evidence),
    reviews: bounded(list(value.reviews).filter(plain).map(readReview), LIMITS.reviews),
    rework: keepOpen(list(value.rework).filter(plain).map((item, index) => ({
      id: str(item.id, `R${index + 1}`),
      at: num(item.at),
      text: str(item.text),
      from: str(item.from),
      status: item.status === 'closed' ? 'closed' : 'open',
      closedBy: str(item.closedBy),
      closedAt: num(item.closedAt),
    })), LIMITS.reviews, item => item.status !== 'closed'),
    facts: readFacts(value.facts),
    findings: bounded(list(value.findings).filter(plain).map(item => ({ seq: num(item.seq), at: num(item.at), childId: str(item.childId), role: str(item.role), preset: str(item.preset), delivered: bool(item.delivered), text: str(item.text) })), LIMITS.findings),
    reports: bounded(list(value.reports).filter(plain).map(item => ({
      seq: num(item.seq), at: num(item.at),
      status: item.status === 'done' ? 'done' : item.status === 'blocked' ? 'blocked' : 'partial',
      snapshot: readSnapshot(item.snapshot),
      readingConfirmed: item.readingConfirmed === 'yes' ? 'yes' : 'no',
      perNeed: list(item.perNeed).filter(plain).map(need => ({ id: str(need.id), status: ['met', 'not-met', 'not-checked'].includes(need.status) ? need.status : 'not-checked' })),
      gaps: list(item.gaps).map(gap => str(gap)),
      limitations: list(item.limitations).map(item => str(item)),
    })), LIMITS.reports),
    history: bounded(list(value.history).filter(plain).map(item => ({
      at: num(item.at),
      reason: str(item.reason),
      literal: str(item.literal),
      wants: str(item.wants),
      needs: num(item.needs),
      reviews: num(item.reviews),
      reports: num(item.reports),
      steps: num(item.steps),
      edits: num(item.edits),
    })), LIMITS.history),
  }
}

export function encode(sessions) {
  const records = Object.create(null)
  for (const [id, round] of sessions) records[id] = round
  return JSON.stringify({ format: FORMAT, sessions: records }, null, 2)
}

export function decode(text) {
  const sessions = new Map()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw storageError('CORRUPT_STATE', 'persisted state is not valid JSON; the file was left unchanged', cause)
  }
  if (!plain(parsed)) throw storageError('CORRUPT_STATE', 'persisted state is not an object')
  const format = Number(parsed.format)
  if (!Number.isInteger(format) || format < 1 || format > FORMAT) throw storageError('CORRUPT_STATE', `unsupported state format ${String(parsed.format)}`)
  if (!plain(parsed.sessions)) throw storageError('CORRUPT_STATE', 'persisted sessions must be an object')
  for (const [id, value] of Object.entries(parsed.sessions)) {
    if (!plain(value)) throw storageError('CORRUPT_STATE', `session ${id} is not an object`)
    sessions.set(id, adopt(value, { sessionId: id }))
  }
  return sessions
}

function storageError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  error.code = code
  return error
}

function optionalRead(path) {
  try { return readFileSync(path, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

/** Creating a backend touches nothing. Legacy sessions.json is never rewritten. */
export function createFileBackend(options = {}) {
  const directory = options.directory ?? join(resolveHome(), '.rigor4')
  const path = join(directory, options.fileName ?? 'sessions.json')
  const sessionDirectory = join(directory, 'sessions')
  const sessionPath = id => join(sessionDirectory, `${createHash('sha256').update(String(id)).digest('hex')}.json`)
  const legacy = () => {
    const text = optionalRead(path)
    return text === undefined ? new Map() : decode(text)
  }
  const readRecord = (target, wanted) => {
    const text = optionalRead(target)
    if (text === undefined) return undefined
    let record
    try { record = JSON.parse(text) } catch (error) { throw storageError('CORRUPT_STATE', `invalid session file ${target}; it was left unchanged`, error) }
    if (!plain(record) || record.format !== FORMAT || typeof record.sessionId !== 'string' || !Number.isInteger(record.revision) || record.revision < 1 || !plain(record.round)
      || (wanted !== undefined && record.sessionId !== String(wanted)) || sessionPath(record.sessionId) !== target) {
      throw storageError('CORRUPT_STATE', `invalid session record ${target}; it was left unchanged`)
    }
    return { id: record.sessionId, revision: record.revision, round: adopt(record.round, { sessionId: record.sessionId }) }
  }
  const readSession = id => {
    const record = readRecord(sessionPath(id), id)
    return record ?? { id: String(id), revision: 0, round: legacy().get(String(id)) }
  }
  return {
    path,
    sessionDirectory,
    readSession,
    readAll() {
      const records = new Map([...legacy()].map(([id, round]) => [id, { id, round, revision: 0 }]))
      let names
      try { names = readdirSync(sessionDirectory) } catch (error) {
        if (error.code === 'ENOENT') return records
        throw error
      }
      for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        const record = readRecord(join(sessionDirectory, name))
        if (record !== undefined) records.set(record.id, record)
      }
      return records
    },
    writeSession(id, round, expectedRevision) {
      const key = String(id)
      const target = sessionPath(key)
      const lock = `${target}.lock`
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
      mkdirSync(sessionDirectory, { recursive: true })
      let descriptor
      try { descriptor = openSync(lock, 'wx') } catch (error) {
        if (error.code === 'EEXIST') throw storageError('CONFLICT', `session ${key} is being saved by another writer; reload and retry`)
        throw error
      }
      try {
        const current = readSession(key)
        if (current.revision !== expectedRevision) throw storageError('CONFLICT', `session ${key} changed since it was loaded; reload before retrying`)
        const revision = current.revision + 1
        writeFileSync(temporary, JSON.stringify({ format: FORMAT, sessionId: key, revision, round }, null, 2), { encoding: 'utf8', flag: 'wx' })
        renameSync(temporary, target)
        return revision
      } finally {
        closeSync(descriptor)
        rmSync(temporary, { force: true })
        rmSync(lock, { force: true })
      }
    },
    clear() {
      throw storageError('READ_ONLY', 'bulk deletion is not supported; legacy state and session records are retained')
    },
  }
}

// Object spreads preserve this token; JSON serialization omits it. This binds a
// derived round to the version it actually read, even across an async tool call.
const REVISION = Symbol('rigor4.storageRevision')

/** A store over a file backend or the original injectable read/write backend. */
export function createStore(backend) {
  if (backend === undefined || backend === null || (typeof backend.read !== 'function' && typeof backend.readSession !== 'function')) {
    const sessions = new Map()
    return {
      mode: 'memory',
      reason: 'no persistent backend is available; the round lives for this process only',
      load: () => new Map(sessions),
      loadSession: id => sessions.get(String(id)),
      saveSession(id, round) { sessions.set(String(id), round); return { ok: true, revision: 0 } },
      save(values) { for (const [id, round] of values) sessions.set(String(id), round); return { ok: true } },
      clear: () => sessions.clear(),
    }
  }
  let degraded = false
  let reported = ''
  const versions = new Map()
  const baseline = new Map()
  const perSession = typeof backend.readSession === 'function' && typeof backend.writeSession === 'function'
  const canonical = round => round === undefined ? null : JSON.stringify(adopt(round))
  const mark = (id, round, revision) => {
    versions.set(id, revision)
    baseline.set(id, canonical(round))
    if (round !== undefined) round[REVISION] = { id, revision }
    return round
  }
  const oldRead = () => {
    const text = backend.read()
    return text === undefined ? new Map() : decode(text)
  }
  const fail = error => {
    const code = error?.code === 'CONFLICT' ? 'CONFLICT' : error?.code === 'CORRUPT_STATE' ? 'CORRUPT_STATE' : error?.code === 'READ_ONLY' ? 'READ_ONLY' : 'IO_ERROR'
    reported = error instanceof Error ? error.message : String(error)
    if (code !== 'CONFLICT') degraded = true
    return { ok: false, code, reason: reported }
  }
  const store = {
    get mode() {
      return degraded ? 'memory' : 'persistent'
    },
    get reason() {
      return reported
    },
    load() {
      try {
        const sessions = new Map()
        if (perSession) {
          for (const [id, record] of backend.readAll()) sessions.set(id, mark(id, record.round, record.revision))
        } else {
          for (const [id, round] of oldRead()) sessions.set(id, mark(id, round, canonical(round)))
        }
        return sessions
      } catch (error) {
        fail(error)
        return new Map()
      }
    },
    loadSession(id) {
      const key = String(id)
      try {
        if (perSession) {
          const record = backend.readSession(key)
          return mark(key, record.round, record.revision)
        }
        const round = oldRead().get(key)
        return mark(key, round, canonical(round))
      } catch (error) {
        fail(error)
        throw error
      }
    },
    saveSession(id, round) {
      if (degraded) return { ok: false, code: 'READ_ONLY', reason: reported || 'storage is unavailable; persisted data was left unchanged' }
      const key = String(id)
      const token = round?.[REVISION]
      const expected = token?.id === key ? token.revision : versions.get(key) ?? (perSession ? 0 : null)
      try {
        let revision
        if (perSession) {
          revision = backend.writeSession(key, round, expected)
        } else {
          const latest = oldRead()
          if (canonical(latest.get(key)) !== expected) throw storageError('CONFLICT', `session ${key} changed since it was loaded; reload before retrying`)
          latest.set(key, round)
          backend.write(encode(latest))
          revision = canonical(round)
        }
        mark(key, round, revision)
        reported = ''
        return { ok: true, revision }
      } catch (error) { return fail(error) }
    },
    save(sessions) {
      const failures = []
      for (const [id, round] of sessions) {
        if (baseline.has(String(id)) && baseline.get(String(id)) === canonical(round)) continue
        const result = store.saveSession(id, round)
        if (!result.ok) failures.push({ id: String(id), ...result })
      }
      return failures.length === 0 ? { ok: true } : { ok: false, failures }
    },
    clear() {
      try {
        backend.clear()
        versions.clear()
        baseline.clear()
        return { ok: true }
      } catch (error) { return fail(error) }
    },
  }
  return store
}
