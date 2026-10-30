# M1 工作令（v2）：任务台 —— 任务规格、领取、开工摘要

> 取代 v1。v1 与 `docs/ARCHITECTURE-TASKS.md` 冲突，评审见 `docs/REVIEW-workorder-m1.md`。
> 交付基线：`main = e343b28`（含 M0 代码与 v1）。本 v2 提交后，以 v2 所在提交为基线。
> 交给实现方执行；本文件即验收依据，每一条都能用命令验。

## 0. 这一版改了什么（对评审的处置）

| 评审项 | 处置 |
|---|---|
| B1 基线不一致 | 接受：基线钉成提交号，不写"main"这种会移动的名字 |
| B2 存储模型与协议相反 | 接受：型号改 `.md` front-matter spec + common-dir live lease，运行态绝不写回 spec |
| B3 状态机与依赖语义 | 接受：状态用协议名；依赖只认 `merged`；M1 用「人工确认合并」闭环 |
| B4 缺崩溃事务闭环 | 接受：`next` 必须带 intent + recovery，不拿"持锁"冒充原子性 |
| B5 退出码 1/2 不确定 | 接受：锁前观察候选集、锁后重算，用「是否被别人消耗」区分 |
| I1 排序会饿死大任务 | 接受：改 FIFO（`created_at`, `id`） |
| I2 trunk 语义缺失 | 接受：`ready`/`next` 只认 trunk 可达的 spec，记录 `spec_commit` |
| I3 `lane new --task` | 接受：**删除该选项** |
| I4 Git 不进 mutex | 接受：`lane new` 的 `git worktree add` 全程在锁外 |
| I5 契约区被无条件延期 | 部分接受：M1 做 reads↔touches 交集提醒；`contracts_changed` 展示列 M2 并写进 DECISIONS |
| I6 id 跨分支重号 | 接受：改 opaque `t-<6 位十六进制>` |
| I7 SnapshotTask/UI | 接受：补完整字段与坏数据策略，改 UI 与断言 |
| I8 doctor 未对齐任务层 | 接受：写明 M1 doctor 最小检查集 |
| I9 基线测试非零退出 | **未能复现**：本机 `npm test` 48/48、exit 0；仍加固清理重试并统一统计口径 |

## 1. 存储模型（硬性）

```
<repo>/.cowork/tasks/<task-id>.md           # 提交：任务规格（spec）
<git-common-dir>/cowork/tasks/<task-id>.json # 不提交：状态、lease、审计
```

- spec 是**可提交知识**：`touches`/`reads`/`depends_on`/`done_when`/标题/正文。进入 `ready`
  后**不得改写**；要改就取消重建。
- live 是**运行态**：`status`、`lane`、`agent`、`spec_commit`、`history`。绝不写回 spec。
- CLI 是唯一写者；面板只读 `snapshot --json`。

## 2. spec schema

`.cowork/tasks/t-3f9a1c.md`，JSON front-matter（沿用 §3.5 的 `---` 分隔，不引入 YAML）：

```markdown
---
{"schemaVersion":1,"id":"t-3f9a1c","title":"给登录页加图形验证码",
 "touches":["src/auth/**"],"reads":["src/shared/types.ts"],
 "depends_on":[],"done_when":["npm test"],"contracts":[],
 "created_at":"2026-10-30T16:00:00.000Z"}
---

## 背景

…

## 验收说明

…
```

规则：

1. `id` = `t-` + 6 位十六进制，由 `sha256(title + created_at + 随机盐)` 截断，跨分支唯一，
   创建后不变。**不用自增序号**。
2. `touches` 非空；不能是仓库根（`""`、`.`、`./`、`**`）→ exit 1。
3. 路径规范化**复用** `src/paths.ts`，不新写一套。
4. `reads` 可为空；`done_when` 可为空（M1 不执行它，只展示）。
5. `depends_on` 只允许引用 trunk catalog 里存在且非 `cancelled` 的任务；成环 → exit 1 并打印环。
6. 未知字段原样保留，不做 schema 升级。

