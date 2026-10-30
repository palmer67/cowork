# cowork 架构计划书（二）：任务层增补

> 本册只定义任务层，不重写基础架构。Windows/NTFS 路径、claim、mutex、live store 与 handoff 的基础约束以 [docs/ARCHITECTURE.md](ARCHITECTURE.md) §3 为准。本册引用该协议，不新增路径判定、文件锁或 live 状态源。

## 1. 定位与运行方式

任务层把“人和 agent 已经拆好的工作”记录成可领取任务，并管理依赖、touches 占位、验证进度和完成汇总。拆解智能在 agent 侧；cowork 不自动拆解、不做 LLM 调度，也不启动 Codex 或 DSH。该环境中 Codex 不在 PATH、DSH 是 GUI，cowork 只能采用**拉模式**：人/agent 把任务写入任务台，agent 自己执行 `cowork next` 来领取。

任务单是可提交知识，放在 `.cowork/tasks/<task-id>.md`；领取、分配、心跳、运行状态、验证结果放在 `$(git rev-parse --git-common-dir)/cowork/tasks/`。CLI 是唯一写者。只读看板将来只能读取 `cowork snapshot --json`，不能直接访问 live store 或写任务状态。

## 2. 任务对象模型

任务对象由两部分合成：提交进 Git 的不可变/可审阅任务规格，加上 common-dir 中的 live 运行态。CLI 输出的有效对象至少有以下字段：

| 字段 | 含义 |
| --- | --- |
| `id` | 稳定 task id；建单时生成，路径安全，创建后不改 |
| `title` | 一句话说明交付结果 |
| `touches` | 要读写的文件/目录逻辑路径清单；使用基础架构 §3 的同一规范化键与精确文件/递归前缀 matcher |
| `depends_on` | 前置 task id 数组；所有前置任务必须完成三层验收并进入 `merged` 才算满足 |
| `done_when` | 可验收的完成定义，数组形式；写明行为、测试或交付物，不用“完成开发”等空泛描述 |
| `assigned_lane` | 当前实际领取 lane；未领取为 `null`。派工单可写建议 lane，实际领取值以 live lease 覆盖 |
| `status` | 当前状态；派工单创建值为 `ready`，之后以 live 状态记录为准 |
| `created_at` | UTC 创建时间；用于稳定的 next 排序 |
| `contracts` | 已知公共接口/契约路径，见第 5 节 |

派工单里的初始 `status` 和建议 `assigned_lane` 不作为运行态真相。CLI 读取 task spec 后，以 common-dir live 记录覆盖二者；任何命令展示的是合成后的有效 Task 对象。这样领取/心跳不会改写已跟踪任务单，也不会让不同 worktree 对同一任务单产生提交冲突。

### 状态机

```text
draft -> ready -> claimed -> in_progress -> reported_done -> verifying
                                      ^                          |
                                      |                    verify_failed
                                      |                          |
                                      +--------------------------+
                                                               v
                                                       awaiting_merge -> merged

ready/claimed/in_progress/reported_done/verifying/verify_failed/awaiting_merge
  -> blocked -> ready 或 in_progress
ready/blocked -> cancelled
```

- `draft`：任务规格尚未审阅，`next` 不可领取。
- `ready`：依赖满足，可参与领取候选。
- `claimed`：某 lane 已原子取得任务租约和 touches claim，尚未确认开工。
- `in_progress`：agent 明确开始；lease/claim 由原有 heartbeat 机制续期。
- `reported_done`：agent 自报完成，等待自动验证。
- `verifying`：CLI 正在跑预先配置的测试/构建/类型检查。
- `verify_failed`：至少一项验证失败；保留任务现场和 claim，修复后重新验证或继续执行。
- `awaiting_merge`：自动验证全过，等人审阅并合并。
- `merged`：人已完成合并并向 CLI 确认目标提交；依赖从此满足，touches claim 可释放。
- `blocked`：明确记录阻塞原因与解除条件；不进入 `next` 候选。
- `cancelled`：人取消；释放其 task lease 与 touches claim，并记录原因。

终态 `merged`、`cancelled` 不自动回退。需要返工时创建新任务，或由人显式 reopen 并留下审计记录；不能由 stale 恢复静默重置状态。

## 3. 派工单格式

