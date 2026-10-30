# cowork —— 多 agent 同仓协作工具 目标计划 v0.1

> 本文件是给 Codex 的**输入规格**（需求 + 约束 + 验收），不是架构书。
> 架构设计、模块划分、数据格式、失败模式由 Codex 产出；落地实现由 DSH 执行。
> 工作名 `cowork` 可改。

---

## 0. 一句话目标

让两个异构 agent（Codex CLI、DSH）在同一台 Windows 机器上、针对**同一个 git 仓库**同时干活：
物理上写不到一起（隔离），逻辑上知道对方干了什么（知情），并且能接着对方的成果往下做（互补）。

三个词概括设计哲学：

- **隔离靠 worktree** —— 每个任务一个工作区，不进同一个目录。
- **秩序靠 claim + guard** —— 文件/模块级占用声明，配 git hook 做硬拦截。
- **互补靠 handoff** —— 收工写结构化交接单，开工自动读。

---

## 1. 问题定义

### 1.1 现状

用户同时开着 Codex 和 DSH 两个 agent，各自有独立的会话上下文，但**共享同一个文件系统和同一个 git 工作区**。后果：

| 症状 | 原因 |
|---|---|
| 后写的覆盖先写的 | 两者编辑同一文件，谁最后落盘谁赢，静默丢失 |
| `git status` 被对方的改动污染 | 同一个工作区，看不出哪部分自己是自己改的 |
| 一个 agent 的编译/测试被对方的半成品搞挂 | 共享构建产物与未完成改动 |
| 互相重复造轮子 | A 不知道 B 已经加了 `utils/date.ts` |
| 合并时才发现冲突 | 冲突发现得太晚，返工成本高 |

### 1.2 为什么现成工具不够

- worktree 工具（`agent-worktree` / `git worktree`）只解决"物理隔离"，不解决"知情"和"互补"。
- 编排面板（vibe-kanban / crystal / claude-squad / agentbox）要么已停更关停，要么需 tmux/WSL/容器，在这个 Windows 环境上不可用；且它们把 agent 当黑盒调度，不介入"我要改哪几个文件"这一层。
- 容器方案（container-use）在 Windows 上需 WSL + Docker，重且实验性。

**空白点：一个轻量的、跨厂商的、文件级的协作协调层。它不是调度器，是"占位与交接"的协议实现。**

---

## 2. 非目标（明确不做）

1. 有任务层，但智能在 agent 侧（人 + agent 拆任务）；cowork 只负责纪律（队列、依赖、占位、汇总）。不做自动拆解、不做 LLM 调度、不启动 agent 进程或推送派工。Agent 通过拉模式自行调用 `cowork next` 领取可执行任务。详见 `docs/ARCHITECTURE-TASKS.md`。
2. 不做 Web UI 或桌面面板。CLI 优先，`--json` 供将来接 GUI。
3. 不用容器、不用 Docker、不用 WSL、不起后台守护进程。
4. 不改 Codex / DSH 的安装或二进制。只能通过 AGENTS.md、git hook、CLI、可选的 MCP server 接入。
5. 不做代码语义理解 / AST 级自动合并。冲突检测只到"文件 + hunk 重叠"这一层，够用即可。
6. 不做跨机器同步。单机多进程。
7. 不做权限系统 / 用户账号。同一 OS 用户。

---

## 3. 硬约束（这些是环境事实，架构必须迁就）

| 约束 | 影响 |
|---|---|
| **Windows 10/11 + NTFS** | 路径长度、CRLF、文件锁语义、`cmd /C` 而非 `sh -c`、无 POSIX 原子 rename 保证。所有并发原语必须按 Windows 验证。 |
| **DSH 文件沙箱 = 仅可写 session workspace** | worktree **必须**建在仓库目录内部（如 `.cowork/lanes/`），不能放 `../`。这直接决定 lane 的目录布局。 |
| **Codex 只认工作目录内的 AGENTS.md** | 规则注入只能靠文件，不能靠环境变量或配置中心。 |
| **Node v22.14.0 / npm 10.9.2 可用，git 在 D:\Git** | 首选 TypeScript CLI + npm 分发。避免引入需要编译的原生依赖（无 MSVC 保证）。 |
| **`wt` 命令名已被 Windows Terminal 占用** | 工具不能叫 `wt`，避免 PATH 撞名。 |
| **两个 agent 都在交互式使用，人随时在场** | 失败模式必须"显式报错并保留现场"，不允许静默清理或自动回滚。 |

