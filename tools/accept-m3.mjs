#!/usr/bin/env node
/** WORKORDER-M3 §6 的 10 条验收。先 npm run build，再 node tools/accept-m3.mjs。
 * --only 1,2 可定位；默认完整十条。所有产品操作针对系统临时仓库。
 * 第10条完整跑 npm test / tsc / build / M1 / panel / M2；日志落在忽略的 node_modules/.cache。
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const project = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const option = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
};
const cli = path.resolve(option('--cli', path.join(project, 'dist', 'cli.js')));
const only = option('--only', '').split(',').filter(Boolean).map(Number);
if (!existsSync(cli) || only.some((id) => !Number.isInteger(id) || id < 1 || id > 10)) {
  console.error('需要已构建的 CLI，且 --only 编号应为 1..10；先运行 npm run build。');
  process.exit(1);
}
const keep = process.argv.includes('--keep');
const repos = [];
const workers = new Set();
const env = { ...process.env, COWORK_AGENT_ID: 'm3-owner', NODE_NO_WARNINGS: '1', GIT_OPTIONAL_LOCKS: '0' };
if (process.platform === 'win32') {
  const n = Number(env.GIT_CONFIG_COUNT ?? '0');
  env[`GIT_CONFIG_KEY_${n}`] = 'core.symlinks'; env[`GIT_CONFIG_VALUE_${n}`] = 'false'; env.GIT_CONFIG_COUNT = String(n + 1);
}

function run(command, args, cwd, extra = {}, timeout = 120_000) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', env: { ...env, ...extra }, windowsHide: true,
    shell: false, windowsVerbatimArguments: command === 'cmd.exe', timeout, maxBuffer: 64 * 1024 * 1024,
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message ?? '' };
}
function output(result) { return `${result.stdout}${result.stderr}${result.error}`; }
function success(result) { assert.equal(result.code, 0, output(result)); return result; }
function git(root, args) { return success(run('git', args, root)).stdout.replace(/\r?\n$/, ''); }
function cw(root, args) { return run(process.execPath, [cli, ...args], root); }
function commit(root, message) { git(root, ['add', '.']); git(root, ['commit', '-qm', message]); }
function state(root) { return path.join(root, '.git', 'cowork'); }
function liveFile(root, id) { return path.join(state(root), 'tasks', `${id}.json`); }
function live(root, id) { return existsSync(liveFile(root, id)) ? JSON.parse(readFileSync(liveFile(root, id), 'utf8')) : null; }
function status(root) { return JSON.parse(success(cw(root, ['status', '--json'])).stdout); }
function noStack(result) { assert.doesNotMatch(result.stderr, /Error:|\n\s+at /); }

function newRepo(prefix = 'cowork-m3-accept-', milliseconds = 0) {
  const root = mkdtempSync(path.join(tmpdir(), prefix)); repos.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'accept']); git(root, ['config', 'user.email', 'accept@example.invalid']);
  git(root, ['config', 'core.longpaths', 'true']);
  writeFileSync(path.join(root, 'shared.txt'), Array.from({ length: 80 }, (_, n) => `line ${n + 1}`).join('\n') + '\n');
  commit(root, 'initial'); success(cw(root, ['init']));
  writeFileSync(path.join(root, '.cowork', 'config.json'), JSON.stringify({
    schemaVersion: 1, trunk: 'main', verification: {
      allow_disabled: false,
      commands: [{ name: 'probe', argv: [process.execPath, '-e', `setTimeout(() => process.stdout.write("verified"), ${milliseconds})`], timeout_ms: 15_000, enabled: true }],
      env_allowlist: ['PATH', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'CI', 'NODE_ENV', 'COWORK_AGENT_ID'],
    },
  }));
  commit(root, 'configure');
  return root;
}
function lane(root, name) {
  const dir = path.join(root, '.cowork', 'lanes', name);
  git(root, ['worktree', 'add', '-q', '-b', `accept/${name}`, dir, 'main']);
  return dir;
}
function conflictRepo() {
  const root = newRepo(); const dir = lane(root, 'conflict');
  const file = path.join(root, 'shared.txt');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/line 5\r?\n/, 'line 5\nextra one\nextra two\n').replace(/line 40\r?\n/, 'trunk forty\n'));
  commit(root, 'trunk overlap');
  const other = path.join(dir, 'shared.txt');
  writeFileSync(other, readFileSync(other, 'utf8').replace(/line 40\r?\n/, 'lane forty\n'));
  commit(dir, 'lane overlap');
  return { root, dir };
}
function add(root, title = 'accept task', touches = 'src/shared.ts', runner = cw) {
  const result = success(runner(root, ['task', 'add', '--title', title, '--touches', touches]));
  const id = result.stdout.trim().split(/\r?\n/).at(-1)?.match(/t-[0-9a-f]{6}/)?.[0];
  assert.ok(id, result.stdout); return { id, result };
}
function assigned(root, runner = cw) {
  const { id, result } = add(root, 'verify then merge', 'src/shared.ts', runner);
  commit(root, 'task spec');
  for (const args of [['task', 'ready', id], ['next'], ['task', 'start', id], ['task', 'report-done', id]]) success(runner(root, args));
  return { id, result };
}
function files(root, exclude = new Set()) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (exclude.has(entry.name)) return [];
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? files(file, exclude) : [file];
  }).sort();
}
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
function observed(root) {
  return {
    head: git(root, ['rev-parse', 'HEAD']),
    refs: git(root, ['for-each-ref', '--format=%(refname) %(objectname)']),
    status: git(root, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all']),
    index: digest(path.resolve(root, git(root, ['rev-parse', '--git-path', 'index']))),
    files: files(root, new Set(['.git', 'lanes'])).map((file) => [path.relative(root, file), digest(file)]),
  };
}
function startDone(root, id) {
  const child = spawn(process.execPath, [cli, 'task', 'done', id], { cwd: root, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  workers.add(child); let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
  child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => { workers.delete(child); resolve({ code: code ?? -1, stdout, stderr, error: '' }); });
  });
  return { child, done };
}

const checks = [];
function define(id, title, fn) { checks.push({ id, title, fn }); }

define(1, '无冲突的两条车道预演退出0并打印可合', () => {
  const root = newRepo();
  for (const name of ['alpha', 'beta']) {
    const dir = lane(root, name); writeFileSync(path.join(dir, `${name}.txt`), name); commit(dir, 'separate file');
    assert.match(success(cw(root, ['merge', '--dry-run', name])).stdout, /可合/);
  }
});

define(2, '同文件同段冲突退出2并显示双方hunk行号', () => {
  const { root } = conflictRepo();
  const result = cw(root, ['merge', '--dry-run', 'conflict']); assert.equal(result.code, 2, output(result));
  assert.match(result.stdout, /shared\.txt\s+hunk 40-40\s+与 main 的 42-42 重叠/);
});

define(3, '预演前后工作树、HEAD、index、status、refs与live完全不变', () => {
  const { root, dir } = conflictRepo();
  writeFileSync(path.join(root, 'staged.txt'), 'staged'); git(root, ['add', 'staged.txt']);
  writeFileSync(path.join(root, 'dirty.txt'), 'untracked'); writeFileSync(path.join(dir, 'shared.txt'), 'dirty\n', { flag: 'a' });
  mkdirSync(path.join(state(root), 'tasks', 'intents'), { recursive: true });
  writeFileSync(path.join(state(root), 'tasks', 'intents', 'pending.json'), '{"sentinel":true}');
  mkdirSync(path.join(state(root), 'lock')); writeFileSync(path.join(state(root), 'lock', 'owner.json'), '{"sentinel":true}');
  const before = [observed(root), observed(dir), files(state(root)).map((file) => [file, digest(file)])];
  assert.equal(cw(dir, ['merge', '--dry-run', 'conflict']).code, 2);
  assert.deepEqual([observed(root), observed(dir), files(state(root)).map((file) => [file, digest(file)])], before);
});

define(4, 'JSON冲突路径与人类输出一致，字段为snake_case', () => {
  const { root } = conflictRepo();
  const human = cw(root, ['merge', '--dry-run', 'conflict']); const json = cw(root, ['merge', '--dry-run', 'conflict', '--json']);
  assert.equal(json.code, 2, output(json)); const payload = JSON.parse(json.stdout);
  assert.equal(payload.can_merge, false); assert.ok(payload.base_head); assert.ok(payload.lane_head);
  assert.deepEqual(payload.conflicts.map((item) => item.path), ['shared.txt']);
  for (const conflict of payload.conflicts) assert.ok(human.stdout.includes(conflict.path));
});

define(5, 'status四块标题、超过40条时折叠、JSON保留全部任务', () => {
  const root = newRepo(); const at = new Date().toISOString();
  mkdirSync(path.join(root, '.cowork', 'tasks'), { recursive: true });
  for (let n = 1; n <= 45; n += 1) {
    const id = `t-${n.toString(16).padStart(6, '0')}`;
    writeFileSync(path.join(root, '.cowork', 'tasks', `${id}.md`), `---\n${JSON.stringify({
      schemaVersion: 1, id, title: `task ${n}`, touches: [`src/${n}.ts`], reads: [], depends_on: [], done_when: [], contracts: [], created_at: at,
    })}\n---\n`);
  }
  commit(root, 'dashboard specs'); const head = git(root, ['rev-parse', 'HEAD']);
  mkdirSync(path.join(state(root), 'tasks'), { recursive: true });
  for (let n = 1; n <= 45; n += 1) {
    const id = `t-${n.toString(16).padStart(6, '0')}`;
    writeFileSync(liveFile(root, id), JSON.stringify({
      schemaVersion: 1, id, status: 'verifying', lane: null, lanePath: root, agent: 'm3-owner', spec_commit: head,
      created_at: at, updated_at: at, blocked_reason: null, recovery: null, history: [],
      verification: { run_id: `verify-${id}`, status: 'running', pid: null, host: hostname(), pid_started_at: null, pid_start_error: null,
        started_at: at, finished_at: null, head_before: head, head_after: null, config_commit: head, summary: '', records: [] },
    }));
  }
  const human = success(cw(root, ['status'])).stdout;
  assert.ok(human.trimEnd().split(/\r?\n/).length <= 40, human);
  for (const title of ['车道', '占位', '任务', '提示']) assert.match(human, new RegExp(`^${title}\\r?$`, 'm'));
  assert.match(human, /另 37 条/); assert.equal(status(root).tasks.items.length, 45);
});

define(6, '真实verifying进程运行期间status可见且小于2秒返回', async () => {
  const root = newRepo('cowork-m3-running-', 5000); const { id } = assigned(root);
  const worker = startDone(root, id); const until = Date.now() + 15_000;
  while (live(root, id)?.verification?.pid == null && Date.now() < until) await delay(20);
  assert.equal(live(root, id)?.status, 'verifying'); assert.ok(live(root, id)?.verification?.pid);
  const started = performance.now(); const result = success(cw(root, ['status']));
  assert.ok(performance.now() - started < 2000, 'status被长验证阻塞'); assert.ok(result.stdout.includes(id)); assert.match(result.stdout, /verifying/);
  success(await worker.done); assert.equal(live(root, id).status, 'awaiting_merge');
});

function shellRunner(shell) {
  const wrapper = path.join(tmpdir(), `cowork-m3-shell-${process.pid}-${shell}.cjs`);
  writeFileSync(wrapper, "const {spawnSync}=require('node:child_process');const r=spawnSync(process.execPath,[process.env.COWORK_TEST_CLI,...JSON.parse(process.env.COWORK_TEST_ARGS)],{cwd:process.cwd(),encoding:'utf8',shell:false,windowsHide:true});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');if(r.error)process.stderr.write(r.error.message);process.exitCode=r.status??1;");
  return {
    run: (cwd, args) => {
      const extra = { COWORK_TEST_CLI: cli, COWORK_TEST_ARGS: JSON.stringify(args), COWORK_TEST_NODE: process.execPath, COWORK_TEST_WRAPPER: wrapper };
      return shell === 'powershell' ? run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        '$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); & $env:COWORK_TEST_NODE $env:COWORK_TEST_WRAPPER; exit $LASTEXITCODE'], cwd, extra) :
        run('cmd.exe', ['/d', '/s', '/c', '""%COWORK_TEST_NODE%" "%COWORK_TEST_WRAPPER%""'], cwd, extra);
    },
    cleanup: () => rmSync(wrapper, { force: true }),
  };
}

define(7, '中文加空格路径中init/add/next/status正常，Windows覆盖PowerShell和cmd', () => {
  for (const shell of process.platform === 'win32' ? ['powershell', 'cmd'] : ['direct']) {
    const root = newRepo(`cowork-m3 中文 空格-${shell}-`);
    const adapter = shell === 'direct' ? { run: cw, cleanup() {} } : shellRunner(shell);
    try {
      success(adapter.run(root, ['init']));
      const { id } = add(root, '中文 空格任务', 'src/中文 空格.ts', adapter.run);
      commit(root, 'unicode task'); success(adapter.run(root, ['task', 'ready', id]));
      success(adapter.run(root, ['next']));
      const result = success(adapter.run(root, ['status', '--json'])); noStack(result);
      assert.equal(JSON.parse(result.stdout).tasks.items.find((task) => task.id === id).status, 'claimed');
    } finally { adapter.cleanup(); }
  }
});

define(8, '真实三层>260路径成功或退出3，真实失败无堆栈与半写', () => {
  const root = newRepo(); const segments = ['a'.repeat(85), 'b'.repeat(85), 'c'.repeat(85)];
  for (const outputPath of [path.join(root, ...segments, 'index.html'), path.join(root, 'x'.repeat(300), 'index.html')]) {
    assert.ok(outputPath.length > 260);
    const result = cw(root, ['ui', '--out', outputPath]); noStack(result);
    if (result.code === 0) assert.match(readFileSync(outputPath, 'utf8'), /<!doctype html>/i);
    else {
      assert.equal(result.code, 3, output(result)); assert.match(result.stderr, /路径过长/); assert.match(result.stderr, /可开启 Windows 长路径支持/);
      assert.equal(existsSync(outputPath), false);
    }
    assert.equal(files(root, new Set(['.git'])).filter((file) => /\.tmp-/.test(file)).length, 0);
    assert.equal(existsSync(state(root)), false, '只读快照与面板输出不写live');
  }
});

define(9, 'add仅末行一个id；awaiting_merge取消释放lease与占位', () => {
  const root = newRepo(); const { id, result } = assigned(root);
  assert.equal(result.stdout.match(/t-[0-9a-f]{6}/g)?.length, 1, result.stdout);
  assert.equal(result.stdout.trim().split(/\r?\n/).at(-1), `下一步: 把 spec 提交到 trunk 后运行 cowork task ready ${id}。`);
  success(cw(root, ['task', 'done', id])); assert.equal(live(root, id).status, 'awaiting_merge'); assert.equal(status(root).claims.length, 1);
  success(cw(root, ['task', 'cancel', id, '--reason', 'acceptance cancellation']));
  assert.equal(live(root, id).status, 'cancelled');
  for (const key of ['lane', 'lanePath', 'agent']) assert.equal(live(root, id)[key], null);
  assert.equal(status(root).claims.length, 0);
});

define(10, 'npm test / tsc / build / accept-m1 / accept-panel / accept-m2全部通过', () => {
  const pkg = JSON.parse(readFileSync(path.join(project, 'package.json'), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, '零运行时依赖');
  const npm = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  assert.ok(existsSync(npm), `找不到npm入口: ${npm}`);
  const gates = [
    ['npm-test', [npm, 'test']],
    ['tsc', [path.join(project, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit']],
    ['build', [npm, 'run', 'build']],
    ['accept-m1', [path.join(project, 'tools', 'accept-m1.mjs'), '--cli', cli]],
    ['accept-panel', [path.join(project, 'tools', 'accept-panel.mjs')]],
    ['accept-m2', [path.join(project, 'tools', 'accept-m2.mjs'), '--cli', cli]],
  ];
  const logDir = path.join(project, 'node_modules', '.cache', 'm3-acceptance'); mkdirSync(logDir, { recursive: true });
  for (const [name, args] of gates) {
    console.log(`  门禁 ${name}...`);
    // M1/panel的内嵌测试已由本轮前两项实际执行，只去重，不跳过它们自身的验收。
    const result = run(process.execPath, args, project, { COWORK_ACCEPT_SKIP_SUITE: '1' }, 15 * 60 * 1000);
    writeFileSync(path.join(logDir, `${name}.log`), `exit=${result.code}\n${output(result)}`);
    success(result);
    if (name === 'npm-test') assert.match(result.stdout, /# fail 0/);
    if (name === 'accept-m1') assert.match(result.stdout, /全部 \d+ 条通过|全部通过|10.*PASS|10.*通过/);
    if (name === 'accept-panel' || name === 'accept-m2') assert.match(result.stdout, /0 FAIL/);
    console.log(`  门禁 ${name}: PASS`);
  }
});

let passed = 0; let failed = 0;
try {
  for (const check of checks) {
    if (only.length > 0 && !only.includes(check.id)) continue;
    try { await check.fn(); passed += 1; console.log(`PASS ${check.id}. ${check.title}`); }
    catch (err) { failed += 1; console.error(`FAIL ${check.id}. ${check.title}\n${err instanceof Error ? err.stack ?? err.message : String(err)}`); }
  }
} finally {
  for (const child of workers) {
    if (process.platform === 'win32' && child.pid !== undefined) run('taskkill.exe', ['/T', '/F', '/PID', String(child.pid)], project);
    else child.kill('SIGKILL');
  }
  if (!keep) for (const root of repos) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }); }
    catch (err) { failed += 1; console.error(`FAIL cleanup ${root}: ${String(err)}`); }
  }
}
console.log(`${passed} PASS / ${failed} FAIL`);
process.exitCode = failed === 0 ? 0 : 1;
