// One place reads a child's session log.
//
// Two files used to ask the same two questions of a child's own log — "has it finished?" and
// "what was the last thing it said?" — and the copies drifted apart. One of them was edited
// down to a check that read a variable it never declared, and every turn of a live session
// died of it. A child's log is read here, and only here.

/**
 * The tail of a session log: whether it is empty, the type of its last event, and whether that
 * event means the session has finished. `empty` stays separate from `finished` because the
 * callers say different things about an empty log — one skips it, the other explains it.
 */
export function sessionTail(events) {
  const present = Array.isArray(events) && events.length > 0
  const last = present ? events[events.length - 1] : null
  const type = last === null || typeof last !== 'object' ? '' : String(last.type ?? '')
  return { empty: !present, type, finished: present && (type === 'turn/end' || type === 'agent/disposed') }
}

/** The last non-empty text the session said, or '' when it never said anything. */
export function lastAssistantText(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  return ''
}
