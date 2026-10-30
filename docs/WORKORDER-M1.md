# M1 工作令：任务台（task / next / brief / lane new）

> 交给实现方（小东）执行；本文件是验收依据。基线 `main = 50ec6cd`。

## 0. 交付边界

- 只做 M1；不改变 M0 已有行为与输出（除新增字段）。
- 不新增运行时依赖；`npm test` 必须整体 exit 0，`npx tsc --noEmit` 干净。
- 一个提交只做一件事，Conventional Commits。
- 自举：动手前先 `cowork claim` 自己要改的文件，收工写 `.cowork/notes/` 交接单。

## 1. 任务对象

落盘 `.cowork/tasks/<id>.json`（**进版本库**，与 `.cowork/notes/` 同级）：

```json
{
  "schemaVersion": 1,
  "id": "t-0001",
  "title": "给登录页加图形验证码",
  "status": "draft",
  "touches": ["src/auth/**"],
  "reads": ["src/shared/types.ts"],
  "depends_on": ["t-0000"],
  "done_when": ["npm test"],
  "assigned_lane": null,
  "agent": null,
  "created_at": "2026-10-30T16:00:00.000Z",
  "updated_at": "2026-10-30T16:00:00.000Z",
  "history": [{ "at": "…", "event": "ready", "by": "dsh" }]
}
```

规则：

1. `touches` = 写集，参与占位与排他；`reads` = 弱只读声明，不占位，只进契约提醒。
2. `touches` 必须非空，且不能是仓库根（含规范化等价的 `""`、`.`、`./`、`**`）→ 违规 exit 1。
3. 路径规范化**复用** `src/paths.ts`，不新写一套。
4. `id`：`t-` + 4 位零填自增，锁内读现存最大值 +1；并发 add 不得重号。
5. 状态机：`draft → ready → assigned → done`；`assigned → blocked`；任意状态 `→ cancelled`。
   其他转换一律 exit 1 并说明当前状态。
6. `depends_on` 必须指向存在的、非 `cancelled` 的任务；**环检测**失败 exit 1，打印环路径。

## 2. 命令面

| 命令 | 说明 |
|---|---|
| `cowork task add --title <文本> [--touches <路径>]... [--reads <路径>]... [--depends <id>]... [--done-when <命令>]... [--status draft\|ready]` | 新建任务，默认 `draft`；打印 id |
| `cowork task ls [--status <状态>] [--json]` | 列表 |
| `cowork task show <id> [--json]` | 单条详情 |
| `cowork task ready <id>` | `draft → ready`，同锁内写 history |
| `cowork task cancel <id> [--reason <文本>]` | 任意状态 → cancelled |
| `cowork next [--agent <名>] [--json]` | **领取**：选一个 ready 任务并批量占位 |
| `cowork brief [--agent <名>]` | 给 agent 读的开工摘要（只读） |
| `cowork lane new <名> [--base <ref>] [--task <id>]` | 建车道 worktree |

`--agent` 缺省取 `COWORK_AGENT_ID`，再缺省 `default`。

## 3. `next` 的语义（最关键，必须逐条实现）

1. 候选 = `status=ready` **且** `depends_on` 全部 `done` **且** 其 `touches` 未被任何有效 claim
   占用、也未被其他 `assigned` 任务占用。
2. 排序：按 `(touches 数量升序, created_at 升序)` 取第一个。
3. 整个操作在 §3.1 mutex 内完成：读全部任务 → 判定 → 写 claims → 置 `assigned` + history。
4. **全占或全不占**：一个任务的多个 `touches` 要么一次全占上，要么该任务不可领，
   绝不允许部分占位。
5. 成功：exit 0，输出任务 id、touches、依赖、`done_when`、所在车道。
6. 没有候选：exit 1，**必须说明卡在哪**——被谁占（路径 + 车道 + agent）、等哪个依赖未 done；
   不允许只输出"没有任务"。
7. 并发：N 个进程同时 `next`，同一任务只能被领走一次；抢输的一方 exit 2 并打印赢家车道。
8. 领取成功后该任务所属 agent 与 lane 写入任务文件。

## 4. `brief`

只读，但持锁读以保持前后一致。输出给 agent 看的纯文本：

- 当前任务：id、标题、touches、reads、done_when；
- 依赖状态：哪些已 done、哪些未 done；
- 同车道已有占位、其他车道与本单位置冲突的占位；
- 最近 3 条 `.cowork/notes/` 交接单（id/时间/标题）；
- 一条硬规则提示：只在 touches 内改文件，越界需先 claim 扩范围。

