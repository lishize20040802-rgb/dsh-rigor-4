// The reviewer's structured verdict, parsed from the reviewer's own words.
//
// The three generations before this one let an approval be a magic word: a child's
// last line said VERIFIED and the gate believed the author's summary of it. This
// module is the opposite seam. The child is required to end its final message with
// one JSON block that says, per need, what it actually did and found; the block is
// read out of the child's own session log, and a block that is missing, malformed,
// incomplete or self-contradictory is not a rejection of the work — it is the
// absence of a review, which is exactly what it is reported as.

const STATUSES = Object.freeze(['met', 'not-met', 'not-checked'])
const HOW = Object.freeze(['read', 'ran', 'inspected', 'asked-person', 'artifact'])

/** Whether a parsed value looks like the reviewer's payload at all. */
function looksLikePayload(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.verdict === 'string'
}

/**
 * Pull the reviewer's payload out of the text of its final message.
 * Returns `{ ok, payload, why }`; `why` is written to be handed back to the model.
 */
export function extractReviewPayload(text) {
  const source = String(text ?? '')
  if (source.trim() === '') return { ok: false, why: 'the reviewer wrote no final message at all' }
  // The final candidate is authoritative. Falling back to an earlier valid block
  // can turn a damaged final rework verdict into an obsolete approval.
  const fenced = source.split('```')
  const hasFence = fenced.length > 1
  if (hasFence && (fenced.length - 1) % 2 !== 0) {
    return { ok: false, why: 'the final JSON block is not closed; ask the reviewer to resend its final verdict' }
  }
  const candidate = hasFence
    ? fenced[fenced.length - 2].trim().replace(/^json(?:\s+|$)/i, '').trim()
    : source.trim()
  try {
    const parsed = JSON.parse(candidate)
    if (looksLikePayload(parsed)) return { ok: true, payload: parsed }
  } catch {
    if (hasFence) return { ok: false, why: 'the final JSON block is malformed; earlier verdicts are not used as a fallback' }
  }
  return { ok: false, why: 'no JSON block with a "verdict" field was found in the reviewer\'s final message — the brief asks for one as the last fenced ```json block' }
}

/**
 * Validate the payload against the reading it judges.
 *
 * `needIds` is every need of the current reading; the reviewer has to have an entry
 * for each, and an approval has to be internally consistent — all met, reading
 * confirmed, no rework demanded, and at least one honest sentence about what the
 * passing scripts do NOT prove (the failure this whole generation exists to remove
 * is the equation of "the check passed" with "the person's need is met").
 */
export function validateReviewPayload(payload, { needIds = [], openItems = [], role = 'review' } = {}) {
  const problems = []
  const verdict = payload?.verdict
  if (verdict !== 'approve' && verdict !== 'rework') {
    problems.push('"verdict" must be exactly "approve" or "rework"')
  }
  const cleanRole = role === 'rework-check' ? 'rework-check' : 'review'
  if (payload?.role !== undefined && payload.role !== cleanRole) {
    problems.push(`"role" must match the brief's role "${cleanRole}"`)
  }
  if (typeof payload?.reading_ok !== 'boolean') problems.push('"reading_ok" must be true or false')
  const needs = payload?.needs
  if (!Array.isArray(needs) || needs.length === 0) {
    problems.push('"needs" must be a non-empty array with one entry per need of the reading')
  } else {
    const seen = new Set()
    for (const item of needs) {
      const id = String(item?.id ?? '')
      if (id === '') { problems.push('every needs[] entry needs an "id" (N1, N2 …)'); continue }
      if (seen.has(id)) problems.push(`needs[] names ${id} more than once`)
      seen.add(id)
      if (!needIds.includes(id)) problems.push(`needs[] names ${id}, which is not a need of the current reading`)
      if (!STATUSES.includes(item?.status)) problems.push(`${id}: "status" must be met, not-met or not-checked`)
      if (!HOW.includes(item?.how)) problems.push(`${id}: "how" must be one of ${HOW.join(', ')} — say how the need was examined, not only what ran`)
      if (String(item?.evidence ?? '').trim() === '' && item?.status !== 'not-checked') {
        problems.push(`${id}: a ${item?.status} need carries "evidence" — the concrete thing you saw, not "the tests pass"`)
      }
    }
    for (const id of needIds) if (!seen.has(id)) problems.push(`needs[] is missing ${id} — every need of the reading has to be judged, including the ones that went well`)
  }
  if (!Array.isArray(payload?.script_only) || payload.script_only.length === 0 || payload.script_only.some(item => String(item ?? '').trim() === '')) {
    problems.push('"script_only" must be a non-empty array: at least one sentence saying what the passing commands do NOT prove about the person\'s needs')
  }
  for (const field of ['deviations', 'rework', 'questions']) {
    if (payload?.[field] !== undefined && !Array.isArray(payload[field])) problems.push(`"${field}" must be an array`)
  }
  const rework = Array.isArray(payload?.rework) ? payload.rework.map(item => String(item ?? '').trim()).filter(item => item !== '') : []
  const deviations = Array.isArray(payload?.deviations) ? payload.deviations.map(item => String(item ?? '').trim()).filter(item => item !== '') : []
  const closedItems = Array.isArray(payload?.closed_items) ? payload.closed_items.map(item => String(item ?? '').trim()).filter(item => item !== '') : []
  if (cleanRole !== 'rework-check' && closedItems.length > 0) problems.push('only a rework-check verdict may close rework items')
  if (role === 'rework-check') {
    if (!Array.isArray(payload?.closed_items)) problems.push('a rework-check payload needs "closed_items": the ids it verified as closed (or an empty array)')
    for (const id of closedItems) if (!openItems.includes(id)) problems.push(`closed_items names ${id}, which is not an open rework item`)
    for (const id of openItems) {
      if (!closedItems.includes(id) && !rework.some(item => item.includes(id))) {
        problems.push(`rework item ${id} is neither closed (closed_items) nor still demanded (rework) — say what happened to it`)
      }
    }
  }
  if (verdict === 'approve') {
    if (payload.reading_ok !== true) problems.push('an approval has to confirm the reading ("reading_ok": true); if it cannot, the verdict is "rework"')
    const unmet = Array.isArray(needs) ? needs.filter(item => item?.status !== 'met') : []
    if (unmet.length > 0) problems.push(`an approval cannot carry needs that are not met (${unmet.map(item => item?.id ?? '?').join(', ')}) — approve only when every need is met, otherwise demand rework`)
    if (rework.length > 0) problems.push('an approval that lists rework is not an approval — either demand the rework or close it')
  }
  return { ok: problems.length === 0, problems, normalized: {
    verdict: verdict === 'rework' ? 'rework' : 'approve',
    role: cleanRole,
    readingOk: payload?.reading_ok === true,
    needs: (Array.isArray(needs) ? needs : []).map(item => ({
      id: String(item?.id ?? ''),
      status: STATUSES.includes(item?.status) ? item.status : 'not-checked',
      how: HOW.includes(item?.how) ? item.how : 'inspected',
      evidence: String(item?.evidence ?? '').slice(0, 600),
    })),
    scriptOnly: (Array.isArray(payload?.script_only) ? payload.script_only : []).map(item => String(item ?? '').slice(0, 400)).filter(item => item !== ''),
    deviations: deviations.slice(0, 20).map(item => String(item).slice(0, 400)),
    rework: rework.slice(0, 20).map(item => String(item).slice(0, 400)),
    questions: (Array.isArray(payload?.questions) ? payload.questions : []).map(item => String(item ?? '').slice(0, 400)).filter(item => item !== ''),
    closedItems,
  } }
}
