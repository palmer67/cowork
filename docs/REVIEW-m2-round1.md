# M2 设计稿裁定（第一轮）

裁定对象：`docs/WORKORDER-M2.md`（`dsh/m2-design`，提交 `10df12e`、`105246d`，234 行，纯文档）
裁定人：DSH（判官）  日期：2026-10-31
对照清单：`docs/M2-REVIEW-CRITERIA.md`（我在实现开始前写的判据）

## 结论：**放行（有条件）**

状态机、两次短锁 + 锁外执行、`argv` 数组 + `shell:false`、白名单环境、契约提醒复用同一 matcher、
非目标边界——都跟我写下的四条硬事对上了。可以开始实现，但必须先落 R1–R4 这四条修正，
以及把我列的 5 个缺口补进验收清单。**R1 是安全项，不能让步。**

## 一、四个问题（必须改）

### R1 验证配置必须从 trunk 读，不能从车道读（安全）

设计稿写「`cwd` 固定为任务 `assigned_lane` 对应 worktree 根」，但没说配置从哪读。如果从被验证的
那个车间的 `.cowork/config.json` 读，**被验证方就能顺手把验证命令改弱**（比如把 test 换成 `node -e ""`），
然后自证通过。这是"谁能改考卷"的问题，不是风格问题。

裁定：
- 验证命令、超时、`env_allowlist` 一律从 **trunk 提交里的 `.cowork/config.json`** 读取
  （`git show <trunk>:.cowork/config.json`），不读任何工作树里的未提交版本；
- 配置里出现 `verification` 以外的顶层键不报错，但 `verification` 形状错误必须 `1` 并说明；
- 记录里写下 `config_commit`（读配置时 trunk 的 SHA），面板与 `brief` 可见——这样"用哪份考卷"可追溯。

理由：`spec_commit` 已经证明"任务定义是提交过的"，验证定义没有同等约束，就是一个后门。

### R2 崩溃恢复要防 PID 复用

设计选「本机 + PID 已死」才恢复 `verifying → reported_done`，方向对。但 Windows 的 PID 会被复用：
一个 3 小时前的验证进程 PID 被今天的编辑器占了，doctor 会认为"验证还活着"，任务永久卡住。

裁定（任选其一，实现时写进代码注释说明选择）：
- 记录 `pid_started_at`（能取到时），恢复前比对进程启动时间；取不到就**不恢复**，只提示；
- 或者退一步：`started_at` 超过配置的最大超时（默认 300000ms）+ 一个宽限期后，即使 PID 看起来活着
  也只为「提示」，不自动改状态，并明确告诉人「疑似 PID 复用」。
- 无论哪种，`doctor --fix` 的恢复动作必须写进 live 的 `recovery` 字段（时间、原 run_id、依据）。

### R3 验收清单补五条（现有 12 条不够）

现有 12 条覆盖了主要路径，但漏了我判据里的关键项：

1. **超时**：配置 `timeout_ms: 1000`，命令 `sleep 3` → `verify_failed`，`records[].timed_out = true`，
   退出 `1`，claim 保留。（现在 12 条里没有超时用例。）
2. **不阻塞**：验证命令跑 5 秒期间，另一个 lane 的 `cowork next` 与 `cowork lane new` 必须在 2 秒内返回。
   （现有第 1 条只说"不能抢同一任务"，没证明"全局锁没被占着"。）
3. **重复 done**：任务处于 `verifying` 时再执行 `task done` → 退出 `2`，提示 `正在验证中`，
   不产生第二条 verification 记录。
4. **面板**：`verifying` / `awaiting_merge` / `verify_failed` 三态在面板可见，失败态能一键复制
   「重跑验证」命令；非 owner 看到按钮置灰（沿用 R4 的身份规则）。
5. **config 篡改**：在车间的 `.cowork/config.json` 里把 test 改成必然通过的命令并提交，
   再 `task done` → 必须仍按 trunk 的配置执行（R1 的可执行证明）。