沿用基础架构 §3.7（原计划 §3.5 handoff schema）的 JSON front matter + Markdown 正文，不增加 YAML、数据库或第二种载体。一个任务一份 `.cowork/tasks/<task-id>.md`：

```markdown
---
{"schemaVersion":1,"kind":"task","id":"T-2026-001","title":"为登录刷新补重试保护","created_at":"2026-10-30T08:00:00Z","touches":["src/auth/login.ts","tests/auth/**"],"depends_on":[],"done_when":["刷新失败时只重试一次","新增用例覆盖超时与成功路径"],"assigned_lane":null,"status":"ready","contracts":["src/auth/session.ts"]}
---
## Context
用户可见的问题与相关背景。

## Instructions
约束、允许的实现范围，以及明确的非目标。

## Validation
期望的测试、构建或类型检查。
```

front matter 使用单行 JSON，必需字段缺失、schemaVersion 不支持、touches 路径非法、depends_on 引用不存在或形成环时，`task add/doctor` 拒绝接受（一般错误退出 1）；不猜测修复。人类可直接审阅/提交 Markdown；`cowork task add` 可以生成模板，但不代替人或 agent 拆任务。完成结果不回写任务规格，而写入基于 §3.7 同一 handoff 格式的 `.cowork/notes/` 交接单，关联 `task_id`。

任务目录的权威版本是 `.cowork/config.json` 指定的 trunk ref；任务单必须先提交到 trunk 才进入全局候选队列，未提交的 lane 私有 task 文件不参与其他 lane 的 `next`。各 lane 的 `next` 从 Git 对象库读取同一个 trunk commit 下的 task specs，领取时把 `spec_commit` 写入 live task lease；一个活跃任务的 spec 在 lease 期间不得改写。任务更新提交到 trunk 后，尚未领取的任务立即按新版本读取；活跃任务若发现 spec commit 漂移，doctor 报告并要求人显式取消/重建，不静默改变 touches 或 done_when。

live store 保存每 task 的状态、assigned lane、lease、尝试次数、验证结果、状态变更时间和 handoff 引用。建议布局：

```text
<repo>/.cowork/tasks/<task-id>.md       # 提交：任务规格
<git-common-dir>/cowork/tasks/<task-id>.json  # live：状态、lease、验证摘要
```

## 4. 领取协议与并行判定

### `cowork next`

多个 agent 同时执行 `cowork next` 时，命令必须恰好让一个领取到特定任务，其他竞争者不能拿到同一任务并以退出码 2 返回“任务已被 lane X 领取”。它不启动任何 agent。

领取复用基础架构 §3.1 的**同一个全局 mutex**，不创建任务 mutex 或第二种路径锁。`next` 先从配置的 trunk ref 读取一个固定 commit 的 task catalog；取得 mutex 后确认 catalog ref 未变化，若变化则释放并重读。持有该 mutex 时，按稳定顺序扫描 `ready` 任务（`created_at` 升序、再按 task id ordinal 升序），核验依赖、任务并行判定和现存 path claims，然后在一个临界区内写入 task lease/assigned lane/status，并登记对应 touches claims。临界区只做本地元数据读写，不跑 Git build/test，也不等待 agent。

领取任务和取得其 touches claim 是同一个原子事务：

1. 若已有手工/其他任务 claim 与 touches 冲突，`next` 不得先占任务；继续找下一个可执行任务。若没有候选，退出 2 并给出冲突/依赖原因。
2. 任务 lease、状态和 touches claim 是多文件 live 更新，mutex 只提供并发排他，不自动提供断电事务性。先在同一 live store 写入带 operation id 的 `next` intent（含 task id、lane、旧状态和拟写 claim ids），再写 task lease 与全部 touches claims，最后标记 intent `committed`；任何命令取得 mutex 时先恢复未完成 intent。无 `committed` 标记则按 intent 幂等回滚已创建记录，已 `committed` 则核对所有记录完整后清除 intent。恢复遇到不一致时标记 corrupt 并 fail closed，不能把任务开放给第二个 owner。
3. 只有 task lease 和全部 touches claims 都能成功时，才提交 `claimed` 状态。任一写入失败，在 mutex 内按 intent 撤销本次已写的 live 记录后释放锁，任务保持原状态；撤销失败则标记 corrupt 并 fail closed。
4. 手工 `claim` 与任务 `next` 通过同一 mutex 和同一 matcher 序列化。先完成的 claim 优先；后到者退出 2。不存在“先领任务再异步抢文件”或双锁顺序，因此没有锁顺序反转。
5. task lease、touches claim 使用 §3 已定 TTL/heartbeat/stale 回收规则；失效恢复不可把 `reported_done`、`verify_failed` 或 `awaiting_merge` 静默改成 `ready`。

