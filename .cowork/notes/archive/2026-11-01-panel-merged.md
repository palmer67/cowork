# M1.5 已合入 main（派工面板 + 计划导入）

- 合并提交：`bbf3c1d`（`dsh/panel` → `main`，`--no-ff`）
- 后续：`b66460c` 测试计数 132→133；`origin/main = b66460c`
- 分支：`dsh/panel`（Codex，6 个功能提交 + R4 `c54cc94` + README `68ce231`）
- 锁修复：`311a1f2`（`dsh/lock-fix`，小东），先于面板合入

## 合并后重跑的门禁（在 `.cowork/lanes/main`）

| 项目 | 结果 |
| ---- | ---- |
| `npm test` | `# tests 133 / # pass 133 / # fail 0` |
| `npx tsc --noEmit` | 无输出，exit 0 |
| `npm run build` | exit 0 |
| `node tools/accept-panel.mjs` | 13 PASS / 0 FAIL |
| 判官探针 `tools/probe-panel.mjs`（dsh-review 车道） | 31 项全过 |
| 锁 5 进程并发 20 轮 | 0 失败 |

## 评审链

1. M1.5 工单 `docs/WORKORDER-PANEL.md`（D11/D12 + 13 条验收）→ `43bc699`
2. 裁定 R1–R3（返回码、只读验收、身份）→ `a10f6a0`
3. 裁定 R4（状态按钮绑定 owner）→ `48c30c4`
4. Codex 交付 → 判官复验 → 发现锁竞态（`docs/BUG-lock-dir-race.md`）与小东修复 → 复验合并
5. 面板复验 → `docs/REVIEW-panel.md`、`docs/REVIEW-panel-r4.md`（dsh-review 车道）

## 使用

```bash
cd .cowork/lanes/main
node dist\cli.js ui --serve --open     # 本机前台派工面板
node dist\cli.js ui --out board.html   # 静态只读看板
```

面板能：新建车道/任务、导入 `plan.json`、按队列派工、查看 brief、确认合并。
状态推进（start / report-done / block / cancel）需要任务 owner 身份，面板会把按钮置灰并给出
`cowork task start <id>`，在对应车道里执行。

## 已知遗留（不阻塞使用）

1. `doctor` 不清理 `lock.tmp-*` 与 `trash/` 的残留（崩溃后可能留下空目录）。
2. `tools/accept-m1.mjs` 第 9 条标题仍是旧文案，断言已覆盖 §12.9。
3. 手工 `claim` 出来、`lane` 为 null 的任务，面板文案写「需在车道 未分配 内…」，读起来别扭。
