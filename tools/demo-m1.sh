#!/usr/bin/env bash
set -u
CLI="D:/UserData/Documents/deepseek-harness/cowork/.cowork/lanes/dsh-m0/dist/cli.js"
D=$(mktemp -d)
cd "$D" || exit 1
git init -q -b main
git config user.email demo@example.com
git config user.name demo
git commit -q --allow-empty -m "init"
mkdir -p src .cowork
printf '{"schemaVersion":1,"trunk":"main"}\n' > .cowork/config.json
echo "== 1) 建一条任务 =="
node "$CLI" task add --title "修登录页" --touches src/login.ts
git add -A && git commit -qm "init"
echo
echo "== 2) 列表 =="
node "$CLI" task ls
echo
ID=$(node "$CLI" task ls --json | grep -o 't-[0-9a-f]\{6\}' | head -1)
echo "任务 id: $ID"
node "$CLI" task ready "$ID"
echo
echo "== 3) 建车道并领取 =="
node "$CLI" lane new demo
cd .cowork/lanes/demo || exit 1
node "$CLI" next --agent demo
echo
echo "== 4) 看板数据（snapshot） =="
node "$CLI" snapshot --json | head -c 700
echo
echo "== 5) doctor =="
node "$CLI" doctor
echo
echo "DEMO_DIR=$D"
