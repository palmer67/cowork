# cowork 架构计划书

> 状态：供 M0 实现使用的架构基线。约束来自 `docs/PLAN.md` 与 `docs/DECISIONS.md`；本文落实 PLAN 第 10 节八项决策，不重开 D1–D6，也不重问 PLAN 第 12 节问题。

## 1. 目标与边界

`cowork` 是运行在单机上的协作协调 CLI：以 git worktree 隔离工作区，以共享 claim/guard 提前暴露路径冲突，以 handoff/brief 传递上下文。人决定任务由哪个 agent 执行，工具不创建队列、不分派 agent、不 fan-out 并行任务，也不提供看板、守护进程、容器或 AST 合并。

本设计的交付目标是满足 PLAN 的 P0/P1 验收路径，并为可选 P2 留出命令/API 边界，不预先实现 patch 队列或 watch。完成点是：Windows/NTFS 上的 claim 协议与崩溃恢复闭环明确、嵌套 worktree 不污染仓库操作、八项决策和验证策略可直接指导实现。实现前的实测结果以测试产物为准；本文不把设计判断冒充测试结论。

## 2. 总体结构

```text
Codex / DSH / 人
        │ CLI（PowerShell、cmd；可选 MCP 复用同一服务层）
        ▼
命令层：init / lane / claim / release / brief / handoff / guard / doctor / status / merge
        │
        ├── Git adapter ── git.exe（worktree、diff、merge-base、hook）
        ├── Live store ──── <git-common-dir>/cowork/（claims、互斥目录、临时文件）
        └── Knowledge store <repo>/.cowork/notes/（可提交 handoff）
```

CLI 是唯一运行时进程，不监听后台端口。命令层负责参数解析、退出码和人类/JSON 输出；领域服务实现 lane、claim、brief、handoff、guard、doctor；文件存储和 Git adapter 封装平台差异。MCP（若实现）只调用同一领域服务，不另造状态或策略。

### 建议仓库布局

```text
src/
  cli/                 # 命令入口、参数、格式化和退出码
  core/                # lane、claim、handoff、guard、doctor 的规则
  store/               # live store、notes schema、原子文件写入
  git/                 # git.exe 调用、common-dir、worktree、diff/hook
  platform/windows/    # Windows 进程身份、路径及文件系统辅助
tests/
  unit/
  integration/
  windows/             # NTFS 并发、进程崩溃、cmd/PowerShell 验证
docs/
```

该布局是模块边界建议，不要求一次性搭建空目录；按 M0–M3 逐步建立。避免运行时依赖，核心只用 Node 22 内建模块（`node:fs/promises`、`node:path`、`node:child_process`、`node:crypto`、`node:os`）。Git 是外部可执行程序；用 `execFile` 传参数数组，不经 shell 拼接。测试使用 Node 内建 `node:test`，不引入原生扩展。MCP SDK 只在 P2 决定采用时评估为可选依赖。

## 3. PLAN 第 10 节：八项决策

### 3.1 Claim 原子性与 Windows 兜底

采用 NTFS 目录创建作为抢占原语：所有会改变 claim 集合的操作，先以 `mkdir(<common>/cowork/mutex)` 原子竞争同一个固定互斥目录。成功创建者持有临界区；目录已存在即失败并退避重试。仅当创建者确认 mutex 内的 owner 租约过期且满足回收规则，才可以回收后重试。不得用 `flock`，也不使用“先检查文件不存在再写”的非原子流程。

临界区内读取并校验全部有效 claim，检查 glob/path 冲突，再以唯一 claim ID 创建 claim 目录并写入完整元数据；只有元数据写入成功后 claim 才可见为有效。释放、续租和 stale 回收也必须取得同一互斥目录。读状态的命令可读一致性快照：读取前后比较 generation，若发生变化则重读；简化实现可直接短暂持有 mutex。

目录创建是同卷 NTFS 的排他名字创建点，适合作为互斥仲裁；这不是本仓库已实测的结论。M0 必须在目标 Windows/NTFS 环境以多进程压力测试验证，不把 POSIX `rename` 语义作为证明。claim 元数据不依赖覆盖式 rename：在 mutex 下写唯一临时文件、flush/close 后创建最终文件名；遇到 `EEXIST`、`EPERM`、`EBUSY`、`EACCES` 等共享冲突按有界指数退避重试，并重新检查目标状态。超出重试窗口时报一般错误，保留现场并提示运行 `cowork doctor`；不能删除未知 owner 的目录。

