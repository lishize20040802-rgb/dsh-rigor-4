// Optional delivery strategy and measurements. Pure validation: no IO, coercion,
// truncation, or claims about the provenance of model-supplied measurements.

const LEVELS = ['low', 'medium', 'high']
const KINDS = ['functional', 'integration', 'performance', 'compatibility', 'delivery']
const MAX_SAMPLES = 10000
const MAX_JSON_LENGTH = 128000
const LIST_LIMITS = { options: 4, technology: 16, execution: 64, checks: 64, questions: 32 }
const has = (object, key) => Object.hasOwn(object, key)

function objectAt(value, allowed, path, errors) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    errors.push(`${path} must be a plain object`)
    return {}
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) errors.push(`${path} contains an unknown field: ${String(key)}`)
  }
  return value
}

function stringAt(value, path, errors, max = 1000, { empty = false, trim = true } = {}) {
  if (typeof value !== 'string') { errors.push(`${path} must be a string`); return '' }
  if (value.length > max) errors.push(`${path} exceeds ${max} characters`)
  if (!empty && value.trim() === '') errors.push(`${path} must not be empty`)
  return trim ? value.trim() : value
}

function idAt(value, path, errors) {
  const id = stringAt(value, path, errors, 32)
  if (id !== '' && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) errors.push(`${path} must be a letter-led identifier using letters, digits, underscores or hyphens`)
  return id
}

function enumAt(value, values, path, errors) {
  if (!values.includes(value)) errors.push(`${path} must be one of ${values.join(', ')}`)
  return value
}

function arrayAt(value, path, limit, errors) {
  if (!Array.isArray(value)) { errors.push(`${path} must be an array`); return [] }
  if (value.length > limit) { errors.push(`${path} exceeds ${limit} entries`); return [] }
  for (let index = 0; index < value.length; index++) {
    if (!has(value, index)) { errors.push(`${path} must be a dense array without missing entries`); return [] }
  }
  return value
}

function uniqueIds(items, field, path, errors) {
  const seen = new Set()
  for (const item of items) {
    const id = item[field]
    if (id === '') continue
    if (seen.has(id)) errors.push(`${path} contains duplicate ${field}: ${id}`)
    seen.add(id)
  }
  return seen
}

function metricAt(raw, path, errors) {
  const metric = objectAt(raw, ['unit', 'statistic', 'operator', 'threshold', 'minSamples', 'workload', 'environment'], path, errors)
  const value = {
    // Measurement context is an exact identity, not a fuzzy text comparison.
    unit: stringAt(metric.unit, `${path}.unit`, errors, 64, { trim: false }),
    statistic: enumAt(metric.statistic, ['max', 'mean', 'p95'], `${path}.statistic`, errors),
    operator: enumAt(metric.operator, ['lte', 'gte'], `${path}.operator`, errors),
    threshold: metric.threshold,
    minSamples: metric.minSamples,
    workload: stringAt(metric.workload, `${path}.workload`, errors, 1000, { trim: false }),
    environment: stringAt(metric.environment, `${path}.environment`, errors, 1000, { trim: false }),
  }
  if (typeof value.threshold !== 'number' || !Number.isFinite(value.threshold)) errors.push(`${path}.threshold must be a finite number`)
  if (!Number.isInteger(value.minSamples) || value.minSamples < 1 || value.minSamples > MAX_SAMPLES) errors.push(`${path}.minSamples must be an integer from 1 to ${MAX_SAMPLES}`)
  return value
}

function referenceSet(value, path, errors) {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string')) { errors.push(`${path} must be an array of identifiers`); return new Set() }
  for (let index = 0; index < value.length; index++) {
    if (!has(value, index)) { errors.push(`${path} must be a dense array of identifiers`); return new Set() }
  }
  return new Set(value)
}

function checkCycles(execution, errors) {
  const graph = new Map(execution.map(item => [item.step, item.dependsOn]))
  const state = new Map()
  const visit = step => {
    if (state.get(step) === 1) return true
    if (state.get(step) === 2) return false
    state.set(step, 1)
    for (const dependency of graph.get(step) ?? []) if (visit(dependency)) return true
    state.set(step, 2)
    return false
  }
  if (execution.some(item => visit(item.step))) errors.push('strategy.execution contains a dependency cycle')
}

