---
{
  "from": "dsh",
  "lane": "dsh/m0",
  "at": "2026-10-30T17:00:00+08:00",
  "task": "交付只读面板：cowork snapshot --json 与 cowork ui",
  "files_touched": [
    "src/snapshot.ts",
    "src/ui.ts",
    "src/cli.ts",
    "test/snapshot.test.ts",
    "test/ui.test.ts",
    "package.json",
    "README.md",
    "docs/DECISIONS.md"
  ],
  "decisions": [
    "面板是静态单文件，输出到 <tmp>/cowork-ui/<sha1(commonDir)>/index.html，不监听端口、不读写 .git/cowork（见 D8）",
    "snapshot 先在 mutex 内读 claims，再在锁外对各车道跑只读 git；live 状态目录不存在时不为只读操作创建它",
    "dirty 用 git status --porcelain=v1 -z --untracked-files=all 解析，按路径去重，重命名新旧一对只计 1；worktree 缺失时 dirty/changed_file_count 是 null 加 error，不能伪装成 false",
    "交接单解析要容忍多行 JSON front matter；lane 可能写分支名（dsh/m0）也可能写目录名（dsh-m0）；没有 createdAt 时用 at；没有 id 时用文件名",
    "面板展示文件不落仓库、不落 live 目录，避免弄脏 git status 或制造第二份状态"
  ],
  "next": [
    "M1 任务层：cowork task / cowork next；snapshot 的 tasks 与 contract_alerts 目前固定为空数组",
    "如果需要实时刷新，先评估 snapshot --watch 这类每次调用做一次完整快照的形态，不要起常驻 HTTP 服务"
  ]
}
---

# 面板交付（2026-10-30）

## 现在在哪

`dsh/m0` 车道上新增了只读面板的三件套：`src/snapshot.ts`（数据）、`src/ui.ts`（渲染）、
`src/cli.ts` 里的 `snapshot` / `ui` 命令。测试从 14 个涨到 27 个，`npx tsc --noEmit` 干净。

## snapshot 契约实现要点

- lanes 来自 `git worktree list --porcelain -z`，只取主仓库 `.cowork/lanes/` 下已登记的 worktree；
  `lane` 是目录名，detached HEAD 时 `branch` 为 null。
- `dirty` / `changed_file_count` 用该车道工作区的
  `git status --porcelain=v1 -z --untracked-files=all`：暂存、未暂存、删除、重命名、未跟踪都算，
  按路径去重，重命名新旧一对计 1。`-z` 下重命名的源路径是下一个 token，解析时必须跳过，
  否则一个重命名会被算成 2 个文件。
- 最近交接读该车道工作树里（含未提交）的 `.cowork/notes/*.md`，按 `createdAt ?? at` 倒序、
  同一时间按 id 倒序；`lane` 同时匹配目录名与分支名。没有交接时 id/created_at 都为 null。
- claims 只在 `<git-common-dir>/cowork` 存在时读，且在 mutex 内读；状态目录不存在就直接返回空，
  不为了"看一眼"把它建出来。Git 命令一律在锁外跑（临界区不能持锁跑 git）。
- worktree 目录缺失时给 `error`，`dirty`/`changed_file_count`/`last_handoff` 为 null。

## 面板

`cowork ui` 渲染自包含 HTML（无外部资源，内联 CSS + 一小段过滤脚本，CSP 默认全禁），
默认写到 `<tmp>/cowork-ui/<sha1(commonDir)>/index.html`，重跑覆盖同一个文件；`--out` 指定路径，
`--open` 才尝试打开浏览器，打开失败只警告、退出码仍是 0。面板只消费 snapshot 的 JSON，
不读 `.git/cowork`，也不调用任何写命令。

## 怎么验

```bash
npm test                                     # 27 个测试（paths 5 / claims 9 / snapshot 8 / ui 5）
npx tsc -p tsconfig.json --noEmit
cowork snapshot --json | head                # 人工核对 lanes / claims / repo
cowork ui --open                             # 生成面板并打开浏览器
```

`package.json` 的 test 脚本已改成 `node --experimental-strip-types --test "test/*.test.ts"`：
原来写成 `--test test/`，Node 会把目录当模块加载直接报错；Windows 的 cmd 不展开 glob，
所以要带引号传模式（Node 22.14 的 test runner 自己展开）。

## 下一步

M1 任务层还没动。`snapshot` 的 `tasks` 与 `contract_alerts` 现在固定是空数组，
面板里对应的卡片也写着"M1"。实现任务层时先把 ARCHITECTURE-TASKS 的 §8 契约保持在数据形状上，
面板这边只需要补渲染，不需要改数据源。