mutex 包含 `owner.json`（PID、进程启动时间、操作、创建时间、随机 nonce）。拿到目录后立即写 owner；短临界区必须有操作超时，且释放前完成所有元数据更新。mutex 的回收依据是 owner 进程身份已确认不存在或 PID 已复用，而不是“锁年龄超过 TTL”；进程查询失败时 fail closed。崩溃发生在 owner 写完之前时，缺失 owner 只能在短暂初始化宽限期后由 doctor/竞争者回收。回收前再次检查 owner，并将旧 mutex 隔离到 `trash/`，不能直接递归删除。锁竞争错误按占用处理（退出码 2）；IO、权限或持续杀毒软件占用按一般错误处理（退出码 1），环境前置条件缺失为 3。消息指出当前 owner/状态以及可执行的恢复命令。

### 3.2 Stale 判定状态机

claim 是租约，不是永久文件锁。`claim` 写入 `createdAt`、`leaseUntil`、`heartbeatAt`、`laneId`、`claimId`、PID 和进程启动时间；`heartbeat` 在取得全局 mutex 后更新租约。agent 的正常长任务必须按 TTL 的约三分之一续租，或使用前台 `claim --watch` 保持租约；watch 是用户主动运行的前台 CLI 子命令，不是后台守护进程。没有续租的 claim 到期后不再保证排他保护，工具会明确提示这一点。

状态机：

| 状态 | 条件 | claim/doctor 行为 |
| --- | --- | --- |
| `active` | 当前时间早于 `leaseUntil`，元数据有效 | 参与冲突检查；不得回收 |
| `suspect` | 已到期但仍在宽限期，或 PID 存活且启动时间匹配 | 报过期候选；不回收，允许 owner 续租 |
| `stale` | 到期超过宽限期，且进程身份不存在/不匹配，或 owner 明确释放 | doctor 可标记可回收；保留快照/诊断记录 |
| `reclaiming` | 回收者持有 mutex 并再次核验条件 | 原子地将 claim 目录改名到 live `trash/` 唯一隔离名，再从有效集合移除；不直接递归删除 |
| `recovered` | 隔离成功，重新计算冲突集合 | doctor 报告回收；等待新 claim 重试 |
| `corrupt` | 元数据缺失、格式错、PID 信息不完整或读写失败 | fail closed：视为占用，不自动回收；doctor 输出原因与人工检查命令 |

PID 不能单独证明 owner 存活，需与进程启动时间匹配以规避 PID 重用。进程查询在 Windows 使用 Node `execFile` 调用 PowerShell（优先 `pwsh`，兼容 `powershell.exe`）读取进程启动时间，设置超时且不经 shell；查询失败按“无法确认”处理，留在 `suspect/corrupt`，不能据 TTL 强行删除。由于 CLI 命令本身通常很快退出，PID 是辅助防误回收信号，不代替续租；续租与 lease 是主协议。

崩溃闭环为：进程退出/掉电 → lease 到期 → doctor 或下一次 claim 在 mutex 内复核 → 有效目录先隔离并记录 → 重算冲突并重试 claim。用户不需要手动删除 lock 文件。过期宽限期默认至少一个 heartbeat 周期；具体默认值进入 config 并由测试固定。`doctor --fix` 只处理符合 `stale` 条件的状态，默认 `doctor` 只诊断。

### 3.3 Live 状态位置与可见性

按 D3 使用 `git rev-parse --path-format=absolute --git-common-dir` 解析 common dir（若 Git 版本不支持该选项，则用 `--git-common-dir` 并相对调用目录规范化），live 根目录固定为 `<common-dir>/cowork/`。所有 lane 调用从自己的 worktree 解析到同一个 common dir，因此只有一份 claims、互斥状态和恢复隔离区。`.cowork/live/` 不作为状态源，避免独立 checkout 各自一份且 gitignore 内容不会随 worktree 复制的错误。

人类可见性由 `cowork status`、`brief`、`doctor` 与 `--json` 提供；不生成易失状态的工作树镜像，避免产生过期副本或误提交。可选地 `doctor` 显示绝对 live 根路径及最近状态更新时间。用户可直接运行只读 `cowork state-path` 查看位置；不提供由多写者维护的镜像文件。

### 3.4 内嵌 worktree 的 Git 陷阱

