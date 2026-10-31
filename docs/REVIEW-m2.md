# M2 验收评审：dsh/m2 @ e5d00c1

判官：DSH。实现：Codex。本文件只记结论、证据与遗留；过程在对话里。

## 结论

**可合（无阻塞项）。** 产品行为、状态机、锁边界、可观测性与验收脚本均按 WORKORDER-M2 与
`docs/PERMIT-m2.md` 落地；我用自己的独立探针复验 44 条断言全过，未发现需要打回的缺陷。

## 证据（全部在本机独立跑，不采信实现方自报）

环境：node v22.14.0，独立 worktree `.cowork/lanes/m2-verify`（detached at `origin/dsh/m2` = `e5d00c1`）。

| 检查 | 结果 |
| --- | --- |
| `npm test` | `# tests 155 / # pass 155 / # fail 0`，exit 0（约 90 s） |
| `npx tsc --noEmit` | 无输出，exit 0 |
| `npm run build` | exit 0 |
| `node tools/accept-m1.mjs` | `10 条：10 PASS，0 FAIL，0 SKIP` |
| `node tools/accept-panel.mjs` | `13 PASS / 0 FAIL` |
| `node tools/accept-m2.mjs` | `20 PASS / 0 FAIL` |
| 我的独立探针 `tools/probe-m2.mjs` | **44 PASS / 0 FAIL**（18 组场景，见下） |

分支：`git log --oneline origin/main..dsh/m2` 共 8 个提交（7 个功能边界 + 1 个 accept-m1 超时修复），
`git status --short` 干净；`docs/ARCHITECTURE-TASKS.md`、`docs/ARCHITECTURE.md`、`docs/PLAN.md`
与 `test/ui.test.ts` 均未改动。

## 我的探针覆盖（不复用 accept-m2 的断言）

P1 验证期间 `next` 不被阻塞（<2 s）且 live 保持 `verifying`；P2 命令失败 → `verify_failed`，lease 与 claims 保留；
P3 验证后 HEAD 漂移 → 拒绝；P4 初始 dirty 拒绝（状态留在 `reported_done`）；P5 超时 → `timed_out=true` + `verify_failed`；
P6 `verifying` 中重复 `task done` → exit 2；P7 成功 → `awaiting_merge` → `task confirm-merge` 成功；
P8 车道里篡改 config 不生效，记录的是 trunk 的 `config_commit`；P9 `reads`×`touches` 冲突在 snapshot 里成结构化提醒；
P10 CLI 在验证中被杀 → 停在 `verifying` → `doctor --fix` 恢复 `reported_done` 且保留 claim；
P11 `claimed` 下 `task done` → exit 1；P12 `reported_done` 直接合并 → exit 1 且文案要求先验证；
P13 可执行文件不存在 → 回到 `reported_done`，记录 `exit=null`/`error="spawn"`；P14 验证命令写脏 → `verify_failed`；
P15 未跟踪文件也算 dirty；P16 snapshot 投影 `verifying` 与 `run_id`；P17 5000 字符输出下仍通过且 summary ≤2 KiB；
P18 面板显示三态并提供可复制的重跑命令。

## 关键实现复核（文件:行）

- 锁内不跑 git：`src/taskverify.ts` 的快照读取在两次 `withTaskLock` 之外，第二次锁内只做
  `requireRun`/`requireOwnerAndClaims`/`transitionM2Task`（R5）。
- 配置只认 trunk：`readGitSnapshot` 用 `git show <trunkSha>:.cowork/config.json` 与
  `:.cowork/tasks/<id>.md`，`verification.config_commit` 记录该 SHA（R1）。
- PID 复用防护：`pid_started_at` 由 `powershell.exe -NoProfile -Command "Get-Process ..."` 取得，
  取不到只写 `pid_start_error` 并拒绝恢复（R6）。
- 不让 `report-done` 绕过验证：`confirm-merge` 从 `reported_done` 直接拒绝并提示先 `task done`（R7）。
- spawn 失败不卡死：回到 `reported_done`，`verification.status='failed'`，记录 `exit=null`/`error="spawn"`（R8）。
- M2 状态表只加行不改 M1 语义：`M2_TRANSITIONS` 与 `transitionTask` 分离（`src/taskstore.ts`）。

## 遗留（不阻塞合入，记入后续）

1. 超时 `child.kill()` 只杀直接子进程；Windows 下 npm/tsc 的孙进程可能继续跑。当前用「验证后快照不一致」
   兜住结果，但进程残留会拖慢机器。建议 M3 用 job object 或 `taskkill /T`。
2. `blocked` 且验证在跑的路径保留了 `verification.status='running'`，doctor 能识别，但没有主动恢复入口；
   属于已知边界，写进 doctor 文档即可。
3. 状态机未允许 `awaiting_merge → cancelled`；是否需要取消「已验证待合并」的任务，留给 M3 一起定。
4. `task add` 会把同一个 id 打印三次（M1 遗留），影响脚本解析，已在我的探针里用 `head -1` 规避。

## 合并步骤（下一步执行）

1. 在 `.cowork/lanes/main` 上 `git fetch origin` 后 `git merge --no-ff dsh/m2`。
2. 合并树上重跑：`npm test`、`npx tsc --noEmit`、`npm run build`、三个 accept 脚本。
3. `git push origin main`；把合并哈希与门禁表写进 `.cowork/notes/`。