### R4 `task done` 在非 `reported_done` 状态下的返回码要写死

转移表只列了 `reported_done → verifying`，没说 `task done` 打到别的状态（`in_progress`、`merged`、
`cancelled`）时返回什么。裁定：一律 `1`，消息包含"当前状态 + 允许的做法"；只有 `verifying` 中的重复
调用是 `2`（并发冲突语义）。写进 §1 的转移表，不要留给实现现场发挥。

## 二、五个待裁定问题的回答

全部采纳它的 A 选项，理由如下：

| # | 问题 | 裁定 | 理由 |
|---|---|---|---|
| 1 | 崩溃恢复由谁做 | **A：只 `doctor --fix`** | 普通命令猜不出"慢测试"还是"进程死了"；误判会把正在跑的验证推回，证据链断掉 |
| 2 | 是否允许禁用验证项 | **A：显式 `allow_disabled=true`** | 允许阶段性缺工具（比如没装 tsc 的车道），但禁用项必须写进 `verification.records` 显示为 skipped，不能悄悄消失 |
| 3 | 验证命令的副作用 | **A：dirty 即失败** | CLI 一旦开始替人清理，就会掩盖"测试偷偷改文件"这类真问题；保持 CLI 不做清理器 |
| 4 | `contracts_changed` 的 old/new | **A：只强校验 `paths`** | 现有 handoff 已经是自由文本，M2 不该借机扩 schema；展示字段坏掉只进 diagnostics |
| 5 | `confirm-merge` 的目标参数 | **A：沿用 `--commit`** | 少一个参数、少一套兼容分支；语义在新文档里写清楚即可 |

## 三、设计稿做得好的三处（不是客套，是给实现定的锚）

1. **`verify_failed` 保留 lease 和全部 claims**——这个选择让"改完再验"不需要重新抢文件，
   也防止别人趁验证失败抢走车道。跟 §6 的"只跑绿测试不等于合并完成"一致。
2. **`run_id` + 第二次取锁复核**——解决了我判据里"两次锁之间状态被别的进程改掉"的问题；
   设计明确写了"发现 run_id 被替换就退出 2 且不盲写"，这是对的。
3. **移动/删除用 porcelain 的新旧路径对**——rename 两侧任一命中都算，删掉的文件仍参与匹配。
   这一点很多实现会漏，漏了就会出现"契约变更后读方收不到提醒"。

## 四、实现时的纪律（复述一遍，避免走样）

- 不做 `git merge`、不 push、不启动任何 agent；
- 验证只在 `assigned_lane` 的 worktree 根跑，`cwd` 用 `realpath` 校验在仓库内；
- `execFile` 只接受 `argv[0]` 为可直接执行的程序，**拒绝 `.cmd`/`.bat`/shell 字符串**；
- 验证前后都要 `git status --porcelain -z --untracked-files=all`，忽略文件不算 dirty；
- 任何拒绝都不能局部写状态，也不能释放 claim；崩溃中断的现场由 `doctor` 收尾。

## 五、下一步

1. 把 R1–R4 与 R3 的五条验收并入 `docs/WORKORDER-M2.md`（它自己改，我不替它写实现细节）；
2. 我复看修订版，确认无歧义后发实现许可；
3. 实现完成后按 `docs/M2-REVIEW-CRITERIA.md` §三 的 24 条探针逐条验收，其中 P8/P11/P14/P17 由
   我自己的 `tools/probe-m2.mjs` 覆盖，不用它的验收脚本。

## 附：同批合并的 `dsh/nits`

`8f313c6 fix: clean stale mutex artifacts in doctor` 单独验过并合入 main：
`npm test` 134/134、`tsc` 干净、`build` 通过、`accept-m1` 10/10、`accept-panel` 13/13。
代码复核：`staleArtifacts()` 只读 `state` 顶层与 `trash/`，`ENOENT` 返回空、其他读错不动状态；
`fixPass()` 在锁内删除；`notices` 与 `problems` 分开，因此不影响退出码——符合我要求的"提示不弄红 CI"。
