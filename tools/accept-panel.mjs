#!/usr/bin/env node
/** M1.5 工单 §8 的 13 项验收。先 npm run build，再 node tools/accept-panel.mjs。
 * 所有操作只针对独立临时仓库；不改当前仓库的任务/车道。失败退出 1，不跳过门禁。
 * --keep 保留临时仓库；--only 1,2 用于定位，默认必须跑全 13 条。
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const project = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(project, 'dist', 'cli.js');
if (!existsSync(cli)) { console.error('找不到 dist/cli.js；请先 npm run build。'); process.exit(2); }
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',').map(Number) : null;
const env = { ...process.env, COWORK_AGENT_ID: 'panel-operator' };
// 只限本脚本子进程，不改用户 Git 配置；避免 Windows init symlink 探测留下不可删 reparse 文件。
if (process.platform === 'win32') {
  const n = Number(env.GIT_CONFIG_COUNT ?? '0');
  env[`GIT_CONFIG_KEY_${n}`] = 'core.symlinks'; env[`GIT_CONFIG_VALUE_${n}`] = 'false'; env.GIT_CONFIG_COUNT = String(n + 1);
}
const root = mkdtempSync(path.join(tmpdir(), 'cowork-accept-panel-'));
const state = path.join(root, '.git', 'cowork');
const laneDir = (name) => path.join(root, '.cowork', 'lanes', name);
let child, childExited = false, port, token, id, failed = 0, passed = 0;

function run(command, argv, cwd = root, extra = {}, timeout = 180_000) {
  const r = spawnSync(command, argv, { cwd, env: { ...env, ...extra }, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}
function success(r) { assert.equal(r.code, 0, `${r.stdout}${r.stderr}${r.error ?? ''}`); return r; }
function git(argv) { return run('git', ['-C', root, ...argv]); }
function cw(argv, cwd = root, extra = {}) { return run(process.execPath, [cli, ...argv], cwd, extra); }
const output = (r) => r.stdout + r.stderr;
function init() {
  success(git(['init', '-q', '-b', 'main']));
  success(git(['config', 'user.name', 'panel-accept'])); success(git(['config', 'user.email', 'panel@example.invalid']));
  writeFileSync(path.join(root, 'README.md'), '# acceptance\n');
  success(git(['add', '.'])); success(git(['commit', '-qm', 'init'])); success(cw(['init']));
}
async function start() {
  child = spawn(process.execPath, [cli, 'ui', '--serve', '--port', '0'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`服务启动超时: ${err}`)), 20_000);
    const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
    child.once('error', finish);
    child.once('exit', (code) => { childExited = true; finish(new Error(`服务提前退出 ${code}: ${err}`)); });
    child.stderr.on('data', (s) => { err += s; });
    child.stdout.on('data', (s) => {
      out += s;
      const match = /面板已启动: http:\/\/127\.0\.0\.1:(\d+)\/\?t=([a-f0-9]{32})/.exec(out);
      if (match) { port = Number(match[1]); token = match[2]; finish(); }
    });
  });
  assert.equal(child.exitCode, null);
}
async function stop() {
  if (!child || childExited) return;
  const ended = new Promise((resolve) => child.once('exit', () => { childExited = true; resolve(); }));
  child.kill('SIGINT');
  const wait = (ms) => Promise.race([ended, delay(ms)]);
  await wait(3000);
  if (!childExited) { child.kill(); await wait(3000); }
  if (!childExited && process.platform === 'win32') {
    // Only terminate the service process this script started; Windows SIGINT is not a console Ctrl+C.
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
    await wait(5000);
  }
  if (!childExited) throw new Error(`验收服务没有退出 (PID ${child.pid})`);
}
function http(route, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: options.host ?? `127.0.0.1:${port}`, ...options.headers };
    if (options.auth !== false) headers['X-Cowork-Token'] = token;
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const req = request({ hostname: '127.0.0.1', port, path: route, method: options.method ?? 'GET', headers }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (s) => { text += s; });
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.setTimeout(65_000, () => req.destroy(new Error('HTTP 超时'))); req.on('error', reject); req.end(body);
  });
}
async function post(route, body = {}) {
  const r = await http(route, { method: 'POST', body }); assert.equal(r.status, 200, r.text); return JSON.parse(r.text);
}
const live = () => JSON.parse(readFileSync(path.join(state, 'tasks', `${id}.json`), 'utf8'));
function inventory(base) {
  const entries = [];
  if (!existsSync(base)) return entries;
  const walk = (file) => {
    if (!existsSync(file)) return;
    const stat = lstatSync(file, { bigint: true });
    entries.push([path.relative(base, file) || '.', stat.isDirectory() ? 'dir' : 'file', String(stat.mtimeNs)]);
    if (stat.isDirectory()) for (const name of readdirSync(file).sort()) walk(path.join(file, name));
  };
  walk(base); return entries;
}
async function check(number, name, fn) {
  if (only && !only.includes(number)) return;
  try { await fn(); passed++; console.log(`PASS ${number}. ${name}`); }
  catch (err) { failed++; console.error(`FAIL ${number}. ${name}\n${err.stack ?? err}`); }
}

try {
  init(); await start();
  await check(1, 'port 0 启动本机前台服务', async () => {
    assert.ok(port > 0); assert.equal(child.exitCode, null);
    const occupied = cw(['ui', '--serve', '--port', String(port)]);
    assert.equal(occupied.code, 3); assert.match(output(occupied), /--port/);
    assert.equal(cw(['ui', '--serve', '--port', 'invalid']).code, 3);
    assert.equal(cw(['ui', '--serve', '--out', 'bad.html']).code, 1);
  });
  await check(2, '首页与 API token 校验，HTML 含任务与契约', async () => {
    assert.equal((await http('/', { auth: false })).status, 401);
    assert.equal((await http('/?t=wrong')).status, 401);
    assert.equal((await http('/api/snapshot', { auth: false })).status, 401);
    const r = await http(`/?t=${token}`); assert.equal(r.status, 200); assert.match(r.text, /任务与契约/);
    assert.match(r.text, /history.replaceState/);
  });
  await check(3, '非本地 Host 返回 403', async () => assert.equal((await http('/api/snapshot', { host: 'evil.example' })).status, 403));
  await check(4, 'OPTIONS 返回 405 且无 CORS', async () => {
    const r = await http('/api/lane/new', { method: 'OPTIONS' }); assert.equal(r.status, 405);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    assert.equal((await http('/api/task/add', { method: 'POST', body: { title: 'x', agent: 'dsh' } })).status, 400);
  });
  await check(5, '新建 dsh 车道与 cowork/dsh 分支', async () => {
    success(await post('/api/lane/new', { name: 'dsh' })); assert.ok(existsSync(laneDir('dsh')));
    success(git(['show-ref', '--verify', 'refs/heads/cowork/dsh']));
  });
  await check(6, '重复车道返回 2 及原始诊断', async () => {
    const r = await post('/api/lane/new', { name: 'dsh' }); assert.equal(r.code, 2); assert.match(output(r), /车道已存在/);
  });
  await check(7, '创建、提交、ready、派工，live/lease/claim 一致', async () => {
    const added = success(await post('/api/task/add', { title: '验证登录', touches: ['src/auth/login.ts'], done_when: ['npm test'] }));
    id = added.stdout.match(/t-[0-9a-f]{6}/)?.[0]; assert.ok(id);
    success(git(['add', '.cowork/tasks'])); success(git(['commit', '-qm', 'task: login']));
    success(await post(`/api/task/${id}/ready`)); success(await post('/api/lane/dsh/next'));
    assert.equal(live().status, 'claimed'); assert.equal(live().lane, 'dsh'); assert.equal(live().agent, 'dsh');
    const panelSnapshot = JSON.parse((await http('/api/snapshot')).text);
    assert.equal(panelSnapshot.panel_agent, 'panel-operator');
    const assigned = panelSnapshot.tasks.find((task) => task.id === id);
    assert.equal(assigned.assigned_lane, 'dsh'); assert.equal(assigned.agent, 'dsh');
    const home = await http(`/?t=${token}`); assert.equal(home.status, 200);
    const startNeedle = `data-api="/api/task/${id}/start"`;
    const startAt = home.text.indexOf(startNeedle); assert.notEqual(startAt, -1, '已派工任务必须显示 start 动作');
    const startBegin = home.text.lastIndexOf('<button', startAt);
    const startEnd = home.text.indexOf('</button>', startAt) + '</button>'.length;
    const startButton = home.text.slice(startBegin, startEnd);
    assert.match(startButton, /disabled title="需在车道 dsh 内由 dsh 执行"/);
    assert.match(home.text, new RegExp(`<code class="mono">cowork task start ${id}<\\/code>`));
    assert.match(home.text, new RegExp(`data-copy="cowork task start ${id}"`));
    // M1 当前把 lease 写入 live task JSON；claims 是独立目录，leases 目录可能不存在。
    assert.ok(existsSync(path.join(state, 'tasks', `${id}.json`))); assert.ok(readdirSync(path.join(state, 'claims')).length > 0);
    const detail = success(JSON.parse((await http(`/api/tasks/${id}`)).text)); assert.match(detail.stdout, /claimed/);
    success(JSON.parse((await http('/api/brief?lane=dsh')).text));
  });
  await check(8, '顺序重复 next 返回 1，任务归属不变（R1）', async () => {
    const before = live(); const r = await post('/api/lane/dsh/next');
    assert.equal(r.code, 1); assert.match(output(r), /没有可领取的任务/); assert.deepEqual(live(), before);
    const snap = JSON.parse((await http('/api/snapshot')).text); assert.equal(snap.tasks.find((t) => t.id === id).status, 'claimed');
  });
  await check(9, '既有占位冲突返回 1，路径与 agent=a 原样显示（R1，§8.9 旧字面为 2）', async () => {
    success(await post('/api/lane/new', { name: 'a' })); success(await post('/api/lane/new', { name: 'b' }));
    // 释放第 7 条的同路径任务；按 owner 在原车道 CLI 调用，不经面板冒充 owner。
    success(cw(['task', 'cancel', id, '--reason', 'acceptance conflict fixture'], laneDir('dsh'), { COWORK_AGENT_ID: 'dsh' }));
    success(cw(['claim', 'src/auth/login.ts'], laneDir('a'), { COWORK_AGENT_ID: 'a' }));
    const added = success(await post('/api/task/add', { title: 'conflicting task', touches: ['src/auth/login.ts'] }));
    const conflictId = added.stdout.match(/t-[0-9a-f]{6}/)[0];
    success(git(['add', '.cowork/tasks'])); success(git(['commit', '-qm', 'task: conflict'])); success(await post(`/api/task/${conflictId}/ready`));
    const r = await post('/api/lane/b/next'); assert.equal(r.code, 1); assert.match(output(r), /src\/auth\/login\.ts/); assert.match(output(r), /agent=a/);
  });
  await check(10, '导入三项 draft、依赖解析；环失败且零新增', async () => {
    const tasks = [
      { key: 'base', title: 'base', touches: ['src/base.ts'] },
      { key: 'middle', title: 'middle', touches: ['src/middle.ts'], depends_on: ['base'] },
      { key: 'last', title: 'last', touches: ['src/last.ts'], depends_on: ['middle'] },
    ];
    const file = path.join(root, 'plan.json'); writeFileSync(file, JSON.stringify({ schemaVersion: 1, tasks }));
    const before = readdirSync(path.join(root, '.cowork', 'tasks')).sort();
    success(await post('/api/import', { path: 'plan.json', dry_run: true }));
    assert.deepEqual(readdirSync(path.join(root, '.cowork', 'tasks')).sort(), before);
    const imported = success(await post('/api/import', { path: 'plan.json' }));
    const ids = Object.fromEntries([...imported.stdout.matchAll(/^\s+(base|middle|last)\s+→\s+(t-[a-f0-9]{6})/gm)].map((m) => [m[1], m[2]]));
    assert.equal(Object.keys(ids).length, 3);
    for (const [key, dep] of [['base', undefined], ['middle', ids.base], ['last', ids.middle]]) {
      const snapshot = JSON.parse(success(cw(['snapshot', '--json'])).stdout);
      const task = snapshot.tasks.find((entry) => entry.id === ids[key]);
      assert.equal(task.status, 'draft'); assert.deepEqual(task.depends_on, dep ? [dep] : []);
    }
    assert.equal(readdirSync(path.join(root, '.cowork', 'tasks')).length, before.length + 3);
    tasks[0].depends_on = ['last']; writeFileSync(file, JSON.stringify({ schemaVersion: 1, tasks }));
    const validFiles = inventory(path.join(root, '.cowork', 'tasks'));
    const r = await post('/api/import', { path: 'plan.json' }); assert.equal(r.code, 1); assert.match(output(r), /环/);
    assert.deepEqual(inventory(path.join(root, '.cowork', 'tasks')), validFiles);
  });
  await check(11, '五次快照跨缓存周期，持久状态文件集合与 mtime 不变（R2）', async () => {
    const bases = ['tasks', 'claims', 'intents', 'leases'].map((s) => path.join(state, s)); bases.push(path.join(root, '.cowork', 'tasks'));
    const before = bases.map(inventory);
    for (let i = 0; i < 5; i++) { if (i) await delay(1100); assert.equal((await http('/api/snapshot')).status, 200); }
    assert.deepEqual(bases.map(inventory), before);
  });
  await check(12, '静态 ui 退出、输出 HTML 与复制命令，无监听代码', async () => {
    success(cw(['ui', '--out', 'board.html'])); const html = readFileSync(path.join(root, 'board.html'), 'utf8');
    assert.match(html, /复制命令/); assert.match(html, /任务与契约/); assert.doesNotMatch(html, /fetch\(|data-api=|<dialog/);
  });
  await stop();
  await check(13, 'npm test / tsc 通过；零运行时依赖与架构门禁', async () => {
    const pkg = JSON.parse(readFileSync(path.join(project, 'package.json'), 'utf8')); assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
    const tests = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], project, {}, 600_000);
    // Windows .cmd 不能由无 shell 的 spawnSync 直接启动；使用 Node 运行 npm 官方入口。
    const npmEntry = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const testResult = tests.error?.code === 'EINVAL' || tests.error?.code === 'ENOENT' ? run(process.execPath, [npmEntry, 'test'], project, {}, 600_000) : tests;
    success(testResult); assert.match(testResult.stdout, /# fail 0/);
    const tsc = run(process.execPath, [path.join(project, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit'], project);
    success(tsc); assert.equal(tsc.stdout + tsc.stderr, '');
    // 判基线：本地 main 优先（CI 的单分支 checkout 没有它），退到 origin/main
    const baseRef = ['main', 'origin/main'].find((ref) => run('git', ['-C', project, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], project).code === 0);
    assert.ok(baseRef, '找不到 main 分支（本地或 origin/main）');
    const architecture = run('git', ['-C', project, 'diff', baseRef, '--', 'docs/ARCHITECTURE-TASKS.md', 'docs/ARCHITECTURE.md', 'test/ui.test.ts'], project);
    success(architecture); assert.equal(architecture.stdout, '');
    const source = readFileSync(path.join(project, 'src', 'uiserver.ts'), 'utf8'); assert.doesNotMatch(source, /writeFileSync|renameSync/);
    for (const name of readdirSync(path.join(project, 'src')).filter((s) => s.endsWith('.ts'))) assert.ok(!readFileSync(path.join(project, 'src', name), 'utf8').includes('0.0.0.0'));
    console.log(`  ${testResult.stdout.match(/# tests \d+/)?.[0]}; # fail 0; tsc: silent; dependencies: 0`);
  });
} catch (err) { failed++; console.error(`FAIL setup/cleanup: ${err.stack ?? err}`); }
finally {
  try { await stop(); } catch (err) { failed++; console.error(`FAIL stop: ${err.message}`); child?.kill(); }
  if (args.includes('--keep')) console.log(`临时仓库: ${root}`);
  else {
    for (const name of ['dsh', 'a', 'b']) if (existsSync(laneDir(name))) git(['worktree', 'remove', '--force', laneDir(name)]);
    try { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }); }
    catch (err) { failed++; console.error(`FAIL cleanup ${root}: ${err.message}`); }
  }
}
console.log(`\n${passed} PASS / ${failed} FAIL${only ? ' (partial run)' : ' / 13 checks'}`);
process.exitCode = failed ? 1 : 0;
