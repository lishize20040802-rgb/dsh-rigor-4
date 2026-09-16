// The boundary that matters after this build's bug: a child's session log is read in ONE place.
//
// "Has this child finished?" and "what did it last say?" were written twice, in index.js and
// tools.js. The copies drifted; one of them was edited down to a check that read a variable it
// never declared, and every turn of a live session died of `last is not defined`. Like the
// isolation boundary, this test reads the source rather than trusting a comment, so the second
// copy cannot come back unnoticed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { lastAssistantText, sessionTail } from '../src/children.js'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const sources = () => readdirSync(SRC).filter(name => name.endsWith('.js')).map(name => ({ name, text: readFileSync(join(SRC, name), 'utf8') }))

test('a child log is read in exactly one file', () => {
  for (const shared of ['lastAssistantText', 'sessionTail']) {
    const definers = sources().filter(file => new RegExp(`function\\s+${shared}\\s*\\(`).test(file.text)).map(file => file.name)
    assert.deepEqual(definers, ['children.js'], `${shared} must be defined in children.js and nowhere else`)
  }
  const handmade = sources().filter(file => /events\[events\.length - 1\]/.test(file.text)).map(file => file.name)
  assert.deepEqual(handmade, ['children.js'], 'walking the tail of a session log by hand is what made the copies drift')
})

test('both callers read through the shared reader', () => {
  for (const caller of ['index.js', 'tools.js']) {
    const text = readFileSync(join(SRC, caller), 'utf8')
    assert.match(text, /from '\.\/children\.js'/, `${caller} imports the shared reader`)
    for (const shared of ['lastAssistantText', 'sessionTail']) {
      assert.ok(!new RegExp(`function\\s+${shared}\\s*\\(`).test(text), `${caller} keeps no local copy of ${shared}`)
    }
  }
})

test('one definition of "finished" serves both callers', () => {
  assert.equal(sessionTail([{ type: 'turn/end' }]).finished, true)
  assert.equal(sessionTail([{ type: 'agent/disposed' }]).finished, true)
  assert.equal(sessionTail([{ type: 'step/start' }, { type: 'tool/call' }]).finished, false)
  assert.equal(sessionTail([]).empty, true)
  assert.equal(sessionTail([]).finished, false)
  assert.equal(sessionTail([{ type: 'turn/end' }]).empty, false)
  const said = [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'the last word' }] } } }, { type: 'turn/end' }]
  assert.equal(lastAssistantText(said), 'the last word')
  assert.equal(lastAssistantText([]), '')
})
