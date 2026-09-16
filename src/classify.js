// What the pipeline saw, in the vocabulary this discipline needs.
//
// The plugin's facts come from the tool stream, never from the model's account of what
// it did, so the mapping from a tool name to a fact has to be boring and total. Two
// deliberate choices:
//
//   * a shell command is recorded as a command with a `mutationHint`, never as a
//     mutation. Forty-one of forty such heuristics were measured in an earlier build
//     and the false positives are what made sessions unable to close; a hint that is
//     only ever used to decide whether a turn REPORTED ITSELF cannot false-hold.
//   * the reading gate denies file-mutation TOOLS (edit/write/apply_patch …) because
//     those are unambiguous. It does not deny shell, because "does this command
//     write?" cannot be answered for every shell, and a wrong denial costs a turn.

export const MUTATION_TOOLS = Object.freeze([
  'write', 'edit', 'multi_edit', 'apply_patch', 'str_replace', 'create_file', 'notebook_edit',
])

export const READ_TOOLS = Object.freeze([
  'read', 'read_document', 'read_image', 'grep', 'glob',
  'doc_list', 'doc_current', 'doc_page', 'doc_search', 'vision',
])

export const SHELL_TOOLS = Object.freeze(['pwsh', 'bash', 'terminal'])

export const SPAWN_TOOLS = Object.freeze([
  'subagent', 'subagent_fork',
  'subagent_explore', 'subagent_review', 'subagent_monitor',
  'workflow', 'ralph',
])

/**
 * Which brief roles a role-specific spawn tool may answer.
 *
 * The three earlier generations ran every child on the parent's own tool set, so a
 * reviewer could edit the thing it was reviewing and an explorer carried the whole
 * shell. The host supports one subagent tool per capability profile (its row config
 * carries the persona and the tool filter), so the profile is chosen by picking the
 * tool — and this map is what makes the choice binding rather than decorative: the
 * spawn gate refuses a review brief answered by the explorer tool, and the reverse.
 *
 * A tool not named here (the generic subagent, a fork, the workflow tools) claims no
 * profile and may answer any role.
 */
export const ROLE_TOOLS = Object.freeze({
  subagent_explore: Object.freeze(['clarify', 'diverge', 'explore', 'technical', 'plan-review']),
  subagent_review: Object.freeze(['review', 'rework-check']),
  subagent_monitor: Object.freeze(['monitor']),
})

/** The roles a spawn tool may answer, or null when it claims no specific profile. */
/**
 * What a child briefed for one role may not do.
 *
 * This is enforced in the CHILD's own session, not by a preset row's toolFilter, and the
 * reason is a host contract that cost a live session: tools.restrict() accepts only
 * restrictable GLOBAL tool names — unknown names and scope-local names both throw, and
 * every preset row registers scope-locally. A role row with a filter list therefore
 * failed the whole spawn ("tools.restrict() names unknown global tools ... ; known
 * global tools: ..."), and it could never have named the subagent tools anyway. In the
 * child's own gate the names are facts: they are the names this build actually uses.
 */
export const BRIEF_ROLE_RULES = Object.freeze({
  clarify: Object.freeze({ shell: false }),
  diverge: Object.freeze({ shell: false }),
  explore: Object.freeze({ shell: false }),
  technical: Object.freeze({ shell: false }),
  'plan-review': Object.freeze({ shell: false }),
  monitor: Object.freeze({ shell: true }),
  review: Object.freeze({ shell: true }),
  'rework-check': Object.freeze({ shell: true }),
})

/** The reason a briefed child may not use this tool, or '' when it may. */
export function childRestriction(role, tool) {
  const rule = BRIEF_ROLE_RULES[String(role ?? '')]
  if (rule === undefined) return ''
  const name = String(tool ?? '')
  if (isMutationTool(name)) {
    return `this session was briefed as the ${role} child and is read-only: it may not modify files. Report what you found instead; the delegating session does the editing.`
  }
  if (rule.shell === false && isShellTool(name)) {
    return `this session was briefed as the ${role} child and has no shell. Observe and report; if a command would answer something, name the command in your answer.`
  }
  if (SPAWN_TOOLS.includes(name) || name === 'rigor_brief') {
    return `this session was briefed as the ${role} child: children do not delegate further.`
  }
  if (name === 'ask_user_question') {
    return `this session was briefed as the ${role} child: it does not question the person directly. Put the question in your answer and the delegating session will ask it.`
  }
  return ''
}

