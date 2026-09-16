// The briefs a child is handed.
//
// A child starts with none of this session's context, so a brief that says "review
// the work" gets a reviewer that reviews whatever it can see, which is not the work.
// Every brief therefore carries the same four things — what the person said, the
// reading with its unstated needs, the plan, and what has actually happened — plus
// the one question this child was opened to answer and the shape its answer must
// take. The review brief is the strictest: its answer is machine-read, and the one
// sentence it is required to write is the one three generations of this mode kept
// failing to get: what the passing scripts do NOT prove.

import { toolForRole } from './classify.js'

const ROLE_MANDATES = Object.freeze({
  clarify: [
    'You are the CLARIFY child. Your question is not "what did they type" — it is "what did they mean, including the parts they never said because they seemed obvious".',
    'People leave out the defaults of their trade, the thing they assume any competent worker would do, the boundary they think is not worth mentioning, and the outcome that would make them say "not like that". Your job is to name those, not to be right about them.',
    'Read the workspace if it helps. Do not modify anything. Do not delegate.',
    'Answer in plain text: (1) the reading you would act on; (2) each unstated need you would carry, and what would show it is met or that you have it wrong; (3) the questions only the person can answer. Keep it short and specific — the delegating session has to act on it.',
  ],
  diverge: [
    'You are the DIVERGE child. Your job is to attack the reading, not to complete it.',
    'Find the strongest case that the reading is wrong: a need it invents, a need it misses, an interpretation the person\'s words do not support, or a default of their context that has been silently swapped for a different one. If the reading survives your attack, say so and say what you tried.',
    'Read the workspace if it helps. Do not modify anything. Do not delegate.',
    'Answer in plain text: (1) the attack you consider strongest; (2) what evidence you saw for and against the reading; (3) the correction you would make, if any. Do not hedge into "it depends".',
  ],
  'plan-review': [
    'You are the PLAN-REVIEW child. You judge the plan against the reading, not the plan against itself.',
    'Look for: a step that serves no need (work nobody asked for); a need with no step (a promise the plan does not keep); a step whose evidence cannot show what it claims; an ordering that makes a later step impossible; a check that would pass while the need is unmet.',
    'Do not modify anything. Do not delegate.',
    'Answer in plain text: (1) each problem, named by step and need; (2) the strongest single change you would make; (3) what in the plan you would keep.',
  ],
  monitor: [
    'You are the MONITOR child. You watch the execution for drift while it happens, and you are the only role that may speak before the work is finished.',
    'Drift means: work touching things the plan does not name; a step that stopped without landing; a job running long against the wrong target; the approach being changed without the plan being changed; a claim about what something does that the recorded facts do not support.',
    'Do not modify anything. Do not delegate. Do not approve anything: you have no verdict.',
    'Answer in plain text as a list of findings, strongest first, one or two lines each, each naming the evidence you saw. If nothing has drifted, say that in one line.',
  ],
  review: [
    'You are the REVIEW child, and you are judging whether the delivery meets what the person MEANT — not whether the checks passed.',
    'The trap this role exists to avoid: a passing command is evidence about a command, never about a person\'s need. "The tests pass" is not a verdict on whether the unstated need is met; that judgement is yours, and where you cannot make it, "not-checked" is the honest answer.',
    'Read the actual artifacts and evidence before judging. You did not write this work and you must not defend it. Do not modify anything. Do not delegate.',
    'What you must produce is a verdict payload, and it is machine-read: end your final message with exactly one fenced ```json block, of the shape below. Anything outside that block is not read.',
  ],
  'rework-check': [
    'You are the REWORK-CHECK child. A previous review demanded specific fixes; you verify the fixes and whether the needs are now met. You do not re-litigate the whole design unless the fix itself is wrong.',
    'Check each demanded item against the actual artifacts: fixed, not fixed, or fixed differently. Then judge every need again, on the same rule as any reviewer — script success is not need fulfilment.',
    'Do not modify anything. Do not delegate.',
    'End your final message with exactly one fenced ```json block of the same shape the review brief describes, with "closed_items" naming the rework ids you verified.',
  ],
})

const REVIEW_SCHEMA = `{
  "verdict": "approve" | "rework",
  "role": "review" | "rework-check",
  "reading_ok": true | false,
  "needs": [
    { "id": "N1", "status": "met" | "not-met" | "not-checked",
      "how": "read" | "ran" | "inspected" | "asked-person" | "artifact",
      "evidence": "the concrete thing you saw — file and line, output, artifact, or the question you asked" }
  ],
  "script_only": ["what a passing command does NOT prove about these needs"],
  "deviations": ["where the delivery differs from what the reading says"],
  "rework": ["the exact change demanded, one per item — empty when you approve"],
  "closed_items": ["R1 — required in a rework-check, empty otherwise"],
  "questions": ["what only the person can answer"]
}`

const REVIEW_RULES = `Rules the payload is checked against:
- "verdict": "approve" only if every need is "met", reading_ok is true, and "rework" is empty. Anything else is "rework".
- One needs[] entry per need of the reading, by id. A need you could not examine is "not-checked" with your reason — an honest gap beats a confident approval.
- "how" is how you examined it, not what the author says they did.
- "evidence" is the thing you saw. "Tests pass" alone is not evidence for a need; say what the test does not cover in "script_only".
- "script_only" is mandatory and non-empty even when you approve: the one sentence that keeps a green check from standing in for the person's need.
- If the reading itself looks wrong against the person's words, say so with "reading_ok": false and verdict "rework".`

