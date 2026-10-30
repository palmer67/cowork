# 已定决策

> 本文件记录已拍板的选择，供架构设计直接引用，避免反复讨论。
> 新决策往下追加，不要改动历史条目（要推翻就标 Superseded 并写明原因）。

## D1 — 工具名 `cowork`

状态：已定（2026-10-30）

命令名不能叫 `wt`（与 Windows Terminal 的 `wt.exe` 冲突）。`cowork` 作为命令行名词与项目名统一。
若将来发布 npm 包遇到占名，改用 scoped 包名 `@palmer67/cowork`，不影响命令名。

## D2 — 首个接入仓库 = 本仓库（自举）

状态：已定（2026-10-30）

`https://github.com/palmer67/cowork`，private，MIT。
M0 完成后先用 `cowork` 管理 `cowork` 自身的开发（验收 1/2/6 可在本项目内真实跑通）。

## D3 — live 状态放 `$(git rev-parse --git-common-dir)/cowork/`

状态：已定（2026-10-30），待架构书确认实现细节

即主仓库 `.git/cowork/`。理由：

- worktree 是独立 checkout，被 gitignore 的文件**不会**被复制过去，因此 live 状态若放在
  `.cowork/live/`，每个 lane 会各持一份，跨 lane 可见性直接失效。
- 放在 git-common-dir 天然被所有 worktree 共享且只有一份。
- 不进 `git status`，不会被误提交、不污染 diff。

代价：人不能靠 `ls` 看见，可观测性必须由 `cowork status` / `brief` 承担（这是硬要求，不是可选）。
若架构书能给出更优方案，需要正面论证这三个理由如何被更好的方案覆盖。

## D4 — 可提交知识与易失状态严格分离

状态：已定（2026-10-30）

- `.cowork/notes/`：交接单、决策、接口契约 —— **提交进 git**，是团队共享的知识资产。
- live 状态（claims / heartbeat）—— **永不入库**。

理由：live 状态每次心跳都变，入库会产生噪音 diff 并制造合并冲突。

## D5 — 运行环境基线

状态：已定（2026-10-30，实测）

| 项 | 值 |
|---|---|
| OS | Windows（NTFS），PowerShell 7 + cmd 均需可用 |
| Node | v22.14.0 |
| npm | 10.9.2 |
| git | `D:\Git\cmd\git` |
| Docker | 存在但引擎未启动 —— **本方案不使用** |
| agent 接入方式 | 不改二进制；只通过 AGENTS.md、git hook、CLI、（可选）MCP server |

## D6 — 许可证 MIT

状态：已定（2026-10-30）

私人仓库同样附 MIT；早期定好，避免将来开源时需追溯全部历史贡献者授权。

## D7 — claim 存活语义：TTL，不是 pid

状态：已定（2026-10-30），M0 实测后修正

原架构书 §3.2 用「owner 进程还活着」判断 claim 是否有效。M0 的 e2e 推翻了这个前提：
CLI 每次调用都是新进程，`cowork claim` 一退出 pid 就死，下一条命令立刻把它当残留清掉，
占位形同虚设（复现：A 占位后，B 立刻成功抢占同一文件，exit 0）。

改为：有效性只看 `createdAt + ttlMs`（默认 24h，`COWORK_CLAIM_TTL_HOURS` 覆盖）。
pid 只用于展示与审计，不再参与判定。崩溃回收依靠过期 + `doctor --fix` + 人工 `release --force`。
