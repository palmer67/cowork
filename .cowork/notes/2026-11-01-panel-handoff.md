---
date: 2026-11-01
branch: dsh/panel
base: 48c30c4
status: implemented, not merged
---

# M1.5 派工面板交接

## 已完成

- `cowork task import` 校验计划、解析依赖别名、检查环并批量创建 draft；dry-run 展示目标路径。
- `cowork ui --serve` 运行在前台，仅绑定 `127.0.0.1`；token/Host/路径/body/串行写队列已覆盖。
- 静态面板继续单文件、本地可开，M1 的 `test/ui.test.ts` 原断言未变。
- D11/D12、R1–R4、架构说明与双语 README 已更新；架构任务文档和原架构文档没有改动。

## 验收与限制

- `npm test`：132 tests 通过；`npx tsc --noEmit` 静默；`npm run build` 成功。
- `node tools/accept-panel.mjs`：13 项通过；脚本会在临时仓库复核锁外快照的持久文件集合及 mtime。
- R1：顺序重复 next 与因既有占位无候选均返回 M1 的 1；真实竞争才是 2。工单 §8.9 的“已有冲突返回 2”旧文字与裁定冲突，验收明确以裁定为准。
- R3：面板不接受客户端提供的 agent，也不模拟快照 owner；写路由由 CLI 使用面板进程身份运行。
- R4：snapshot API 增加 `panel_agent`；owner 状态按钮仅在车道和 agent 都匹配时启用，不匹配时显示提示和可复制的 `cowork task start <id>`。`ready` 与 `confirm-merge` 不受身份限制。
- 仍是拉取式协作：不启动 agent、不自动调度、不自动合并。浏览器重载/关闭不停止服务，需在启动终端 Ctrl+C。

## 继续操作

1. 查看六个提交：`git log --oneline main..HEAD`。
2. 有网络时仅推送 `dsh/panel`；不合并 main。
3. 由判官按工单评审，尤其检查 owner 按钮门控、R1 对 §8.9 旧文字的处理与 R2 的 mutex 豁免范围。
