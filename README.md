# cowork

**让多个 AI agent 在同一个 git 仓库里并行干活，互不踩脚，还能接力。**

![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.6-3c873a)
![Platform](https://img.shields.io/badge/platform-Windows-0078d4)
![Tests](https://img.shields.io/badge/tests-104%20passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-informational)

Codex、Claude Code、DSH 这类 agent 各自有独立上下文，却共享同一个工作区：后写的静默覆盖先写的，冲突要等到 merge 才暴露。`cowork` 在它们之间补一层轻量的协调协议：

- **隔离靠车道**：每个 agent 一条 `git worktree`，物理上写不到一起；
- **秩序靠占位**：文件级 `claim` 撞车就是退出码 `2`，不是一句警告；
- **互知情靠共享状态**：谁占了什么、哪条车道有未提交改动、每个任务到哪一步，一条 `status` / `snapshot` 看全；
- **接力靠任务队列**：读写集、依赖、完成条件都写在可提交的 spec 里，`next` 原子领取，崩溃可恢复。

它**不是**调度器，**不**碰容器，也**不**是写操作后台：只读看板是 P0，但看板只消费 `cowork snapshot --json`，唯一写者始终是 CLI。

```bash
cowork lane new dsh              # 建一条车道（worktree）
cowork claim "src/auth/**"       # 占位：目录前缀
cowork next                      # 从队列里原子领取一个任务
cowork ui --watch --open         # 只读看板，2 秒自动刷新
```

---

## 目录

- [为什么需要它](#为什么需要它)
- [它不做什么](#它不做什么)
- [工作原理](#工作原理)
- [安装](#安装)
- [快速开始（5 分钟）](#快速开始5-分钟)
- [教程](#教程)
  - [1. 两个 agent 并行改代码](#1-两个-agent-并行改代码)
  - [2. 用任务队列派工](#2-用任务队列派工)
  - [3. 只读看板](#3-只读看板)
  - [4. 日常自检](#4-日常自检)
- [命令参考](#命令参考)
- [退出码](#退出码)
- [配置](#配置)
- [状态存在哪](#状态存在哪)
- [常见问题](#常见问题)
- [已知限制](#已知限制)
- [开发](#开发)
- [文档](#文档)
- [许可证](#许可证)

## 为什么需要它

现有方案在这台 Windows 机器上都不成立：worktree 工具只解决隔离、不解决知情；编排面板要么停更（vibe-kanban 于 2026-04 停止运营、crystal 改名后停滞），要么依赖 tmux / WSL / Docker（claude-squad、container-use）。空白点是**跨厂商、文件级、零守护进程、Windows 原生**的协调层。

具体要解决的事：

| 问题 | 现状 | cowork 的做法 |
|---|---|---|
| 两个 agent 改同一个文件 | 后写的静默覆盖，merge 时才炸 | 占位撞车立刻退出 `2`，并打印谁占着 |
| 不知道别的车道在动什么 | 靠人肉口头同步 | `status` / `snapshot` 汇总所有车道与未提交改动 |
| 任务派下去就失联 | 聊天里散落，无法审计 | 任务 spec 进版本库，状态机可查 |
| 领任务时并发抢同一个 | 手写锁，容易半途而废 | `next` 是一条可恢复的事务，崩溃不留半成品 |

## 它不做什么

- ❌ 不自动拆解任务、不做 LLM 调度、不启动或推送任务给 agent——agent 用拉模式自己 `cowork next`；
- ❌ 不做自动 fan-out；并行边界只由依赖、`touches`、占位规则决定；
- ❌ 不做写操作后台，不用 Electron，不监听端口；
- ❌ 不用 Docker / WSL / 后台守护进程；
- ❌ 不做 AST 级自动合并，冲突检测只到文件 + hunk 重叠；
- ❌ 不修改 Codex、DSH 等 agent 的安装或二进制。

## 工作原理

四个概念，够用。

**车道（lane）** —— 仓库内部的 `git worktree`，默认建在 `.cowork/lanes/<名字>`。不用 `../`，因为 agent 的文件沙箱可能只允许写 session workspace。两个 agent 各占一条车道，编辑物理上互不可见。

**占位（claim）** —— 文件级短期租约。键是「主仓库根相对路径」，所以车道 A 的 `src/auth/login.ts` 和车道 B 的同名文件算同一个键——这正是要防的冲突。占位存活**只由 TTL 决定**（默认 24 小时），与 pid 无关：`cowork claim` 每次都是短命进程，用 pid 判活会把刚占好的位当残留清掉。

**live 状态** —— 放在 `<git-common-dir>/cowork/`（通常是 `.git/cowork/`），不放工作树。worktree checkout 不复制被 gitignore 的文件，状态放工作树里就会每车道一份、彼此看不见。它永远不进版本库。可提交的知识（交接单）在 `.cowork/notes/`，两者严格分开。

**任务（task）** —— 一份可提交的 spec（`.cowork/tasks/<id>.md`，id 是不透明的 `t-` + 6 位十六进制），加一份共享的 live 状态：

```
draft ──ready──▶ ready ──next──▶ claimed ──start──▶ in_progress
        ──report-done──▶ reported_done ──confirm-merge──▶ merged
```

`block` / `cancel` 在进入 `merged` / `cancelled` 之前都由 lease 持有者调用；`cancel` 会同时释放 lease 与占位。

`next` 是一条事务：锁外算候选集 → 取锁 → 恢复上次未完成的事务 → 重算候选集 → 写 intent → 占 lease → 占文件 → 提交 → 清理。要么全成，要么一条不写；进程被强杀也能在下次取锁命令时自动回滚。

## 安装

要求 **Node ≥ 22.6**（源码用 `--experimental-strip-types` 直接跑 TypeScript）、**git ≥ 2.40**。零运行时依赖。

```bash
git clone https://github.com/palmer67/cowork.git
cd cowork
npm install
npm run build

npm link            # 把 cowork 放进 PATH
# 不想 link 也可以直接：node dist/cli.js <命令>
```

验证：

```bash
cowork version      # cowork 0.0.0 (M1)
```

## 快速开始（5 分钟）

在一个**已有 git 仓库**里，建两条车道，让两个 agent 各改各的。

### 1) 初始化

```bash
cd 你的项目
cowork init
```

```
已创建 .cowork/config.json（trunk=main）
已写入 .gitignore: .cowork/lanes/
live 状态目录: /path/to/仓库/.git/cowork（不进入 Git）
```

把 `.cowork/config.json` 提交掉。

### 2) 建车道

```bash
cowork lane new dsh
cowork lane new codex
```

```
已创建车道 dsh: /path/to/仓库/.cowork/lanes/dsh
  branch: cowork/dsh（base main）
  cd /path/to/仓库/.cowork/lanes/dsh
  建议: COWORK_AGENT_ID=dsh
```

两条车道是两个真实目录，各开一个终端：

```bash
# 终端 1
cd .cowork/lanes/dsh && export COWORK_AGENT_ID=dsh
cowork claim "src/auth/**"

# 终端 2
cd .cowork/lanes/codex && export COWORK_AGENT_ID=codex
cowork claim src/auth/login.ts
```

第二条会退出码 `2`，并告诉你谁占着：

```
cowork: 路径已被占用: src/auth/login.ts ← /path/to/仓库 agent=dsh 的 pid 14236@…，于 2026-10-30T15:45:20.186Z
  → 先运行 cowork status 看全部占位；等对方 cowork release，或换一条不冲突的路径。万一对方已经崩溃，
    由人来运行 cowork release --force src/auth/login.ts（会打印原占用者）。cowork 不给 claim --force：
    抢占会让两个 agent 同时改同一个文件。
```

## 教程

### 1. 两个 agent 并行改代码

**占位一个文件或一个目录前缀。** 精确文件写全路径；目录写 `dir/**`、`dir/` 或 `dir` 都会记成前缀：

```bash
cowork claim src/auth/login.ts            # 单文件
cowork claim "src/auth/**"                # 整个目录
cowork claim src/a.ts src/b.ts            # 多条要么全占上，要么一条不写
cowork claim src/a.ts --note "改登录文案"  # 备注会带进看板
```

**看谁占了什么：**

```bash
cowork status
```

```
仓库: /path/to/仓库
本工作树: lane dsh  agent=dsh
live 状态: /path/to/仓库/.git/cowork

路径           车道           占用者                                 过期时间
src/auth/**  (主)            pid 14236@W11-… agent=demo            2026-10-31T15:45:20.186Z
```

**改完释放：**

```bash
cowork release                             # 释放本工作树本 agent 的全部占位
cowork release src/auth/login.ts           # 只释放指定路径
cowork release --force src/auth/login.ts   # 人拆别人的占位（会打印原占用者）
```

> **为什么没有 `claim --force`？** 抢占会让两个 agent 同时改同一个文件，冲突被推后到 merge。要拆别人的位，必须由人显式 `release --force`，并且看到原占用者是谁。

> **两个 agent 共用一个工作树时**，务必各自设 `COWORK_AGENT_ID=codex` / `COWORK_AGENT_ID=dsh`，否则会被当成同一个 owner 而不互斥。

### 2. 用任务队列派工

任务 = 一份可提交的 spec + 一份共享的 live 状态。派工的人写 spec，干活的人用 `next` 领。

#### a. 建任务（draft）

```bash
cowork task add \
  --title "补登录校验" \
  --touches src/auth/login.ts \
  --reads src/auth/token.ts \
  --done-when "npm test" \
  --done-when "手动验证错误密码提示"
```

```
已创建 t-1cb3e3（draft）
  /path/to/仓库/.cowork/tasks/t-1cb3e3.md
下一步: 把 spec 提交到 trunk 后运行 cowork task ready t-1cb3e3。
```

`--touches` 是**写集**，`--reads` 是**读集**（用于契约提醒），`--depends` 引用另一个任务 id。spec 进版本库、可以 review，`ready` 之后不可再改。

#### b. 提交 spec，进入 ready

```bash
git add .cowork/tasks && git commit -m "task: 补登录校验"
cowork task ready t-1cb3e3
```

```
t-1cb3e3 → ready（spec_commit 0b5fc590…）
下一步: cowork next 领取，或先 cowork task ls 查看队列。
```

> `ready` 要求 spec 已在 trunk 可达。没提交就 `ready` 会退出 `1`——这是防止「口头任务」。

#### c. 领取

```bash
cd .cowork/lanes/dsh && export COWORK_AGENT_ID=dsh
cowork next
```

```
已领取 t-1cb3e3  补登录校验
  touches: src/auth/login.ts
  depends_on: (空)
  done_when: npm test
  lane: dsh  agent: dsh
  spec_commit: 0b5fc590…
下一步: cowork task start t-1cb3e3
```

`next` 按 FIFO 领最早可干的 ready 任务，同时占好它的 `touches`。没有可领的任务会退出 `1` 并说明原因（没有 ready 任务 / 依赖没 merged / 路径被占）。

#### d. 开工、交付、合并

```bash
cowork task start t-1cb3e3        # claimed → in_progress，只有 lease 持有者能调
# …改代码、提交…
cowork task report-done t-1cb3e3  # in_progress → reported_done
```

由人（或合并者）在主工作树确认合并：

```bash
cowork task confirm-merge t-1cb3e3 \
  --commit 79195ba --manual --reason "人工确认，演示"
```

```
t-1cb3e3 → merged（79195ba）
  已释放占位 src/auth/login.ts
```

M1 没有自动验证：`confirm-merge` 必须显式带 `--manual --reason`，自动验证三层是 M2 的事。

#### e. 队列状态与异常处理

```bash
cowork task ls
cowork task ls --status ready
cowork task show t-1cb3e3
cowork task block t-1cb3e3 --reason "等设计确认"
cowork task cancel t-1cb3e3 --reason "需求取消"
```

```
t-1cb3e3  merged         (未领取)          补登录校验
```

### 3. 只读看板

看板是**单个 HTML 文件**，不监听端口，不读 `.git/cowork`，也不写任何状态：

```bash
cowork ui --out board.html --open     # 生成并打开
cowork ui --watch --open              # 前台每 2 秒重写，Ctrl+C 退出
cowork ui --watch --interval 5        # 自定义刷新间隔
```

看板分三块：

- **工作树**：每条车道的分支、HEAD、未提交文件数、最近交接；
- **占位**：路径、类型、车道、占用者、备注、过期时间；
- **任务与契约**：每个任务的状态、车道 / agent、依赖、`spec_commit`，以及读集与写集的契约提醒。

数据只来自 `cowork snapshot --json`，所以任何只读消费方（脚本、其它面板）都可以基于它自己画。进程被强杀时页面会停在最后一次采样，页头始终显示「数据截至 <时间>」。

### 4. 日常自检

**开工前看摘要：**

```bash
cowork brief
```

```
# 开工摘要（agent=dsh，lane=dsh）

本 lane 任务: t-1cb3e3 补登录校验（claimed）
  touches: src/auth/login.ts
  依赖: (无)

本 lane 占位:
  src/auth/login.ts  agent=dsh  到期 2026-10-30T15:45:32.908Z

跨 lane 冲突（与本单位置重叠的 claim）: (无)
契约提醒（本任务 reads 与其他活跃任务 touches 的交集）: (无)
最近交接单: …
```

**体检：**

```bash
cowork doctor          # 只检查，退出码 1 表示有问题
cowork doctor --fix    # 清理过期占位、回收孤儿 lease、隔离损坏文件
```

```
主仓库: /path/to/仓库
共享 git 目录: /path/to/仓库/.git
live 状态: /path/to/仓库/.git/cowork
未发现过期占位。
任务层未发现问题。
```

> 读不出来的 spec 或 live 文件**不会**被当成「没有这条任务」：`doctor` 报异常并退出 `1`，看板把它放进 `task_diagnostics`。

## 命令参考

| 命令 | 说明 |
|---|---|
| `cowork init` | 建 `.cowork/config.json`（`schemaVersion`、`trunk`），并把 `.cowork/lanes/` 写进 `.gitignore` |
| `cowork claim <路径>...` | 占位。精确文件，或目录 / `dir/**` / `dir/` 记为前缀；多条要么全占上，要么一条不写 |
| `cowork release [<路径>...]` | 只释放本工作树本 agent 的占位；省略路径 = 全部 |
| `cowork release --force <路径>` | 人拆别人的占位，会打印原占用者 |
| `cowork status [--json]` | 当前所有占位及过期时间 |
| `cowork snapshot [--json]` | 只读快照：仓库、车道、未提交改动、最近交接、占位、任务、诊断 |
| `cowork ui [--out <路径>] [--open]` | 生成静态单文件看板，不监听端口 |
| `cowork ui --watch [--interval <秒>]` | 前台循环重写（默认 2 秒），Ctrl+C 退出 |
| `cowork task add --title <标题> [--touches <路径>]... [--reads <路径>]... [--depends <id>]... [--done-when <命令>]...` | 建 draft spec（`.cowork/tasks/<id>.md`），进 ready 后不可改 |
| `cowork task ls [--status <状态>] [--json]` | 列任务；本地 draft 也可见 |
| `cowork task show <id> [--json]` | 单条任务与它的 live 状态、历史 |
| `cowork task ready <id>` | draft → ready；要求 spec 已在 trunk 可达 |
| `cowork next [--agent <名>] [--json]` | 领取最早可干的 ready 任务（事务：intent → lease → claims） |
| `cowork task start <id>` | claimed → in_progress，只能由 lease 持有者调用 |
| `cowork task report-done <id>` | in_progress → reported_done |
| `cowork task confirm-merge <id> --commit <sha> --manual --reason <文本>` | reported_done → merged，释放 lease 与占位 |
| `cowork task block <id> --reason <文本>` | 标阻塞并记原因 |
| `cowork task cancel <id> [--reason <文本>]` | 取消任务并释放占位 |
| `cowork brief [--agent <名>]` | 当前车道该干什么：任务、依赖、占位冲突、最近交接 |
| `cowork lane new <名> [--base <ref>]` | 建 `cowork/<名>` 车道（worktree） |
| `cowork doctor [--fix]` | 检查状态与任务；`--fix` 清理过期占位 / 回收 lease / 隔离损坏文件 |
| `cowork version` | 版本 |

不带参数运行 `cowork` 会打印完整用法。占位可选 `--note "<备注>"`，备注会带进看板。

## 退出码

| 码 | 含义 |
|---|---|
| `0` | 成功（含「这条本来就是我占的」这种幂等刷新） |
| `1` | 一般错误：参数不合法、没有可领的任务、依赖未满足、路径越界、状态文件损坏、I/O 失败 |
| `2` | 被占用或冲突：占位撞车、`next` 竞争失败、车道重名、锁等待超时 |
| `3` | 环境不满足：找不到 git、不在仓库内、路径落在仓库外 |

错误信息一律包含**谁占着**和**怎么解决**，不是裸堆栈。脚本里可以直接按退出码分支，不必解析文本。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `COWORK_AGENT_ID` | 工作树名 / 用户名 | 占位与 lease 的持有者标识。多个 agent 共用工作树时必须各自设置 |
| `COWORK_CLAIM_TTL_HOURS` | `24` | 占位存活时间 |

`.cowork/config.json`（`cowork init` 生成，建议提交）：

```json
{
  "schemaVersion": 1,
  "trunk": "main"
}
```

`trunk` 决定 `task ready` 检查 spec 时看哪条分支，也是 `spec_commit` 的基准。默认取当前分支；仓库用 `master` 等名字时手动编辑。

## 状态存在哪

| 内容 | 位置 | 进 Git |
|---|---|---|
| 占位、lease、intent、任务 live 状态 | `<git-common-dir>/cowork/`（通常 `.git/cowork/`） | 否，跨车道共享 |
| 任务 spec | `.cowork/tasks/<id>.md` | 是 |
| 交接单、评审等可提交知识 | `.cowork/notes/` | 是 |
| 车道（worktree） | `.cowork/lanes/<名字>` | 否（`cowork init` 自动写 ignore） |
| 看板 | `--out` 指定的路径 | 否 |

放在共享 git 目录而不是工作树，是硬约束：worktree checkout 不复制被 ignore 的文件，状态放工作树里就会每车道一份、彼此看不见。

## 常见问题

**Q：`cowork claim` 报退出码 2，但我看不到有人？**
用 `cowork status` 看完整占位表：可能对方是另一条车道，也可能是你自己在另一个工作树里占的。确实没人在用了，由人运行 `cowork release --force <路径>`。

**Q：占位会自己消失吗？**
会。过期后任何命令都会顺手回收，`cowork doctor --fix` 可立即清理。TTL 默认 24 小时；存活与 pid 无关——agent 进程退出不会清掉它的占位，因为每次 CLI 调用都是短命进程。

**Q：`cowork next` 说「没有可领取的任务」？**
看 `cowork task ls`：没有 `ready` 任务、依赖还没 `merged`、或 `touches` 正被别的车道占着，三种原因它分别说明。

**Q：看板打开是空的 / 不刷新？**
看板只消费 `cowork snapshot --json`。先手动跑一次 `cowork snapshot` 确认有数据；`--watch` 是前台进程，Ctrl+C 就停；页面靠 `<meta refresh>` 自刷新，不需要装任何东西。

**Q：支持 Linux / macOS 吗？**
设计以 Windows + NTFS 语义为先（目录 `mkdir` 锁、路径小写折叠、`cmd /C` hook）。代码是纯 Node、无原生依赖，但并发门槛只在 Windows 上验证过。

**Q：和 git 分支模型冲突吗？**
不冲突。车道就是普通 worktree + 普通分支（`cowork/<名>`）；`cowork` 只额外记录「谁在动哪些文件」。

## 已知限制

- 冲突检测只到**文件级**，不做 AST 或 hunk 级自动合并；
- 只能拉模式：cowork 不启动、不唤醒 agent，谁干活谁自己 `cowork claim` 或 `cowork next`；
- M1 没有自动验证：`confirm-merge` 必须显式 `--manual --reason`，自动验证三层是 M2；
- 只管一个仓库及其 worktree，不跨仓库；
- `taskkill /F`、断电这类信号够不到的死亡，看板会停在最后一次采样；
- 未开 `LongPathsEnabled` 的 Windows 机器上超长路径可能统计不到（会报 lane `error`，不会伪装成干净）。

## 开发

```bash
npm test                 # 104 个测试：node:test + 真实 git worktree
npx tsc --noEmit         # 类型检查
npm run build            # 编译到 dist/
node tools/mutex-gate.mjs                # 并发门槛：8 进程 × 1000 次，一次重叠都不能有
node tools/accept-m1.mjs --with-build    # M1 验收（10 条）
```

源码是 TypeScript（ESM，`node:` 前缀导入）；测试直接用 `node --experimental-strip-types` 跑，不经过编译。

自举：`cowork` 用自己管理自己的开发，`.cowork/notes/` 里是历次交接单。

## 文档

- [目标计划：需求、约束、验收标准](docs/PLAN.md)
- [架构：路径、claim、worktree、失败模式](docs/ARCHITECTURE.md)
- [任务层协议：任务对象、派工单、snapshot 契约](docs/ARCHITECTURE-TASKS.md)
- [已定决策（含被推翻的决策与复现路径）](docs/DECISIONS.md)
- [M1 工单与验收标准](docs/WORKORDER-M1.md)

## 许可证

MIT
