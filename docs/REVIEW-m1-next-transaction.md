# 评审：M1 `next` 事务设计说明（开工前检查点）

> 评审人：dsh-review 车道。评审对象：`.cowork/notes/2026-10-30-m1-next-transaction.md`
> （小东，2026-10-30T22:35）。判据：`docs/WORKORDER-M1.md` §5/§10/§11/§15、
> `docs/ARCHITECTURE-TASKS.md` §4/§6、`docs/ARCHITECTURE.md` §3.1/§3.4。
>
> 评审时的现场：`dsh/m0` 已到 `fb4f8b9`（`feat: make next claim atomic and recoverable`），
> 所以下面每条都对照了「说明怎么写」和「代码怎么实现」，两者不一致的单独指出。

## 结论

**放行（有条件）**：事务骨架、崩溃恢复、回滚、锁内边界都成立，可以继续往下做
（`task` 命令面 / `brief` / `doctor` / snapshot 接线）。
下面 P1–P3 三条必须在跑验收前处理完，P4–P5 两条必须在 `docs/DECISIONS.md` 落一条记录，
否则本轮不算闭环。P1 是**文档与实现相反**，不改会把后续读者带进坑里。

## 先说对上号的部分（不用改）

| 说明条目 | 判定 | 证据 |
|---|---|---|
| intent 独立文件、phase 只有 pending/committed | ✓ | `src/tasknext.ts:164-183`（tmp+rename 写/删） |
| 先写 intent 再写 lease，崩溃可判进度 | ✓ | `src/tasknext.ts:487-500`；§5.5 顺序一致 |
| 恢复在取锁后、任何读写之前 | ✓ | `src/taskops.ts:106-113`（`withTaskLock` 先 `recoverIntents`）；`src/tasknext.ts:398` |
| pending 回滚 / committed 核对，缺一即 corrupt 并 fail closed | ✓ | `src/tasknext.ts:185-241`、`242-276` |
| 锁外 C 只用于区分退出码，锁内 C′ 才决定领取 | ✓ | `src/tasknext.ts:396`（C）、`402-403`（C′） |
| 冲突判定 = 未过期 claims ∪ held lease | ✓ | `src/tasknext.ts:80`、`344-356`（解决「claim 先过期、lease 还在」的洞） |
| FIFO（created_at, id） | ✓ | `src/tasknext.ts:316-321`；§15.1 |
| 锁内不跑 git | ✓ | `acquire()` 内只有 `readTaskLive`/`transitionTask`/`writeClaim` |
| 锁内二次确认状态仍为 ready，否则 exit 2 | ✓（超出说明的加固） | `src/tasknext.ts:440-446` |
| 半成品 intent 能回滚后重领 | ✓（有单测） | `test/tasknext.test.ts:213` |

## P1（必须改，文档）：候选集定义写反了

说明第 2 条写「候选 = **live 缺失或** `ready`」。实现不是这样：

```
$ grep -n "statusOf" src/tasknext.ts
313:  const statusOf = (id: string): string => world.lives.get(id)?.status ?? 'draft';
316:    .filter((spec) => statusOf(spec.id) === 'ready')
```

live 缺失一律按 `draft`，不可领。**实现是对的，文档是错的**，必须改成：

> 候选 = live **存在且** `status === 'ready'`；live 缺失一律按 `draft`（不可领）；
> live 损坏不得当作缺失或可领，按 corrupt fail closed。

理由（为什么这不是措辞问题）：照文档字面实现，等于「删掉 `live` 文件就能让任何
`blocked`/`cancelled` 任务重新变成可领取」——那正是 §9「绝不把读不出来的任务当成『没有任务』」
的反面，也绕过了 §12.5 的 ready 门（`task ready` 是唯一把 draft 推进到可领取状态的写者）。
这条也是 §3 状态机与 §5.1 的交点，写错一次，后面 `brief`/`doctor` 会照着错的语义写。

## P2（必须定，规则）：corrupt 用哪个退出码

三处说法不一致：说明第 6 条写 `exit 1`；工作令 §5.6 写「exit 3 或 1」；§10 表格写
「live 状态损坏需人工 → 3」。实现选了 1：

```
$ sed -n '52,57p' src/taskstore.ts
function corruptFile(file: string, detail: string): Error {
  return general(
    `任务状态文件损坏: ${file}（${detail}）`,
```

**裁定：统一 `exit 1`**，并把 §10 表格里「live 状态损坏需人工」从 `3` 挪出去。理由：

1. `AGENTS.md` 把 `3` 定义为「环境不满足」，live 数据损坏是数据问题，不是环境；
2. §9 已经规定 doctor 对同一情形退 `1`，同一种病不该有两种码；
3. §5.6 明确写了「3 或 1」，1 在授权范围内。

