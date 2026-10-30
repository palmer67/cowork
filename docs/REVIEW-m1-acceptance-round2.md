# 复核：M1 交付验收（第二轮，独立复核）

> 复核人：dsh-review。对象：`dsh/m0@aa1b83c`。复核方式：**不看小东的自报，自己跑一遍**，
> 另写 16 条独立探针（`tools/probe-m1-acceptance.mjs`）复现工作令 §12 中脚本没真正证明的条目。

## 结论

**产品实质通过，流程上打回。** 行为是对的：我自己的探针 16/16 通过，测试 95/95，类型检查干净，
官方脚本 10/10。但 M1 的验收**依据**还有四处不成立，其中一处是工作令 §11 明确要求的测试根本没写。
在这些补齐之前不合 main。

## 一、我自己验过的（结论：通过）

| 项 | 我的证据 | 结果 |
|---|---|---|
| 测试门槛 | `npm test` → `# tests 95 / # pass 95 / # fail 0`，exit 0，node v22.14.0 | ✅ |
| 类型检查 | `npx tsc --noEmit` → 无输出 | ✅ |
| 官方验收 | `node tools/accept-m1.mjs --with-build` → `10 条：10 PASS，0 FAIL，0 SKIP` | ✅ |
| §12.3 占位冲突 | 真实 CLI：`claim src/auth/login.ts` 后 `next` → exit 1，输出 `src/auth/login.ts 与占位 src/auth/login.ts 冲突（lane a agent=agent-a 于 …）`，且任务仍是 `ready`、`agent=null` | ✅ |
| §12.4 真 barrier 并发 | 两个 racer 各自就位后同时 `next`：`a=2 b=0`；输家输出 `任务已被领取: t-… ← lane b agent agent-b 于 …` | ✅ |
| §11 无部分占位 | 双 touches 任务被领后 claim 文件数 == touches 数（2 == 2），live `claimed` 且有 `spec_commit` | ✅ |
| §12.8 不写 live | `lane new ok-lane` 前后 tasks/intents/claims 文件清单无任何新增 | ✅ |
| §12.9 半截 intent | 手写 `phase=pending` intent → `next` 输出 `已回滚未完成事务: t-…` 并把任务领给另一条 lane；intent 清除、旧 claim 被新 owner 接管 | ✅ |

复现：`node .cowork/lanes/dsh-review/tools/probe-m1-acceptance.mjs .cowork/lanes/dsh-m0/dist/cli.js`
→ `16 PASS / 0 FAIL`。探针自带真 barrier（文件同步点），不是 `Promise.all` 假并发。

确认修好的三处（小东自述属实）：`--only` 空默认值曾把检查过滤成「0 条全绿」；Windows 上
`spawnSync('npm'/'npx')` 缺 shell 会 ENOENT；冲突消息现在同时打印被占 claim 与占用者 lane/agent，
`lane new --task` 显式拒绝。

## 二、打回项（合并前必须补）

### B1（最重）§11 要求的 5 进程并发测试不存在

工作令 §11 原文：「并发测试用 5 个进程**同一时刻** `next`，断言只有一个成功、其余 exit 2 且无残留
intent」；设计说明第 19 条也以此自称。实际：

```
$ grep -rn "spawn" test/*.ts        # 无输出
$ grep -c "^test(" test/*.ts        # 各文件条数，无并发用例
```

`test/` 里没有任何跨进程测试，`npm test` 95 条全在被测进程内。验收脚本第 4 条只跑 2 个进程、
且失败了允许重试 3 轮，达不到 §11 的「同一时刻」。**这是工作令写死的门槛，不是建议。**
要求：`test/` 内新增一个 spawn 型测试，5 个子进程经同一 barrier 文件对齐后同时 `next`，
断言恰好 1 个 exit 0、4 个 exit 2、无残留 intent、claims 数 == 胜者的 touches 数。
（可以直接借用 `tools/probe-m1-acceptance.mjs` 里 racer 的写法。）

### B2 验收脚本仍有四处不成立（上一轮 A–E 未修）

```
$ sed -n '180p' tools/accept-m1.mjs
  check(n.out.includes('a'), '输出里没有占用者车道');     ← 单字符，恒真
$ sed -n '313p' tools/accept-m1.mjs
  writeFileSync(path.join(liveTasks, 't-ffffff.json'), …  ← §12.9 的坑没补，验的是损坏 live
$ sed -n '323p' tools/accept-m1.mjs
  if (!has('--with-build')) return ['跳过：未加 --with-build'];  ← 默认命令下门槛不验
```

