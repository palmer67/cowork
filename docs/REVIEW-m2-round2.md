# M2 工单复审（第二轮）

对象：`dsh/m2-design` @ `31d9b85`（`docs/WORKORDER-M2.md`，234 → 249 行）
判据：`docs/M2-REVIEW-CRITERIA.md` + 第一轮裁定 `docs/REVIEW-m2-round1.md`
结论：**放行（有条件），还剩 4 条小的必改项**。改完即可发实现许可。

## 一、已确认落地

| 裁定 | 位置 | 结论 |
| --- | --- | --- |
| R1 trunk 配置 | §2 第 2 段：先取 trunk commit SHA，再等价 `git show <sha>:.cowork/config.json`；`config_commit` 写进记录、面板与 brief 展示 | ✅ 到位，且补了"配置缺失/形状错误退出 1、不启动验证" |
| R2 PID 复用 | §1 恢复段：`pid_started_at`；PID 不存在 **或** 启动时间明确不同才恢复；无法比对只提示，写 `live.recovery` | ✅ 到位 |
| R3 五条验收 | §8 第 13–17 条：超时 `timed_out=true`；验证 5 秒期间 `next`/`lane new` 2 秒内返回；verifying 中重复 done = 2 且不新增记录；面板三态 + 复制重跑命令；车内篡改 config 仍按 trunk 执行 | ✅ 到位 |
| R4 转移表 | 表中新增两行：done 命中 in_progress/merged/cancelled → 1；verifying 中 → 2；并改写"未列出转移统一拒绝"的措辞 | ✅ 到位 |
| 五个 A 选项 | §「已裁定问题」 | ✅ 与裁定一致 |

## 二、必须改的 4 条

### R5 锁内不跑 git —— 现文稿与 M1 §5.8 直接冲突

`docs/WORKORDER-M1.md` §5.8：**"锁内不跑 git（协议 §7）：catalog 已在锁外读进内存；锁内只做 live 文件的读写。"**
而本稿 §3 第 1 步写"第一次取全局 mutex：……检查 `git status` 为空；读取 `head_before`"，第 3 步写"第二次取锁：……重新读取 HEAD 和 dirty 状态"，§2 又要求"每次验证都必须从 trunk commit 读取配置"——三处都要在锁内起 git 子进程。这正是 M1 里 Codex 判我不可合的 B1（`src/tasknext.ts:468`/`:520` 在 `withLock` 内 `execFileSync('git')`）。

**裁定：保持"锁内不跑 git"不动，把 git 读取全部挪到锁外，用失败关闭（fail-closed）兜住竞态。**

- 两次锁各自紧邻一段**锁外** git 读取：`git rev-parse <trunk>` → `git show <trunk-sha>:.cowork/config.json` → `git rev-parse HEAD` → `git status --porcelain=v1 -z --untracked-files=all`；
- 锁内只做 live 的读写与判定，不 spawn 任何子进程；
- 竞态由第二次锁外读取兜住：若两次读到的 HEAD 不等、或第二次读到 dirty，一律 `verify_failed`（退出 1、保留占位）。**宁可误判失败，不可误判通过**；
- 说明里要写清"读完之后到拿到锁之前，HEAD 可能已变；这只会导致验证失败，不会导致假绿"。

### R6 `pid_started_at` 怎么取 —— 现在无法落地

Node 没有"取任意 PID 启动时间"的内建 API，`process.kill(pid, 0)` 只能判断存活。零运行时依赖 + `shell:false` 的前提下，只能通过系统命令取：`wmic process where processid=<pid> get CreationDate /value`（已废弃但多数机器仍在）或 PowerShell `(Get-Process -Id <pid>).StartTime`，两者都只能 `execFile` 调用、不得拼 shell 字符串。

**裁定：**

- 取不到启动时间时，`pid_started_at` 写 `null`，doctor 一律"只提示、不恢复"（与 §1 的降级语义一致）；
- 验收第 8 条要拆成两半：PID 不存在 → 必恢复；启动时间不可得 → 必**不**恢复只提示。不允许把"取不到"当成"已死"；
- 取时间失败不能让 `task done` 失败（它只是诊断字段），但要写进 `verification` 让面板可解释。

### R7 `report-done` 与 `done` 的并存关系没写

M2 之后 `reported_done --done--> verifying`，但 `report-done` 仍是 in_progress → reported_done 的正常入口。于是存在一条"绕路"：agent 只做 `report-done`、永不 `done`，任务停在 reported_done，谁也不会被验证。

**裁定：保留 M1 语义，但把绕路变成显式可见，不新增行为分叉：**

- `confirm-merge` 只接受 `awaiting_merge`；`reported_done` 直接 confirm-merge → 退出 1，文案写明"尚未验证，请先 `task done`"；
- `brief`、面板对 `reported_done` 显示"未验证"标记；`doctor` 对停留超过 24 小时的 `reported_done` 出**提示**（不是异常，不改状态）；
- 验收补一条：`report-done` 之后直接 `confirm-merge` → 退出 1，状态仍是 reported_done。

### R8 验证进程起不来时的收尾没定义

§3 写了"executable 启动失败"属于"保持 reported_done、退出 1"，但那是在**第一次锁内**写入 `verifying` 之前的判断（R5 之后改为锁外）。真正的 spawn 失败发生在 `verifying` 已写入之后：命令不存在、argv[0] 不是可执行文件、cwd 被删。此时若不回写，任务会永久卡在 `verifying`，而 doctor 只在"进程确认已死"时恢复——进程根本没起来，PID 是 CLI 自己的还是空的？语义不清。

**裁定：**

- spawn 失败必须在**第二次锁内**落为 `reported_done`（不是 `verify_failed`，因为验证根本没执行），`verification.status='failed'` 且 `summary` 写明失败原因，`records` 里记一条 `exit=null`、`error='spawn'`；
- 若连第二次锁都拿不到（异常），保持 `verifying` 并让 doctor 兜底；doctor 对 `pid=null` 或 `pid` 等于 CLI 自身 PID 的 `verifying` 视为"验证未真正启动"，恢复为 `reported_done`；
- 验收补一条：`commands[0].argv[0]` 指向不存在的可执行文件 → `task done` 退出 1、状态 `reported_done`、无残留 `verifying`。

## 三、非阻塞建议

1. 验收 17 要写死结果断言："trunk 配置的命令必然失败 → `verify_failed` 且 `config_commit` 等于 trunk SHA"，否则只断言"按 trunk 执行"无法证伪。
2. §4 的 `summary` 截断规则给个具体上限（例如 2 KB、保留末尾 4 KB 的环形截断），否则实现方各写各的。
3. `verification.status='stale'` 与 `recovery` 字段的关系写一句：`stale` 只在恢复瞬间出现，恢复后 state 转 reported_done、`recovery` 留档。

## 四、发许可条件

R5–R8 四条 + 验收 3 条新增（R7、R8 各一条，验收 8 拆分）落进 `docs/WORKORDER-M2.md` 后，我复看一遍即发实现许可；不需要再跑一轮完整设计评审。
