---
{
  "from": "dsh",
  "lane": "dsh/m0",
  "at": "2026-10-30T22:05:00+08:00",
  "task": "第二轮评审修复：mutex 回收、损坏状态、车道/长路径、诊断、退出码、watch 收尾与测试清理",
  "files_touched": [
    "src/mutex.ts",
    "src/store.ts",
    "src/claims.ts",
    "src/paths.ts",
    "src/cli.ts",
    "src/snapshot.ts",
    "src/ui.ts",
    "test/mutex.test.ts",
    "test/store.test.ts",
    "test/paths.test.ts",
    "test/claims.test.ts",
    "test/snapshot.test.ts",
    "test/ui.test.ts",
    "test/helpers.ts",
    "docs/ARCHITECTURE-TASKS.md",
    "docs/ARCHITECTURE.md",
    "docs/DECISIONS.md"
  ],
  "decisions": [
    "mutex 回收只认“能证明持有者已死”：owner.json 缺失且目录超过 5 秒宽限，或本地 pid 已不存在；锁年龄不再参与判定，避免慢持有者或跨主机场景被误抢",
    "释放锁前核对 owner token：锁已被回收时只警告“本次未独占”，绝不删除别人的锁目录",
    "损坏的 live 状态文件是错误而不是“没有占位”：readClaim 抛退出码 1 并指出文件，doctor --fix 隔离到 trash/ 后逐条报告；只有真正的环境前置条件缺失才是 3",
    "realpath 失败时先解析最近的已存在祖先再判越界，junction/符号链接逃出车道根仍然退出 3，不把“解析不了”当成通过",
    "snapshot 一律先取基础 mutex 再读 claims；createStateDir=false 保证只读采样不会创建 live 目录（目录恰在采样瞬间被创建的竞态下按空表处理，下一轮自然恢复）",
    "车道过滤按路径段判断而不是 startsWith('..')，合法车道名可以叫 ..hidden；git status 带 -c core.longpaths=true，失败仍给 error 并保持 dirty/count=null",
    "交接单读取失败不静默：handoff_diagnostics 列出文件级原因，notes 目录不可读时额外给 lane error；坏文件不影响仍可解析的最近交接",
    "watch 在 SIGINT/SIGTERM/SIGHUP/未捕获异常/未处理 rejection 下都先写一次不带 refresh 的收尾版本再退出；收尾写失败只警告、不改变退出码；页头始终标注数据时间",
    "测试清理统一 removeTree（maxRetries/retryDelay）并在删目录前 git worktree remove --force，避免 .git 里残留句柄导致 ENOTEMPTY"
  ],
  "next": [
    "M1 任务层：cowork task / cowork next；snapshot 的 tasks 与 contract_alerts 仍是空数组",
    "Windows 长路径的真实场景未在本机验证：需要开启 LongPathsEnabled 的 Windows 和超过 260 字符的路径；本机只验证了 git status 带 -c core.longpaths=true 后普通仓库仍正常。复现路径：在启用长路径的机器上把某个 lane 的未跟踪文件放进 >260 字符目录，再跑 cowork snapshot --json，该 lane 应仍能给出 dirty 与文件数，而不是 error",
    "ENOTEMPTY/EPERM 在本机没有复现（清理已加固为预防）；真实杀软/索引器占用需在目标机器上测",
    "Windows 真实 Ctrl+C 需要人工在终端验证：Node 无法用 child.kill('SIGINT') 在 Windows 模拟控制台中断；SIGTERM/SIGHUP 路径已由代码与单元测试覆盖收尾逻辑"
  ]
}
---

# 第二轮评审修复（2026-10-30）

## 现在在哪

评审 12 条全部落地，按 A–F 分组提交：A `141350f`、B 紧随其后、C `23b688d`、
D `060bb82`、F `1dbaea8`，测试组与文档单独提交。`npm test` 48 个测试全绿且整体退出 0，
`npx tsc -p tsconfig.json --noEmit` 干净。

## 关键取舍

- 锁只按“证明已死”回收。之前 acquiredAt 超过 staleMs 就回收，等于假设临界区一定短；
  慢机器、杀软扫描或跨主机时会把活着的持有者踢掉，两个进程同时进临界区。
- 损坏状态是 1 不是 3。3 表示“这台机器/仓库现在不适合跑”，而坏文件是数据问题，
  应该指出来并给出 `doctor --fix`。
- 只读采样不建 live 目录。watch 每 2 秒跑一次，如果为了读而 mkdir，等于让只读命令
  成为第二写者；代价是目录刚出现时的极小竞态窗口（读空表，下一轮恢复）。
- 交接单诊断挂在车道上而不是整份快照上：一条车道 notes 坏了不该让面板看不到别的车道。

## 已知限制

- 长路径修复只覆盖“调用 git 时带 core.longpaths”；真实 >260 字符路径需要目标机器
  开启 LongPathsEnabled，本机没有这个环境，故未做端到端验证（见 front matter next）。
- 强杀（taskkill /F）来不及写收尾版本时页面仍会按 meta refresh 空转，数据停在最后一次
  成功采样；页头“数据截至 …，进程停止后不会继续更新。”让旧数据可被识别。
