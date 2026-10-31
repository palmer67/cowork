# M2 自动验证与人工确认合并工单

状态：设计稿，等待判官裁定。本文只定义 M2 的接口、状态和验收，不包含实现。

依据：`docs/ARCHITECTURE-TASKS.md` §4 状态机、§6 三层完成判定、§7 snapshot 字段，以及现有 §3 的 mutex、claim、路径 matcher 和退出码约定。

## 决策与理由

### 1. 状态机与转移表

选择保留现有拉取式 owner 语义，并增加以下明确转移：

```text
reported_done --task done--> verifying --全部验证通过--> awaiting_merge --confirm-merge--> merged
                                      |
                                      +--任一失败/超时/dirty/HEAD 漂移--> verify_failed

verify_failed --owner 修复后 task done--> verifying
verifying --doctor --fix（确认验证进程已死）--> reported_done
```

`reported_done -> verifying` 在 `task done` 的第一次短锁临界区内完成，命令随后在锁外运行验证。启动失败、配置错误、owner/claim 不匹配为一般错误，退出 `1`，状态保持 `reported_done`；不把未执行伪装成验证失败。

`verifying -> verify_failed` 表示验证确实开始但没有得到合格结果：命令非零、超时、输出不可记录、worktree dirty 或验证前后 HEAD 不一致，退出 `1`，保留 lease 和全部 touches claim。

`verifying -> awaiting_merge` 只有所有启用检查退出 `0`、工作树仍干净且 HEAD 未变，退出 `0`。`awaiting_merge -> merged` 由人执行 `confirm-merge`，成功退出 `0` 并释放 lease/claims。

转移/拒绝码表：

| 请求或结果 | 状态变化 | 退出码 |
| --- | --- | --- |
| owner 的 `task done`: reported_done → verifying，随后全部通过 | awaiting_merge | `0` |
| 初始 dirty、配置无效或 executable 启动失败 | 保持 reported_done | `1` |
| owner/lease 冲突或第二次锁发现 run_id/status 已被替换 | 保持当前状态 | `2` |
| 任一验证失败、超时、验证中 dirty 或 HEAD 漂移 | verify_failed | `1` |
| doctor 确认 verifying 进程已死并恢复 | reported_done | `0`；仅提示、无法确认不转移且退出 `0` |
| 普通 merge 校验通过并记录人工确认 | merged | `0` |
| target 不存在/祖先不成立/manual reason 缺失或其他非法状态转移 | 状态不变 | `1` |
| 实际 Git merge 冲突 | awaiting_merge 不变 | `2` |
| git-common-dir 或 lane 环境不可用 | 状态不变 | `3` |

所有未列出的状态转移统一拒绝，退出 `1`；owner/并发版本冲突属于 `2`，环境缺失属于 `3`。任何拒绝均不得局部写入状态或释放 claim。

验证进程崩溃时由 `doctor --fix` 负责恢复：live 记录保存 `verification.pid`、`verification.host`、`started_at` 和 `run_id`；仅当 host 是本机且 PID 已确认不存在时，doctor 才把 `verifying` 推回 `reported_done`，保留 owner、lease、claims 和历史并输出恢复记录。PID 仍存活、host 不同、字段损坏或无法确认时不自动回退，doctor 只报提示，避免误杀仍在运行的验证。普通 `doctor` 不改变状态。

被否决的备选：

- 让下一次 `task done` 或 `next` 自动清理 verifying。否决：普通任务命令不应猜测一次验证是否仍在跑，会把长测试误判为崩溃。
- 让 doctor 无条件把 verifying 改回 reported_done。否决：无法区分慢测试与崩溃，破坏验证记录的可信度。

### 2. 验证配置

选择 `.cowork/config.json` 增加 `verification` 对象，命令是参数数组：