代价要说清：1 与「无候选」撞码，只能靠消息区分。因此强制要求消息里**必须**出现
`任务状态文件损坏: <文件>`，不许退化成「没有可领取的任务」。这一条要在
`docs/DECISIONS.md` 留档，并同步改 §10 表格那一行。

## P3（必须定，规则）：`C′` 空、`C` 非空，但没有「赢家」时的退出码

说明第 8 条写「C′ 空且 C 非空 → exit 2，打印赢家」。但「被别人消耗」有两种：
任务被另一个 lane 领走（有赢家 task），或 touches 被别人手工 `claim`（**没有**赢家 task）。
实现在第二种情况下退 1：

```
$ sed -n '405,424p' src/tasknext.ts
      if (after.tasks.length === 0) {
        const winner = pickWinner(before, world);
        if (winner !== null) {
          ... throw busy(...)          // ← 有赢家：exit 2
        }
        const detail = ...;
        throw general(...)             // ← 无赢家：exit 1
```

**裁定：保持实现，改工作令 §5.4 的措辞**：

> C′ 空且 C 非空，且 C 里的任务已被别人领取 → `2`，打印赢家 task/lane/agent/时间；
> 只是 touches 被别人 claim 占住 → `1`，打印占用路径与占用者（与 §12.3 同语义）。

理由：§12.3 已经规定「先占位、后 next」退 1。同一种病在锁内发现就退 2，会让 agent 把
「该等别人 release」误读成「重跑一次就好」——这恰好是 exit 2/1 区分要解决的问题。
改 §5.4 一行，不改代码。

## P4（必须记档，不阻塞）：锁外读 live/claims 是 §3.1 的例外

`ARCHITECTURE.md` §3.1 要求「所有 live 状态读取必须持锁，不做无锁快照」。
§5.1 为了「全程不阻塞别人」引入了锁外读（`src/tasknext.ts:396` 的 `readWorld`）。

裁定：这是**有界例外**，允许，但必须满足三个约束并写进 `DECISIONS.md`：
C 只用于挑退出码与打印原因；任何写决策只用锁内 C′；C 读到的坏 live 不得被跳过。
（第三点在实现上是 fail closed——`readTaskLive` 坏 JSON 会抛错——行为正确，但要写进文档，
否则下一个人会「顺手」加个 try/catch 把坏 live 跳过，那就成了静默吞数据。）

## P5（必须记档，不阻塞）：`next` 不重验 trunk 是否移动

§5.3 规定「用同一个 trunk commit 重算 C′」，而协议 §4 要求「取锁后确认 catalog ref 未变化，
变了就释放重读」。两者与「锁内不跑 git」结构上互斥，M1 选了前者。

裁定：接受这个降级，但要在 `DECISIONS.md` 记后果与兜底：trunk 在锁外读之后前移时，
会用旧 spec 领取并写旧 `spec_commit`；由 §9 的「lease 的 spec_commit 与 trunk 漂移」兜底，
且 §1「进入 ready 后不得改写 spec」已把窗口压到很小。

## 建议（不阻塞，改不改都放行）

1. `rollback()` 删 claim 只匹配 `lane/lanePath/agent`（`src/tasknext.ts:185-196`）。
   claim id 是路径哈希，同车道同 agent 的另一任务写同一路径会撞同一个 id。当前不可达
   （`candidates()` 会先排除冲突），但加一行 `record.note === 'task ' + intent.task_id`
   校验几乎零成本，建议加。
2. `verifyCommitted()` 在 live 已是 `merged`/`cancelled` 时直接返回并清 intent
   （`src/tasknext.ts:207`），不核对残留 claims。靠 confirm-merge 已释放 + doctor 兜底，
   可接受，但值得在 doctor 里确认「orphan claim」检查存在。
3. 说明第 19 条只断言「无残留 intent」，漏了 §11 的硬要求「**claims 与 lease 数量一致**，
   没有部分占位」。写测试时补上。
4. §11 的「5 进程 barrier 并发 next」测试目前还没有（`test/` 里没有 spawn 型并发测试），
   这是验收门槛的一部分，排在交付清单里别忘。

## 复现命令

```bash
cd .cowork/lanes/dsh-m0
git log --oneline -3                                  # fb4f8b9 bf99d54 7e9d0bf
grep -n "statusOf" src/tasknext.ts                     # P1：?? 'draft'
sed -n '52,57p' src/taskstore.ts                       # P2：corruptFile → general(1)
sed -n '405,424p' src/tasknext.ts                      # P3：winner 为 null → general
sed -n '100,114p' src/taskops.ts                       # 恢复先于任何读写
grep -n "^test(" test/tasknext.test.ts                 # 8 条，含半成品 intent 回滚
```