## 3. 状态机（M1 子集，名字用协议原名）

`draft → ready → claimed → in_progress → reported_done → merged`

旁支：`claimed|in_progress → blocked → in_progress`；任意 → `cancelled`。

- `blocked` 必须带 `reason`。
- `verifying` / `verify_failed` / `awaiting_merge` 是 M2 的自动验证态；M1 里出现这些转换一律
  exit 1，提示"M1 未实现自动验证，请用 `task confirm-merge --manual`"。
- **依赖满足只认 `merged`**，`reported_done` 不算。
- 非法转换 exit 1，打印"当前状态 → 你想要的状态 → 允许的下一步"。

## 4. 命令面

| 命令 | 说明 |
|---|---|
| `cowork task add --title <文本> [--touches <路径>]... [--reads <路径>]... [--depends <id>]... [--done-when <命令>]...` | 只创建 `draft` spec，打印 id 与文件路径。**不接受 `--status`** |
| `cowork task ls [--status <状态>] [--json]` | 列表（spec 字段 + live 状态合并视图） |
| `cowork task show <id> [--json]` | 详情 |
| `cowork task ready <id>` | `draft → ready`；**要求该 spec 已在配置 trunk 可达**，否则 exit 1 |
| `cowork next [--agent <名>] [--json]` | 领取（见 §5） |
| `cowork task start <id>` | `claimed → in_progress` |
| `cowork task report-done <id>` | `in_progress → reported_done`（M1 不做自动验证） |
| `cowork task confirm-merge <id> --commit <sha> [--manual --reason <文本>]` | `reported_done → merged`，释放 lease 与全部 touches claim |
| `cowork task block <id> --reason <文本>` / `cowork task cancel <id> [--reason]` | 旁支 |
| `cowork brief [--agent <名>]` | 开工摘要（只读） |
| `cowork lane new <名> [--base <ref>]` | 建车道（**无 `--task`**） |

`--agent` 缺省取 `COWORK_AGENT_ID`，再缺省 `default`。

## 5. `next` 事务（本单最难，逐条实现）

1. **锁外**：从配置 trunk 的固定 commit 读出整个 catalog（`git ls-tree` + `git show` 或
   `git cat-file`），得到候选集 `C` = `ready` 且 `depends_on` 全部 `merged` 且 touches 与
   现有 task lease / claim 不冲突。全程不持锁、不阻塞别人。
2. **取锁**，第一件事：恢复未完成 intent（见 3）。
3. 用同一个 trunk commit 重算候选集 `C'`。
4. 分支：
   - `C'` 非空 → 取第一个（FIFO：`created_at` 升序，同秒按 `id` 升序）。
   - `C'` 空且 `C` 非空 → **exit 2**，打印赢家：哪个 task、哪条 lane、哪个 agent、何时领的。
   - `C'` 空且 `C` 非空、但 `C` 只是因 touches 被手工 claim / held lease 占用（没有任务赢家）
     → **exit 1**，逐条打印占用者（与 §12.3 同语义；没有赢家就不许伪装成"被别人领走"）。
   - `C'` 空且 `C` 也空 → **exit 1**，打印阻塞原因：等哪个依赖未 `merged`、哪条路径被谁占。
     不允许只输出"没有任务"。
5. 事务：写 `next` intent（operation id、task id、lane、旧状态、拟写 claim ids）→ 写 task lease
   → 写全部 touches claims → 标记 intent `committed` → 清除 intent。
6. **全占或全不占**：任一步失败，在锁内按 intent 幂等回滚已写记录，任务状态不变；回滚失败
   标记 `corrupt` 并 **fail closed**（exit 3 或 1，绝不把任务开放给第二个 owner）。
