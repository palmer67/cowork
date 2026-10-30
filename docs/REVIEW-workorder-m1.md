# M1 工作令评审

评审车道：`codex/review-m1`，按要求从 `50ec6cd` 建立。`docs/WORKORDER-M1.md` 不在该提交中，而是在 `e343b28`（当前 `origin/main`/`dsh/m0`）的新增 blob 中；以下同时以该 blob 的工作令和车道中的 M0 源码为依据。工作令自身第 3 行仍写 `main = 50ec6cd`，与用户给出的 `main = e343b28` 不一致。

## 阻塞问题

### B1. 评审基线和工作令声明的 main 不一致

工作令实际来自 `e343b28`，但文件头声明 `main = 50ec6cd`。`50ec6cd` 不含工作令，且 `e343b28` 是其子提交。实现者若按文件头 checkout，会看不到验收依据；评审和交付也无法证明针对同一基线。

**应改：工作令。** 将基线写成 `main = e343b28`，或明确“实现基线为 50ec6cd，工作令文档提交为 e343b28”。在基线未钉死前不应开工。

### B2. 任务存储模型与任务层协议相反

工作令 §1 要求 `.cowork/tasks/<id>.json` 进入版本库，并在任务文件里保存 `status`、`assigned_lane`、`agent`、`updated_at` 和 `history`；§3 第 8 条又要求成功领取后把 agent/lane 写回任务文件。`ARCHITECTURE-TASKS.md` §1、§3 则已经明确：任务单是 `.cowork/tasks/<task-id>.md` 的 JSON front-matter + Markdown 正文，任务规格提交后是可审阅的知识；状态、租约、assigned lane、history、验证结果必须在 common-dir live store 中，由 CLI 合成有效对象，领取期间不得改写 spec。

这不是文件后缀偏好，而是会造成跨 lane 工作树各持一份运行态、任务文件提交冲突，以及 `next` 看到过期 assigned 状态。

**应改：工作令。** 改为协议规定的 `.md` front-matter + common-dir `tasks/<id>.json` live lease；删除把运行态写回任务文件的要求，并补上 `contracts` 字段。

### B3. 状态机和依赖完成语义不满足协议

工作令只定义 `draft → ready → assigned → done`，依赖要求写的是“全部 `done`”。协议 §2/§6 要求的状态至少包括 `claimed`、`in_progress`、`reported_done`、`verifying`、`verify_failed`、`awaiting_merge`、`merged`、`blocked`、`cancelled`；下游依赖只有进入 `merged` 才满足。工作令 §8 还提到 `task done`，但 §2 命令表没有该命令，也没有三层完成判定、验证失败保留 claim、人工确认合并的入口。

按工作令实现会让一个“自报 done”任务阻塞/放行下游，绕过自动验证和人确认合并，直接破坏 §6 与 §4 的依赖判定。

**应改：工作令。** M1 可以只实现状态机的前半段，但状态值、依赖检查和不可用转换必须使用协议名称；若暂不实现完成闭环，应明确 `done` 命令不属于本单，不能把 `done` 当作 `merged`。

### B4. “全占或全不占”缺少崩溃事务闭环

工作令 §3.3 只描述“读全部任务 → 判定 → 写 claims → 置 assigned + history”，并称此为全占或全不占。协议 §4.2/§4.3 已要求在同一 mutex 内先写带 operation id 的 `next intent`，写 task lease 和全部 touches claims，最后标记 committed；崩溃后所有命令先恢复 intent，未提交则幂等回滚，已提交则核对完整性，撤销失败必须 `corrupt`/fail closed。

当前 M0 的 `writeClaim` 是逐个文件写入；全局 mutex 只提供并发排他，不提供多文件断电原子性。因此进程可能在第一个 claim 成功、第二个 claim 或 assigned 写入前被 `taskkill /F`，留下部分占位或“任务未 assigned 但路径已占用”。Windows 的目录 `mkdir` 互斥不能消除这个窗口。

**应改：工作令。** 明确复用协议的 intent/recovery；不要用“持锁”替代崩溃事务。若 M1 不实现恢复，必须把“全占或全不占”从验收中移出并经协议修订批准，不能继续声称满足。

