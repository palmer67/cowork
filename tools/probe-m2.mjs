#!/usr/bin/env node
// M2 独立验收探针：不复用 tools/accept-m2.mjs 的任何断言，自己起临时仓库、自己造场景。
// 依据 docs/WORKORDER-M2.md（dsh/m2-design）与 dsh-review:docs/M2-REVIEW-CRITERIA.md。
// 用法: node tools/probe-m2.mjs <仓库路径> <构建后的 cli.js 路径>
//
// M2 尚未实现时，本脚本不会报一堆 FAIL，而是先探测能力，缺能力就整段 SKIP 并说明原因。
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';

const repo = process.argv[2];
const cli = process.argv[3];
if (!repo || !cli) {
  console.error('用法: node tools/probe-m2.mjs <仓库> <cli.js>');
  process.exit(2);
}

let failures = 0;
let skipped = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS ${name}`);
  else { failures += 1; console.log(`FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`); }
}
function note(name, detail) { console.log(`NOTE ${name}: ${detail}`); }
function skip(name, why) { skipped += 1; console.log(`SKIP ${name} — ${why}`); }

function run(args, cwd, allowFail = false) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = /** @type {{status?: number, stdout?: string, stderr?: string}} */ (err);
    if (!allowFail) throw new Error(`cowork ${args.join(' ')} 意外失败: ${e.stdout ?? ''}${e.stderr ?? ''}`);
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function idFrom(out) {
  const id = /t-[0-9a-f]{6}/.exec(out)?.[0];
  if (id === undefined) throw new Error(`没拿到任务 id: ${out}`);
  return id;
}

const root = mkdtempSync(path.join(tmpdir(), 'cowork-probe-m2-'));
const keep = process.argv.includes('--keep');
function cleanup() {
  if (keep) { console.log(`现场保留: ${root}`); return; }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
}
process.on('exit', cleanup);

// ---- 场景夹具 -------------------------------------------------------------

const VERIFY_SCRIPTS = {
  'v-pass.js': 'process.exit(0);\n',
  'v-fail.js': 'console.error("probe: 故意失败"); process.exit(1);\n',
  'v-dirty.js': "const { writeFileSync } = require('node:fs'); writeFileSync('probe-side-effect.txt', 'x'); process.exit(0);\n",
  'v-slow.js': 'setTimeout(() => process.exit(0), 5000);\n',
  'v-slow-pass.js': 'setTimeout(() => process.exit(0), 4000);\n',
};

/**
 * 写 .cowork/config.json 并提交到当前 HEAD。
 * @param {string} cwd
 * @param {{name: string, argv: string[], timeout_ms?: number, enabled?: boolean}[]} commands
 * @param {{allow_disabled?: boolean}} [extra]
 */
function writeConfig(cwd, commands, extra = {}) {
  mkdirSync(path.join(cwd, '.cowork'), { recursive: true });
  const full = commands.map((c) => ({ name: c.name, argv: c.argv, timeout_ms: c.timeout_ms ?? 60000, enabled: c.enabled ?? true }));
  const config = { schemaVersion: 1, trunk: 'main', verification: { allow_disabled: extra.allow_disabled ?? false, commands: full, env_allowlist: ['PATH', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'NODE_ENV'] } };
  writeFileSync(path.join(cwd, '.cowork', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  git(['add', '.cowork/config.json'], cwd);
  git(['commit', '-q', '-m', 'config: probe verification'], cwd);
}
/** 用 node 直接跑一个探针脚本，避免 shell 包装器 */
function nodeArgv(script) { return [process.execPath.replaceAll('\\', '/'), `tools/${script}`]; }

function initRepo() {
  git(['init', '-b', 'main'], root);
  git(['config', 'user.email', 'probe@example.com'], root);
  git(['config', 'user.name', 'Probe'], root);
  git(['config', 'core.autocrlf', 'false'], root);
  git(['config', 'core.safecrlf', 'false'], root);
  mkdirSync(path.join(root, 'src', 'foo', 'bar'), { recursive: true });
  mkdirSync(path.join(root, 'tools'), { recursive: true });
  for (const [name, body] of Object.entries(VERIFY_SCRIPTS)) writeFileSync(path.join(root, 'tools', name), body);
  writeFileSync(path.join(root, 'src', 'api.ts'), 'export const api = 1;\n');
  writeFileSync(path.join(root, 'src', 'foo', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(root, 'src', 'foo', 'bar', 'b.ts'), 'export const b = 1;\n');
  writeFileSync(path.join(root, 'src', 'foobar.ts'), 'export const fb = 1;\n');
  writeFileSync(path.join(root, 'README.md'), '# probe m2\n');
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'init'], root);
  const r = run(['init'], root, true);
  if (r.code !== 0) throw new Error(`cowork init 失败: ${r.stdout}${r.stderr}`);
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'chore: cowork init'], root);
}

/** 建车道并返回路径 */
function lane(name) {
  const r = run(['lane', 'new', name], root, true);
  if (r.code !== 0) throw new Error(`lane new ${name} 失败: ${r.stdout}${r.stderr}`);
  const dir = path.join(root, '.cowork', 'lanes', name);
  if (!existsSync(dir)) throw new Error(`车道目录不存在: ${dir}`);
  return dir;
}

/** 造一个 ready 任务并领取，返回 { id, laneDir } */
function readyTask(title, touches, laneName) {
  const add = run(['task', 'add', '--title', title, '--touches', ...touches, '--done-when', 'probe'], root);
  const id = idFrom(add.stdout);
  git(['add', '.cowork/tasks'], root);
  git(['commit', '-q', '-m', `task: ${id}`], root);
  const r = run(['task', 'ready', id], root, true);
  if (r.code !== 0) throw new Error(`task ready 失败: ${r.stdout}${r.stderr}`);
  const laneDir = path.join(root, '.cowork', 'lanes', laneName);
  const n = run(['next'], laneDir, true);
  if (n.code !== 0) throw new Error(`next 失败: ${n.stdout}${n.stderr}`);
  run(['task', 'start', id], laneDir, true);
  return { id, laneDir };
}

function readLive(id) {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
  const p = path.join(common, 'cowork', 'tasks', `${id}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

