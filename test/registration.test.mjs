import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTools } from '../src/tools.js'
import { parameterSchema, registerableTool } from '../src/registration.js'

test('all six tools expose standard JSON Schema without an SDK installation', () => {
  const tools = createTools({ capabilities: {} }).map(registerableTool)
  assert.equal(tools.length, 6)
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.ok(Array.isArray(tool.parameters.required))
    assert.equal(tool.output.schema.type, 'object')
    for (const field of Object.values(tool.parameters.properties)) assert.equal(Object.hasOwn(field, 'required'), false)
  }
})

test('malformed model arguments cannot reach the mutating tool body', async () => {
  let executions = 0
  const tool = registerableTool({
    name: 'validation-fixture',
    parameters: { status: { type: 'string', required: true, enum: ['done', 'partial'] }, new_task: { type: 'boolean' } },
    output: { schema: { type: 'object' }, render: () => [] },
    execute(args) { executions += 1; return args },
  })
  for (const args of [null, [], {}, { status: 1 }, { status: 'unknown' }, { status: 'done', new_task: 'true' }, { status: 'done', unexpected: true }]) {
    await assert.rejects(tool.execute(args, {}), /Invalid arguments/)
  }
  assert.equal(executions, 0)
  assert.deepEqual(await tool.execute({ status: 'partial', new_task: false }, {}), { status: 'partial', new_task: false })
  assert.equal(executions, 1)
})

test('new unsupported schema keywords fail explicitly instead of weakening validation', () => {
  assert.throws(() => parameterSchema({ value: { type: 'object' } }), /Unsupported/)
  assert.throws(() => parameterSchema({ value: { type: 'string', pattern: 'x' } }), /Unsupported/)
})

test('host schemas omit unsupported length keywords while execution still enforces bounds', async () => {
  let calls = 0
  const tool = registerableTool({ name: 'bounded', parameters: {
    text: { type: 'string', required: true, minLength: 2, maxLength: 4 },
  }, execute(args) { calls++; return args.text } })
  assert.equal(Object.hasOwn(tool.parameters.properties.text, 'minLength'), false)
  assert.equal(Object.hasOwn(tool.parameters.properties.text, 'maxLength'), false)
  await assert.rejects(tool.execute({ text: 'x' }, {}), /too short/)
  await assert.rejects(tool.execute({ text: '12345' }, {}), /too long/)
  assert.equal(calls, 0)
  assert.equal(await tool.execute({ text: '1234' }, {}), '1234')
  assert.equal(calls, 1)
  assert.throws(() => parameterSchema({ text: { type: 'string', maxLength: -1 } }), /Invalid parameter bound/)
  assert.throws(() => parameterSchema({ text: { type: 'string', minLength: 4, maxLength: 2 } }), /Invalid parameter bounds/)
})

test('oversized strategy input cannot reach the plan implementation', async () => {
  const unavailable = () => { throw new Error('session state must not be accessed') }
  const plan = createTools({ sessionFor: unavailable, save: unavailable }).map(registerableTool).find(tool => tool.name === 'rigor_plan')
  await assert.rejects(plan.execute({ strategy: 'x'.repeat(40001) }, {}), /strategy is too long/)
})
