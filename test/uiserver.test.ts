import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { removeTree } from './helpers.ts';
import type { RepoInfo } from '../src/git.ts';
import { createPanelServer, parsePort, runCli, type CliExecutor, type PanelServer } from '../src/uiserver.ts';

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

async function withAgent(agent: string | undefined, fn: () => Promise<void>): Promise<void> {
  const previous = process.env.COWORK_AGENT_ID;
  if (agent === undefined) delete process.env.COWORK_AGENT_ID;
  else process.env.COWORK_AGENT_ID = agent;
  try { await fn(); }
  finally {
    if (previous === undefined) delete process.env.COWORK_AGENT_ID;
    else process.env.COWORK_AGENT_ID = previous;
  }
}

test('首页和 API 无 token/错 token 均 401，正确 token 返回 HTML 与快照', async () => {
  await withAgent(undefined, () => withPanel(async (panel) => {
    assert.equal((panel.server.address() as import('node:net').AddressInfo).address, '127.0.0.1');
    assert.equal((await http(panel, '/')).status, 401);
    assert.equal((await http(panel, '/?t=wrong')).status, 401);
    assert.equal((await http(panel, '/api/snapshot', { token: null })).status, 401);
    assert.equal((await http(panel, '/api/snapshot', { token: 'x'.repeat(32) })).status, 401);
    const home = await http(panel, `/?t=${panel.token}`);
    assert.equal(home.status, 200);
    assert.match(home.body, /任务与契约/);
    assert.match(home.body, /history.replaceState/);
    assert.deepEqual(JSON.parse((await http(panel, '/api/snapshot')).body), { ...snap, panel_agent: 'default' });
  }));
  await withAgent('panel-owner', () => withPanel(async (panel) => {
    assert.deepEqual(JSON.parse((await http(panel, '/api/snapshot')).body), { ...snap, panel_agent: 'panel-owner' });
  }));
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

test('写请求串行，退出码与两条输出原样透传；一次操作只有一次执行', async () => {
  const finished: string[] = [];
  let running = 0;
  await withPanel(async (panel) => {
    const send = (name: string) => http(panel, '/api/lane/new', { method: 'POST', body: JSON.stringify({ name }) });
    const [a, b] = await Promise.all([send('first'), send('second')]);
    const results = [JSON.parse(a.body), JSON.parse(b.body)];
    assert.deepEqual(results.map((r) => r.code), [2, 3]);
    assert.deepEqual(results[1], { code: 3, stdout: 'first,second', stderr: '原始错误\n--port 如何解决\n' });
    assert.deepEqual(finished, ['first', 'second']);
  }, async (args) => {
    assert.equal(running++, 0, '不能并发执行两个写命令');
    await new Promise((resolve) => setTimeout(resolve, 20));
    finished.push(args[2]!);
    running--;
    return { code: finished.length === 1 ? 2 : 3, stdout: finished.join(','), stderr: '原始错误\n--port 如何解决\n' };
  });
});

test('写路由白名单、argv 与 cwd/agent 身份仅由服务器确定', async () => {
  const calls: { args: readonly string[]; cwd: string; agent?: string }[] = [];
  await withPanel(async (panel) => {
    const cases: [string, object, string[]][] = [
      ['/api/lane/new', { name: 'bad/../name', base: 'main' }, ['lane', 'new', 'bad/../name', '--base=main']],
      ['/api/task/add', { title: '--help & echo nope', touches: ['src/a.ts'], reads: ['src/b.ts'], depends_on: ['t-123abc'], done_when: ['npm test'] }, ['task', 'add', '--title=--help & echo nope', '--touches=src/a.ts', '--reads=src/b.ts', '--depends=t-123abc', '--done-when=npm test']],
      ['/api/task/t-123abc/ready', {}, ['task', 'ready', 't-123abc']],
      ['/api/task/t-123abc/start', {}, ['task', 'start', 't-123abc']],
      ['/api/task/t-123abc/report-done', {}, ['task', 'report-done', 't-123abc']],
      ['/api/task/t-123abc/confirm-merge', { commit: 'HEAD', reason: '--reason literal' }, ['task', 'confirm-merge', 't-123abc', '--commit=HEAD', '--manual', '--reason=--reason literal']],
      ['/api/task/t-123abc/block', { reason: 'waiting' }, ['task', 'block', 't-123abc', '--reason=waiting']],
      ['/api/task/t-123abc/cancel', {}, ['task', 'cancel', 't-123abc']],
      ['/api/import', { path: 'plan.json', dry_run: true }, ['task', 'import', path.resolve(info.mainRoot, 'plan.json'), '--dry-run']],
      ['/api/lane/dsh/next', {}, ['next', '--agent', 'dsh']],
    ];
    for (const [route, body, args] of cases) {
      assert.equal((await http(panel, route, { method: 'POST', body: JSON.stringify(body) })).status, 200);
      assert.deepEqual(calls.at(-1)?.args, args);
    }
    assert.equal(calls.length, cases.length);
    assert.equal(calls[3]?.cwd, info.mainRoot);
    assert.equal(calls[3]?.agent, undefined, '不能从 snapshot 冒充 owner');
    assert.equal(calls.at(-1)?.cwd, path.join(info.mainRoot, '.cowork', 'lanes', 'dsh'));
    assert.equal(calls.at(-1)?.agent, 'dsh');
  }, async (args, cwd, agent) => { calls.push({ args, cwd, agent }); return { code: 0, stdout: 'ok', stderr: '' }; });
});

test('拒绝伪造身份、任意命令、越界路径、坏 JSON/类型与超大 body', async () => {
  let calls = 0;
  await withPanel(async (panel) => {
    const invalid: [string, string, number, string?][] = [
      ['/api/task/t-123abc/start', '{"agent":"dsh"}', 400],
      ['/api/lane/dsh/next?agent=other', '{}', 400],
      ['/api/task/t-123abc/ready', '{"argv":["init"]}', 400],
      ['/api/lane/%2e%2e/next', '{}', 400],
      ['/api/lane/dsh%2f..%2fevil/next', '{}', 400],
      ['/api/task/--help/start', '{}', 400],
      ['/api/import', '{"path":"../plan.json"}', 400],
      ['/api/task/add', '{"title":"x","touches":"src/a.ts"}', 400],
      ['/api/lane/new', '{', 400],
      ['/api/lane/new', '[]', 400],
      ['/api/lane/new', '{"name":"a"}', 400, 'text/plain'],
      ['/api/lane/new', JSON.stringify({ name: 'a', extra: 'x'.repeat(65536) }), 413],
      ['/api/run', '{}', 404],
    ];
    for (const [route, body, status, type] of invalid) assert.equal((await http(panel, route, { method: 'POST', body, type })).status, status, route);
    assert.equal(calls, 0);
  }, async () => { calls++; return ok; });
});

test('真实子进程透传非零结果，超时 kill 返回 1 并说明命令', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cowork-panel-runner-'));
  try {
    const cli = path.join(root, 'cli.mjs');
    writeFileSync(cli, "process.stdout.write(process.env.COWORK_AGENT_ID);process.stderr.write('who owns it\\n');process.exit(2);");
    assert.deepEqual(await runCli(cli, ['next', '--agent', 'dsh'], root, 'dsh'), { code: 2, stdout: 'dsh', stderr: 'who owns it\n' });
    writeFileSync(cli, 'setInterval(()=>{},1000);');
    const timed = await runCli(cli, ['task', 'add'], root, undefined, 100);
    assert.equal(timed.code, 1);
    assert.match(timed.stderr, /命令超时：cowork task add/);
  } finally { removeTree(root); }
});
