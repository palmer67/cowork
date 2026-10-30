# cowork

**让多个 AI agent 在同一个 git 仓库里并行干活：互不踩脚，还能相互接力。**

Codex、Claude Code、DSH 这类 agent 各自有独立上下文，却共享同一个工作区——后写的静默覆盖
先写的，冲突要等到 merge 才暴露。`cowork` 在它们之间补一层轻量的协调协议：

- **隔离靠车道**：每个 agent 一条 worktree，物理上写不到一起；
- **秩序靠占位**：文件级 claim 撞车就是退出码 `2`，不是一句警告；
- **互知情靠共享状态**：who 占了什么、哪条车道有未提交改动，一条 `status` 看全。

它**不是**调度器，**不**碰容器，也**不**是写操作后台：只读看板是 P0，但看板只消费
`cowork snapshot --json`，唯一写者始终是 CLI。

## 状态

M0 与只读看板已完成，通过两轮对抗式评审，`main` 可用：

| 能力 | 命令 |
|---|---|
| 初始化 | `cowork init` |
| 占位 / 释放 | `cowork claim`、`cowork release` |
| 查看 | `cowork status`、`cowork snapshot` |
| 只读看板 | `cowork ui`、`cowork ui --watch` |
| 自检 | `cowork doctor` |

M1 任务层（`cowork task` / `cowork next` / `cowork brief` / `cowork lane new`）尚未实现，
协议已定稿：[docs/ARCHITECTURE-TASKS.md](docs/ARCHITECTURE-TASKS.md)。

## 为什么再造一个轮子

现有方案在这台 Windows 机器上都不成立：worktree 工具只解决隔离、不解决知情；编排面板要么
停更（vibe-kanban 于 2026-04 停止运营、crystal 改名后停滞），要么依赖 tmux / WSL / Docker
（claude-squad、container-use）。空白点是**跨厂商、文件级、零守护进程、Windows 原生**的
协调层。

## 安装

要求 Node ≥ 22.6（源码用 `--experimental-strip-types` 直接跑 TypeScript），git ≥ 2.40。

```bash
git clone https://github.com/palmer67/cowork.git
cd cowork
npm install
npm run build
npm link          # 把 cowork 放进 PATH；不 link 也可以直接 node dist/cli.js
```

## 快速开始

两个 agent、一个仓库，各占一条车道：

```bash
cd 你的项目
cowork init                                       # 建 .cowork/config.json，忽略 .cowork/lanes/
git worktree add .cowork/lanes/dsh -b dsh/work    # 每个 agent 一条车道
git worktree add .cowork/lanes/codex -b codex/work

# DSH 那边
cd .cowork/lanes/dsh && export COWORK_AGENT_ID=dsh
cowork claim src/auth/**                          # 目录按前缀占位

# Codex 那边（另一个终端）
cd .cowork/lanes/codex && export COWORK_AGENT_ID=codex
cowork claim src/auth/login.ts                    # 退出码 2，并打印谁占着、怎么解决
```

看板开着就行：

```bash
cowork ui --watch --open     # 每 2 秒重写一次，浏览器按 meta refresh 自己重载
```

## 命令

| 命令 | 说明 |
|---|---|
| `cowork init` | 建 `.cowork/config.json`（`schemaVersion`、`trunk`），并把 `.cowork/lanes/` 写进 `.gitignore` |
| `cowork claim <路径>...` | 占位。精确文件，或目录 / `dir/**` / `dir/` 记为前缀；多条要么全占上，要么一条不写 |
| `cowork release [<路径>...]` | 只释放本工作树本 agent 的占位；省略路径=全部 |
| `cowork release --force <路径>` | 人拆别人的占位，会打印原占用者 |
| `cowork status [--json]` | 当前所有占位及过期时间 |
| `cowork snapshot [--json]` | 只读快照：仓库、车道、未提交改动、最近交接、占位、诊断 |
| `cowork ui [--out <路径>] [--open]` | 生成静态单文件看板，不监听端口 |
| `cowork ui --watch [--interval <秒>]` | 前台循环重写（默认 2 秒），Ctrl+C 退出 |
| `cowork doctor [--fix]` | 检查状态目录；`--fix` 清理过期占位、把损坏文件隔离到 `trash/` |
| `cowork version` | 版本 |

不带参数运行 `cowork` 会打印用法。占位可选 `--note "<备注>"`，备注会带进看板。

## 退出码