export function rolesForTool(tool) {
  return ROLE_TOOLS[String(tool ?? '')] ?? null
}

/** The tool a role is meant to be started with. */
export function toolForRole(role) {
  const clean = String(role ?? '')
  for (const [tool, roles] of Object.entries(ROLE_TOOLS)) if (roles.includes(clean)) return tool
  return 'subagent'
}

export function isMutationTool(name) {
  return MUTATION_TOOLS.includes(String(name ?? ''))
}

export function isShellTool(name) {
  return SHELL_TOOLS.includes(String(name ?? ''))
}

/** The command a shell tool ran, or ''. */
export function commandOf(args) {
  if (args === null || typeof args !== 'object') return ''
  const raw = args.command ?? args.script ?? args.cmd ?? ''
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) return raw.map(part => String(part ?? '')).join(' ')
  return ''
}

/** The target of a mutation, named the way a person would name it. */
export function targetOf(tool, args) {
  if (args === null || typeof args !== 'object') return ''
  const path = args.file_path ?? args.filePath ?? args.path ?? args.filename ?? args.file ?? ''
  if (typeof path === 'string' && path.trim() !== '') return path.trim()
  const command = commandOf(args)
  if (command.trim() !== '') {
    const first = command.trim().split('\n')[0].trim()
    return `pwsh: ${first.slice(0, 90)}`
  }
  return ''
}

const WRITE_WORDS = /(?:^|[;&|(`\s])(?:rm|rmdir|del|erase|mv|move|cp|copy|mkdir|touch|tee|truncate|chmod|chown|dd|patch|git\s+commit|git\s+checkout|git\s+reset|git\s+apply|npm\s+install|pnpm\s+install|yarn\s+add|pip\s+install|poetry\s+add|cargo\s+add|go\s+get|set-content|add-content|clear-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|set-itemproperty|new-itemproperty|invoke-webrequest|invoke-restmethod)\b/i
const REDIRECT = /(^|[^0-9<>])(>>?|2>)\s*(?![&])/
const WRITE_API = /\[System\.IO\.File\]::(?:Write|Append|Create|Delete)|WriteAllText|WriteAllBytes|Set-Content|Out-File/i

/**
 * Whether a shell command looks like it persists something.
 *
 * Conservative by construction: a false negative costs one advisory, a false positive
 * could hold a turn that changed nothing. The reading gate never uses this.
 */
export function mutationHint(command) {
  const text = String(command ?? '')
  if (text.trim() === '') return false
  if (WRITE_API.test(text)) return true
  if (REDIRECT.test(text) && !/2>&1|>&2|-gt|-lt|=>/.test(text.split('\n')[0])) return true
  return WRITE_WORDS.test(text)
}

/**
 * The text that identifies a spawn: what this child is being asked.
 *
 * EVERY text field the spawn carries is read, not the first one that is non-empty. A real
 * spawn sets `description` to a short label AND `prompt` to the brief it was handed, so
 * reading the first non-empty field made this gate refuse a spawn that had handed an open
 * brief over. A live PTC session lost its reviewer to exactly that: four refusals, and then
 * a report explaining the missing independent review as a harness fault.
 */
const SPAWN_TEXT_FIELDS = Object.freeze(['description', 'objective', 'prompt', 'instructions', 'message'])

export function describeSpawn(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return ''
  const parts = []
  for (const field of SPAWN_TEXT_FIELDS) {
    const raw = args[field]
    if (typeof raw === 'string' && raw.trim() !== '') parts.push(raw)
    else if (Array.isArray(raw)) {
      const block = raw.find(part => part !== null && typeof part === 'object' && typeof part.text === 'string')
      if (block !== undefined) parts.push(block.text)
    }
  }
  return parts.join('\n')
}