function requestsBlock(round, limit = 4) {
  const requests = (round.requests ?? []).slice(-limit)
  if (requests.length === 0) return 'The person\'s words were not captured in this session (no user message was recorded).'
  return requests.map(item => `[#${item.seq}] ${item.text}`).join('\n')
}

function readingBlock(round) {
  const reading = round.reading
  if (reading === null) return 'No reading is recorded yet.'
  const needs = reading.needs.map(need => `- ${need.id} [${need.kind}] ${need.text}\n    would show it is met or that it is misread: ${need.test}`).join('\n')
  const unknowns = reading.unknowns.length === 0 ? '' : `\nUnknowns the session named: ${reading.unknowns.map(item => `${item.id} ${item.text}`).join('; ')}`
  return `Reading v${reading.version} (literal request): ${reading.literal}\nNeeds:\n${needs}${unknowns}`
}

function planBlock(round) {
  const plan = round.plan
  if (plan === null) return 'No plan is recorded yet.'
  const steps = plan.steps.map(step => `- ${step.id} ${step.text}\n    serves: ${step.serves.join(', ') || '(nothing)'}\n    evidence planned: ${step.evidence}`).join('\n')
  const risks = plan.risks.length === 0 ? '' : `\nRisks named by the session: ${plan.risks.join('; ')}`
  return `Approach: ${plan.approach}\nSteps:\n${steps}${risks}`
}

function factsDigest(round, limit = 12) {
  const edits = (round.facts?.edits ?? []).slice(-limit)
  const commands = (round.facts?.commands ?? []).slice(-limit)
  const evidence = (round.evidence ?? []).slice(-limit)
  const parts = []
  parts.push(edits.length === 0
    ? 'No file target has been changed in this session.'
    : `Changed targets (newest last):\n${edits.map(item => `- #${item.seq} ${item.target} (${item.tool})`).join('\n')}`)
  parts.push(commands.length === 0
    ? 'No command has been recorded.'
    : `Commands (newest last):\n${commands.map(item => `- #${item.seq} exit ${item.exit} ${String(item.cmd).replace(/\s+/g, ' ').slice(0, 100)}`).join('\n')}`)
  parts.push(evidence.length === 0
    ? 'No fact has been linked to a need yet.'
    : `Facts linked to needs:\n${evidence.map(item => `- ${item.need} ← ${item.kind} ${item.ref}${item.note === '' ? '' : ` (${item.note})`}`).join('\n')}`)
  return parts.join('\n\n')
}

/**
 * Render the whole brief for one child.
 *
 * `serves` is what the parent says this child is for (need or step ids); it is kept
 * because a brief that serves nothing is a spawn nobody can hold to anything.
 */
export function renderBrief({ role, question, serves = [], round, openItems = [], previousReview = null }) {
  const mandate = ROLE_MANDATES[role] ?? ROLE_MANDATES.review
  const header = [
    `# Brief: ${role}`,
    '',
    'You are a child session briefed by a session running the rigor-4 discipline. You have its record below; you do not have its conversation. Read-only unless the mandate says otherwise: do not modify files, do not delegate further.',
    '',
    mandate.join('\n'),
    '',
    `The delegating session opened this brief for: ${serves.length === 0 ? '(nothing named — it should have named the need or step it serves)' : serves.join(', ')}`,
    `Start this child with the ${toolForRole(role)} tool. The spawn gate refuses a brief answered by a tool built for another job: the tool is what gives the child the capability profile this role needs.`,
    '',
    '## What the person said',
    requestsBlock(round),
    '',
    '## The reading',
    readingBlock(round),
    '',
    '## The plan',
    planBlock(round),
    '',
    '## What has actually happened',
    factsDigest(round),
  ]
  if (openItems.length > 0) {
    header.push('', '## Rework still open', openItems.map(item => `- ${item.id}: ${item.text}`).join('\n'))
  }
  if (previousReview !== null) {
    const needs = previousReview.needs.map(item => `- ${item.id}: ${item.status}${item.evidence === '' ? '' : ` — ${item.evidence}`}`).join('\n')
    header.push(
      '',
      `## The previous review (${previousReview.id}, ${previousReview.verdict})`,
      needs,
      previousReview.scriptOnly.length === 0 ? '' : `What it said the scripts do not prove: ${previousReview.scriptOnly.join(' | ')}`,
      previousReview.deviations.length === 0 ? '' : `Deviations it named: ${previousReview.deviations.join(' | ')}`,
    )
  }
  header.push(
    '',
    '## The question this brief exists to answer',
    question,
    '',
    '## What your answer must look like',
  )
  if (role === 'review' || role === 'rework-check') {
    header.push(REVIEW_SCHEMA, '', REVIEW_RULES)
  } else {
    header.push('Plain text, no JSON required. Be specific: name what you saw, not what you assume. If you cannot tell, say so and say what would tell you.')
  }
  return header.filter(line => line !== undefined).join('\n')
}

export { REVIEW_SCHEMA, REVIEW_RULES, ROLE_MANDATES }