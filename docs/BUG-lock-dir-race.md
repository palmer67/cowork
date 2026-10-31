# BUG：Windows 上全局锁的「建目录 + 写 owner.json」不是原子的

- 发现：M1.5 面板验收期间，我复跑 `test/tasknext-concurrency.test.ts`（5 个进程同时 `next`）压测
- 影响：**M1 已合并到 main 的代码**，不是面板引入的
- 结论：`docs/ARCHITECTURE.md` §3 与 WORKORDER §11 的「恰好一个赢家」在高并发下会被打破，
  失败者在事务开始前就 exit 1，并附带一条内部错误信息

## 复现（两条命令，本机必现概率约 10%~20%）

```bash
cd .cowork/lanes/codex-panel
for i in $(seq 1 10); do
  node --experimental-strip-types --test test/tasknext-concurrency.test.ts > /tmp/conc-$i.log 2>&1
  echo "RUN$i=$?"
done
```

实测（2026-10-31，node v22.14.0，Windows 11）：`RUN1=1 RUN6=1`，其余 8 次通过，即 **2/10 失败**。

失败断言原文：

```
应恰好四个 exit 2，实际：
a=2 (任务已被领取: t-00a1b2（race）← lane e agent agent-e 于 2026-10-31T07:34:09.253Z)
b=2 (任务已被领取: t-00a1b2（race）← lane e agent agent-e 于 2026-10-31T07:34:09.253Z)
c=1 (无法写入 owner.json: Error: ENOENT: no such file or directory, open 'C:\Users\...\.git\cowork\lock\owner.json')
d=2 (任务已被领取: t-00a1b2（race）← lane e agent agent-e 于 2026-10-31T07:34:09.253Z)
e=0
```

隔离复现（在临时副本里给 `src/mutex.ts` 加日志，同一用例循环 24 次）：

```
a=1 (无法创建锁目录 C:\Users\...\.git\cowork\lock: EPERM)
```

同一天内同一个用例出现**两种**错误：`ENOENT`（写 owner.json 时目录没了）和 `EPERM`（
`mkdirSync` 失败）。两者指向同一个根因。

## 根因

`src/mutex.ts:60-89` 的 `tryAcquire()` 是两步：

```ts
mkdirSync(lockDir);                                   // 第一步：先建目录
...
writeFileSync(path.join(lockDir, 'owner.json'), ...); // 第二步：再写拥有者
```

第一步和第二步之间，目录处于「存在但没有主人」的状态；而释放路径 `releaseLock()`（`:128-137`）
与回收路径 `reap()`（`:107-117`）会 `rmSync(lockDir, { recursive: true })` /
`renameSync(lockDir, trash)` **整目录删除或移走**。

Windows 的目录删除不是瞬时的：目录进入 delete-pending 状态期间

1. 另一个进程的 `mkdirSync` 会得到 `EPERM` 而不是 `EEXIST`，被 `:66-71` 当成致命错误直接 exit 1；
2. 已经 `mkdirSync` 成功的进程，在写 `owner.json` 时目录已被别人删除，得到 `ENOENT`，同样 exit 1。

Linux 上这两步的时间窗极小，Windows 上因为 delete-pending 会被放大到可观测。

`isStale()`（`:91-104`）对「目录在、owner.json 不在」只做了 5 秒兜底，覆盖不了毫秒级的窗口，
也无法解决 delete-pending。

## 为什么必须修

1. **它直接否定 M1 的核心承诺**。WORKORDER §11 要求 5 进程屏障测试断言「恰好一个 0、其余 2」，
   现在约 10%~20% 的概率变成「一个 1、一个 0、三个 2」。用户看到的会是
   `cowork: 无法写入 owner.json: ENOENT ...` 这种内部错误，而不是「任务已被领取」。
2. **它会污染 M2**。M2 的自动验证要在同一把锁下跑更多步骤，临界区变长，窗口出现频率只会更高。
3. **M1.5 面板的门禁依赖它**：`npm test` 里带着这个用例，CI 会随机红。

## 建议的修法（方向，具体实现由实现者定）

把「建目录 + 写 owner」变成一次原子发布，避免目录在无主状态下被看见：

- 先在 `lock.tmp-<pid>-<rand>` 目录里写好 `owner.json`，再用 `renameSync(tmpDir, lockDir)`
  发布；目标已存在时 rename 会失败（Windows 上可能是 `EPERM`/`EEXIST`），按「被占用」处理，
  删掉自己的临时目录后继续等待/退出 2；
- 回收时不再 `rmSync` 整目录，改为单文件 `unlink` + 重试，或沿用 rename 到 trash（trash 目录
  本身不参与竞争判断）；
- `tryAcquire()` 对 `EPERM`/`EEXIST`/`ENOENT` 一律按「此刻没抢到」处理，绝不直接抛错；
- 回归测试：并发用例循环 50 次全绿（现有只跑 1 次，抓不到）。

## 验收这条修复的标准

```bash
for i in $(seq 1 50); do
  node --experimental-strip-types --test test/tasknext-concurrency.test.ts || { echo "FAIL at $i"; break; }
done
```

50/50 通过，且失败路径里不再出现 `无法创建锁目录` / `无法写入 owner.json`。