```json
{
  "schemaVersion": 1,
  "trunk": "main",
  "verification": {
    "allow_disabled": false,
    "commands": [
      { "name": "test", "argv": ["node", "--experimental-strip-types", "--test"], "timeout_ms": 300000, "enabled": true },
      { "name": "types", "argv": ["node", "node_modules/typescript/bin/tsc", "--noEmit"], "timeout_ms": 120000, "enabled": true }
    ],
    "env_allowlist": ["PATH", "SystemRoot", "ComSpec", "TEMP", "TMP", "CI", "NODE_ENV", "COWORK_AGENT_ID"]
  }
}
```

schema 规则：`commands` 非空数组；每项 `name` 唯一且为短标识，`argv` 非空字符串数组，第一项是可执行文件，`timeout_ms` 为 1..3,600,000 的整数，`enabled` 为布尔值。`allow_disabled=false` 时所有项必须 enabled；只有显式设为 true 才允许禁用单项，禁用项写入 verification 记录并显示为 skipped，不能悄悄消失。至少保留一项 enabled 命令。

执行使用 `execFile(argv[0], argv.slice(1), { cwd, shell: false })`，不拼接 shell 字符串，也不从配置读取 shell。配置中的 executable 必须是可直接执行的程序；Windows 的 `.cmd`/`.bat` 包装器不允许作为 argv[0]，示例通过 `node.exe` 直接运行 Node 测试 runner 与 TypeScript 编译器入口，避免平台 shell 差异。`cwd` 固定为任务 `assigned_lane` 对应的 worktree 根；lane 缺失、worktree 不存在或不等于 lease 记录的路径时拒绝执行。环境只继承内置白名单中的现值和当前任务所需的 `COWORK_AGENT_ID`，不继承完整 `process.env`，配置不能扩展白名单或注入 secret。

被否决的备选：

- 允许每个命令写一整条 shell 字符串。否决：引入 quoting、PATH 和命令注入差异，无法满足零 shell 拼接。
- 允许任务 spec 自己覆盖命令、cwd 或环境。否决：验证定义必须由仓库配置和人审查，不能由待验证 agent 改写。

### 3. `cowork task done <id>` 的事务边界

选择“两次短锁 + 锁外执行”：

1. 第一次取全局 mutex：读取 live/spec，核对 status=`reported_done`、lane/agent owner、lease/claims、done_when/handoff；检查 `git status --porcelain=v1 --untracked-files=all` 为空；读取 `head_before`；生成 `run_id`，写入 `verifying` 和验证元数据，然后释放锁。
2. 锁外按配置顺序执行所有 enabled 命令。每项记录开始时 HEAD、退出码、超时、duration 和摘要；一项失败后停止后续项，保留已执行记录。
3. 第二次取锁：核对仍是同一 `run_id`、状态仍为 `verifying`、owner/lease/claims 未变；重新读取 HEAD 和 dirty 状态。只有 HEAD 等于 `head_before`、工作树干净、每项成功，才写 `awaiting_merge`；否则写 `verify_failed`。释放锁后返回相应退出码。

两次取锁之间若 HEAD 变了，验证仍可完成但最终必为 `verify_failed`，因为验证结果不再对应开始时的提交；不会覆盖新提交，也不会释放占位。若第二次取锁发现状态或 run_id 已被其他命令改变，退出 `2` 并保留当前 live，不作盲写。

dirty 判定使用 `git status --porcelain=v1 -z --untracked-files=all`；暂存、未暂存、删除、重命名、未跟踪都算 dirty，忽略文件不算。初始 dirty 直接拒绝 `done` 并退出 `1`，保持 `in_progress`；验证中出现 dirty 进入 `verify_failed`。

被否决的备选：

- 持有全局 mutex 跑测试。否决：长测试会阻塞所有 claim、next 和 doctor。
- 验证前后只检查一个 HEAD，不检查 dirty。否决：测试生成未跟踪/修改文件时，提交仍可能看似未变而污染 lane。

### 4. verifying 的可观测性

