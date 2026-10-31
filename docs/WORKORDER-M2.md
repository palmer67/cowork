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
verifying --doctor --fix（确认原验证进程已退出）--> reported_done
```

`reported_done -> verifying` 在 `task done` 的第一次短锁临界区内完成，命令随后在锁外运行验证。配置错误、owner/claim 不匹配为一般错误，退出 `1`，状态保持 `reported_done`；验证命令 spawn 失败时按 §3 在第二次短锁中恢复为 `reported_done`，不把未执行伪装成验证失败。

`verifying -> verify_failed` 表示验证确实开始但没有得到合格结果：命令非零、超时、输出不可记录、worktree dirty 或验证前后 HEAD 不一致，退出 `1`，保留 lease 和全部 touches claim。

`verifying -> awaiting_merge` 只有所有启用检查退出 `0`、工作树仍干净且 HEAD 未变，退出 `0`。`awaiting_merge -> merged` 由人执行 `confirm-merge`，成功退出 `0` 并释放 lease/claims。

转移/拒绝码表：

| 请求或结果 | 状态变化 | 退出码 |
| --- | --- | --- |
| owner 的 `task done`: reported_done → verifying，随后全部通过 | awaiting_merge | `0` |
| `task done` 命中 `in_progress`、`merged` 或 `cancelled` | 状态不变；说明当前状态及允许的后续操作 | `1` |
| `task done` 在 `verifying` 中重复调用 | 状态不变；提示正在验证中，不新增 verification 记录 | `2` |
| `confirm-merge` 命中 `reported_done` | 状态不变；提示“尚未验证，请先 `task done`” | `1` |
| 初始 dirty、配置无效或 executable 启动失败 | 保持 reported_done | `1` |
| owner/lease 冲突或第二次锁发现 run_id/status 已被替换 | 保持当前状态 | `2` |
| 任一验证失败、超时、验证中 dirty 或 HEAD 漂移 | verify_failed | `1` |
| `doctor --fix` 确认 verifying 的原验证进程已退出或验证未启动并恢复 | reported_done | `0`；仅提示、无法确认不转移且退出 `0` |
| 普通 merge 校验通过并记录人工确认 | merged | `0` |
| target 不存在/祖先不成立/manual reason 缺失或其他非法状态转移 | 状态不变 | `1` |
| 实际 Git merge 冲突 | awaiting_merge 不变 | `2` |
| git-common-dir 或 lane 环境不可用 | 状态不变 | `3` |

除表中明确的并发冲突外，未允许的状态转移统一拒绝，退出 `1` 并说明当前状态和允许的做法；owner/并发版本冲突属于 `2`，环境缺失属于 `3`。任何拒绝均不得局部写入状态或释放 claim。

验证进程崩溃时唯一恢复入口是 `doctor --fix`：live 记录保存 `verification.pid`、`verification.host`、`verification.pid_started_at`、`started_at` 和 `run_id`。取得任意 PID 启动时间只能在 mutex 外通过 `execFile` 调用 `wmic` 或 PowerShell，必须 `shell:false`，不得拼 shell 字符串；取不到时 `pid_started_at=null`，错误写入 verification 诊断字段，但不能让 `task done` 失败。PID 不存在时可确认原进程已退出并恢复；PID 仍存在时，只有取得启动时间且与记录明确不同（确认 PID 已复用）才可恢复，匹配原启动时间则不恢复。PID 仍存在但启动时间为 null、host 不同、字段损坏或其他情况无法确认时，不自动改状态，只输出提示。恢复时保留 owner、lease、claims 和历史，并在 live 的 `recovery` 字段记录恢复时间、原 `run_id` 和判定依据。`stale` 只在恢复瞬间使用；恢复后任务状态为 `reported_done`，历史和 `recovery` 留档。普通 `doctor` 不改变状态。

`doctor --fix` 也负责收尾未真正启动的验证：`verifying` 记录的 `pid=null` 或 `pid` 等于 CLI 自身 PID 时，恢复为 `reported_done` 并在 `recovery` 写明“验证未启动”；spawn 已成功且 PID 为验证子进程时才按进程启动时间规则判断。普通 `doctor` 对按状态进入时间（live history/updated_at）停留超过 24 小时的 `reported_done` 只输出非错误“未验证”提示，不改状态、不影响退出码。

被否决的备选：

- 让下一次 `task done` 或 `next` 自动清理 verifying。否决：普通任务命令不应猜测一次验证是否仍在跑，会把长测试误判为崩溃。
- 让 doctor 无条件把 verifying 改回 reported_done。否决：无法区分慢测试与崩溃，破坏验证记录的可信度。

### 2. 验证配置

选择 `.cowork/config.json` 增加 `verification` 对象，命令是参数数组。每次验证都必须在 mutex 外从 trunk 提交读取配置：先确定 trunk ref 对应的 commit SHA，再执行等价于 `git show <trunk-sha>:.cowork/config.json` 的读取；验证命令、超时和 `env_allowlist` 均只使用该提交中的内容，不读取任何工作树版本（包括 assigned lane 的已提交、暂存或未提交版本）。将该 SHA 写入本次 `verification.config_commit`，并在面板与 `brief` 中展示，保证验证配置可追溯。配置中 `verification` 以外的顶层键允许存在；`verification` 缺失、形状错误或字段非法时，退出 `1` 并给出可读说明，不启动验证。

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

schema 规则：`commands` 非空数组；每项 `name` 唯一且为短标识，`argv` 非空字符串数组，第一项是可执行文件，`timeout_ms` 为 1..3,600,000 的整数，`enabled` 为布尔值。`allow_disabled=false` 时所有项必须 enabled；只有显式设为 `true` 才允许禁用单项，禁用项写入 verification 记录并显示为 skipped，不能悄悄消失。至少保留一项 enabled 命令。

执行使用 `execFile(argv[0], argv.slice(1), { cwd, shell: false })`，不拼接 shell 字符串，也不从配置读取 shell。配置中的 executable 必须是可直接执行的程序；Windows 的 `.cmd`/`.bat` 包装器不允许作为 argv[0]，示例通过 `node.exe` 直接运行 Node 测试 runner 与 TypeScript 编译器入口，避免平台 shell 差异。`cwd` 固定为任务 `assigned_lane` 对应的 worktree 根；lane 缺失、worktree 不存在或不等于 lease 记录的路径时拒绝执行。环境只继承内置白名单中的现值和当前任务所需的 `COWORK_AGENT_ID`，不继承完整 `process.env`，配置不能扩展白名单或注入 secret。

被否决的备选：

- 允许每个命令写一整条 shell 字符串。否决：引入 quoting、PATH 和命令注入差异，无法满足零 shell 拼接。
- 允许任务 spec 自己覆盖命令、cwd 或环境。否决：验证定义必须由仓库配置和人审查，不能由待验证 agent 改写。

### 3. `cowork task done <id>` 的事务边界

选择短 live 锁包住状态提交，所有 Git 读取与验证命令都在锁外：

1. 锁外读取初始 Git 快照：`git rev-parse <trunk>` 得到 trunk SHA；`git show <trunk-sha>:.cowork/config.json` 读取并校验配置；按同一 trunk SHA 读取 task spec、done_when 和 handoff；再读 `git rev-parse HEAD` 和 `git status --porcelain=v1 -z --untracked-files=all`。初始 dirty、配置无效或 Git 读取失败时，不取锁、不启动验证，退出 `1`，保持 `reported_done`。
2. 第一次取全局 mutex：只读写 live 文件，不 spawn 子进程；使用锁外已加载的 spec/catalog 数据，核对 status=`reported_done`、lane/agent owner、lease/claims、done_when/handoff 及初始 Git 快照的 dirty 结果；生成 `run_id`，写入 `verifying` 和验证元数据（含 `head_before`、trunk `config_commit`），初始 `verification.pid=null`，然后释放锁。锁内不运行 Git。
3. 锁外按 trunk 配置顺序执行所有 enabled 命令。每项记录退出码、超时、duration 和摘要；一项失败后停止后续项，保留已执行记录。`execFile` 成功 spawn 后，在锁外获取验证子进程 PID 与启动时间；获取启动时间失败只记录诊断。随后以只操作 live 的短锁写入子进程 PID、启动时间或 null 与错误字段；锁内不运行 Git，也不 spawn 任何子进程。

4. 所有命令结束后，在第二次取锁前再次锁外读取 Git 快照（trunk SHA、trunk config、HEAD、porcelain status）。第二次取全局 mutex 后，只读写 live 文件并核对仍是同一 `run_id`、状态仍是 `verifying`、owner/lease/claims 未变。若命令未成功 spawn，按下文恢复为 `reported_done`；对已启动的验证，若两次 HEAD 不一致、第二次 snapshot dirty，或 trunk SHA/config commit 改变，一律写 `verify_failed`，退出 `1` 并保留 lease/claims；只有两次 HEAD 一致、第二次工作树干净、配置 commit 未变且每项成功，才写 `awaiting_merge`。锁内不运行 Git，也不 spawn 任何子进程。

两次短锁各由一段紧邻的锁外 Git 读取准备；锁内只做 live 读写和状态判定。初始 Git 快照到第一次拿锁之间，HEAD 或 dirty 可能变化；第二次锁外快照用于比较并失败关闭。只要两次 HEAD 不等或第二次读到 dirty 就拒绝放行：宁可误判失败，不可误判通过。读取完成后到取得对应短锁之间发生的变化同样按上述比较条件处理；不覆盖新提交，也不释放占位。若第二次取锁发现状态或 run_id 已被其他命令改变，退出 `2` 并保留当前 live，不作盲写。

验证命令 spawn 失败时，第二次短锁把状态恢复为 `reported_done`，令 `verification.status=failed`、summary 包含启动失败原因，并在 records 记录 `exit=null`、`error="spawn"`；这是未执行验证，不进入 `verify_failed`。若第二次锁也无法取得，保留现场，由 `doctor --fix` 将 `pid=null` 或 `pid` 等于 CLI 自身 PID 的 verifying 识别为未真正启动并恢复。

dirty 判定使用 `git status --porcelain=v1 -z --untracked-files=all`；暂存、未暂存、删除、重命名、未跟踪都算 dirty，忽略文件不算。初始 dirty 直接拒绝 `task done` 并退出 `1`，保持 `reported_done`；验证中第二次快照出现 dirty 进入 `verify_failed`。

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
  "pid_started_at": "2026-11-01T09:59:59.000Z",
  "pid_start_error": null,
  "started_at": "2026-11-01T10:00:00.000Z",
  "finished_at": null,
  "head_before": "<sha>",
  "head_after": null,
  "config_commit": "<trunk-sha>",
  "summary": "",
  "records": [
    { "name": "test", "argv": ["node", "--experimental-strip-types", "--test"], "exit": 0, "timed_out": false, "duration_ms": 1200, "head": "<sha>", "summary": "132 pass", "at": "..." }
  ]
}
```