lane checkout 放在 `.cowork/lanes/<slug>/`，其父目录必须被根 `.gitignore` 明确忽略，并在 `init` 与 `doctor` 检查。`.gitignore` 只让 Git 忽略路径，不保护它免受 `git clean -fdx` 删除；因此：

- `git add -A` 默认不加入被忽略的 lane 目录；禁止 `git add -f .cowork/lanes`，guard/doctor 检查已跟踪文件没有覆盖此目录的异常规则。
- 从主工作树运行 `git clean`/`git clean -fdx` 有删除忽略 lane 的风险。`cowork` 不执行该命令；文档、doctor 和 `cowork clean`（若未来添加）必须拒绝对活动 lane 的清理。普通 Git 无法阻止用户自行运行破坏性命令，故 `doctor` 会通过 `git worktree list --porcelain` 检查缺失路径并报告 orphan metadata；可运行 `git worktree prune` 前先诊断，不自动 prune。
- 父工作树的 Git status 应忽略 lanes；lane 内部自己的 status 以 lane checkout 为根，不把兄弟 lane 纳入索引。禁止把 lane 目录纳入父仓库 index。IDE 索引与文件监听可能递归进入 lanes，根 `.gitignore` 与常见 IDE 忽略规则均排除 `.cowork/lanes/`；不能假设所有 IDE 遵守 gitignore，初始化只提供建议，不改用户 IDE 配置。
- `git worktree add` 在既有工作树目录中嵌套 checkout 是 Git 支持但容易混淆的布局：目标目录必须不存在/为空，路径不能是另一个已注册 worktree，分支不能已被其他 worktree 检出。lane 建立前校验 slug、路径长度、空目录、分支占用；失败时保留 Git 输出和现场，不自作清理。用 `git worktree list --porcelain` 做登记依据，而非扫描目录猜测。
- hooks 放在 Git 实际解析的 hooks 目录（以 `git rev-parse --git-path hooks` 取值），复用 common git dir 共享 hooks 的行为。安装前读取有效 `core.hooksPath`；如用户已自定义，安装器在该解析目录落 managed dispatcher 并链式调用既有 hook，或报告冲突让用户显式配置，不覆盖既有 hook。不要写相对 `core.hooksPath`，不要改成相对 `.cowork/...` 路径；移动仓库后的绝对路径由 `doctor` 检测并重新安装提示。hook 入口用 `.cmd`/Node CLI 兼容 `cmd /C`，不依赖 `sh`。

### 3.5 Handoff schema 与可读性

采用 Markdown 正文加 JSON front matter（YAML front matter 对简单字段虽易读，但解析/转义规则和运行时依赖容易不一致）。顶层 JSON 块只保存稳定、机器可筛选字段；正文用短段落供 Codex/DSH 阅读：

```markdown
---
{"schemaVersion":1,"id":"2026-10-30T15-00-00Z-codex-fix-login","createdAt":"2026-10-30T15:00:00Z","lane":"codex/fix-login","task":"修复登录刷新","status":"ready","files":["src/auth/login.ts"],"contracts":["request() 返回值保持 Promise<Response>"],"next":"在 DSH lane 补集成测试","base":"main@<commit>"}
---
## Summary
...
## Decisions
...
## Risks
...
## Validation
...
```

字段要求：`schemaVersion/id/createdAt/lane/task/status/files/contracts/next/base`；`summary`、`decisions`、`risks`、`validation` 在正文。CLI 参数提供短路径，并允许 stdin/编辑器补正文；agent 不需要编写复杂 YAML。读取时验证 schemaVersion 与必需字段，未知字段忽略，写入 UTF-8。`brief` 首先给活跃 claim 与 lane，再按 `createdAt` 倒序给最近 N 条 handoff；只展示 `ready` 和最近历史，`superseded` 或超过配置保留期的记录可折叠/排除，但原文件不自动删除。默认 N=5，支持 `--limit`；文件名含 UTC 时间和 slug，避免同秒覆盖。brief 提供来源路径和时间，便于识别陈旧契约。过期不靠自动删知识，而由新 handoff 可显式标记旧记录 `superseded`。

### 3.6 软约束、硬约束与 preflight

分层执行：

