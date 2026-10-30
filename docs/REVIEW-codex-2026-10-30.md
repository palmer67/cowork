# 独立评审：snapshot 与只读面板

评审基线：`dsh/m0` 的 `e12eb7d4f3fa708bf23fe176485a469d34e72398`。评审工作树：`codex/review`。

## 结论

`snapshot` 的 lane/claim 字段与 ARCHITECTURE-TASKS.md §8 大体一致；`ui` 生成静态单文件、不监听端口、无外部资源，也符合 DECISIONS.md D8。任务和契约字段目前为空数组，与 M1 尚未实现的占位一致。

实现目前不宜通过：mutex 会按年龄回收仍由活进程持有的锁，旧持有者还会无条件删除新持有者的锁；损坏 claim 被静默忽略；外部 junction 下尚不存在的叶子可绕过越界检查。另有快照漏读竞争、路径枚举、长路径和 HTML 转义问题。

## P1：高风险

### P1-1 mutex 可回收活锁，旧持有者可删除新锁

`src/mutex.ts:80-95` 在 owner PID 仍存活时，仍会因 `acquiredAt` 超过 `staleMs` 判 stale；默认门槛为 60 秒。`src/mutex.ts:149` 的释放路径不核对 owner token，直接递归删除固定 lock 目录。ARCHITECTURE.md §3.1 明确要求按进程身份回收，不能只凭锁龄回收。

复现：临时仓库中启动进程 A，以 `staleMs=20ms` 持锁 500ms；进程 B 延迟 50ms 竞争，以相同阈值持锁 1200ms。B 会回收仍存活的 A 并进入；A 结束时删除 B 的 lock 目录。随后进程 C 用 `staleMs=5000ms` 进入时，B 仍存活。实测结果：`bAliveAfterARelease=true`、`lockExistsAfterARelease=false`、`cEnteredWhileBAlive=true`。缩短阈值只为快速重现同一代码分支；生产默认值为 60 秒。

### P1-2 坏 claim JSON 被当成不存在，冲突检查 fail-open

`src/store.ts:64-71,88-98` 将 JSON 解析错误转换成 `null`，`listClaims` 随即跳过记录。ARCHITECTURE.md §3.10 要求损坏状态 fail closed。

复现：临时仓库先 `cowork claim src/shared.ts`，把对应 common-dir claims JSON 改成 `{ broken`，再设置 `COWORK_AGENT_ID=second-agent` 执行相同 claim。第二次退出 0 并创建新 claim；损坏记录仍在目录中，但 `listClaims` 和 snapshot 都看不到它。

### P1-3 junction 中缺失叶子绕过仓库越界检查

`src/paths.ts:56-65` 对完整路径 `realpath` 失败时直接返回逻辑输入，没有按 §3.2 解析最近存在的父目录。外部 junction 中尚不存在的文件因此不会进入越界分支；ARCHITECTURE.md §3.2 要求此类路径拒绝并以 3 退出。

复现：在临时仓库创建 `escape` junction 指向仓库外临时目录，确保外部 `new.ts` 尚不存在；在仓库根执行 `cowork claim escape/new.ts`。实测命令输出“已占位 escape/new.ts”，原生退出码 0。该逻辑键日后写入会落到仓库外目标。

## P2：需要修正

### P2-1 HTML 的 `claim.pid` 未转义，CSP 允许该注入

`src/ui.ts:113` 将 `claim.pid` 直接拼入 HTML；live JSON 由 `JSON.parse` 后直接类型断言，没有运行时 schema 校验。CSP（`src/ui.ts:187`）为静态过滤脚本开放了 `script-src 'unsafe-inline'`，因此不能阻挡注入的 inline script。其余字符串插值点均经过 `escapeHtml`；数字计数由本模块计算。

复现：在临时仓库先产生一条 claim，再把记录的 `pid` 改成 `</div><script>document.title="INJECTED"</script><div>`，执行 `cowork ui --out <临时文件>`。生成 HTML 原样包含该 `<script>`，同时含 `unsafe-inline`。未打开该文件执行脚本。

### P2-2 首次 claim 与 snapshot 并发时会漏掉已完成的 claim