`summary` 必须是截断后的 stdout/stderr 摘要，最多 2 KiB；保留末尾内容以便看到失败原因，完整输出留在 CLI 当次结果，不写入 live。无法取得 PID 启动时间时 `pid_started_at=null`，`pid_start_error` 保存诊断，不能因此让 `task done` 失败。spawn 失败对应 `reported_done` 且 `verification.status=failed`，record 写 `exit=null`、`error="spawn"`；实际验证失败对应 `verify_failed`，通过对应 `awaiting_merge`。`stale` 只在 doctor 恢复 verifying 的瞬间使用；恢复后任务状态转为 `reported_done`，`recovery` 和 verification 历史留档。

面板任务列显示 verifying、最近检查名、exit、耗时和短摘要；running 显示“验证中”，失败显示失败命令及“保留占位”，PID 启动时间不可得时可查看 `pid_start_error` 诊断。`reported_done` 在面板和 `brief` 明确显示“未验证”；`brief` 同时显示本 lane verification 状态/最近结果，`next` 在领取输出中提示依赖任务正在验证或验证失败，不能把 verifying/verify_failed 当作 merged 依赖满足。

被否决的备选：只把最终状态写成字符串。否决：无法解释哪一项检查失败、耗时多少或验证是否因崩溃卡住。

