# 代码评审：snapshot 与只读面板（4dd79fb / 2678dad）

评审对象：`src/snapshot.ts`（312 行）、`src/ui.ts`（294 行）、`test/snapshot.test.ts`、
`test/ui.test.ts`、`src/cli.ts` 的接线、`docs/DECISIONS.md` D8。

## 结论

质量比预期好：数据形状清晰、Git 调用与锁的边界分得对（锁外跑 git、锁内读 claims）、
空值不伪装成零值（`dirty: null` 而不是 `false`）、HTML 全部转义、CSP 收紧到 `default-src 'none'`。
27 个测试我本地跑过，全绿。真实仓库的 `snapshot --json` 输出与面板渲染都核对过。

主要问题只有一个，但它是需求级的：**面板不会自己刷新**。其余是健壮性与文档层面的欠账。

## P0 需求缺口：面板不会自动刷新

我在面板规格里定的是「2 秒刷新、开着就行」。现在：

- `cowork ui` 只写一次静态文件，没有 `--watch`；
- 生成的 HTML 里没有 `<meta http-equiv="refresh">`，也没有轮询脚本；
- CSP `default-src 'none'` 连 `fetch` 都禁了。

所以要看到新数据，用户必须**重跑 `cowork ui` 再手动按 F5**。这不是"刷新慢"，是"没有刷新"。
它和"打开一个窗口一直看着"的原始需求不是一回事。

修法（两件都要做，缺一不可）：

1. `cowork ui --watch [--interval 2]`：前台循环重写同一个文件，Ctrl+C 退出。
   不必起 HTTP 服务，也不违反"无后台守护进程"——进程在前台，谁看谁开。
2. 页面里加 `<meta http-equiv="refresh" content="2">`，让浏览器自己去读新文件。

配 1 之后必须同时改成**原子写**（写临时文件再 rename），否则浏览器可能正好读到写了一半的 HTML。
`src/store.ts` 的 claim 写入已经是 tmp+rename，照抄即可。

## P1 主工作树不在车道列表里

`snapshot()` 只保留 `.cowork/lanes/` 下的 worktree，主工作树被过滤掉了。
后果很具体：**Codex 现在就在主工作树里干活，它的未提交改动在面板上完全看不见**，
只有它显式 claim 过的文件才会以"占位"形式出现。

我们自己的使用场景里，主工作树是最活跃的那条，这等于面板少了一半画面。

建议：把主工作树作为一条特殊记录纳入 `lanes`（`lane` 用 `(main)` 或 `null` + 单独字段标出），
`dirty` / `changed_file_count` 照常统计；这样"每条工作树在改什么"才是完整的。

## P1 `readHandoffs` 缺少容错

`readdirSync(notesDir)` 没有 try/catch。`.cowork/notes` 存在但不可读（权限、被杀软锁住、
或者被换成同名文件）时，异常会冒到 `snapshot()` 顶层，整个快照和面板一起挂掉。

同一个函数里读文件是包了 try/catch 的，目录读取漏了，属于不一致。
按"一条车道坏了不影响整份快照"的原则，这里也该降级成跳过。

## P2 最近交接的排序比较器可能返回 NaN

```ts
const byTime = timeValue(b.created_at) - timeValue(a.created_at);
return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
```

`timeValue` 对无法解析的时间返回 `-Infinity`。两份都无时间时是 `-Infinity - (-Infinity)` = `NaN`，
`NaN !== 0` 为真，比较器返回 NaN，排序结果未定义（V8 不保证任何顺序），id 兜底反而走不到。

改成先判断两边是否都是有效时间，无效就退回 `id` 比较。

## P2 每次快照都抢一把全局互斥锁

`readClaims` 用 `withLock` 包住 `listClaims`，注释说"不创建状态目录"，但锁目录是在
state 目录里 mkdir 出来的。逻辑上没错（state 不存在时提前返回），但含义要说清：
**每刷新一次面板就抢一次互斥锁**。压测里 8 进程竞争最长等 290ms，如果 `--watch` 每 2 秒刷一次，
它会稳定地和真正的 `claim` 抢锁。

两个选择，任选其一并写进 D8：

- 读 claims 不必持锁：`claims/` 目录里的文件是原子 rename 写进去的，逐个读已经是安全快照；
- 持锁但把 `--watch` 的默认间隔拉到 5 秒以上，并在文档里写明这个代价。

## P2 `repo.head` 的语义

面板顶部显示 `HEAD 8af301f`，取的是主工作树的 HEAD。现在主工作树在
`codex/task-layer-architecture` 上，读者很容易把它当成"仓库主干在这"。
建议改名为"当前工作树 HEAD"，或者改取 `trunk` 的 HEAD。

## P3 其余

- `tasks` / `contract_alerts` 声明为 `unknown[]`。M1 落地时形状会变，建议现在就给具体类型
  （哪怕空数组），否则"数据形状不用动"的约定守不住。
- `parseStatusCount` 里 `token.slice(3)` 硬编码了 `"XY "` 三字符前缀，正确但脆，加个常量或注释。
- `openPanel` 在 Windows 用 `cmd /c start "" <path>`，`--out` 指向含空格路径时未验证；
  建议补一条手测，或改用 `explorer.exe <path>`（参数直接传，少一层 cmd 解析）。
- `ui` 没有 `--watch` 之外的退出码测试：写不出文件时是否 exit 3 值得钉住。

## 已验证（不是推测）

- `npm test` → 27 passed / 0 failed（我在车道里实跑）。
- `cowork snapshot --json` → 车道 `dsh-m0`、`head 2678dad`、`dirty false`、
  最近交接 `2026-10-30-panel-done`，与仓库实际一致。
- `cowork ui --out` → 用两条真实临时占位渲染并截图核对：暗色主题、中文、备注与 pid 正常，
  过期时间显示为次日同一时刻（TTL 24h 生效）。
- 评审用的临时占位已 `release`，预览文件已删除，工作区干净。