`src/snapshot.ts:269-272` 在 mutex 外用 `existsSync(state)` 判断是否跳过锁。首次 claim 恰好在该检查返回 false 后创建 state 并完成写入，snapshot 仍直接返回空 claims；这违反 ARCHITECTURE.md §3.1“所有 live 状态读取都通过同一 mutex”。

复现：临时仓库中包装 `fs.existsSync`，当它对 state 根首次返回 false 时同步启动并等待 `cowork claim race.txt` 子进程完成，再让检查仍返回 false。实测 live claims JSON 数为 1，而同一次 snapshot 的 `claims` 长度为 0。state 已存在时，实际 claim 集合读取会在同一 mutex 内完成；Git status 不在锁内。

### P2-3 合法 lane 名以 `..` 开头时被错误过滤

`src/snapshot.ts:297-298` 用 `rel.startsWith('..')` 判断越界，而不是检查 `..` 路径段。合法路径 `.cowork/lanes/..hidden` 得到相对值 `..hidden`，会被过滤。

复现：临时仓库执行 `git worktree add .cowork/lanes/..hidden -b dot-hidden`；`git worktree list --porcelain` 能列出该工作树，但 `snapshot.lanes` 为空。检查的是路径段边界，不应把普通名称前缀当成父目录。

### P2-4 默认 Git 长路径配置下 snapshot 会报“干净”

lane 中创建未跟踪文件，绝对路径长度 311 字符，且 `core.longpaths` 未配置时，Git 2.52.0.windows.1 的 `status --porcelain=v1 -z --untracked-files=all` 警告 `Filename too long` 但输出为空。snapshot 因而给出 `dirty=false`、`changed_file_count=0`，不是错误或未知状态。设置 `core.longpaths=true` 后同一文件可被 status 列出。ARCHITECTURE.md §6 要求超过 260 字符时成功统计或明确报错；ARCHITECTURE-TASKS.md §8 不允许用 0 掩盖读取失败。

复现：临时仓库加 lane，在 lane 下创建绝对路径约 311 字符的未跟踪文件；分别在 `core.longpaths` unset 与 `true` 时运行 snapshot。前者显示干净，后者的 Git status 显示该文件。

### P2-5 notes 不可枚举时会静默丢 handoff 或让整份 snapshot 失败

`src/snapshot.ts:141-145` 的 `existsSync(notesDir)` 对无访问权限可能返回 false 并被当成“没有 notes”；若目录属性可读但列目录权限被拒，未捕获的 `readdirSync` 异常会使整条 snapshot 退出 1。两种情况都没有按 ARCHITECTURE-TASKS.md §8 为 lane 输出 `error` 和不可得字段。

复现：临时 lane 的 `.cowork/notes/` 下放一份 handoff，对目录用 `icacls <notes> /deny *<当前用户 SID>:(RD)` 拒绝列目录，然后执行 `cowork snapshot --json`；实测报 `EPERM: scandir`、退出 1，未返回 lane 级错误。若同时拒绝读取属性，`existsSync` 会走 false 分支，命令退出 0 但 handoff 为空。测试后移除临时目录上的 deny ACE。

### P2-6 I/O 错误的退出码与架构定义不一致

ARCHITECTURE.md §3.1/§5 将权限和 I/O 错误规定为 1，环境前置条件才是 3。`src/mutex.ts:57-64` 把锁目录创建失败（含权限错误）映射为 `EXIT.ENV`；`src/ui.ts:256-264` 也将面板文件写入失败映射为 `env`。临时仓库中 `cowork ui --out <现有目录>` 的原生退出码实测为 3，而 §5 定义应为一般 I/O 错误 1。锁目录 ACL 拒绝创建的临时仓库复现同样为 3。锁竞争超时退出 2、Git 环境错误退出 3、意外异常退出 1；`--open` 失败只警告并返回 0 符合 D8。

### P2-7 损坏/不完整 handoff 会被隐藏或接受

`src/snapshot.ts:122-183` 对坏 front matter、坏 JSON、缺失 `lane` 的文件静默跳过；但只含 `{"lane":"alpha"}` 的 JSON front matter 会被接受，id 取文件名、`created_at=null`，不产生 lane `error`。这不是 D8 的明确反例，但看板无法区分“没有 handoff”和“handoff 格式损坏”，且 schema 没有验证。建议至少加入显式错误/诊断语义。

