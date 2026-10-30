#!/usr/bin/env node
/**
 * M1 验收脚本 —— 把 docs/WORKORDER-M1.md 第 12 节的 10 条做成可一键跑。
 *
 *   npm run build && node tools/accept-m1.mjs
 *   node tools/accept-m1.mjs --with-build      # 额外跑 npm test / tsc 门槛
 *   node tools/accept-m1.mjs --only 3,7        # 只跑指定编号
 *   node tools/accept-m1.mjs --cli dist/cli.js # 指定 CLI 入口
 *   node tools/accept-m1.mjs --keep            # 保留临时仓库便于排查
 *
 * 退出码：全部 PASS 或 SKIP 为 0；有 FAIL 为 1；脚本自身环境问题为 2。
 * 每条检查用独立临时仓库，互不污染；断言以退出码为主，消息只做包含判断。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const CLI = path.resolve(opt('--cli', 'dist/cli.js'));
const ONLY = opt('--only', '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '')
  .map((s) => Number(s))
  .filter((n) => Number.isFinite(n));

if (!existsSync(CLI)) {
  console.error(`找不到 CLI：${CLI}\n先跑 npm run build，或用 --cli 指定入口。`);
  process.exit(2);
}

/** 命令没实现时 CLI 会报「未知命令」；这时退出码 1 会伪装成验收通过，必须先挡掉。 */
const NOT_IMPLEMENTED = /未知命令|unknown command|未知子命令/i;
function assertImplemented() {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'cowork-probe-'));
  try {
    run('git', ['init', '-q', '-b', 'main'], probe);
    const r = cw(probe, ['task', 'add', '--title', 'probe', '--touches', 'src/probe.ts']);
    if (NOT_IMPLEMENTED.test(r.out)) {
      console.error(`M1 命令还没实现（${r.out.trim().split('\n')[0]}），验收无法进行。`);
      process.exit(1);
    }
  } finally {
    try {
      rmSync(probe, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    } catch {
      /* ignore */
    }
  }
}

const TMP = [];
process.on('exit', () => {
  if (has('--keep')) return;
  for (const dir of TMP) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
});

function run(cmd, args, cwd, env = {}, shell = false) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    windowsHide: true,
    shell,
    timeout: 120_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function cw(cwd, args, agent = 'dsh') {
  return run(process.execPath, [CLI, ...args], cwd, { COWORK_AGENT_ID: agent });
}

function git(cwd, args) {
  return run('git', args, cwd);
}

const TASK_ID = /t-[0-9a-f]{6,}/;

function newRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cowork-accept-'));
  TMP.push(root);
  const fail = (what, r) => {
    throw new Error(`${what} 失败：${r.out.trim().slice(0, 400)}`);
  };
  let r = git(root, ['init', '-q', '-b', 'main']);
  if (r.code !== 0) fail('git init', r);
  git(root, ['config', 'user.email', 'accept@example.com']);
  git(root, ['config', 'user.name', 'accept']);
  writeFileSync(path.join(root, 'README.md'), '# accept\n');
  r = git(root, ['add', '.']);
  if (r.code !== 0) fail('git add', r);
  r = git(root, ['commit', '-qm', 'init']);
  if (r.code !== 0) fail('git commit', r);
  r = cw(root, ['init']);
  if (r.code !== 0) fail('cowork init', r);
  return root;
}

function lane(root, name) {
  const r = git(root, ['worktree', 'add', `.cowork/lanes/${name}`, '-b', name]);
  if (r.code !== 0) throw new Error(`建车道 ${name} 失败：${r.out.trim()}`);
  return path.join(root, '.cowork', 'lanes', name);
}

function addTask(root, title, touches, extra = []) {
  const r = cw(root, ['task', 'add', '--title', title, '--touches', touches, ...extra]);
  const id = (r.out.match(TASK_ID) ?? [])[0];
  return { r, id };
}

function commitAll(root, msg = 'tasks') {
  git(root, ['add', '.']);
  return git(root, ['commit', '-qm', msg]);
}

/** 断言小工具：返回 true/false 并收集理由 */
function makeChecker() {
  const notes = [];
  const check = (ok, msg) => {
    if (!ok) notes.push(msg);
    return ok;
  };
  return { check, notes, done: () => notes };
}

