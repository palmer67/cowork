# 复核：M1 第三轮（补齐后复验）

> 复核人：dsh-review。对象：`dsh/m0@880ac73`（新增 4c525e6 / 686fca9 / 880ac73）。
> 方式同前两轮：不看自报，全量复跑 + 读改动 + 跑我自己的 16 项探针。

## 结论

**四项门槛全部补齐，行为与验收都已独立验证通过。** 只剩工作令 §5.6 一句残留措辞与 §10/DECISIONS P2
不一致，改一行即可放行合并。

## 一、我复跑的（证据）

| 项 | 命令 | 结果 |
|---|---|---|
| 测试 | `npm test` | `# tests 96 / # pass 96 / # fail 0`，exit 0 |
| 类型 | `npx tsc --noEmit` | 无输出，exit 0 |
| 构建 | `npm run build` | exit 0 |
| 官方验收 | `node tools/accept-m1.mjs --with-build` | `10 条：10 PASS，0 FAIL，0 SKIP` |
| 我的探针 | `node ../dsh-review/tools/probe-m1-acceptance.mjs dist/cli.js` | `16 PASS / 0 FAIL` |
| 并发稳定性 | 单跑 `test/tasknext-concurrency.test.ts` 三次 | 3/3 `# pass 1`，无抖动 |
| 工作树 | `git status --short`（两条车道） | 均干净 |

## 二、四处补齐的实读确认（不是看它说，是看代码）

1. **5 进程并发测试**：`test/tasknext-concurrency.test.ts:139` 真 spawn 5 个子进程，各自写 ready
   文件后轮询同一 barrier 文件（`:80-85`），放行后同时 `next()`；断言恰好 1×exit 0、4×exit 2
   （`:170-171`）、intent 为空（`:173`）、`claims.length === touches.length`（`:175`）、
   claims 全归赢家且 `note === 'task <id>'`（`:178-180`）。**在 `npm test` 里跑**（96 = 95+1）。
2. **验收脚本**：`tools/accept-m1.mjs:201` 换成 `agent=(agent-)?a\b` 结构化断言；第 4 条改为
   真 barrier（`:220-262`）并断言输家打印赢家 lane（`:271-274`）+ `claims 数 == touches 数`（`:286-289`）；
   第 8 条前后对整棵 live 根做清单快照（`:370-382`）；第 9 条保留损坏 live，另加真 §12.9
   半截 `phase=pending` intent（`:402-452`）；第 10 条默认执行 `npm test`+`tsc`（`:456-466`），
   `--with-build` 已无跳过分支。
3. **文档**：设计说明第 2 条已改「live 存在且 `status==='ready'`（缺失按 draft，永不可领）」；
   第 8 条补「仅 touches 被手工 claim / held lease 占、无任务赢家 → exit 1」；
   `docs/WORKORDER-M1.md` §5.4 同步该分支；§10 表把损坏 live 挪到 exit 1 并要求消息含
   `任务状态文件损坏: <文件>`。
4. **DECISIONS**：P2（损坏码=1 的语义论证）、P4（锁外读三条约束）、P5（不重验 trunk 的降级
   + doctor 兜底 + M2 若要强一致应把 commit 写进 intent）均已落档，非提纲。
5. **越界**：`git diff --stat main..HEAD` 未含 `docs/ARCHITECTURE-TASKS.md`、`docs/ARCHITECTURE.md`、
   `docs/PLAN.md`；`.cowork/lanes/dsh-review` 未动。

## 三、唯一残留（改一行即可）

`docs/WORKORDER-M1.md` §5.6 仍写「回滚失败标记 `corrupt` 并 fail closed（**exit 3 或 1**）」，
而同文件 §10 表与 DECISIONS P2 已定为 **1**。同一份文档内两种说法，验收依据必须自洽：
改成「exit 1（消息含 `任务状态文件损坏: <文件>`）」。

## 四、仍不在本轮的两条（记入 M2 待办，不影响 M1 合并）

1. 验收第 9 条只能证明「intent 被清、任务仍可领」，不能区分「回滚后重领」与「没回滚、只
   清了 intent」——我的探针补了这个区分（校验旧 claim 被接管），单测 `test/tasknext.test.ts:213`
   也覆盖；脚本层面属可接受强度。
2. 上轮三条非阻塞建议（rollback 校验 `record.note`、doctor 查 orphan claim、`cowork --help`）
   小东未做，同意留到 M2。
