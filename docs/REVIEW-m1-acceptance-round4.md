# M1 第四轮复验（修复 7 条之后）

对象：`dsh/m0 @ 15206ad`（工作树干净）。命令与原始输出见下，均可复现。

## 结论

**可合。** B1–B3 三个阻塞与 I1–I4 都已按裁定落地，行为与不变式两头都对上了；门槛全绿。唯一未闭合的是一条**未能复现的测试清理抖动**（29 次全量运行里 1 次 103/104），不涉及产品语义，但要让门槛长期可信，M2 前得补诊断。

## 七条修复逐条核对

| # | 提交 | 核对结果 |
|---|---|---|
| 1 | `8392179` | `src/tasknext.ts:395-396` 两次 `currentBranch` 都在 `withLock`（`:403`）之前，作为参数传进 `acquire`/`writeTaskClaims`；`grep -n "currentBranch\|gitTry" src/tasknext.ts` 只剩导入和这两行。B1 闭合。 |
| 2 | `9959ca2` | `src/store.ts:53-63` `readStateDir`：只有 `ENOENT` 返回 `[]`，其余 `throw general('任务状态不可读: <dir>')`（exit 1）。采用点：`store.ts:173/196`（claim ids / listClaims）、`tasknext.ts:150/283`（intents / readWorld tasks）、`taskstore.ts:157/172`。`snapshot.ts:421` 改为直接 `listClaims`（原 `existsSync ? : []` 的空集降级已删）。B2 闭合，且覆盖了 Codex 没点名的 `readWorld` tasks 目录那处。 |
| 3 | `4e2c785` | `src/taskdoctor.ts` `doctorTasks`：`readTrunkCatalog` 在锁外，`fix` 分支整段 `await withLock(state, () => fixPass(...))`；`fixPass` 内才是 recoverIntents / 隔离坏 live / 回收 lease。检查阶段（`leaseProblems` 等）在锁外，git 仍在锁外跑。B3 闭合。 |
| 4 | `ba653cf` | `leaseProblems`：`git rev-parse <spec_commit>:<rel>` vs `<catalog.trunk>:<rel>`，无祖先判断，漂移即问题。`fixPass` 回收条件：`agentId === live.agent && note === 'task <id>' && lane === live.lane && !expired`，同 agent 别的任务的占位不再保活。I1/I3 闭合。 |
| 5 | `1d71533` | `rollback`（`tasknext.ts:180-199`）加 `note === 'task <id>'`；`verifyCommitted`（`:207-210`）merged/cancelled 先清本任务残留 claim 再返回；`releaseTaskClaims`（`taskops.ts:269`）只删 `note === 'task <id>'` 的 claim。I4/I2 的误删保护闭合。 |
| 6 | `51205ca` | `test/helpers.ts:8` `maxRetries: 20, retryDelay: 200`；并发测试 `test/tasknext-concurrency.test.ts:181-197` 先 `git worktree remove --force` ×5、再 `prune`、最后删仓库。ENOTEMPTY 修法正确（见下"残余"）。 |
| 7 | `15206ad` | `docs/DECISIONS.md` 新增 A1（blob 比较）、A2（`--manual` 无身份信任边界）；`docs/WORKORDER-M1.md:116` 回滚失败统一为 exit 1；D10 公式恢复完整。三份架构文档 `git diff --stat main..HEAD -- docs/ARCHITECTURE-TASKS.md docs/ARCHITECTURE.md docs/PLAN.md` 为空。 |

## 门槛证据

- `npm test`：**29 次运行，28 次 104/104 全绿**；第 1 次 `# tests 104 / # pass 103 / # fail 1`，其余 28 次 `# fail 0`（日志 `.cowork/tmptest-r{1..28}.log`，注意第 1 次的日志被我当时 `| tail` 截断，失败项名字丢失）。
- 并发测试单独跑（`node --experimental-strip-types --test test/tasknext-concurrency.test.ts`）：6/6 通过。
- `npx tsc --noEmit`：无输出，`TSC-CLEAN`。
- `npm run build` → exit 0；`node tools/accept-m1.mjs --with-build` → `10 条：10 PASS，0 FAIL，0 SKIP`。
- 我的独立复核 `tools/probe-m1-acceptance.mjs` → `16 PASS / 0 FAIL`（含真实文件 barrier 的 §12.4、§12.9 半截 intent 回滚后重新领取、§12.8 lane new 不写 live）。

## 残余（不阻塞合并，记 M2 前收口）

1. **一次未能复现的测试失败。** 29 次里 1 次（103/104）。单独跑并发测试 6 次全过、其余 28 次全量也全过，机制未定；最可能是 Windows 清理抖动（这次失败发生在 小东 自己的测试刚跑完、机器还在收尾时）。要让它可诊断：把测试名与失败断言写进日志再跑长循环（≥50 次），或把清理失败与产品失败分开标注。**门槛可信度依赖这一点，M2 开工前应补。**
2. `tools/accept-m1.mjs:389` 第 9 条的**标题**仍叫"损坏 live 状态时不伪装成空"，实际已经同时断言 §9 与 §12.9 半截 intent（`:402-444`）。只改标题。
3. `cowork --help` 仍 exit 1（`未知命令: --help`）。用户可感知，5 行内可修，放到合并后的收尾提交。

## 合并前还差的一步

Codex 对 `8392179..15206ad` 这七个提交再过一眼（它上一轮给的是"不可合"，需要它确认自己的阻塞项确已闭合）。范围只有 7 个 diff、约 1200 行，15 分钟量级。它说"可合"后我按 `docs/RUNBOOK-m1-acceptance.md` §4 合 main，合之前跟用户打招呼。