function commonDir(root) {
  const r = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return r.code === 0 ? r.out.trim() : null;
}

/** live 状态目录下的相对文件清单（用于断言某条命令没写入任何东西）。 */
function listRel(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(dir, '');
  return out.sort();
}

const checks = [];
const def = (id, title, fn) => checks.push({ id, title, fn });

// 1. 缺 touches → exit 1
def(1, 'task add 缺 touches 退出 1', () => {
  const root = newRepo();
  const { check, done } = makeChecker();
  const r = cw(root, ['task', 'add', '--title', 'x']);
  check(r.code === 1, `期望 exit 1，实际 ${r.code}`);
  return done();
});

// 2. touches 是仓库根 → exit 1
def(2, 'touches 为仓库根退出 1', () => {
  const root = newRepo();
  const { check, done } = makeChecker();
  for (const bad of ['.', './', '**', '']) {
    const r = cw(root, ['task', 'add', '--title', 'x', '--touches', bad]);
    check(r.code === 1, `--touches ${JSON.stringify(bad)} 期望 exit 1，实际 ${r.code}`);
  }
  return done();
});

// 3. 路径被 claim 占着 → next 拒绝并说明占位者
def(3, 'touches 被占时 next 退出 1 并打印占用者', () => {
  const root = newRepo();
  const a = lane(root, 'a');
  const b = lane(root, 'b');
  const { check, done } = makeChecker();
  const c = cw(a, ['claim', 'src/auth/login.ts'], 'a');
  check(c.code === 0, `车道 a claim 失败：${c.out.trim()}`);
  const { r: addR, id } = addTask(root, '登录改造', 'src/auth/**');
  check(Boolean(id), `task add 没给出 id：${addR.out.trim()}`);
  commitAll(root);
  const ready = cw(root, ['task', 'ready', id]);
  check(ready.code === 0, `task ready 失败：${ready.out.trim()}`);
  const n = cw(b, ['next'], 'b');
  check(n.code === 1, `期望 next exit 1，实际 ${n.code}：${n.out.trim().slice(0, 200)}`);
  check(n.out.includes('src/auth/login.ts'), '输出里没有冲突路径');
  check(new RegExp(`lane\\s+a\\b`).test(n.out), `输出里没有占用者车道 a：${n.out.trim().slice(0, 300)}`);
  check(new RegExp(`agent=(agent-)?a\\b`).test(n.out), `输出里没有占用者 agent a：${n.out.trim().slice(0, 300)}`);
  return done();
});