---

## 4. 用户故事（验收就以这四条为准）

**US-1 并行不打架**
我在 Codex 里让它改 `src/auth/`，同时切到 DSH 让它改 `src/billing/`。两边各自在独立 worktree 里跑，各自 `git commit`。收工时先合 Codex 的，再合 DSH 的，**零冲突**，且两边测试都还能过。

**US-2 冲突早知道**
我忘了，两个 agent 都被指派去改 `src/auth/login.ts`。第二个 agent 开工时必须**在动手前**被拦住或强烈警告："该文件已被 lane `codex/fix-login` 占用"，并给出占用者的分支和交接单摘要。它应该能选择换文件、或先跟对方协调。

**US-3 知情**
我新开一个 DSH 会话，敲 `cowork brief`。它告诉我：Codex 现在在 `codex/fix-login` 上干活，改了 3 个文件，其中 `src/api/client.ts` 的 `request()` 签名被改了（这是我不能破坏的契约），最近两条交接单说了什么。

**US-4 互补**
DSH 在 Codex 的成果上继续做（合并基线后接着改），而不是把 Codex 刚写的那个工具函数再造一遍。收工它写一条交接单，下一个 agent 开工时自动读到。

---

## 5. 功能需求

### P0（没有它就不成立）

- **F1 `init`**：把仓库变成协作仓库。生成 `.cowork/config.json`、向根 `AGENTS.md` 追加受管区块（带 `<!-- cowork:begin -->` 标记，可重复执行幂等）、必要时写 `.gitignore` 条目。
- **F2 `lane new/ls/rm`**：基于 `git worktree` 建车道，命名 `<agent>/<slug>`，记录 base 分支。lane 根目录固定 `.cowork/lanes/<slug>/`。
- **F3 `claim` / `release`**：声明占用一组路径（glob）。同一路径被他人持有时，`claim` 以非零退出码失败并说明持有者。支持 TTL + 心跳续期。
- **F4 跨 lane 可见性**：live 状态必须对**所有 worktree**同时可见且只有一份。**建议放在 `$(git rev-parse --git-common-dir)/cowork/`（即主仓库 `.git/cowork/`）**：天然被所有 worktree 共享、不进 `git status`、不会被误提交；代价是人不能靠 `ls` 看见，必须走 CLI。
- **F5 `brief`**：给即将开工的 agent 输出一份"现状摘要"——活跃 lane 列表、文件占用表、最近 N 条交接单、需要遵守的接口契约。设计成可直接被 agent 读的纯文本（也支持 `--json`）。
- **F6 `handoff`**：结构化交接单，落盘到 `.cowork/notes/`（**提交进 git**，与 live 状态刻意分开）。
- **F7 `guard`**：硬拦截。`pre-commit` 检查提交的路径是否违反他人 claim；冲突时退出码非零并给提示。可 `--force` 绕过（给人留后门）。

### P1（强烈需要）

- **F8 `merge <lane> --dry-run`**：合并前预检——hunk 重叠、双方都改了同一文件的不同区域时的提醒、目标分支是否落后、测试是否可跑。
- **F9 `status`**：人类可读的全局视图（活跃 lane、落后/领先、占用、脏工作区）。
- **F10 `doctor`**：环境与仓库体检——残留 lock、过期 claim、孤立 worktree、`.gitignore` 是否漏了 lanes、AGENTS.md 区块是否被手改坏。
- **F11 stale 恢复**：进程崩溃/断电后，过期 claim 必须能被 `doctor` 识别并安全回收；不能出现"死锁到需要手删文件"。

