# M1 第三方代码评审的裁定（Codex `c24629d` → 我）

对象：`.cowork/lanes/codex-review-m1/docs/REVIEW-m1-code.md`（Codex 结论：不可合，B1–B3）。
我的核对对象：`dsh/m0 @ 880ac73`。

## 结论

**不可合，打回。** B1–B3 逐条成立，都是实现问题，不是评审口径问题；I1/I3/I4 我也判为合前应改（比 Codex 的"应改/建议"更严一档），I2 按 ADR 显式信任边界收口。全部是小改。

同时更正我上一轮的话：我说"产品行为已全绿"，指的是**行为验收**（96/96、10/10、16/16 全过），不是说代码层面没有问题。Codex 找的是**不变式**（锁内跑 git、坏状态当空集、doctor 写 live 不取锁），这三类我的验收脚本测不出来——这正是"实现者不评、作者不评、第三方评"要补的位。这一轮之前的结论不撤销，只补充。

## 逐条核对

### B1 锁内跑 git —— 成立（阻塞）

`src/tasknext.ts:395` 的 `withLock(state, async () => {` 一直包到事务结束；其回调内：

- `src/tasknext.ts:468` `branch: currentBranch(info.laneTop)`
- `src/tasknext.ts:520` `const branch = currentBranch(lanePath);`

`currentBranch` 走 `src/git.ts:19` `execFileSync('git', ...)`。违反 `docs/WORKORDER-M1.md` §5.8「锁内不跑 git」和 `docs/ARCHITECTURE-TASKS.md` §7 的短临界区。Codex 的"shim 睡眠法"不必要：只要在 `withLock` 回调内设断点，就能看到锁目录存在期间有 git 子进程启动。

修法（机械的）：在 `:395` 之前算好两条分支（`info.laneTop` 的、`lanePath` 的），作为参数传进 `next()` 的回调和 `writeTaskClaims`。不改事务语义。

### B2 不可读的 claims/tasks 被降级为空集 —— 成立（阻塞），且比 Codex 说的更严重

- `src/store.ts:174-176`：`if (!existsSync(dir)) return [];` —— 目录存在但不可读（Windows ACL / junction 拒绝）时 `existsSync` 返回 false，claims 被当空集，`next` 可能放行一个已有占位的路径。
- `src/tasknext.ts:279-283`：**这一处 Codex 没点名但更危险**

  ```ts
  try { names = readdirSync(path.join(state, 'tasks')); } catch { names = []; }
  ```

  tasks 目录读不出来 = 一个任务都没有 = `next` 说"没有可领的任务"（exit 1），而 §9 原文是「绝不把读不出来的任务当成没有任务」。这一条同时推翻我 P4 里"坏 live 不会被跳过"的前提。
- `src/snapshot.ts:421-428` 同一模式（锁内 `existsSync(state) ? listClaims(state) : []`）。

修法：不是加一行判断，而是把"读不出来"当成 exit 1 的显式错误（`任务状态不可读: <目录>`），与坏 live 同等处理；`claimsDir` 不存在（从未有过占位）仍是合法的空集，所以要用 `statSync` 区分"不存在"和"存在但不可读"。

### B3 `doctor --fix` 写 live 不取全局锁 —— 成立（阻塞）

`src/cli.ts:436` `const tasks = await doctorTasks(info, fix);` 不在任何 `withLock` 内；`src/taskdoctor.ts:84-149` 在 `fix === true` 时直接 `recoverIntents()`（`:90`）、`renameSync` 隔离（`:101`）、`writeTaskLive`（`:114-131`）。这破坏"所有 live 写者共用同一把锁"——`next` / `task cancel` / `task ready` 可以同时进。

修法：`readTrunkCatalog(info)`（`:108`、`:136`）本来就在锁外，所以把 doctor 拆成"锁外取 catalog → 锁内做 fix 的三件事 → 锁外做只读检查"即可，不用把 git 拖进锁。

### I1 P5 的祖先检查兜不住"后继提交改写同一 spec" —— 成立（合前应改）

`src/taskdoctor.ts:39-42` 只跑 `merge-base --is-ancestor live.spec_commit catalog.trunk`。只有 force-push / 改写历史会触发；trunk 从 C1 正常前进到 C2 并在 C2 改同一 `.cowork/tasks/<id>.md` 时，C1 仍是祖先，检查通过，而 live 停在 C1，`next` 接着按旧 spec 混用 touches。

