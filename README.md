# dsh-rigor-4

English | [中文](README.zh.md)

Rigor-4 adds explicit requirements, plans, evidence, child-agent briefs and independent review records to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). DSH retains ownership of sessions, model calls, tools, approvals and subagents. This is an independent community plugin.

Release **0.1.3** targets the native contracts checked against **DSH 0.1.5-rc.2**. There are no external npm runtime dependencies. Other DSH releases require renewed contract testing; the plugin does not claim compatibility with every future release.

## Install

Initialize a native DSH profile first and ensure Node, npm, pnpm and a global official DSH installation are available. Install the public npm release:

```sh
npx --yes dsh-rigor-4@0.1.3 setup
```

Add `--preview` to inspect the plan without changing DSH. The `setup` and `uninstall` commands apply by default. The installer packs the release with `npm pack --ignore-scripts`, retains it at `<DSH_HOME>/third-party/archives/dsh-rigor-4-0.1.3.tgz`, forwards installation to `dsh plugin --profile web add`, asks native pnpm to refresh its lockfile, verifies package resolution, and copies four agent presets into `<DSH_HOME>/.agent-presets`. Existing customized files are preserved unless `--replace-presets` is explicitly passed.

The GitHub tarball is an alternative: `npx --yes --package=https://github.com/lishize20040802-rgb/dsh-rigor-4/releases/download/v0.1.3/dsh-rigor-4-0.1.3.tgz dsh-rigor-4 setup`.

`npx` downloads the public release into npm's cache. The subsequent DSH installation uses offline mode with installation scripts and pnpmfile disabled. Other dependencies already present in the target profile must be available locally; if pnpm reports missing cache entries, restore that profile's dependencies with the normal official DSH command before retrying. Versioned archives are preserved; native package-manager operations do not provide a transaction for the entire profile.

Useful options are `--dsh-home PATH`, `--profile NAME` (default `web`), `--dsh-package PATH`, and `--store-dir PATH`. The default home is `DSH_HOME` or `~/.dsh`. DSH is located through `npm root --global`, so an npx-local peer cannot be mistaken for the installed host; `--dsh-package` selects an explicit official installation. Both setup and uninstall read the existing profile's `node_modules/.modules.yaml` and forward its store as `--store-dir`; the explicit option overrides it. JSON metadata is read directly, and YAML uses the selected official DSH installation's parser.

From a clone or extracted release, use `node scripts/cli.mjs setup`. The lower-level `node scripts/install.mjs` and Windows `./install.ps1` retain their preview default; pass `--apply` to execute. See [installation details](docs/installation.md).

Restart DSH and select a Rigor preset in the agent selector. The package is activated by its agent preset rather than a global `dsh.bundle`; the official CLI warning that it is installed as a plain dependency is expected.

## Uninstall

Finish active Rigor tasks and choose a built-in preset for new tasks. Run:

```sh
npx --yes dsh-rigor-4@0.1.3 uninstall
```

Add `--preview` for inspection; the GitHub tarball command also accepts `uninstall` in place of `setup`. From a retained release, `node scripts/cli.mjs uninstall` provides the same operation; `node scripts/uninstall.mjs --dry-run` / `--apply` remain available. Removal uses official `dsh plugin --profile NAME remove dsh-rigor-4 --config.ignore-pnpmfile=true`, adding the detected `--store-dir`. pnpm remove does not support `--offline`, `--ignore-scripts` or the `--ignore-pnpmfile` shorthand. Removal uses the explicit pnpmfile configuration key and omits the other two flags. Shared presets remain if another profile still depends on Rigor. Otherwise, only preset files matching this release are removed. Customized presets stop the operation before removal; export and explicitly remove those definitions before retrying. Session state, credentials and release archives are preserved. Restart DSH and refresh the browser afterward.

## Tools and presets

| Tool | Purpose |
|---|---|
| `rigor_read` | Record the request, explicit and inferred requirements, and falsifiable acceptance conditions. |
| `rigor_plan` | Associate steps and expected evidence with requirements. |
| `rigor_brief` | Define a child agent's question, role and relevant requirements. |
| `rigor_evidence` | Link observations, commands or artifacts already present in this session. |
| `rigor_review` | Read a structured review from the bound review child's own log. |
| `rigor_report` | Check a completion claim or record an honest partial/blocked result. |

| Preset | Native base | Child agents and user-question channel |
|---|---|---|
| `rigor-4` | standard | Available |
| `rigor-4-ptc` | PTC | Available |
| `rigor-4-cordis` | cordis | Available |
| `rigor-4-minimal` | minimal | Unavailable; registers the four usable record tools |

State is isolated per session under `<DSH_HOME>/.rigor4/sessions/<sha256(sessionId)>.json`. Reading, plan and work revisions prevent older evidence or reviews from silently proving a newer delivery. Restarting or disposing an agent preserves these records.

## Model experience and limitations

Rigor adds stable prompt guidance and tool schemas, plus variable tool results. These consume context and may affect cache reuse according to the host/provider. The plugin does not make direct model requests, but its workflow can cause more tool calls, model turns and review subagents.

Evidence and review records can still be wrong. Tool and shell classifications are finite heuristics, and role prompts or plugin checks are not operating-system read-only sandboxes. In particular, a reviewer allowed to run shell checks may execute commands with side effects. The native sandbox and approval policy remain responsible for execution permissions. A minimal preset cannot provide independent review and must report that limitation.

## Development and validation

```sh
node --test
npm pack --ignore-scripts
```

Tests use synthetic state and native-command substitutes. They verify logic, event contracts and installer/uninstaller failure behavior without calling a live model. Passing them does not demonstrate every real LLM workflow or compatibility with untested DSH releases. Package archives exclude tests, user state and credentials; the Git repository includes the synthetic tests for contributors.

## License and attribution

[MIT](LICENSE). The four preset compositions are adapted from DeepSeek Harness 0.1.5-rc.2; its original MIT notice is retained in [LICENSE-DeepSeek](LICENSE-DeepSeek).