1. `AGENTS.md` 受管区块与 `.cowork/AGENTS.cowork.md` 告诉 agent 开工前执行 `cowork preflight`、先看 brief、claim 后编辑、完成后 handoff/release。这是软约束。
2. `cowork preflight` 汇总 lane 身份、brief、当前 worktree 与冲突 claim；占用冲突退出 2。命令廉价、只读，不要求常驻进程。agent 忽略指引时它不能强迫其调用。
3. `pre-commit` hook 校验暂存路径与其他 lane 的 claim；这是提交前硬边界，`--force` 只由用户明确绕过。hook 不能保护尚未提交的编辑，也不能阻止用户直接删改文件。
4. `claim` 是最早的原子冲突门，建议 MCP 只在 P2 提供同一命令能力，减少 agent 记语法成本，不把“自觉”当唯一保护。

agent 不调用 preflight 的兜底是 pre-commit guard、全局 `brief/status` 与 doctor 检查；不能声称 hook 可防止编辑覆盖。冲突信息包含 owner lane、分支、文件/模式、handoff 摘要和解决命令。退出码固定遵循 AGENTS.md。preflight 不自动 claim，防止一次误调用占用路径。

### 3.7 同文件并发策略

P0 采用首个有效 claim 获胜；claim 期间同一文件/路径冲突即退出 2。用户故事是不同 agent 预先分工，自动 patch 排队会引入顺序、公平性、应用/rebase 失败和丢失上下文等一整套机制，超出协调层边界。因此不实现 F13 patch 队列，也不把并行写同一文件排队作为当前承诺。冲突双方通过人协调、release/改 scope 或 handoff 后再继续。

`merge --dry-run` 用 Git diff 与 merge-base 报告同文件修改及 hunk 重叠；不作语义合并。未来若需求证明队列必要，应单独设计协议；不得以 Windows 文件锁临时串行化编辑。若将来只需串行应用 patch，优先采用短时目录 mutex + 单个前台 CLI 操作，不引入单写者常驻进程或 daemon。

### 3.8 失败模式全表

| 故障 | 检测 | 工具行为 | 恢复/现场 |
| --- | --- | --- | --- |
| 断电/系统崩溃 | mutex/claim lease 到期、临时或隔离目录 | fail closed；doctor 标记 stale/corrupt；仅按状态机回收 | 先隔离、保留诊断元数据，再允许重试；无需手删 lock |
| agent/CLI 崩溃 | 进程退出时间与 lease/heartbeat | 临界区 mutex 可过期回收；claim 等 lease 过期并过宽限期 | doctor 或下一次 claim 取得 mutex 后核验并隔离 stale claim |
| 用户手改 live 状态 | schema、nonce、generation 校验失败 | claim/guard 拒绝继续（退出 1）；不猜测修复 | `doctor` 输出损坏字段、备份/隔离建议；有效目录不自动覆盖 |
| lane 被用户删除 | worktree porcelain 仍登记但路径缺失 | status 标为 missing；claim 仍按原 owner 保护直至释放/过期 | doctor 提供 `git worktree remove/prune` 建议；不自动删除元数据或恢复文件 |
| base 分支被 force push | 保存的 base OID 与当前 ref 不同，merge-base/ancestor 检查 | merge dry-run 拒绝自动合并并显示两边 OID/差异 | 用户选择新基线并显式 rebase/重建；不改 lane、不丢现场 |
| 两个用户同时 merge | 目标 ref 前置 OID 校验、Git ref 更新失败 | 只允许 Git 成功更新 ref 的一方；另一方报告目标已变化并重新 dry-run | 不自动重试覆盖；工作树与分支保留，用户重新确认顺序 |
| 杀毒软件/索引器短暂占用 | 文件系统操作返回共享冲突/权限错误 | 有界退避；不把锁竞争误判成 stale | 超时后报告路径、错误码、owner 和 doctor 命令；不强删 |
| hook 缺失/被绕过 | doctor 检查安装状态；提交可用 `--no-verify` 绕过 | status/doctor 报告保护降级；`--force`/绕过必须显式 | 重新安装 hook；日志记录 guard 结果，但不阻断人工恢复 |
| common dir 不可写/解析失败 | init/doctor 前置检查 | 环境错误退出 3，不降级到每 lane live 状态 | 修复仓库权限或 Git 环境后重试 |

## 4. 数据格式与目录

```text
<repo>/
  AGENTS.md                       # 只追加/更新受管区块
  .gitignore                      # 忽略 .cowork/lanes/
  .cowork/
    config.json                   # 跟踪：默认 TTL、宽限期、主分支、brief 保留策略
    AGENTS.cowork.md              # 跟踪：agent 协作规则
    notes/                        # 跟踪：handoff Markdown + JSON front matter
    lanes/<slug>/                 # 忽略：内嵌的 git worktree
<git-common-dir>/cowork/
  mutex/owner.json                # 易失：全局短临界区
  claims/<claim-id>/meta.json     # 易失：租约及路径 glob
  trash/<id>/                     # 易失隔离：待人工/doctor 清理的恢复材料
  generation                      # 易失：一致性快照版本
```

