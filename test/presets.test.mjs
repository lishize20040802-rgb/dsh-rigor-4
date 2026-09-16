// The preset variants are the other half of the discipline: the plugin decides what a
// role owes, the preset decides what the child it is handed can actually do. A role row
// that loses its tool filter, or a variant that loses its capability declaration, would
// silently turn "a reviewer that cannot edit" back into "any child at all" — so the
// composition is asserted here rather than trusted to the install copy.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { childRestriction } from '../src/classify.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const PRESET = fileURLToPath(new URL('../preset/', import.meta.url))
const read = variant => readFileSync(join(PRESET, variant, 'agent.cordis.yml'), 'utf8')
const MUTATION_TOOLS = ['write', 'edit', 'multi_edit', 'apply_patch', 'str_replace', 'create_file', 'notebook_edit']

test('the three capable variants mount the discipline and declare their channels', () => {
  for (const variant of ['standard', 'ptc', 'cordis']) {
    const text = read(variant)
    assert.match(text, /- id: rigor-4\n\s+name: 'dsh-rigor-4'/, `${variant} mounts dsh-rigor-4`)
    assert.match(text, /children: true/, `${variant} declares the child channel`)
    assert.match(text, /person: true/, `${variant} declares the question channel`)
  }
})

test('each role row names its job and states a persona, and carries no host tool filter', () => {
  for (const variant of ['standard', 'ptc', 'cordis']) {
    const text = read(variant)
    for (const tool of ['subagent_explore', 'subagent_review', 'subagent_monitor']) {
      assert.match(text, new RegExp(`toolName: ${tool}`), `${variant} has a ${tool} row`)
      const row = text.split(new RegExp(`toolName: ${tool}`))[1].split(/tool-subagent-/)[0]
      assert.match(row, /persona:/, `${variant}/${tool} states a persona`)
      // Measured live: tools.restrict() accepts only restrictable GLOBAL names, and both
      // unknown names and scope-local names (every preset row) throw. A toolFilter here
      // failed the whole spawn — the mandate is enforced in the child's own gate instead.
      assert.ok(!/toolFilter:/.test(row), `${variant}/${tool} carries no toolFilter`)
      assert.ok(!/^\s+deny:/m.test(row), `${variant}/${tool} carries no deny list`)
    }
  }
})

test('the read-only mandate lives in the child gate, where tool names are facts', () => {
  assert.match(childRestriction('review', 'edit'), /read-only/, 'a reviewer cannot edit')
  assert.equal(childRestriction('review', 'pwsh'), '', 'a reviewer may run the checks')
  assert.match(childRestriction('plan-review', 'pwsh'), /no shell/, 'an explorer has no shell')
  assert.equal(childRestriction('monitor', 'pwsh'), '', 'a monitor may run and watch')
  assert.match(childRestriction('monitor', 'subagent_monitor'), /do not delegate/, 'children do not delegate')
  assert.match(childRestriction('clarify', 'ask_user_question'), /does not question/, 'children do not question the person')
  assert.equal(childRestriction('', 'edit'), '', 'an unbriefed session is not restricted by this rule')
})

test('the capable variants declare that their role tools exist; minimal does not', () => {
  for (const variant of ['standard', 'ptc', 'cordis']) {
    assert.match(read(variant), /profiles: true/, variant + ' declares the role tools')
  }
  assert.ok(!/profiles: true/.test(read('minimal')), 'minimal declares no role tools')
})

test('minimal carries the discipline in its fixed persona, because complete: true drops sections', () => {
  const text = read('minimal')
  assert.match(text, /complete: true/, 'the base keeps its fixed prompt')
  assert.match(text, /rigor_read/, 'the reading is stated')
  assert.match(text, /implicit:/, 'implicit needs are named')
  assert.match(text, /rigor_report\(limitations=/, 'the limitation has a home')
  assert.match(text, /never proof that the person's need is met/, 'the anti-script sentence is present')
})

test('the minimal variant declares no child channel and mounts no role row', () => {
  const text = read('minimal')
  assert.match(text, /children: false/)
  assert.match(text, /person: false/)
  assert.ok(!/toolName: subagent_explore/.test(text), 'minimal has no explore row')
  assert.ok(!/toolName: subagent_review/.test(text), 'minimal has no review row')
  assert.match(text, /- id: rigor-4\n\s+name: 'dsh-rigor-4'/, 'minimal still mounts the discipline')
})