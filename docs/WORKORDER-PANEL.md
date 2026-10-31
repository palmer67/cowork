# 工单：M1.5 派工面板（可写界面 + 计划导入）

状态：待实施（2026-10-31）
实施者：Codex（本工单是完整规格，评审环节由判官负责）
版本：v1

> 一句话：把只读看板升级成**本机、前台、只调用 CLI** 的派工面板，并补一条 `task import`
> 把 agent 拆出来的任务清单一次性收进队列。CLI 仍是唯一写者，M0/M1 的锁与事务一条都不改。

---

## 0. 背景

今天的闭环是：agent 解读项目 → 产出任务清单 → **人逐条敲 `cowork task add`** → 划车道 →
每个 agent 在自己车道里 `cowork next`。命令都能用，但第 2、3 步靠人肉搬运，且看板只能看。

用户要的是：**一个项目，先让 agent 解读并拆解，然后在界面上划车道、把任务派到车道，多 agent 执行。**
本工单交付这条链路里缺的两块：可写面板、批量导入。

## 1. 目标

1. `cowork ui --serve`：本机 `127.0.0.1` 前台控制面板，能新建车道、建任务、派工（领取）、改状态、
   看快照。所有写操作 = 一次 CLI 子进程调用。
2. `cowork task import <plan.json>`：把 agent 产出的任务清单（含依赖别名）一次性写成 draft spec。
3. 静态 `cowork ui`（当前行为）保持不变，作为无服务时的降级形态。
4. 决策记录 D11（面板服务）、D12（计划导入）写入 `docs/DECISIONS.md`。

## 2. 非目标（不要做，做了就是越界）

- ❌ 不做后台守护进程：`--serve` 前台运行，Ctrl+C 结束，不 fork、不 daemon、不开机自启。
- ❌ 不引入任何运行时依赖（`package.json` 的 `dependencies` 必须保持空），只用 `node:http`、`node:child_process`。
- ❌ 不引入 Electron、不引入前端框架、不引入打包器；页面仍是**单个 HTML 字符串**，内联 CSS/JS。
- ❌ 面板不直接读写 `.git/cowork/`、`.cowork/tasks/` 等任何状态文件；只调用 CLI。
- ❌ 不自动唤醒/调度 agent、不自动合并、不做 LLM 调用——这是 M2/M3 的话题。
- ❌ 不改动 `.cowork/lanes/dsh-m0`、不动 `docs/ARCHITECTURE-TASKS.md` 的既有语义。
- ❌ 不监听 `0.0.0.0`，不允许局域网访问，不提供任何远程访问选项。

## 3. 要新增的两条决策（先写进 DECISIONS.md，再写代码）

### D11 — 面板默认只读；`--serve` 是本机前台的可写例外（补充 D8）

D8（静态单文件、不监听端口）不变，仍是默认路径。新增的例外只允许以下形态：

1. 只 bind `127.0.0.1`，端口从命令行指定（默认 `7788`），端口被占时退出码 `3`，不自动换端口；
2. 进程前台运行，随窗口/Ctrl+C 退出，不写 pid 文件、不驻留；
3. **面板不直接写状态**：每个写操作都被翻译成一次 `node <cli> <argv>` 子进程调用，退出码原样透传；
4. 请求必须带一次性随机 token，缺 token / token 不符一律 `401`，不做任何匿名写；
5. 面板只依赖 `cowork snapshot --json` 读数据，不新造读协议。

理由：GUI 天生产生重复点击、顺序错乱；让 CLI 继续独占写入，锁和事务就是为这种场景准备的。
GUI 只是遥控器，不是第二个写者。

### D12 — 计划导入只生成 draft，不碰状态机

`cowork task import` 把一份 JSON 计划写成若干 `.cowork/tasks/<id>.md`，全部处于 `draft`：

- id 由 CLI 生成，计划里的 `key` 只做依赖别名的内部引用，不写进 spec；
- 依赖别名在导入时解析成真实 id，未知 key、自依赖、环 → 退出码 `1`，一条都不写（全有或全无）；
- 写完后由人提交 spec 并 `cowork task ready`，`--ready` 只是打印下一步，不自动提交、不自动 ready。