选择在 task live 增加一个可空 `verification` 对象，并由 snapshot 原样投影：

```json
{
  "run_id": "verify-20261101-...",
  "status": "running|passed|failed|stale",
  "pid": 1234,
  "host": "HOST",
  "started_at": "2026-11-01T10:00:00.000Z",
  "finished_at": null,
  "head_before": "<sha>",
  "head_after": null,
  "summary": "",
  "records": [
    { "name": "test", "argv": ["node", "--experimental-strip-types", "--test"], "exit": 0, "duration_ms": 1200, "head": "<sha>", "summary": "132 pass", "at": "..." }
  ]
}
```

`summary` 必须是截断后的 stdout/stderr 摘要，完整输出留在 CLI 当次结果，不写入 live。`stale` 只由 doctor 在确认验证进程死亡后使用，然后转回 `reported_done`；`failed` 对应 `verify_failed`，`passed` 对应 `awaiting_merge`。

面板任务列显示 verifying、最近检查名、exit、耗时和短摘要；running 显示“验证中”，失败显示失败命令及“保留占位”。`brief` 在本 lane 任务段落中显示验证状态/最近结果，`next` 在领取输出中提示依赖任务正在验证或验证失败，不能把 verifying/verify_failed 当作 merged 依赖满足。

被否决的备选：只把最终状态写成字符串。否决：无法解释哪一项检查失败、耗时多少或验证是否因崩溃卡住。

### 5. `confirm-merge` 强化

选择沿用 `confirm-merge <id> --commit <target>` 的接口，把 `--commit` 解释为目标分支当前确认的 commit。普通 merge：先解析 target 与 `verify_head`，执行 `git merge-base --is-ancestor <verify_head> <target>`；成功才允许 merged。target 不存在、不是 commit、祖先判定不成立，退出 `1`，状态保持 `awaiting_merge`，不释放 claim。

目标是 squash/cherry-pick 等不包含 `verify_head` 祖先关系的历史时，必须显式 `--manual --reason "..."`；缺任一参数退出 `1`、状态保持不变。人工确认只记录 target SHA、reason、操作者和时间，不伪造自动等价证明。Git 冲突或目标读取环境错误按现有语义退出 `2`/`3`，同样不改状态。

被否决的备选：用树快照或 patch 文本自动猜测 squash 等价。否决：这不是通用可证明的合并判定，容易把遗漏改动标为 merged。

### 6. `contracts_alerts`

选择把 handoff front matter 的 `contracts_changed` 定义为对象数组，每个对象至少有一个 `paths` 数组，其他字段用于展示：

```yaml
contracts_changed:
  - paths: [src/api.ts, schemas/task.json]
    old: "TaskV1"
    new: "TaskV2"
    compatibility: "兼容读取，写入需升级"
    affected_tasks: [t-123abc]
```

`paths` 必须是非空字符串数组；`old`、`new`、`compatibility`、`affected_tasks` 可缺省，缺省分别显示为 `未说明`、`未说明`、`未说明`、`[]`。缺省 `contracts_changed` 等于空数组，不生成提醒；字段存在但形状错误进入 handoff diagnostics，不把坏数据当作空集。多条 handoff、每条多路径逐项展开，去重后保留来源 lane/task/path。

路径归一化复用 touches 的 matcher：反斜杠转 `/`、去掉 `./`、拒绝绝对路径和 `..`；精确文件是精确匹配，目录或尾随 `/**` 是递归前缀，路径段边界必须相同。嵌入式 `*`、`?`、`[]` 等通配仍拒绝，不另引 glob 库。

产生三类提醒：任务 `reads` 与其他任务 `touches` 相交；任务 `reads` 与 `contracts_changed.paths` 相交；当前任务的 `touches` 与已声明契约变更相交。提醒只读、不阻止领取，字段至少含 `kind`、读方 task、写方 task/lane、path、handoff path、summary。`brief` 和 `next` 显示可执行文字，snapshot 的 `contract_alerts` 保留结构化数组；面板在任务表的“契约”列显示警告数量，展开行显示路径与来源。

