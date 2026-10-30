# AGENTS.md

本文件对所有在本仓库工作的 agent 生效（Codex、DSH、Claude Code 等）。

## 先读这个

- **目标规格**：[docs/PLAN.md](docs/PLAN.md) —— 需求、硬约束、验收标准、待决策清单。
  任何实现选择都要能对回这里的某一条。

## 项目定位（别扩散）

`cowork` 是**协调层**，不是调度器。

- ❌ 不做 agent 调度 / 任务队列 / 并行 fan-out
- ❌ 不做 Web UI / 桌面面板（CLI 优先，`--json` 供将来接 GUI）
- ❌ 不用 Docker / WSL / 后台守护进程
- ❌ 不修改 Codex、DSH 等 agent 的安装或二进制
- ❌ 不做 AST 级自动合并，冲突检测只到文件 + hunk 重叠

## 硬约束

1. **Windows 优先**。所有并发原语按 NTFS 语义验证，不许照搬 Linux 的 `flock`。
   hooks 走 `cmd /C`，不假设有 `sh`。
2. **DSH 文件沙箱**可能限制为仅 session workspace，因此 worktree 必须建在仓库内部
   （`.cowork/lanes/`），不能依赖 `../`。
3. **live 状态必须跨 worktree 共享**。默认落在 `$(git rev-parse --git-common-dir)/cowork/`；
   易失状态与可提交知识（`.cowork/notes/`）严格分离。
4. **命令名不能叫 `wt`**（已被 Windows Terminal 占用）。
5. Node ≥ 22，TypeScript strict。避免需要 MSVC 编译的原生依赖。

## 代码约定

- ESM，`node:` 前缀导入内建模块。
- 零运行时依赖优先；需要依赖时先在提交信息里说明理由。
- 退出码语义固定：`0` 成功 / `1` 一般错误 / `2` 被占用或冲突 / `3` 环境不满足。
- 错误信息必须包含**谁占着**和**怎么解决**，不允许只抛堆栈。

## 提交

- Conventional Commits：`feat:`、`fix:`、`docs:`、`test:`、`chore:`。
- 一个提交只做一件事；涉及 Windows 语义的修复要在提交正文写明复现路径。

## 自举

M0 完成后，用 `cowork` 管理 `cowork` 自身的开发——这是最好的压力测试。