此设计复用现有 mutex 与 claim 规则，新增的是 mutex 临界区内的任务状态事务，不新增并发原语。

### 确定性并行函数

两任务同时执行的纯判定接口：

```ts
assessParallel(
  a: TaskSpec,
  b: TaskSpec,
  live: Readonly<TaskLiveSnapshot>,
): { allowed: boolean; code: 0 | 2; reason: "allowed" | "touches_overlap" | "dependency_pending"; paths: string[]; taskIds: string[] }
```

规则按固定顺序执行：

1. 若 `a.touches` 与 `b.touches` 按基础架构 §3.3 的同一 matcher 有交集（相同文件、文件落在目录前缀下，或两个目录前缀互为祖先/后代），返回 `{allowed:false, code:2, reason:"touches_overlap"}`。
2. 若 A 直接或传递依赖 B，或 B 直接或传递依赖 A，且该依赖任务尚未 `merged`，返回 `{allowed:false, code:2, reason:"dependency_pending"}`。两个任务只共享同一个尚未完成的上游依赖，但互相没有依赖关系时，本条不阻止并行。
3. 其他情况返回 `{allowed:true, code:0, reason:"allowed"}`。

非法 task、依赖环、损坏的 live snapshot 属一般错误退出 1；NTFS/git-common-dir 等环境条件不满足退出 3。结果与输入顺序无关；`paths`、`taskIds` 排序后去重，供测试和 JSON 使用。`next` 还必须把候选与所有 live active touches/path claims 做相同判定，而不能只比较两张任务单。

## 5. 契约区（公共接口）

契约区是任务间必须共同遵守的路径/接口集合，包括：公开 TypeScript 类型定义、JSON/schema 定义、package/module 导出面，以及被多个未完成任务 touches 覆盖的路径。采用**自动候选 + 人工确认**：

- 自动候选来自 config 中显式登记的契约路径/前缀，以及任务 touches 重叠、`package.json` exports、schema 文件和 Git diff 命中的文件。零运行时依赖约束下不做完整 AST/API 语义扫描；自动结果是提醒，不宣称完整。
- 人/agent 在任务单 `contracts` 字段标出已知契约；`cowork brief/next/status` 将任务 touches 与自动候选集合合并显示。新建任务时若触及候选契约，要求作者确认“会改契约”或“只兼容使用”，不能默认为无影响。
- 更改公共契约的任务必须在最终 handoff 中记录 `contracts_changed`：路径、旧/新签名或 schema、兼容性/迁移说明、受影响 task id 与建议动作。改动者负责在 handoff 写出受影响任务；任务创建者/人负责调整依赖或 touches。其他 agent 不可被程序推送/启动，下一次 `cowork next`、`brief` 或 `snapshot --json` 必须显著展示该通知。
- 若契约变更使活跃任务的假设失效，由人或任务负责 agent 显式将其置为 `blocked` 并在该任务 handoff/状态原因中引用契约变更 handoff；更新任务单并提交后再解除。不得自动改写他人任务或代码。

## 6. 三层完成判定

任务只有走完以下三层才成为 `merged`，并满足下游依赖：

| 层 | 动作与成功条件 | 失败状态与退出码 |
| --- | --- | --- |
| 1. Agent 自报完成 | lane owner 执行 `cowork task done <id>`；CLI 核对 lease owner、必需 done_when 自检和 handoff 引用，转 `reported_done`，然后启动第 2 层 | owner 不匹配/租约冲突退出 2；缺少结果或 handoff 退出 1，保持 `in_progress` |
| 2. 自动验证 | CLI 按仓库 config 中固定 argv 顺序运行测试、构建、类型检查；全部为 0 才转 `awaiting_merge`。命令用 `execFile` 参数数组，不 shell 拼接；进程执行不持有全局 mutex，但 task lease/touches claim 继续有效 | 任一验证非 0、超时或结果不可解析，转 `verify_failed`，保存命令、退出码和摘要，整个 done 命令退出 1。保留任务和 touches claim；agent 修复后重新自报/重跑验证，不将其标为完成 |
| 3. 人确认合并 | 人检查验证摘要并将 lane 合入目标分支，之后执行 `cowork task confirm-merge <id> --commit <sha>`；CLI 验证该提交确已包含任务分支结果，记录确认事件，转 `merged`，释放任务 lease 与 touches claim | Git 合并冲突退出 2，状态留在 `awaiting_merge`，不自动解决；拒绝合并则显式置 `blocked`/reopen 并写原因，不能伪造 merged |