| 码 | 含义 |
|---|---|
| `0` | 成功（含"这条本来就是我占的"这种幂等刷新） |
| `1` | 一般错误：参数不合法、路径越界、状态文件损坏、I/O 失败 |
| `2` | 被占用或冲突：claim 撞车、锁等待超时 |
| `3` | 环境不满足：找不到 git、不在仓库内、路径落在仓库外 |

错误信息一律包含**谁占着**和**怎么解决**，不是裸堆栈。

## 它怎么工作

**车道是仓库内部的 worktree。** 放在 `.cowork/lanes/<名字>` 而不是 `../`，因为 agent 的文件
沙箱可能只允许写 session workspace。worktree 让两个 agent 的编辑物理上互不可见，冲突从
"静默覆盖"变成"git 的冲突"。

**live 状态放在 `<git-common-dir>/cowork/`，不放工作树。** worktree checkout 不复制被
gitignore 的文件，状态放在工作树里就会每车道一份、彼此看不见。放共享 git 目录则天然跨车道，
且永远不进版本库。可提交的知识（交接单）在 `.cowork/notes/`，两者严格分开。

**占位键是"主仓库根相对路径"，不是物理路径。** 否则车道 A 的 `src/auth/login.ts` 和车道 B
的同名文件物理路径不同，会被判成不冲突——那正好放过了这个工具要防的事。规范化只做：转
正斜杠、去前导 `./`、去尾随 `/`、小写折叠；realpath 只用于消歧与越界检查。

**存活只由 TTL 决定，与 pid 无关。** 每次 `cowork claim` 都是一次短命进程，用 pid 判活会把
刚占好的位当成残留清掉（M0 实测踩过，见 [D7](docs/DECISIONS.md)）。默认 24 小时，
`COWORK_CLAIM_TTL_HOURS` 可覆盖。

**锁是目录 mkdir，只按"持有者已死"回收。** 不按锁龄回收：长操作被按时间抢走锁、原持有者
收尾又删掉新锁，等于没有互斥。释放前核对 token，不匹配就不删。8 进程 × 1000 次竞争的
零重叠门槛见 `tools/mutex-gate.mjs`。

## 看板

`cowork snapshot --json` 是唯一数据源，字段：`schemaVersion`、`generatedAt`、`repo`、
`tasks`、`contract_alerts`、`claims`、`lanes`。每条车道带
`lane` / `branch` / `head` / `dirty` / `changed_file_count` / `observed_at` / `last_handoff`
（读不出交接待时可带 `handoff_diagnostics`），
读失败时给 `error` 而不是伪装成 0。主工作树（agent 直接在主仓库里干活的那种）以
`lane: null` 出现，面板显示为 `(main)` 并排在最前。

面板不读 `.git/cowork`、不写任何状态、不监听端口：`--watch` 在前台重写同一个文件（先写
临时文件再 rename），页面靠 `<meta http-equiv="refresh">` 自己重载。进程被强杀时页面会停在
最后一次采样，页头始终显示"数据截至 <时间>"，旧数据能被识别出来。

## Windows 注意事项

- 并发原语按 NTFS 语义设计，不照搬 `flock`；hook 走 `cmd /C`，不假设有 `sh`。
- `git status` 一律带 `-c core.longpaths=true`；未开 `LongPathsEnabled` 的机器上超长路径
  仍可能统计不到（会报 lane `error`，不会伪装成干净）。
- 路径规范化按小写折叠处理，是 NTFS `$UpCase` 的近似；硬链接列为已知限制，不做检测。
- junction / 符号链接指向仓库外一律退出 `3`，不跟踪仓库外的文件。

## 已知限制

- 冲突检测只到**文件级**，不做 AST 或 hunk 级自动合并。
- 只能拉模式：cowork 不启动、不唤醒 agent，谁干活谁自己 `cowork claim`（M1 起是 `cowork next`）。
- 只管一个仓库及其 worktree，不跨仓库。
- `taskkill /F`、断电这类信号够不到的死亡，看板会停在最后一次采样。

## 开发

```bash
npm test                   # 48 个测试：node:test + 真实 git worktree
npx tsc --noEmit
npm run build
node tools/mutex-gate.mjs  # 并发门槛：8 进程 × 1000 次，一次重叠都不能有
```

自举：`cowork` 用自己管理自己的开发，`.cowork/notes/` 里有历次交接单。

## 文档

- [目标计划：需求、约束、验收标准](docs/PLAN.md)
- [架构：路径、claim、worktree、失败模式](docs/ARCHITECTURE.md)
- [任务层协议：任务对象、派工单、snapshot 契约](docs/ARCHITECTURE-TASKS.md)
- [已定决策（含被推翻的决策与复现路径）](docs/DECISIONS.md)

## 许可证

MIT
