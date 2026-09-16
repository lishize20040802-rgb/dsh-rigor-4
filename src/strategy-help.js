// Loaded into model context only on request. These examples are not standing rules.
export const STRATEGY_HELP = Object.freeze({
  usage: 'Call rigor_plan with approach, steps and strategy as a JSON string. Omit strategy for routine work; omission during replanning preserves the existing strategy. Include only relevant fields. All listed checks are required before done.',
  example: {
    risk: { impact: 'medium', uncertainty: 'high', reason: 'A host interface may differ in the installed version.' },
    options: [
      { id: 'A', title: 'Use the native extension API', tradeoffs: 'Small integration, version compatibility needs checking.', probe: 'Run a minimal lifecycle probe on the installed host.' },
      { id: 'B', title: 'Use an isolated adapter', tradeoffs: 'More code but isolates interface changes.', probe: 'Measure the adapter boundary with a small fixture.' },
    ],
    selected: 'A', decision: 'Prefer the native API if the probe confirms support; otherwise reconsider B.',
    technology: [{ id: 'T1', name: 'Host SDK', version: 'installed version', source: 'official documentation or local source location', probe: 'Minimal mount/dispose experiment; record the actual result as evidence.' }],
    execution: [{ step: 'S2', dependsOn: ['S1'], doneWhen: 'Installed build passes its user flow.', replanWhen: 'The native lifecycle contract is unavailable.' }],
    checks: [{ id: 'C1', need: 'N1', kind: 'delivery', criterion: 'A clean install runs the main flow and uninstalls cleanly.' }],
    questions: [{ id: 'Q1', question: 'An unresolved decision that materially affects delivery.', blocking: true }],
  },
  fields: {
    risk: 'Required when strategy is supplied: impact and uncertainty = low|medium|high, plus reason. The assessment is agent-authored and must be reviewed.',
    options: 'Optional 2–4 materially different approaches; selected identifies one, decision explains the choice. Do not invent extra user requirements.',
    execution: 'Optional step metadata: step and dependsOn reference S1, S2, etc. Dependency cycles are refused. doneWhen and replanWhen are required.',
    technology: 'Optional versioned facts and proposed probes. Listing a probe does not mean it ran; use ordinary tools and link actual evidence.',
    checks: 'Optional acceptance conditions: id, need, kind=functional|integration|performance|compatibility|delivery, criterion. Performance additionally requires metric below.',
    questions: 'Optional unresolved decisions. Resolve blocking questions from evidence or existing authorization; ask the user only when their answer is necessary, then revise the plan.',
  },
  metric: { unit: 'ms', statistic: 'p95', operator: 'lte', threshold: 500, minSamples: 20, workload: 'Fixed representative fixture', environment: 'Exact runtime/platform configuration' },
  metricNote: 'Choose thresholds from the actual task, not this example. Statistics: max|mean|p95 (nearest rank); operators: lte|gte. Reports carry finite samples and optional baselineSamples under identical conditions.',
  evidence: 'Generate a local JSON report with check, status (passed|failed), observed, environment, subject:{path,sha256}, and measurement when applicable. Link with rigor_evidence(needs="N1",check="C1",ref="artifact:report.json",run="cmd:actual command"). The command must run after the plan. The plugin checks facts, hashes and numeric thresholds; reviewers judge whether the experiment proves the requirement.',
})
