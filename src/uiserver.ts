import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import type { RepoInfo } from './git.ts';
import { renderPanel } from './ui.ts';

const execFile = promisify(execFileCallback);
const PORT_ERROR = '端口被占用或不可用';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CliExecutor = (args: readonly string[], cwd: string, agent?: string) => Promise<CliResult>;

export interface PanelServerOptions {
  port: number;
  cliPath: string;
  execute?: CliExecutor;
}

export interface PanelServer {
  server: Server;
  token: string;
  readonly port: number;
  readonly url: string;
  listen(): Promise<string>;
  close(): Promise<void>;
}

export async function runCli(cliPath: string, args: readonly string[], cwd: string, agent?: string, timeoutMs = 60_000): Promise<CliResult> {
  try {
    const prefix = cliPath.endsWith('.ts') ? ['--experimental-strip-types', cliPath] : [cliPath];
    const result = await execFile(process.execPath, [...prefix, ...args], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      env: agent === undefined ? process.env : { ...process.env, COWORK_AGENT_ID: agent },
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean; message: string };
    if (error.killed === true) return { code: 1, stdout: error.stdout ?? '', stderr: `命令超时：cowork ${args.join(' ')}` };
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message,
    };
  }
}

function send(res: ServerResponse, status: number, body: string, type = 'application/json; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value));
}

function authorizedToken(expected: string, actual: string | null): boolean {
  if (actual === null) return false;
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(actual, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && !value.startsWith('-') && value !== '.' && value !== '..';
}

class BadRequest extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new BadRequest('Content-Type 必须是 application/json');
  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    req.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > 64 * 1024) { reject(new BadRequest('请求 body 超过 64KB', 413)); return; }
      chunks.push(chunk);
    });
    req.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.once('error', reject);
    req.once('aborted', () => reject(new BadRequest('请求已中断')));
  });
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new BadRequest('body 必须是 JSON 对象'); }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new BadRequest('body 必须是 JSON 对象');
  return data as Record<string, unknown>;
}

function fields(body: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new BadRequest(`不接受字段: ${key}`);
}

function textField(body: Record<string, unknown>, key: string, optional = false): string | undefined {
  const value = body[key];
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') throw new BadRequest(`${key} 必须是非空字符串`);
  return value;
}

interface Command { args: string[]; cwd: string; agent?: string }

