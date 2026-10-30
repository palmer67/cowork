---
{
  "from": "dsh",
  "lane": "dsh/m0",
  "at": "2026-10-30T22:35:00+08:00",
  "task": "M1 §5 next 事务设计",
  "files_touched": ["src/tasknext.ts", "src/cli.ts", "test/tasknext.test.ts"],
  "decisions": [
    "intent 用单独 JSON 文件（<state>/tasks/intents/<opid>.json），不掺进 task live；phase 只有 pending/committed 两态",
    "lease 就是 task live 上的 lane/lanePath/agent/spec_commit：live 存在即 lease 存在，不再写第二份",
    "恢复扫描在每次取到全局锁之后、做任何读写之前执行（next 与全部 task 命令），锁外不碰 intent",
    "corrupt 判定：回滚失败、committed intent 对应的 live 或 claims 缺失、恢复时读到坏 live/坏 claim；标记后一律 fail closed（exit 1）",
    "锁外候选集 C 只用于区分退出码 1/2，绝不用于写决策；锁内用同一 trunk commit 重算 C' 才决定谁被领取",
    "next 的冲突判定同时看未过期 claims 与 held lease（claims 可能先过期，lease 还在），两者取并集",
    "锁内不跑 git：catalog 在锁外按 trunk commit 读进内存，锁内只用内存里的 spec"
  ],
  "next": ["实现 tasknext.ts 的 intent 写入/恢复与 next 事务", "再写 task 命令面与 brief/lane new"]
}
---

## next 事务设计（20 行）

1. 锁外：`readTrunkCatalog(info)` 把 trunk 固定 commit 的 spec 读进内存，得到候选集 C。
2. C 的选取：live 存在且 `status === 'ready'`（live 缺失按 `draft` 处理，永不可领）；`depends_on` 全部 `merged`；touches 与未过期 claims、held lease 均不冲突。
3. 取锁，第一件事 `recoverIntents(state)`：扫 `<state>/tasks/intents/*.json`。
4. `pending` intent：按 claim_ids 删除本 intent 写的 claims（lane+agent 必须匹配），把 live 恢复成 `prev`（`prev=null` 则删文件）。
5. `committed` intent：核对 live 的 lane/agent 与 claim_ids 全部存在且归属一致；缺一个即 `corrupt`。
6. 恢复中任何一步失败：`markCorrupt` + exit 1，宁可停下也不把任务交给第二个 owner。
7. 锁内用同一 commit 重算 C'；C' 非空取 FIFO(created_at, id) 第一个。
8. C' 空且 C 非空：exit 2，打印赢家（task、lane、agent、领取时间）；但若 C 非空只是因 touches 被手工 claim / held lease 占、没有任何任务赢家 → exit 1，逐条打印占用者（与 §12.3 同语义）。
9. 都空：exit 1，逐条打印阻塞原因（等哪个依赖、哪条路径被谁占）。
10. 写 intent：operation_id、task_id、lane、prev、claim_ids、phase=`pending`。
11. 写 lease：live 置 `claimed`，lane/lanePath/agent/spec_commit 落盘。
12. 写 claims：逐个 touches，冲突则整单回滚。
13. intent 置 `committed`，再删除 intent 文件；成功输出 task id/touches/depends_on/done_when/lane/agent/spec_commit。
14. 任一步失败：锁内按 intent 幂等回滚（删 claims、恢复 live），回滚失败转 `corrupt`。
15. 所有写都是 tmp+rename；intent 永远先于 lease 落盘，保证崩溃后能判断"写到哪一步"。
16. 锁内只读写 live 文件与 intent，不执行 git，避免把慢操作塞进临界区。
17. `next --json` 与文本输出同一份结果；错误路径也遵守 exit 1/2 的区分。
18. 恢复报告由 `next`/`task` 命令统一打印，便于发现上一轮崩溃。
19. 并发测试用 5 个进程同一时刻 next，断言只有一个成功、其余 exit 2 且无残留 intent。
20. 设计变更（例如把 lease 拆成独立文件）必须同步改本文件与 DECISIONS D9。
