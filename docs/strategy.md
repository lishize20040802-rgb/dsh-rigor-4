# Optional strategies and acceptance checks

**Available in 0.2.0.** This page describes the optional strategy and acceptance API. See the [README](../README.md#install-or-upgrade) to install or upgrade.

中文摘要：0.2.0 的策略是按需填写的结构化计划，包含风险、方案选择、技术探针、步骤依赖、重规划条件及验收检查。普通任务可以省略；模型自报风险仍须审查，依赖关系不会自动调度任务。检查报告必须对应计划之后的实际命令和带哈希的文件；插件核对事实与数值，不能自动证明命令真的加载了该文件或样本具有真实性、代表性。每次修改计划或补充检查证据后，应重新取得适用于当前结果的审阅。

## Request details only when useful

These are tool-call examples for an agent in DSH, not standalone JavaScript programs. Detailed help can be requested without a reading, approach or steps:

```js
rigor_plan({ strategy: "help" })
```

Help does not read or change session state. A normal plan still requires an existing `rigor_read`, a nonempty `approach`, and `steps` in the existing `text => serves N1 => evidence` notation. The `strategy` parameter is a **JSON string**, limited to 40,000 characters by the plugin before execution. DSH 0.1.5-rc.2 does not accept length keywords in its tool schemas, so these guards stay internal. Omit strategy for routine work. Omission during replanning preserves and revalidates the previous strategy; it does not erase acceptance obligations. Invalid JSON or references are refused before the plan changes.

The smallest supplied strategy is:

```json
{
  "risk": {
    "impact": "low",
    "uncertainty": "low",
    "reason": "A bounded reversible change with a well-understood interface"
  }
}
```

Choose the risk from the actual task. It is an agent-authored assessment, not an independently measured property. Optional collections normalize to empty arrays; selected and decision normalize to empty strings.

## Strategy fields

Unknown fields and invalid references are rejected. Identifiers use letters, digits, underscores or hyphens, begin with a letter, and are at most 32 characters. Identifiers within each collection must be unique.

| Field | Shape and meaning |
|---|---|
| `risk` | Required when a strategy is supplied: `{impact, uncertainty, reason}`. Both levels are `low`, `medium` or `high`; reason is nonempty. |
| `options` | Optional 2–4 alternatives, each `{id, title, tradeoffs, probe}`. An empty array is also valid. |
| `selected`, `decision` | With alternatives, select an existing option ID and explain the decision. A listed probe is a proposal until it actually runs. |
| `technology` | Up to 16 entries `{id, name, version, source, probe}`: record the relevant version, source and proposed compatibility check. |
| `execution` | Up to 64 entries `{step, dependsOn, doneWhen, replanWhen}`. Step IDs and dependencies must exist in the plan; duplicate dependencies and cycles are rejected. |
| `checks` | Up to 64 entries `{id, need, kind, criterion}`. Need references an existing requirement. Kind is `functional`, `integration`, `performance`, `compatibility` or `delivery`. **Every listed check is required before done.** |
| `questions` | Up to 32 entries `{id, question, blocking}`; blocking is a boolean. Resolve blocking decisions using existing authorization, investigation, or a necessary user answer, then revise the plan. |

Execution dependencies, `doneWhen` and `replanWhen` are plan and review data. Rigor validates their structure; it does not schedule tasks, detect every replanning condition, or run probes automatically. Native DSH tools still perform the work.

Use `rigor_brief(role="explore", ...)` to compare approaches and `rigor_brief(role="technical", ...)` to investigate versioned capabilities. The returned brief names the actual spawn tool. These roles are optional and their text findings are not independent review approvals.

Risk selects required review depth: one independent reviewer normally, two if impact or uncertainty is high; `diverge` if uncertainty is not low; `plan-review` if either dimension is not low. A recorded background job also requires monitoring. Requirement and step counts do not add reviewers or force user questions. Presets without child or question channels must state their limitations in the completion report.

## Declare numeric acceptance before running it

A performance check must add `metric`. Other check kinds cannot carry it:

```json
{
  "unit": "ms",
  "statistic": "p95",
  "operator": "lte",
  "threshold": 20,
  "minSamples": 3,
  "workload": "fixed-fixture-v1",
  "environment": "node24-fixture"
}
```

Statistics are `max`, `mean` or nearest-rank `p95`. Operators are inclusive `lte` and `gte`; threshold must be a finite number. `minSamples` is an integer from 1 to 10,000. Unit, workload and environment must exactly match the report's measurement context. This example's three samples and 20 ms threshold illustrate the schema; they are not a recommendation for a representative benchmark.

After recording requirement N1, an illustrative plan call is:

```js
rigor_plan({
  approach: "Validate the delivered processor under a fixed workload",
  steps: "Measure the delivered processor => serves N1 => a JSON report with samples and the tested file hash",
  strategy: JSON.stringify({
    risk: {
      impact: "low", uncertainty: "low",
      reason: "This isolated example checks a bounded fixture"
    },
    checks: [{
      id: "C1", need: "N1", kind: "performance",
      criterion: "p95 is at most 20 ms under fixed-fixture-v1",
      metric: {
        unit: "ms", statistic: "p95", operator: "lte", threshold: 20,
        minSamples: 3, workload: "fixed-fixture-v1", environment: "node24-fixture"
      }
    }]
  })
})
```

Run the actual validation using ordinary DSH tools **after** the plan is recorded. Generate a local JSON report from the observations. The template below contains illustrative samples and a placeholder hash; replace them with the actual result before linking it:

```json
{
  "check": "C1",
  "status": "passed",
  "observed": "Describe the measured result and the limits of the experiment",
  "environment": "node24-fixture",
  "subject": {
    "path": "dist/processor.js",
    "sha256": "<actual 64-character SHA-256 of the tested file>"
  },
  "measurement": {
    "unit": "ms",
    "samples": [10, 12, 15],
    "baselineSamples": [18, 20, 22],
    "workload": "fixed-fixture-v1",
    "environment": "node24-fixture"
  }
}
```

For functional, integration, compatibility or delivery checks, omit `measurement`. Reports are at most 256 KiB; `observed` is nonempty and at most 2,000 characters, `environment` at most 1,000, and `subject.path` at most 4,096. `subject.sha256` is the 64 hexadecimal digits without a `sha256:` prefix. Samples must be finite numbers, with enough values for the declared minimum and no more than 10,000. Optional baseline samples obey the same rules. Baselines are summarized for comparison; only the declared absolute threshold is a gate. Improving over a baseline does not excuse missing that threshold.

Link the report to its declared need and the observed command:

```js
rigor_evidence({
  needs: "N1", check: "C1",
  ref: "artifact:reports/check-C1-run1.json",
  run: "cmd:node verify-processor.mjs",
  note: "Fixed workload and recorded runtime; broader deployment remains untested"
})
```

`run` accepts `#<seq>` or `cmd:<fragment>` and must resolve to a command recorded in this session after the current plan. A typed check links only its declared need; ordinary artifact evidence can separately serve multiple needs. Paths are resolved using the agent's working directory. Keep linked reports unchanged and use a new report file for a new run.

Malformed reports, unknown checks, mismatched hashes or references are refused. A valid report with a failing command, failed status, insufficient samples, mismatched metric context or a missed threshold is **recorded as failed**. The tool returns `validation` with status, observations, environment, command sequence, subject fingerprint, applicable measured/baseline values and errors. A green command alone cannot turn a failed check into a pass.

## Completion, review and persistence

Done requires the latest validation for every declared check in the current round/reading/plan/work snapshot to pass. Replanning invalidates earlier checks and approvals, even when strategy is preserved; rerun validation after the revised plan. Outstanding blocking questions must be resolved in the plan.

Open the review brief after linking the latest check evidence. The comparison uses the **brief sequence**, not the later time when an approval is imported. Starting a reviewer before a check and importing its completed approval afterward is refused. Adding new check evidence also makes earlier approvals insufficient. Before accepting done, Rigor rechecks the fingerprints of reports and subjects, once per distinct path. External changes can therefore block completion even when a report still says passed.

State remains format 2 / shape 2. Strategy, check IDs and validation records survive restart; old sessions without these fields retain their round and evidence. No missing record is synthesized into a pass. A minimal preset can complete with passing checks and explicit limitations, but cannot supply an independent review.

## What validation establishes

The report author supplies status, environment, observations, samples and the claimed relationship between command and tested subject. Rigor checks that the command fact exists in the required order, checks its exit status, verifies current file hashes, and evaluates submitted numeric samples against declared conditions. It does **not** independently prove that the command actually loaded that file, that samples were truthfully measured, or that the workload represents users' circumstances. Reviewers must inspect that evidence and judge relevance, threshold choice and the accuracy of the declared risk.

No native execution engine or new external runtime dependency is introduced. Detailed help and role briefs enter model context when requested; they are not added in full to every standing prompt. Prompt-budget and synthetic tool/state tests exercise these mechanisms. They do not measure real LLM success rates or certify delivery quality.