理由：`ready` 要求 spec 在 trunk 可达（D9/A1 的验收基础），导入工具不能替人做这件事。

## 4. 用户流程（验收时按这个演一遍）

```bash
# 1) 人（或 agent）解读项目，产出一份计划
#    见 §5.3 的 plan.json 格式
cowork task import plan.json           # → 4 个 draft，打印别名→id 对照表
git add .cowork/tasks && git commit -m "task: 拆分项目"
cowork task ready t-a1b2c3             # 逐条 ready（或写脚本循环）

# 2) 划车道
cowork lane new dsh
cowork lane new codex

# 3) 开面板派工
cowork ui --serve --open
#    页面：任务卡片 → [派给车道 ▾] → 选 dsh → 执行 cowork next（cwd=车道目录，agent=dsh）
#    冲突时原样显示「路径已被占用: … ← … agent=… 的 pid …」

# 4) agent 在自己车道里干活（面板只负责派工与看进度）

# 5) 交付、合并：面板上的 [标记完成] / [确认合并] 按钮同样是一次 CLI 调用
```

## 5. 详细设计

### 5.1 文件

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/uiserver.ts` | 新增 | HTTP 服务、token、路由、CLI 执行器、串行队列（目标 300–400 行） |
| `src/planimport.ts` | 新增 | 计划解析/校验/别名解析/环检测/写 spec（目标 180–250 行） |
| `src/ui.ts` | 修改 | 抽出 `renderBoard(snapshot, opts)`；静态模式与 serve 模式共用同一渲染函数 |
| `src/cli.ts` | 修改 | `ui` 增加 `--serve/--port/--open`；新增 `task import` 子命令与用法行 |
| `test/uiserver.test.ts` | 新增 | 路由、token、白名单、串行、退出码透传 |
| `test/planimport.test.ts` | 新增 | 正常、别名、未知 key、环、非法字段、全有或全无 |
| `tools/accept-panel.mjs` | 新增 | 端到端验收（见 §8），风格对齐 `tools/accept-m1.mjs` |
| `docs/DECISIONS.md` | 追加 | D11、D12 |
| `docs/ARCHITECTURE-PANEL.md` | 新增 | 面板的进程模型、安全边界、API 表（可短，60 行内） |
| `README.md` / `README.en.md` | 修改 | 「三条常用路径」后加一节「面板派工」，命令速查补 `ui --serve`、`task import` |

### 5.2 CLI 接口

```
cowork ui [--out <路径>] [--open]                      # 现状，静态单文件（不可写）
cowork ui --serve [--port <端口>] [--open]             # 新增：本机前台面板，默认 7788
cowork task import <plan.json> [--dry-run] [--ready]   # 新增：计划 → draft specs
```

- `--serve` 与 `--out` 互斥，同给 → 退出码 `1`。
- `--port` 非法或占用 → 退出码 `3`，错误信息带「端口被谁占了怎么办」。
- 启动后在 stdout 打印：`面板已启动: http://127.0.0.1:7788/?t=<token>`（token 只在启动时打印一次）。
- `--open` 用 `cmd /C start "" <url>`（Windows），其它平台用 `open`/`xdg-open`，失败不影响服务。

### 5.3 `plan.json` 格式（零依赖，手写解析）

```json
{
  "schemaVersion": 1,
  "tasks": [
    {
      "key": "login",
      "title": "补登录校验",
      "body": "在 src/auth/login.ts 里补齐空密码与错误密码的分支。",
      "touches": ["src/auth/login.ts"],
      "reads": ["src/auth/token.ts"],
      "depends_on": ["token-migration"],
      "done_when": ["npm test"]
    }
  ]
}
```

校验规则（全部失败 → 退出码 `1`，一次列出所有问题，一条 spec 都不写）：