function writeCommand(route: string, body: Record<string, unknown>, root: string): Command {
  if ('agent' in body) throw new BadRequest('写路由不接受客户端 agent');
  const command: Command = { args: [], cwd: root };
  if (route === '/api/lane/new') {
    fields(body, ['name', 'base']);
    command.args = ['lane', 'new', textField(body, 'name')!];
    const base = textField(body, 'base', true);
    if (base !== undefined) command.args.push(`--base=${base}`);
  } else if (route === '/api/task/add') {
    fields(body, ['title', 'touches', 'reads', 'depends_on', 'done_when']);
    command.args = ['task', 'add', `--title=${textField(body, 'title')!}`];
    for (const [key, flag] of [['touches', 'touches'], ['reads', 'reads'], ['depends_on', 'depends'], ['done_when', 'done-when']] as const) {
      const value = body[key] ?? [];
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new BadRequest(`${key} 必须是字符串数组`);
      for (const item of value) command.args.push(`--${flag}=${item}`);
    }
  } else if (route === '/api/import') {
    fields(body, ['path', 'dry_run']);
    const file = path.resolve(root, textField(body, 'path')!);
    const inside = (candidate: string): boolean => {
      const relative = path.relative(root, candidate);
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    if (!inside(file)) throw new BadRequest('import path 必须在仓库根内');
    try { if (!inside(realpathSync(file))) throw new BadRequest('import path 指向仓库外'); }
    catch (err) { if (err instanceof BadRequest) throw err; /* 不存在的文件由 CLI 原样报告 */ }
    if (body['dry_run'] !== undefined && typeof body['dry_run'] !== 'boolean') throw new BadRequest('dry_run 必须是布尔值');
    command.args = ['task', 'import', file, ...(body['dry_run'] === true ? ['--dry-run'] : [])];
  } else {
    const lane = /^\/api\/lane\/([^/]+)\/next$/.exec(route);
    const task = /^\/api\/task\/([^/]+)\/(ready|start|report-done|confirm-merge|block|cancel)$/.exec(route);
    if (lane !== null) {
      const name = decodeURIComponent(lane[1]!);
      if (!safeSegment(name)) throw new BadRequest('Invalid lane');
      fields(body, []);
      command.cwd = path.join(root, '.cowork', 'lanes', name);
      command.agent = name;
      command.args = ['next', '--agent', name];
    } else if (task !== null) {
      const id = decodeURIComponent(task[1]!);
      const action = task[2]!;
      if (!safeSegment(id)) throw new BadRequest('Invalid task id');
      fields(body, action === 'confirm-merge' ? ['commit', 'reason'] : action === 'block' || action === 'cancel' ? ['reason'] : []);
      command.args = ['task', action, id];
      if (action === 'confirm-merge') command.args.push(`--commit=${textField(body, 'commit')!}`, '--manual');
      if (action === 'confirm-merge' || action === 'block' || action === 'cancel') {
        const reason = textField(body, 'reason', action === 'cancel');
        if (reason !== undefined) command.args.push(`--reason=${reason}`);
      }
    } else throw new BadRequest('Not found', 404);
  }
  return command;
}

function htmlWithToken(html: string, token: string): string {
  const bootstrap = `<script>window.__COWORK_TOKEN__=${JSON.stringify(token)};history.replaceState(null,'',location.pathname+location.hash);</script>`;
  return html.replace('</body>', `${bootstrap}</body>`);
}

function requestToken(req: IncomingMessage, url: URL): string | null {
  if (url.pathname === '/') return url.searchParams.get('t');
  return typeof req.headers['x-cowork-token'] === 'string' ? req.headers['x-cowork-token'] : null;
}

export function createPanelServer(info: RepoInfo, options: PanelServerOptions): PanelServer {
  const token = randomBytes(16).toString('hex');
  const execute = options.execute ?? ((args, cwd, agent) => runCli(options.cliPath, args, cwd, agent));
  let activePort = options.port;
  let snapshotCache: { expires: number; result: CliResult } | null = null;
  let writeTail: Promise<unknown> = Promise.resolve();

  const server = createServer((req, res) => {
    void (async () => {
      const host = req.headers.host ?? '';
      if (host !== `127.0.0.1:${activePort}` && host !== `localhost:${activePort}`) {
        send(res, 403, JSON.stringify({ error: 'Forbidden host' }));
        return;
      }
      let url: URL;
      try {
        const rawPath = (req.url ?? '/').split('?')[0]!;
        if (rawPath.split('/').some((part) => ['.', '..'].includes(decodeURIComponent(part)))) throw new BadRequest('Invalid path segment');
        url = new URL(req.url ?? '/', `http://${host}`);
      } catch {
        send(res, 400, JSON.stringify({ error: 'Invalid request URL' }));
        return;
      }
      if (req.method === 'OPTIONS') {
        send(res, 405, JSON.stringify({ error: 'Method not allowed' }));
        return;
      }
      if (!authorizedToken(token, requestToken(req, url))) {
        send(res, 401, JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/') {
        const result = await execute(['snapshot', '--json'], info.mainRoot);
        if (result.code !== 0) {
          send(res, 500, result.stderr || result.stdout, 'text/plain; charset=utf-8');
          return;
        }
        try {
          const snap = JSON.parse(result.stdout);
          send(res, 200, htmlWithToken(renderPanel(snap), token), 'text/html; charset=utf-8');
        } catch (err) {
          send(res, 500, `cowork snapshot --json 返回无效 JSON: ${err instanceof Error ? err.message : String(err)}`, 'text/plain; charset=utf-8');
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/snapshot') {
        if (snapshotCache !== null && snapshotCache.expires > Date.now()) {
          send(res, snapshotCache.result.code === 0 ? 200 : 500, snapshotCache.result.stdout || snapshotCache.result.stderr);
          return;
        }
        const result = await execute(['snapshot', '--json'], info.mainRoot);
        if (result.code === 0) snapshotCache = { expires: Date.now() + 1000, result };
        send(res, result.code === 0 ? 200 : 500, result.stdout || result.stderr);
        return;
      }
      const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && taskMatch !== null) {
        const id = taskMatch[1] ?? '';
        if (!safeSegment(id)) { json(res, 400, { error: 'Invalid task id' }); return; }
        json(res, 200, await execute(['task', 'show', id, '--json'], info.mainRoot));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/brief') {
        const lane = url.searchParams.get('lane') ?? '';
        if (!safeSegment(lane)) { json(res, 400, { error: 'Invalid lane' }); return; }
        const lanePath = path.join(info.mainRoot, '.cowork', 'lanes', lane);
        json(res, 200, await execute(['brief', '--agent', lane], lanePath, lane));
        return;
      }
      if (req.method === 'POST') {
        if (url.searchParams.has('agent')) throw new BadRequest('写路由不接受客户端 agent');
        const body = await readBody(req);
        let command: Command;
        try { command = writeCommand(url.pathname, body, info.mainRoot); }
        catch (err) { if (err instanceof URIError) throw new BadRequest('Invalid URL encoding'); throw err; }
        // 仅排队 CLI 调用；参数错误不入队，读请求不被写队列阻塞。
        const pending = writeTail.then(() => execute(command.args, command.cwd, command.agent));
        writeTail = pending.catch(() => undefined);
        let result: CliResult;
        try { result = await pending; }
        catch (err) { result = { code: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }; }
        snapshotCache = null;
        json(res, 200, result);
        return;
      }
      json(res, 404, { error: 'Not found' });
    })().catch((err: unknown) => {
      if (res.headersSent) { res.destroy(err instanceof Error ? err : undefined); return; }
      json(res, err instanceof BadRequest ? err.status : 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  const panel: PanelServer = {
    server,
    token,
    get port() { return activePort; },
    get url() { return `http://127.0.0.1:${activePort}/?t=${token}`; },
    listen: () => new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') reject(new Error(`${PORT_ERROR}: ${activePort}，请用 --port 指定其它本机端口。`));
        else reject(err);
      };
      const onListening = (): void => {
        server.off('error', onError);
        const address = server.address();
        if (address !== null && typeof address !== 'string') activePort = address.port;
        resolve(panel.url);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(activePort, '127.0.0.1');
    }),
    close: () => new Promise((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      server.close((err) => err === undefined ? resolve() : reject(err));
    }),
  };
  return panel;
}

export function parsePort(raw: string | undefined): number {
  if (raw === undefined) return 7788;
  if (!/^\d+$/.test(raw)) throw new Error(`${PORT_ERROR}: ${raw} 不是有效端口，请用 --port 1..65535。`);
  const port = Number(raw);
  if (port > 65535) throw new Error(`${PORT_ERROR}: ${raw} 超出范围，请用 --port 1..65535。`);
  return port;
}