7. 恢复：任何命令取得锁后先扫 intents。无 `committed` → 按 intent 回滚；有 `committed` →
   核对 task lease 与全部 claims 齐全，缺一个就 `corrupt` + fail closed。
8. **锁内不跑 git**（协议 §7）：catalog 已在锁外读进内存；锁内只做 live 文件的读写。
9. 领取成功输出：task id、touches、depends_on、done_when、lane、agent、spec_commit。

## 6. `brief`（只读，锁内短读）

输出给 agent 读的纯文本：

- 本 lane 当前任务：id、标题、touches、reads、done_when、spec_commit；
- 依赖：哪些已 `merged`、哪些没、卡在谁手里；
- 本 lane 已有 claim；跨 lane 与本单位置冲突的 claim（路径 + lane + agent）；
- 契约提醒：本任务 `reads` 与其他活跃任务 `touches` 的交集；
- 最近 3 条 `.cowork/notes/` 交接单（id/时间/标题）；
- 一条硬规则：只在 `touches` 内改文件，越界先 claim 扩范围。

## 7. `lane new`

- 名字 `[a-z0-9-]{1,32}`，不得为 `.`/`..`、不含 `/`、不与现有车道重名、分支 `cowork/<名>` 不存在
  → 违规 exit 1。
- `git worktree add .cowork/lanes/<名> -b cowork/<名> [<base>]`，base 缺省取 config `trunk`。
- **整条命令不持锁、不写 live 状态**（评审 I3/I4：删掉 `--task` 后没有需要保护的跨 Git 状态）。
- 已存在 → exit 2，打印现有车道。
- 成功输出：路径、`cd` 命令、建议 `COWORK_AGENT_ID=<名>`。

## 8. snapshot 与面板

`SnapshotTask` 字段（`src/snapshot.ts`）：

```
id, title, status, touches[], reads[], depends_on[], done_when[],
assigned_lane, agent, spec_commit, updated_at, blocked_reason
```

- `tasks` 从 `unknown[]` 改成 `SnapshotTask[]`；空数组仍合法。
- 坏 spec / 坏 live：不隐式跳过——进 `task_diagnostics: string[]`，该任务不进 `tasks`，
  并在面板显示"有 N 条任务读取失败"。
- `contract_alerts`：M1 产出 `{kind:"reads_touches", task, path, peer_task}` 数组（read↔touches 交集）；
  `contracts_changed` 展示列 M2，写入 `docs/DECISIONS.md` 作为版本化例外。
- 面板第四区：任务计数 + 状态分布 + 阻塞项；**删掉** `src/ui.ts:261` 的"任务层还没实现"，
  同步改 `test/ui.test.ts:150` 的断言。
- 面板仍只读 snapshot，不直接读 task 文件。

## 9. `doctor`（M1 最小检查集）

检查并各自给结论：spec 解析失败、id 与文件名不符、`touches` 空或为仓库根、依赖不存在、依赖成环、
task lease 的 `spec_commit` 与 trunk 漂移、live task JSON 损坏、残留 intent。

- 任一项异常 → exit 1（不是 0），逐条打印"文件 + 问题 + 怎么修"。
- `--fix`：清理过期 lease、隔离坏 live 到 `trash/`、回滚未提交 intent；**不改 spec**。
- 绝不把读不出来的任务当成"没有任务"。

## 10. 退出码

| 情形 | 码 |
|---|---|
| 参数错、touches 空/是根、id 不存在、依赖缺失/成环、状态转换非法 | 1 |
| `next` 调用时无候选（打印依赖/占用原因） | 1 |
| `next` 候选在等待锁期间被别人领走 | 2 |
| `lane new` 重名或路径/分支已存在 | 2 |
| 不在 git 仓库、无 git、路径越界 | 3 |
| live 状态损坏（消息必须含 `任务状态文件损坏: <文件>`） | 1 |

错误信息：**有 owner 就说明 owner，没有 owner 就说明阻塞原因和解决命令**（参数错误、依赖环、
空候选都不存在 owner，不要硬套"谁占着"）。