- `schemaVersion` 必须是 `1`；`tasks` 非空数组。
- `key` 必填、`[a-z0-9][a-z0-9-]{0,31}`、全表唯一。
- `title` 非空、≤ 120 字符；`body` 可为空。
- `touches`/`reads` 为字符串数组；`touches` 不得为空（§10：空写集是 1）。
- `depends_on` 里的 key 必须存在、不能自依赖、图中无环。
- 同一路径同时出现在 `touches` 与 `reads` → 报错（写优于读，不允许双身份）。

输出（成功）：

```
导入 4 个任务（draft）:
  login              → t-a1b2c3
  token-migration    → t-d4e5f6
依赖:
  t-a1b2c3 depends_on t-d4e5f6
下一步: git add .cowork/tasks && git commit -m "task: …"，然后 cowork task ready <id>
```

`--dry-run` 只打印对照表与将要写的路径，不落盘。`--ready` 额外打印每条任务的 ready 命令（不执行）。

### 5.4 HTTP 接口（serve 模式）

读：

| 方法 + 路径 | 行为 |
|---|---|
| `GET /?t=<token>` | 返回面板 HTML；token 校验通过后页面用 `history.replaceState` 抹掉 query |
| `GET /api/snapshot` | 执行 `cowork snapshot --json`，透传 stdout 的 JSON；1 秒内重复请求走缓存 |
| `GET /api/tasks/<id>` | 执行 `cowork task show <id> --json` |
| `GET /api/brief?lane=<名>` | 在车道目录执行 `cowork brief --agent <名>` |

写（全部 `POST`，`Content-Type: application/json`，body ≤ 64KB）：

| 路径 | 执行的 argv（cwd） |
|---|---|
| `/api/lane/new` `{name, base?}` | `lane new <name> [--base <ref>]`（仓库根） |
| `/api/task/add` `{title, touches[], reads[], depends_on[], done_when[]}` | `task add …`（仓库根） |
| `/api/task/<id>/ready` | `task ready <id>`（仓库根） |
| `/api/task/<id>/start` | `task start <id>`（仓库根） |
| `/api/task/<id>/report-done` | `task report-done <id>`（仓库根） |
| `/api/task/<id>/confirm-merge` `{commit, reason}` | `task confirm-merge <id> --commit <sha> --manual --reason <text>`（仓库根） |
| `/api/task/<id>/block` `{reason}` | `task block <id> --reason <text>` |
| `/api/task/<id>/cancel` `{reason?}` | `task cancel <id> [--reason <text>]` |
| `/api/lane/<lane>/next` | `next --agent <lane>`（cwd = `.cowork/lanes/<lane>`，env `COWORK_AGENT_ID=<lane>`） |
| `/api/import` `{path, dry_run?}` | `task import <path> [--dry-run]`（仓库根） |

响应统一为 `200 {"code":0|1|2|3,"stdout":"…","stderr":"…"}`；参数校验失败返回 `400`，鉴权失败 `401`，
未知路径 `404`。**面板不翻译 CLI 的错误文本**，原样展示（"谁占着、怎么解决"已经在 CLI 里写好了）。

**身份只用 `cwd` + 环境变量表达**：`/api/lane/<lane>/next` 固定 `cwd=<仓库>/.cowork/lanes/<lane>`、
`COWORK_AGENT_ID=<lane>`，`--agent` 也由服务端按 lane 填。**写路由不接受客户端传 agent**——面板不能
代替另一个 agent 行动，快照里的 owner 只是展示信息（见 §11 裁定 R3）。

### 5.5 安全

1. **只 bind `127.0.0.1`**；`server.listen(port, '127.0.0.1')`。
2. **token**：启动时 `randomBytes(16).toString('hex')`；所有 `/api/*` 与首页都校验：
   `GET /` 用查询参数，`/api/*` 用请求头 `X-Cowork-Token`（页面从 URL 取到后存进 JS 变量）。
   比较用 `crypto.timingSafeEqual`（先比长度）。