“自报完成但验证失败”固定进入 `verify_failed`，不能仅凭 agent 文字、handoff 或测试摘要越过验证，也不能释放 touches claim。人工确认是最后一层；只跑绿测试不等于合并完成。

## 7. 与基础 §3 的边界

1. 任务 spec touches 使用基础 §3.2 的跨 worktree 逻辑路径键和 §3.3 的精确文件/递归前缀 matcher；不得重新按物理路径比较，不得另发明 glob。
2. 领取时在基础 §3.1 的 mutex 内把 task lease 与原有 path claims 一起原子取得；手工 claim 先到则 task 不领取，task 先到则手工 claim 退出 2。两者均以现有 claims live store 为唯一占位真相。
3. task status/assignment/lease 与 claim 的增删续期全部使用同一个 common-dir live store 与 mutex。任务层没有第二把锁、数据库、`.cowork/live` 镜像或任务状态守护进程。
4. 不在 mutex 内执行外部测试或 Git merge。自动验证期间 lease 仍有效；人工 Git merge 在锁外完成，完成后用短临界区验证提交并记录 `merged`、释放 claim。

## 8. `cowork snapshot --json` 只读契约

为未来只读面板预留快照，不在本册设计 Web UI。建议顶层字段：

```json
{
  "schemaVersion": 1,
  "generatedAt": "...",
  "repo": { "root": "...", "head": "..." },
  "tasks": [{ "id": "...", "title": "...", "status": "...", "assigned_lane": null, "touches": [], "depends_on": [], "blockers": [], "verification": [], "contracts_changed": [] }],
  "claims": [],
  "lanes": []
}
```

命令通过基础 mutex 获取一致 live 快照，完整序列化后输出 stdout；只读，无写入副作用。JSON schema 版本化；面板不可直接读取或修改 `.git/cowork`。

## 9. 错误码与不变约束

沿用既有退出码：`0` 操作成功/并行允许；`1` 一般错误、task spec/验证失败；`2` 被占用、touches/依赖阻止并行、重复领取或 Git 冲突；`3` 环境不满足。错误继续说明 lane/任务占用者与下一步命令。

本层不改变 Windows/NTFS、Node ≥ 22、TypeScript strict、零运行时依赖优先、不用 Docker/WSL/后台守护进程、不改 agent 二进制等既定约束。没有 Codex/DSH spawn 能力，故不提供推送式派工；人和 agent 自己创建任务、自己来拉取。

## 10. 实施与验收边界

任务层实现前，基础 M0 的 mutex 原语必须已经通过原架构 §6 中规定的 NTFS 并发门槛；本册不改写或替代该测试结论。任务层最小验收：

- 两个进程同时 `next` 同一唯一候选任务，恰好一个获得 task lease + touches claim，另一个退出 2；验证 live 状态只有一名 owner。
- 两个任务 touches 相交时禁止并行；文件/目录前缀边界结果与基础 matcher 一致。
- 未完成直接或传递依赖关系禁止并行；仅有共同上游依赖且无互相依赖时允许并行；两任务都 `merged` 后解除依赖限制。
- 手工 claim 先到、任务 next 先到两种交错顺序都只允许一个 owner，不存在任务 lease 成功但文件 claim 失败后的残留状态。
- 自报完成后测试/构建/类型检查失败进入 `verify_failed`、退出 1、保留 claim；三项通过只到 `awaiting_merge`；人确认实际合并后才进入 `merged` 并释放占位。
- 改契约任务的完成 handoff 有 `contracts_changed`，影响任务在 brief/next/snapshot 可见；CLI 不尝试启动或通知 GUI agent 进程。
