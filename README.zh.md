# dsh-rigor-4

[English](README.md) | 中文

Rigor-4 为官方 DSH agent 增加需求读法、计划、证据、子任务和独立审阅记录。它挂在原生 preset、工具和 agent 事件上；会话、模型调用、工具执行和子代理仍由官方 DSH 负责。

版本：**0.1.3**。已核对原生 DSH **0.1.5-rc.2**。运行时没有外部 npm 依赖。其他 DSH 版本需要重新验证接口契约。

## 安装

先有可用的官方 DSH profile、npm 和 pnpm，然后使用公开 npm 包安装：

```sh
npx --yes dsh-rigor-4@0.1.3 setup
```

这个命令默认执行安装，加 `--preview` 只检查计划、不修改 DSH。`--dsh-home`、`--profile` 可以指定目标，默认使用原生 `DSH_HOME` / `~/.dsh` 和 `web` profile。先用官方 DSH 初始化 profile，并确保 Node、npm、pnpm 和全局安装的官方 DSH 可用。

也可直接使用 GitHub 发布包：`npx --yes --package=https://github.com/lishize20040802-rgb/dsh-rigor-4/releases/download/v0.1.3/dsh-rigor-4-0.1.3.tgz dsh-rigor-4 setup`。

`npx` 先将公开发布包下载到 npm 缓存。安装入口用 `npm pack --ignore-scripts` 生成 `<DSH_HOME>/third-party/archives/dsh-rigor-4-0.1.3.tgz`，交给官方 `dsh plugin --profile NAME add` 离线安装。它只把自身 dependency 归一化为相对 `file:` 路径，再让原生 pnpm 重新生成锁文件，并安装四种预设。已有定制预设默认保留。

运行包和锁文件统一由官方 DSH/pnpm 管理；官方插件和 SDK 保持原位。安装入口不创建源码联接或额外运行副本。它禁用 lifecycle 和 pnpmfile，离线缓存缺失时停止。原生安装失败可能留下包管理器的部分更改，入口不会承诺自动回滚整个 profile。

入口通过 `npm root --global` 定位真实的官方 DSH，不从 npx 临时 peer 解析宿主；非全局安装可以用 `--dsh-package PATH` 指向实际官方包。安装和卸载都会读取 profile 的 `node_modules/.modules.yaml`，以 `--store-dir` 转发原有存储目录；显式 `--store-dir PATH` 优先。JSON 元数据直接解析，YAML 使用所选官方 DSH 已安装的解析器，不增加运行依赖。

源码或解压目录也可执行 `node scripts/cli.mjs setup`。底层 `node scripts/install.mjs` 和 Windows `./install.ps1` 仍默认预览，传 `--apply` 才执行。

详见 [安装、预览与原生包管理](docs/installation.md)。日常继续使用官方 `dsh web`，在界面选择需要的 Rigor 预设。

## 六个工具

| 工具 | 记录或核对的内容 |
|---|---|
| `rigor_read` | 原始请求、明确和隐含需求，以及可证伪的验收条件 |
| `rigor_plan` | 计划步骤、关联需求和预期证据 |
| `rigor_brief` | 子代理问题、职责及其所服务的需求 |
| `rigor_evidence` | 本会话已记录的观察、命令或产物证据 |
| `rigor_review` | 从已绑定审阅子代理自身日志读取结构化结论 |
| `rigor_report` | 检查完成声明，或如实记录 partial / blocked |

标准流程是记录读法和计划、执行与取证、安排独立审阅，再提交报告。子任务通过原生工具启动；Rigor 根据成功启动结果中的 child ID 绑定 brief，审阅必须对应已有绑定。

记录使用 round、reading、plan 和 work revision 标记。`partial` / `blocked` 保留当前任务；完成后有新请求才开启新的 round。被拒绝的工具调用记录为 denied，不当作成功修改；执行失败但可能留下更改的情况单独记录。

## 四种预设

| 预设 | 原生基础 | 子代理 / 提问 |
|---|---|---|
| `rigor-4` | standard | 有 |
| `rigor-4-ptc` | PTC，工具通过 `run_code` SDK 呈现 | 有 |
| `rigor-4-cordis` | cordis，带运行时检查工具 | 有 |
| `rigor-4-minimal` | minimal | 无；只注册可用的四个记录工具 |