### 5. `confirm-merge` 强化

`confirm-merge` 只接受 `awaiting_merge`。从 `reported_done` 调用时退出 `1`、状态不变，明确提示“尚未验证，请先 `task done`”；`reported_done` 不能直接合并。沿用 `confirm-merge <id> --commit <target>` 接口，把 `--commit` 解释为目标分支当前确认的 commit。普通 merge：先解析 target 与 `verify_head`，执行 `git merge-base --is-ancestor <verify_head> <target>`；成功才允许 merged。target 不存在、不是 commit、祖先判定不成立，退出 `1`，状态保持 `awaiting_merge`，不释放 claim。

目标是 squash/cherry-pick 等不包含 `verify_head` 祖先关系的历史时，必须显式 `--manual --reason "..."`；缺任一参数退出 `1`、状态保持不变。人工确认只记录 target SHA、reason、操作者和时间，不伪造自动等价证明。Git 冲突或目标读取环境错误按现有语义退出 `2`/`3`，同样不改状态。

被否决的备选：用树快照或 patch 文本自动猜测 squash 等价。否决：这不是通用可证明的合并判定，容易把遗漏改动标为 merged。

### 6. `contracts_alerts`

裁定采纳 A：把 handoff front matter 的 `contracts_changed` 定义为对象数组，每个对象只对 `paths` 做强校验，其他字段用于展示：

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