3. **Host 校验**：`Host` 必须是 `127.0.0.1:<port>` 或 `localhost:<port>`，否则 `403`（防 DNS rebinding）。
4. **不发 CORS 头**：自定义头 + 无 CORS ⇒ 跨站 `fetch` 预检失败；`OPTIONS` 一律 `405`。
5. **无文件服务**：不提供静态目录、不拼接用户路径到磁盘；`import` 的 `path` 必须 resolve 在仓库根内，
   否则 `400`。
6. **无 shell**：一律 `execFile(process.execPath, [cli, ...argv])`，禁止字符串拼接进 shell。
7. **串行**：所有写请求进同一个 promise 队列，一次只跑一个 CLI；读请求可并发（snapshot 有缓存）。
8. **超时**：子进程 60s；超时 kill 并按 `code:1` 返回，stderr 注明超时。

### 5.6 面板行为

- 顶部：仓库路径、trunk、`数据截至` 时间；右侧 [刷新]。
- 三块表沿用现有看板结构（工作树 / 占位 / 任务与契约），每行右侧新增操作列：
  - 车道行：[在此车道派工]（调 `/api/lane/<lane>/next`）、[查看 brief]
  - 任务行：按状态显示可用动作（ready / start / report-done / confirm-merge / block / cancel），
    未到该状态时按钮置灰并 `title` 说明原因；`start`/`report-done`/`block`/`cancel` 另需
    「面板身份 == 任务 owner」这一条，否则置灰（见 R4）
  - 导入：[导入计划] → 文件路径输入框 → 调 `/api/import`
- 每次操作后在页面底部展开一个结果条：`exit 2`、命令、stdout/stderr 原文（可折叠）。失败不弹 alert。
- 每 2 秒 `fetch('/api/snapshot')` 刷新；`document.hidden` 时暂停。
- 静态模式（无 `--serve`）渲染同一份 HTML，只是操作列替换成「复制命令」按钮。

## 6. 实现步骤（建议 6 个提交，一个提交一件事）

1. `feat: add plan import for agent-produced task lists` — `src/planimport.ts` + 单测 + CLI 接线。
2. `feat: add a local control panel server behind ui --serve` — `src/uiserver.ts` 只读部分（HTML、token、
   `/api/snapshot`）+ 启动参数 + 单测。
3. `feat: execute whitelisted CLI commands from the panel` — 写路由、串行队列、退出码透传 + 单测。
4. `feat: wire panel actions and conflict output` — `src/ui.ts` 操作列、结果条、轮询；静态模式降级为复制命令。
5. `docs: record D11 and D12 and document the panel` — DECISIONS、ARCHITECTURE-PANEL、双 README。
6. `test: add end-to-end acceptance for the panel` — `tools/accept-panel.mjs` + 跑通。

提交正文里写清楚：面板为何只是遥控器（D11 的理由），以及 import 为何不自动 ready（D12 的理由）。

## 7. 测试计划

单测（`node --experimental-strip-types --test`）：

- `planimport`：4 个任务的计划 → 4 个文件、别名解析正确、`--dry-run` 不落盘、未知 key / 自依赖 / 环 /
  空 touches / 重 key / 超长 title 各自退出 1 且**一条都不写**。
- `uiserver`：无 token 401；错 token 401；正确 token 200；`Host` 非本地 403；`OPTIONS` 405；
  body 超 64KB 413；未知路径 404；`--port` 占用退出 3；写请求串行（两个并发 POST，第二个的
  stdout 里能看到第一个的完成顺序）；子进程非零退出原样透传 `code`。

集成（临时仓库，`mkdtempSync` + `git init`）：

- 起服务（`--port 0` 时从 stdout 解析真实端口，测试专用）→ `lane new dsh` → `task add` → `ready`
  （需先 commit spec）→ `lane/dsh/next` 拿到 `code 0`，且临时仓库里出现 lease 与 claim；
- 同一任务再 `next` 一次 → `code 1`，`stdout` 里含「没有可领取的任务」与阻塞原因（见 §11 裁定 R1）。
  `code 2` 只在「锁外候选」与「取锁」之间被别的进程领走时出现；面板不制造这个竞态，只原样透传。

