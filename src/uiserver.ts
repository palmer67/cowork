import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import path from 'node:path';
import type { RepoInfo } from './git.ts';
import { renderPanel } from './ui.ts';

const execFile = promisify(execFileCallback);
const PORT_ERROR = '端口被占用或不可用';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CliExecutor = (args: readonly string[], cwd: string) => Promise<CliResult>;

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

async function runCli(cliPath: string, args: readonly string[], cwd: string): Promise<CliResult> {
  try {
    const prefix = cliPath.endsWith('.ts') ? ['--experimental-strip-types', cliPath] : [cliPath];
    const result = await execFile(process.execPath, [...prefix, ...args], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
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
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..';
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
  const execute = options.execute ?? ((args, cwd) => runCli(options.cliPath, args, cwd));
  let activePort = options.port;
  let snapshotCache: { expires: number; result: CliResult } | null = null;

  const server = createServer((req, res) => {
    void (async () => {
      const host = req.headers.host ?? '';
      if (host !== `127.0.0.1:${activePort}` && host !== `localhost:${activePort}`) {
        send(res, 403, JSON.stringify({ error: 'Forbidden host' }));
        return;
      }
      let url: URL;
      try {
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
        json(res, 200, await execute(['brief', '--agent', lane], lanePath));
        return;
      }
      json(res, 404, { error: 'Not found' });
    })().catch((err: unknown) => {
      if (res.headersSent) { res.destroy(err instanceof Error ? err : undefined); return; }
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
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
