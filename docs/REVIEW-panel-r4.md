# 复验：R4 面板状态按钮 + M1.5 合入 main

被验对象：`dsh/panel`，`68ce231`（R4 在 `c54cc94`，README 在 `68ce231`）。
合并提交：`bbf3c1d`，`main` 上再补 `b66460c`（测试计数 132→133）。
复验人：判官；时间：2026-10-31。

## 结论

**可合，已合。** R4 按裁定实现，没有引入「面板冒充 owner」；面板、导入、锁修复三者合并后的
main 全绿。

## 证据（我在合并后的 main 树上重跑，不采信分支里的报告）

| 项目 | 结果 |
| ---- | ---- |
| `npm test` | `# tests 133 / # pass 133 / # fail 0`，exit 0 |
| `npx tsc --noEmit` | 无输出，exit 0 |
| `npm run build` | exit 0 |
| `node tools/accept-panel.mjs` | 13 PASS / 0 FAIL |
| 我的探针 `tools/probe-panel.mjs` | ALL PASS（31 项，含 5 项新的 R4 断言） |
| 锁并发压测 20 轮 | 0 失败 |
| 禁改文件 | `git diff main..HEAD -- docs/ARCHITECTURE-TASKS.md docs/ARCHITECTURE.md test/ui.test.ts` 空 |
| `src/mutex.ts` / `src/tasknext.ts` / `src/taskops.ts` | 面板分支未改动，合并后保留锁修复 |

分支自检（`lanes/codex-panel`）也复跑过一遍：`132/132`、tsc 干净、build 0、`accept-panel` 13/13。

## R4 的代码确认

- `src/snapshot.ts:84` 新增可选 `panel_agent`，只在面板响应里注入（`src/uiserver.ts:69-74`
  `withPanelAgent`），CLI 的 `snapshot --json` 不受影响。
- `src/ui.ts:175-196`：`start/report-done/block/cancel` 需要
  `assigned_lane === panelAgent && agent === panelAgent`；`ready`/`confirm-merge` 不参与。
  不匹配时按钮带 `disabled` 和 `需在车道 <lane> 内由 <agent> 执行`，并在行内给出可复制的
  `cowork task start <id>`（`src/ui.ts:190-193`）。
- `src/ui.ts:454-470` 补了 `data-copy` 的点击复制（原先静态模式只渲染按钮，点击没反应），
  含 `navigator.clipboard` 失败时的 `execCommand` 兜底。
- 服务端对首页与 `/api/snapshot` 走同一条 `withPanelAgent` 路径（`src/uiserver.ts:231`），
  首屏与轮询结果一致，不会出现「首屏按钮全亮、两秒后变灰」。

我的探针新增断言（对已派工任务）：`panel_agent=default`；`start` 置灰且文案含「需在车道 dsh 内由 dsh 执行」；
`confirm-merge` 只因「状态未到」置灰、不含 owner 文案；页面含可复制的 `cowork task start <id>`；
绕过 UI 直接 `POST /api/task/<id>/start` 仍返回 `code 2`。

## 留下的观察（不阻塞）

1. **UI 比后端更严**：`requireOwner()`（`src/taskops.ts:206-213`）只比对 `agent`，不看 `lane`。
   手工 `claim` 出来的任务 `lane` 为 `null` 时，面板会显示「需在车道 未分配 内由 dsh 执行」并置灰，
   而 CLI 用同一个 agent 其实能 `start`。方向是「多拦」不是「漏拦」，暂不修；下轮把文案从
   `未分配` 改成 `(main)` 会更准确。
2. `doctor` 仍不清理 `lock.tmp-*` 与 `trash/` 的残留（见 `docs/REVIEW-lock-fix.md`）。
3. `tools/accept-m1.mjs` 第 9 条的**标题**还是旧文案（断言已覆盖 §12.9），列入收尾清单。

## 合并

`.cowork/lanes/main` 上 `git merge --no-ff dsh/panel` → `bbf3c1d`；合并后重跑全套门禁
（上表）再推送。`origin/main = b66460c`。