门禁：

- `npm run build && node tools/accept-panel.mjs`
- `npm test`（新增用例计入总数，README 的徽章数字同步）、`npx tsc --noEmit`
- `git diff --stat main..HEAD -- docs/ARCHITECTURE-TASKS.md docs/ARCHITECTURE.md` 必须为空

## 8. 验收标准（`tools/accept-panel.mjs`，逐条可执行）

1. `ui --serve --port 0` 打印 `面板已启动: http://127.0.0.1:<port>/?t=`，进程前台存活。
2. 无 token `GET /` → 401；带 token → 200 且 HTML 含「任务与契约」。
3. `Host: evil.example` 的请求 → 403。
4. `OPTIONS /api/lane/new` → 405。
5. 带 token `POST /api/lane/new {name:"dsh"}` → `code 0`，仓库里出现 `.cowork/lanes/dsh` 与分支 `cowork/dsh`。
6. 重复同名 → `code 2`，stdout 含「车道已存在」。
7. `task add` → `ready` → `POST /api/lane/dsh/next` → `code 0`，任务 live 状态 `claimed`、`lane=dsh`。
8. 同一任务再派（同车道、顺序执行）→ `code 1`，输出含「没有可领取的任务」；任务仍归原车道，
   live 的 `lane`/`agent` 不变，面板不得因为 `1` 就把卡片标成失败（见 §11 裁定 R1）。
9. 占位冲突：车道 a 占 `src/auth/login.ts`，车道 b 派工 → `code 2`，输出含路径与 `agent=a`。
10. `task import plan.json`（3 任务含依赖）→ 3 个 draft、依赖解析正确；把 `depends_on` 改成环 → 退出 1 且目录无新增文件。
11. 只浏览不点按钮（连刷 5 次 `/api/snapshot`）→ `<git-common-dir>/cowork/{tasks,claims,intents,leases}`
    与 `.cowork/tasks` 下的**文件集合与 mtime 都不变**；唯一允许变化的是 `<git-common-dir>/cowork/mutex*`
    锁目录——任何取锁命令都会 touch 它，断言它就等于测错对象（见 §11 裁定 R2）。
12. `cowork ui --out board.html`（静态模式）仍不监听端口、输出 HTML 且含操作列的「复制命令」。
13. `npm test` 退出 0、`npx tsc --noEmit` 静默、`package.json` 的 `dependencies` 仍为空。

## 9. 边界情况（必须处理，别留 TODO）

- 车道名与已有分支重名、含 `/` 或 `..`：CLI 已有校验，面板不要重复实现，原样透传错误。
- 面板打开后仓库被切分支/删车道：snapshot 里该车道标 `error`，操作列置灰并提示重开面板。
- 两个浏览器标签同时点「派工」：请求串行，第二个拿到 `code 2`，页面必须显示而不是静默。
- CLI 超时（60s）：返回 `code 1` + 「命令超时：cowork …」，不 try/catch 后静默成功。
- 端口占用 / 非数字端口：退出码 `3`，提示改用 `--port`。
- Windows 路径：只拼相对仓库根的路径；`<id>`、`<lane>` 出现在 URL 时做 `[A-Za-z0-9._-]` 白名单校验。
- token 泄露风险：只在本机、只打印一次、页面用后从 URL 抹掉；日志里不打印 token。

## 10. 交付物

1. 上述 6 个提交（分支 `.cowork/lanes/codex-panel`，基于 `main`）。
2. 交接单 `.cowork/notes/2026-11-01-panel-handoff.md`：做了什么、怎么验、已知限制、下一步。
3. 汇报给判官：`npm test` / `tsc` / `accept-panel.mjs` 的**原始输出**，加上 `git log --oneline main..HEAD`。

## 11. 判官验收前会看的三件事

