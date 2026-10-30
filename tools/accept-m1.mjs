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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  check(n.out.includes('a'), '输出里没有占用者车道');
  return done();
});

// 4. 两车道同时 next 同一任务 → 一个 0 一个 2
def(4, '并发 next 恰好一方胜出（观察型）', async () => {
  const observations = [];
  for (let round = 0; round < 3; round += 1) {
    const root = newRepo();
    const a = lane(root, 'a');
    const b = lane(root, 'b');
    const { id } = addTask(root, '共享任务', 'src/shared/**');
    commitAll(root);
    const ready = cw(root, ['task', 'ready', id]);
    if (ready.code !== 0) return [`task ready 失败：${ready.out.trim().slice(0, 200)}`];
    const spawnNext = (cwd, agent) =>
      new Promise((resolve) => {
        const p = spawn(process.execPath, [CLI, 'next'], {
          cwd,
          env: { ...process.env, COWORK_AGENT_ID: agent },
          windowsHide: true,
        });
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (out += d));
        p.on('close', (code) => resolve({ code, out }));
      });
    const [ra, rb] = await Promise.all([spawnNext(a, 'a'), spawnNext(b, 'b')]);
    observations.push([ra.code, rb.code].sort((x, y) => x - y));
    if (ra.code === 0 && rb.code === 0) {
      return [`第 ${round + 1} 轮出现双重领取：两方都 exit 0\n${ra.out}\n${rb.out}`];
    }
    if (observations.at(-1).join() === '0,2') return [];
  }
  return [
    `3 轮都没观察到 (0,2)，实际为 ${observations.map((o) => `(${o.join(',')})`).join(' ')}` +
      '\n  → 可能是进程没真正重叠，也可能是竞争失败也返回 1；需人工确认（工作令 §5.4）',
  ];
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
  check(cw(root, ['lane', 'new', 'ok-lane']).code === 0, 'lane new ok-lane 失败');
  const dup = cw(root, ['lane', 'new', 'ok-lane']);
  check(dup.code === 2, `重名期望 exit 2，实际 ${dup.code}`);
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
  return done();
});

// 10. 构建与测试门槛
def(10, 'npm test ≥60 且 tsc 干净（需 --with-build）', () => {
  if (!has('--with-build')) return ['跳过：未加 --with-build'];
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
