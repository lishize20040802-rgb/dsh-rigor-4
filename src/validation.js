// Validation reports are small local artifacts. Their contents describe observations;
// the host supplies command facts and file hashes. Reviewers still judge relevance.
import { evaluateMeasurement } from './strategy.js'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max
const fields = (value, allowed) => Object.keys(value).every(key => allowed.includes(key))

export function checkTemplate(check) {
  return {
    check: check.id,
    status: 'passed',
    observed: 'Describe the actual result and its limits.',
    environment: check.metric?.environment ?? 'Runtime, dependencies and platform used.',
    subject: { path: 'path/to/the/file-actually-tested', sha256: '<64 hex characters>' },
    ...(check.metric ? { measurement: {
      unit: check.metric.unit, workload: check.metric.workload,
      environment: check.metric.environment, samples: [],
    } } : {}),
  }
}

/** Read a bounded report and bind it to the current run and tested file. */
export function validateCheckReport({ check, fact, runFact, round, deps, agent }) {
  const refuse = message => ({ refusal: message })
  if (fact.kind !== 'artifact' || !fact.fingerprint) return refuse('A check needs a fingerprinted artifact:<report.json> reference.')
  if (fact.size > 262144) return refuse('A validation report must be at most 256 KiB; keep raw recordings and large logs separate.')
  if (runFact?.kind !== 'command') return refuse('run must reference a command actually recorded in this session (#seq or cmd:fragment).')
  const command = (round.facts?.commands ?? []).find(item => item.seq === runFact.seqOfFact)
  if (!command || command.seq <= (round.plan?.seq ?? 0)) return refuse('Run the check after declaring its acceptance conditions in rigor_plan.')
  let loaded
  try { loaded = deps.readArtifact(fact.path, agent) } catch { return refuse('The validation report could not be read as bounded JSON.') }
  if (loaded?.fingerprint !== fact.fingerprint) return refuse('The validation report changed while being inspected. Finish writing it and retry.')
  const report = loaded.data
  if (!object(report) || !fields(report, ['check', 'status', 'observed', 'environment', 'subject', 'measurement'])) return refuse('The report must be an object with check, status, observed, environment, subject and optional measurement.')
  if (report.check !== check.id) return refuse(`The report must identify check ${check.id}.`)
  if (!['passed', 'failed'].includes(report.status)) return refuse('Report status must be passed or failed.')
  if (!nonempty(report.observed, 2000) || !nonempty(report.environment, 1000)) return refuse('Report observed and environment must be nonempty strings (limits: 2000 and 1000 characters).')
  if (!object(report.subject) || !fields(report.subject, ['path', 'sha256'])
    || !nonempty(report.subject.path, 4096) || typeof report.subject.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/i.test(report.subject.sha256)) return refuse('subject must contain the tested file path and its 64-character SHA256.')
  let subject
  try { subject = deps.stat(report.subject.path, agent) } catch { subject = null }
  const fingerprint = `sha256:${report.subject.sha256.toLowerCase()}`
  if (subject?.exists !== true || subject.isFile === false || subject.changedDuringRead || subject.fingerprint !== fingerprint) return refuse('The tested subject is missing, changed, or does not match the report SHA256. Verify the actual installed/running artifact.')
  const errors = []
  if (command.exit !== 0) errors.push('The recorded validation command did not exit successfully.')
  if (report.status === 'failed') errors.push('The report states the check failed.')
  let measurement = null
  if (check.metric) {
    measurement = evaluateMeasurement(check.metric, report.measurement)
    errors.push(...measurement.errors)
    if (report.environment !== check.metric.environment) errors.push('Report environment differs from the planned metric environment.')
  } else if (report.measurement !== undefined) {
    return refuse('A measurement needs a performance check and metric declared in the plan.')
  }
  return { validation: {
    status: errors.length === 0 ? 'passed' : 'failed',
    observed: report.observed,
    environment: report.environment,
    commandSeq: command.seq,
    subject: { path: String(subject.path ?? report.subject.path), fingerprint },
    ...(Number.isFinite(measurement?.measured) ? { measured: measurement.measured } : {}),
    ...(Number.isFinite(measurement?.baseline) ? { baseline: measurement.baseline } : {}),
    errors,
  } }
}

/** Recheck each distinct report/subject once, even when it serves several needs. */
export function verifyArtifacts(evidence, deps, agent) {
  const latestChecks = new Map()
  for (const item of evidence) if (item.check) latestChecks.set(`${item.check}:${item.need}`, item)
  evidence = evidence.filter(item => !item.check || latestChecks.get(`${item.check}:${item.need}`) === item)
  const verified = new Map()
  const boundedReports = new Set(evidence.filter(item => item.check && item.kind === 'artifact').map(item => String(item.path)))
  for (const item of evidence) {
    const files = [
      ...(item.kind === 'artifact' ? [{ path: item.path, fingerprint: item.fingerprint }] : []),
      ...(item.validation?.subject ? [item.validation.subject] : []),
    ]
    for (const file of files) {
      const key = String(file.path)
      let info = verified.get(key)
      if (info === undefined) {
        try { info = deps.stat(file.path, agent, boundedReports.has(key) ? { maxBytes: 262144 } : {}) } catch { info = null }
        verified.set(key, info)
      }
      if (info?.exists !== true || info.isFile === false || info.changedDuringRead === true || info.tooLarge === true
        || (file.fingerprint && info.fingerprint !== file.fingerprint)) return { ok: false, path: file.path }
    }
  }
  return { ok: true }
}