### P2（可选加分）

- **F12 MCP server**：把 `claim/release/brief/handoff` 暴露成 MCP 工具，让 agent 不用记 CLI 语法（DSH 已支持 MCP）。这是"让 agent 自觉遵守"的最优解。
- **F13 patch 队列**：同一文件的并发修改排队串行应用，自动 rebase。
- **F14 `watch`**：可选的文件监听模式，实时提示 lane 之间的重叠。

---

## 6. 数据落盘布局（建议，待 Codex 确认）

```
<repo>/
├── AGENTS.md                       # 受管区块，指向 .cowork/AGENTS.cowork.md
├── .cowork/
│   ├── config.json                 # 提交：项目级配置（trunk、lane 前缀、超时）
│   ├── AGENTS.cowork.md            # 提交：给 agent 的协作规则正文
│   ├── notes/                      # 提交：交接单、决策记录、接口契约
│   │   └── 2026-10-30T15-00-codex-fix-login.md
│   └── lanes/                      # gitignore：worktree 落点
│       └── fix-login/              #   一个 checkout
└── .git/cowork/                    # 不进版本库，被所有 worktree 共享
    ├── claims/<claim-id>/meta.json #   原子目录 mkdir 抢锁
    ├── claims/<claim-id>/paths     #   占用路径清单
    └── heartbeat/<lane>/<ts>       #   心跳
```

**契约要点**：`notes/` 是可提交的知识，`live/` 是易失的运行态；两者绝不能混放，否则每次提交都会产生噪音 diff。

---

## 7. 命令面（草案）

```
cowork init
cowork lane new <slug> [--agent codex|dsh|other] [--base <branch>]
cowork lane ls | cd <slug> | rm <slug> [--force]
cowork claim <glob...> [--ttl 30m] [--note "为什么占"]
cowork release [<glob...>] [--all]
cowork brief [--for codex|dsh] [--json]
cowork handoff --task "..." --files <paths> --contract "..." --next "..."
cowork status [--json]
cowork merge <slug> [--dry-run] [--squash]
cowork guard            # 给 git hook 用，也可手动跑
cowork doctor [--fix]
```

统一约定：人类可读走 stdout，机器输出走 `--json`，**错误信息必须包含"谁占着"和"怎么解决"**；退出码语义固定（0 成功、1 一般错误、2 冲突/被占用、3 环境不满足）。

---

## 8. 验收标准（可执行，逐条测）

1. 两个 lane 改不同文件 → 依次 merge，**零冲突**，双方测试通过。
2. 两个 lane 改同一文件 → 第二个 `claim` 失败，退出码 2，消息含持有者 lane 名。
3. `kill -9` 掉持有 claim 的进程 → 过了 TTL 后 `doctor` 能识别，`claim` 可被新 lane 取得。
4. 仓库重启 / 新开 shell / 新开 worktree → live 状态仍在且一致（证明放在 git-common-dir 的选择是对的）。
5. 从 lane 内部运行任何命令，读到的都是主仓库的那一份 live 状态（不能因为 worktree 是独立 checkout 就各自为政）。
6. `pre-commit` 在违反 claim 时确实拦下提交（真跑一次 `git commit` 验证）。
7. Windows 路径：中文路径、空格路径、>260 字符路径三种情况都不崩（或优雅报错）。
8. 全部功能在 PowerShell 与 cmd 下可用；不依赖 bash、不依赖 WSL。
9. `npm i -g` 后零配置可用；`cowork doctor` 在空仓库上给出可读诊断而非堆栈。
10. 不修改 agent 本体即可工作（把 `codex` 和 DSH 的安装目录校验一遍 hash 不变）。

---

## 9. 里程碑

