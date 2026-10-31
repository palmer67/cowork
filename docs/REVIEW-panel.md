# 评审：M1.5 派工面板（`dsh/panel`）

被评对象：`dsh/panel`，HEAD `02b78f2`，6 个提交，`main...dsh/panel = 0 6`。
评审人：判官（读代码 + 独立探针 + 独立跑门禁，不采信交付报告）。
时间：2026-10-31。

## 结论

**可合（有条件）**：面板本身达标，两处必须先改，其中一处不在面板代码里。

| # | 问题 | 位置 | 归谁 |
| - | ---- | ---- | ---- |
| P0 | 全局锁不是原子发布，高并发下 exit 1（ENOENT/EPERM） | `src/mutex.ts:60-89`（M1 已合并代码） | 小东 |
| P1 | 面板上「开始 / 标记完成 / 标记阻塞 / 取消」必然失败 | `src/uiserver.ts` 写路由 + `src/ui.ts` 任务行按钮 | Codex |

P0 的复现与机理另见 `docs/BUG-lock-dir-race.md`：5 进程用例循环 10 次失败 2 次。

## P1：为什么面板那四个按钮是死的

`src/taskops.ts:206` 的 `requireOwner()` 被 `start`(`:232`)、`report-done`(`:246`)、
`block`(`:257`)、`cancel`(`:348`) 调用，要求执行者与 live 里的 `lane`/`agent` 完全一致。

面板的 `writeCommand()` 在**仓库根目录**起子进程，不带任何身份覆盖，于是子进程用的是面板自己的
`agentId()`（通常 `default`）；而任务被派工时 owner 是 `lane dsh agent dsh`。两者永远对不上。

实测（我的探针 `.cowork/lanes/dsh-review/tools/probe-panel.mjs`）：

```
NOTE 面板点「开始」: code=2 stderr=cowork: 任务 t-58f61f 被 lane dsh agent dsh 占着，start 需要持有者执行
```

`WORKORDER-PANEL.md:209` 明确要求「任务行按状态显示可用动作」，所以这是工单与实现都没兜住的
设计缺口，责任在工单（我写的），不在实现者。

### 裁定（新增 R4）

不做「面板冒充 owner」。人的点击不应该等价于 agent 说「我开工了 / 我做完了」，否则
`in_progress` / `reported_done` 这两个信号就失去意义。因此：

1. `/api/snapshot` 的响应里增加 `panel_agent`（面板进程的身份 = `COWORK_AGENT_ID` 或 `default`）；
2. 任务行按钮仅在 `task.lane_agent === panel_agent` 时可用，否则置灰并在 `title` 里写
   「需在车道 <lane> 内由 <agent> 执行」，正文给出 `cowork task start <id>` 供复制；
3. `confirm-merge` 不受此限（它本来就没有 owner 校验，是人工确认口）；
4. `ready` 不受此限（draft → ready 是人的审核动作）；
5. 双 README 的「面板派工」一节补一句：状态推进在车道 CLI 里做，面板负责派工、导入、确认合并。

## 已验证通过的（可复算）

| 项目 | 命令 | 结果 |
| ---- | ---- | ---- |
| 单测 | `npm test`（`codex-panel`） | `# tests 132 / # pass 132 / # fail 0`，exit 0，44.8s |
| 类型 | `npx tsc --noEmit` | 无输出，exit 0 |
| 构建 | `npm run build` | exit 0 |
| 端到端 | `node tools/accept-panel.mjs` | 13 PASS / 0 FAIL |
| 我的独立探针 | `node .cowork/lanes/dsh-review/tools/probe-panel.mjs <lane> <dist/cli.js>` | ALL PASS（24 项） |
| 禁改文件 | `git diff main..HEAD -- docs/ARCHITECTURE-TASKS.md docs/ARCHITECTURE.md test/ui.test.ts` | 空 |
| 零依赖 | `package.json` `dependencies` | `{}` |
| 面板不直接写状态 | `grep -cE "writeFileSync\|renameSync" src/uiserver.ts` | 0 |
| 只监听本机 | `grep -rn "0.0.0.0" src/` | 无 |

安全面（代码通读）：`randomBytes(16)` token + `timingSafeEqual`、Host 白名单、无 CORS 头、
`OPTIONS` 405、请求体 64KB 上限、`safeSegment` 拒 `..`/`.`/`-`、导入路径 `realpathSync` 防越界、
写路由对 body/query 的 `agent` 一律 400、子进程 60s 超时映射 code 1、写请求串行队列。

## 其它观察（不阻塞）

- `README.md` / `README.en.md` 改动（badge 109→132、新增「面板派工」节）仍在工作区未提交，
  按交付说明留给 DSH。合并前需要落成一个提交。
- 并发建同名车道返回 `[0,2]`（串行队列生效），符合预期，但错误文案是「车道已存在」，
  没有指出是队列保证的——可读性建议，非缺陷。
- `task import` 的 `--ready` 只打印命令不自动 ready（D12），已验证不会偷偷改状态。

## 合并前置

1. P0（锁）修复合入并 50/50 压测通过；
2. P1（按钮）按 R4 改完，`npm test` / `accept-panel` / 我的探针三绿；
3. README 落成一个提交；
4. 我在合并后的树上重跑一遍门禁，再按 `docs/RUNBOOK-m1-acceptance.md` §4 合 `main`。