## 11. 测试与门槛

- 单测：状态机全部非法转换、id 唯一性、依赖环、touches 规范化、候选判定与 FIFO 排序抽成纯函数。
- 并发：5 进程 barrier 同时 `next` 领同一批任务 → 每个任务恰好一个 owner；并断言**没有**
  部分占位（claims 与 lease 数量一致）。
- 崩溃恢复：手工造一个"写了一半的 intent"（直接写 live 文件），跑任何命令 → 必须回滚或标 corrupt。
- e2e：`add → ready → next → start → report-done → confirm-merge --manual`，之后依赖它的任务才可领。
- 基线清理加固：`test/helpers.ts` 的 `rmSync` 重试上限提到 20 次/200ms，清理失败只警告不失败。
- 门槛：`npm test` 子测试 **≥ 60** 且整体 exit 0；`npx tsc --noEmit` 干净；比较数字时以测试
  runner 报的 `# tests` 为准。

## 12. 验收（每条都能直接跑，不依赖 shell 展开 glob）

1. `cowork task add --title x` → exit 1（缺 touches）。
2. `cowork task add --title x --touches .` → exit 1。
3. 车道 A：`cowork claim src/auth/login.ts`；车道 B：`cowork next`（候选任务 touches 为
   `"src/auth/**"`）→ exit 1，输出含 `src/auth/login.ts` 与车道 A 的 agent。
4. 两个车道用 barrier 各跑一次 `next`，仓库里只有一个 ready 任务 → 一个 exit 0，另一个 exit 2
   且打印赢家 lane。
5. 未提交的 lane 私有 spec：`task add` 后不提交，直接 `task ready` → exit 1（不在 trunk）。
6. `task ready` 后 `snapshot --json` 中 `tasks[].status == "ready"`，`spec_commit` 非空。
7. 依赖链：B `depends_on` A；A 只到 `reported_done` 时 `next` 不给 B（exit 1 说明等 A `merged`）；
   A `confirm-merge --manual --reason "..."` 后 B 可领。
8. `lane new bad/../name` → exit 1；重名 → exit 2；成功后 `lane new` 不产生任何 live 写入。
9. 手工写一个半成品 intent → 任意命令自动回滚，`next` 仍能正常领取。
10. `npm test` ≥60 且 exit 0；`npx tsc --noEmit` 无输出。

## 13. 非目标

- 不做自动验证三层（`verifying` / `verify_failed` / `awaiting_merge`）——M2。
- 不做 `contracts_changed` 全量扫描与 AST 分析——M2。
- 不做 `merge --dry-run`、不做任务自动拆解、不做 LLM 调度、不做 fan-out。
- 不改 M0 的 claim/mutex/store 语义；不动面板布局（只换第四区内容与文案）。
- 不动 `docs/ARCHITECTURE-TASKS.md`（除把"M1 例外"记进 DECISIONS 这一条）。

## 14. 交付物

- 代码 + 测试（≥60）+ `docs/DECISIONS.md` 两条：D9「M1 跳过自动验证，用 confirm-merge --manual
  闭环」、D10「任务 id 用 opaque hash，不用自增」。
- `.cowork/notes/` 交接单：做了什么、没做什么、下一单从哪接。
- 提交分组：①spec 模型与解析 ②live 状态机与 lease ③next 事务与恢复 ④brief/doctor ⑤snapshot 与面板
  ⑥测试加固。每组可独立回滚。

## 15. 已决议（不再开放）

1. 排序：FIFO（`created_at`, `id`），touches 只用于冲突判定。
2. 竞争失败 2、调用时无候选 1，靠锁前候选集区分。
3. 一任务一 Markdown，运行态在 common-dir。
4. id 用 `t-<hash6>`，不用自增。
5. 依赖只认 trunk catalog + `merged`，lane 私有 spec 不参与。