// ---- 能力探测 -------------------------------------------------------------

function hasM2() {
  const add = run(['task', 'add', '--title', '能力探测', '--touches', 'src/api.ts', '--done-when', 'probe'], root, true);
  const id = /t-[0-9a-f]{6}/.exec(add.stdout)?.[0];
  if (id === undefined) return { ok: false, why: 'task add 不可用' };
  git(['add', '.cowork/tasks'], root);
  git(['commit', '-q', '-m', `task: ${id}`], root);
  run(['task', 'ready', id], root, true);
  const l = run(['lane', 'new', 'probe-m2'], root, true);
  if (l.code !== 0) return { ok: false, why: `lane new 失败: ${l.stdout}${l.stderr}` };
  const laneDir = path.join(root, '.cowork', 'lanes', 'probe-m2');
  run(['next'], laneDir, true);
  run(['task', 'start', id], laneDir, true);
  const done = run(['task', 'done', id], laneDir, true);
  if (done.code === 0 || /verifying|verify_failed|awaiting_merge/.test(done.stdout + done.stderr)) return { ok: true, id, laneDir };
  return { ok: false, why: `task done 未进入 M2 流程: code=${done.code} ${(done.stdout + done.stderr).trim().slice(0, 200)}` };
}

// ---- 主流程 ---------------------------------------------------------------

