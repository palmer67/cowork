import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { RepoInfo } from '../src/git.ts';
import { createPanelServer, parsePort, type CliExecutor, type PanelServer } from '../src/uiserver.ts';

const info: RepoInfo = { mainRoot: 'C:/test', laneTop: 'C:/test', commonDir: 'C:/test/.git', laneName: null };
const snap = { schemaVersion: 1, generatedAt: new Date().toISOString(), repo: { root: 'test', head: 'abc123' }, tasks: [], task_diagnostics: [], claims: [], contract_alerts: [], lanes: [] };
const ok = { code: 0, stdout: JSON.stringify(snap), stderr: '' };

function http(panel: PanelServer, route: string, opts: { method?: string; host?: string; token?: string | null; body?: string; type?: string } = {}): Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: opts.host ?? `127.0.0.1:${panel.port}` };
    if (opts.token !== null) headers['X-Cowork-Token'] = opts.token ?? panel.token;
    if (opts.body !== undefined) headers['Content-Type'] = opts.type ?? 'application/json';
    const req = request({ hostname: '127.0.0.1', port: panel.port, path: route, method: opts.method ?? 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (data) => { body += data; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

async function withPanel(fn: (panel: PanelServer) => Promise<void>, execute: CliExecutor = async () => ok): Promise<void> {
  const panel = createPanelServer(info, { port: 0, cliPath: 'unused', execute });
  await panel.listen();
  try { await fn(panel); } finally { await panel.close(); }
}

test('首页和 API 无 token/错 token 均 401，正确 token 返回 HTML 与快照', async () => {
  await withPanel(async (panel) => {
    assert.equal((panel.server.address() as import('node:net').AddressInfo).address, '127.0.0.1');
    assert.equal((await http(panel, '/')).status, 401);
    assert.equal((await http(panel, '/?t=wrong')).status, 401);
    assert.equal((await http(panel, '/api/snapshot', { token: null })).status, 401);
    assert.equal((await http(panel, '/api/snapshot', { token: 'x'.repeat(32) })).status, 401);
    const home = await http(panel, `/?t=${panel.token}`);
    assert.equal(home.status, 200);
    assert.match(home.body, /任务与契约/);
    assert.match(home.body, /history.replaceState/);
    assert.deepEqual(JSON.parse((await http(panel, '/api/snapshot')).body), snap);
  });
});

test('非本地 Host 403；OPTIONS 405；未知路径 404；没有 CORS 头', async () => {
  await withPanel(async (panel) => {
    assert.equal((await http(panel, '/', { host: 'evil.example' })).status, 403);
    const options = await http(panel, '/api/lane/new', { method: 'OPTIONS' });
    assert.equal(options.status, 405);
    assert.equal(options.headers['access-control-allow-origin'], undefined);
    assert.equal((await http(panel, '/unknown')).status, 404);
    assert.equal((await http(panel, '/api/snapshot', { host: `localhost:${panel.port}` })).status, 200);
  });
});

test('snapshot 在一秒内复用缓存，详情/brief 只调用白名单 CLI', async () => {
  const calls: { args: readonly string[]; cwd: string }[] = [];
  await withPanel(async (panel) => {
    for (let i = 0; i < 5; i++) assert.equal((await http(panel, '/api/snapshot')).status, 200);
    assert.equal(calls.length, 1);
    await http(panel, '/api/tasks/t-123abc');
    await http(panel, '/api/brief?lane=dsh');
    assert.deepEqual(calls[1]?.args, ['task', 'show', 't-123abc', '--json']);
    assert.deepEqual(calls[2]?.args, ['brief', '--agent', 'dsh']);
    assert.match(calls[2]?.cwd ?? '', /lanes[\\/]dsh$/);
    assert.equal((await http(panel, '/api/brief?lane=..')).status, 400);
    assert.equal((await http(panel, '/api/tasks/bad%2Fname')).status, 400);
  }, async (args, cwd) => { calls.push({ args, cwd }); return ok; });
});

test('端口校验及占用提示，不自动换端口', async () => {
  assert.equal(parsePort(undefined), 7788);
  assert.equal(parsePort('0'), 0);
  for (const raw of ['no', '-1', '65536', '2.5', '']) assert.throws(() => parsePort(raw), /--port/);
  await withPanel(async (first) => {
    const second = createPanelServer(info, { port: first.port, cliPath: 'unused' });
    await assert.rejects(second.listen(), /端口.*--port/);
    await second.close();
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const run = (args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', cli, 'ui', ...args], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', windowsHide: true });
    for (const args of [['--serve', '--port', String(first.port)], ['--serve', '--port', 'invalid']]) {
      const result = run(args);
      assert.equal(result.status, 3, result.stderr);
      assert.match(result.stderr, /--port/);
    }
    assert.equal(run(['--serve', '--out', 'board.html']).status, 1);
  });
});
