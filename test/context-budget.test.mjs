import test from 'node:test'
import assert from 'node:assert/strict'
import { createTools } from '../src/tools.js'
import { registerableTool } from '../src/registration.js'
import { DISCIPLINE_SECTION } from '../src/prompt.js'

test('standing discipline and tool metadata stay within the lightweight budget', () => {
  const definitions = createTools({ capabilities: { children: true, person: true } })
    .map(registerableTool).map(({ name, description, parameters }) => ({ name, description, parameters }))
  const disciplineBytes = Buffer.byteLength(DISCIPLINE_SECTION.text)
  const toolBytes = Buffer.byteLength(JSON.stringify(definitions))
  assert.equal(definitions.length, 6, 'new abilities extend the existing tools')
  assert.ok(disciplineBytes <= 2200, `standing discipline grew to ${disciplineBytes} UTF-8 bytes`)
  assert.ok(toolBytes <= 6200, `tool metadata grew to ${toolBytes} UTF-8 bytes`)
  assert.ok(disciplineBytes + toolBytes <= 8400, 'load detailed guidance only on demand')
  assert.ok(!DISCIPLINE_SECTION.text.includes('baselineSamples'), 'measurement schemas are not standing instructions')
})

test('detailed strategy help is read-only and does not read or mutate a session', () => {
  const unavailable = () => { throw new Error('help must not access session state') }
  const plan = createTools({ sessionFor: unavailable, save: unavailable }).find(tool => tool.name === 'rigor_plan')
  const result = plan.execute({ strategy: 'help' }, {})
  assert.equal(result.recorded, false)
  assert.ok(result.help.example.risk)
  assert.ok(result.help.metric.minSamples)
})
