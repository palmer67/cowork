---
{
  "from": "dsh",
  "lane": "dsh/m0",
  "at": "2026-10-30T16:50:00+08:00",
  "task": "仓库迁移与车道指针修复（会话交接）",
  "files_touched": ["docs/PLAN.md", ".cowork/notes/2026-10-30-relocation.md"],
  "decisions": [
    "仓库从 default-workspace\\cowork 迁到 deepseek-harness\\cowork，与独立的 DSH 工作区对齐",
    "迁移后 worktree 的 .git 指针是绝对路径，必须手工改写，git worktree repair 单独跑修不了嵌套车道",
    "这个会话（旧工作区 agent）就此停手，后续由新工作区的会话接手"
  ],
  "next": [
    "cowork snapshot --json（lanes + 未提交改动）",
    "cowork ui 只读面板",
    "COWORK_AGENT_ID 默认从车道名推断，免去人工设置"
  ]
}
---

## 仓库搬过家

```
旧：D:\...\deepseek-harness\default-workspace\cowork
新：D:\...\deepseek-harness\cowork          ← DSH 工作区 cowork 指向这里
```

`.git/cowork/`（占位状态）随仓库一起搬过去了，没有丢失。

## 车道指针是手工修的

`worktree add` 写进车道 `.git` 文件的是**绝对路径**，仓库一搬就全指错，
`git worktree list` 会把车道标成 `prunable`。只跑 `git worktree repair` 不够，必须同时改：

- `<lane>/.git` → `gitdir: D:/.../cowork/.git/worktrees/dsh-m0`
- `<repo>/.git/worktrees/dsh-m0/gitdir` → 车道的新绝对路径

改完再 `git worktree repair` 才干净。**如果以后仓库还要搬，先停掉所有 agent**，
否则有 agent 正在车道里跑命令时改这些文件，会出现"仓库里一半文件不见了"的假象。

## 未推送的提交

网络故障（`schannel: failed to receive handshake`），本地领先远端两个提交：

- `f5b3545` docs: handoff for moving development into a dedicated DSH workspace
- `0add7c2` docs: record repo relocation out of the shared default workspace

网络恢复后执行：

```bash
git push origin HEAD:refs/heads/dsh/m0
git push origin main:refs/heads/main
```

## 接手的人注意

仓库根那条工作树 checkout 的是 `codex/task-layer-architecture` 分支，**不是 main**。
要在里面改代码，先 `cd .cowork/lanes/dsh-m0`，否则等于在 Codex 的分支上施工。
这正是本工具要拦的事，目前只能靠约定，等 `cowork status` 把当前工作树标出来以后就不用记了。
