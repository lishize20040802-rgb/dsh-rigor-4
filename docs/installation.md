# 安装与原生包管理

Rigor-4 0.2.0 使用官方 DSH/pnpm 安装运行包。运行时零外部 npm 依赖；当前核对版本为 DSH **0.1.5-rc.2**。Node 版本以官方 DSH 要求为准，安装入口自身要求 Node 20 或更高。

## 使用

先用全局安装的官方 DSH 初始化目标 profile，并确保 npm、pnpm 可用：

```sh
npx --yes dsh-rigor-4@0.2.0 setup
```

`setup` 默认执行，加 `--preview` 只读检查 DSH。卸载入口为 `npx --yes dsh-rigor-4@0.2.0 uninstall`，也支持 `--preview`。`npx` 首次运行会下载公开包到 npm 缓存。

不使用 npm 包名时，可从 GitHub Release 启动同一入口：

```sh
npx --yes --package=https://github.com/lishize20040802-rgb/dsh-rigor-4/releases/download/v0.2.0/dsh-rigor-4-0.2.0.tgz dsh-rigor-4 setup
```

源码或解压目录使用 `node scripts/cli.mjs setup` / `uninstall`。底层 `node scripts/install.mjs` 和 `node scripts/uninstall.mjs` 默认只预览，传 `--apply` 才执行；Windows 薄包装 `./install.ps1` 沿用底层安装器的参数和默认值。预览可以执行只读的 `npm root --global` 定位查询，不执行安装、打包或删除。安装完成后继续用官方 `dsh web`，在界面选择 Rigor 预设。

| 参数 | 含义 |
|---|---|
| `--dsh-home PATH` | 默认使用非空 `DSH_HOME`，否则 `~/.dsh`。 |
| `--profile NAME` | 已存在的官方 profile，默认 `web`。 |
| `--package-root PATH` | 发布源码包；默认安装脚本所属包，可从任意工作目录运行。 |
| `--dsh-package PATH` | 已安装的官方 `@deepseek-ai/dsh` 包目录，直接调用其 CLI。默认通过 `npm root --global` 定位全局官方包，不采用 npx 临时 peer。 |
| `--store-dir PATH` | 显式 pnpm store。省略时读取目标 profile 的 `node_modules/.modules.yaml`；没有该文件时才沿用 pnpm 配置。 |
| `--replace-presets` | 显式覆盖已有不同的预设文件；默认保留。 |
| `--preview` | `dsh-rigor-4 setup` / `uninstall` 的只读模式；不加则执行。 |
| `--dry-run` / `--apply` | 底层脚本的只读预览 / 执行；底层默认预览。 |

非全局宿主安装须显式传 `--dsh-package`。Windows 会保留传给官方 CLI 的路径引号，支持目录空格；官方安装路径保持原位。命令行相对路径参数以当前工作目录解析。

## 原生安装流程

1. 用 `npm pack --ignore-scripts` 打包，生成 `DSH_HOME/third-party/archives/dsh-rigor-4-0.2.0.tgz`。归档作为可重装的本地源保留。同版本已有归档内容不同时停止，要求提升版本，避免悄悄替换已锁定发布包。
2. 调用 `dsh plugin --profile NAME add ARCHIVE --offline --ignore-scripts --ignore-pnpmfile`。运行包、依赖图、安装目录和锁文件由官方 DSH/pnpm 管理。
3. DSH 0.1.5-rc.2 会把命令行文件路径转成绝对 dependency。入口仅将自身 `package.json` dependency 归一化为 `file:../../third-party/archives/dsh-rigor-4-0.2.0.tgz`。
4. 调用 `dsh plugin --profile NAME install --lockfile-only --offline --ignore-scripts --ignore-pnpmfile`，让 pnpm 自己同步锁文件。入口不解析或改写锁文件。
5. 验证 profile 解析到所需版本的实际运行包，然后复制或保留四种预设的八个 YAML 文件。

```text
DSH_HOME/
  third-party/archives/dsh-rigor-4-0.2.0.tgz
  profiles/PROFILE/
    package.json                   # Rigor 使用相对 file: 归档
    pnpm-lock.yaml                 # 由原生 pnpm 生成
    node_modules/dsh-rigor-4/       # 由原生 pnpm 安装
  .agent-presets/
    rigor-4/
    rigor-4-ptc/
    rigor-4-cordis/
    rigor-4-minimal/
```

源码目录只用于开发与打包，运行时不再依赖它。入口不管理 profile 的 `node_modules`、SDK fallback 或额外运行副本，也不安装或移动官方 DSH。原生 `dsh plugin` 发现 Rigor 没有 `dsh.bundle` 时会提示按普通依赖安装；这是预期行为，插件由所选 Rigor agent preset 挂载。

## SDK 与离线行为

官方 profile 使用 `nodeLinker: hoisted`、`autoInstallPeers: false`。官方启动流程的 `healProfilesModuleFallback` 将已安装宿主依赖提供给 profile；需要 SDK peers 的插件可以通过该原生机制导入 SDK。Rigor 0.2.0 本身没有运行时 peers。

