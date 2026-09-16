// The round: one request, one reading of it, one plan, the children that were asked,
// the evidence that was linked, the reviews that judged the delivery, and the report.
//
// This is the whole state. There is no phase machine, no cycle, no flow and no
// per-tool obligation — three generations of this plugin died under that weight, and
// every deadlock in them came from a rule about the PROCESS rather than about the
// ANSWER. Here a session is only ever judged when it makes a claim, and every refusal
// names a single call that clears it.
//
// No IO or clock. A round identity may be supplied for deterministic callers.

import { randomUUID } from 'node:crypto'

/** Bumped when the on-disk shape changes. */
export const SHAPE = 2

/** How much of each stream a round keeps. Bounds memory, not obligations. */
export const LIMITS = Object.freeze({
  requests: 40,
  edits: 200,
  commands: 200,
  reads: 200,
  questions: 60,
  answers: 60,
  attempts: 200,
  briefs: 80,
  evidence: 200,
  reviews: 60,
  findings: 60,
  reports: 60,
  history: 8,
})

/** The roles a child can be briefed for. */
export const ROLES = Object.freeze(['clarify', 'diverge', 'plan-review', 'monitor', 'review', 'rework-check'])

/** Roles whose brief is worthless without a reading (and, for most, a plan). */
const NEEDS_READING = Object.freeze(['plan-review', 'monitor', 'review', 'rework-check'])
const NEEDS_PLAN = Object.freeze(['plan-review', 'review', 'rework-check'])

export function createRound(now = 0, roundId = randomUUID()) {
  return {
    shape: SHAPE,
    roundId: String(roundId),
    planVersion: 0,
    workRevision: 0,
    briefSeq: 0,
    reviewSeq: 0,
    reworkSeq: 0,
    seq: 0,
    startedAt: now,
    // What the person said, in order, as the pipeline saw it.
    requests: [],
    // The reading: the literal request, and the needs nobody typed.
    reading: null,
    // What will be done, step by step, and which need each step serves.
    plan: null,
    // Every question a child was asked, and who answered it.
    briefs: [],
    // Facts linked to needs. The plugin verifies the fact; the reviewer judges it.
    evidence: [],
    // The independent judgements, newest last.
    reviews: [],
    // Rework the reviewers demanded, open until a later review closes it.
    rework: [],
    // Facts the pipeline recorded. Never authored by the model.
    facts: { edits: [], commands: [], reads: [], questions: [], answers: [], attempts: [], sawJob: false },
    // Text findings the parent has not yet been shown (monitors, adversaries).
    findings: [],
    reports: [],
    // ── when this session IS a child ──
    // A child runs the same plugin. It reads its own brief from the first user message
    // and enforces the role's mandate in its own tool gate — the one enforcement that
    // cannot go through the host's tool filter, because tools.restrict() accepts only
    // global names and a preset-local name throws there. See index.js pre-execute.
    briefedAs: '',
    briefedTool: '',
    // Summaries of the most recent completed rounds, not full conversation logs.
    history: [],
  }
}

export function snapshotOf(round) {
  return {
    roundId: String(round?.roundId ?? ''),
    readingVersion: Number(round?.reading?.version ?? 0),
    planVersion: Number(round?.planVersion ?? round?.plan?.version ?? 0),
    workRevision: Number(round?.workRevision ?? 0),
  }
}

export function sameSnapshot(a, b) {
  return a !== null && a !== undefined && b !== null && b !== undefined
    && typeof a.roundId === 'string' && a.roundId !== ''
    && ['roundId', 'readingVersion', 'planVersion', 'workRevision'].every(key => a[key] === b[key])
}

/** Preparation can change the reading; delivery reviewers must see exact work. */
export function briefIsCurrent(round, brief) {
  if (brief?.snapshot?.roundId !== round.roundId) return false
  if (['review', 'rework-check'].includes(brief.role)) return sameSnapshot(brief.snapshot, snapshotOf(round))
  if (brief.role === 'monitor') return true
  if (brief.requestSeq !== ((round.requests ?? []).at(-1)?.seq ?? 0)) return false
  return brief.role !== 'plan-review' || brief.snapshot.planVersion === round.planVersion
}

function retainOpen(items, limit, isOpen) {
  const closed = items.filter(item => !isOpen(item))
  const keepClosed = new Set(closed.slice(-Math.max(0, limit - (items.length - closed.length))))
  if (items.length - closed.length >= limit) return items.filter(isOpen)
  return items.filter(item => isOpen(item) || keepClosed.has(item))
}

