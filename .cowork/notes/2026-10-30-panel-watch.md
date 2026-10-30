---
{
  "from": "dsh",
  "lane": "dsh/m0",
  "at": "2026-10-30T17:30:00+08:00",
  "task": "面板自动刷新：cowork ui --watch + meta refresh + 原子写，并把主工作树作为 (main) 行纳入 snapshot",
  "files_touched": [
    "src/snapshot.ts",
    "src/ui.ts",
    "src/cli.ts",
    "test/snapshot.test.ts",
    "test/ui.test.ts",
    "README.md",
    "docs/ARCHITECTURE-TASKS.md",
    "docs/DECISIONS.md"
  ],
  "decisions": [
    "watch 是前台循环：每次重新做一次完整 snapshot，原子重写同一个 HTML，页面用 <meta http-equiv=\"refresh\"> 自己重载；不起 HTTP、不起后台进程、不引入长连接",
    "写面板改成 tmp+rename 原子替换（照 store.ts 的 writeClaim），避免 watch 下浏览器读到半截 HTML；失败清理 tmp 并按退出码 3",
    "退出 watch 时再写一次不带 refresh 的版本，避免命令停了页面还在空转；meta refresh 只支持整秒，所以间隔取 1..3600 的整数",
    "主工作树 lane=null、显示 (main)，排在所有 .cowork/lanes/ 车道之前；主工作树的最近交接只按分支名匹配，其余仍同时匹配目录名与分支名",
    "watch 每次采样仍走基础 mutex（只读一遍 claims 目录，临界区毫秒级），默认 2 秒；与 claim/release 偶发等待可接受，成为热点再改无锁读",
    "每次渲染都全量解析快照，不缓存：面板只消费 snapshot，不读 .git/cowork"
  ],
  "next": [
    "M1 任务层：cowork task / cowork next；snapshot 的 tasks 与 contract_alerts 仍是空数组，面板只等渲染补全",
    "评审 P2/P3 遗留：repo.head 语义（现已在面板标注“主工作树 HEAD”）、parseStatusCount 的 slice(3) 前提、tasks 类型化、openPanel 含空格路径的验证",
    "Windows 下真实 Ctrl+C 需人工在终端验证：Node 无法用 child.kill('SIGINT') 在 Windows 模拟控制台中断"
  ]
}
---

# 面板自动刷新（2026-10-30）

## 现在在哪

`dsh/m0` 上把看板 P0 的两个缺口补掉了：面板不再需要手动重跑命令 + F5，
主工作树（Codex 直接干活的那个）也不再是不可见的盲区。测试从 27 涨到 31，
`npx tsc --noEmit` 干净，`npm run build` 通过。

## watch 的形态

```bash
cowork ui --watch                  # 每 2 秒重新采样并重写面板，Ctrl+C 退出
cowork ui --watch --interval 5     # 1..3600 的整数秒
```

仍然是静态单文件：`--watch` 在同一个前台进程里循环 `snapshot → 原子写 HTML`，
页面靠 `<meta http-equiv="refresh" content="N">` 自己重载。没有 HTTP 服务、没有后台进程、
没有长连接，所以 D8 的"CLI 是唯一运行时进程"没有被破坏。

- 原子写：先写 `<file>.tmp-<pid>` 再 `rename`，浏览器永远看到完整文件；出错时清理 tmp 并按退出码 3 报错。
- 退出：SIGINT/SIGTERM 触发一次最终重采样，写出的版本**不带** refresh，命令停了页面不会反复空转。
  第二次 Ctrl+C 走默认终止。
- `--interval` 只能和 `--watch` 一起用；非整数、0、>3600 都退出 1，错误信息带取值范围。

## 主工作树行

`git worktree list` 里主工作树不在 `.cowork/lanes/` 下，之前被过滤掉了。现在它是
`lane: null` 的一条，面板显示 `(main)`，排在其余车道前面；`dirty` / `changed_file_count` /
最近交接的语义与普通车道一致，最近交接只按分支名匹配（主工作树没有车道目录名）。

这让"Codex 在主仓库改了东西但面板看不见"不再发生，也顺带说明 `repo.head` 是主工作树的
HEAD 而不是 trunk——面板顶部标签已改成“主工作树 HEAD”。

## 顺手修的评审项

- `readHandoffs` 的 `readdirSync` 加了 try/catch：某条车道 notes 不可读时返回空列表，
  不再让整份快照挂掉。
- `latestHandoff` 比较器不再用两个可能都是 `-Infinity` 的值相减（会得到 NaN），改成显式比较。
- 过滤框把当前过滤词写进 URL hash，meta refresh 重载后不会丢。
- `writePanel` 失败路径有测试覆盖（父路径是文件 → 退出码 3）。

## 怎么验

```bash
npm test                          # 31 个（paths 5 / claims 9 / snapshot 9 / ui 8）
npx tsc -p tsconfig.json --noEmit
cowork ui --watch                 # 终端 A：放着不动
cowork claim src/whatever.ts      # 终端 B：2 秒内面板出现占位，不需要 F5
```

手工快速路径（临时仓库，不污染本仓库）：

```bash
cd $(mktemp -d) && git init -q -b main r && cd r
printf 'x\n' > a.txt && git add . && git -c user.email=a@b -c user.name=a commit -qm init
cowork ui --watch --interval 1 &   # 或用 --out 指定文件
echo y >> a.txt                    # 1 秒内面板变 dirty
```

e2e 冒烟（一次性脚本）实测：首次写出 361ms、改动可见 1173ms、tmp 残留 0。

## 已知限制

- 轮询式实时（默认 2 秒），不是推送；要更密就调小 `--interval`，代价是每次采样都抢一次锁。
- meta refresh 只支持整秒，亚秒间隔没有意义。
- Windows 下 Node 无法用 `child.kill('SIGINT')` 模拟控制台 Ctrl+C；信号处理逻辑只有单测
  （AbortSignal 路径）和手动 Ctrl+C 覆盖，自动 e2e 只能验证"更新可见"，不能验证"优雅退出"。