验证配置必须取自 trunk commit 的 `.cowork/config.json`；任何 lane 工作树版本均不参与验证配置读取。配置允许其他顶层键，但 `verification` 缺失或形状错误时退出 `1`。配置对象含 `allow_disabled: boolean`、非空 `commands: VerificationCommand[]`、固定的 `env_allowlist: string[]`。每个命令包含唯一 `name`、非空 `argv: string[]`、有界 `timeout_ms` 和 `enabled: boolean`；至少一个命令启用。执行记录包含命令名、原始 argv、exit、`timed_out`、duration、head、摘要与时间；verification 记录包含 `config_commit`。

task live 的可空 `verification` 记录含 `run_id`、`status`、`pid`、`host`、可空 `pid_started_at`、可空 `pid_start_error`、`started_at`、`finished_at`、`head_before`、`head_after`、`config_commit`、summary 和 records；snapshot 对任务投影同一字段，不重算或丢弃历史。每条 record 含命令名、argv、exit、`timed_out`、duration、head、summary 和时间；spawn 失败时 `exit=null` 且 `error="spawn"`。`head_before` 即本次验证绑定的 `verify_head`。live 的 `recovery` 字段记录 doctor 的恢复时间、原 `run_id` 和判定依据。

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

doctor --fix: verifying --(PID 不存在/已复用，或验证未启动)--> reported_done
blocked 可从 ready/claimed/in_progress/reported_done/verifying/verify_failed/awaiting_merge 进入；
blocked -> ready 或 in_progress；ready/blocked -> cancelled。
```

## 事务序列

```text
task done
  ├─ lock 外: trunk SHA/config + HEAD + porcelain snapshot #1
  ├─ lock #1: 只校验并写 live，写 verifying(run_id, pid=null, head_before, config_commit)
  ├─ unlock
  ├─ execFile 命令 1..N（固定 cwd、argv、超时、白名单环境）
  ├─ lock 外: trunk SHA/config + HEAD + porcelain snapshot #2
  ├─ lock #2: 只校验并写 live；按两次 snapshot 结果写 reported_done/verify_failed/awaiting_merge
  └─ unlock，返回 1 或 0

doctor --fix
  ├─ lock #1: 读取 verifying 的 pid/host/pid_started_at/run_id
  ├─ unlock
  ├─ lock 外: 检查 PID/启动时间（execFile 调用系统工具；取不到只提示）
  ├─ lock #2: 复核 run_id/status；确认退出或未启动才恢复为 reported_done
  │            保留 lease/claims，写 live.recovery
  └─ unlock
