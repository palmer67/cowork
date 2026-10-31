#!/usr/bin/env bash
# M2 手工复现现场：建一个带验证配置、两个车道、五种任务状态的临时仓库，然后停手让你自己点。
# 用法: tools/scenario-m2.sh [目标目录]   不给目录就在系统临时目录新建一个
# 依赖: git, node（用仓库里的 dist/cli.js）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
CLI="${COWORK_CLI:-$REPO_ROOT/dist/cli.js}"
[ -f "$CLI" ] || { echo "找不到 cli.js: $CLI（先在仓库根 npm run build）" >&2; exit 1; }

TARGET="${1:-$(mktemp -d "${TMPDIR:-/tmp}/cowork-scenario-m2-XXXXXX")}"
mkdir -p "$TARGET"
cd "$TARGET"

git init -q -b main .
git config user.email scenario@example.com
git config user.name Scenario
git config core.autocrlf false
git config core.safecrlf false

mkdir -p src/api src/foo/bar tools .cowork
printf 'export const api = 1;\n'               > src/api/index.ts
printf 'export const a = 1;\n'                 > src/foo/a.ts
printf 'export const b = 1;\n'                 > src/foo/bar/b.ts
printf 'export const fb = 1;\n'                > src/foobar.ts
printf 'export const ui = 1;\n'                > src/panel.ts
printf 'process.exit(0);\n'                    > tools/v-pass.js
printf 'console.error("scenario: 故意失败"); process.exit(1);\n' > tools/v-fail.js
printf 'setTimeout(() => process.exit(0), 5000);\n'               > tools/v-slow.js
printf '# scenario\n'                          > README.md

cat > .cowork/config.json <<JSON
{
  "schemaVersion": 1,
  "trunk": "main",
  "verification": {
    "allow_disabled": false,
    "commands": [
      { "name": "pass", "argv": ["$(command -v node | sed 's|\\\\|/|g')", "tools/v-pass.js"], "timeout_ms": 60000, "enabled": true }
    ],
    "env_allowlist": ["PATH", "SystemRoot", "ComSpec", "TEMP", "TMP", "NODE_ENV"]
  }
}
JSON

git add -A && git commit -qm "scenario: init"
"$CLI" init >/dev/null
git add -A && git commit -qm "chore: cowork init"

"$CLI" lane new alpha >/dev/null
"$CLI" lane new beta  >/dev/null

add_task() { "$CLI" task add --title "$1" --touches "$2" ${3:+--reads "$3"} --done-when "$4" | grep -o 't-[0-9a-f]\{6\}' | head -1; }

T_READY=$(add_task "待领取"      src/api/index.ts "" pass)
T_CLAIM=$(add_task "已领取"      src/foo/a.ts    "" pass)
T_WORK=$(add_task "进行中"       src/foo/bar/b.ts "" pass)
T_READS=$(add_task "读契约的任务" src/panel.ts   src/api/index.ts pass)

git add .cowork/tasks && git commit -qm "scenario: tasks"
for id in "$T_READY" "$T_CLAIM" "$T_WORK" "$T_READS"; do "$CLI" task ready "$id" >/dev/null; done

claim_and_start() {
  local lane="$1" out id
  out=$( (cd ".cowork/lanes/$lane" && "$CLI" next) )
  id=$(printf '%s
' "$out" | grep -o 't-[0-9a-f]\{6\}' | head -1)
  [ -n "$id" ] || { echo "车道 $lane 没领到任务: $out" >&2; return 1; }
  (cd ".cowork/lanes/$lane" && "$CLI" task start "$id" >/dev/null)
  printf '%s' "$id"
}
C_ALPHA=$(claim_and_start alpha)
C_BETA=$(claim_and_start beta)

cat <<EOF

现场就绪: $TARGET
  alpha 领了  $C_ALPHA  (in_progress)
  beta  领了  $C_BETA   (in_progress)
  其余任务见 node "$CLI" task ls（含一个只读契约的任务）

接下来自己试（都在 $TARGET 下）:
  cd .cowork/lanes/beta && COWORK_AGENT_ID=beta node $CLI task done $C_BETA
  node $CLI snapshot --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).contract_alerts))'
  node $CLI doctor --fix
  node $CLI ui --serve --open      # 看面板三态

把 .cowork/config.json 的 commands 换成 tools/v-slow.js 或 v-fail.js 再跑 done，可以复现慢验证与失败态。
EOF