被否决的备选：缺省或坏 `contracts_changed` 直接忽略。否决：静默丢失契约提醒比显示诊断更危险；坏 handoff 必须可见。

### 7. 移动/删除、`**` 与验证命令副作用

移动和删除使用 Git porcelain 的新旧路径对：rename 的新旧任一路径命中 touches/reads 都算命中，删除路径保留为待验证变更，不因为文件不存在而跳过。路径比较仍按逻辑仓库根相对键，不按物理 worktree 绝对路径比较。

`src/foo/**` 只表示 `src/foo` 递归前缀，和现有 touches 规则一致；不支持中间 glob。`**` 命中目录自身及其后代，边界按 `/` 判断。

验证命令默认必须是可重复、对 worktree 只读的命令。确实会生成产物的命令必须通过 argv/环境把产物放到系统临时目录或自身在退出前清理；CLI 不运行 `git clean`、不回滚文件、也不替命令删除副作用。验证前后 dirty 检查把未清理副作用判为失败并保留现场，避免验证程序“自己把自己弄 dirty”后仍然放行。

被否决的备选：允许 doctor 或 `task done` 自动删除测试产生的文件。否决：这会掩盖验证程序的副作用，并可能删除 agent 尚未提交的诊断材料。

### 8. 验收策略

选择把状态、claim、HEAD/dirty 和契约提醒都写成可执行验收。理由：M2 的关键安全边界是跨进程状态和退出码，必须能重复证明。

被否决的备选：只保留人工走查清单。否决：无法稳定复现竞争、恢复和状态保持行为。

### 9. 非目标

- 不自动合并、不 push、不启动 agent。
- 不做 AST 分析；契约发现仍是基于声明和路径 matcher 的提醒。
- 不引入运行时依赖、数据库、后台守护进程或第二套状态写入器。
- 不把验证结果当作合并证明；最终 merged 仍需人工确认。

被否决的备选：把 M2 扩展成自动 merge/自动调度系统。否决：这会越过人工确认边界，改变 cowork 作为拉取式纪律层的定位。

## 数据与配置 schema

配置顶层为 `verification`：`allow_disabled: boolean`、非空 `commands: VerificationCommand[]`、固定的 `env_allowlist: string[]`。每个命令包含唯一 `name`、非空 `argv: string[]`、有界 `timeout_ms` 和 `enabled: boolean`；至少一个命令启用。执行记录包含命令名、原始 argv、exit、duration、head、摘要与时间。

task live 的可空 `verification` 记录含 `run_id`、`status`、`pid`、`host`、`started_at`、`finished_at`、`head_before`、`head_after`、summary 和 records；snapshot 对任务投影同一字段，不重算或丢弃历史。`head_before` 即本次验证绑定的 `verify_head`。

handoff `contracts_changed` 是对象数组，每项的 `paths` 是非空字符串数组；old/new/compatibility/affected_tasks 为可选展示字段。缺字段默认为空列表，坏形状进入 handoff diagnostics。snapshot `contract_alerts` 每项含 kind、读方/写方 task 或 lane、path、handoff path 与 summary。

## 状态机图（纯文本）

```text
draft -> ready -> claimed -> in_progress -> reported_done
                                             |
                                             v
                                         verifying
                                      /            \
                         verify_failed          awaiting_merge
                              |                       |
                 owner 修复后 task done              |
                              |                       v
                              +--------------------> merged

doctor --fix: verifying --(本机 PID 已死)--> reported_done
blocked 可从 ready/claimed/in_progress/reported_done/verifying/verify_failed/awaiting_merge 进入；
blocked -> ready 或 in_progress；ready/blocked -> cancelled。
```

## 事务序列

