# M1.5 派工面板

决策依据：[D11/D12](DECISIONS.md)、[工单与判官裁定](WORKORDER-PANEL.md)。

## 进程与数据

`ui` 默认生成静态单文件；`ui --watch` 前台重写文件，行为沿用 M1。
`ui --serve [--port 7788] [--open]` 前台监听 `127.0.0.1`，Ctrl+C 关闭。
端口非法或占用退出 3，不换端口；与 `--out` / `--watch` 互斥。

浏览器 → HTTP 白名单 → CLI 子进程 → 既有锁/事务/状态文件。
服务不读写持久状态；首页与轮询的数据源是 `snapshot --json`，详情/摘要也走 CLI。
页面共用 `renderBoard`，内联 CSS/JS，无外部资源、框架、打包器、运行时依赖。
每 2 秒刷新，页面隐藏时暂停；一秒快照缓存，每次写操作后失效。
所有写操作在同一 promise 队列中串行；每个操作恰好一个 `execFile`，无 shell。
子进程超时 60 秒后 kill，返回 code 1 与命令说明；CLI code/stdout/stderr 原样显示。

## 安全边界与身份

- 仅 IPv4 loopback。Host 必须是 `127.0.0.1:<port>` / `localhost:<port>`。
- 每次启动生成 16 字节随机 token；首页 query 校验，API 用 `X-Cowork-Token`。
- 页面取 token 后抹掉 query；token 不落盘、不打印到请求日志，比较使用 timingSafeEqual。
- 不发 CORS 头，OPTIONS 返回 405；JSON body ≤64KB，超限 413。
- 无文件服务、任意命令路由；URL id/lane 白名单；import 路径限仓库内（含 realpath 检查）。
- 写路由拒绝客户端 agent（400）；next 固定车道 cwd、环境变量及 `--agent <lane>`。
- 根目录状态动作保留启动者身份；owner 只展示。身份不符时显示 CLI 拒绝（R3）。
- next 领取 FIFO 中可执行任务，任务行选择车道不构成指定 task id 的领取协议。

## API

除首页 query token 外，以下均要求 token header；参数错误 400、未鉴权 401、未知路由 404。

| 方法/路径 | CLI（默认 cwd=主工作树） |
|---|---|
| GET `/` | snapshot，渲染页面 |
| GET `/api/snapshot` | `snapshot --json`（JSON 原文） |
| GET `/api/tasks/<id>` | `task show <id> --json` |
| GET `/api/brief?lane=<lane>` | `brief --agent <lane>`（车道 cwd/身份） |
| POST `/api/lane/new` | `lane new <name> [--base <ref>]` |
| POST `/api/task/add` | `task add --title … --touches … --reads … --depends … --done-when …` |
| POST `/api/task/<id>/{ready,start,report-done}` | 对应 `task` 命令 |
| POST `/api/task/<id>/confirm-merge` | `task confirm-merge <id> --commit … --manual --reason …` |
| POST `/api/task/<id>/{block,cancel}` | 对应命令与 reason（cancel 可省略） |
| POST `/api/lane/<lane>/next` | `next --agent <lane>`（车道 cwd/身份） |
| POST `/api/import` | `task import <path> [--dry-run]` |

除 snapshot/首页外，CLI 响应为 HTTP 200 `{code,stdout,stderr}`，非零退出不改任务卡片状态。
顺序重复 next / 已有占位导致无可领任务返回 1；真实领取竞争才可能返回 2（R1）。

## 计划导入

CLI 校验整个计划、规范化路径、解析别名并检测依赖环，失败零 spec 写入。
成功分配任务 id，批量创建 draft；写入异常回滚本批文件，不覆盖已有 spec。
`--dry-run` 打印映射/目标路径，不落盘；`--ready` 只打印下一步命令。
ready 仍要求人审阅并将 spec 提交到 trunk，导入不推进状态机。
