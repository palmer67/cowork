# WORKORDER-M3：合并预演、状态仪表盘、Windows 路径加固

基线：`main@b2f23ff`（M2 已合）。实现方：Codex。判官：DSH。
本工单与判据一起发，**不需要再回来问设计**——下面每一条都是已定的规则；真遇到本文件没覆盖的分歧，
写成 ADR 草案交给判官，不要自己拍板。

## 0. 为什么做

- 现在只能「合完才知道有没有冲突」，多车道并行时这是最大的盲区；
- `cowork status` 只列占位，看不到任务、验证、脏工作树；
- 项目对外宣称「Windows 优先」，但中文路径、空格路径、长路径、PowerShell/cmd 都没测过。
- 顺带清掉 M1/M2 留下的四条小尾巴。

## 1. 硬约束（与 M1/M2 相同，违反即打回）

1. 锁内不跑 git、不跑验证命令、不做进程查询；锁只操作 live 状态。
2. 只读命令（`status`、`snapshot`、`list`、`show`、合并预演）**不取锁**，不得顺手回滚 intent。
3. 零运行时依赖；不引 Electron/前端框架/打包器。
4. 不改 `docs/ARCHITECTURE-TASKS.md`、`docs/ARCHITECTURE.md`、`docs/PLAN.md` 的既有语义。
5. 不弱化既有测试与既有验收脚本；`test/ui.test.ts` 不动。
6. 新决策写进 `docs/DECISIONS.md`（D14 起），一个新决策一条。

## 2. `cowork merge --dry-run <lane>`（新增，只读）

用途：在真合之前，算出「这条车道合进 trunk 会不会冲突、冲突在哪」。

规则：

- 参数：`cowork merge --dry-run <lane>`；`--base <ref>` 可选，默认 `config.trunk`。
- 不修改工作树、HEAD、index、工作区文件；不创建分支或引用（临时对象可以，结束后不留引用）。
- 不取写锁。
- 计算：对 `<lane 分支 HEAD>` 与 `<base HEAD>` 做三方合并比较（`git merge-tree --write-tree` 优先；
  若 git 版本不支持，退化为在临时目录做 `git merge --no-commit --no-ff` 再清理——**临时目录必须在系统临时区**，
  不许建在仓库里）。
- 输出（stdout，人类可读）：
  ```
  预演：lane dsh ← main@b2f23ff
  冲突 2 个文件 / 3 处
    src/auth/login.ts        hunk 40-52  与 main 的 41-55 重叠
    src/snapshot.ts          整文件冲突（两侧都改，且基线不同）
  可合（文件级）
  ```
  无冲突时打印 `可合：0 个文件冲突`。
- 退出码：`0` 可合 / `2` 有冲突 / `1` 参数或仓库错误 / `3` 环境不满足（不是 git 仓库）。
- `--json` 输出同一份结果的结构化版本，字段名用 snake_case，供面板和脚本消费。

## 3. `cowork status` 升级成仪表盘（只读）

保留现有「占位表」，增加四块，**默认输出必须一屏能看完**（不超过 40 行，超出就折叠成计数）：

1. **车道**：车道名、分支、HEAD 短哈希、未提交文件数、是否落后 trunk；
2. **占位**：现有内容（路径、类型、车道、占用者、过期时间）；
3. **任务**：按状态分组计数（`ready` / `claimed` / `in_progress` / `reported_done` / `verifying` /
   `verify_failed` / `awaiting_merge` / `merged`），并把 `verifying`、`verify_failed`、`awaiting_merge`
   三类逐条列出（带 `run_id` 或 `verify_failed` 原因摘要，不超过 60 字）；
4. **提示**：`reported_done` 超过 24h 未验证、`spec_commit` 漂移、残留 intent、`lock.tmp-*`/`trash/` 残留，
   每类一行计数 + 一条建议命令。

`cowork status --json` 输出结构化版本（同样的四块）。不得新增锁，不得触发恢复。

## 4. Windows 路径加固

目标：中文路径、带空格路径、超过 260 字符的路径，行为是**要么正确工作，要么优雅报错**（退出码 3，
消息说明原因 + 建议），**绝不出现堆栈或半写状态**。

- 所有内部路径拼接改用 `node:path` 的 `path.resolve`/`path.join`，禁止手写 `/` 或 `\` 拼接；
- 长路径：读取/写入前不假设 260 上限；Windows 上若 `ENAMETOOLONG`/`ENOENT` 因长路径产生，
  统一包装成 `退出码 3`，消息含「路径过长」与「可开启 Windows 长路径支持」的建议；
- `git` 子进程的工作目录与参数路径必须原样传递（不经过 shell 拼接）；
- 新增 `test/paths-windows.test.ts`：中文名、空格名、长路径三层嵌套各一条用例（长路径用临时区内拼出）。

## 5. 顺带修四条小尾巴

| 项 | 要求 |
|---|---|
| `task add` 打印 id 三次 | 只打印一次，格式不变（脚本靠最后一行解析） |
| 验证超时只杀直接子进程 | Windows 上优先 `taskkill /T /F /PID <pid>`，失败再退回 `child.kill()`；非 Windows 用进程组 |
| `blocked` 且验证在跑 | `doctor --fix` 只清掉过期的 `verification.status='running'`，状态保持 `blocked`，写一条 recovery 历史 |
| `awaiting_merge` 不能取消 | 允许 `task cancel`，同时释放 lease 与占位；记 D14 |

## 6. 验收（新增 `tools/accept-m3.mjs`，10 条，输出 `PASS n.` + 末行 `N PASS / M FAIL`）

1. `merge --dry-run` 对无冲突的两条车道 → 退出 0，输出含 `可合`；
2. 两条车道改同一文件同一段 → 退出 2，输出含该文件路径与两个 hunk 行号；
3. dry-run 前后工作树、HEAD、index、`git status` 完全不变，且不留临时引用；
4. `--json` 输出的 `conflicts[].path` 与人类输出一致；
5. `status` 默认输出 ≤40 行且包含四块标题；`--json` 可被 `JSON.parse`；
6. 有任务在 `verifying` 时，`status` 能看到它且 `status` 本身不被阻塞（<2 s 返回）；
7. 中文 + 空格路径仓库里，`init`、`task add`、`next`、`status` 全部正常工作；
8. 长路径（>260）触发时退出码为 3 或正常完成，**不得**出现 `Error:` 堆栈或部分写入；
9. `task add` 只输出一次 id；`awaiting_merge` 的任务可 `cancel` 且占位被释放；
10. `npm test`、`npx tsc --noEmit`、`npm run build` 全绿；`accept-m1`/`accept-panel`/`accept-m2` 全绿。

## 7. 提交拆分（≤6 个，一个提交一件事）

1. `feat: add merge dry-run preview`
2. `feat: turn status into a dashboard`
3. `fix: harden Windows path handling`
4. `fix: clean up the four M1/M2 leftovers`
5. `test: add M3 acceptance script`
6. `docs: record D14 and the M3 decisions`

## 8. 交付报告（写文件，不要贴聊天）

写 `.cowork/notes/<分支>-report.md` 并提交，内容固定五行：

```
分支 / 提交数 / 最终哈希
门禁：npm test = ? / tsc = ? / build = ? / accept-m1 = ? / accept-panel = ? / accept-m2 = ? / accept-m3 = ?
CI：<运行链接> <结论>
已知风险：<不超过 3 条>
判官需要重点看的点：<不超过 3 条>
```

用户会把「它交了」告诉判官，判官自己 `git fetch` 读这份文件——**不要在聊天里贴长报告**。