| 阶段 | 内容 | 交付判据 |
|---|---|---|
| M0 | CLI 骨架 + `init` + `lane new/ls` + live 状态落在 git-common-dir + `claim/release` 原子性 | 验收 2、5 通过 |
| M1 | `brief` + `handoff` + AGENTS.md 注入（含对 Codex/DSH 的差异化措辞） | 验收 1、4 通过，US-3/US-4 演示成立 |
| M2 | `guard` + git hook 安装 + `doctor` | 验收 3、6 通过 |
| M3 | `merge --dry-run` + `status` + Windows 路径加固 | 验收 7、8、9、10 全绿 |
| M4 | 可选：MCP server、patch 队列 | 加分项 |

建议 M0 就先做出能跑的最小闭环，然后**用它自己管它自己的开发**（自举），这是最好的压力测试。

---

## 10. 留给 Codex 的架构决策清单（架构书必须逐条正面回答）

1. **claim 的原子性怎么在 Windows 上保证？** 目录 `mkdir`、`O_EXCL` 文件、还是锁文件 + 重试？给出选择的实测依据与兜底策略（NTFS 上 `rename` 语义、杀毒软件短暂锁文件都是已知坑）。
2. **stale lock 怎么判定？** 只用 TTL 会误杀长任务；用 pid 会跨会话失效；pid + 进程启动时间？还是心跳文件 mtime？给出失效判定的完整状态机。
3. **为什么选 `.git/cowork/` 而不是 `.cowork/live/`？** 如果选后者，如何解决"worktree 是独立 checkout、gitignore 的文件不会被复制过去"导致每个 lane 各有一份状态的问题？反过来如果选前者，如何在人可见性上补偿（`cowork status` 之外还要不要一个只读镜像文件）？
4. **嵌套 worktree 的 git 陷阱**：`.cowork/lanes/x` 在仓库内部，`git status`、`git add -A`、`git clean`、IDE 索引、文件监听会不会把它当普通目录？`git worktree add` 在 repo 内的已知限制是什么？是否需要 `core.hooksPath` 的特殊处理（相对路径在 worktree 里不解析⚠️）？
5. **handoff 的 schema 设计**：字段如何既结构化又让两个不同厂商的 agent 都愿意填？是否用 front-matter + 自由正文？如何避免变成"没人读的文档坟场"（brief 里怎么排序、怎么过期）？
6. **软约束 vs 硬约束的分层**：AGENTS.md（软，agent 可能忽略）与 git hook（硬，但只在 commit 时触发）之间怎么补位？要不要一个 `cowork preflight` 让 agent 在开始编辑前必须调用（靠 AGENTS.md 强制）？被忽略时的兜底是什么？
7. **同一文件并发编辑**：只做抢占（第一个赢）够不够？还是需要 patch 队列（P2/F13）？如果要做，如何在 Windows 上安全地串行化（文件锁 vs 单写者进程）？
8. **失败模式全表**：断电、agent 崩溃、用户手改 live 状态、lane 被 `rm -rf`、base 分支被别人 force push、两人同时 `merge`——每种情况工具应该做什么（拒绝 / 自愈 / 保留现场），列成表。

另外请明确：**模块划分、目录结构、依赖清单（希望零运行时依赖或极少）、测试策略（在 Windows 上怎么自动化测并发）**。

---

## 11. 我自己评审架构书时用的五条尺子

1. 有没有认真处理"worktree 内部看不到 gitignore 状态"这个致命细节？
2. Windows 并发原语是不是真的验证过，还是照搬了 Linux 的 `flock`？
3. 崩溃恢复是不是闭环（能不能不靠人手工删文件恢复）？
4. 是不是把"agent 会不自觉"当成一等公民（否则工具很好但没人用）？
5. 有没有偷偷膨胀成调度器/看板（超出非目标就该砍）。

---

## 12. 待用户确认

- 第一个接入的仓库路径（当前 `default-workspace` 不是 git 仓库）。
- 工具名是否用 `cowork`（已排除 `wt`）。
- 是否接受"live 状态放在 `.git/cowork/`"（人不可见，但最干净）。
