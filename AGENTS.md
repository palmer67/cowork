# AGENTS.md

本文件对所有在本仓库工作的 agent 生效（Codex、DSH、Claude Code 等）。

## 先读这个

- **目标规格**：[docs/PLAN.md](docs/PLAN.md) —— 需求、硬约束、验收标准、待决策清单。
  任何实现选择都要能对回这里的某一条。

## 项目定位（别扩散）

`cowork` 是**协作纪律层**：包含由人和 agent 共同拆解、人工录入的任务队列，负责依赖、占位和汇总；任务判断与拆解智能留在 agent 侧。

- ❌ 不自动拆解任务、不做 LLM 调度、不启动或推送任务给 Codex/DSH 等 agent；agent 通过拉模式调用 `cowork next` 自行领取
- ❌ 不做自动 fan-out；并行边界只由依赖、touches、claim 规则确定
- ✅ 只读看板是 P0；数据只经 `cowork snapshot --json` 提供，唯一写者仍是 CLI；不做写操作后台，不用 Electron
- ❌ 不用 Docker / WSL / 后台守护进程
- ❌ 不修改 Codex、DSH 等 agent 的安装或二进制
- ❌ 不做 AST 级自动合并，冲突检测只到文件 + hunk 重叠

任务对象、领取、并行和完成协议见 [docs/ARCHITECTURE-TASKS.md](docs/ARCHITECTURE-TASKS.md)。底层路径与 claim/mutex 规则继续以 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §3 为准。

## 硬约束

1. **Windows 优先**。所有并发原语按 NTFS 语义验证，不许照搬 Linux 的 `flock`。
   hooks 走 `cmd /C`，不假设有 `sh`。
2. **DSH 文件沙箱**可能限制为仅 session workspace，因此 worktree 必须建在仓库内部
   （`.cowork/lanes/`），不能依赖 `../`。
3. **live 状态必须跨 worktree 共享**。默认落在 `$(git rev-parse --git-common-dir)/cowork/`；
   易失状态与可提交知识（`.cowork/notes/`）严格分离。
4. **命令名不能叫 `wt`**（已被 Windows Terminal 占用）。
5. Node ≥ 22，TypeScript strict。避免需要 MSVC 编译的原生依赖。

## 占位的存活语义

claim 的存活**只由 TTL 决定**，与进程 pid 无关：每次 `cowork claim` 都是一次独立的短命进程，
用 pid 判断「agent 还在不在」会把刚占好的位当成残留清掉（M0 实测踩过，见 DECISIONS D7）。

- 默认 TTL 24 小时，`COWORK_CLAIM_TTL_HOURS` 可覆盖；`cowork status` 显示过期时间
- 过期后任何命令都会顺手回收；`cowork doctor --fix` 可立即清理
- `cowork release` 只释放本工作树本 agent 的占位；确有 agent 崩溃时，由人运行
  `cowork release --force <路径>`（会打印原占用者）
- 两个 agent 共用一个工作树时，各自设 `COWORK_AGENT_ID=codex` / `COWORK_AGENT_ID=dsh`，
  否则会被当成同一个 owner 而不互斥
- claim 的事务语义：多个路径要么全部占上，要么一条都不写

## 文件读写（DSH 写保护）

DSH 默认装了写保护插件（`dsh-fs-observation-policy`）：**覆盖或编辑已存在的文件之前，本会话必须先用 `read` 工具读过它**。用 shell（`cat`、`Get-Content`、`node -e`）读不算观察记录；观察记录也不跨会话继承，恢复或新开的会话等于没读过。

- 改已有文件：先 `read`，再 `edit` / `write`。不要「shell 看一眼 → 直接写」。
- 新建文件：直接 `write`；如果目标可能已存在，先 `read` 一次。
- 看到 `cannot modify "<path>": file has not been read` 是保护机制触发了，不是命令写错：读一次再重试即可。
- 不要为了绕过它去关插件或改用 shell 重定向写文件——那等于放弃覆盖保护。

## 代码约定

- ESM，`node:` 前缀导入内建模块。
- 零运行时依赖优先；需要依赖时先在提交信息里说明理由。
- 退出码语义固定：`0` 成功 / `1` 一般错误 / `2` 被占用或冲突 / `3` 环境不满足。
- 错误信息必须包含**谁占着**和**怎么解决**，不允许只抛堆栈。

## 提交

- Conventional Commits：`feat:`、`fix:`、`docs:`、`test:`、`chore:`。
- 一个提交只做一件事；涉及 Windows 语义的修复要在提交正文写明复现路径。

## CI（自动化门禁）

- 任意分支 push 都会在 GitHub Actions 的 `windows-latest` 上跑门禁：
  `npm test` → `npx tsc --noEmit` → `npm run build` → `node tools/accept-m1.mjs`
  → `node tools/accept-panel.mjs`。配置在 `.github/workflows/ci.yml`。
- 实现方**报完成之前先看 CI**：`gh run list --branch <你的分支> --limit 1`，贴出那次运行的链接与结论。
  红的不许说"完成"；红的原因要么修掉，要么在交接单里写清"已复现、待谁处理"。
- 判官合并前仍会在合并树上本地重跑一遍——CI 绿只说明那份提交在 runner 上过，不替代合并后的复验。
- 每周一 11:17（北京时间）额外跑 20 轮多进程压测；要立刻复现竞态，可手动
  `gh workflow run ci.yml`。
- 推送即触发，所以不要为了"看看 CI"去推半成品到 `main`；在自己的车道分支上推即可。

## 工作副本

- 仓库根（`D:\...\cowork`）只作为**查看与合并的视口**：默认停在 `main`，可能处于 detached HEAD。
  不要在里面改代码，不要在里面提交。
- 每个 agent 在自己的车道里干活：

  ```
  git -C "<仓库绝对路径>" worktree add ".cowork/lanes/<slug>" -b <分支名> origin/main
  cd "<仓库绝对路径>/.cowork/lanes/<slug>"
  ```

- 开工前先确认 `pwd` 在车道里、`git log --oneline -1` 是最新的；别人可能刚推了新提交。

## 分工

- **大量代码实现交给 Codex**：功能开发、重构、批量修复、测试补齐，都在 Codex 自己的车道里写。
- **评审、定分歧、跑验收、合 main 交给 DSH（判官）**：DSH 不写实现代码，只读、验、判、合。
- 实现方自测全绿只证明「某份代码能过」，不能替代独立复验；判官在合并树上重跑门禁。
- 判官发现问题是打回或写裁定，不替实现方改代码；确有阻塞时写清复现命令与期望行为。

## 自举

M0 完成后，用 `cowork` 管理 `cowork` 自身的开发——这是最好的压力测试。
