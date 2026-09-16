import test from 'node:test'
import assert from 'node:assert/strict'
import { parseStrategy, strategyRoles, evaluateMeasurement } from '../src/strategy.js'

const refs = { needIds: ['N1', 'N2'], stepIds: ['S1', 'S2', 'S3'] }
const risk = { impact: 'low', uncertainty: 'low', reason: 'Bounded reversible work' }
const metric = { unit: 'ms', statistic: 'p95', operator: 'lte', threshold: 20, minSamples: 3, workload: 'fixed fixture v1', environment: 'runtime 24 / runner A' }
const option = id => ({ id, title: `Candidate ${id}`, tradeoffs: 'Lower setup cost but more runtime work', probe: 'Measure the same fixture' })
const execution = (step, dependsOn = []) => ({ step, dependsOn, doneWhen: 'Associated checks pass', replanWhen: 'The documented assumption fails' })
const check = (id = 'C1', kind = 'functional') => ({ id, need: 'N1', kind, criterion: 'Recorded output satisfies the requirement', ...(kind === 'performance' ? { metric: { ...metric } } : {}) })
const report = (samples, extra = {}) => ({ unit: metric.unit, workload: metric.workload, environment: metric.environment, samples, ...extra })
const parse = value => parseStrategy(value, refs)
const reject = (value, pattern) => {
  const result = parse(value)
  assert.equal(result.value, null)
  assert.ok(result.errors.length > 0)
  if (pattern) assert.match(result.errors.join('; '), pattern)
}

test('omitted strategy preserves legacy behavior; supplied null is not omission', () => {
  for (const raw of [undefined, '', ' \n\t']) assert.deepEqual(parse(raw), { value: null, errors: [] })
  for (const raw of [null, false, 0, [], 'null', '[]', '{broken']) reject(raw)
})

test('minimal strategy requires risk and normalizes optional collections', () => {
  const result = parse({ risk: { ...risk, reason: '  Bounded reversible work  ' } })
  assert.deepEqual(result, { value: { risk, options: [], selected: '', decision: '', technology: [], execution: [], checks: [], questions: [] }, errors: [] })
  reject({}, /strategy.risk/)
  for (const field of ['impact', 'uncertainty', 'reason']) {
    const incomplete = { ...risk }; delete incomplete[field]
    reject({ risk: incomplete })
  }
  reject({ risk: { ...risk, impact: 'LOW' } }, /impact/)
})

test('complete JSON strategy retains references and has no shared mutable objects', () => {
  const input = { risk, options: [option('A'), option('B')], selected: 'B', decision: 'The probe supports B',
    technology: [{ id: 'T1', name: 'Host API', version: '1.2.3', source: 'local official package declarations', probe: 'Exercise the installed export' }],
    execution: [execution('S3', ['S2']), execution('S1'), execution('S2', ['S1'])],
    checks: [check(), check('C2', 'performance')], questions: [{ id: 'Q1', question: 'Which boundary applies?', blocking: true }] }
  const serialized = JSON.stringify(input)
  assert.deepEqual(parse(serialized), parse(input))
  assert.equal(parse(input).errors.length, 0)
  const parsed = parse(input).value
  parsed.execution[0].dependsOn.push('S1')
  parsed.checks[1].metric.unit = 'seconds'
  assert.equal(JSON.stringify(input), serialized)
})

test('unknown fields are rejected at every strategy schema level', () => {
  const variants = [
    { risk, extra: true }, { risk: { ...risk, extra: true } },
    { risk, options: [{ ...option('A'), extra: true }, option('B')], selected: 'A', decision: 'Chosen by probe' },
    { risk, technology: [{ id: 'T1', name: 'API', version: '1', source: 'declaration', probe: 'Check export', extra: true }] },
    { risk, execution: [{ ...execution('S1'), extra: true }] },
    { risk, checks: [{ ...check(), extra: true }] },
    { risk, checks: [{ ...check('C1', 'performance'), metric: { ...metric, relativeImprovement: 20 } }] },
    { risk, questions: [{ id: 'Q1', question: 'Boundary?', blocking: false, extra: true }] },
  ]
  for (const value of variants) reject(value, /unknown field/)
})

test('invalid object types and array fields are not coerced', () => {
  for (const value of [new Date(), new Map(), Object.create({ risk })]) reject(value, /plain object/)
  for (const field of ['options', 'technology', 'execution', 'checks', 'questions']) reject({ risk, [field]: null }, /array/)
  reject({ risk, questions: [{ id: 'Q1', question: 'Boundary?', blocking: 'false' }] }, /boolean/)
  reject({ risk, execution: [{ ...execution('S1'), dependsOn: 'S2' }] }, /array/)
  reject({ risk, checks: [null] }, /plain object/)
})

