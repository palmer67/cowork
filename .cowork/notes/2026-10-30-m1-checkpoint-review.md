---
{"schemaVersion":1,"id":"2026-10-30T22-55-00Z-dsh-review-m1-checkpoint","createdAt":"2026-10-30T22:55:00+08:00","lane":"dsh/review","task":"M1 检查点评审：next 事务设计 + 验收脚本","status":"ready","files":["docs/REVIEW-m1-next-transaction.md","docs/REVIEW-accept-m1.md"],"contracts":[],"next":"小东按 P1/P3 与缺口 A-E 改；P2/P4/P5 记 DECISIONS；改完我跑验收","base":"dsh/m0@fb4f8b9"}
---

## Summary

接手 M1 的验收人角色后做了三件不必等实现的事：判 `next` 事务设计、对验收脚本做逐条缺口分析、
查越界。结论已落到 `docs/REVIEW-m1-next-transaction.md` 与 `docs/REVIEW-accept-m1.md`。

- **设计**：放行（有条件）。事务骨架、恢复、回滚、锁内边界都对；但说明第 2 条的候选集定义
  与实现相反（实现按 `live 缺失 → draft`，文档写成「live 缺失或 ready」），照文档实现会让
  删掉 live 就等于复活任务。
- **验收脚本**：10 条里 4 条与 §12 不等价（§12.3 的 agent 断言用单字符 `includes('a')` 恒真；
  §12.4 不查赢家 lane 且无真 barrier；§12.8 不查「不写 live」；§12.9 验的是损坏 live 而不是
  半成品 intent），§12.10 默认 SKIP。
- **越界**：没有。`M2_STATUSES` 只作为拒绝用的守卫（`src/tasks.ts:36`），没有自动合并、
  没有 `verifying` 实现、没有改 `ARCHITECTURE-TASKS.md`。三个提交的文件面都在 §14 的分组内。

## Decisions

1. corrupt 统一 `exit 1`（不是 §10 表格的 3）：数据损坏不是「环境不满足」，且 §9 的 doctor
   对同一情形已是 1。代价是 1 与「无候选」撞码，所以强制消息含 `任务状态文件损坏: <文件>`。
2. `C′` 空、`C` 非空、但没有任务赢家（只是 touches 被手工 claim）→ 退 1，不套用 §5.4 的 2。
   改工作令 §5.4 一行，不改代码。
3. 锁外读 live 是 §3.1 的有界例外，必须在 DECISIONS 记档（C 不得用于写决策、坏 live 不得跳过）。
4. `next` 不重验 trunk 移动，接受，由 doctor 的「spec_commit 漂移」兜底，记档。

## Risks

- 第 1 条若不改文档，后续 `brief`/`doctor` 会照错的语义写，且评审时看不出分歧从哪来。
- 验收跑绿之前，缺口 A–E 里的任意一条都会让「绿」不可信；尤其 §12.9 现在**没有被脚本证明**。

## Validation

复现命令见两份评审文档末尾。本次未跑 `npm test`/`npm run build`：小东仍在提交（`fb4f8b9`
之后仍在改 `src/cli.ts`、`src/taskops.ts`），在他的车道里跑构建会互相干扰，且我这一轮
本来就不该跑验收。