```

## 验收清单

每条都可由临时 Git 仓库、两个 lane 和白名单命令脚本执行：

1. `reported_done` 执行 `task done` 后进入 verifying；验证期间另一个 lane 的 `next` 不能抢同一任务或其 touches。
2. 任一验证命令退出非零时，`task done` 退出 `1`，状态为 `verify_failed`，lease 和全部 claims 仍存在。
3. 验证后修改 lane HEAD，再让命令返回 `0`，结果必须为 `verify_failed`、退出 `1`，不能进入 awaiting_merge。
4. 验证前制造 tracked/unstaged 或 untracked dirty，`task done` 拒绝执行并退出 `1`，状态保持 `reported_done`。
5. squash 场景不带 `--manual` 或缺 `--reason` 的 `confirm-merge` 退出 `1`，状态仍为 awaiting_merge。
6. `reads` 与其他任务 touches 相交时，`brief`、`next` 和 snapshot 各出现一条结构化契约提醒。
7. 修正/移除冲突 handoff 后重新生成 snapshot，原契约提醒消失，坏 front matter 则进入 diagnostics。
8. 验证进程被杀死且原 PID 不存在时，`doctor --fix` 必须把 verifying 恢复为 reported_done，保留 claim，并在 live `recovery` 记录时间、原 run_id 和依据。
9. PID 仍存在但启动时间不可取得时，`doctor --fix` 必须只提示、不恢复；取启动时间失败不让 `task done` 失败，`pid_started_at=null` 且 verification 保存诊断。
10. snapshot 在 verifying/verify_failed/awaiting_merge 分别显示 verification status、命令记录、exit、duration、head 和 summary。
11. 普通 merge 的 target 不存在或不满足 `is-ancestor` 时退出 `1`、状态和 claims 不变；满足时才 merged 并释放占位。
12. rename、delete 和 `src/foo/**` 的契约/reads 命中与 touches matcher 一致，路径段相邻前缀不误报。
13. 验证命令写入 worktree 后未自清理，结果为 verify_failed；写入系统临时目录且工作树保持 clean 时可进入 awaiting_merge。
14. trunk 配置把命令超时设为 `1000ms`，验证命令运行约 3 秒：对应 record 的 `timed_out=true`，`task done` 退出 `1`，状态为 `verify_failed` 且 claims 保留。
15. 一个 lane 的验证持续 5 秒期间，另一个 lane 的 `cowork next` 和创建唯一新 lane 的 `cowork lane new` 均须在 2 秒内返回；验证执行期间不持有阻塞全局命令的 mutex。
16. task 处于 `verifying` 时重复执行 `task done`，退出 `2`、提示正在验证中，状态不变且不产生第二条 verification 记录。
17. 面板可见 `verifying`、`awaiting_merge`、`verify_failed` 三态；失败态提供一键复制 `cowork task done <id>` 的“重跑验证”命令。
18. 将 trunk 配置的验证命令设为必然失败，并在 lane 中提交把它改成必然通过的 `.cowork/config.json`；执行 `task done` 仍按 trunk 命令运行并进入 `verify_failed`，记录的 `config_commit` 等于该 trunk SHA。
19. `report-done` 后直接调用 `confirm-merge`，退出 `1`、状态仍为 `reported_done` 并提示“尚未验证，请先 `task done`”；`brief` 和面板显示“未验证”，超过 24 小时的 `reported_done` 被 doctor 提示但不改状态。
20. 将 trunk 配置的 `commands[0].argv[0]` 指向不存在的可执行文件，`task done` 退出 `1`、状态恢复为 `reported_done`，`verification.status=failed`、summary 包含启动原因，record 写 `exit=null` 和 `error="spawn"`，不残留 verifying。

## 已裁定问题

本轮五个待裁定问题全部采纳 A：恢复仅由 `doctor --fix` 执行；禁用验证项必须显式设置 `allow_disabled=true` 并记为 skipped；验证命令造成 dirty 即失败且 CLI 不清理；`contracts_changed` 只强校验 `paths`；`confirm-merge` 沿用 `--commit` 表示目标 commit。