test('alternatives require a real comparison and a declared supported selection', () => {
  assert.equal(parse({ risk, options: [] }).errors.length, 0)
  reject({ risk, options: [option('A')], selected: 'A', decision: 'Chosen' }, /2 to 4/)
  reject({ risk, options: [option('A'), option('B')] }, /selected.*required.*decision.*required/)
  reject({ risk, options: [option('A'), option('B')], selected: 'C', decision: 'Chosen' }, /reference/)
  reject({ risk, selected: 'A' }, /reference/)
  const four = { risk, options: ['A', 'B', 'C', 'D'].map(option), selected: 'A', decision: 'Same fixture favored A' }
  assert.equal(parse(four).errors.length, 0)
  reject({ ...four, options: [...four.options, option('E')] }, /exceeds 4/)
})

test('duplicate identifiers are refused in every collection', () => {
  reject({ risk, options: [option('A'), option(' A ')], selected: 'A', decision: 'Chosen' }, /duplicate/)
  const technology = { id: 'T1', name: 'API', version: '1', source: 'declaration', probe: 'Check export' }
  reject({ risk, technology: [technology, technology] }, /duplicate/)
  reject({ risk, execution: [execution('S1'), execution('S1')] }, /duplicate/)
  reject({ risk, checks: [check(), check()] }, /duplicate/)
  const question = { id: 'Q1', question: 'Boundary?', blocking: false }
  reject({ risk, questions: [question, question] }, /duplicate/)
})

test('identifier syntax and unknown need/step references are rejected', () => {
  reject({ risk, checks: [{ ...check(), id: 'bad id' }] }, /identifier/)
  reject({ risk, checks: [{ ...check(), need: 'N9' }] }, /unknown need/)
  reject({ risk, execution: [execution('S9')] }, /unknown plan step/)
  reject({ risk, execution: [execution('S1', ['S9'])] }, /unknown plan step/)
  reject({ risk, execution: [execution('S1', ['S2', 'S2'])] }, /duplicate/)
})

test('dependency validation accepts unsorted DAGs and implicit plan vertices', () => {
  assert.equal(parse({ risk, execution: [execution('S3', ['S2', 'S1']), execution('S2', ['S1']), execution('S1')] }).errors.length, 0)
  assert.equal(parse({ risk, execution: [execution('S3', ['S1'])] }).errors.length, 0)
})

test('dependency validation rejects self loops and multi-step cycles', () => {
  for (const steps of [[execution('S1', ['S1'])], [execution('S1', ['S2']), execution('S2', ['S1'])],
    [execution('S1', ['S3']), execution('S2', ['S1']), execution('S3', ['S2'])]]) reject({ risk, execution: steps }, /cycle/)
})

test('string and collection limits fail without returning a truncated strategy', () => {
  reject({ risk: { ...risk, reason: 'a'.repeat(1001) } }, /exceeds/)
  reject({ risk, checks: Array.from({ length: 65 }, (_, i) => check(`C${i + 1}`)) }, /exceeds/)
  reject({ risk, questions: Array.from({ length: 33 }, (_, i) => ({ id: `Q${i + 1}`, question: 'A boundary?', blocking: false })) }, /exceeds/)
  reject(' '.repeat(128001) + JSON.stringify({ risk }), /JSON exceeds/)
  reject({ risk, checks: [{ ...check(), criterion: '   ' }] }, /must not be empty/)
})

test('performance checks alone carry required metrics', () => {
  for (const kind of ['functional', 'integration', 'compatibility', 'delivery']) {
    assert.equal(parse({ risk, checks: [check('C1', kind)] }).errors.length, 0)
    reject({ risk, checks: [{ ...check('C1', kind), metric }] }, /only for performance/)
  }
  const performance = check('C1', 'performance')
  delete performance.metric
  reject({ risk, checks: [performance] }, /metric/)
  reject({ risk, checks: [{ ...check(), kind: 'security' }] }, /kind/)
})

test('metric thresholds and sample requirements are finite and achievable', () => {
  for (const threshold of ['20', NaN, Infinity, -Infinity, null]) reject({ risk, checks: [{ ...check('C1', 'performance'), metric: { ...metric, threshold } }] }, /finite number/)
  for (const minSamples of [0, -1, 1.5, '3', 10001, Infinity]) reject({ risk, checks: [{ ...check('C1', 'performance'), metric: { ...metric, minSamples } }] }, /minSamples/)
  for (const [key, value] of [['statistic', 'median'], ['operator', '<'], ['unit', 1]]) reject({ risk, checks: [{ ...check('C1', 'performance'), metric: { ...metric, [key]: value } }] })
})

test('risk roles use impact and uncertainty rather than requirement counts', () => {
  assert.deepEqual(strategyRoles({ risk }), { reviews: 1, clarify: false, diverge: false, planReview: false })
  assert.deepEqual(strategyRoles({ risk: { ...risk, impact: 'medium' } }), { reviews: 1, clarify: false, diverge: false, planReview: true })
  assert.deepEqual(strategyRoles({ risk: { ...risk, uncertainty: 'medium' } }), { reviews: 1, clarify: false, diverge: true, planReview: true })
  for (const [impact, uncertainty] of [['high', 'low'], ['low', 'high'], ['high', 'high']]) {
    const roles = strategyRoles({ risk: { ...risk, impact, uncertainty } })
    assert.equal(roles.reviews, 2)
    assert.equal(roles.clarify, false)
    assert.equal(roles.diverge, uncertainty !== 'low')
  }
})