### B5. `next` 的竞争退出码在工作令内部不确定

工作令 §3.6 规定“没有候选”退出 1，§3.7 又规定并发抢输退出 2；两个进程都在锁内重新扫描时，第二个进程只能看到“没有候选”，无法从最终状态知道它是：

- 调用时就没有 ready 候选；还是
- 调用时有候选，但在等待 mutex 期间被另一进程领取。

若不记录调用前的候选观察或操作代次，两个结果无法稳定区分，验收项 4 的“输的一方 exit 2”不能仅靠外部行为可靠判定。

**应改：工作令。** 采用确定规则：基于同一固定 task catalog，在等待 mutex 前记录可执行候选集合；取得锁后若候选已被其他 owner 消耗则 exit 2 并打印赢家，调用前就没有候选则 exit 1 并说明依赖/占用原因。或统一规定“锁后无候选一律 1”，同时删除“竞争失败 2”的要求；不能两套语义并存。

## 重要问题

### I1. 领取顺序与协议冲突，且会饿死大任务

工作令 §3.2 选择 `(touches 数量升序, created_at 升序)`；协议 §4.1 要求稳定的 `created_at` 升序、再按 task id ordinal 升序。小任务持续到达时，touches 较多的任务可以无限延后。

**应改：工作令。** M1 采用协议规定的 FIFO（`created_at`, `id`），需要优先级时另加显式字段和协议，不把 touches 数量隐式当优先级。

### I2. `depends_on` 和 ready 的 trunk 语义缺失

协议要求 task spec 先提交到配置的 trunk；`next` 从固定 trunk commit 读取同一个 catalog，并记录 `spec_commit`。工作令只说依赖 id 存在且非 cancelled，允许 lane 私有/未提交任务参与 ready 语义，也没有规定 `task ready` 必须验证任务已进入 trunk。分支切换后同名/同 id 文件可能不存在或内容不同。

**应改：工作令。** `ready`/`next` 只接受配置 trunk 可达的任务 spec；依赖存在性在该 catalog 上验证；active lease 记录 `spec_commit`，spec 漂移由 doctor 报告，不静默改变 touches/done_when。

### I3. `lane new --task` 会无 claim 地制造 assigned

工作令 §5 允许 `lane new --task <id>` 直接把 `assigned_lane` 写成新车道，但没有取得 task lease、touches claim 或 assigned 状态。这会让任务看起来已分配，却仍可被 `next` 或手工 claim 竞争；也违反协议中 assigned lane 只能由 live lease 覆盖的定义。

**应改：工作令。** 删除 `--task`；让 agent 在已存在的 lane 中调用 `next` 完成任务 lease + touches claim 原子领取。若必须保留，必须把它定义为同一 `next` 事务的入口，且 Git worktree 创建不能在 mutex 内执行。

### I4. `lane new` 的 Git 操作边界没有写死

协议 §7 明确 mutex 内不能跑 Git。工作令既要求 `lane new` 执行 `git worktree add`，又允许同时修改任务 assigned_lane，却没有规定先后和锁边界。若实现者为避免 assignment race 把整个命令放进 mutex，就会在临界区运行 Git；若先跑 Git 再写任务状态，又需要处理建车道成功后任务更新失败的补偿。

**应改：工作令。** 明确 Git worktree 创建/检查在锁外；锁内只写短 live 记录，并定义 assignment 失败时如何保留或清理已建车道。推荐去掉 `--task`，避免这套跨 Git/live 的半事务。

### I5. §5 契约区被工作令无条件延期到 M2

工作令 §6 规定 M1 `contract_alerts` 永远 `[]`，只在架构文档标注“原型在 M2 接入”。但协议 §5 已要求 reads 与其他任务 touches、`contracts_changed` 形成可执行提醒，并在 `brief`/`next`/`snapshot` 显著展示；协议没有给 M1 一个空实现例外。

**应改：工作令（或先正式修订协议）。** 推荐 M1 至少实现协议已写死的 reads↔touches 和 handoff `contracts_changed` 提醒；如果产品确实把扫描推迟到 M2，必须在协议中增加版本化的 M1 例外、字段语义和验收，不可只改一句工作令。

