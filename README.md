# cowork

**让多个 AI agent 在同一个 git 仓库里并行干活，互不踩脚，还能相互接力。**

Codex、Claude Code、DSH 这类 agent 各自有独立上下文，却共享同一个文件系统——后写的静默覆盖先写的，冲突在 merge 时才暴露。`cowork` 在它们之间补一层轻量的协调协议：

- **隔离靠 worktree** — 每个任务一个独立工作区，物理上写不到一起
- **秩序靠 claim + guard** — 文件级占用声明，配 git hook 硬拦截
- **互补靠 handoff** — 收工写结构化交接单，开工自动读

它**不是**调度器，**不**碰容器，也不是写操作后台：只读看板是 P0，但看板只消费 `cowork snapshot --json`，唯一写者仍然是 CLI。

## 状态

> M0 已实现并已自举：`claim` / `release` / `status` / `doctor`，以及只读快照与面板（`snapshot`、`ui`）。
> M1 任务层尚未开始。目标规格见 [docs/PLAN.md](docs/PLAN.md)。

## 为什么再造一个轮子

现有方案在同一台 Windows 机器上都不成立：worktree 工具只解决隔离、不解决知情；编排面板要么已停更（vibe-kanban 于 2026-04 停止运营、crystal 改名后停滞），要么依赖 tmux / WSL / Docker（claude-squad、container-use）。空白点是**跨厂商、文件级、零守护进程**的协调层。

## 快速开始

要求 Node ≥ 22.6（本仓库用 `--experimental-strip-types` 直接跑 TypeScript）。

```bash
npm i -g cowork            # 或在本仓库里 npm link
cowork init                # 建 .cowork/ 配置，并把 .cowork/lanes/ 写进 .gitignore
cowork claim src/auth/**   # 声明占用（目录自动按前缀处理）
cowork status              # 看当前所有占位
cowork release src/auth/** # 释放占位
```

车道是仓库内部的 worktree（`.cowork/lanes/<名字>`），live 状态在 `<git-common-dir>/cowork/`，所有车道共享：

```bash
git worktree add .cowork/lanes/fix-login -b fix/login
cd .cowork/lanes/fix-login
cowork claim src/auth/**
```

只读面板：静态 HTML，不监听端口，重跑即可刷新。

```bash
cowork snapshot --json   # 面板的唯一数据源（车道、未提交改动、最近交接、占位）
cowork ui --open         # 渲染到系统临时目录并打开浏览器；--out 可指定路径
```

规划中的命令（M1+）：`cowork lane new`、`cowork brief`、`cowork handoff`、`cowork merge --dry-run`。

## 文档

- [目标计划（需求、约束、验收标准）](docs/PLAN.md)
- [架构（路径、claim、worktree、测试门槛）](docs/ARCHITECTURE.md)
- [任务层协议（snapshot 契约、任务对象）](docs/ARCHITECTURE-TASKS.md)
- [已定决策](docs/DECISIONS.md)

## 许可证

MIT
