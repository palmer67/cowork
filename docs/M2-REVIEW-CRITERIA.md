# M2 评审判据（判官内部清单，先于实现写好）

状态：**草稿**，2026-10-31 起草。用途：M2 设计稿到手后逐条比对；实现到手后逐条写探针。
依据：`docs/ARCHITECTURE-TASKS.md` §4 / §5 / §6 / §7，`docs/WORKORDER-M1.md` §13（M2 边界），
`docs/DECISIONS.md` D9（`--manual`）、D10（id）。

写这份清单的原则：**先想清楚"怎么证明它真的挡住了坏情况"，再想"它好不好用"。**
凡是"跑一遍绿了就信"的检查都不算数——M1 期间已经抓出三处永远为真的断言。

---

## 一、这次交付必须证明的四件硬事

| # | 命题 | 为什么必须由它证明 | 判据 |
|---|---|---|---|
| H1 | 自报完成 ≠ 完成 | 否则 agent 只要说"我做完了"就能推进状态 | 未配置验证、验证失败、验证超时、worktree dirty、HEAD 变动的五种情况全部**不能**进入 `awaiting_merge`，且保留 claim |
| H2 | 验证不在锁内跑 | 一条 `npm test` 跑 45 秒，持锁等于让整个仓库排队 | 用一个故意 sleep 5 秒的验证命令，同时另一个 lane 跑 `next`/`claim` 必须不被阻塞，且读到的状态一致 |
| H3 | 状态与证据绑定 | 否则人可以手改 live 让任务"看起来验过了" | `verify_head` 必须等于交付物所在提交；confirm-merge 的普通路径必须做祖先判定；`--manual` 必须留下 reason |
| H4 | 契约提醒不是摆设 | 改公共接口不通知读方，是本项目要解决的核心痛点 | `contracts_changed` 与自动 `reads∩touches` 两条路径都能在 brief/next/snapshot 里出现，且改完/合并后能消失 |

四条里任意一条失败 → **打回**，不接受"后续补"。

---

## 二、设计稿到手时要问的问题（不通过不发实现许可）

1. **锁边界**：验证命令在锁外跑，那"取验证快照"和"写验证结果"各在哪一次锁里？两次锁之间 HEAD 变了怎么处理？
2. **崩溃恢复**：CLI 在 `verifying` 中途被杀，谁负责把任务推回去？`doctor` 判据是什么（超时？verify 记录缺 timestamp？）会不会把正在跑的另一台机器误判？
3. **配置来源**：验证命令写在 `.cowork/config.json`（可提交）。如果这个文件被恶意/错误提交（比如 `argv: ["cmd","/c","del","/s","/q","*"]`），CLI 会不会照跑？至少要求：
   - arguments 作为数组传入，永不拼字符串
   - 命令只在 `assigned_lane` 的 worktree 根跑，路径必须 realpath 校验在仓库内
   - 拒绝空的 commands 数组时给出明确提示（不是静默通过）
4. **glob 语义一致**：`contracts_alerts` 的 matcher 必须和 claim/touches 的 matcher 是同一份代码，不能各写一套——否则提醒和占位会打架。
5. **失败留痕**：`verify_failed` 必须同时保存命令、退出码、耗时、stdout/stderr 摘要、验证时 HEAD；面板要能一键复制"重跑验证"的命令。
6. **不可解析**：验证命令输出了 0 但结果无法解析（比如预期 JSON 报告但给了空文件），按失败处理还是通过？我要求**按失败**，理由：不可信的成功比失败更危险。
7. **幂等**：同一任务重复 `task done` 应直接拒绝（已在 verifying/awaiting_merge），而不是重跑。
8. **跨平台**：`argv` 里带 `npx`/`npm` 在 Windows 上是否需要 `.cmd`？如果设计里写了"用 shell:true"，直接打回——那等于把注入面打开。
9. **依赖任务**：`verifying`/`awaiting_merge` 的任务，对依赖方算不算"已完成"？必须继续算**未完成**（只有 `merged` 计数），且 `next` 的理由文案要说清楚。
10. **非目标守护**：出现任何"验证通过后自动 git merge / 自动 push / 自动通知另一个 agent"的实现，直接打回——这是 M2 的定位红线。

---

## 三、验收清单（我会写成的探针，逐条可复现）

### 3.1 状态机

- P1 `task done` 在未配置验证命令时 → 退出 1，任务仍在 `reported_done`，claim 未释放。
- P2 配置两条验证（一条通过、一条失败）→ `verify_failed`，退出 1，claim 保留，`verification` 记录两条都有 exit/duration。
- P3 两条都通过且 HEAD 未变 → `awaiting_merge`，退出 0，`verify_head` = 当时 HEAD。
- P4 验证后 `git commit --allow-empty` 再 confirm-merge（普通路径）→ 祖先判定成立（empty commit 是后代），应允许；把工作树切到另一个分支使 verify_head 不在目标历史里 → 必须拒绝，退出 1。
- P5 `confirm-merge --manual` 缺 `--reason` → 退出 1 且状态不变。
- P6 squash 场景：verify_head 不是目标分支祖先，带 `--manual --reason` → 成功 `merged`，审计记录里三条都在（target sha、reason、verify_head）。
- P7 非法转移：`draft → verifying`、`awaiting_merge → in_progress` 全部拒绝，退出 1，消息说明当前状态和允许的下一状态。