live store 初始化使用 mkdir，文件权限按当前 OS 用户默认 ACL；同一 OS 用户是信任边界。存储写入采用版本化 JSON 与 schema 校验。只删除已隔离且超过保留期的 trash 项，并要求显式 `doctor --fix --purge`；默认永远不清现场。

## 5. 命令与退出码

命令面遵循 PLAN 第 7 节，并增加 `preflight`、`heartbeat`、只读 `state-path`。所有命令提供 `--json`（如适用），人类输出走 stdout、诊断错误走 stderr。错误至少包含：发生什么、占用者/状态（若存在）、下一条可执行的解决命令。`cowork doctor` 可在空仓库运行，输出逐项诊断而非堆栈。

退出码：`0` 成功；`1` 一般错误/IO/损坏状态；`2` claim 冲突、资源被占用或合并冲突；`3` Git/Node/仓库条件不满足。hook 保持同一语义。

## 6. 测试与验收策略

### Windows 并发自动化

- 使用 `node:test` 启动多个独立 `node.exe` 子进程同时 claim 相同与不相交路径。相同路径测试要求恰好一个成功、其余退出 2，且每次运行的共享状态 schema 完整；不同路径可在同一短互斥区内顺序成功。
- 用 barrier 文件/父进程管道同步竞争开始，循环高次数并记录错误码、claim 数、generation 和残留 mutex；不以线程测试替代多进程测试。
- 专门测杀毒软件类暂时占用：由测试进程持有目标文件句柄/模拟 `EPERM`，检查有界重试、现场保留和诊断；此模拟不能替代真实 Defender/NTFS 压测。
- 子进程在 mutex 写 owner 前后、claim 元数据写一半、lease 更新前后被 `taskkill /T /F` 终止；重启 doctor 后确认 `active/suspect/stale/corrupt` 分类与回收行为，并确认重复执行幂等。
- 在 NTFS 临时仓库实际执行并发测试；CI 若可用 Windows runner，每次 PR 跑集成组。目录互斥、杀毒/索引器与 Node/Git 版本组合的结论以 Windows 测试记录为准。

### 功能矩阵

- P0：两 lane claim 冲突、不同路径、跨 worktree live 一致性、handoff/brief 交接、断电/崩溃 stale 恢复、hook 真正拦截一次 commit。
- P1：status、merge dry-run 的文件/hunk 冲突提示、doctor 对残留/过期/missing worktree 的诊断。
- 平台：PowerShell 7 与 cmd 各跑 CLI 冒烟；含中文、空格和超过 260 字符路径的成功或明确优雅报错；路径参数一律不用 shell 拼接。
- Git 陷阱：父仓库 `status` 和 `add -A` 不捕获 lane；doctor 可发现被 `git clean` 删除的登记 worktree；相对/自定义 hooksPath 场景不覆盖用户 hook。
- 发布：全新空仓库 `init`、Node/npm 基线、npm 全局安装后 `doctor` 可读；确认不需要 MSVC 原生模块。D2 自举在 M0 后执行，不作为架构文档阶段的假测试。

## 7. 里程碑映射

| 阶段 | 架构落地重点 | 完成信号 |
| --- | --- | --- |
| M0 | Git adapter、common-dir live store、目录 mutex、claim/release/heartbeat、lane new/ls | Windows 多进程互斥及跨 worktree 可见性通过 |
| M1 | handoff schema、brief 排序、AGENTS 注入、preflight | US-3/US-4 可演示，notes 与 live 不混放 |
| M2 | hook dispatcher、guard、doctor stale 恢复 | 真 commit 拦截；崩溃后不需手删恢复 |
| M3 | status、merge dry-run、路径和终端加固 | PLAN 验收矩阵全绿 |
| M4（可选） | MCP 调用适配器；再评估其他增强 | 仍由人选择和执行任务，无调度/队列 |

实现过程中若 Windows 测试否定目录创建互斥或目标 Git 版本的嵌套 worktree 行为，应修正对应 adapter/策略并更新本架构书及 DECISIONS 的新增条目；不得带着未验证假设宣称验收通过。