1. 面板是否真的没有直接写任何状态文件（`grep -rn "writeFileSync\|renameSync" src/uiserver.ts` 必须为空）。
2. 有没有引入依赖、有没有监听 `0.0.0.0`（`grep -n "0.0.0.0" src/*.ts` 必须为空）。
3. 静态 `ui` 的行为是否还和 M1 一致（`npm test` 里 `test/ui.test.ts` 不改断言直接过）。

## 12. 判官裁定（2026-10-31，对 Codex 的三点提问）

- **R1 顺序重复 `next` 的返回码：保留 M1 的 `1`，不改 CLI。** 依据 `src/tasknext.ts:369-378`
  `pickWinner()` 只从**锁外候选集**（只含 ready 任务）里找已持有的任务；同一个车道第二次 `next` 时
  该任务已不是 ready，`before` 与 `after` 都空 → 走 `:414-419` 的 `general()`（`exit 1`「没有可领取的任务」）。
  `kind: 'busy'`（`exit 2`）只在锁外候选非空、取锁后候选变空、且候选里能挑出持有者时抛出（`:404-412`）。
  历史背景：M1 设计评审 P3 已经定过同一条规则——「只有占位被别人拿走」才是 `2`，其余一律 `1`。
  因此 §7 集成测试与 §8 第 8 条按上面的 `1` 修正；面板对 `1`/`2` 一视同仁地原样展示，不做语义猜测。
- **R2 只读验收排除 mutex 父目录：允许。** 任何取锁命令（包括读路径上 `ensureState` 之后的 mutex
  创建/删除）都会改动 `<git-common-dir>/cowork/` 这一层的 mtime，断言它等于断言「锁没被用过」，
  是测错对象。验收改为查 `tasks|claims|intents|leases` 四个子目录与 `.cowork/tasks` 的**文件集合 +
  mtime**，mutex 目录显式豁免。豁免范围只到 mutex，不放宽到整个 `.git/cowork`。
- **R3 不新增 `agent` 字段。** 身份由 `cwd`（车道 worktree）+ `COWORK_AGENT_ID=<lane>` 决定，`next`
  的 `--agent` 由服务端按 lane 名填；写路由一律拒绝客户端传入的 `agent`（`400`）。理由：D11 的整个
  前提是「面板只是 CLI 的遥控器」，允许面板代为指定 agent 就等于绕过「谁占着」的身份语义，而 M1 的
  占位与租约都建立在 agent 身份上。快照里的 owner 仅供展示。
- **R4 状态推进按钮必须绑定任务 owner（2026-10-31 复审后新增）。** `requireOwner()`
  （`src/taskops.ts:206`）被 `start`/`report-done`/`block`/`cancel` 调用；面板在仓库根起子进程，
  用的是面板自己的 `COWORK_AGENT_ID`（通常 `default`），与被派工任务的 `lane dsh agent dsh` 永不相等，
  所以这四个按钮现在是死的（判官探针实测 `code=2`「start 需要持有者执行」）。裁定：**不新增任何
  「代填身份」能力**（R3 不变），改为
  1. `/api/snapshot` 响应增加 `panel_agent` 字段（`COWORK_AGENT_ID` 或 `default`）；
  2. 任务行四个状态按钮仅在 `task.lane` + `task.assigned_agent` == `panel_agent` 时启用，
     否则置灰，`title` 写「需在车道 <lane> 内由 <agent> 执行」（主工作树显示为 `(main)`，未声明 agent 显示为 `未声明`），正文附可复制的
     `cowork task start <id>`；
  3. `ready` 与 `confirm-merge` 不受此限（前者是人的审核动作，后者本就是人工确认口）；
  4. 双 README 补一句：状态推进在车道 CLI 里做，面板负责派工 / 导入 / 确认合并；
  5. `accept-panel.mjs` 增加一条断言：对已派工任务点 `start` 时，面板要么给出启用（身份相符），
     要么给出置灰 + 提示文案，不允许发出必然 `code=2` 的请求。
  理由：人的点击不能等价于 agent 说「我开工了 / 我做完了」，否则 `in_progress` 与
  `reported_done` 两个信号失去意义，M2 的自动验证也无法据此判断「谁在干活」。