### I6. id 自增只在当前工作树扫目录，跨分支会重号

工作令要求锁内扫描现存最大 `t-0001` 加一。全局 mutex 只能串行同时运行的进程，不能让 lane A 的未提交 `.cowork/tasks` 文件出现在 lane B 的工作树；两个 agent 可以各自看见最大值为 0，随后生成相同 id，合并时产生冲突或覆盖风险。

**应改：工作令。** M1 采用跨分支唯一的 `t-<hash/random>`（或把序列号放 common-dir live allocator，并在提交 spec 时核对）；不应把当前工作树目录扫描称为全局不重号。

### I7. `SnapshotTask` 改型本身基本兼容，但面板要求会改现有测试和文案

当前 `src/snapshot.ts` 的 `Snapshot.tasks` 是 `unknown[]`，`src/ui.ts` 只使用 `snap.tasks.length`，现有 fixture 也都是 `tasks: []`；只要 `SnapshotTask` 的字段都明确、空数组仍合法，把类型改成 `SnapshotTask[]` 不会破坏旧调用的结构类型。

但当前面板第三块仍渲染“任务层还没实现”，`test/ui.test.ts` 明确断言该文案；工作令要求第四区显示任务计数和状态分布，因此必须更新渲染和该断言。应同时定义 status union（至少覆盖协议状态）以及任务读取失败/损坏时的快照语义，不能只把 `unknown[]` 换成接口名。

**应改：工作令。** 补 `SnapshotTask` 的完整字段类型、状态集合、任务 catalog/live 合成和坏 task 的错误策略；实现时更新 UI 测试。现有 `Snapshot`/UI 类型形状不会因空数组本身破坏。

### I8. doctor 的 M1 行为没有对齐任务协议

工作令只在 touches 规则中提到 `doctor` 拒绝空声明，但当前 `src/cli.ts` 的 `doctor` 只检查 claims/live 状态；任务层协议要求 doctor 校验 task schema、依赖存在/成环、touches 非空/非根、spec commit 漂移和损坏 live task snapshot，并对损坏状态 fail closed。工作令没有定义这些诊断的退出码、是否隔离 task live 文件和是否保留现场。

**应改：工作令。** 写清 M1 doctor 的最小检查集，至少与 task add/ready/next 使用同一 schema/matcher，坏 live 状态按 1 且不当成空任务；不允许让 doctor 继续只报告 claims 却声称任务层可恢复。

### I9. 当前基线测试并非整体 exit 0

在 `50ec6cd` 车道运行 `npm test`，Node test runner 报 50 个子测试、48 个通过，两个文件级清理 hook 因临时仓库 `.git` 报 `ENOTEMPTY` 失败，进程退出 1。工作令要求 M1 总体 exit 0 且从 48 提到 ≥60；若不先解决基线清理问题，新增测试数量达标也不能满足整体绿门槛。

`npx tsc --noEmit` 在本车道因未安装本地 TypeScript 失败，输出为 “This is not the tsc command you are looking for”；这是环境缺依赖，不应被误报成源码类型错误，但交付前必须在安装依赖的环境重新验证。

**应改：工作令/交付门槛。** 先把 Windows 临时 worktree/.git 清理失败作为已知基线问题处理或明确隔离；验收应按实际 test runner 的总子测试数统计，不把“48 个声明”混同“48 个运行通过”。

## 次要问题

