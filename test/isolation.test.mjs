// The boundary the designer asked for: this generation uses nothing from the three
// before it. No imports, no shared files, no shared state, no tool-name collision.
// The test reads the source rather than trusting a comment, because a comment is how
// the last three generations described behaviour they no longer had.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

function sourceFiles() {
  return readdirSync(SRC).filter(name => name.endsWith('.js')).map(name => ({ name, text: readFileSync(join(SRC, name), 'utf8') }))
}

test('no source file imports or names an earlier generation', () => {
  const forbidden = [/dsh-rigor-2/, /dsh-rigor-3/, /dsh-rigor-mode/, /\.rigor2\b/, /\.rigor3\b/, /\.rigor-mode\b/, /\.\.\/dsh-rigor/]
  for (const file of sourceFiles()) {
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(file.text), `${file.name} mentions ${pattern}`)
    }
  }
})

test('this generation owns its state directory', () => {
  const store = readFileSync(join(SRC, 'store.js'), 'utf8')
  assert.match(store, /\.rigor4/)
  assert.ok(!/\.rigor2|\.rigor3|\.rigor-mode/.test(store))
})

test('its tool names do not collide with the five the previous generation registered', () => {
  const previous = ['rigor_scope', 'rigor_assume', 'rigor_note', 'rigor_verdict', 'rigor_verify']
  const tools = readFileSync(join(SRC, 'tools.js'), 'utf8')
  for (const name of previous) assert.ok(!tools.includes(`'${name}'`), `${name} is not registered by this build`)
})