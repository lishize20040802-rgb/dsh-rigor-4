# dsh-rigor-4

English | [中文](README.zh.md)

Rigor-4 helps agents turn a request into a reviewable delivery: clarify requirements, compare approaches, plan the work, collect evidence and obtain independent review. It is an independent community plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness); DSH runs the sessions, models, tools, approvals and child agents.

**Release: [0.2.0](https://github.com/lishize20040802-rgb/dsh-rigor-4/releases/tag/v0.2.0).** Native contracts have been checked against **DSH 0.1.5-rc.2**. The plugin has no external npm runtime dependencies.

## What it does

- **Clarify the request:** record explicit requirements, inferred needs and acceptance criteria, so a misunderstanding can be found before delivery.
- **Explore solutions and technologies:** compare alternatives and record why one was selected; capture technology versions, sources and proposed experiments before relying on an interface.
- **Keep the plan tied to the work:** associate steps with requirements, dependencies, completion conditions and reasons to replan. Ordinary tasks can omit the extra strategy fields.
- **Check measurable results:** connect declared functional, integration, compatibility, delivery or performance checks to recorded commands and local reports. Performance checks evaluate submitted samples against a chosen threshold, such as p95 latency.
- **Review according to risk:** brief exploration, review and monitoring agents, bind them to actual child tasks, and read review conclusions from the review child's own records. More steps alone do not add reviewers or user questions.
- **Report progress honestly:** require current evidence for a completion claim, or retain a partial/blocked result. Per-session records survive restarts.

For example, an API optimization can record two approaches, the installed framework version, a fixed workload and a latency threshold. The agent runs the check through DSH, links its report, and then requests review of the delivered result. Rigor verifies command facts, file hashes and submitted numeric results; the reviewer still judges whether the experiment proves the requirement.

## New in 0.2.0

Optional strategies bring solution exploration, versioned technology investigation, step dependencies, replanning conditions and declared acceptance checks into the existing tools. Review depth follows the agent's declared risk, which remains subject to review. Completion requires every declared check to pass for the current work, with review briefs created after the latest check evidence.

Detailed strategy help is requested with `rigor_plan({ strategy: "help" })`; role instructions arrive with the relevant brief. The standing guidance plus six tools' names, descriptions and standard input schemas use about **26% fewer UTF-8 bytes** than 0.1.3 under the same measurement scope. This excludes host prompts, requested help/briefs and runtime events; it is not a token, latency or model-quality measurement. See the [strategy guide](docs/strategy.md) and [release notes](CHANGELOG.md).

## Install or upgrade

First initialize the target profile using an official DSH installation. Node 20 or newer, npm and pnpm are required; also satisfy your DSH version's Node requirement. Then run:

```sh
npx --yes dsh-rigor-4@0.2.0 setup
```

This installs or upgrades the package. Add `--preview` to inspect the plan. Existing preset files with different content are **preserved by default**; to use the release's preset definitions, first save any customizations and explicitly run:

```sh
npx --yes dsh-rigor-4@0.2.0 setup --replace-presets
```

Finish active Rigor tasks before upgrading. After installation, restart DSH, refresh the browser and select `rigor-4` in its agent selector. PTC, Cordis and minimal variants are also available. Installation does not select a default agent or change model routes. The native warning about installing Rigor as a plain dependency is expected: the plugin is activated by its agent preset.

The GitHub release archive is an alternative:

```sh
npx --yes --package=https://github.com/lishize20040802-rgb/dsh-rigor-4/releases/download/v0.2.0/dsh-rigor-4-0.2.0.tgz dsh-rigor-4 setup
```

The default target is the `web` profile under `DSH_HOME` or `~/.dsh`. Use `--dsh-home PATH` and `--profile NAME` to choose another target. DSH is located through `npm root --global`; non-global installations need `--dsh-package PATH`. The installer detects the profile's pnpm store, or accepts `--store-dir PATH`.

`npx` downloads the release into npm's cache. Setup packs it with `npm pack --ignore-scripts`, retains `<DSH_HOME>/third-party/archives/dsh-rigor-4-0.2.0.tgz`, and uses official DSH/pnpm to install offline with installation scripts and pnpmfile disabled. Existing profile dependencies must already be available locally. Native package-manager failures can leave partial profile changes; versioned archives are retained. See [installation, upgrade and recovery details](docs/installation.md).

From a clone or extracted release, `node scripts/cli.mjs setup` installs that source package's version. The lower-level `node scripts/install.mjs` and Windows `./install.ps1` default to preview; pass `--apply` to execute.

## Tools and presets

| Tool | Purpose |
|---|---|
| `rigor_read` | Record the request, explicit and inferred requirements, and falsifiable acceptance conditions. |
| `rigor_plan` | Link steps to requirements; optionally declare strategy, dependencies and acceptance checks. |
| `rigor_brief` | Define a child agent's question, role and relevant requirements. |
| `rigor_evidence` | Link recorded observations, commands or artifacts; validate a declared check's report. |
| `rigor_review` | Read a structured review from the bound review child's own log. |
| `rigor_report` | Check a completion claim or record a partial/blocked result. |

| Preset | Native base | Child agents and user-question channel |
|---|---|---|
| `rigor-4` | standard | Available |
| `rigor-4-ptc` | PTC | Available |
| `rigor-4-cordis` | cordis | Available |
| `rigor-4-minimal` | minimal | Unavailable; registers the four usable record tools |

## Evidence and state

State is isolated per session under `<DSH_HOME>/.rigor4/sessions/<sha256(sessionId)>.json`. Reading, plan and work revisions prevent older evidence or reviews from silently proving a newer delivery. Format 2 / shape 2 is retained: old sessions keep their records, and missing strategy/check fields do not become passing results. Restarting or disposing an agent preserves state.

Plans and technology probes guide execution and review; native DSH tools perform the work. A report's status, environment, samples and claimed command-to-subject relationship are authored assertions. Hash and threshold checks do not establish that the command loaded that file or that the samples represent the target workload. Evidence and model judgments still need review, and minimal cannot provide independent review.

Role restrictions use finite tool and shell classifications. Execution permissions remain with DSH's sandbox and approval policy; a reviewer allowed to run shell checks can execute commands with side effects. Other DSH releases need their native contracts rechecked. See [design and integration details](docs/design.md).

## Uninstall

Finish active Rigor tasks and choose a built-in preset for new tasks, then run:

```sh
npx --yes dsh-rigor-4@0.2.0 uninstall
```

Add `--preview` for inspection. The GitHub archive command also accepts `uninstall` in place of `setup`; source installations can use `node scripts/cli.mjs uninstall` from the matching package.

Removal uses official DSH/pnpm. Shared presets remain if another profile depends on Rigor; otherwise, only preset files matching this release are removed. Customized presets stop removal: export and explicitly remove those definitions before retrying. Session state, credentials and release archives are preserved. Restart DSH and refresh the browser afterward. See [uninstall details](docs/installation.md#卸载与数据保留).

## Development and validation

```sh
node --test
npm pack --ignore-scripts
```

Synthetic tests cover strategy parsing, acceptance reports, review ordering, persistence, prompt budgets and installer failure behavior without calling a live model. They do not measure LLM success rates or complete task quality. Requested help, tool results and review agents still consume context and can add model turns; smaller standing guidance does not guarantee lower whole-task cost. Packing creates a local artifact, not a publication. Package archives exclude tests, user state and credentials.

## License and attribution

[MIT](LICENSE). The four preset compositions are adapted from DeepSeek Harness 0.1.5-rc.2; its original MIT notice is retained in [LICENSE-DeepSeek](LICENSE-DeepSeek).