test('max and mean compare absolute inclusive thresholds in either direction', () => {
  assert.deepEqual(evaluateMeasurement({ ...metric, statistic: 'max' }, report([1, 20, 3])), { ok: true, errors: [], measured: 20 })
  const failed = evaluateMeasurement({ ...metric, statistic: 'max' }, report([1, 21, 3]))
  assert.equal(failed.ok, false); assert.equal(failed.measured, 21); assert.match(failed.errors.join(), /threshold/)
  const mean = evaluateMeasurement({ ...metric, statistic: 'mean', operator: 'gte', threshold: 2 }, report([1, 2, 3]))
  assert.equal(mean.ok, true); assert.equal(mean.measured, 2)
  assert.equal(evaluateMeasurement({ ...metric, statistic: 'mean', operator: 'gte', threshold: 3 }, report([1, 2, 3])).ok, false)
})

test('p95 uses nearest rank, not interpolation or the maximum', () => {
  const samples = Array.from({ length: 20 }, (_, i) => 20 - i)
  const before = [...samples]
  const result = evaluateMeasurement({ ...metric, threshold: 19 }, report(samples))
  assert.equal(result.ok, true); assert.equal(result.measured, 19)
  assert.deepEqual(samples, before)
  assert.equal(evaluateMeasurement({ ...metric, minSamples: 1 }, report([7])).measured, 7)
  assert.equal(evaluateMeasurement(metric, report([3, 1, 2])).measured, 3)
})

test('measurement refuses mismatched unit, workload or environment without coercion', () => {
  for (const key of ['unit', 'workload', 'environment']) for (const value of [report([1, 2, 3])[key] + ' ', '', 1]) {
    const result = evaluateMeasurement(metric, report([1, 2, 3], { [key]: value }))
    assert.equal(result.ok, false); assert.ok(result.errors.some(error => error.includes(key))); assert.equal(result.measured, undefined)
  }
})

test('measurement rejects missing, insufficient, oversized and fabricated sample types', () => {
  for (const samples of [undefined, null, '1,2,3', new Float64Array([1, 2, 3]), [], [1, 2], [1, '2', 3], [1, true, 3], [1, null, 3],
    [1, NaN, 3], [1, Infinity, 3], [1, -Infinity, 3], Array(3), Array(10001).fill(1)]) {
    const result = evaluateMeasurement(metric, report(samples))
    assert.equal(result.ok, false); assert.ok(result.errors.length > 0); assert.equal(result.measured, undefined)
  }
  assert.equal(evaluateMeasurement({ ...metric, minSamples: 10000 }, report(Array(10000).fill(1))).ok, true)
})

test('invalid measurement schemas cannot accidentally pass', () => {
  for (const invalidMetric of [null, {}, { ...metric, minSamples: 0 }, { ...metric, operator: 'eq' }, { ...metric, threshold: '20' }, { ...metric, extra: 1 }]) {
    assert.equal(evaluateMeasurement(invalidMetric, report([1, 2, 3])).ok, false)
  }
  for (const invalidReport of [null, [], { ...report([1, 2, 3]), extra: true }, { ...report([1, 2, 3]), baselineSamples: undefined }]) {
    assert.equal(evaluateMeasurement(metric, invalidReport).ok, false)
  }
})

test('baseline is aggregated for display, never an undeclared relative gate', () => {
  const slower = evaluateMeasurement({ ...metric, statistic: 'mean' }, report([10, 10, 10], { baselineSamples: [1, 1, 1] }))
  assert.deepEqual(slower, { ok: true, errors: [], measured: 10, baseline: 1 })
  const fasterButOverBudget = evaluateMeasurement(metric, report([21, 21, 21], { baselineSamples: [100, 100, 100] }))
  assert.equal(fasterButOverBudget.ok, false); assert.equal(fasterButOverBudget.baseline, 100)
  for (const baselineSamples of [[], [1], [1, '2', 3], [1, Infinity, 3]]) assert.equal(evaluateMeasurement(metric, report([1, 2, 3], { baselineSamples })).ok, false)
})

test('large finite mean samples do not overflow an otherwise valid metric', () => {
  const large = { ...metric, statistic: 'mean', threshold: Number.MAX_VALUE }
  const result = evaluateMeasurement(large, report([Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE]))
  assert.equal(result.ok, true); assert.equal(result.measured, Number.MAX_VALUE)
  assert.equal(evaluateMeasurement(large, report([-1e308, 0, 1e308])).measured, 0)
})

test('sparse strategy lists and reference arrays fail validation without throwing', () => {
  for (const field of ['options', 'technology', 'execution', 'checks', 'questions']) {
    reject({ risk, [field]: Array(2) }, /dense array/)
  }
  reject({ risk, execution: [{ step: 'S1', dependsOn: Array(1), doneWhen: 'Verified', replanWhen: 'Dependency changes' }] }, /dense array/)
  for (const field of ['needIds', 'stepIds']) {
    const result = parseStrategy({ risk }, { [field]: Array(1) })
    assert.equal(result.value, null)
    assert.match(result.errors.join(), /dense array/)
  }
})