安装入口保留已有 profile 配置，禁用安装脚本和 pnpmfile，并要求 pnpm 离线处理。虽然 Rigor 无外部依赖，pnpm 仍可能核对同 profile 的其他依赖；它们不在缓存中时，安装会停止。入口不会偷偷联网补齐。打包仅需要本地 npm；发布时也可单独运行 `npm pack --ignore-scripts`。

pnpm 的本地 tarball 处理日志可能显示 `downloaded` 计数；配合 `--offline` 时，该计数也包含从本地归档导入缓存，不表示网络下载。

安装和卸载都自动读取 profile 的 `node_modules/.modules.yaml` 中的 `storeDir`：JSON 直接解析，标准 YAML 通过所选官方 DSH 的 `js-yaml` 解析。元数据中的末尾版本目录（例如 `v11`）去掉后，以真正的 `--store-dir` 命令行参数传给 pnpm。显式选项优先，解析失败时停止并说明如何显式指定。入口不依赖 pnpm 11 会忽略的 `npm_config_store_dir` 环境变量。

卸载调用 `dsh plugin --profile NAME remove dsh-rigor-4 --config.ignore-pnpmfile=true`，并附加同样的 `--store-dir`。`pnpm remove` 不接受 `--offline`、`--ignore-scripts` 和 `--ignore-pnpmfile` 简写，卸载使用 pnpmfile 的显式配置键并省略前两个选项，也不承诺它具有安装流程的离线约束。

## 预设、升级与失败边界

升级前先结束正在使用 Rigor 的活动任务。安装新版运行包使用同一入口：

```sh
npx --yes dsh-rigor-4@0.2.0 setup
```

`preset.yml` 和 `agent.cordis.yml` 按文件内容处理：缺少的文件补齐，相同内容保持不变，已有但内容不同的文件默认保留（包括旧版预设或自己的定制）。因此，升级运行包不代表预设定义也自动换成新版。预览列出每个文件的动作；如需完整采用本次发布的预设，先保存定制，再显式运行：

```sh
npx --yes dsh-rigor-4@0.2.0 setup --replace-presets
```

这会覆盖全部内容不同的 Rigor 预设文件。预览后发生的目标修改会被检测到。完成后重启 DSH、刷新网页并选择所需 Rigor 预设；安装器不选择默认 agent，也不修改模型路线。旧会话继续使用 format 2 / shape 2，保留原有记录；缺少策略与验收字段不会被补成通过结果。

重复安装会交原生 pnpm 核对现有包，同内容归档可以复用。升级使用新版本归档；旧归档不会自动删除。旧源码联接和旧运行副本的迁移或清理应由用户的整体迁移流程处理，入口不会擅自递归清理它们。

此入口是原生命令的薄包装，**不为整个 profile 提供事务回滚**。npm pack 或原生 add/锁刷新失败时，不会开始复制预设；原生包管理器可能已经修改 profile。预设写入失败也可能留下部分已复制文件。错误会说明阶段，保留已生成归档以便排查；仅清理本次暂存打包目录。批量迁移应在外部先备份 profile，再使用原生命令恢复，不要手拼锁文件或仅恢复 manifest。

## 卸载与数据保留

先结束 Rigor 活动任务，为新任务选择官方预设，再运行：

```sh
npx --yes dsh-rigor-4@0.2.0 uninstall
```

加 `--preview` 只查看计划。源码或解压目录可用 `node scripts/cli.mjs uninstall`；底层 `node scripts/uninstall.mjs --dry-run` / `--apply` 分别预览和执行。

卸载器先检查共享预设：其他 profile 仍依赖 Rigor 时保留；否则只删除与当前发布内容完全相同的八个预设文件。发现内容不同的预设时，在任何卸载前停止，需先导出并明确移除那些定义再重试。会话状态、凭据和发布归档均保留。完成后重启 DSH 并刷新网页。

## 验证范围

```sh
node --test
npm pack --ignore-scripts
```

默认安装测试不需要 SDK：使用临时 fixture 和替代命令 runner 验证转发顺序、安装禁用 lifecycle 的参数、卸载参数兼容性、自动 store 检测、全局宿主定位、相对 dependency、锁文件由原生 runner 负责、定制预设保留和错误传播。打包命令入口的测试同时覆盖目录联接和符号链接启动。

此前已在临时 DSH_HOME 中验证 DSH 0.1.5-rc.2 / pnpm 11.23.0：本地 tarball 离线安装、相对 manifest 与锁同步、重复安装、真实 Node import，以及 SDK peer 在原生 fallback 前失败、之后成功导入原位官方 SDK。此验证不启动真实 agent，不调用模型，不代表真实 LLM 工作流全部通过。

此前 0.1.3 入口也已通过真实 npm exec 本地 tarball 验证：setup / uninstall 的默认执行、两个预览均不修改临时 DSH_HOME、重复安装、从 pnpm 实际生成的 YAML 自动沿用含空格及 `&` 的 store、保留另一依赖与合成会话数据。卸载期间放置会直接报错的合成 pnpmfile，验证显式忽略配置确实生效；实际用户 profile 未参与此测试。

卸载与数据保留说明见 [中文 README](../README.zh.md#卸载)。