- A：`includes('a')` 仍是恒真断言。行为我已独立验证正确，但**脚本没有证明它**。
- B：第 4 条仍是 `Promise.all` 假并发，也不断言输家打印赢家 lane。行为我验证正确，脚本未证明。
- C：第 8 条仍不查「不写 live」。
- D：第 9 条仍是损坏 live（应保留为 §9 的检查），**§12.9 半截 intent 在脚本里完全缺失**。
- E：第 10 条默认 SKIP，而约定验收命令不带 `--with-build`，等于门槛默认不验。

### B3 设计说明与工作令仍有事实不符

1. 设计说明**第 2 条仍然写反**：「C 的选取：live 缺失或 `ready`」。实现是
   `src/tasknext.ts:313` `world.lives.get(id)?.status ?? 'draft'`，`live` 缺失按 `draft`，不可领。
   照文档实现 = 删掉 live 文件就能复活任意 blocked/cancelled 任务，绕过 §12.5 的 ready 门。
   **实现对，文档错**，必须改。
2. 设计说明第 8 条仍写「C′ 空且 C 非空 → exit 2」，漏了「只是 touches 被手工 claim、没有任务赢家」
   这一支：实现 `src/tasknext.ts:405-424` 在无赢家时退 1（与 §12.3 同语义）。工作令 §5.4 同样缺这个分支。
3. 工作令 §10 表仍写「live 状态损坏需人工 → 3」，实现与小东的设计说明都是 **1**
   （`src/taskstore.ts:52-57` `corruptFile → general`）。我的裁定不变：**用 1**，
   把 §10 那一行从 3 挪出，并要求消息含 `任务状态文件损坏: <文件>`。

### B4 DECISIONS 缺三条记录（P2/P4/P5）

`git diff main..HEAD -- docs/DECISIONS.md` 只有 D9、D10（D9 `--manual`、D10 opaque id 写得合格）。
缺：**P2** 损坏码为何是 1（含与 §10 的差异）；**P4** 锁外读 live/claims 是 §3.1 的有界例外
（C 只用于退出码、写决策只用 C′、坏 live 不得跳过）；**P5** `next` 不重验 trunk 移动的降级与
doctor 兜底。这三条是评审时「允许继续」的条件，不落档等于没定。

## 三、不阻塞但建议顺手记下

1. §12.9 的措辞是「任意命令自动回滚」，但 `task ls` / `task show` 是只读、不取锁、不恢复
   （`src/taskops.ts:162`、`:178`）。按 §5.7「任何命令**取得锁**后先扫 intents」，这不算 bug，
   但建议：给 `task ls` 在检测到残留 intent 时打一行提示「存在未完成事务，运行任意写命令或
   `cowork doctor --fix` 恢复」；并把 §12.9 的措辞改成「任意取锁命令」。
2. `rollback()` 删 claim 只比对 lane/lanePath/agent，建议加 `record.note === 'task ' + intent.task_id`。
3. `verifyCommitted()` 在 live 已 merged/cancelled 时直接返回（`src/tasknext.ts:207`），不核对残留
   claims，靠 doctor 兜底——建议 doctor 明确有 orphan claim 检查。
4. `cowork --help` 仍报「未知命令」（exit 1）。小瑕疵，M2 前修掉即可。

## 四、越界检查（结论：无）

`git diff --stat main..HEAD -- docs/ARCHITECTURE-TASKS.md docs/ARCHITECTURE.md docs/PLAN.md` 为空。
无自动合并、无 `verifying` 实现、无 contracts_changed 扫描。

## 合并前置清单（我按这个放行）

- [ ] B1：5 进程并发测试进 `npm test`，断言赢家唯一 + 其余 exit 2 + 无残留 intent + claims==touches
- [ ] B2：脚本 A/C/D/E 四处补齐（B 补 barrier 与赢家断言）
- [ ] B3：设计说明第 2/8 条改正；§10 损坏码改 1；§5.4 补「仅 touches 被占」分支
- [ ] B4：DECISIONS 补 P2/P4/P5
- [ ] 重跑：`npm test`（≥60 且含新并发用例）、`npx tsc --noEmit`、`node tools/accept-m1.mjs --with-build`
- [ ] 我再用 `tools/probe-m1-acceptance.mjs` 复跑一次

清单全绿后我按 `docs/RUNBOOK-m1-acceptance.md` §4 合 main，合之前会先跟用户打招呼。
