# 安装与原生包管理

Rigor-4 0.1.3 使用官方 DSH/pnpm 安装运行包。运行时零外部 npm 依赖；当前核对版本为 DSH **0.1.5-rc.2**。Node 版本以官方 DSH 要求为准，安装入口自身要求 Node 20 或更高。

## 使用

先用官方 DSH 初始化目标 profile，并确保 npm、pnpm 可用。解压发布包后执行：

```sh
node scripts/install.mjs --dry-run
node scripts/install.mjs --apply
```

默认只读预览，不执行包管理命令。Windows 薄包装 `./install.ps1` 接受相同参数。安装完成后继续用官方 `dsh web`，在界面选择 Rigor 预设。

| 参数 | 含义 |
|---|---|
| `--dsh-home PATH` | 默认使用非空 `DSH_HOME`，否则 `~/.dsh`。 |
| `--profile NAME` | 已存在的官方 profile，默认 `web`。 |
| `--package-root PATH` | 发布源码包；默认安装脚本所属包，可从任意工作目录运行。 |
| `--dsh-package PATH` | 已安装的官方 `@deepseek-ai/dsh` 包目录，直接调用其 CLI。默认先从 profile 的原生 fallback 解析，否则用 PATH 中的 `dsh`。 |
| `--store-dir PATH` | 可选 pnpm store；省略时使用 pnpm 原有配置。测试可用隔离缓存。 |
| `--replace-presets` | 显式覆盖已有不同的预设文件；默认保留。 |
| `--dry-run` / `--apply` | 只读预览 / 执行。 |

Windows 安装目标包含空格、又无法从 profile 解析官方包时，传 `--dsh-package`，以避开多层命令包装的参数歧义。官方安装路径保持原位。

## 原生安装流程

1. 用 `npm pack --ignore-scripts` 打包，生成 `DSH_HOME/plugin-packages/dsh-rigor-4-0.1.3.tgz`。归档作为可重装的本地源保留。同版本已有归档内容不同时停止，要求提升版本，避免悄悄替换已锁定发布包。
2. 调用 `dsh plugin --profile NAME add ARCHIVE --offline --ignore-scripts --ignore-pnpmfile`。运行包、依赖图、安装目录和锁文件由官方 DSH/pnpm 管理。
3. DSH 0.1.5-rc.2 会把命令行文件路径转成绝对 dependency。入口仅将自身 `package.json` dependency 归一化为 `file:../../plugin-packages/dsh-rigor-4-0.1.3.tgz`。
4. 调用 `dsh plugin --profile NAME install --lockfile-only --offline --ignore-scripts --ignore-pnpmfile`，让 pnpm 自己同步锁文件。入口不解析或改写锁文件。
5. 验证 profile 解析到所需版本的实际运行包，然后复制或保留四种预设的八个 YAML 文件。

```text
DSH_HOME/
  plugin-packages/dsh-rigor-4-0.1.3.tgz
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

官方 profile 使用 `nodeLinker: hoisted`、`autoInstallPeers: false`。官方启动流程的 `healProfilesModuleFallback` 将已安装宿主依赖提供给 profile；需要 SDK peers 的插件可以通过该原生机制导入 SDK。Rigor 0.1.3 本身没有运行时 peers。

安装入口保留已有 profile 配置，禁用安装脚本和 pnpmfile，并要求 pnpm 离线处理。虽然 Rigor 无外部依赖，pnpm 仍可能核对同 profile 的其他依赖；它们不在缓存中时，安装会停止。入口不会偷偷联网补齐。打包仅需要本地 npm；发布时也可单独运行 `npm pack --ignore-scripts`。

pnpm 的本地 tarball 处理日志可能显示 `downloaded` 计数；配合 `--offline` 时，该计数也包含从本地归档导入缓存，不表示网络下载。

## 预设、升级与失败边界

`preset.yml` 和 `agent.cordis.yml` 默认逐文件保留已有定制，缺少的文件补齐，相同内容保持不变。预览列出每个文件的动作。确需换为发布版本时使用 `--replace-presets`；预览后发生的目标修改会被检测到。

重复安装会交原生 pnpm 核对现有包，同内容归档可以复用。升级使用新版本归档；旧归档不会自动删除。旧源码联接和旧运行副本的迁移或清理应由用户的整体迁移流程处理，入口不会擅自递归清理它们。

此入口是原生命令的薄包装，**不为整个 profile 提供事务回滚**。npm pack 或原生 add/锁刷新失败时，不会开始复制预设；原生包管理器可能已经修改 profile。预设写入失败也可能留下部分已复制文件。错误会说明阶段，保留已生成归档以便排查；仅清理本次暂存打包目录。批量迁移应在外部先备份 profile，再使用原生命令恢复，不要手拼锁文件或仅恢复 manifest。

## 验证范围

```sh
node --test
npm pack --ignore-scripts
```

默认安装测试不需要 SDK：使用临时 fixture 和替代命令 runner 验证转发顺序、禁用 lifecycle 的参数、相对 dependency、锁文件由原生 runner 负责、定制预设保留和错误传播。

另已在临时 DSH_HOME 中验证 DSH 0.1.5-rc.2 / pnpm 11.23.0：本地 tarball 离线安装、相对 manifest 与锁同步、重复安装、真实 Node import，以及 SDK peer 在原生 fallback 前失败、之后成功导入原位官方 SDK。此验证不启动真实 agent，不调用模型，不代表真实 LLM 工作流全部通过。

卸载使用 `node scripts/uninstall.mjs --dry-run` / `--apply`，行为和数据保留说明见 [中文 README](../README.zh.md#卸载)。