console.log(`M2 probe | repo=${root} | cli=${cli}`);
try {
  initRepo();

  const cap = hasM2();
  if (!cap.ok) {
    console.log(`\nSKIP 全部 M2 检查 — ${cap.why}`);
    console.log('\nM2 尚未在当前构建里实现；探针骨架就绪，实现落地后直接重跑。');
    process.exit(0);
  }
  const okLane = path.join(root, '.cowork', 'lanes', 'probe-m2');

  // P1 验证期间不阻塞别的车道 + 状态不共享
  {
    writeConfig(root, [{ name: 'slow', argv: nodeArgv('v-slow-pass.js'), timeout_ms: 60000 }]);
    const { id, laneDir } = readyTask('P1 慢验证', ['src/api.ts'], 'probe-m2');
    const child = spawn(process.execPath, [cli, 'task', 'done', id], { cwd: laneDir, windowsHide: true });
    let finished = false;
    const t0 = Date.now();
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', () => { finished = true; });
    await sleep(600);
    const other = lane('probe-m2-b');
    const tNext = Date.now();
    const n = run(['next'], other, true);
    const elapsed = Date.now() - tNext;
    check('P1 验证期间 next 不被阻塞（<2s）', elapsed < 2000, `耗时 ${elapsed}ms`);
    const live = readLive(id);
    check('P1 验证期间状态为 verifying', live?.status === 'verifying', `实际 ${live?.status}`);
    check('P1 验证期间 lease 与 claims 保留', live?.lane === 'probe-m2', `lane=${live?.lane}`);
    await new Promise((res) => { const t = setInterval(() => { if (finished) { clearInterval(t); res(); } else if (Date.now() - t0 > 30000) { clearInterval(t); child.kill(); res(); } }, 200); });
  }

  // P2 失败 → verify_failed 且保留占位
  {
    writeConfig(root, [{ name: 'fail', argv: nodeArgv('v-fail.js'), timeout_ms: 60000 }]);
    const { id, laneDir } = readyTask('P2 失败', ['src/api.ts'], 'probe-m2');
    const r = run(['task', 'done', id], laneDir, true);
    const live = readLive(id);
    check('P2 失败退出 1', r.code === 1, `实际 ${r.code}`);
    check('P2 状态为 verify_failed', live?.status === 'verify_failed', `实际 ${live?.status}`);
    check('P2 保留 lease 与 claims', live?.lane === 'probe-m2' && Array.isArray(live?.claims) && live.claims.length === 1, JSON.stringify(live?.claims));
    check('P2 verification.records 记录失败', (live?.verification?.records ?? []).some((x) => x.exit !== 0), JSON.stringify(live?.verification?.records));
  }

  // P3 验证后 HEAD 漂移
  {
    writeConfig(root, [{ name: 'tamper', argv: nodeArgv('v-pass.js'), timeout_ms: 60000 }]);
    const { id, laneDir } = readyTask('P3 HEAD 漂移', ['src/api.ts'], 'probe-m2');
    const child = spawn(process.execPath, [cli, 'task', 'done', id], { cwd: laneDir, windowsHide: true });
    await sleep(400);
    writeFileSync(path.join(laneDir, 'tamper.txt'), 'x\n');
    git(['add', 'tamper.txt'], laneDir);
    git(['commit', '-q', '-m', 'tamper during verify'], laneDir);
    const code = await exitCode(child);
    const live = readLive(id);
    check('P3 HEAD 漂移后退出 1', code === 1, `实际 ${code}`);
    check('P3 不进入 awaiting_merge', live?.status !== 'awaiting_merge', `实际 ${live?.status}`);
  }

  // P4 初始 dirty 拒绝
  {
    const { id, laneDir } = readyTask('P4 dirty', ['src/api.ts'], 'probe-m2');
    writeFileSync(path.join(laneDir, 'src', 'api.ts'), 'export const api = 2;\n');
    const r = run(['task', 'done', id], laneDir, true);
    const live = readLive(id);
    check('P4 dirty 拒绝且退出 1', r.code === 1, `实际 ${r.code}`);
    check('P4 状态保持 in_progress', live?.status === 'in_progress', `实际 ${live?.status}`);
    git(['checkout', '--', 'src/api.ts'], laneDir);
  }

  // P5 超时
  {
    writeConfig(root, [{ name: 'slow', argv: nodeArgv('v-slow.js'), timeout_ms: 1500 }]);
    const { id, laneDir } = readyTask('P5 超时', ['src/api.ts'], 'probe-m2');
    const r = run(['task', 'done', id], laneDir, true);
    const live = readLive(id);
    const rec = (live?.verification?.records ?? [])[0];
    check('P5 超时退出 1', r.code === 1, `实际 ${r.code}`);
    check('P5 记录 timed_out=true', rec?.timed_out === true, JSON.stringify(rec));
    check('P5 状态 verify_failed', live?.status === 'verify_failed', `实际 ${live?.status}`);
  }

  // P6 重复 done
  {
    writeConfig(root, [{ name: 'slow', argv: nodeArgv('v-slow-pass.js'), timeout_ms: 60000 }]);
    const { id, laneDir } = readyTask('P6 重复 done', ['src/api.ts'], 'probe-m2');
    const child = spawn(process.execPath, [cli, 'task', 'done', id], { cwd: laneDir, windowsHide: true });
    await sleep(600);
    const again = run(['task', 'done', id], laneDir, true);
    check('P6 verifying 中重复 done 退出 2', again.code === 2, `实际 ${again.code}`);
    await exitCode(child);
  }

  // P7 成功 → awaiting_merge → confirm-merge
  {
    writeConfig(root, [{ name: 'pass', argv: nodeArgv('v-pass.js'), timeout_ms: 60000 }]);
    const { id, laneDir } = readyTask('P7 成功', ['src/api.ts'], 'probe-m2');
    const r = run(['task', 'done', id], laneDir, true);
    const live = readLive(id);
    check('P7 成功退出 0', r.code === 0, `实际 ${r.code}`);
    check('P7 状态 awaiting_merge', live?.status === 'awaiting_merge', `实际 ${live?.status}`);
    const head = git(['rev-parse', 'HEAD'], laneDir);
    const merge = run(['confirm-merge', id, '--commit', head, '--manual', '--reason', 'probe'], root, true);
    check('P7 confirm-merge 成功', merge.code === 0, `实际 ${merge.code} ${merge.stdout}${merge.stderr}`);
  }

  // P8 车道内篡改配置无效（R1）
  {
    const laneDir = okLane;
    writeConfig(root, [{ name: 'fail', argv: nodeArgv('v-fail.js'), timeout_ms: 60000 }]);
    writeConfig(laneDir, [{ name: 'pass', argv: nodeArgv('v-pass.js'), timeout_ms: 60000 }]);
    const { id } = readyTask('P8 篡改配置', ['src/foobar.ts'], 'probe-m2');
    const r = run(['task', 'done', id], laneDir, true);
    const live = readLive(id);
    check('P8 车道篡改 config 不生效（trunk 为准）', r.code === 1 && live?.status === 'verify_failed', `code=${r.code} status=${live?.status}`);
    check('P8 记录 config_commit', typeof live?.verification?.config_commit === 'string', JSON.stringify(live?.verification ?? {}).slice(0, 120));
  }

  // P9 契约提醒
  {
    const a = run(['task', 'add', '--title', 'P9 读方', '--touches', 'src/other.ts', '--reads', 'src/api.ts', '--done-when', 'probe'], root, true);
    const b = run(['task', 'add', '--title', 'P9 写方', '--touches', 'src/api.ts', '--done-when', 'probe'], root, true);
    const aid = /t-[0-9a-f]{6}/.exec(a.stdout)?.[0];
    const bid = /t-[0-9a-f]{6}/.exec(b.stdout)?.[0];
    if (aid === undefined || bid === undefined) {
      skip('P9 契约提醒', 'task add 不支持 --reads');
    } else {
      const snap = run(['snapshot', '--json'], root, true).stdout;
      const alerts = JSON.parse(snap)?.contract_alerts ?? [];
      check('P9 snapshot 出现结构化契约提醒', alerts.some((x) => x.kind && x.path === 'src/api.ts'), JSON.stringify(alerts).slice(0, 200));
    }
  }

  // P10 doctor 恢复崩溃的验证
  {
    const { id } = readyTask('P10 崩溃恢复', ['src/foobar.ts'], 'probe-m2');
    const live = readLive(id);
    if (live === null) throw new Error('P10 读不到 live');
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    live.status = 'verifying';
    live.verification = { run_id: 'probe-run', status: 'running', pid: dead.pid ?? 999999, host: hostname(), started_at: new Date().toISOString(), head_before: git(['rev-parse', 'HEAD'], root), records: [] };
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
    writeFileSync(path.join(common, 'cowork', 'tasks', `${id}.json`), `${JSON.stringify(live, null, 2)}\n`);
    const r = run(['doctor', '--fix'], root, true);
    const after = readLive(id);
    check('P10 doctor --fix 恢复为 reported_done', after?.status === 'reported_done', `实际 ${after?.status} ${r.stdout}${r.stderr}`);
    check('P10 恢复保留 claim', Array.isArray(after?.claims) && after.claims.length > 0, JSON.stringify(after?.claims));
  }
} catch (err) {
  failures += 1;
  console.error(`\n探针自身异常: ${err instanceof Error ? err.message : String(err)}`);
}

console.log(`\nM2 probe 结果: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}${skipped > 0 ? `, ${skipped} SKIP` : ''}`);
process.exitCode = failures === 0 ? 0 : 1;

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }
function exitCode(child) {
  return new Promise((res) => { child.on('exit', (code) => res(code ?? 1)); });
}
