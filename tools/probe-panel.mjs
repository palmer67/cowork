#!/usr/bin/env node
// 独立验收探针：不复用 tools/accept-panel.mjs 的任何断言，自己起临时仓库、自己打 HTTP。
// 用法: node tools/probe-panel.mjs <仓库路径> <构建后的 cli.js 路径>
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import path from 'node:path';

const repo = process.argv[2];
const cli = process.argv[3];
if (!repo || !cli) {
  console.error('用法: node tools/probe-panel.mjs <仓库> <cli.js>');
  process.exit(2);
}

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`PASS ${name}`);
  else { failures += 1; console.log(`FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`); }
}
function note(name, detail) { console.log(`NOTE ${name}: ${detail}`); }

function run(args, cwd, allowFail = false) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = /** @type {{status?: number, stdout?: string, stderr?: string}} */ (err);
    if (!allowFail) throw new Error(`cowork ${args.join(' ')} 意外失败: ${e.stdout ?? ''}${e.stderr ?? ''}`);
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

const root = mkdtempSync(path.join(tmpdir(), 'cowork-probe-panel-'));
let server = null;
function cleanup() {
  if (server !== null && !server.killed) server.kill();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
}
process.on('exit', cleanup);

try {
  git(['init', '-b', 'main'], root);
  git(['config', 'user.email', 'probe@example.com'], root);
  git(['config', 'user.name', 'Probe'], root);
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'README.md'), '# probe\n');
  writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  git(['add', '-A'], root);
  git(['commit', '-m', 'init'], root);
  run(['init'], root);

  const add = run(['task', 'add', '--title', '探针任务', '--touches', 'src/a.ts', '--done-when', 'true'], root);
  const id = /t-[0-9a-f]{6}/.exec(add.stdout)?.[0];
  if (id === undefined) throw new Error(`没拿到任务 id: ${add.stdout}`);
  git(['add', '.cowork/tasks'], root);
  git(['commit', '-m', 'task: spec'], root);
  run(['task', 'ready', id], root);

  // 起服务，从 stdout 解析端口与 token
  const child = spawn(process.execPath, [cli, 'ui', '--serve', '--port', '0'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server = child;
  const urlLine = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`面板 15s 未启动: ${buffer}`)), 15000);
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const match = /面板已启动: (http:\/\/127\.0\.0\.1:\d+\/\?t=([0-9a-f]+))/.exec(buffer);
      if (match) { clearTimeout(timer); resolve({ url: match[1], token: match[2] }); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`面板进程提前退出 ${code}`)); });
  });
  const parsed = new URL(urlLine.url);
  const origin = `http://127.0.0.1:${parsed.port}`;
  const token = urlLine.token;

  async function api(route, { method = 'GET', body, tokenOverride = token, host = `127.0.0.1:${parsed.port}` } = {}) {
    const headers = { Host: host };
    if (tokenOverride !== null) headers['X-Cowork-Token'] = tokenOverride;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return await request(method, route, headers, body === undefined ? undefined : JSON.stringify(body));
  }

  // fetch 会覆盖 Host 头，伪造 Host 的场景必须走 http.request。
  function request(method, route, headers, payload) {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: parsed.port, path: route, method, headers }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          let data = null;
          try { data = JSON.parse(text); } catch { /* 可能是 HTML */ }
          resolve({ status: res.statusCode ?? 0, text, data });
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  // ---- 鉴权与 Host ----
  const noToken = await fetch(`${origin}/`, { headers: { Host: `127.0.0.1:${parsed.port}` } });
  check('无 token 首页 401', noToken.status === 401, String(noToken.status));
  const wrongToken = await api('/', { tokenOverride: 'deadbeef' });
  check('错 token 401', wrongToken.status === 401, String(wrongToken.status));
  const evilHost = await api('/', { host: 'evil.example' });
  check('伪造 Host 403', evilHost.status === 403, String(evilHost.status));
  const options = await api('/api/lane/new', { method: 'OPTIONS' });
  check('OPTIONS 405', options.status === 405, String(options.status));
  const home = await api(`/?t=${token}`);
  check('带 token 首页 200 且含「任务与契约」', home.status === 200 && home.text.includes('任务与契约'), String(home.status));
  check('首页脚本会把 token 从地址栏抹掉', home.text.includes('history.replaceState'));

  // ---- 客户端不得指定 agent ----
  const agentQuery = await api(`/api/task/${id}/start?agent=dsh`, { method: 'POST', body: {} });
  check('写路由拒绝 query ?agent', agentQuery.status === 400, String(agentQuery.status));
  const agentBody = await api(`/api/task/${id}/start`, { method: 'POST', body: { agent: 'dsh' } });
  check('写路由拒绝 body.agent', agentBody.status === 400, String(agentBody.status));

  // ---- 只读：连续取快照不改持久状态 ----
  const stateDirs = [path.join(root, '.git', 'cowork', 'tasks'), path.join(root, '.git', 'cowork', 'claims'), path.join(root, '.git', 'cowork', 'intents'), path.join(root, '.git', 'cowork', 'leases'), path.join(root, '.cowork', 'tasks')];
  function fingerprint() {
    const out = [];
    for (const dir of stateDirs) {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) out.push(`${dir}|${name}|${statSync(path.join(dir, name)).mtimeMs}`);
    }
    return out.sort().join('\n');
  }
  await api('/api/snapshot'); // 预热状态目录
  const before = fingerprint();
  for (let i = 0; i < 5; i += 1) await api('/api/snapshot');
  await api(`/?t=${token}`);
  const after = fingerprint();
  check('连刷 5 次 snapshot + 首页，持久状态文件与 mtime 不变', before === after, `${before.length} vs ${after.length}`);

  // ---- 派工 ----
  const laneNew = await api('/api/lane/new', { method: 'POST', body: { name: 'dsh' } });
  check('新建车道 code 0', laneNew.data?.code === 0, JSON.stringify(laneNew.data));
  check('新建车道真的建出 worktree', existsSync(path.join(root, '.cowork', 'lanes', 'dsh')));
  const dup = await api('/api/lane/new', { method: 'POST', body: { name: 'dsh' } });
  check('重复车道 code 2', dup.data?.code === 2, JSON.stringify(dup.data));

  const dispatched = await api('/api/lane/dsh/next', { method: 'POST', body: {} });
  check('派工 code 0', dispatched.data?.code === 0, JSON.stringify(dispatched.data));
  const live = JSON.parse(execFileSync('node', ['-e', `const fs=require('fs');const p=process.argv[1];process.stdout.write(fs.readFileSync(p,'utf8'))`, path.join(root, '.git', 'cowork', 'tasks', `${id}.json`)], { encoding: 'utf8' }));
  check('live 状态 claimed 且归属 dsh', live.status === 'claimed' && live.lane === 'dsh' && live.agent === 'dsh', JSON.stringify({ status: live.status, lane: live.lane, agent: live.agent }));

  // ---- 派工后从面板点「开始」----
  const started = await api(`/api/task/${id}/start`, { method: 'POST', body: {} });
  note('面板点「开始」', `code=${started.data?.code} stderr=${String(started.data?.stderr ?? '').split('\n')[0]}`);

  // ---- 队列顺序重复派工（R1）----
  const again = await api('/api/lane/dsh/next', { method: 'POST', body: {} });
  check('顺序重复派工 code 1（R1）', again.data?.code === 1, JSON.stringify(again.data?.code));
  check('重复派工后任务归属未变', JSON.parse(execFileSync('node', ['-e', `process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))`, path.join(root, '.git', 'cowork', 'tasks', `${id}.json`)], { encoding: 'utf8' })).lane === 'dsh');

  // ---- 并发写串行：同名车道只可能一个成功 ----
  rmSync(path.join(root, '.cowork', 'lanes', 'two'), { recursive: true, force: true });
  const [r1, r2] = await Promise.all([
    api('/api/lane/new', { method: 'POST', body: { name: 'two' } }),
    api('/api/lane/new', { method: 'POST', body: { name: 'two' } }),
  ]);
  const codes = [r1.data?.code, r2.data?.code].sort();
  check('两个并发同名建车道：一个 0 一个 2', codes[0] === 0 && codes[1] === 2, JSON.stringify(codes));

  // ---- 导入：坏计划一条不写，好计划三个 draft ----
  const beforeImport = fingerprint();
  writeFileSync(path.join(root, 'bad.json'), JSON.stringify({ schemaVersion: 1, tasks: [
    { key: 'a', title: 'A', touches: ['src/x.ts'], depends_on: ['b'] },
    { key: 'b', title: 'B', touches: ['src/y.ts'], depends_on: ['a'] },
  ] }));
  const bad = await api('/api/import', { method: 'POST', body: { path: 'bad.json' } });
  check('环依赖导入 code 1', bad.data?.code === 1, JSON.stringify(bad.data?.code));
  check('环依赖导入没有写任何文件', fingerprint() === beforeImport);

  writeFileSync(path.join(root, 'plan.json'), JSON.stringify({ schemaVersion: 1, tasks: [
    { key: 'x', title: 'X', touches: ['src/x.ts'], depends_on: [] },
    { key: 'y', title: 'Y', touches: ['src/y.ts'], depends_on: ['x'] },
    { key: 'z', title: 'Z', touches: ['src/z.ts'], depends_on: ['y'] },
  ] }));
  const good = await api('/api/import', { method: 'POST', body: { path: 'plan.json' } });
  check('正常导入 code 0', good.data?.code === 0, JSON.stringify(good.data));
  check('导入了 3 个 spec 文件', readdirSync(path.join(root, '.cowork', 'tasks')).filter((name) => name.endsWith('.md')).length === 4);

  // ---- 越界路径 ----
  const escape = await api('/api/import', { method: 'POST', body: { path: '../outside.json' } });
  check('导入仓库外路径 400', escape.status === 400, String(escape.status));
  const badLane = await api('/api/lane/..%2F..%2Fx/next', { method: 'POST', body: {} });
  check('车道名越界被拒绝', badLane.status === 400 || badLane.data?.code !== 0, `${badLane.status}/${badLane.data?.code}`);
} finally {
  cleanup();
}

console.log(`\n探针结果: ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`);
process.exit(failures === 0 ? 0 : 1);
