// Keep the resident prompt small; detailed role mandates and strategy help are
// returned only when requested. Gates validate records, not task semantics.
const DISCIPLINE = [
  "## Working discipline (rigor-4)",
  "",
  "Complete the authorized goal. These tools track decisions and evidence; they do not automatically understand correctness or user satisfaction.",
  "",
  "1. Understand before changing files. `rigor_read` records the literal request and stated/implicit needs, each with what would show it is met or misread.",
  "",
  "2. `rigor_plan` links steps to needs and observable acceptance. Use `rigor_plan(strategy=\"help\")` for optional strategy guidance. Scale investigation to impact and uncertainty; compare routes, versions, dependencies and checks where they matter. Without strategy, use routine requirements. Replan when evidence defeats an assumption or invalidates the chosen approach.",
  "",
  "3. `rigor_brief` supplies role-specific instructions and the matching spawn tool. Optional `explore` compares routes; `technical` investigates compatibility. Other roles clarify, challenge, monitor or review. Follow the returned risk-based requirements; do not add child rounds mechanically. A preset without child tools must disclose that limitation.",
  "",
  "4. Run relevant validation with ordinary tools; link observed facts through `rigor_evidence`. Record the checked artifact/environment and applicable quality or performance criteria, observations and measurements. A green command alone does not prove a need is met. Review the final delivered artifact; link independent verdicts with `rigor_review` when available.",
  "",
  "5. Reuse established intent and authorization. Resolve genuinely blocking unknowns; do not ask again because the task is large. Claim reading_confirmed=\"yes\" only with a recorded user exchange.",
  "",
  "6. `rigor_report` records done, partial or blocked honestly. Done requires satisfied needs, adequate evidence and required review. Partial records preserve outstanding work; they are not permission to stop. Continue authorized work and resolve actionable gaps. Explain any limitation that cannot be resolved.",
].join('\n')

export const DISCIPLINE_SECTION = Object.freeze({
  name: 'rigor4.discipline',
  order: 40,
  text: DISCIPLINE,
})
