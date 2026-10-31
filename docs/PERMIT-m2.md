# M2 实现许可

日期：2026-11-01
依据：`docs/WORKORDER-M2.md` @ `2a75d19`，两轮裁定 `docs/REVIEW-m2-round1.md`、`docs/REVIEW-m2-round2.md`。

## 结论

**准予实现。** 设计阶段的四条阻塞项（R5–R8）已在 `2a75d19` 中落实，验收清单扩到 20 条并与状态机一致。设计不再改动；实现期间如遇设计未覆盖的分歧，停下来问判官，不许自行扩大语义。

## 已核实的修订点

| 项 | 要求 | 文档落点 | 判定 |
| --- | --- | --- | --- |
| R5 | 所有 Git 读取在 mutex 外；锁内只碰 live；两次外部快照比较，失败关闭 | §3 步骤 1/4、`task done` 时序图、§2 config 读取 | 通过 |
| R6 | PID 启动时间只能 `execFile` 调 `wmic`/PowerShell，`shell:false`；取不到记 `null` + `pid_start_error`，不得让 `task done` 失败 | §1 doctor 段、§2 记录字段、验收 8/9 | 通过 |
| R7 | `reported_done` 不能直接 `confirm-merge`（退出 1）；面板与 `brief` 显示“未验证”；doctor 对 >24h 的 `reported_done` 只提示 | §5、状态转移表新增行、验收 19 | 通过 |
| R8 | spawn 失败回到 `reported_done`，`verification.status=failed`、`exit=null`、`error="spawn"`；doctor 把 `pid=null` 或自身 PID 识别为“未启动” | §3、§1、验收 20 | 通过 |

## 实现期硬约束（违反即打回，不进合并）

1. **锁内不跑 git、不 spawn**：`withLock` 回调里只允许 live/metrics 的读写与判定。Git 与子进程都必须在锁外，用两次快照比较，任一不一致写 `verify_failed`。
2. **验证配置只认 trunk commit**：`git show <trunk-sha>:.cowork/config.json`，记录 `config_commit`；任何工作树版本（含 lane 已提交版本）都不参与。
3. **身份与原子性保持不变**：沿用现有 `requireOwner`、短命进程 claim 语义、tmp+rename 写 live；不新增后台进程、不引运行时依赖。
4. **不弱化既有测试**：`test/tasknext.test.ts`、`test/mutex.test.ts`、`test/ui.test.ts`、`test/taskops.test.ts` 的断言不得删改；新行为加新测试。
5. **验收脚本是交付物**：新增 `tools/accept-m2.mjs`，逐条覆盖 `WORKORDER-M2.md` §验收 1–20，输出 `PASS n. …` 与末行 `N PASS / M FAIL`，失败即非零退出。
6. **面板改动只加不拆**：三态展示、失败态“重跑验证”复制命令；`panel_agent` 的 R4 语义不变。
7. **不动架构文档**：`docs/ARCHITECTURE-TASKS.md`、`docs/ARCHITECTURE.md`、`docs/PLAN.md` 的既有语义不改；`docs/DECISIONS.md` 追加 D13 起的新决策。

## 分支与提交

- 分支：`dsh/m2`，基线 `origin/main`（含 `cf732b3`）。
- 拆分（一个提交只做一件事）：
  1. `feat: add M2 statuses and verification record to the task layer`
  2. `feat: run task done verification outside the lock`
  3. `feat: recover stuck verifications and unverified tasks in doctor`
  4. `feat: require verification before confirm-merge`
  5. `feat: surface contract alerts from handoffs`
  6. `test: add acceptance harness for M2`
  7. `docs: record M2 decisions and status table`
- 不推 `main`，不合并。

## 交付报告必须包含

- `git log --oneline origin/main..HEAD`
- `git status --short --branch`
- `npm test` 原始 TAP 汇总（`# tests / # pass / # fail`）与退出码
- `npx tsc --noEmit`、`npm run build` 的退出码
- `node tools/accept-m1.mjs --with-build`、`node tools/accept-panel.mjs`、`node tools/accept-m2.mjs` 的末行
- 最近一次 CI 运行的链接与结论
- 任何未覆盖的边界与已知风险

## 判官复验

实现方交回后，判官独立执行：`tools/probe-m2.mjs`（P1–P10，能力缺失时应全 SKIP）、`tools/scenario-m2.sh` 起的手工场景、`tools/check-lock-race.sh` 20 轮、完整门禁两次（分支与合并树各一次），并逐条对 `M2-REVIEW-CRITERIA.md` 的 24 个探针口径复核。
