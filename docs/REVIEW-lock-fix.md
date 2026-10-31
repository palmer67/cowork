# 复验：锁目录原子发布（`dsh/lock-fix`）

被验对象：`dsh/lock-fix`，`7bf4f5f` + `b0156d7`，基线 `main@48c30c4`，4 文件 +260/−32。
复验人：判官（独立跑，不用交付方的脚本结论）。
时间：2026-10-31。

## 结论

**可合，已合。** 原缺陷（`docs/BUG-lock-dir-race.md`）在 50 轮压测下不再复现；语义未变
（恰好一个赢家、输家 exit 2）；没有削弱既有测试。

## 证据（全部本机复跑）

| 项目 | 命令 | 结果 |
| ---- | ---- | ---- |
| 单测 | `npm test`（`lanes/dsh-mutex`） | `# tests 110 / # pass 110 / # fail 0`，exit 0 |
| 类型 | `npx tsc --noEmit` | 无输出，exit 0 |
| 50 轮压测 | `bash tools/check-lock-race.sh <lanes/dsh-mutex> 50`（我在 `dsh/review` 里自己的脚本） | `总计 50 轮，失败 0 轮` |
| 语义未改 | `git diff --stat main..HEAD -- test/tasknext-concurrency.test.ts test/tasknext.test.ts src/tasknext.ts src/taskops.ts` | 空 |
| 残留锁 · 空目录 | 手工造 `.git/cowork/lock/`（无 owner）后 `next` | exit 0，用时 4976ms，锁被回收 |
| 残留锁 · 死 pid | `owner.json` 写 `pid:999999` 后 `next` | 517ms 内锁被回收，无 trash 残留 |

修复后 50/50，修复前 10 轮里 2 轮失败——同一台机器、同一条命令。

## 代码确认

- `src/mutex.ts:102-156` `tryAcquire()`：`mkdir lock.tmp-<pid>-<rand>` → 写 `owner.json` →
  `renameSync(tmp, lock)` 原子发布；`EPERM/EEXIST/ENOENT/ENOTEMPTY/EBUSY` 统一视作竞争失败返回
  `null`，只有真正的前置错误才 `exit 1`。原「目录无主」窗口消失。
- `src/mutex.ts:181-198` `reap()`：先复查 token，再 `rename(lock → trash)` 让出锁路径，最后删 trash；
  不会把别人刚发布的新锁挪走。
- `src/mutex.ts:209-241` `releaseLock()`：token 不符只告警不删；rename 失败时退化为
  `unlink owner.json + rmdir`，不递归删目录。
- 新增 `test/mutex-concurrency.test.ts`（4 进程 × 15 轮读-改-写 counter，断言 exit 全 0、
  stderr 无 EPERM/ENOENT、计数不丢、无残留 lock 与 `lock.tmp-*`），已进 `npm test`。

## 留下的观察（不阻塞）

1. **空 `lock/` 目录要等 5 秒**（`isStale` 对无 owner 目录用 mtime 兜底）。只影响旧版本残留或
   手工造锁的场景，正常崩溃会留下带 owner 的锁，走 pid 存活判断，517ms 就回收。
2. **`lock.tmp-*` 崩溃残留没有清理者**：进程在 `mkdir tmp` 与 `rename` 之间被杀会留下空临时目录，
   `doctor` 目前不扫描它。建议并进 M2 的 doctor 检查（或下个补丁），不作为本次合并条件。
3. `trash/` 里的副本删除失败会静默留给 `doctor --fix`，目前 `doctor` 也不清 trash——同上。

## 合并

已在 `.cowork/lanes/main` 执行 `git merge --no-ff dsh/lock-fix`，合并提交 `311a1f2`，
合并树上重跑 `npm test` / `tsc` / `build` / 50 轮压测后推送 `main`。