/** Parse an optional strategy against the current reading and plan identifiers. */
export function parseStrategy(raw, references = {}) {
  if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return { value: null, errors: [] }
  const errors = []
  if (typeof raw === 'string') {
    if (raw.length > MAX_JSON_LENGTH) return { value: null, errors: [`strategy JSON exceeds ${MAX_JSON_LENGTH} characters`] }
    try { raw = JSON.parse(raw) } catch { return { value: null, errors: ['strategy must be valid JSON'] } }
  }
  const strategy = objectAt(raw, ['risk', 'options', 'selected', 'decision', 'technology', 'execution', 'checks', 'questions'], 'strategy', errors)
  const risk = objectAt(strategy.risk, ['impact', 'uncertainty', 'reason'], 'strategy.risk', errors)
  const value = {
    risk: {
      impact: enumAt(risk.impact, LEVELS, 'strategy.risk.impact', errors),
      uncertainty: enumAt(risk.uncertainty, LEVELS, 'strategy.risk.uncertainty', errors),
      reason: stringAt(risk.reason, 'strategy.risk.reason', errors),
    },
    options: [], selected: '', decision: '', technology: [], execution: [], checks: [], questions: [],
  }
  const needIds = referenceSet(references?.needIds ?? [], 'needIds', errors)
  const stepIds = referenceSet(references?.stepIds ?? [], 'stepIds', errors)
  const list = key => has(strategy, key) ? arrayAt(strategy[key], `strategy.${key}`, LIST_LIMITS[key], errors) : []

  value.options = list('options').map((rawOption, index) => {
    const path = `strategy.options[${index}]`
    const item = objectAt(rawOption, ['id', 'title', 'tradeoffs', 'probe'], path, errors)
    return { id: idAt(item.id, `${path}.id`, errors), title: stringAt(item.title, `${path}.title`, errors, 200),
      tradeoffs: stringAt(item.tradeoffs, `${path}.tradeoffs`, errors, 2000), probe: stringAt(item.probe, `${path}.probe`, errors) }
  })
  const optionIds = uniqueIds(value.options, 'id', 'strategy.options', errors)
  if (value.options.length === 1) errors.push('strategy.options must contain 2 to 4 alternatives when nonempty')
  if (has(strategy, 'selected')) value.selected = stringAt(strategy.selected, 'strategy.selected', errors, 32, { empty: value.options.length === 0 })
  if (has(strategy, 'decision')) value.decision = stringAt(strategy.decision, 'strategy.decision', errors, 2000, { empty: value.options.length === 0 })
  if (value.options.length > 0 && value.selected === '') errors.push('strategy.selected is required when alternatives are supplied')
  if (value.selected !== '' && !optionIds.has(value.selected)) errors.push('strategy.selected must reference a supplied option id')
  if (value.options.length > 0 && value.decision === '') errors.push('strategy.decision is required when alternatives are supplied')

  value.technology = list('technology').map((rawTechnology, index) => {
    const path = `strategy.technology[${index}]`
    const item = objectAt(rawTechnology, ['id', 'name', 'version', 'source', 'probe'], path, errors)
    return { id: idAt(item.id, `${path}.id`, errors), name: stringAt(item.name, `${path}.name`, errors, 200),
      version: stringAt(item.version, `${path}.version`, errors, 160), source: stringAt(item.source, `${path}.source`, errors, 2048), probe: stringAt(item.probe, `${path}.probe`, errors) }
  })
  uniqueIds(value.technology, 'id', 'strategy.technology', errors)

  value.execution = list('execution').map((rawExecution, index) => {
    const path = `strategy.execution[${index}]`
    const item = objectAt(rawExecution, ['step', 'dependsOn', 'doneWhen', 'replanWhen'], path, errors)
    const step = idAt(item.step, `${path}.step`, errors)
    if (!stepIds.has(step)) errors.push(`${path}.step references an unknown plan step`)
    const dependsOn = arrayAt(item.dependsOn, `${path}.dependsOn`, 64, errors).map((id, dependencyIndex) => idAt(id, `${path}.dependsOn[${dependencyIndex}]`, errors))
    if (new Set(dependsOn).size !== dependsOn.length) errors.push(`${path}.dependsOn contains duplicate step ids`)
    if (dependsOn.some(id => !stepIds.has(id))) errors.push(`${path}.dependsOn references an unknown plan step`)
    return { step, dependsOn, doneWhen: stringAt(item.doneWhen, `${path}.doneWhen`, errors), replanWhen: stringAt(item.replanWhen, `${path}.replanWhen`, errors) }
  })
  uniqueIds(value.execution, 'step', 'strategy.execution', errors)
  checkCycles(value.execution, errors)

  value.checks = list('checks').map((rawCheck, index) => {
    const path = `strategy.checks[${index}]`
    const item = objectAt(rawCheck, ['id', 'need', 'kind', 'criterion', 'metric'], path, errors)
    const check = { id: idAt(item.id, `${path}.id`, errors), need: idAt(item.need, `${path}.need`, errors),
      kind: enumAt(item.kind, KINDS, `${path}.kind`, errors), criterion: stringAt(item.criterion, `${path}.criterion`, errors) }
    if (!needIds.has(check.need)) errors.push(`${path}.need references an unknown need`)
    if (check.kind === 'performance') check.metric = metricAt(item.metric, `${path}.metric`, errors)
    else if (has(item, 'metric')) errors.push(`${path}.metric is allowed only for performance checks`)
    return check
  })
  uniqueIds(value.checks, 'id', 'strategy.checks', errors)

  value.questions = list('questions').map((rawQuestion, index) => {
    const path = `strategy.questions[${index}]`
    const item = objectAt(rawQuestion, ['id', 'question', 'blocking'], path, errors)
    if (typeof item.blocking !== 'boolean') errors.push(`${path}.blocking must be a boolean`)
    return { id: idAt(item.id, `${path}.id`, errors), question: stringAt(item.question, `${path}.question`, errors), blocking: item.blocking }
  })
  uniqueIds(value.questions, 'id', 'strategy.questions', errors)
  return { value: errors.length === 0 ? value : null, errors }
}