**这直接削弱我 P5 的裁定理由**（我当时写"doctor 的 spec_commit 漂移检查兜底"）。ADR A1 我选方案 1：doctor 比较 `git rev-parse <spec_commit>:<path>` 与 `git rev-parse <trunk>:<path>`，不一致 → exit 1 并提示 cancel 后重建。只加一次 git 调用，且 doctor 在锁外跑 git 是允许的。

### I2 `confirm-merge` 无 owner 校验 —— 成立，按显式信任边界收口（ADR A2 方案 1）

`src/taskops.ts:286-318` 不调 `requireOwner`；`releaseTaskClaims`（`:262-268`）按路径哈希直接 `removeClaim`，不核对 `note`/lane/agent。M1 无身份系统，`--manual` 只能表达"调用者声称人工确认"，所以：

- DECISIONS 里把"`--manual` 是无身份的人工信任边界，任何有仓库写权限者可确认"写成显式 ADR；
- 顺手加 `note === 'task ' + id` 的保护（删除 claim 时只删本任务的），避免跨任务误删。

### I3 doctor 回收 lease 的判据过宽 —— 成立（合前应改，会成为永久卡死）

`src/taskdoctor.ts:112` `claims.some((claim) => claim.agentId === live.agent && !isExpired(claim))`。同一 agent 在另一任务上的有效 claim 会掩盖当前任务的孤儿 lease → 任务永久停在 `claimed`，`next` 永远当它被占着。判据应至少加 `claim.note === 'task ' + live.id` 与 lane 匹配。

### I4 `verifyCommitted()` 对 merged/cancelled 直接清 intent —— 成立（合前应改）

`src/tasknext.ts:207` `if (live.status === 'merged' || live.status === 'cancelled') return;`，`recoverIntents()` 随后删 intent，不核对 `intent.claim_ids` 是否残留。修法：这条早退前先检查该 intent 的 claims 是否存在，存在则删（`note` 校验），再返回。

### S1/S2 —— 接受

S1 补 `record.note === 'task ' + intent.task_id`（我上一轮已提过，仍未做）。S2 与协议一致：只读命令不取锁、不恢复 intent；把验收措辞固定为"任意**取锁**命令自动恢复"。

### ENOTEMPTY

`test/helpers.ts:8` 实际是 `maxRetries: 10, retryDelay: 100`（≈1 秒），不是 §11 写的 20×200ms。Codex 在临时仓库清理阶段撞上了它——这是**门槛本身在抖**：`npm test` 的退出码不可信。修法：对齐 §11 的 20×200ms，并在删目录前 best-effort `git worktree prune`（并发测试会建 5 条 worktree，git 收尾慢是主因）。

## 给小东的修复清单（按提交拆）

1. `fix: 把分支读取移出 next 临界区`（B1）
2. `fix: 状态目录不可读时 fail closed`（B2，含 store/tasknext/snapshot 三处）
3. `fix: doctor --fix 在全局锁内写 live`（B3，拆 catalog/锁内/锁外）
4. `fix: doctor 回收 lease 与 spec 漂移判据收紧`（I3 + I1/A1）
5. `fix: committed intent 清残留 claim；confirm-merge 只释放本任务 claim`（I4 + I2 的 note 保护 + S1）
6. `test: 临时仓库清理对齐 20×200ms 并 prune worktree`（ENOTEMPTY）
7. `docs: DECISIONS 记录 A2 信任边界与 A1 的 spec blob 比较`（+ §5.6 的 exit 3 或 1 收成 1）

## 合的前提（更新）

- 上述 1–7 落地；
- `npm test` 连续 3 次 96/96（验证 ENOTEMPTY 不再抖）、`npx tsc --noEmit` 静默、`node tools/accept-m1.mjs --with-build` 10/10、我的 `tools/probe-m1-acceptance.mjs` 16/16；
- Codex 对 diff 再给一次"可合"（只看 1–6 的改动，约 15 分钟）；
- 然后按 `docs/RUNBOOK-m1-acceptance.md` §4 合 main，合之前我说一声。