## 5. `lane new`

- 名字校验 `[a-z0-9-]{1,32}`，不得为 `..`、`.`、不得含 `/`、不得与现有车道重名 → 违规 exit 1。
- `git worktree add .cowork/lanes/<名> -b cowork/<名> [<base>]`，base 缺省取 config 的 `trunk`。
- 已存在（目录或分支）→ exit 2，打印现有车道。
- 成功输出：新路径、`cd` 命令、建议设置 `COWORK_AGENT_ID=<名>`。
- `--task <id>`：顺手把该任务的 `assigned_lane` 置为该车道（任务必须已 ready）。

## 6. snapshot 接线

- `tasks`：从 `unknown[]` 改为 `SnapshotTask[]`——`id / title / status / touches / depends_on /
  assigned_lane / updated_at`。
- `contract_alerts`：M1 仍返回 `[]`，但在 `docs/ARCHITECTURE-TASKS.md` §5 标注"原型在 M2 接入"，
  面板该区显示"契约：M2 接入"，不要伪装成"没有契约告警"。
- 面板第四区（合并就绪度）本阶段只显示任务计数与状态分布，不新增交互。

## 7. 错误与退出码

| 情形 | 码 |
|---|---|
| 参数错、touches 空/是根、依赖不存在、依赖成环、状态转换非法 | 1 |
| `next` 无候选（说明原因） | 1 |
| `next` 竞争失败（任务被别的车道领走） | 2 |
| `lane new` 重名或路径已存在 | 2 |
| 不在 git 仓库、路径越界、找不到 git | 3 |

错误信息必须含**谁占着**与**怎么解决**。

## 8. 测试要求

- 单测：状态机非法转换、id 并发不重号、依赖环检测、touches 规范化、`next` 判定抽成纯函数后单测。
- 并发：5 个进程同时 `next`，断言同一任务只被领一次（真 git worktree + mkdtemp）。
- e2e：`task add → ready → next → brief → done`（done 由人手动 `task done` 或按 done_when 验证，
  本阶段只做手动）。
- 总数从 48 提到 **≥ 60**，整体 exit 0。

## 9. 验收（我会亲手跑）

1. `cowork task add --title x` → exit 1。
2. `cowork task add --title x --touches .` → exit 1。
3. A 车道 `claim src/auth/login.ts` 后，`touches: ["src/auth/**"]` 的任务 `next` → exit 1 且打印 A 车道占用。
4. 两车道各跑 5 次 `next` → 同一任务只有一个 owner，输的一方 exit 2。
5. `task ready` 后 `snapshot --json` 的 `tasks[].status` 为 `ready`，面板第四区计数正确。
6. `lane new bad/../name` → exit 1；重名 → exit 2。
7. `npm test` ≥60 绿、`tsc` 干净、`cowork claim` 自举记录齐全。

## 10. 非目标（本阶段明确不做）

- 不做任务自动拆解、不做 LLM 调度、不做 fan-out。
- 不做 `contract_alerts` 扫描（M2）。
- 不做 `merge --dry-run`（M2）。
- 不改面板布局，不加交互，不引入 fetch/websocket。
- 不改 M0 的 claim/mutex/store 语义（发现缺陷另开 issue，不在本单修）。

## 11. 交付物

- 代码 + 测试（≥60）+ `docs/DECISIONS.md` 新条目（任务 id 分配、next 排序、领取失败退出码）。
- `.cowork/notes/` 交接单一份：做了什么、没做什么、下一单该从哪接。
- 提交按 A(模型)/B(命令)/C(next)/D(brief+lane)/E(snapshot+文档) 分组。

## 12. 留给评审的开放问题

1. `next` 排序用"touches 少优先"会不会饿死大任务？替代方案：严格 `created_at` FIFO。
2. 竞争失败用 exit 2 还是 exit 1？2 表达"被别人抢了"，1 表达"现在没得做"。
3. 任务文件一任务一文件 vs 单一 `tasks.json`：前者 merge 友好、后者无冲突但易写坏。
4. id 自增需要锁内扫目录，任务数上千后是否换 `t-<hash6>`。
5. `depends_on` 引用 id 在分支切换后会指向不存在任务，是否要求依赖先合入 trunk 才允许 `ready`。