### 3.2 锁与并发

- P8 验证命令 `node -e "setTimeout(()=>{},5000)"` 正在跑时，另一个 lane 执行 `cowork next` 与 `cowork lane new` → 都在 2 秒内返回，不被阻塞。
- P9 同一任务两个进程同时 `task done` → 一个 0/一个 2（或一个 1 说明已在验证），不出现两个 verification 记录。
- P10 `verifying` 期间另一 lane `next` 不得选中该任务；`snapshot` 显示 `verifying`。

### 3.3 证据与防伪

- P11 验证通过后手工改 live 的 `verify_head` 为另一个 SHA，再 confirm-merge → 普通路径必须拒绝（祖先判定基于 verify_head），能证明"证据与提交绑定"。
- P12 worktree 有未提交改动时 `task done` → 退出 1，提示"先提交"，即使验证命令全绿也不许过。
- P13 验证命令是 `exit 0` 的壳（`node -e ""`）→ 通过是**正确**行为（这是项目配置的信任边界，不是漏洞），但文档与 brief 必须写明"验证强度取决于配置"。这条不作为打回理由，作为文档检查项。
- P14 验证超时（配置 1 秒、命令 sleep 3 秒）→ `verify_failed`，记录 `timeout: true`，退出 1。

### 3.4 契约提醒

- P15 任务 A `touches: ["src/session.ts"]`，任务 B `reads: ["src/session.ts"]` → B 的 `brief` 与 `snapshot.contract_alerts` 出现提醒（含双方 task id 与路径），且不影响 B 领取。
- P16 handoff front-matter 写 `contracts_changed: ["src/session.ts"]` → 在 A 的 brief/next 与全局 snapshot 出现；A `merged` 后提醒消失（或被标记为历史）。
- P17 matcher 一致性：用与 claim 相同的 glob（`src/auth/**`）验证提醒命中，且 `src/authx/a.ts` 不命中（防止 `**` 写错方向）。
- P18 提醒只读：出现提醒后，B 的 claim/touches 集合不变，`doctor` 不报异常。

### 3.5 面板与快照

- P19 `snapshot --json` 的 `verification[]`、`verify_head`、`awaiting_merge` 都能被面板渲染；`verifying` 有转圈/进行中文案。
- P20 面板上 `task done` 按钮遵守 R4 身份规则（非 owner 置灰 + 可复制命令）；`confirm-merge` 不置灰。

### 3.6 门禁

- P21 `npm test` 全绿、`npx tsc --noEmit` 干净、`npm run build`、`node tools/accept-m1.mjs`、`node tools/accept-panel.mjs` 全过。
- P22 新增 `tools/accept-m2.mjs`，上述 P1–P7 至少覆盖，且**每条断言失败时能打印实际输出**（M1 的教训：`includes('a')` 那种断言等于没写）。
- P23 合并树上重跑 P21/P22 全绿（合并可能引入语义漂移）。
- P24 一轮并发压测：`test/tasknext-concurrency.test.ts` + `test/mutex-concurrency.test.ts` 各 20 轮 0 失败。

---

## 四、我会重点找的"假绿"

1. 验证记录里 `duration_ms` 恒为 0 或 `head` 恒为空 —— 说明是抄的字段，不是真跑。
2. 断言用 `includes('ok')`、`includes('a')` 这类单字符/宽匹配。
3. 先写 `awaiting_merge` 再补验证记录（顺序错）。
4. 验证命令在 dirty 树上跑（会看到未提交的假通过）。
5. `verify_failed` 之后 claim 被静默释放（等于任何人可接管）。
6. `contracts_alerts` 只在 `brief` 出现、`next`/`snapshot` 没有（三条路径必须一致）。
7. 恢复逻辑把 `verify_failed` 误判成 stale 改回 `reported_done`（§5 明令禁止的静默回退）。
8. 超时用 `setTimeout` 杀进程但没等 `close` 事件就写结果（记录可能丢失或挂住）。

---

## 五、合并前必须由我亲自跑的命令（不接受截图）

```
cd .cowork/lanes/<m2 lane> && git log --oneline main..HEAD
npm test                       # 看 # tests / # pass / # fail 与退出码，不管道截断
npx tsc --noEmit ; echo rc=$?
npm run build ; echo rc=$?
node tools/accept-m1.mjs --with-build
node tools/accept-panel.mjs
node tools/accept-m2.mjs
node .cowork/lanes/dsh-review/tools/probe-m2.mjs      # 我自己的探针（P8/P9/P11/P14/P17 等）
```

判定口径：**P1–P7、P8、P10、P12、P15、P16、P21–P23 任一失败 = 打回**；其余为"合前应改"或"记入 backlog"。