/** Roles for a validated strategy. Counts of steps and files do not select depth. */
export function strategyRoles(strategy) {
  const { impact, uncertainty } = strategy.risk
  return { reviews: impact === 'high' || uncertainty === 'high' ? 2 : 1, clarify: false,
    diverge: uncertainty !== 'low', planReview: impact !== 'low' || uncertainty !== 'low' }
}

function samplesAt(samples, path, minimum, errors) {
  if (!Array.isArray(samples)) { errors.push(`${path} must be an array of finite numbers`); return }
  if (samples.length < 1 || samples.length > MAX_SAMPLES) { errors.push(`${path} must contain 1 to ${MAX_SAMPLES} samples`); return }
  if (samples.length < minimum) errors.push(`${path} has fewer than the required ${minimum} samples`)
  for (let index = 0; index < samples.length; index++) {
    if (typeof samples[index] !== 'number' || !Number.isFinite(samples[index])) { errors.push(`${path}[${index}] must be a finite number`); break }
  }
}

function aggregate(samples, statistic) {
  if (statistic === 'max') return Math.max(...samples)
  if (statistic === 'p95') return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]
  // Scaling keeps the mean finite even when summing finite samples would overflow.
  const scale = Math.max(...samples.map(Math.abs))
  return scale === 0 ? 0 : samples.reduce((sum, sample) => sum + sample / scale, 0) / samples.length * scale
}

/** Validate matching measurement conditions and apply the declared absolute gate. */
export function evaluateMeasurement(metric, report) {
  const errors = []
  const normalized = metricAt(metric, 'metric', errors)
  const measuredReport = objectAt(report, ['unit', 'samples', 'baselineSamples', 'workload', 'environment'], 'report', errors)
  for (const key of ['unit', 'workload', 'environment']) {
    const context = stringAt(measuredReport[key], `report.${key}`, errors, key === 'unit' ? 64 : 1000, { trim: false })
    if (context !== normalized[key]) errors.push(`report.${key} must exactly match metric.${key}`)
  }
  samplesAt(measuredReport.samples, 'report.samples', normalized.minSamples, errors)
  if (has(measuredReport, 'baselineSamples')) samplesAt(measuredReport.baselineSamples, 'report.baselineSamples', normalized.minSamples, errors)
  if (errors.length > 0) return { ok: false, errors }
  const measured = aggregate(measuredReport.samples, normalized.statistic)
  const result = { ok: normalized.operator === 'lte' ? measured <= normalized.threshold : measured >= normalized.threshold, errors, measured }
  if (has(measuredReport, 'baselineSamples')) result.baseline = aggregate(measuredReport.baselineSamples, normalized.statistic)
  if (!result.ok) errors.push(`measurement does not satisfy the declared ${normalized.operator} threshold`)
  return result
}