```text
task done
  ├─ lock #1: owner/lease/claim/spec/dirty/head 校验
  ├─ lock #1: 写 verifying(run_id, pid, head_before, started_at)
  ├─ unlock
  ├─ execFile 命令 1..N（固定 cwd、argv、超时、白名单环境）
  ├─ lock #2: 校验 run_id/status/owner/claims/head/dirty
  ├─ lock #2: 写 verify_failed 或 awaiting_merge + records
  └─ unlock，返回 1 或 0

doctor --fix
  ├─ lock: 读取 verifying 的 pid/host/run_id
  ├─ 确认本机 PID 已死
  ├─ lock: verifying -> reported_done，保留 lease/claims，追加 recovery history
  └─ unlock
```

## 验收清单

每条都可由临时 Git 仓库、两个 lane 和白名单命令脚本执行：

1. `reported_done` 执行 `task done` 后进入 verifying；验证期间另一个 lane 的 `next` 不能抢同一任务或其 touches。
2. 任一验证命令退出非零时，`task done` 退出 `1`，状态为 `verify_failed`，lease 和全部 claims 仍存在。
3. 验证后修改 lane HEAD，再让命令返回 `0`，结果必须为 `verify_failed`、退出 `1`，不能进入 awaiting_merge。
4. 验证前制造 tracked/unstaged 或 untracked dirty，`task done` 拒绝执行并退出 `1`，状态保持 `in_progress`。
5. squash 场景不带 `--manual` 或缺 `--reason` 的 `confirm-merge` 退出 `1`，状态仍为 awaiting_merge。
6. `reads` 与其他任务 touches 相交时，`brief`、`next` 和 snapshot 各出现一条结构化契约提醒。
7. 修正/移除冲突 handoff 后重新生成 snapshot，原契约提醒消失，坏 front matter 则进入 diagnostics。
8. 验证进程被杀死且 live PID 已失效时，`doctor --fix` 把 verifying 恢复为 reported_done，保留 claim，并记录恢复历史；PID 仍存活时不回退。
9. snapshot 在 verifying/verify_failed/awaiting_merge 分别显示 verification status、命令记录、exit、duration、head 和 summary。
10. 普通 merge 的 target 不存在或不满足 `is-ancestor` 时退出 `1`、状态和 claims 不变；满足时才 merged 并释放占位。
11. rename、delete 和 `src/foo/**` 的契约/reads 命中与 touches matcher 一致，路径段相邻前缀不误报。
12. 验证命令写入 worktree 后未自清理，结果为 verify_failed；写入系统临时目录且工作树保持 clean 时可进入 awaiting_merge。

## 需要判官裁定的问题

1. 验证进程崩溃恢复：A. 仅 `doctor --fix` 在 PID 明确死亡时恢复（我的倾向）；B. 允许下一次 owner 的 `task done` 同时恢复。取舍：A 更保守，B 少一个人工维护动作但更容易误判。
2. 禁用验证项：A. 配置显式 `allow_disabled=true` 才能禁用并记录 skipped（我的倾向）；B. 永远不允许禁用。取舍：A 支持仓库阶段性缺少工具，B 更强保证但难以迁移。
3. 验证副作用：A. 命令必须自清理/写系统临时目录，dirty 就失败（我的倾向）；B. CLI 维护允许输出路径并在成功后自动还原。取舍：A 保持 CLI 不成为清理器，B 更方便但会隐藏命令副作用。
4. `contracts_changed` 的旧/新字段：A. 保持自由文本并只强校验 `paths`（我的倾向）；B. 再定义结构化 schema（例如每项 name/type/breaking）。取舍：A 兼容现有 handoff，B 便于机器展示但扩大 M2 schema。
5. 普通 merge 的 target 输入：A. 沿用现有 `--commit`，把它解释为目标 commit（我的倾向）；B. 新增 `--target` 并保留 `--commit` 表示 lane 验证 HEAD。取舍：A 改动面小，B 语义更直白但需要兼容两个参数和旧脚本。
