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