复现：在 lane 的 `.cowork/notes/` 写入 `---\nnot-json\n---`，snapshot 返回成功、handoff 为空、无 error；再写入 `---\n{"lane":"alpha"}\n---`，返回该文件名作为 id、时间为 null。

### P2-8 两个无效 handoff 时间使 ID 排序兜底失效

`src/snapshot.ts:205-208` 以时间差排序；无效时间被 `timeValue()` 转成 `-Infinity`，两个无效时间相减得到 `NaN`。因此 `byTime !== 0` 为真，比较器直接返回 `NaN`，不会比较 ID。按 JavaScript 排序规则，`NaN` 被视作相等；稳定排序会保留输入顺序，结果因而取决于文件枚举顺序，不满足 §8 要求的 ID 确定性排序。

复现：在临时 lane 的 `.cowork/notes/` 创建 `a.md`（`id=z-id`）和 `b.md`（`id=a-id`），两份 front matter 都用相同 `lane` 且 `createdAt="not-a-time"`；在本机观察到目录枚举为 `a.md,b.md`，运行 `cowork snapshot --json` 返回 `a-id`，而同时间按 ID 倒序应返回 `z-id`。由于比较器未执行 ID 兜底，首条枚举记录会被保留为结果。

## 逐项核对

退出码：2 用于锁超时/冲突的主路径正确；Git/仓库条件 3、一般异常 1 正确。坏 live JSON 被当成功、坏 handoff 被当成功、notes 访问被当成功或整份失败；锁和 panel 写入 I/O 则错误地返回 3。部分 lane Git status 失败时，snapshot 保留 lane `error` 且整体返回 0，作为部分快照可接受，但需要在 CLI 契约里明确。

Mutex 边界：没有在 mutex 内运行 Git；live claims 文件枚举在 mutex 内。例外是 mutex 外的 state 根存在性探测，已通过首次 claim 交错复现漏读。lane Git status、handoff notes 都在锁外读；其中 Git 字段带 `observed_at`，其非原子采样符合 §8，notes 访问错误处理不符合。

claim 与 snapshot 交错：state 已存在且两命令均已进入 mutex 路径时，claim 文件集合读写串行；snapshot 可能在释放锁后继续采样 Git，故 claim 集合与 lane `dirty` 不保证同一瞬间，§8 已允许逐 lane 的非原子采样。首次创建 live state 的竞态见 P2-2。

Windows 路径：测试覆盖 `/`、反斜杠、前导 `./`、ASCII 大小写和跨 lane 逻辑键；这些已验证。junction 越界叶子、lane 名 `..hidden` 和默认长路径已复现失败。8.3 别名、Unicode `$UpCase` 完整映射、跨卷/非 NTFS 与 junction 的其他方向没有本次测试覆盖；`src/paths.ts` 使用 `toLowerCase()`，没有实现 §3.2 要求的 NTFS `$UpCase` 权威规则，不能据现有 ASCII 测试声称覆盖 Unicode 等价性。

工作树 prune：删除 lane 目录但保留 Git 登记时，snapshot 输出该 lane 的 `error` 且 `dirty=null`；执行 `git worktree prune --expire=now` 后，该 lane 从 `git worktree list` 消失，snapshot 也完全不再输出它。此行为来自枚举来源，但 prune 后没有 lane 级历史行；若 live claim 尚在，claims 仍可能显示该 owner。

## 测试覆盖缺口

- mutex 活 owner 超时回收、旧 owner 释放新 owner 锁、锁目录权限错误和坏 owner JSON；现有测试无 mutex 专用文件。
- 首个 state 创建与 snapshot 并发、坏 claim JSON/错误 schema、快照与 claim 同时更新。
- 坏 handoff front matter/JSON/schema、notes 无读取/列目录权限、同时间 handoff id 排序。
- `.cowork/lanes/..hidden`、junction/8.3、Unicode `$UpCase`、跨卷/非 NTFS、默认 `core.longpaths` 下的长路径。
- `claim.pid` 注入与 CSP；HTML 字符转义测试目前覆盖 note/title/error 等文本，但未覆盖 pid。
- CLI `snapshot --json` / `ui` 的端到端接线、`--out` 写入失败码、`--open` 成功/失败；现有 UI 测试直接测 render/write helper。
- prune 之后 lane 消失及其可能遗留的 claim 展示。

