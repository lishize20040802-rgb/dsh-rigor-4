# dsh-rigor-4

[English](README.md) | 中文

Rigor-4 帮助 agent 把请求变成可核查的交付：明确需求、比较方案、制定计划、收集证据，再进行独立审阅。它是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立社区插件；会话、模型调用、工具执行、审批和子代理仍由官方 DSH 负责。

**发布版本：[0.2.0](https://github.com/lishize20040802-rgb/dsh-rigor-4/releases/tag/v0.2.0)。** 已核对原生 DSH **0.1.5-rc.2** 的接口契约，运行时没有外部 npm 依赖。

## 插件能做什么

- **明确需求**：记录原始请求、明确需求、推测的隐含需求和验收条件，便于在交付前发现理解偏差。
- **探索方案与技术**：比较不同实现方式，记录选择理由；核对所用技术的版本、资料来源和待执行的小实验，避免凭印象依赖接口。
- **让计划对应实际工作**：把步骤关联到需求，记录依赖、完成条件和需要重新规划的情形。普通任务可以省略额外策略字段。
- **检查可测量的结果**：把功能、集成、兼容性、交付或性能检查关联到实际命令与本地报告；性能检查可按预设阈值核对样本，例如 p95 延迟。
- **按风险安排审阅**：为探索、审阅和监控子代理提供简报，绑定实际子任务，从审阅子代理自身记录中读取结论。不会仅因步骤变多就增加审阅或向用户提问。
- **如实报告进度**：检查完成声明是否有当前证据支持，也支持保留部分完成或受阻状态。记录按会话保存，重启后仍可读取。

例如优化一个接口时，可以先记录两种方案、框架版本、固定测试负载和延迟阈值。agent 通过 DSH 执行检查、关联报告，再请审阅者检查最终产物。Rigor 核对命令事实、文件哈希和提交的数值结果；实验是否真正证明需求得到满足，仍由审阅者判断。

## 0.2.0 新增能力

现有工具新增可选策略，支持方案探索、带版本的技术调查、步骤依赖、重规划条件与声明式验收检查。审阅深度跟随 agent 声明的风险，风险判断本身也需要审查。完成前，每个声明检查必须针对当前工作通过，且审阅简报须晚于最新检查证据。

详细策略说明通过 `rigor_plan({ strategy: "help" })` 按需获取，子任务收到对应角色简报。常驻纪律段与六工具的名称、描述和标准输入 schema 合计 UTF-8 体积，在相同统计口径下比 0.1.3 **约缩减 26%**。统计不含宿主提示、按需帮助/简报或运行事件，也不代表 token、延迟或模型能力提升。详细字段见 [策略与验收说明](docs/strategy.md)，本次变化见 [发布记录](CHANGELOG.md)。

## 安装或升级

先用官方 DSH 初始化目标 profile（运行配置），并确保 Node 20 或更高版本、npm 和 pnpm 可用；Node 同时须满足所用 DSH 版本的要求。然后执行：

```sh
npx --yes dsh-rigor-4@0.2.0 setup
```

该命令安装或升级运行包，加 `--preview` 可预览计划。已有且内容不同的预设文件**默认保留**；如需采用本次发布的预设定义，先保存自己的定制，再显式执行：

```sh
npx --yes dsh-rigor-4@0.2.0 setup --replace-presets
```

升级前结束正在使用 Rigor 的任务。安装后重启 DSH、刷新网页，在 agent 选择器中选用 `rigor-4`；也提供 PTC、Cordis 和 minimal 变体。安装不会替你选择默认 agent 或修改模型路线。官方提示“按普通依赖安装”属于预期行为，插件通过所选 agent 预设挂载。

也可以使用 GitHub 发布包：

```sh
npx --yes --package=https://github.com/lishize20040802-rgb/dsh-rigor-4/releases/download/v0.2.0/dsh-rigor-4-0.2.0.tgz dsh-rigor-4 setup
```

默认目标为 `DSH_HOME` / `~/.dsh` 下的 `web` profile；可用 `--dsh-home PATH`、`--profile NAME` 指定目标。入口通过 `npm root --global` 定位官方 DSH，非全局安装须传入 `--dsh-package PATH`。它自动沿用目标 profile 的 pnpm store，也接受显式 `--store-dir PATH`。

`npx` 先将发布包下载到 npm 缓存。安装入口通过 `npm pack --ignore-scripts` 保留 `<DSH_HOME>/third-party/archives/dsh-rigor-4-0.2.0.tgz`，再交给官方 DSH/pnpm 离线安装，并禁用安装脚本和 pnpmfile。同 profile 的其他依赖须已在本地可用。原生包管理失败可能留下部分 profile 更改；版本归档会保留。详见 [安装、升级与故障处理](docs/installation.md)。

源码或解压目录可以运行 `node scripts/cli.mjs setup`，安装该源码包自身的版本。底层 `node scripts/install.mjs` 和 Windows `./install.ps1` 默认预览，传 `--apply` 才执行。

## 六个工具与四种预设

| 工具 | 记录或核对的内容 |
|---|---|
| `rigor_read` | 原始请求、明确和隐含需求，以及可证伪的验收条件 |
| `rigor_plan` | 步骤与需求的关联；按需声明策略、依赖和验收检查 |
| `rigor_brief` | 子代理问题、职责及其所服务的需求 |
| `rigor_evidence` | 已记录的观察、命令或产物；核验声明检查的报告 |
| `rigor_review` | 从已绑定审阅子代理自身日志读取结构化结论 |
| `rigor_report` | 检查完成声明，或如实记录 partial / blocked |

| 预设 | 原生基础 | 子代理 / 提问通道 |
|---|---|---|
| `rigor-4` | standard | 有 |
| `rigor-4-ptc` | PTC | 有 |
| `rigor-4-cordis` | cordis | 有 |
| `rigor-4-minimal` | minimal | 无；只注册可用的四个记录工具 |

## 证据与持久状态

每个会话使用独立状态文件：`<DSH_HOME>/.rigor4/sessions/<sha256(sessionId)>.json`。需求读法、计划和工作修订号防止旧证据或旧审阅直接证明新的交付。0.2.0 继续使用 format 2 / shape 2；旧会话保留原有记录，缺失的策略或检查字段不会自动变成“验证通过”。重启或释放 agent 不会删除记录。

计划与技术探针为执行和审阅提供依据，实际工作仍由 DSH 工具完成。报告的状态、环境、样本以及命令与被测文件之间的关系由报告作者提供；哈希和阈值核对无法证明命令确实加载了该文件，或样本能代表目标负载。证据和模型判断仍需审查，minimal 不提供独立审阅。

角色约束依赖有限的工具与命令分类。执行权限由 DSH 沙箱和审批策略负责；允许运行 shell 检查的审阅者仍可能执行有副作用的命令。其他 DSH 版本需要重新核对原生契约。集成细节见 [设计说明](docs/design.md)。

## 卸载

先结束使用 Rigor 的活动任务，为新任务选择官方预设，然后执行：

```sh
npx --yes dsh-rigor-4@0.2.0 uninstall
```

加 `--preview` 可预览。GitHub 发布包命令同样把末尾 `setup` 改为 `uninstall`；源码安装可从对应版本的包目录运行 `node scripts/cli.mjs uninstall`。

卸载通过官方 DSH/pnpm 执行。其他 profile 仍依赖 Rigor 时保留共享预设；否则只删除与本次发布完全相同的预设文件。遇到定制预设会停止卸载，需先导出并明确移除这些定义后重试。会话记录、凭据和发布归档保留。完成后重启 DSH 并刷新网页。详见 [卸载与数据保留](docs/installation.md#卸载与数据保留)。

## 开发与验证

```sh
node --test
npm pack --ignore-scripts
```

合成测试覆盖策略解析、验收报告、审阅时序、持久化、提示体积预算和安装器失败行为，不调用真实模型，也不衡量 LLM 成功率或完整任务质量。按需帮助、工具结果和审阅子代理仍会占用上下文并可能增加模型轮次；常驻提示缩小不保证整项任务成本下降。打包只生成本地产物，不代表发布；发布包不携带测试、用户状态或凭据。

## 许可与归属

插件采用 [MIT](LICENSE) 许可。四种预设改编自 DeepSeek Harness 0.1.5-rc.2，其原始 MIT 许可保留在 [LICENSE-DeepSeek](LICENSE-DeepSeek)。