// 4. 两车道同一 barrier 同时 next → 一个 0 一个 2，输家打印赢家 lane
def(4, '并发 next 恰好一方胜出，输家打印赢家 lane', async () => {
  const root = newRepo();
  const a = lane(root, 'a');
  const b = lane(root, 'b');
  const { check, done } = makeChecker();
  const { id } = addTask(root, '共享任务', 'src/shared/**');
  check(Boolean(id), 'task add 没给出 id');
  commitAll(root);
  const ready = cw(root, ['task', 'ready', id]);
  check(ready.code === 0, `task ready 失败：${ready.out.trim().slice(0, 200)}`);

  const dir = mkdtempSync(path.join(os.tmpdir(), 'cowork-accept-race-'));
  TMP.push(dir);
  const racer = path.join(dir, 'racer.mjs');
  const racerCode = [
    "import { spawnSync } from 'node:child_process';",
    "import fs from 'node:fs';",
    "const [barrier, readyFile, cli, cwd, agent] = process.argv.slice(2);",
    "fs.writeFileSync(readyFile, '1');",
    "const t0 = Date.now();",
    "while (!fs.existsSync(barrier)) { if (Date.now() - t0 > 15000) process.exit(9); }",
    "const r = spawnSync(process.execPath, [cli, 'next'], { cwd, encoding: 'utf8', env: { ...process.env, COWORK_AGENT_ID: agent }, windowsHide: true });",
    "process.stdout.write(JSON.stringify({ code: r.status, out: (r.stdout || '') + (r.stderr || '') }));",
    '',
  ].join('\n');
  writeFileSync(racer, racerCode);

  const racers = [
    { cwd: a, agent: 'agent-a', tag: 'a' },
    { cwd: b, agent: 'agent-b', tag: 'b' },
  ];
  const readyFiles = racers.map((item, index) => path.join(dir, `ready-${index}`));
  const kids = racers.map(
    (item, index) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [racer, path.join(dir, 'go'), readyFiles[index], CLI, item.cwd, item.agent], {
          windowsHide: true,
        });
        let buf = '';
        child.stdout.on('data', (data) => (buf += data));
        child.on('close', () => {
          let parsed = { code: -1, out: `racer 没有输出（${buf}）` };
          try {
            parsed = JSON.parse(buf);
          } catch {
            /* 保留兜底 */
          }
          resolve({ ...item, ...parsed });
        });
      }),
  );
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !readyFiles.every((file) => existsSync(file))) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  check(readyFiles.every((file) => existsSync(file)), '两个 racer 没有同时就位（barrier 超时）');
  writeFileSync(path.join(dir, 'go'), '1');
  const settled = await Promise.all(kids);
  const summary = settled.map((item) => `${item.tag}=${item.code}`).join(' ');
  const winners = settled.filter((item) => item.code === 0);
  const losers = settled.filter((item) => item.code !== 0);
  check(winners.length === 1, `应恰好一个赢家，实际 ${summary}`);
  check(losers.length === 1 && losers[0].code === 2, `输家应 exit 2，实际 ${summary}`);
  if (winners.length === 1 && losers.length === 1) {
    const winner = winners[0];
    check(
      new RegExp(`lane\\s+${winner.tag}\\b`).test(losers[0].out),
      `输家没有打印赢家 lane ${winner.tag}：${losers[0].out.trim().slice(0, 300)}`,
    );
  }
  const common = commonDir(root);
  const claimsDir = common === null ? null : path.join(common, 'cowork', 'claims');
  const claims = claimsDir === null ? [] : listRel(claimsDir).filter((file) => file.endsWith('.json'));
  const shown = cw(root, ['task', 'show', id, '--json']);
  let touched = [];
  try {
    touched = JSON.parse(shown.out).view.touches ?? [];
  } catch {
    touched = [];
  }
  check(
    touched.length > 0 && claims.length === touched.length,
    `claims 数应等于 touches 数（${touched.length}），实际 ${claims.length} 个（不允许部分占位）`,
  );
  return done();
});

// 5. lane 私有未提交 spec 不能 ready
def(5, '未提交到 trunk 的 spec 不能 ready', () => {
  const root = newRepo();
  const a = lane(root, 'a');
  const { check, done } = makeChecker();
  const { id } = addTask(a, '车道私有', 'src/only-a.ts');
  check(Boolean(id), 'task add 没给出 id');
  const ready = cw(a, ['task', 'ready', id]);
  check(ready.code === 1, `期望 exit 1，实际 ${ready.code}：${ready.out.trim().slice(0, 200)}`);
  return done();
});

// 6. ready 之后 snapshot 里有状态与 spec_commit
def(6, 'snapshot 显示 ready 与 spec_commit', () => {
  const root = newRepo();
  const { check, done } = makeChecker();
  const { id } = addTask(root, '待领取', 'src/x/**');
  commitAll(root);
  const ready = cw(root, ['task', 'ready', id]);
  check(ready.code === 0, `task ready 失败：${ready.out.trim().slice(0, 200)}`);
  const snap = cw(root, ['snapshot', '--json']);
  check(snap.code === 0, `snapshot 失败：${snap.out.trim().slice(0, 200)}`);
  let data = null;
  try {
    data = JSON.parse(snap.out);
  } catch {
    check(false, 'snapshot 输出不是合法 JSON');
  }
  if (data) {
    const t = (data.tasks ?? []).find((x) => x && x.id === id);
    check(Boolean(t), `snapshot.tasks 里找不到 ${id}`);
    if (t) {
      check(t.status === 'ready', `期望 status=ready，实际 ${t.status}`);
      check(Boolean(t.spec_commit), 'spec_commit 为空');
    }
  }
  return done();
});