完整预设增加 explore、review、monitor 的子任务工具和角色说明。每个子代理继承父 agent 的原生 preset，再叠加角色约束和所选模型路线。角色门禁是插件逻辑，不能把提示词里的“只读”理解成操作系统沙箱保证；新增工具或执行入口需要同步验证分类。

minimal 的 persona 会覆盖普通 system prompt section，因此其预设内部保留精简纪律说明；没有独立审阅通道时，需要在完成报告中说明这一限制。

## 原生集成与边界

- 一个 preset 的插件实例常驻，由同 preset 的多个 agent 共享；状态按 session ID 区分。工具和提示词注册保持原生 scope 隔离。
- 工具 pre/execute/post/result、agent pre-step、turn-stopping、inbox claimed、session-start 和 disposed 构成集成边界。Rigor 不直接请求模型。
- 当前 0.1.5-rc.2 的原生 PTC SDK 子调用在源码上明确经过同一 pre/post 工具流水线。该结论来自原生源码核对；测试结果不等同于真实 LLM 场景全部通过。
- 证据存在不等于需求成立，审阅还要说明观察的适用范围；模型写出的隐含需求和审阅结论仍可能出错。
- 原生工具名、事件形状、预设组合或返回结果改变时，需要重新验证。包记录 `testedDSHVersions`，不以通配 peer 依赖宣称支持所有未来版本。

## 持久状态

每个 session 使用独立文件：

```text
<DSH_HOME>/.rigor4/sessions/<sha256(sessionId)>.json
```

存储目录与安装入口使用相同的路径规则：去除 `DSH_HOME` 首尾空白；空值使用 `~/.dsh`；展开 `~`、`~/` 和 `~\`；相对路径在创建存储后端时解析成绝对路径。此前把 `~` 当作普通目录名、或随工作目录变化的相对存储路径已修正。

文件使用 format 2、revision 检查和独占文件锁更新。旧 `sessions.json` 只读回退，避免为迁移而覆盖旧记录。重启或 agent dispose 不会删除任务记录。发布包不携带状态、凭据或会话。

## 验证与打包

```sh
node --test
npm pack --ignore-scripts
```

合成测试保留在 Git 仓库，安装和卸载入口随发布包提供；默认不需要 SDK。安装测试在临时 fixture 中验证零写入预览、原生命令转发、相对 dependency、预设保留、重复安装和失败边界。包管理器负责锁文件内容。原生验证范围见 [安装文档](docs/installation.md)。历史迁移脚本不属于发布和安装入口。

## 卸载

先结束使用 Rigor 预设的活动任务，选择官方预设作为新任务默认值，然后执行：

```sh
npx --yes dsh-rigor-4@0.1.3 uninstall
```

加 `--preview` 可只查看计划；GitHub 发布包命令同样把末尾 `setup` 改为 `uninstall` 即可。保留的发布目录可运行 `node scripts/cli.mjs uninstall`，底层 `node scripts/uninstall.mjs --dry-run` / `--apply` 也仍可用。卸载器调用官方 `dsh plugin --profile NAME remove dsh-rigor-4 --config.ignore-pnpmfile=true`，并传入检测到的 `--store-dir`。pnpm remove 不支持 `--offline`、`--ignore-scripts` 和 `--ignore-pnpmfile` 简写，因此卸载使用 pnpmfile 的显式配置键，并省略前两个安装参数。其他 profile 仍使用 Rigor 时保留共享预设；否则只删除与当前发布内容完全相同的八个预设文件。发现定制预设时在任何卸载前停止，先导出并明确移除那些定制预设再重试。会话记录、凭据、旧发布包都保留，卸载不递归清理个人数据。随后重启 DSH 并刷新网页。

## 第三方归属

四种预设改编自 DeepSeek Harness 0.1.5-rc.2 的 MIT 许可预设；原许可保留在 [LICENSE-DeepSeek](LICENSE-DeepSeek)。插件本身采用 [MIT](LICENSE)。
