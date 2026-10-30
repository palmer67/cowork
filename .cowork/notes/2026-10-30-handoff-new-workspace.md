---
{
  "from": "dsh",
  "lane": "dsh/m0",
  "at": "2026-10-30T16:45:00+08:00",
  "task": "交接：把 cowork 的开发迁到独立 DSH 工作区",
  "files_touched": [],
  "decisions": [
    "工作区边界按项目划分（cowork 一个、ai-note 一个），车道边界按 agent 划分（codex 一条、dsh 一条），两层不混用",
    "新会话的工作目录直接落在 .cowork/lanes/dsh-m0，不要再从仓库根开始改代码"
  ],
  "next": [
    "cowork snapshot --json（lanes + 未提交改动）",
    "cowork ui 只读面板",
    "M1 任务层：cowork task / cowork next"
  ]
}
---

## 现在在哪

main = `46cb36f`，M0（占位、路径键、NTFS 互斥、CLI、14 个测试）已经合进去并且能自举。
我的车道 `.cowork/lanes/dsh-m0`（分支 `dsh/m0`）与 main 同步，工作区干净。

## 接手顺序

1. `docs/PLAN.md` —— 需求与验收标准，任何实现要能对回某一条
2. `docs/ARCHITECTURE.md` §3 —— 路径键、claim、mutex、失败模式表
3. `docs/ARCHITECTURE-TASKS.md` —— 任务对象、领取协议、并行判定、三层完成判定
4. `docs/DECISIONS.md` D7 —— **pid 判活为什么被 TTL 取代**，别改回去

## 命令速查

```bash
npm test                                     # 14 个用例，需真实 git
npx tsc -p tsconfig.json                     # 产出 dist/
node --experimental-strip-types src/cli.ts status
```

`npm test` 必须写成 `node --experimental-strip-types --test test/*.test.ts`，
直接传 `test/` 目录会报 `Cannot find module`。

## 三个已经踩过的坑

- **别用 pid 判活**。CLI 每次调用都是新进程，命令一退出 pid 就死，占位会被当成残留清掉。
- **车道在仓库内**（`.cowork/lanes/`），所以这个仓库永远不能 `git clean -fdx`。
- **claim 的 key 小写折叠，display 保留原样**。只改其中一个会把输出搞成 `readme.md`。

## 两个 agent 同时在一个工作树里时

```bash
COWORK_AGENT_ID=codex   # Codex 侧
COWORK_AGENT_ID=dsh     # DSH 侧
```

不设的话两边会被当成同一个 owner，不互斥。