// 7. 依赖只认 merged
def(7, '依赖只认 merged（reported_done 不解锁）', () => {
  const root = newRepo();
  const a = lane(root, 'a');
  const b = lane(root, 'b');
  const { check, done } = makeChecker();
  const A = addTask(root, '底层', 'src/a.ts');
  commitAll(root);
  check(cw(root, ['task', 'ready', A.id]).code === 0, 'A ready 失败');
  const B = addTask(root, '上层', 'src/b.ts', ['--depends', A.id]);
  check(Boolean(B.id), 'B add 失败');
  commitAll(root);
  check(cw(root, ['task', 'ready', B.id]).code === 0, 'B ready 失败');

  const gotA = cw(a, ['next'], 'a');
  check(gotA.code === 0 && gotA.out.includes(A.id), `车道 a 应领到 A：${gotA.out.trim().slice(0, 200)}`);
  check(cw(a, ['task', 'start', A.id], 'a').code === 0, 'A start 失败');
  check(cw(a, ['task', 'report-done', A.id], 'a').code === 0, 'A report-done 失败');

  const blocked = cw(b, ['next'], 'b');
  check(blocked.code === 1, `A 只到 reported_done 时 B 应不可领（exit 1），实际 ${blocked.code}`);
  check(blocked.out.includes(A.id), '阻塞原因里没有提到依赖任务 A');

  const confirm = cw(root, ['task', 'confirm-merge', A.id, '--commit', 'HEAD', '--manual', '--reason', '验收脚本']);
  check(confirm.code === 0, `confirm-merge 失败：${confirm.out.trim().slice(0, 200)}`);
  const unblocked = cw(b, ['next'], 'b');
  check(unblocked.code === 0, `A merged 后 B 应可领，实际 ${unblocked.code}：${unblocked.out.trim().slice(0, 200)}`);
  return done();
});

// 8. lane new 的名字校验与重名
def(8, 'lane new 名字校验与重名冲突', () => {
  const root = newRepo();
  const { check, done } = makeChecker();
  for (const bad of ['bad/../name', '.', '..', 'a/b', 'A']) {
    const r = cw(root, ['lane', 'new', bad]);
    check(r.code === 1, `lane new ${bad} 期望 exit 1，实际 ${r.code}`);
  }
  const common = commonDir(root);
  const liveRoot = common === null ? null : path.join(common, 'cowork');
  const before = liveRoot === null ? [] : listRel(liveRoot);
  check(cw(root, ['lane', 'new', 'ok-lane']).code === 0, 'lane new ok-lane 失败');
  const dup = cw(root, ['lane', 'new', 'ok-lane']);
  check(dup.code === 2, `重名期望 exit 2，实际 ${dup.code}`);
  const after = liveRoot === null ? [] : listRel(liveRoot);
  const added = after.filter((file) => !before.includes(file));
  const removed = before.filter((file) => !after.includes(file));
  check(
    added.length === 0 && removed.length === 0,
    `lane new 不应写 live 状态：新增 ${added.join(',') || '无'} / 删除 ${removed.join(',') || '无'}`,
  );
  const withTask = cw(root, ['lane', 'new', 'other', '--task', 't-000000']);
  check(withTask.code !== 0, '--task 应已移除，却仍然接受');
  return done();
});