- 工作令 §1 的 task 示例缺少协议要求的 `contracts`，却增加了协议没有的 `agent` 与文件内 `history`；应在 schema 定义中区分 spec 字段和 live 字段。
- `task add --status ready` 绕过“先提交 trunk、再执行 `task ready`”的审阅门槛；建议只允许创建 draft，或要求该参数证明 spec 已在 trunk 可达并仍走 ready 校验。
- 工作令写“依赖必须指向非 cancelled 任务”，但没有说明 `blocked`/`ready`/`awaiting_merge` 依赖都只能等待到 `merged`；应直接引用协议的完成定义。
- “错误信息必须含谁占着”不适用于没有 owner 的参数错误、依赖环和空候选；应改成“有占用者时说明 owner，无 owner 时说明阻塞原因和解决命令”。
- 验收 3 写 `touches: ["src/auth/**"]`，但命令面是 `--touches <路径>` 重复参数；验收应给可执行的完整命令，明确不得依赖 PowerShell/cmd 先展开 glob。
- 验收 4“两个车道各跑 5 次 next”没有区分一次并发竞争与后续无候选调用；应增加 barrier、期望成功/2/1 的精确序列和最终 live 记录断言。
- 当前 M0 的 `Snapshot` 已包含 `(main)` 车道和 `contract_alerts` 空数组；新面板应保持只读数据源，不把任务读取或契约提醒变成 UI 第二写者。工作令应明确 `ui` 只消费 snapshot，不直接读 task 文件。
- 工作令 §11 要求提交按 A/B/C/D/E 分组，但又要求“一次提交只做一件事”；这是提交组织规则，不是可测试协议，应明确是多个提交还是单提交内的逻辑分组。

## 开放问题回答

### 1. `next` 排序：touches 少优先还是 FIFO？

选择 **`created_at` 升序，再按 task id 稳定排序的 FIFO**。它与 `ARCHITECTURE-TASKS.md` §4.1 一致，避免持续新增小任务饿死大任务；touches 只用于冲突判定和显示，不隐式承担优先级。应改工作令 §3.2；不改协议。

### 2. 竞争失败退出 2 还是 1？

选择 **真正观察到“候选在等待期间被另一 lane 领取”时为 2；调用时没有可执行候选时为 1**。2 表示资源被竞争者赢走，1 表示参数/依赖/当前占用导致没有可做任务。实现必须记录固定 catalog 下的候选观察或等价 operation 代次，否则无法判定。应改工作令 §3.6/§3.7 的歧义；不改既有退出码协议。

### 3. 一任务一文件还是单一 `tasks.json`？

选择 **一任务一份 Markdown（JSON front-matter + 正文）**，运行态另存 common-dir 每任务 live JSON。它符合 §3.3 的 handoff 载体、便于 cherry-pick/合并和人工审阅；单一 JSON 会让不同 lane 添加任务时制造大范围写冲突，且仍不能替代 live lease。应改工作令从 `.json` 改为协议格式；不改协议。

### 4. 自增 id 何时换 hash？

选择 **M1 就使用跨分支唯一的 opaque id（例如 `t-<hash6>` 或时间+随机后缀）**，不等任务数上千才处理。锁内扫描当前目录只能防同一工作树同时进程重号，不能防两个未合并分支各自生成 `t-0001`。若产品必须保留可读序号，应把 allocator 放 common-dir live store，并把 spec 创建/提交失败回收写入协议；这比 M1 所需范围复杂。应改工作令；协议只需保留“稳定、路径安全、创建后不改”的要求。

### 5. `depends_on` 在分支切换后是否要求先合入 trunk？

选择 **是：依赖任务 spec 必须存在于配置 trunk 的固定 catalog，ready/next 不读取 lane 私有未提交任务；依赖完成仍以 live 状态 `merged` 为准**。这样所有 lane 对 id、touches、done_when 看到同一个版本，spec 漂移可被 `spec_commit` 检测。应改工作令；这是协议 §3.3/§4.1 的既定形状。

## 结论

结论：**需修订后开工**。最少必须修改：

1. 钉死基线为 `e343b28`，并修正工作令自身 baseline 文字；
2. 采用协议的 `.md` front-matter + common-dir live task lease，删除回写任务文件的 assigned/status/history；
3. 对齐完整状态机和 `merged` 依赖语义；
4. 为 `next` 增加 intent/recovery，明确 Git 不进 mutex，并使判定、claims、assigned 的事务在崩溃后仍全占或全不占；
5. 统一 `next` 的 1/2 退出码判定和 FIFO 排序；
6. 处理 §5 契约提醒是 M1 必做还是先正式修订协议，不能用空 `contract_alerts` 无条件延期；
7. 解决当前基线 `npm test` 非零退出，并补足 `SnapshotTask`/UI/doctor 的验收定义。

本次没有修改 `src/`、`docs/WORKORDER-M1.md` 或 `dsh/m0`；只做了评审验证和本报告/交接单。