function nextId(round, counter, list, prefix) {
  return Math.max(Number(round[counter] ?? 0), ...(round[list] ?? []).map(item => Number(String(item.id).replace(new RegExp(`^${prefix}`), '')) || 0)) + 1
}

export function nextSeq(round) {
  const seq = Number(round?.seq ?? 0) + 1
  return { round: { ...round, seq }, seq }
}

export function bounded(list, limit) {
  return list.length <= limit ? list : list.slice(list.length - limit)
}

function push(round, key, value, limit) {
  return { ...round, [key]: bounded([...(round[key] ?? []), value], limit) }
}

/** Path comparison: case-insensitive, forward slashes, no trailing slash. */
export function normalizeTarget(value) {
  return String(value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function fingerprintOf(value) {
  const words = String(value ?? '').trim().toLowerCase().split(/\s+/).filter(word => word !== '')
  return words.slice(0, 24).join(' ').slice(0, 140)
}

// ── the facts, fed from the pipeline ────────────────────────────────────────

export function recordRequest(round, { text, at }) {
  const { round: stepped, seq } = nextSeq(round)
  return push(stepped, 'requests', { seq, at, text: String(text ?? '').slice(0, 4000) }, LIMITS.requests)
}

/** Append to one fact stream. The facts live on an object, so this is not `push`. */
function fact(round, key, entry, limit) {
  return { ...round, facts: { ...round.facts, [key]: bounded([...(round.facts?.[key] ?? []), entry], limit) } }
}

export function recordEdit(round, { target, tool, detail, at }) {
  const { round: stepped, seq } = nextSeq({ ...round, workRevision: Number(round.workRevision ?? 0) + 1 })
  return fact(stepped, 'edits', { seq, at, snapshot: snapshotOf(stepped), target: String(target ?? ''), tool: String(tool ?? ''), detail: String(detail ?? '').slice(0, 160) }, LIMITS.edits)
}

export function recordCommand(round, { cmd, exit, mutationHint, advanceWork = true, at }) {
  const { round: stepped, seq } = nextSeq(mutationHint === true && advanceWork !== false ? { ...round, workRevision: Number(round.workRevision ?? 0) + 1 } : round)
  return fact(stepped, 'commands', { seq, at, snapshot: snapshotOf(stepped), cmd: String(cmd ?? '').slice(0, 400), exit: exit === undefined ? null : exit, mutationHint: mutationHint === true }, LIMITS.commands)
}

export function recordReadFact(round, { ref, at }) {
  const { round: stepped, seq } = nextSeq(round)
  return fact(stepped, 'reads', { seq, at, snapshot: snapshotOf(stepped), ref: String(ref ?? '').slice(0, 400) }, LIMITS.reads)
}

export function recordAttempt(round, { tool, target, outcome = 'failed', possibleMutation = false, at }) {
  const { round: stepped, seq } = nextSeq(possibleMutation === true ? { ...round, workRevision: Number(round.workRevision ?? 0) + 1 } : round)
  return fact(stepped, 'attempts', { seq, at, tool: String(tool ?? ''), target: String(target ?? ''), outcome: outcome === 'denied' ? 'denied' : 'failed', possibleMutation: possibleMutation === true, snapshot: snapshotOf(stepped) }, LIMITS.attempts)
}

export function recordQuestion(round, { questions, at }) {
  const { round: stepped, seq } = nextSeq(round)
  return fact(stepped, 'questions', {
    seq,
    at,
    snapshot: snapshotOf(stepped),
    ids: (Array.isArray(questions) ? questions : []).map(item => String(item?.id ?? '')),
    texts: (Array.isArray(questions) ? questions : []).map(item => String(item?.question ?? '').slice(0, 300)),
  }, LIMITS.questions)
}

export function recordAnswers(round, { answers, at }) {
  const { round: stepped, seq } = nextSeq(round)
  return fact(stepped, 'answers', {
    seq,
    at,
    snapshot: snapshotOf(stepped),
    texts: (Array.isArray(answers) ? answers : []).map(item => [item?.id, item?.selected, item?.custom].flat().map(part => String(part ?? '').trim()).filter(Boolean).join(' / ').slice(0, 300)),
  }, LIMITS.answers)
}

export function recordSawJob(round) {
  if (round.facts.sawJob === true) return round
  return { ...round, facts: { ...round.facts, sawJob: true } }
}

// ── the reading ─────────────────────────────────────────────────────────────

/**
 * Record or revise the reading.
 *
 * `needs` arrive normalised from the tool: `{ kind: 'stated'|'implicit', text, test }`,
 * where `test` is what would show the need is met or that the reading is wrong. A need
 * with no test is refused at the tool, because a belief nobody can check is a belief
 * the person cannot correct. Revising bumps `version`: every plan, brief and review
 * carries the version it was built against, so a reading changed after the work cannot
 * inherit the old approvals.
 */
export function recordReading(round, { literal, needs, unknowns, at, late = false }) {
  const { round: stepped, seq } = nextSeq(round)
  const previous = round.reading
  const version = Number(previous?.version ?? 0) + 1
  const reading = {
    version,
    seq,
    at,
    late: previous === null && late === true,
    hadLateReading: late === true && previous === null || previous?.late === true || previous?.hadLateReading === true,
    literal: String(literal ?? '').slice(0, 2000),
    requestSeq: (round.requests ?? []).length === 0 ? 0 : round.requests[round.requests.length - 1].seq,
    needs: needs.map((item, index) => ({
      id: `N${index + 1}`,
      kind: item.kind === 'stated' ? 'stated' : 'implicit',
      text: String(item.text ?? '').slice(0, 400),
      test: String(item.test ?? '').slice(0, 400),
    })),
    unknowns: (unknowns ?? []).map((item, index) => ({ id: `U${index + 1}`, text: String(item).slice(0, 300) })),
  }
  const revisions = previous === null ? [] : [...(previous.revisions ?? []), {
    at: previous.at,
    version: previous.version,
    late: previous.late === true,
    literal: previous.literal,
    needs: previous.needs,
  }]
  return { round: { ...stepped, reading: { ...reading, revisions: bounded(revisions, 6).slice(-6) } }, reading }
}

/**
 * Record the plan.
 *
 * Every step names the needs it serves and the evidence that will show it worked.
 * A step serving nothing is work nobody asked for; a need served by nothing is a
 * promise the plan does not keep. Both are refused at the tool, and the second is
 * checked again at the claim, because a plan can be recorded before the reading is
 * complete and the reading can change after it.
 */
export function recordPlan(round, { approach, steps, risks, at }) {
  const { round: stepped, seq } = nextSeq(round)
  const version = Number(round.planVersion ?? round.plan?.version ?? 0) + 1
  const plan = {
    version,
    seq,
    at,
    readingVersion: Number(round.reading?.version ?? 0),
    approach: String(approach ?? '').slice(0, 2000),
    steps: steps.map((item, index) => ({
      id: `S${index + 1}`,
      text: String(item.text ?? '').slice(0, 400),
      serves: (item.serves ?? []).map(String),
      evidence: String(item.evidence ?? '').slice(0, 400),
    })),
    risks: (risks ?? []).map(item => String(item).slice(0, 300)),
  }
  return { round: { ...stepped, planVersion: version, plan }, plan }
}

// ── scale: what the work is, counted the way the requirements are ───────────

export function scaleOf(round) {
  const needs = round?.reading?.needs?.length ?? 0
  const steps = round?.plan?.steps?.length ?? 0
  const targets = new Set((round?.facts?.edits ?? []).map(edit => normalizeTarget(edit.target))).size
  return needs + steps + targets
}

/** What this round owes in voices, derived from its own record. */
export function requiredRoles(round) {
  const scale = scaleOf(round)
  return {
    scale,
    reviews: scale <= 4 ? 1 : scale <= 9 ? 2 : 3,
    clarify: scale >= 5,
    diverge: scale >= 5,
    planReview: scale >= 10,
    monitor: round?.facts?.sawJob === true,
  }
}

// ── briefs: the questions a child is asked ──────────────────────────────────

export function openBrief(round, { role, question, serves, at }) {
  const clean = String(role ?? '').trim().toLowerCase()
  if (!ROLES.includes(clean)) {
    return { refusal: refusal('unknown-role', `"${role}" is not a role a child can be briefed for.`, `rigor_brief with one of: ${ROLES.join(', ')}.`) }
  }
  const text = String(question ?? '').trim()
  if (text.length < 40) {
    return { refusal: refusal('brief-too-short', 'a brief that does not say what to examine is a spawn nobody can hold to anything.', `write the question the child must answer, in one sentence of at least 40 characters.`) }
  }
  if (NEEDS_READING.includes(clean) && round.reading === null) {
    return { refusal: refusal('no-reading', `the ${clean} child needs the reading to work from, and none is recorded.`, `call rigor_read first (or rigor_brief(role="clarify") if the reading is what you are still building).`) }
  }
  if (NEEDS_PLAN.includes(clean) && round.plan === null) {
    return { refusal: refusal('no-plan', `the ${clean} child judges against the plan, and none is recorded.`, `call rigor_plan first, then open this brief.`) }
  }
  if (clean === 'rework-check' && openRework(round).length === 0) {
    return { refusal: refusal('no-rework', 'a rework-check brief is for verifying demanded fixes, and no rework is open.', `open a review first (rigor_brief(role="review")), or report as partial.`) }
  }
  const fingerprint = fingerprintOf(text)
  const duplicate = (round.briefs ?? []).find(item => item.state !== 'closed' && item.role === clean && item.fingerprint === fingerprint && briefIsCurrent(round, item))
  if (duplicate !== undefined) {
    return { refusal: refusal('duplicate-brief', `brief ${duplicate.id} already asks this exact question of a child (role ${clean}).`, 'wait for it to report, ask a different question, or revise the reading and ask again.') }
  }
  const { round: stepped, seq } = nextSeq(round)
  const briefSeq = nextId(stepped, 'briefSeq', 'briefs', 'B')
  const id = `B${briefSeq}`
  const brief = {
    id,
    seq,
    at,
    role: clean,
    question: text.slice(0, 1200),
    serves: (serves ?? []).map(String),
    fingerprint,
    // Which spawn tool claimed this brief. A child's capability profile is a property
    // of the tool it was started with, so the record has to carry it.
    tool: '',
    readingVersion: Number(round.reading?.version ?? 0),
    snapshot: snapshotOf(round),
    requestSeq: (round.requests ?? []).at(-1)?.seq ?? 0,
    childId: '',
    state: 'open',
    conclusion: '',
  }
  return { round: { ...stepped, briefSeq, briefs: retainOpen([...(stepped.briefs ?? []), brief], LIMITS.briefs, item => item.state !== 'closed') }, brief }
}

export function claimBrief(round, { briefId, childId, at, tool = '' }) {
  const brief = (round.briefs ?? []).find(item => item.id === briefId)
  if (brief === undefined) {
    return { refusal: refusal('unknown-brief', `no brief ${briefId} is on record.`, 'open one with rigor_brief, then hand its text to the child.') }
  }
  if (brief.state === 'closed') return { refusal: refusal('brief-closed', `brief ${briefId} has already closed.`, 'open a new brief for a new child.') }
  if (brief.state === 'claimed' && brief.childId !== '' && brief.childId !== String(childId ?? '')) {
    return { refusal: refusal('brief-already-claimed', `brief ${briefId} is already held by child ${brief.childId}.`, 'let that child report; open a new brief for another question.') }
  }
  const briefs = round.briefs.map(item => (item.id === briefId
    ? { ...item, state: 'claimed', childId: String(childId ?? ''), claimedAt: at, tool: tool === '' ? item.tool ?? '' : String(tool) }
    : item))
  return { round: { ...round, briefs } }
}

export function closeBriefConclusion(round, { briefId, conclusion, at }) {
  const briefs = round.briefs.map(item => (item.id === briefId && item.state !== 'closed'
    ? { ...item, state: 'closed', conclusion: String(conclusion ?? '').slice(0, 1600), closedAt: at }
    : item))
  return { ...round, briefs }
}

export function openBriefs(round) {
  return (round.briefs ?? []).filter(item => item.state !== 'closed')
}

// ── evidence: a fact of this session, tied to the need it speaks for ────────

export function linkEvidence(round, { need, fact, note, at }) {
  if (fact?.kind === 'artifact' && String(fact?.fingerprint ?? '') !== '') {
    const previous = [...(round.evidence ?? [])].reverse().find(item => item.kind === 'artifact' && normalizeTarget(item.path) === normalizeTarget(fact.path))
    if (previous?.fingerprint && previous.fingerprint !== fact.fingerprint && previous.snapshot?.workRevision === round.workRevision) {
      round = { ...round, workRevision: Number(round.workRevision ?? 0) + 1 }
    }
  }
  const { round: stepped, seq } = nextSeq(round)
  return push(stepped, 'evidence', {
    seq,
    at,
    need: String(need ?? ''),
    kind: String(fact?.kind ?? ''),
    ref: String(fact?.ref ?? ''),
    seqOfFact: Number.isFinite(fact?.seqOfFact) ? fact.seqOfFact : 0,
    path: String(fact?.path ?? ''),
    size: Number.isFinite(fact?.size) ? fact.size : null,
    mtimeMs: Number.isFinite(fact?.mtimeMs) ? fact.mtimeMs : null,
    fingerprint: String(fact?.fingerprint ?? ''),
    factSnapshot: fact?.snapshot ?? null,
    snapshot: snapshotOf(round),
    note: String(note ?? '').slice(0, 400),
  }, LIMITS.evidence)
}

export function evidenceFor(round, needId) {
  return (round.evidence ?? []).filter(item => item.need === String(needId ?? '') && sameSnapshot(item.snapshot, snapshotOf(round)))
}

// ── reviews: the independent judgement ──────────────────────────────────────

export function latestReview(round, version = round?.reading?.version ?? 0) {
  const matching = (round.reviews ?? []).filter(item => item.readingVersion === version && sameSnapshot(item.snapshot, snapshotOf(round)))
  return matching.length === 0 ? null : matching[matching.length - 1]
}

export function openRework(round) {
  return (round.rework ?? []).filter(item => item.status !== 'closed')
}

export function recordReview(round, { briefId, childId, payload, at, childPreset = '', childTool = '' }) {
  const brief = (round.briefs ?? []).find(item => item.id === String(briefId ?? ''))
  if (brief === undefined) return { refusal: refusal('unknown-brief', `no brief ${briefId} is on record.`, 'open and claim a review brief before linking its conclusion.') }
  if (brief.state !== 'claimed' || brief.childId === '' || brief.childId !== String(childId ?? '')) return { refusal: refusal('review-child-mismatch', 'the review must come from the child holding this claimed brief.', 'link the child assigned to this brief, or open a new brief.') }
  if (!['review', 'rework-check'].includes(brief.role) || payload?.role !== brief.role) return { refusal: refusal('review-role-mismatch', 'the review role does not match its brief.', 'use the role of the claimed review brief.') }
  if (!sameSnapshot(brief.snapshot, snapshotOf(round))) return { refusal: refusal('stale-review-brief', 'the reading, plan or work changed after this review was briefed.', 'open a fresh review brief against the current work.') }
  if ((round.reviews ?? []).some(item => item.childId === String(childId) && sameSnapshot(item.snapshot, snapshotOf(round)))) return { refusal: refusal('duplicate-reviewer', 'this child has already reviewed the current work snapshot.', 'use a new child for an independent review.') }
  if (payload.closedItems.length > 0 && brief.role !== 'rework-check') return { refusal: refusal('rework-role-required', 'only a rework-check can close demanded fixes.', 'open a rework-check brief to verify the fixes.') }
  const openIds = new Set(openRework(round).map(item => item.id))
  if (payload.closedItems.some(id => !openIds.has(id))) return { refusal: refusal('unknown-rework', 'the review names a fix that is not currently open.', 'close only the open rework ids named by the brief.') }
  const { round: stepped, seq } = nextSeq(round)
  const reviews = stepped.reviews ?? []
  const reviewSeq = nextId(stepped, 'reviewSeq', 'reviews', 'V')
  const id = `V${reviewSeq}`
  const review = {
    id,
    seq,
    at,
    briefId: String(briefId ?? ''),
    childId: String(childId ?? ''),
    role: payload.role,
    // Which base preset the child actually ran under, read from ITS session header, and
    // which spawn tool opened it. The host inherits the parent's preset today, so the
    // preset is a fact about the child rather than a choice — recorded, not assumed.
    childPreset: String(childPreset ?? ''),
    childTool: String(childTool ?? ''),
    readingVersion: Number(round.reading?.version ?? 0),
    snapshot: snapshotOf(round),
    verdict: payload.verdict,
    readingOk: payload.readingOk === true,
    needs: payload.needs.map(item => ({ ...item })),
    scriptOnly: [...payload.scriptOnly],
    deviations: [...payload.deviations],
    questions: [...payload.questions],
    closedItems: [...payload.closedItems],
  }
  // Close what the reviewer verified, open what it demanded. The order matters:
  // a rework-check may both close old items and demand new ones.
  const closedNow = []
  let rework = (round.rework ?? []).map(item => {
    if (item.status === 'closed') return item
    if (!review.closedItems.includes(item.id)) return item
    closedNow.push(item.id)
    return { ...item, status: 'closed', closedBy: id, closedAt: at }
  })
  const opened = []
  let reworkSeq = Number(round.reworkSeq ?? 0)
  for (const text of payload.rework) {
    reworkSeq = nextId({ ...round, reworkSeq, rework }, 'reworkSeq', 'rework', 'R')
    const itemId = `R${reworkSeq}`
    const item = { id: itemId, at, text: String(text).slice(0, 400), from: id, status: 'open' }
    rework = retainOpen([...rework, item], LIMITS.reviews, entry => entry.status !== 'closed')
    opened.push(itemId)
  }
  const briefs = (stepped.briefs ?? []).map(item => (item.id === briefId
    ? { ...item, childId: item.childId === '' ? String(childId ?? '') : item.childId, state: 'closed', conclusion: `${review.verdict} (${id})`, closedAt: at }
    : item))
  return {
    round: { ...stepped, reviewSeq, reworkSeq, briefs, reviews: bounded([...reviews, review], LIMITS.reviews), rework },
    review,
    opened,
    closed: closedNow,
  }
}

// ── the report: the account ─────────────────────────────────────────────────

export function recordReport(round, { status, perNeed, gaps, limitations, readingConfirmed, at }) {
  const { round: stepped, seq } = nextSeq(round)
  const report = {
    seq,
    at,
    status,
    snapshot: snapshotOf(round),
    readingConfirmed: readingConfirmed === 'yes' ? 'yes' : 'no',
    perNeed: perNeed.map(item => ({ ...item })),
    gaps: (gaps ?? []).map(item => String(item).slice(0, 400)),
    // What this session could not do because its preset lacks the channel to do it.
    // A limitation that is declared is a fact about the base the discipline is mounted
    // on; one that is left out is a claim that does not hold. See `evaluateDone`.
    limitations: (limitations ?? []).map(item => String(item).slice(0, 400)),
  }
  return { round: push(stepped, 'reports', report, LIMITS.reports), report }
}

// ── the gate: may this claim stand? ─────────────────────────────────────────

function refusal(code, detail, exit) {
  return { code, detail, exit }
}

function childRolesMissing(round, roles) {
  const closed = new Set((round.briefs ?? []).filter(item => item.state === 'closed' && briefIsCurrent(round, item)).map(item => item.role))
  const missing = []
  if (roles.clarify && !closed.has('clarify')) missing.push(['clarify', 'nobody was briefed to draw out what the person left unsaid — the reading is one model talking to itself.'])
  if (roles.diverge && !closed.has('diverge')) missing.push(['diverge', 'nobody attacked the reading, so the first interpretation hardened into the requirement unexamined.'])
  if (roles.planReview && !closed.has('plan-review')) missing.push(['plan-review', 'the plan was never attacked: no child checked that a step serves no need, or that a need has no step.'])
  if (roles.monitor && !closed.has('monitor')) missing.push(['monitor', 'a background job ran in this round and no child watched the execution for drift while it happened.'])
  return missing
}

/**
 * Whether a `done` claim may be recorded.
 *
 * Every branch returns a refusal that names ONE call closing it, and no branch can
 * only be cleared by waiting or by work the session no longer has the context to do:
 * `partial` and `blocked` are always recordable, so a session that cannot clear a
 * refusal can still tell the truth.
 *
 * `options.capabilities` is what the preset the discipline is mounted on can actually
 * do. Standard, PTC and cordis presets carry the subagent and question channels; a
 * minimal preset carries neither, and the gate must not demand a child that base
 * cannot spawn — it demands the limitation be declared instead. A rule that cannot be
 * satisfied is not discipline, it is a deadlock; the three earlier generations were
 * full of them.
 */
export function evaluateDone(round, options = {}) {
  const refusals = []
  const reading = round.reading
  const plan = round.plan
  const roles = requiredRoles(round)
  const capabilities = { children: true, person: true, ...(options.capabilities ?? {}) }
  const limitations = (options.limitations ?? []).map(item => String(item ?? '').trim()).filter(item => item !== '')
  const latest = latestReview(round, reading?.version ?? 0)

  if (reading === null) {
    refusals.push(refusal('no-reading', 'a completed claim needs a reading of what the person meant: the literal request plus the needs they never typed.', 'call rigor_read(literal=..., needs="stated: ... => ... | implicit: ... => ...") — one call.'))
    return { ok: false, refusals, roles }
  }
  if (reading.late === true) {
    refusals.push(refusal('late-reading', 'the reading was recorded after work had already started, so it may describe what got built rather than what was asked. A reading written after the fact cannot catch the deviation it exists to catch.', 'revise it as a genuine reading of the person\'s words (calling rigor_read again records a revision), or report partial naming the deviation.'))
  }
  if (plan === null) {
    refusals.push(refusal('no-plan', 'no plan is on record, so nothing shows the work was aimed at the needs rather than at the request.', 'call rigor_plan(approach=..., steps="... => serves N1 => evidence ...").'))
  }
  if (plan !== null && plan.readingVersion !== reading.version) {
    refusals.push(refusal('stale-plan', `the plan was written against reading v${plan.readingVersion}; the reading is now v${reading.version}.`, 're-record the plan against the current reading (rigor_plan), then re-review.'))
  }
  if (plan !== null) {
    const served = new Set(plan.steps.flatMap(step => step.serves))
    const unserved = reading.needs.filter(need => !served.has(need.id)).map(need => need.id)
    if (unserved.length > 0) {
      refusals.push(refusal('unserved-need', `${unserved.join(', ')} ${unserved.length === 1 ? 'is' : 'are'} named as needs and served by no step of the plan.`, 'add the step that serves them (rigor_plan), or revise the reading to say they are not in scope.'))
    }
  }

  if (capabilities.children !== false) {
    for (const [role, why] of childRolesMissing(round, roles)) {
      refusals.push(refusal(`no-${role}`, why, `open a ${role} brief (rigor_brief(role="${role}")), hand it to a NEW child, and let it report before claiming again.`))
    }
    const reviewRoles = new Set((round.reviews ?? []).filter(item => ['review', 'rework-check'].includes(item.role) && item.verdict === 'approve' && item.readingOk === true && sameSnapshot(item.snapshot, snapshotOf(round))).map(item => item.childId).filter(Boolean)).size
    if (latest === null || reviewRoles < roles.reviews) {
      refusals.push(refusal('no-review', `${roles.reviews} independent review(s) are owed for a ${roles.scale}-scale round; ${reviewRoles} finished. The author cannot be the only judge of whether the person's needs are met.`, 'open a review brief (rigor_brief(role="review")), hand it the reading, the plan, the evidence and the artifacts, then link its conclusion with rigor_review.'))
    }
    if (latest !== null) {
      if (latest.verdict !== 'approve') {
        refusals.push(refusal('review-not-approving', `the newest review (${latest.id}) says "rework", not approve.`, 'do the demanded work, then open a rework-check brief (rigor_brief(role="rework-check")) and link its conclusion with rigor_review.'))
      }
      if (latest.readingOk !== true) {
        refusals.push(refusal('reading-unconfirmed', `the reviewer could not confirm the reading against the person's own words (${latest.id}).`, 'ask the person the question the reviewer named, revise the reading if it was wrong, and re-review.'))
      }
      const status = new Map(latest.needs.map(item => [item.id, item.status]))
      const unmet = reading.needs.filter(need => status.get(need.id) !== 'met')
      if (unmet.length > 0) {
        refusals.push(refusal('unmet-need', `${unmet.map(need => `${need.id} (${status.get(need.id) ?? 'not reviewed'})`).join(', ')} — the reviewer did not find these met.`, 'close what is missing and re-review, or report partial naming each one.'))
      }
    }
    const open = openRework(round)
    if (open.length > 0) {
      refusals.push(refusal('open-rework', `${open.length} demanded fix(es) are still open: ${open.map(item => `${item.id} "${item.text}"`).join('; ')}.`, 'close each with a rework-check review, or report partial naming them. An approval that ignored them would be the false statement this whole file exists to prevent.'))
    }
  }

  const unlinked = reading.needs.filter(need => evidenceFor(round, need.id).length === 0)
  if (unlinked.length > 0) {
    refusals.push(refusal('no-evidence', `${unlinked.map(need => need.id).join(', ')} have no recorded fact linked to them, so the claim that they are met rests on prose.`, 'call rigor_evidence(needs=..., ref=...) for each — it must name a fact this session actually recorded (#seq, cmd:..., read:... or artifact:...).'))
  }

  if (options.readingConfirmed === 'yes') {
    const asked = (round.facts?.questions ?? []).find(item => item.seq > reading.seq)
    const answered = asked !== undefined && (round.facts?.answers ?? []).some(item => item.seq > asked.seq)
    if (!asked || !answered) {
      refusals.push(refusal('unconfirmed-claim', 'the report says the person confirmed this reading, and no question went out and came back after the reading was recorded.', 'ask the person (ask_user_question), then re-report; or say honestly that the reading was not confirmed (reading_confirmed="no").'))
    }
  } else if (roles.scale >= 5 && capabilities.person !== false) {
    refusals.push(refusal('unconfirmed-reading', `this is ${roles.scale}-scale work and the reading was never confirmed by the person, so the whole round may be built on a misreading nothing but the author has checked.`, 'ask the person one question that would falsify the reading (ask_user_question), then re-report with their answer; or report partial naming the unconfirmed assumption.'))
  }

  if ((capabilities.children === false || capabilities.person === false) && limitations.length === 0) {
    const missing = []
    if (capabilities.children === false) missing.push('no subagent channel: no child was briefed and no independent review happened')
    if (capabilities.person === false) missing.push('no question channel: the person could not be asked to confirm the reading')
    refusals.push(refusal('undeclared-limitation', `this preset cannot provide ${missing.join('; ')}, and the report does not say so. A done claim on a base that cannot run the full discipline has to carry that fact where a reader will see it.`, `add limitations="..." to rigor_report, naming what this preset could not do. ${missing.join('; ')}.`))
  }

  const byNeed = new Map((options.perNeed ?? []).map(item => [item.id, item.status]))
  const notMet = reading.needs.filter(need => byNeed.get(need.id) !== 'met')
  if (notMet.length > 0) {
    refusals.push(refusal('report-not-met', `${notMet.map(need => `${need.id} (${byNeed.get(need.id) ?? 'not named'})`).join(', ')} — a done claim has to name every need met, matching the reviewer, not just the ones that went well.`, 'report partial and name these, or finish them and re-review.'))
  }
  return { ok: refusals.length === 0, refusals, roles }
}

// ── round boundaries ────────────────────────────────────────────────────────

/**
 * Close one round and open the next, keeping the person's words and decisions.
 *
 * A round is archived when a NEW request arrives after the previous one was reported
 * on — not on a restart and not on a timer. Restarting must not be a way to erase
 * either a debt or a reading; and a request that arrives while the previous work was
 * never reported means the two belong to the same round, because the person is still
 * talking about the same task.
 */
export function archiveRound(round, { at, reason = 'a new request arrived after the previous round was reported' }) {
  const entry = {
    at,
    reason,
    literal: round.reading === null ? '' : round.reading.literal.slice(0, 300),
    needs: (round.reading?.needs ?? []).length,
    reviews: (round.reviews ?? []).length,
    reports: (round.reports ?? []).length,
    steps: (round.plan?.steps ?? []).length,
    edits: (round.facts?.edits ?? []).length,
  }
  const fresh = createRound(at)
  return {
    ...fresh,
    seq: Number(round.seq ?? 0),
    startedAt: at,
    history: bounded([...(round.history ?? []), entry], LIMITS.history),
  }
}

export function needsNewRound(round, { newTask = false } = {}) {
  if (newTask) return true
  const latest = (round.reports ?? []).at(-1)
  return latest?.status === 'done' && sameSnapshot(latest.snapshot, snapshotOf(round))
}

/** The one-line shape of the round, for tool results and advisory text. */
export function summarize(round, capabilities = { children: true, person: true }) {
  const roles = requiredRoles(round)
  const latest = latestReview(round, round?.reading?.version ?? 0)
  return {
    requests: (round.requests ?? []).length,
    reading: round.reading === null ? null : { version: round.reading.version, needs: round.reading.needs.length, late: round.reading.late === true, literal: round.reading.literal.slice(0, 80) },
    plan: round.plan === null ? null : { steps: round.plan.steps.length, readingVersion: round.plan.readingVersion },
    briefs: (round.briefs ?? []).map(item => `${item.id} ${item.role} ${item.state}${item.childId === '' ? '' : ` child=${item.childId}`}`),
    evidence: (round.evidence ?? []).length,
    reviews: (round.reviews ?? []).map(item => `${item.id} ${item.role} ${item.verdict}`),
    latestReview: latest === null ? null : { id: latest.id, verdict: latest.verdict, readingOk: latest.readingOk },
    openRework: openRework(round).map(item => item.id),
    scale: roles.scale,
    owes: roles,
    capabilities,
    edits: (round.facts?.edits ?? []).length,
    commands: (round.facts?.commands ?? []).length,
    reports: (round.reports ?? []).length,
  }
}