// 9. 损坏的 live 文件 → doctor exit 1，next fail closed
def(9, '损坏 live 状态时不伪装成空', () => {
  const root = newRepo();
  const { check, done } = makeChecker();
  const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.code !== 0) return [`拿不到 git-common-dir：${common.out.trim()}`];
  const liveTasks = path.join(common.out.trim(), 'cowork', 'tasks');
  mkdirSync(liveTasks, { recursive: true });
  writeFileSync(path.join(liveTasks, 't-ffffff.json'), '{"id":"t-ffffff","status":');
  const doc = cw(root, ['doctor']);
  check(doc.code === 1, `doctor 遇到损坏 live 应 exit 1，实际 ${doc.code}`);
  const n = cw(root, ['next']);
  check(n.code !== 0, `next 遇到损坏 live 应 fail closed，实际 exit ${n.code}`);

  // §12.9 半截 pending intent：下一条命令回滚它、清掉 intent、live 回到 ready，随后仍能领到
  const root2 = newRepo();
  const laneB = lane(root2, 'b');
  const added = addTask(root2, '半截事务', 'src/half/**');
  check(Boolean(added.id), '§12.9 task add 没给出 id');
  commitAll(root2);
  check(cw(root2, ['task', 'ready', added.id]).code === 0, '§12.9 task ready 失败');
  const common2 = commonDir(root2);
  if (common2 === null) return ['§12.9 拿不到 git-common-dir'];
  const state2 = path.join(common2, 'cowork');
  const liveFile = path.join(state2, 'tasks', `${added.id}.json`);
  const prevLive = JSON.parse(readFileSync(liveFile, 'utf8'));
  const firstNext = cw(laneB, ['next'], 'b');
  check(firstNext.code === 0, `§12.9 首次 next 失败：${firstNext.out.trim().slice(0, 300)}`);
  const claimsDir = path.join(state2, 'claims');
  const claimFiles = existsSync(claimsDir) ? readdirSync(claimsDir).filter((file) => file.endsWith('.json')) : [];
  check(claimFiles.length >= 1, `§12.9 首次 next 没有写 claims（${claimFiles.length}）`);
  const claim = JSON.parse(readFileSync(path.join(claimsDir, claimFiles[0]), 'utf8'));
  const claimIds = claimFiles.map((file) => file.replace(/\.json$/, ''));
  const intentsDir = path.join(state2, 'tasks', 'intents');
  mkdirSync(intentsDir, { recursive: true });
  writeFileSync(
    path.join(intentsDir, 'op-half.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        operation_id: 'op-half',
        task_id: added.id,
        lane: claim.lane,
        lane_path: claim.lanePath,
        agent: claim.agentId,
        branch: claim.branch,
        prev: prevLive,
        claim_ids: claimIds,
        phase: 'pending',
        created_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  const afterHalf = cw(laneB, ['next'], 'b');
  check(afterHalf.code === 0, `§12.9 半截 intent 后 next 应成功，实际 ${afterHalf.code}：${afterHalf.out.trim().slice(0, 300)}`);
  const intentsLeft = existsSync(intentsDir) ? readdirSync(intentsDir) : [];
  check(intentsLeft.length === 0, `§12.9 intent 没被清除：${intentsLeft.join(',')}`);
  const liveAfter = JSON.parse(readFileSync(liveFile, 'utf8'));
  check(
    liveAfter.status === 'claimed' && liveAfter.lane === 'b',
    `§12.9 回滚后应重新领给 lane b，实际 status=${liveAfter.status} lane=${liveAfter.lane}`,
  );
  return done();
});

// 10. 构建与测试门槛
def(10, 'npm test ≥60 且 tsc 干净（默认执行）', () => {
  // Windows 上 npm 是 npm.cmd，直接 spawn 会 ENOENT；只有这条命令需要 shell。
  const test = run('npm', ['test'], process.cwd(), {}, process.platform === 'win32');
  if (test.code !== 0) return [`npm test 退出 ${test.code}\n${test.out.trim().slice(-600)}`];
  const m = test.out.match(/#\s*tests\s+(\d+)/);
  const count = m ? Number(m[1]) : 0;
  if (count < 60) return [`子测试数 ${count} < 60`];
  const tsc = run('npx', ['tsc', '--noEmit'], process.cwd(), {}, process.platform === 'win32');
  if (tsc.code !== 0) return [`tsc 失败：\n${tsc.out.trim().slice(-600)}`];
  return [];
});

if (!has("--allow-missing")) assertImplemented();

const results = [];
for (const c of checks) {
  if (ONLY.length && !ONLY.includes(c.id)) continue;
  let problems;
  try {
    problems = await c.fn();
    if (problems === undefined) problems = [];
  } catch (err) {
    problems = [`检查抛错：${err instanceof Error ? err.message : String(err)}`];
  }
  const isSkip = problems.length === 1 && String(problems[0]).startsWith('跳过');
  const status = problems.length === 0 ? 'PASS' : isSkip ? 'SKIP' : 'FAIL';
  results.push({ id: c.id, title: c.title, status, problems });
  const mark = status === 'PASS' ? '✓' : status === 'SKIP' ? '·' : '✗';
  console.log(`${mark} [${c.id}] ${c.title}`);
  for (const p of problems) console.log(`    ${String(p).split('\n').join('\n    ')}`);
}

const failed = results.filter((r) => r.status === 'FAIL');
const skipped = results.filter((r) => r.status === 'SKIP');
console.log(
  `\n${results.length} 条：${results.length - failed.length - skipped.length} PASS，` +
    `${failed.length} FAIL，${skipped.length} SKIP`,
);
process.exit(failed.length ? 1 : 0);