现有覆盖已验证普通 lane 的 branch/HEAD/dirty/count、detached HEAD、worktree 目录缺失、有效 handoff、rename 计数、无 live store 时不创建状态目录、已有 store 时在 mutex 内读取 claim，以及常见 HTML 字符转义。

## 验证结果

- `npx tsc --noEmit`：通过。
- `npm test`：进程退出 1；29 个测试单元中 27 通过、2 个文件级 `after` hook 失败。失败分别位于 `test/claims.test.ts:41` 和 `test/snapshot.test.ts:73`，都是 `rmSync` 清理临时仓库时报 `.git` `ENOTEMPTY`。本机 Node `v22.14.0`、Git `2.52.0.windows.1`；残留 `.git` 下发现零字节 ReparsePoint，`fsutil reparsepoint query` 返回找不到文件。尚未确定其产生原因；两文件的业务断言均已通过。
- 手工临时仓库复现：mutex 活锁、首次 claim/snapshot 竞态、坏 claim JSON、junction 外部未存在叶子、`..hidden` lane、长路径、ACL notes 访问、坏 handoff、prune 与 pid HTML 注入。

## 分歧与遗漏

### 与既有评审的分歧

- **“2 秒自动刷新”不是当前规格要求。** `docs/PLAN.md` 没有该刷新间隔；DECISIONS.md D8 明确约定静态文件，重跑 `cowork ui` 后刷新浏览器，并把 `snapshot --watch` 留待另立决策。因此不把没有 `--watch` 或页面轮询列为实现缺陷，也不同意为此加入 watch 与原子覆盖要求。
- **主工作树未出现在 `lanes` 是事实，但不是已证明的 §8 违例。** §8 描述每条 lane 的字段，没有规定将主工作树建模为 lane。若产品要求看板覆盖所有 worktree，应先明确 `(main)` 记录的 schema，再将其作为需求补充；本评审把它列为边界/规格问题，不定为 P1。
- **notes 不可读的故障应显式报 lane error，不应静默跳过。** 我同意既有评审发现的异常路径，但不同意“降级成跳过”：这会把“读不到交接单”伪装成“没有交接单”。ARCHITECTURE-TASKS.md §8 要求读取失败时设置不可得字段并附 `error`，应按该契约表达。
- **claims 读取持 mutex 是 §3 的一致性要求，不是当前缺陷。** 每次 snapshot 短暂竞争同一把锁有成本，但把读改成无锁会偏离 §3.1；本实现没有在锁内跑 Git。尚无证据显示短临界区造成不可接受的延迟。
- **无效时间排序问题成立，但“排序结果未定义 / V8 不保证顺序”的解释不准确。** 比较器返回 `NaN` 会被排序算法视为相等，稳定排序保留输入次序；真正的问题是 ID 兜底不执行，最终结果依赖枚举顺序。本评审已按可复现结果补入 P2-8。

### 既有评审遗漏

以下均是本评审独立复现、而既有评审未提及的实现问题：活 mutex 可被年龄回收且旧 owner 可删掉新 owner 的锁（P1-1）；损坏 claim JSON 被跳过导致 fail-open（P1-2）；外部 junction 中缺失叶子绕过路径边界检查（P1-3）；`claim.pid` 未 HTML 转义且 CSP 允许 inline script（P2-1）；首次创建 live state 与 snapshot 的竞态漏读（P2-2）；合法 `..hidden` lane 被过滤（P2-3）；默认长路径配置下 Git status 失败被显示为干净（P2-4）；notes ACL 错误未按 lane 降级、I/O 错误退出码映射错误、坏 handoff 被跳过或部分接受（P2-5 至 P2-7）。

另观察到 `git worktree prune` 后已登记 lane 不再出现在 snapshot，残留 live claim 仍可能可见；由于 §8 以 Git 当前 worktree 列表枚举 lane，尚不能据此判定实现违约，列为已知可观测性边界。既有评审提到的 `repo.head` 标签、`unknown[]` 占位类型、status 前缀常量及 `--open` 路径测试建议，本次未复现为功能故障；其中 `--open` 含空格路径仍是测试缺口，不据此断言存在错误。
