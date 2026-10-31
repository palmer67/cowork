#!/usr/bin/env bash
# 50 轮并发压测：5 个进程同时 next，每轮必须恰好 1 个 exit 0、4 个 exit 2。
# 用法：bash tools/check-lock-race.sh <车道目录> [轮数]
set -u
LANE="${1:-D:/UserData/Documents/deepseek-harness/cowork/.cowork/lanes/codex-panel}"
N="${2:-50}"
cd "$LANE" || exit 1
fails=0
for i in $(seq 1 "$N"); do
  if ! node --experimental-strip-types --test test/tasknext-concurrency.test.ts > "/tmp/lock-race-$i.log" 2>&1; then
    fails=$((fails + 1))
    echo "RUN $i FAILED"
    grep -A8 "应恰好四个" "/tmp/lock-race-$i.log" | head -10
    grep -o "无法[^:]*: [^\"]*" "/tmp/lock-race-$i.log" | head -3
  fi
done
echo "总计 $N 轮，失败 $fails 轮"
[ "$fails" -eq 0 ]
