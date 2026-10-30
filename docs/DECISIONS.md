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

## D8 — 面板是静态单文件，不监听端口

状态：已定（2026-10-30），M0 实现时确定

`cowork ui` 把 `cowork snapshot --json` 的结果渲染成一个自包含 HTML 文件（无外部资源、无 CDN），
写到系统临时目录 `<tmp>/cowork-ui/<sha1(commonDir)>/index.html`（`--out` 可覆盖），打印路径；
只有显式 `--open` 才尝试调用系统默认浏览器，打开失败只警告、不影响已生成的面板。

理由：

- 架构书 §2 规定 CLI 是唯一运行时进程、不监听后台端口。起 HTTP 服务等于第二个常驻进程，
  还要处理端口冲突、进程生命周期和访问控制。
- 面板只消费 snapshot 的 JSON，不直接读/写 `.git/cowork`，也不调用任何写命令——它不是第二写者。
  重跑 `cowork ui` 即重新采样；`--watch` 下每隔几秒自动重采样，浏览器靠 meta refresh 重载。
- 展示文件不落仓库、不落 live 状态目录：既不弄脏 `git status`，也不需要任何清理逻辑。

`cowork ui --watch` 在这个形态上做实时化，不引入常驻服务：前台每 N 秒（默认 2 秒）重新做一次完整 snapshot，
原子重写同一个 HTML（先写 `<file>.tmp-<pid>` 再 `rename`，避免浏览器读到半截页面），并在页面里放
`<meta http-equiv="refresh" content="N">` 让浏览器自己重载。Ctrl+C 退出，退出时再写一次不带 refresh 的版本，
命令停了页面不会空转。间隔只能取整秒（meta refresh 的限制），取值 1..3600。

与 claim 抢锁的取舍：watch 每次采样仍走基础 mutex（临界区只读一遍 claims 目录，毫秒级），默认 2 秒一次；
与 `claim`/`release` 偶发等待（不到 1 秒）是可接受的代价，换来的是与写路径完全一致的读取语义。
若将来实测成为热点，再改为"读 claims 不加锁、靠单文件原子替换保证可见性"这类无锁读法，届时另立决策。

代价：实时性是轮询式（默认 2 秒）而非推送，且需要用户手动开着 `--watch` 进程；面板关闭期间不采集。

已知限制：进程被强杀（`taskkill /F`、断电、未捕获异常之外的信号）时来不及写“不带 refresh”的收尾版本，页面仍会按 meta refresh 继续重载，但数据停在最后一次成功采样。因此页头始终显示“数据截至 <时间>，进程停止后不会继续更新。”——看到的旧数据能被识别，而不是伪装成实时。正常退出（Ctrl+C、SIGTERM、SIGHUP、未捕获异常/未处理 rejection）都会先写一次收尾版本再退出；收尾写失败只警告，不改变退出码。


## D9 — M1 的 confirm-merge 只走 `--manual`

状态：已定（2026-10-30），M1 实现时确定

M1 的完成链路是 `ready → claimed → in_progress → reported_done → merged`。最后一步必须由
`cowork task confirm-merge <id> --commit <sha> --manual --reason <文本>` 显式完成：
`--manual` 与 `--reason` 缺一不可，`--commit` 必须是可解析的 sha。

理由：

- M1 不做自动验证（无 verifying / verify_failed / awaiting_merge 三态，见工作令 §13）。
  没有验证就自动合并，等于把"agent 说做完了"当成"做完了"。
- `--reason` 强制留下判断依据；`--manual` 让日志里能清楚区分"人确认"与将来的自动验证，
  不会在 M2 引入自动态后把两者的历史混在一起。
- 依赖只认 `merged`：没有这一步，上游任务永远停在 `reported_done`，下游拿不到。

代价：M1 的"完成"依赖 agent 或人主动确认，短期内无法全自动流转；这是刻意的。

## D10 — 任务 id 是不透明的哈希前缀

状态：已定（2026-10-30），M1 实现时确定

`task add` 生成的 id 形如 `t-1a2b3c`：`sha256(title + "
" + created_at + "
" + salt)`
的前 6 位十六进制。它与创建顺序、标题排序、时间都无单调关系，只用于稳定引用。

理由：

- id 会被写进 depends_on、notes、commit message。若按递增编号，两条车道并发创建会撞号；
  用哈希则天然去重（撞了换 salt 重试，最多 64 次）。
- 6 位足够在单仓库规模内保持低碰撞率，同时短到能在命令行里手打。
- 不透明意味着将来换生成策略（更长、不同算法）时，消费方不必改变假设——不要从 id 推断顺序。

代价：人不能从 id 看出创建先后；需要时看 spec 里的 `created_at`。

## P2 — 损坏的 live 状态归退出码 1，不是 3

状态：已定（2026-10-30，M1 验收复核后）

工作令 §10 原表把「live 状态损坏需人工」放在 exit 3（环境不满足）。实现与复核裁定都用 **1**：

- 退出码 3 的语义是「当前环境不具备运行条件」（不在 git 仓库、没有 git、路径越界）。损坏的
  live 文件不是环境问题，是状态数据问题；同一台机器上换个仓库就能正常工作。
- 1 是「一般错误」，调用方按「读到了坏数据，别继续」处理即可；doctor --fix 能隔离坏文件。
- 消息必须是 `任务状态文件损坏: <文件>（<原因>）`，调用方与脚本可以据此稳定匹配。

原表那一行已从 §10 的 exit 3 挪到 exit 1 并补上消息要求；这是文档向实现对齐，不是放宽。

## P4 — 锁外读 live/claims 是有界例外

状态：已定（2026-10-30，M1 验收复核后）

架构书要求「先经基础 mutex 取一致快照，再跑 Git 只读命令」。`next` 在锁外读了一次 catalog、
live 与 claims，用它们算候选集 `C`。这是有界例外，靠三条约束把风险关住：

1. `C` 只参与退出码判定（1 vs 2）与「有没有希望能领」的提示，**不参与任何写决策**；
2. 真正决定领谁、写 lease、写 claims 的，是锁内用同一 trunk commit 重算的 `C'`；
3. 锁外读到坏 live / 坏 claim 不得跳过或当成空集，必须 fail closed（exit 1），
   由 doctor 报告；`C` 与 `C'` 不一致时宁可退 2，不猜。

因此锁外读的只是提示性快照；写路径仍然完全在锁内，且不执行 git。

## P5 — `next` 不重验 trunk 移动，由 doctor 兜底

状态：已定（2026-10-30，M1 验收复核后）

`next` 在锁外把 trunk 固定 commit 的 catalog 读进内存，锁内不再跑 git（协议 §7）。因此从采样
到领取之间，trunk 若被推进，`next` 可能按稍旧的 catalog 领任务。这是刻意的降级：

- spec 进 `ready` 后不可改、id 由内容哈希决定，旧 catalog 与新 catalog 对已存在任务的
  touches/依赖判断一致；
- 依赖只认 `merged`，旧 catalog 最多让「刚 merged 的依赖」晚一轮才可见，不会把未 merged 的
  任务放出来；
- 兜底在 doctor：检查 lease 的 `spec_commit` 是否仍是 trunk 祖先、依赖是否存在/成环、
  live 是否损坏；任何一项异常都 exit 1，不静默通过。

代价是「严格线性一致」不成立；换来的是锁内不跑 git、临界区保持毫秒级。M2 如需强一致，
应把 catalog 的 commit 写进 intent 并在锁内校验，而不是把 git 塞进锁里。
