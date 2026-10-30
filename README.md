# cowork

**让多个 AI agent 在同一个 git 仓库里并行干活，互不踩脚，还能相互接力。**

Codex、Claude Code、DSH 这类 agent 各自有独立上下文，却共享同一个文件系统——后写的静默覆盖先写的，冲突在 merge 时才暴露。`cowork` 在它们之间补一层轻量的协调协议：

- **隔离靠 worktree** — 每个任务一个独立工作区，物理上写不到一起
- **秩序靠 claim + guard** — 文件级占用声明，配 git hook 硬拦截
- **互补靠 handoff** — 收工写结构化交接单，开工自动读

它**不是**调度器，**不是**看板，**不**碰容器。它是"占位与交接"的协议实现。

## 状态

> 设计阶段。目标规格见 [docs/PLAN.md](docs/PLAN.md)，M0 尚未实现。

## 为什么再造一个轮子

现有方案在同一台 Windows 机器上都不成立：worktree 工具只解决隔离、不解决知情；编排面板要么已停更（vibe-kanban 于 2026-04 停止运营、crystal 改名后停滞），要么依赖 tmux / WSL / Docker（claude-squad、container-use）。空白点是**跨厂商、文件级、零守护进程**的协调层。

## 快速开始（规划中）

```bash
npm i -g cowork

cowork init                                  # 把仓库变成协作仓库
cowork lane new fix-login --agent codex      # 开一条车道（独立 worktree）
cowork claim src/auth/**                     # 声明占用
cowork brief                                 # 开工前看现状
cowork handoff --task "..." --next "..."     # 收工写交接单
cowork merge fix-login --dry-run             # 合并前预检
```

## 文档

- [目标计划（需求、约束、验收标准）](docs/PLAN.md)

## 许可证

MIT
